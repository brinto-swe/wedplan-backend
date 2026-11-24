import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { MongoClient } from "mongodb";

test("built Vercel app coalesces startup and retries transient failures", async (t) => {
  Object.assign(process.env, {
    MONGODB_URI: "mongodb://127.0.0.1:27017",
    MONGODB_DATABASE: "wedplan_test_double",
    CLIENT_URL: "https://app.example.test",
    BETTER_AUTH_URL: "https://api.example.test",
    BETTER_AUTH_SECRET: "synthetic-test-value-with-more-than-32-characters",
    GOOGLE_CLIENT_ID: "test-google",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    GITHUB_CLIENT_ID: "test-github",
    GITHUB_CLIENT_SECRET: "test-github-secret",
  });
  let connections = 0;
  let pings = 0;
  let bookingIndexes = 0;

  t.mock.method(MongoClient.prototype, "connect", async function () {
    connections += 1;
    if (connections === 1) throw new Error("Synthetic transient connection failure");
    return this;
  });
  t.mock.method(MongoClient.prototype, "db", () => ({
    command: async () => { pings += 1; return { ok: 1 }; },
    collection: (name) => ({
      createIndex: async () => "synthetic-auth-index",
      createIndexes: async () => {
        assert.equal(name, "bookings");
        bookingIndexes += 1;
        if (bookingIndexes === 1) throw new Error("Synthetic transient index failure");
        return [];
      },
    }),
  }));

  const { default: app } = await import("../dist/app.js");
  assert.equal(typeof app, "function");
  assert.equal(connections, 0, "import must not connect or start a listener");
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const origin = "https://app.example.test";
  const base = "http://127.0.0.1:" + server.address().port;
  const fetchPath = (path) => fetch(base + path, { headers: { Origin: origin } });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchPath("/api/auth/ok");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "API initialization failed. Try again shortly." });
  }

  const responses = await Promise.all(Array.from({ length: 8 }, () => fetchPath("/api/auth/ok")));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    await response.json();
  }
  const protectedRoute = await fetchPath("/api/bookings/my");
  assert.equal(protectedRoute.status, 401);
  await protectedRoute.json();
  const adminRoute = await fetchPath("/api/admin/users");
  assert.equal(adminRoute.status, 401);
  assert.deepEqual(await adminRoute.json(), { error: "Bearer token required" });

  assert.equal(connections, 2);
  assert.equal(pings, 1);
  assert.equal(bookingIndexes, 2);
});
