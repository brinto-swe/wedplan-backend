import { ObjectId } from "mongodb";
import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);

export const bookingId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid ID")
  .transform((value) => new ObjectId(value));

export const contact = z.strictObject({
  name: text(120),
  email: text(254).pipe(z.email()),
  phone: text(32).regex(/^\+?[\d ().-]+$/, "Invalid phone number")
    .refine((value) => (value.match(/\d/g)?.length ?? 0) >= 7, "Phone number must have at least 7 digits"),
});

export const createBooking = z.strictObject({
  serviceId: bookingId,
  eventDate: z.iso.date(),
  eventLocation: text(200),
  customerContact: contact,
  notes: z.string().trim().max(2000).optional(),
});

export const transitionBody = z.strictObject({}).optional();

export type BookingInput = z.output<typeof createBooking>;
