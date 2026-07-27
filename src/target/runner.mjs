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
import {
  materializeEvidenceWorkspace,
  verifyEvidenceWorkspace,
} from "./evidence.mjs";
import { createAgentStatusStore } from "./agent-status.mjs";

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

function createGigacodeEventRecorder(runDirectory, agentStatusStore) {
  let pending = Promise.resolve();
  return {
    record(event, fields) {
      agentStatusStore.record(event, fields);
      if (event === "activity") return;
      pending = pending.then(() =>
        appendEvent(runDirectory, `gigacode.${event}`, fields));
    },
    async flush() {
      await pending;
    },
  };
}

function transcriptDirectory(config, runDirectory) {
  return config.storage.retainAgentTranscripts
    ? path.join(runDirectory, "transcripts")
    : null;
}

function formationPolicy() {
  return {
    amendmentOrder: "strict-input-order",
    conflictResolution: "later-signed-amendment-wins",
    preserveSourceMeaning: true,
    doNotTreatDraftAsSigned: true,
    preserveDocxStructure: true,
    proposedAgreementRole: "declared-change-intent-and-output-template",
    historicalDocumentFormats: "arbitrary",
    requireStructuralSimilarityToCurrentContract: false,
    preserveProposedAgreementLayout: true,
    allowSemanticEditsInEditableOoxmlParts: true,
    requiredCoverage: "all-changes-declared-by-proposed-agreement",
    placeholderPolicy: "resolve-from-supplied-content-or-block-specific-field",
    requireEvidenceForEveryChange: true,
    requireHumanApprovalBeforeFinalization: true,
  };
}

async function requireCurrentContract(roundDirectory) {
  const currentContract = path.join(roundDirectory, "artifacts/current-contract.md");
  const currentInfo = await stat(currentContract);
  if (!currentInfo.isFile() || currentInfo.size < 100) {
    throw new Error("Producer не создал содержательную действующую редакцию договора.");
  }
  return currentContract;
}

async function requireChangeArtifacts(roundDirectory) {
  const changeRegister = path.join(roundDirectory, "artifacts/change-register.json");
  const changePlan = path.join(roundDirectory, "artifacts/change-plan.json");
  const register = await readJson(changeRegister);
  if (!Array.isArray(register.changes)) {
    throw new Error("change-register.json должен содержать массив changes.");
  }
  const plan = await readJson(changePlan);
  if (!Array.isArray(plan.operations)) {
    throw new Error("change-plan.json должен содержать массив operations.");
  }
  return { changeRegister, changePlan };
}

async function requireProducerArtifacts(roundDirectory) {
  const currentContract = await requireCurrentContract(roundDirectory);
  const { changeRegister, changePlan } = await requireChangeArtifacts(roundDirectory);
  return { currentContract, changeRegister, changePlan };
}

function isProducerStatus(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.status === "string";
}

function embeddedJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

export function parseProducerStatus(output) {
  const text = String(output ?? "").trim();
  try {
    const exact = JSON.parse(text);
    if (isProducerStatus(exact)) return exact;
  } catch {
    // Some models wrap the requested status in prose or a Markdown fence.
  }

  const candidates = embeddedJsonObjects(text)
    .map((candidate) => {
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    })
    .filter(isProducerStatus);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new TypeError("ответ содержит несколько JSON-объектов со статусом");
  }
  throw new TypeError("в ответе нет корректного JSON-объекта со статусом");
}

async function runProducerStage({
  stage,
  expectedStatus,
  promptName,
  taskName,
  roundDirectory,
  config,
  runDirectory,
  onGigacodeEvent,
  validateArtifacts,
}) {
  const result = await runGigacode({
    config: executorConfig(config),
    model: config.models.producer,
    prompt: `${(await loadPrompt(promptName)).trim()}\n\nTask file: ${taskName}`,
    cwd: roundDirectory,
    session: `producer-${stage}`,
    onEvent: onGigacodeEvent,
    transcriptDirectory: transcriptDirectory(config, runDirectory),
  });
  let recovered = false;
  if (!result.ok) {
    if (!result.knownCliCancellation) {
      throw new Error(
        `Producer ${stage} завершился с ошибкой: ${result.stderr || result.output}`,
      );
    }
    if (result.reportedModels.length > 0) {
      assertRequestedModel(result, config.models.producer);
    }
    recovered = true;
  }
  if (!recovered) {
    assertRequestedModel(result, config.models.producer);
    let status;
    try {
      status = parseProducerStatus(result.output);
    } catch (error) {
      throw new Error(
        `Producer ${stage} вернул некорректный JSON-статус: ${error.message}.`,
      );
    }
    if (status.status === "blocked") {
      return {
        blocked: status.reason ?? `Producer ${stage} запросил ручное решение.`,
        artifacts: null,
      };
    }
    if (status.status !== expectedStatus) {
      throw new Error(
        `Producer ${stage} не подтвердил ожидаемый статус ${expectedStatus}.`,
      );
    }
  }
  let artifacts;
  try {
    artifacts = await validateArtifacts();
  } catch (error) {
    if (recovered) {
      throw new Error(
        `GigaCode CLI отменил стадию producer-${stage} после `
        + `MaxListenersExceededWarning, но результат стадии не готов: ${error.message}`,
      );
    }
    throw error;
  }
  if (recovered) {
    onGigacodeEvent("recovered", {
      session: `producer-${stage}`,
      model: config.models.producer,
      attempt: result.attempt,
      ok: true,
      durationMs: result.durationMs,
      outputChars: result.output.length,
      reason: "known-gigacode-cli-cancellation",
    });
  }
  return { blocked: null, artifacts };
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
    "artifacts/change-plan.json",
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
  evidenceManifestSha256,
  onGigacodeEvent,
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
    policy: formationPolicy(),
    evidenceManifestSha256,
    paths: {
      evidenceManifest: "evidence/manifest.json",
      evidenceDocuments: "evidence/documents",
      currentContract: "artifacts/current-contract.md",
      changeRegister: "artifacts/change-register.json",
      changePlan: "artifacts/change-plan.json",
      candidateDocx: "candidate.docx",
      renderedPdf: candidate.render ? "qa/candidate.pdf" : null,
      package: "package",
    },
  };
  const reviewTaskPath = path.join(roundDirectory, `review-task-${reviewer.id}.json`);
  await atomicWriteJson(reviewTaskPath, task);
  const basePrompt = await loadPrompt("reviewer.md");
  const prompt = `${basePrompt.trim()}\n\nReview task: review-task-${reviewer.id}.json\n\n${reviewOutputContract()}`;
  let result = await runGigacode({
    config: executorConfig(config),
    model: reviewer.model,
    prompt,
    cwd: roundDirectory,
    session: `review:${round}:${reviewer.id}`,
    onEvent: onGigacodeEvent,
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
        cwd: roundDirectory,
        session: `review-format:${round}:${reviewer.id}:${attempt + 1}`,
        onEvent: onGigacodeEvent,
        transcriptDirectory: transcriptDirectory(config, runDirectory),
      });
      if (!result.ok) break;
      assertRequestedModel(result, reviewer.model);
    }
  }
  if (lastError || !report) {
    throw new Error(`Reviewer ${reviewer.id} нарушил формат: ${lastError?.message ?? result.stderr}`);
  }
  await verifyEvidenceWorkspace(
    path.join(roundDirectory, "evidence"),
    evidenceManifestSha256,
  );
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
  evidenceManifestSha256,
  onGigacodeEvent,
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
    policy: formationPolicy(),
    evidenceManifestSha256,
    paths: {
      evidenceManifest: "evidence/manifest.json",
      evidenceDocuments: "evidence/documents",
      currentContract: "artifacts/current-contract.md",
      changeRegister: "artifacts/change-register.json",
      changePlan: "artifacts/change-plan.json",
      candidateDocx: "candidate.docx",
      renderedPdf: candidate.render ? "qa/candidate.pdf" : null,
      package: "package",
      untrustedFindings: "untrusted-findings.json",
    },
  });
  const prompt = `${(await loadPrompt("synthesis.md")).trim()}

Synthesis task: synthesis-task.json
Untrusted findings: untrusted-findings.json`;
  const result = await runGigacode({
    config: executorConfig(config),
    model: config.models.synthesizer,
    prompt,
    cwd: roundDirectory,
    session: `synthesis:${round}`,
    onEvent: onGigacodeEvent,
    transcriptDirectory: transcriptDirectory(config, runDirectory),
  });
  if (!result.ok) {
    throw new Error(`Арбитр завершился с ошибкой: ${result.stderr || result.output}`);
  }
  assertRequestedModel(result, config.models.synthesizer);
  await verifyEvidenceWorkspace(
    path.join(roundDirectory, "evidence"),
    evidenceManifestSha256,
  );
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
    cp(path.join(currentDirectory, "evidence"), path.join(nextDirectory, "evidence"), {
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
  const agentStatusStore = createAgentStatusStore(runDirectory);
  const gigacodeEvents = createGigacodeEventRecorder(
    runDirectory,
    agentStatusStore,
  );
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
    const formationRequest = await readJson(
      path.join(inputDirectory, "formation-request.json"),
    );
    const evidenceWorkspace = await materializeEvidenceWorkspace({
      roundDirectory: firstRoundDirectory,
      formationRequest,
      sourceRequestSha256: verifiedCase.manifest.formationRequest.sha256,
    });
    const evidenceManifestSha256 = evidenceWorkspace.manifestSha256;
    await extractDocx(
      path.join(inputDirectory, "new-edition.docx"),
      path.join(firstRoundDirectory, "package"),
    );
    const referenceInventory = await packageInventory(path.join(firstRoundDirectory, "package"));
    await atomicWriteJson(path.join(runDirectory, "reference-inventory.json"), referenceInventory);
    const sharedProducerTask = {
      caseId: verifiedCase.manifest.caseId,
      policy: formationPolicy(),
      evidenceManifestSha256,
    };
    await atomicWriteJson(path.join(firstRoundDirectory, "reconstruction-task.json"), {
      schemaVersion: "contractility.producer-reconstruction-task.v1",
      ...sharedProducerTask,
      paths: {
        evidenceManifest: "evidence/manifest.json",
        evidenceDocuments: "evidence/documents",
        currentContract: "artifacts/current-contract.md",
        blocker: "artifacts/blocker.json",
      },
    });
    state = await writeState(runDirectory, {
      ...state,
      status: "reconstructing-contract",
      round: 1,
    });
    const reconstruction = await runProducerStage({
      stage: "reconstruct",
      expectedStatus: "reconstruction-ready",
      promptName: "producer-reconstruct.md",
      taskName: "reconstruction-task.json",
      roundDirectory: firstRoundDirectory,
      config,
      runDirectory,
      onGigacodeEvent: gigacodeEvents.record,
      validateArtifacts: async () => {
        await verifyImmutableRunInputs(runDirectory, verifiedCase.manifest);
        await verifyEvidenceWorkspace(
          path.join(firstRoundDirectory, "evidence"),
          evidenceManifestSha256,
        );
        return requireCurrentContract(firstRoundDirectory);
      },
    });
    if (reconstruction.blocked) {
      state = await writeState(runDirectory, {
        ...state,
        status: "blocked",
        blocker: reconstruction.blocked,
      });
      return { runId, runDirectory, state };
    }

    await atomicWriteJson(path.join(firstRoundDirectory, "change-plan-task.json"), {
      schemaVersion: "contractility.producer-change-plan-task.v1",
      ...sharedProducerTask,
      paths: {
        evidenceManifest: "evidence/manifest.json",
        evidenceDocuments: "evidence/documents",
        currentContract: "artifacts/current-contract.md",
        package: "package",
        changeRegister: "artifacts/change-register.json",
        changePlan: "artifacts/change-plan.json",
        blocker: "artifacts/blocker.json",
      },
    });
    state = await writeState(runDirectory, {
      ...state,
      status: "planning-changes",
      round: 1,
    });
    const planning = await runProducerStage({
      stage: "plan",
      expectedStatus: "change-plan-ready",
      promptName: "producer-plan.md",
      taskName: "change-plan-task.json",
      roundDirectory: firstRoundDirectory,
      config,
      runDirectory,
      onGigacodeEvent: gigacodeEvents.record,
      validateArtifacts: async () => {
        await verifyImmutableRunInputs(runDirectory, verifiedCase.manifest);
        await verifyEvidenceWorkspace(
          path.join(firstRoundDirectory, "evidence"),
          evidenceManifestSha256,
        );
        return requireChangeArtifacts(firstRoundDirectory);
      },
    });
    if (planning.blocked) {
      state = await writeState(runDirectory, {
        ...state,
        status: "blocked",
        blocker: planning.blocked,
      });
      return { runId, runDirectory, state };
    }

    await atomicWriteJson(path.join(firstRoundDirectory, "application-task.json"), {
      schemaVersion: "contractility.producer-application-task.v1",
      ...sharedProducerTask,
      paths: {
        currentContract: "artifacts/current-contract.md",
        changeRegister: "artifacts/change-register.json",
        changePlan: "artifacts/change-plan.json",
        package: "package",
        blocker: "artifacts/blocker.json",
      },
    });
    state = await writeState(runDirectory, {
      ...state,
      status: "applying-changes",
      round: 1,
    });
    const application = await runProducerStage({
      stage: "apply",
      expectedStatus: "candidate-ready",
      promptName: "producer-apply.md",
      taskName: "application-task.json",
      roundDirectory: firstRoundDirectory,
      config,
      runDirectory,
      onGigacodeEvent: gigacodeEvents.record,
      validateArtifacts: async () => {
        await verifyImmutableRunInputs(runDirectory, verifiedCase.manifest);
        await verifyEvidenceWorkspace(
          path.join(firstRoundDirectory, "evidence"),
          evidenceManifestSha256,
        );
        await requireProducerArtifacts(firstRoundDirectory);
        return validateCandidate(firstRoundDirectory, referenceInventory, config);
      },
    });
    if (application.blocked) {
      state = await writeState(runDirectory, {
        ...state,
        status: "blocked",
        blocker: application.blocked,
      });
      return { runId, runDirectory, state };
    }
    let candidate = application.artifacts;
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
      const reviewDirectory = path.join(roundDirectory, "reviews");
      await ensurePrivateDirectory(reviewDirectory);
      const reviewResults = await mapPool(
        config.models.reviewers,
        config.review.maxParallel,
        async (reviewer) => {
          try {
            const report = await runReviewer({
              reviewer,
              round,
              roundDirectory,
              candidate,
              config,
              runDirectory,
              evidenceManifestSha256,
              onGigacodeEvent: gigacodeEvents.record,
            });
            await atomicWriteJson(
              path.join(reviewDirectory, `${report.reviewer.id}.json`),
              report,
            );
            return { ok: true, reviewer, report };
          } catch (error) {
            return {
              ok: false,
              reviewer,
              error: error.message ?? String(error),
            };
          }
        },
      );
      const requiredFailures = reviewResults.filter(
        (result) => !result.ok && result.reviewer.required !== false,
      );
      if (requiredFailures.length > 0) {
        throw new Error(
          `Обязательные reviewer завершились с ошибкой:\n${requiredFailures
            .map((result) => `${result.reviewer.id}: ${result.error}`)
            .join("\n")}`,
        );
      }
      const reports = reviewResults
        .filter((result) => result.ok)
        .map((result) => result.report);
      await verifyImmutableRunInputs(runDirectory, verifiedCase.manifest);
      await verifyEvidenceWorkspace(
        path.join(roundDirectory, "evidence"),
        evidenceManifestSha256,
      );
      const afterReviewInventory = await packageInventory(path.join(roundDirectory, "package"));
      const afterReviewFingerprint = await workspaceFingerprint(roundDirectory, afterReviewInventory);
      if (afterReviewFingerprint !== beforeReviewFingerprint) {
        throw new Error("Read-only reviewer изменил кандидат или обязательные артефакты.");
      }
      const findingsSha256 = findingFingerprint(reports);
      const consensus = await runSynthesis({
        round,
        roundDirectory,
        reports,
        candidate,
        config,
        runDirectory,
        evidenceManifestSha256,
        onGigacodeEvent: gigacodeEvents.record,
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
    try {
      await gigacodeEvents.flush();
      await agentStatusStore.flush();
    } finally {
      await releaseLock();
    }
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
