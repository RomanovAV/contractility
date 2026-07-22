import { GlobalWorkerOptions, getDocument } from "./vendor/pdfjs/pdf.min.mjs";
import Tesseract from "./vendor/tesseract/tesseract.esm.min.js";
import { flattenOcrLines, normalizeWhitespace } from "./ocr-utils.mjs";

const { createWorker } = Tesseract;
const DIAGNOSTIC_DPI = 220;

GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url,
).href;

const elements = Object.fromEntries([
  "diagnostics-download", "diagnostics-drop-zone", "diagnostics-error", "diagnostics-file",
  "diagnostics-file-meta", "diagnostics-file-name", "diagnostics-file-summary", "diagnostics-log",
  "diagnostics-progress", "diagnostics-progress-bar", "diagnostics-progress-detail",
  "diagnostics-progress-percent", "diagnostics-progress-title", "diagnostics-retry", "diagnostics-status",
].map((id) => [id, document.getElementById(id)]));

let selectedFile = null;
let currentReport = null;
let running = false;

function serializeError(error) {
  if (error == null) return { name: "Error", message: "Unknown error" };
  if (typeof error !== "object") return { name: typeof error, message: String(error) };
  return {
    name: error.name ?? error.constructor?.name ?? "Error",
    message: error.message ?? String(error),
    stack: error.stack ?? null,
    code: error.code ?? null,
  };
}

function collectEnvironment() {
  const canvas = document.createElement("canvas");
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    vendor: navigator.vendor,
    language: navigator.language,
    languages: Array.from(navigator.languages ?? []),
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    maxTouchPoints: navigator.maxTouchPoints ?? null,
    devicePixelRatio: window.devicePixelRatio ?? null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    capabilities: {
      webAssembly: typeof WebAssembly === "object",
      webWorker: typeof Worker === "function",
      sha256: Boolean(globalThis.crypto?.subtle),
      canvas2d: Boolean(canvas.getContext("2d")),
      canvasToBlob: typeof canvas.toBlob === "function",
      canvasToDataUrl: typeof canvas.toDataURL === "function",
      offscreenCanvas: typeof OffscreenCanvas === "function",
      createImageBitmap: typeof createImageBitmap === "function",
    },
  };
}

function appendLog(message) {
  const timestamp = new Date().toISOString().slice(11, 23);
  elements["diagnostics-log"].textContent += `[${timestamp}] ${message}\n`;
  elements["diagnostics-log"].scrollTop = elements["diagnostics-log"].scrollHeight;
}

function setProgress(percent, title, detail) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  elements["diagnostics-progress"].hidden = false;
  elements["diagnostics-progress-bar"].style.width = `${safePercent}%`;
  elements["diagnostics-progress-percent"].textContent = `${safePercent}%`;
  elements["diagnostics-progress-title"].textContent = title;
  elements["diagnostics-progress-detail"].textContent = detail;
}

function setError(message) {
  elements["diagnostics-error"].textContent = message;
  elements["diagnostics-error"].hidden = !message;
}

function setRunning(value) {
  running = value;
  elements["diagnostics-file"].disabled = value;
  elements["diagnostics-retry"].disabled = value || !selectedFile;
  elements["diagnostics-download"].disabled = value || !currentReport;
}

async function sha256(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function runStep(report, name, action) {
  const step = { name, startedAt: new Date().toISOString() };
  const started = performance.now();
  report.steps.push(step);
  appendLog(`${name}: запущено`);
  try {
    step.result = await action();
    step.status = "passed";
    appendLog(`${name}: OK`);
    return { ok: true, value: step.result };
  } catch (error) {
    step.status = "failed";
    step.error = serializeError(error);
    appendLog(`${name}: ОШИБКА — ${step.error.message}`);
    return { ok: false, error };
  } finally {
    step.durationMs = Math.round(performance.now() - started);
    step.finishedAt = new Date().toISOString();
  }
}

async function probeCanvasBlob(canvas) {
  if (typeof canvas.toBlob !== "function") {
    throw new TypeError("HTMLCanvasElement.toBlob is not a function");
  }
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("canvas.toBlob timed out after 10 seconds")), 10_000);
    canvas.toBlob((blob) => {
      clearTimeout(timeoutId);
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}

async function createDiagnosticWorker(report) {
  let initializationTimedOut = false;
  let timeoutId;
  const workerPromise = createWorker(["rus", "eng"], 1, {
    workerPath: new URL("./vendor/tesseract/worker.min.js", import.meta.url).href,
    corePath: new URL("./vendor/tesseract/core/tesseract-core-lstm.wasm.js", import.meta.url).href,
    langPath: new URL("./vendor/tessdata/", import.meta.url).href,
    workerBlobURL: false,
    cacheMethod: "none",
    gzip: true,
    logger(message) {
      const event = {
        at: new Date().toISOString(),
        status: message.status,
        progress: Number.isFinite(message.progress) ? message.progress : null,
      };
      report.workerLog.push(event);
      if (message.status) {
        const progress = event.progress == null ? "" : ` ${Math.round(event.progress * 100)}%`;
        appendLog(`Tesseract: ${message.status}${progress}`);
      }
    },
    errorHandler(error) {
      const serialized = serializeError(error);
      report.workerErrors.push({ at: new Date().toISOString(), ...serialized });
      appendLog(`Tesseract worker: ${serialized.message}`);
    },
  });
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => {
        initializationTimedOut = true;
        reject(new Error("Tesseract worker initialization timed out after 120 seconds"));
      },
      120_000,
    );
  });
  try {
    const worker = await Promise.race([workerPromise, timeoutPromise]);
    await worker.setParameters({
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: "3",
      user_defined_dpi: String(DIAGNOSTIC_DPI),
    });
    return worker;
  } finally {
    clearTimeout(timeoutId);
    if (initializationTimedOut) {
      workerPromise.then((lateWorker) => lateWorker.terminate()).catch(() => {});
    }
  }
}

function recognitionSummary(recognition) {
  const data = recognition?.data ?? {};
  return {
    textLength: typeof data.text === "string" ? data.text.length : null,
    confidence: Number.isFinite(data.confidence) ? data.confidence : null,
    blocksType: data.blocks == null ? null : Array.isArray(data.blocks) ? "array" : typeof data.blocks,
    blocksCount: Array.isArray(data.blocks) ? data.blocks.length : null,
    rotateRadians: Number.isFinite(data.rotateRadians) ? data.rotateRadians : null,
  };
}

function blockShape(blocks) {
  if (!Array.isArray(blocks)) {
    return { type: blocks == null ? "null" : typeof blocks, count: null, sample: [] };
  }
  const sample = [];
  const sampleSize = Math.min(blocks.length, 20);
  for (let blockIndex = 0; blockIndex < sampleSize; blockIndex += 1) {
    const block = blocks[blockIndex];
    const paragraphs = block?.paragraphs;
    const paragraphSummary = {
      type: paragraphs == null ? "null" : Array.isArray(paragraphs) ? "array" : typeof paragraphs,
      count: Array.isArray(paragraphs) ? paragraphs.length : null,
      lines: [],
    };
    if (Array.isArray(paragraphs)) {
      const paragraphSampleSize = Math.min(paragraphs.length, 20);
      for (let paragraphIndex = 0; paragraphIndex < paragraphSampleSize; paragraphIndex += 1) {
        const lines = paragraphs[paragraphIndex]?.lines;
        paragraphSummary.lines.push({
          type: lines == null ? "null" : Array.isArray(lines) ? "array" : typeof lines,
          count: Array.isArray(lines) ? lines.length : null,
        });
      }
    }
    sample.push(paragraphSummary);
  }
  return { type: "array", count: blocks.length, sample };
}

async function runDiagnostics(file) {
  if (running) return;
  setError("");
  currentReport = {
    schemaVersion: "contractility.ocr-diagnostics.v1",
    createdAt: new Date().toISOString(),
    engine: {
      pdf: "pdfjs-dist@6.1.200",
      ocr: "tesseract.js@7.0.0",
      models: ["rus@4.0.0_best_int", "eng@4.0.0_best_int"],
    },
    environment: collectEnvironment(),
    document: {
      name: file.name,
      size: file.size,
      lastModified: new Date(file.lastModified).toISOString(),
    },
    settings: { page: 1, dpi: DIAGNOSTIC_DPI },
    steps: [],
    workerLog: [],
    workerErrors: [],
    conclusion: null,
    complete: false,
  };
  elements["diagnostics-log"].textContent = "";
  elements["diagnostics-status"].textContent = "Выполняется диагностика…";
  setRunning(true);

  let pdf;
  let worker;
  try {
    setProgress(5, "Чтение файла", "Вычисляется SHA-256");
    const buffer = await file.arrayBuffer();
    const hashResult = await runStep(currentReport, "sha256", async () => {
      const hash = await sha256(buffer);
      currentReport.document.sha256 = hash;
      return { sha256: hash };
    });
    if (!hashResult.ok) throw hashResult.error;

    setProgress(15, "Открытие PDF", "Проверяется PDF.js");
    const openResult = await runStep(currentReport, "pdf.open", async () => {
      pdf = await getDocument({
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        useSystemFonts: true,
      }).promise;
      currentReport.document.pageCount = pdf.numPages;
      return { pageCount: pdf.numPages };
    });
    if (!openResult.ok) throw openResult.error;

    let page;
    setProgress(20, "Проверка текстового слоя", "Safari вызывает PDF.js getTextContent");
    const pageResult = await runStep(currentReport, "pdf.get-page-1", async () => {
      page = await pdf.getPage(1);
      return { pageNumber: page.pageNumber, pdfRotation: page.rotate };
    });
    if (!pageResult.ok) throw pageResult.error;

    const textLayerResult = await runStep(currentReport, "pdf.get-text-content", async () => {
      const textContent = await page.getTextContent();
      return { itemsCount: Array.isArray(textContent?.items) ? textContent.items.length : null };
    });
    if (!textLayerResult.ok) {
      currentReport.conclusion = "pdf-text-layer-failure";
      currentReport.complete = true;
      setProgress(100, "Причина найдена", "PDF.js getTextContent несовместим с Safari; приложение перейдёт к OCR");
      elements["diagnostics-status"].textContent = "Готово — скачайте отчёт JSON";
      appendLog("Причина найдена: PDF text layer недоступен; требуется fallback на OCR");
      return;
    }

    let canvas;
    setProgress(25, "Отрисовка страницы", `Первая страница, ${DIAGNOSTIC_DPI} DPI`);
    const renderResult = await runStep(currentReport, "pdf.render-page-1", async () => {
      const viewport = page.getViewport({ scale: DIAGNOSTIC_DPI / 72 });
      canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      if (!context) throw new Error("Canvas 2D context is unavailable");
      await page.render({ canvasContext: context, viewport }).promise;
      return { width: canvas.width, height: canvas.height, pdfRotation: page.rotate };
    });
    if (!renderResult.ok) throw renderResult.error;

    setProgress(35, "Проверка Canvas", "Проверяются два способа передачи изображения");
    const blobProbe = await runStep(currentReport, "canvas.toBlob", async () => {
      const blob = await probeCanvasBlob(canvas);
      return { type: blob.type, size: blob.size };
    });
    const dataUrlProbe = await runStep(currentReport, "canvas.toDataURL", async () => {
      if (typeof canvas.toDataURL !== "function") {
        throw new TypeError("HTMLCanvasElement.toDataURL is not a function");
      }
      const dataUrl = canvas.toDataURL("image/png");
      return { prefix: dataUrl.slice(0, 30), length: dataUrl.length };
    });

    setProgress(45, "Запуск Tesseract", "Загружаются локальное ядро и языки");
    const workerResult = await runStep(currentReport, "tesseract.initialize", async () => {
      worker = await createDiagnosticWorker(currentReport);
      return { initialized: true };
    });
    if (!workerResult.ok) throw workerResult.error;

    setProgress(60, "Точный повтор", "Canvas + autoRotate + blocks");
    let exactRecognition;
    const exactResult = await runStep(currentReport, "tesseract.app-exact", async () => {
      exactRecognition = await worker.recognize(
        canvas,
        { rotateAuto: true },
        { text: true, blocks: true },
        "diagnostics-app-exact",
      );
      return recognitionSummary(exactRecognition);
    });

    let postprocessResult = null;
    if (exactResult.ok) {
      await runStep(currentReport, "tesseract.block-shape", async () => (
        blockShape(exactRecognition.data.blocks)
      ));
      postprocessResult = await runStep(currentReport, "ocr.postprocess", async () => {
        const text = normalizeWhitespace(exactRecognition.data.text);
        const lines = flattenOcrLines(exactRecognition.data.blocks, canvas.width, canvas.height);
        return { textLength: text.length, linesCount: lines.length };
      });
    }

    if (exactResult.ok && !postprocessResult.ok) {
      currentReport.conclusion = "ocr-postprocess-failure";
    } else if (!exactResult.ok && dataUrlProbe.ok) {
      setProgress(75, "Проверка транспорта", "Data URL + autoRotate + blocks");
      const fullFallback = await runStep(currentReport, "tesseract.data-url-full", async () => {
        const recognition = await worker.recognize(
          canvas.toDataURL("image/png"),
          { rotateAuto: true },
          { text: true, blocks: true },
          "diagnostics-data-url-full",
        );
        return recognitionSummary(recognition);
      });
      if (fullFallback.ok) {
        currentReport.conclusion = "canvas-transport-failure";
      } else {
        setProgress(88, "Минимальный OCR", "Data URL без автоповорота и блоков");
        const minimalFallback = await runStep(currentReport, "tesseract.data-url-minimal", async () => {
          const recognition = await worker.recognize(
            canvas.toDataURL("image/png"),
            {},
            { text: true },
            "diagnostics-data-url-minimal",
          );
          return recognitionSummary(recognition);
        });
        currentReport.conclusion = minimalFallback.ok
          ? "rotate-or-blocks-failure"
          : "tesseract-recognition-failure";
      }
    } else if (exactResult.ok && postprocessResult.ok) {
      currentReport.conclusion = "no-failure-reproduced";
    } else if (!blobProbe.ok) {
      currentReport.conclusion = "canvas-to-blob-unavailable";
    } else {
      currentReport.conclusion = "exact-recognition-failure";
    }

    currentReport.complete = true;
    setProgress(100, "Диагностика завершена", `Результат: ${currentReport.conclusion}`);
    elements["diagnostics-status"].textContent = "Готово — скачайте отчёт JSON";
    appendLog(`Диагностика завершена: ${currentReport.conclusion}`);
  } catch (error) {
    currentReport.fatalError = serializeError(error);
    currentReport.conclusion = currentReport.conclusion ?? "fatal-error";
    setError(`Диагностика остановлена: ${currentReport.fatalError.message}`);
    elements["diagnostics-status"].textContent = "Отчёт можно скачать, несмотря на ошибку";
    appendLog(`Диагностика остановлена: ${currentReport.fatalError.message}`);
  } finally {
    if (worker) {
      await runStep(currentReport, "tesseract.terminate", async () => {
        await worker.terminate();
        return { terminated: true };
      });
    }
    if (typeof pdf?.destroy === "function") {
      await pdf.destroy().catch(() => {});
    }
    currentReport.finishedAt = new Date().toISOString();
    setRunning(false);
  }
}

function downloadReport() {
  if (!currentReport) return;
  const blob = new Blob([`${JSON.stringify(currentReport, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const baseName = (selectedFile?.name ?? "contractility").replace(/\.pdf$/i, "");
  anchor.href = url;
  anchor.download = `${baseName}.diagnostics.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function selectFile(file) {
  if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
    setError("Выберите файл PDF.");
    return;
  }
  selectedFile = file;
  elements["diagnostics-drop-zone"].hidden = true;
  elements["diagnostics-file-summary"].hidden = false;
  elements["diagnostics-file-name"].textContent = file.name;
  elements["diagnostics-file-meta"].textContent = `${file.size} байт`;
  elements["diagnostics-retry"].disabled = false;
  runDiagnostics(file).catch((error) => setError(error.message ?? String(error)));
}

elements["diagnostics-file"].addEventListener("change", (event) => selectFile(event.target.files[0]));
elements["diagnostics-download"].addEventListener("click", downloadReport);
elements["diagnostics-retry"].addEventListener("click", () => runDiagnostics(selectedFile));
