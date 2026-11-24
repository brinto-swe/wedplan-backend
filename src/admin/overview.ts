import type { Db, Document } from "mongodb";

import { authCollections } from "../auth/schema.js";
import { premiumEntitlementExpression } from "../payments/entitlement.js";
import { stripeBillingCollection, stripeTransactionsCollection } from "../payments/store.js";

function countIf(condition: Document) {
  return { $sum: { $cond: [condition, 1, 0] } };
}

export function createAdminOverviewStore(db: Db) {
  const users = db.collection(authCollections.user);
  const services = db.collection("services");
  const bookings = db.collection("bookings");
  const billing = db.collection(stripeBillingCollection);
  const transactions = db.collection(stripeTransactionsCollection);

  return {
    async get() {
      const now = new Date();
      const vendor = { $eq: ["$role", "vendor"] };
      const admin = { $eq: ["$role", "admin"] };
      const premium = premiumEntitlementExpression(now);
      const [userRows, serviceRows, bookingRows, cancellationRows, currencyRows] = await Promise.all([
        users.aggregate<{ total: number; vendors: number; admins: number; blocked: number; premium: number }>([
          { $group: { _id: null, total: { $sum: 1 },
            vendors: countIf(vendor), admins: countIf(admin),
            blocked: countIf({ $eq: ["$isBlocked", true] }),
            premium: countIf({ $and: [vendor, premium] }),
          } },
        ]).toArray(),
        services.aggregate<{ total: number; active: number }>([
          { $group: { _id: null, total: { $sum: 1 }, active: countIf({ $eq: ["$isActive", true] }) } },
        ]).toArray(),
        bookings.aggregate<{ total: number; pending: number; accepted: number; rejected: number; cancelled: number }>([
          { $group: { _id: null, total: { $sum: 1 },
            pending: countIf({ $eq: ["$status", "pending"] }),
            accepted: countIf({ $eq: ["$status", "accepted"] }),
            rejected: countIf({ $eq: ["$status", "rejected"] }),
            cancelled: countIf({ $eq: ["$status", "cancelled"] }),
          } },
        ]).toArray(),
        billing.aggregate<{ total: number }>([
          { $match: {
            "subscription.status": { $type: "string", $nin: ["canceled", "incomplete_expired"] },
            $or: [
              { "subscription.cancelAt": { $gt: now } },
              {
                "subscription.cancelAt": null,
                "subscription.cancelAtPeriodEnd": true,
                $or: [{ "subscription.periodEnd": null }, { "subscription.periodEnd": { $gt: now } }],
              },
            ],
          } },
          { $set: { vendorObjectId: { $convert: { input: "$_id", to: "objectId", onError: null, onNull: null } } } },
          { $lookup: {
            from: authCollections.user,
            localField: "vendorObjectId",
            foreignField: "_id",
            pipeline: [{ $match: { role: "vendor" } }, { $project: { _id: 1 } }],
            as: "vendor",
          } },
          { $match: { "vendor.0": { $exists: true } } },
          { $count: "total" },
        ]).toArray(),
        transactions.aggregate<{ _id: string; amount: number; paid: number; failed: number }>([
          { $match: { status: { $in: ["paid", "failed"] } } },
          { $group: { _id: "$currency",
            paid: countIf({ $eq: ["$status", "paid"] }),
            failed: countIf({ $eq: ["$status", "failed"] }),
            amount: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] } },
          } },
          { $sort: { _id: 1 } },
        ]).toArray(),
      ]);

      const user = userRows[0] ?? { total: 0, vendors: 0, admins: 0, blocked: 0, premium: 0 };
      const service = serviceRows[0] ?? { total: 0, active: 0 };
      const booking = bookingRows[0] ?? { total: 0, pending: 0, accepted: 0, rejected: 0, cancelled: 0 };
      return {
        users: {
          total: user.total, customers: user.total - user.vendors - user.admins, vendors: user.vendors,
          admins: user.admins, active: user.total - user.blocked, blocked: user.blocked,
        },
        services: { total: service.total, active: service.active, inactive: service.total - service.active },
        bookings: {
          total: booking.total, pending: booking.pending, accepted: booking.accepted,
          rejected: booking.rejected, cancelled: booking.cancelled,
        },
        subscriptions: { premium: user.premium, free: user.vendors - user.premium, cancellationScheduled: cancellationRows[0]?.total ?? 0 },
        revenue: {
          amountUnit: "minor" as const,
          dateBasis: "stripe_invoice_event" as const,
          paidInvoiceCount: currencyRows.reduce((sum, row) => sum + row.paid, 0),
          failedInvoiceCount: currencyRows.reduce((sum, row) => sum + row.failed, 0),
          paidByCurrency: currencyRows.filter((row) => row.paid > 0).map(({ _id, amount }) => ({ currency: _id, amount })),
        },
      };
    },
  };
}

export type AdminOverviewStore = ReturnType<typeof createAdminOverviewStore>;
