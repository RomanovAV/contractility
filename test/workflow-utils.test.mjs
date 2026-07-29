import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFormationRequest,
  createFormationTextExport,
  createReviewerMetadataLines,
  createSemanticSignedDocuments,
  formationLaunchAvailability,
  mergeDocumentBatch,
  moveHistoricalDocument,
  normalizeDocumentOrder,
  normalizeReviewerReports,
  validateDraftAgreementFile,
} from "../public/workflow-utils.mjs";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function completeOcrResult() {
  return {
    schemaVersion: "contractility.ocr.v2",
    createdAt: "2026-07-23T12:00:00.000Z",
    complete: true,
    documents: [
      {
        id: "contract",
        role: "contract",
        label: "Исходный договор",
        order: 1,
        file: { name: "Договор.pdf", sha256: "contract-hash" },
        pages: [{ number: 1, text: "Исходная редакция договора" }],
      },
      {
        id: "amendment-1",
        role: "additional-agreement",
        label: "Подписанное доп. соглашение 1",
        order: 2,
        file: { name: "ДС-1.pdf", sha256: "amendment-hash" },
        pages: [{ number: 1, text: "Пункт 2 изложить в новой редакции" }],
      },
    ],
  };
}

test("validateDraftAgreementFile accepts one non-empty DOCX", () => {
  assert.equal(validateDraftAgreementFile({
    name: "Новая редакция.docx",
    type: DOCX_MIME,
    size: 1024,
  }), "");
  assert.equal(validateDraftAgreementFile({
    name: "Новая редакция.docx",
    type: "application/octet-stream",
    size: 1024,
  }), "");
});

test("validateDraftAgreementFile rejects PDF and empty files", () => {
  assert.match(validateDraftAgreementFile({
    name: "Новая редакция.pdf",
    type: "application/pdf",
    size: 1024,
  }), /DOCX/);
  assert.match(validateDraftAgreementFile({
    name: "Новая редакция.docx",
    type: DOCX_MIME,
    size: 0,
  }), /пуст/);
});

test("formation launch stays actionable when target configuration needs a refresh", () => {
  assert.deepEqual(formationLaunchAvailability({
    ocrComplete: true,
    draftReady: true,
    targetReady: false,
    targetChecking: false,
    formationBusy: false,
    formationJobActive: false,
  }), {
    enabled: true,
    refreshTargetBeforeLaunch: true,
    reason: "Нажмите, чтобы повторно проверить конфигурацию GigaCode.",
  });
  assert.equal(formationLaunchAvailability({
    ocrComplete: false,
    draftReady: true,
    targetReady: true,
    targetChecking: false,
    formationBusy: false,
    formationJobActive: false,
  }).enabled, false);
  assert.equal(formationLaunchAvailability({
    ocrComplete: true,
    draftReady: false,
    targetReady: true,
    targetChecking: false,
    formationBusy: false,
    formationJobActive: false,
  }).enabled, false);
  assert.equal(formationLaunchAvailability({
    ocrComplete: true,
    draftReady: true,
    targetReady: true,
    targetChecking: false,
    formationBusy: false,
    formationJobActive: true,
  }).enabled, false);
});

test("normalizeReviewerReports ignores incomplete and unrelated JSON artifacts", () => {
  const valid = {
    reviewer: { id: "legal-a", requestedModel: "review-model" },
    verdict: "pass",
    findings: [],
  };
  assert.deepEqual(normalizeReviewerReports([
    { status: "completed" },
    { reviewer: null, verdict: "pass", findings: [] },
    { reviewer: { id: "legal-b" }, verdict: "unknown", findings: [] },
    valid,
  ]), [valid]);
});

test("createReviewerMetadataLines keeps reviewer details on separate rows", () => {
  assert.deepEqual(createReviewerMetadataLines({
    model: "review-model-a",
    attempt: 2,
    activity: "15:42:08",
  }), [
    { kind: "model", text: "Модель: review-model-a" },
    { kind: "attempt", text: "Попытка: 2" },
    { kind: "activity", text: "Активность: 15:42:08" },
  ]);
});

test("normalizeDocumentOrder keeps the contract first and relabels amendments", () => {
  const normalized = normalizeDocumentOrder([
    { id: "base", file: { name: "base.pdf" } },
    { id: "second", file: { name: "later.pdf" } },
  ]);
  assert.equal(normalized[0].id, "base");
  assert.equal(normalized[0].role, "contract");
  assert.equal(normalized[0].label, "Исходный договор");
  assert.equal(normalized[1].role, "additional-agreement");
  assert.equal(normalized[1].label, "Подписанное доп. соглашение 1");
});

test("mergeDocumentBatch returns the normalized state objects as pending load targets", () => {
  const existing = normalizeDocumentOrder([{ id: "base", pdf: { numPages: 1 } }]);
  const pending = [{ id: "second", pdf: null }];
  const batch = mergeDocumentBatch(existing, pending);

  assert.equal(batch.documents.length, 2);
  assert.equal(batch.addedDocuments.length, 1);
  assert.equal(batch.addedDocuments[0], batch.documents[1]);
  assert.notEqual(batch.addedDocuments[0], pending[0]);

  batch.addedDocuments[0].pdf = { numPages: 3 };
  assert.equal(batch.documents[1].pdf.numPages, 3);
});

test("moveHistoricalDocument reorders only signed amendments", () => {
  const documents = normalizeDocumentOrder([
    { id: "base" },
    { id: "first" },
    { id: "second" },
  ]);
  assert.equal(moveHistoricalDocument(documents, 1, -1), documents);
  const reordered = moveHistoricalDocument(documents, 2, -1);
  assert.deepEqual(reordered.map((document) => document.id), ["base", "second", "first"]);
  assert.equal(reordered[1].label, "Подписанное доп. соглашение 1");
});

test("buildFormationRequest records the four-stage legal workflow and DOCX identity", () => {
  const request = buildFormationRequest({
    ocrResult: completeOcrResult(),
    draftAgreement: {
      name: "Новая редакция.docx",
      size: 2048,
      lastModified: "2026-06-19T00:00:00.000Z",
      sha256: "draft-hash",
    },
    createdAt: "2026-07-23T13:00:00.000Z",
  });
  assert.equal(request.schemaVersion, "contractility.formation-request.v1");
  assert.deepEqual(request.workflow.map((step) => step.action), [
    "reconstruct-current-contract",
    "apply-signed-amendments",
    "extract-proposed-changes",
    "generate-final-agreement",
  ]);
  assert.equal(request.inputs.newAgreementEdition.file.sha256, "draft-hash");
  assert.equal(request.rules.amendmentOrder, "strict-input-order");
  assert.equal(request.rules.doNotTreatDraftAsSigned, true);
  assert.equal(request.rules.proposedAgreementRole, "declared-change-intent-and-output-template");
  assert.equal(request.rules.requireStructuralSimilarityToCurrentContract, false);
  assert.equal(
    request.rules.placeholderPolicy,
    "resolve-from-supplied-content-or-preserve-empty-template-field",
  );
  assert.equal(request.rules.allowUnresolvedTemplateFields, true);
  assert.equal(request.rules.requireHumanApprovalBeforeFinalization, true);
});

test("createSemanticSignedDocuments keeps continuous page text and removes OCR layout details", () => {
  const documents = createSemanticSignedDocuments([{
    id: "contract",
    role: "contract",
    label: "Исходный договор",
    order: 1,
    file: { name: "Договор.pdf", sha256: "contract-hash" },
    complete: true,
    pages: [{
      number: 1,
      source: "tesseract",
      text: "1. Предмет договора\nпродолжается на следующей строке.",
      confidence: 91.5,
      manuallyEdited: true,
      lines: [{
        text: "1. Предмет договора",
        bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.03 },
      }],
      renderedWidth: 1800,
      renderedHeight: 2600,
    }],
  }]);

  assert.deepEqual(documents, [{
    id: "contract",
    role: "contract",
    label: "Исходный договор",
    order: 1,
    file: { name: "Договор.pdf", sha256: "contract-hash" },
    pageCount: 1,
    complete: true,
    textFormat: "plain-text-by-page",
    pages: [{
      number: 1,
      text: "1. Предмет договора\nпродолжается на следующей строке.",
      source: "tesseract",
      confidence: 91.5,
      manuallyEdited: true,
    }],
  }]);
});

test("buildFormationRequest excludes line coordinates from the saved model input", () => {
  const ocrResult = completeOcrResult();
  ocrResult.documents[0].pages[0].lines = [{
    text: "Исходная редакция договора",
    bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.03 },
  }];

  const request = buildFormationRequest({
    ocrResult,
    draftAgreement: {
      name: "Новая редакция.docx",
      size: 2048,
      sha256: "draft-hash",
    },
  });

  assert.equal(request.inputs.signedDocuments[0].textFormat, "plain-text-by-page");
  assert.equal(
    request.inputs.signedDocuments[0].pages[0].text,
    "Исходная редакция договора",
  );
  assert.equal("lines" in request.inputs.signedDocuments[0].pages[0], false);
  assert.equal(JSON.stringify(request).includes('"bbox"'), false);
});

test("buildFormationRequest rejects incomplete OCR and missing DOCX", () => {
  const incomplete = completeOcrResult();
  incomplete.complete = false;
  assert.throws(() => buildFormationRequest({
    ocrResult: incomplete,
    draftAgreement: { name: "draft.docx", sha256: "hash" },
  }), /полностью распознанный/);
  assert.throws(() => buildFormationRequest({
    ocrResult: completeOcrResult(),
    draftAgreement: null,
  }), /предлагаемое дополнительное соглашение/);
});

test("createFormationTextExport keeps workflow, hashes and source boundaries", () => {
  const request = buildFormationRequest({
    ocrResult: completeOcrResult(),
    draftAgreement: {
      name: "Новая редакция.docx",
      size: 2048,
      lastModified: "2026-06-19T00:00:00.000Z",
      sha256: "draft-hash",
    },
  });
  const output = createFormationTextExport(request);
  assert.match(output, /Последовательно применить все подписанные/);
  assert.match(output, /SHA-256 DOCX: draft-hash/);
  assert.match(output, /######## Исходный договор · Договор\.pdf ########/);
  assert.match(output, /Пункт 2 изложить в новой редакции/);
});
