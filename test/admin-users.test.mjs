import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { ObjectId } from "mongodb";

import { createAdminUserStore } from "../dist/src/admin/store.js";
import { createApp } from "../dist/src/app.js";

const privateFields = {
  password: "synthetic", token: "synthetic", seedMarker: "synthetic", session: "synthetic",
  accessToken: "synthetic", refreshToken: "synthetic", clientSecret: "synthetic",
};
const fields = ["createdAt", "email", "emailVerified", "id", "name", "role", "status", "updatedAt"];
const fixture = (name, role, blocked, day) => ({
  _id: new ObjectId(), name, email: name.split(" ")[0].toLowerCase() + "@example.test", role,
  ...(blocked !== undefined && { isBlocked: blocked }),
  createdAt: new Date(Date.UTC(2025, 0, day)), updatedAt: new Date(Date.UTC(2025, 0, day)),
  ...privateFields,
});

function database(users) {
  function matches(user, filter) {
    return Object.entries(filter).every(([key, value]) => {
      if (key === "$or") return value.some((clause) => matches(user, clause));
      if (value instanceof ObjectId) return value.equals(user[key]);
      if (value instanceof RegExp) return value.test(user[key]);
      if (value && typeof value === "object") {
        if ("$ne" in value) return user[key] !== value.$ne;
        if ("$nin" in value) return !value.$nin.includes(user[key]);
      }
      return user[key] === value;
    });
  }
  function projected(user, projection) {
    assert.deepEqual(Object.keys(projection).sort(), ["_id", "createdAt", "email", "emailVerified", "isBlocked", "name", "role", "updatedAt"]);
    if (!user) return null;
    return { ...Object.fromEntries(Object.keys(projection).map((key) => [key, user[key]])), ...privateFields };
  }
  return { collection(name) {
    assert.equal(name, "user");
    return {
      find(filter, { projection }) {
        let selected = users.filter((row) => matches(row, filter));
        return {
          sort(order) {
            assert.deepEqual(order, { createdAt: -1, _id: -1 });
            selected.sort((a, b) => b.createdAt - a.createdAt || String(b._id).localeCompare(String(a._id)));
            return this;
          },
          skip(count) { selected = selected.slice(count); return this; },
          limit(count) { selected = selected.slice(0, count); return this; },
          async toArray() { return selected.map((user) => projected(user, projection)); },
        };
      },
      async countDocuments(filter) { return users.filter((row) => matches(row, filter)).length; },
      async findOne(filter, { projection }) { return projected(users.find((row) => matches(row, filter)), projection); },
      async findOneAndUpdate(filter, { $set }, { projection, returnDocument }) {
        assert.equal(returnDocument, "after");
        assert.deepEqual(Object.keys($set).sort(), ["isBlocked", "updatedAt"]);
        const user = users.find((row) => matches(row, filter));
        return projected(user && Object.assign(user, $set), projection);
      },
    };
  } };
}

test("admin user HTTP routes enforce authorization, validation, and safe responses", async (t) => {
  const admin = fixture("Test Admin", "admin", false, 1);
  const blockedAdmin = fixture("Blocked Admin", "admin", true, 2);
  const vendor = fixture("Test Vendor", "vendor", false, 3);
  const customer = fixture("Test Customer", "customer", false, 4);
  const legacy = fixture("Legacy User", undefined, undefined, 5);
  const users = [admin, blockedAdmin, vendor, customer, legacy];
  const auth = {
    handler: () => new Response(null, { status: 404 }),
    api: { async verifyJWT({ body: { token } }) {
      // The Admin claim must never override the database role or blocked status.
      return { payload: { sub: token, exp: Date.now() / 1000 + 60, role: "admin" } };
    } },
    $context: Promise.resolve({ internalAdapter: { async findUserById(id) {
      const row = users.find((user) => user._id.equals(id));
      return row ? { ...row, id } : null;
    } } }),
  };
  const server = createApp(auth, "http://localhost:3000", {}, undefined, undefined, createAdminUserStore(database(users)))
    .listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port + "/api/admin/users";
  const request = (path = "", { actor = admin, body, method = body === undefined ? "GET" : "PATCH" } = {}) =>
    fetch(base + path, { method, headers: {
      ...(actor && { Authorization: "Bearer " + actor._id }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const detail = "/" + vendor._id;
  const mutation = detail + "/status";

  await t.test("rejects anonymous users, customers, vendors and blocked admins at the router", async () => {
    for (const [actor, status] of [[null, 401], [customer, 403], [vendor, 403], [blockedAdmin, 403]]) {
      for (const result of [
        await request("", { actor }), await request(detail, { actor }),
        await request(mutation, { actor, body: "{" }),
      ]) assert.equal(result.status, status);
    }
  });

  await t.test("lists and retrieves users with no-store and an explicit response allowlist", async () => {
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { data, pagination } = await response.json();
    assert.deepEqual(pagination, { page: 1, limit: 20, total: 5, totalPages: 1 });
    assert.equal(data[0].role, "customer");
    assert.equal(data[0].status, "active");
    for (const row of data) assert.deepEqual(Object.keys(row).sort(), fields);
    const found = await request(detail);
    assert.equal(found.status, 200);
    const profile = (await found.json()).data;
    assert.deepEqual(Object.keys(profile).sort(), fields);
    assert.equal(profile.role, "vendor");
  });

  await t.test("supports name and email search, literal regex characters, filters, and pagination", async () => {
    for (const [query, total, name] of [
      ["?q=TEST+VENDOR", 1, "Test Vendor"],
      ["?q=legacy%40example.test", 1, "Legacy User"],
      ["?q=.*", 0],
      ["?role=admin&status=blocked", 1, "Blocked Admin"],
      ["?role=vendor&status=active", 1, "Test Vendor"],
      ["?role=customer&status=active", 2, "Legacy User"],
      ["?page=2&limit=2", 5, "Test Vendor"],
    ]) {
      const result = await request(query);
      assert.equal(result.status, 200);
      const { pagination, data } = await result.json();
      assert.equal(pagination.total, total);
      assert.equal(data[0]?.name, name);
      if (query.startsWith("?page=")) assert.deepEqual(pagination, { page: 2, limit: 2, total: 5, totalPages: 3 });
    }
  });

  await t.test("blocks and unblocks using only status and prevents self-blocking", async () => {
    const blocked = await request(mutation, { body: { status: "blocked" } });
    assert.equal(blocked.status, 200);
    const profile = (await blocked.json()).data;
    assert.deepEqual(Object.keys(profile).sort(), fields);
    assert.equal(profile.status, "blocked");
    assert.equal(vendor.isBlocked, true);
    assert.equal(vendor.role, "vendor");
    const active = await request(mutation, { body: { status: "active" } });
    assert.equal(active.status, 200);
    assert.equal((await active.json()).data.status, "active");
    assert.equal(vendor.isBlocked, false);
    assert.equal((await request("/" + admin._id + "/status", { body: { status: "blocked" } })).status, 403);
    assert.equal(admin.isBlocked, false);
  });

  await t.test("rejects invalid IDs, queries, bodies and escalation and handles missing users", async () => {
    for (const query of ["?page=0", "?limit=101", "?page=1&page=2", "?role=owner", "?status=unknown", "?extra=1"]) {
      assert.equal((await request(query)).status, 400);
    }
    assert.equal((await request("/invalid")).status, 400);
    assert.equal((await request("/invalid/status", { body: { status: "active" } })).status, 400);
    const missing = "/" + new ObjectId();
    assert.equal((await request(missing)).status, 404);
    assert.equal((await request(missing + "/status", { body: { status: "active" } })).status, 404);
    for (const body of [{}, { status: true }, { status: "pending" }, { status: "blocked", role: "admin" }, { isBlocked: true }, "{"]) {
      assert.equal((await request(mutation, { body })).status, 400);
    }
    assert.equal(vendor.role, "vendor");
    assert.equal(vendor.isBlocked, false);
  });
});
