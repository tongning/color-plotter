const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// fitArcs / circleThrough / arcAngle live in app.js (a browser script), so
// extract them by name with brace matching instead of loading the DOM.
const src = fs.readFileSync(`${__dirname}/../app.js`, 'utf8');
function extract(name) {
  const start = src.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} not found in app.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
const circleThrough = new Function(`return ${extract('circleThrough')}`)();
const arcAngle = new Function(`return ${extract('arcAngle')}`)();
const arcStaysInBounds = new Function(`return ${extract('arcStaysInBounds')}`)();
const fitArcs = new Function('circleThrough', 'arcAngle', 'arcStaysInBounds', `return ${extract('fitArcs')}`)(circleThrough, arcAngle, arcStaysInBounds);

// Rebuild the path a move list describes (sampling arcs) so tests can
// measure how far it strays from the original polyline.
function rebuild(pts, moves) {
  const out = [pts[0]];
  let cur = pts[0];
  for (const m of moves) {
    if (m.type === 'arc') {
      const r = Math.hypot(cur.x - m.center.x, cur.y - m.center.y);
      const a1 = Math.atan2(cur.y - m.center.y, cur.x - m.center.x);
      const a2 = Math.atan2(m.to.y - m.center.y, m.to.x - m.center.x);
      let d = a2 - a1;
      if (m.clockwise && d > 0) d -= 2 * Math.PI;
      if (!m.clockwise && d < 0) d += 2 * Math.PI;
      const steps = Math.max(2, Math.ceil(Math.abs(d) * r / 0.5));
      for (let s = 1; s <= steps; s++) {
        out.push({ x: m.center.x + r * Math.cos(a1 + d * s / steps), y: m.center.y + r * Math.sin(a1 + d * s / steps) });
      }
    } else {
      out.push(m.to);
    }
    cur = m.to;
  }
  return out;
}
function maxDeviation(pts, moves) {
  const rebuilt = rebuild(pts, moves);
  let max = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 1; i < rebuilt.length; i++) {
      const a = rebuilt[i - 1], b = rebuilt[i];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
    max = Math.max(max, best);
  }
  return max;
}

test('ellipse becomes a handful of arcs, not 64 line segments', () => {
  const ell = Array.from({ length: 65 }, (_, i) => {
    const a = i / 64 * Math.PI * 2;
    return { x: 59 + Math.cos(a) * 35, y: 59 + Math.sin(a) * 24 };
  });
  const moves = fitArcs(ell);
  assert.ok(moves.length <= 12, `ellipse should be <=12 moves, got ${moves.length}`);
  assert.ok(moves.filter((m) => m.type === 'arc').length >= 6, 'most ellipse moves should be arcs');
  assert.ok(maxDeviation(ell, moves) <= 0.15, `ellipse arcs stray ${maxDeviation(ell, moves).toFixed(3)}mm`);
  const last = moves[moves.length - 1].to;
  assert.ok(Math.hypot(last.x - ell[ell.length - 1].x, last.y - ell[ell.length - 1].y) < 1e-9, 'last move must end at the last point');
});

test('arc direction matches the path direction (G3 CCW, G2 CW)', () => {
  // Counterclockwise ellipse in mm space (X right, Y up) -> G3.
  const ell = Array.from({ length: 65 }, (_, i) => {
    const a = i / 64 * Math.PI * 2;
    return { x: 59 + Math.cos(a) * 35, y: 59 + Math.sin(a) * 24 };
  });
  const ccw = fitArcs(ell);
  assert.ok(ccw.filter((m) => m.type === 'arc').every((m) => !m.clockwise), 'CCW ellipse arcs must be counterclockwise');
  // Reversed (clockwise) -> G2.
  const cw = fitArcs(ell.slice().reverse());
  assert.ok(cw.filter((m) => m.type === 'arc').every((m) => m.clockwise), 'reversed ellipse arcs must be clockwise');
});

test('a circle becomes two arcs', () => {
  const circ = Array.from({ length: 65 }, (_, i) => {
    const a = i / 64 * Math.PI * 2;
    return { x: 59 + Math.cos(a) * 30, y: 59 + Math.sin(a) * 30 };
  });
  const moves = fitArcs(circ);
  assert.equal(moves.length, 2, `circle should be 2 arcs, got ${moves.length}`);
  assert.ok(moves.every((m) => m.type === 'arc'));
  assert.ok(maxDeviation(circ, moves) <= 0.01, 'circle arcs should be nearly exact');
});

test('a straight line stays lines, never arcs', () => {
  const straight = Array.from({ length: 11 }, (_, i) => ({ x: 10 + i * 5, y: 20 }));
  const moves = fitArcs(straight);
  assert.ok(moves.every((m) => m.type === 'line'), 'collinear points must stay G1 lines');
  assert.equal(moves.length, 10);
});

test('freehand curve becomes arcs within tolerance', () => {
  const raw = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    raw.push({ x: 12 + 94 * t, y: 59 + 18 * Math.sin(t * Math.PI * 2) });
  }
  const moves = fitArcs(raw);
  assert.ok(moves.length < raw.length / 4, `freehand should collapse, got ${moves.length} moves from ${raw.length} pts`);
  assert.ok(maxDeviation(raw, moves) <= 0.15, `freehand arcs stray ${maxDeviation(raw, moves).toFixed(3)}mm`);
});

test('an arc that would leave the bed is rejected by arcStaysInBounds', () => {
  // A fitted arc can bulge up to the 0.1mm tolerance past the polyline,
  // so a curve hugging the bed edge can produce an arc RRF rejects with
  // "intermediate position outside machine limits". The bounds check must
  // catch an arc whose sweep dips below y=0 and accept the same arc
  // shifted inside the bed.
  const bounds = { minX: 0, minY: 0, maxX: 118, maxY: 118 };
  // Circle centre (59, 5), radius 6: bottom of the circle is y=-1.
  // Sweep from 200deg to 340deg (through the bottom, 270deg).
  const a1 = 200 * Math.PI / 180;
  const sweep = 140 * Math.PI / 180; // counterclockwise, 200 -> 340deg
  assert.equal(arcStaysInBounds({ x: 59, y: 5 }, 6, a1, sweep, bounds), false, 'arc dipping below y=0 must be rejected');
  // Same circle shifted up so its bottom is y=4: fully inside.
  assert.equal(arcStaysInBounds({ x: 59, y: 10 }, 6, a1, sweep, bounds), true, 'same arc inside the bed must be accepted');
  // A clockwise sweep through the bottom must be rejected too.
  assert.equal(arcStaysInBounds({ x: 59, y: 5 }, 6, -20 * Math.PI / 180, -140 * Math.PI / 180, bounds), false, 'clockwise arc dipping below y=0 must be rejected');
});

test('fitArcs with bounds never emits an arc outside the bed', () => {
  // Regression test for the RRF "intermediate position outside machine
  // limits" error: run premade strokes through fitArcs with the bed
  // bounds and sample each emitted arc — none may leave the bed.
  const bounds = { minX: 0, minY: 0, maxX: 118, maxY: 118 };
  const markerPalette = ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff'];
  const parsePremadeGcode = new Function('markerPalette', `return ${extract('parsePremadeGcode')}`)(markerPalette);
  const distance = new Function(`return ${extract('distance')}`)();
  const simplifyStroke = new Function('distance', `return ${extract('simplifyStroke')}`)(distance);
  let arcs = 0;
  for (const name of ['stanford bunny', 'meme1', 'emoji', 'meowl']) {
    const gcode = fs.readFileSync(`${__dirname}/../assets/${name}.gcode`, 'utf8');
    for (const s of parsePremadeGcode(gcode)) {
      const ready = simplifyStroke(s, 0.0004);
      const mm = ready.map((p) => ({ x: p.x * 118, y: (1 - p.y) * 118 }));
      let cur = mm[0];
      for (const m of fitArcs(mm, 0.1, bounds)) {
        if (m.type === 'arc') {
          arcs++;
          const r = Math.hypot(cur.x - m.center.x, cur.y - m.center.y);
          const a1 = Math.atan2(cur.y - m.center.y, cur.x - m.center.x);
          const a2 = Math.atan2(m.to.y - m.center.y, m.to.x - m.center.x);
          let d = a2 - a1;
          if (m.clockwise && d > 0) d -= 2 * Math.PI;
          if (!m.clockwise && d < 0) d += 2 * Math.PI;
          const steps = Math.max(8, Math.ceil(Math.abs(d) * r / 0.25));
          for (let k = 0; k <= steps; k++) {
            const a = a1 + d * k / steps;
            const px = m.center.x + r * Math.cos(a);
            const py = m.center.y + r * Math.sin(a);
            assert.ok(px >= -0.001 && px <= 118.001 && py >= -0.001 && py <= 118.001,
              `${name}: arc sample (${px.toFixed(2)},${py.toFixed(2)}) leaves the bed`);
          }
        }
        cur = m.to;
      }
    }
  }
  assert.ok(arcs > 0, 'premade test should contain arcs to check');
});

test('an arc never strays from the polyline it replaces', () => {
  // The radial check alone only puts the vertices near the circle; the
  // arc between two vertices can bulge far off the straight segment
  // joining them, which rounds off polygonal shapes like the bunny.
  // Every emitted arc must stay within the 0.1mm tolerance of the
  // polyline itself, measured as the distance from arc samples to the
  // closest polyline segment.
  const bounds = { minX: 0, minY: 0, maxX: 118, maxY: 118 };
  const markerPalette = ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff'];
  const parsePremadeGcode = new Function('markerPalette', `return ${extract('parsePremadeGcode')}`)(markerPalette);
  const distance = new Function(`return ${extract('distance')}`)();
  const simplifyStroke = new Function('distance', `return ${extract('simplifyStroke')}`)(distance);
  const distToSegment = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  let worst = 0;
  for (const name of ['stanford bunny', 'golden gate bridge', 'meowl', 'emoji']) {
    const gcode = fs.readFileSync(`${__dirname}/../assets/${name}.gcode`, 'utf8');
    for (const s of parsePremadeGcode(gcode)) {
      const ready = simplifyStroke(s, 0.0004);
      const mm = ready.map((p) => ({ x: p.x * 118, y: (1 - p.y) * 118 }));
      let cur = mm[0];
      for (const m of fitArcs(mm, 0.1, bounds)) {
        if (m.type === 'arc') {
          const r = Math.hypot(cur.x - m.center.x, cur.y - m.center.y);
          const a1 = Math.atan2(cur.y - m.center.y, cur.x - m.center.x);
          const a2 = Math.atan2(m.to.y - m.center.y, m.to.x - m.center.x);
          let d = a2 - a1;
          if (m.clockwise && d > 0) d -= 2 * Math.PI;
          if (!m.clockwise && d < 0) d += 2 * Math.PI;
          const steps = Math.max(8, Math.ceil(Math.abs(d) * r / 0.25));
          for (let k = 1; k < steps; k++) {
            const a = a1 + d * k / steps;
            const p = { x: m.center.x + r * Math.cos(a), y: m.center.y + r * Math.sin(a) };
            let best = Infinity;
            for (let sIdx = 0; sIdx < mm.length - 1; sIdx++) {
              best = Math.min(best, distToSegment(p, mm[sIdx], mm[sIdx + 1]));
            }
            worst = Math.max(worst, best);
          }
        }
        cur = m.to;
      }
    }
  }
  assert.ok(worst <= 0.12, `worst arc-to-polyline deviation ${worst.toFixed(2)}mm must stay near the 0.1mm tolerance`);
});

test('emitted arcs keep start/end radii equal within RRF limits', () => {
  // Mirror generateGcode: round points to 4 decimals, fit arcs, then
  // compute the radii exactly as RRF does from the rounded I/J and X/Y.
  // RRF 3.6.2+ aborts when they differ by >0.05mm (FDM) or >0.0022mm (CNC).
  const fmt = (n) => Number(n.toFixed(4));
  const ell = Array.from({ length: 65 }, (_, i) => {
    const a = i / 64 * Math.PI * 2;
    return { x: fmt(59 + Math.cos(a) * 35), y: fmt(59 + Math.sin(a) * 24) };
  });
  const bounds = { minX: 0, minY: 0, maxX: 118, maxY: 118 };
  const moves = fitArcs(ell, 0.1, bounds);
  let cur = ell[0];
  let maxDiff = 0;
  for (const m of moves) {
    if (m.type !== 'arc') { cur = m.to; continue; }
    const ix = fmt(m.center.x - cur.x), jy = fmt(m.center.y - cur.y);
    const ex = fmt(m.to.x), ey = fmt(m.to.y);
    const rStart = Math.hypot(ix, jy);
    const rEnd = Math.hypot(ex - (cur.x + ix), ey - (cur.y + jy));
    maxDiff = Math.max(maxDiff, Math.abs(rStart - rEnd));
    cur = m.to;
  }
  assert.ok(maxDiff <= 0.0022, `max radius difference ${maxDiff.toFixed(5)}mm must stay under RRF's 0.0022mm CNC limit`);
});
