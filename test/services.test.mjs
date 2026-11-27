import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { ObjectId } from "mongodb";

import { createApp } from "../dist/src/app.js";
import { createServiceStore } from "../dist/src/services/store.js";

const id = () => new ObjectId().toHexString();
const accounts = new Map([
  ["vendor", { id: id(), role: "vendor", subscriptionPlan: "free" }],
  ["premium", { id: id(), role: "vendor", subscriptionPlan: "premium", subscriptionExpiresAt: new Date(Date.now() + 86_400_000) }],
  ["expired", { id: id(), role: "vendor", subscriptionPlan: "premium", subscriptionExpiresAt: new Date(0) }],
  ["blocked", { id: id(), role: "vendor", isBlocked: true }],
  ["customer", { id: id(), role: "customer" }],
  ["admin", { id: id(), role: "admin" }],
  ["blocked-admin", { id: id(), role: "admin", isBlocked: true }],
]);

const cover = "https://i.ibb.co/fixture/cover.webp";
const detailImage = "https://i.ibb.co/fixture/detail.png";
const fixture = {
  title: "Wedding photography",
  description: "Full day photography",
  category: "Photo",
  price: 350,
  location: "Shanghai",
  images: [cover],
};

import { aggregate, matches } from "./fixtures/aggregate.mjs";

test("service routes use authorization, validation, CRUD, and capacity rules", async (t) => {
  const rows = [];
  const documents = {
    async insertOne(doc) { rows.push({ ...doc }); },
    async findOne(filter) { return rows.find((doc) => matches(doc, filter)) ?? null; },

    async findOneAndUpdate(filter, update) {
      const doc = rows.find((record) => matches(record, filter));
      return doc ? Object.assign(doc, update.$set) : null;
    },
    async deleteOne(filter) {
      const index = rows.findIndex((doc) => matches(doc, filter));
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
    aggregate(pipeline, options) {
      assert.equal(options.readConcern.level, "snapshot");
      const user = [...accounts.values()].map((account) => ({ ...account, _id: new ObjectId(account.id) }));
      const result = aggregate(rows, pipeline, { user });
      return { toArray: async () => result, next: async () => result[0] ?? null };
    },
  };
  const database = {
    collection(name) {
      if (name === "services") return documents;
      assert.equal(name, "user");
      return {
        find(filter, { projection }) {
          assert.deepEqual(projection, { _id: 1, name: 1, businessName: 1 });
          const vendors = [...accounts.values()].filter((account) =>
            account.role === filter.role && filter._id.$in.some((id) => id.equals(account.id)));
          return { async toArray() {
            return vendors.map(({ id }) => ({
              _id: new ObjectId(id), name: "Vendor display name", businessName: "Wedding Studio",
              email: "private@example.test", password: "synthetic", seedMarker: "synthetic",
            }));
          } };
        },
      };
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
  const server = createApp(auth, "http://localhost:3000", createServiceStore(database), undefined, undefined, {})
    .listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;

  async function request(method, path = "", actor, body, prefix = "/api/services") {
    return fetch(base + prefix + path, {
      method,
      headers: {
        ...(actor && { Authorization: "Bearer " + actor }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  const adminRequest = (method, path = "", body, actor = "admin") =>
    request(method, path, actor, body, "/api/admin/services");

  await t.test("Admin service routes reject every non-admin actor", async () => {
    for (const [actor, status] of [[null, 401], ["customer", 403], ["vendor", 403], ["blocked-admin", 403]]) {
      for (const [method, path, body] of [["GET", ""], ["GET", "/invalid"], ["PATCH", "/invalid", "{"], ["DELETE", "/invalid"], ["PATCH", "/invalid/moderation", { status: "approved" }]]) {
        assert.equal((await adminRequest(method, path, body, actor)).status, status);
      }
    }
  });

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
      { ...fixture, moderationStatus: "approved" },
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

  await t.test("requires a nonempty list of approved hosted images on creation", async () => {
    const invalid = [
      undefined, [], Array(11).fill(cover), [""], ["not-a-url"], ["https:i.ibb.co/fixture/a.png"],
      ["http://i.ibb.co/fixture/a.png"], ["https://unapproved.example/a.png"],
      ["https://i.ibb.co.example/a.png"], ["https://user:password@i.ibb.co/a.png"],
      ["https://i.ibb.co/a.png?private=fixture"],
    ];
    for (const value of invalid) {
      const response = await request("POST", "", "vendor", { ...fixture, images: value });
      assert.equal(response.status, 400);
      assert.ok((await response.json()).issues.some(({ path }) => path === "images" || path.startsWith("images.")));
    }
    assert.equal(rows.length, 0);
  });

  await t.test("creates services and limits public search and detail to active services", async () => {
    const created = await request("POST", "", "vendor", fixture);
    assert.equal(created.status, 201);
    owned = (await created.json()).data;
    assert.equal(created.headers.get("location"), "/api/services/manage/" + owned.id);
    assert.equal(owned.vendorId, accounts.get("vendor").id);
    assert.equal(owned.isActive, false);
    assert.equal(owned.vendorAvailable, true);
    assert.equal(owned.moderationStatus, "pending");
    assert.equal((await request("GET", "/" + owned.id)).status, 404);
    assert.equal((await request("PATCH", "/" + owned.id, "vendor", { moderationStatus: "approved" })).status, 400);
    assert.equal((await request("PATCH", "/" + owned.id, "vendor", { isActive: false })).status, 409);
    const approved = await adminRequest("PATCH", "/" + owned.id + "/moderation", { status: "approved" });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).data.isActive, true);
    assert.deepEqual(owned.images, [cover]);
    const createdDraft = await request("POST", "", "vendor", { ...fixture, title: "Draft", isActive: false, images: [cover, detailImage] });
    assert.equal(createdDraft.status, 201);
    draft = (await createdDraft.json()).data;
    assert.deepEqual(draft.images, [cover, detailImage]);
    const publicDetail = await request("GET", "/" + owned.id);
    assert.equal(publicDetail.status, 200);
    assert.deepEqual((await publicDetail.json()).data.images, [cover]);
    assert.equal((await request("GET", "/" + draft.id)).status, 404);
    const vendorDetail = await request("GET", "/manage/" + draft.id, "vendor");
    assert.equal(vendorDetail.status, 200);
    assert.deepEqual((await vendorDetail.json()).data.images, [cover, detailImage]);
    assert.equal((await request("GET", "/manage/" + draft.id, "admin")).status, 200);
    assert.equal((await request("GET", "/manage/" + draft.id, "premium")).status, 404);
    const listing = await (await request("GET", "?q=photography&category=photo&location=shanghai&limit=1")).json();
    assert.deepEqual(listing.pagination, { page: 1, limit: 1, total: 1, totalPages: 1 });
    assert.deepEqual(listing.data.map(({ id }) => id), [owned.id]);
    assert.deepEqual(listing.data[0].images, [cover]);
    assert.equal((await (await request("GET", "?q=.*")).json()).data.length, 0);
  });

  await t.test("updates the ordered image array, preserves omitted images, and enforces ownership", async () => {
    const path = "/" + owned.id;
    const patch = { images: [detailImage, cover] };
    for (const [actor, status] of [[null, 401], ["customer", 403], ["blocked", 403], ["premium", 404]]) {
      assert.equal((await request("PATCH", path, actor, patch)).status, status);
    }
    for (const images of [Array(11).fill(cover), [cover, "https://unapproved.example/a.png"]]) {
      assert.equal((await request("PATCH", path, "vendor", { images })).status, 400);
    }
    assert.deepEqual((await (await request("GET", path)).json()).data.images, [cover]);
    const updated = await request("PATCH", path, "vendor", patch);
    assert.equal(updated.status, 200);
    assert.deepEqual((await updated.json()).data.images, patch.images);
    const unchanged = await request("PATCH", path, "vendor", { price: 375 });
    assert.equal(unchanged.status, 200);
    assert.deepEqual((await unchanged.json()).data.images, patch.images);
    const managed = (await (await request("GET", "/manage", "vendor")).json()).data;
    assert.deepEqual(managed.find(({ id }) => id === owned.id).images, patch.images);
    const replaced = await adminRequest("PATCH", path, { images: [detailImage] });
    assert.equal(replaced.status, 200);
    assert.deepEqual((await replaced.json()).data.images, [detailImage]);
    const removed = await request("PATCH", path, "vendor", { images: [] });
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json()).data.images, []);
    assert.deepEqual((await (await request("GET", path)).json()).data.images, []);
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

  await t.test("moderation, deletion, downgrade and renewal recompute the same publication policy", async () => {
    const vendor = accounts.get("vendor");
    const create = async (title) => {
      const result = await request("POST", "", "vendor", { ...fixture, title });
      assert.equal(result.status, 201);
      return (await result.json()).data;
    };
    const decide = (id, status) => adminRequest("PATCH", "/" + id + "/moderation", { status });
    const published = async () => {
      const result = await request("GET");
      assert.equal(result.status, 200);
      return (await result.json()).data.map(({ id }) => id);
    };

    const first = await create("First new service");
    const second = await create("Second new service");
    const third = await create("Third new service");
    const fourth = await create("Fourth new service");
    const rejected = await create("Rejected service");
    assert.deepEqual((await (await adminRequest("GET", "?moderationStatus=pending")).json()).data.length, 5);
    assert.equal((await decide(rejected.id, "rejected")).status, 200);
    assert.equal((await decide(rejected.id, "approved")).status, 409);
    assert.equal((await request("PATCH", "/" + rejected.id, "vendor", { isActive: true })).status, 409);
    assert.equal((await request("PATCH", "/" + rejected.id, "vendor", { price: 200 })).status, 200);
    assert.equal((await request("GET", "/" + rejected.id)).status, 404);

    const concurrent = await Promise.all([first, second, third].map(({ id }) => decide(id, "approved")));
    assert.ok(concurrent.every(({ status }) => status === 200));
    assert.deepEqual(await published(), [third.id, second.id, first.id]);
    assert.equal((await decide(fourth.id, "approved")).status, 200);
    assert.deepEqual(await published(), [fourth.id, third.id, second.id]);
    assert.equal((await request("GET", "?q=First+new+service")).status, 200);
    assert.equal((await (await request("GET", "?q=First+new+service")).json()).data.length, 0);
    const older = (await (await request("GET", "/manage/" + first.id, "vendor")).json()).data;
    assert.equal(older.moderationStatus, "approved");
    assert.equal(older.vendorAvailable, true);
    assert.equal(older.isActive, false);

    assert.equal((await request("DELETE", "/" + fourth.id, "vendor")).status, 204);
    assert.deepEqual(await published(), [third.id, second.id, first.id]);

    vendor.subscriptionPlan = "premium";
    vendor.subscriptionExpiresAt = new Date(Date.now() + 60_000);
    assert.deepEqual(await published(), [third.id, second.id, first.id, owned.id]);
    assert.equal((await request("PATCH", "/" + third.id, "vendor", { isActive: false })).status, 200);
    assert.deepEqual(await published(), [second.id, first.id, owned.id]);
    vendor.subscriptionExpiresAt = new Date(0);
    assert.deepEqual(await published(), [second.id, first.id]);
    assert.equal((await request("GET", "/" + owned.id)).status, 404);
    assert.equal((await request("GET", "/" + third.id)).status, 404);
    vendor.subscriptionExpiresAt = new Date(Date.now() + 60_000);
    assert.deepEqual(await published(), [second.id, first.id, owned.id]);
    const rejectionFilter = await adminRequest("GET", "?moderationStatus=rejected");
    assert.deepEqual((await rejectionFilter.json()).data.map(({ id }) => id), [rejected.id]);
    vendor.subscriptionPlan = "free";
    delete vendor.subscriptionExpiresAt;
  });

  await t.test("only one competing Admin decision can change a pending submission", async () => {
    const created = await request("POST", "", "vendor", fixture);
    const { data: service } = await created.json();
    assert.equal(created.status, 201);
    const path = "/" + service.id + "/moderation";
    assert.equal((await adminRequest("PATCH", path, { status: "pending" })).status, 400);
    assert.equal((await adminRequest("PATCH", path, { status: "approved", vendorAvailable: true })).status, 400);
    assert.equal((await adminRequest("PATCH", "/" + id() + "/moderation", { status: "approved" })).status, 404);
    const decisions = await Promise.all(["approved", "rejected"].map((status) => adminRequest("PATCH", path, { status })));
    assert.deepEqual(decisions.map(({ status }) => status).sort(), [200, 409]);
    const winner = await decisions.find(({ status }) => status === 200).json();
    const managed = await (await adminRequest("GET", "/" + service.id)).json();
    assert.equal(managed.data.moderationStatus, winner.data.moderationStatus);
    assert.equal(managed.data.isActive, winner.data.isActive);
  });

  await t.test("Admin service listing filters across vendors and returns only safe display fields", async () => {
    rows.length = 0;
    const add = (actor, title, category, isActive, day) => {
      const row = { ...fixture, _id: new ObjectId(), title, category, isActive,
        description: day === 4 ? "Includes a reception portrait" : fixture.description,
        vendorId: accounts.get(actor)?.id ?? id(), createdAt: new Date(2025, 0, day),
        updatedAt: new Date(2025, 0, day), seedMarker: "synthetic" };
      rows.push(row);
      return row;
    };
    add("vendor", "Photo A", "Photo", true, 1);
    add("vendor", "Photo B", "Photo", true, 2);
    const active = add("vendor", "Photo C", "Photo", true, 3);
    delete active.images;
    const draft = add("vendor", "Portrait package", "Photo", false, 4);
    const other = add("premium", "Wedding flowers", "Florist", true, 5);
    const missingVendor = add("missing", "Unlinked service", "Other", false, 6);

    for (const [query, total, titles] of [
      ["?limit=2&page=2", 6, ["Portrait package", "Photo C"]],
      ["?q=FLOWERS", 1, ["Wedding flowers"]],
      ["?q=reception+portrait", 1, ["Portrait package"]],
      ["?q=.*", 0, []],
      ["?category=pHoTo&visibility=active", 2, ["Photo C", "Photo B"]],
      ["?visibility=inactive", 3, ["Unlinked service", "Portrait package", "Photo A"]],
      ["?vendorId=" + other.vendorId.toUpperCase(), 1, ["Wedding flowers"]],
    ]) {
      const response = await adminRequest("GET", query);
      assert.equal(response.status, 200);
      const { data, pagination } = await response.json();
      assert.equal(pagination.total, total);
      assert.deepEqual(data.map(({ title }) => title), titles);
      if (query.startsWith("?limit=2")) assert.deepEqual(pagination, { page: 2, limit: 2, total: 6, totalPages: 3 });
      for (const entry of data) {
        assert.equal("seedMarker" in entry, false);
        assert.deepEqual(entry.vendor, entry.id === String(missingVendor._id) ? null : {
          id: entry.vendorId, name: "Vendor display name", businessName: "Wedding Studio",
        });
        assert.deepEqual(entry.images, entry.id === String(active._id) ? [] : [cover]);
      }
    }
    for (const query of ["?vendorId=not-an-id", "?visibility=pending", "?limit=101", "?page=0", "?category=", "?q=a&q=b", "?owner=admin"]) {
      assert.equal((await adminRequest("GET", query)).status, 400);
    }
    assert.equal((await request("GET", "/manage?vendorId=" + other.vendorId, "vendor")).status, 400);
    assert.equal((await request("GET", "/manage/" + other._id, "vendor")).status, 404);

    const detail = await adminRequest("GET", "/" + draft._id);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.isActive, false);
    for (const response of [
      await request("GET", "/" + active._id),
      await request("GET", "/manage/" + active._id, "vendor"),
      await adminRequest("GET", "/" + active._id),
      await adminRequest("PATCH", "/" + active._id, { description: "Legacy service edit" }),
    ]) {
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data.images, []);
    }
    assert.equal("images" in active, false);
    assert.equal((await adminRequest("PATCH", "/" + draft._id, { isActive: true })).status, 200);
    for (const body of [{ vendorId: other.vendorId }, { isActive: "true" }, { title: "" }]) {
      assert.equal((await adminRequest("PATCH", "/" + draft._id, body)).status, 400);
    }
    const updated = await adminRequest("PATCH", "/" + draft._id, { title: "Edited portrait package" });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).data.title, "Edited portrait package");
    assert.equal((await adminRequest("PATCH", "/" + active._id, { isActive: false })).status, 200);
    assert.equal((await adminRequest("PATCH", "/" + draft._id, { isActive: true })).status, 200);
    assert.equal(draft.isActive, true);
    assert.equal((await request("PATCH", "/" + other._id, "vendor", { isActive: false })).status, 404);
    assert.equal((await request("DELETE", "/" + other._id, "vendor")).status, 404);
    assert.equal((await adminRequest("DELETE", "/" + other._id)).status, 204);
    assert.equal((await adminRequest("GET", "/" + other._id)).status, 404);
    for (const method of ["GET", "PATCH", "DELETE"]) {
      assert.equal((await adminRequest(method, "/invalid", method === "PATCH" ? { isActive: true } : undefined)).status, 400);
    }
  });
});
