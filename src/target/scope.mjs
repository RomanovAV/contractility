function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} должен быть непустой строкой.`);
  }
}

function normalizedContractNumber(value) {
  return String(value)
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/^\s*(?:№|N(?:O|º)?\.?)\s*/u, "")
    .replace(/\s+/gu, "")
    .replace(/^[("'«».,;:]+|[)"'«».,;:]+$/gu, "");
}

function normalizedContractDate(value) {
  const text = String(value).normalize("NFKC").trim();
  const numeric = text.match(
    /(?:^|\D)(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?:\D|$)/u,
  );
  if (!numeric) {
    return text.toUpperCase().replace(/\s+/gu, "").replace(/[.,;:]+$/gu, "");
  }
  const [, day, month, sourceYear] = numeric;
  const year = sourceYear.length === 2 ? `20${sourceYear}` : sourceYear;
  return `${day.padStart(2, "0")}.${month.padStart(2, "0")}.${year}`;
}

export function validateReconstructionScope(scope, evidenceManifest) {
  if (scope?.schemaVersion !== "contractility.reconstruction-scope.v1") {
    throw new TypeError("Некорректная schemaVersion в reconstruction-scope.json.");
  }
  const baseDocument = evidenceManifest.documents?.find(
    (document) => document.role === "contract",
  );
  if (!baseDocument || scope.baseContract?.sourceDocumentId !== baseDocument.id) {
    throw new TypeError(
      "reconstruction-scope.json должен идентифицировать исходный договор.",
    );
  }
  requireNonEmptyString(scope.baseContract.number, "baseContract.number");
  requireNonEmptyString(scope.baseContract.date, "baseContract.date");
  requireNonEmptyString(scope.baseContract.evidence, "baseContract.evidence");
  if (
    !Number.isInteger(scope.baseContract.page)
    || scope.baseContract.page < 1
    || scope.baseContract.page > baseDocument.pageCount
  ) {
    throw new TypeError("baseContract.page находится вне страниц исходного договора.");
  }
  if (!Array.isArray(scope.instruments)) {
    throw new TypeError("reconstruction-scope.json должен содержать массив instruments.");
  }
  const amendmentDocuments = evidenceManifest.documents.filter(
    (document) => document.role === "additional-agreement",
  );
  const documentsById = new Map(
    amendmentDocuments.map((document) => [document.id, document]),
  );
  const coveredDocumentIds = new Set();
  const baseNumber = normalizedContractNumber(scope.baseContract.number);
  const baseDate = normalizedContractDate(scope.baseContract.date);
  for (const [index, instrument] of scope.instruments.entries()) {
    const label = `instruments[${index}]`;
    const sourceDocument = documentsById.get(instrument?.sourceDocumentId);
    if (!sourceDocument) {
      throw new TypeError(`${label}.sourceDocumentId отсутствует в OCR-evidence.`);
    }
    coveredDocumentIds.add(sourceDocument.id);
    if (
      !Array.isArray(instrument.pages)
      || instrument.pages.length === 0
      || new Set(instrument.pages).size !== instrument.pages.length
      || instrument.pages.some(
        (page) => !Number.isInteger(page) || page < 1 || page > sourceDocument.pageCount,
      )
    ) {
      throw new TypeError(`${label}.pages содержит недопустимые страницы.`);
    }
    requireNonEmptyString(instrument.agreementNumber, `${label}.agreementNumber`);
    requireNonEmptyString(instrument.agreementDate, `${label}.agreementDate`);
    requireNonEmptyString(
      instrument.referencedContractNumber,
      `${label}.referencedContractNumber`,
    );
    requireNonEmptyString(
      instrument.referencedContractDate,
      `${label}.referencedContractDate`,
    );
    if (!["included", "excluded"].includes(instrument.decision)) {
      throw new TypeError(`${label}.decision должен быть included или excluded.`);
    }
    requireNonEmptyString(instrument.reason, `${label}.reason`);
    const referencesBaseContract =
      normalizedContractNumber(instrument.referencedContractNumber) === baseNumber
      && normalizedContractDate(instrument.referencedContractDate) === baseDate;
    if (instrument.decision === "included" && !referencesBaseContract) {
      throw new TypeError(
        `${label} включён, хотя номер или дата базового договора не совпадают.`,
      );
    }
    if (instrument.decision === "excluded" && referencesBaseContract) {
      throw new TypeError(
        `${label} исключён, хотя номер и дата базового договора совпадают.`,
      );
    }
  }
  const missingDocuments = amendmentDocuments
    .filter((document) => !coveredDocumentIds.has(document.id))
    .map((document) => document.id);
  if (missingDocuments.length > 0) {
    throw new TypeError(
      `reconstruction-scope.json не классифицирует документы: ${missingDocuments.join(", ")}.`,
    );
  }
  return scope;
}
