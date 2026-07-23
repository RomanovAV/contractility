import { sha256Text } from "./fs-utils.mjs";

const SEVERITIES = new Set(["blocker", "major", "minor"]);
const CATEGORIES = new Set([
  "contract-reconstruction",
  "legal-delta",
  "cross-reference",
  "document-fidelity",
  "missing-evidence",
  "security",
  "ocr-quality",
  "requirements",
]);
const MAX_FINDINGS = 20;
const MAX_FIELD_CHARS = 6000;

function nonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Поле ${field} должно быть непустой строкой.`);
  }
  if (value.length > MAX_FIELD_CHARS) {
    throw new TypeError(`Поле ${field} слишком длинное.`);
  }
  return value.trim();
}

function parseExactJson(text, name) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || trimmed.startsWith("```") || trimmed.endsWith("```")) {
    throw new TypeError(`${name}: ожидается чистый JSON без Markdown.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new TypeError(`${name}: некорректный JSON: ${error.message}`);
  }
}

function normalizeFinding(value) {
  if (!SEVERITIES.has(value?.severity)) {
    throw new TypeError("finding.severity должен быть blocker, major или minor.");
  }
  if (!CATEGORIES.has(value?.category)) {
    throw new TypeError(`Недопустимая finding.category: ${value?.category}`);
  }
  const sourceDocumentId = nonEmptyString(value.sourceDocumentId, "sourceDocumentId");
  const page = Number(value.page);
  if (!Number.isInteger(page) || page < 1) {
    throw new TypeError("finding.page должен быть положительным целым числом.");
  }
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError("finding.confidence должен быть числом 0..1.");
  }
  const normalized = {
    severity: value.severity,
    category: value.category,
    target: nonEmptyString(value.target, "target"),
    sourceDocumentId,
    page,
    clause: nonEmptyString(value.clause, "clause"),
    evidence: nonEmptyString(value.evidence, "evidence"),
    observed: nonEmptyString(value.observed, "observed"),
    impact: nonEmptyString(value.impact, "impact"),
    proposedAction: nonEmptyString(value.proposedAction, "proposedAction"),
    confidence,
  };
  return {
    id: `finding-${sha256Text(JSON.stringify(normalized)).slice(0, 16)}`,
    ...normalized,
  };
}

export function parseReviewReport(text) {
  const value = parseExactJson(text, "review report");
  if (!["pass", "changes-required"].includes(value?.verdict)) {
    throw new TypeError("review.verdict должен быть pass или changes-required.");
  }
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) {
    throw new TypeError(`review.findings должен содержать не более ${MAX_FINDINGS} элементов.`);
  }
  const findings = value.findings.map(normalizeFinding);
  if (value.verdict === "pass" && findings.length > 0) {
    throw new TypeError("verdict=pass несовместим с непустыми findings.");
  }
  if (value.verdict === "changes-required" && findings.length === 0) {
    throw new TypeError("verdict=changes-required требует хотя бы одно замечание.");
  }
  return { verdict: value.verdict, findings };
}

export function parseSynthesisResult(text, knownFindingIds) {
  const value = parseExactJson(text, "review synthesis");
  if (!["done", "fixed", "blocked"].includes(value?.status)) {
    throw new TypeError("synthesis.status должен быть done, fixed или blocked.");
  }
  for (const field of ["acceptedFindingIds", "rejectedFindingIds", "unresolvedFindingIds"]) {
    if (!Array.isArray(value[field]) || value[field].some((id) => !knownFindingIds.has(id))) {
      throw new TypeError(`synthesis.${field} содержит неизвестные finding id.`);
    }
  }
  const all = [
    ...value.acceptedFindingIds,
    ...value.rejectedFindingIds,
    ...value.unresolvedFindingIds,
  ];
  if (new Set(all).size !== all.length) {
    throw new TypeError("Каждое замечание должно иметь ровно одно решение.");
  }
  if (new Set(all).size !== knownFindingIds.size) {
    throw new TypeError("Арбитр должен вынести решение по каждому замечанию.");
  }
  if (value.status === "done" && (
    value.acceptedFindingIds.length > 0 || value.unresolvedFindingIds.length > 0
  )) {
    throw new TypeError("status=done допустим только после отклонения всех замечаний.");
  }
  if (value.status === "fixed" && value.unresolvedFindingIds.length > 0) {
    throw new TypeError("status=fixed несовместим с нерешёнными замечаниями.");
  }
  return {
    status: value.status,
    acceptedFindingIds: [...value.acceptedFindingIds],
    rejectedFindingIds: [...value.rejectedFindingIds],
    unresolvedFindingIds: [...value.unresolvedFindingIds],
    summary: nonEmptyString(value.summary, "summary"),
  };
}

export function findingFingerprint(reports) {
  const ids = reports.flatMap((report) => report.findings.map((finding) => finding.id)).sort();
  return sha256Text(ids.join("\n"));
}

export function reviewOutputContract() {
  return `Return exactly one JSON object and no Markdown:
{"verdict":"pass","findings":[]}
or
{"verdict":"changes-required","findings":[{"severity":"blocker|major|minor","category":"contract-reconstruction|legal-delta|cross-reference|document-fidelity|missing-evidence|security|ocr-quality|requirements","target":"candidate locator","sourceDocumentId":"document id","page":1,"clause":"source clause","evidence":"short exact observed fragment","observed":"confirmed problem","impact":"legal or document consequence","proposedAction":"smallest correction","confidence":0.0}]}
Maximum 20 findings. Do not report style preferences or unsupported suspicions.`;
}

export function formatRetryPrompt(invalidOutput) {
  const escaped = String(invalidOutput)
    .slice(0, 40_000)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `Your previous response did not satisfy the structured review contract.
Reformat only concrete claims already present. Do not add findings.
If there are no valid concrete claims, return {"verdict":"pass","findings":[]}.

<UNTRUSTED_INVALID_OUTPUT>
${escaped}
</UNTRUSTED_INVALID_OUTPUT>

${reviewOutputContract()}`;
}

