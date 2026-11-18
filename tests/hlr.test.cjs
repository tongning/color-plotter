const test = require('node:test');
const assert = require('node:assert/strict');
const { clipAgainstMask } = require('../color-svg.js');

const SIZE = 480;
function maskWithRect(x0, y0, x1, y1) {
  const mask = new Uint8Array(SIZE * SIZE);
  const px0 = Math.floor(x0 * SIZE), px1 = Math.ceil(x1 * SIZE);
  const py0 = Math.floor(y0 * SIZE), py1 = Math.ceil(y1 * SIZE);
  for (let py = py0; py < py1; py++)
    for (let px = px0; px < px1; px++)
      mask[py * SIZE + px] = 1;
  return mask;
}
const emptyMask = () => new Uint8Array(SIZE * SIZE);
const px = 1 / SIZE; // one mask pixel, in normalized units
const near = (a, b) => Math.abs(a - b) <= px;

test('a line clear of the occluder comes back as one piece, endpoints kept', () => {
  const mask = maskWithRect(0.6, 0.6, 0.9, 0.9);
  const out = clipAgainstMask([{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }], mask);
  assert.equal(out.length, 1);
  assert.ok(near(out[0][0].x, 0.1));
  assert.ok(near(out[0].at(-1).x, 0.4));
});

test('a line fully inside the occluder is removed', () => {
  const mask = maskWithRect(0.2, 0.2, 0.8, 0.8);
  assert.deepEqual(clipAgainstMask([{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }], mask), []);
});

test('a line crossing the occluder is split into the visible ends', () => {
  const mask = maskWithRect(0.4, 0.4, 0.6, 0.6);
  const out = clipAgainstMask([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], mask);
  assert.equal(out.length, 2);
  assert.ok(near(out[0][0].x, 0.1));
  assert.ok(out[0].at(-1).x > 0.39 && out[0].at(-1).x < 0.41);
  assert.ok(out[1][0].x > 0.59 && out[1][0].x < 0.61);
  assert.ok(near(out[1].at(-1).x, 0.9));
});

test('a long sparse segment with a hidden middle is split (subdivision)', () => {
  // One segment, endpoints outside, middle inside: without subdivision
  // the midpoint test would miss it.
  const mask = maskWithRect(0.45, 0.45, 0.55, 0.55);
  const out = clipAgainstMask([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], mask);
  assert.equal(out.length, 2);
});

test('a polyline that enters and leaves the occluder twice is split into three', () => {
  const mask = maskWithRect(0.3, 0.3, 0.7, 0.7);
  const line = [
    { x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.1 },
    { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.5 },
  ];
  const out = clipAgainstMask(line, mask);
  assert.equal(out.length, 3);
});

test('an empty occluder returns the line as one piece', () => {
  const line = [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.8 }, { x: 0.9, y: 0.2 }];
  const out = clipAgainstMask(line, emptyMask());
  assert.equal(out.length, 1);
  assert.ok(near(out[0][0].x, 0.1));
  assert.ok(near(out[0].at(-1).x, 0.9));
});

test('a single point or empty input returns nothing', () => {
  assert.deepEqual(clipAgainstMask([{ x: 0.5, y: 0.5 }], emptyMask()), []);
  assert.deepEqual(clipAgainstMask([], emptyMask()), []);
});
