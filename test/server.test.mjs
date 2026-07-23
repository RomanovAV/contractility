import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../src/server.mjs";
import { verifyVendorIntegrity } from "../src/vendor-integrity.mjs";

async function stopServer(server) {
  const stopped = new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections?.();
  await stopped;
}

test("vendored OCR files match the committed manifest", async () => {
  const result = await verifyVendorIntegrity();
  assert.equal(result.ok, true, JSON.stringify(result.failures, null, 2));
  assert.ok(result.checkedFiles >= 20);
});

test("local server exposes health and restrictive security headers", async (context) => {
  const server = await startServer({ port: 0 });
  context.after(() => stopServer(server));
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
  const indexHtml = await indexResponse.text();
  assert.match(indexHtml, /Contractility/);
  assert.match(indexHtml, /id="file-input"[^>]*multiple/);
  assert.match(indexHtml, /id="additional-file-input"[^>]*multiple/);
  assert.match(indexHtml, />\+ Добавить документы</);
  assert.match(indexHtml, />Сбросить</);

  const diagnosticsResponse = await fetch(`${origin}/diagnostics.html`);
  assert.equal(diagnosticsResponse.status, 200);
  assert.match(await diagnosticsResponse.text(), /diagnostics\.mjs/);

  const diagnosticsScriptResponse = await fetch(`${origin}/diagnostics.mjs`);
  assert.equal(diagnosticsScriptResponse.status, 200);
  assert.match(diagnosticsScriptResponse.headers.get("content-type"), /text\/javascript/);
  await diagnosticsScriptResponse.arrayBuffer();

  const workerResponse = await fetch(`${origin}/vendor/tesseract/worker.min.js`);
  assert.equal(workerResponse.status, 200);
  assert.match(workerResponse.headers.get("content-security-policy"), /'wasm-unsafe-eval'/);
  assert.match(workerResponse.headers.get("content-security-policy"), /script-src[^;]*'unsafe-eval'/);
  await workerResponse.arrayBuffer();

  const pdfWorkerResponse = await fetch(`${origin}/vendor/pdfjs/pdf.worker.min.mjs`);
  assert.equal(pdfWorkerResponse.status, 200);
  assert.match(pdfWorkerResponse.headers.get("content-security-policy"), /'wasm-unsafe-eval'/);
  assert.doesNotMatch(pdfWorkerResponse.headers.get("content-security-policy"), /script-src[^;]*'unsafe-eval'/);
  await pdfWorkerResponse.arrayBuffer();

  const pdfWasmResponse = await fetch(`${origin}/vendor/pdfjs/wasm/jbig2.wasm`);
  assert.equal(pdfWasmResponse.status, 200);
  assert.match(pdfWasmResponse.headers.get("content-type"), /application\/wasm/);
  await pdfWasmResponse.arrayBuffer();
});

test("local server rejects unsupported methods", async (context) => {
  const server = await startServer({ port: 0 });
  context.after(() => stopServer(server));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST" });
  assert.equal(response.status, 405);
  await response.arrayBuffer();
});
