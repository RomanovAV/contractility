import assert from "node:assert/strict";
import test from "node:test";
import {
  createTextExport,
  flattenOcrLines,
  isUsefulPdfText,
  normalizeWhitespace,
  readPdfTextLayer,
} from "../public/ocr-utils.mjs";

test("normalizeWhitespace preserves paragraphs and removes noise", () => {
  assert.equal(normalizeWhitespace("  Первый   пункт \r\n\r\n\r\n Второй\tпункт  "), "Первый пункт\n\nВторой пункт");
});

test("isUsefulPdfText rejects short scan artifacts", () => {
  assert.equal(isUsefulPdfText("стр. 1"), false);
  assert.equal(isUsefulPdfText("Договор ".repeat(12)), true);
});

test("readPdfTextLayer returns normalized PDF text", async () => {
  const result = await readPdfTextLayer({
    async getTextContent() {
      return { items: [{ str: " Первый " }, { str: "пункт" }] };
    },
  });
  assert.deepEqual(result, { skipped: false, text: "Первый пункт", error: null });
});

test("readPdfTextLayer skips PDF.js when OCR is forced", async () => {
  let called = false;
  const result = await readPdfTextLayer({
    async getTextContent() {
      called = true;
      throw new Error("must not be called");
    },
  }, { skip: true });
  assert.equal(called, false);
  assert.deepEqual(result, { skipped: true, text: "", error: null });
});

test("readPdfTextLayer converts PDF.js failure into an OCR fallback", async () => {
  const failure = new TypeError("Safari getTextContent failure");
  const result = await readPdfTextLayer({
    async getTextContent() {
      throw failure;
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.text, "");
  assert.equal(result.error, failure);
});

test("flattenOcrLines returns normalized evidence coordinates", () => {
  const blocks = [{
    paragraphs: [{
      lines: [{
        text: " Пункт 1.1 ",
        confidence: 87.654,
        bbox: { x0: 100, y0: 200, x1: 500, y1: 260 },
      }],
    }],
  }];

  assert.deepEqual(flattenOcrLines(blocks, 1000, 2000), [{
    text: "Пункт 1.1",
    confidence: 87.65,
    bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.03 },
  }]);
});

test("flattenOcrLines does not depend on nested array iterators", () => {
  const lines = [{
    text: "Строка Safari",
    confidence: 90,
    bbox: { x0: 10, y0: 20, x1: 110, y1: 60 },
  }];
  const paragraphs = [{ lines }];
  const blocks = [{ paragraphs }];
  lines[Symbol.iterator] = undefined;
  paragraphs[Symbol.iterator] = undefined;
  blocks[Symbol.iterator] = undefined;

  assert.deepEqual(flattenOcrLines(blocks, 200, 100), [{
    text: "Строка Safari",
    confidence: 90,
    bbox: { x: 0.05, y: 0.2, width: 0.5, height: 0.4 },
  }]);
});

test("flattenOcrLines ignores malformed nested OCR collections", () => {
  assert.deepEqual(flattenOcrLines([{ paragraphs: {} }, null], 100, 100), []);
});

test("createTextExport keeps page boundaries", () => {
  const output = createTextExport({ pages: [
    { number: 1, text: "Первая" },
    { number: 2, text: "Вторая" },
  ] });
  assert.match(output, /===== Страница 1 =====\nПервая/);
  assert.match(output, /===== Страница 2 =====\nВторая/);
});
