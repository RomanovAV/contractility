import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sha256(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export async function verifyVendorIntegrity(projectRoot = defaultProjectRoot) {
  const vendorRoot = path.join(projectRoot, "public", "vendor");
  const manifestPath = path.join(vendorRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const failures = [];

  for (const [relativePath, expectedHash] of Object.entries(manifest.files ?? {})) {
    try {
      const actualHash = await sha256(path.join(vendorRoot, relativePath));
      if (actualHash !== expectedHash) {
        failures.push({ relativePath, reason: "hash-mismatch", expectedHash, actualHash });
      }
    } catch (error) {
      failures.push({ relativePath, reason: "missing", error: error.message });
    }
  }

  return {
    ok: failures.length === 0,
    checkedFiles: Object.keys(manifest.files ?? {}).length,
    packages: manifest.packages ?? {},
    failures,
  };
}
