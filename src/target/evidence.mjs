import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  atomicWriteText,
  ensurePrivateDirectory,
  readJson,
  safeRelativePath,
  sha256File,
  sha256Text,
} from "./fs-utils.mjs";

function normalizedText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function safeDocumentName(document, index) {
  const id = String(document.id ?? `document-${index + 1}`)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${String(index + 1).padStart(3, "0")}-${id || `document-${index + 1}`}.md`;
}

function documentEvidence(document) {
  const pages = document.pages.map((page) => [
    `## Страница ${page.number}`,
    "",
    normalizedText(page.text),
  ].join("\n"));
  return [
    `# ${document.label || (document.role === "contract" ? "Договор" : "Дополнительное соглашение")}`,
    "",
    `- Document ID: ${document.id}`,
    `- Роль: ${document.role}`,
    `- Порядок: ${document.order}`,
    `- Исходный файл: ${document.file.name}`,
    `- SHA-256 исходного файла: ${document.file.sha256}`,
    "",
    ...pages,
    "",
  ].join("\n");
}

export async function materializeEvidenceWorkspace({
  roundDirectory,
  formationRequest,
  sourceRequestSha256,
}) {
  const evidenceDirectory = path.join(roundDirectory, "evidence");
  const documentsDirectory = path.join(evidenceDirectory, "documents");
  await ensurePrivateDirectory(documentsDirectory);

  const documents = [];
  for (const [index, document] of formationRequest.inputs.signedDocuments.entries()) {
    const relativePath = `documents/${safeDocumentName(document, index)}`;
    const content = documentEvidence(document);
    await atomicWriteText(path.join(evidenceDirectory, relativePath), content);
    documents.push({
      id: document.id,
      role: document.role,
      order: document.order,
      originalName: document.file.name,
      sourceSha256: document.file.sha256,
      path: relativePath,
      pageCount: document.pages.length,
      textSha256: sha256Text(content),
    });
  }

  const manifest = {
    schemaVersion: "contractility.evidence-manifest.v1",
    sourceRequestSha256,
    documentCount: documents.length,
    documents,
  };
  const manifestPath = path.join(evidenceDirectory, "manifest.json");
  await atomicWriteJson(manifestPath, manifest);
  return {
    evidenceDirectory,
    manifest,
    manifestSha256: await sha256File(manifestPath),
  };
}

export async function verifyEvidenceWorkspace(
  evidenceDirectory,
  expectedManifestSha256,
) {
  const manifestPath = path.join(evidenceDirectory, "manifest.json");
  if (await sha256File(manifestPath) !== expectedManifestSha256) {
    throw new Error("Манифест OCR-evidence изменён после подготовки раунда.");
  }
  const manifest = await readJson(manifestPath);
  if (
    manifest?.schemaVersion !== "contractility.evidence-manifest.v1"
    || !Array.isArray(manifest.documents)
    || manifest.documentCount !== manifest.documents.length
  ) {
    throw new Error("Некорректный манифест OCR-evidence.");
  }
  const expectedPaths = new Set(["manifest.json"]);
  for (const document of manifest.documents) {
    const relativePath = safeRelativePath(document.path);
    expectedPaths.add(relativePath);
    const actualSha256 = await sha256File(path.join(evidenceDirectory, relativePath));
    if (actualSha256 !== document.textSha256) {
      throw new Error(`OCR-evidence изменён: ${document.id}.`);
    }
  }
  const actualPaths = new Set(["manifest.json"]);
  for (const name of await readdir(path.join(evidenceDirectory, "documents"))) {
    actualPaths.add(`documents/${name}`);
  }
  if (
    actualPaths.size !== expectedPaths.size
    || [...actualPaths].some((relativePath) => !expectedPaths.has(relativePath))
  ) {
    throw new Error("В OCR-evidence появились неожиданные файлы.");
  }
  return manifest;
}
