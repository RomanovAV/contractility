import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../src/server.mjs";
import { verifyVendorIntegrity } from "../src/vendor-integrity.mjs";

test("vendored OCR files match the committed manifest", async () => {
  const result = await verifyVendorIntegrity();
  assert.equal(result.ok, true, JSON.stringify(result.failures, null, 2));
  assert.ok(result.checkedFiles >= 20);
});

test("local server exposes health and restrictive security headers", async (context) => {
  const server = await startServer({ port: 0 });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${origin}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    status: "ok",
    version: "0.1.0",
    networkRequired: false,
  });

  const indexResponse = await fetch(origin);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.match(indexResponse.headers.get("content-security-policy"), /worker-src 'self'/);
  assert.match(indexResponse.headers.get("content-security-policy"), /'wasm-unsafe-eval'/);
  assert.doesNotMatch(indexResponse.headers.get("content-security-policy"), /script-src[^;]*'unsafe-eval'/);
  assert.match(await indexResponse.text(), /Contractility/);

  const workerResponse = await fetch(`${origin}/vendor/tesseract/worker.min.js`);
  assert.equal(workerResponse.status, 200);
  assert.match(workerResponse.headers.get("content-security-policy"), /'wasm-unsafe-eval'/);
  assert.doesNotMatch(workerResponse.headers.get("content-security-policy"), /script-src[^;]*'unsafe-eval'/);
});

test("local server rejects unsupported methods", async (context) => {
  const server = await startServer({ port: 0 });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST" });
  assert.equal(response.status, 405);
});
