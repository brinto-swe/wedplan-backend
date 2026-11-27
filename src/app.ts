import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";

import type { Auth } from "./auth/auth.js";
import { requireBearerUser } from "./auth/protection.js";
import { createAdminRouter } from "./admin/routes.js";
import type { AdminUserStore } from "./admin/store.js";
import type { AdminTransactionStore } from "./admin/transactions.js";
import type { AdminOverviewStore } from "./admin/overview.js";

import { createServiceRouter, serviceErrors } from "./services/routes.js";
import type { ServiceStore } from "./services/store.js";

import { bookingErrors, createBookingRouter } from "./bookings/routes.js";
import type { BookingStore } from "./bookings/store.js";
import { paymentRouter, stripeWebhook } from "./payments/routes.js";
import type { Payments } from "./payments/service.js";
import { imageUploadRouter } from "./uploads/images.js";

export function createApp(
  auth: Auth, clientOrigin: string, services: ServiceStore, bookings?: BookingStore, payments?: Payments,
  adminUsers?: AdminUserStore, adminTransactions?: AdminTransactionStore, adminOverview?: AdminOverviewStore,
  imgbbApiKey?: string,
) {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: clientOrigin, credentials: true }));

  if (payments) app.use("/api/webhooks/stripe", stripeWebhook(payments));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  if (adminUsers) app.use("/api/admin", createAdminRouter(adminUsers, auth, services, adminTransactions, adminOverview));
  app.use("/api/uploads", imageUploadRouter(auth, imgbbApiKey));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/api/me", requireBearerUser(auth), (_request, response) => {
    response.json(response.locals.profile);
  });

  app.use("/api/services", createServiceRouter(services, requireBearerUser(auth, ["vendor", "admin"])));
  app.use("/api/services", serviceErrors);

  if (bookings) {
    app.use("/api/bookings", createBookingRouter(bookings, auth));
    app.use("/api/bookings", bookingErrors);
  }
  if (payments) app.use("/api/payments", paymentRouter(payments, auth));

  const handleError: ErrorRequestHandler = (_error, _request, response, next) => {
    console.error("API request failed.");
    if (response.headersSent) {
      next(new Error("API request failed"));
      return;
    }
    response.status(500).json({ error: "Request failed" });
  };
  app.use(handleError);

  return app;
}
