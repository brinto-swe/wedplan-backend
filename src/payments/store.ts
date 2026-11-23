import { randomUUID } from "node:crypto";
import { MongoServerError, ObjectId, type Db, type MongoClient } from "mongodb";

import { authCollections } from "../auth/schema.js";

export type SubscriptionState = {
  id: string;
  created: number;
  status: string;
  periodEnd: Date | null;
  paidThrough: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
};

type Attempt = { id: string; expiresAt: number };
type Billing = {
  _id: string;
  customerId?: string;
  attempt?: Attempt;
  subscription?: SubscriptionState;
  revision: number;
};
export type Transaction = {
  _id: string;
  vendorId: string;
  customerId: string;
  subscriptionId: string;
  eventId: string;
  amount: number;
  currency: string;
  status: "paid" | "failed";
  type: "subscription";
  createdAt: Date;
};
type Receipt = { _id: string; type: string; status: "processed" | "ignored"; processedAt: Date };
type WebhookChange = {
  billing: Billing;
  subscription?: SubscriptionState;
  clearAttemptId?: string;
  transaction?: Transaction;
};

export function createPaymentStore(client: MongoClient, db: Db) {
  const billing = db.collection<Billing>("stripeBilling");
  const events = db.collection<Receipt>("stripeWebhookEvents");
  const invoices = db.collection<Transaction>("stripeTransactions");
  const users = db.collection(authCollections.user);

  return {
    async ensureIndexes() {
      // MongoDB's built-in unique _id indexes cover vendor, event and invoice IDs.
      await Promise.all([
        billing.createIndex({ customerId: 1 }, { unique: true, sparse: true }),
        events.createIndex({ processedAt: -1 }),
        invoices.createIndex({ vendorId: 1, createdAt: -1, _id: -1 }),
      ]);
    },
    findBilling(vendorId: string) {
      return billing.findOne({ _id: vendorId });
    },
    findCustomer(customerId: string) {
      return billing.findOne({ customerId });
    },
    async saveCustomer(vendorId: string, customerId: string) {
      try {
        await billing.updateOne({ _id: vendorId }, { $setOnInsert: { customerId, revision: 0 } }, { upsert: true });
      } catch (error) {
        if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
      }
      const saved = await billing.findOne({ _id: vendorId });
      if (!saved?.customerId) throw new Error("Stripe customer could not be linked");
      return saved.customerId;
    },
    async reserveCheckout(vendorId: string) {
      const now = Math.floor(Date.now() / 1000);
      const attempt = { id: randomUUID(), expiresAt: now + 7200 };
      const reserved = await billing.findOneAndUpdate(
        { _id: vendorId, $or: [{ attempt: { $exists: false } }, { "attempt.expiresAt": { $lte: now } }] },
        { $set: { attempt } },
        { returnDocument: "after" },
      );
      return (reserved ?? await billing.findOne({ _id: vendorId }))?.attempt;
    },
    eventExists(id: string) {
      return events.findOne({ _id: id }, { projection: { _id: 1 } });
    },
    async applyEvent(id: string, type: string, change?: WebhookChange) {
      return client.withSession((session) => session.withTransaction(async () => {
        if (await events.findOne({ _id: id }, { session })) return true;

        if (change) {
          const current = await billing.findOne({ _id: change.billing._id }, { session });
          if (!current || current.revision !== change.billing.revision) return false;
          const update = { $inc: { revision: 1 } } as {
            $inc: { revision: number };
            $set?: { subscription: SubscriptionState };
            $unset?: { attempt: "" };
          };
          if (change.subscription) update.$set = { subscription: change.subscription };
          if (change.clearAttemptId && current.attempt?.id === change.clearAttemptId) update.$unset = { attempt: "" };
          await billing.updateOne({ _id: current._id }, update, { session });

          if (change.subscription) {
            const paidThrough = change.subscription.paidThrough;
            await users.updateOne(
              { _id: new ObjectId(current._id), role: "vendor" },
              { $set: {
                subscriptionPlan: paidThrough && paidThrough.getTime() > Date.now() ? "premium" : "free",
                subscriptionExpiresAt: paidThrough,
              } },
              { session },
            );
          }
          if (change.transaction) {
            const previous = await invoices.findOne({ _id: change.transaction._id }, { session });
            if (!previous || (previous.status !== "paid" && previous.vendorId === current._id)) {
              await invoices.replaceOne({ _id: change.transaction._id }, change.transaction, { session, upsert: true });
            }
          }
        }

        await events.insertOne({ _id: id, type, status: change ? "processed" : "ignored", processedAt: new Date() }, { session });
        return true;
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } })).catch(async (error: unknown) => {
        if (error instanceof MongoServerError && error.code === 11000 && await events.findOne({ _id: id })) return true;
        throw error;
      });
    },
    async listTransactions(vendorId: string, page: number, limit: number) {
      const filter = { vendorId };
      const [data, total] = await Promise.all([
        invoices.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        invoices.countDocuments(filter),
      ]);
      return {
        data: data.map(({ _id, amount, currency, status, type, createdAt }) => ({
          id: _id, amount, currency, status, type, createdAt,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    },
  };
}

export type PaymentStore = ReturnType<typeof createPaymentStore>;
