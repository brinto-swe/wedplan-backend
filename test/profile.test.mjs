import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createApp } from "../dist/src/app.js";

const origin = "http://localhost:3000";
const avatar = "https://i.ibb.co/fixture/avatar.webp";

test("profile routes use Better Auth sessions, persist approved changes, and preserve authorization", async (t) => {
  // The auth module requires explicit settings even when the test uses an in-memory adapter.
  Object.assign(process.env, { MONGODB_URI: "mongodb://127.0.0.1:27017", MONGODB_DATABASE: "wedplan_profile_fixture" });
  const { createAuth } = await import("../dist/src/auth/auth.js");
  const db = { user: [], account: [], session: [], verification: [], jwks: [] };
  const auth = createAuth({
    origin, baseURL: "http://localhost:5000", secret: "Profile test only synthetic secret 2026!",
    google: { clientId: "test", clientSecret: "test" },
    github: { clientId: "test", clientSecret: "test" },
  }, memoryAdapter(db));
  const server = createApp(auth, origin, {}, undefined, undefined, {
    list: async () => ({ data: [], pagination: { total: 0 } }),
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;

  await t.test("public signup enforces the assignment password rules and keeps the image optional", async () => {
    const cases = [
      ["customer", "Abc123", undefined, "customer"],
      ["vendor", "Abcde1", avatar, "vendor"],
      ["admin", "Abcdef", undefined, "customer"],
      ["customer", "abcdef", undefined, null],
      ["vendor", "ABCDEF", undefined, null],
      ["customer", "Ab123", undefined, null],
    ];
    for (const [index, [role, password, image, expectedRole]] of cases.entries()) {
      const email = `signup-${index}@example.test`;
      const response = await fetch(base + "/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ name: "Signup fixture", email, password, role, image }),
      });
      assert.equal(response.status, expectedRole ? 200 : 400);
      const result = await response.json();
      const user = db.user.find((entry) => entry.email === email);
      if (expectedRole) {
        assert.equal(result.user.role, expectedRole);
        assert.equal(user.role, expectedRole);
        assert.equal(user.image ?? null, image ?? null);
      } else {
        assert.equal(result.code, "SIGNUP_PASSWORD_REQUIREMENTS");
        assert.equal(user, undefined);
      }
    }
  });

  async function account(role, label = role) {
    const email = label + "@example.test";
    const body = { name: label, email, password: "Synthetic!Fixture2026", role: role === "vendor" ? role : "customer" };
    const signed = await auth.api.signUpEmail({ body, returnHeaders: true });
    const row = db.user.find((user) => user.email === email);
    if (role === "admin") row.role = "admin";
    row.seedMarker = "private-fixture";
    const cookie = signed.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const token = async () => (await auth.api.getToken({ headers: new Headers({ cookie }) })).token;
    return { row, cookie, token: await token(), freshToken: token };
  }

  const customer = await account("customer");
  const vendor = await account("vendor");
  const admin = await account("admin");
  const blocked = await account("vendor", "blocked");
  blocked.row.isBlocked = true;

  function send(path, actor, method = "GET", body) {
    return fetch(base + path, { method, headers: {
      ...(actor && { Authorization: "Bearer " + actor.token }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    }, body: typeof body === "string" ? body : JSON.stringify(body) });
  }

  await t.test("Customers and Vendors read only their own safe profile", async () => {
    for (const actor of [customer, vendor]) {
      const response = await send("/api/me", actor);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const profile = await response.json();
      const { id, role, name, email } = actor.row;
      assert.deepEqual(profile, {
        id, role, name, email, image: null, emailVerified: false, createdAt: actor.row.createdAt.toISOString(),
        ...(role === "vendor" && { businessName: "" }),
      });
    }
  });

  await t.test("each role can update its name and a fresh authenticated request sees the persisted result", async () => {
    for (const actor of [customer, vendor]) {
      const nextName = "Updated " + actor.row.role;
      const updated = await send("/api/me", actor, "PATCH", { name: "  " + nextName + "  " });
      assert.equal(updated.status, 200);
      const profile = await updated.json();
      assert.equal(profile.id, actor.row.id);
      assert.equal(profile.name, nextName);
      assert.equal(db.user.find(({ id }) => id === profile.id).name, nextName);
      assert.deepEqual(await (await send("/api/me", { token: await actor.freshToken() })).json(), profile);
    }
    const session = await auth.api.getSession({ headers: new Headers({ cookie: customer.cookie }) });
    assert.equal(session.user.name, "Updated customer");
  });

  await t.test("trusted image updates and clearing work; only Vendors can edit business names", async () => {
    for (const actor of [customer, vendor]) {
      const set = await send("/api/me", actor, "PATCH", { image: avatar });
      assert.equal(set.status, 200);
      assert.equal((await set.json()).image, avatar);
      assert.equal((await (await send("/api/me", actor)).json()).image, avatar);
      const clear = await send("/api/me", actor, "PATCH", { image: null });
      assert.equal(clear.status, 200);
      assert.equal((await clear.json()).image, null);
      assert.equal((await (await send("/api/me", actor)).json()).image, null);
    }
    const business = await send("/api/me", vendor, "PATCH", { businessName: "  Fixture Studio  " });
    assert.equal(business.status, 200);
    assert.equal((await business.json()).businessName, "Fixture Studio");
    assert.equal((await send("/api/me", customer, "PATCH", { businessName: "Not a Vendor" })).status, 400);
  });

  await t.test("denies anonymous and blocked clients and rejects invalid or privileged fields", async () => {
    assert.equal((await send("/api/me", undefined, "PATCH", { name: "No session" })).status, 401);
    assert.equal((await send("/api/me", blocked, "PATCH", { name: "Blocked" })).status, 403);
    for (const actor of [customer, vendor]) {
      for (const body of [
        {}, { name: "   " }, { name: "a".repeat(121) }, { name: 42 }, { image: "" },
        { image: "http://i.ibb.co/fixture/avatar.webp" }, { image: "https://i.ibb.co.evil.test/a" },
        { image: "https://i.ibb.co/a?private=1" }, { email: "changed@example.test" }, { role: "admin" },
        { subscriptionPlan: "premium" }, { subscriptionExpiresAt: "2999-01-01" },
        { paymentStatus: "paid" }, { status: "active" }, { isBlocked: false },
        { id: admin.row.id, name: "Cross-account update" }, "{bad",
      ]) {
        assert.equal((await send("/api/me", actor, "PATCH", body)).status, 400);
      }
      assert.equal((await send("/api/me/" + admin.row.id, actor, "PATCH", { name: "Cross-account update" })).status, 404);
    }
    assert.equal(db.user.find(({ id }) => id === admin.row.id).name, "admin");
  });

  await t.test("preserves Admin GET and Admin router permissions", async () => {
    const current = await send("/api/me", admin);
    assert.equal(current.status, 200);
    assert.equal((await current.json()).role, "admin");
    assert.equal((await send("/api/me", admin, "PATCH", { name: "Ignored" })).status, 403);
    assert.equal((await send("/api/admin/users", admin)).status, 200);
    assert.equal((await send("/api/admin/users", vendor)).status, 403);
  });

  await t.test("legacy Better Auth profile updates keep their response and apply the same allowlist", async () => {
    const legacy = (body) => fetch(base + "/api/auth/update-user", {
      method: "POST", headers: { Origin: origin, Cookie: vendor.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const updated = await legacy({ name: "  Legacy profile client  ", image: avatar });
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), { status: true });
    assert.equal((await legacy({ role: "admin" })).status, 400);
    assert.equal((await legacy({ image: "https://external.example/avatar.png" })).status, 400);
    const profile = await (await send("/api/me", vendor)).json();
    assert.equal(profile.name, "Legacy profile client");
    assert.equal(profile.image, avatar);
    assert.equal(profile.role, "vendor");
  });
});
