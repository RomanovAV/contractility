import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
}

export async function atomicWriteJson(filePath, value) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function copyVerified(source, destination, expectedSha256) {
  const before = await sha256File(source);
  if (before !== expectedSha256) {
    throw new Error(`SHA-256 не совпадает для ${path.basename(source)}.`);
  }
  await ensurePrivateDirectory(path.dirname(destination));
  await copyFile(source, destination);
  await chmod(destination, 0o600).catch(() => {});
  const after = await sha256File(destination);
  if (after !== expectedSha256) {
    throw new Error(`Файл изменился при копировании: ${path.basename(source)}.`);
  }
}

export function safeRelativePath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized === "."
    || normalized === ".."
    || normalized.split("/").includes("..")
  ) {
    throw new TypeError(`Недопустимый относительный путь: ${value}`);
  }
  return normalized;
}

export async function acquireRunLock(runDirectory) {
  const lockPath = path.join(runDirectory, "run.lock");
  const handle = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") {
      throw new Error(`Запуск уже заблокирован: ${lockPath}`);
    }
    throw error;
  });
  await handle.writeFile(`${JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  })}\n`);
  return async () => {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true });
  };
}

export async function appendEvent(runDirectory, event, fields = {}) {
  const eventPath = path.join(runDirectory, "events.ndjson");
  const handle = await open(eventPath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...fields,
    })}\n`);
  } finally {
    await handle.close();
  }
}

export async function requireRegularFile(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new TypeError(`Ожидался обычный файл: ${filePath}`);
  }
  return info;
}

