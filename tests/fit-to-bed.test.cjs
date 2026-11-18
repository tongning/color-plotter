const test = require('node:test');
const assert = require('node:assert/strict');
const { fitToBed } = require('../color-svg.js');

// plotPoint maps normalized coords to mm the way app.js does.
const plot = (p, w, h) => ({ x: p.x * w, y: p.y * h });
const sizeOf = (strokes, w, h) => {
  const pts = strokes.flat().map((p) => plot(p, w, h));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return {
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
    minY: Math.min(...ys),
  };
};
const close = (a, b) => Math.abs(a - b) < 1e-9;

test('a square design stays square on the rectangular 118x140 bed', () => {
  const square = [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]];
  const out = fitToBed(square, 118, 140);
  const { w, h, minY } = sizeOf(out, 118, 140);
  assert.ok(close(w, 118));
  assert.ok(close(h, 118));
  assert.ok(close(minY, 11)); // centred: 11mm margins top and bottom
});

test('a wide design keeps its aspect ratio and fills the bed width', () => {
  // 2:1 design, letterboxed into the normalized square like importSvg does.
  const wide = [[{ x: 0, y: 0.25 }, { x: 1, y: 0.25 }, { x: 1, y: 0.75 }, { x: 0, y: 0.75 }]];
  const out = fitToBed(wide, 118, 140);
  const { w, h } = sizeOf(out, 118, 140);
  assert.ok(close(w, 118));
  assert.ok(close(w / h, 2));
});

test('a tall design keeps its aspect ratio and fills the bed height', () => {
  // 1:2 design, letterboxed into the normalized square.
  const tall = [[{ x: 0.25, y: 0 }, { x: 0.75, y: 0 }, { x: 0.75, y: 1 }, { x: 0.25, y: 1 }]];
  const out = fitToBed(tall, 118, 140);
  const { w, h } = sizeOf(out, 118, 140);
  assert.ok(close(h, 140));
  assert.ok(close(w, 70));
  assert.ok(close(w / h, 0.5));
});

test('a square bed is a no-op', () => {
  const strokes = [[{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.7 }]];
  const out = fitToBed(strokes, 118, 118);
  assert.deepEqual(out, strokes);
});

test('stroke props (color, shape) survive the fit', () => {
  const stroke = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  stroke.color = '#e42e2a'; stroke.shape = true;
  const out = fitToBed([stroke], 118, 140);
  assert.equal(out[0].color, '#e42e2a');
  assert.equal(out[0].shape, true);
});
