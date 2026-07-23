import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] || 8123);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Port must be an integer between 1 and 65535.");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function sendError(response, statusCode) {
  response.writeHead(statusCode, { "Cache-Control": "no-store" });
  response.end();
}

async function findFile(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  let file = resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    return null;
  }
  if ((await stat(file)).isDirectory()) {
    file = resolve(file, "index.html");
  }
  return file;
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendError(response, 405);
    return;
  }

  try {
    const file = await findFile(request.url || "/");
    if (!file) {
      sendError(response, 403);
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": body.length,
      "Content-Type": contentTypes[extname(file).toLowerCase()] || "application/octet-stream",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      sendError(response, 404);
      return;
    }
    console.error(error);
    sendError(response, 500);
  }
});

server.once("error", (error) => {
  console.error(`Unable to start local server: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1");
