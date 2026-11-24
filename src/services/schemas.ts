import { ObjectId } from "mongodb";
import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const serviceFields = z.strictObject({
  title: text(120),
  description: text(5000),
  category: text(80),
  price: z.number().min(0).max(1_000_000_000),
  location: text(120),
  isActive: z.boolean(),
});

export const createService = serviceFields.partial({ isActive: true })
  .transform((input) => ({ ...input, isActive: input.isActive ?? true }));
export const updateService = serviceFields.partial()
  .refine((input) => Object.keys(input).length > 0, "Provide at least one field");

const positiveInteger = z.string().regex(/^[1-9][0-9]*$/).transform(Number);
const pagination = z.strictObject({
  page: positiveInteger.pipe(z.number().max(10_000)).default(1),
  limit: positiveInteger.pipe(z.number().max(100)).default(20),
});

export const publicQuery = pagination.extend({
  category: text(80).optional(),
  location: text(120).optional(),
  q: text(120).optional(),
});
export const managementQuery = pagination;
export const serviceId = z.string().regex(/^[a-f0-9]{24}$/i).transform((id) => new ObjectId(id));
export const adminServiceQuery = pagination.extend({
  q: text(120).optional(),
  category: text(80).optional(),
  vendorId: serviceId.transform((id) => id.toHexString()).optional(),
  visibility: z.enum(["active", "inactive"]).optional(),
});

export type ServiceInput = z.output<typeof createService>;
export type ListQuery = z.output<typeof publicQuery>;
export type AdminServiceQuery = z.output<typeof adminServiceQuery>;
