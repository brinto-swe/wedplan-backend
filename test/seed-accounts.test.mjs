import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryAdapter } from "better-auth/adapters/memory";
import { MongoNetworkError } from "mongodb";
import { connectWithRetry, createSeedAuth, readSeedConfig, seedAccounts, seedFailure } from "../dist/scripts/seed-accounts-core.js";

const environment = {
  MONGODB_URI: "mongodb://127.0.0.1:27017",
  MONGODB_DATABASE: "seed_test",
  WEDPLAN_SEED_EXPECTED_DATABASE: "seed_test",
  WEDPLAN_SEED_AUTH_SECRET: "synthetic-test-value-with-more-than-32-characters",
  WEDPLAN_SEED_ADMIN_NAME: "Test Admin",
  WEDPLAN_SEED_ADMIN_EMAIL: "admin@example.com",
  WEDPLAN_SEED_ADMIN_PASSWORD: "Synthetic!Admin2026",
  WEDPLAN_SEED_VENDOR_NAME: "Test Vendor",
  WEDPLAN_SEED_VENDOR_EMAIL: "vendor@example.com",
  WEDPLAN_SEED_VENDOR_PASSWORD: "Synthetic!Vendor2026",
};

function fixture() {
  const { targets, secret } = readSeedConfig(environment);
  const db = { user: [], account: [], session: [], verification: [] };
  const auth = createSeedAuth(memoryAdapter(db), secret, targets);
  const store = {
    hasUniqueEmailIndex: async () => true,
    findUsers: async (email) => db.user.filter((user) => user.email === email),
    hasCredential: async (id) => db.account.some((account) =>
      account.userId === id && account.accountId === id && account.providerId === "credential" && !!account.password),
  };
  async function signUp({ name, email, password }) {
    const result = await auth.api.signUpEmail({ body: { name, email, password } });
    if (result.token !== null || Object.hasOwn(result.user, "seedMarker")) {
      throw new Error("Seed response exposed a token or private marker");
    }
    return result.user.id;
  }
  async function run(signUpAccount = signUp) {
    const outcomes = [];
    await seedAccounts(store, targets, signUpAccount, (role, outcome) => outcomes.push([role, outcome]));
    return outcomes;
  }
  return { db, run, signUp, targets, store };
}

test("creates admin and vendor with Better Auth and preserves credentials on rerun", async () => {
  const { db, run, targets } = fixture();
  assert.deepEqual(await run(), [["admin", "created"], ["vendor", "created"]]);
  const users = db.user.map(({ role, isBlocked, subscriptionPlan, emailVerified }) =>
    ({ role, isBlocked, subscriptionPlan, emailVerified }));
  assert.deepEqual(users, ["admin", "vendor"].map((role) =>
    ({ role, isBlocked: false, subscriptionPlan: "free", emailVerified: false })));
  assert.equal(db.session.length, 0);
  assert.equal(db.account.length, 2);
  assert.ok(db.account.every(({ password }) =>
    password && !targets.some((target) => target.password === password)));
  assert.deepEqual(await run(() => assert.fail("Unexpected signup")),
    [["admin", "already present"], ["vendor", "already present"]]);
});

for (const [label, alter] of [
  ["unmarked account", ({ user }) => { delete user[1].seedMarker; }],
  ["incorrect marker", ({ user }) => { user[1].seedMarker = user[0].seedMarker; }],
  ["wrong role", ({ user }) => { user[1].role = "customer"; }],
  ["blocked account", ({ user }) => { user[1].isBlocked = true; }],
  ["missing credential", ({ account }) => { account.pop(); }],
]) {
  test("preflight rejects " + label + " before creating a missing account", async () => {
    const { db, run } = fixture();
    await run();
    alter(db);
    db.user.shift();
    let attempts = 0;
    await assert.rejects(run(async () => { attempts++; }), /Conflicting vendor account/);
    assert.equal(attempts, 0);
    assert.equal(db.user.length, 1);
  });
}

test("refuses to seed without a full unique email index", async () => {
  const { store, run, db } = fixture();
  store.hasUniqueEmailIndex = async () => false;
  await assert.rejects(run(), /unique email index/);
  assert.equal(db.user.length, 0);
});

test("labels an index permission failure without exposing the driver error", async () => {
  const { store, run } = fixture();
  store.hasUniqueEmailIndex = async () => {
    throw Object.assign(new Error("synthetic-sensitive-driver-message"), { code: 13 });
  };
  await assert.rejects(run(), {
    message: "Unique email index preflight: MongoDB permission denied. Check the database user's privileges for this operation.",
  });
});

test("retains the signup database diagnosis after a read-back finds no account", async () => {
  const { run, db } = fixture();
  await assert.rejects(run(async () => {
    throw Object.assign(new Error("synthetic-sensitive-signup-message"), { code: 20 });
  }), { message: /^Could not create and verify the admin account\. admin Better Auth signup transaction: MongoDB rejected this operation\./ });
  assert.equal(db.user.length, 0);
});

test("uses only allowlisted driver codes and never renders unknown error data", () => {
  const secret = "synthetic-sensitive-value";
  const error = Object.assign(new Error(secret), { code: secret });
  assert.equal(seedFailure("MongoDB connection", error).reason,
    "MongoDB connection: Unexpected failure. Check the database and auth configuration for this stage.");
  const wrapped = new Error(secret, { cause: Object.assign(new Error(secret), { code: 18 }) });
  assert.equal(seedFailure("MongoDB connection", wrapped).reason,
    "MongoDB connection: MongoDB authentication failed. Check the Atlas database user, credentials, and authentication database.");
});

test("retries a transient connection once and preserves a TLS validation failure", async () => {
  let attempts = 0;
  const reset = new MongoNetworkError("synthetic", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) });
  await connectWithRetry(async () => {
    if (++attempts === 1) throw reset;
  });
  assert.equal(attempts, 2);
  attempts = 0;
  const tls = new MongoNetworkError("synthetic", { cause: Object.assign(new Error(), { code: "CERT_HAS_EXPIRED" }) });
  await assert.rejects(connectWithRetry(async () => { attempts++; throw tls; }), (error) => error === tls);
  assert.equal(attempts, 1);
  assert.match(seedFailure("Connection", tls).reason, /certificate expired/);
});

test("rejects duplicate emails, weak or reused passwords, and database mismatch", () => {
  for (const [override, message] of [
    [{ WEDPLAN_SEED_VENDOR_EMAIL: " ADMIN@EXAMPLE.COM " }, /emails must be distinct/],
    [{ WEDPLAN_SEED_VENDOR_PASSWORD: "weak" }, /WEDPLAN_SEED_VENDOR_PASSWORD/],
    [{ WEDPLAN_SEED_VENDOR_PASSWORD: environment.WEDPLAN_SEED_ADMIN_PASSWORD }, /passwords must be distinct/],
    [{ WEDPLAN_SEED_EXPECTED_DATABASE: "different" }, /Database names do not match/],
  ]) {
    assert.throws(() => readSeedConfig({ ...environment, ...override }), message);
  }
});

test("a partial failure can be retried without recreating the admin", async () => {
  const { db, run, signUp } = fixture();
  await assert.rejects(run((target) => {
    if (target.role === "vendor") throw new Error("Synthetic failure");
    return signUp(target);
  }), /Could not create and verify the vendor/);
  assert.deepEqual(db.user.map(({ role }) => role), ["admin"]);
  assert.deepEqual(await run(), [["admin", "already present"], ["vendor", "created"]]);
});

test("public auth signup cannot assign admin and session output hides the seed marker", async () => {
  process.env.MONGODB_URI = environment.MONGODB_URI;
  process.env.MONGODB_DATABASE = environment.MONGODB_DATABASE;
  const { createAuth } = await import("../dist/src/auth/auth.js");
  const db = { user: [], account: [], session: [], verification: [], jwks: [] };
  const auth = createAuth({
    origin: "https://app.example.test",
    baseURL: "https://api.example.test",
    secret: environment.WEDPLAN_SEED_AUTH_SECRET,
    google: { clientId: "test", clientSecret: "test" },
    github: { clientId: "test", clientSecret: "test" },
  }, memoryAdapter(db));
  const body = { name: "Public", email: "public@example.com", password: "Synthetic!Public2026" };
  const response = await auth.api.signUpEmail({ body: { ...body, role: "admin" } });
  assert.equal(response.user.role, "customer");
  assert.equal(db.user[0].role, "customer");
  db.user[0].seedMarker = "synthetic-private-marker";
  const login = await auth.api.signInEmail({ body, returnHeaders: true });
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: login.headers.get("set-cookie").split(";")[0] }),
  });
  assert.equal(session.user.role, "customer");
  assert.ok(!Object.hasOwn(session.user, "seedMarker"));
});
