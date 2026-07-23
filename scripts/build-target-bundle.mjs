import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sha256File } from "../src/target/fs-utils.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(projectRoot, "dist");
const archivePath = path.join(distDirectory, "contractility-target.zip");
const manifestPath = path.join(distDirectory, "contractility-target.manifest.json");

await mkdir(distDirectory, { recursive: true });
await rm(archivePath, { force: true });
await execFileAsync("zip", [
  "-q",
  "-X",
  "-r",
  archivePath,
  ".",
  "-x",
  ".git/*",
  "node_modules/*",
  "data/*",
  "tmp/*",
  "dist/*",
  "testdata/*",
  "config/target.json",
  "config/*.local.json",
  ".DS_Store",
  "*.log",
], {
  cwd: projectRoot,
  maxBuffer: 10 * 1024 * 1024,
});
const info = await stat(archivePath);
const manifest = {
  schemaVersion: "contractility.target-bundle.v1",
  createdAt: new Date().toISOString(),
  file: path.basename(archivePath),
  size: info.size,
  sha256: await sha256File(archivePath),
  runtime: {
    node: ">=22",
    requiredCommands: ["gigacode", "zip", "unzip"],
    conditionalCommands: ["soffice when tools.requireSoffice=true"],
  },
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ archivePath, manifestPath, ...manifest }, null, 2));
