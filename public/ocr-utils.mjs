export function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function flattenOcrLines(blocks, imageWidth, imageHeight) {
  if (!Array.isArray(blocks) || imageWidth <= 0 || imageHeight <= 0) {
    return [];
  }

  const lines = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = normalizeWhitespace(line.text);
        const bbox = line.bbox;
        if (!text || !bbox) {
          continue;
        }

        lines.push({
          text,
          confidence: Number.isFinite(line.confidence) ? Math.round(line.confidence * 100) / 100 : null,
          bbox: {
            x: clamp(bbox.x0 / imageWidth, 0, 1),
            y: clamp(bbox.y0 / imageHeight, 0, 1),
            width: clamp((bbox.x1 - bbox.x0) / imageWidth, 0, 1),
            height: clamp((bbox.y1 - bbox.y0) / imageHeight, 0, 1),
          },
        });
      }
    }
  }

  return lines;
}

export function isUsefulPdfText(text) {
  const meaningfulCharacters = normalizeWhitespace(text).replace(/\s/g, "");
  return meaningfulCharacters.length >= 80;
}

export function createTextExport(documentResult) {
  const sections = documentResult.pages.map((page) => [
    `===== Страница ${page.number} =====`,
    normalizeWhitespace(page.text),
  ].join("\n"));
  return `${sections.join("\n\n")}\n`;
}

export function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 Б";
  }
  const units = ["Б", "КБ", "МБ", "ГБ"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}
