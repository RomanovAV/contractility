import { copyFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  copyVerified,
  ensurePrivateDirectory,
  readJson,
  requireRegularFile,
  sha256File,
  sha256Text,
} from "./fs-utils.mjs";

export function validateFormationRequest(request) {
  if (request?.schemaVersion !== "contractility.formation-request.v1") {
    throw new TypeError("Ожидалась схема contractility.formation-request.v1.");
  }
  const documents = request.inputs?.signedDocuments;
  const draft = request.inputs?.newAgreementEdition?.file;
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new TypeError("В запросе отсутствуют подписанные документы.");
  }
  if (documents[0]?.role !== "contract") {
    throw new TypeError("Первым подписанным документом должен быть договор.");
  }
  const ids = new Set();
  documents.forEach((document, index) => {
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
  if (!draft?.name || !draft?.sha256 || !Number.isFinite(draft.size)) {
    throw new TypeError("В запросе отсутствует идентичность новой редакции DOCX.");
  }
  if (!request.rules?.requireHumanApprovalBeforeFinalization) {
    throw new TypeError("Финализация без ручного подтверждения запрещена.");
  }
  return request;
}

export async function prepareCase({
  requestPath,
  draftPath,
  sources,
  outputRoot,
}) {
  await requireRegularFile(requestPath);
  await requireRegularFile(draftPath);
  const request = validateFormationRequest(await readJson(requestPath));
  const expectedDocuments = request.inputs.signedDocuments;
  const sourceIds = new Set(Object.keys(sources));
  if (
    sourceIds.size !== expectedDocuments.length
    || expectedDocuments.some((document) => !sourceIds.has(document.id))
  ) {
    throw new TypeError("Нужно передать ровно один --source id=path для каждого подписанного PDF.");
  }
  const requestSha256 = await sha256File(requestPath);
  const draftExpected = request.inputs.newAgreementEdition.file.sha256;
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
    const destination = path.join(signedDirectory, `${document.id}.pdf`);
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
  if (!draftPath.toLowerCase().endsWith(".docx")) {
    throw new TypeError("Новая редакция должна быть DOCX.");
  }
  const draftDestination = path.join(draftDirectory, "new-edition.docx");
  await copyVerified(draftPath, draftDestination, draftExpected);
  const manifest = {
    schemaVersion: "contractility.case-manifest.v1",
    caseId,
    createdAt: new Date().toISOString(),
    formationRequest: {
      path: "formation-request.json",
      sha256: requestSha256,
    },
    signedDocuments: signed,
    newAgreementEdition: {
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
  const requestPath = path.join(caseDirectory, manifest.formationRequest.path);
  if (await sha256File(requestPath) !== manifest.formationRequest.sha256) {
    throw new Error("formation-request.json изменён после подготовки case.");
  }
  for (const document of manifest.signedDocuments) {
    if (await sha256File(path.join(caseDirectory, document.path)) !== document.sha256) {
      throw new Error(`Источник ${document.id} изменён после подготовки case.`);
    }
  }
  const draftPath = path.join(caseDirectory, manifest.newAgreementEdition.path);
  if (await sha256File(draftPath) !== manifest.newAgreementEdition.sha256) {
    throw new Error("Новая редакция DOCX изменена после подготовки case.");
  }
  return { manifest, requestPath, draftPath };
}
