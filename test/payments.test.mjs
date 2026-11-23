import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

import { createApp } from "../dist/src/app.js";
import { createPaymentStore } from "../dist/src/payments/store.js";
import { createPayments } from "../dist/src/payments/service.js";
import { createServiceStore } from "../dist/src/services/store.js";

const origin = "https://app.example.test";
const secret = "whsec_synthetic_test";
const priceId = "price_server";
const purpose = "wedplan-premium";
const vendorId = new ObjectId().toHexString();
const otherId = new ObjectId().toHexString();

function matches(row, filter) {
  return Object.entries(filter).every(([key, val]) => {
    if (key === "$or") return val.some((entry) => matches(row, entry));
    const actual = key.split(".").reduce((value, field) => value?.[field], row);
    if (val instanceof ObjectId) return val.equals(actual);
    if (typeof val === "object" && val !== null) {
      if ("$exists" in val) return (actual !== undefined) === val.$exists;
      if ("$lte" in val) return actual <= val.$lte;
    }
    return actual === val;
  });
}

function databaseFixture() {
  const rows = {
    stripeBilling: [],
    stripeWebhookEvents: [],
    stripeTransactions: [],
    services: [],
    user: [
      { _id: vendorId, role: "vendor", name: "Original Vendor", subscriptionPlan: "free" },
      { _id: otherId, role: "vendor", name: "Other Vendor", subscriptionPlan: "free" },
      { _id: new ObjectId().toHexString(), role: "admin", name: "Original Admin" },
      { _id: new ObjectId().toHexString(), role: "customer" },
    ],
    account: [{ _id: "original-credential", userId: vendorId, providerId: "credential" }],
  };
  const indexes = [];
  let failReceipt = false;
  function collection(name) {
    function first(filter) { return rows[name].find((row) => matches(row, filter)); }
    function change(row, update) {
      Object.assign(row, update.$set);
      for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + value;
      for (const key of Object.keys(update.$unset ?? {})) delete row[key];
    }
    return {
      async createIndex(key, options) { indexes.push({ name, key, options }); },
      async findOne(filter) { return first(filter) ? structuredClone(first(filter)) : null; },
      async updateOne(filter, update, options) {
        const row = first(filter);
        if (row) change(row, update);
        else if (options?.upsert) rows[name].push({ ...filter, ...update.$setOnInsert });
      },
      async findOneAndUpdate(filter, update) {
        const row = first(filter);
        if (!row) return null;
        change(row, update);
        return structuredClone(row);
      },
      async insertOne(row) {
        if (name === "stripeWebhookEvents" && failReceipt) {
          failReceipt = false;
          throw new Error("synthetic event receipt write failure");
        }
        assert.ok(!first({ _id: row._id }));
        rows[name].push(row);
      },
      async replaceOne(filter, row) {
        const previous = first(filter);
        if (previous) Object.assign(previous, row);
        else rows[name].push(row);
      },
      async countDocuments(filter) { return rows[name].filter((row) => matches(row, filter)).length; },
      find(filter) {
        let found = rows[name].filter((row) => matches(row, filter));
        return {
          sort() { found.sort((a, b) => b.createdAt - a.createdAt); return this; },
          skip(n) { found = found.slice(n); return this; },
          limit(n) { found = found.slice(0, n); return this; },
          async toArray() { return found; },
        };
      },
    };
  }
  let queue = Promise.resolve();
  const client = {
    withSession(fn) {
      return fn({
        withTransaction(operation) {
          const result = queue.then(async () => {
            const backup = structuredClone(rows);
            try {
              return await operation();
            } catch (error) {
              Object.assign(rows, backup);
              throw error;
            }
          });
          queue = result.catch(() => {});
          return result;
        },
      });
    },
  };
  return { client, db: { collection }, rows, indexes, failNextReceipt: () => { failReceipt = true; } };
}

test("Stripe payment HTTP routes, signed webhooks, transactional reconciliation and entitlement", async (t) => {
  const { client, db, rows, indexes, failNextReceipt } = databaseFixture();
  const store = createPaymentStore(client, db);
  await store.ensureIndexes();
  assert.deepEqual(indexes.find(({ name }) => name === "stripeBilling").options, { unique: true, sparse: true });
  const serviceStore = createServiceStore(client, db);
  const stripesdk = new Stripe("sk_test_synthetic");
  const checkoutCalls = [];
  const cancellations = [];
  const customerCalls = [];
  const now = Math.floor(Date.now() / 1000);
  const invoice = {
    id: "in_primary", customer: "cus_vendor", status: "open",
    parent: { subscription_details: { subscription: "sub_vendor" } },
    amount_paid: 3500, amount_due: 3500, currency: "usd",
  };
  const sub = {
    id: "sub_vendor", created: now, customer: "cus_vendor", status: "incomplete",
    metadata: { vendorId, purpose }, cancel_at: null, cancel_at_period_end: false,
    items: { data: [{ id: "si_primary", price: { id: priceId }, current_period_end: now + 3600 }] },
    latest_invoice: invoice,
  };
  let existingSubscription = false;
  let invoicePeriodEnd = now + 3600;
  let lastCheckout;
  const stripe = {
    webhooks: stripesdk.webhooks,
    customers: { async create(_params, options) { customerCalls.push(options); return { id: "cus_vendor" }; } },
    checkout: { sessions: { async create(params, options) {
      lastCheckout = params;
      checkoutCalls.push({ params, options });
      return { url: "https://checkout.stripe.com/example" };
    } } },
    subscriptions: {
      async *list(params) {
        assert.equal(params.customer, "cus_vendor");
        if (existingSubscription) yield sub;
      },
      async retrieve(subscriptionId) {
        assert.equal(subscriptionId, sub.id);
        return structuredClone(sub);
      },
      async update(subscriptionId, params) {
        cancellations.push({ subscriptionId, params });
        sub.cancel_at_period_end = params.cancel_at_period_end;
        sub.cancel_at = now + 1800;
        return structuredClone(sub);
      },
    },
    invoices: { async *listLineItems(invoiceId) {
      assert.equal(invoiceId, invoice.id);
      yield {
        parent: { subscription_item_details: { subscription_item: "si_primary", proration: false } },
        pricing: { price_details: { price: priceId } },
        period: { start: now - 10, end: invoicePeriodEnd },
      };
    } },
  };
  const payments = createPayments(stripe, store, { origin, priceId, webhookSecret: secret, liveMode: false });
  const auth = {
    handler: () => new Response("ok"),
    api: { async verifyJWT({ body: { token } }) {
      return { payload: token && { sub: token, exp: Date.now() / 1000 + 60 } };
    } },
    $context: Promise.resolve({ internalAdapter: {
      async findUserById(id) {
        const user = rows.user.find(({ _id }) => _id === id);
        return user && { ...user, id };
      },
    } }),
  };
  const app = createApp(auth, origin, serviceStore, undefined, payments);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  const actor = (role) => rows.user.find((entry) => entry.role === role)?._id;
  const request = (path, { method = "GET", token = vendorId, body } = {}) => fetch(base + "/api/payments/" + path, {
    method,
    headers: {
      ...(token && { authorization: "Bearer " + token }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: JSON.stringify(body),
  });
  const getStatus = async () => (await request("subscription")).json();
  const event = (id, type, object) => ({ id, type, created: now, livemode: false, data: { object } });
  function deliver(evt, invalid = false) {
    const body = JSON.stringify(evt, null, 1);
    const signature = stripesdk.webhooks.generateTestHeaderString({ payload: body, secret });
    return fetch(base + "/api/webhooks/stripe", {
      method: "POST", body: invalid ? body + " " : body,
      headers: { "content-type": "application/json", "stripe-signature": signature },
    });
  }

  const preservedAdmin = structuredClone(rows.user[2]);
  const preservedCredential = structuredClone(rows.account[0]);
  const createService = () => serviceStore.create({ id: vendorId, role: "vendor" }, {
    title: "Service", category: "Photo", description: "A wedding service", price: 100, location: "London", isActive: true,
  });

  await t.test("only vendors can access payments and checkout uses the server price", async () => {
    for (const [token, status] of [[null, 401], [actor("customer"), 403], [actor("admin"), 403]]) {
      assert.equal((await request("create-checkout-session", { method: "POST", token })).status, status);
      assert.equal((await request("cancel-subscription", { method: "POST", token })).status, status);
    }
    assert.equal((await request("create-checkout-session", { method: "POST", body: { priceId: "price_client", userId: otherId } })).status, 400);
    const [first, retry] = await Promise.all([
      request("create-checkout-session", { method: "POST" }),
      request("create-checkout-session", { method: "POST", body: {} }),
    ]);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 201);
    assert.deepEqual(await first.json(), { url: "https://checkout.stripe.com/example" });
    assert.deepEqual(checkoutCalls[0], checkoutCalls[1]);
    assert.ok(customerCalls.every(({ idempotencyKey }) => idempotencyKey === customerCalls[0].idempotencyKey));
    assert.deepEqual(lastCheckout.line_items, [{ price: priceId, quantity: 1 }]);
    assert.equal(lastCheckout.mode, "subscription");
    assert.equal(lastCheckout.client_reference_id, vendorId);
    assert.deepEqual(lastCheckout.metadata, lastCheckout.subscription_data.metadata);
    assert.equal(lastCheckout.success_url, origin + "/payment/success?session_id={CHECKOUT_SESSION_ID}");
    assert.equal(lastCheckout.cancel_url, origin + "/payment/cancel");
    assert.equal((await getStatus()).plan, "free");
    const reserved = lastCheckout.metadata.attemptId;
    assert.equal((await deliver(event("evt_expired", "checkout.session.expired", {
      mode: "subscription", customer: "cus_vendor", metadata: lastCheckout.metadata,
    }))).status, 200);
    assert.equal(rows.stripeBilling[0].attempt, undefined);
    assert.equal((await request("create-checkout-session", { method: "POST" })).status, 201);
    assert.notEqual(lastCheckout.metadata.attemptId, reserved);
    existingSubscription = true;
    assert.equal((await request("create-checkout-session", { method: "POST" })).status, 409);
  });

  await t.test("free vendors are capped and signed checkout cannot provision unpaid Premium", async () => {
    for (let i = 0; i < 3; i++) await createService();
    await assert.rejects(createService(), /at most 3 active services/);
    const completion = event("evt_checkout", "checkout.session.completed", {
      ...lastCheckout, subscription: sub.id, payment_status: "unpaid",
    });
    assert.equal((await deliver(completion, true)).status, 400);
    assert.equal(rows.stripeWebhookEvents.some(({ _id }) => _id === completion.id), false);
    assert.equal((await deliver(completion)).status, 200);
    assert.equal((await getStatus()).plan, "free");
  });

  await t.test("paid checkout and invoice provision Premium, concurrent redelivery is durable", async () => {
    sub.status = "active";
    invoice.status = "paid";
    const completion = event("evt_checkout_paid", "checkout.session.completed", {
      ...lastCheckout, subscription: sub.id, payment_status: "paid",
    });
    assert.equal((await deliver(completion)).status, 200);
    assert.equal((await getStatus()).plan, "premium");
    const paid = event("evt_paid", "invoice.paid", { ...invoice });
    failNextReceipt();
    assert.equal((await deliver(paid)).status, 503);
    assert.equal(rows.stripeTransactions.length, 0, "invoice rolls back when receipt fails");
    const deliveries = await Promise.all([deliver(paid), deliver(paid)]);
    assert.deepEqual(deliveries.map(({ status }) => status), [200, 200]);
    assert.equal((await deliver(paid)).status, 200);
    assert.equal(rows.stripeWebhookEvents.filter(({ _id }) => _id === paid.id).length, 1);
    assert.equal(rows.stripeTransactions.length, 1);
    await createService();
    await createService();
    const history = await (await request("transactions?page=1&limit=1")).json();
    assert.equal(history.pagination.total, 1);
    assert.deepEqual(Object.keys(history.data[0]).sort(), ["amount", "createdAt", "currency", "id", "status", "type"]);
    assert.equal((await (await request("transactions", { token: otherId })).json()).pagination.total, 0);
    assert.equal((await request("transactions?vendorId=" + otherId)).status, 400);
  });

  await t.test("failed renewal removes access, late failure cannot overwrite a paid invoice", async () => {
    const oldPaidFailure = event("evt_old_failed", "invoice.payment_failed", { ...invoice });
    assert.equal((await deliver(oldPaidFailure)).status, 200);
    assert.equal((await getStatus()).plan, "premium");
    assert.equal(rows.stripeTransactions[0].status, "paid");
    sub.status = "past_due";
    invoice.id = "in_renewal";
    invoice.status = "open";
    assert.equal((await deliver(event("evt_renewal_failed", "invoice.payment_failed", { ...invoice }))).status, 200);
    assert.equal((await getStatus()).plan, "free");
    assert.equal(rows.stripeTransactions.find(({ _id }) => _id === invoice.id).status, "failed");
    await assert.rejects(createService(), /at most 3 active services/);
  });

  await t.test("renewal, owner-only cancellation, expiration and deletion", async () => {
    sub.status = "active";
    invoice.status = "paid";
    assert.equal((await deliver(event("evt_renewal_paid", "invoice.paid", { ...invoice }))).status, 200);
    assert.equal((await getStatus()).plan, "premium");
    assert.equal((await request("cancel-subscription", { method: "POST", token: otherId })).status, 404);
    assert.equal((await request("cancel-subscription", { method: "POST", body: { subscriptionId: "sub_other" } })).status, 400);
    assert.equal((await request("cancel-subscription", { method: "POST" })).status, 200);
    assert.deepEqual(cancellations, [{ subscriptionId: sub.id, params: { cancel_at_period_end: true } }]);
    assert.equal((await deliver(event("evt_updated", "customer.subscription.updated", { ...sub }))).status, 200);
    const scheduled = await getStatus();
    assert.equal(scheduled.plan, "premium");
    assert.equal(scheduled.renewsAt, null);
    assert.equal(scheduled.cancelAtPeriodEnd, true);
    assert.equal(new Date(scheduled.expiresAt).getTime(), (now + 1800) * 1000);

    invoicePeriodEnd = now - 1;
    assert.equal((await deliver(event("evt_expired_period", "customer.subscription.updated", { ...sub }))).status, 200);
    assert.equal((await getStatus()).plan, "free");
    sub.status = "canceled";
    assert.equal((await deliver(event("evt_deleted", "customer.subscription.deleted", { ...sub }))).status, 200);
    assert.equal((await deliver(event("evt_late_update", "customer.subscription.updated", { ...sub, status: "active" }))).status, 200);
    assert.equal((await getStatus()).status, "canceled");
    assert.equal(rows.user[0].subscriptionPlan, "free");
    assert.equal(rows.user[0].name, "Original Vendor");
    assert.deepEqual(rows.user[2], preservedAdmin);
    assert.deepEqual(rows.account[0], preservedCredential);
    assert.equal(rows.user.length, 4);
  });
});
