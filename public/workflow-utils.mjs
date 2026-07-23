import { createTextExport } from "./ocr-utils.mjs";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_COMPATIBLE_MIME_TYPES = new Set([
  "",
  DOCX_MIME,
  "application/octet-stream",
  "application/zip",
]);

export function validateDraftAgreementFile(file) {
  if (!file) {
    return "Выберите новую редакцию дополнительного соглашения в формате DOCX.";
  }
  if (!String(file.name ?? "").toLowerCase().endsWith(".docx")) {
    return `Файл «${file.name ?? "без имени"}» должен быть в формате DOCX.`;
  }
  if (!DOCX_COMPATIBLE_MIME_TYPES.has(String(file.type ?? "").toLowerCase())) {
    return `Файл «${file.name}» не распознан как документ Word DOCX.`;
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return `Файл «${file.name}» пуст.`;
  }
  return "";
}

export function normalizeDocumentOrder(documents) {
  return documents.map((document, index) => ({
    ...document,
    id: document.id ?? `document-${index + 1}`,
    role: index === 0 ? "contract" : "additional-agreement",
    label: index === 0 ? "Исходный договор" : `Подписанное доп. соглашение ${index}`,
  }));
}

export function moveHistoricalDocument(documents, index, direction) {
  if (!Array.isArray(documents) || index <= 0 || index >= documents.length) {
    return documents;
  }
  const targetIndex = index + direction;
  if (targetIndex <= 0 || targetIndex >= documents.length) {
    return documents;
  }
  const reordered = [...documents];
  [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
  return normalizeDocumentOrder(reordered);
}

function requireCompleteOcr(ocrResult) {
  if (!ocrResult?.complete || !Array.isArray(ocrResult.documents) || ocrResult.documents.length === 0) {
    throw new TypeError("Для формирования требуется полностью распознанный комплект PDF.");
  }
  if (ocrResult.documents[0]?.role !== "contract") {
    throw new TypeError("Первым документом должен быть исходный подписанный договор.");
  }
  if (ocrResult.documents.slice(1).some((document) => document.role !== "additional-agreement")) {
    throw new TypeError("После договора допускаются только подписанные дополнительные соглашения.");
  }
}

export function buildFormationRequest({
  ocrResult,
  draftAgreement,
  createdAt = new Date().toISOString(),
}) {
  requireCompleteOcr(ocrResult);
  if (!draftAgreement?.sha256 || !draftAgreement?.name) {
    throw new TypeError("Для формирования требуется новая редакция дополнительного соглашения DOCX.");
  }

  return {
    schemaVersion: "contractility.formation-request.v1",
    createdAt,
    inputs: {
      signedDocuments: ocrResult.documents,
      newAgreementEdition: {
        role: "new-agreement-edition",
        file: {
          name: draftAgreement.name,
          size: draftAgreement.size,
          lastModified: draftAgreement.lastModified,
          sha256: draftAgreement.sha256,
        },
        contentIncluded: false,
        handling: "Передать исходный DOCX отдельным файлом и проверить SHA-256 перед обработкой.",
      },
    },
    workflow: [
      {
        order: 1,
        action: "reconstruct-current-contract",
        instruction: "Взять исходный подписанный договор за базу.",
      },
      {
        order: 2,
        action: "apply-signed-amendments",
        instruction: "Последовательно применить все подписанные дополнительные соглашения в указанном порядке.",
      },
      {
        order: 3,
        action: "compare-new-edition",
        instruction: "Сопоставить новую редакцию DOCX с реконструированной действующей редакцией договора.",
      },
      {
        order: 4,
        action: "generate-final-agreement",
        instruction: "Создать финальное дополнительное соглашение, содержащее только необходимые изменения к действующей редакции.",
      },
    ],
    rules: {
      amendmentOrder: "strict-input-order",
      conflictResolution: "later-signed-amendment-wins",
      preserveSourceMeaning: true,
      doNotTreatDraftAsSigned: true,
      preserveDocxStructure: true,
      preserveDocxFeatures: [
        "page-layout",
        "styles",
        "tables",
        "headers-and-footers",
        "footnotes",
        "numbering",
        "fields",
        "relationships",
      ],
      requireEvidenceForEveryChange: true,
      requireHumanApprovalBeforeFinalization: true,
    },
    expectedOutput: {
      currentContractEdition: "Полная действующая редакция после всех подписанных изменений.",
      changeRegister: "Операции с источником, пунктом назначения и уровнем уверенности.",
      unresolvedIssues: "Коллизии, пропуски OCR и неоднозначности для ручного решения.",
      finalAgreementDocx: "Финальный DOCX на основе отдельно переданной новой редакции.",
    },
    provenance: {
      ocrSchemaVersion: ocrResult.schemaVersion,
      ocrCreatedAt: ocrResult.createdAt,
      sourceDocumentCount: ocrResult.documents.length,
    },
  };
}

export function createFormationTextExport(formationRequest) {
  const workflow = formationRequest.workflow
    .map((step) => `${step.order}. ${step.instruction}`)
    .join("\n");
  const draft = formationRequest.inputs.newAgreementEdition.file;
  const sourceText = createTextExport({
    documents: formationRequest.inputs.signedDocuments,
  }).trimEnd();
  return [
    "######## ЗАДАНИЕ НА ФОРМИРОВАНИЕ ДОПОЛНИТЕЛЬНОГО СОГЛАШЕНИЯ ########",
    workflow,
    "",
    `Новая редакция DOCX: ${draft.name}`,
    `SHA-256 DOCX: ${draft.sha256}`,
    "DOCX передаётся отдельным файлом и не является подписанным документом.",
    "",
    "######## РАСПОЗНАННЫЕ ПОДПИСАННЫЕ ДОКУМЕНТЫ ########",
    sourceText,
    "",
  ].join("\n");
}
