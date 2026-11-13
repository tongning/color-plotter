import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(ROOT, "assets");
const DATA_DIR = join(ROOT, ".data");
const STORE_FILE = join(DATA_DIR, "drawings.json");
const STORE_TEMP = join(DATA_DIR, "drawings.tmp.json");
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "meowl";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DRAWINGS = 500;
const MAX_STROKES = 500;
const MAX_POINTS = 50000;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".gcode": "text/plain; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

let storeQueue = Promise.resolve();

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function loadStore() {
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, "utf8"));
    return { version: 1, drawings: Array.isArray(parsed.drawings) ? parsed.drawings : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, drawings: [] };
    throw error;
  }
}

async function saveStore(store) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_TEMP, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(STORE_TEMP, STORE_FILE);
}

function updateStore(change) {
  const operation = storeQueue.then(async () => {
    const store = await loadStore();
    const result = await change(store);
    await saveStore(store);
    return result;
  });
  storeQueue = operation.catch(() => {});
  return operation;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "Drawing is too large to save.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw httpError(400, "Request body must be valid JSON."); }
}

function cleanText(value, label) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) throw httpError(400, `${label} is required.`);
  if (text.length > 60) throw httpError(400, `${label} must be 60 characters or fewer.`);
  return text;
}

function cleanDrawing(input) {
  if (!Array.isArray(input.strokes) || input.strokes.length === 0) throw httpError(400, "Drawing has no strokes.");
  if (input.strokes.length > MAX_STROKES) throw httpError(400, "Drawing has too many strokes.");
  let pointCount = 0;
  const strokes = input.strokes.map((stroke) => {
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) throw httpError(400, "Drawing contains an invalid stroke.");
    pointCount += stroke.points.length;
    if (pointCount > MAX_POINTS) throw httpError(400, "Drawing has too many points.");
    return {
      points: stroke.points.map((point) => {
        const x = Number(point?.x);
        const y = Number(point?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw httpError(400, "Drawing contains an invalid point.");
        return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
      }),
      shape: Boolean(stroke.shape),
      ...(typeof stroke.color === "string" && /^#[a-f\d]{6}$/i.test(stroke.color) ? { color: stroke.color.toLowerCase() } : {}),
    };
  });
  const drawing = {
    id: /^[a-f\d-]{36}$/i.test(String(input.id || "")) ? String(input.id) : randomUUID(),
    name: cleanText(input.name, "Drawing name"),
    artist: cleanText(input.artist, "Drawer name"),
    strokes,
  };
  if (input.remixOf != null) {
    if (!input.remixOf || typeof input.remixOf !== "object" || !/^[a-f\d-]{36}$/i.test(String(input.remixOf.id || ""))) {
      throw httpError(400, "Remix source is invalid.");
    }
    drawing.remixOf = {
      id: String(input.remixOf.id),
      name: cleanText(input.remixOf.name, "Remix drawing name"),
      artist: cleanText(input.remixOf.artist, "Remix drawer name"),
    };
  }
  return drawing;
}

function requireAdmin(request) {
  if (request.headers["x-admin-password"] !== ADMIN_PASSWORD) throw httpError(403, "Admin password is required.");
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/premades") {
    const entries = await readdir(ASSETS_DIR, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const imageByStem = new Map();
    const imageExtensions = [".png", ".jpg", ".jpeg"];

    for (const extension of imageExtensions) {
      for (const file of files) {
        if (extname(file).toLowerCase() !== extension) continue;
        const stem = file.slice(0, -extension.length).toLowerCase();
        if (!imageByStem.has(stem)) imageByStem.set(stem, file);
      }
    }

    const drawingsByStem = new Map();
    for (const file of files) {
      if (extname(file).toLowerCase() !== ".gcode") continue;
      const name = file.slice(0, -extname(file).length);
      const key = name.toLowerCase();
      if (!drawingsByStem.has(key)) drawingsByStem.set(key, { name, file });
    }

    const drawings = Array.from(drawingsByStem.entries())
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([stem, drawing]) => ({
        name: drawing.name,
        gcode: `assets/${encodeURIComponent(drawing.file)}`,
        thumbnail: imageByStem.has(stem) ? `assets/${encodeURIComponent(imageByStem.get(stem))}` : null,
      }));
    return sendJson(response, 200, { drawings });
  }

  if (request.method === "GET" && url.pathname === "/api/drawings") {
    const store = await loadStore();
    const drawings = store.drawings.slice();
    if (url.searchParams.get("sort") === "popular") {
      drawings.sort((a, b) => (b.prints || 0) - (a.prints || 0) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    } else {
      drawings.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }
    return sendJson(response, 200, { drawings });
  }

  if (request.method === "POST" && url.pathname === "/api/drawings") {
    const drawing = cleanDrawing(await readJson(request));
    const saved = await updateStore((store) => {
      if (store.drawings.length >= MAX_DRAWINGS) throw httpError(507, "The public gallery is full.");
      if (store.drawings.some((item) => item.id === drawing.id)) throw httpError(409, "That drawing is already public.");
      const record = { ...drawing, createdAt: new Date().toISOString(), prints: 0 };
      store.drawings.push(record);
      return record;
    });
    return sendJson(response, 201, { drawing: saved });
  }

  const drawingMatch = url.pathname.match(/^\/api\/drawings\/([a-f\d-]{36})(?:\/(print))?$/i);
  if (drawingMatch && request.method === "POST" && drawingMatch[2] === "print") {
    const drawing = await updateStore((store) => {
      const found = store.drawings.find((item) => item.id === drawingMatch[1]);
      if (!found) throw httpError(404, "Drawing not found.");
      found.prints = Math.max(0, Number(found.prints) || 0) + 1;
      return found;
    });
    return sendJson(response, 200, { drawing });
  }

  if (drawingMatch && request.method === "DELETE" && !drawingMatch[2]) {
    requireAdmin(request);
    await updateStore((store) => {
      const index = store.drawings.findIndex((item) => item.id === drawingMatch[1]);
      if (index === -1) throw httpError(404, "Drawing not found.");
      store.drawings.splice(index, 1);
    });
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "DELETE" && url.pathname === "/api/drawings") {
    requireAdmin(request);
    const deleted = await updateStore((store) => {
      const count = store.drawings.length;
      store.drawings = [];
      return count;
    });
    return sendJson(response, 200, { ok: true, deleted });
  }

  throw httpError(404, "API endpoint not found.");
}

async function serveStatic(request, response, url) {
  if (!['GET', 'HEAD'].includes(request.method)) throw httpError(405, "Method not allowed.");
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { throw httpError(400, "Invalid URL."); }
  const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/, "");
  const filePath = join(ROOT, relative);
  const hiddenPath = relative.split(/[\\/]/).some((segment) => segment.startsWith("."));
  if ((!filePath.startsWith(`${ROOT}${sep}`) && filePath !== ROOT) || hiddenPath || relative === "server.mjs") throw httpError(404, "Not found.");
  let body;
  try { body = await readFile(filePath); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") throw httpError(404, "Not found.");
    throw error;
  }
  response.writeHead(200, {
    "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else await serveStatic(request, response, url);
  } catch (error) {
    const status = Number(error.status) || 500;
    if (!response.headersSent) sendJson(response, status, { error: status === 500 ? "Internal server error." : error.message });
    else response.end();
    if (status === 500) console.error(error);
  } finally {
    console.log(`${request.method} ${request.url} ${response.statusCode} ${Date.now() - startedAt}ms`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Small Plotter listening on http://${HOST}:${PORT}`);
  console.log(`Saved drawings: ${STORE_FILE}`);
});
