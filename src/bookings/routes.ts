import { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { ZodError } from "zod";

import type { Auth } from "../auth/auth.js";
import { requireBearerUser } from "../auth/protection.js";
import { managementQuery } from "../services/schemas.js";
import { bookingId, createBooking, transitionBody } from "./schemas.js";
import { BookingError, type BookingRecord, type BookingStore } from "./store.js";

function serialize({ _id, serviceId, ...booking }: BookingRecord) {
  return { id: _id.toHexString(), serviceId: serviceId.toHexString(), ...booking };
}

export function createBookingRouter(store: BookingStore, auth: Auth) {
  const router = Router();
  const customer = requireBearerUser(auth, ["customer"]);
  const vendor = requireBearerUser(auth, ["vendor"]);
  const admin = requireBearerUser(auth, ["admin"]);

  router.post("/", customer, async (request, response) => {
    const booking = await store.create(response.locals.profile.id, createBooking.parse(request.body));
    response.location(`/api/bookings/${booking._id.toHexString()}`);
    response.status(201).json({ data: serialize(booking) });
  });

  const list = (owner?: "customerId" | "vendorId"): RequestHandler => async (request, response) => {
    const scope = owner ? { [owner]: response.locals.profile.id } : {};
    const result = await store.list(scope, managementQuery.parse(request.query));
    response.json({ data: result.data.map(serialize), pagination: result.pagination });
  };

  router.get("/my", customer, list("customerId"));
  router.get("/vendor", vendor, list("vendorId"));
  router.get("/admin", admin, list());
  router.get("/admin/:id", admin, async (request, response) => {
    response.json({ data: serialize(await store.detail(bookingId.parse(request.params.id), {})) });
  });

  router.get("/:id", requireBearerUser(auth, ["customer", "vendor"]), async (request, response) => {
    const { id, role } = response.locals.profile;
    const scope = role === "vendor" ? { vendorId: id } : { customerId: id };
    response.json({ data: serialize(await store.detail(bookingId.parse(request.params.id), scope)) });
  });

  router.patch("/:id/cancel", customer, async (request, response) => {
    transitionBody.parse(request.body);
    response.json({ data: serialize(await store.cancel(bookingId.parse(request.params.id), response.locals.profile.id)) });
  });

  for (const [action, status] of [["accept", "accepted"], ["reject", "rejected"]] as const) {
    router.patch(`/:id/${action}`, vendor, async (request, response) => {
      transitionBody.parse(request.body);
      response.json({ data: serialize(await store.decide(bookingId.parse(request.params.id), response.locals.profile.id, status)) });
    });
  }

  return router;
}

export const bookingErrors: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "Invalid booking request",
      issues: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
    });
    return;
  }
  if (error instanceof BookingError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (typeof error === "object" && error !== null && "type" in error) {
    if (error.type === "entity.parse.failed") {
      response.status(400).json({ error: "Invalid request body" });
      return;
    }
    if (error.type === "entity.too.large") {
      response.status(413).json({ error: "Request body too large" });
      return;
    }
  }
  next(error);
};
