import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
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
  parseProducerStatus,
  verifyRun,
} from "../src/target/runner.mjs";
import {
  formatRetryPrompt,
  parseReviewReport,
} from "../src/target/review.mjs";
import { validateReconstructionScope } from "../src/target/scope.mjs";

const execFileAsync = promisify(execFile);
const fakeGigacode = path.resolve("test-support/fake-gigacode.mjs");

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function exists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Условие теста не выполнено за ${timeoutMs} мс.`);
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
      stallRounds: 2,
    },
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

test("producer status parser accepts one status object with harmless model formatting", () => {
  assert.deepEqual(
    parseProducerStatus('{"status":"change-plan-ready"}'),
    { status: "change-plan-ready" },
  );
  assert.deepEqual(
    parseProducerStatus('```json\n{"status":"change-plan-ready"}\n```'),
    { status: "change-plan-ready" },
  );
  assert.deepEqual(
    parseProducerStatus('План подготовлен.\n{"status":"change-plan-ready"}'),
    { status: "change-plan-ready" },
  );
  assert.deepEqual(
    parseProducerStatus('{"status":"blocked","reason":"Не найдено значение {СУММА}"}'),
    { status: "blocked", reason: "Не найдено значение {СУММА}" },
  );
});

test("producer status parser rejects missing or ambiguous status objects", () => {
  assert.throws(
    () => parseProducerStatus("План подготовлен."),
    /нет корректного JSON-объекта/,
  );
  assert.throws(
    () => parseProducerStatus(
      '{"status":"change-plan-ready"}\n{"status":"blocked","reason":"ambiguous"}',
    ),
    /несколько JSON-объектов/,
  );
});

test("review parser accepts one JSON object wrapped in harmless model formatting", () => {
  assert.deepEqual(
    parseReviewReport('```json\n{"verdict":"pass","findings":[]}\n```'),
    { verdict: "pass", findings: [] },
  );
  assert.deepEqual(
    parseReviewReport('Оформил результат ревью:\n{"verdict":"pass","findings":[]}'),
    { verdict: "pass", findings: [] },
  );
  assert.throws(
    () => parseReviewReport(
      '{"verdict":"pass","findings":[]}\n{"verdict":"pass","findings":[]}',
    ),
    /несколько JSON-объектов/,
  );
});

test("review parser accepts domain findings", () => {
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

test("review parser supports exact non-paginated artifact findings", () => {
  const report = parseReviewReport(JSON.stringify({
    verdict: "changes-required",
    findings: [{
      severity: "blocker",
      category: "security",
      target: "candidate.docx",
      sourceDocumentId: "candidate.docx",
      page: null,
      clause: "word/_rels/document.xml.rels rId7",
      evidence: "TargetMode=External",
      observed: "The candidate retains an external OOXML relationship",
      impact: "Opening the document can contact an external resource",
      proposedAction: "Remove the external relationship",
      confidence: 1,
    }],
  }));
  assert.equal(report.findings[0].page, null);
  assert.throws(
    () => parseReviewReport(JSON.stringify({
      verdict: "changes-required",
      findings: [{ ...report.findings[0], page: "N/A" }],
    })),
    /положительным целым числом или null/,
  );
});

test("review retry names the validation failure and requires re-verification", () => {
  const prompt = formatRetryPrompt(
    "I've verified the candidate and saved JSON.",
    new TypeError("finding.page должен быть положительным целым числом."),
  );
  assert.match(prompt, /<UNTRUSTED_VALIDATION_ERROR>\s+finding\.page/);
  assert.match(prompt, /Perform the assigned review again/);
  assert.match(prompt, /Do not infer a\s+pass verdict/);
  assert.match(prompt, /entire final assistant response must be exactly one JSON object/);
});

test("target config allows one model for every agent role", () => {
  const config = targetConfig("/tmp/runs");
  config.models.reviewers = config.models.reviewers.map((reviewer) => ({
    ...reviewer,
    model: "same-model",
  }));
  config.models.producer = "same-model";
  config.models.synthesizer = "same-model";
  assert.doesNotThrow(() => validateTargetConfig(config));
});

test("reconstruction scope validates contract identity after harmless normalization", () => {
  const evidenceManifest = {
    documents: [
      { id: "document-1", role: "contract", pageCount: 2 },
      { id: "document-2", role: "additional-agreement", pageCount: 3 },
    ],
  };
  const scope = {
    schemaVersion: "contractility.reconstruction-scope.v1",
    baseContract: {
      sourceDocumentId: "document-1",
      number: "№ 32–01/10",
      date: "1.12.2011",
      page: 1,
      evidence: "Договор №32-01/10 от 01.12.2011",
    },
    instruments: [{
      sourceDocumentId: "document-2",
      pages: [1, 2],
      agreementNumber: "8",
      agreementDate: "15.02.2024",
      referencedContractNumber: "N 32-01/10",
      referencedContractDate: "01.12.2011 г.",
      decision: "included",
      reason: "Номер и дата совпадают.",
    }],
  };
  assert.equal(validateReconstructionScope(scope, evidenceManifest), scope);
  assert.throws(
    () => validateReconstructionScope({
      ...scope,
      instruments: [{
        ...scope.instruments[0],
        referencedContractNumber: "38-ИЭ-РБ",
      }],
    }, evidenceManifest),
    /включён, хотя номер или дата.*не совпадают/,
  );
  assert.throws(
    () => validateReconstructionScope({
      ...scope,
      instruments: [{
        ...scope.instruments[0],
        decision: "excluded",
      }],
    }, evidenceManifest),
    /исключён, хотя номер и дата.*совпадают/,
  );
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
  process.env.FAKE_GIGACODE_MODE =
    "producer-cancel-slow-review-malformed-plan-review-format-retry";
  try {
    const config = targetConfig(path.join(temporary, "runs"), {
      passEnvironment: ["FAKE_GIGACODE_MODE"],
    });
    let createdRun;
    const pendingRun = createAndRun({
      caseDirectory: prepared.caseDirectory,
      config,
      onRunCreated(value) {
        createdRun = value;
      },
    });
    await waitFor(() => createdRun);
    const firstReviewPath = path.join(
      createdRun.runDirectory,
      "rounds/01/reviews/legal-a.json",
    );
    const slowReviewPath = path.join(
      createdRun.runDirectory,
      "rounds/01/reviews/legal-c.json",
    );
    await waitFor(() => exists(firstReviewPath));
    assert.equal(await exists(slowReviewPath), false);
    const run = await pendingRun;
    assert.equal(run.state.status, "awaiting-human-approval");
    const evidenceManifest = JSON.parse(await readFile(
      path.join(run.runDirectory, "rounds/01/evidence/manifest.json"),
      "utf8",
    ));
    assert.equal(evidenceManifest.documentCount, 2);
    assert.deepEqual(
      evidenceManifest.documents.map((document) => document.id),
      ["document-1", "document-2"],
    );
    assert.match(
      await readFile(
        path.join(run.runDirectory, "rounds/01/evidence", evidenceManifest.documents[1].path),
        "utf8",
      ),
      /## Страница 1\n\nИзменение/,
    );
    const producerTask = JSON.parse(await readFile(
      path.join(run.runDirectory, "rounds/01/reconstruction-task.json"),
      "utf8",
    ));
    assert.ok(Object.values(producerTask.paths).every((value) => !value.includes("..")));
    assert.equal(producerTask.policy.conflictResolution, "later-signed-amendment-wins");
    assert.equal(
      producerTask.policy.placeholderPolicy,
      "resolve-from-supplied-content-or-preserve-empty-template-field",
    );
    assert.equal(producerTask.policy.allowUnresolvedTemplateFields, true);
    assert.equal(
      producerTask.policy.bundledDocumentPolicy,
      "classify-each-contained-legal-instrument",
    );
    assert.equal(
      producerTask.policy.outOfScopeInstrumentPolicy,
      "exclude-and-record",
    );
    assert.equal(
      producerTask.policy.fullClauseReplacementPolicy,
      "supersede-entire-prior-clause-body-including-omitted-tiers-and-exceptions",
    );
    const events = await readFile(path.join(run.runDirectory, "events.ndjson"), "utf8");
    assert.match(events, /"event":"gigacode\.recovered"/);
    assert.doesNotMatch(events, /"event":"gigacode\.activity"/);
    for (const line of events.trim().split("\n")) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    const agentStatuses = await Promise.all(
      (await readdir(path.join(run.runDirectory, "agent-status")))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => JSON.parse(await readFile(
          path.join(run.runDirectory, "agent-status", name),
          "utf8",
        ))),
    );
    assert.ok(agentStatuses.some((status) => status.role === "producer-reconstruct"));
    assert.ok(agentStatuses.some((status) => status.role === "producer-plan-retry"));
    assert.ok(agentStatuses.some((status) =>
      status.role === "producer-apply"
      && status.phase === "recovered"
      && status.status === "completed"));
    assert.ok(agentStatuses.some((status) =>
      status.reviewerId === "legal-c" && status.status === "completed"));
    assert.ok(agentStatuses.some((status) =>
      status.role === "reviewer-format"
      && status.reviewerId === "legal-a"
      && status.status === "completed"));
    assert.ok(agentStatuses.some((status) =>
      status.role === "reviewer-format"
      && status.reviewerId === "legal-b"
      && status.status === "completed"));
    assert.ok(agentStatuses.every((status) => status.attempt === 1));
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

test("mixed agreement bundle excludes other contracts and applies full clause replacement", async () => {
  await chmod(fakeGigacode, 0o755);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "contractility-scope-"));
  const sources = {
    "document-1": Buffer.from("%PDF-1.4\ncontract-2011\n%%EOF\n"),
    "document-2": Buffer.from("%PDF-1.4\nagreement-6\n%%EOF\n"),
    "document-3": Buffer.from("%PDF-1.4\nmixed-agreement-bundle\n%%EOF\n"),
  };
  const sourcePaths = {};
  for (const [id, content] of Object.entries(sources)) {
    const sourcePath = path.join(temporary, `${id}.pdf`);
    await writeFile(sourcePath, content);
    sourcePaths[id] = sourcePath;
  }
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
          file: { name: "contract-2011.pdf", sha256: sha256(sources["document-1"]) },
          pages: [{
            number: 1,
            text: [
              "Договор №32-01/10 от 01.12.2011.",
              "Пункт 5.1: 1,7% или 1,0% в зависимости от объёма.",
            ].join(" "),
          }],
        },
        {
          id: "document-2",
          role: "additional-agreement",
          order: 2,
          complete: true,
          file: { name: "agreement-6.pdf", sha256: sha256(sources["document-2"]) },
          pages: [{
            number: 1,
            text: [
              "Дополнительное соглашение №6 к договору №32-01/10 от 01.12.2011.",
              "Дополнить пунктом 5.1.1: SberPay QR — 1,60%.",
            ].join(" "),
          }],
        },
        {
          id: "document-3",
          role: "additional-agreement",
          order: 3,
          complete: true,
          file: {
            name: "mixed-agreement-bundle.pdf",
            sha256: sha256(sources["document-3"]),
          },
          pages: [
            {
              number: 1,
              text: "Соглашение №10 к договору №38-ИЭ-РБ от 24.11.2020.",
            },
            {
              number: 2,
              text: [
                "Соглашение №8 к договору №32-01/10 от 01.12.2011.",
                "Пункт 5.1 изложить в новой редакции: Visa/MC 1,90%, "
                  + "SberPayQR 1,60%, SberPay FaceScan 1,90%.",
                "Пункт 5.1.1 исключить.",
              ].join(" "),
            },
            {
              number: 3,
              text: "Соглашение №2 к договору №38-РБ-4216-2023 от 30.05.2023.",
            },
          ],
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
    sources: sourcePaths,
    outputRoot: path.join(temporary, "cases"),
  });
  process.env.FAKE_GIGACODE_MODE = "mixed-contract-bundle";
  try {
    const config = targetConfig(path.join(temporary, "runs"), {
      passEnvironment: ["FAKE_GIGACODE_MODE"],
    });
    const run = await createAndRun({ caseDirectory: prepared.caseDirectory, config });
    assert.equal(run.state.status, "awaiting-human-approval");
    const scope = JSON.parse(await readFile(
      path.join(run.runDirectory, "rounds/01/artifacts/reconstruction-scope.json"),
      "utf8",
    ));
    assert.equal(scope.baseContract.number, "32-01/10");
    assert.equal(scope.baseContract.date, "01.12.2011");
    assert.deepEqual(
      scope.instruments.map(({ agreementNumber, decision }) => ({
        agreementNumber,
        decision,
      })),
      [
        { agreementNumber: "6", decision: "included" },
        { agreementNumber: "10", decision: "excluded" },
        { agreementNumber: "8", decision: "included" },
        { agreementNumber: "2", decision: "excluded" },
      ],
    );
    assert.ok(scope.instruments
      .filter((instrument) => instrument.decision === "excluded")
      .every((instrument) => /другой базовый договор/i.test(instrument.reason)));
    const currentContract = await readFile(
      path.join(run.runDirectory, "rounds/01/artifacts/current-contract.md"),
      "utf8",
    );
    assert.match(currentContract, /Visa\/Mastercard — 1\.90%/);
    assert.match(currentContract, /SberPayQR — 1\.60%/);
    assert.match(currentContract, /5\.1\.1 удалён/);
    assert.doesNotMatch(currentContract, /1[,.]7%|1[,.]0%|объ[её]м/i);
    const reviewTask = JSON.parse(await readFile(
      path.join(run.runDirectory, "rounds/01/review-task-legal-a.json"),
      "utf8",
    ));
    assert.equal(
      reviewTask.paths.reconstructionScope,
      "artifacts/reconstruction-scope.json",
    );
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
    assert.equal(
      await readFile(
        path.join(run.runDirectory, "rounds/02/evidence/manifest.json"),
        "utf8",
      ),
      await readFile(
        path.join(run.runDirectory, "rounds/01/evidence/manifest.json"),
        "utf8",
      ),
    );
  } finally {
    delete process.env.FAKE_GIGACODE_MODE;
  }
});
