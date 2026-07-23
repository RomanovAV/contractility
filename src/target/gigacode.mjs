import { spawn } from "node:child_process";
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

async function runOnce({
  config,
  model,
  prompt,
  cwd,
  session,
  onEvent = () => {},
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
    onEvent("activity", { session, source: "stdout" });
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
    onEvent("activity", { session, source: "stderr" });
  });

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    activeChildren.delete(child);
    clearTimeout(sessionTimer);
    clearTimeout(idleTimer);
  });

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
  return response;
}

export async function runGigacode(options) {
  const retries = options.config.retryCount ?? 1;
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    last = await runOnce(options);
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
