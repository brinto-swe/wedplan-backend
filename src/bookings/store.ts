import { MongoServerError, ObjectId, type Db, type Filter } from "mongodb";

import type { ServiceStore } from "../services/store.js";
import type { BookingInput } from "./schemas.js";

export type BookingStatus = "pending" | "accepted" | "rejected" | "cancelled";
type Transition = Exclude<BookingStatus, "pending">;
type Booking = BookingInput & {
  _id: ObjectId;
  customerId: string;
  vendorId: string;
  status: BookingStatus;
  createdAt: Date;
  updatedAt: Date;
};

export class BookingError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

const todayUtc = (now: Date) => now.toISOString().slice(0, 10);
const notFound = () => new BookingError(404, "Booking not found");

export function createBookingStore(db: Db, services: Pick<ServiceStore, "findPublic">) {
  const bookings = db.collection<Booking>("bookings");
  const sort = { createdAt: -1, _id: -1 } as const;

  async function transition(id: ObjectId, owner: Filter<Booking>, status: Transition) {
    const now = new Date();
    const scope = { _id: id, ...owner };
    const eligible: Filter<Booking> = {
      ...scope, status: "pending",
      ...(status === "cancelled" ? { eventDate: { $gte: todayUtc(now) } } : {}),
    };
    const booking = await bookings.findOneAndUpdate(
      eligible, { $set: { status, updatedAt: now } }, { returnDocument: "after" },
    );
    if (booking) return booking;
    if (!await bookings.findOne(scope, { projection: { _id: 1 } })) throw notFound();
    throw new BookingError(409, "Booking is not eligible for this status change");
  }

  return {
    async ensureIndexes() {
      await bookings.createIndexes([
        { name: "bookings_customer_created", key: { customerId: 1, ...sort } },
        { name: "bookings_vendor_created", key: { vendorId: 1, ...sort } },
        { name: "bookings_created", key: sort },
        {
          name: "bookings_unique_active_event",
          key: { customerId: 1, serviceId: 1, eventDate: 1 },
          unique: true,
          partialFilterExpression: { status: { $in: ["pending", "accepted"] } },
        },
      ]);
    },

    async create(customerId: string, input: BookingInput) {
      if (input.eventDate < todayUtc(new Date())) throw new BookingError(400, "Event date cannot be in the past");
      const service = await services.findPublic(input.serviceId);
      if (!service) throw new BookingError(404, "Active service not found");

      const now = new Date();
      const booking: Booking = {
        ...input, _id: new ObjectId(), customerId, vendorId: service.vendorId,
        status: "pending", createdAt: now, updatedAt: now,
      };
      try {
        await bookings.insertOne(booking);
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) {
          throw new BookingError(409, "An active booking already exists for this service and event date");
        }
        throw error;
      }
      return booking;
    },

    async list(scope: Filter<Booking>, { page, limit }: { page: number; limit: number }) {
      const [data, total] = await Promise.all([
        bookings.find(scope).sort(sort).skip((page - 1) * limit).limit(limit).toArray(),
        bookings.countDocuments(scope),
      ]);
      return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
    },

    async detail(id: ObjectId, scope: Filter<Booking>) {
      const booking = await bookings.findOne({ _id: id, ...scope });
      if (!booking) throw notFound();
      return booking;
    },

    cancel(id: ObjectId, customerId: string) {
      return transition(id, { customerId }, "cancelled");
    },
    decide(id: ObjectId, vendorId: string, status: "accepted" | "rejected") {
      return transition(id, { vendorId }, status);
    },
  };
}

export type BookingStore = ReturnType<typeof createBookingStore>;
export type BookingRecord = Awaited<ReturnType<BookingStore["detail"]>>;
