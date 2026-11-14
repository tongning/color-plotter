/* Connected raster hatching shared by SVG import and the canvas fill tool. */
(() => {
  // Trace the boundary ring of each filled component with Moore-neighbour
  // tracing: one ordered ring of boundary pixel indices per outer edge and
  // per hole. Diagonal steps across concave corners go through the inside
  // pixel instead, so no segment leaves the mask. Rings are used to route
  // hatch connectors along the wall, Cura-style, instead of cutting across
  // the interior. Returns a Map from component label to its rings.
  function boundaryRings(inside, size, labels) {
    const total = size * size;
    const atLabel = (x, y, label) => x >= 0 && x < size && y >= 0 && y < size && labels[y * size + x] === label;
    const isBoundary = (x, y, label) => atLabel(x, y, label) && (!atLabel(x - 1, y, label) || !atLabel(x + 1, y, label) || !atLabel(x, y - 1, label) || !atLabel(x, y + 1, label));
    const dirs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
    const visited = new Uint8Array(total);
    const rings = new Map();
    for (let sy = 0; sy < size; sy++) for (let sx = 0; sx < size; sx++) {
      const label = labels[sy * size + sx];
      if (!label || !isBoundary(sx, sy, label) || visited[sy * size + sx]) continue;
      let cur = [sx, sy], backDir = 6;
      const loop = [cur[0] + cur[1] * size];
      visited[cur[1] * size + cur[0]] = 1;
      let guard = 0;
      while (guard++ < total * 2) {
        let found = -1;
        for (let k = 0; k < 8; k++) {
          const d = (backDir + 2 + k) % 8;
          const dx = dirs[d][0], dy = dirs[d][1];
          const nx = cur[0] + dx, ny = cur[1] + dy;
          if (isBoundary(nx, ny, label)) {
            // A diagonal step across a concave corner would cut outside
            // the region at the corner point. Step through the inside
            // orthogonal pixel instead, so the loop stays inside.
            if (dx && dy && (!atLabel(nx, cur[1], label) || !atLabel(cur[0], ny, label))) {
              if (atLabel(nx, cur[1], label)) { found = dx > 0 ? 2 : 6; break; }
              if (atLabel(cur[0], ny, label)) { found = dy > 0 ? 4 : 0; break; }
            }
            found = d; break;
          }
        }
        if (found < 0) break;
        backDir = (found + 4) % 8;
        cur = [cur[0] + dirs[found][0], cur[1] + dirs[found][1]];
        if (cur[0] === sx && cur[1] === sy) break;
        loop.push(cur[0] + cur[1] * size);
        if (isBoundary(cur[0], cur[1], label)) visited[cur[1] * size + cur[0]] = 1;
      }
      if (loop.length < 3) continue;
      if (!rings.has(label)) rings.set(label, []);
      rings.get(label).push(loop);
    }
    return rings;
  }

  // edgeGap is the distance, in raster pixels along the hatch direction,
  // between a hatch endpoint and the shape edge. It is independent of
  // spacing, which sets the distance between hatch lines. 0 puts the
  // endpoint at the edge; a negative value extends past it, so the fill
  // overlaps the separately drawn outline.
  // connectMax is the longest a connector may run along the boundary
  // between two hatch runs, in raster pixels. Longer than that, the pen
  // lifts instead of drawing a long perimeter lap. It scales with spacing:
  // neighbouring lines meet the same edge about spacing * sqrt(2) apart
  // along it, so 4 * spacing lets every normal neighbour connection
  // through and only lifts for genuinely distant runs. The ring is a
  // pixel staircase, so a connector may draw up to connectMax * sqrt(2)
  // along it on a 45-degree edge; that is the same short wall run, not
  // a longer threshold.
  function hatchStrokes(inside, size, spacing, edgeGap = 0, connectMax = 4 * spacing) {
    const total = size * size;
    const step = Math.max(1, Math.round(spacing * Math.SQRT2));
    // A run endpoint sits at its pixel centre; the edge along the diagonal
    // is half a diagonal away (0.5 * sqrt(2) px). Extend the endpoint to
    // the edge, less the requested gap. Cap the extension at 0.6px when the
    // gap is not negative, so the endpoint stays inside its own pixel and
    // no segment can sample an outside pixel at a concave corner.
    const edgeExtension = Math.max(0, 0.5 * Math.SQRT2 - edgeGap);
    const cappedExtension = edgeGap < 0 ? edgeExtension : Math.min(0.6, edgeExtension);
    const labels = new Int32Array(total);
    const queue = new Int32Array(total);
    let component = 0;
    const seeds = [];
    const neighbors = (index) => {
      const x = index % size, y = Math.floor(index / size);
      return [x > 0 ? index - 1 : -1, x + 1 < size ? index + 1 : -1, y > 0 ? index - size : -1, y + 1 < size ? index + size : -1];
    };
    // Label islands once. They require lifts; do not repeatedly search between them.
    for (let seed = 0; seed < total; seed++) {
      if (!inside[seed] || labels[seed]) continue;
      component++;
      seeds.push(seed);
      let head = 0, tail = 0;
      labels[seed] = component; queue[tail++] = seed;
      while (head < tail) {
        for (const next of neighbors(queue[head++])) {
          if (next < 0 || !inside[next] || labels[next]) continue;
          labels[next] = component; queue[tail++] = next;
        }
      }
    }

    const groups = new Map();
    function addRun(start, end) {
      if (start < 0) return;
      const label = labels[start];
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push({ start, end, done: false });
    }
    for (let offset = -(size - 1); offset < size; offset += step) {
      const yStart = Math.max(0, -offset);
      const yEnd = Math.min(size - 1, size - 1 - offset);
      let start = -1, previous = -1;
      for (let y = yStart; y <= yEnd; y++) {
        const x = y + offset, index = y * size + x;
        // A diagonal cannot cut across the corner of a hole or join separate islands.
        if (start >= 0 && (!inside[index] || !inside[index - 1] || !inside[index - size])) {
          addRun(start, previous); start = -1;
        }
        if (inside[index]) { if (start < 0) start = index; previous = index; }
      }
      addRun(start, previous);
    }

    // A tiny island may fall entirely between scanlines. Keep it as a dot.
    for (const seed of seeds) if (!groups.has(labels[seed])) addRun(seed, seed);

    const distance = (a, b) => Math.hypot(a % size - b % size, Math.floor(a / size) - Math.floor(b / size));
    // Sample every crossed grid boundary so direct connectors cannot cut holes.
    function straightPath(start, goal) {
      const x0 = start % size, y0 = Math.floor(start / size);
      const dx = goal % size - x0, dy = Math.floor(goal / size) - y0;
      const sx = Math.sign(dx), sy = Math.sign(dy);
      let x = x0, y = y0;
      let tx = dx ? .5 / Math.abs(dx) : Infinity;
      let ty = dy ? .5 / Math.abs(dy) : Infinity;
      while (y * size + x !== goal) {
        if (Math.abs(tx - ty) < 1e-10) {
          if (!inside[y * size + x + sx] || !inside[(y + sy) * size + x]) return null;
          x += sx; y += sy; tx += 1 / Math.abs(dx); ty += 1 / Math.abs(dy);
        } else if (tx < ty) { x += sx; tx += 1 / Math.abs(dx); }
        else { y += sy; ty += 1 / Math.abs(dy); }
        if (!inside[y * size + x]) return null;
      }
      return [start, goal];
    }

    const scores = new Float64Array(total);
    const previous = new Int32Array(total);
    const seen = new Uint32Array(total);
    const closed = new Uint32Array(total);
    let searchId = 0;
    function connector(start, goal, limit = Infinity) {
      if (start === goal) return { path: [start], length: 0 };
      if (labels[start] !== labels[goal]) return null;
      const direct = straightPath(start, goal);
      if (direct) return { path: direct, length: distance(start, goal) };
      // A* minimizes actual travel, without making long perimeter laps cheaper
      // than short interior links. Stop once a known better candidate wins.
      const id = ++searchId;
      const heap = [];
      function push(index, priority) {
        let i = heap.length; heap.push([index, priority]);
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heap[p][1] <= priority) break;
          heap[i] = heap[p]; i = p;
        }
        heap[i] = [index, priority];
      }
      function pop() {
        const first = heap[0], last = heap.pop();
        if (heap.length) {
          let i = 0;
          while (i * 2 + 1 < heap.length) {
            let child = i * 2 + 1;
            if (child + 1 < heap.length && heap[child + 1][1] < heap[child][1]) child++;
            if (heap[child][1] >= last[1]) break;
            heap[i] = heap[child]; i = child;
          }
          heap[i] = last;
        }
        return first;
      }
      seen[start] = id; scores[start] = 0; previous[start] = -1;
      push(start, distance(start, goal));
      while (heap.length) {
        const [current, priority] = pop();
        if (priority > limit) return null;
        if (closed[current] === id) continue;
        closed[current] = id;
        if (current === goal) {
          const path = [];
          for (let node = goal; node !== -1; node = previous[node]) path.push(node);
          return { path: path.reverse(), length: scores[goal] };
        }
        const x = current % size, y = Math.floor(current / size);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= size || y + dy < 0 || y + dy >= size) continue;
          const next = (y + dy) * size + x + dx;
          if (!inside[next] || closed[next] === id) continue;
          if (dx && dy && (!inside[y * size + x + dx] || !inside[(y + dy) * size + x])) continue;
          const score = scores[current] + (dx && dy ? Math.SQRT2 : 1);
          if (seen[next] !== id || score < scores[next]) {
            seen[next] = id; scores[next] = score; previous[next] = current;
            push(next, score + distance(next, goal));
          }
        }
      }
      return null;
    }

    // Cura-style connector: join two hatch runs by running along the shape
    // boundary between them, so the fill hugs the wall instead of cutting
    // across the interior. Returns null when the boundary path (including
    // the short jogs from the run endpoints onto the ring) is longer than
    // connectMax: the caller lifts the pen instead of drawing a long
    // perimeter lap. The A* connector survives only for those tiny jogs.
    const rings = boundaryRings(inside, size, labels);
    function boundaryLink(from, to, label) {
      if (from === to) return { path: [from], length: 0 };
      const labelRings = rings.get(label);
      if (!labelRings) return null;
      let best = null;
      for (const ring of labelRings) {
        const n = ring.length;
        // Prefix sums of step lengths, so an arc length is O(1).
        const prefix = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + distance(ring[i], ring[(i + 1) % n]);
        const total = prefix[n];
        const arcLen = (i, j) => {
          const forward = (prefix[j] - prefix[i] + total) % total;
          return Math.min(forward, total - forward);
        };
        let ai = -1, ad = Infinity, bi = -1, bd = Infinity;
        for (let i = 0; i < n; i++) {
          const d0 = distance(from, ring[i]), d1 = distance(to, ring[i]);
          if (d0 < ad) { ad = d0; ai = i; }
          if (d1 < bd) { bd = d1; bi = i; }
        }
        const arc = arcLen(ai, bi);
        const length = ad + arc + bd;
        // The ring is a pixel staircase, so the arc along it overstates
        // the distance along the wall by up to sqrt(2) on a 45-degree
        // edge. Allow that inflation; the chord check above is what
        // keeps genuinely distant runs (a lap around a U-shape) out.
        if (length <= connectMax * Math.SQRT2 && (!best || length < best.length)) best = { ring, prefix, total, ai, bi, length };
      }
      if (!best) return null;
      // Jogs from the endpoints onto the ring: straight if the pixels
      // allow, else a short A* (endpoints sit at the edge, so the jog
      // is a pixel or two).
      const jog = (a, b) => {
        const direct = straightPath(a, b);
        if (direct) return direct;
        const link = connector(a, b, 4);
        return link ? link.path : null;
      };
      const jogA = jog(from, best.ring[best.ai]);
      const jogB = jog(best.ring[best.bi], to);
      if (!jogA || !jogB) return null;
      // Walk the ring the short way around between the two nearest points.
      const forward = (best.prefix[best.bi] - best.prefix[best.ai] + best.total) % best.total;
      const dir = forward <= best.total - forward ? 1 : -1;
      const path = [...jogA];
      for (let k = best.ai; k !== best.bi; k = (k + dir + best.ring.length) % best.ring.length) path.push(best.ring[k]);
      path.push(best.ring[best.bi], ...jogB);
      // The jogs may wander a little off the straight line; measure the
      // path as drawn and lift if it ran long after all. Same staircase
      // allowance as above.
      let actual = 0;
      for (let i = 1; i < path.length; i++) actual += distance(path[i - 1], path[i]);
      if (actual > connectMax * Math.SQRT2) return null;
      return { path, length: actual };
    }

    const strokes = [];
    for (const [label, runs] of groups) {
      let remaining = runs.length;
      let current = runs[0].start;
      while (remaining > 0) {
        // A new stroke starts at the unfinished endpoint nearest the pen;
        // the pen is up, so no link is drawn to get there.
        let startRun = null, startReverse = false, startDist = Infinity;
        for (const run of runs) if (!run.done) for (const reverse of [false, true]) {
          const start = reverse ? run.end : run.start;
          const d = distance(current, start);
          if (d < startDist) { startDist = d; startRun = run; startReverse = reverse; }
        }
        current = startReverse ? startRun.end : startRun.start;
        const indices = [];
        const edgePoints = new Map();
        function append(index) {
          if (indices.at(-1) === index) return;
          if (indices.length > 1) {
            const a = indices.at(-2), b = indices.at(-1);
            const ax = b % size - a % size, ay = Math.floor(b / size) - Math.floor(a / size);
            const bx = index % size - b % size, by = Math.floor(index / size) - Math.floor(b / size);
            // Exact collinear compression keeps grid corners and holes intact.
            if (ax * by === ay * bx && ax * bx + ay * by > 0) indices.pop();
          }
          indices.push(index);
        }
        for (;;) {
          // Consider the closest unfinished endpoints, rather than forcing all
          // segments on a split scanline (and a lap around its hole) in sequence.
          const candidates = [];
          for (const run of runs) if (!run.done) for (const reverse of [false, true]) {
            const start = reverse ? run.end : run.start;
            const length = distance(current, start);
            const candidate = { run, reverse, start, length };
            let i = candidates.findIndex(other => other.length > length);
            if (i < 0) i = candidates.length;
            if (i < 8) { candidates.splice(i, 0, candidate); if (candidates.length > 8) candidates.pop(); }
          }
          // One-pixel edge fragments strand if the pen leaves their
          // neighbourhood, so always consider nearby dots even when
          // nearer run endpoints crowd them out of the top 8.
          for (const run of runs) {
            if (!run.done && run.start === run.end
              && distance(current, run.start) <= connectMax
              && !candidates.some(c => c.run === run)) {
              const candidate = { run, reverse: false, start: run.start, length: distance(current, run.start) };
              let i = candidates.findIndex(other => other.length > candidate.length);
              if (i < 0) i = candidates.length;
              candidates.splice(i, 0, candidate);
            }
          }
          let best = null, bestDot = null;
          for (const candidate of candidates) {
            if (best && candidate.length >= best.link.length) break;
            // Top-infill rule (Cura Lines / Zig Zag): a connector runs
            // along the wall or not at all. No hop through the fill
            // itself, however short: that is the line that cuts across
            // the hatching. Longer than connectMax, the pen lifts.
            const link = boundaryLink(current, candidate.start, label);
            if (!link) continue;
            const entry = { ...candidate, link };
            if (!best || link.length < best.link.length) best = entry;
            // A one-pixel fragment on the edge is stranded if the pen
            // leaves its neighbourhood, so draw it while it is here.
            if (candidate.run.start === candidate.run.end
              && (!bestDot || link.length < bestDot.link.length)) bestDot = entry;
          }
          best = bestDot || best;
          // No short link to any unfinished run: lift the pen and start
          // a new stroke instead of a long perimeter lap.
          if (!best) break;
          for (const index of best.link.path) append(index);
          current = best.reverse ? best.run.start : best.run.end;
          append(current); best.run.done = true; remaining--;
          // Remember run endpoints so they can be extended to the edge.
          // A one-pixel run is a dot; leave it centred.
          if (best.run.start !== best.run.end) {
            edgePoints.set(best.run.start, -1);
            edgePoints.set(best.run.end, 1);
          }
        }
        if (indices.length === 1) indices.push(indices[0]);
        const stroke = indices.map(index => {
          const point = { x: (index % size + .5) / size, y: (Math.floor(index / size) + .5) / size };
          const direction = edgePoints.get(index);
          if (direction) {
            const offset = direction * cappedExtension / Math.SQRT2 / size;
            point.x += offset; point.y += offset;
          }
          return point;
        });
        // Connected fill paths must not be rounded across holes by freehand smoothing.
        stroke.shape = true;
        strokes.push(stroke);
      }
    }
    return strokes;
  }
  // Traced line art often encodes an ink line as a narrow filled ribbon.
  // Separate those components from solid areas before deciding how to plot them.
  function svgFillStrokes(mask, size, spacing, edgeGap = 0, connectMax = 4 * spacing) {
    const total = size * size;
    const depth = new Float32Array(total);
    const root2 = Math.SQRT2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!mask[i]) continue;
      depth[i] = Math.min(x ? depth[i-1]+1 : 1, y ? depth[i-size]+1 : 1,
        x && y ? depth[i-size-1]+root2 : 1, x+1<size && y ? depth[i-size+1]+root2 : 1);
    }
    for (let y=size-1;y>=0;y--) for(let x=size-1;x>=0;x--) {
      const i=y*size+x;
      if(mask[i]) depth[i]=Math.min(depth[i],x+1<size?depth[i+1]+1:1,y+1<size?depth[i+size]+1:1,
        x+1<size&&y+1<size?depth[i+size+1]+root2:1,x&&y+1<size?depth[i+size-1]+root2:1);
    }
    const visited=new Uint8Array(total), narrow=new Uint8Array(total), solid=new Uint8Array(total);
    const queue=new Int32Array(total);
    for(let seed=0;seed<total;seed++) {
      if(!mask[seed]||visited[seed]) continue;
      let head=0,tail=1,core=0;
      queue[0]=seed;visited[seed]=1;
      while(head<tail) {
        const i=queue[head++],x=i%size,y=Math.floor(i/size);
        if(depth[i]>Math.max(2,spacing*1.5)) core++;
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
          if((!dx&&!dy)||x+dx<0||x+dx>=size||y+dy<0||y+dy>=size) continue;
          const next=(y+dy)*size+x+dx;
          if(mask[next]&&!visited[next]) {visited[next]=1;queue[tail++]=next;}
        }
      }
      // A few thicker junctions may belong to an otherwise narrow ink line.
      const target=core/tail<=.05?narrow:solid;
      for(let j=0;j<tail;j++) target[queue[j]]=1;
    }
    return [...centerlineStrokes(narrow,size),...hatchStrokes(solid,size,spacing,edgeGap,connectMax)];
  }

  function centerlineStrokes(mask, size) {
    // Topology-preserving thinning keeps loops and branches while reducing an
    // ink ribbon to one pixel across. Pad so shapes touching the bed edge work.
    const width=size+2, pixels=new Uint8Array(width*width);
    for(let y=0;y<size;y++) for(let x=0;x<size;x++) pixels[(y+1)*width+x+1]=mask[y*size+x];
    let changed=true;
    while(changed) {
      changed=false;
      for(let pass=0;pass<2;pass++) {
        const remove=[];
        for(let y=1;y<=size;y++) for(let x=1;x<=size;x++) {
          const i=y*width+x;
          if(!pixels[i]) continue;
          const n=[pixels[i-width],pixels[i-width+1],pixels[i+1],pixels[i+width+1],pixels[i+width],pixels[i+width-1],pixels[i-1],pixels[i-width-1]];
          const count=n.reduce((a,b)=>a+b,0);
          if(count<2||count>6) continue;
          let transitions=0;
          for(let j=0;j<8;j++) if(!n[j]&&n[(j+1)%8]) transitions++;
          if(transitions!==1) continue;
          if(pass===0 ? n[0]*n[2]*n[4]||n[2]*n[4]*n[6] : n[0]*n[2]*n[6]||n[0]*n[4]*n[6]) continue;
          remove.push(i);
        }
        if(remove.length) changed=true;
        for(const i of remove) pixels[i]=0;
      }
    }
    const nodes=new Map();
    for(let y=1;y<=size;y++) for(let x=1;x<=size;x++) {
      const i=y*width+x;
      if(!pixels[i]) continue;
      const adjacent=[];
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
        if((!dx&&!dy)||!pixels[i+dy*width+dx]) continue;
        // Do not add a diagonal shortcut across a skeleton corner: it creates
        // tiny triangles and fake branches that would retrace the same line.
        if(dx&&dy&&(pixels[i+dx]||pixels[i+dy*width])) continue;
        adjacent.push(i+dy*width+dx);
      }
      nodes.set(i,adjacent);
    }
    const used=new Set(), paths=[];
    const edge=(a,b)=>Math.min(a,b)*pixels.length+Math.max(a,b);
    function trace(start,next) {
      const path=[start];let current=start;
      while(true) {
        used.add(edge(current,next));path.push(next);
        const adjacent=nodes.get(next);
        if(adjacent.length!==2||next===start) break;
        const after=adjacent[0]===current?adjacent[1]:adjacent[0];
        current=next;next=after;
        if(used.has(edge(current,next))) break;
      }
      paths.push(path);
    }
    for(const [i,adjacent] of nodes) if(adjacent.length!==2) {
      if(!adjacent.length) paths.push([i,i]);
      for(const next of adjacent) if(!used.has(edge(i,next))) trace(i,next);
    }
    for(const [i,adjacent] of nodes) for(const next of adjacent) if(!used.has(edge(i,next))) trace(i,next);
    return paths.map(path=>{
      const points=path.map(i=>({x:(i%width-.5)/size,y:(Math.floor(i/width)-.5)/size}));
      // Remove pixel stair steps without freehand rounding or hatch zigzags.
      const keep=new Uint8Array(points.length);keep[0]=keep[points.length-1]=1;
      const stack=[[0,points.length-1]];
      while(stack.length) {
        const [a,b]=stack.pop(),p=points[a],q=points[b];
        const dx=q.x-p.x,dy=q.y-p.y,denom=dx*dx+dy*dy;
        let best=-1,error=(.6/size)**2;
        for(let i=a+1;i<b;i++) {
          const r=points[i],t=denom?Math.max(0,Math.min(1,((r.x-p.x)*dx+(r.y-p.y)*dy)/denom)):0;
          const d=(r.x-p.x-t*dx)**2+(r.y-p.y-t*dy)**2;
          if(d>error) {error=d;best=i;}
        }
        if(best>=0) {keep[best]=1;stack.push([a,best],[best,b]);}
      }
      const stroke=points.filter((_,i)=>keep[i]);stroke.shape=true;
      return stroke;
    });
  }

  const api = { hatchStrokes, svgFillStrokes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.PlotterFill = api;
})();
