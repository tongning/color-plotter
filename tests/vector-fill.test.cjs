const test = require('node:test');
const assert = require('node:assert/strict');
const { vectorHatch } = require('../vector-fill.js');
const size = 96;
const spacing = 2.5, edgeGap = -0.5, connectMax = 4 * spacing;

// Rasterize a closed outline the way fillCoverageMask does: the stroke is
// 4px wide (halfWidth 2), so covered pixels are within 2px of an edge and
// inside pixels are the polygon interior outside the stroke.
function rasterizeOutline(poly, halfW = 2) {
  const covered = new Uint8Array(size * size);
  const inside = new Uint8Array(size * size);
  const distToSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const inPoly = (px, py) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x + .5, py = y + .5;
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      d = Math.min(d, distToSeg(px, py, a.x, a.y, b.x, b.y));
    }
    if (d <= halfW) covered[y * size + x] = 1;
    else if (inPoly(px, py)) inside[y * size + x] = 1;
  }
  return { covered, inside };
}
function strokeFrom(poly, shape = true) {
  const s = poly.map((p) => ({ x: p.x / size, y: p.y / size }));
  s.shape = shape;
  return s;
}
const length = (strokes) => strokes.reduce((sum, stroke) => sum + stroke.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - stroke[i].x, p.y - stroke[i].y) * size, 0), 0);
// Every drawn segment must stay in the region or the outline (the skin
// overlap pushes run endpoints 0.5px into the outline). Sample densely
// and allow a 1px tolerance for the sub-pixel endpoints.
function checkInside(strokes, inside, covered) {
  for (const stroke of strokes) {
    assert.equal(stroke.shape, true, 'fill must preserve corners rather than use freehand smoothing');
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1], b = stroke[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * size * 4));
      for (let j = 0; j <= steps; j++) {
        const x = Math.floor((a.x + (b.x - a.x) * j / steps) * size);
        const y = Math.floor((a.y + (b.y - a.y) * j / steps) * size);
        let ok = false;
        for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1 && !ok; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < size && ny < size && (inside[ny * size + nx] || covered[ny * size + nx])) ok = true;
        }
        assert.ok(ok, `segment left its region at ${x},${y}`);
      }
    }
  }
}
function fillShape(name, poly, strokePolys) {
  const { covered, inside } = rasterizeOutline(poly);
  const strokes = strokePolys.map((p) => strokeFrom(p));
  const hatch = vectorHatch(strokes, covered, inside, size, spacing, edgeGap, connectMax);
  assert.ok(hatch, `${name}: vector fill returned null`);
  return { hatch, inside, covered };
}

test('rectangle vector-fills in one stroke', () => {
  const rect = [{ x: 20, y: 20 }, { x: 76, y: 20 }, { x: 76, y: 76 }, { x: 20, y: 76 }];
  const { hatch, inside, covered } = fillShape('rect', rect, [[...rect, rect[0]]]);
  assert.equal(hatch.length, 1);
  checkInside(hatch, inside, covered);
});

test('circle vector-fills in one stroke with a smooth edge', () => {
  const circ = [];
  for (let k = 0; k < 64; k++) {
    const a = k / 64 * 2 * Math.PI;
    circ.push({ x: 48 + 28 * Math.cos(a), y: 48 + 28 * Math.sin(a) });
  }
  const { hatch, inside, covered } = fillShape('circle', circ, [[...circ, circ[0]]]);
  assert.equal(hatch.length, 1);
  checkInside(hatch, inside, covered);
  // The drawn stroke near the boundary hugs the true circle (radius 26
  // = 28 - halfWidth 2). The raster ring stair-steps up to ~0.7px off
  // the edge on average; the vector edge stays well inside that.
  let max = 0, sum = 0, n = 0;
  for (const st of hatch) for (const p of st) {
    const r = Math.hypot(p.x * size - 48, p.y * size - 48);
    const d = Math.abs(r - 26);
    if (d < 3) { max = Math.max(max, d); sum += d; n++; }
  }
  assert.ok(n > 0, 'no boundary points found');
  assert.ok(sum / n < 0.5, `mean edge deviation ${sum / n} px`);
  assert.ok(max < 1.1, `worst edge deviation ${max} px`);
});

test('diamond vector-fills in one stroke', () => {
  const diam = [{ x: 48, y: 8 }, { x: 88, y: 48 }, { x: 48, y: 88 }, { x: 8, y: 48 }];
  const { hatch, inside, covered } = fillShape('diamond', diam, [[...diam, diam[0]]]);
  assert.equal(hatch.length, 1);
  checkInside(hatch, inside, covered);
});

test('U-shape vector-fills without lapping the notch', () => {
  const u = [{ x: 16, y: 16 }, { x: 36, y: 16 }, { x: 36, y: 56 }, { x: 60, y: 56 }, { x: 60, y: 16 }, { x: 80, y: 16 }, { x: 80, y: 80 }, { x: 16, y: 80 }];
  const { hatch, inside, covered } = fillShape('U', u, [[...u, u[0]]]);
  assert.ok(hatch.length <= 3, `U-shape took ${hatch.length} strokes`);
  assert.ok(length(hatch) < 1600, `fill traveled ${length(hatch)} pixels`);
  checkInside(hatch, inside, covered);
});

test('concave shape vector-fills without retracing its perimeter', () => {
  const conc = [{ x: 16, y: 16 }, { x: 64, y: 16 }, { x: 64, y: 40 }, { x: 80, y: 40 }, { x: 80, y: 80 }, { x: 16, y: 80 }];
  const { hatch, inside, covered } = fillShape('concave', conc, [[...conc, conc[0]]]);
  assert.ok(hatch.length <= 3, `concave took ${hatch.length} strokes`);
  checkInside(hatch, inside, covered);
});

test('an interior hatch line is not mistaken for the boundary', () => {
  const rect = [{ x: 20, y: 20 }, { x: 76, y: 20 }, { x: 76, y: 76 }, { x: 20, y: 76 }];
  const hatchLine = [{ x: 30, y: 30 }, { x: 66, y: 66 }];
  const { hatch, inside, covered } = fillShape('rect+hatch', rect, [[...rect, rect[0]], hatchLine]);
  assert.equal(hatch.length, 1);
  checkInside(hatch, inside, covered);
});

test('freehand stroke flattens to its quadratic curve and fills', () => {
  // Raw pointer points of a circle; the rendered curve is the quadratic
  // smoothing through segment midpoints, not the raw polyline.
  const pts = [];
  for (let k = 0; k < 60; k++) {
    const a = k / 60 * 2 * Math.PI;
    pts.push({ x: 48 + 28 * Math.cos(a), y: 48 + 28 * Math.sin(a) });
  }
  pts.push({ ...pts[0] });
  const poly = pts.map((p) => ({ x: p.x, y: p.y }));
  const { covered, inside } = rasterizeOutline(poly);
  const stroke = pts.map((p) => ({ x: p.x / size, y: p.y / size }));
  stroke.shape = false;
  const hatch = vectorHatch([stroke], covered, inside, size, spacing, edgeGap, connectMax);
  assert.ok(hatch, 'freehand circle returned null');
  assert.equal(hatch.length, 1);
  checkInside(hatch, inside, covered);
});

test('no boundary strokes returns null so the caller falls back to raster', () => {
  const mask = new Uint8Array(size * size);
  for (let y = 20; y < 76; y++) for (let x = 20; x < 76; x++) mask[y * size + x] = 1;
  const covered = new Uint8Array(size * size);
  assert.equal(vectorHatch([], covered, mask, size, spacing, edgeGap, connectMax), null);
});
