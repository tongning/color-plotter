const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// canConnect / distance live in app.js (a browser script), so extract them
// by name with brace matching instead of loading the DOM.
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
const thresholdMatch = src.match(/const CONNECT_MAX_MM = ([\d.]+);/);
assert.ok(thresholdMatch, 'CONNECT_MAX_MM not found in app.js');
const CONNECT_MAX_MM = Number(thresholdMatch[1]);
const canConnect = new Function('distance', 'CONNECT_MAX_MM', `return ${extract('canConnect')}`)(distance, CONNECT_MAX_MM);

test('pen stays down only when it is already down and the next start is close', () => {
  const pen = { x: 10, y: 10 };
  assert.equal(canConnect(false, pen, { x: 10, y: 10 }), false, 'pen up: never connects');
  assert.equal(canConnect(true, null, { x: 10, y: 10 }), false, 'no known pen position: never connects');
  assert.equal(canConnect(true, pen, { x: 10, y: 10 }), true, 'same point connects');
  assert.equal(canConnect(true, pen, { x: 10 + CONNECT_MAX_MM, y: 10 }), true, 'exactly at the threshold connects');
  assert.equal(canConnect(true, pen, { x: 10 + CONNECT_MAX_MM + 0.01, y: 10 }), false, 'just past the threshold lifts');
  assert.equal(canConnect(true, pen, { x: 50, y: 50 }), false, 'far away lifts');
});

test('the connect threshold is sub-millimetre-scale, under the pen width', () => {
  // The pen is 1.6mm wide, so the link must hide under it.
  assert.ok(CONNECT_MAX_MM > 0 && CONNECT_MAX_MM <= 1.6, `CONNECT_MAX_MM is ${CONNECT_MAX_MM}`);
});

test('generateGcode lifts before a tool change and at the end of the job', () => {
  // The loop only lifts when the pen is down (tool change) or at the end;
  // verify the structure is present in the source so a refactor cannot
  // silently drop the final lift or the tool-change lift.
  assert.ok(src.includes('if (penIsDown) penUp(lines);'), 'tool-change lift guarded by penIsDown');
  assert.ok(src.includes('if (penIsDown) penUp(lines);\n\n  lines.push(...JOB_END'), 'final lift before JOB_END');
  assert.ok(src.includes('if (canConnect(penIsDown, penPosition, first))'), 'stroke loop uses canConnect');
});
