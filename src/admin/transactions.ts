import type { Db, Filter } from "mongodb";

import { findVendorDisplay } from "../auth/vendor-display.js";
import { stripeTransactionsCollection, type Transaction } from "../payments/store.js";
import type { AdminTransactionQuery } from "./schemas.js";

const projection = {
  _id: 1, vendorId: 1, amount: 1, currency: 1, status: 1, type: 1, plan: 1, createdAt: 1,
} as const;

function formatTransaction(transaction: Transaction) {
  return {
    id: transaction._id,
    vendorId: transaction.vendorId,
    amount: transaction.amount,
    amountUnit: "minor" as const,
    currency: transaction.currency,
    status: transaction.status,
    type: transaction.type,
    plan: transaction.plan === "premium" ? transaction.plan : null,
    createdAt: transaction.createdAt,
    dateBasis: "stripe_invoice_event" as const,
  };
}

export function createAdminTransactionStore(db: Db) {
  const transactions = db.collection<Transaction>(stripeTransactionsCollection);

  return {
    async list({ page, limit, q, status, vendorId, currency, from, to }: AdminTransactionQuery) {
      const filter: Filter<Transaction> = {};
      if (q) filter._id = new RegExp("^" + q);
      if (status) filter.status = status;
      if (vendorId) filter.vendorId = vendorId;
      if (currency) filter.currency = currency;
      if (from || to) {
        filter.createdAt = {
          ...(from && { $gte: new Date(from) }),
          ...(to && { $lt: new Date(Date.parse(to) + 86_400_000) }),
        };
      }
      const [rows, total] = await Promise.all([
        transactions.find(filter, { projection }).sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit).limit(limit).toArray(),
        transactions.countDocuments(filter),
      ]);
      const vendors = await findVendorDisplay(db, rows.map(({ vendorId }) => vendorId));
      return {
        data: rows.map((row) => ({ ...formatTransaction(row), vendor: vendors.get(row.vendorId) ?? null })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    },

    async find(id: string) {
      const row = await transactions.findOne({ _id: id }, { projection });
      if (!row) return null;
      const vendors = await findVendorDisplay(db, [row.vendorId]);
      return { ...formatTransaction(row), vendor: vendors.get(row.vendorId) ?? null, invoiceCreatedAt: null, billingPeriod: null };
    },
  };
}

export type AdminTransactionStore = ReturnType<typeof createAdminTransactionStore>;
