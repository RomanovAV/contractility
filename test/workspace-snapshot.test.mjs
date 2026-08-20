import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  base64ToBytes,
  bytesToBase64,
  createWorkspaceSnapshot,
  parseWorkspaceSnapshot,
  SNAPSHOT_SCHEMA,
} from "../public/workspace-snapshot.mjs";

function sha256(bytes) {
  const value = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return createHash("sha256").update(value).digest("hex");
}

function fileLike(name, type, values, lastModified = 1_723_456_789_000) {
  const bytes = Uint8Array.from(values);
  return {
    name,
    type,
    size: bytes.byteLength,
    lastModified,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function ocrResult(pdfFile, pdfSha256) {
  return {
    schemaVersion: "contractility.ocr.v2",
    createdAt: "2026-08-20T10:00:00.000Z",
    startedAt: "2026-08-20T09:59:00.000Z",
    documentCount: 1,
    documents: [{
      id: "document-1",
      role: "contract",
      label: "Исходный договор",
      order: 1,
      file: {
        name: pdfFile.name,
        size: pdfFile.size,
        lastModified: new Date(pdfFile.lastModified).toISOString(),
        sha256: pdfSha256,
      },
      pageCount: 1,
      pageRotationOverrides: { 1: 90 },
      complete: true,
      pages: [{
        number: 1,
        source: "tesseract",
        text: "Исправленный текст договора",
        manuallyEdited: true,
        confidence: 91,
        lines: [],
      }],
    }],
    engine: {},
    settings: { dpi: 220, forceOcr: false, rotationMode: "auto" },
    complete: true,
  };
}

test("workspace snapshot round-trips OCR edits and embedded source files", async () => {
  const pdf = fileLike("contract.pdf", "application/pdf", [37, 80, 68, 70, 1, 2, 3]);
  const draft = fileLike(
    "draft.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    [80, 75, 3, 4, 5, 6],
  );
  const pdfSha256 = sha256(await pdf.arrayBuffer());
  const draftSha256 = sha256(await draft.arrayBuffer());
  const result = ocrResult(pdf, pdfSha256);

  const snapshot = await createWorkspaceSnapshot({
    ocrResult: result,
    documents: [{ id: "document-1", file: pdf, fileHash: pdfSha256 }],
    draftAgreement: { file: draft, sha256: draftSha256 },
    createdAt: "2026-08-20T10:01:00.000Z",
  });
  result.documents[0].pages[0].text = "Изменение после сохранения";

  assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA);
  assert.notEqual(snapshot.ocrResult, result);
  const restored = parseWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.ocrResult.documents[0].pages[0].text, "Исправленный текст договора");
  assert.equal(restored.ocrResult.documents[0].pages[0].manuallyEdited, true);
  assert.deepEqual(restored.signedDocuments[0].bytes, new Uint8Array(await pdf.arrayBuffer()));
  assert.deepEqual(restored.draftAgreement.bytes, new Uint8Array(await draft.arrayBuffer()));
  assert.equal(restored.signedDocuments[0].file.sha256, pdfSha256);
  assert.equal(restored.draftAgreement.file.sha256, draftSha256);
});

test("workspace snapshot validates base64 and OCR-to-file metadata", async () => {
  const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.throws(() => base64ToBytes("***="), /base64/);

  const pdf = fileLike("contract.pdf", "application/pdf", [37, 80, 68, 70]);
  const pdfSha256 = sha256(await pdf.arrayBuffer());
  const snapshot = await createWorkspaceSnapshot({
    ocrResult: ocrResult(pdf, pdfSha256),
    documents: [{ id: "document-1", file: pdf, fileHash: pdfSha256 }],
  });

  const wrongSize = JSON.parse(JSON.stringify(snapshot));
  wrongSize.signedDocuments[0].file.size += 1;
  assert.throws(() => parseWorkspaceSnapshot(wrongSize), /размер вложенного файла/);

  const wrongHash = JSON.parse(JSON.stringify(snapshot));
  wrongHash.ocrResult.documents[0].file.sha256 = "f".repeat(64);
  assert.throws(() => parseWorkspaceSnapshot(wrongHash), /SHA-256/);

  const duplicatePage = JSON.parse(JSON.stringify(snapshot));
  duplicatePage.ocrResult.documents[0].pageCount = 2;
  duplicatePage.ocrResult.documents[0].pages.push({
    ...duplicatePage.ocrResult.documents[0].pages[0],
  });
  assert.throws(() => parseWorkspaceSnapshot(duplicatePage), /Страницы документа/);
});
