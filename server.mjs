import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 2603;

const MIME_BY_EXT = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"],
]);

function safeResolve(rootDir, requestPathname) {
  const decoded = decodeURIComponent(requestPathname);
  const normalized = decoded.replaceAll("\\", "/");
  const clean = normalized.split("?")[0].split("#")[0];
  const rel = clean.startsWith("/") ? clean.slice(1) : clean;
  const abs = path.resolve(rootDir, rel);
  const rootAbs = path.resolve(rootDir);
  if (!abs.startsWith(rootAbs)) return null;
  return abs;
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT.get(ext) ?? "application/octet-stream";
}

function decodeTxtToUtf8(buffer) {
  const cutoff = buffer.indexOf(0x1a);
  const sliced = cutoff >= 0 ? buffer.subarray(0, cutoff) : buffer;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(sliced);
  } catch {
    return new TextDecoder("gb18030").decode(sliced);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = safeResolve(__dirname, pathname);
    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"].includes(ext);
    res.writeHead(200, {
      "Content-Type": guessContentType(filePath),
      "Cache-Control": isImage ? "public, max-age=86400" : "no-store",
    });
    if (ext === ".txt") {
      res.end(decodeTxtToUtf8(data));
      return;
    }
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Tagteam UI: http://localhost:${PORT}/\n`);
});
