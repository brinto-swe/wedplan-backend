import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { crc32 } from "node:zlib";

import { createApp } from "../dist/src/app.js";

const request = fetch;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5CYAAAAASUVORK5CYII=", "base64");
const maxImageBytes = 4 * 1024 * 1024;
const image = (bytes = png, type = "image/png", name = "fixture.png") => ({ bytes, type, name });

function paddedPng(size) {
  const chunk = Buffer.alloc(size - png.length, "a");
  chunk.writeUInt32BE(chunk.length - 12);
  chunk.write("tEXtComment\0", 4);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

function multipart(...files) {
  const body = new FormData();
  for (const { bytes, type, name } of files) body.append("images", new Blob([bytes], { type }), name);
  return body;
}

const users = {
  vendor: { role: "vendor" },
  customer: { role: "customer" },
  blocked: { role: "vendor", isBlocked: true },
  admin: { role: "admin" },
};
const auth = {
  handler: () => new Response(null, { status: 404 }),
  api: { verifyJWT: async ({ body: { token } }) => ({ payload: { sub: token, exp: Date.now() / 1000 + 60 } }) },
  $context: Promise.resolve({ internalAdapter: { findUserById: async (id) => users[id] && { id, ...users[id] } } }),
};

async function serve(t, key, reserve, path = "images") {
  const server = createApp(auth, "http://localhost:3000", {}, undefined, undefined, undefined, undefined, undefined, key, reserve)
    .listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const endpoint = "http://127.0.0.1:" + server.address().port + "/api/uploads/" + path;
  return (actor, body, headers = {}) => request(endpoint, {
    method: "POST", body, headers: { ...headers, ...(actor && { Authorization: "Bearer " + actor }) },
  });
}

test("image uploads authorize one file per request and expose only safe ImgBB metadata", async (t) => {
  let calls = 0;
  let behavior = "success";
  let expectedBytes = png;
  t.mock.method(globalThis, "fetch", async (endpoint, init) => {
    calls++;
    assert.equal(endpoint.origin + endpoint.pathname, "https://api.imgbb.com/1/upload");
    assert.equal(endpoint.searchParams.get("key"), "mock-key");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const file = init.body.get("image");
    assert.equal(file.name, "image.png");
    assert.equal(file.type, "image/png");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), expectedBytes);
    if (behavior === "failure") return Response.json({ error: "sensitive response" }, { status: 503 });
    if (behavior === "invalid-json") return new Response("sensitive response");
    return Response.json({ success: true, data: {
      url: behavior === "bad-url" ? "https://i.ibb.co.example.test/image.png" : "https://i.ibb.co/example/image.png",
      display_url: "https://i.ibb.co/example/display.png", delete_url: "https://ibb.co/delete/private-link",
    } });
  });
  const upload = await serve(t, "mock-key");
  const metadata = { url: "https://i.ibb.co/example/image.png", displayUrl: "https://i.ibb.co/example/display.png" };

  await t.test("Vendor and Customer can make sequential independent single-image uploads", async () => {
    for (const actor of ["vendor", "vendor", "customer", "customer"]) {
      const result = await upload(actor, multipart(image()));
      assert.equal(result.status, 201);
      assert.equal(result.headers.get("cache-control"), "no-store");
      assert.deepEqual(await result.json(), { data: [metadata] });
    }
    assert.equal(calls, 4);
  });

  await t.test("rejects anonymous, blocked, and Admin requests before parsing", async () => {
    for (const [actor, status] of [[null, 401], ["blocked", 403], ["admin", 403]]) {
      assert.equal((await upload(actor, "malformed")).status, status);
    }
    assert.equal(calls, 4);
  });

  await t.test("rejects invalid format, spoofed MIME, and malformed or empty forms", async () => {
    assert.equal((await upload("vendor", multipart(image(Buffer.from("GIF89a"), "image/gif")))).status, 415);
    assert.equal((await upload("vendor", multipart(image(Buffer.from("not an image"))))).status, 415);
    assert.equal((await upload("vendor", multipart(image(png, "image/jpeg", "spoof.jpg")))).status, 415);
    assert.equal((await upload("vendor", multipart(image(Buffer.alloc(0))))).status, 400);
    assert.equal((await upload("vendor", multipart())).status, 400);
    assert.equal((await upload("vendor", "bad", { "Content-Type": "multipart/form-data; boundary=broken" })).status, 400);
    assert.equal((await upload("vendor", "not multipart")).status, 415);
    assert.equal(calls, 4);
  });

  await t.test("accepts 4 MiB, rejects one byte over, rejects two files, and caps the multipart body", async () => {
    expectedBytes = paddedPng(maxImageBytes);
    const boundary = await upload("customer", multipart(image(expectedBytes)));
    assert.equal(boundary.status, 201);
    assert.deepEqual(await boundary.json(), { data: [metadata] });
    expectedBytes = png;
    const oversized = await upload("customer", multipart(image(paddedPng(maxImageBytes + 1))));
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "The image must be at most 4 MiB" });
    assert.equal((await upload("customer", multipart(image(), image()))).status, 400);
    const excessiveOverhead = multipart(image(paddedPng(maxImageBytes), "image/png", "a".repeat(70 * 1024) + ".png"));
    const oversizedBody = await upload("customer", excessiveOverhead);
    assert.equal(oversizedBody.status, 413);
    assert.deepEqual(await oversizedBody.json(), { error: "Multipart body must be at most 4259840 bytes including overhead" });
    assert.equal(calls, 5);
  });

  await t.test("sanitizes upstream failures and malformed responses", async () => {
    for (behavior of ["failure", "invalid-json", "bad-url"]) {
      const response = await upload("vendor", multipart(image()));
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "Image hosting could not complete the upload" });
    }
  });
});

test("missing ImgBB configuration returns 503 without making upstream requests", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected ImgBB request"));
  const upload = await serve(t, undefined);
  const response = await upload("customer", multipart(image()));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Image uploads are unavailable" });
  assert.equal(upstream.mock.callCount(), 0);
});

test("signup profile uploads require the configured origin and quota and reuse image validation", async (t) => {
  let upstream = 0;
  let reserved = 0;
  let limit = "available";
  const url = "https://i.ibb.co/example/signup.png";
  t.mock.method(globalThis, "fetch", async () => {
    upstream++;
    return Response.json({ success: true, data: { url, delete_url: "private" } });
  });
  const upload = await serve(t, "fixture-key", async () => {
    reserved++;
    if (limit === "error") throw new Error("private database detail");
    return limit === "available";
  }, "signup-profile-image");
  const headers = { Origin: "http://localhost:3000", "X-WedPlan-Upload": "signup-profile" };
  assert.equal((await upload(null, multipart(image()), { ...headers, Origin: "https://foreign.example" })).status, 403);
  assert.equal((await upload(null, multipart(image()), { Origin: headers.Origin })).status, 403);
  assert.equal(reserved, 0);
  assert.equal((await upload(null, multipart(image(Buffer.from("invalid"))), headers)).status, 415);
  assert.equal((await upload(null, multipart(image(paddedPng(maxImageBytes + 1))), headers)).status, 413);
  assert.equal((await upload(null, multipart(image(), image()), headers)).status, 400);
  assert.equal(upstream, 0);
  const response = await upload(null, multipart(image()), headers);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { data: [{ url }] });
  limit = "exhausted";
  const throttled = await upload(null, multipart(image()), headers);
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get("retry-after")) > 0);
  limit = "error";
  const unavailable = await upload(null, multipart(image()), headers);
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /private database detail/);
  assert.equal(upstream, 1);
});
