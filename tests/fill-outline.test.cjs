const test = require('node:test');
const assert = require('node:assert/strict');
const { closeLoop } = require('../color-svg.js');

// closeLoop is the fill-perimeter helper in importSvg: a fill's outline
// must draw as a complete loop, so an open sampled outline (polyline, or
// a path whose close is only implicit in the fill) gets its closing edge.
test('an open outline is closed by repeating its first point', () => {
  const open = [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }];
  const closed = closeLoop(open);
  assert.equal(closed.length, 4);
  assert.deepEqual(closed[3], { x: 0.1, y: 0.1 });
  assert.equal(open.length, 3, 'the input is not mutated');
});

test('an already-closed loop passes through unchanged', () => {
  const loop = [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.1, y: 0.1 }];
  assert.strictEqual(closeLoop(loop), loop);
});

test('degenerate outlines (fewer than 3 points) are left alone', () => {
  const two = [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }];
  assert.strictEqual(closeLoop(two), two);
  const empty = [];
  assert.strictEqual(closeLoop(empty), empty);
});
