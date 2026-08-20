const SNAPSHOT_SCHEMA = "contractility.workspace-snapshot.v1";
const MAX_EMBEDDED_FILE_BYTES = 1024 * 1024 * 1024;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} должен быть JSON-объектом.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} должен быть непустой строкой.`);
  }
  return value;
}

function requireSha256(value, label) {
  const sha256 = requireString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new TypeError(`${label} должен быть SHA-256 в hex-формате.`);
  }
  return sha256.toLowerCase();
}

function binaryMetadata(file, sha256) {
  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    lastModified: Number(file.lastModified) || 0,
    sha256,
  };
}

export function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value, label = "binary.dataBase64") {
  const encoded = requireString(value, label);
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new TypeError(`${label} содержит некорректный base64.`);
  }
  const estimatedSize = Math.floor(encoded.length * 3 / 4);
  if (estimatedSize > MAX_EMBEDDED_FILE_BYTES) {
    throw new TypeError(`${label} превышает допустимый размер.`);
  }
  let binary;
  try {
    binary = atob(encoded);
  } catch {
    throw new TypeError(`${label} содержит некорректный base64.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function snapshotBinary(file, sha256) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new TypeError("Для снимка требуется исходный файл с arrayBuffer().");
  }
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength !== file.size) {
    throw new TypeError(`Размер файла «${file.name}» изменился во время сохранения.`);
  }
  return {
    file: binaryMetadata(file, requireSha256(sha256, `SHA-256 файла «${file.name}»`)),
    dataBase64: bytesToBase64(buffer),
  };
}

export async function createWorkspaceSnapshot({
  ocrResult,
  documents,
  draftAgreement = null,
  createdAt = new Date().toISOString(),
}) {
  requireObject(ocrResult, "ocrResult");
  if (ocrResult.schemaVersion !== "contractility.ocr.v2" || ocrResult.complete !== true) {
    throw new TypeError("Сохранить можно только полностью распознанный OCR-комплект.");
  }
  if (!Array.isArray(documents) || documents.length !== ocrResult.documents?.length) {
    throw new TypeError("Исходные PDF не соответствуют OCR-комплекту.");
  }
  const retainedOcrResult = typeof structuredClone === "function"
    ? structuredClone(ocrResult)
    : JSON.parse(JSON.stringify(ocrResult));
  const signedDocuments = [];
  for (const [index, document] of documents.entries()) {
    const ocrDocument = retainedOcrResult.documents[index];
    if (document.id !== ocrDocument?.id) {
      throw new TypeError("Порядок исходных PDF не соответствует OCR-комплекту.");
    }
    signedDocuments.push({
      documentId: document.id,
      ...await snapshotBinary(document.file, document.fileHash),
    });
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    createdAt,
    ocrResult: retainedOcrResult,
    signedDocuments,
    draftAgreement: draftAgreement
      ? await snapshotBinary(draftAgreement.file, draftAgreement.sha256)
      : null,
  };
}

function validateBinaryEntry(value, label) {
  const entry = requireObject(value, label);
  const file = requireObject(entry.file, `${label}.file`);
  requireString(file.name, `${label}.file.name`);
  requireString(file.type, `${label}.file.type`);
  file.sha256 = requireSha256(file.sha256, `${label}.file.sha256`);
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > MAX_EMBEDDED_FILE_BYTES) {
    throw new TypeError(`${label}.file.size недопустим.`);
  }
  if (!Number.isFinite(file.lastModified) || file.lastModified < 0) {
    throw new TypeError(`${label}.file.lastModified недопустим.`);
  }
  const bytes = base64ToBytes(entry.dataBase64, `${label}.dataBase64`);
  if (bytes.byteLength !== file.size) {
    throw new TypeError(`${label}: размер вложенного файла не совпадает с метаданными.`);
  }
  return { file: { ...file }, bytes };
}

export function parseWorkspaceSnapshot(value) {
  const snapshot = requireObject(value, "Снимок");
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA) {
    throw new TypeError(`Ожидалась схема ${SNAPSHOT_SCHEMA}.`);
  }
  const ocrResult = requireObject(snapshot.ocrResult, "ocrResult");
  if (
    ocrResult.schemaVersion !== "contractility.ocr.v2"
    || ocrResult.complete !== true
    || !Array.isArray(ocrResult.documents)
    || ocrResult.documents.length === 0
  ) {
    throw new TypeError("Снимок не содержит полностью распознанный OCR-комплект.");
  }
  if (
    !Array.isArray(snapshot.signedDocuments)
    || snapshot.signedDocuments.length !== ocrResult.documents.length
  ) {
    throw new TypeError("Количество PDF в снимке не соответствует OCR-комплекту.");
  }
  const seenIds = new Set();
  const signedDocuments = snapshot.signedDocuments.map((entry, index) => {
    const ocrDocument = requireObject(ocrResult.documents[index], `ocrResult.documents[${index}]`);
    const documentId = requireString(entry?.documentId, `signedDocuments[${index}].documentId`);
    if (seenIds.has(documentId) || documentId !== ocrDocument.id) {
      throw new TypeError("Идентификаторы PDF в снимке не соответствуют OCR-комплекту.");
    }
    seenIds.add(documentId);
    const expectedRole = index === 0 ? "contract" : "additional-agreement";
    if (
      ocrDocument.role !== expectedRole
      || ocrDocument.order !== index + 1
      || typeof ocrDocument.label !== "string"
      || !ocrDocument.label.trim()
    ) {
      throw new TypeError(`Роль или порядок документа ${documentId} повреждены.`);
    }
    if (
      ocrDocument.complete !== true
      || !Number.isInteger(ocrDocument.pageCount)
      || ocrDocument.pageCount < 1
      || !Array.isArray(ocrDocument.pages)
      || ocrDocument.pages.length !== ocrDocument.pageCount
    ) {
      throw new TypeError(`Документ ${documentId} распознан не полностью.`);
    }
    const pageNumbers = new Set();
    for (const page of ocrDocument.pages) {
      if (
        !Number.isInteger(page?.number)
        || page.number < 1
        || page.number > ocrDocument.pageCount
        || pageNumbers.has(page.number)
        || typeof page.text !== "string"
        || page.error
      ) {
        throw new TypeError(`Страницы документа ${documentId} повреждены.`);
      }
      pageNumbers.add(page.number);
    }
    const binary = validateBinaryEntry(entry, `signedDocuments[${index}]`);
    if (
      ocrDocument.file?.sha256 !== binary.file.sha256
      || ocrDocument.file?.name !== binary.file.name
      || ocrDocument.file?.size !== binary.file.size
    ) {
      throw new TypeError(`SHA-256 документа ${documentId} не совпадает внутри снимка.`);
    }
    return {
      documentId,
      ...binary,
    };
  });
  const draftAgreement = snapshot.draftAgreement == null
    ? null
    : validateBinaryEntry(snapshot.draftAgreement, "draftAgreement");
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    createdAt: snapshot.createdAt ?? null,
    ocrResult,
    signedDocuments,
    draftAgreement,
  };
}

export { SNAPSHOT_SCHEMA };
