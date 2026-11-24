import { z } from "zod";

import { managementQuery, serviceId } from "../services/schemas.js";

export const userId = serviceId;

export const userQuery = managementQuery.extend({
  q: z.string().trim().min(1).max(254).optional(),
  role: z.enum(["customer", "vendor", "admin"]).optional(),
  status: z.enum(["active", "blocked"]).optional(),
});

export const userStatus = z.strictObject({
  status: z.enum(["active", "blocked"]),
});

export type UserQuery = z.output<typeof userQuery>;
export type UserStatus = z.output<typeof userStatus>["status"];

export const invoiceId = z.string().regex(/^in_[A-Za-z0-9]{1,125}$/);

export const adminTransactionQuery = managementQuery.extend({
  q: z.string().trim().regex(/^[A-Za-z0-9_]{1,128}$/).optional(),
  status: z.enum(["paid", "failed"]).optional(),
  vendorId: userId.transform((id) => id.toHexString()).optional(),
  currency: z.string().regex(/^[a-z]{3}$/i).transform((code) => code.toLowerCase()).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).refine(({ from, to }) => !from || !to || from <= to, {
  path: ["to"], message: "End date must be on or after start date",
});

export type AdminTransactionQuery = z.output<typeof adminTransactionQuery>;
