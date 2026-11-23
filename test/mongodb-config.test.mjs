import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoClient } from "mongodb";

const fixture = {
  MONGODB_URI: "mongodb://127.0.0.1:27017/ignored_uri_database",
  MONGODB_DATABASE: "wedplan_stripe_test",
  BETTER_AUTH_SECRET: "synthetic-test-value-with-more-than-32-characters",
  GOOGLE_CLIENT_ID: "synthetic-google",
  GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
  GITHUB_CLIENT_ID: "synthetic-github",
  GITHUB_CLIENT_SECRET: "synthetic-github-secret",
};

test("startup rejects missing or invalid MongoDB configuration before connecting", async (t) => {
  const connect = t.mock.method(MongoClient.prototype, "connect", () => assert.fail("Unexpected MongoDB connection"));
  const log = t.mock.method(console, "error", () => {});
  const { getApplication } = await import("../dist/src/bootstrap.js");
  for (const [key, value] of [
    ["MONGODB_URI", undefined],
    ["MONGODB_URI", " "],
    ["MONGODB_URI", "invalid-private-value"],
    ["MONGODB_DATABASE", undefined],
    ["MONGODB_DATABASE", ""],
    ["MONGODB_DATABASE", " "],
    ["MONGODB_DATABASE", "invalid/database"],
  ]) {
    Object.assign(process.env, fixture);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    await assert.rejects(getApplication(), { message: "Invalid startup environment" });
    assert.deepEqual(log.mock.calls.at(-1).arguments, ["Missing or invalid startup environment:", key]);
  }
  Object.assign(process.env, fixture, { MONGODB_URI: "mongodb://@" });
  await assert.rejects(getApplication(), { message: "API initialization failed" });
  assert.deepEqual(log.mock.calls.at(-1).arguments, [
    "WedPlan initialization failed during MongoDB configuration (check MONGODB_URI syntax and options).",
  ]);
  assert.equal(connect.mock.callCount(), 0);
});

for (const database of ["wedplan", "wedplan_stripe_test"]) {
  test(`uses the explicit ${database} database without a network connection`, async (t) => {
    const connect = t.mock.method(MongoClient.prototype, "connect", () => assert.fail("Unexpected MongoDB connection"));
    Object.assign(process.env, fixture, { MONGODB_DATABASE: database });
    const { client, getDatabase } = await import(`../dist/src/db/mongodb.js?${database}`);
    try {
      assert.equal(getDatabase().databaseName, database);
      delete process.env.MONGODB_DATABASE;
      assert.equal(getDatabase().databaseName, database);
      assert.equal(connect.mock.callCount(), 0);
    } finally {
      await client.close();
    }
  });
}
