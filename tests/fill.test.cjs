const test = require('node:test');
const assert = require('node:assert/strict');
const { hatchStrokes } = require('../fill-path.js');
const size = 96;
const maskFor = predicate => Uint8Array.from({length:size*size}, (_,i) => +predicate(i%size, Math.floor(i/size)));
const length = strokes => strokes.reduce((sum, stroke) => sum + stroke.slice(1).reduce((n,p,i) => n + Math.hypot(p.x-stroke[i].x,p.y-stroke[i].y)*size,0),0);
function checkInside(strokes, mask) {
  for (const stroke of strokes) {
    assert.equal(stroke.shape, true, 'fill must preserve corners rather than use freehand smoothing');
    for (let i=1;i<stroke.length;i++) {
      const a=stroke[i-1], b=stroke[i];
      const steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)*size*4));
      for(let j=0;j<=steps;j++) {
        const x=Math.floor((a.x+(b.x-a.x)*j/steps)*size);
        const y=Math.floor((a.y+(b.y-a.y)*j/steps)*size);
        assert.equal(mask[y*size+x],1,`segment left its region at ${x},${y}`);
      }
    }
  }
}
function checkCoverage(strokes, mask) {
  const covered=new Uint8Array(size*size);
  for (const stroke of strokes) for(let i=1;i<stroke.length;i++) {
    const a=stroke[i-1],b=stroke[i],steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)*size*4));
    for(let j=0;j<=steps;j++) covered[Math.floor((a.y+(b.y-a.y)*j/steps)*size)*size+Math.floor((a.x+(b.x-a.x)*j/steps)*size)]=1;
  }
  // Every selected scanline pixel must still be drawn, including split runs.
  const step=Math.round(2*Math.SQRT2);
  for(let offset=-(size-1);offset<size;offset+=step) for(let y=Math.max(0,-offset);y<=Math.min(size-1,size-1-offset);y++) {
    const i=y*size+y+offset;
    if(mask[i]) assert.equal(covered[i],1,`missing hatch pixel ${i%size},${y}`);
  }
}

test('rectangle fills continuously, covers every hatch, and uses compact paths',()=>{
  const mask=maskFor((x,y)=>x>=8&&x<88&&y>=8&&y<88);
  const strokes=hatchStrokes(mask,size,2);
  assert.equal(strokes.length,1);
  assert.ok(strokes[0].length<180);
  checkInside(strokes,mask);checkCoverage(strokes,mask);
});

test('holes stay empty while connected fill avoids repeated perimeter laps',()=>{
  const mask=maskFor((x,y)=>x>=8&&x<88&&y>=8&&y<88&&!(x>=30&&x<66&&y>=30&&y<66));
  const strokes=hatchStrokes(mask,size,2);
  // Top-infill rule: no hop through the fill to join the two sides of
  // the hole, however short; the pen lifts instead of drawing a line
  // across the hatching. Old boundary-biased routing traveled 3,361
  // pixels for this fixture.
  assert.equal(strokes.length,2);
  assert.ok(length(strokes)<2800,`fill traveled ${length(strokes)} pixels`);
  checkInside(strokes,mask);checkCoverage(strokes,mask);
});

test('deep concave branches fill without repeatedly retracing their perimeter',()=>{
  const mask=maskFor((x,y)=>x>=8&&x<88&&y>=8&&y<88&&!(y<68&&((x>=24&&x<32)||(x>=48&&x<56)||(x>=72&&x<80))));
  const strokes=hatchStrokes(mask,size,2);
  // Cura-style: the pen lifts between branches instead of lapping the
  // notch walls to join them (the boundary path around a slot is far
  // longer than the connector cap), so this is several strokes, not one.
  // Old scanline ordering traveled 5,867 pixels for this fixture.
  assert.equal(strokes.length,6);
  assert.ok(length(strokes)<3400,`fill traveled ${length(strokes)} pixels`);
  checkInside(strokes,mask);checkCoverage(strokes,mask);
});

test('U-shape lifts between arms instead of lapping the notch',()=>{
  const mask=maskFor((x,y)=>x>=8&&x<88&&y>=8&&y<88&&!(x>=36&&x<60&&y<60));
  const strokes=hatchStrokes(mask,size,2);
  // The wall path around the notch is far longer than the connector cap,
  // and no hop through the fill is allowed, so the arms and the base
  // are separate strokes.
  assert.equal(strokes.length,3);
  checkInside(strokes,mask);checkCoverage(strokes,mask);
});

test('circle keeps its edge fragments in the fill instead of stranding them',()=>{
  const mask=maskFor((x,y)=>Math.hypot(x-48,y-48)<=40);
  const strokes=hatchStrokes(mask,size,2);
  // The curved edge grazes many scanlines into one-pixel runs. They are
  // drawn while the pen is next to them (dot priority plus wall-only
  // links) instead of each getting its own lift. One far-left dot is
  // still stranded at this spacing; at the app default (2.5) it joins
  // and the circle is a single stroke.
  assert.equal(strokes.length,2);
  checkInside(strokes,mask);checkCoverage(strokes,mask);
});

test('fill reaches the edge along a rectangle top',()=>{
  const mask=maskFor((x,y)=>x>=8&&x<88&&y>=8&&y<88);
  const strokes=hatchStrokes(mask,size,2);
  // Distance from points on the true top edge to the nearest ink, in px.
  // A snake can only cover half the edge stretches between hatch lines
  // (one connection per run, two stretches per run), so the worst point
  // is midway between two hatch lines; at 1.06px (0.26mm) it is well
  // inside a marker line width, and the wall-hugging connectors cover
  // the other half of the stretches.
  const points=[];
  for(const stroke of strokes) for(let i=1;i<stroke.length;i++) {
    const a=stroke[i-1],b=stroke[i],n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)*size*8));
    for(let j=0;j<=n;j++) points.push([(a.x+(b.x-a.x)*j/n)*size,(a.y+(b.y-a.y)*j/n)*size]);
  }
  let max=0,sum=0,n=0;
  for(let x=8;x<88;x++) {
    let d=Infinity;
    for(const [px,py] of points) d=Math.min(d,Math.hypot(px-(x+.5),py-8));
    max=Math.max(max,d);sum+=d;n++;
  }
  assert.ok(sum/n<0.5,`mean edge strip ${sum/n} px`);
  assert.ok(max<1.1,`worst edge strip ${max} px`);
  checkInside(strokes,mask);checkCoverage(strokes,mask);
});

test('separate islands use one stroke each and never connect across blank space',()=>{
  const mask=maskFor((x,y)=>(x>=8&&x<30&&y>=8&&y<30)||(x>=60&&x<88&&y>=60&&y<88));
  const strokes=hatchStrokes(mask,size,2);
  assert.equal(strokes.length,2);
  checkInside(strokes,mask);checkCoverage(strokes,mask);
});

test('hatch endpoints reach the edge, with the edge distance separate from the spacing',()=>{
  const mask=maskFor((x,y)=>x>=8&&x<88&&y>=8&&y<88);
  // Default edge gap 0: endpoints extend from their pixel centres toward
  // the edge, so some points sit closer to the edge than any pixel centre.
  const atEdge=hatchStrokes(mask,size,2,0);
  assert.ok(atEdge.flat().some(p=>p.y*size<8.5), 'endpoints should reach past the outermost pixel centres');
  assert.ok(atEdge.flat().every(p=>p.y*size>=8), 'default gap keeps endpoints inside the shape');
  // A 1px edge gap leaves endpoints at their pixel centres, as before.
  const inset=hatchStrokes(mask,size,2,1);
  assert.ok(inset.flat().every(p=>p.y*size>=8.5), 'a 1px edge gap should not extend endpoints');
  // A negative edge gap extends past the edge, into the separately drawn outline.
  const overlap=hatchStrokes(mask,size,2,-1);
  assert.ok(overlap.flat().some(p=>p.y*size<8), 'a negative edge gap should extend past the edge');
  checkInside(atEdge,mask);checkInside(inset,mask);
});

test('one-pixel-wide connected regions are retained',()=>{
  const mask=maskFor((x,y)=>x===40&&y>=8&&y<88);
  const strokes=hatchStrokes(mask,size,2);
  assert.equal(strokes.length,1);
  checkInside(strokes,mask);checkCoverage(strokes,mask);
});

test('tiny islands between scanlines are retained and empty masks stay empty',()=>{
  const mask=maskFor((x,y)=>x===10&&y===10);
  const strokes=hatchStrokes(mask,size,2);
  assert.equal(strokes.length,1);
  assert.equal(strokes[0][0].x,10.5/size);
  assert.equal(strokes[0][0].y,10.5/size);
  checkInside(strokes,mask);
  assert.deepEqual(hatchStrokes(new Uint8Array(size*size),size,2),[]);
});

const { svgFillStrokes } = require('../fill-path.js');
test('SVG traced diagonal ribbons become a single centerline without hatch oscillations',()=>{
  const mask=maskFor((x,y)=>x>=8&&x<88&&Math.abs(y-x)<=2);
  const strokes=svgFillStrokes(mask,size,2);
  assert.equal(strokes.length,1);
  assert.ok(strokes[0].length<10,`unexpected zigzag: ${strokes[0].length} points`);
  assert.ok(length(strokes)<120,`centerline doubled back: ${length(strokes)}`);
  for(const p of strokes[0]) assert.ok(Math.abs(p.x-p.y)*size<1);
});

test('SVG thin closed outlines preserve one loop with an empty interior',()=>{
  const mask=maskFor((x,y)=>{const r=Math.hypot(x-48,y-48);return r>=29&&r<=32;});
  const strokes=svgFillStrokes(mask,size,2);
  assert.equal(strokes.length,1);
  const first=strokes[0][0],last=strokes[0].at(-1);
  assert.deepEqual(first,last);
  assert.ok(length(strokes)>170&&length(strokes)<215);
  assert.ok(strokes[0].every(p=>Math.hypot(p.x*size-48,p.y*size-48)>28));
});

test('SVG solid regions still hatch when a separate thin outline shares the mask',()=>{
  const mask=maskFor((x,y)=>(x>=8&&x<38&&y>=8&&y<38)||(x>=65&&x<=68&&y>=10&&y<85));
  const strokes=svgFillStrokes(mask,size,2);
  assert.equal(strokes.length,2);
  assert.ok(strokes.some(p=>p.length<5));
  assert.ok(strokes.some(p=>p.length>20));
});
