import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocumentLabel,
  createTextExport,
  createOcrRenderPlan,
  flattenOcrLines,
  isUsefulPdfText,
  normalizeWhitespace,
  readPdfTextLayer,
  resolveAdditionalPageRotation,
} from "../public/ocr-utils.mjs";

test("createDocumentLabel assigns the first PDF to the contract", () => {
  assert.equal(createDocumentLabel(0), "Договор");
  assert.equal(createDocumentLabel(1), "Доп. соглашение 1");
  assert.equal(createDocumentLabel(4), "Доп. соглашение 4");
  assert.throws(() => createDocumentLabel(-1), /non-negative integer/);
});

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

test("resolveAdditionalPageRotation normalizes landscape pages in auto mode", () => {
  assert.equal(resolveAdditionalPageRotation({ width: 1400, height: 900 }, "auto"), 90);
  assert.equal(resolveAdditionalPageRotation({ width: 900, height: 1400 }, "auto"), 0);
});

test("resolveAdditionalPageRotation honors explicit quarter turns", () => {
  assert.equal(resolveAdditionalPageRotation({ width: 900, height: 1400 }, "90"), 90);
  assert.equal(resolveAdditionalPageRotation({ width: 900, height: 1400 }, "180"), 180);
  assert.equal(resolveAdditionalPageRotation({ width: 900, height: 1400 }, "270"), 270);
  assert.equal(resolveAdditionalPageRotation({ width: 900, height: 1400 }, "invalid"), 0);
});

test("createOcrRenderPlan preserves requested DPI for ordinary A4 pages", () => {
  assert.deepEqual(createOcrRenderPlan({ width: 595, height: 842 }, 220), {
    scale: 220 / 72,
    width: 1819,
    height: 2573,
    requestedDpi: 220,
    effectiveDpi: 220,
    limited: false,
  });
});

test("createOcrRenderPlan caps oversized iOS PDF pages", () => {
  const plan = createOcrRenderPlan({ width: 2215.38, height: 3451.65 }, 220);
  assert.equal(plan.limited, true);
  assert.equal(plan.height, 4096);
  assert.ok(plan.width < 4096);
  assert.ok(plan.width * plan.height <= 12_000_000);
  assert.ok(plan.effectiveDpi >= 80);
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

test("createTextExport keeps document roles and boundaries", () => {
  const output = createTextExport({ documents: [
    {
      label: "Договор",
      file: { name: "Договор.pdf" },
      pages: [{ number: 1, text: "Основной текст" }],
    },
    {
      label: "Доп. соглашение 1",
      file: { name: "ДС-1.pdf" },
      pages: [{ number: 1, text: "Изменения" }],
    },
  ] });
  assert.match(output, /######## Договор · Договор\.pdf ########/);
  assert.match(output, /Основной текст/);
  assert.match(output, /######## Доп\. соглашение 1 · ДС-1\.pdf ########/);
  assert.match(output, /Изменения/);
});
