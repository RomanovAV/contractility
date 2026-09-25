export const OCR_CORRECTIONS_SCHEMA = "contractility.ocr-corrections.v1";

const CORRECTION_BASES = new Set([
  "defined-term",
  "repeated-readable-form",
  "unambiguous-language-context",
]);
const PROTECTED_VALUE_PATTERN = /[\d@%№$€₽]/u;
const MAX_FRAGMENT_LENGTH = 120;
const MAX_FRAGMENT_WORDS = 4;

function nonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} должно быть непустой строкой.`);
  }
  return value.trim();
}

function sourcePage(item, documents, field) {
  const document = documents.get(nonEmptyString(item?.sourceDocumentId, `${field}.sourceDocumentId`));
  if (!document) {
    throw new TypeError(`${field}.sourceDocumentId отсутствует в подписанных источниках.`);
  }
  if (!Number.isInteger(item.page) || item.page < 1) {
    throw new TypeError(`${field}.page должен быть положительным целым числом.`);
  }
  const page = document.pages?.find((candidate) => candidate.number === item.page);
  if (!page || typeof page.text !== "string") {
    throw new TypeError(`${field}.page отсутствует в подписанном источнике.`);
  }
  return page;
}

function validateObservedFragment(item, page, field) {
  const sourceText = nonEmptyString(item.sourceText, `${field}.sourceText`);
  if (!page.text.includes(sourceText)) {
    throw new TypeError(`${field}.sourceText не найден дословно на указанной OCR-странице.`);
  }
  return sourceText;
}

export function validateOcrCorrections(value, signedDocuments) {
  if (value?.schemaVersion !== OCR_CORRECTIONS_SCHEMA
    || !Array.isArray(value.corrections)
    || !Array.isArray(value.unresolved)) {
    throw new TypeError("Некорректный реестр исправлений OCR.");
  }
  const documents = new Map(
    (signedDocuments ?? []).map((document) => [document.id, document]),
  );
  const locations = new Set();
  for (const [index, correction] of value.corrections.entries()) {
    const field = `corrections[${index}]`;
    const page = sourcePage(correction, documents, field);
    const sourceText = validateObservedFragment(correction, page, field);
    const correctedText = nonEmptyString(correction.correctedText, `${field}.correctedText`);
    if (correction.kind !== "lexical" || !CORRECTION_BASES.has(correction.basis)) {
      throw new TypeError(`${field} должен описывать доказуемую лексическую OCR-нормализацию.`);
    }
    if (sourceText === correctedText) {
      throw new TypeError(`${field} не изменяет OCR-фрагмент.`);
    }
    if (sourceText.length > MAX_FRAGMENT_LENGTH || correctedText.length > MAX_FRAGMENT_LENGTH
      || sourceText.split(/\s+/u).length > MAX_FRAGMENT_WORDS
      || correctedText.split(/\s+/u).length > MAX_FRAGMENT_WORDS) {
      throw new TypeError(`${field} выходит за пределы локальной лексической коррекции: `
        + `sourceText и correctedText должны содержать не более ${MAX_FRAGMENT_WORDS} слов `
        + `и ${MAX_FRAGMENT_LENGTH} символов каждый. Оставьте только изменяемый фрагмент.`);
    }
    if (PROTECTED_VALUE_PATTERN.test(sourceText) || PROTECTED_VALUE_PATTERN.test(correctedText)) {
      throw new TypeError(`${field} затрагивает защищённое точное значение.`);
    }
    nonEmptyString(correction.reason, `${field}.reason`);
    const location = `${correction.sourceDocumentId}:${correction.page}:${sourceText}`;
    if (locations.has(location)) {
      throw new TypeError(`${field} дублирует другую OCR-коррекцию.`);
    }
    locations.add(location);
  }
  for (const [index, unresolved] of value.unresolved.entries()) {
    const field = `unresolved[${index}]`;
    const page = sourcePage(unresolved, documents, field);
    validateObservedFragment(unresolved, page, field);
    nonEmptyString(unresolved.reason, `${field}.reason`);
    if (unresolved.marker !== "________________________") {
      throw new TypeError(`${field}.marker должен быть стандартным маркером ручной проверки.`);
    }
  }
  return value;
}
