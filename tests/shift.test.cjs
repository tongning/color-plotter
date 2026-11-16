const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// shiftConstrain / shapeStroke live in app.js (a browser script), so
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
const shiftConstrain = new Function(`return ${extract('shiftConstrain')}`)();
const markerPalette = ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff'];
function makeShapeStroke(width, height) {
  return new Function('shiftConstrain', 'dimensions', 'markerPalette', 'activeMarker',
    `return ${extract('shapeStroke')}`)(
    shiftConstrain, () => ({ width, height }), markerPalette, 0);
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('line snaps to the nearest of 8 directions, preserving length', () => {
  const W = 118, H = 118;
  const start = { x: 0.2, y: 0.2 };
  // 30 deg drag, length 0.3 (normalized) -> snaps to 45 deg.
  const len = 0.3;
  const end30 = { x: start.x + len * Math.cos(Math.PI / 6), y: start.y + len * Math.sin(Math.PI / 6) };
  const got = shiftConstrain('line', start, end30, W, H);
  const want = { x: start.x + len * Math.cos(Math.PI / 4), y: start.y + len * Math.sin(Math.PI / 4) };
  assert.ok(approx(got.x, want.x), `x ${got.x} != ${want.x}`);
  assert.ok(approx(got.y, want.y), `y ${got.y} != ${want.y}`);
  assert.ok(approx(Math.hypot(got.x - start.x, got.y - start.y), len));

  // 10 deg -> 0 deg (horizontal), 80 deg -> 90 deg (vertical).
  const end10 = { x: start.x + len * Math.cos(0.17), y: start.y + len * Math.sin(0.17) };
  const got10 = shiftConstrain('line', start, end10, W, H);
  assert.ok(approx(got10.y, start.y), '10deg should snap horizontal');
  assert.ok(approx(got10.x, start.x + len));
  const end80 = { x: start.x + len * Math.cos(1.4), y: start.y + len * Math.sin(1.4) };
  const got80 = shiftConstrain('line', start, end80, W, H);
  assert.ok(approx(got80.x, start.x), '80deg should snap vertical');
  assert.ok(approx(got80.y, start.y + len));

  // Zero-length drag is unchanged.
  assert.deepEqual(shiftConstrain('line', start, start, W, H), start);
});

test('rectangle/ellipse drag to a square in the drag direction', () => {
  const W = 118, H = 118;
  const start = { x: 0.2, y: 0.2 };
  const end = { x: 0.6, y: 0.4 }; // wider than tall
  const got = shiftConstrain('rectangle', start, end, W, H);
  assert.ok(approx(got.x, 0.6), `x ${got.x}`);
  assert.ok(approx(got.y, 0.6), `y ${got.y} (side = max axis)`);

  // Dragging up-left extends the square up-left.
  const start2 = { x: 0.6, y: 0.6 };
  const end2 = { x: 0.2, y: 0.4 };
  const got2 = shiftConstrain('ellipse', start2, end2, W, H);
  assert.ok(approx(got2.x, 0.2), `x ${got2.x}`);
  assert.ok(approx(got2.y, 0.2), `y ${got2.y}`);
});

test('square is square in mm on a non-square bed', () => {
  const W = 118, H = 60;
  const start = { x: 0.2, y: 0.2 };
  const end = { x: 0.6, y: 0.4 };
  const got = shiftConstrain('rectangle', start, end, W, H);
  const sideXmm = (got.x - start.x) * W;
  const sideYmm = (got.y - start.y) * H;
  assert.ok(approx(sideXmm, sideYmm), `physical sides ${sideXmm} vs ${sideYmm}mm`);
  assert.ok(approx(sideXmm, 0.4 * W), 'side = longer drag axis in mm');
});

test('line snap is at 45 deg in mm on a non-square bed', () => {
  const W = 118, H = 60;
  const start = { x: 0.2, y: 0.2 };
  // Physical 30 deg drag, 30mm long.
  const end = { x: start.x + 30 * Math.cos(Math.PI / 6) / W, y: start.y + 30 * Math.sin(Math.PI / 6) / H };
  const got = shiftConstrain('line', start, end, W, H);
  const dxMm = (got.x - start.x) * W, dyMm = (got.y - start.y) * H;
  const angle = Math.atan2(dyMm, dxMm);
  assert.ok(approx(angle, Math.PI / 4), `physical angle ${angle} rad, want 45deg`);
  assert.ok(approx(Math.hypot(dxMm, dyMm), 30), 'physical length preserved');
});

test('shapeStroke with shift makes a square rect, a circle ellipse, a snapped line', () => {
  const shapeStroke = makeShapeStroke(118, 118);
  const start = { x: 0.2, y: 0.2 };
  const rect = shapeStroke('rectangle', start, { x: 0.6, y: 0.4 }, true);
  assert.equal(rect.length, 5);
  assert.ok(approx(rect[2].x, 0.6) && approx(rect[2].y, 0.6), 'rect opposite corner is the square corner');
  assert.ok(rect.shape);

  const ell = shapeStroke('ellipse', start, { x: 0.6, y: 0.4 }, true);
  const cx = 0.4, cy = 0.4;
  for (const p of ell) {
    assert.ok(approx(Math.hypot(p.x - cx, p.y - cy), 0.2, 1e-6), `ellipse point ${p.x},${p.y} not on circle r=0.2`);
  }

  const line = shapeStroke('line', start, { x: 0.2 + 0.3 * Math.cos(Math.PI / 6), y: 0.2 + 0.3 * Math.sin(Math.PI / 6) }, true);
  assert.equal(line.length, 2);
  assert.ok(approx(line[1].x, start.x + 0.3 * Math.cos(Math.PI / 4)));
  assert.ok(approx(line[1].y, start.y + 0.3 * Math.sin(Math.PI / 4)));

  // Without shift, the rect stays a non-square rectangle.
  const plain = shapeStroke('rectangle', start, { x: 0.6, y: 0.4 }, false);
  assert.ok(approx(plain[2].x, 0.6) && approx(plain[2].y, 0.4));
});
