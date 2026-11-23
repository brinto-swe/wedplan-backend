import { mongodbAdapter } from "@better-auth/mongo-adapter";
import type { Db, MongoClient } from "mongodb";

export const authCollections = { user: "user", account: "account" } as const;

export function authDatabase(db: Db, client: MongoClient) {
  return mongodbAdapter(db, { client });
}

export const accountOptions = {
  modelName: authCollections.account,
  accountLinking: { enabled: false },
} as const;

export const userFields = {
  role: { type: "string", required: false, input: false, defaultValue: "customer" },
  isBlocked: { type: "boolean", required: false, input: false, defaultValue: false },
  businessName: { type: "string", required: false, defaultValue: "" },
  subscriptionPlan: { type: "string", required: false, input: false, defaultValue: "free" },
  seedMarker: { type: "string", required: false, input: false, returned: false },
  subscriptionExpiresAt: { type: "date", required: false, input: false },
} as const;

export function initialUserFields(role: "customer" | "vendor" | "admin") {
  return { role, isBlocked: false, subscriptionPlan: "free", subscriptionExpiresAt: null };
}
