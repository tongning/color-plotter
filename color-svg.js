
/* Color matching and SVG geometry conversion. No network or third-party runtime. */
(() => {
  const DEFAULT_PALETTE = ["#2c2d30", "#e42e2a", "#c65a93", "#08b1dc", "#7bae44", "#0497bd", "#2d4e9e", "#533c94"];
  const SIZE = 480;
  const isColor = (value) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value);

  // OKLab distance compares colors perceptually, including saturated blues.
  function oklab(hex) {
    const rgb = [1, 3, 5].map((offset) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const [r, g, b] = rgb;
    const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
    const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
    const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
    return [
      .2104542553 * l + .793617785 * m - .0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
      .0259040371 * l + .7827717662 * m - .808675766 * s,
    ];
  }

  function nearestTool(color, palette) {
    const source = oklab(color);
    let best = 0;
    let bestDistance = Infinity;
    palette.forEach((candidate, tool) => {
      const target = oklab(candidate);
      const distance = source.reduce((sum, value, i) => sum + (value - target[i]) ** 2, 0);
      if (distance < bestDistance) { best = tool; bestDistance = distance; }
    });
    return best;
  }

  // Keep compound-path moves separate, including relative moves following a close.
  // Otherwise getPointAtLength would draw a connector between independent paths.
  function splitPath(data) {
    const tokens = data.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || [];
    const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
    let i = 0, command = "", x = 0, y = 0, sx = 0, sy = 0, part = "";
    const parts = [];
    while (i < tokens.length) {
      if (/^[a-z]$/i.test(tokens[i])) command = tokens[i++];
      const upper = command.toUpperCase();
      const relative = command !== upper;
      if (upper === "Z") {
        part += " Z"; x = sx; y = sy; command = "";
        continue;
      }
      const count = counts[upper];
      if (!count || i + count > tokens.length) throw new Error("The SVG contains invalid path data.");
      const values = tokens.slice(i, i + count).map(Number);
      if (values.some((v) => !Number.isFinite(v))) throw new Error("The SVG contains invalid path coordinates.");
      i += count;
      if (upper === "H") x = values[0] + (relative ? x : 0);
      else if (upper === "V") y = values[0] + (relative ? y : 0);
      else {
        x = values[count - 2] + (relative ? x : 0);
        y = values[count - 1] + (relative ? y : 0);
      }
      if (upper === "M") {
        if (part) parts.push(part);
        part = `M ${x} ${y}`; sx = x; sy = y;
        command = relative ? "l" : "L";
      } else {
        if (!part) throw new Error("SVG paths must start with a move.");
        part += ` ${command} ${values.join(" ")}`;
      }
    }
    if (part) parts.push(part);
    return parts;
  }

  function clipPolyline(points) {
    const pieces = [];
    let piece = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      let lo = 0, hi = 1, outside = false;
      for (const [p, q] of [[-dx, a.x], [dx, 1 - a.x], [-dy, a.y], [dy, 1 - a.y]]) {
        if (p === 0) { if (q < 0) outside = true; continue; }
        const t = q / p;
        if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
      }
      if (outside || lo > hi) { if (piece.length > 1) pieces.push(piece); piece = []; continue; }
      const start = { x: a.x + lo * dx, y: a.y + lo * dy };
      const end = { x: a.x + hi * dx, y: a.y + hi * dy };
      const last = piece.at(-1);
      if (last && Math.hypot(last.x - start.x, last.y - start.y) > 1e-7) {
        if (piece.length > 1) pieces.push(piece);
        piece = [];
      }
      if (!piece.length) piece.push(start);
      piece.push(end);
      if (hi < 1) { pieces.push(piece); piece = []; }
    }
    if (piece.length > 1) pieces.push(piece);
    return pieces;
  }

  // Hidden-line removal: clip a polyline against an occluder mask
  // (Uint8Array SIZE*SIZE, 1 = hidden behind an opaque fill drawn later).
  // Points are normalized 0..1. Subdivides long segments to ~1px so a
  // hidden middle isn't missed, classifies each sub-segment by its
  // midpoint, and returns the visible runs (each >= 2 points).
  function clipAgainstMask(points, mask) {
    if (points.length < 2) return [];
    const pieces = [];
    let piece = [];
    const step = 1 / SIZE;
    function inside(x, y) {
      const px = Math.min(SIZE - 1, Math.max(0, Math.floor(x * SIZE)));
      const py = Math.min(SIZE - 1, Math.max(0, Math.floor(y * SIZE)));
      return mask[py * SIZE + px] === 1;
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
      for (let j = 0; j < n; j++) {
        const t0 = j / n, t1 = (j + 1) / n;
        const x0 = a.x + dx * t0, y0 = a.y + dy * t0;
        const x1 = a.x + dx * t1, y1 = a.y + dy * t1;
        if (inside((x0 + x1) / 2, (y0 + y1) / 2)) {
          if (piece.length > 1) pieces.push(piece);
          piece = [];
        } else {
          if (!piece.length) piece.push({ x: x0, y: y0 });
          piece.push({ x: x1, y: y1 });
        }
      }
    }
    if (piece.length > 1) pieces.push(piece);
    return pieces;
  }

  async function importSvg(text, fillStrokes) {
    const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
    const source = parsed.documentElement;
    if (source.localName !== "svg" || parsed.querySelector("parsererror")) throw new Error("This file is not a valid SVG.");

    // Isolate SVG CSS from the app. Imported scripts/events/links are never copied;
    // CSP also blocks external styles, images, fonts and other resource requests.
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:480px;border:0;visibility:hidden";
    const ready = new Promise((resolve) => { frame.onload = resolve; });
    frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>html,body{margin:0;width:480px;height:480px}svg{display:block}</style><body></body>';
    document.body.append(frame);
    try {
      await ready;
      const doc = frame.contentDocument;
      const allowed = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "style", "defs", "title", "desc"]);
      const attributes = new Set(["id", "class", "style", "d", "points", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "rx", "ry", "r", "cx", "cy", "viewBox", "preserveAspectRatio", "transform", "fill", "stroke", "stroke-width", "fill-rule", "color", "display", "visibility", "opacity", "fill-opacity", "stroke-opacity", "clip-path", "mask", "filter", "stroke-dasharray", "marker-start", "marker-mid", "marker-end"]);
      function copy(node, inDefs = false) {
        if (!allowed.has(node.localName)) {
          if (["script", "metadata"].includes(node.localName) || inDefs) return null;
          throw new Error(`SVG <${node.localName}> is unsupported. Convert text and symbols to paths; use solid colors without effects.`);
        }
        const result = doc.createElementNS("http://www.w3.org/2000/svg", node.localName);
        for (const attr of node.attributes) if (attributes.has(attr.name)) result.setAttribute(attr.name, attr.value);
        if (node.localName === "style") result.textContent = node.textContent;
        else for (const child of node.children) {
          const clean = copy(child, inDefs || node.localName === "defs");
          if (clean) result.append(clean);
        }
        return result;
      }
      const svg = copy(source);
      // An SVG without a viewBox uses its declared viewport as its coordinate space.
      if (!svg.hasAttribute("viewBox")) {
        const width = svg.width.baseVal.value, height = svg.height.baseVal.value;
        if (!(width > 0 && height > 0)) throw new Error("The SVG needs a viewBox or a width and height.");
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      }
      const box = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
      if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error("The SVG has an invalid viewBox.");
      svg.setAttribute("width", SIZE); svg.setAttribute("height", SIZE);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.style.setProperty("width", `${SIZE}px`, "important");
      svg.style.setProperty("height", `${SIZE}px`, "important");
      doc.body.append(svg);
      const raster = document.createElement("canvas"); raster.width = raster.height = SIZE;
      const context = raster.getContext("2d", { willReadFrequently: true });
      function colorOf(value, opacity) {
        if (value === "none" || opacity <= 0) return null;
        if (/url\(/i.test(value)) throw new Error("Gradients and patterns are unsupported. Use solid SVG colors.");
        context.clearRect(0, 0, SIZE, SIZE);
        context.fillStyle = "#fff"; context.fillRect(0, 0, 1, 1);
        context.globalAlpha = Math.min(1, opacity);
        context.fillStyle = value; context.fillRect(0, 0, 1, 1); context.globalAlpha = 1;
        const rgb = context.getImageData(0, 0, 1, 1).data;
        return `#${[...rgb].slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      }
      // Phase 1: collect every element's outlines, fill and stroke in
      // document order. Nothing is plotted yet.
      const items = [];
      for (const element of svg.querySelectorAll("path,rect,circle,ellipse,line,polyline,polygon")) {
        if (element.closest("defs")) continue;
        const style = frame.contentWindow.getComputedStyle(element);
        let opacity = 1, hidden = false;
        for (let ancestor = element; ancestor && ancestor !== doc.body; ancestor = ancestor.parentElement) {
          const computed = frame.contentWindow.getComputedStyle(ancestor);
          opacity *= Number(computed.opacity);
          if (computed.display === "none") hidden = true;
          if ([computed.clipPath, computed.maskImage, computed.filter].some((v) => v && v !== "none")) throw new Error("Clipping, masks and filters are unsupported. Flatten them to paths first.");
        }
        if (hidden || opacity === 0 || style.visibility !== "visible") continue;
        if (style.strokeDasharray !== "none" || [style.markerStart, style.markerMid, style.markerEnd].some((v) => v && v !== "none")) throw new Error("Convert dashed strokes and arrow markers to paths before importing.");
        const fillOpacity = opacity * Number(style.fillOpacity);
        const fill = element.localName === "line" ? null : colorOf(style.fill, fillOpacity);
        const stroke = parseFloat(style.strokeWidth) > 0 ? colorOf(style.stroke, opacity * Number(style.strokeOpacity)) : null;
        if (!fill && !stroke) continue;
        const matrix = element.getCTM();
        if (!matrix) continue;
        const scale = Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
        const original = element.getAttribute("d");
        const parts = element.localName === "path" ? splitPath(original || "") : [null];
        const outlines = [];
        try {
          for (const part of parts) {
            if (part !== null) element.setAttribute("d", part);
            const length = element.getTotalLength();
            if (!Number.isFinite(length) || length <= 0) continue;
            const steps = Math.max(1, Math.ceil(length * scale));
            const points = [];
            for (let i = 0; i <= steps; i++) {
              const p = element.getPointAtLength(length * i / steps).matrixTransform(matrix);
              if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error("SVG has invalid transformed coordinates.");
              points.push({ x: p.x / SIZE, y: p.y / SIZE });
            }
            outlines.push(points);
          }
        } finally { if (original !== null) element.setAttribute("d", original); }
        items.push({ outlines, fill, stroke, fillRule: style.fillRule, fillOpacity });
      }
      // Phase 2: hidden-line removal. Walk the elements in reverse
      // (painter's algorithm): keep a running union of the opaque fill
      // masks from later-painted elements, and clip each earlier stroke
      // (and each earlier fill's hatch) against it, so lines behind a
      // solid fill are never plotted. A fill's own outline is clipped
      // only by later fills, never by its own fill, because the mask is
      // added to the occluder after the element's own strokes are done.
      // White is paper, not ink: an opaque white fill occludes but is
      // never hatched (it used to hatch sky blue via nearestTool).
      // Only opaque fills (fill-opacity >= 0.9) occlude; semi-transparent
      // fills don't hide what's behind them.
      const occluder = new Uint8Array(SIZE * SIZE);
      let hasOccluder = false;
      const ordered = new Array(items.length);
      for (let idx = items.length - 1; idx >= 0; idx--) {
        const item = items[idx];
        const out = [];
        function addToOut(points, color) {
          if (points.length < 2) return;
          points.color = color; points.shape = true;
          out.push(points);
        }
        let mask = null, area = 0;
        if (item.fill) {
          context.clearRect(0, 0, SIZE, SIZE); context.beginPath();
          for (const points of item.outlines) {
            context.moveTo(points[0].x * SIZE, points[0].y * SIZE);
            for (let i = 1; i < points.length; i++) {
              const b = points[i];
              context.lineTo(b.x * SIZE, b.y * SIZE);
            }
            context.closePath();
          }
          context.fillStyle = "#000"; context.fill(item.fillRule === "evenodd" ? "evenodd" : "nonzero");
          const data = context.getImageData(0, 0, SIZE, SIZE).data;
          mask = new Uint8Array(SIZE * SIZE);
          for (let i = 0; i < mask.length; i++) {
            const inside = data[i * 4 + 3] > 127;
            mask[i] = inside ? 1 : 0;
            if (inside) area++;
          }
          // Plot solid areas as connected fills and narrow traced ink as
          // centerlines. The outlines are the vector fill boundaries, so
          // pass them through for a vector hatch of the solid parts.
          // White is paper: never hatched.
          if (area > 0 && item.fill !== "#ffffff") {
            for (const path of fillStrokes(mask, item.outlines)) {
              if (hasOccluder) for (const vis of clipAgainstMask(path, occluder)) addToOut(vis, item.fill);
              else addToOut(path, item.fill);
            }
          }
        }
        if (item.stroke) {
          for (const points of item.outlines) {
            for (const piece of clipPolyline(points)) {
              if (hasOccluder) for (const vis of clipAgainstMask(piece, occluder)) addToOut(vis, item.stroke);
              else addToOut(piece, item.stroke);
            }
          }
        }
        if (mask && area > 0 && item.fillOpacity >= 0.9) {
          for (let i = 0; i < mask.length; i++) occluder[i] |= mask[i];
          hasOccluder = true;
        }
        ordered[idx] = out;
      }
      const strokes = [];
      for (const out of ordered) strokes.push(...out);
      if (!strokes.length) throw new Error("This SVG has no visible, supported paths to plot.");
      return strokes;
    } finally { frame.remove(); }
  }

  // Imported SVGs arrive normalized to a square (0..1 in both axes), but the
  // bed is not necessarily square. Mapping x -> bed width and y -> bed height
  // then stretches the artwork whenever the bed is rectangular: a square
  // design on the 118x140 bed plotted 118 wide x 140 tall. Fit the
  // artwork's bounding box into the bed preserving its aspect ratio,
  // centred, so a square design stays square and a wide or tall one fills
  // the bed's limiting dimension. On a square bed this is a no-op for
  // artwork that already fills its viewBox.
  function fitToBed(strokes, bedWidth, bedHeight) {
    if (!(bedWidth > 0 && bedHeight > 0)) return strokes;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of strokes) {
      for (const point of stroke) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return strokes;
    const dw = maxX - minX, dh = maxY - minY;
    if (dw <= 0 || dh <= 0) return strokes;
    // The artwork's true aspect is dw/dh (the normalized space is uniform).
    const aspect = dw / dh;
    let plottedW, plottedH;
    if (aspect >= bedWidth / bedHeight) { plottedW = bedWidth; plottedH = bedWidth / aspect; }
    else { plottedH = bedHeight; plottedW = bedHeight * aspect; }
    const sx = plottedW / (dw * bedWidth);
    const sy = plottedH / (dh * bedHeight);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (const stroke of strokes) {
      for (const point of stroke) {
        point.x = (point.x - cx) * sx + 0.5;
        point.y = (point.y - cy) * sy + 0.5;
      }
    }
    return strokes;
  }

  const api = { DEFAULT_PALETTE, isColor, nearestTool, splitPath, clipPolyline, clipAgainstMask, importSvg, fitToBed };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.PlotterColor = api;
})();
