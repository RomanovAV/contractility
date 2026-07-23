import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFormationRequest,
  createFormationTextExport,
  moveHistoricalDocument,
  normalizeDocumentOrder,
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
    "compare-new-edition",
    "generate-final-agreement",
  ]);
  assert.equal(request.inputs.newAgreementEdition.file.sha256, "draft-hash");
  assert.equal(request.rules.amendmentOrder, "strict-input-order");
  assert.equal(request.rules.doNotTreatDraftAsSigned, true);
  assert.equal(request.rules.requireHumanApprovalBeforeFinalization, true);
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
  }), /новая редакция/);
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
