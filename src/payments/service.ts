import type Stripe from "stripe";
import type { PaymentStore, SubscriptionState, Transaction } from "./store.js";

const purpose = "wedplan-premium";
const id = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id;
const date = (seconds: number | null | undefined) => seconds ? new Date(seconds * 1000) : null;
const ended = (status: string) => ["canceled", "incomplete_expired"].includes(status);
const invoiceSubscription = (invoice: Stripe.Invoice) => id(invoice.parent?.subscription_details?.subscription);

export class PaymentError extends Error {
  constructor(readonly status: 404 | 409 | 503, message: string) {
    super(message);
  }
}

export function createPayments(stripe: Stripe, store: PaymentStore, config: {
  priceId: string;
  origin: string;
  webhookSecret: string;
  liveMode: boolean;
}) {
  const ownsSubscription = (sub: Stripe.Subscription, customerId: string, vendorId: string) =>
    id(sub.customer) === customerId && sub.metadata.purpose === purpose && sub.metadata.vendorId === vendorId;
  const premiumItem = (sub: Stripe.Subscription) => sub.items.data.find((item) => item.price.id === config.priceId);

  async function checkout(vendorId: string) {
    let customerId = (await store.findBilling(vendorId))?.customerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ metadata: { vendorId, purpose } },
        { idempotencyKey: "wedplan:customer:" + vendorId });
      customerId = await store.saveCustomer(vendorId, customer.id);
    }
    const attempt = await store.reserveCheckout(vendorId);
    if (!attempt) throw new PaymentError(503, "Checkout could not be reserved. Please retry.");
    for await (const sub of stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
      if (!ended(sub.status)) throw new PaymentError(409, "An existing subscription must end before starting another checkout");
    }

    const metadata = { purpose, vendorId, attemptId: attempt.id };
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      client_reference_id: vendorId,
      mode: "subscription",
      allowed_payment_method_types: ["card"],
      line_items: [{ price: config.priceId, quantity: 1 }],
      subscription_data: { metadata },
      metadata,
      expires_at: attempt.expiresAt,
      success_url: config.origin + "/payment/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: config.origin + "/payment/cancel",
    }, { idempotencyKey: "wedplan:checkout:" + attempt.id });
    if (!session.url) throw new PaymentError(409, "Checkout is unavailable. Refresh your subscription status before retrying.");
    return { url: session.url };
  }

  async function subscription(vendorId: string) {
    const state = (await store.findBilling(vendorId))?.subscription;
    const premium = !!state?.paidThrough && state.paidThrough.getTime() > Date.now();
    return {
      plan: premium ? "premium" : "free",
      status: !state ? "none" : state.status === "active" && !premium ? "unpaid_or_expired" : state.status,
      expiresAt: state?.paidThrough ?? null,
      renewsAt: state?.status === "active" && !state.cancelAtPeriodEnd && !state.cancelAt &&
        state.periodEnd && state.periodEnd.getTime() > Date.now() ? state.periodEnd : null,
      cancelAtPeriodEnd: state?.cancelAtPeriodEnd ?? false,
      cancelAt: state?.cancelAt ?? null,
    };
  }

  async function cancel(vendorId: string) {
    const billing = await store.findBilling(vendorId);
    if (!billing?.subscription || !billing.customerId) throw new PaymentError(404, "Subscription not found");
    const sub = await stripe.subscriptions.retrieve(billing.subscription.id);
    if (!ownsSubscription(sub, billing.customerId, vendorId)) throw new PaymentError(404, "Subscription not found");
    if (ended(sub.status)) throw new PaymentError(409, "Subscription has already ended");
    const updated = sub.cancel_at_period_end ? sub : await stripe.subscriptions.update(
      sub.id, { cancel_at_period_end: true },
    );
    return { cancelAtPeriodEnd: updated.cancel_at_period_end, cancelAt: date(updated.cancel_at) };
  }

  async function reconcile(event: Stripe.Event, customerId: string, subscriptionId: string) {
    const billing = await store.findCustomer(customerId);
    if (!billing) return store.applyEvent(event.id, event.type);
    // Stripe does not guarantee event order. Fetch current state against a local revision
    // and refetch if another event commits before this snapshot can be applied.
    const current = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
    if (!ownsSubscription(current, customerId, billing._id)) return store.applyEvent(event.id, event.type);
    const item = premiumItem(current);
    const previous = billing.subscription;
    const sameSubscription = previous?.id === current.id;
    // A replacement can complete before Stripe delivers the old subscription's deletion event.
    const canReplace = !previous || (!sameSubscription && !ended(current.status) &&
      current.created >= previous.created &&
      (ended(previous.status) || ended((await stripe.subscriptions.retrieve(previous.id)).status)));
    let state: SubscriptionState | undefined;
    if (sameSubscription || canReplace) {
      const latest = current.latest_invoice;
      const periodEnd = date(item?.current_period_end);
      let paidThrough: Date | null = null;
      if (item && current.status === "active" && !current.pause_collection && periodEnd &&
        latest && typeof latest !== "string" && latest.status === "paid" &&
        invoiceSubscription(latest) === current.id && id(latest.customer) === customerId) {
        let coverage = 0;
        for await (const line of stripe.invoices.listLineItems(latest.id, { limit: 100 })) {
          const details = line.parent?.subscription_item_details;
          if (details?.subscription_item === item.id && !details.proration &&
            id(line.pricing?.price_details?.price) === config.priceId && line.period.start <= Date.now() / 1000) {
            coverage = Math.max(coverage, line.period.end);
          }
        }
        paidThrough = date(Math.min(coverage, item.current_period_end, current.cancel_at ?? Infinity));
      }
      state = {
        id: current.id, created: current.created, status: current.status, periodEnd, paidThrough,
        cancelAtPeriodEnd: current.cancel_at_period_end, cancelAt: date(current.cancel_at),
      };
    }

    let transaction: Transaction | undefined;
    if (item && (event.type === "invoice.paid" || event.type === "invoice.payment_failed")) {
      const invoice = event.data.object;
      if (event.type === "invoice.payment_failed" || invoice.status === "paid") {
        transaction = {
          _id: invoice.id, vendorId: billing._id, customerId, subscriptionId, eventId: event.id,
          amount: event.type === "invoice.paid" ? invoice.amount_paid : invoice.amount_due,
          currency: invoice.currency, status: event.type === "invoice.paid" ? "paid" : "failed",
          type: "subscription", plan: "premium", createdAt: new Date(event.created * 1000),
        };
      }
    }
    return store.applyEvent(event.id, event.type, { billing, subscription: state, transaction });
  }

  async function handleEvent(event: Stripe.Event) {
    if (event.livemode !== config.liveMode || await store.eventExists(event.id)) return;
    if (event.type === "checkout.session.expired") {
      const checkout = event.data.object;
      const customerId = id(checkout.customer);
      const attemptId = checkout.metadata?.attemptId;
      if (checkout.mode === "subscription" && customerId && checkout.metadata?.purpose === purpose && attemptId) {
        for (let attempt = 0; attempt < 4; attempt++) {
          const billing = await store.findCustomer(customerId);
          if (!billing || billing._id !== checkout.metadata.vendorId) {
            await store.applyEvent(event.id, event.type);
            return;
          }
          if (await store.applyEvent(event.id, event.type, { billing, clearAttemptId: attemptId })) return;
        }
        // Keep the delivery retryable if a concurrent update changed the revision.
        throw new Error("Checkout expiration changed concurrently");
      }
      await store.applyEvent(event.id, event.type);
      return;
    }

    let customerId: string | undefined;
    let subscriptionId: string | undefined;
    switch (event.type) {
      case "checkout.session.completed": {
        const checkout = event.data.object;
        if (checkout.mode === "subscription" && checkout.metadata?.purpose === purpose) {
          customerId = id(checkout.customer);
          subscriptionId = id(checkout.subscription);
        }
        break;
      }
      case "invoice.paid":
      case "invoice.payment_failed":
        customerId = id(event.data.object.customer);
        subscriptionId = invoiceSubscription(event.data.object);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        customerId = id(event.data.object.customer);
        subscriptionId = event.data.object.id;
        break;
    }

    if (!customerId || !subscriptionId) {
      await store.applyEvent(event.id, event.type);
      return;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await reconcile(event, customerId, subscriptionId)) return;
    }
    throw new Error("Subscription synchronization changed concurrently");
  }

  return {
    checkout, subscription, cancel, handleEvent,
    verifyWebhook: (body: Buffer, signature: string) => stripe.webhooks.constructEvent(body, signature, config.webhookSecret),
    listTransactions: store.listTransactions,
  };
}

export type Payments = ReturnType<typeof createPayments>;
