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
  // OCR data crosses a Worker boundary and has an external nested shape. Guard
  // every collection and use indexed access so WebKit does not need iterator
  // methods while post-processing the worker response.
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const paragraphs = block && Array.isArray(block.paragraphs) ? block.paragraphs : [];
    for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
      const paragraph = paragraphs[paragraphIndex];
      const paragraphLines = paragraph && Array.isArray(paragraph.lines) ? paragraph.lines : [];
      for (let lineIndex = 0; lineIndex < paragraphLines.length; lineIndex += 1) {
        const line = paragraphLines[lineIndex];
        const text = normalizeWhitespace(line?.text);
        const bbox = line?.bbox;
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

export async function readPdfTextLayer(page, { skip = false } = {}) {
  if (skip) {
    return { skipped: true, text: "", error: null };
  }

  try {
    const textContent = await page.getTextContent();
    const items = Array.isArray(textContent?.items) ? textContent.items : [];
    const parts = [];
    for (let index = 0; index < items.length; index += 1) {
      parts.push(items[index]?.str ?? "");
    }
    return {
      skipped: false,
      text: normalizeWhitespace(parts.join(" ")),
      error: null,
    };
  } catch (error) {
    return { skipped: false, text: "", error };
  }
}

export function resolveAdditionalPageRotation(viewport, rotationMode = "auto") {
  if (rotationMode === "auto") {
    return viewport?.width > viewport?.height ? 90 : 0;
  }
  const requested = Number.parseInt(rotationMode, 10);
  if (![0, 90, 180, 270].includes(requested)) {
    return 0;
  }
  return requested;
}

export function createDocumentLabel(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError("Document index must be a non-negative integer");
  }
  return index === 0 ? "Договор" : `Доп. соглашение ${index}`;
}

export function createOcrRenderPlan(
  viewport,
  requestedDpi,
  { maxDimension = 4096, maxPixels = 12_000_000 } = {},
) {
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  const dpi = Number(requestedDpi);
  if (!(width > 0) || !(height > 0) || !(dpi > 0)) {
    throw new TypeError("Invalid OCR viewport or DPI");
  }

  const requestedScale = dpi / 72;
  const dimensionScale = maxDimension / Math.max(width, height);
  const pixelScale = Math.sqrt(maxPixels / (width * height));
  const scale = Math.min(requestedScale, dimensionScale, pixelScale);
  return {
    scale,
    width: Math.ceil(width * scale),
    height: Math.ceil(height * scale),
    requestedDpi: dpi,
    effectiveDpi: Math.round(scale * 72 * 10) / 10,
    limited: scale < requestedScale,
  };
}

export function createTextExport(documentResult) {
  const documents = Array.isArray(documentResult?.documents)
    ? documentResult.documents
    : [{
        label: "Договор",
        file: { name: documentResult?.document?.name ?? "" },
        pages: documentResult?.pages ?? [],
      }];
  const sections = documents.map((document) => {
    const heading = document.file?.name
      ? `######## ${document.label} · ${document.file.name} ########`
      : `######## ${document.label} ########`;
    const pages = (document.pages ?? []).map((page) => [
      `===== Страница ${page.number} =====`,
      normalizeWhitespace(page.text),
    ].join("\n"));
    return [heading, ...pages].join("\n\n");
  });
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
