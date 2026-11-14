/* Connected raster hatching shared by SVG import and the canvas fill tool. */
(() => {
  // edgeGap is the distance, in raster pixels along the hatch direction,
  // between a hatch endpoint and the shape edge. It is independent of
  // spacing, which sets the distance between hatch lines. 0 puts the
  // endpoint at the edge; a negative value extends past it, so the fill
  // overlaps the separately drawn outline.
  function hatchStrokes(inside, size, spacing, edgeGap = 0) {
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

    const strokes = [];
    for (const runs of groups.values()) {
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
      let current = runs[0].start;
      for (let remaining = runs.length; remaining > 0; remaining--) {
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
        let best = null;
        for (const candidate of candidates) {
          if (best && candidate.length >= best.link.length) break;
          const link = connector(current, candidate.start, best?.link.length);
          if (link && (!best || link.length < best.link.length)) best = { ...candidate, link };
        }
        // Every run in this group is 4-connected, so a connector must exist.
        if (!best) throw new Error("Could not route a connected fill region.");
        for (const index of best.link.path) append(index);
        current = best.reverse ? best.run.start : best.run.end;
        append(current); best.run.done = true;
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
    return strokes;
  }
  // Traced line art often encodes an ink line as a narrow filled ribbon.
  // Separate those components from solid areas before deciding how to plot them.
  function svgFillStrokes(mask, size, spacing, edgeGap = 0) {
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
    return [...centerlineStrokes(narrow,size),...hatchStrokes(solid,size,spacing,edgeGap)];
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
