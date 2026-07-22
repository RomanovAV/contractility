import assert from "node:assert/strict";
import test from "node:test";
import {
  createTextExport,
  flattenOcrLines,
  isUsefulPdfText,
  normalizeWhitespace,
} from "../public/ocr-utils.mjs";

test("normalizeWhitespace preserves paragraphs and removes noise", () => {
  assert.equal(normalizeWhitespace("  Первый   пункт \r\n\r\n\r\n Второй\tпункт  "), "Первый пункт\n\nВторой пункт");
});

test("isUsefulPdfText rejects short scan artifacts", () => {
  assert.equal(isUsefulPdfText("стр. 1"), false);
  assert.equal(isUsefulPdfText("Договор ".repeat(12)), true);
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

test("createTextExport keeps page boundaries", () => {
  const output = createTextExport({ pages: [
    { number: 1, text: "Первая" },
    { number: 2, text: "Вторая" },
  ] });
  assert.match(output, /===== Страница 1 =====\nПервая/);
  assert.match(output, /===== Страница 2 =====\nВторая/);
});
