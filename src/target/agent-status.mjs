import path from "node:path";
import { atomicWriteJson, sha256Text } from "./fs-utils.mjs";

function sessionIdentity(session) {
  const parts = String(session).split(":");
  if (parts[0] === "review" && parts.length >= 3) {
    return {
      role: "reviewer",
      round: Number(parts[1]),
      reviewerId: parts.slice(2).join(":"),
    };
  }
  if (parts[0] === "review-format" && parts.length >= 4) {
    return {
      role: "reviewer-format",
      round: Number(parts[1]),
      reviewerId: parts.slice(2, -1).join(":"),
    };
  }
  if (parts[0] === "synthesis") {
    return { role: "synthesizer", round: Number(parts[1]), reviewerId: null };
  }
  if (parts[0] === "synthesis-format") {
    return {
      role: "synthesizer-format",
      round: Number(parts[1]),
      reviewerId: null,
    };
  }
  if (session === "producer-reconstruct") {
    return { role: "producer-reconstruct", round: 1, reviewerId: null };
  }
  if (session === "producer-plan") {
    return { role: "producer-plan", round: 1, reviewerId: null };
  }
  const artifactRetry = session.match(
    /^producer-(reconstruct|plan)-artifact-retry$/,
  );
  if (artifactRetry) {
    return {
      role: `producer-${artifactRetry[1]}-retry`,
      round: 1,
      reviewerId: null,
    };
  }
  if (session === "producer-apply") {
    return { role: "producer-apply", round: 1, reviewerId: null };
  }
  const unresolvedRetry = session.match(
    /^producer-(reconstruct|plan|apply)-unresolved-retry$/,
  );
  if (unresolvedRetry) {
    return {
      role: `producer-${unresolvedRetry[1]}`,
      round: 1,
      reviewerId: null,
    };
  }
  const statusRetry = session.match(
    /^producer-(reconstruct|plan|apply)-status-retry$/,
  );
  if (statusRetry) {
    return {
      role: `producer-${statusRetry[1]}`,
      round: 1,
      reviewerId: null,
    };
  }
  return { role: "gigacode", round: null, reviewerId: null };
}

function statusForEvent(event, fields) {
  if (event === "prepared") return "starting";
  if (event === "started" || event === "activity") return "running";
  if (event === "retrying") return "retrying";
  if (event === "recovered") return "completed";
  if (event === "finished") return fields.ok ? "completed" : "failed";
  return "running";
}

function statusFileName(session) {
  const readable = String(session)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return `${readable || "gigacode"}-${sha256Text(session).slice(0, 10)}.json`;
}

export function createAgentStatusStore(runDirectory) {
  const states = new Map();
  const lastPersistedAt = new Map();
  let pending = Promise.resolve();

  function record(event, fields = {}) {
    const session = String(fields.session ?? "");
    if (!session) return;
    const now = new Date().toISOString();
    const previous = states.get(session);
    const identity = previous ?? sessionIdentity(session);
    const next = {
      schemaVersion: "contractility.agent-status.v1",
      session,
      role: identity.role,
      round: identity.round,
      reviewerId: identity.reviewerId,
      model: fields.model ?? previous?.model ?? null,
      status: statusForEvent(event, fields),
      phase: event,
      attempt: Number.isInteger(fields.retryAttempt)
        ? fields.retryAttempt
        : previous?.attempt ?? null,
      executionAttempt: Number.isInteger(fields.attempt)
        ? fields.attempt
        : previous?.executionAttempt ?? null,
      modelFallbackUsed: typeof fields.modelFallbackUsed === "boolean"
        ? fields.modelFallbackUsed
        : previous?.modelFallbackUsed ?? false,
      startedAt: event === "started"
        ? now
        : previous?.startedAt ?? null,
      lastActivityAt: ["started", "activity"].includes(event)
        ? now
        : previous?.lastActivityAt ?? null,
      finishedAt: ["finished", "recovered"].includes(event) ? now : null,
      durationMs: Number.isFinite(fields.durationMs)
        ? fields.durationMs
        : previous?.durationMs ?? null,
      outputChars: Number.isFinite(fields.outputChars)
        ? fields.outputChars
        : previous?.outputChars ?? null,
      ok: typeof fields.ok === "boolean" ? fields.ok : previous?.ok ?? null,
      errorKind: event === "finished" && !fields.ok
        ? fields.errorKind ?? "execution-failed"
        : null,
      updatedAt: now,
    };
    states.set(session, next);
    const nowMs = Date.now();
    if (
      event === "activity"
      && nowMs - (lastPersistedAt.get(session) ?? 0) < 1000
    ) {
      return;
    }
    lastPersistedAt.set(session, nowMs);
    const filePath = path.join(
      runDirectory,
      "agent-status",
      statusFileName(session),
    );
    pending = pending.then(() => atomicWriteJson(filePath, next));
  }

  return {
    record,
    async flush() {
      await pending;
    },
  };
}
