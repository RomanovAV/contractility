import { GlobalWorkerOptions, getDocument } from "./vendor/pdfjs/pdf.min.mjs";
import Tesseract from "./vendor/tesseract/tesseract.esm.min.js";
import {
  createDocumentLabel,
  createOcrRenderPlan,
  flattenOcrLines,
  humanFileSize,
  isUsefulPdfText,
  normalizeWhitespace,
  readPdfTextLayer,
  resolveAdditionalPageRotation,
} from "./ocr-utils.mjs";
import {
  buildFormationRequest,
  createFormationTextExport,
  moveHistoricalDocument,
  normalizeDocumentOrder,
  validateDraftAgreementFile,
} from "./workflow-utils.mjs";

const { createWorker } = Tesseract;

GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url,
).href;

const elements = Object.fromEntries(
  [
    "add-files-button", "additional-file-input", "cancel-button", "confidence-badge",
    "documents-list", "download-json", "download-text", "draft-drop-zone",
    "draft-file-input", "draft-summary",
    "dpi-select", "drop-zone", "edit-note", "error-banner", "export-card", "file-input",
    "file-summary", "force-ocr", "next-page", "ocr-overlay", "overlay-toggle",
    "page-rotation-label", "page-surface", "page-text", "pages-counter", "pages-list",
    "preflight-note", "previous-page", "progress-bar", "progress-card", "progress-detail",
    "progress-percent", "progress-title", "reset-button", "reset-page-rotation",
    "rotate-page-left", "rotate-page-right", "rotation-select", "start-button",
    "viewer-canvas", "viewer-document-label", "viewer-page-label", "viewer-position",
    "viewer-stage", "workspace", "formation-status",
  ].map((id) => [id, document.getElementById(id)]),
);

const state = {
  documents: [],
  selectedDocument: 0,
  selectedPage: 1,
  worker: null,
  running: false,
  loading: false,
  cancelRequested: false,
  previewRequest: 0,
  startedAt: null,
  processingDocument: null,
  processingPage: null,
  processingDetail: "",
  draftAgreement: null,
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

function currentDocument() {
  return state.documents[state.selectedDocument] ?? null;
}

function hasReadyDocuments() {
  return state.documents.length > 0 && state.documents.every((document) => document.pdf);
}

function totalPageCount() {
  return state.documents.reduce((total, document) => total + (document.pdf?.numPages ?? 0), 0);
}

function completedPageCount() {
  return state.documents.reduce(
    (total, document) => total + document.results.filter(Boolean).length,
    0,
  );
}

function isOcrComplete() {
  return totalPageCount() > 0
    && completedPageCount() === totalPageCount()
    && state.documents.every((document) => document.results.every((page) => page && !page.error));
}

function isFormationReady() {
  return isOcrComplete() && Boolean(state.draftAgreement?.sha256);
}

function updateFormationState() {
  const hasOcrResults = completedPageCount() > 0;
  elements["export-card"].hidden = !hasOcrResults && !state.draftAgreement;
  elements["download-json"].disabled = !isFormationReady();
  elements["download-text"].disabled = !isFormationReady();

  if (isFormationReady()) {
    elements["formation-status"].textContent =
      "PDF-комплект распознан, порядок источников зафиксирован, DOCX проверен по SHA-256. Пакет готов для реконструкции действующей редакции и генерации финального файла.";
  } else if (!isOcrComplete() && state.draftAgreement) {
    elements["formation-status"].textContent =
      "Новая редакция DOCX загружена. Завершите распознавание всех страниц подписанного комплекта.";
  } else if (isOcrComplete()) {
    elements["formation-status"].textContent =
      "Подписанный комплект распознан. Загрузите новую редакцию дополнительного соглашения в DOCX.";
  } else {
    elements["formation-status"].textContent =
      "Завершите OCR подписанных PDF и загрузите новую редакцию DOCX.";
  }
}

function updateStartButtonLabel() {
  const total = totalPageCount();
  const completed = completedPageCount();
  if (total > 0 && completed === total) {
    elements["start-button"].textContent = "Распознать заново";
  } else if (completed > 0) {
    elements["start-button"].textContent = "Распознать новые документы";
  } else {
    elements["start-button"].textContent = "Начать распознавание";
  }
  updateFormationState();
}

function setError(message) {
  elements["error-banner"].textContent = message;
  elements["error-banner"].hidden = !message;
}

function serializeError(error) {
  return {
    name: error?.name ?? error?.constructor?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  };
}

function setRunning(running) {
  state.running = running;
  updateStartButtonLabel();
  const document = currentDocument();
  elements["start-button"].disabled = running || state.loading || !hasReadyDocuments();
  elements["cancel-button"].hidden = !running;
  elements["reset-button"].disabled = running || state.loading;
  elements["add-files-button"].disabled = running || state.loading;
  elements["additional-file-input"].disabled = running || state.loading;
  elements["file-input"].disabled = running || state.loading;
  elements["draft-file-input"].disabled = running || state.loading;
  elements["dpi-select"].disabled = running;
  elements["force-ocr"].disabled = running;
  elements["rotation-select"].disabled = running;
  elements["rotate-page-left"].disabled = running || !document?.pdf;
  elements["rotate-page-right"].disabled = running || !document?.pdf;
  elements["reset-page-rotation"].disabled = running
    || !document?.pdf
    || document.pageRotationOverrides[String(state.selectedPage)] == null;
  if (running) {
    elements["cancel-button"].disabled = false;
    elements["cancel-button"].textContent = "Остановить после страницы";
  }
  renderFileSummary();
  renderDraftAgreement();
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

function clearResults({ hideWorkspace = true } = {}) {
  for (const document of state.documents) {
    document.results = [];
  }
  state.processingDocument = null;
  state.processingPage = null;
  state.processingDetail = "";
  state.selectedDocument = 0;
  state.selectedPage = 1;
  elements["documents-list"].replaceChildren();
  elements["pages-list"].replaceChildren();
  elements["page-text"].value = "";
  elements["page-text"].disabled = true;
  elements["workspace"].hidden = hideWorkspace;
  elements["export-card"].hidden = true;
  elements["progress-card"].hidden = true;
  updateStartButtonLabel();
}

function destroyDocuments(documents = state.documents) {
  for (const document of documents) {
    if (typeof document.pdf?.destroy === "function") {
      Promise.resolve(document.pdf.destroy()).catch(console.error);
    }
  }
}

function renderFileSummary() {
  elements["file-summary"].replaceChildren();
  for (const [index, document] of state.documents.entries()) {
    const item = globalThis.document.createElement("div");
    item.className = "file-summary-item";

    const icon = globalThis.document.createElement("div");
    icon.className = "file-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "PDF";

    const description = globalThis.document.createElement("div");
    description.className = "file-description";
    const role = globalThis.document.createElement("span");
    role.className = "document-role";
    role.textContent = document.label;
    const name = globalThis.document.createElement("strong");
    name.textContent = document.file.name;
    const meta = globalThis.document.createElement("span");
    if (document.error) {
      meta.className = "file-error";
      meta.textContent = "Не удалось открыть PDF";
    } else if (document.pdf) {
      meta.textContent = `${humanFileSize(document.file.size)} · ${document.pdf.numPages} стр. · SHA-256 ${document.fileHash.slice(0, 12)}…`;
    } else {
      meta.textContent = `${humanFileSize(document.file.size)} · подготовка…`;
    }
    description.append(role, name, meta);

    const trailing = globalThis.document.createElement("div");
    if (index > 0) {
      trailing.className = "file-order-actions";
      const up = globalThis.document.createElement("button");
      up.type = "button";
      up.textContent = "↑";
      up.title = "Переместить выше";
      up.setAttribute("aria-label", `Переместить «${document.file.name}» выше`);
      up.disabled = state.running || state.loading || index === 1;
      up.addEventListener("click", () => reorderHistoricalDocument(index, -1));
      const down = globalThis.document.createElement("button");
      down.type = "button";
      down.textContent = "↓";
      down.title = "Переместить ниже";
      down.setAttribute("aria-label", `Переместить «${document.file.name}» ниже`);
      down.disabled = state.running || state.loading || index === state.documents.length - 1;
      down.addEventListener("click", () => reorderHistoricalDocument(index, 1));
      trailing.append(up, down);
    } else {
      trailing.className = document.error ? "ready-mark failed" : "ready-mark";
      trailing.setAttribute("aria-label", document.pdf ? "Файл готов" : "Файл подготавливается");
      trailing.textContent = document.error ? "!" : document.pdf ? "✓" : "1";
    }
    item.append(icon, description, trailing);
    elements["file-summary"].append(item);
  }
}

function reorderHistoricalDocument(index, direction) {
  if (state.running || state.loading) return;
  const selectedId = currentDocument()?.id;
  const reordered = moveHistoricalDocument(state.documents, index, direction);
  if (reordered === state.documents) return;
  state.documents = reordered;
  state.selectedDocument = Math.max(
    0,
    state.documents.findIndex((document) => document.id === selectedId),
  );
  renderFileSummary();
  renderDocumentsList();
  if (currentDocument()?.pdf) {
    selectDocument(state.selectedDocument, state.selectedPage).catch(console.error);
  }
}

function renderDraftAgreement() {
  const draft = state.draftAgreement;
  elements["draft-drop-zone"].hidden = Boolean(draft);
  elements["draft-summary"].hidden = !draft;
  elements["draft-summary"].replaceChildren();
  if (!draft) {
    updateFormationState();
    return;
  }

  const badge = globalThis.document.createElement("span");
  badge.className = "docx-badge";
  badge.textContent = "DOCX";
  const copy = globalThis.document.createElement("span");
  copy.className = "draft-summary-copy";
  const name = globalThis.document.createElement("strong");
  name.textContent = draft.file.name;
  const meta = globalThis.document.createElement("span");
  meta.textContent = `${humanFileSize(draft.file.size)} · SHA-256 ${draft.sha256.slice(0, 12)}…`;
  const note = globalThis.document.createElement("small");
  note.textContent = "Новая редакция · не подписанный документ";
  copy.append(name, meta, note);
  const replace = globalThis.document.createElement("button");
  replace.type = "button";
  replace.className = "replace-draft-button";
  replace.textContent = "Заменить";
  replace.disabled = state.running || state.loading;
  replace.addEventListener("click", () => {
    elements["draft-file-input"].value = "";
    elements["draft-file-input"].click();
  });
  elements["draft-summary"].append(badge, copy, replace);
  updateFormationState();
}

async function loadDraftAgreement(fileList) {
  if (state.running || state.loading) return;
  const files = Array.from(fileList ?? []);
  if (files.length !== 1) {
    setError("Выберите один файл новой редакции в формате DOCX.");
    return;
  }
  const file = files[0];
  const validationError = validateDraftAgreementFile(file);
  if (validationError) {
    setError(validationError);
    return;
  }
  setError("");
  const buffer = await file.arrayBuffer();
  state.draftAgreement = {
    file,
    sha256: await sha256(buffer),
  };
  renderDraftAgreement();
}

function validatePdfFiles(files) {
  if (files.length === 0) {
    return "Выберите хотя бы один PDF-файл.";
  }
  const invalid = files.find(
    (file) => (file.type && file.type !== "application/pdf") || !file.name.toLowerCase().endsWith(".pdf"),
  );
  return invalid ? `Файл «${invalid.name}» не является PDF.` : "";
}

async function loadDocuments(fileList, { append = false } = {}) {
  if (state.running || state.loading) return;
  const files = Array.from(fileList ?? []);
  const validationError = validatePdfFiles(files);
  if (validationError) {
    setError(validationError);
    return;
  }

  setError("");
  const previousDocuments = append ? [...state.documents] : [];
  const previousSelectedDocument = state.selectedDocument;
  const startIndex = previousDocuments.length;
  if (!append) destroyDocuments();
  const addedDocuments = files.map((file, offset) => {
    const index = startIndex + offset;
    return {
      id: `document-${index + 1}`,
      role: index === 0 ? "contract" : "additional-agreement",
      label: createDocumentLabel(index),
      file,
      fileHash: null,
      pdf: null,
      results: [],
      pageRotationOverrides: {},
      error: null,
    };
  });
  state.documents = normalizeDocumentOrder([...previousDocuments, ...addedDocuments]);
  if (!append) clearResults();
  state.loading = true;
  elements["drop-zone"].hidden = true;
  elements["file-summary"].hidden = false;
  elements["add-files-button"].hidden = false;
  elements["add-files-button"].disabled = true;
  elements["reset-button"].hidden = false;
  elements["start-button"].disabled = true;
  renderFileSummary();

  try {
    for (const document of addedDocuments) {
      const buffer = await document.file.arrayBuffer();
      document.fileHash = await sha256(buffer);
      const loadingTask = getDocument({
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        useSystemFonts: true,
        wasmUrl: new URL("./vendor/pdfjs/wasm/", import.meta.url).href,
      });
      document.pdf = await loadingTask.promise;
      renderFileSummary();
    }

    state.loading = false;
    elements["add-files-button"].disabled = false;
    elements["start-button"].disabled = false;
    elements["workspace"].hidden = false;
    renderDocumentsList();
    await selectDocument(append ? startIndex : 0, 1);
    if (append && completedPageCount() > 0) {
      updateProgress({
        percent: (completedPageCount() / totalPageCount()) * 100,
        title: "Комплект дополнен",
        detail: `Обработано ${completedPageCount()} из ${totalPageCount()} страниц`,
      });
    }
    updateStartButtonLabel();
  } catch (error) {
    console.error(error);
    const failedDocument = addedDocuments.find((document) => !document.pdf);
    if (failedDocument) failedDocument.error = serializeError(error);
    renderFileSummary();
    destroyDocuments(addedDocuments);
    if (append) {
      state.documents = previousDocuments;
      state.selectedDocument = Math.min(
        previousSelectedDocument,
        Math.max(0, previousDocuments.length - 1),
      );
      renderFileSummary();
      renderDocumentsList();
    } else {
      for (const document of state.documents) {
        document.pdf = null;
      }
    }
    state.loading = false;
    elements["add-files-button"].hidden = !hasReadyDocuments();
    elements["add-files-button"].disabled = false;
    elements["start-button"].disabled = !hasReadyDocuments();
    updateStartButtonLabel();
    setError(`Не удалось открыть «${failedDocument?.file.name ?? "PDF"}»: ${error.message ?? error}`);
  }
}

function resetDocuments() {
  if (state.running || state.loading) return;
  destroyDocuments();
  state.documents = [];
  state.draftAgreement = null;
  state.selectedDocument = 0;
  state.selectedPage = 1;
  elements["file-input"].value = "";
  elements["additional-file-input"].value = "";
  elements["draft-file-input"].value = "";
  elements["file-summary"].replaceChildren();
  elements["file-summary"].hidden = true;
  elements["drop-zone"].hidden = false;
  elements["add-files-button"].hidden = true;
  elements["reset-button"].hidden = true;
  elements["start-button"].disabled = true;
  updateStartButtonLabel();
  clearResults();
  renderDraftAgreement();
  setError("");
}

function renderDocumentsList() {
  elements["documents-list"].replaceChildren();
  for (const [index, document] of state.documents.entries()) {
    const button = globalThis.document.createElement("button");
    button.type = "button";
    button.className = "document-item";
    button.classList.toggle("selected", index === state.selectedDocument);
    button.dataset.document = String(index);

    const role = globalThis.document.createElement("strong");
    role.textContent = document.label;
    const fileName = globalThis.document.createElement("span");
    fileName.textContent = document.file.name;
    const progress = globalThis.document.createElement("small");
    progress.textContent = `${document.results.filter(Boolean).length} / ${document.pdf?.numPages ?? 0} стр.`;
    button.append(role, fileName, progress);
    button.addEventListener("click", () => selectDocument(index, 1));
    elements["documents-list"].append(button);
  }
}

function initializePageList(document = currentDocument()) {
  elements["pages-list"].replaceChildren();
  if (!document?.pdf) return;
  for (let number = 1; number <= document.pdf.numPages; number += 1) {
    const button = globalThis.document.createElement("button");
    button.type = "button";
    button.className = "page-item";
    button.dataset.page = String(number);
    button.innerHTML = `
      <span class="page-number">${number}</span>
      <span class="page-state"><strong>Готова</strong><span>Нажмите кнопку распознавания</span></span>
    `;
    button.addEventListener("click", () => selectPage(number));
    elements["pages-list"].append(button);
  }
  renderPageList();
}

function pageState(result, pageNumber = null) {
  const isProcessing = state.running
    && state.selectedDocument === state.processingDocument
    && pageNumber === state.processingPage;
  if (!result && isProcessing) {
    return { title: "Обработка", detail: state.processingDetail || "Подготавливается страница", tone: "warning" };
  }
  if (!result && state.running) return { title: "В очереди", detail: "Ожидает обработки", tone: "" };
  if (!result) return { title: "Готова", detail: "Нажмите кнопку распознавания", tone: "" };
  if (result.error) return { title: "Ошибка", detail: result.error, tone: "failed" };
  if (result.source === "pdf-text") return { title: "Текст PDF", detail: "OCR не потребовался", tone: "good" };
  if (!normalizeWhitespace(result.text)) return { title: "Пустая", detail: "Текст не найден", tone: "warning" };
  if (result.confidence >= 80) return { title: `${Math.round(result.confidence)}%`, detail: "Высокая уверенность", tone: "good" };
  if (result.confidence >= 55) return { title: `${Math.round(result.confidence)}%`, detail: "Нужна проверка", tone: "warning" };
  return { title: `${Math.round(result.confidence)}%`, detail: "Низкая уверенность", tone: "failed" };
}

function renderPageList() {
  const document = currentDocument();
  const completed = document?.results.filter(Boolean).length ?? 0;
  elements["pages-counter"].textContent = `${completedPageCount()} / ${totalPageCount()}`;
  renderDocumentsList();
  for (const button of elements["pages-list"].querySelectorAll(".page-item")) {
    const pageNumber = Number(button.dataset.page);
    const pageResult = document?.results[pageNumber - 1];
    const view = pageState(pageResult, pageNumber);
    button.classList.toggle("selected", pageNumber === state.selectedPage);
    const stateElement = button.querySelector(".page-state");
    const title = globalThis.document.createElement("strong");
    title.className = view.tone;
    title.textContent = view.title;
    const detail = globalThis.document.createElement("span");
    detail.textContent = view.detail;
    stateElement.replaceChildren(title, detail);
  }
  if (document) {
    const activeButton = elements["documents-list"].querySelector(`[data-document="${state.selectedDocument}"] small`);
    if (activeButton) activeButton.textContent = `${completed} / ${document.pdf?.numPages ?? 0} стр.`;
  }
  updateStartButtonLabel();
}

async function renderPreview(pageNumber) {
  const document = currentDocument();
  if (!document?.pdf) return;
  const requestId = ++state.previewRequest;
  const selectedDocument = state.selectedDocument;
  const page = await document.pdf.getPage(pageNumber);
  const displayedViewport = page.getViewport({ scale: 1 });
  const additionalRotation = resolveAdditionalPageRotation(
    displayedViewport,
    rotationModeForPage(pageNumber, null, document),
  );
  const rotation = (page.rotate + additionalRotation) % 360;
  const baseViewport = page.getViewport({ scale: 1, rotation });
  const availableWidth = Math.max(280, elements["viewer-stage"].clientWidth - 44);
  const cssScale = Math.min(1.6, availableWidth / baseViewport.width);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: cssScale * pixelRatio, rotation });
  const canvas = elements["viewer-canvas"];
  const context = canvas.getContext("2d", { alpha: false });

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${Math.ceil(viewport.width / pixelRatio)}px`;
  canvas.style.height = `${Math.ceil(viewport.height / pixelRatio)}px`;
  elements["page-surface"].style.width = canvas.style.width;
  elements["page-surface"].style.height = canvas.style.height;

  await page.render({ canvasContext: context, viewport }).promise;
  if (requestId !== state.previewRequest || selectedDocument !== state.selectedDocument) return;
  renderOverlay(document.results[pageNumber - 1]?.lines ?? []);
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
  const result = currentDocument()?.results[state.selectedPage - 1];
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

function rotationModeForPage(pageNumber, settings = null, document = currentDocument()) {
  const overrides = document?.pageRotationOverrides ?? {};
  return overrides[String(pageNumber)] ?? settings?.rotationMode ?? elements["rotation-select"].value;
}

function rotationLabel(mode) {
  const labels = {
    auto: "Авто",
    0: "Без поворота",
    90: "90° вправо",
    180: "180°",
    270: "90° влево",
  };
  return labels[String(mode)] ?? "Авто";
}

function updatePageRotationControls() {
  const document = currentDocument();
  const override = document?.pageRotationOverrides[String(state.selectedPage)];
  const mode = override ?? elements["rotation-select"].value;
  elements["page-rotation-label"].textContent = override == null
    ? `По умолчанию: ${rotationLabel(mode)}`
    : rotationLabel(mode);
  elements["rotate-page-left"].disabled = state.running || !document?.pdf;
  elements["rotate-page-right"].disabled = state.running || !document?.pdf;
  elements["reset-page-rotation"].disabled = state.running || !document?.pdf || override == null;
}

async function rotateSelectedPage(delta) {
  const document = currentDocument();
  if (!document?.pdf || state.running) return;
  const page = await document.pdf.getPage(state.selectedPage);
  const displayedViewport = page.getViewport({ scale: 1 });
  const currentMode = rotationModeForPage(state.selectedPage, null, document);
  const currentRotation = resolveAdditionalPageRotation(displayedViewport, currentMode);
  const nextRotation = (currentRotation + delta + 360) % 360;
  document.pageRotationOverrides[String(state.selectedPage)] = String(nextRotation);
  updatePageRotationControls();
  await renderPreview(state.selectedPage);
}

async function selectDocument(documentIndex, pageNumber = 1) {
  const document = state.documents[documentIndex];
  if (!document?.pdf) return;
  state.selectedDocument = documentIndex;
  state.selectedPage = Math.max(1, Math.min(pageNumber, document.pdf.numPages));
  renderDocumentsList();
  initializePageList(document);
  await selectPage(state.selectedPage);
}

async function selectPage(pageNumber) {
  const document = currentDocument();
  if (!document?.pdf || pageNumber < 1 || pageNumber > document.pdf.numPages) return;
  state.selectedPage = pageNumber;
  elements["viewer-document-label"].textContent = document.label;
  elements["viewer-page-label"].textContent = `Страница ${pageNumber}`;
  elements["viewer-position"].textContent = `${pageNumber} / ${document.pdf.numPages}`;
  elements["previous-page"].disabled = pageNumber === 1;
  elements["next-page"].disabled = pageNumber === document.pdf.numPages;
  renderPageList();
  updateTextPanel();
  updatePageRotationControls();
  await renderPreview(pageNumber);
}

async function renderOcrCanvas(page, dpi, rotationMode) {
  const displayedViewport = page.getViewport({ scale: 1 });
  const additionalRotation = resolveAdditionalPageRotation(displayedViewport, rotationMode);
  const rotation = (page.rotate + additionalRotation) % 360;
  const baseViewport = page.getViewport({ scale: 1, rotation });
  const renderPlan = createOcrRenderPlan(baseViewport, dpi);
  const viewport = page.getViewport({ scale: renderPlan.scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  await page.render({ canvasContext: context, viewport }).promise;
  return { canvas, additionalRotation, renderPlan };
}

async function createOcrWorker(dpi) {
  let initializationTimedOut = false;
  let timeoutId;
  const workerPromise = createWorker(["rus", "eng"], 1, {
    workerPath: new URL("./vendor/tesseract/worker.min.js", import.meta.url).href,
    corePath: new URL("./vendor/tesseract/core/", import.meta.url).href,
    langPath: new URL("./vendor/tessdata/", import.meta.url).href,
    workerBlobURL: false,
    cacheMethod: "none",
    gzip: true,
    logger(message) {
      const detail = statusLabels[message.status] ?? message.status;
      const currentProgress = message.status === "recognizing text" ? message.progress : 0;
      const percent = ((completedPageCount() + currentProgress) / Math.max(1, totalPageCount())) * 100;
      const processingDocument = state.documents[state.processingDocument];
      updateProgress({
        percent,
        title: processingDocument ? `${processingDocument.label} · распознавание` : "Подготовка и распознавание",
        detail,
      });
      if (state.processingPage) {
        state.processingDetail = message.status === "recognizing text"
          ? `Распознавание ${Math.round((message.progress ?? 0) * 100)}%`
          : detail;
        renderPageList();
      }
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

async function recognizePage(document, documentIndex, pageNumber, settings) {
  const startedAt = performance.now();
  const page = await document.pdf.getPage(pageNumber);
  const pdfTextLayer = await readPdfTextLayer(page, { skip: settings.forceOcr });

  if (pdfTextLayer.error) {
    console.warn("PDF text layer is unavailable; falling back to OCR:", pdfTextLayer.error);
  }

  if (!pdfTextLayer.skipped && !pdfTextLayer.error && isUsefulPdfText(pdfTextLayer.text)) {
    return {
      number: pageNumber,
      source: "pdf-text",
      text: pdfTextLayer.text,
      confidence: 100,
      lines: [],
      durationMs: Math.round(performance.now() - startedAt),
      pdfRotation: page.rotate,
    };
  }

  const rotationMode = rotationModeForPage(pageNumber, settings, document);
  if (!state.worker) {
    updateProgress({
      percent: (completedPageCount() / Math.max(1, totalPageCount())) * 100,
      title: `${document.label} · подготовка OCR`,
      detail: "Читаются локальные компоненты…",
    });
    state.worker = await createOcrWorker(settings.dpi);
  }
  const { canvas, additionalRotation, renderPlan } = await renderOcrCanvas(
    page,
    settings.dpi,
    rotationMode,
  );
  try {
    await state.worker.setParameters({
      user_defined_dpi: String(Math.round(renderPlan.effectiveDpi)),
    });
    const useDataUrlTransport = !browserCapabilities.canvasToBlob;
    const ocrInput = useDataUrlTransport ? canvas.toDataURL("image/png") : canvas;
    const recognition = await state.worker.recognize(
      ocrInput,
      { rotateAuto: rotationMode === "auto" },
      { text: true, blocks: true },
      `document-${documentIndex + 1}-page-${pageNumber}`,
    );
    const text = normalizeWhitespace(recognition.data.text);
    const lines = flattenOcrLines(recognition.data.blocks, canvas.width, canvas.height);
    const result = {
      number: pageNumber,
      source: "tesseract",
      text,
      confidence: Number.isFinite(recognition.data.confidence) ? recognition.data.confidence : 0,
      lines,
      durationMs: Math.round(performance.now() - startedAt),
      pdfRotation: page.rotate,
      additionalPageRotation: additionalRotation,
      ocrRotationRadians: recognition.data.rotateRadians ?? 0,
      renderedWidth: canvas.width,
      renderedHeight: canvas.height,
      requestedDpi: renderPlan.requestedDpi,
      effectiveDpi: renderPlan.effectiveDpi,
      renderLimited: renderPlan.limited,
    };
    if (pdfTextLayer.error) {
      result.pdfTextLayerError = serializeError(pdfTextLayer.error);
    }
    return result;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    if (typeof page.cleanup === "function") page.cleanup();
  }
}

function readSettings() {
  const rotationMode = elements["rotation-select"].value;
  return {
    dpi: Number(elements["dpi-select"].value),
    forceOcr: elements["force-ocr"].checked,
    autoRotate: rotationMode === "auto",
    rotationMode,
    languages: ["rus", "eng"],
  };
}

async function runOcr() {
  if (!hasReadyDocuments() || state.running) return;
  if (missingBrowserCapabilities.length > 0) {
    setError(
      `Этот браузер не предоставляет необходимые возможности: ${missingBrowserCapabilities.join(", ")}. `
      + "Откройте приложение в актуальном Chrome, Edge или Firefox.",
    );
    return;
  }
  setError("");
  const completedBeforeRun = completedPageCount();
  const totalBeforeRun = totalPageCount();
  const resumeIncompleteRun = completedBeforeRun > 0 && completedBeforeRun < totalBeforeRun;
  if (!resumeIncompleteRun) {
    clearResults({ hideWorkspace: false });
    state.startedAt = new Date().toISOString();
  } else {
    state.processingDocument = null;
    state.processingPage = null;
    state.processingDetail = "";
    updateFormationState();
  }
  state.cancelRequested = false;
  setRunning(true);
  state.processingDetail = "Подготовка OCR";
  await selectDocument(0, 1);

  const settings = readSettings();
  const totalPages = totalPageCount();

  try {
    updateProgress({
      percent: (completedPageCount() / totalPages) * 100,
      title: "Подготовка документов",
      detail: "Проверяется текстовый слой PDF…",
    });

    processing:
    for (const [documentIndex, document] of state.documents.entries()) {
      for (let pageNumber = 1; pageNumber <= document.pdf.numPages; pageNumber += 1) {
        if (state.cancelRequested) break processing;
        if (document.results[pageNumber - 1]) continue;
        state.processingDocument = documentIndex;
        state.processingPage = pageNumber;
        state.processingDetail = "Подготавливается изображение страницы";
        await selectDocument(documentIndex, pageNumber);
        updateProgress({
          percent: (completedPageCount() / totalPages) * 100,
          title: `${document.label} · страница ${pageNumber} из ${document.pdf.numPages}`,
          detail: "Подготавливается изображение страницы",
        });

        try {
          document.results[pageNumber - 1] = await recognizePage(
            document,
            documentIndex,
            pageNumber,
            settings,
          );
        } catch (error) {
          console.error(error);
          document.results[pageNumber - 1] = {
            number: pageNumber,
            source: "error",
            text: "",
            confidence: 0,
            lines: [],
            error: error.message ?? String(error),
            errorDetails: serializeError(error),
          };
        }

        state.processingPage = null;
        state.processingDetail = "";
        renderPageList();
        await selectPage(pageNumber);
        updateProgress({
          percent: (completedPageCount() / totalPages) * 100,
          title: `${document.label} · обработано страниц: ${pageNumber}`,
          detail: pageState(document.results[pageNumber - 1], pageNumber).detail,
        });
      }
    }

    const processed = completedPageCount();
    updateProgress({
      percent: (processed / totalPages) * 100,
      title: state.cancelRequested ? "Распознавание остановлено" : "Распознавание завершено",
      detail: `Обработано ${processed} из ${totalPages} страниц в ${state.documents.length} док.`,
    });
    updateFormationState();
  } catch (error) {
    console.error(error);
    setError(`OCR не запустился: ${error.message ?? error}`);
  } finally {
    await state.worker?.terminate().catch(console.error);
    state.worker = null;
    state.processingDocument = null;
    state.processingPage = null;
    state.processingDetail = "";
    setRunning(false);
    renderPageList();
    updateFormationState();
  }
}

function buildDocumentResult() {
  const settings = readSettings();
  return {
    schemaVersion: "contractility.ocr.v2",
    createdAt: new Date().toISOString(),
    startedAt: state.startedAt,
    documentCount: state.documents.length,
    documents: state.documents.map((document, index) => ({
      id: document.id,
      role: document.role,
      label: document.label,
      order: index + 1,
      file: {
        name: document.file.name,
        size: document.file.size,
        lastModified: new Date(document.file.lastModified).toISOString(),
        sha256: document.fileHash,
      },
      pageCount: document.pdf.numPages,
      pageRotationOverrides: { ...document.pageRotationOverrides },
      complete: document.results.filter(Boolean).length === document.pdf.numPages
        && document.results.every((page) => page && !page.error),
      pages: document.results.filter(Boolean),
    })),
    engine: {
      pdf: "pdfjs-dist@6.1.200",
      ocr: "tesseract.js@7.0.0",
      models: ["rus@4.0.0_best_int", "eng@4.0.0_best_int"],
      browserCapabilities,
      browserEnvironment,
    },
    settings,
    complete: isOcrComplete(),
  };
}

function buildCurrentFormationRequest() {
  if (!state.draftAgreement) {
    throw new TypeError("Загрузите новую редакцию дополнительного соглашения DOCX.");
  }
  const { file, sha256: draftSha256 } = state.draftAgreement;
  return buildFormationRequest({
    ocrResult: buildDocumentResult(),
    draftAgreement: {
      name: file.name,
      size: file.size,
      lastModified: new Date(file.lastModified).toISOString(),
      sha256: draftSha256,
    },
  });
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
  return state.documents[0]?.file.name.replace(/\.pdf$/i, "") ?? "contract";
}

elements["file-input"].addEventListener("change", (event) => loadDocuments(event.target.files));
elements["add-files-button"].addEventListener("click", () => {
  elements["additional-file-input"].value = "";
  elements["additional-file-input"].click();
});
elements["additional-file-input"].addEventListener("change", (event) => {
  loadDocuments(event.target.files, { append: true });
});
elements["draft-file-input"].addEventListener("change", (event) => {
  loadDraftAgreement(event.target.files).catch((error) => {
    console.error(error);
    setError(`Не удалось прочитать DOCX: ${error.message ?? error}`);
  });
});
elements["reset-button"].addEventListener("click", resetDocuments);
elements["start-button"].addEventListener("click", runOcr);
elements["cancel-button"].addEventListener("click", () => {
  state.cancelRequested = true;
  elements["cancel-button"].disabled = true;
  elements["cancel-button"].textContent = "Останавливается…";
});
elements["previous-page"].addEventListener("click", () => selectPage(state.selectedPage - 1));
elements["next-page"].addEventListener("click", () => selectPage(state.selectedPage + 1));
elements["overlay-toggle"].addEventListener("change", () => {
  renderOverlay(currentDocument()?.results[state.selectedPage - 1]?.lines ?? []);
});
elements["rotation-select"].addEventListener("change", () => {
  updatePageRotationControls();
  if (currentDocument()?.pdf) renderPreview(state.selectedPage).catch(console.error);
});
elements["rotate-page-left"].addEventListener("click", () => rotateSelectedPage(-90).catch(console.error));
elements["rotate-page-right"].addEventListener("click", () => rotateSelectedPage(90).catch(console.error));
elements["reset-page-rotation"].addEventListener("click", () => {
  const document = currentDocument();
  if (!document) return;
  delete document.pageRotationOverrides[String(state.selectedPage)];
  updatePageRotationControls();
  renderPreview(state.selectedPage).catch(console.error);
});
elements["page-text"].addEventListener("input", () => {
  const result = currentDocument()?.results[state.selectedPage - 1];
  if (!result) return;
  result.text = elements["page-text"].value;
  result.manuallyEdited = true;
  elements["edit-note"].hidden = false;
  renderPageList();
});
elements["download-json"].addEventListener("click", () => {
  try {
    const result = buildCurrentFormationRequest();
    download(
      `${baseFileName()}.formation-request.json`,
      "application/json",
      `${JSON.stringify(result, null, 2)}\n`,
    );
  } catch (error) {
    setError(error.message ?? String(error));
  }
});
elements["download-text"].addEventListener("click", () => {
  try {
    const result = buildCurrentFormationRequest();
    download(
      `${baseFileName()}.formation-request.txt`,
      "text/plain;charset=utf-8",
      createFormationTextExport(result),
    );
  } catch (error) {
    setError(error.message ?? String(error));
  }
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
elements["drop-zone"].addEventListener("drop", (event) => loadDocuments(event.dataTransfer.files));

for (const eventName of ["dragenter", "dragover"]) {
  elements["draft-drop-zone"].addEventListener(eventName, (event) => {
    event.preventDefault();
    elements["draft-drop-zone"].classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements["draft-drop-zone"].addEventListener(eventName, (event) => {
    event.preventDefault();
    elements["draft-drop-zone"].classList.remove("dragging");
  });
}
elements["draft-drop-zone"].addEventListener("drop", (event) => {
  loadDraftAgreement(event.dataTransfer.files).catch((error) => {
    console.error(error);
    setError(`Не удалось прочитать DOCX: ${error.message ?? error}`);
  });
});

window.addEventListener("resize", () => {
  if (currentDocument()?.pdf) renderPreview(state.selectedPage).catch(console.error);
});
