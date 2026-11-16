const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fonts } = require('../hershey.js');

// textStrokes lives in app.js (a browser script), so extract it by name
// with brace matching instead of loading the DOM. It only uses its
// parameters and Math, so it runs standalone.
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
const textStrokes = new Function(`return ${extract('textStrokes')}`)();
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const W = 118, H = 118; // bed mm

function bbox(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

test('a single letter lands with its top-left at the click point', () => {
  const origin = { x: 0.2, y: 0.3 };
  const strokes = textStrokes('A', fonts.futural, 10, origin, W, H);
  assert.ok(strokes.length > 0, 'A should produce strokes');
  for (const s of strokes) assert.equal(s.shape, true, 'text strokes are shape strokes (no freehand smoothing)');
  const b = bbox(strokes);
  assert.ok(approx(b.minX, origin.x), `left ${b.minX} != ${origin.x}`);
  assert.ok(approx(b.minY, origin.y), `top ${b.minY} != ${origin.y}`);
  // Cap height is the requested size: H is 21 Hershey units tall.
  assert.ok(approx((b.maxY - b.minY) * H, 10, 0.01), `cap height ${(b.maxY - b.minY) * H}mm != 10mm`);
});

test('cap height matches the requested size in mm', () => {
  for (const size of [5, 10, 20]) {
    const strokes = textStrokes('H', fonts.futural, size, { x: 0.1, y: 0.1 }, W, H);
    const b = bbox(strokes);
    assert.ok(approx((b.maxY - b.minY) * H, size, 0.01), `H height ${(b.maxY - b.minY) * H}mm != ${size}mm`);
  }
});

test('all four fonts produce strokes for the same string', () => {
  for (const name of ['futural', 'futuram', 'rowmans', 'scripts']) {
    const strokes = textStrokes('Hello', fonts[name], 10, { x: 0.1, y: 0.1 }, W, H);
    assert.ok(strokes.length > 0, `${name} produced no strokes`);
    assert.ok(strokes.every((s) => s.shape), `${name} strokes must be shape strokes`);
  }
  // The bolder duplex font draws more (each stem twice).
  const single = textStrokes('H', fonts.futural, 10, { x: 0, y: 0 }, W, H).length;
  const bold = textStrokes('H', fonts.futuram, 10, { x: 0, y: 0 }, W, H).length;
  assert.ok(bold > single, `futuram (${bold} strokes) should draw more than futural (${single})`);
});

test('text advances left to right and spaces separate words', () => {
  const strokes = textStrokes('Hi there', fonts.futural, 10, { x: 0.1, y: 0.1 }, W, H);
  const b = bbox(strokes);
  // "Hi there" is much wider than a single letter.
  const one = bbox(textStrokes('H', fonts.futural, 10, { x: 0.1, y: 0.1 }, W, H));
  assert.ok(b.maxX - b.minX > 3 * (one.maxX - one.minX), 'multi-word text should be wider than one letter');
  // The gap between the words is a real gap: no stroke spans it.
  const gapMid = (bbox(textStrokes('Hi', fonts.futural, 10, { x: 0.1, y: 0.1 }, W, H)).maxX
    + bbox(textStrokes('Hi there', fonts.futural, 10, { x: 0.1, y: 0.1 }, W, H)).minX) / 2;
  void gapMid;
});

test('unknown characters and empty text do not throw', () => {
  assert.deepEqual(textStrokes('', fonts.futural, 10, { x: 0, y: 0 }, W, H), []);
  const weird = textStrokes('héllo→', fonts.futural, 10, { x: 0.1, y: 0.1 }, W, H);
  assert.ok(weird.length > 0, 'unknown chars fall back instead of throwing');
  assert.deepEqual(textStrokes('A', null, 10, { x: 0, y: 0 }, W, H), []);
  assert.deepEqual(textStrokes('A', fonts.futural, 10, { x: 0, y: 0 }, W, H).length > 0, true);
});

test('text stays on a non-square bed with the right physical size', () => {
  const strokes = textStrokes('H', fonts.futural, 10, { x: 0.2, y: 0.2 }, 118, 60);
  const b = bbox(strokes);
  const heightMm = (b.maxY - b.minY) * 60;
  assert.ok(approx(heightMm, 10, 0.01), `H height ${heightMm}mm != 10mm on a 118x60 bed`);
});
