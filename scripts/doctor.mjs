import { spawnSync } from "node:child_process";
import { verifyVendorIntegrity } from "../src/vendor-integrity.mjs";

let failed = false;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);

if (nodeMajor >= 22) {
  console.log(`✓ Node.js ${process.versions.node}`);
} else {
  console.error(`✗ Требуется Node.js 22 или новее, найден ${process.versions.node}`);
  failed = true;
}

try {
  const integrity = await verifyVendorIntegrity();
  if (integrity.ok) {
    console.log(`✓ Проверены локальные OCR-компоненты: ${integrity.checkedFiles} файлов`);
  } else {
    console.error("✗ Нарушена целостность локальных OCR-компонентов:");
    for (const failure of integrity.failures) {
      console.error(`  - ${failure.relativePath}: ${failure.reason}`);
    }
    failed = true;
  }
} catch (error) {
  console.error(`✗ Не удалось проверить OCR-компоненты: ${error.message}`);
  failed = true;
}

const gigacode = spawnSync("gigacode", ["--version"], {
  encoding: "utf8",
  shell: false,
  timeout: 10_000,
});
if (gigacode.status === 0) {
  console.log(`✓ GigaCode CLI: ${(gigacode.stdout || gigacode.stderr).trim()}`);
} else {
  console.warn("! GigaCode CLI не найден. OCR доступен, семантический анализ пока недоступен.");
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("✓ Окружение готово к локальному OCR");
}
