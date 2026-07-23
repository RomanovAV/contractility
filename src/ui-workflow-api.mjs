import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCase, validateFormationRequest } from "./target/case-store.mjs";
import { loadTargetConfig } from "./target/config.mjs";
import {
  atomicWriteJson,
  ensurePrivateDirectory,
  readJson,
} from "./target/fs-utils.mjs";
import {
  approveRun,
  createAndRun,
  finalizeRun,
  verifyRun,
} from "./target/runner.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_LIMIT = 128 * 1024 * 1024;
const FILE_LIMIT = 1024 * 1024 * 1024;
const SAFE_ID = /^(?:stage|case|run|job)-[a-zA-Z0-9-]+$/;
const SAFE_DOCUMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function apiHeaders(securityHeaders, extra = {}) {
  return {
    ...securityHeaders,
    "Cache-Control": "no-store",
    ...extra,
  };
}

function sendJson(response, securityHeaders, statusCode, value) {
  response.writeHead(statusCode, apiHeaders(securityHeaders, {
    "Content-Type": "application/json; charset=utf-8",
  }));
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request, limit = JSON_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "JSON-запрос слишком большой.");
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError(400, "Пустой JSON-запрос.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Некорректный JSON.");
  }
}

function requireSafeId(value, label) {
  if (!SAFE_ID.test(value ?? "")) {
    throw new HttpError(400, `Некорректный ${label}.`);
  }
  return value;
}

function requireDocumentId(value) {
  if (!SAFE_DOCUMENT_ID.test(value ?? "")) {
    throw new HttpError(400, "Некорректный идентификатор документа.");
  }
  return value;
}

function safeJoin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new HttpError(400, "Недопустимый путь.");
  }
  return resolved;
}

function allowedHost(host) {
  return /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host ?? "");
}

function requireLocalHost(request) {
  if (!allowedHost(request.headers.host)) {
    throw new HttpError(403, "Недопустимый Host.");
  }
}

function requireMutationOrigin(request) {
  const expected = `http://${request.headers.host}`;
  if (request.headers.origin !== expected) {
    throw new HttpError(403, "Запрос отклонён проверкой Origin.");
  }
}

function requireToken(request, token) {
  if (request.headers["x-contractility-token"] !== token) {
    throw new HttpError(403, "Недействительный токен локальной сессии.");
  }
}

async function receiveFile(request, destination, expectedSha256, limit = FILE_LIMIT) {
  const declaredSize = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredSize) && (declaredSize <= 0 || declaredSize > limit)) {
    throw new HttpError(413, "Файл пуст или превышает допустимый размер.");
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporaryPath = `${destination}.${randomBytes(8).toString("hex")}.part`;
  const handle = await open(temporaryPath, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  let failure = null;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, "Файл превышает допустимый размер.");
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    await handle.close();
  }
  if (failure) {
    await unlink(temporaryPath).catch(() => {});
    throw failure;
  }
  if (size === 0) {
    await unlink(temporaryPath).catch(() => {});
    throw new HttpError(400, "Получен пустой файл.");
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== expectedSha256) {
    await unlink(temporaryPath).catch(() => {});
    throw new HttpError(409, "SHA-256 загруженного файла не совпадает с OCR-запросом.");
  }
  await rename(temporaryPath, destination);
  return { size, sha256 };
}

async function exists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function stateLabel(status) {
  const labels = {
    created: "Создание запуска",
    "inputs-verified": "Входы проверены",
    "candidate-created": "Кандидат сформирован",
    reviewing: "Параллельное ревью",
    fixing: "Исправление замечаний",
    "awaiting-human-approval": "Ожидается проверка человеком",
    approved: "Кандидат подтверждён",
    finalized: "Финальный DOCX готов",
    blocked: "Требуется ручное решение",
    failed: "Техническая ошибка",
  };
  return labels[status] ?? status;
}

async function readCurrentRound(runDirectory, state) {
  if (!Number.isInteger(state.round) || state.round < 1) {
    return { reviews: [], consensus: null };
  }
  const roundDirectory = safeJoin(
    runDirectory,
    `rounds/${String(state.round).padStart(2, "0")}`,
  );
  const reviewDirectory = path.join(roundDirectory, "reviews");
  const reviews = [];
  try {
    for (const name of (await readdir(reviewDirectory)).sort()) {
      if (!name.endsWith(".json")) continue;
      const report = await readJson(path.join(reviewDirectory, name));
      reviews.push({
        reviewer: report.reviewer,
        verdict: report.verdict,
        findings: report.findings,
      });
    }
  } catch {
    // Reviews appear atomically near the end of a round; an empty list is a
    // normal transient state while the parallel agents are still running.
  }
  let consensus = null;
  try {
    consensus = await readJson(path.join(roundDirectory, "consensus.json"));
  } catch {
    // The arbiter has not completed this round yet.
  }
  return { reviews, consensus };
}

async function readLastGigacodeStatus(runDirectory) {
  const eventPath = path.join(runDirectory, "events.ndjson");
  let content;
  try {
    const info = await stat(eventPath);
    const length = Math.min(info.size, 128 * 1024);
    const handle = await open(eventPath, "r");
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, length, Math.max(0, info.size - length)));
    } finally {
      await handle.close();
    }
    content = buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  }
  const lines = content.split("\n").filter(Boolean).reverse();
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!String(event.event ?? "").startsWith("gigacode.")) continue;
    return {
      at: event.at ?? null,
      phase: event.event.slice("gigacode.".length),
      session: event.session ?? null,
      model: event.model ?? null,
      source: event.source ?? null,
      ok: typeof event.ok === "boolean" ? event.ok : null,
      durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
      outputChars: Number.isFinite(event.outputChars) ? event.outputChars : null,
    };
  }
  return null;
}

async function readRunSummary(runDirectory) {
  const state = await readJson(path.join(runDirectory, "state.json"));
  const round = await readCurrentRound(runDirectory, state);
  return {
    state,
    stateLabel: stateLabel(state.status),
    ...round,
    gigacodeStatus: await readLastGigacodeStatus(runDirectory),
  };
}

function safeDownloadName(name) {
  return String(name).replace(/[\r\n"\\/]/g, "_").slice(0, 160);
}

async function sendFile(response, securityHeaders, filePath, contentType, downloadName) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new HttpError(404, "Файл результата не найден.");
  response.writeHead(200, apiHeaders(securityHeaders, {
    "Content-Disposition": `attachment; filename="${safeDownloadName(downloadName)}"`,
    "Content-Length": info.size,
    "Content-Type": contentType,
  }));
  const handle = await open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      if (!response.write(chunk)) {
        await new Promise((resolve) => response.once("drain", resolve));
      }
    }
    response.end();
  } finally {
    await handle.close().catch(() => {});
  }
}

export function createUiWorkflowApi({
  securityHeaders,
  dataRoot = path.join(projectRoot, "data"),
  targetConfigPath = process.env.CONTRACTILITY_TARGET_CONFIG
    ? path.resolve(process.env.CONTRACTILITY_TARGET_CONFIG)
    : path.join(projectRoot, "config/target.json"),
  runTarget = createAndRun,
} = {}) {
  const sessionToken = randomBytes(32).toString("hex");
  const stagingRoot = path.join(dataRoot, "ui-staging");
  const caseRoot = path.join(dataRoot, "cases");
  const jobs = new Map();

  async function targetStatus() {
    try {
      const config = await loadTargetConfig(targetConfigPath);
      return {
        ready: true,
        models: {
          producer: config.models.producer,
          synthesizer: config.models.synthesizer,
          reviewers: config.models.reviewers.map(({ id, model, focus }) => ({ id, model, focus })),
        },
        retainAgentTranscripts: config.storage.retainAgentTranscripts,
      };
    } catch (error) {
      return { ready: false, error: error.message };
    }
  }

  async function stagingManifest(stageId) {
    return readJson(path.join(safeJoin(stagingRoot, stageId), "staging-manifest.json"));
  }

  async function updateStagingManifest(stageId, update) {
    const stageDirectory = safeJoin(stagingRoot, stageId);
    const manifest = await stagingManifest(stageId);
    const next = { ...manifest, ...update, updatedAt: new Date().toISOString() };
    await atomicWriteJson(path.join(stageDirectory, "staging-manifest.json"), next);
    return next;
  }

  async function requireRunDirectory(runId) {
    requireSafeId(runId, "runId");
    const config = await loadTargetConfig(targetConfigPath);
    const runDirectory = safeJoin(config.storage.runRoot, runId);
    if (!(await exists(path.join(runDirectory, "state.json")))) {
      throw new HttpError(404, "Запуск не найден.");
    }
    return { config, runDirectory };
  }

  async function handleSession(request, response) {
    if (request.method !== "GET") throw new HttpError(405, "Метод не поддерживается.");
    sendJson(response, securityHeaders, 200, {
      schemaVersion: "contractility.ui-session.v1",
      token: sessionToken,
      target: await targetStatus(),
    });
  }

  async function createStaging(request, response) {
    const body = await readJsonBody(request);
    const formationRequest = validateFormationRequest(body.formationRequest);
    const stageId = `stage-${randomBytes(12).toString("hex")}`;
    const stageDirectory = safeJoin(stagingRoot, stageId);
    await ensurePrivateDirectory(path.join(stageDirectory, "signed"));
    await atomicWriteJson(path.join(stageDirectory, "formation-request.json"), formationRequest);
    const manifest = {
      schemaVersion: "contractility.ui-staging.v1",
      stageId,
      createdAt: new Date().toISOString(),
      signedDocuments: formationRequest.inputs.signedDocuments.map((document) => ({
        id: document.id,
        name: document.file.name,
        sha256: document.file.sha256,
        uploaded: false,
      })),
      draft: {
        name: formationRequest.inputs.newAgreementEdition.file.name,
        sha256: formationRequest.inputs.newAgreementEdition.file.sha256,
        uploaded: false,
      },
    };
    await atomicWriteJson(path.join(stageDirectory, "staging-manifest.json"), manifest);
    sendJson(response, securityHeaders, 201, { stageId, manifest });
  }

  async function uploadSigned(request, response, stageId, documentId) {
    requireDocumentId(documentId);
    const manifest = await stagingManifest(stageId);
    const expected = manifest.signedDocuments.find((document) => document.id === documentId);
    if (!expected) throw new HttpError(404, "Документ не входит в formation request.");
    const stageDirectory = safeJoin(stagingRoot, stageId);
    const result = await receiveFile(
      request,
      path.join(stageDirectory, "signed", `${documentId}.pdf`),
      expected.sha256,
    );
    await updateStagingManifest(stageId, {
      signedDocuments: manifest.signedDocuments.map((document) => (
        document.id === documentId ? { ...document, uploaded: true, size: result.size } : document
      )),
    });
    sendJson(response, securityHeaders, 200, { ok: true, documentId, ...result });
  }

  async function uploadDraft(request, response, stageId) {
    const manifest = await stagingManifest(stageId);
    const stageDirectory = safeJoin(stagingRoot, stageId);
    const result = await receiveFile(
      request,
      path.join(stageDirectory, "new-edition.docx"),
      manifest.draft.sha256,
    );
    await updateStagingManifest(stageId, {
      draft: { ...manifest.draft, uploaded: true, size: result.size },
    });
    sendJson(response, securityHeaders, 200, { ok: true, ...result });
  }

  async function prepareStaging(response, stageId) {
    const stageDirectory = safeJoin(stagingRoot, stageId);
    const manifest = await stagingManifest(stageId);
    if (
      manifest.signedDocuments.some((document) => !document.uploaded)
      || !manifest.draft.uploaded
    ) {
      throw new HttpError(409, "Не все исходные файлы загружены.");
    }
    const sources = Object.fromEntries(manifest.signedDocuments.map((document) => [
      document.id,
      path.join(stageDirectory, "signed", `${document.id}.pdf`),
    ]));
    const prepared = await prepareCase({
      requestPath: path.join(stageDirectory, "formation-request.json"),
      draftPath: path.join(stageDirectory, "new-edition.docx"),
      sources,
      outputRoot: caseRoot,
    });
    await rm(stageDirectory, { recursive: true, force: true });
    sendJson(response, securityHeaders, 201, {
      caseId: prepared.caseId,
      documentCount: prepared.manifest.signedDocuments.length,
    });
  }

  function trimJobs() {
    if (jobs.size <= 100) return;
    for (const [id, job] of jobs) {
      if (job.status !== "running") jobs.delete(id);
      if (jobs.size <= 80) break;
    }
  }

  async function startRun(response, caseId) {
    requireSafeId(caseId, "caseId");
    if ([...jobs.values()].some((job) => job.status === "running")) {
      throw new HttpError(409, "Уже выполняется другой запуск из UI.");
    }
    const config = await loadTargetConfig(targetConfigPath);
    const caseDirectory = safeJoin(caseRoot, caseId);
    if (!(await exists(path.join(caseDirectory, "case-manifest.json")))) {
      throw new HttpError(404, "Case не найден.");
    }
    const jobId = `job-${randomBytes(10).toString("hex")}`;
    const job = {
      jobId,
      caseId,
      status: "running",
      createdAt: new Date().toISOString(),
      runId: null,
      runDirectory: null,
      error: null,
    };
    jobs.set(jobId, job);
    trimJobs();
    Promise.resolve().then(() => runTarget({
      caseDirectory,
      config,
      onRunCreated({ runId, runDirectory }) {
        Object.assign(job, { runId, runDirectory });
      },
    })).then((result) => {
      Object.assign(job, {
        status: "completed",
        completedAt: new Date().toISOString(),
        runId: result.runId,
        runDirectory: result.runDirectory,
      });
    }).catch((error) => {
      Object.assign(job, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error.message ?? String(error),
        runId: error.runId ?? job.runId,
        runDirectory: error.runDirectory ?? job.runDirectory,
      });
    });
    sendJson(response, securityHeaders, 202, { jobId, caseId, status: job.status });
  }

  async function sendJob(response, jobId) {
    requireSafeId(jobId, "jobId");
    const job = jobs.get(jobId);
    if (!job) throw new HttpError(404, "Задание не найдено в текущей сессии сервера.");
    sendJson(response, securityHeaders, 200, {
      jobId: job.jobId,
      caseId: job.caseId,
      status: job.status,
      error: job.error,
      runId: job.runId,
      run: job.runDirectory && await exists(path.join(job.runDirectory, "state.json"))
        ? await readRunSummary(job.runDirectory)
        : null,
    });
  }

  async function sendRun(response, runId) {
    const { runDirectory } = await requireRunDirectory(runId);
    sendJson(response, securityHeaders, 200, await readRunSummary(runDirectory));
  }

  async function approve(response, runId, request) {
    const { runDirectory } = await requireRunDirectory(runId);
    const body = await readJsonBody(request, 64 * 1024);
    const approver = String(body.approver ?? "").trim();
    if (!approver) throw new HttpError(400, "Укажите ФИО проверяющего.");
    const result = await approveRun({
      runDirectory,
      approver,
      candidateSha256: String(body.candidateSha256 ?? ""),
      findingsSha256: String(body.findingsSha256 ?? ""),
    });
    sendJson(response, securityHeaders, 200, result);
  }

  async function finalize(response, runId) {
    const { runDirectory } = await requireRunDirectory(runId);
    const result = await finalizeRun(runDirectory);
    await verifyRun(runDirectory);
    sendJson(response, securityHeaders, 200, result);
  }

  async function download(response, runId, kind) {
    const { runDirectory } = await requireRunDirectory(runId);
    const state = await readJson(path.join(runDirectory, "state.json"));
    if (kind === "candidate") {
      if (!state.candidatePath) throw new HttpError(409, "Кандидат ещё не готов.");
      await sendFile(
        response,
        securityHeaders,
        safeJoin(runDirectory, state.candidatePath),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "candidate-additional-agreement.docx",
      );
      return;
    }
    if (kind === "preview") {
      if (!Number.isInteger(state.round) || state.round < 1) {
        throw new HttpError(409, "PDF-превью ещё не готово.");
      }
      await sendFile(
        response,
        securityHeaders,
        safeJoin(runDirectory, `rounds/${String(state.round).padStart(2, "0")}/qa/candidate.pdf`),
        "application/pdf",
        "candidate-additional-agreement.pdf",
      );
      return;
    }
    if (kind === "final") {
      if (state.status !== "finalized" || !state.finalPath) {
        throw new HttpError(409, "Финальный DOCX ещё не готов.");
      }
      await sendFile(
        response,
        securityHeaders,
        safeJoin(runDirectory, state.finalPath),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "final-additional-agreement.docx",
      );
      return;
    }
    throw new HttpError(404, "Неизвестный файл результата.");
  }

  async function handle(request, response, url) {
    if (!url.pathname.startsWith("/api/workflow/")) return false;
    try {
      requireLocalHost(request);
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length === 3 && segments[2] === "session") {
        await handleSession(request, response);
        return true;
      }
      requireToken(request, sessionToken);
      if (!["GET", "HEAD"].includes(request.method)) requireMutationOrigin(request);

      if (segments.length === 3 && segments[2] === "staging" && request.method === "POST") {
        await createStaging(request, response);
        return true;
      }
      if (segments[2] === "staging" && segments.length >= 5) {
        const stageId = requireSafeId(segments[3], "stageId");
        if (
          segments.length === 6
          && segments[4] === "signed"
          && request.method === "PUT"
        ) {
          await uploadSigned(request, response, stageId, segments[5]);
          return true;
        }
        if (segments.length === 5 && segments[4] === "draft" && request.method === "PUT") {
          await uploadDraft(request, response, stageId);
          return true;
        }
        if (segments.length === 5 && segments[4] === "prepare" && request.method === "POST") {
          await prepareStaging(response, stageId);
          return true;
        }
      }
      if (
        segments.length === 4
        && segments[2] === "staging"
        && request.method === "DELETE"
      ) {
        const stageId = requireSafeId(segments[3], "stageId");
        await rm(safeJoin(stagingRoot, stageId), { recursive: true, force: true });
        sendJson(response, securityHeaders, 200, { ok: true });
        return true;
      }
      if (
        segments.length === 5
        && segments[2] === "cases"
        && segments[4] === "runs"
        && request.method === "POST"
      ) {
        await startRun(response, segments[3]);
        return true;
      }
      if (segments.length === 4 && segments[2] === "jobs" && request.method === "GET") {
        await sendJob(response, segments[3]);
        return true;
      }
      if (segments[2] === "runs" && segments.length >= 4) {
        const runId = segments[3];
        if (segments.length === 4 && request.method === "GET") {
          await sendRun(response, runId);
          return true;
        }
        if (segments.length === 5 && segments[4] === "approve" && request.method === "POST") {
          await approve(response, runId, request);
          return true;
        }
        if (segments.length === 5 && segments[4] === "finalize" && request.method === "POST") {
          await finalize(response, runId);
          return true;
        }
        if (
          segments.length === 6
          && segments[4] === "files"
          && request.method === "GET"
        ) {
          await download(response, runId, segments[5]);
          return true;
        }
      }
      throw new HttpError(404, "API-маршрут не найден.");
    } catch (error) {
      sendJson(response, securityHeaders, error.statusCode ?? 500, {
        error: error.message ?? String(error),
      });
      return true;
    }
  }

  return { handle };
}
