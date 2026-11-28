import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { ObjectId } from "mongodb";

import { createAdminTransactionStore } from "../dist/src/admin/transactions.js";
import { createApp } from "../dist/src/app.js";

test("Admin transaction routes read the Stripe ledger through safe projections", async (t) => {
  const vendor = new ObjectId();
  const other = new ObjectId();
  const rows = [
    { _id: "in_Alpha1", plan: "premium", vendorId: String(vendor), status: "paid", currency: "usd", createdAt: new Date("2026-01-10T00:00:00Z") },
    { _id: "in_Alpha2", vendorId: String(vendor), status: "failed", currency: "eur", createdAt: new Date("2026-01-10T23:59:59Z") },
    { _id: "in_Beta1", vendorId: String(other), status: "paid", currency: "usd", createdAt: new Date("2026-01-11T00:00:00Z") },
  ].map((row) => ({ ...row, amount: 1500, type: "subscription", customerId: "synthetic",
    eventId: "synthetic", subscriptionId: "synthetic", paymentMethod: "synthetic" }));
  const snapshot = structuredClone(rows);
  const allFields = ["amount", "amountUnit", "createdAt", "currency", "dateBasis", "id", "plan", "status", "type", "vendor", "vendorId"].sort();
  const projectionFields = ["_id", "amount", "createdAt", "currency", "plan", "status", "type", "vendorId"];
  const actors = {
    admin: { id: "admin", role: "admin" },
    blocked: { id: "blocked", role: "admin", isBlocked: true },
    customer: { id: "customer", role: "customer" },
    vendor: { id: "vendor", role: "vendor" },
  };
  let previousFilter;
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (value instanceof RegExp) return value.test(row[key]);
    if (key === "createdAt") return (!value.$gte || row.createdAt >= value.$gte) && (!value.$lt || row.createdAt < value.$lt);
    return row[key] === value;
  });
  const db = { collection(name) {
    if (name === "user") return { find(filter, { projection }) {
      assert.deepEqual(projection, { _id: 1, name: 1, businessName: 1 });
      assert.equal(filter.role, "vendor");
      return { async toArray() { return filter._id.$in.some((id) => id.equals(vendor)) ?
        [{ _id: vendor, name: "Fixture Vendor", businessName: "Fixture Studio", token: "synthetic", email: "private@example.test" }] : []; } };
    } };
    assert.equal(name, "stripeTransactions");
    return {
      find(filter, { projection }) {
        assert.deepEqual(Object.keys(projection).sort(), projectionFields);
        previousFilter = filter;
        let result = rows.filter((row) => matches(row, filter));
        return {
          sort(order) { assert.deepEqual(order, { createdAt: -1, _id: -1 }); result.sort((a, b) => b.createdAt - a.createdAt || b._id.localeCompare(a._id)); return this; },
          skip(n) { result = result.slice(n); return this; },
          limit(n) { result = result.slice(0, n); return this; },
          async toArray() { return result; },
        };
      },
      async countDocuments(filter) {
        assert.equal(previousFilter, filter);
        return rows.filter((row) => matches(row, filter)).length;
      },
      async findOne(filter, { projection }) {
        assert.deepEqual(Object.keys(projection).sort(), projectionFields);
        return rows.find((row) => matches(row, filter)) ?? null;
      },
    };
  } };
  const auth = {
    handler: () => new Response(null),
    api: { async verifyJWT({ body }) {
      return { payload: { sub: body.token, exp: Date.now() / 1000 + 60, role: "admin" } };
    } },
    $context: Promise.resolve({ internalAdapter: { async findUserById(id) { return actors[id]; } } }),
  };
  const server = createApp(auth, "http://localhost:3000", {}, undefined, undefined, {}, createAdminTransactionStore(db))
    .listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port + "/api/admin/transactions";
  const request = (path = "", actor = "admin", method = "GET") => fetch(base + path, {
    method, headers: actor ? { Authorization: "Bearer " + actor } : {},
  });

  for (const [actor, status] of [[null, 401], ["customer", 403], ["vendor", 403], ["blocked", 403]]) {
    assert.equal((await request("", actor)).status, status);
    assert.equal((await request("/in_Alpha1", actor)).status, status);
  }
  for (const [query, ids, total] of [
    ["", ["in_Beta1", "in_Alpha2", "in_Alpha1"], 3],
    ["?page=2&limit=1", ["in_Alpha2"], 3],
    ["?q=in_Alpha", ["in_Alpha2", "in_Alpha1"], 2],
    ["?status=failed", ["in_Alpha2"], 1],
    ["?vendorId=" + vendor.toHexString().toUpperCase(), ["in_Alpha2", "in_Alpha1"], 2],
    ["?currency=USD", ["in_Beta1", "in_Alpha1"], 2],
    ["?from=2026-01-10&to=2026-01-10", ["in_Alpha2", "in_Alpha1"], 2],
    ["?from=2026-01-11", ["in_Beta1"], 1],
    ["?to=2026-01-10", ["in_Alpha2", "in_Alpha1"], 2],
    ["?q=in_Alpha&status=paid&currency=usd&vendorId=" + vendor + "&from=2026-01-10&to=2026-01-10", ["in_Alpha1"], 1],
    ["?currency=GBP", [], 0],
  ]) {
    const response = await request(query);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { data, pagination } = await response.json();
    assert.equal(pagination.total, total);
    assert.deepEqual(data.map(({ id }) => id), ids);
    if (query.startsWith("?page=")) assert.deepEqual(pagination, { page: 2, limit: 1, total: 3, totalPages: 3 });
    for (const transaction of data) {
      assert.deepEqual(Object.keys(transaction).sort(), allFields);
      assert.equal(transaction.plan, transaction.id === "in_Alpha1" ? "premium" : null);
      assert.equal(transaction.amountUnit, "minor");
      assert.equal(transaction.dateBasis, "stripe_invoice_event");
      assert.deepEqual(transaction.vendor, transaction.vendorId === String(vendor) ?
        { id: String(vendor), name: "Fixture Vendor", businessName: "Fixture Studio" } : null);
    }
  }
  const response = await request("/in_Alpha1");
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(Object.keys(data).sort(), [...allFields, "billingPeriod", "invoiceCreatedAt"].sort());
  assert.equal(data.plan, "premium");
  assert.equal(data.amount, 1500);
  assert.equal(data.status, "paid");
  assert.equal(data.billingPeriod, null);
  assert.equal(data.invoiceCreatedAt, null);
  assert.equal((await request("/in_Missing")).status, 404);
  for (const path of ["/bad", "?q=.*", "?status=pending", "?vendorId=bad", "?currency=usdollars",
    "?from=2026-02-30", "?to=2026-01-10&from=2026-01-11", "?limit=101", "?page=0", "?page=1&page=2", "?extra=1"]) {
    assert.equal((await request(path)).status, 400);
  }
  for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await request("/in_Alpha1", "admin", method)).status, 404);
  assert.deepEqual(rows, snapshot);
});
