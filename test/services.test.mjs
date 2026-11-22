import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { ObjectId } from "mongodb";

import { createApp } from "../dist/app.js";
import { createServiceStore } from "../dist/services/store.js";

const id = () => new ObjectId().toHexString();
const accounts = new Map([
  ["vendor", { id: id(), role: "vendor", subscriptionPlan: "free" }],
  ["premium", { id: id(), role: "vendor", subscriptionPlan: "premium" }],
  ["expired", { id: id(), role: "vendor", subscriptionPlan: "premium", subscriptionExpiresAt: new Date(0) }],
  ["blocked", { id: id(), role: "vendor", isBlocked: true }],
  ["customer", { id: id(), role: "customer" }],
  ["admin", { id: id(), role: "admin" }],
]);

const fixture = {
  title: "Wedding photography",
  description: "Full day photography",
  category: "Photo",
  price: 350,
  location: "Shanghai",
};

function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((term) => matches(doc, term));
    if (value instanceof RegExp) return value.test(doc[key]);
    if (value instanceof ObjectId) return value.equals(doc[key]);
    return value === doc[key];
  });
}

test("service routes use authorization, validation, CRUD, and capacity rules", async (t) => {
  const rows = [];
  const documents = {
    async insertOne(doc) { rows.push({ ...doc }); },
    async findOne(filter) { return rows.find((doc) => matches(doc, filter)) ?? null; },
    async countDocuments(filter) { return rows.filter((doc) => matches(doc, filter)).length; },
    async findOneAndUpdate(filter, update) {
      const doc = await this.findOne(filter);
      return doc ? Object.assign(doc, update.$set) : null;
    },
    async deleteOne(filter) {
      const index = rows.findIndex((doc) => matches(doc, filter));
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
    find(filter) {
      let result = rows.filter((doc) => matches(doc, filter));
      return {
        sort() {
          result.sort((a, b) => b.createdAt - a.createdAt || String(b._id).localeCompare(String(a._id)));
          return this;
        },
        skip(count) { result = result.slice(count); return this; },
        limit(count) { result = result.slice(0, count); return this; },
        async toArray() { return result; },
      };
    },
  };
  const database = {
    collection(name) {
      if (name === "services") return documents;
      assert.equal(name, "user");
      return {
        async findOneAndUpdate(filter, update, options) {
          assert.ok(options.session);
          assert.deepEqual(update, { $inc: { serviceCapacityVersion: 1 } });
          const account = [...accounts.values()].find(({ id, role }) => filter._id.equals(id) && role === filter.role);
          return account ?? null;
        },
      };
    },
  };
  // Simulates the serialization the shared vendor document provides in a real transaction.
  let pending = Promise.resolve();
  const client = {
    withSession(callback) {
      return callback({
        withTransaction(operation) {
          const result = pending.then(operation);
          pending = result.catch(() => {});
          return result;
        },
      });
    },
  };
  const auth = {
    handler: () => new Response("ok"),
    api: {
      async verifyJWT({ body: { token } }) {
        const account = accounts.get(token);
        return { payload: account && { sub: account.id, exp: Date.now() / 1000 + 60 } };
      },
    },
    $context: Promise.resolve({
      internalAdapter: { findUserById: async (id) => [...accounts.values()].find((user) => user.id === id) },
    }),
  };
  const server = createApp(auth, "http://localhost:3000", createServiceStore(client, database))
    .listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;

  async function request(method, path = "", actor, body) {
    return fetch(base + "/api/services" + path, {
      method,
      headers: {
        ...(actor && { Authorization: "Bearer " + actor }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  let owned;
  let draft;
  await t.test("rejects anonymous, invalid, customer, blocked, and admin creation", async () => {
    for (const [actor, status] of [[undefined, 401], ["invalid", 401], ["customer", 403], ["blocked", 403], ["admin", 403]]) {
      assert.equal((await request("POST", "", actor, fixture)).status, status);
    }
    assert.equal((await request("GET", "/manage")).status, 401);
  });

  await t.test("validates bodies, IDs, filters, and pagination", async () => {
    for (const body of [
      { ...fixture, price: -1 },
      { ...fixture, title: "  " },
      { ...fixture, vendorId: accounts.get("admin").id },
      { ...fixture, subscriptionPlan: "premium" },
      "{invalid",
    ]) {
      const result = await request("POST", "", "vendor", body);
      assert.equal(result.status, 400);
      assert.ok((await result.json()).error);
    }
    for (const path of ["/invalid", "?page=0", "?limit=101", "?page=1&page=2", "?role=admin"]) {
      assert.equal((await request("GET", path)).status, 400);
    }
  });

  await t.test("creates services and limits public search and detail to active services", async () => {
    const created = await request("POST", "", "vendor", fixture);
    assert.equal(created.status, 201);
    owned = (await created.json()).data;
    assert.equal(created.headers.get("location"), "/api/services/" + owned.id);
    assert.equal(owned.vendorId, accounts.get("vendor").id);
    assert.equal(owned.isActive, true);
    draft = (await (await request("POST", "", "vendor", { ...fixture, title: "Draft", isActive: false })).json()).data;
    assert.equal((await request("GET", "/" + owned.id)).status, 200);
    assert.equal((await request("GET", "/" + draft.id)).status, 404);
    assert.equal((await request("GET", "/manage/" + draft.id, "vendor")).status, 200);
    assert.equal((await request("GET", "/manage/" + draft.id, "admin")).status, 200);
    assert.equal((await request("GET", "/manage/" + draft.id, "premium")).status, 404);
    const listing = await (await request("GET", "?q=photography&category=photo&location=shanghai&limit=1")).json();
    assert.deepEqual(listing.pagination, { page: 1, limit: 1, total: 1, totalPages: 1 });
    assert.deepEqual(listing.data.map(({ id }) => id), [owned.id]);
    assert.equal((await (await request("GET", "?q=.*")).json()).data.length, 0);
  });

  await t.test("enforces ownership and lets admins manage every service", async () => {
    const path = "/" + owned.id;
    assert.equal((await request("PATCH", path, "premium", { price: 99 })).status, 404);
    assert.equal((await request("DELETE", path, "premium")).status, 404);
    assert.equal((await request("PATCH", path, "vendor", {})).status, 400);
    assert.equal((await request("PATCH", path, "vendor", { price: 400 })).status, 200);
    const updated = await request("PATCH", path, "admin", { title: "Photo package" });
    assert.equal((await updated.json()).data.title, "Photo package");
    assert.equal((await (await request("GET", "/manage", "vendor")).json()).data.length, 2);
    assert.equal((await (await request("GET", "/manage", "premium")).json()).data.length, 0);
    assert.equal((await (await request("GET", "/manage", "admin")).json()).data.length, 2);
    assert.equal((await request("DELETE", "/" + draft.id, "admin")).status, 204);
    assert.equal((await request("DELETE", "/" + draft.id, "admin")).status, 404);
  });

  await t.test("caps concurrent free creates and reactivation while allowing drafts", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => request("POST", "", "vendor", fixture)));
    assert.deepEqual(results.map(({ status }) => status).sort(), [201, 201, 409, 409, 409]);
    const saved = await request("POST", "", "vendor", { ...fixture, isActive: false });
    assert.equal(saved.status, 201);
    const savedId = (await saved.json()).data.id;
    for (const actor of ["vendor", "admin"]) {
      assert.equal((await request("PATCH", "/" + savedId, actor, { isActive: true })).status, 409);
    }
    assert.equal((await request("PATCH", "/" + owned.id, "vendor", { isActive: false })).status, 200);
    assert.equal((await request("PATCH", "/" + savedId, "vendor", { isActive: true })).status, 200);
    assert.equal((await request("DELETE", "/" + savedId, "vendor")).status, 204);
    assert.equal((await request("POST", "", "vendor", fixture)).status, 201);
  });

  await t.test("premium can exceed three while expired premium is capped", async () => {
    for (let index = 0; index < 4; index++) {
      assert.equal((await request("POST", "", "premium", fixture)).status, 201);
      assert.equal((await request("POST", "", "expired", fixture)).status, index < 3 ? 201 : 409);
    }
  });
});
