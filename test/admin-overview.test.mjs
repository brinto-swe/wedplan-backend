import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { ObjectId } from "mongodb";

import { createAdminOverviewStore } from "../dist/src/admin/overview.js";
import { createApp } from "../dist/src/app.js";

const get = (row, path) => path.split(".").reduce((value, key) => value?.[key], row);

function evaluate(expression, row) {
  if (typeof expression === "string" && expression.startsWith("$")) return get(row, expression.slice(1));
  if (!expression || typeof expression !== "object" || expression instanceof Date) return expression;
  const [[op, arg]] = Object.entries(expression);
  if (op === "$type") return evaluate(arg, row) instanceof Date ? "date" : typeof evaluate(arg, row);
  if (op === "$convert") {
    const value = evaluate(arg.input, row);
    return ObjectId.isValid(value) ? new ObjectId(value) : null;
  }
  const [a, b, c] = arg.map((operand) => evaluate(operand, row));
  switch (op) {
    case "$eq": return a === b;
    case "$gt": return a > b;
    case "$and": return arg.every((operand) => evaluate(operand, row));
    case "$cond": return a ? b : c;
    default: throw new Error("Unexpected expression " + op);
  }
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((branch) => matches(row, branch));
    const value = get(row, key);
    if (condition === null) return value == null;
    if (typeof condition !== "object") return value === condition;
    return Object.entries(condition).every(([op, operand]) => {
      switch (op) {
        case "$in": return operand.includes(value);
        case "$nin": return !operand.includes(value);
        case "$gt": return value instanceof Date && value > operand;
        case "$type": return typeof value === operand;
        case "$exists": return (value !== undefined) === operand;
        default: throw new Error("Unexpected filter " + op);
      }
    });
  });
}

function aggregate(source, pipeline, collections) {
  let rows = source;
  for (const stage of pipeline) {
    if (stage.$match) rows = rows.filter((row) => matches(row, stage.$match));
    else if (stage.$set) rows = rows.map((row) => ({
      ...row, ...Object.fromEntries(Object.entries(stage.$set).map(([key, value]) => [key, evaluate(value, row)])),
    }));
    else if (stage.$lookup) {
      const { as, from, localField, foreignField, pipeline: inner } = stage.$lookup;
      rows = rows.map((row) => ({
        ...row, [as]: aggregate(collections[from].filter((foreign) =>
          row[localField]?.equals(foreign[foreignField])), inner, collections),
      }));
    } else if (stage.$project) rows = rows.map((row) =>
      Object.fromEntries(Object.keys(stage.$project).map((key) => [key, row[key]])));
    else if (stage.$count) rows = rows.length ? [{ [stage.$count]: rows.length }] : [];
    else if (stage.$sort) rows.sort((a, b) => a._id.localeCompare(b._id));
    else if (stage.$group) {
      const { _id, ...fields } = stage.$group;
      const groups = new Map();
      for (const row of rows) {
        const id = evaluate(_id, row);
        const total = groups.get(id) ?? { _id: id };
        for (const [key, { $sum }] of Object.entries(fields)) {
          total[key] = (total[key] ?? 0) + evaluate($sum, row);
        }
        groups.set(id, total);
      }
      rows = [...groups.values()];
    } else throw new Error("Unexpected aggregation stage");
  }
  return rows;
}

test("Admin overview authorizes requests and aggregates dashboard stats with empty defaults", async (t) => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(0);
  const sampleUser = (role, fields = {}) => ({
    _id: new ObjectId(), role, email: "private@example.test", password: "synthetic", seedMarker: "synthetic", ...fields,
  });
  const premium = sampleUser("vendor", { subscriptionPlan: "premium", subscriptionExpiresAt: future });
  const expired = sampleUser("vendor", { subscriptionPlan: "premium", subscriptionExpiresAt: past });
  const noExpiry = sampleUser("vendor", { subscriptionPlan: "premium" });
  const invalidExpiry = sampleUser("vendor", { subscriptionPlan: "premium", subscriptionExpiresAt: future.toISOString() });
  const free = sampleUser("vendor", { subscriptionPlan: "free", subscriptionExpiresAt: future });
  const customer = sampleUser("customer");
  const bill = (user, subscription) => ({ _id: String(user._id), subscription });
  const collections = {
    user: [premium, expired, noExpiry, invalidExpiry, free, customer, sampleUser(undefined),
      sampleUser("admin", { isBlocked: true }), sampleUser("admin", { isBlocked: false })],
    services: [{ isActive: true }, { isActive: true }, { isActive: false }, {}],
    bookings: ["pending", "pending", "accepted", "rejected", "cancelled"].map((status) => ({ status })),
    stripeBilling: [
      bill(premium, { status: "active", cancelAtPeriodEnd: true, periodEnd: future }),
      bill(noExpiry, { status: "past_due", cancelAt: future }),
      bill(expired, { status: "active", cancelAtPeriodEnd: true, cancelAt: past }),
      bill(invalidExpiry, { status: "canceled", cancelAt: future }),
      bill(customer, { status: "active", cancelAt: future }),
      bill({ _id: "invalid" }, { status: "active", cancelAt: future }),
    ],
    stripeTransactions: [
      { status: "paid", currency: "usd", amount: 1500 },
      { status: "paid", currency: "usd", amount: 500 },
      { status: "failed", currency: "usd", amount: 9999 },
      { status: "paid", currency: "jpy", amount: 1200 },
      { status: "failed", currency: "eur", amount: 100 },
    ].map((row) => ({ ...row, customerId: "synthetic", paymentMethod: "synthetic" })),
  };
  let reads = 0;
  const db = { collection(name) {
    assert.ok(name in collections);
    return { aggregate(pipeline) {
      reads += 1;
      return { async toArray() { return aggregate(collections[name], pipeline, collections); } };
    } };
  } };
  const actors = {
    admin: { id: "admin", role: "admin" },
    blocked: { id: "blocked", role: "admin", isBlocked: true },
    customer: { id: "customer", role: "customer" },
    vendor: { id: "vendor", role: "vendor" },
  };
  const auth = {
    handler: () => new Response(null),
    api: { async verifyJWT({ body }) {
      return { payload: { sub: body.token, exp: Date.now() / 1000 + 60, role: "admin" } };
    } },
    $context: Promise.resolve({ internalAdapter: { async findUserById(id) { return actors[id]; } } }),
  };
  const server = createApp(auth, "http://localhost:3000", {}, undefined, undefined, {}, undefined, createAdminOverviewStore(db))
    .listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port + "/api/admin/overview";
  const request = (actor) => fetch(url, { headers: actor ? { Authorization: "Bearer " + actor } : {} });

  for (const [actor, status] of [[undefined, 401], ["customer", 403], ["vendor", 403], ["blocked", 403]]) {
    assert.equal((await request(actor)).status, status);
  }
  assert.equal(reads, 0);
  const expectedRevenue = { amountUnit: "minor", dateBasis: "stripe_invoice_event" };
  const response = await request("admin");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { data: {
    users: { total: 9, customers: 2, vendors: 5, admins: 2, active: 8, blocked: 1 },
    services: { total: 4, active: 2, inactive: 2 },
    bookings: { total: 5, pending: 2, accepted: 1, rejected: 1, cancelled: 1 },
    subscriptions: { premium: 1, free: 4, cancellationScheduled: 2 },
    revenue: { ...expectedRevenue, paidInvoiceCount: 3, failedInvoiceCount: 2,
      paidByCurrency: [{ currency: "jpy", amount: 1200 }, { currency: "usd", amount: 2000 }] },
  } });
  assert.equal(reads, 5);

  for (const rows of Object.values(collections)) rows.length = 0;
  const empty = await request("admin");
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { data: {
    users: { total: 0, customers: 0, vendors: 0, admins: 0, active: 0, blocked: 0 },
    services: { total: 0, active: 0, inactive: 0 },
    bookings: { total: 0, pending: 0, accepted: 0, rejected: 0, cancelled: 0 },
    subscriptions: { premium: 0, free: 0, cancellationScheduled: 0 },
    revenue: { ...expectedRevenue, paidInvoiceCount: 0, failedInvoiceCount: 0, paidByCurrency: [] },
  } });
});
