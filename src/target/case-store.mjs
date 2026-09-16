import { copyFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  copyVerified,
  ensurePrivateDirectory,
  readJson,
  requireRegularFile,
  resolveWithinDirectory,
  sha256File,
  sha256Text,
} from "./fs-utils.mjs";

import { validateMasterContract, validateMasterStructure } from "../../public/master-contract.mjs";
import { validateReconstructionScope } from "./scope.mjs";

const SAFE_DOCUMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/;

export function validateDocumentId(value) {
  if (typeof value !== "string" || !SAFE_DOCUMENT_ID.test(value)) {
    throw new TypeError("Некорректный идентификатор документа.");
  }
  return value;
}

export function validateFormationRequest(request) {
  if (request?.schemaVersion !== "contractility.formation-request.v1") {
    throw new TypeError("Ожидалась схема contractility.formation-request.v1.");
  }
  const stage = request.workflowStage ?? "full";
  if (!["full", "master", "agreement"].includes(stage)) throw new TypeError("Неизвестный этап формирования.");
  const master = request.inputs?.masterContract;
  if (stage === "agreement") validateMasterStructure(master);
  else if (master) throw new TypeError("Мастер-договор допустим только на этапе подготовки ДС.");
  if (stage === "agreement" && (!Array.isArray(request.inputs?.signedDocuments) || request.inputs.signedDocuments.length !== 0)) {
    throw new TypeError("Используйте проверенный мастер-договор без нового комплекта PDF.");
  }
  if (stage === "master" && request.inputs?.newAgreementEdition) {
    throw new TypeError("Драфт не входит в этап подготовки мастер-договора.");
  }
  const documents = master?.payload.signedDocuments ?? request.inputs?.signedDocuments;
  const draft = request.inputs?.newAgreementEdition?.file;
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new TypeError("В запросе отсутствуют подписанные документы.");
  }
  if (documents[0]?.role !== "contract") {
    throw new TypeError("Первым подписанным документом должен быть договор.");
  }
  const ids = new Set();
  documents.forEach((document, index) => {
    validateDocumentId(document?.id);
    if (
      !document?.id
      || ids.has(document.id)
      || document.order !== index + 1
      || !document.file?.sha256
      || !document.file?.name
    ) {
      throw new TypeError(`Некорректный подписанный документ в позиции ${index + 1}.`);
    }
    if (index > 0 && document.role !== "additional-agreement") {
      throw new TypeError(`Документ ${document.id} должен быть дополнительным соглашением.`);
    }
    if (!document.complete || !Array.isArray(document.pages) || document.pages.length === 0) {
      throw new TypeError(`OCR документа ${document.id} не завершён.`);
    }
    ids.add(document.id);
  });
  if (stage !== "master" && (!draft?.name || !draft?.sha256 || !Number.isFinite(draft.size))) {
    throw new TypeError("В запросе отсутствует идентичность предлагаемого допсоглашения DOCX.");
  }
  if (master) validateReconstructionScope(master.payload.reconstructionScope, { documents: documents.map((document) => ({ ...document, pageCount: document.pages.length })) });
  if (!request.rules?.requireHumanApprovalBeforeFinalization) {
    throw new TypeError("Финализация без ручного подтверждения запрещена.");
  }
  return request;
}

export async function prepareCase({
  requestPath,
  draftPath,
  sources = {},
  outputRoot,
}) {
  await requireRegularFile(requestPath);
  const request = validateFormationRequest(await readJson(requestPath));
  const masterOnly = request.workflowStage === "master";
  if (!masterOnly) await requireRegularFile(draftPath);
  if (request.inputs.masterContract) await validateMasterContract(request.inputs.masterContract);
  const expectedDocuments = request.inputs.signedDocuments;
  const sourceIds = new Set(Object.keys(sources));
  if (
    sourceIds.size !== expectedDocuments.length
    || expectedDocuments.some((document) => !sourceIds.has(document.id))
  ) {
    throw new TypeError("Нужно передать ровно один --source id=path для каждого подписанного PDF.");
  }
  const requestSha256 = await sha256File(requestPath);
  const draftExpected = request.inputs.newAgreementEdition?.file.sha256 ?? "master";
  const caseId = `case-${sha256Text(`${requestSha256}:${draftExpected}`).slice(0, 20)}`;
  const caseDirectory = path.resolve(outputRoot, caseId);
  await ensurePrivateDirectory(caseDirectory);
  const inputDirectory = path.join(caseDirectory, "inputs");
  const signedDirectory = path.join(inputDirectory, "signed");
  const draftDirectory = path.join(inputDirectory, "draft");
  await Promise.all([
    ensurePrivateDirectory(signedDirectory),
    ensurePrivateDirectory(draftDirectory),
  ]);

  const requestDestination = path.join(caseDirectory, "formation-request.json");
  await copyFile(requestPath, requestDestination);
  const signed = [];
  for (const document of expectedDocuments) {
    const sourcePath = path.resolve(sources[document.id]);
    await requireRegularFile(sourcePath);
    if (!sourcePath.toLowerCase().endsWith(".pdf")) {
      throw new TypeError(`Источник ${document.id} должен быть PDF.`);
    }
    const destination = resolveWithinDirectory(signedDirectory, `${document.id}.pdf`);
    await copyVerified(sourcePath, destination, document.file.sha256);
    signed.push({
      id: document.id,
      role: document.role,
      order: document.order,
      path: path.relative(caseDirectory, destination).split(path.sep).join("/"),
      sha256: document.file.sha256,
      originalName: document.file.name,
    });
  }
  if (!masterOnly && !draftPath.toLowerCase().endsWith(".docx")) {
    throw new TypeError("Предлагаемое допсоглашение должно быть DOCX.");
  }
  const draftDestination = path.join(draftDirectory, "new-edition.docx");
  if (!masterOnly) await copyVerified(draftPath, draftDestination, draftExpected);
  const manifest = {
    schemaVersion: "contractility.case-manifest.v1",
    caseId,
    createdAt: new Date().toISOString(),
    formationRequest: {
      path: "formation-request.json",
      sha256: requestSha256,
    },
    signedDocuments: signed,
    workflowStage: request.workflowStage ?? "full",
    newAgreementEdition: masterOnly ? null : {
      path: "inputs/draft/new-edition.docx",
      sha256: draftExpected,
      originalName: request.inputs.newAgreementEdition.file.name,
    },
  };
  await atomicWriteJson(path.join(caseDirectory, "case-manifest.json"), manifest);
  await stat(caseDirectory);
  return { caseId, caseDirectory, manifest };
}

export async function verifyCase(caseDirectory) {
  const manifest = await readJson(path.join(caseDirectory, "case-manifest.json"));
  if (manifest?.schemaVersion !== "contractility.case-manifest.v1") {
    throw new TypeError("Некорректный case-manifest.");
  }
  for (const document of manifest.signedDocuments) validateDocumentId(document.id);
  const requestPath = resolveWithinDirectory(caseDirectory, manifest.formationRequest.path);
  if (await sha256File(requestPath) !== manifest.formationRequest.sha256) {
    throw new Error("formation-request.json изменён после подготовки case.");
  }
  for (const document of manifest.signedDocuments) {
    if (await sha256File(resolveWithinDirectory(caseDirectory, document.path)) !== document.sha256) {
      throw new Error(`Источник ${document.id} изменён после подготовки case.`);
    }
  }
  const request = validateFormationRequest(await readJson(requestPath));
  if (request.inputs.masterContract) await validateMasterContract(request.inputs.masterContract);
  if ((manifest.workflowStage ?? "full") !== (request.workflowStage ?? "full")) throw new Error("Этап case не совпадает с запросом.");
  const requestDraft = request.inputs.newAgreementEdition?.file;
  if (Boolean(manifest.newAgreementEdition) !== Boolean(requestDraft)
    || (requestDraft && manifest.newAgreementEdition.sha256 !== requestDraft.sha256)
    || manifest.signedDocuments.length !== request.inputs.signedDocuments.length
    || manifest.signedDocuments.some((document, index) => document.id !== request.inputs.signedDocuments[index].id
      || document.sha256 !== request.inputs.signedDocuments[index].file.sha256)) {
    throw new Error("Манифест case не соответствует входам запроса.");
  }
  const draftPath = manifest.newAgreementEdition ? resolveWithinDirectory(caseDirectory, manifest.newAgreementEdition.path) : null;
  if (draftPath && await sha256File(draftPath) !== manifest.newAgreementEdition.sha256) {
    throw new Error("Предлагаемое допсоглашение DOCX изменено после подготовки case.");
  }
  return { manifest, requestPath, draftPath };
}
