const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// orderByNearestNeighbour / plotPoint / distance live in app.js (a browser
// script), so extract them by name with brace matching instead of loading
// the DOM.
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
const dimensions = () => ({ width: 118, height: 140 });
const distance = new Function(`return ${extract('distance')}`)();
const plotPoint = new Function('dimensions', `return ${extract('plotPoint')}`)(dimensions);
const orderByNearestNeighbour = new Function('distance', 'plotPoint', `return ${extract('orderByNearestNeighbour')}`)(distance, plotPoint);

// Simulate the pen the way generateGcode does: first stroke from its start,
// then each next stroke from whichever end is nearer the pen.
function travelDistance(ordered) {
  if (ordered.length <= 1) return 0;
  const first = ordered[0];
  let pen = plotPoint(first[first.length - 1]);
  let total = 0;
  for (let i = 1; i < ordered.length; i++) {
    const s = ordered[i];
    const start = plotPoint(s[0]);
    const end = plotPoint(s[s.length - 1]);
    const toStart = distance(pen, start);
    const toEnd = distance(pen, end);
    total += Math.min(toStart, toEnd);
    pen = toStart <= toEnd ? end : start;
  }
  return total;
}

test('nearest-neighbour ordering cuts travel vs import order', () => {
  // Two clusters: a/c bottom-left, b/d top-right. Import order interleaves
  // them, so the pen crosses the bed three times.
  const a = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }];
  const b = [{ x: 0.9, y: 0.9 }, { x: 0.8, y: 0.9 }];
  const c = [{ x: 0.15, y: 0.15 }, { x: 0.25, y: 0.15 }];
  const d = [{ x: 0.85, y: 0.85 }, { x: 0.75, y: 0.85 }];
  const input = [a, b, c, d];
  const ordered = orderByNearestNeighbour(input);
  assert.deepEqual(ordered, [a, c, d, b]);
  assert.ok(travelDistance(ordered) < travelDistance(input));
  assert.ok(travelDistance(ordered) < travelDistance(input) / 2);
  // Input array and strokes untouched (no in-place reversal).
  assert.deepEqual(input, [a, b, c, d]);
  assert.equal(ordered[0], a);
  assert.equal(ordered[1], c);
});

test('ordering considers both ends of each stroke', () => {
  // e runs right-to-left, so its END sits next to a's end; it should be
  // picked next even though its start is far away.
  const a = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }];
  const e = [{ x: 0.9, y: 0.1 }, { x: 0.25, y: 0.1 }];
  const f = [{ x: 0.9, y: 0.9 }, { x: 0.8, y: 0.9 }];
  const ordered = orderByNearestNeighbour([a, f, e]);
  assert.deepEqual(ordered, [a, e, f]);
});

test('edge cases: empty, single, and two strokes', () => {
  assert.deepEqual(orderByNearestNeighbour([]), []);
  const only = [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }];
  const out = orderByNearestNeighbour([only]);
  assert.deepEqual(out, [only]);
  assert.notEqual(out, [only]); // new array, not the input
  const first = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }];
  const second = [{ x: 0.9, y: 0.9 }, { x: 0.8, y: 0.9 }];
  assert.deepEqual(orderByNearestNeighbour([first, second]), [first, second]);
});

test('ordering 5000 scattered strokes is fast and keeps every stroke once', () => {
  // Regression: the old O(S^2) scan took ~850ms at 5000 strokes and 12.8s
  // at 20000 (stipple imports). The bucket grid must stay near-instant.
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const input = Array.from({ length: 5000 }, () => {
    const x = rand(), y = rand();
    return [{ x, y }, { x: Math.min(0.99, x + 0.002), y }];
  });
  const t0 = Date.now();
  const ordered = orderByNearestNeighbour(input);
  const ms = Date.now() - t0;
  assert.equal(ordered.length, 5000);
  assert.equal(new Set(ordered).size, 5000, 'every stroke exactly once');
  assert.ok(travelDistance(ordered) < travelDistance(input), 'ordering must cut travel');
  assert.ok(ms < 3000, `5000-stroke ordering took ${ms}ms, must stay under 3s`);
});
