import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { prepareCase } from "../src/target/case-store.mjs";
import { validateTargetConfig } from "../src/target/config.mjs";
import {
  assertRequestedModel,
  decodeStreamJson,
  runGigacode,
} from "../src/target/gigacode.mjs";
import {
  approveRun,
  createAndRun,
  finalizeRun,
  verifyRun,
} from "../src/target/runner.mjs";
import { parseReviewReport } from "../src/target/review.mjs";

const execFileAsync = promisify(execFile);
const fakeGigacode = path.resolve("test-support/fake-gigacode.mjs");

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function createMinimalDocx(root) {
  const packageDirectory = path.join(root, "docx-package");
  await mkdir(path.join(packageDirectory, "_rels"), { recursive: true });
  await mkdir(path.join(packageDirectory, "word"), { recursive: true });
  await writeFile(path.join(packageDirectory, "[Content_Types].xml"), `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  await writeFile(path.join(packageDirectory, "_rels/.rels"), `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  await writeFile(path.join(packageDirectory, "word/document.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Тестовое дополнительное соглашение</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`);
  const output = path.join(root, "draft.docx");
  await execFileAsync("zip", ["-q", "-X", "-r", output, "."], { cwd: packageDirectory });
  return output;
}

function targetConfig(runRoot, { passEnvironment = [] } = {}) {
  return {
    schemaVersion: "contractility.target-config.v1",
    gigacode: {
      command: process.execPath,
      commandArgs: [fakeGigacode],
      sessionTimeoutSeconds: 20,
      idleTimeoutSeconds: 5,
      retryCount: 0,
      retryDelaySeconds: 0,
      passEnvironment,
    },
    models: {
      producer: "producer-model",
      synthesizer: "synthesis-model",
      reviewers: [
        { id: "legal-a", model: "review-model-a", focus: "reconstruction", required: true },
        { id: "legal-b", model: "review-model-b", focus: "delta", required: true },
        { id: "legal-c", model: "review-model-c", focus: "fidelity", required: true },
      ],
    },
    review: {
      maxRounds: 3,
      maxParallel: 3,
      formatRetries: 1,
      requiredDistinctModels: 3,
      stallRounds: 2,
    },
    tools: { requireSoffice: false },
    storage: { runRoot, retainAgentTranscripts: false },
  };
}

test("decodeStreamJson returns result, session and reported model", () => {
  const decoded = decodeStreamJson([
    JSON.stringify({ type: "system", session_id: "s1", model: "m1" }),
    JSON.stringify({ type: "result", result: '{"ok":true}', usage: { total_tokens: 4 } }),
  ].join("\n"));
  assert.equal(decoded.output, '{"ok":true}');
  assert.equal(decoded.sessionId, "s1");
  assert.deepEqual(decoded.models, ["m1"]);
  assert.equal(decoded.usage.total_tokens, 4);
});

test("model verification fails closed when GigaCode omits or changes the model", () => {
  assert.throws(
    () => assertRequestedModel({ reportedModels: [] }, "requested"),
    /не сообщил/,
  );
  assert.throws(
    () => assertRequestedModel({ reportedModels: ["other"] }, "requested"),
    /но сообщил/,
  );
});

test("runGigacode uses the requested model and strict one-shot flags", async () => {
  await chmod(fakeGigacode, 0o755);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "contractility-exec-"));
  const events = [];
  const transcriptDirectory = path.join(temporary, "transcripts");
  const result = await runGigacode({
    config: {
      command: process.execPath,
      commandArgs: [fakeGigacode],
      sessionTimeoutSeconds: 10,
      idleTimeoutSeconds: 3,
      retryCount: 0,
    },
    model: "smoke-model",
    prompt: 'Return exactly {"status":"ok"} and no other text. Do not use tools.',
    cwd: temporary,
    session: "test",
    transcriptDirectory,
    onEvent(event, fields) {
      events.push({ event, ...fields });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, '{"status":"ok"}');
  assert.deepEqual(result.reportedModels, ["smoke-model"]);
  assert.equal(events.at(-1).event, "finished");
  assert.equal(events.at(-1).model, "smoke-model");
  assert.ok(events.filter((event) => event.event === "activity")
    .every((event) => event.model === "smoke-model"));
  const transcriptFiles = (await readdir(transcriptDirectory)).sort();
  assert.deepEqual(transcriptFiles, [
    "test.attempt-1.stderr.log",
    "test.attempt-1.stdout.ndjson",
    "test.attempt-1.summary.json",
  ]);
  assert.match(
    await readFile(path.join(transcriptDirectory, "test.attempt-1.stdout.ndjson"), "utf8"),
    /"type":"result"/,
  );
  const transcriptSummary = JSON.parse(await readFile(
    path.join(transcriptDirectory, "test.attempt-1.summary.json"),
    "utf8",
  ));
  assert.equal(transcriptSummary.model, "smoke-model");
  assert.equal(transcriptSummary.ok, true);
  assert.equal(transcriptSummary.transcriptLimited, false);
});

test("review parser rejects prose and accepts domain findings", () => {
  assert.throws(() => parseReviewReport("```json\n{}\n```"), /без Markdown/);
  const report = parseReviewReport(JSON.stringify({
    verdict: "changes-required",
    findings: [{
      severity: "major",
      category: "missing-evidence",
      target: "change-1",
      sourceDocumentId: "document-2",
      page: 3,
      clause: "2.1",
      evidence: "Пункт 2.1 изложить в новой редакции",
      observed: "Источник не указан",
      impact: "Изменение нельзя проверить",
      proposedAction: "Добавить ссылку на источник",
      confidence: 0.95,
    }],
  }));
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0].id, /^finding-/);
});

test("target config enforces multiple distinct reviewer models", () => {
  const config = targetConfig("/tmp/runs");
  validateTargetConfig(config);
  config.models.reviewers = config.models.reviewers.map((reviewer) => ({
    ...reviewer,
    model: "same-model",
  }));
  config.models.producer = "same-model";
  config.models.synthesizer = "same-model";
  assert.throws(() => validateTargetConfig(config), /минимум 3 разных моделей/);
});

test("full run recovers a complete producer candidate after known GigaCode CLI cancellation", async () => {
  await chmod(fakeGigacode, 0o755);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "contractility-target-"));
  const contract = Buffer.from("%PDF-1.4\ncontract\n%%EOF\n");
  const amendment = Buffer.from("%PDF-1.4\namendment\n%%EOF\n");
  const contractPath = path.join(temporary, "contract.pdf");
  const amendmentPath = path.join(temporary, "amendment.pdf");
  await writeFile(contractPath, contract);
  await writeFile(amendmentPath, amendment);
  const draftPath = await createMinimalDocx(temporary);
  const draft = await readFile(draftPath);
  const request = {
    schemaVersion: "contractility.formation-request.v1",
    inputs: {
      signedDocuments: [
        {
          id: "document-1",
          role: "contract",
          order: 1,
          complete: true,
          file: { name: "contract.pdf", sha256: sha256(contract) },
          pages: [{ number: 1, text: "Договор" }],
        },
        {
          id: "document-2",
          role: "additional-agreement",
          order: 2,
          complete: true,
          file: { name: "amendment.pdf", sha256: sha256(amendment) },
          pages: [{ number: 1, text: "Изменение" }],
        },
      ],
      newAgreementEdition: {
        file: { name: "draft.docx", size: draft.length, sha256: sha256(draft) },
      },
    },
    rules: { requireHumanApprovalBeforeFinalization: true },
  };
  const requestPath = path.join(temporary, "request.json");
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const prepared = await prepareCase({
    requestPath,
    draftPath,
    sources: {
      "document-1": contractPath,
      "document-2": amendmentPath,
    },
    outputRoot: path.join(temporary, "cases"),
  });
  process.env.FAKE_GIGACODE_MODE = "producer-cancel";
  try {
    const config = targetConfig(path.join(temporary, "runs"), {
      passEnvironment: ["FAKE_GIGACODE_MODE"],
    });
    const run = await createAndRun({ caseDirectory: prepared.caseDirectory, config });
    assert.equal(run.state.status, "awaiting-human-approval");
    assert.match(
      await readFile(path.join(run.runDirectory, "events.ndjson"), "utf8"),
      /"event":"producer\.recovered"/,
    );
    await assert.rejects(() => finalizeRun(run.runDirectory), /невозможна/);
    await assert.rejects(() => approveRun({
      runDirectory: run.runDirectory,
      approver: "Test Operator",
      candidateSha256: "wrong",
      findingsSha256: run.state.findingsSha256,
    }), /Хеш кандидата/);
    await approveRun({
      runDirectory: run.runDirectory,
      approver: "Test Operator",
      candidateSha256: run.state.candidateSha256,
      findingsSha256: run.state.findingsSha256,
    });
    const finalized = await finalizeRun(run.runDirectory);
    assert.equal(finalized.state.status, "finalized");
    const verified = await verifyRun(run.runDirectory);
    assert.equal(verified.ok, true);
    assert.equal(verified.sha256, finalized.manifest.sha256);
  } finally {
    delete process.env.FAKE_GIGACODE_MODE;
  }
});

test("review loop applies an arbiter fix and reruns all reviewers on a new candidate", async () => {
  await chmod(fakeGigacode, 0o755);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "contractility-cycle-"));
  const contract = Buffer.from("%PDF-1.4\ncontract\n%%EOF\n");
  const amendment = Buffer.from("%PDF-1.4\namendment\n%%EOF\n");
  const contractPath = path.join(temporary, "contract.pdf");
  const amendmentPath = path.join(temporary, "amendment.pdf");
  await writeFile(contractPath, contract);
  await writeFile(amendmentPath, amendment);
  const draftPath = await createMinimalDocx(temporary);
  const draft = await readFile(draftPath);
  const requestPath = path.join(temporary, "request.json");
  await writeFile(requestPath, `${JSON.stringify({
    schemaVersion: "contractility.formation-request.v1",
    inputs: {
      signedDocuments: [
        {
          id: "document-1",
          role: "contract",
          order: 1,
          complete: true,
          file: { name: "contract.pdf", sha256: sha256(contract) },
          pages: [{ number: 1, text: "Договор" }],
        },
        {
          id: "document-2",
          role: "additional-agreement",
          order: 2,
          complete: true,
          file: { name: "amendment.pdf", sha256: sha256(amendment) },
          pages: [{ number: 1, text: "Изменение" }],
        },
      ],
      newAgreementEdition: {
        file: { name: "draft.docx", size: draft.length, sha256: sha256(draft) },
      },
    },
    rules: { requireHumanApprovalBeforeFinalization: true },
  }, null, 2)}\n`);
  const prepared = await prepareCase({
    requestPath,
    draftPath,
    sources: { "document-1": contractPath, "document-2": amendmentPath },
    outputRoot: path.join(temporary, "cases"),
  });
  process.env.FAKE_GIGACODE_MODE = "fix-once";
  try {
    const config = targetConfig(path.join(temporary, "runs"), {
      passEnvironment: ["FAKE_GIGACODE_MODE"],
    });
    const run = await createAndRun({ caseDirectory: prepared.caseDirectory, config });
    assert.equal(run.state.status, "awaiting-human-approval");
    assert.equal(run.state.round, 2);
    const finalXml = await readFile(
      path.join(run.runDirectory, "rounds/02/package/word/document.xml"),
      "utf8",
    );
    assert.match(finalXml, /исправлено/);
  } finally {
    delete process.env.FAKE_GIGACODE_MODE;
  }
});
