const test = require('node:test');
const assert = require('node:assert/strict');
const { convertPixels, rdp, chaikin, orderPolylines, PALETTE } = require('../photo-sketch.js');

// A photo with something to find: a black disc on a light-to-dark
// grey gradient, like a simple product shot.
function makePhoto(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2, dy = y - h / 2;
      let v = Math.round(255 * x / w);
      if (dx * dx + dy * dy < 25 * 25) v = 0;
      const i = (y * w + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

test('rdp drops collinear points and keeps the corners', () => {
  assert.deepEqual(rdp([[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]], 0.1), [[0, 0], [3, 0], [3, 1]]);
});

test('chaikin keeps endpoints and smooths the middle', () => {
  const out = chaikin([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]]);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [10, 10]);
  assert.ok(out.length > 5, 'straight runs gain intermediate points');
});

test('ordering returns every line once', () => {
  const lines = [[[0, 0], [1, 0]], [[5, 5], [6, 5]], [[2, 2], [3, 2]]];
  const ordered = orderPolylines(lines);
  assert.equal(ordered.length, 3);
  assert.equal(new Set(ordered.map((l) => l[0].join(','))).size, 3);
});

test('a photo converts to a stroke SVG with structure and tone', async () => {
  const { svg, stats } = await convertPixels(makePhoto(120, 90), { shading: 'off', density: 1 });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480">'));
  assert.ok(svg.includes('<!-- pen-down '), 'stats comment is embedded');
  assert.ok(stats.structurePaths > 0, 'structure finds the disc edge');
  assert.ok(stats.tonePaths > 0, 'tone shades the gradient');
  assert.ok(stats.toneM > 0 && stats.penUpM >= 0 && stats.lifts > 0);
  const strokes = [...svg.matchAll(/stroke="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  assert.ok(strokes.length > 0);
  assert.ok(strokes.every((s) => PALETTE.includes(s)), 'every stroke uses a palette pen');
});

test('higher density packs more tone ink', async () => {
  const photo = makePhoto(120, 90);
  const low = await convertPixels(photo, { shading: 'off', density: 1 });
  const high = await convertPixels(photo, { shading: 'off', density: 5 });
  assert.ok(high.stats.toneM > low.stats.toneM, `density 5 (${high.stats.toneM} m) beats density 1 (${low.stats.toneM} m)`);
});

test('gradient, hybrid, squiggle and tsp modes all produce paths', async () => {
  const photo = makePhoto(120, 90);
  for (const shading of ['gradient', 'hybrid', 'squiggle', 'tsp']) {
    const { svg, stats } = await convertPixels(photo, { shading, density: 1 });
    assert.ok(svg.includes('<path '), `${shading} emits paths`);
    assert.ok(stats.tonePaths >= 1, `${shading} shades something`);
  }
});

test('tsp mode draws one continuous tour per pen', async () => {
  const { svg, stats } = await convertPixels(makePhoto(120, 90), { shading: 'tsp', density: 1 });
  // One tour per pen: black plus one per colour layer. (Structure
  // outlines are black too, so the SVG has more black paths than tours.)
  assert.equal(stats.tonePaths, 1 + stats.colourLayers.length, 'one tour per pen');
  const blackPaths = [...svg.matchAll(/<path d="([^"]+)" stroke="#2c2d30"/g)].map((m) => m[1]);
  const longest = Math.max(...blackPaths.map((d) => d.split(' L ').length));
  assert.ok(longest > 100, 'the black tour is one long continuous line');
});

test('a blank white photo plots nothing', async () => {
  const data = new Uint8ClampedArray(80 * 60 * 4).fill(255);
  const { svg, stats } = await convertPixels({ width: 80, height: 60, data }, { shading: 'off' });
  assert.equal(stats.structurePaths, 0);
  assert.equal(stats.tonePaths, 0);
  assert.ok(!svg.includes('<path '));
});

test('uniform smoothing and detail mode also convert', async () => {
  const photo = makePhoto(120, 90);
  const plain = await convertPixels(photo, { shading: 'off', adaptive: false });
  assert.ok(plain.stats.tonePaths > 0, 'uniform smoothing converts');
  const detailed = await convertPixels(photo, { shading: 'off', detail: true });
  assert.ok(detailed.stats.structurePaths > 0, 'detail mode converts');
});

test('empty pixels are rejected', async () => {
  await assert.rejects(convertPixels({ width: 0, height: 0, data: new Uint8ClampedArray(0) }), /no pixels/);
});
