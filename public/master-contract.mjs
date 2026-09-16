export const MASTER_SCHEMA = "contractility.master-contract.v1";

export async function masterPayloadHash(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateMasterStructure(master, { requireApproval = true } = {}) {
  if (master?.schemaVersion !== MASTER_SCHEMA
    || typeof master.payload?.currentContract !== "string"
    || master.payload.currentContract.trim().length < 100
    || master.payload.reconstructionScope?.schemaVersion !== "contractility.reconstruction-scope.v1"
    || !Array.isArray(master.payload.signedDocuments)
    || !master.payload.signedDocuments.length
    || !/^[a-f0-9]{64}$/.test(master.sha256 ?? "")) {
    throw new TypeError("Некорректный файл мастер-договора.");
  }
  const { signedDocuments, reconstructionScope } = master.payload;
  const ids = new Set();
  for (const [index, document] of signedDocuments.entries()) {
    if (!document || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(document.id ?? "")
      || ids.has(document.id) || document.order !== index + 1
      || document.role !== (index === 0 ? "contract" : "additional-agreement")
      || document.complete !== true || typeof document.file?.name !== "string" || !document.file.name
      || !/^[a-f0-9]{64}$/i.test(document.file?.sha256 ?? "")
      || !Array.isArray(document.pages) || !document.pages.length
      || document.pages.some((page, index) => page?.number !== index + 1 || typeof page.text !== "string" || page.error)) {
      throw new TypeError("История источников мастер-договора повреждена.");
    }
    ids.add(document.id);
  }
  const base = reconstructionScope.baseContract;
  if (base?.sourceDocumentId !== signedDocuments[0].id
    || ![base.number, base.date, base.evidence].every((value) => typeof value === "string" && value.trim())
    || !Number.isInteger(base.page) || base.page < 1 || base.page > signedDocuments[0].pages.length
    || !Array.isArray(reconstructionScope.instruments)
    || reconstructionScope.instruments.some((item) => !item || !ids.has(item.sourceDocumentId)
      || !["included", "excluded", "unresolved"].includes(item.decision)
      || !Array.isArray(item.pages) || !item.pages.length || item.pages.some((number) => !Number.isInteger(number) || number < 1)
      || ![item.agreementNumber, item.agreementDate, item.reason].every((value) => typeof value === "string" && value.trim()))) {
    throw new TypeError("История применения допсоглашений повреждена.");
  }
  if (requireApproval || master.approval != null) {
    if (typeof master.approval?.approver !== "string" || !master.approval.approver.trim()
      || !Number.isFinite(Date.parse(master.approval.approvedAt))
      || master.approval.sha256 !== master.sha256) {
      throw new TypeError("Мастер-договор должен быть проверен и подтверждён человеком.");
    }
  }
  return master;
}

export async function validateMasterContract(master, options) {
  validateMasterStructure(master, options);
  if (await masterPayloadHash(master.payload) !== master.sha256) {
    throw new TypeError("Мастер-договор изменён после проверки: SHA-256 не совпадает.");
  }
  return master;
}

export async function createMasterContract(payload) {
  return {
    schemaVersion: MASTER_SCHEMA,
    createdAt: new Date().toISOString(),
    payload,
    sha256: await masterPayloadHash(payload),
    approval: null,
  };
}
