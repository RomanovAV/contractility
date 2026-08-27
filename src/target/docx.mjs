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
const WORDPROCESSING_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const TRACKED_CHANGE_ELEMENTS = new Set([
  "ins",
  "del",
  "moveFrom",
  "moveTo",
  "moveFromRangeStart",
  "moveFromRangeEnd",
  "moveToRangeStart",
  "moveToRangeEnd",
  "customXmlInsRangeStart",
  "customXmlInsRangeEnd",
  "customXmlDelRangeStart",
  "customXmlDelRangeEnd",
  "customXmlMoveFromRangeStart",
  "customXmlMoveFromRangeEnd",
  "customXmlMoveToRangeStart",
  "customXmlMoveToRangeEnd",
  "cellIns",
  "cellDel",
  "cellMerge",
  "numberingChange",
  "pPrChange",
  "rPrChange",
  "sectPrChange",
  "tblPrChange",
  "tblGridChange",
  "trPrChange",
  "tcPrChange",
]);

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

function visibleWordText(xml) {
  const wordPrefixes = new Set();
  for (const match of xml.matchAll(
    /\bxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(["'])(.*?)\2/g,
  )) {
    if (WORDPROCESSING_NAMESPACES.has(match[3])) {
      wordPrefixes.add(match[1] ?? "");
    }
  }
  const wordTextPattern = /<(?:([A-Za-z_][\w.-]*):)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g;
  return [...xml.matchAll(wordTextPattern)]
    .filter((match) => wordPrefixes.has(match[1] ?? ""))
    .map((match) => match[2]
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", "\"")
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&"))
    .join("");
}

function wordprocessingPrefixes(xml) {
  const prefixes = new Set();
  for (const match of xml.matchAll(
    /\bxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(["'])(.*?)\2/g,
  )) {
    if (WORDPROCESSING_NAMESPACES.has(match[3])) prefixes.add(match[1] ?? "");
  }
  return prefixes;
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

export async function wordprocessingMarkupFacts(packageDirectory) {
  const revisionByElement = {};
  const revisionByPart = {};
  const highlightByValue = {};
  let revisionMarkupCount = 0;
  let highlightCount = 0;
  let revisionRecordingEnabled = false;

  for (const file of await walk(packageDirectory)) {
    if (!file.relative.startsWith("word/") || !file.relative.endsWith(".xml")) continue;
    const xml = await readFile(file.absolute, "utf8");
    const prefixes = wordprocessingPrefixes(xml);
    if (prefixes.size === 0) continue;
    for (const match of xml.matchAll(
      /<(?!\/|\?|!)(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)\b([^>]*)>/g,
    )) {
      const prefix = match[1] ?? "";
      if (!prefixes.has(prefix)) continue;
      const localName = match[2];
      if (TRACKED_CHANGE_ELEMENTS.has(localName)) {
        revisionMarkupCount += 1;
        incrementCount(revisionByElement, localName);
        incrementCount(revisionByPart, file.relative);
      } else if (localName === "trackRevisions") {
        revisionRecordingEnabled = true;
      } else if (localName === "highlight") {
        highlightCount += 1;
        const value = match[3].match(
          /(?:^|\s)(?:[A-Za-z_][\w.-]*:)?val\s*=\s*(["'])(.*?)\1/,
        )?.[2] ?? "unspecified";
        incrementCount(highlightByValue, value);
      }
    }
  }

  return {
    schemaVersion: "contractility.ooxml-markup-facts.v1",
    revisionMarkup: {
      count: revisionMarkupCount,
      byElement: revisionByElement,
      byPart: revisionByPart,
    },
    revisionRecordingEnabled,
    textHighlighting: {
      count: highlightCount,
      byValue: highlightByValue,
    },
  };
}

export async function editablePackageTextCount(packageDirectory, text) {
  const needle = String(text);
  if (!needle) return 0;
  let count = 0;
  for (const file of await walk(packageDirectory)) {
    if (!EDITABLE_PARTS.some((pattern) => pattern.test(file.relative))) continue;
    const visibleText = visibleWordText(await readFile(file.absolute, "utf8"));
    let offset = 0;
    while ((offset = visibleText.indexOf(needle, offset)) >= 0) {
      count += 1;
      offset += needle.length;
    }
  }
  return count;
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
