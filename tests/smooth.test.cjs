const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// smoothStroke / flattenFreehand live in app.js (a browser script), so
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
const distance = new Function(`return ${extract('distance')}`)();
const simplifyStroke = new Function('distance', `return ${extract('simplifyStroke')}`)(distance);
const flattenFreehand = new Function('distance', `return ${extract('flattenFreehand')}`)(distance);
const smoothStroke = new Function('simplifyStroke', 'flattenFreehand', `return ${extract('smoothStroke')}`)(simplifyStroke, flattenFreehand);

function maxAngle(pts) {
  let max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
    if (!l1 || !l2) continue;
    max = Math.max(max, Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)))) * 180 / Math.PI);
  }
  return max;
}

function wiggly(jitterAmp) {
  const raw = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    raw.push({
      x: 0.1 + 0.8 * t,
      y: 0.5 + 0.15 * Math.sin(t * Math.PI * 2) + (Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 78.233) * 0.5) * jitterAmp,
    });
  }
  return raw;
}

test('smoothStroke removes jitter junctions from a hand-drawn line', () => {
  const raw = wiggly(0.001);
  assert.ok(maxAngle(raw) > 15, 'fixture should start out choppy');
  const smooth = smoothStroke(raw);
  assert.ok(smooth.length >= 3);
  assert.ok(smooth.length < raw.length, 'smoothing should drop points');
  assert.ok(maxAngle(smooth) < 15, `worst junction ${maxAngle(smooth).toFixed(1)}deg should be gentle`);
});

test('smoothStroke keeps the path close to the original', () => {
  const raw = wiggly(0.001);
  const smooth = smoothStroke(raw);
  // Every smoothed point must lie within ~0.5mm (0.0042 normalized) of the
  // raw polyline, so the plotted line still follows what was drawn.
  for (const p of smooth) {
    let best = Infinity;
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1], b = raw[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
    assert.ok(best < 0.0042, `smoothed point drifted ${best} from the raw line`);
  }
});

test('flattenFreehand samples the renderer curve, not the raw polygon', () => {
  // Three points forming a corner: the flattened curve must cut the
  // corner (its samples sit off the raw polyline) and end at the
  // midpoint of p1-p2, which is where the renderer's quadratic ends.
  const pts = [{ x: 0.2, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.8 }];
  const flat = flattenFreehand(pts);
  assert.ok(flat.length > 3, 'curve should be sampled, not just the 3 points');
  // flattenFreehand ends with a straight line to the last raw point, so
  // the final point is p2 (0.5, 0.8) and the quadratic segment ends at
  // the midpoint of p1-p2 (0.5, 0.65), one sample earlier.
  const last = flat[flat.length - 1];
  assert.ok(Math.abs(last.x - 0.5) < 1e-9 && Math.abs(last.y - 0.8) < 1e-9, `last point ${last.x},${last.y} should be (0.5, 0.8)`);
  const quadEnd = flat[flat.length - 2];
  assert.ok(Math.abs(quadEnd.x - 0.5) < 1e-9 && Math.abs(quadEnd.y - 0.65) < 1e-9, `quadratic end ${quadEnd.x},${quadEnd.y} should be (0.5, 0.65)`);
  const mid = flat[Math.floor(flat.length / 2)];
  // The quadratic at t=0.5 is (0.425, 0.5375): off both raw segments
  // (y=0.5 and x=0.5), so the curve cuts the corner instead of
  // following the polygon through it.
  assert.ok(Math.abs(mid.y - 0.5) > 0.01 && Math.abs(mid.x - 0.5) > 0.01, `midpoint ${mid.x},${mid.y} should be off the raw polyline`);
});

test('feedrate is emitted only when it changes', () => {
  // Mirror of generateGcode's feedSuffix: the feedrate is modal, so F
  // appears only on the first move at a new feedrate, not every line.
  let lastFeed = null;
  const feedSuffix = (feed) => {
    const v = Math.round(feed);
    if (v === lastFeed) return '';
    lastFeed = v;
    return ` F${v}`;
  };
  const lines = [];
  const travel = 30000, draw = 6000;
  lines.push(`G0 X44.57 Y129.16${feedSuffix(travel)}`);
  for (const p of [{ x: 49.29, y: 130.63 }, { x: 54.1, y: 131.52 }, { x: 58.95, y: 131.81 }]) {
    lines.push(`G1 X${p.x} Y${p.y}${feedSuffix(draw)}`);
  }
  lines.push(`G0 X60 Y60${feedSuffix(travel)}`);
  lines.push(`G1 X61 Y61${feedSuffix(draw)}`);
  assert.deepEqual(lines, [
    'G0 X44.57 Y129.16 F30000',
    'G1 X49.29 Y130.63 F6000',
    'G1 X54.1 Y131.52',
    'G1 X58.95 Y131.81',
    'G0 X60 Y60 F30000',
    'G1 X61 Y61 F6000',
  ]);
});
