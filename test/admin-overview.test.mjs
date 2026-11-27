import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { ObjectId } from "mongodb";

import { createAdminOverviewStore } from "../dist/src/admin/overview.js";
import { createApp } from "../dist/src/app.js";

import { aggregate } from "./fixtures/aggregate.mjs";

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
    services: [
      { isActive: true, vendorId: String(premium._id) },
      { isActive: true, vendorId: String(free._id) },
      { isActive: false, vendorId: String(free._id) },
      { isActive: true, moderationStatus: "pending", vendorId: String(free._id) },
      { isActive: true, moderationStatus: "rejected", vendorId: String(free._id) },
    ],
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
    services: { total: 5, active: 2, inactive: 3, pending: 1 },
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
    services: { total: 0, active: 0, inactive: 0, pending: 0 },
    bookings: { total: 0, pending: 0, accepted: 0, rejected: 0, cancelled: 0 },
    subscriptions: { premium: 0, free: 0, cancellationScheduled: 0 },
    revenue: { ...expectedRevenue, paidInvoiceCount: 0, failedInvoiceCount: 0, paidByCurrency: [] },
  } });
});
