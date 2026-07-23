import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { safeRelativePath, sha256File, sha256Text } from "./fs-utils.mjs";

const execFileAsync = promisify(execFile);
const MAX_ENTRIES = 5000;
const MAX_EXPANDED_BYTES = 150 * 1024 * 1024;
const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "word/document.xml"];
const BLOCKED_PART_PATTERNS = [
  /(^|\/)vbaProject\.bin$/i,
  /(^|\/)activeX\//i,
  /(^|\/)embeddings\//i,
  /(^|\/)oleObject/i,
];
const EDITABLE_PARTS = [
  /^word\/document\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
  /^word\/header\d+\.xml$/,
  /^word\/footer\d+\.xml$/,
];

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    throw new Error(`${command} завершился с ошибкой: ${String(detail).trim()}`);
  }
}

async function walk(root, current = root, result = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`DOCX содержит символическую ссылку: ${absolute}`);
    }
    if (entry.isDirectory()) {
      await walk(root, absolute, result);
    } else if (entry.isFile()) {
      result.push({
        absolute,
        relative: path.relative(root, absolute).split(path.sep).join("/"),
        size: info.size,
      });
    }
  }
  return result;
}

function validateXmlShape(xml, relativePath) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error(`DTD/ENTITY запрещены в ${relativePath}.`);
  }
  const stack = [];
  const tagPattern = /<([^!?][^>]*?)>/g;
  for (const match of xml.matchAll(tagPattern)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("!--") || raw.startsWith("![CDATA[")) continue;
    if (raw.endsWith("/")) continue;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().split(/\s/, 1)[0];
      const expected = stack.pop();
      if (expected !== name) {
        throw new Error(`Нарушена XML-структура ${relativePath}: ожидался </${expected}>.`);
      }
    } else {
      const name = raw.split(/\s/, 1)[0];
      stack.push(name);
    }
  }
  if (stack.length > 0) {
    throw new Error(`Незакрытый XML-тег <${stack.at(-1)}> в ${relativePath}.`);
  }
}

function validateRelationships(xml, relativePath) {
  for (const match of xml.matchAll(/<Relationship\b([^>]+?)\/?>/g)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([A-Za-z:]+)="([^"]*)"/g)].map((item) => [item[1], item[2]]),
    );
    if (
      attributes.TargetMode === "External"
      && !["/hyperlink", "/image"].some((suffix) =>
        String(attributes.Type ?? "").endsWith(suffix))
    ) {
      throw new Error(`Запрещённая внешняя связь в ${relativePath}: ${attributes.Type}`);
    }
  }
}

export async function extractDocx(docxPath, destination) {
  await stat(docxPath);
  const listing = await run("unzip", ["-Z1", docxPath]);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new Error(`Недопустимое количество частей DOCX: ${entries.length}.`);
  }
  for (const entry of entries) {
    const safe = safeRelativePath(entry);
    if (BLOCKED_PART_PATTERNS.some((pattern) => pattern.test(safe))) {
      throw new Error(`DOCX содержит запрещённую часть: ${safe}.`);
    }
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await run("unzip", ["-qq", docxPath, "-d", destination]);
  await validateExtractedPackage(destination);
}

export async function validateExtractedPackage(packageDirectory) {
  const files = await walk(packageDirectory);
  const names = new Set(files.map((file) => file.relative));
  for (const required of REQUIRED_PARTS) {
    if (!names.has(required)) {
      throw new Error(`В DOCX отсутствует обязательная часть: ${required}.`);
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > MAX_ENTRIES || totalBytes > MAX_EXPANDED_BYTES) {
    throw new Error("DOCX превышает допустимый размер после распаковки.");
  }
  for (const file of files) {
    if (BLOCKED_PART_PATTERNS.some((pattern) => pattern.test(file.relative))) {
      throw new Error(`DOCX содержит запрещённую часть: ${file.relative}.`);
    }
    if (file.relative.endsWith(".xml") || file.relative.endsWith(".rels")) {
      const xml = await readFile(file.absolute, "utf8");
      validateXmlShape(xml, file.relative);
      if (file.relative.endsWith(".rels")) validateRelationships(xml, file.relative);
    }
  }
  return { fileCount: files.length, totalBytes };
}

export async function packDocx(packageDirectory, outputPath) {
  await validateExtractedPackage(packageDirectory);
  await rm(outputPath, { force: true });
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await run("zip", ["-q", "-X", "-r", outputPath, "."], { cwd: packageDirectory });
  await run("unzip", ["-tqq", outputPath]);
  return sha256File(outputPath);
}

export async function renderDocx(docxPath, outputDirectory, command = "soffice") {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const profileDirectory = path.join(outputDirectory, ".lo-profile");
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await run(command, [
    `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    outputDirectory,
    docxPath,
  ]);
  const pdfPath = path.join(
    outputDirectory,
    `${path.basename(docxPath, path.extname(docxPath))}.pdf`,
  );
  const info = await stat(pdfPath);
  if (!info.isFile() || info.size < 1000) {
    throw new Error("LibreOffice не создал пригодный PDF для визуальной проверки.");
  }
  return { pdfPath, sha256: await sha256File(pdfPath), size: info.size };
}

export async function packageInventory(packageDirectory) {
  const files = await walk(packageDirectory);
  const inventory = {};
  for (const file of files.sort((left, right) => left.relative.localeCompare(right.relative))) {
    inventory[file.relative] = {
      size: file.size,
      sha256: await sha256File(file.absolute),
    };
  }
  return inventory;
}

export function comparePreservedParts(referenceInventory, candidateInventory) {
  const failures = [];
  for (const [relative, expected] of Object.entries(referenceInventory)) {
    if (EDITABLE_PARTS.some((pattern) => pattern.test(relative))) continue;
    const actual = candidateInventory[relative];
    if (!actual) {
      failures.push(`${relative}: часть удалена`);
    } else if (actual.sha256 !== expected.sha256) {
      failures.push(`${relative}: изменена защищённая часть`);
    }
  }
  for (const relative of Object.keys(candidateInventory)) {
    if (!referenceInventory[relative]) {
      failures.push(`${relative}: добавлена новая часть`);
    }
  }
  return failures;
}

export function inventoryFingerprint(inventory) {
  return sha256Text(JSON.stringify(inventory));
}
