/* Small Plotter browser application. */

const PEN_DOWN = ["M280 P0 S168", "G4 P25"];
const PEN_UP = ["M280 P0 S150", "G4 P25"];
const JOB_START = ["M280 P0 S150", "G4 P60", "G28 ; home axes with the pen lifted"];
const JOB_END = ["T-1", "G28", "M84"];

const MARKER_PALETTE_KEY = "smallPlotter.markerPalette.v1";
let markerPalette = PlotterColor.DEFAULT_PALETTE.slice();
try {
  const saved = JSON.parse(localStorage.getItem(MARKER_PALETTE_KEY));
  if (Array.isArray(saved) && saved.length === 8 && saved.every(PlotterColor.isColor)) markerPalette = saved;
} catch { /* use factory palette */ }
let activeMarker = 0;
const toolForStroke = (stroke) => PlotterColor.nearestTool(stroke.color || markerPalette[0], markerPalette);
const inkForStroke = (stroke) => markerPalette[toolForStroke(stroke)];
const SOURCE_SIZE = 480; // px; square raster used for selfie squiggling
const ERASER_RADIUS = 0.025; // normalized canvas radius (about 12px on a 480px canvas)
const DEFAULT_SQUIGGLE_LIMITS = { lines: 60, amp: 3 };
const SELFIE_SQUIGGLE_LIMITS = { lines: 45, amp: 1.5 };
const FILL_RASTER = 480; // px; offscreen raster the fill tool flood-fills
const FILL_SPACING = 2; // px between hatch lines on that raster (~0.5mm on the default bed)
const FILL_EDGE_GAP = 0; // px along a hatch line between its endpoint and the shape edge (negative extends past the edge, into the outline)
const PLOT_FILENAME = "small-plotter.gcode";
const SAVED_DRAWINGS_KEY = "smallPlotter.savedDrawings.v1";
const APP_SETTINGS_KEY = "smallPlotter.settings.v1";
const PERSISTED_SETTING_IDS = [
  "duetEndpoint", "workWidth", "workHeight", "drawFeed", "travelFeed",
  "startAfterUpload", "gallerySort",
];

const state = {
  strokes: [],
  activeStroke: null,
  undoStack: [],
  redoStack: [],
  canvasSize: 0,
  sourceImage: null, // ImageData driving the squiggle sliders
  previewGcode: "",
  toastTimer: null,
  sendInProgress: false,
  drawingTool: "pencil",
  shapeStart: null,
  eraserStartStrokes: null,
  eraserLastPoint: null,
  eraserChanged: false,
  galleryDrawing: null,
  galleryCopyDirty: false,
  premadeSource: null,
  galleryDrawings: [],
  galleryDeleteMode: false,
  adminUnlocked: false,
  selfieSize: "3:4",
  selfieOriginal: null, // last capture as taken
  selfieRemoved: null, // background-removed copy of it, computed on demand
  selfieRemovalPromise: null, // in-flight/cached removal for the current capture
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const canvas = $("#drawCanvas");
const ctx = canvas.getContext("2d");
const plottingBed = $("#plottingBed");
const drawButton = $("#drawButton");
const undoButton = $("#undoButton");
const redoButton = $("#redoButton");
const clearButton = $("#clearButton");
const adminButton = $("#adminButton");
const adminPanel = $("#adminPanel");
const gcodeButton = $("#gcodeButton");
const downloadButton = $("#downloadButton");
const gcodePanel = $("#gcodePanel");
const squigglePanel = $("#squigglePanel");
const cameraVideo = $("#cameraVideo");
const snapButton = $("#snapButton");
const saveDrawingButton = $("#saveDrawingButton");
const toast = $("#toast");

function restoreAppSettings() {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(APP_SETTINGS_KEY)); } catch { return; }
  if (!stored || typeof stored !== "object") return;
  for (const id of PERSISTED_SETTING_IDS) {
    const input = document.getElementById(id);
    if (!input || !(id in stored)) continue;
    if (input.type === "checkbox") input.checked = Boolean(stored[id]);
    else input.value = String(stored[id]);
  }
}

function saveAppSettings() {
  const settings = {};
  for (const id of PERSISTED_SETTING_IDS) {
    const input = document.getElementById(id);
    if (input) settings[id] = input.type === "checkbox" ? input.checked : input.value;
  }
  try { localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings)); }
  catch (error) { logLine("APP", `could not save settings: ${error.message || error}`); }
}

restoreAppSettings();

function safeNumber(value, fallback, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function dimensions() {
  return {
    width: safeNumber($("#workWidth").value, 118, 1),
    height: safeNumber($("#workHeight").value, 118, 1),
  };
}

function feeds() {
  return {
    draw: safeNumber($("#drawFeed").value, 18000, 1),
    travel: safeNumber($("#travelFeed").value, 30000, 1),
  };
}

function formatMm(number, precision = 2) {
  return Number(number.toFixed(precision)).toString();
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function plotPoint(point) {
  const { width, height } = dimensions();
  // Canvas Y grows down; machines normally home to the lower-left origin.
  return { x: point.x * width, y: (1 - point.y) * height };
}

function strokeLength(stroke) {
  let total = 0;
  for (let i = 1; i < stroke.length; i += 1) total += distance(plotPoint(stroke[i - 1]), plotPoint(stroke[i]));
  return total;
}

// Ramer–Douglas–Peucker removes redundant pointer samples while retaining corners.
function simplifyStroke(points, tolerance = 0.0012) {
  if (points.length < 3) return points;
  const start = points[0];
  const end = points[points.length - 1];
  const lineLength = distance(start, end);
  let furthestDistance = 0;
  let furthestIndex = 0;

  for (let i = 1; i < points.length - 1; i += 1) {
    const point = points[i];
    const pointDistance = lineLength === 0
      ? distance(point, start)
      : Math.abs((end.y - start.y) * point.x - (end.x - start.x) * point.y + end.x * start.y - end.y * start.x) / lineLength;
    if (pointDistance > furthestDistance) {
      furthestDistance = pointDistance;
      furthestIndex = i;
    }
  }

  if (furthestDistance > tolerance) {
    const left = simplifyStroke(points.slice(0, furthestIndex + 1), tolerance);
    const right = simplifyStroke(points.slice(furthestIndex), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [start, end];
}

// Chaikin corner cutting rounds the polyline so plotted strokes match the
// smooth curve shown on screen.
function chaikin(points, iterations = 2) {
  let pts = points;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function smoothStroke(points) {
  // Simplify first so smoothing rounds real corners, not pointer jitter;
  // the final pass drops the near-collinear points Chaikin introduces.
  return simplifyStroke(chaikin(simplifyStroke(points)), 0.0004);
}

function cloneStroke(stroke) {
  const copy = stroke.map((point) => ({ x: point.x, y: point.y }));
  if (stroke.shape) copy.shape = true;
  if (stroke.squiggle) copy.squiggle = true;
  if (PlotterColor.isColor(stroke.color)) copy.color = stroke.color;
  return copy;
}

function cloneStrokes(strokes) {
  return strokes.map(cloneStroke);
}

function serializeStrokes(strokes) {
  return strokes.map((stroke) => ({
    points: stroke.map((point) => ({ x: point.x, y: point.y })),
    shape: Boolean(stroke.shape),
    ...(PlotterColor.isColor(stroke.color) ? { color: stroke.color } : {}),
  }));
}

function deserializeStrokes(strokes) {
  if (!Array.isArray(strokes)) return [];
  return strokes.map((savedStroke) => {
    const stroke = (savedStroke.points || []).map((point) => ({ x: Number(point.x), y: Number(point.y) }));
    if (savedStroke.shape) stroke.shape = true;
    if (PlotterColor.isColor(savedStroke.color)) stroke.color = savedStroke.color;
    return stroke;
  }).filter((stroke) => stroke.length > 0);
}

/* ---------- views ---------- */

const views = {
  splash: $("#viewSplash"),
  draw: $("#viewDraw"),
  selfie: $("#viewSelfie"),
  premade: $("#viewPremade"),
};

function showView(name) {
  for (const [viewName, element] of Object.entries(views)) element.classList.toggle("hidden", viewName !== name);
  if (name === "selfie") startCamera();
  else stopCamera();
  if (name === "draw") resizeCanvas();
  if (name === "premade") {
    loadPremades();
    loadGallery();
  }
}

/* ---------- drawing canvas ---------- */

function normalizedEventPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
  };
}

function resizeCanvas() {
  const rect = plottingBed.getBoundingClientRect();
  if (!rect.width) return; // view is hidden
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  state.canvasSize = rect.width;
  render();
}

function drawStrokeOn(targetContext, size, stroke, lineWidth = 1.35) {
  if (!stroke.length) return;
  targetContext.strokeStyle = inkForStroke(stroke);
  targetContext.lineWidth = lineWidth;
  targetContext.lineJoin = "round";
  targetContext.lineCap = "round";
  targetContext.beginPath();
  if (stroke.length === 1) {
    targetContext.fillStyle = inkForStroke(stroke);
    targetContext.arc(stroke[0].x * size, stroke[0].y * size, Math.max(.68, lineWidth / 2), 0, Math.PI * 2);
    targetContext.fill();
    return;
  }
  if (stroke.shape) {
    targetContext.moveTo(stroke[0].x * size, stroke[0].y * size);
    for (let index = 1; index < stroke.length; index += 1) {
      targetContext.lineTo(stroke[index].x * size, stroke[index].y * size);
    }
    targetContext.stroke();
    return;
  }
  // Quadratic curves through segment midpoints keep the live line smooth.
  targetContext.moveTo(stroke[0].x * size, stroke[0].y * size);
  for (let i = 1; i < stroke.length - 1; i += 1) {
    const midX = (stroke[i].x + stroke[i + 1].x) / 2 * size;
    const midY = (stroke[i].y + stroke[i + 1].y) / 2 * size;
    targetContext.quadraticCurveTo(stroke[i].x * size, stroke[i].y * size, midX, midY);
  }
  const last = stroke[stroke.length - 1];
  targetContext.lineTo(last.x * size, last.y * size);
  targetContext.stroke();
}

function drawStroke(stroke) {
  drawStrokeOn(ctx, state.canvasSize, stroke);
}

function render() {
  ctx.clearRect(0, 0, state.canvasSize, state.canvasSize);
  state.strokes.forEach((stroke) => drawStroke(stroke));
  if (state.activeStroke) drawStroke(state.activeStroke);
}

function updateUi() {
  updateColorMapping();
  const hasStrokes = state.strokes.length > 0;
  const squiggleMode = Boolean(state.sourceImage);
  // Saved gallery drawings are opened as editable working copies. Their
  // original records remain untouched unless this copy is explicitly saved,
  // which always creates a new drawing ID.
  const readonly = squiggleMode;
  drawButton.disabled = !hasStrokes;
  undoButton.disabled = readonly || !state.undoStack.length;
  redoButton.disabled = readonly || !state.redoStack.length;
  clearButton.disabled = readonly || !hasStrokes;
  downloadButton.disabled = !hasStrokes;
  saveDrawingButton.disabled = readonly || !hasStrokes;
  saveDrawingButton.classList.toggle("hidden", readonly);
  $("#drawingTools").classList.toggle("hidden", readonly);
  $(".canvas-actions").classList.toggle("hidden", readonly);
  plottingBed.classList.toggle("readonly", readonly);
  // Squiggle jobs carry thousands of points; only build the preview text
  // while the panel is actually showing it.
  if (gcodePanel.classList.contains("open")) refreshGcodePreview();
}

function refreshGcodePreview() {
  state.previewGcode = state.strokes.length ? generateGcode() : "";
  $("#gcodePreview").textContent = state.previewGcode || "Start drawing to see the generated G-code.";
  const artworkLength = state.strokes.reduce((sum, stroke) => sum + strokeLength(stroke), 0);
  $("#gcodeMeta").textContent = state.previewGcode ? `${state.previewGcode.split("\n").length} lines · ${formatMm(artworkLength, 1)} mm drawing` : "No G-code yet";
}

/* ---------- gcode ---------- */

function penUp(lines) { lines.push(...PEN_UP); }
function penDown(lines) { lines.push(...PEN_DOWN); }

function plotReadyStroke(stroke) {
  // Squiggle lines are already smooth sine curves — rounding them again only
  // bloats the job. Shape strokes also keep their exact corners/curves.
  return stroke.squiggle || stroke.shape ? simplifyStroke(stroke, 0.0004) : smoothStroke(stroke);
}

function generateGcode() {
  const { width, height } = dimensions();
  const { draw, travel } = feeds();
  const date = new Date().toISOString();
  const lines = [
    "; Generated by Small Plotter",
    `; ${date}`,
    `; Drawing area: ${formatMm(width)} x ${formatMm(height)} mm`,
    `; Strokes: ${state.strokes.length}`,
    "G90 ; absolute positioning",
    ...JOB_START,
  ];

  // Group by the physical marker after color matching. Keep first-use tool
  // order and the original path order within each group, without editing the
  // canvas strokes or undo history.
  const toolGroups = new Map();
  for (const stroke of state.strokes) {
    const tool = toolForStroke(stroke);
    if (!toolGroups.has(tool)) toolGroups.set(tool, []);
    toolGroups.get(tool).push(stroke);
  }
  const groupedStrokes = Array.from(toolGroups.values()).flat();

  let penPosition = null;
  let selectedTool = null;
  groupedStrokes.forEach((originalStroke, index) => {
    const tool = toolForStroke(originalStroke);
    if (tool !== selectedTool) {
      penUp(lines);
      lines.push("M400 ; finish moves before changing marker", `T${tool} ; marker ${markerPalette[tool]}`);
      penUp(lines);
      selectedTool = tool;
      penPosition = null; // tool-change macros may move the carriage
    }
    let stroke = plotReadyStroke(originalStroke);
    // Squiggle lines plot serpentine-style: start each line at whichever end
    // is nearer the pen, instead of always travelling back to the same edge.
    if (originalStroke.squiggle && penPosition && stroke.length > 1) {
      const toStart = distance(penPosition, plotPoint(stroke[0]));
      const toEnd = distance(penPosition, plotPoint(stroke[stroke.length - 1]));
      if (toEnd < toStart) stroke = stroke.slice().reverse();
    }
    const first = plotPoint(stroke[0]);
    lines.push(`; stroke ${index + 1}`);
    lines.push(`G0 X${formatMm(first.x)} Y${formatMm(first.y)} F${Math.round(travel)}`);
    penDown(lines);

    // A tap still receives a short down/up sequence without a potentially zero move.
    for (let pointIndex = 1; pointIndex < stroke.length; pointIndex += 1) {
      const point = plotPoint(stroke[pointIndex]);
      lines.push(`G1 X${formatMm(point.x)} Y${formatMm(point.y)} F${Math.round(draw)}`);
    }
    penPosition = plotPoint(stroke[stroke.length - 1]);
    penUp(lines);
  });

  lines.push(...JOB_END, "; End of Small Plotter job");
  return `${lines.join("\n")}\n`;
}

/* ---------- application log ---------- */

const logBuffer = [];

function logLine(level, ...parts) {
  const time = new Date().toISOString().slice(11, 23);
  const text = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
  logBuffer.push(`[${time}] ${level.padEnd(6)} ${text}`);
  if (logBuffer.length > 500) logBuffer.shift();
  $("#logsMeta").textContent = `${logBuffer.length} entries`;
  const output = $("#logsOutput");
  if (!output.classList.contains("hidden")) {
    output.textContent = logBuffer.join("\n");
    output.scrollTop = output.scrollHeight;
  }
}

for (const level of ["warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => { logLine(level.toUpperCase(), ...args); original(...args); };
}
window.addEventListener("error", (event) => logLine("ERROR", `${event.message} @ ${event.filename}:${event.lineno}`));
window.addEventListener("unhandledrejection", (event) => logLine("ERROR", "Unhandled rejection:", String(event.reason)));

/* ---------- toast + status ---------- */

function showToast(message, type = "") {
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.className = `toast show ${type}`.trim();
  state.toastTimer = setTimeout(() => { toast.className = "toast"; }, 4300);
  logLine(type === "error" ? "ERROR" : "TOAST", message);
}

function setMachineStatus(message, mode = "") {
  $("#statusText").textContent = message;
  $("#machineStatus").className = `machine-status ${mode}`.trim();
  logLine("STATUS", message);
}

/* ---------- Duet upload ---------- */

const duetTransportModes = new Map();
let duetRequestSequence = 0;

function requestDescription(url) {
  const safeUrl = new URL(url, window.location.href);
  if (safeUrl.searchParams.has("password")) safeUrl.searchParams.set("password", "[redacted]");
  if (safeUrl.searchParams.has("gcode")) {
    const gcode = safeUrl.searchParams.get("gcode") || "";
    safeUrl.searchParams.set("gcode", `[${gcode.length} chars]`);
  }
  return `${safeUrl.origin}${safeUrl.pathname}${safeUrl.search}`;
}

function isSameOrigin(target) {
  return window.location.protocol !== "file:" && target.origin === window.location.origin;
}

async function readDuetResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}

function baseUrlFromEndpoint() {
  let input = $("#duetEndpoint").value.trim().replace(/\/+$/, "");
  if (!input) throw new Error("Enter your Duet board address first.");
  if (!/^https?:\/\//i.test(input)) input = `http://${input}`;
  let url;
  try { url = new URL(input); } catch { throw new Error("Enter a complete address, e.g. http://192.168.1.42"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("The board address must start with http:// or https://");
  // The rr_* paths are appended automatically; tolerate a pasted /rr_upload.
  url.pathname = url.pathname.replace(/\/rr_upload$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function autoFileName() {
  return PLOT_FILENAME;
}

async function requestDuet(url, options = {}) {
  const target = new URL(url, window.location.href);
  const method = (options.method || "GET").toUpperCase();
  const sameOrigin = isSameOrigin(target);
  const requestId = ++duetRequestSequence;
  const idempotent = options.idempotent ?? method === "GET";
  const maxAttempts = options.maxAttempts || (idempotent ? 3 : 1);
  const fetchOptions = { ...options };
  delete fetchOptions.maxAttempts;
  delete fetchOptions.idempotent;

  // Probe CORS with an idempotent GET before any upload. When M586 permits
  // this page's origin we can read and validate Duet responses. A direct
  // file:// page usually falls back to an opaque request instead.
  let mode = sameOrigin ? "same-origin" : duetTransportModes.get(target.origin);
  let probingCors = !mode && idempotent;
  if (!mode) mode = probingCors ? "cors" : "no-cors";

  for (let attempt = 1; ; attempt += 1) {
    const startedAt = performance.now();
    logLine("NET", `#${requestId} ${method} ${requestDescription(target)} mode=${mode} attempt=${attempt}/${maxAttempts}`);
    try {
      const response = await fetch(target.href, {
        ...fetchOptions,
        mode,
        credentials: sameOrigin ? "same-origin" : "omit",
        cache: "no-store",
      });
      const elapsed = Math.round(performance.now() - startedAt);
      if (!sameOrigin) duetTransportModes.set(target.origin, mode);
      probingCors = false;
      if (response.type === "opaque") {
        logLine("NET", `#${requestId} dispatched; opaque response after ${elapsed}ms`);
        return { opaque: true };
      }
      logLine("NET", `#${requestId} HTTP ${response.status} after ${elapsed}ms`);
      if (!response.ok) throw new Error(`Duet returned HTTP ${response.status}`);
      return await readDuetResponse(response);
    } catch (error) {
      const elapsed = Math.round(performance.now() - startedAt);
      logLine("NET", `#${requestId} failed after ${elapsed}ms: ${error.name || "Error"}: ${error.message || error}`);

      // A CORS failure and a network failure are both exposed as TypeError.
      // Falling back is safe here because probes are GET-only. POST and M32
      // are never speculatively repeated by this helper.
      if (!sameOrigin && probingCors && mode === "cors") {
        probingCors = false;
        mode = "no-cors";
        duetTransportModes.set(target.origin, mode);
        logLine("NET", `#${requestId} readable CORS unavailable; switching this board to opaque transport`);
        continue;
      }
      if (attempt >= maxAttempts) throw error;
      const backoffMs = 350 * attempt;
      logLine("NET", `#${requestId} retrying idempotent request in ${backoffMs}ms`);
      await wait(backoffMs);
    }
  }
}

async function connectToDuet(baseUrl) {
  const password = $("#duetPassword").value;
  if (!password) {
    logLine("NET", "warming Duet connection via rr_upload");
    return requestDuet(`${baseUrl}/rr_upload`, { method: "GET" });
  }
  const url = new URL(`${baseUrl}/rr_connect`);
  url.searchParams.set("password", password);
  logLine("NET", "authenticating passworded Duet session via rr_connect");
  const result = await requestDuet(url, { method: "GET" });
  if (!result.opaque && Number(result.err) !== 0) throw new Error("Duet rejected that password.");
  return result;
}

let crc32Table;

function crc32(bytes) {
  if (!crc32Table) {
    crc32Table = Array.from({ length: 256 }, (_, value) => {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
      return crc >>> 0;
    });
  }
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xFF];
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, "0");
}

function gcodeUploadPayload(gcode) {
  const bytes = new TextEncoder().encode(gcode);
  return {
    body: new Blob([bytes], { type: "text/plain" }),
    byteLength: bytes.byteLength,
    crc32: crc32(bytes),
  };
}

async function verifyUploadedFile(baseUrl, filename, expectedBytes, jobId, options = {}) {
  const attempts = options.attempts || 16;
  // Opaque responses cannot expose file size. Use a conservative, size-aware
  // settle window in addition to the serialized firmware request barriers.
  const opaqueSettleMs = options.opaqueSettleMs
    ?? Math.min(12000, 1500 + Math.ceil(expectedBytes / 100000) * 500);
  const statusUrl = new URL(`${baseUrl}/rr_upload`);
  statusUrl.searchParams.set("_", Date.now());
  const fileInfoUrl = new URL(`${baseUrl}/rr_fileinfo`);
  fileInfoUrl.searchParams.set("name", `0:/gcodes/${filename}`);
  fileInfoUrl.searchParams.set("_", Date.now());

  // GET /rr_upload is the firmware's documented last-upload result. Besides
  // returning that result, it acts as a request barrier after the POST.
  const uploadStatus = await requestDuet(statusUrl, { method: "GET" });
  if (!uploadStatus.opaque && uploadStatus.err !== undefined && Number(uploadStatus.err) !== 0) {
    throw new Error("Duet reported that the upload did not finish successfully.");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    fileInfoUrl.searchParams.set("_", `${Date.now()}-${attempt}`);
    const info = await requestDuet(fileInfoUrl, { method: "GET" });
    if (info.opaque) {
      // We cannot inspect cross-origin JSON without M586 CORS permission. The
      // POST, upload-status GET, and file-info GET are deliberately serialized,
      // then given a final SD-card settle window before M32 is dispatched.
      logLine("UPLOAD", `${jobId} verification response is opaque; waiting ${opaqueSettleMs}ms before start`);
      await wait(opaqueSettleMs);
      fileInfoUrl.searchParams.set("_", `${Date.now()}-barrier`);
      await requestDuet(fileInfoUrl, { method: "GET" });
      logLine("UPLOAD", `${jobId} opaque upload barrier completed`);
      return { confirmed: false, opaque: true };
    }

    const actualBytes = Number(info.size);
    logLine("UPLOAD", `${jobId} verify ${attempt}/${attempts}: err=${info.err} size=${Number.isFinite(actualBytes) ? actualBytes : "unknown"}/${expectedBytes}`);
    if (Number(info.err) === 0 && actualBytes === expectedBytes) {
      logLine("UPLOAD", `${jobId} upload confirmed by rr_fileinfo`);
      return { confirmed: true, opaque: false };
    }
    if (attempt < attempts) await wait(250);
  }
  throw new Error(`Upload did not verify at ${expectedBytes} bytes; the job was not started.`);
}

async function uploadGcode(baseUrl, filename, gcode, jobId) {
  const payload = gcodeUploadPayload(gcode);
  const deleteUrl = new URL(`${baseUrl}/rr_delete`);
  deleteUrl.searchParams.set("name", `0:/gcodes/${filename}`);
  const uploadUrl = new URL(`${baseUrl}/rr_upload`);
  uploadUrl.searchParams.set("name", `0:/gcodes/${filename}`);
  uploadUrl.searchParams.set("time", new Date().toISOString().slice(0, 19));
  uploadUrl.searchParams.set("crc32", payload.crc32);
  logLine("UPLOAD", `${jobId} prepared ${payload.byteLength} bytes crc32=${payload.crc32}`);

  // The filename is intentionally stable. Remove the previous job before the
  // new POST so rr_fileinfo cannot mistake an equally-sized old file for the
  // upload currently being finalized.
  try {
    const deleted = await requestDuet(deleteUrl, { method: "GET" });
    logLine("UPLOAD", `${jobId} previous fixed-name job ${deleted.opaque ? "delete dispatched" : "cleared or absent"}`);
  } catch (error) {
    logLine("UPLOAD", `${jobId} could not pre-clear old file: ${error.message || error}`);
  }

  // One recovery attempt handles a stale Firefox keep-alive connection. It
  // uses the same fixed filename and CRC, so a complete first attempt is
  // replaced with identical bytes and a partial attempt is repaired.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = performance.now();
    try {
      logLine("UPLOAD", `${jobId} POST attempt ${attempt}/2 started`);
      const result = await requestDuet(uploadUrl, { method: "POST", body: payload.body, maxAttempts: 1 });
      const elapsed = Math.round(performance.now() - startedAt);
      logLine("UPLOAD", `${jobId} POST attempt ${attempt}/2 completed after ${elapsed}ms (${result.opaque ? "opaque" : "readable"} response)`);
      if (!result.opaque && result.err !== undefined && Number(result.err) !== 0) {
        throw new Error("Duet reported an upload error (the CRC or file write failed).");
      }
      setMachineStatus("Finalizing upload…", "is-busy");
      const verification = await verifyUploadedFile(baseUrl, filename, payload.byteLength, jobId);
      return { ...verification, byteLength: payload.byteLength, crc32: payload.crc32 };
    } catch (error) {
      logLine("UPLOAD", `${jobId} POST attempt ${attempt}/2 failed: ${error.name || "Error"}: ${error.message || error}`);
      if (attempt >= 2) {
        if (error.name === "TypeError") throw new Error("The board reset the upload connection twice. The job was not started; check the board network and try again.");
        throw error;
      }
      setMachineStatus("Recovering upload…", "is-busy");
      await wait(700);
      try {
        const recovered = await verifyUploadedFile(baseUrl, filename, payload.byteLength, jobId, { attempts: 3, opaqueSettleMs: 500 });
        if (recovered.confirmed) {
          logLine("UPLOAD", `${jobId} first POST succeeded despite its lost response`);
          return { ...recovered, byteLength: payload.byteLength, crc32: payload.crc32 };
        }
      } catch (verificationError) {
        logLine("UPLOAD", `${jobId} recovery check did not confirm the file: ${verificationError.message || verificationError}`);
      }
      logLine("UPLOAD", `${jobId} retrying the same filename and CRC after connection recovery`);
    }
  }
  throw new Error("Upload failed.");
}

async function testConnection() {
  let baseUrl;
  try { baseUrl = baseUrlFromEndpoint(); } catch (error) { showToast(error.message, "error"); return; }
  const button = $("#testButton");
  button.disabled = true;
  setMachineStatus("Checking…", "is-busy");
  try {
    const result = await connectToDuet(baseUrl);
    setMachineStatus(result.opaque ? "Request dispatched" : "Duet reachable", result.opaque ? "" : "is-connected");
    showToast(result.opaque ? "Request sent to Duet. A direct page cannot read the board's CORS response." : "Duet is reachable.");
  } catch (error) {
    setMachineStatus("Connection failed");
    showToast(error.message || "Could not reach the Duet.", "error");
  } finally { button.disabled = false; }
}

async function sendToPlotter() {
  if (!state.strokes.length) return;
  if (state.sendInProgress) {
    logLine("JOB", "ignored duplicate Draw click while a job is in progress");
    return;
  }
  let baseUrl;
  try { baseUrl = baseUrlFromEndpoint(); } catch (error) { showToast(error.message, "error"); return; }
  const filename = autoFileName();
  const gcode = generateGcode();
  // Only an unchanged gallery drawing earns a popularity print. Once edited,
  // the canvas is an independent draft and must not mutate the source record.
  const galleryDrawingForPrint = state.galleryDrawing && !state.galleryCopyDirty
    ? { ...state.galleryDrawing }
    : null;
  const jobId = filename.replace(/\.gcode$/, "");
  logLine("JOB", `${jobId} queued: ${gcode.split("\n").length} lines, ${state.strokes.length} strokes, ${Math.round(gcode.length / 1024)} KB, start=${$("#startAfterUpload").checked}`);

  state.sendInProgress = true;
  drawButton.disabled = true;
  drawButton.querySelector(".draw-button-word").textContent = "Sending…";
  setMachineStatus("Uploading job…", "is-busy");
  try {
    await connectToDuet(baseUrl);
    // rr_upload expects the raw G-code in the POST body — not multipart form data.
    const upload = await uploadGcode(baseUrl, filename, gcode, jobId);

    if ($("#startAfterUpload").checked) {
      setMachineStatus("Starting job…", "is-busy");
      // M32 launches the uploaded SD-card job. Supplying it via rr_gcode keeps
      // the file upload itself compatible with RepRapFirmware's raw POST API.
      // RRF's M32 takes the filename as a plain quoted string — a P parameter
      // makes it look for a file literally named `P"…"`.
      const runUrl = new URL(`${baseUrl}/rr_gcode`);
      runUrl.searchParams.set("gcode", `M32 "0:/gcodes/${filename}"`);
      logLine("JOB", `${jobId} dispatching M32 after upload ${upload.confirmed ? "confirmation" : "barrier"}`);
      // M32 is intentionally sent once. Retrying after a reset could restart an
      // already-running plot; the warm-up and upload barriers avoid the stale
      // connection that used to make Firefox lose this request.
      let runResult;
      try {
        runResult = await requestDuet(runUrl, { method: "GET", idempotent: false, maxAttempts: 1 });
      } catch (error) {
        logLine("JOB", `${jobId} M32 response lost: ${error.name || "Error"}: ${error.message || error}`);
        throw new Error("The board's start response was lost. Do not click Draw again until you check Duet Web Control; the job may already be running.");
      }
      if (!runResult.opaque && runResult.err && runResult.err !== 0) throw new Error("Duet could not start the uploaded job.");
      logLine("JOB", `${jobId} M32 ${runResult.opaque ? "dispatched with opaque response" : "accepted"}`);
      setMachineStatus("Job started", "is-connected");
      showToast(upload.opaque ? `${filename} uploaded; start command dispatched.` : `${filename} verified and started.`);
      void recordGalleryPrint(galleryDrawingForPrint);
    } else {
      setMachineStatus("Job uploaded", "is-connected");
      showToast(upload.opaque ? `${filename} uploaded after completion barrier.` : `${filename} verified in 0:/gcodes/.`);
    }
  } catch (error) {
    logLine("JOB", `${jobId} failed: ${error.name || "Error"}: ${error.message || error}`);
    setMachineStatus("Send failed");
    showToast(error.message || "Could not send the drawing to the Duet.", "error");
  } finally {
    state.sendInProgress = false;
    drawButton.querySelector(".draw-button-word").textContent = "🖨️ Draw it!";
    drawButton.disabled = state.strokes.length === 0;
  }
}

function downloadGcode() {
  if (!state.strokes.length) return;
  const filename = autoFileName();
  const blob = new Blob([generateGcode()], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast(`Saved ${filename}.`);
}

/* ---------- freehand input ---------- */

function snapshot() {
  state.undoStack.push(state.strokes.slice());
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack = [];
}

function markGalleryCopyEdited() {
  if (!state.galleryDrawing || state.galleryCopyDirty) return;
  state.galleryCopyDirty = true;
  logLine("GALLERY", `working copy of ${state.galleryDrawing.id} changed; source drawing will not be updated`);
}

function addPoint(event) {
  const point = normalizedEventPoint(event);
  const last = state.activeStroke[state.activeStroke.length - 1];
  if (!last || distance(last, point) > 0.0014) state.activeStroke.push(point);
}

function shapeStroke(tool, start, end) {
  let points;
  if (tool === "line") {
    points = [start, end];
  } else if (tool === "rectangle") {
    points = [
      start,
      { x: end.x, y: start.y },
      end,
      { x: start.x, y: end.y },
      start,
    ];
  } else {
    const centerX = (start.x + end.x) / 2;
    const centerY = (start.y + end.y) / 2;
    const radiusX = Math.abs(end.x - start.x) / 2;
    const radiusY = Math.abs(end.y - start.y) / 2;
    points = Array.from({ length: 65 }, (_, index) => {
      const angle = index / 64 * Math.PI * 2;
      return { x: centerX + Math.cos(angle) * radiusX, y: centerY + Math.sin(angle) * radiusY };
    });
  }
  points.shape = true;
  points.color = markerPalette[activeMarker];
  return points;
}

function eraseStrokeAt(stroke, center) {
  if (!stroke.length) return null;
  const sampleSpacing = ERASER_RADIUS / 3;
  const samples = [stroke[0]];
  for (let index = 1; index < stroke.length; index += 1) {
    const start = stroke[index - 1];
    const end = stroke[index];
    const steps = Math.max(1, Math.ceil(distance(start, end) / sampleSpacing));
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps;
      samples.push({
        x: start.x + (end.x - start.x) * amount,
        y: start.y + (end.y - start.y) * amount,
      });
    }
  }

  let touched = false;
  let currentPiece = [];
  const pieces = [];
  for (const point of samples) {
    if (distance(point, center) <= ERASER_RADIUS) {
      touched = true;
      if (currentPiece.length) pieces.push(currentPiece);
      currentPiece = [];
    } else {
      currentPiece.push(point);
    }
  }
  if (currentPiece.length) pieces.push(currentPiece);
  if (!touched) return null;
  for (const piece of pieces) {
    if (stroke.shape) piece.shape = true;
    if (stroke.squiggle) piece.squiggle = true;
    if (PlotterColor.isColor(stroke.color)) piece.color = stroke.color;
  }
  return pieces;
}

function eraseAt(point) {
  const nextStrokes = [];
  let changed = false;
  for (const stroke of state.strokes) {
    const pieces = eraseStrokeAt(stroke, point);
    if (pieces === null) nextStrokes.push(stroke);
    else {
      changed = true;
      nextStrokes.push(...pieces);
    }
  }
  if (!changed) return false;
  state.strokes = nextStrokes;
  state.eraserChanged = true;
  markGalleryCopyEdited();
  return true;
}

function eraseTo(point) {
  const start = state.eraserLastPoint || point;
  const steps = Math.max(1, Math.ceil(distance(start, point) / (ERASER_RADIUS / 2)));
  let changed = false;
  for (let step = 1; step <= steps; step += 1) {
    const amount = step / steps;
    changed = eraseAt({
      x: start.x + (point.x - start.x) * amount,
      y: start.y + (point.y - start.y) * amount,
    }) || changed;
  }
  state.eraserLastPoint = point;
  if (changed) {
    render();
    updateUi();
  }
}

function finishErasing(event) {
  if (!state.eraserStartStrokes) return;
  if (event && event.type !== "pointercancel") eraseTo(normalizedEventPoint(event));
  if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (state.eraserChanged) {
    state.undoStack.push(state.eraserStartStrokes);
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
  }
  state.eraserStartStrokes = null;
  state.eraserLastPoint = null;
  state.eraserChanged = false;
  updateUi();
}

/* ---------- fill (diagonal hatch) ---------- */

// Strokes rasterized as region boundaries. Drawn thicker than on screen so
// anti-aliased diagonals can't leak the flood fill.
function fillCoverageMask() {
  const size = FILL_RASTER;
  const raster = document.createElement("canvas");
  raster.width = size;
  raster.height = size;
  const rasterCtx = raster.getContext("2d", { willReadFrequently: true });
  for (const stroke of state.strokes) drawStrokeOn(rasterCtx, size, stroke, 4);
  const { data } = rasterCtx.getImageData(0, 0, size, size);
  const covered = new Uint8Array(size * size);
  for (let index = 0; index < covered.length; index += 1) {
    covered[index] = data[index * 4 + 3] > 32 ? 1 : 0;
  }
  return covered;
}

// 4-connected flood fill from the tapped pixel; returns the region mask, or
// null when the tap landed on a stroke.
function floodRegion(covered, startX, startY) {
  const size = FILL_RASTER;
  const start = startY * size + startX;
  if (covered[start]) return null;
  const inside = new Uint8Array(size * size);
  const stack = [start];
  inside[start] = 1;
  while (stack.length) {
    const index = stack.pop();
    const x = index % size;
    const neighbors = [x > 0 ? index - 1 : -1, x < size - 1 ? index + 1 : -1, index - size, index + size];
    for (const neighbor of neighbors) {
      if (neighbor >= 0 && neighbor < inside.length && !inside[neighbor] && !covered[neighbor]) {
        inside[neighbor] = 1;
        stack.push(neighbor);
      }
    }
  }
  return inside;
}


function hatchStrokes(inside) {
  return PlotterFill.hatchStrokes(inside, FILL_RASTER, FILL_SPACING, FILL_EDGE_GAP);
}


function svgFillStrokes(inside) {
  return PlotterFill.svgFillStrokes(inside, FILL_RASTER, FILL_SPACING, FILL_EDGE_GAP);
}

function fillAt(point) {
  const size = FILL_RASTER;
  const x = Math.min(size - 1, Math.floor(point.x * size));
  const y = Math.min(size - 1, Math.floor(point.y * size));
  const inside = floodRegion(fillCoverageMask(), x, y);
  const hatch = inside ? hatchStrokes(inside) : [];
  if (!hatch.length) {
    showToast("Tap an open area to fill it.", "error");
    return;
  }
  snapshot();
  markGalleryCopyEdited();
  for (const stroke of hatch) stroke.color = markerPalette[activeMarker];
  state.strokes = state.strokes.concat(hatch);
  render();
  updateUi();
  logLine("DRAW", `fill added ${hatch.length} hatch lines`);
}

function setDrawingTool(tool) {
  if (!["pencil", "line", "rectangle", "ellipse", "fill", "eraser"].includes(tool)) return;
  state.drawingTool = tool;
  plottingBed.classList.toggle("using-eraser", tool === "eraser");
  for (const button of $$('[data-drawing-tool]')) {
    const active = button.dataset.drawingTool === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  logLine("DRAW", `tool=${tool}`);
}

canvas.addEventListener("pointerdown", (event) => {
  if (state.sourceImage) return;
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  const point = normalizedEventPoint(event);
  if (state.drawingTool === "eraser") {
    state.eraserStartStrokes = state.strokes;
    state.eraserLastPoint = point;
    state.eraserChanged = false;
    if (eraseAt(point)) {
      render();
      updateUi();
    }
    return;
  }
  if (state.drawingTool === "fill") {
    fillAt(point);
    return;
  }
  state.shapeStart = point;
  state.activeStroke = state.drawingTool === "pencil" ? [point] : shapeStroke(state.drawingTool, point, point);
  state.activeStroke.color = markerPalette[activeMarker];
  updateUi();
  render();
});

canvas.addEventListener("pointermove", (event) => {
  if (state.eraserStartStrokes) {
    event.preventDefault();
    const coalesced = event.getCoalescedEvents ? event.getCoalescedEvents() : [];
    for (const pointEvent of coalesced.length ? coalesced : [event]) eraseTo(normalizedEventPoint(pointEvent));
    return;
  }
  if (!state.activeStroke) return;
  event.preventDefault();
  if (state.drawingTool === "pencil") {
    const coalesced = event.getCoalescedEvents ? event.getCoalescedEvents() : [];
    for (const pointEvent of coalesced.length ? coalesced : [event]) addPoint(pointEvent);
  } else {
    const color = state.activeStroke.color;
    state.activeStroke = shapeStroke(state.drawingTool, state.shapeStart, normalizedEventPoint(event));
    state.activeStroke.color = color;
  }
  render();
});

function finishStroke(event) {
  if (state.eraserStartStrokes) {
    finishErasing(event);
    return;
  }
  if (!state.activeStroke) return;
  if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  snapshot();
  markGalleryCopyEdited();
  state.strokes = state.strokes.concat([state.activeStroke]);
  state.activeStroke = null;
  state.shapeStart = null;
  render();
  updateUi();
}

canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);

for (const button of $$('[data-drawing-tool]')) {
  button.addEventListener("click", () => setDrawingTool(button.dataset.drawingTool));
}

function undo() {
  if (!state.undoStack.length) return;
  markGalleryCopyEdited();
  state.redoStack.push(state.strokes);
  state.strokes = state.undoStack.pop();
  render();
  updateUi();
}

function redo() {
  if (!state.redoStack.length) return;
  markGalleryCopyEdited();
  state.undoStack.push(state.strokes);
  state.strokes = state.redoStack.pop();
  render();
  updateUi();
}

function clearDrawing() {
  if (!state.strokes.length) return;
  snapshot();
  markGalleryCopyEdited();
  state.strokes = [];
  setSquiggleSource(null);
  render();
  updateUi();
}

/* ---------- squiggle (after mitxela's plotterfun squiggle.js) ---------- */

function squiggleParams() {
  const limits = state.squigglePreset === "selfie" ? {
    lines: Number($("#sqLines").max) || SELFIE_SQUIGGLE_LIMITS.lines,
    amp: Number($("#sqAmp").max) || SELFIE_SQUIGGLE_LIMITS.amp,
  } : DEFAULT_SQUIGGLE_LIMITS;
  return {
    lineCount: Math.min(safeNumber($("#sqLines").value, 40, 1), limits.lines),
    frequency: safeNumber($("#sqFreq").value, 60, 1),
    amplitude: Math.min(safeNumber($("#sqAmp").value, 1.5, 0.1), limits.amp),
    brightness: Number($("#sqBright").value) || 0,
    contrast: Number($("#sqContrast").value) || 0,
    modulation: $("#sqMod").value,
    sizePercent: Math.min(safeNumber($("#sqSize").value, 100, 25), 100),
  };
}

// Brightness/contrast-adjusted darkness (0 = white, 255 = black) per pixel.
function pixelProcessor(image, brightness, contrast) {
  const { data, width } = image;
  const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  return (x, y) => {
    const i = 4 * (Math.floor(x) + Math.floor(y) * width);
    const adjust = (value) => contrastFactor * (value - 128) + 128 + brightness;
    const b = 0.2125 * adjust(data[i]) + 0.7154 * adjust(data[i + 1]) + 0.0721 * adjust(data[i + 2]);
    return Math.max(255 - Math.max(b, 0), 0);
  };
}

// Vertical scanlines drawn as pure sine waves whose local frequency (FM)
// and/or amplitude (AM) follow image darkness. The y step adapts so every
// sine cycle gets at least 8 samples — a fixed step aliases at high
// frequency, which shows up as interference-looking noise, not clean waves.
function squiggleStrokes(image) {
  const { lineCount, frequency, amplitude, brightness, contrast, modulation, sizePercent } = squiggleParams();
  const getPixel = pixelProcessor(image, brightness, contrast);
  const { width, height } = image;
  // Narrow sources (portrait selfies) keep full height and sit centered
  // horizontally; the size slider shrinks the whole plot about the center.
  // Line count, wavelength, and amplitude all track the plotted extent so
  // stroke spacing and wave shape on paper match a full-size full-frame plot.
  const scale = sizePercent / 100;
  const aspect = Math.min(1, width / height);
  const xSpan = aspect * scale;
  const xOffset = (1 - xSpan) / 2;
  const yOffset = (1 - scale) / 2;
  const lineTotal = Math.max(1, Math.round(lineCount * xSpan));
  const spacing = width / lineTotal;
  // The frequency slider counts full sine cycles down a full page at black.
  const omegaMax = (2 * Math.PI * frequency * scale) / height; // rad per px
  const maxPhaseStep = Math.PI / 4;
  const strokes = [];

  // Transparent pixels (removed background) break a scanline into segments
  // so the pen lifts over them instead of drawing a flat line through.
  const alphaAt = (x, y) => image.data[4 * (Math.floor(x) + Math.floor(y) * width) + 3];

  for (let lineIndex = 0; lineIndex < lineTotal; lineIndex += 1) {
    const x = spacing * (lineIndex + 0.5);
    let phase = 0;
    let y = 0;
    let line = [];
    const flushLine = () => {
      if (line.length > 1) {
        line.squiggle = true;
        strokes.push(line);
      }
      line = [];
    };
    while (true) {
      const sampleY = Math.min(y, height - 1);
      const blank = alphaAt(x, sampleY) < 128;
      const z = blank ? 0 : getPixel(x, sampleY);
      if (blank) {
        flushLine();
      } else {
        const zAmp = modulation === "FM" ? 255 : z;
        const r = amplitude * zAmp / lineCount / scale;
        line.push({
          x: xOffset + xSpan * Math.max(0, Math.min(1, (x + Math.sin(phase) * r) / width)),
          y: yOffset + scale * (y / height),
        });
      }
      if (y >= height) break;
      const zFreq = modulation === "AM" ? 255 : z;
      const omega = omegaMax * zFreq / 255;
      const step = omega > 0 ? Math.min(3, Math.max(0.25, maxPhaseStep / omega)) : 3;
      y = Math.min(y + step, height);
      phase += omega * step;
    }
    flushLine();
  }
  return strokes;
}

function setSquiggleSource(image) {
  state.sourceImage = image;
  squigglePanel.classList.toggle("hidden", !image);
  $("#retakeButton").classList.toggle("hidden", !(image && state.squigglePreset === "selfie"));
}

function regenerateSquiggle() {
  if (!state.sourceImage) return;
  state.strokes = squiggleStrokes(state.sourceImage);
  for (const stroke of state.strokes) stroke.color = markerPalette[activeMarker];
  state.undoStack = [];
  state.redoStack = [];
  state.activeStroke = null;
  render();
  updateUi();
}

// Emoji are pure black-on-white; camera shots are soft and mid-gray, so the
// selfie preset trades in extra contrast and finer lines. The selfie factory
// values can be overridden from the admin panel (stored in localStorage).
const SQUIGGLE_PRESETS = {
  premade: { lines: 40, freq: 60, amp: 1.5, bright: 0, contrast: 0, mod: "both", size: 100 },
  selfie: { lines: 45, freq: 90, amp: 1.5, bright: 0, contrast: 40, mod: "AM", size: 100 },
};

const SELFIE_PRESET_KEY = "selfiePreset";

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function getSelfiePreset() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(SELFIE_PRESET_KEY)) || {}; } catch { /* corrupted store */ }
  const factory = SQUIGGLE_PRESETS.selfie;
  const maxLines = clampNumber(stored.maxLines, 10, DEFAULT_SQUIGGLE_LIMITS.lines, SELFIE_SQUIGGLE_LIMITS.lines);
  const maxAmp = clampNumber(stored.maxAmp, 0.1, DEFAULT_SQUIGGLE_LIMITS.amp, SELFIE_SQUIGGLE_LIMITS.amp);
  return {
    maxLines,
    maxAmp,
    lines: clampNumber(stored.lines, 10, maxLines, factory.lines),
    freq: clampNumber(stored.freq, 20, 100, factory.freq),
    amp: clampNumber(stored.amp, 0.1, maxAmp, factory.amp),
    bright: clampNumber(stored.bright, -100, 100, factory.bright),
    contrast: clampNumber(stored.contrast, -100, 100, factory.contrast),
    mod: ["both", "AM", "FM"].includes(stored.mod) ? stored.mod : factory.mod,
    size: clampNumber(stored.size, 25, 100, factory.size),
  };
}

function applySquigglePreset(name) {
  state.squigglePreset = name;
  const preset = name === "selfie" ? getSelfiePreset() : SQUIGGLE_PRESETS[name];
  const limits = name === "selfie" ? { lines: preset.maxLines, amp: preset.maxAmp } : DEFAULT_SQUIGGLE_LIMITS;
  $("#sqLines").max = String(limits.lines);
  $("#sqAmp").max = String(limits.amp);
  for (const [slider, output, value] of [
    ["#sqLines", "#sqLinesValue", preset.lines], ["#sqFreq", "#sqFreqValue", preset.freq],
    ["#sqAmp", "#sqAmpValue", preset.amp], ["#sqBright", "#sqBrightValue", preset.bright],
    ["#sqContrast", "#sqContrastValue", preset.contrast], ["#sqSize", "#sqSizeValue", preset.size],
  ]) {
    $(slider).value = value;
    $(output).textContent = String(value);
  }
  $("#sqMod").value = preset.mod;
  $("#removeBgRow").classList.toggle("hidden", name !== "selfie");
}

function applySquiggleSource(image, preset = "premade") {
  logLine("APP", `squiggle source set (${preset} preset)`);
  clearGalleryDrawing();
  state.premadeSource = preset === "premade" ? "squiggle" : null;
  applySquigglePreset(preset);
  setSquiggleSource(image);
  showView("draw");
  regenerateSquiggle();
}

for (const [slider, output] of [
  ["#sqLines", "#sqLinesValue"], ["#sqFreq", "#sqFreqValue"], ["#sqAmp", "#sqAmpValue"],
  ["#sqBright", "#sqBrightValue"], ["#sqContrast", "#sqContrastValue"], ["#sqSize", "#sqSizeValue"],
]) {
  $(slider).addEventListener("input", () => {
    $(output).textContent = $(slider).value;
    regenerateSquiggle();
  });
}
$("#sqMod").addEventListener("change", regenerateSquiggle);

$("#sqReset").addEventListener("click", () => {
  applySquigglePreset(state.squigglePreset || "premade");
  regenerateSquiggle();
});

/* ---------- selfie ---------- */

let cameraStream = null;

async function startCamera() {
  $("#cameraError").classList.add("hidden");
  // Load and compile the segmentation model while the visitor lines up their
  // shot, so the first background-removal tap does not pay the cold-start cost.
  warmSegmenter().catch((error) => logLine("SELFIE", `segmenter warm-up failed: ${error.message || error}`));
  if (cameraStream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError("This browser can't open a camera. Try Chrome or Safari over HTTPS.");
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 960 } },
      audio: false,
    });
    cameraVideo.srcObject = cameraStream;
  } catch {
    showCameraError("Could not open the camera. Check the browser's camera permission and try again.");
  }
}

function stopCamera() {
  if (!cameraStream) return;
  for (const track of cameraStream.getTracks()) track.stop();
  cameraStream = null;
  cameraVideo.srcObject = null;
}

function showCameraError(message) {
  const box = $("#cameraError");
  box.textContent = message;
  box.classList.remove("hidden");
}

// Mirrored center-crop of the live video, matching what the preview shows.
// 3:4 takes a portrait crop: full height, three quarters of the width.
function captureFrame() {
  const video = cameraVideo;
  const srcHeight = Math.min(video.videoWidth, video.videoHeight);
  const srcWidth = state.selfieSize === "3:4" ? srcHeight * 0.75 : srcHeight;
  const sx = (video.videoWidth - srcWidth) / 2;
  const sy = (video.videoHeight - srcHeight) / 2;
  const outWidth = Math.round(SOURCE_SIZE * (srcWidth / srcHeight));
  const frame = document.createElement("canvas");
  frame.width = outWidth;
  frame.height = SOURCE_SIZE;
  const frameCtx = frame.getContext("2d");
  frameCtx.translate(outWidth, 0);
  frameCtx.scale(-1, 1);
  frameCtx.drawImage(video, sx, sy, srcWidth, srcHeight, 0, 0, outWidth, SOURCE_SIZE);
  return frameCtx.getImageData(0, 0, outWidth, SOURCE_SIZE);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- background removal (on-device ML, vendored TF.js) ---------- */

const REMOVE_BG_KEY = "smallPlotter.removeBackground";
let segmenterPromise = null;
let segmenterWarmupPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(script);
  });
}

// Lazily loads the vendored TF.js runtime and the MediaPipe selfie
// segmentation model. Both arrive via plain script tags with the weights
// embedded, so this works offline and straight from file://.
function loadSegmenter() {
  segmenterPromise ||= (async () => {
    if (!window.tf) await loadScript("vendor/tf.min.js");
    if (!window.SELFIE_MODEL) await loadScript("vendor/selfie-model.js");
    const { modelJson, weightsBase64 } = window.SELFIE_MODEL;
    const binary = atob(weightsBase64);
    const weightData = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) weightData[i] = binary.charCodeAt(i);
    return tf.loadGraphModel({
      load: async () => ({
        modelTopology: modelJson.modelTopology,
        weightSpecs: modelJson.weightsManifest.flatMap((group) => group.weights),
        weightData: weightData.buffer,
      }),
    });
  })();
  segmenterPromise.catch(() => { segmenterPromise = null; }); // allow a retry after a failure
  return segmenterPromise;
}

// Run one dummy inference to initialize the TensorFlow backend and compile the
// model's kernels before a real selfie needs them.
function warmSegmenter() {
  segmenterWarmupPromise ||= (async () => {
    const model = await loadSegmenter();
    await tf.ready();
    const [, inputHeight, inputWidth] = model.inputs[0].shape;
    const outputs = tf.tidy(() => {
      const result = model.predict(tf.zeros([1, inputHeight, inputWidth, 3]));
      return Array.isArray(result) ? result : [result];
    });
    try {
      await Promise.all(outputs.map((output) => output.data()));
    } finally {
      for (const output of outputs) output.dispose();
    }
    return model;
  })();
  segmenterWarmupPromise.catch(() => { segmenterWarmupPromise = null; });
  return segmenterWarmupPromise;
}

// Person-probability mask for the photo, one float (0..1) per pixel.
async function personMask(image) {
  const model = await warmSegmenter();
  const [, inputHeight, inputWidth] = model.inputs[0].shape;
  const maskTensor = tf.tidy(() => {
    const input = tf.image.resizeBilinear(tf.browser.fromPixels(image), [inputHeight, inputWidth])
      .toFloat().div(255).expandDims(0);
    const output = model.predict(input);
    const channels = Array.isArray(output) ? output[0] : output;
    // The model emits [background, person] channels; keep the person one.
    const person = channels.squeeze([0]).slice([0, 0, 1], [-1, -1, 1]);
    return tf.image.resizeBilinear(person, [image.height, image.width]);
  });
  const values = await maskTensor.data();
  maskTensor.dispose();
  return values;
}

// Cached background-removed copy of the current capture, so the panel
// checkbox can flip back and forth without re-running the model.
async function removedSelfieImage() {
  if (state.selfieRemoved) return state.selfieRemoved;
  if (state.selfieRemovalPromise) return state.selfieRemovalPromise;
  const original = state.selfieOriginal;
  if (!original) return null;
  const removalPromise = (async () => {
    const copy = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
    if (!(await removeBackground(copy)) || state.selfieOriginal !== original) return null;
    state.selfieRemoved = copy;
    return copy;
  })();
  state.selfieRemovalPromise = removalPromise;
  removalPromise.catch(() => {
    if (state.selfieRemovalPromise === removalPromise) state.selfieRemovalPromise = null;
  });
  return removalPromise;
}

// ML background removal: whites out low person-confidence pixels and marks
// them transparent, which the squiggler skips. Returns false when the mask
// looks untrustworthy (almost nobody or almost no background in frame).
async function removeBackground(image) {
  const mask = await personMask(image);
  const { width, height, data } = image;
  // Insurance against channel-order surprises: the subject sits in the
  // center of a selfie, so the center must outscore the corners.
  const at = (x, y) => mask[Math.floor(y) * width + Math.floor(x)];
  const centerScore = at(width / 2, height / 2) + at(width / 2, height * 0.4) + at(width * 0.4, height / 2);
  const cornerScore = at(2, 2) + at(width - 3, 2) + at(2, height * 0.3);
  const person = (index) => (centerScore >= cornerScore ? mask[index] : 1 - mask[index]);

  let kept = 0;
  for (let index = 0; index < width * height; index += 1) {
    if (person(index) >= 0.5) kept += 1;
  }
  const fraction = kept / (width * height);
  if (fraction < 0.08 || fraction > 0.92) return false;

  for (let index = 0; index < width * height; index += 1) {
    if (person(index) >= 0.5) continue;
    const i = index * 4;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 0;
  }
  return true;
}

async function takeSelfie() {
  if (!cameraStream || cameraVideo.readyState < 2) {
    showToast("The camera isn't ready yet.", "error");
    return;
  }
  snapButton.disabled = true;
  const countdown = $("#countdown");
  countdown.classList.remove("hidden");
  for (const step of ["3", "2", "1"]) {
    countdown.textContent = step;
    countdown.classList.remove("tick");
    void countdown.offsetWidth; // restart the pop animation
    countdown.classList.add("tick");
    await wait(1000);
  }
  countdown.classList.add("hidden");

  const flash = $("#flash");
  flash.classList.add("snap");
  const image = captureFrame();
  state.selfieOriginal = image;
  state.selfieRemoved = null;
  state.selfieRemovalPromise = null;
  // Start removal during the shutter flash even when the toggle is off. The
  // result is cached, making a later first tap use already-started work.
  const removalPromise = removedSelfieImage();
  removalPromise.catch(() => {}); // handled if/when the visitor enables it
  await wait(350);
  flash.classList.remove("snap");
  let source = image;
  if (removeBackgroundToggle.checked) {
    try {
      const removed = await removalPromise;
      if (removed) source = removed;
      else {
        setRemoveBackgroundChecked(false);
        showToast("Couldn't pick out the background — keeping the whole photo.", "error");
      }
    } catch (error) {
      logLine("SELFIE", `background removal failed: ${error.message || error}`);
      setRemoveBackgroundChecked(false);
      showToast("Couldn't pick out the background — keeping the whole photo.", "error");
    }
  }
  snapButton.disabled = false;
  applySquiggleSource(source, "selfie");
}

snapButton.addEventListener("click", takeSelfie);
$("#retakeButton").addEventListener("click", () => showView("selfie"));

const SELFIE_SIZE_KEY = "smallPlotter.selfieSize";

function setSelfieSize(size) {
  state.selfieSize = size;
  $("#cameraWrap").classList.toggle("portrait", size === "3:4");
  for (const button of $$("#selfieSizeToggle button")) {
    button.classList.toggle("active", button.dataset.size === size);
  }
  try { localStorage.setItem(SELFIE_SIZE_KEY, size); } catch { /* private mode */ }
}

for (const button of $$("#selfieSizeToggle button")) {
  button.addEventListener("click", () => setSelfieSize(button.dataset.size));
}

setSelfieSize(localStorage.getItem(SELFIE_SIZE_KEY) === "square" ? "square" : "3:4");

const removeBackgroundToggle = $("#removeBackground");
removeBackgroundToggle.checked = localStorage.getItem(REMOVE_BG_KEY) === "1";

function setRemoveBackgroundChecked(checked) {
  removeBackgroundToggle.checked = checked;
  try { localStorage.setItem(REMOVE_BG_KEY, checked ? "1" : "0"); } catch { /* private mode */ }
}

// Flipping the checkbox re-processes the selfie already on the canvas.
removeBackgroundToggle.addEventListener("change", async () => {
  setRemoveBackgroundChecked(removeBackgroundToggle.checked);
  if (removeBackgroundToggle.checked) {
    warmSegmenter().catch((error) => logLine("SELFIE", `segmenter warm-up failed: ${error.message || error}`));
  }
  const original = state.selfieOriginal;
  if (!state.sourceImage || state.squigglePreset !== "selfie" || !original) return;
  if (!removeBackgroundToggle.checked) {
    setSquiggleSource(original);
    regenerateSquiggle();
    return;
  }
  try {
    const removed = await removedSelfieImage();
    if (state.selfieOriginal !== original || !removeBackgroundToggle.checked) return; // stale toggle
    if (!removed) {
      setRemoveBackgroundChecked(false);
      showToast("Couldn't pick out the background — keeping the whole photo.", "error");
      return;
    }
    setSquiggleSource(removed);
    regenerateSquiggle();
  } catch (error) {
    logLine("SELFIE", `background removal failed: ${error.message || error}`);
    setRemoveBackgroundChecked(false);
    showToast("Couldn't pick out the background — keeping the whole photo.", "error");
  }
});

/* ---------- premade pictures ---------- */

function parsePremadeGcode(gcode) {
  const rawStrokes = [];
  let activeStroke = null;
  let x = null;
  let y = null;
  const usesServoPenControl = /^\s*M280\b/im.test(gcode);
  let penDown = false;
  let marker = 0;

  function finishStroke() {
    if (activeStroke?.length > 1) { activeStroke.color = markerPalette[marker]; rawStrokes.push(activeStroke); }
    activeStroke = null;
  }

  for (const line of gcode.split(/\r?\n/)) {
    const toolMatch = line.match(/^\s*T([0-7])(?:\s|;|$)/i);
    if (toolMatch) { finishStroke(); marker = Number(toolMatch[1]); continue; }
    const servoMatch = line.match(/^\s*M280\b.*?\bS(-?(?:\d+\.?\d*|\.\d+))/i);
    if (usesServoPenControl && servoMatch) {
      const nextPenDown = Number(servoMatch[1]) >= 100;
      if (penDown && !nextPenDown) finishStroke();
      penDown = nextPenDown;
      if (penDown && Number.isFinite(x) && Number.isFinite(y)) activeStroke = [{ x, y }];
      continue;
    }

    const command = line.match(/^\s*(G0|G1)\b/i)?.[1]?.toUpperCase();
    if (!command) continue;
    // G-code permits adjacent addresses, e.g. `G1 X5.88Y10.88F10000`.
    // Do not require a word boundary before Y: the preceding X value ends in
    // a digit, which is also a word character.
    const xMatch = line.match(/X(-?(?:\d+\.?\d*|\.\d+))/i);
    const yMatch = line.match(/Y(-?(?:\d+\.?\d*|\.\d+))/i);
    if (xMatch) x = Number(xMatch[1]);
    if (yMatch) y = Number(yMatch[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const point = { x, y };

    if (usesServoPenControl) {
      if (!penDown) continue;
      if (!activeStroke) activeStroke = [point];
      else {
        const previous = activeStroke[activeStroke.length - 1];
        if (previous.x !== point.x || previous.y !== point.y) activeStroke.push(point);
      }
      continue;
    }

    if (command === "G0") {
      finishStroke();
      activeStroke = [point];
    } else if (activeStroke) {
      const previous = activeStroke[activeStroke.length - 1];
      if (previous.x !== point.x || previous.y !== point.y) activeStroke.push(point);
    }
  }
  finishStroke();
  if (!rawStrokes.length) throw new Error("This G-code does not contain any drawable paths.");

  const points = rawStrokes.flat();
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = maxX - minX;
  const height = maxY - minY;
  const span = Math.max(width, height);
  if (!Number.isFinite(span) || span <= 0) throw new Error("This G-code has invalid coordinates.");
  const offsetX = (span - width) / 2;
  const offsetY = (span - height) / 2;

  return rawStrokes.map((rawStroke) => {
    const stroke = rawStroke.map((point) => ({
      x: (point.x - minX + offsetX) / span,
      // Plotter coordinates grow upward; canvas coordinates grow downward.
      y: 1 - (point.y - minY + offsetY) / span,
    }));
    stroke.shape = true;
    stroke.color = rawStroke.color;
    return stroke;
  });
}

async function openPremade(drawing, button) {
  button.disabled = true;
  logLine("PREMADE", `loading ${drawing.name} preview paths from ${drawing.gcode}`);
  try {
    const response = await fetch(drawing.gcode, { cache: "no-store" });
    if (!response.ok) throw new Error(`${drawing.name} G-code returned HTTP ${response.status}`);
    const gcode = await response.text();
    const strokes = parsePremadeGcode(gcode);
    setSquiggleSource(null);
    clearGalleryDrawing();
    state.premadeSource = drawing.name;
    state.strokes = strokes;
    state.undoStack = [];
    state.redoStack = [];
    state.activeStroke = null;
    setDrawingTool("pencil");
    showView("draw");
    render();
    updateUi();
    logLine("PREMADE", `${drawing.name} loaded: ${strokes.length} G-code paths, ${strokes.reduce((sum, stroke) => sum + stroke.length, 0)} points`);
  } catch (error) {
    logLine("PREMADE", `${drawing.name} load failed: ${error.message || error}`);
    showToast(error.message || `Could not load ${drawing.name}.`, "error");
  } finally {
    button.disabled = false;
  }
}

let premadesLoaded = false;
let premadesLoading = null;

function renderPremades(drawings) {
  const grid = $("#premadeGrid");
  grid.replaceChildren();
  for (const drawing of drawings) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "premade-card premade-image-card";
    button.setAttribute("aria-label", `Open ${drawing.name} premade drawing`);
    if (drawing.thumbnail) {
      const preview = document.createElement("img");
      preview.src = drawing.thumbnail;
      preview.alt = "";
      preview.loading = "lazy";
      button.appendChild(preview);
    } else {
      button.classList.add("premade-missing-thumbnail");
      button.textContent = drawing.name;
    }
    button.addEventListener("click", () => openPremade(drawing, button));
    grid.appendChild(button);
  }
}

async function loadPremades() {
  if (premadesLoaded) return;
  if (premadesLoading) return premadesLoading;
  premadesLoading = (async () => {
    try {
      const result = await galleryRequest("/api/premades");
      renderPremades(Array.isArray(result.drawings) ? result.drawings : []);
      premadesLoaded = true;
    } catch (error) {
      logLine("PREMADE", `could not load asset list: ${error.message || error}`);
      showToast("Built-in pictures are temporarily unavailable.", "error");
    } finally {
      premadesLoading = null;
    }
  })();
  return premadesLoading;
}

/* ---------- saved drawings gallery ---------- */

let galleryLoadSequence = 0;

function createDrawingId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function localDrawings() {
  try {
    const drawings = JSON.parse(localStorage.getItem(SAVED_DRAWINGS_KEY));
    return Array.isArray(drawings) ? drawings : [];
  } catch (error) {
    logLine("GALLERY", `could not read local drawings: ${error.message || error}`);
    return [];
  }
}

function writeLocalDrawings(drawings) {
  try {
    localStorage.setItem(SAVED_DRAWINGS_KEY, JSON.stringify(drawings));
    return true;
  } catch (error) {
    logLine("GALLERY", `could not write local drawings: ${error.message || error}`);
    return false;
  }
}

function upsertLocalDrawing(drawing) {
  const drawings = localDrawings();
  const index = drawings.findIndex((item) => item.id === drawing.id);
  if (index === -1) drawings.push(drawing);
  else drawings[index] = drawing;
  return writeLocalDrawings(drawings);
}

function removeLocalDrawing(id) {
  return writeLocalDrawings(localDrawings().filter((drawing) => drawing.id !== id));
}

async function galleryRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let result = {};
  try { result = await response.json(); } catch { /* response had no JSON */ }
  if (!response.ok) throw new Error(result.error || `Gallery returned HTTP ${response.status}`);
  return result;
}

function mergedDrawings(publicDrawings, browserDrawings) {
  const byId = new Map();
  for (const drawing of browserDrawings) byId.set(drawing.id, { ...drawing, localOnly: drawing.localOnly !== false });
  for (const drawing of publicDrawings) byId.set(drawing.id, { ...drawing, localOnly: false });
  const drawings = Array.from(byId.values());
  if ($("#gallerySort").value === "popular") {
    drawings.sort((a, b) => (Number(b.prints) || 0) - (Number(a.prints) || 0) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } else {
    drawings.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  return drawings;
}

function paintDrawingPreview(previewCanvas, strokes) {
  const previewContext = previewCanvas.getContext("2d");
  const size = previewCanvas.width;
  previewContext.setTransform(1, 0, 0, 1, 0, 0);
  previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewContext.fillStyle = "#fff";
  previewContext.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  for (const stroke of strokes) drawStrokeOn(previewContext, size, stroke, Math.max(1.5, size / 210));
}

function galleryDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved drawing" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function renderGallery() {
  const gallery = $("#savedGallery");
  gallery.replaceChildren();
  for (const drawing of state.galleryDrawings) {
    const card = document.createElement("article");
    card.className = "saved-drawing-card";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "saved-card-open";
    const remixDescription = drawing.remixOf
      ? `, remix of ${drawing.remixOf.name} by ${drawing.remixOf.artist}`
      : "";
    openButton.setAttribute("aria-label", `Open ${drawing.name} by ${drawing.artist}${remixDescription}`);
    const preview = document.createElement("canvas");
    preview.width = 300;
    preview.height = 300;
    paintDrawingPreview(preview, deserializeStrokes(drawing.strokes));
    const copy = document.createElement("span");
    copy.className = "saved-card-copy";
    const title = document.createElement("strong");
    title.textContent = drawing.name;
    const artist = document.createElement("span");
    artist.textContent = `by ${drawing.artist}`;
    const remix = drawing.remixOf && document.createElement("span");
    if (remix) {
      remix.className = "saved-card-remix";
      remix.textContent = `↪ Remix of ${drawing.remixOf.name} by ${drawing.remixOf.artist}`;
    }
    const meta = document.createElement("span");
    meta.className = "saved-card-meta";
    const date = document.createElement("span");
    date.textContent = drawing.localOnly ? "On this browser" : galleryDate(drawing.createdAt);
    const prints = document.createElement("span");
    prints.textContent = `${Number(drawing.prints) || 0} print${Number(drawing.prints) === 1 ? "" : "s"}`;
    meta.append(date, prints);
    copy.append(title, artist);
    if (remix) copy.appendChild(remix);
    copy.appendChild(meta);
    openButton.append(preview, copy);
    openButton.addEventListener("click", () => openGalleryDrawing(drawing));
    card.appendChild(openButton);

    if (state.galleryDeleteMode && state.adminUnlocked) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "gallery-delete-button";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => deleteGalleryDrawing(drawing));
      card.appendChild(deleteButton);
    }
    gallery.appendChild(card);
  }
  $("#galleryStatus").classList.toggle("hidden", state.galleryDrawings.length > 0);
  if (!state.galleryDrawings.length) $("#galleryStatus").textContent = "No drawings have been saved yet. Make the first one!";
}

async function loadGallery() {
  const sequence = ++galleryLoadSequence;
  $("#galleryStatus").classList.remove("hidden");
  $("#galleryStatus").textContent = "Loading saved drawings…";
  let publicDrawings = [];
  let publicError = null;
  try {
    const result = await galleryRequest(`/api/drawings?sort=${encodeURIComponent($("#gallerySort").value)}`);
    publicDrawings = result.drawings || [];
  } catch (error) {
    publicError = error;
    logLine("GALLERY", `public gallery unavailable: ${error.message || error}`);
  }
  if (sequence !== galleryLoadSequence) return;
  state.galleryDrawings = mergedDrawings(publicDrawings, localDrawings());
  renderGallery();
  if (publicError && !state.galleryDrawings.length) $("#galleryStatus").textContent = "Public drawings are temporarily unavailable.";
  else if (publicError) showToast("Showing drawings saved in this browser; the public gallery is offline.", "error");
}

function updateSavedDrawingBanner() {
  const drawing = state.galleryDrawing;
  $("#savedDrawingBanner").classList.toggle("hidden", !drawing);
  if (!drawing) return;
  $("#savedDrawingAttribution").textContent = `Editing a copy of ${drawing.name} by ${drawing.artist}`;
  const count = Number(drawing.prints) || 0;
  $("#savedDrawingPrints").textContent = `${count} public print${count === 1 ? "" : "s"}`;
}

function clearGalleryDrawing() {
  state.galleryDrawing = null;
  state.galleryCopyDirty = false;
  updateSavedDrawingBanner();
}

function openGalleryDrawing(drawing) {
  state.sourceImage = null;
  state.premadeSource = null;
  squigglePanel.classList.add("hidden");
  state.galleryDrawing = { ...drawing };
  state.galleryCopyDirty = false;
  state.strokes = deserializeStrokes(drawing.strokes);
  state.undoStack = [];
  state.redoStack = [];
  state.activeStroke = null;
  $("#retakeButton").classList.add("hidden");
  updateSavedDrawingBanner();
  showView("draw");
  render();
  updateUi();
  logLine("GALLERY", `opened editable copy of ${drawing.id} (${drawing.name} by ${drawing.artist}); original remains unchanged`);
}

async function deleteGalleryDrawing(drawing) {
  if (!state.adminUnlocked || !state.galleryDeleteMode) return;
  if (!window.confirm(`Delete “${drawing.name}” by ${drawing.artist}?`)) return;
  try {
    if (!drawing.localOnly) {
      await galleryRequest(`/api/drawings/${encodeURIComponent(drawing.id)}`, {
        method: "DELETE",
        headers: { "x-admin-password": ADMIN_PASSWORD },
      });
    }
    removeLocalDrawing(drawing.id);
    showToast(`Deleted ${drawing.name}.`);
    await loadGallery();
  } catch (error) {
    showToast(error.message || "Could not delete that drawing.", "error");
  }
}

async function deleteAllGalleryDrawings() {
  if (!state.adminUnlocked) return;
  if (!window.confirm("Are you sure you want to permanently delete ALL saved drawings? This cannot be undone.")) return;
  const button = $("#deleteAllDrawings");
  button.disabled = true;
  try {
    await galleryRequest("/api/drawings", {
      method: "DELETE",
      headers: { "x-admin-password": ADMIN_PASSWORD },
    });
    writeLocalDrawings([]);
    state.galleryDrawings = [];
    renderGallery();
    showToast("All saved drawings were deleted.");
  } catch (error) {
    showToast(error.message || "Could not delete saved drawings.", "error");
  } finally {
    button.disabled = false;
  }
}

function openSaveDrawingModal() {
  if (!state.strokes.length || state.sourceImage) return;
  $("#drawingName").value = "";
  $("#drawerName").value = "";
  $("#savePreviewName").textContent = "Your drawing";
  $("#savePreviewArtist").textContent = "Your name";
  const remixNote = $("#saveRemixNote");
  remixNote.classList.toggle("hidden", !state.galleryDrawing);
  remixNote.textContent = state.galleryDrawing
    ? `↪ This will be saved as a remix of ${state.galleryDrawing.name} by ${state.galleryDrawing.artist}.`
    : "";
  paintDrawingPreview($("#saveDrawingPreview"), state.strokes);
  $("#saveDrawingModal").classList.remove("hidden");
  $("#drawingName").focus();
}

function closeSaveDrawingModal() {
  if ($("#confirmSaveDrawing").classList.contains("saving")) return;
  $("#saveDrawingModal").classList.add("hidden");
}

function updateSaveCaption() {
  $("#savePreviewName").textContent = $("#drawingName").value.trim() || "Your drawing";
  $("#savePreviewArtist").textContent = $("#drawerName").value.trim() || "Your name";
}

async function saveDrawing(event) {
  event.preventDefault();
  const name = $("#drawingName").value.trim();
  const artist = $("#drawerName").value.trim();
  if (!name || !artist) return;
  const button = $("#confirmSaveDrawing");
  button.disabled = true;
  button.classList.add("saving");
  $(".save-submit-label").textContent = "Saving…";
  const draft = {
    // A saved-gallery edit is a fork, never an overwrite. Every save receives
    // a fresh ID so neither localStorage nor the public API can replace the
    // drawing that was opened.
    id: createDrawingId(),
    name,
    artist,
    strokes: serializeStrokes(state.strokes),
    createdAt: new Date().toISOString(),
    prints: 0,
    localOnly: true,
  };
  if (state.galleryDrawing) {
    draft.remixOf = {
      id: state.galleryDrawing.id,
      name: state.galleryDrawing.name,
      artist: state.galleryDrawing.artist,
    };
    logLine("GALLERY", `saving new drawing ${draft.id} from edited copy of ${state.galleryDrawing.id}; source remains unchanged`);
  }
  const savedLocally = upsertLocalDrawing(draft);
  const animationStarted = performance.now();
  let published = null;
  let publishError = null;
  try {
    const result = await galleryRequest("/api/drawings", { method: "POST", body: JSON.stringify(draft) });
    published = { ...result.drawing, localOnly: false };
    upsertLocalDrawing(published);
    logLine("GALLERY", `published ${published.id} (${published.name} by ${published.artist})`);
  } catch (error) {
    publishError = error;
    logLine("GALLERY", `public save failed for ${draft.id}: ${error.message || error}`);
  }
  const remainingAnimation = 650 - (performance.now() - animationStarted);
  if (remainingAnimation > 0) await wait(remainingAnimation);
  button.disabled = false;
  button.classList.remove("saving");
  $(".save-submit-label").textContent = "Save publicly";
  $("#saveDrawingModal").classList.add("hidden");
  if (published) showToast(`${name} by ${artist} is now public.`);
  else if (savedLocally) showToast(`Saved in this browser, but publishing failed: ${publishError?.message || "server unavailable"}`, "error");
  else showToast("The drawing could not be saved.", "error");
}

async function recordGalleryPrint(sourceDrawing = state.galleryCopyDirty ? null : state.galleryDrawing) {
  if (!sourceDrawing) return;
  let drawing = { ...sourceDrawing, prints: (Number(sourceDrawing.prints) || 0) + 1 };
  upsertLocalDrawing(drawing);
  if (state.galleryDrawing?.id === drawing.id) {
    state.galleryDrawing = drawing;
    updateSavedDrawingBanner();
  }
  if (drawing.localOnly) return;
  try {
    const result = await galleryRequest(`/api/drawings/${encodeURIComponent(drawing.id)}/print`, { method: "POST" });
    drawing = { ...result.drawing, localOnly: false };
    upsertLocalDrawing(drawing);
    if (state.galleryDrawing?.id === drawing.id) {
      state.galleryDrawing = drawing;
      updateSavedDrawingBanner();
    }
    logLine("GALLERY", `recorded print for ${drawing.id}`);
  } catch (error) {
    logLine("GALLERY", `could not record print for ${drawing.id}: ${error.message || error}`);
  }
}

saveDrawingButton.addEventListener("click", openSaveDrawingModal);
$("#closeSaveDrawing").addEventListener("click", closeSaveDrawingModal);
$("#cancelSaveDrawing").addEventListener("click", closeSaveDrawingModal);
$("#saveDrawingForm").addEventListener("submit", saveDrawing);
$("#drawingName").addEventListener("input", updateSaveCaption);
$("#drawerName").addEventListener("input", updateSaveCaption);
$("#saveDrawingModal").addEventListener("click", (event) => {
  if (event.target === $("#saveDrawingModal")) closeSaveDrawingModal();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#saveDrawingModal").classList.contains("hidden")) closeSaveDrawingModal();
});
$("#gallerySort").addEventListener("change", loadGallery);
$("#deleteAllDrawings").addEventListener("click", deleteAllGalleryDrawings);

/* ---------- navigation ---------- */

$("#goDraw").addEventListener("click", () => {
  // Freehand mode starts fresh: squiggle strokes have no clear/undo controls.
  if (state.sourceImage || state.galleryDrawing || state.premadeSource) {
    setSquiggleSource(null);
    clearGalleryDrawing();
    state.premadeSource = null;
    state.strokes = [];
    state.undoStack = [];
    state.redoStack = [];
    state.activeStroke = null;
  }
  setDrawingTool("pencil");
  showView("draw");
  updateUi();
});
$("#goSelfie").addEventListener("click", () => showView("selfie"));
$("#goPremade").addEventListener("click", () => showView("premade"));
$("#backFromDraw").addEventListener("click", () => {
  if (state.galleryDrawing) {
    clearGalleryDrawing();
    state.strokes = [];
    showView("premade");
    updateUi();
  } else if (state.premadeSource) {
    setSquiggleSource(null);
    state.premadeSource = null;
    state.strokes = [];
    state.undoStack = [];
    state.redoStack = [];
    state.activeStroke = null;
    showView("premade");
    updateUi();
  } else {
    showView("splash");
  }
});
$("#backFromSelfie").addEventListener("click", () => showView("splash"));
$("#backFromPremade").addEventListener("click", () => showView("splash"));

/* ---------- buttons + panels ---------- */

undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);
clearButton.addEventListener("click", clearDrawing);
drawButton.addEventListener("click", sendToPlotter);
downloadButton.addEventListener("click", downloadGcode);
$("#testButton").addEventListener("click", testConnection);

// Keeps casual visitors out of the machine controls. The password lives in
// this client-side script, so it is a speed bump, not real security.
const ADMIN_PASSWORD = "meowl";

function lockAdmin() {
  state.adminUnlocked = false;
  state.galleryDeleteMode = false;
  $("#galleryDeleteMode").checked = false;
  $("#adminPassword").value = "";
  $("#adminLock").classList.remove("hidden");
  $("#adminContent").classList.add("hidden");
  renderGallery();
}

adminButton.addEventListener("click", () => {
  const open = adminPanel.classList.contains("hidden");
  adminPanel.classList.toggle("hidden", !open);
  adminPanel.setAttribute("aria-hidden", String(!open));
  adminButton.setAttribute("aria-expanded", String(open));
  // Every open starts locked. Once an admin explicitly enables gallery delete
  // mode, closing the panel leaves those buttons visible for gallery cleanup;
  // opening Admin again resets and re-locks the controls.
  if (open) {
    lockAdmin();
    $("#adminPassword").focus();
  }
});

function unlockAdmin() {
  if ($("#adminPassword").value !== ADMIN_PASSWORD) {
    $("#adminPassword").value = "";
    showToast("Wrong password.", "error");
    return;
  }
  state.adminUnlocked = true;
  $("#adminLock").classList.add("hidden");
  $("#adminContent").classList.remove("hidden");
}

$("#adminUnlock").addEventListener("click", unlockAdmin);
$("#adminPassword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") unlockAdmin();
});

$("#galleryDeleteMode").addEventListener("change", () => {
  state.galleryDeleteMode = state.adminUnlocked && $("#galleryDeleteMode").checked;
  renderGallery();
});

/* ---------- logs panel ---------- */

const logsPanel = $("#logsPanel");

function lockLogs() {
  $("#logsPassword").value = "";
  $("#logsLock").classList.remove("hidden");
  $("#logsOutput").classList.add("hidden");
}

function unlockLogs() {
  if ($("#logsPassword").value !== ADMIN_PASSWORD) {
    $("#logsPassword").value = "";
    showToast("Wrong password.", "error");
    return;
  }
  $("#logsLock").classList.add("hidden");
  const output = $("#logsOutput");
  output.classList.remove("hidden");
  output.textContent = logBuffer.join("\n") || "No log entries yet.";
  output.scrollTop = output.scrollHeight;
}

$("#logsButton").addEventListener("click", () => {
  const open = !logsPanel.classList.contains("open");
  logsPanel.classList.toggle("open", open);
  logsPanel.setAttribute("aria-hidden", String(!open));
  $("#logsButton").setAttribute("aria-expanded", String(open));
  lockLogs(); // every open starts locked; closing forgets the unlock
  if (open) $("#logsPassword").focus();
});
$("#closeLogs").addEventListener("click", () => $("#logsButton").click());
$("#logsUnlock").addEventListener("click", unlockLogs);
$("#logsPassword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") unlockLogs();
});

/* ---------- drawing area defaults ---------- */

const DRAWING_AREA_DEFAULTS = [["#workWidth", 118], ["#workHeight", 118], ["#drawFeed", 18000], ["#travelFeed", 30000]];

$("#drawingAreaReset").addEventListener("click", () => {
  for (const [selector, value] of DRAWING_AREA_DEFAULTS) $(selector).value = value;
  $("#drawFeedValue").textContent = `${feeds().draw} mm/min`;
  $("#travelFeedValue").textContent = `${feeds().travel} mm/min`;
  saveAppSettings();
  updateUi();
  logLine("APP", "drawing area settings reset to defaults");
});

const selfieDefaultInputs = [
  ["#defLines", "lines"], ["#maxLines", "maxLines"],
  ["#defAmp", "amp"], ["#maxAmp", "maxAmp"], ["#defFreq", "freq"],
  ["#defBright", "bright"], ["#defContrast", "contrast"], ["#defMod", "mod"],
  ["#defSize", "size"],
];

function populateSelfieDefaults() {
  const preset = getSelfiePreset();
  $("#defLines").max = String(preset.maxLines);
  $("#defAmp").max = String(preset.maxAmp);
  for (const [selector, key] of selfieDefaultInputs) $(selector).value = String(preset[key]);
}

for (const [selector] of selfieDefaultInputs) {
  $(selector).addEventListener("change", () => {
    const stored = {};
    for (const [inputSelector, key] of selfieDefaultInputs) stored[key] = $(inputSelector).value;
    localStorage.setItem(SELFIE_PRESET_KEY, JSON.stringify(stored));
    populateSelfieDefaults(); // reflect clamped values back into the fields
  });
}

$("#selfieDefaultsReset").addEventListener("click", () => {
  localStorage.removeItem(SELFIE_PRESET_KEY);
  populateSelfieDefaults();
  showToast("Selfie defaults restored to factory values.");
});

populateSelfieDefaults();

gcodeButton.addEventListener("click", () => {
  const open = !gcodePanel.classList.contains("open");
  gcodePanel.classList.toggle("open", open);
  gcodePanel.setAttribute("aria-hidden", String(!open));
  gcodeButton.setAttribute("aria-expanded", String(open));
  if (open) refreshGcodePreview();
});
$("#closeGcode").addEventListener("click", () => gcodeButton.click());

for (const input of [$("#workWidth"), $("#workHeight"), $("#drawFeed"), $("#travelFeed")]) {
  input.addEventListener("input", () => {
    $("#drawFeedValue").textContent = `${feeds().draw} mm/min`;
    $("#travelFeedValue").textContent = `${feeds().travel} mm/min`;
    updateUi();
  });
}

for (const id of PERSISTED_SETTING_IDS) {
  const input = document.getElementById(id);
  input.addEventListener(input.type === "checkbox" || input.tagName === "SELECT" ? "change" : "input", saveAppSettings);
}

/* ---------- marker palette and SVG import ---------- */

function updateMarkerSelection() {
  for (const button of $$(".marker-select")) button.setAttribute("aria-pressed", String(Number(button.dataset.marker) === activeMarker));
  $("#activeMarkerLabel").textContent = `Drawing with T${activeMarker}`;
}

function updateColorMapping() {
  const mapping = $("#colorMapping");
  const colors = [...new Set(state.strokes.map((stroke) => stroke.color || markerPalette[0]))];
  mapping.replaceChildren();
  for (const color of colors.slice(0, 32)) {
    const tool = PlotterColor.nearestTool(color, markerPalette);
    const item = document.createElement("span");
    item.className = "color-assignment";
    item.title = `${color} → T${tool} (${markerPalette[tool]})`;
    for (const swatch of [color, markerPalette[tool]]) {
      const chip = document.createElement("span");
      chip.className = "color-chip";
      chip.style.backgroundColor = swatch;
      item.append(chip);
      if (swatch === color && item.childNodes.length === 1) item.append(document.createTextNode(` → T${tool} `));
    }
    mapping.append(item);
  }
  if (colors.length > 32) mapping.append(document.createTextNode(`+${colors.length - 32} more source colors`));
}

for (let tool = 0; tool < 8; tool++) {
  const slot = document.createElement("label");
  slot.className = "marker-slot";
  const label = document.createElement("span");
  label.textContent = `T${tool}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "marker-select";
  button.dataset.marker = tool;
  button.textContent = `T${tool}`;
  const chip = document.createElement("span");
  chip.className = "color-chip";
  chip.style.backgroundColor = markerPalette[tool];
  button.prepend(chip);
  button.setAttribute("aria-label", `Draw with marker T${tool}`);
  button.addEventListener("click", () => {
    activeMarker = tool;
    updateMarkerSelection();
    if (state.sourceImage) regenerateSquiggle();
  });
  const input = document.createElement("input");
  input.type = "color";
  input.value = markerPalette[tool];
  input.setAttribute("aria-label", `Color loaded in T${tool}`);
  input.addEventListener("input", () => {
    markerPalette[tool] = input.value;
    chip.style.backgroundColor = input.value;
    try { localStorage.setItem(MARKER_PALETTE_KEY, JSON.stringify(markerPalette)); } catch { /* private mode */ }
    if (state.sourceImage) regenerateSquiggle();
    else { render(); updateUi(); }
  });
  slot.append(label, input);
  $("#markerConfiguration").append(slot);
  $("#markerPalette").append(button);
}
updateMarkerSelection();

for (const selector of ["#goSvg", "#importSvgButton"]) {
  $(selector).addEventListener("click", () => $("#svgFile").click());
}
$("#svgFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const status = $("#svgImportStatus");
  $("#importSvgButton").disabled = true;
  $("#goSvg").disabled = true;
  status.textContent = "Converting SVG…";
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("Choose an SVG smaller than 2 MB.");
    const strokes = await PlotterColor.importSvg(await file.text(), svgFillStrokes);
    // Replace the current artwork only after the complete import succeeds.
    snapshot();
    setSquiggleSource(null);
    clearGalleryDrawing();
    state.premadeSource = file.name;
    state.strokes = strokes;
    state.activeStroke = null;
    setDrawingTool("pencil");
    showView("draw");
    render(); updateUi();
    const tools = new Set(strokes.map(toolForStroke));
    status.textContent = `${file.name} · ${strokes.length} paths · ${tools.size} markers. Preview shows the matched marker colors.`;
    showToast(`Imported ${file.name}`);
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message || "Could not import this SVG.", "error");
  } finally {
    event.target.value = "";
    $("#importSvgButton").disabled = false;
    $("#goSvg").disabled = false;
  }
});

window.addEventListener("resize", resizeCanvas);
showView("splash");
resizeCanvas();
updateUi();
logLine("APP", `Small Plotter started (${navigator.userAgent}; page=${window.location.protocol})`);
