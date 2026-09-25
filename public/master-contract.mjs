import { validateOcrCorrections } from "./ocr-corrections.mjs";

export const MASTER_SCHEMA = "contractility.master-contract.v1";

export async function masterPayloadHash(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function masterReviewTargetHash(payload) {
  return masterPayloadHash({
    currentContract: payload.currentContract,
    reconstructionScope: payload.reconstructionScope,
    signedDocuments: payload.signedDocuments,
    ocrCorrections: payload.ocrCorrections,
  });
}

export async function masterFindingsHash(reports) {
  const ids = reports
    .flatMap((report) => report.findings.map((finding) => finding.id))
    .sort();
  const bytes = new TextEncoder().encode(ids.join("\n"));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateMasterReview(review) {
  if (review?.schemaVersion !== "contractility.master-review.v1"
    || !Number.isFinite(Date.parse(review.reviewedAt))
    || !/^[a-f0-9]{64}$/.test(review.targetSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(review.evidenceManifestSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(review.findingsSha256 ?? "")
    || !Array.isArray(review.reports)
    || review.reports.length < 3) {
    throw new TypeError("Мастер-договор не прошёл обязательную межмодельную проверку.");
  }
  for (const report of review.reports) {
    if (report?.schemaVersion !== "contractility.review-report.v1"
      || !Number.isInteger(report.round)
      || report.round < 1
      || report.reviewTarget !== "master-contract"
      || report.candidateSha256 !== review.targetSha256
      || typeof report.reviewer?.id !== "string"
      || !report.reviewer.id
      || !["pass", "changes-required"].includes(report.verdict)
      || !Array.isArray(report.findings)
      || report.findings.some((finding) => typeof finding?.id !== "string" || !finding.id)) {
      throw new TypeError("Отчёты проверки мастер-договора повреждены.");
    }
  }
  const consolidatedFields = [
    review.round,
    review.consensus,
    review.actionItems,
    review.actionItemCount,
    review.omittedActionItemCount,
    review.history,
  ];
  if (consolidatedFields.every((value) => value == null)) return;
  if (!Number.isInteger(review.round) || review.round < 1
    || review.consensus?.schemaVersion !== "contractility.master-consensus.v1"
    || review.consensus.round !== review.round
    || review.consensus.targetSha256 !== review.targetSha256
    || !Array.isArray(review.actionItems)
    || !Number.isInteger(review.actionItemCount)
    || review.actionItemCount < review.actionItems.length
    || !Number.isInteger(review.omittedActionItemCount)
    || review.omittedActionItemCount !== review.actionItemCount - review.actionItems.length
    || !Array.isArray(review.history)
    || review.history.length !== review.round) {
    throw new TypeError("Итог межмодельной проверки мастер-договора повреждён.");
  }
  if (review.blockingActionItemCount != null
    && (!Number.isInteger(review.blockingActionItemCount)
      || !Number.isInteger(review.advisoryActionItemCount)
      || review.blockingActionItemCount < 0
      || review.advisoryActionItemCount < 0
      || review.blockingActionItemCount + review.advisoryActionItemCount !== review.actionItemCount)) {
    throw new TypeError("Классификация замечаний мастер-договора повреждена.");
  }
}

export function validateMasterStructure(master, { requireApproval = true } = {}) {
  if (master?.schemaVersion !== MASTER_SCHEMA
    || typeof master.payload?.currentContract !== "string"
    || master.payload.currentContract.trim().length < 100
    || master.payload.reconstructionScope?.schemaVersion !== "contractility.reconstruction-scope.v1"
    || !Array.isArray(master.payload.signedDocuments)
    || !master.payload.signedDocuments.length
    || !/^[a-f0-9]{64}$/.test(master.sha256 ?? "")) {
    throw new TypeError("Некорректный файл мастер-договора.");
  }
  validateMasterReview(master.payload.review);
  const { signedDocuments, reconstructionScope } = master.payload;
  const ids = new Set();
  for (const [index, document] of signedDocuments.entries()) {
    if (!document || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(document.id ?? "")
      || ids.has(document.id) || document.order !== index + 1
      || document.role !== (index === 0 ? "contract" : "additional-agreement")
      || document.complete !== true || typeof document.file?.name !== "string" || !document.file.name
      || !/^[a-f0-9]{64}$/i.test(document.file?.sha256 ?? "")
      || !Array.isArray(document.pages) || !document.pages.length
      || document.pages.some((page, index) => page?.number !== index + 1 || typeof page.text !== "string" || page.error)) {
      throw new TypeError("История источников мастер-договора повреждена.");
    }
    ids.add(document.id);
  }
  if (master.payload.ocrCorrections != null) {
    validateOcrCorrections(master.payload.ocrCorrections, signedDocuments);
  }
  const base = reconstructionScope.baseContract;
  if (base?.sourceDocumentId !== signedDocuments[0].id
    || ![base.number, base.date, base.evidence].every((value) => typeof value === "string" && value.trim())
    || !Number.isInteger(base.page) || base.page < 1 || base.page > signedDocuments[0].pages.length
    || !Array.isArray(reconstructionScope.instruments)
    || reconstructionScope.instruments.some((item) => !item || !ids.has(item.sourceDocumentId)
      || !["included", "excluded", "unresolved"].includes(item.decision)
      || !Array.isArray(item.pages) || !item.pages.length || item.pages.some((number) => !Number.isInteger(number) || number < 1)
      || ![item.agreementNumber, item.agreementDate, item.reason].every((value) => typeof value === "string" && value.trim()))) {
    throw new TypeError("История применения допсоглашений повреждена.");
  }
  if (requireApproval || master.approval != null) {
    if (typeof master.approval?.approver !== "string" || !master.approval.approver.trim()
      || !Number.isFinite(Date.parse(master.approval.approvedAt))
      || master.approval.sha256 !== master.sha256
      || ((master.payload.review?.blockingActionItemCount ?? 0) > 0
        && master.approval.acknowledgedFindings !== true)) {
      throw new TypeError("Мастер-договор должен быть проверен и подтверждён человеком.");
    }
  }
  return master;
}

export async function validateMasterContract(master, options) {
  validateMasterStructure(master, options);
  const actualReviewTargetSha256 = await masterReviewTargetHash(master.payload);
  if (actualReviewTargetSha256 !== master.payload.review.targetSha256) {
    const revisions = master.payload.humanRevisions;
    const latestRevision = Array.isArray(revisions) ? revisions.at(-1) : null;
    if (!latestRevision
      || revisions.some((revision, index) => revision?.schemaVersion !== "contractility.master-human-revision.v1"
        || !Number.isFinite(Date.parse(revision.revisedAt))
        || typeof revision.sourceFileName !== "string"
        || !revision.sourceFileName.trim()
        || !/^[a-f0-9]{64}$/.test(revision.previousTargetSha256 ?? "")
        || !/^[a-f0-9]{64}$/.test(revision.currentTargetSha256 ?? "")
        || !/^[a-f0-9]{64}$/.test(revision.previousMasterSha256 ?? "")
        || revision.previousTargetSha256 !== (index === 0
          ? master.payload.review.targetSha256
          : revisions[index - 1].currentTargetSha256))
      || latestRevision.currentTargetSha256 !== actualReviewTargetSha256) {
      throw new TypeError("Текст или источники мастер-договора изменены после межмодельной проверки.");
    }
  }
  if (await masterFindingsHash(master.payload.review.reports)
    !== master.payload.review.findingsSha256) {
    throw new TypeError("Реестр замечаний мастер-договора изменён после межмодельной проверки.");
  }
  if (await masterPayloadHash(master.payload) !== master.sha256) {
    throw new TypeError("Мастер-договор изменён после проверки: SHA-256 не совпадает.");
  }
  return master;
}

export async function createMasterContract(payload) {
  return {
    schemaVersion: MASTER_SCHEMA,
    createdAt: new Date().toISOString(),
    payload,
    sha256: await masterPayloadHash(payload),
    approval: null,
  };
}
