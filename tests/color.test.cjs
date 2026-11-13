const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PALETTE, nearestTool, splitPath, clipPolyline } = require('../color-svg.js');

test('each palette color maps to its own tool, with stable ties', () => {
  DEFAULT_PALETTE.forEach((color, tool) => assert.equal(nearestTool(color, DEFAULT_PALETTE), tool));
  assert.equal(nearestTool('#ff0000', ['#ff0000', '#ff0000']), 0);
  assert.equal(nearestTool('#0000ff', DEFAULT_PALETTE), 6);
  assert.equal(nearestTool('#ff0000', DEFAULT_PALETTE), 1);
});

test('compound paths track relative endpoints across curves and closing commands', () => {
  assert.deepEqual(splitPath('M10 20 c5 5 10 10 20 30 m5 5 l10 0z m2 3 h4'), [
    'M 10 20 c 5 5 10 10 20 30', 'M 35 55 l 10 0 Z', 'M 37 58 h 4'
  ]);
  assert.deepEqual(splitPath('M1e1,2e1 30,40 M50 60A10 10 0 0 1 70 80'), ['M 10 20 L 30 40', 'M 50 60 A 10 10 0 0 1 70 80']);
  assert.throws(() => splitPath('M 1'), /invalid/);
});

test('clipping keeps crossings, rejects outside paths, and avoids boundary connectors', () => {
  assert.deepEqual(clipPolyline([{x:-1,y:.5},{x:2,y:.5}]), [[{x:0,y:.5},{x:1,y:.5}]]);
  assert.deepEqual(clipPolyline([{x:-1,y:0},{x:-1,y:1}]), []);
  assert.equal(clipPolyline([{x:.2,y:.2},{x:2,y:.2},{x:2,y:.8},{x:.2,y:.8}]).length, 2);
});
