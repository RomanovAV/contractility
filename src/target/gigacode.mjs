import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const APPROVAL_UNAVAILABLE =
  "requires user approval but cannot execute in non-interactive mode";
const TRANSIENT_PATTERNS = [
  "FYA_TRANSIENT_TIMEOUT",
  "API Error: 529",
  "API Error: 502",
  "API Error: 503",
  "API Error: 504",
  "502 Bad Gateway",
  "503 Service Unavailable",
  "504 Gateway Timeout",
  "429 Too Many Requests",
  "Rate limit exceeded",
];
const MAX_CAPTURE_CHARS = 2_000_000;
const MAX_TRANSCRIPT_BYTES = 2_000_000;
const activeChildren = new Set();

function allowedEnvironment(extraNames = []) {
  const names = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
    "LANG", "LC_ALL", "SystemRoot", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
    ...extraNames,
  ]);
  return Object.fromEntries(
    [...names]
      .filter((name) => process.env[name] != null)
      .map((name) => [name, process.env[name]]),
  );
}

function extractAssistantText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function decodeStreamJson(text) {
  const assistant = [];
  const plain = [];
  const models = new Set();
  let finalResult = null;
  let sessionId = "";
  let usage = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      plain.push(rawLine);
      continue;
    }
    sessionId = event.session_id ?? sessionId;
    for (const model of [
      event.model,
      event.message?.model,
      event.model_name,
      event.model_id,
    ]) {
      if (typeof model === "string" && model) models.add(model);
    }
    if (event.type === "assistant") {
      const content = extractAssistantText(event.message?.content ?? event.content);
      if (content) assistant.push(content);
    }
    if (event.type === "result") {
      if (typeof event.result === "string") finalResult = event.result;
      usage = event.usage ?? usage;
    }
  }
  const output = finalResult ?? assistant.join("") ?? plain.join("\n");
  return {
    output: output || plain.join("\n"),
    sessionId,
    models: [...models],
    usage,
  };
}

function terminateProcess(child, reason) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  const escalation = setTimeout(() => {
    if (child.exitCode != null || child.signalCode != null) return;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
  }, 2000);
  escalation.unref();
  return reason;
}

function safeTranscriptName(value) {
  const normalized = String(value ?? "gigacode")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return normalized || "gigacode";
}

async function createTranscriptWriters(directory, session, attempt) {
  if (!directory) return null;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const base = `${safeTranscriptName(session)}.attempt-${attempt}`;
  const stdoutPath = path.join(directory, `${base}.stdout.ndjson`);
  const stderrPath = path.join(directory, `${base}.stderr.log`);
  const summaryPath = path.join(directory, `${base}.summary.json`);
  const stdout = createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
  const stderr = createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
  const stdoutDone = new Promise((resolve, reject) => {
    stdout.once("finish", resolve);
    stdout.once("error", reject);
  });
  const stderrDone = new Promise((resolve, reject) => {
    stderr.once("finish", resolve);
    stderr.once("error", reject);
  });
  return {
    base,
    stdout,
    stderr,
    stdoutDone,
    stderrDone,
    stdoutPath,
    stderrPath,
    summaryPath,
    stdoutBytes: 0,
    stderrBytes: 0,
    limited: false,
  };
}

function writeTranscriptChunk(transcript, streamName, chunk) {
  if (!transcript) return;
  const byteField = streamName === "stdout" ? "stdoutBytes" : "stderrBytes";
  const stream = transcript[streamName];
  const remaining = MAX_TRANSCRIPT_BYTES - transcript[byteField];
  if (remaining <= 0) {
    transcript.limited = true;
    return;
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const retained = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
  stream.write(retained);
  transcript[byteField] += retained.length;
  if (retained.length < buffer.length) transcript.limited = true;
}

async function writeTranscriptSummary(transcript, value) {
  if (!transcript) return;
  await writeFile(transcript.summaryPath, `${JSON.stringify({
    schemaVersion: "contractility.gigacode-transcript.v1",
    ...value,
    stdoutFile: path.basename(transcript.stdoutPath),
    stderrFile: path.basename(transcript.stderrPath),
  }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function runOnce({
  config,
  model,
  prompt,
  cwd,
  session,
  onEvent = () => {},
  transcriptDirectory = null,
  attempt = 1,
}) {
  const args = [
    ...(config.commandArgs ?? []),
    "--model",
    model,
    "--approval-mode=auto-edit",
    "--allowed-tools",
    "run_shell_command",
    "--output-format",
    "stream-json",
    "-p",
    prompt,
  ];
  onEvent("prepared", {
    session,
    model,
    command: config.command,
    promptChars: prompt.length,
  });
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const transcript = await createTranscriptWriters(
    transcriptDirectory,
    session,
    attempt,
  );
  const child = spawn(config.command, args, {
    cwd,
    env: allowedEnvironment(config.passEnvironment),
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  onEvent("started", { session, model, pid: child.pid });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let idleTimedOut = false;
  let outputLimited = false;
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      terminateProcess(child, "idle-timeout");
    }, Math.max(1, config.idleTimeoutSeconds) * 1000);
    idleTimer.unref();
  };
  resetIdle();
  const sessionTimer = setTimeout(() => {
    timedOut = true;
    terminateProcess(child, "session-timeout");
  }, Math.max(1, config.sessionTimeoutSeconds) * 1000);
  sessionTimer.unref();

  const append = (target, chunk) => {
    resetIdle();
    const next = target + chunk.toString("utf8");
    if (next.length > MAX_CAPTURE_CHARS) {
      outputLimited = true;
      terminateProcess(child, "output-limit");
      return next.slice(0, MAX_CAPTURE_CHARS);
    }
    return next;
  };
  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk);
    writeTranscriptChunk(transcript, "stdout", chunk);
    onEvent("activity", { session, model, source: "stdout" });
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
    writeTranscriptChunk(transcript, "stderr", chunk);
    onEvent("activity", { session, model, source: "stderr" });
  });

  let result;
  let executionError = null;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    executionError = error;
  } finally {
    activeChildren.delete(child);
    clearTimeout(sessionTimer);
    clearTimeout(idleTimer);
    if (transcript) {
      transcript.stdout.end();
      transcript.stderr.end();
      await Promise.all([transcript.stdoutDone, transcript.stderrDone]);
    }
  }
  if (executionError) {
    await writeTranscriptSummary(transcript, {
      session,
      model,
      attempt,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: executionError.message ?? String(executionError),
      transcriptLimited: transcript?.limited ?? false,
      durationMs: Date.now() - started,
    });
    throw executionError;
  }

  const decoded = decodeStreamJson(stdout);
  const combined = `${decoded.output}\n${stderr}`;
  const approvalUnavailable = combined.includes(APPROVAL_UNAVAILABLE);
  const transient = TRANSIENT_PATTERNS.some((pattern) =>
    combined.toLowerCase().includes(pattern.toLowerCase()));
  const response = {
    ok: result.code === 0
      && !timedOut
      && !idleTimedOut
      && !outputLimited
      && !approvalUnavailable,
    returnCode: result.code,
    signal: result.signal,
    timedOut,
    idleTimedOut,
    outputLimited,
    approvalUnavailable,
    transient,
    output: decoded.output.trim(),
    stderr: stderr.trim(),
    sessionId: decoded.sessionId,
    reportedModels: decoded.models,
    usage: decoded.usage,
    durationMs: Date.now() - started,
  };
  onEvent("finished", {
    session,
    model,
    ok: response.ok,
    returnCode: response.returnCode,
    durationMs: response.durationMs,
    outputChars: response.output.length,
  });
  await writeTranscriptSummary(transcript, {
      session,
      model,
      attempt,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: response.ok,
      returnCode: response.returnCode,
      signal: response.signal,
      timedOut: response.timedOut,
      idleTimedOut: response.idleTimedOut,
      outputLimited: response.outputLimited,
      transcriptLimited: transcript?.limited ?? false,
      durationMs: response.durationMs,
      outputChars: response.output.length,
    });
  return response;
}

export async function runGigacode(options) {
  const retries = options.config.retryCount ?? 1;
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    last = await runOnce({ ...options, attempt: attempt + 1 });
    last.attempt = attempt + 1;
    if (last.ok || last.approvalUnavailable || !last.transient || attempt === retries) {
      return last;
    }
    await delay((options.config.retryDelaySeconds ?? 5) * 1000);
  }
  return last;
}

export function assertRequestedModel(result, requestedModel) {
  if (result.reportedModels.length === 0) {
    throw new Error(
      `GigaCode не сообщил фактически использованную модель для запроса ${requestedModel}.`,
    );
  }
  if (!result.reportedModels.includes(requestedModel)) {
    throw new Error(
      `GigaCode запрошен с моделью ${requestedModel}, но сообщил: ${result.reportedModels.join(", ")}.`,
    );
  }
}

export function terminateActiveGigacode(reason = "interrupted") {
  for (const child of activeChildren) terminateProcess(child, reason);
}

export { decodeStreamJson };
