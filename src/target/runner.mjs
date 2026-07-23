import { randomBytes } from "node:crypto";
import {
  copyFile,
  cp,
  readFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCase } from "./case-store.mjs";
import {
  comparePreservedParts,
  extractDocx,
  inventoryFingerprint,
  packDocx,
  packageInventory,
  renderDocx,
  validateExtractedPackage,
} from "./docx.mjs";
import {
  acquireRunLock,
  appendEvent,
  atomicWriteJson,
  ensurePrivateDirectory,
  readJson,
  sha256File,
  sha256Text,
} from "./fs-utils.mjs";
import { assertRequestedModel, runGigacode } from "./gigacode.mjs";
import {
  findingFingerprint,
  formatRetryPrompt,
  parseReviewReport,
  parseSynthesisResult,
  reviewOutputContract,
} from "./review.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const promptRoot = path.join(projectRoot, "prompts");

async function loadPrompt(name) {
  return readFile(path.join(promptRoot, name), "utf8");
}

async function writeState(runDirectory, state) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  await atomicWriteJson(path.join(runDirectory, "state.json"), next);
  await appendEvent(runDirectory, "state", {
    status: next.status,
    round: next.round ?? null,
  });
  return next;
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function executorConfig(config) {
  return {
    ...config.gigacode,
    passEnvironment: config.gigacode.passEnvironment ?? [],
  };
}

function eventRecorder(runDirectory) {
  return (event, fields) => {
    void appendEvent(runDirectory, `gigacode.${event}`, fields);
  };
}

function transcriptDirectory(config, runDirectory) {
  return config.storage.retainAgentTranscripts
    ? path.join(runDirectory, "transcripts")
    : null;
}

async function requireProducerArtifacts(roundDirectory) {
  const currentContract = path.join(roundDirectory, "artifacts/current-contract.md");
  const changeRegister = path.join(roundDirectory, "artifacts/change-register.json");
  const currentInfo = await stat(currentContract);
  if (!currentInfo.isFile() || currentInfo.size < 100) {
    throw new Error("Producer не создал содержательную действующую редакцию договора.");
  }
  const register = await readJson(changeRegister);
  if (!Array.isArray(register.changes)) {
    throw new Error("change-register.json должен содержать массив changes.");
  }
  return { currentContract, changeRegister };
}

async function verifyImmutableRunInputs(runDirectory, manifest) {
  const checks = [
    [
      path.join(runDirectory, "input/formation-request.json"),
      manifest.formationRequest.sha256,
      "formation-request.json",
    ],
    [
      path.join(runDirectory, "input/new-edition.docx"),
      manifest.newAgreementEdition.sha256,
      "new-edition.docx",
    ],
    ...manifest.signedDocuments.map((document) => [
      path.join(runDirectory, "input/signed", `${document.id}.pdf`),
      document.sha256,
      document.id,
    ]),
  ];
  for (const [filePath, expected, label] of checks) {
    if (await sha256File(filePath) !== expected) {
      throw new Error(`Агент изменил неизменяемый вход: ${label}.`);
    }
  }
}

async function workspaceFingerprint(roundDirectory, inventory) {
  const pieces = [inventoryFingerprint(inventory)];
  for (const relative of [
    "artifacts/current-contract.md",
    "artifacts/change-register.json",
  ]) {
    pieces.push(await sha256File(path.join(roundDirectory, relative)));
  }
  return sha256Text(pieces.join(":"));
}

async function validateCandidate(roundDirectory, referenceInventory, config) {
  const packageDirectory = path.join(roundDirectory, "package");
  await validateExtractedPackage(packageDirectory);
  const inventory = await packageInventory(packageDirectory);
  const preservationFailures = comparePreservedParts(referenceInventory, inventory);
  if (preservationFailures.length > 0) {
    throw new Error(
      `Нарушено сохранение DOCX:\n${preservationFailures.slice(0, 20).join("\n")}`,
    );
  }
  const candidatePath = path.join(roundDirectory, "candidate.docx");
  const candidateSha256 = await packDocx(packageDirectory, candidatePath);
  let render = null;
  if (config.tools?.requireSoffice) {
    render = await renderDocx(
      candidatePath,
      path.join(roundDirectory, "qa"),
      config.tools.sofficeCommand ?? "soffice",
    );
  }
  return {
    candidatePath,
    candidateSha256,
    inventory,
    render,
    workspaceFingerprint: await workspaceFingerprint(roundDirectory, inventory),
  };
}

async function runReviewer({
  reviewer,
  round,
  roundDirectory,
  candidate,
  config,
  runDirectory,
}) {
  const task = {
    schemaVersion: "contractility.review-task.v1",
    round,
    candidateSha256: candidate.candidateSha256,
    reviewer: {
      id: reviewer.id,
      model: reviewer.model,
      focus: reviewer.focus,
    },
    paths: {
      formationRequest: "../../input/formation-request.json",
      currentContract: "artifacts/current-contract.md",
      changeRegister: "artifacts/change-register.json",
      candidateDocx: "candidate.docx",
      renderedPdf: candidate.render ? "qa/candidate.pdf" : null,
      package: "package",
    },
  };
  const reviewTaskPath = path.join(roundDirectory, `review-task-${reviewer.id}.json`);
  await atomicWriteJson(reviewTaskPath, task);
  const basePrompt = await loadPrompt("reviewer.md");
  const prompt = `${basePrompt.trim()}\n\nReview task: rounds/${String(round).padStart(2, "0")}/review-task-${reviewer.id}.json\n\n${reviewOutputContract()}`;
  let result = await runGigacode({
    config: executorConfig(config),
    model: reviewer.model,
    prompt,
    cwd: runDirectory,
    session: `review:${round}:${reviewer.id}`,
    onEvent: eventRecorder(runDirectory),
    transcriptDirectory: transcriptDirectory(config, runDirectory),
  });
  if (!result.ok) {
    throw new Error(`Reviewer ${reviewer.id} завершился с ошибкой: ${result.stderr || result.output}`);
  }
  assertRequestedModel(result, reviewer.model);
  let report;
  let lastError;
  for (let attempt = 0; attempt <= config.review.formatRetries; attempt += 1) {
    try {
      report = parseReviewReport(result.output);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt === config.review.formatRetries) break;
      result = await runGigacode({
        config: executorConfig(config),
        model: reviewer.model,
        prompt: formatRetryPrompt(result.output),
        cwd: runDirectory,
        session: `review-format:${round}:${reviewer.id}:${attempt + 1}`,
        onEvent: eventRecorder(runDirectory),
        transcriptDirectory: transcriptDirectory(config, runDirectory),
      });
      if (!result.ok) break;
      assertRequestedModel(result, reviewer.model);
    }
  }
  if (lastError || !report) {
    throw new Error(`Reviewer ${reviewer.id} нарушил формат: ${lastError?.message ?? result.stderr}`);
  }
  return {
    schemaVersion: "contractility.review-report.v1",
    round,
    candidateSha256: candidate.candidateSha256,
    reviewer: {
      id: reviewer.id,
      requestedModel: reviewer.model,
      reportedModels: result.reportedModels,
      required: reviewer.required !== false,
    },
    verdict: report.verdict,
    findings: report.findings,
    execution: {
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      usage: result.usage,
    },
  };
}

async function runSynthesis({
  round,
  roundDirectory,
  reports,
  candidate,
  config,
  runDirectory,
}) {
  const findingMap = new Map();
  for (const report of reports) {
    for (const finding of report.findings) findingMap.set(finding.id, finding);
  }
  const findingsPath = path.join(roundDirectory, "untrusted-findings.json");
  await atomicWriteJson(findingsPath, {
    schemaVersion: "contractility.untrusted-findings.v1",
    candidateSha256: candidate.candidateSha256,
    reports,
  });
  await atomicWriteJson(path.join(roundDirectory, "synthesis-task.json"), {
    schemaVersion: "contractility.synthesis-task.v1",
    round,
    candidateSha256: candidate.candidateSha256,
    findingIds: [...findingMap.keys()],
  });
  const prompt = `${(await loadPrompt("synthesis.md")).trim()}

Synthesis task: rounds/${String(round).padStart(2, "0")}/synthesis-task.json
Untrusted findings: rounds/${String(round).padStart(2, "0")}/untrusted-findings.json`;
  const result = await runGigacode({
    config: executorConfig(config),
    model: config.models.synthesizer,
    prompt,
    cwd: runDirectory,
    session: `synthesis:${round}`,
    onEvent: eventRecorder(runDirectory),
    transcriptDirectory: transcriptDirectory(config, runDirectory),
  });
  if (!result.ok) {
    throw new Error(`Арбитр завершился с ошибкой: ${result.stderr || result.output}`);
  }
  assertRequestedModel(result, config.models.synthesizer);
  const synthesis = parseSynthesisResult(result.output, new Set(findingMap.keys()));
  const consensus = {
    schemaVersion: "contractility.review-consensus.v1",
    round,
    candidateSha256: candidate.candidateSha256,
    model: {
      requested: config.models.synthesizer,
      reported: result.reportedModels,
    },
    ...synthesis,
  };
  await atomicWriteJson(path.join(roundDirectory, "consensus.json"), consensus);
  return consensus;
}

async function createNextRound(currentDirectory, nextDirectory) {
  await ensurePrivateDirectory(nextDirectory);
  await Promise.all([
    cp(path.join(currentDirectory, "package"), path.join(nextDirectory, "package"), {
      recursive: true,
    }),
    cp(path.join(currentDirectory, "artifacts"), path.join(nextDirectory, "artifacts"), {
      recursive: true,
    }),
  ]);
}

export async function createAndRun({ caseDirectory, config, onRunCreated = null }) {
  const verifiedCase = await verifyCase(caseDirectory);
  const runId = `run-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
  const runDirectory = path.join(config.storage.runRoot, runId);
  await ensurePrivateDirectory(runDirectory);
  const releaseLock = await acquireRunLock(runDirectory);
  let state = {
    schemaVersion: "contractility.run-state.v1",
    runId,
    caseId: verifiedCase.manifest.caseId,
    status: "created",
    createdAt: new Date().toISOString(),
    round: 0,
  };
  try {
    state = await writeState(runDirectory, state);
    if (onRunCreated) await onRunCreated({ runId, runDirectory });
    const inputDirectory = path.join(runDirectory, "input");
    await ensurePrivateDirectory(inputDirectory);
    await Promise.all([
      copyFile(verifiedCase.requestPath, path.join(inputDirectory, "formation-request.json")),
      cp(path.join(caseDirectory, "inputs/signed"), path.join(inputDirectory, "signed"), {
        recursive: true,
      }),
      copyFile(verifiedCase.draftPath, path.join(inputDirectory, "new-edition.docx")),
      atomicWriteJson(path.join(runDirectory, "input-manifest.json"), verifiedCase.manifest),
    ]);
    state = await writeState(runDirectory, { ...state, status: "inputs-verified" });

    const firstRoundDirectory = path.join(runDirectory, "rounds/01");
    await ensurePrivateDirectory(path.join(firstRoundDirectory, "artifacts"));
    await extractDocx(
      path.join(inputDirectory, "new-edition.docx"),
      path.join(firstRoundDirectory, "package"),
    );
    const referenceInventory = await packageInventory(path.join(firstRoundDirectory, "package"));
    await atomicWriteJson(path.join(runDirectory, "reference-inventory.json"), referenceInventory);
    await atomicWriteJson(path.join(firstRoundDirectory, "task.json"), {
      schemaVersion: "contractility.producer-task.v1",
      caseId: verifiedCase.manifest.caseId,
      paths: {
        formationRequest: "../../input/formation-request.json",
        signedDocuments: "../../input/signed",
        retainedDraft: "../../input/new-edition.docx",
        package: "package",
        artifacts: "artifacts",
      },
    });
    const producerResult = await runGigacode({
      config: executorConfig(config),
      model: config.models.producer,
      prompt: `${(await loadPrompt("producer.md")).trim()}\n\nTask file: rounds/01/task.json`,
      cwd: runDirectory,
      session: "producer",
      onEvent: eventRecorder(runDirectory),
      transcriptDirectory: transcriptDirectory(config, runDirectory),
    });
    let recoveredFromCliCancellation = false;
    if (!producerResult.ok) {
      if (!producerResult.knownCliCancellation) {
        throw new Error(`Producer завершился с ошибкой: ${producerResult.stderr || producerResult.output}`);
      }
      if (producerResult.reportedModels.length > 0) {
        assertRequestedModel(producerResult, config.models.producer);
      }
      recoveredFromCliCancellation = true;
    }
    if (!recoveredFromCliCancellation) {
      assertRequestedModel(producerResult, config.models.producer);
      let producerStatus;
      try {
        producerStatus = JSON.parse(producerResult.output);
      } catch {
        throw new Error("Producer вернул некорректный JSON-статус.");
      }
      if (producerStatus.status === "blocked") {
        state = await writeState(runDirectory, {
          ...state,
          status: "blocked",
          blocker: producerStatus.reason ?? "Producer запросил ручное решение.",
        });
        return { runId, runDirectory, state };
      }
      if (producerStatus.status !== "candidate-ready") {
        throw new Error("Producer не подтвердил готовность кандидата.");
      }
    }
    let candidate;
    try {
      await verifyImmutableRunInputs(runDirectory, verifiedCase.manifest);
      await requireProducerArtifacts(firstRoundDirectory);
      candidate = await validateCandidate(firstRoundDirectory, referenceInventory, config);
    } catch (error) {
      if (recoveredFromCliCancellation) {
        throw new Error(
          `GigaCode CLI отменил операцию после MaxListenersExceededWarning, `
          + `но комплект кандидата не готов: ${error.message}`,
        );
      }
      throw error;
    }
    if (recoveredFromCliCancellation) {
      await appendEvent(runDirectory, "producer.recovered", {
        reason: "known-gigacode-cli-cancellation",
        attempt: producerResult.attempt,
      });
    }
    state = await writeState(runDirectory, {
      ...state,
      status: "candidate-created",
      round: 1,
      candidateSha256: candidate.candidateSha256,
    });

    let stallCount = 0;
    let previousStallKey = "";
    for (let round = 1; round <= config.review.maxRounds; round += 1) {
      const roundDirectory = path.join(
        runDirectory,
        `rounds/${String(round).padStart(2, "0")}`,
      );
      if (round > 1) {
        await createNextRound(
          path.join(runDirectory, `rounds/${String(round - 1).padStart(2, "0")}`),
          roundDirectory,
        );
        candidate = await validateCandidate(roundDirectory, referenceInventory, config);
      }
      state = await writeState(runDirectory, {
        ...state,
        status: "reviewing",
        round,
        candidateSha256: candidate.candidateSha256,
      });
      const beforeReviewFingerprint = candidate.workspaceFingerprint;
      const reports = await mapPool(
        config.models.reviewers,
        config.review.maxParallel,
        (reviewer) => runReviewer({
          reviewer,
          round,
          roundDirectory,
          candidate,
          config,
          runDirectory,
        }),
      );
      await verifyImmutableRunInputs(runDirectory, verifiedCase.manifest);
      const afterReviewInventory = await packageInventory(path.join(roundDirectory, "package"));
      const afterReviewFingerprint = await workspaceFingerprint(roundDirectory, afterReviewInventory);
      if (afterReviewFingerprint !== beforeReviewFingerprint) {
        throw new Error("Read-only reviewer изменил кандидат или обязательные артефакты.");
      }
      const reviewDirectory = path.join(roundDirectory, "reviews");
      await ensurePrivateDirectory(reviewDirectory);
      await Promise.all(reports.map((report) =>
        atomicWriteJson(path.join(reviewDirectory, `${report.reviewer.id}.json`), report)));
      const findingsSha256 = findingFingerprint(reports);
      const consensus = await runSynthesis({
        round,
        roundDirectory,
        reports,
        candidate,
        config,
        runDirectory,
      });
      await verifyImmutableRunInputs(runDirectory, verifiedCase.manifest);
      if (consensus.status === "blocked") {
        state = await writeState(runDirectory, {
          ...state,
          status: "blocked",
          round,
          findingsSha256,
          blocker: consensus.summary,
        });
        return { runId, runDirectory, state };
      }
      if (consensus.status === "done") {
        const doneCandidate = await validateCandidate(roundDirectory, referenceInventory, config);
        if (doneCandidate.workspaceFingerprint !== beforeReviewFingerprint) {
          throw new Error("Арбитр изменил кандидат при status=done.");
        }
        state = await writeState(runDirectory, {
          ...state,
          status: "awaiting-human-approval",
          round,
          candidateSha256: doneCandidate.candidateSha256,
          candidatePath: path.relative(runDirectory, doneCandidate.candidatePath),
          findingsSha256,
        });
        return { runId, runDirectory, state };
      }

      await requireProducerArtifacts(roundDirectory);
      const fixedCandidate = await validateCandidate(roundDirectory, referenceInventory, config);
      const stallKey = `${fixedCandidate.workspaceFingerprint}:${findingsSha256}`;
      stallCount = stallKey === previousStallKey ? stallCount + 1 : 1;
      previousStallKey = stallKey;
      if (stallCount >= config.review.stallRounds) {
        state = await writeState(runDirectory, {
          ...state,
          status: "blocked",
          round,
          candidateSha256: fixedCandidate.candidateSha256,
          findingsSha256,
          blocker: "Цикл ревью не меняет кандидат и повторяет тот же набор замечаний.",
        });
        return { runId, runDirectory, state };
      }
      candidate = fixedCandidate;
      state = await writeState(runDirectory, {
        ...state,
        status: "fixing",
        round,
        candidateSha256: candidate.candidateSha256,
        findingsSha256,
      });
    }
    state = await writeState(runDirectory, {
      ...state,
      status: "blocked",
      blocker: `Достигнут лимит раундов: ${config.review.maxRounds}.`,
    });
    return { runId, runDirectory, state };
  } catch (error) {
    state = await writeState(runDirectory, {
      ...state,
      status: "failed",
      error: error.message,
    }).catch(() => state);
    throw Object.assign(error, { runId, runDirectory, state });
  } finally {
    await releaseLock();
  }
}

export async function approveRun({
  runDirectory,
  approver,
  candidateSha256,
  findingsSha256,
}) {
  const state = await readJson(path.join(runDirectory, "state.json"));
  if (state.status !== "awaiting-human-approval") {
    throw new Error(`Подтверждение невозможно в состоянии ${state.status}.`);
  }
  if (state.candidateSha256 !== candidateSha256 || state.findingsSha256 !== findingsSha256) {
    throw new Error("Хеш кандидата или реестра замечаний изменился.");
  }
  const candidatePath = path.join(runDirectory, state.candidatePath);
  if (await sha256File(candidatePath) !== candidateSha256) {
    throw new Error("Кандидат DOCX изменён после ревью.");
  }
  const approval = {
    schemaVersion: "contractility.audit-approval.v1",
    approvedAt: new Date().toISOString(),
    approver,
    candidateSha256,
    findingsSha256,
    notice: "Аудиторское подтверждение процесса; не является электронной подписью.",
  };
  await atomicWriteJson(path.join(runDirectory, "approval/approval.json"), approval);
  const nextState = await writeState(runDirectory, { ...state, status: "approved" });
  return { approval, state: nextState };
}

export async function finalizeRun(runDirectory) {
  const state = await readJson(path.join(runDirectory, "state.json"));
  if (state.status !== "approved") {
    throw new Error(`Финализация невозможна в состоянии ${state.status}.`);
  }
  const approval = await readJson(path.join(runDirectory, "approval/approval.json"));
  const candidatePath = path.join(runDirectory, state.candidatePath);
  const candidateSha256 = await sha256File(candidatePath);
  if (candidateSha256 !== approval.candidateSha256) {
    throw new Error("Кандидат изменён после ручного подтверждения.");
  }
  const finalDirectory = path.join(runDirectory, "final");
  await ensurePrivateDirectory(finalDirectory);
  const finalPath = path.join(finalDirectory, "final-additional-agreement.docx");
  await copyFile(candidatePath, finalPath);
  const finalSha256 = await sha256File(finalPath);
  const manifest = {
    schemaVersion: "contractility.final-manifest.v1",
    finalizedAt: new Date().toISOString(),
    runId: state.runId,
    caseId: state.caseId,
    path: "final-additional-agreement.docx",
    sha256: finalSha256,
    approvalSha256: await sha256File(path.join(runDirectory, "approval/approval.json")),
  };
  await atomicWriteJson(path.join(finalDirectory, "final-manifest.json"), manifest);
  const nextState = await writeState(runDirectory, {
    ...state,
    status: "finalized",
    finalPath: path.relative(runDirectory, finalPath),
    finalSha256,
  });
  return { finalPath, manifest, state: nextState };
}

export async function verifyRun(runDirectory) {
  const state = await readJson(path.join(runDirectory, "state.json"));
  if (state.status !== "finalized") {
    throw new Error(`Проверка финала невозможна в состоянии ${state.status}.`);
  }
  const finalPath = path.join(runDirectory, state.finalPath);
  const actual = await sha256File(finalPath);
  if (actual !== state.finalSha256) throw new Error("SHA-256 финального DOCX не совпадает.");
  const manifest = await readJson(path.join(runDirectory, "final/final-manifest.json"));
  if (manifest.sha256 !== actual) throw new Error("Финальный манифест не совпадает с DOCX.");
  return { ok: true, finalPath, sha256: actual };
}
