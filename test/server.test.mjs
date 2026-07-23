import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  assert.match(indexHtml, /id="draft-file-input"[^>]*\.docx/);
  assert.match(indexHtml, /Новая редакция допсоглашения/);
  assert.match(indexHtml, /Финальное соглашение/);
  assert.match(indexHtml, /id="start-formation"/);
  assert.match(indexHtml, /id="formation-run-card"/);
  assert.match(indexHtml, /Пять рецензентов/);
  assert.match(indexHtml, /id="approve-candidate"/);
  assert.match(indexHtml, /id="download-final"/);
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

test("workflow API protects mutations and prepares a verified local case", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "contractility-ui-api-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const configDirectory = path.join(dataRoot, "config");
  const targetConfigPath = path.join(configDirectory, "target.json");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(targetConfigPath, `${JSON.stringify({
    schemaVersion: "contractility.target-config.v1",
    gigacode: {
      command: "fake-gigacode",
      commandArgs: [],
    },
    models: {
      producer: "producer-model",
      synthesizer: "synthesizer-model",
      reviewers: [
        { id: "review-a", model: "review-model-a", focus: "a", required: true },
        { id: "review-b", model: "review-model-b", focus: "b", required: true },
        { id: "review-c", model: "review-model-c", focus: "c", required: true },
      ],
    },
    review: {
      maxRounds: 2,
      maxParallel: 3,
      formatRetries: 0,
      requiredDistinctModels: 3,
      stallRounds: 2,
    },
    tools: {
      requireSoffice: false,
    },
    storage: {
      runRoot: "../runs",
      retainAgentTranscripts: false,
    },
  }, null, 2)}\n`);
  const fakeRunTarget = async ({ config, onRunCreated }) => {
    const runId = "run-ui-integration";
    const runDirectory = path.join(config.storage.runRoot, runId);
    const roundDirectory = path.join(runDirectory, "rounds", "01");
    await mkdir(path.join(roundDirectory, "reviews"), { recursive: true });
    await mkdir(path.join(roundDirectory, "qa"), { recursive: true });
    const candidate = Buffer.from("candidate docx");
    const candidateSha256 = sha256(candidate);
    await writeFile(path.join(roundDirectory, "candidate.docx"), candidate);
    await writeFile(path.join(roundDirectory, "qa", "candidate.pdf"), Buffer.from("%PDF preview"));
    await writeFile(path.join(roundDirectory, "reviews", "review-a.json"), `${JSON.stringify({
      reviewer: {
        id: "review-a",
        requestedModel: "review-model-a",
      },
      verdict: "pass",
      findings: [],
    })}\n`);
    await writeFile(path.join(roundDirectory, "consensus.json"), `${JSON.stringify({
      status: "done",
      summary: "Замечаний нет.",
    })}\n`);
    const state = {
      schemaVersion: "contractility.run-state.v1",
      runId,
      caseId: "case-from-ui",
      status: "awaiting-human-approval",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      round: 1,
      candidatePath: "rounds/01/candidate.docx",
      candidateSha256,
      findingsSha256: "f".repeat(64),
    };
    await writeFile(path.join(runDirectory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    await writeFile(path.join(runDirectory, "events.ndjson"), [
      JSON.stringify({
        at: new Date().toISOString(),
        event: "state",
        status: state.status,
      }),
      JSON.stringify({
        at: new Date().toISOString(),
        event: "gigacode.finished",
        session: "synthesis:1",
        model: "synthesizer-model",
        ok: true,
        durationMs: 1200,
        outputChars: 240,
      }),
      "",
    ].join("\n"));
    await onRunCreated({ runId, runDirectory });
    return { runId, runDirectory, state };
  };
  const server = await startServer({
    port: 0,
    workflowOptions: {
      dataRoot,
      targetConfigPath,
      runTarget: fakeRunTarget,
    },
  });
  context.after(() => stopServer(server));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const sessionResponse = await fetch(`${origin}/api/workflow/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.schemaVersion, "contractility.ui-session.v1");
  assert.equal(typeof session.token, "string");
  assert.ok(session.token.length >= 32);
  assert.equal(session.target.ready, true);
  assert.equal(session.target.models.reviewers.length, 3);

  const pdf = Buffer.from("%PDF-1.4\ncontract fixture\n%%EOF\n");
  const draft = Buffer.from("PK\u0003\u0004docx fixture");
  const formationRequest = {
    schemaVersion: "contractility.formation-request.v1",
    inputs: {
      signedDocuments: [{
        id: "document-1",
        role: "contract",
        order: 1,
        complete: true,
        file: {
          name: "contract.pdf",
          sha256: sha256(pdf),
        },
        pages: [{ number: 1, text: "Договор" }],
      }],
      newAgreementEdition: {
        file: {
          name: "new-edition.docx",
          size: draft.length,
          sha256: sha256(draft),
        },
      },
    },
    rules: {
      requireHumanApprovalBeforeFinalization: true,
    },
  };

  const rejected = await fetch(`${origin}/api/workflow/staging`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ formationRequest }),
  });
  assert.equal(rejected.status, 403);
  await rejected.arrayBuffer();

  const securedHeaders = {
    "X-Contractility-Token": session.token,
    Origin: origin,
  };
  const rejectedOrigin = await fetch(`${origin}/api/workflow/staging`, {
    method: "POST",
    headers: {
      "X-Contractility-Token": session.token,
      "Content-Type": "application/json",
      Origin: "https://example.invalid",
    },
    body: JSON.stringify({ formationRequest }),
  });
  assert.equal(rejectedOrigin.status, 403);
  await rejectedOrigin.arrayBuffer();

  const stagingResponse = await fetch(`${origin}/api/workflow/staging`, {
    method: "POST",
    headers: {
      ...securedHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ formationRequest }),
  });
  assert.equal(stagingResponse.status, 201);
  const staging = await stagingResponse.json();

  const mismatchedPdfResponse = await fetch(
    `${origin}/api/workflow/staging/${staging.stageId}/signed/document-1`,
    {
      method: "PUT",
      headers: {
        ...securedHeaders,
        "Content-Type": "application/pdf",
      },
      body: Buffer.from("%PDF-1.4\nwrong file\n%%EOF\n"),
    },
  );
  assert.equal(mismatchedPdfResponse.status, 409);
  await mismatchedPdfResponse.arrayBuffer();

  const pdfResponse = await fetch(
    `${origin}/api/workflow/staging/${staging.stageId}/signed/document-1`,
    {
      method: "PUT",
      headers: {
        ...securedHeaders,
        "Content-Type": "application/pdf",
      },
      body: pdf,
    },
  );
  assert.equal(pdfResponse.status, 200);
  assert.equal((await pdfResponse.json()).sha256, sha256(pdf));

  const draftResponse = await fetch(
    `${origin}/api/workflow/staging/${staging.stageId}/draft`,
    {
      method: "PUT",
      headers: {
        ...securedHeaders,
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      body: draft,
    },
  );
  assert.equal(draftResponse.status, 200);
  assert.equal((await draftResponse.json()).sha256, sha256(draft));

  const prepareResponse = await fetch(
    `${origin}/api/workflow/staging/${staging.stageId}/prepare`,
    {
      method: "POST",
      headers: securedHeaders,
    },
  );
  assert.equal(prepareResponse.status, 201);
  const prepared = await prepareResponse.json();
  const caseManifest = JSON.parse(await readFile(
    path.join(dataRoot, "cases", prepared.caseId, "case-manifest.json"),
    "utf8",
  ));
  assert.equal(caseManifest.caseId, prepared.caseId);
  assert.equal(caseManifest.signedDocuments[0].sha256, sha256(pdf));
  assert.equal(caseManifest.newAgreementEdition.sha256, sha256(draft));

  const runResponse = await fetch(
    `${origin}/api/workflow/cases/${prepared.caseId}/runs`,
    {
      method: "POST",
      headers: securedHeaders,
    },
  );
  assert.equal(runResponse.status, 202);
  const started = await runResponse.json();

  let job;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const jobResponse = await fetch(
      `${origin}/api/workflow/jobs/${started.jobId}`,
      { headers: { "X-Contractility-Token": session.token } },
    );
    assert.equal(jobResponse.status, 200);
    job = await jobResponse.json();
    if (job.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.status, "completed");
  assert.equal(job.run.state.status, "awaiting-human-approval");
  assert.equal(job.run.reviews[0].verdict, "pass");
  assert.equal(job.run.consensus.status, "done");
  assert.equal(job.run.gigacodeStatus.phase, "finished");
  assert.equal(job.run.gigacodeStatus.model, "synthesizer-model");
  assert.equal(job.run.gigacodeStatus.outputChars, 240);

  const approveResponse = await fetch(
    `${origin}/api/workflow/runs/${job.runId}/approve`,
    {
      method: "POST",
      headers: {
        ...securedHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        approver: "Тестовый проверяющий",
        candidateSha256: job.run.state.candidateSha256,
        findingsSha256: job.run.state.findingsSha256,
      }),
    },
  );
  assert.equal(approveResponse.status, 200);
  assert.equal((await approveResponse.json()).state.status, "approved");

  const finalizeResponse = await fetch(
    `${origin}/api/workflow/runs/${job.runId}/finalize`,
    {
      method: "POST",
      headers: securedHeaders,
    },
  );
  assert.equal(finalizeResponse.status, 200);
  assert.equal((await finalizeResponse.json()).state.status, "finalized");

  const finalResponse = await fetch(
    `${origin}/api/workflow/runs/${job.runId}/files/final`,
    {
      headers: { "X-Contractility-Token": session.token },
    },
  );
  assert.equal(finalResponse.status, 200);
  assert.equal(
    finalResponse.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.deepEqual(Buffer.from(await finalResponse.arrayBuffer()), Buffer.from("candidate docx"));
});
