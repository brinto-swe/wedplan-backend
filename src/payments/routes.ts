import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";

import type { Auth } from "../auth/auth.js";
import { requireBearerUser } from "../auth/protection.js";
import { PaymentError, type Payments } from "./service.js";

const empty = z.strictObject({}).optional();
const pageQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function stripeWebhook(payments: Payments) {
  const router = express.Router();
  router.post("/", express.raw({ type: "application/json", limit: "1mb", inflate: false }), async (request, response) => {
    const signature = request.get("stripe-signature");
    if (!signature || !Buffer.isBuffer(request.body)) {
      response.status(400).json({ error: "Stripe signature and raw body required" });
      return;
    }
    let event;
    try {
      event = payments.verifyWebhook(request.body, signature);
    } catch {
      response.status(400).json({ error: "Invalid Stripe signature" });
      return;
    }
    await payments.handleEvent(event);
    response.json({ received: true });
  });
  router.use(paymentErrors);
  return router;
}

export function paymentRouter(payments: Payments, auth: Auth) {
  const router = express.Router();
  router.use(requireBearerUser(auth, ["vendor"]));
  router.post("/create-checkout-session", async (request, response) => {
    if (!empty.safeParse(request.body).success) {
      response.status(400).json({ error: "Checkout accepts no additional fields" });
      return;
    }
    response.status(201).json(await payments.checkout(response.locals.profile.id));
  });
  router.get("/subscription", async (_request, response) => {
    response.json(await payments.subscription(response.locals.profile.id));
  });
  router.get("/transactions", async (request, response) => {
    const query = pageQuery.safeParse(request.query);
    if (!query.success) {
      response.status(400).json({ error: "Invalid pagination" });
      return;
    }
    response.json(await payments.listTransactions(response.locals.profile.id, query.data.page, query.data.limit));
  });
  router.post("/cancel-subscription", async (request, response) => {
    if (!empty.safeParse(request.body).success) {
      response.status(400).json({ error: "Cancellation accepts no additional fields" });
      return;
    }
    response.json(await payments.cancel(response.locals.profile.id));
  });
  router.use(paymentErrors);
  return router;
}

const paymentErrors: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(new Error("Payment request failed"));
    return;
  }
  if (error instanceof PaymentError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error?.type === "entity.too.large" || error?.type === "encoding.unsupported") {
    response.status(error.status).json({ error: "Invalid webhook body" });
    return;
  }
  console.error("Payment request failed.");
  response.status(503).json({ error: "Payment service unavailable. Please retry." });
};
