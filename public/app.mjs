import { GlobalWorkerOptions, getDocument } from "./vendor/pdfjs/pdf.min.mjs";
import Tesseract from "./vendor/tesseract/tesseract.esm.min.js";
import {
  createTextExport,
  flattenOcrLines,
  humanFileSize,
  isUsefulPdfText,
  normalizeWhitespace,
} from "./ocr-utils.mjs";

const { createWorker } = Tesseract;

GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url,
).href;

const elements = Object.fromEntries(
  [
    "auto-rotate", "cancel-button", "confidence-badge", "download-json", "download-text",
    "dpi-select", "drop-zone", "edit-note", "error-banner", "export-card", "file-input",
    "file-meta", "file-name", "file-summary", "force-ocr", "next-page", "ocr-overlay",
    "overlay-toggle", "page-surface", "page-text", "pages-counter", "pages-list",
    "preflight-note", "previous-page", "progress-bar", "progress-card", "progress-detail", "progress-percent",
    "progress-title", "reset-button", "start-button", "viewer-canvas", "viewer-page-label",
    "viewer-position", "viewer-stage", "workspace",
  ].map((id) => [id, document.getElementById(id)]),
);

const state = {
  file: null,
  fileHash: null,
  pdf: null,
  results: [],
  worker: null,
  running: false,
  cancelRequested: false,
  selectedPage: 1,
  previewRequest: 0,
  startedAt: null,
};

const browserCapabilities = {
  webAssembly: typeof WebAssembly === "object",
  webWorker: typeof Worker === "function",
  sha256: Boolean(globalThis.crypto?.subtle),
  canvasToBlob: typeof HTMLCanvasElement.prototype.toBlob === "function",
  canvasToDataUrl: typeof HTMLCanvasElement.prototype.toDataURL === "function",
};
const browserEnvironment = {
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  vendor: navigator.vendor,
  isSafari: /Apple/i.test(navigator.vendor) && /Safari/i.test(navigator.userAgent),
};
const missingBrowserCapabilities = Object.entries(browserCapabilities)
  .filter(([name, available]) => !available && name !== "canvasToBlob")
  .map(([name]) => name);

if (missingBrowserCapabilities.length > 0) {
  elements["preflight-note"].classList.add("unsupported");
  elements["preflight-note"].textContent = `Браузер не поддерживает: ${missingBrowserCapabilities.join(", ")}`;
}

const statusLabels = {
  "loading tesseract core": "Загружается локальное OCR-ядро",
  "initializing tesseract": "Инициализируется OCR-ядро",
  "loading language traineddata": "Читаются локальные языковые модели",
  "initializing api": "Подготавливаются русский и английский языки",
  "recognizing text": "Распознаётся текст страницы",
};

function setError(message) {
  elements["error-banner"].textContent = message;
  elements["error-banner"].hidden = !message;
}

function setRunning(running) {
  state.running = running;
  elements["start-button"].disabled = running || !state.pdf;
  elements["cancel-button"].hidden = !running;
  elements["reset-button"].disabled = running;
  elements["file-input"].disabled = running;
  elements["dpi-select"].disabled = running;
  elements["force-ocr"].disabled = running;
  elements["auto-rotate"].disabled = running;
  if (running) {
    elements["cancel-button"].disabled = false;
    elements["cancel-button"].textContent = "Остановить после страницы";
  }
}

function updateProgress({ percent, title, detail }) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  elements["progress-card"].hidden = false;
  elements["progress-bar"].style.width = `${safePercent}%`;
  elements["progress-percent"].textContent = `${safePercent}%`;
  if (title) elements["progress-title"].textContent = title;
  if (detail) elements["progress-detail"].textContent = detail;
}

async function sha256(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clearResults() {
  state.results = [];
  state.selectedPage = 1;
  elements["pages-list"].replaceChildren();
  elements["page-text"].value = "";
  elements["page-text"].disabled = true;
  elements["workspace"].hidden = true;
  elements["export-card"].hidden = true;
  elements["progress-card"].hidden = true;
}

async function loadFile(file) {
  if (!file || (file.type && file.type !== "application/pdf") || !file.name.toLowerCase().endsWith(".pdf")) {
    setError("Выберите файл PDF.");
    return;
  }

  setError("");
  clearResults();
  elements["drop-zone"].hidden = true;
  elements["file-summary"].hidden = false;
  elements["reset-button"].hidden = false;
  elements["file-name"].textContent = file.name;
  elements["file-meta"].textContent = `${humanFileSize(file.size)} · вычисляется контрольная сумма…`;

  try {
    const buffer = await file.arrayBuffer();
    const hash = await sha256(buffer);
    const loadingTask = getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const pdf = await loadingTask.promise;

    state.file = file;
    state.fileHash = hash;
    state.pdf = pdf;
    elements["file-meta"].textContent = `${humanFileSize(file.size)} · ${pdf.numPages} стр. · SHA-256 ${hash.slice(0, 12)}…`;
    elements["start-button"].disabled = false;
    elements["workspace"].hidden = false;
    initializePageList(pdf.numPages);
    await selectPage(1);
  } catch (error) {
    console.error(error);
    state.file = null;
    state.pdf = null;
    elements["start-button"].disabled = true;
    setError(`Не удалось открыть PDF: ${error.message ?? error}`);
  }
}

function resetFile() {
  if (state.running) return;
  state.pdf?.destroy();
  state.file = null;
  state.fileHash = null;
  state.pdf = null;
  elements["file-input"].value = "";
  elements["file-summary"].hidden = true;
  elements["drop-zone"].hidden = false;
  elements["reset-button"].hidden = true;
  elements["start-button"].disabled = true;
  clearResults();
  setError("");
}

function initializePageList(pageCount) {
  elements["pages-list"].replaceChildren();
  for (let number = 1; number <= pageCount; number += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "page-item";
    button.dataset.page = String(number);
    button.innerHTML = `
      <span class="page-number">${number}</span>
      <span class="page-state"><strong>Ожидание</strong><span>Страница не обработана</span></span>
    `;
    button.addEventListener("click", () => selectPage(number));
    elements["pages-list"].append(button);
  }
  elements["pages-counter"].textContent = `0 / ${pageCount}`;
}

function pageState(result) {
  if (!result) return { title: "Ожидание", detail: "Страница не обработана", tone: "" };
  if (result.error) return { title: "Ошибка", detail: result.error, tone: "failed" };
  if (result.source === "pdf-text") return { title: "Текст PDF", detail: "OCR не потребовался", tone: "good" };
  if (!normalizeWhitespace(result.text)) return { title: "Пустая", detail: "Текст не найден", tone: "warning" };
  if (result.confidence >= 80) return { title: `${Math.round(result.confidence)}%`, detail: "Высокая уверенность", tone: "good" };
  if (result.confidence >= 55) return { title: `${Math.round(result.confidence)}%`, detail: "Нужна проверка", tone: "warning" };
  return { title: `${Math.round(result.confidence)}%`, detail: "Низкая уверенность", tone: "failed" };
}

function renderPageList() {
  const completed = state.results.filter(Boolean).length;
  elements["pages-counter"].textContent = `${completed} / ${state.pdf?.numPages ?? 0}`;
  for (const button of elements["pages-list"].querySelectorAll(".page-item")) {
    const pageNumber = Number(button.dataset.page);
    const pageResult = state.results[pageNumber - 1];
    const view = pageState(pageResult);
    button.classList.toggle("selected", pageNumber === state.selectedPage);
    const stateElement = button.querySelector(".page-state");
    const title = document.createElement("strong");
    title.className = view.tone;
    title.textContent = view.title;
    const detail = document.createElement("span");
    detail.textContent = view.detail;
    stateElement.replaceChildren(title, detail);
  }
}

async function renderPreview(pageNumber) {
  if (!state.pdf) return;
  const requestId = ++state.previewRequest;
  const page = await state.pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(280, elements["viewer-stage"].clientWidth - 44);
  const cssScale = Math.min(1.6, availableWidth / baseViewport.width);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: cssScale * pixelRatio });
  const canvas = elements["viewer-canvas"];
  const context = canvas.getContext("2d", { alpha: false });

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${Math.ceil(viewport.width / pixelRatio)}px`;
  canvas.style.height = `${Math.ceil(viewport.height / pixelRatio)}px`;
  elements["page-surface"].style.width = canvas.style.width;
  elements["page-surface"].style.height = canvas.style.height;

  await page.render({ canvasContext: context, viewport }).promise;
  if (requestId !== state.previewRequest) return;
  renderOverlay(state.results[pageNumber - 1]?.lines ?? []);
}

function renderOverlay(lines) {
  const overlay = elements["ocr-overlay"];
  overlay.replaceChildren();
  overlay.classList.toggle("hidden", !elements["overlay-toggle"].checked);
  for (const line of lines.slice(0, 800)) {
    const box = document.createElement("span");
    box.className = "ocr-box";
    box.style.left = `${line.bbox.x * 100}%`;
    box.style.top = `${line.bbox.y * 100}%`;
    box.style.width = `${line.bbox.width * 100}%`;
    box.style.height = `${line.bbox.height * 100}%`;
    box.title = line.text;
    overlay.append(box);
  }
}

function updateTextPanel() {
  const result = state.results[state.selectedPage - 1];
  elements["page-text"].value = result?.text ?? "";
  elements["page-text"].disabled = !result || Boolean(result.error);
  elements["edit-note"].hidden = !result?.manuallyEdited;
  const badge = elements["confidence-badge"];
  badge.className = "confidence-badge neutral";

  if (!result) {
    badge.textContent = "Ожидание";
  } else if (result.error) {
    badge.textContent = "Ошибка";
    badge.className = "confidence-badge bad";
  } else if (result.source === "pdf-text") {
    badge.textContent = "Текст PDF";
    badge.className = "confidence-badge good";
  } else {
    badge.textContent = `${Math.round(result.confidence)}% OCR`;
    badge.className = `confidence-badge ${result.confidence >= 80 ? "good" : result.confidence >= 55 ? "warning" : "bad"}`;
  }
}

async function selectPage(pageNumber) {
  if (!state.pdf || pageNumber < 1 || pageNumber > state.pdf.numPages) return;
  state.selectedPage = pageNumber;
  elements["viewer-page-label"].textContent = `Страница ${pageNumber}`;
  elements["viewer-position"].textContent = `${pageNumber} / ${state.pdf.numPages}`;
  elements["previous-page"].disabled = pageNumber === 1;
  elements["next-page"].disabled = pageNumber === state.pdf.numPages;
  renderPageList();
  updateTextPanel();
  await renderPreview(pageNumber);
}

async function renderOcrCanvas(page, dpi) {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

async function extractPdfText(page) {
  const textContent = await page.getTextContent();
  return normalizeWhitespace(textContent.items.map((item) => item.str ?? "").join(" "));
}

async function createOcrWorker(dpi) {
  let initializationTimedOut = false;
  let timeoutId;
  const workerPromise = createWorker(["rus", "eng"], 1, {
    workerPath: new URL("./vendor/tesseract/worker.min.js", import.meta.url).href,
    // Фиксированный базовый LSTM-core запускается медленнее SIMD-вариантов,
    // но одинаково работает в корпоративных браузерах с разным уровнем WASM.
    corePath: new URL(
      "./vendor/tesseract/core/tesseract-core-lstm.wasm.js",
      import.meta.url,
    ).href,
    langPath: new URL("./vendor/tessdata/", import.meta.url).href,
    workerBlobURL: false,
    cacheMethod: "none",
    gzip: true,
    logger(message) {
      const detail = statusLabels[message.status] ?? message.status;
      const completedPages = state.results.filter(Boolean).length;
      const totalPages = state.pdf?.numPages ?? 1;
      const currentProgress = message.status === "recognizing text" ? message.progress : 0;
      const percent = ((completedPages + currentProgress) / totalPages) * 100;
      updateProgress({ percent, title: "Подготовка и распознавание", detail });
    },
    errorHandler(error) {
      console.error("Tesseract worker:", error);
    },
  });
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      initializationTimedOut = true;
      reject(new Error(
        "OCR-ядро не запустилось за 60 секунд. Проверьте, что браузер разрешает WebAssembly и Web Workers.",
      ));
    }, 60_000);
  });

  let worker;
  try {
    worker = await Promise.race([workerPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    if (initializationTimedOut) {
      workerPromise.then((lateWorker) => lateWorker.terminate()).catch(console.error);
    }
  }
  await worker.setParameters({
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: "3",
    user_defined_dpi: String(dpi),
  });
  return worker;
}

async function recognizePage(pageNumber, settings) {
  const startedAt = performance.now();
  const page = await state.pdf.getPage(pageNumber);
  const pdfText = await extractPdfText(page);

  if (!settings.forceOcr && isUsefulPdfText(pdfText)) {
    return {
      number: pageNumber,
      source: "pdf-text",
      text: pdfText,
      confidence: 100,
      lines: [],
      durationMs: Math.round(performance.now() - startedAt),
      pdfRotation: page.rotate,
    };
  }

  const canvas = await renderOcrCanvas(page, settings.dpi);
  // Tesseract.js converts HTMLCanvasElement via canvas.toBlob(). Some Safari/WebKit
  // builds expose an incomplete implementation and fail before the image reaches
  // the OCR worker. A PNG data URL follows a separate, broadly supported path.
  const useDataUrlTransport = browserEnvironment.isSafari || !browserCapabilities.canvasToBlob;
  const ocrInput = useDataUrlTransport ? canvas.toDataURL("image/png") : canvas;
  const recognition = await state.worker.recognize(
    ocrInput,
    { rotateAuto: settings.autoRotate },
    { text: true, blocks: true },
    `page-${pageNumber}`,
  );
  const text = normalizeWhitespace(recognition.data.text);
  const lines = flattenOcrLines(recognition.data.blocks, canvas.width, canvas.height);

  return {
    number: pageNumber,
    source: "tesseract",
    text,
    confidence: Number.isFinite(recognition.data.confidence) ? recognition.data.confidence : 0,
    lines,
    durationMs: Math.round(performance.now() - startedAt),
    pdfRotation: page.rotate,
    ocrRotationRadians: recognition.data.rotateRadians ?? 0,
    renderedWidth: canvas.width,
    renderedHeight: canvas.height,
  };
}

async function runOcr() {
  if (!state.pdf || state.running) return;
  if (missingBrowserCapabilities.length > 0) {
    setError(
      `Этот браузер не предоставляет необходимые возможности: ${missingBrowserCapabilities.join(", ")}. `
      + "Откройте приложение в актуальном Chrome, Edge или Firefox.",
    );
    return;
  }
  setError("");
  clearResults();
  elements["workspace"].hidden = false;
  initializePageList(state.pdf.numPages);
  state.cancelRequested = false;
  state.startedAt = new Date().toISOString();
  setRunning(true);

  const settings = {
    dpi: Number(elements["dpi-select"].value),
    forceOcr: elements["force-ocr"].checked,
    autoRotate: elements["auto-rotate"].checked,
    languages: ["rus", "eng"],
  };

  try {
    updateProgress({ percent: 0, title: "Подготовка OCR", detail: "Читаются локальные компоненты…" });
    state.worker = await createOcrWorker(settings.dpi);

    for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
      if (state.cancelRequested) break;
      updateProgress({
        percent: ((pageNumber - 1) / state.pdf.numPages) * 100,
        title: `Страница ${pageNumber} из ${state.pdf.numPages}`,
        detail: "Подготавливается изображение страницы",
      });

      try {
        state.results[pageNumber - 1] = await recognizePage(pageNumber, settings);
      } catch (error) {
        console.error(error);
        state.results[pageNumber - 1] = {
          number: pageNumber,
          source: "error",
          text: "",
          confidence: 0,
          lines: [],
          error: error.message ?? String(error),
          errorDetails: {
            name: error.name ?? error.constructor?.name ?? "Error",
            stack: error.stack ?? null,
          },
        };
      }

      renderPageList();
      await selectPage(pageNumber);
      updateProgress({
        percent: (pageNumber / state.pdf.numPages) * 100,
        title: `Обработано страниц: ${pageNumber}`,
        detail: pageState(state.results[pageNumber - 1]).detail,
      });
    }

    const processed = state.results.filter(Boolean).length;
    updateProgress({
      percent: (processed / state.pdf.numPages) * 100,
      title: state.cancelRequested ? "Распознавание остановлено" : "Распознавание завершено",
      detail: `Обработано ${processed} из ${state.pdf.numPages} страниц`,
    });
    elements["export-card"].hidden = processed === 0;
  } catch (error) {
    console.error(error);
    setError(`OCR не запустился: ${error.message ?? error}`);
  } finally {
    await state.worker?.terminate().catch(console.error);
    state.worker = null;
    setRunning(false);
  }
}

function buildDocumentResult() {
  const settings = {
    dpi: Number(elements["dpi-select"].value),
    forceOcr: elements["force-ocr"].checked,
    autoRotate: elements["auto-rotate"].checked,
    languages: ["rus", "eng"],
  };
  return {
    schemaVersion: "contractility.ocr.v1",
    createdAt: new Date().toISOString(),
    startedAt: state.startedAt,
    document: {
      name: state.file.name,
      size: state.file.size,
      lastModified: new Date(state.file.lastModified).toISOString(),
      sha256: state.fileHash,
      pageCount: state.pdf.numPages,
    },
    engine: {
      pdf: "pdfjs-dist@6.1.200",
      ocr: "tesseract.js@7.0.0",
      models: ["rus@4.0.0_best_int", "eng@4.0.0_best_int"],
      browserCapabilities,
      browserEnvironment,
    },
    settings,
    complete: state.results.filter(Boolean).length === state.pdf.numPages,
    pages: state.results.filter(Boolean),
  };
}

function download(name, type, content) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseFileName() {
  return state.file.name.replace(/\.pdf$/i, "");
}

elements["file-input"].addEventListener("change", (event) => loadFile(event.target.files[0]));
elements["reset-button"].addEventListener("click", resetFile);
elements["start-button"].addEventListener("click", runOcr);
elements["cancel-button"].addEventListener("click", () => {
  state.cancelRequested = true;
  elements["cancel-button"].disabled = true;
  elements["cancel-button"].textContent = "Останавливается…";
});
elements["previous-page"].addEventListener("click", () => selectPage(state.selectedPage - 1));
elements["next-page"].addEventListener("click", () => selectPage(state.selectedPage + 1));
elements["overlay-toggle"].addEventListener("change", () => renderOverlay(state.results[state.selectedPage - 1]?.lines ?? []));
elements["page-text"].addEventListener("input", () => {
  const result = state.results[state.selectedPage - 1];
  if (!result) return;
  result.text = elements["page-text"].value;
  result.manuallyEdited = true;
  elements["edit-note"].hidden = false;
  renderPageList();
});
elements["download-json"].addEventListener("click", () => {
  const result = buildDocumentResult();
  download(`${baseFileName()}.ocr.json`, "application/json", `${JSON.stringify(result, null, 2)}\n`);
});
elements["download-text"].addEventListener("click", () => {
  download(`${baseFileName()}.ocr.txt`, "text/plain;charset=utf-8", createTextExport(buildDocumentResult()));
});

for (const eventName of ["dragenter", "dragover"]) {
  elements["drop-zone"].addEventListener(eventName, (event) => {
    event.preventDefault();
    elements["drop-zone"].classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements["drop-zone"].addEventListener(eventName, (event) => {
    event.preventDefault();
    elements["drop-zone"].classList.remove("dragging");
  });
}
elements["drop-zone"].addEventListener("drop", (event) => loadFile(event.dataTransfer.files[0]));

window.addEventListener("resize", () => {
  if (state.pdf) renderPreview(state.selectedPage).catch(console.error);
});
