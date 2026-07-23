import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminateActiveGigacode } from "./target/gigacode.mjs";
import { createUiWorkflowApi } from "./ui-workflow-api.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, "public");

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gz", "application/gzip"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' blob: data:",
    "object-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "worker-src 'self'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

// The Emscripten wrapper used by Tesseract.js needs unsafe-eval while it
// instantiates the local OCR core in some WebKit builds. Keep that permission
// isolated to the OCR Web Worker; the application page retains the stricter
// wasm-unsafe-eval-only policy above.
const TESSERACT_WORKER_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": SECURITY_HEADERS["Content-Security-Policy"].replace(
    "script-src 'self' 'wasm-unsafe-eval'",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  ),
};

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function resolvePublicPath(pathname) {
  const relativePath = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
  const absolutePath = path.resolve(publicRoot, relativePath);
  if (absolutePath !== publicRoot && !absolutePath.startsWith(`${publicRoot}${path.sep}`)) {
    return null;
  }
  return absolutePath;
}

async function serveStatic(request, response, pathname) {
  const filePath = resolvePublicPath(pathname);
  if (!filePath) {
    sendJson(response, 403, { error: "Доступ запрещён" });
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    sendJson(response, 404, { error: "Файл не найден" });
    return;
  }

  if (!fileStat.isFile()) {
    sendJson(response, 404, { error: "Файл не найден" });
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const isVendoredAsset = filePath.startsWith(`${path.join(publicRoot, "vendor")}${path.sep}`);
  const isTesseractWorker = filePath === path.join(
    publicRoot,
    "vendor",
    "tesseract",
    "worker.min.js",
  );
  response.writeHead(200, {
    ...(isTesseractWorker ? TESSERACT_WORKER_SECURITY_HEADERS : SECURITY_HEADERS),
    "Cache-Control": isVendoredAsset ? "public, max-age=31536000, immutable" : "no-store",
    "Content-Length": fileStat.size,
    "Content-Type": MIME_TYPES.get(extension) ?? "application/octet-stream",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

export function createAppServer({ workflowOptions = {} } = {}) {
  const workflowApi = createUiWorkflowApi({
    securityHeaders: SECURITY_HEADERS,
    ...workflowOptions,
  });
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/api/health") {
        sendJson(response, 200, {
          status: "ok",
          version: "0.1.0",
          networkRequired: false,
        });
        return;
      }

      if (await workflowApi.handle(request, response, url)) return;

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Метод не поддерживается" });
        return;
      }

      await serveStatic(request, response, url.pathname);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "Внутренняя ошибка сервера" });
      } else {
        response.destroy(error);
      }
    }
  });
}

export async function startServer({
  port = 4317,
  host = "127.0.0.1",
  workflowOptions = {},
} = {}) {
  const server = createAppServer({ workflowOptions });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const requestedPort = Number.parseInt(process.env.CONTRACTILITY_PORT ?? "4317", 10);
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 4317;
  const server = await startServer({ port });
  console.log(`Contractility запущен: http://127.0.0.1:${port}`);

  const stop = () => {
    terminateActiveGigacode("local server shutdown");
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
