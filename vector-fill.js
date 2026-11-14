/* Vector fill: hatch a region from the vector stroke geometry instead of
   the pixel grid, so hatch endpoints and edge connectors follow the smooth
   stroke curves rather than a pixel staircase.
   Hybrid: the raster flood fill still finds the region (it is the robust
   part); the boundary loop, the hatch runs and the connectors are all
   computed from vector polygons. Falls back to the raster hatch when a
   vector loop cannot be built. */
(() => {
  // boundaryRings lives in fill-path.js (loaded first in the browser).
  const FillPath = (typeof module !== "undefined" && module.exports)
    ? require("./fill-path.js")
    : (typeof window !== "undefined" ? window.PlotterFill : null);

  // Flatten one app stroke to a dense polyline in raster pixels.
  // Freehand strokes are rendered with quadratic curves through segment
  // midpoints, so flatten those curves to match the drawn centreline;
  // shape strokes are already straight segments.
  function flattenStroke(stroke, size) {
    if (!stroke.length) return [];
    const toPx = (p) => ({ x: p.x * size, y: p.y * size });
    if (stroke.length === 1) {
      const c = toPx(stroke[0]);
      const pts = [];
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        pts.push({ x: c.x + 2 * Math.cos(a), y: c.y + 2 * Math.sin(a) });
      }
      return pts;
    }
    // Dense polylines (~1px spacing) so the ring snap below can find a
    // stroke point near every boundary pixel. Shape strokes are straight
    // segments; densify them the same way.
    if (stroke.shape) {
      const pts = [toPx(stroke[0])];
      for (let i = 0; i < stroke.length - 1; i++) {
        const a = toPx(stroke[i]), b = toPx(stroke[i + 1]);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const n = Math.max(1, Math.ceil(len));
        for (let k = 1; k <= n; k++) {
          pts.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
        }
      }
      return pts;
    }
    const pts = [toPx(stroke[0])];
    const mid = (a, b) => ({ x: (a.x + b.x) / 2 * size, y: (a.y + b.y) / 2 * size });
    // Quadratic segments: from the current point, control p[i], to the
    // midpoint of p[i] and p[i+1]; then a straight line to the last point.
    let cur = toPx(stroke[0]);
    for (let i = 1; i < stroke.length - 1; i++) {
      const ctrl = toPx(stroke[i]);
      const end = mid(stroke[i], stroke[i + 1]);
      const len = Math.hypot(end.x - cur.x, end.y - cur.y);
      const n = Math.max(2, Math.ceil(len));
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        pts.push({
          x: u * u * cur.x + 2 * u * t * ctrl.x + t * t * end.x,
          y: u * u * cur.y + 2 * u * t * ctrl.y + t * t * end.y,
        });
      }
      cur = end;
    }
    pts.push(toPx(stroke[stroke.length - 1]));
    return pts;
  }

  // Dilate a mask by r pixels (square neighbourhood).
  function dilate(mask, size, r) {
    const out = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!mask[y * size + x]) continue;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < size && ny >= 0 && ny < size) out[ny * size + nx] = 1;
      }
    }
    return out;
  }

  // Indices of the strokes that form the region wall. A wall stroke runs
  // along the boundary, so most of its centreline sits within a few px
  // of both the region and the outside. An interior stroke (an earlier
  // hatch line) only touches the boundary at its endpoints, so only a
  // small fraction of its length is near the outside. A single wall
  // pixel cannot touch both sides: the stroke is several px wide.
  function boundaryStrokeIndices(flatStrokes, covered, inside, size, halfWidth = 2) {
    const r = Math.ceil(halfWidth) + 1;
    const nearInside = dilate(inside, size, r);
    const outside = new Uint8Array(size * size);
    for (let i = 0; i < size * size; i++) outside[i] = (!inside[i] && !covered[i]) ? 1 : 0;
    const nearOutside = dilate(outside, size, r);
    const out = [];
    flatStrokes.forEach((pts, index) => {
      if (!pts.length) return;
      let near = 0;
      for (const p of pts) {
        const x = Math.floor(p.x), y = Math.floor(p.y);
        if (x >= 0 && x < size && y >= 0 && y < size
          && nearInside[y * size + x] && nearOutside[y * size + x]) near++;
      }
      if (near / pts.length > 0.3) out.push(index);
    });
    return out;
  }

  // Signed area of a closed polygon (positive = counterclockwise).
  function signedArea(points) {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[(i + 1) % points.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  // Offset a closed polygon by d along the inward normal. The polygon
  // must be counterclockwise on screen (interior on the left), which in
  // raster coordinates (y down) means a NEGATIVE shoelace area; pass
  // sign -1 to offset the other way (for a hole, where the fill lies
  // outside the loop). Bevel join: each vertex moves d along the
  // averaged normal, never more. A miter join (d / cos) spikes at a
  // sharp corner in the snapped loop and pushes the boundary 4px in
  // instead of 2px; the bevel keeps every offset point exactly d from
  // its vertex, which is what the fill boundary needs.
  function offsetPolygon(points, d, sign = 1) {
    const n = points.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = points[(i - 1 + n) % n], cur = points[i], next = points[(i + 1) % n];
      const e1x = cur.x - prev.x, e1y = cur.y - prev.y;
      const e2x = next.x - cur.x, e2y = next.y - cur.y;
      const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
      // Left normals (interior side for a CCW-on-screen loop). Screen
      // coords have y down, so the left normal of (dx, dy) is (dy, -dx).
      const n1x = e1y / l1, n1y = -e1x / l1;
      const n2x = e2y / l2, n2y = -e2x / l2;
      let mx = n1x + n2x, my = n1y + n2y;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) { mx = n1x; my = n1y; }
      else { mx /= ml; my /= ml; }
      out.push({ x: cur.x + sign * mx * Math.abs(d), y: cur.y + sign * my * Math.abs(d) });
    }
    return out;
  }

  // Build the vector loop for one pixel ring: snap each ring point to the
  // nearest point on a boundary stroke centreline (grid hash for speed),
  // in ring order. Falls back to the ring point itself when no stroke
  // point is near, so the loop stays closed and complete.
  function vectorLoop(ring, flatBoundary, size, snapRadius = 5) {
    const cell = snapRadius;
    const grid = new Map();
    const key = (x, y) => Math.floor(x / cell) + "," + Math.floor(y / cell);
    for (const pts of flatBoundary) for (const p of pts) {
      const k = key(p.x, p.y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
    const loop = [];
    for (const index of ring) {
      const rx = index % size + .5, ry = Math.floor(index / size) + .5;
      let best = null, bestD = snapRadius * snapRadius;
      const cx = Math.floor(rx / cell), cy = Math.floor(ry / cell);
      for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const bucket = grid.get(gx + "," + gy);
        if (!bucket) continue;
        for (const p of bucket) {
          const d = (p.x - rx) * (p.x - rx) + (p.y - ry) * (p.y - ry);
          if (d < bestD) { bestD = d; best = p; }
        }
      }
      const pt = best ? { x: best.x, y: best.y } : { x: rx, y: ry };
      const last = loop[loop.length - 1];
      if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) > 0.5) loop.push(pt);
    }
    return loop;
  }

  // Intersect diagonal scanlines (x - y = c) with the polygons and pair
  // the hits even-odd into hatch runs. Run endpoints are sub-pixel
  // points on the polygon boundary, not pixel centres.
  function polygonRuns(polygons, size, spacing, edgeGap) {
    const step = Math.max(1, Math.round(spacing * Math.SQRT2));
    const runs = [];
    for (let c = -(size - 1); c < size; c += step) {
      const hits = [];
      polygons.forEach((poly, pi) => {
        for (let e = 0; e < poly.length; e++) {
          const a = poly[e], b = poly[(e + 1) % poly.length];
          const da = (a.x - a.y) - c, db = (b.x - b.y) - c;
          // Count a vertex once: the edge crosses with its lower endpoint
          // strictly below the line and its upper on or above it.
          if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
            const t = da / (da - db);
            const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
            hits.push({ x, y, poly: pi, edge: e, t, s: x + y });
          }
        }
      });
      hits.sort((p, q) => p.s - q.s);
      for (let i = 0; i + 1 < hits.length; i += 2) {
        runs.push({ start: hits[i], end: hits[i + 1], done: false });
      }
    }
    return runs;
  }

  // Prefix sums of edge lengths per polygon, for O(1) arc lengths.
  function polygonPrefix(polygons) {
    return polygons.map((poly) => {
      const prefix = new Float64Array(poly.length + 1);
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        prefix[i + 1] = prefix[i] + Math.hypot(b.x - a.x, b.y - a.y);
      }
      return prefix;
    });
  }

  // The connector arc along one polygon between two run endpoints
  // (each a {poly, edge, t} position on the boundary). Returns the list
  // of points along the arc, endpoints included, or null when the
  // endpoints are on different polygons or the arc exceeds connectMax.
  // The polygon is smooth, so the arc length is the true wall distance:
  // no staircase inflation allowance, unlike the raster ring.
  function polygonArc(polygons, prefix, a, b, connectMax) {
    if (a.poly !== b.poly) return null;
    const poly = polygons[a.poly];
    const n = poly.length;
    const pre = prefix[a.poly];
    const total = pre[n];
    const edgeLen = (e) => pre[e + 1] - pre[e];
    const posA = pre[a.edge] + a.t * edgeLen(a.edge);
    const posB = pre[b.edge] + b.t * edgeLen(b.edge);
    const forward = (posB - posA + total) % total;
    const dir = forward <= total - forward ? 1 : -1;
    const len = dir === 1 ? forward : total - forward;
    if (len > connectMax) return null;
    // Walk the vertices in the shorter direction.
    const pts = [{ x: a.x, y: a.y }];
    // First vertex after a (in the chosen direction).
    let vi = dir === 1 ? (a.edge + 1) % n : a.edge;
    const targetVi = dir === 1 ? (b.edge + 1) % n : b.edge;
    // Collect vertices strictly between the two endpoints along the arc.
    let guard = 0;
    while (vi !== targetVi && guard++ < n + 2) {
      pts.push({ x: poly[vi].x, y: poly[vi].y });
      vi = (vi + dir + n) % n;
    }
    pts.push({ x: b.x, y: b.y });
    return { path: pts, length: len };
  }

  // Hatch the offset polygons and stitch the runs into strokes, mirroring
  // the raster hatch: greedy nearest-endpoint stitching, dot priority for
  // short runs, wall-only connectors capped at connectMax, lift otherwise.
  // `current` is a boundary position {x, y, poly, edge, t} (the pen sits
  // at the end of the last run); the drawn stroke uses the extended run
  // endpoints, and the connector arc's intermediate vertices are the
  // polygon points between the two boundary positions.
  function hatchPolygons(polygons, size, spacing, edgeGap, connectMax) {
    const runs = polygonRuns(polygons, size, spacing, edgeGap);
    // A tiny island may fall entirely between scanlines. Keep it as a dot.
    if (!runs.length) {
      polygons.forEach((poly, pi) => {
        if (poly.length) runs.push({
          start: { x: poly[0].x, y: poly[0].y, poly: pi, edge: 0, t: 0 },
          end: { x: poly[0].x, y: poly[0].y, poly: pi, edge: 0, t: 0 },
          done: false,
        });
      });
      if (!runs.length) return [];
    }
    // Extend run endpoints past the edge (skin overlap). The endpoints
    // already sit on the boundary, so the extension is just -edgeGap
    // along the hatch direction, not the pixel-centre-to-edge distance.
    const d = -edgeGap / Math.SQRT2;
    for (const run of runs) {
      run.drawStart = { x: run.start.x - d, y: run.start.y - d };
      run.drawEnd = { x: run.end.x + d, y: run.end.y + d };
    }
    const prefix = polygonPrefix(polygons);
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const runLen = (run) => dist(run.drawStart, run.drawEnd);
    const strokes = [];
    let remaining = runs.length;
    let current = runs[0].start;
    while (remaining > 0) {
      // A new stroke starts at the unfinished endpoint nearest the pen;
      // the pen is up, so no link is drawn to get there.
      let startRun = null, startReverse = false, startDist = Infinity;
      for (const run of runs) if (!run.done) for (const reverse of [false, true]) {
        const start = reverse ? run.end : run.start;
        const dd = dist(current, start);
        if (dd < startDist) { startDist = dd; startRun = run; startReverse = reverse; }
      }
      current = startReverse ? startRun.end : startRun.start;
      const points = [];
      const append = (p) => {
        const last = points[points.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-9) return;
        if (points.length > 1) {
          const a = points[points.length - 2], b = points[points.length - 1];
          const ax = b.x - a.x, ay = b.y - a.y, bx = p.x - b.x, by = p.y - b.y;
          // Drop near-collinear points so the stroke stays compact.
          const cross = Math.abs(ax * by - ay * bx);
          const dot = ax * bx + ay * by;
          if (cross < 0.05 * Math.hypot(ax, ay) && dot > 0) points.pop();
        }
        points.push({ x: p.x, y: p.y });
      };
      for (;;) {
        // Consider the closest unfinished endpoints, rather than forcing
        // all segments on a split scanline in sequence.
        const candidates = [];
        for (const run of runs) if (!run.done) for (const reverse of [false, true]) {
          const start = reverse ? run.end : run.start;
          const length = dist(current, start);
          const candidate = { run, reverse, start, length };
          let i = candidates.findIndex((other) => other.length > length);
          if (i < 0) i = candidates.length;
          if (i < 8) { candidates.splice(i, 0, candidate); if (candidates.length > 8) candidates.pop(); }
        }
        // Short edge fragments strand if the pen leaves their
        // neighbourhood, so always consider nearby dots even when
        // nearer run endpoints crowd them out of the top 8.
        for (const run of runs) {
          if (!run.done && runLen(run) <= 1
            && dist(current, run.start) <= connectMax
            && !candidates.some((c) => c.run === run)) {
            const candidate = { run, reverse: false, start: run.start, length: dist(current, run.start) };
            let i = candidates.findIndex((other) => other.length > candidate.length);
            if (i < 0) i = candidates.length;
            candidates.splice(i, 0, candidate);
          }
        }
        let best = null, bestDot = null;
        for (const candidate of candidates) {
          if (best && candidate.length >= best.link.length) break;
          // Top-infill rule (Cura Lines / Zig Zag): a connector runs
          // along the wall or not at all. No hop through the fill
          // itself, however short. Longer than connectMax, the pen lifts.
          const arc = polygonArc(polygons, prefix, current, candidate.start, connectMax);
          if (!arc) continue;
          const entry = { ...candidate, link: arc };
          if (!best || arc.length < best.link.length) best = entry;
          // A short fragment on the edge is stranded if the pen leaves
          // its neighbourhood, so draw it while it is here.
          if (runLen(candidate.run) <= 1
            && (!bestDot || arc.length < bestDot.link.length)) bestDot = entry;
        }
        best = bestDot || best;
        // No short link to any unfinished run: lift the pen and start
        // a new stroke instead of a long perimeter lap.
        if (!best) break;
        // Draw the connector: the arc's intermediate polygon vertices
        // (its endpoints are the boundary positions; the drawn stroke
        // already ends at the extended current point, and the run's near
        // end is appended next, extended). Then draw the run itself.
        const arcPts = best.link.path;
        for (let i = 1; i < arcPts.length - 1; i++) append(arcPts[i]);
        const run = best.run;
        const drawStart = best.reverse ? run.drawEnd : run.drawStart;
        const drawEnd = best.reverse ? run.drawStart : run.drawEnd;
        append(drawStart);
        append(drawEnd);
        current = best.reverse ? run.start : run.end;
        run.done = true; remaining--;
      }
      if (points.length === 1) points.push({ ...points[0] });
      if (points.length) {
        const stroke = points.map((p) => ({ x: p.x / size, y: p.y / size }));
        stroke.shape = true;
        strokes.push(stroke);
      }
    }
    return strokes;
  }

  // Main entry: hatch the region bounded by the vector strokes.
  // strokes: app strokes (arrays of {x,y} normalized, .shape flag).
  // covered: stroke pixels (lineWidth 4 raster). inside: flood-filled
  // region mask. size: raster size (480). Returns hatch strokes
  // (normalized, shape=true) or null when no vector loop can be built.
  function vectorHatch(strokes, covered, inside, size, spacing, edgeGap, connectMax) {
    const halfWidth = 2; // fillCoverageMask rasterizes strokes at lineWidth 4
    const flat = strokes.map((s) => flattenStroke(s, size));
    const bIdx = boundaryStrokeIndices(flat, covered, inside, size, halfWidth);
    if (!bIdx.length) return null;
    const flatBoundary = bIdx.map((i) => flat[i]);
    // Labels: the flood-filled region is one component.
    const labels = new Int32Array(size * size);
    for (let i = 0; i < size * size; i++) if (inside[i]) labels[i] = 1;
    const rings = FillPath.boundaryRings(inside, size, labels);
    const labelRings = rings.get(1) || [];
    if (!labelRings.length) return null;
    const polygons = [];
    // The offset polygon sits on the region boundary (the stroke's inner
    // edge), so validate it against the region dilated by 2px: a point on
    // the boundary lands in an inside or a wall pixel, while an offset in
    // the wrong direction lands 4px out, past the stroke's outer edge.
    const insideDilated = dilate(inside, size, 2);
    const insideCount = (poly) => {
      let n = 0;
      for (const p of poly) {
        const x = Math.floor(p.x), y = Math.floor(p.y);
        if (x >= 0 && x < size && y >= 0 && y < size && insideDilated[y * size + x]) n++;
      }
      return n;
    };
    for (const ring of labelRings) {
      const loop = vectorLoop(ring, flatBoundary, size, 5);
      if (loop.length < 3) continue;
      // Offset toward the filled region. Screen coords (y down): a
      // counterclockwise-on-screen loop (interior on the left) has a
      // negative shoelace area, so reverse positive-area loops first.
      // Try the inward normal; if the offset points land outside the
      // region, flip it (a hole loop, whose fill lies outside it).
      let ccw = signedArea(loop) > 0 ? [...loop].reverse() : loop;
      let off = offsetPolygon(ccw, halfWidth, 1);
      if (insideCount(off) < off.length * 0.5) off = offsetPolygon(ccw, halfWidth, -1);
      if (insideCount(off) < off.length * 0.5) continue;
      polygons.push(off);
    }
    if (!polygons.length) return null;
    const hatch = hatchPolygons(polygons, size, spacing, edgeGap, connectMax);
    return hatch.length ? hatch : null;
  }

  const api = { vectorHatch, _test: { flattenStroke, dilate, boundaryStrokeIndices, signedArea, offsetPolygon, vectorLoop, polygonRuns, polygonArc, hatchPolygons } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.PlotterVectorFill = api;
})();
