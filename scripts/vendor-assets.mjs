import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesRoot = path.join(projectRoot, "node_modules");
const vendorRoot = path.join(projectRoot, "public", "vendor");

async function copyFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function readPackageVersion(packageName) {
  const packageJson = JSON.parse(
    await readFile(path.join(modulesRoot, packageName, "package.json"), "utf8"),
  );
  return packageJson.version;
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

async function sha256(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

await rm(vendorRoot, { recursive: true, force: true });
await mkdir(vendorRoot, { recursive: true });

await copyFile(
  path.join(modulesRoot, "pdfjs-dist", "build", "pdf.min.mjs"),
  path.join(vendorRoot, "pdfjs", "pdf.min.mjs"),
);
await copyFile(
  path.join(modulesRoot, "pdfjs-dist", "build", "pdf.worker.min.mjs"),
  path.join(vendorRoot, "pdfjs", "pdf.worker.min.mjs"),
);

const pdfWasmSource = path.join(modulesRoot, "pdfjs-dist", "wasm");
for (const entry of await readdir(pdfWasmSource, { withFileTypes: true })) {
  if (entry.isFile()) {
    await copyFile(
      path.join(pdfWasmSource, entry.name),
      path.join(vendorRoot, "pdfjs", "wasm", entry.name),
    );
  }
}

await copyFile(
  path.join(modulesRoot, "tesseract.js", "dist", "tesseract.esm.min.js"),
  path.join(vendorRoot, "tesseract", "tesseract.esm.min.js"),
);
await copyFile(
  path.join(modulesRoot, "tesseract.js", "dist", "worker.min.js"),
  path.join(vendorRoot, "tesseract", "worker.min.js"),
);

const coreSource = path.join(modulesRoot, "tesseract.js-core");
for (const entry of await readdir(coreSource, { withFileTypes: true })) {
  if (entry.isFile() && (/\.wasm$/.test(entry.name) || /\.wasm\.js$/.test(entry.name))) {
    await copyFile(
      path.join(coreSource, entry.name),
      path.join(vendorRoot, "tesseract", "core", entry.name),
    );
  }
}

for (const language of ["rus", "eng"]) {
  await copyFile(
    path.join(
      modulesRoot,
      "@tesseract.js-data",
      language,
      "4.0.0_best_int",
      `${language}.traineddata.gz`,
    ),
    path.join(vendorRoot, "tessdata", `${language}.traineddata.gz`),
  );
}

await copyFile(
  path.join(modulesRoot, "pdfjs-dist", "LICENSE"),
  path.join(vendorRoot, "licenses", "pdfjs-dist-LICENSE.txt"),
);
await copyFile(
  path.join(modulesRoot, "tesseract.js", "LICENSE.md"),
  path.join(vendorRoot, "licenses", "tesseract.js-LICENSE.txt"),
);
await copyFile(
  path.join(modulesRoot, "tesseract.js-core", "LICENSE"),
  path.join(vendorRoot, "licenses", "tesseract.js-core-LICENSE.txt"),
);

const files = await listFiles(vendorRoot);
const hashes = {};
for (const relativePath of files) {
  hashes[relativePath] = await sha256(path.join(vendorRoot, relativePath));
}

const manifest = {
  schemaVersion: 1,
  packages: {
    "pdfjs-dist": await readPackageVersion("pdfjs-dist"),
    "tesseract.js": await readPackageVersion("tesseract.js"),
    "tesseract.js-core": await readPackageVersion("tesseract.js-core"),
    "@tesseract.js-data/rus": await readPackageVersion("@tesseract.js-data/rus"),
    "@tesseract.js-data/eng": await readPackageVersion("@tesseract.js-data/eng"),
  },
  files: hashes,
};

await writeFile(
  path.join(vendorRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`Подготовлено ${files.length} локальных файлов в public/vendor.`);
