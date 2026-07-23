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
  mergeDocumentBatch,
  moveHistoricalDocument,
  validateDraftAgreementFile,
} from "./workflow-utils.mjs";

const { createWorker } = Tesseract;

GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url,
).href;

const elements = Object.fromEntries(
  [
    "add-files-button", "additional-file-input", "approve-candidate", "approver-name",
    "cancel-button", "confidence-badge", "consensus-panel", "consensus-summary",
    "documents-list", "download-candidate", "download-final", "download-json",
    "download-preview", "download-text", "draft-drop-zone",
    "draft-file-input", "draft-summary",
    "dpi-select", "drop-zone", "edit-note", "error-banner", "export-card", "file-input",
    "file-summary", "finalize-run", "force-ocr", "formation-run-card",
    "gigacode-activity", "gigacode-activity-detail", "gigacode-activity-time",
    "gigacode-activity-title", "next-page", "ocr-overlay", "overlay-toggle",
    "page-rotation-label", "page-surface", "page-text", "pages-counter", "pages-list",
    "preflight-note", "previous-page", "progress-bar", "progress-card", "progress-detail",
    "progress-percent", "progress-title", "reset-button", "reset-page-rotation",
    "review-round-label", "reviewers-grid", "rotate-page-left", "rotate-page-right",
    "rotation-select", "run-blocker", "run-detail", "run-id-label", "run-stages",
    "run-status-badge", "start-button", "start-formation", "target-status-note",
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
  targetSession: null,
  targetSessionError: null,
  formationBusy: false,
  formationJobId: null,
  formationRunId: null,
  formationRun: null,
  formationPollTimer: null,
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

const reviewerLabels = {
  "contract-reconstruction": "Реконструкция договора",
  "legal-delta": "Юридическая дельта",
  "cross-reference-consistency": "Ссылки и реквизиты",
  "document-fidelity": "Целостность DOCX",
  "evidence-security": "Доказательность и безопасность",
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

function inputsLocked() {
  return state.running || state.loading || Boolean(state.formationJobId);
}

function updateFormationState() {
  const hasOcrResults = completedPageCount() > 0;
  elements["export-card"].hidden = !hasOcrResults && !state.draftAgreement;
  elements["download-json"].disabled = !isFormationReady();
  elements["download-text"].disabled = !isFormationReady();
  const targetReady = Boolean(state.targetSession?.target?.ready);
  elements["start-formation"].disabled = !isFormationReady()
    || !targetReady
    || state.formationBusy
    || Boolean(state.formationJobId);

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

  elements["target-status-note"].className = "target-status-note";
  if (targetReady) {
    const reviewerCount = state.targetSession.target.models.reviewers.length;
    const transcriptStatus = state.targetSession.target.retainAgentTranscripts
      ? " · отладочные transcript-логи включены"
      : "";
    elements["target-status-note"].classList.add("ready");
    elements["target-status-note"].textContent =
      `Конфигурация GigaCode готова: producer, арбитр и ${reviewerCount} независимых рецензентов${transcriptStatus}.`;
  } else if (state.targetSessionError || state.targetSession?.target?.error) {
    elements["target-status-note"].classList.add("failed");
    elements["target-status-note"].textContent =
      `GigaCode недоступен: ${state.targetSessionError ?? state.targetSession.target.error}`;
  } else {
    elements["target-status-note"].textContent = "Проверяется готовность GigaCode…";
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
  const locked = inputsLocked();
  elements["start-button"].disabled = locked || !hasReadyDocuments();
  elements["cancel-button"].hidden = !running;
  elements["reset-button"].disabled = locked;
  elements["add-files-button"].disabled = locked;
  elements["additional-file-input"].disabled = locked;
  elements["file-input"].disabled = locked;
  elements["draft-file-input"].disabled = locked;
  elements["dpi-select"].disabled = locked;
  elements["force-ocr"].disabled = locked;
  elements["rotation-select"].disabled = locked;
  elements["rotate-page-left"].disabled = locked || !document?.pdf;
  elements["rotate-page-right"].disabled = locked || !document?.pdf;
  elements["reset-page-rotation"].disabled = locked
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
      up.disabled = inputsLocked() || index === 1;
      up.addEventListener("click", () => reorderHistoricalDocument(index, -1));
      const down = globalThis.document.createElement("button");
      down.type = "button";
      down.textContent = "↓";
      down.title = "Переместить ниже";
      down.setAttribute("aria-label", `Переместить «${document.file.name}» ниже`);
      down.disabled = inputsLocked() || index === state.documents.length - 1;
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
  if (inputsLocked()) return;
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
  replace.disabled = inputsLocked();
  replace.addEventListener("click", () => {
    elements["draft-file-input"].value = "";
    elements["draft-file-input"].click();
  });
  elements["draft-summary"].append(badge, copy, replace);
  updateFormationState();
}

async function loadDraftAgreement(fileList) {
  if (inputsLocked()) return;
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
  if (inputsLocked()) return;
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
  const pendingDocuments = files.map((file, offset) => {
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
  const documentBatch = mergeDocumentBatch(previousDocuments, pendingDocuments);
  state.documents = documentBatch.documents;
  // Load PDF.js data into the normalized objects owned by state so the preview
  // and OCR observe the loaded PDF rather than stale pre-normalization objects.
  const { addedDocuments } = documentBatch;
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
  if (inputsLocked()) return;
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
  elements["rotate-page-left"].disabled = inputsLocked() || !document?.pdf;
  elements["rotate-page-right"].disabled = inputsLocked() || !document?.pdf;
  elements["reset-page-rotation"].disabled = inputsLocked() || !document?.pdf || override == null;
}

async function rotateSelectedPage(delta) {
  const document = currentDocument();
  if (!document?.pdf || inputsLocked()) return;
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
  if (!hasReadyDocuments() || inputsLocked()) return;
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

async function initializeTargetSession() {
  try {
    const response = await fetch("/api/workflow/session", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Локальный API недоступен.");
    state.targetSession = result;
    state.targetSessionError = null;
  } catch (error) {
    state.targetSession = null;
    state.targetSessionError = error.message ?? String(error);
  }
  updateFormationState();
}

async function workflowFetch(relativePath, options = {}) {
  const token = state.targetSession?.token;
  if (!token) throw new Error("Локальная сессия формирования не инициализирована.");
  const headers = new Headers(options.headers ?? {});
  headers.set("X-Contractility-Token", token);
  headers.set("Accept", "application/json");
  const response = await fetch(`/api/workflow${relativePath}`, {
    ...options,
    cache: "no-store",
    headers,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = (await response.json()).error ?? message;
    } catch {
      // Keep the HTTP status when the response is not JSON.
    }
    throw new Error(message);
  }
  return response;
}

async function workflowJson(relativePath, options = {}) {
  const response = await workflowFetch(relativePath, options);
  return response.json();
}

function setRunStatus(title, detail, tone = "") {
  elements["formation-run-card"].hidden = false;
  elements["run-status-badge"].textContent = title;
  elements["run-status-badge"].className = `run-status-badge${tone ? ` ${tone}` : ""}`;
  elements["run-detail"].textContent = detail;
}

function setRunBlocker(message) {
  elements["run-blocker"].textContent = message;
  elements["run-blocker"].hidden = !message;
}

function renderRunStages(runState) {
  const status = runState?.status ?? "uploading";
  const modes = {
    uploading: ["active", "", "", "", ""],
    created: ["active", "", "", "", ""],
    "inputs-verified": ["complete", "active", "", "", ""],
    "candidate-created": ["complete", "complete", "active", "", ""],
    reviewing: ["complete", "complete", "active", "", ""],
    fixing: ["complete", "complete", "active", "", ""],
    "awaiting-human-approval": ["complete", "complete", "complete", "active", ""],
    approved: ["complete", "complete", "complete", "complete", "active"],
    finalized: ["complete", "complete", "complete", "complete", "complete"],
  };
  const selected = modes[status] ?? modes.reviewing;
  const stages = elements["run-stages"].querySelectorAll("li");
  stages.forEach((stage, index) => {
    stage.classList.toggle("active", selected[index] === "active");
    stage.classList.toggle("complete", selected[index] === "complete");
  });
}

function reviewerTitle(id) {
  return reviewerLabels[id] ?? id;
}

function gigacodeSessionLabel(session) {
  if (session === "producer") return "Формирование кандидата";
  if (session?.startsWith("synthesis:")) return "Арбитр";
  if (session?.startsWith("review-format:")) return "Исправление формата reviewer";
  if (session?.startsWith("review:")) {
    const reviewerId = session.split(":").slice(2).join(":");
    return reviewerTitle(reviewerId);
  }
  return session || "GigaCode";
}

function renderGigacodeStatus(status) {
  const container = elements["gigacode-activity"];
  container.className = "gigacode-activity";
  if (!status) {
    elements["gigacode-activity-title"].textContent = "Ожидается первый запрос к GigaCode";
    elements["gigacode-activity-detail"].textContent =
      "Статус обновляется автоматически раз в секунду.";
    elements["gigacode-activity-time"].textContent = "";
    return;
  }

  const phaseLabels = {
    prepared: "Запрос подготовлен",
    started: "GigaCode начал формировать ответ",
    activity: status.source === "stderr"
      ? "Получено служебное сообщение"
      : "Получен новый фрагмент ответа",
    finished: status.knownCliCancellation
      ? "Известная отмена GigaCode CLI — проверяем сохранённый кандидат"
      : status.ok ? "Ответ GigaCode получен" : "Ответ завершился с ошибкой",
  };
  const active = ["prepared", "started", "activity"].includes(status.phase);
  container.classList.add(
    active || status.knownCliCancellation
      ? "active"
      : status.ok === false ? "failed" : "good",
  );
  elements["gigacode-activity-title"].textContent =
    phaseLabels[status.phase] ?? `Событие GigaCode: ${status.phase}`;
  const details = [
    gigacodeSessionLabel(status.session),
    status.model,
    status.outputChars != null ? `${status.outputChars} симв.` : null,
    status.durationMs != null ? `${Math.round(status.durationMs / 100) / 10} с` : null,
  ].filter(Boolean);
  elements["gigacode-activity-detail"].textContent = details.join(" · ");
  const at = status.at ? new Date(status.at) : null;
  elements["gigacode-activity-time"].textContent =
    at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString("ru-RU") : "";
  elements["gigacode-activity-time"].dateTime = status.at ?? "";
}

function renderReviewers(run) {
  elements["reviewers-grid"].replaceChildren();
  const reports = new Map((run?.reviews ?? []).map((report) => [report.reviewer.id, report]));
  const configured = state.targetSession?.target?.models?.reviewers ?? [];
  const reviewers = configured.length > 0
    ? configured
    : [...reports.values()].map((report) => ({
      id: report.reviewer.id,
      model: report.reviewer.requestedModel,
    }));

  for (const reviewer of reviewers) {
    const report = reports.get(reviewer.id);
    const card = globalThis.document.createElement("article");
    card.className = "reviewer-card";
    const header = globalThis.document.createElement("header");
    const title = globalThis.document.createElement("strong");
    title.textContent = reviewerTitle(reviewer.id);
    const verdict = globalThis.document.createElement("span");
    verdict.className = "reviewer-verdict";
    if (!report) {
      verdict.textContent = "Ожидание";
    } else if (report.verdict === "pass") {
      verdict.classList.add("good");
      verdict.textContent = "Пройдено";
    } else {
      verdict.classList.add("failed");
      verdict.textContent = `${report.findings.length} замеч.`;
    }
    header.append(title, verdict);
    const model = globalThis.document.createElement("span");
    model.className = "reviewer-model";
    model.textContent = reviewer.model ?? report?.reviewer?.requestedModel ?? "модель не указана";
    card.append(header, model);

    if (report?.findings?.length > 0) {
      const list = globalThis.document.createElement("ul");
      list.className = "finding-list";
      for (const finding of report.findings.slice(0, 3)) {
        const item = globalThis.document.createElement("li");
        const severity = globalThis.document.createElement("b");
        severity.textContent = finding.severity;
        item.append(severity, globalThis.document.createTextNode(finding.observed));
        list.append(item);
      }
      if (report.findings.length > 3) {
        const remaining = globalThis.document.createElement("li");
        remaining.textContent = `Ещё замечаний: ${report.findings.length - 3}`;
        list.append(remaining);
      }
      card.append(list);
    }
    elements["reviewers-grid"].append(card);
  }
}

function renderFormationRun(job) {
  state.formationRunId = job.runId ?? state.formationRunId;
  state.formationRun = job.run ?? state.formationRun;
  const run = job.run;
  const runState = run?.state;
  const status = runState?.status;
  elements["run-id-label"].textContent = state.formationRunId ?? job.jobId ?? "";
  elements["review-round-label"].textContent = runState?.round
    ? `Раунд ${runState.round}. Отчёты обновляются после завершения всех рецензентов.`
    : "Отчёты появятся после формирования кандидата.";
  renderRunStages(runState);
  renderReviewers(run);
  renderGigacodeStatus(run?.gigacodeStatus ?? null);

  elements["consensus-panel"].hidden = !run?.consensus;
  elements["consensus-summary"].textContent = run?.consensus?.summary ?? "";
  setRunBlocker(runState?.blocker ?? (job.status === "failed" ? job.error : ""));

  const awaitingApproval = status === "awaiting-human-approval";
  const approved = status === "approved";
  const finalized = status === "finalized";
  const candidateReady = awaitingApproval || approved || finalized;
  elements["download-candidate"].disabled = !candidateReady;
  elements["download-preview"].disabled = !candidateReady;
  elements["approver-name"].disabled = !awaitingApproval;
  elements["approve-candidate"].disabled = !awaitingApproval
    || !elements["approver-name"].value.trim();
  elements["finalize-run"].disabled = !approved;
  elements["download-final"].disabled = !finalized;

  if (job.status === "failed" || status === "failed") {
    setRunStatus("Ошибка", job.error ?? runState?.error ?? "Запуск завершился с ошибкой.", "failed");
  } else if (status === "blocked") {
    setRunStatus("Требуется решение", runState.blocker ?? "Автоматический контур остановлен.", "failed");
  } else if (awaitingApproval) {
    setRunStatus(
      "Нужна проверка",
      "Автоматическое ревью завершено. Скачайте кандидат и PDF-превью, затем подтвердите точные хеши.",
    );
  } else if (approved) {
    setRunStatus("Подтверждено", "Хеши зафиксированы. Можно выпустить финальный DOCX.", "good");
  } else if (finalized) {
    setRunStatus("Готово", "Финальный DOCX сформирован и повторно проверен по SHA-256.", "good");
  } else if (runState) {
    const roundText = runState.round ? ` · раунд ${runState.round}` : "";
    setRunStatus(run.stateLabel, `${run.stateLabel}${roundText}. Не закрывайте страницу.`);
  } else {
    setRunStatus("Запуск", "GigaCode создаёт рабочий каталог и проверяет входные файлы.");
  }
}

function scheduleFormationPoll() {
  clearTimeout(state.formationPollTimer);
  state.formationPollTimer = setTimeout(() => {
    pollFormationJob().catch((error) => {
      state.formationBusy = false;
      setRunBlocker(error.message ?? String(error));
      setRunStatus("Ошибка статуса", "Не удалось получить состояние запуска.", "failed");
      updateFormationState();
    });
  }, 1000);
}

async function pollFormationJob() {
  if (!state.formationJobId) return;
  const job = await workflowJson(`/jobs/${encodeURIComponent(state.formationJobId)}`);
  renderFormationRun(job);
  if (job.status === "running") {
    scheduleFormationPoll();
    return;
  }
  state.formationBusy = false;
  if (
    job.status === "failed"
    || ["blocked", "failed", "finalized"].includes(job.run?.state?.status)
  ) {
    state.formationJobId = null;
  }
  updateFormationState();
  setRunning(false);
}

async function launchFormation() {
  if (!isFormationReady() || !state.targetSession?.target?.ready || state.formationBusy) return;
  const formationRequest = buildCurrentFormationRequest();
  let stageId = null;
  state.formationBusy = true;
  state.formationJobId = "preparing";
  setError("");
  setRunBlocker("");
  renderRunStages(null);
  renderReviewers(null);
  renderGigacodeStatus(null);
  setRunStatus("Загрузка входов", "Создаётся локальный защищённый case bundle.");
  updateFormationState();
  setRunning(false);

  try {
    const staging = await workflowJson("/staging", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formationRequest }),
    });
    stageId = staging.stageId;

    for (const [index, source] of formationRequest.inputs.signedDocuments.entries()) {
      const document = state.documents.find((item) => item.id === source.id);
      if (!document) throw new Error(`Не найден локальный PDF ${source.id}.`);
      setRunStatus(
        "Загрузка входов",
        `Передаётся ${index + 1} из ${formationRequest.inputs.signedDocuments.length} PDF: ${source.file.name}`,
      );
      await workflowFetch(
        `/staging/${encodeURIComponent(stageId)}/signed/${encodeURIComponent(source.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/pdf" },
          body: document.file,
        },
      );
    }

    setRunStatus("Загрузка входов", `Передаётся новая редакция: ${state.draftAgreement.file.name}`);
    await workflowFetch(`/staging/${encodeURIComponent(stageId)}/draft`, {
      method: "PUT",
      headers: {
        "Content-Type": state.draftAgreement.file.type
          || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      body: state.draftAgreement.file,
    });

    setRunStatus("Проверка SHA-256", "Файлы сверяются с результатом OCR и копируются в неизменяемый case.");
    const prepared = await workflowJson(`/staging/${encodeURIComponent(stageId)}/prepare`, {
      method: "POST",
    });
    stageId = null;
    const job = await workflowJson(`/cases/${encodeURIComponent(prepared.caseId)}/runs`, {
      method: "POST",
    });
    state.formationJobId = job.jobId;
    renderFormationRun(job);
    scheduleFormationPoll();
  } catch (error) {
    if (stageId) {
      await workflowFetch(`/staging/${encodeURIComponent(stageId)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
    state.formationBusy = false;
    state.formationJobId = null;
    setRunBlocker(error.message ?? String(error));
    setRunStatus("Запуск не выполнен", "Проверьте сообщение и конфигурацию GigaCode.", "failed");
    updateFormationState();
    setRunning(false);
  }
}

async function refreshFormationRun() {
  if (!state.formationRunId) return;
  const run = await workflowJson(`/runs/${encodeURIComponent(state.formationRunId)}`);
  renderFormationRun({
    status: "completed",
    runId: state.formationRunId,
    run,
  });
  if (["blocked", "failed", "finalized"].includes(run.state?.status)) {
    state.formationJobId = null;
    updateFormationState();
    setRunning(false);
  }
}

async function approveFormationCandidate() {
  const runState = state.formationRun?.state;
  const approver = elements["approver-name"].value.trim();
  if (!state.formationRunId || !runState || !approver) return;
  elements["approve-candidate"].disabled = true;
  try {
    await workflowJson(`/runs/${encodeURIComponent(state.formationRunId)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approver,
        candidateSha256: runState.candidateSha256,
        findingsSha256: runState.findingsSha256,
      }),
    });
    await refreshFormationRun();
  } catch (error) {
    setError(`Не удалось подтвердить кандидат: ${error.message ?? error}`);
    elements["approve-candidate"].disabled = false;
  }
}

async function finalizeFormation() {
  if (!state.formationRunId) return;
  elements["finalize-run"].disabled = true;
  try {
    await workflowJson(`/runs/${encodeURIComponent(state.formationRunId)}/finalize`, {
      method: "POST",
    });
    await refreshFormationRun();
  } catch (error) {
    setError(`Не удалось финализировать документ: ${error.message ?? error}`);
    elements["finalize-run"].disabled = false;
  }
}

async function downloadRunFile(kind) {
  if (!state.formationRunId) return;
  try {
    const response = await workflowFetch(
      `/runs/${encodeURIComponent(state.formationRunId)}/files/${encodeURIComponent(kind)}`,
    );
    const names = {
      candidate: "candidate-additional-agreement.docx",
      preview: "candidate-additional-agreement.pdf",
      final: "final-additional-agreement.docx",
    };
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = globalThis.document.createElement("a");
    anchor.href = url;
    anchor.download = names[kind] ?? "contractility-result";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    setError(`Не удалось скачать результат: ${error.message ?? error}`);
  }
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
elements["start-formation"].addEventListener("click", () => {
  launchFormation().catch((error) => {
    console.error(error);
    setError(`Не удалось запустить формирование: ${error.message ?? error}`);
  });
});
elements["approver-name"].addEventListener("input", () => {
  elements["approve-candidate"].disabled =
    state.formationRun?.state?.status !== "awaiting-human-approval"
    || !elements["approver-name"].value.trim();
});
elements["approve-candidate"].addEventListener("click", () => {
  approveFormationCandidate().catch(console.error);
});
elements["finalize-run"].addEventListener("click", () => {
  finalizeFormation().catch(console.error);
});
elements["download-candidate"].addEventListener("click", () => {
  downloadRunFile("candidate").catch(console.error);
});
elements["download-preview"].addEventListener("click", () => {
  downloadRunFile("preview").catch(console.error);
});
elements["download-final"].addEventListener("click", () => {
  downloadRunFile("final").catch(console.error);
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

renderReviewers(null);
initializeTargetSession().catch(console.error);
