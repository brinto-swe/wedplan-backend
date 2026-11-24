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
