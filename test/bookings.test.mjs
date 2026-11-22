import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { MongoClient, MongoServerError, ObjectId, ServerApiVersion } from "mongodb";

import { createApp } from "../dist/src/app.js";
import { createBookingStore } from "../dist/src/bookings/store.js";
import { createServiceStore } from "../dist/src/services/store.js";

const accounts = new Map([
  ["customer", { id: new ObjectId().toHexString(), role: "customer" }],
  ["other-customer", { id: new ObjectId().toHexString(), role: "customer" }],
  ["vendor", { id: new ObjectId().toHexString(), role: "vendor" }],
  ["other-vendor", { id: new ObjectId().toHexString(), role: "vendor" }],
  ["admin", { id: new ObjectId().toHexString(), role: "admin" }],
  ["blocked", { id: new ObjectId().toHexString(), role: "customer", isBlocked: true }],
]);
const activeService = { _id: new ObjectId(), vendorId: accounts.get("vendor").id, isActive: true };
const inactiveService = { _id: new ObjectId(), vendorId: activeService.vendorId, isActive: false };
const input = {
  serviceId: activeService._id.toHexString(),
  eventDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  eventLocation: "Gazipur",
  customerContact: { name: "Test Customer", email: "booking@example.test", phone: "+880 1700 000000" },
  notes: "Evening reception",
};
const differentDay = new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10);

function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value instanceof ObjectId) return value.equals(doc[key]);
    if (value && typeof value === "object" && "$gte" in value) return doc[key] >= value.$gte;
    return doc[key] === value;
  });
}

function memoryDatabase() {
  const services = [activeService, inactiveService];
  const rows = [];
  let uniqueIndex;
  const database = {
    collection(name) {
      if (name === "services") return { findOne: async (filter) => services.find((doc) => matches(doc, filter)) ?? null };
      if (name === "user") return {};
      assert.equal(name, "bookings");
      return {
        async createIndexes(indexes) {
          uniqueIndex = indexes.find((index) => index.unique);
          assert.deepEqual(uniqueIndex.partialFilterExpression, { status: { $in: ["pending", "accepted"] } });
        },
        async insertOne(doc) {
          if (doc.notes === "simulate database failure") throw new Error("Private database details");
          const active = uniqueIndex.partialFilterExpression.status.$in;
          if (active.includes(doc.status) && rows.some((row) =>
            active.includes(row.status) && matches(row, {
              customerId: doc.customerId, serviceId: doc.serviceId, eventDate: doc.eventDate,
            })
          )) throw new MongoServerError({ code: 11000, message: "duplicate" });
          rows.push({ ...doc });
        },
        async findOne(filter) { return rows.find((doc) => matches(doc, filter)) ?? null; },
        async findOneAndUpdate(filter, update) {
          const index = rows.findIndex((doc) => matches(doc, filter));
          if (index === -1) return null;
          rows[index] = { ...rows[index], ...update.$set };
          return rows[index];
        },
        async countDocuments(filter) { return rows.filter((doc) => matches(doc, filter)).length; },
        find(filter) {
          let result = rows.filter((doc) => matches(doc, filter));
          return {
            sort() { result.sort((a, b) => b.createdAt - a.createdAt || b._id.toHexString().localeCompare(a._id.toHexString())); return this; },
            skip(offset) { result = result.slice(offset); return this; },
            limit(limit) { result = result.slice(0, limit); return this; },
            async toArray() { return result; },
          };
        },
      };
    },
  };
  return database;
}

async function bookingSuite(t, db, client, live) {
  const serviceStore = createServiceStore(client, db);
  const store = createBookingStore(db, serviceStore);
  await store.ensureIndexes();
  const auth = {
    handler: () => new Response("ok"),
    api: {
      async verifyJWT({ body: { token } }) {
        const account = accounts.get(token);
        return { payload: account ? { sub: account.id, exp: Date.now() / 1000 + 60 } : null };
      },
    },
    $context: Promise.resolve({
      internalAdapter: { findUserById: async (id) => [...accounts.values()].find((account) => account.id === id) },
    }),
  };
  const server = createApp(auth, "http://localhost:3000", serviceStore, store).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/bookings`;
  async function request(method, path = "", token, body) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token && { Authorization: "Bearer " + token }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  await t.test("rejects unauthenticated, blocked, vendor, and admin creation", async () => {
    for (const [actor, status] of [[undefined, 401], ["bad-token", 401], ["vendor", 403], ["admin", 403], ["blocked", 403]]) {
      assert.equal((await request("POST", "", actor, input)).status, status);
    }
    assert.equal((await request("GET", "/my")).status, 401);
  });

  await t.test("validates IDs, body, contact, event date, mutations and pagination", async () => {
    for (const invalid of [
      { ...input, vendorId: "override" }, { ...input, status: "accepted" },
      { ...input, customerId: "override" }, { ...input, serviceId: "bad" },
      { ...input, eventDate: "2030-02-30" }, { ...input, eventDate: "2000-01-01" },
      { ...input, customerContact: { ...input.customerContact, email: "invalid" } }, "{malformed",
    ]) {
      assert.equal((await request("POST", "", "customer", invalid)).status, 400);
    }
    assert.equal((await request("GET", "/invalid", "customer")).status, 400);
    assert.equal((await request("GET", "/my?page=0", "customer")).status, 400);
    assert.equal((await request("PATCH", "/invalid/cancel", "customer", { status: "accepted" })).status, 400);
    assert.equal((await request("POST", "", "customer", { ...input, serviceId: inactiveService._id.toHexString() })).status, 404);
    assert.equal((await request("POST", "", "customer", { ...input, serviceId: new ObjectId().toHexString() })).status, 404);
  });

  let bookingId;
  await t.test("creates an owned booking and enforces customer, vendor and admin access", async () => {
    const created = await request("POST", "", "customer", input);
    assert.equal(created.status, 201);
    const { data } = created.body;
    bookingId = data.id;
    assert.equal(created.headers.get("location"), "/api/bookings/" + bookingId);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.equal(data.status, "pending");
    assert.equal(data.customerId, accounts.get("customer").id);
    assert.equal(data.vendorId, activeService.vendorId);
    assert.equal(data.serviceId, input.serviceId);
    assert.deepEqual(data.customerContact, input.customerContact);
    assert.ok(data.createdAt && data.updatedAt);
    for (const actor of ["customer", "vendor"]) assert.equal((await request("GET", "/" + bookingId, actor)).status, 200);
    for (const actor of ["other-customer", "other-vendor"]) assert.equal((await request("GET", "/" + bookingId, actor)).status, 404);
    assert.equal((await request("GET", "/my?limit=1", "customer")).body.pagination.total, 1);
    assert.equal((await request("GET", "/vendor", "other-vendor")).body.pagination.total, 0);
    assert.equal((await request("GET", "/vendor", "vendor")).body.pagination.total, 1);
    assert.equal((await request("GET", "/admin", "admin")).body.pagination.total, 1);
    assert.equal((await request("GET", "/admin/" + bookingId, "admin")).status, 200);
    assert.equal((await request("GET", "/admin/" + bookingId, "vendor")).status, 403);
    assert.equal((await request("GET", "/admin", "customer")).status, 403);
    assert.equal((await request("PATCH", "/" + bookingId + "/accept", "other-vendor")).status, 404);
    assert.equal((await request("PATCH", "/" + bookingId + "/cancel", "other-customer")).status, 404);
    assert.equal((await request("PATCH", "/" + bookingId + "/reject", "customer")).status, 403);
  });

  await t.test("accepts and rejects pending requests and releases cancelled or rejected duplicate keys", async () => {
    const path = "/" + bookingId;
    assert.equal((await request("POST", "", "customer", input)).status, 409);
    assert.equal((await request("PATCH", path + "/cancel", "customer")).body.data.status, "cancelled");
    assert.equal((await request("PATCH", path + "/cancel", "customer")).status, 409);
    assert.equal((await request("PATCH", path + "/accept", "vendor")).status, 409);
    const again = (await request("POST", "", "customer", input)).body.data.id;
    assert.equal((await request("PATCH", "/" + again + "/reject", "vendor")).body.data.status, "rejected");
    const pending = (await request("POST", "", "customer", input)).body.data.id;
    assert.equal((await request("PATCH", "/" + pending + "/accept", "vendor")).body.data.status, "accepted");
    assert.equal((await request("PATCH", "/" + pending + "/reject", "vendor")).status, 409);
    assert.equal((await request("PATCH", "/" + pending + "/cancel", "customer")).status, 409);
    assert.equal((await request("POST", "", "customer", input)).status, 409);
    assert.equal((await request("POST", "", "other-customer", input)).status, 201);
  });

  await t.test("allows one concurrent insert and one conflicting vendor decision", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      request("POST", "", "customer", { ...input, eventDate: differentDay })));
    const created = results.filter(({ status }) => status === 201);
    assert.equal(created.length, 1);
    assert.equal(results.filter(({ status }) => status === 409).length, 11);
    const path = "/" + created[0].body.data.id;
    const decisions = await Promise.all(["accept", "reject"].map((action) => request("PATCH", path + "/" + action, "vendor")));
    assert.deepEqual(decisions.map(({ status }) => status).sort(), [200, 409]);
  });

  if (!live) await t.test("sanitizes unexpected database errors", async () => {
    const failed = await request("POST", "", "customer", { ...input, notes: "simulate database failure" });
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: "Request failed" });
  });
}

test("booking HTTP routes using a MongoDB test double", async (t) => {
  await bookingSuite(t, memoryDatabase(), {}, false);
});

test("booking HTTP routes and concurrent writes using real MongoDB", {
  skip: process.env.BOOKINGS_MONGO_INTEGRATION !== "1",
}, async (t) => {
  assert.ok(process.env.MONGODB_URI, "MONGODB_URI is required for the MongoDB integration test");
  let client;
  try {
    client = new MongoClient(process.env.MONGODB_URI, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
      serverSelectionTimeoutMS: 8000,
    });
    await client.connect();
  } catch {
    await client?.close();
    assert.fail("Could not connect to the configured MongoDB integration server");
  }
  const db = client.db("wp_bkg_test_" + new ObjectId().toHexString());
  try {
    await db.collection("services").insertMany([activeService, inactiveService]);
    await bookingSuite(t, db, client, true);
  } finally {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  }
});
