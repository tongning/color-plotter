// Photo to sketch, fully in the browser.
//
// Converts a photo into plottable pen paths (118x140 bed, 8 BIC pens)
// with no server call: the whole engine runs here, on typed arrays.
// Algorithm source: the Python reference (photo_to_plot_v3.py) and the
// photorealistic plotting research -- 0.42mm datasheet line width
// (1.6mm is the ball, not the line), linear-light tone, ETF + FDoG
// structure, Plotcaster-style flow, per-pen ordering, LBG/TSP mode.
//
// Output is the same stroke-only SVG the server version produced
// (viewBox 0 0 480 480, stroke-width 1.4), so it loads through the
// normal SVG import path unchanged.
(function () {
  "use strict";

  var SIZE = 480;
  var WORK_W = 300;
  var LINE_WIDTH_MM = 0.42;
  var SHADOW_SEP_MM = 1.2 * LINE_WIDTH_MM; // 0.50 mm
  var LIGHT_SEP_MM = 7.0 * LINE_WIDTH_MM; // 2.94 mm
  var PALETTE = ["#2c2d30", "#e42e2a", "#c65a93", "#08b1dc",
                 "#7bae44", "#0497bd", "#2d4e9e", "#533c94"];
  var BLACK = PALETTE[0];
  var SHADING_MODES = ["off", "gradient", "cross", "hybrid", "plotcaster", "squiggle", "tsp"];

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function nowMs() { return (typeof performance !== "undefined" ? performance.now() : Date.now()); }

  // Seeded PRNG (mulberry32): deterministic sampling, like the
  // reference's default_rng(7).
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Binary max-heap keyed by tone, for darkest-first flow seeds.
  function ToneHeap() { this.items = []; }
  ToneHeap.prototype.size = function () { return this.items.length; };
  ToneHeap.prototype.push = function (tone, x, y) {
    var items = this.items, it = { t: tone, x: x, y: y }, i = items.length;
    items.push(it);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (items[p].t >= items[i].t) break;
      items[i] = items[p]; items[p] = it; i = p;
    }
  };
  ToneHeap.prototype.pop = function () {
    var items = this.items, top = items[0], last = items.pop();
    if (items.length === 0) return top;
    items[0] = last;
    var i = 0;
    for (;;) {
      var l = 2 * i + 1, r = l + 1, m = i;
      if (l < items.length && items[l].t > items[m].t) m = l;
      if (r < items.length && items[r].t > items[m].t) m = r;
      if (m === i) break;
      var tmp = items[i]; items[i] = items[m]; items[m] = tmp; i = m;
    }
    return top;
  };

  // Separable Gaussian blur on a Float32Array grid (clamped edges).
  function gaussianBlur(src, w, h, sigma) {
    if (sigma <= 0) return Float32Array.from(src);
    var radius = Math.max(1, Math.ceil(sigma * 3));
    var kernel = new Float64Array(2 * radius + 1), sum = 0, i;
    for (i = -radius; i <= radius; i++) {
      var v = Math.exp(-(i * i) / (2 * sigma * sigma));
      kernel[i + radius] = v; sum += v;
    }
    for (i = 0; i < kernel.length; i++) kernel[i] /= sum;
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    var x, y, k, xx, yy, acc;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        acc = 0;
        for (k = -radius; k <= radius; k++) {
          xx = clamp(x + k, 0, w - 1);
          acc += kernel[k + radius] * src[y * w + xx];
        }
        tmp[y * w + x] = acc;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        acc = 0;
        for (k = -radius; k <= radius; k++) {
          yy = clamp(y + k, 0, h - 1);
          acc += kernel[k + radius] * tmp[yy * w + x];
        }
        out[y * w + x] = acc;
      }
    }
    return out;
  }

  // 3x3 Sobel gradients (clamped edges).
  function sobel(src, w, h) {
    var gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    var x, y, x0, x1, y0, y1;
    function at(px, py) { return src[clamp(py, 0, h - 1) * w + clamp(px, 0, w - 1)]; }
    for (y = 0; y < h; y++) {
      y0 = y - 1; y1 = y + 1;
      for (x = 0; x < w; x++) {
        x0 = x - 1; x1 = x + 1;
        gx[y * w + x] = (at(x1, y0) + 2 * at(x1, y) + at(x1, y1))
                      - (at(x0, y0) + 2 * at(x0, y) + at(x0, y1));
        gy[y * w + x] = (at(x0, y1) + 2 * at(x, y1) + at(x1, y1))
                      - (at(x0, y0) + 2 * at(x, y0) + at(x1, y0));
      }
    }
    return { gx: gx, gy: gy };
  }

  // Bilinear sample with clamped coordinates (map_coordinates, order 1).
  function bilinear(field, w, h, x, y) {
    var x0 = clamp(Math.floor(x), 0, w - 1), y0 = clamp(Math.floor(y), 0, h - 1);
    var x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    var fx = clamp(x - x0, 0, 1), fy = clamp(y - y0, 0, 1);
    var a = field[y0 * w + x0], b = field[y0 * w + x1];
    var c = field[y1 * w + x0], d = field[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  // Separable Lanczos-3 resample of interleaved RGB(A) bytes into
  // float RGB planes, sampling a source rectangle (sx0, sy0, sx1, sy1)
  // in source pixels. Matches the reference's PIL LANCZOS resize: a
  // plain bilinear downscale softens edges enough to push pale pixels
  // over the paper thresholds (lum 245 / sat 25) and halves the tone
  // ink on real photos, so the resize filter has to be Lanczos here.
  function lanczosWeight(t) {
    if (t === 0) return 1;
    var at = Math.abs(t);
    if (at >= 3) return 0;
    var pix = Math.PI * t;
    return (Math.sin(pix) / pix) * (Math.sin(pix / 3) / (pix / 3));
  }
  function resizeRgb(src, sw, sh, sx0, sy0, sx1, sy1, dw, dh) {
    var scaleX = (sx1 - sx0) / dw, scaleY = (sy1 - sy0) / dh;
    var kx = Math.max(1, scaleX), ky = Math.max(1, scaleY);
    var rx = 3 * kx, ry = 3 * ky;
    var r = new Float32Array(dw * dh), g = new Float32Array(dw * dh), b = new Float32Array(dw * dh);
    // Horizontal pass into a (dw x sh) intermediate. Every source row
    // is written: the vertical pass's kernel reaches a few rows past
    // the crop rect, and unwritten rows would read as black.
    var tmpR = new Float32Array(dw * sh), tmpG = new Float32Array(dw * sh), tmpB = new Float32Array(dw * sh);
    var x, y, sx, sy;
    for (y = 0; y < sh; y++) {
      for (x = 0; x < dw; x++) {
        var cx = sx0 + (x + 0.5) * scaleX - 0.5;
        var xStart = Math.max(0, Math.ceil(cx - rx)), xEnd = Math.min(sw - 1, Math.floor(cx + rx));
        var sum = 0, sr = 0, sg = 0, sb = 0;
        for (sx = xStart; sx <= xEnd; sx++) {
          var wgt = lanczosWeight((sx - cx) / kx);
          if (wgt === 0) continue;
          var p = (y * sw + sx) * 4;
          sr += wgt * src[p]; sg += wgt * src[p + 1]; sb += wgt * src[p + 2];
          sum += wgt;
        }
        var o = y * dw + x;
        if (sum !== 0) { tmpR[o] = sr / sum; tmpG[o] = sg / sum; tmpB[o] = sb / sum; }
      }
    }
    // Vertical pass into the working grid.
    for (y = 0; y < dh; y++) {
      var cy = sy0 + (y + 0.5) * scaleY - 0.5;
      var yStart = Math.max(0, Math.ceil(cy - ry)), yEnd = Math.min(sh - 1, Math.floor(cy + ry));
      for (x = 0; x < dw; x++) {
        var vsum = 0, vr = 0, vg = 0, vb = 0;
        for (sy = yStart; sy <= yEnd; sy++) {
          var vw = lanczosWeight((sy - cy) / ky);
          if (vw === 0) continue;
          var q = sy * dw + x;
          vr += vw * tmpR[q]; vg += vw * tmpG[q]; vb += vw * tmpB[q];
          vsum += vw;
        }
        var oi = y * dw + x;
        if (vsum !== 0) { r[oi] = vr / vsum; g[oi] = vg / vsum; b[oi] = vb / vsum; }
      }
    }
    return { r: r, g: g, b: b };
  }

  // RDP simplify (iterative, same tolerance rule as the reference).
  function rdp(pts, eps) {
    if (pts.length <= 2) return pts.slice();
    var n = pts.length, keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var ab = stack.pop(), a = ab[0], b = ab[1];
      if (b - a < 2) continue;
      var ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
      var dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      var dmax = -1, imax = -1, i;
      for (i = a + 1; i < b; i++) {
        var d;
        if (len < 1e-9) d = Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
        else d = Math.abs((dx * (pts[i][1] - ay) - dy * (pts[i][0] - ax)) / len);
        if (d > dmax) { dmax = d; imax = i; }
      }
      if (dmax > eps) {
        keep[imax] = 1;
        stack.push([a, imax]); stack.push([imax, b]);
      }
    }
    var out = [];
    for (var j = 0; j < n; j++) if (keep[j]) out.push(pts[j]);
    return out;
  }

  // One Chaikin pass, split at sharp corners (> cornersplit radians).
  function chaikin(pts, cornersplit) {
    if (cornersplit === undefined) cornersplit = 1.0;
    if (pts.length < 3) return pts.slice();
    var runs = [[pts[0]]], i;
    for (i = 0; i + 2 <= pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1], c = pts[i + 2];
      var v1x = b[0] - a[0], v1y = b[1] - a[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
      var l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y), ang = 0;
      if (l1 >= 1e-9 && l2 >= 1e-9) {
        ang = Math.acos(clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1));
      }
      runs[runs.length - 1].push(b);
      if (ang > cornersplit) runs.push([b]);
    }
    runs[runs.length - 1].push(pts[pts.length - 1]);
    var out = [];
    for (var ri = 0; ri < runs.length; ri++) {
      var run = runs[ri];
      if (run.length < 3) {
        for (var j = 0; j < run.length; j++) {
          if (!out.length || run[j] !== out[out.length - 1]) out.push(run[j]);
        }
        continue;
      }
      var sm = [run[0]];
      for (var k = 0; k + 1 < run.length; k++) {
        var p = run[k], q = run[k + 1];
        sm.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
        sm.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
      }
      sm.push(run[run.length - 1]);
      for (var m = 0; m < sm.length; m++) {
        if (!out.length || sm[m] !== out[out.length - 1]) out.push(sm[m]);
      }
    }
    return out;
  }

  // Plain Chaikin (no corner split), as the TSP tour uses it.
  function chaikinPlain(pts, rounds) {
    var cur = pts.map(function (p) { return [p[0], p[1]]; });
    for (var r = 0; r < (rounds || 1); r++) {
      if (cur.length < 2) break;
      var out = [cur[0]];
      for (var i = 0; i + 1 < cur.length; i++) {
        var a = cur[i], b = cur[i + 1];
        out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
        out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
      }
      out.push(cur[cur.length - 1]);
      cur = out;
    }
    return cur;
  }

  function polylineLength(pts) {
    var tot = 0;
    for (var i = 1; i < pts.length; i++) tot += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return tot;
  }

  // Greedy nearest-neighbour tour (either end) + bounded 2-opt on
  // blocks of <= 8 lines, per the vpype linesort recipe.
  function orderPolylines(lines) {
    var n = lines.length;
    if (n <= 1) return lines.slice();
    var starts = lines.map(function (s) { return s[0]; });
    var ends = lines.map(function (s) { return s[s.length - 1]; });
    var remaining = new Set();
    for (var i = 0; i < n; i++) remaining.add(i);
    var order = [], flips = {}, cx = 0, cy = 0;
    while (remaining.size) {
      var bestD = Infinity, bestI = -1, bestFlip = false;
      remaining.forEach(function (j) {
        var ds = Math.hypot(starts[j][0] - cx, starts[j][1] - cy);
        var de = Math.hypot(ends[j][0] - cx, ends[j][1] - cy);
        if (ds <= de) {
          if (ds < bestD) { bestD = ds; bestI = j; bestFlip = false; }
        } else if (de < bestD) { bestD = de; bestI = j; bestFlip = true; }
      });
      var bi = bestI;
      remaining.delete(bi);
      order.push(bi);
      flips[bi] = bestFlip;
      var ex = bestFlip ? starts[bi][0] : ends[bi][0];
      var ey = bestFlip ? starts[bi][1] : ends[bi][1];
      cx = ex; cy = ey;
    }
    function segStart(j) { return flips[j] ? ends[j] : starts[j]; }
    function segEnd(j) { return flips[j] ? starts[j] : ends[j]; }
    function blockCost(seq, fl, a, b) {
      var c = 0, px = 0, py = 0, k;
      if (a > 0) { var pe = segEnd(seq[a - 1]); px = pe[0]; py = pe[1]; }
      for (k = a; k <= b; k++) {
        var j = seq[k];
        var s = fl[j] ? ends[j] : starts[j];
        c += Math.hypot(s[0] - px, s[1] - py);
        var e = fl[j] ? starts[j] : ends[j];
        px = e[0]; py = e[1];
      }
      if (b + 1 < seq.length) {
        var ns = segStart(seq[b + 1]);
        c += Math.hypot(ns[0] - px, ns[1] - py);
      }
      return c;
    }
    for (var pass = 0; pass < 3; pass++) {
      var improved = false;
      for (var a = 0; a < n; a++) {
        for (var b = a + 1; b < Math.min(n, a + 9); b++) {
          var before = blockCost(order, flips, a, b);
          var rev = order.slice(a, b + 1).reverse();
          var trialFl = Object.assign({}, flips);
          rev.forEach(function (j) { trialFl[j] = !flips[j]; });
          var trial = order.slice(0, a).concat(rev, order.slice(b + 1));
          var after = blockCost(trial, trialFl, a, b);
          if (after < before - 1e-9) {
            order = trial; flips = trialFl; improved = true;
          }
        }
      }
      if (!improved) break;
    }
    return order.map(function (j) {
      return flips[j] ? lines[j].slice().reverse() : lines[j];
    });
  }

  // Small static KD-tree (median split) with nearest / k-nearest queries.
  // Used for the LBG stipple assignment and the TSP nearest tour.
  function buildKdTree(pts) {
    var idx = pts.map(function (_, i) { return i; });
    function build(ids, depth) {
      if (!ids.length) return null;
      var axis = depth % 2;
      ids.sort(function (a, b) { return pts[a][axis] - pts[b][axis]; });
      var mid = ids.length >> 1;
      return {
        point: pts[ids[mid]], index: ids[mid], axis: axis,
        left: build(ids.slice(0, mid), depth + 1),
        right: build(ids.slice(mid + 1), depth + 1),
      };
    }
    return { root: build(idx, 0), pts: pts };
  }
  function kdNearest(tree, qx, qy) {
    var best = { d2: Infinity, index: -1 };
    function visit(node) {
      if (!node) return;
      var dx = qx - node.point[0], dy = qy - node.point[1];
      var d2 = dx * dx + dy * dy;
      if (d2 < best.d2) { best.d2 = d2; best.index = node.index; }
      var axis = node.axis, diff = (axis === 0 ? qx : qy) - node.point[axis];
      var near = diff <= 0 ? node.left : node.right;
      var far = diff <= 0 ? node.right : node.left;
      visit(near);
      if (diff * diff < best.d2) visit(far);
    }
    visit(tree.root);
    return best.index;
  }
  function kdKNearest(tree, qx, qy, k) {
    // Best list kept sorted ascending by d2 (k <= 16, insertion is fine).
    var best = [];
    function consider(d2, index) {
      var i = 0;
      while (i < best.length && best[i].d2 <= d2) i++;
      if (i < k) {
        best.splice(i, 0, { d2: d2, index: index });
        if (best.length > k) best.pop();
      }
    }
    function visit(node) {
      if (!node) return;
      var dx = qx - node.point[0], dy = qy - node.point[1];
      consider(dx * dx + dy * dy, node.index);
      var axis = node.axis, diff = (axis === 0 ? qx : qy) - node.point[axis];
      var near = diff <= 0 ? node.left : node.right;
      var far = diff <= 0 ? node.right : node.left;
      visit(near);
      var worst = best.length < k ? Infinity : best[best.length - 1].d2;
      if (diff * diff < worst) visit(far);
    }
    visit(tree.root);
    return best.map(function (b) { return b.index; });
  }

  // ---------- colour: OKLab nearest pen (same metric as color-svg.js) ----------
  function srgbToLin(c) {
    c = c / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function rgbToOklab(r, g, b) {
    var lr = srgbToLin(r), lg = srgbToLin(g), lb = srgbToLin(b);
    var l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    var m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    var s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }
  var PAL_OKLAB = PALETTE.map(function (hex) {
    return rgbToOklab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
  });
  function quantiseToPens(rgb, w, h) {
    var out = new Uint8Array(w * h), i, t;
    for (i = 0; i < w * h; i++) {
      var lab = rgbToOklab(rgb.r[i], rgb.g[i], rgb.b[i]);
      var best = Infinity, bi = 0;
      for (t = 0; t < 8; t++) {
        var p = PAL_OKLAB[t];
        var d = (lab[0] - p[0]) * (lab[0] - p[0]) + (lab[1] - p[1]) * (lab[1] - p[1]) + (lab[2] - p[2]) * (lab[2] - p[2]);
        if (d < best) { best = d; bi = t; }
      }
      out[i] = bi;
    }
    return out;
  }
  // Majority-vote pen per cellPx x cellPx block, over valid pixels only.
  function cellQuantise(labIdx, w, h, cellPx, valid) {
    var out = new Uint8Array(w * h);
    for (var cy = 0; cy < h; cy += cellPx) {
      for (var cx = 0; cx < w; cx += cellPx) {
        var counts = new Array(8).fill(0);
        for (var y = cy; y < Math.min(h, cy + cellPx); y++) {
          for (var x = cx; x < Math.min(w, cx + cellPx); x++) {
            var i = y * w + x;
            if (!valid || valid[i]) counts[labIdx[i]]++;
          }
        }
        var best = 0, bv = -1;
        for (var t = 0; t < 8; t++) if (counts[t] > bv) { bv = counts[t]; best = t; }
        for (var y2 = cy; y2 < Math.min(h, cy + cellPx); y2++) {
          for (var x2 = cx; x2 < Math.min(w, cx + cellPx); x2++) out[y2 * w + x2] = best;
        }
      }
    }
    return out;
  }

  // ---------- SVG output helpers (same format as the server version) ----------
  function toSvgXy(x, y, nw, nh) {
    var s = SIZE / Math.max(nw, nh);
    return [(SIZE - nw * s) / 2 + x * s, (SIZE - nh * s) / 2 + y * s];
  }
  function pathD(pts) {
    var d = "M " + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    for (var i = 1; i < pts.length; i++) d += " L " + pts[i][0].toFixed(1) + " " + pts[i][1].toFixed(1);
    return d;
  }
  function svgPath(pts, colour) {
    return '<path d="' + pathD(pts) + '" stroke="' + colour + '" stroke-width="1.4" fill="none"/>';
  }
  // ViewBox length -> mm on the 118mm scale (the reference's path_len_mm).
  function pathLenMm(pts) {
    return polylineLength(pts) * 118.0 / SIZE;
  }

  // ---------- image prep: crop, resize, tone, paper ----------
  // Trim a near-white printed border: scan in while >95% of the
  // row/col is >245 grey, cap at 10% per side.
  function cropWhiteBorder(lum, w, h) {
    function rowFrac(y) {
      var n = 0;
      for (var x = 0; x < w; x++) if (lum[y * w + x] > 245) n++;
      return n / w;
    }
    function colFrac(x) {
      var n = 0;
      for (var y = 0; y < h; y++) if (lum[y * w + x] > 245) n++;
      return n / h;
    }
    var t = 0, b = 0, l = 0, r = 0;
    while (t < h / 10 && rowFrac(t) > 0.95) t++;
    while (b < h / 10 && rowFrac(h - 1 - b) > 0.95) b++;
    while (l < w / 10 && colFrac(l) > 0.95) l++;
    while (r < w / 10 && colFrac(w - 1 - r) > 0.95) r++;
    return { x0: l, y0: t, x1: w - r, y1: h - b };
  }

  // ---------- Edge Tangent Flow + flow-based DoG edges ----------
  function etfField(gray, w, h, radius, sigmaS, iterations) {
    var g = sobel(gray, w, h);
    var tx = new Float32Array(w * h), ty = new Float32Array(w * h), mw = new Float32Array(w * h);
    var sum = 0, i;
    for (i = 0; i < w * h; i++) sum += Math.hypot(g.gx[i], g.gy[i]);
    var mean = sum / (w * h);
    for (i = 0; i < w * h; i++) {
      var mag = Math.hypot(g.gx[i], g.gy[i]);
      if (mag > 1e-9) { tx[i] = -g.gy[i] / mag; ty[i] = g.gx[i] / mag; }
      else { tx[i] = 1; ty[i] = 0; }
      mw[i] = 0.5 * (1 + Math.tanh(mag - mean));
    }
    var offs = [];
    for (var dy = -radius; dy <= radius; dy++) {
      for (var dx = -radius; dx <= radius; dx++) {
        offs.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS))]);
      }
    }
    for (var it = 0; it < iterations; it++) {
      var nx = new Float32Array(w * h), ny = new Float32Array(w * h);
      for (var o = 0; o < offs.length; o++) {
        var dx = offs[o][0], dy = offs[o][1], wt0 = offs[o][2];
        for (var y = 0; y < h; y++) {
          var ys = clamp(y + dy, 0, h - 1);
          for (var x = 0; x < w; x++) {
            var xs = clamp(x + dx, 0, w - 1);
            var si = ys * w + xs, ci = y * w + x;
            var dot = tx[ci] * tx[si] + ty[ci] * ty[si];
            var sgn = dot < 0 ? -1 : 1;
            var wt = wt0 * mw[si] * Math.abs(dot);
            nx[ci] += wt * tx[si] * sgn;
            ny[ci] += wt * ty[si] * sgn;
          }
        }
      }
      for (i = 0; i < w * h; i++) {
        var n = Math.hypot(nx[i], ny[i]);
        if (n > 1e-9) { tx[i] = nx[i] / n; ty[i] = ny[i] / n; }
      }
    }
    return { tx: tx, ty: ty };
  }

  function fdogEdges(gray, tx, ty, w, h, sigmaC, sigmaS, tau, flowSteps, minResponse) {
    var resp = new Float32Array(w * h), x, y, t;
    var gc = [], gs = [];
    for (t = -5; t <= 5; t++) {
      gc.push(Math.exp(-t * t / (2 * sigmaC * sigmaC)) / (sigmaC * Math.sqrt(2 * Math.PI)));
      gs.push(Math.exp(-t * t / (2 * sigmaS * sigmaS)) / (sigmaS * Math.sqrt(2 * Math.PI)));
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var i = y * w + x;
        var gxDir = -ty[i], gyDir = tx[i];
        var acc = 0;
        for (var k = 0; k < gc.length; k++) {
          var tt = k - 5;
          acc += (gc[k] - tau * gs[k]) * bilinear(gray, w, h, x + tt * gxDir, y + tt * gyDir);
        }
        resp[i] = acc;
      }
    }
    var accArr = new Float32Array(w * h);
    for (var s = -flowSteps; s <= flowSteps; s++) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var j = y * w + x;
          accArr[j] += bilinear(resp, w, h, x + s * tx[j], y + s * ty[j]);
        }
      }
    }
    var out = new Uint8Array(w * h);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var k2 = y * w + x;
        var v = accArr[k2];
        if (v <= minResponse) continue;
        var gxD = -ty[k2], gyD = tx[k2];
        var plus = bilinear(accArr, w, h, x + gxD, y + gyD);
        var minus = bilinear(accArr, w, h, x - gxD, y - gyD);
        if (v > plus && v > minus) out[k2] = 1;
      }
    }
    return out;
  }

  // Canny: Sobel, non-maximum suppression, hysteresis. Used as the
  // structure fallback (few FDoG edges) and for the faint long-lines pass.
  function cannyEdges(gray, w, h, low, high) {
    var g = sobel(gray, w, h);
    var mag = new Float32Array(w * h), dir = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) {
      mag[i] = Math.hypot(g.gx[i], g.gy[i]);
      dir[i] = Math.atan2(g.gy[i], g.gx[i]);
    }
    var strong = new Uint8Array(w * h), weak = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var j = y * w + x, m = mag[j];
        if (m < low) continue;
        var a = dir[j] * 180 / Math.PI;
        if (a < 0) a += 180;
        var dx1, dy1, dx2, dy2;
        if ((a >= 0 && a < 22.5) || (a >= 157.5 && a <= 180)) { dx1 = 1; dy1 = 0; dx2 = -1; dy2 = 0; }
        else if (a >= 22.5 && a < 67.5) { dx1 = 1; dy1 = 1; dx2 = -1; dy2 = -1; }
        else if (a >= 67.5 && a < 112.5) { dx1 = 0; dy1 = 1; dx2 = 0; dy2 = -1; }
        else { dx1 = -1; dy1 = 1; dx2 = 1; dy2 = -1; }
        var m1 = mag[clamp(y + dy1, 0, h - 1) * w + clamp(x + dx1, 0, w - 1)];
        var m2 = mag[clamp(y + dy2, 0, h - 1) * w + clamp(x + dx2, 0, w - 1)];
        if (m >= m1 && m >= m2) {
          if (m >= high) strong[j] = 1; else weak[j] = 1;
        }
      }
    }
    // Hysteresis: weak pixels survive only next to a strong one.
    var out = new Uint8Array(w * h);
    var stack = [];
    for (i = 0; i < w * h; i++) if (strong[i]) { out[i] = 1; stack.push(i); }
    while (stack.length) {
      var p = stack.pop(), px = p % w, py = (p / w) | 0;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var qx = px + dx, qy = py + dy;
          if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
          var q = qy * w + qx;
          if (weak[q] && !out[q]) { out[q] = 1; stack.push(q); }
        }
      }
    }
    return out;
  }

  // 8-connected components with a minimum area; returns a keep mask.
  function componentsKeep(binary, w, h, minArea) {
    var labels = new Int32Array(w * h).fill(-1);
    var keep = new Uint8Array(w * h);
    var comp = 0, stack = [];
    for (var start = 0; start < w * h; start++) {
      if (!binary[start] || labels[start] !== -1) continue;
      var area = 0, members = [];
      stack.push(start); labels[start] = comp;
      while (stack.length) {
        var p = stack.pop(), px = p % w, py = (p / w) | 0;
        members.push(p); area++;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var qx = px + dx, qy = py + dy;
            if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
            var q = qy * w + qx;
            if (binary[q] && labels[q] === -1) { labels[q] = comp; stack.push(q); }
          }
        }
      }
      if (area >= minArea) for (var m = 0; m < members.length; m++) keep[members[m]] = 1;
      comp++;
    }
    return keep;
  }

  function countSet(mask) {
    var n = 0;
    for (var i = 0; i < mask.length; i++) if (mask[i]) n++;
    return n;
  }

  // Trace a binary edge map into polylines: endpoints first, then
  // junctions, then leftover loops.
  function traceEdges(binary, w, h) {
    var pix = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) pix[i] = binary[i] ? 1 : 0;
    var visited = new Uint8Array(w * h);
    function neighbours(px, py) {
      var out = [];
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var qx = px + dx, qy = py + dy;
          if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
          if (pix[qy * w + qx]) out.push([qx, qy]);
        }
      }
      return out;
    }
    function nCount(p) { return neighbours(p[0], p[1]).length; }
    var lines = [];
    var ends = [], juncs = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!pix[y * w + x]) continue;
        var n = nCount([x, y]);
        if (n === 1) ends.push([x, y]);
        else if (n >= 3) juncs.push([x, y]);
      }
    }
    var starts = ends.concat(juncs);
    for (var si = 0; si < starts.length; si++) {
      var start = starts[si];
      if (visited[start[1] * w + start[0]]) continue;
      var nbs0 = neighbours(start[0], start[1]);
      for (var bi = 0; bi < nbs0.length; bi++) {
        var line = [start];
        var prev = start, cur = nbs0[bi];
        for (;;) {
          line.push(cur);
          visited[cur[1] * w + cur[0]] = 1;
          var nbs = neighbours(cur[0], cur[1]).filter(function (q) { return q[0] !== prev[0] || q[1] !== prev[1]; });
          if (!nbs.length) break;
          if (nbs.length > 1 && (cur[0] !== start[0] || cur[1] !== start[1])) break;
          prev = cur; cur = nbs[0];
          if (visited[cur[1] * w + cur[0]] && (cur[0] !== start[0] || cur[1] !== start[1])) break;
          if (line.length > 5000) break;
        }
        if (line.length >= 2) lines.push(line);
      }
      visited[start[1] * w + start[0]] = 1;
    }
    for (var py = 0; py < h; py++) {
      for (var px = 0; px < w; px++) {
        if (!pix[py * w + px] || visited[py * w + px]) continue;
        var loop = [[px, py]];
        visited[py * w + px] = 1;
        var pprev = null, ccur = [px, py];
        for (;;) {
          var cands = neighbours(ccur[0], ccur[1]).filter(function (q) {
            return (pprev === null || q[0] !== pprev[0] || q[1] !== pprev[1]) && !visited[q[1] * w + q[0]];
          });
          if (!cands.length) break;
          pprev = ccur; ccur = cands[0];
          loop.push(ccur); visited[ccur[1] * w + ccur[0]] = 1;
          if (loop.length > 5000) break;
        }
        if (loop.length >= 2) lines.push(loop);
      }
    }
    return lines;
  }

  // ---------- Plotcaster-style flow ----------
  function mulArrays(a, b) {
    var out = new Float32Array(a.length);
    for (var i = 0; i < a.length; i++) out[i] = a[i] * b[i];
    return out;
  }

  // Jobard-Lefer streamlines over a structure-tensor field. Returns
  // { paths: [svg strings], count, mm }.
  function plotcasterFlowPaths(dark, nw, nh, colour, opts) {
    var w = nw, h = nh;
    var mmPerUnit = (nh >= nw ? 140 : 118) / SIZE;
    var mmPerPx = mmPerUnit * SIZE / nw;
    var step = opts.stepMm / mmPerPx;
    var shadowSep = opts.shadowSepMm / mmPerPx / opts.density;
    var lightSep = opts.lightSepMm / mmPerPx / opts.density;
    var mergeR = opts.mergeMm / mmPerPx;
    var minLenPx = opts.minLenMm / mmPerPx;
    var thresh = opts.thresh;
    var g = sobel(dark, w, h);
    var gxx, gyy, gxy;
    if (opts.adaptive) {
      var sigLo = Math.max(0.5, 0.4 * opts.smoothnessMm / mmPerPx);
      var sigHi = Math.max(1.0, 2.0 * opts.smoothnessMm / mmPerPx);
      var txxLo = gaussianBlur(mulArrays(g.gx, g.gx), w, h, sigLo);
      var tyyLo = gaussianBlur(mulArrays(g.gy, g.gy), w, h, sigLo);
      var txyLo = gaussianBlur(mulArrays(g.gx, g.gy), w, h, sigLo);
      var txxHi = gaussianBlur(mulArrays(g.gx, g.gx), w, h, sigHi);
      var tyyHi = gaussianBlur(mulArrays(g.gy, g.gy), w, h, sigHi);
      var txyHi = gaussianBlur(mulArrays(g.gx, g.gy), w, h, sigHi);
      gxx = new Float32Array(w * h); gyy = new Float32Array(w * h); gxy = new Float32Array(w * h);
      for (var i = 0; i < w * h; i++) {
        var tr = txxHi[i] + tyyHi[i];
        var coh = Math.sqrt((txxHi[i] - tyyHi[i]) * (txxHi[i] - tyyHi[i]) + 4 * txyHi[i] * txyHi[i]) / (tr + 1e-9);
        var wgt = clamp(coh * 8, 0, 1);
        gxx[i] = txxLo[i] * wgt + txxHi[i] * (1 - wgt);
        gyy[i] = tyyLo[i] * wgt + tyyHi[i] * (1 - wgt);
        gxy[i] = txyLo[i] * wgt + txyHi[i] * (1 - wgt);
      }
    } else {
      var sig = Math.max(0.5, opts.smoothnessMm / mmPerPx);
      gxx = gaussianBlur(mulArrays(g.gx, g.gx), w, h, sig);
      gyy = gaussianBlur(mulArrays(g.gy, g.gy), w, h, sig);
      gxy = gaussianBlur(mulArrays(g.gx, g.gy), w, h, sig);
    }
    var flat2 = 2 * (opts.flatAngleDeg * Math.PI / 180 + opts.angleOffset);
    function dirAt(x, y) {
      if (!(x >= 0 && x < w - 1 && y >= 0 && y < h - 1)) return null;
      var a = bilinear(gxx, w, h, x, y);
      var b = bilinear(gxy, w, h, x, y);
      var c = bilinear(gyy, w, h, x, y);
      var theta = 0.5 * Math.atan2(2 * b, a - c) + Math.PI / 2 + opts.angleOffset;
      var tr = a + c;
      var coh = tr > 1e-9 ? Math.sqrt((a - c) * (a - c) + 4 * b * b) / (tr + 1e-9) : 0;
      var phi = 2 * theta;
      var delta = (flat2 - phi + Math.PI) % (2 * Math.PI) - Math.PI;
      var wgt = clamp(coh * 8, 0, 1);
      theta = 0.5 * (phi + delta * (1 - wgt));
      return [Math.cos(theta), Math.sin(theta)];
    }
    function toneAt(x, y) {
      return dark[clamp(Math.floor(y), 0, h - 1) * w + clamp(Math.floor(x), 0, w - 1)];
    }
    function sepAt(x, y) {
      return lightSep - (lightSep - shadowSep) * toneAt(x, y);
    }
    var cell = 0.5 / mmPerPx;
    var gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
    var occ = new Uint8Array(gw * gh);
    function occupied(x, y, r) {
      var ix = Math.floor(x / cell), iy = Math.floor(y / cell);
      var rr = Math.ceil(r / cell);
      for (var yy = Math.max(0, iy - rr); yy <= Math.min(gh - 1, iy + rr); yy++) {
        for (var xx = Math.max(0, ix - rr); xx <= Math.min(gw - 1, ix + rr); xx++) {
          if (occ[yy * gw + xx]) return true;
        }
      }
      return false;
    }
    function markLine(pts) {
      for (var i = 0; i < pts.length; i++) {
        var ix = Math.floor(pts[i][0] / cell), iy = Math.floor(pts[i][1] / cell);
        if (ix >= 0 && ix < gw && iy >= 0 && iy < gh) occ[iy * gw + ix] = 1;
      }
    }
    function trace(sx, sy, vx, vy) {
      var pts = [[sx, sy]], x = sx, y = sy, v = [vx, vy];
      for (var n = 0; n < 3000; n++) {
        var d1 = dirAt(x, y);
        if (!d1) break;
        if (d1[0] * v[0] + d1[1] * v[1] < 0) d1 = [-d1[0], -d1[1]];
        var mx = x + d1[0] * step / 2, my = y + d1[1] * step / 2;
        var d2 = dirAt(mx, my);
        if (!d2) break;
        if (d2[0] * d1[0] + d2[1] * d1[1] < 0) d2 = [-d2[0], -d2[1]];
        var nx = x + d2[0] * step, ny = y + d2[1] * step;
        if (!(nx >= 0 && nx < w && ny >= 0 && ny < h)) break;
        if (toneAt(nx, ny) < thresh) break;
        if (occupied(nx, ny, 0.5 * sepAt(nx, ny))) break;
        pts.push([nx, ny]);
        v = d2; x = nx; y = ny;
      }
      return pts;
    }
    var heap = new ToneHeap();
    var gs = Math.max(2.0, lightSep);
    for (var yy = 0; yy < h; yy += gs) {
      for (var xx = 0; xx < w; xx += gs) {
        var t = toneAt(xx, yy);
        if (t >= thresh) heap.push(t, xx, yy);
      }
    }
    var lines = [], pops = 0;
    while (heap.size() && pops < 30000 && lines.length < 5000) {
      pops++;
      var seed = heap.pop();
      var sx = seed.x, sy = seed.y;
      if (toneAt(sx, sy) < thresh) continue;
      if (occupied(sx, sy, sepAt(sx, sy))) continue;
      var d0 = dirAt(sx, sy);
      if (!d0) continue;
      var back = trace(sx, sy, -d0[0], -d0[1]).reverse();
      var fwd = trace(sx, sy, d0[0], d0[1]);
      var pts = back.concat(fwd.slice(1));
      var L = polylineLength(pts);
      if (L < minLenPx) continue;
      markLine(pts);
      lines.push(pts);
      var n = pts.length, k = 0;
      while (k < n) {
        var px = pts[k][0], py = pts[k][1];
        var d = sepAt(px, py);
        var q1 = pts[Math.max(0, k - 2)], q2 = pts[Math.min(n - 1, k + 2)];
        var vx = q2[0] - q1[0], vy = q2[1] - q1[1];
        var vl = Math.hypot(vx, vy) || 1;
        vx /= vl; vy /= vl;
        for (var sgn = -1; sgn <= 1; sgn += 2) {
          var ox = px + sgn * d * -vy, oy = py + sgn * d * vx;
          if (ox >= 0 && ox < w && oy >= 0 && oy < h) {
            var tt = toneAt(ox, oy);
            if (tt >= thresh && heap.size() < 8000) heap.push(tt, ox, oy);
          }
        }
        k += Math.max(2, Math.floor(d / step));
      }
    }
    var simp = [];
    for (var li = 0; li < lines.length; li++) {
      var s = rdp(lines[li], 0.1 / mmPerPx);
      if (s.length < 2) continue;
      if (polylineLength(s) < minLenPx) continue;
      simp.push(s);
    }
    // Merge endpoints within mergeR when the travel directions align.
    function endDir(line, end) {
      var a, b;
      if (end === 1) { a = line[line.length - 2]; b = line[line.length - 1]; }
      else { a = line[1]; b = line[0]; }
      var vx = b[0] - a[0], vy = b[1] - a[1], l = Math.hypot(vx, vy) || 1;
      return [vx / l, vy / l];
    }
    for (var round = 0; round < 5; round++) {
      var alive = simp.filter(function (s) { return s.length >= 2; });
      if (alive.length < 2) { simp = alive; break; }
      var index = new Map();
      for (var ai = 0; ai < alive.length; ai++) {
        for (var end = 0; end <= 1; end++) {
          var ep = end === 0 ? alive[ai][0] : alive[ai][alive[ai].length - 1];
          var key = Math.floor(ep[0] / mergeR) + "," + Math.floor(ep[1] / mergeR);
          if (!index.has(key)) index.set(key, []);
          index.get(key).push([ai, end]);
        }
      }
      var dead = new Set(), joined = false, outLines = [];
      for (var ci = 0; ci < alive.length; ci++) {
        if (dead.has(ci)) continue;
        var cur = alive[ci];
        for (var e = 1; e >= 0; e--) {
          for (;;) {
            var p = e === 1 ? cur[cur.length - 1] : cur[0];
            var kx = Math.floor(p[0] / mergeR), ky = Math.floor(p[1] / mergeR);
            var best = null;
            outer:
            for (var ddx = -1; ddx <= 1; ddx++) {
              for (var ddy = -1; ddy <= 1; ddy++) {
                var cellList = index.get((kx + ddx) + "," + (ky + ddy));
                if (!cellList) continue;
                for (var ci2 = 0; ci2 < cellList.length; ci2++) {
                  var j = cellList[ci2][0], jend = cellList[ci2][1];
                  if (j === ci || dead.has(j)) continue;
                  var q = jend === 0 ? alive[j][0] : alive[j][alive[j].length - 1];
                  if (Math.hypot(q[0] - p[0], q[1] - p[1]) > mergeR) continue;
                  var dCur = endDir(cur, e), dJ = endDir(alive[j], jend);
                  if (dCur[0] * dJ[0] + dCur[1] * dJ[1] >= -0.5) continue;
                  var joinedLine;
                  if (e === 1 && jend === 0) joinedLine = cur.concat(alive[j].slice(1));
                  else if (e === 1 && jend === 1) joinedLine = cur.concat(alive[j].slice().reverse().slice(1));
                  else if (e === 0 && jend === 1) joinedLine = alive[j].slice(0, -1).concat(cur);
                  else joinedLine = alive[j].slice().reverse().slice(0, -1).concat(cur);
                  best = [j, joinedLine];
                  break outer;
                }
              }
            }
            if (!best) break;
            dead.add(best[0]);
            cur = best[1];
            joined = true;
          }
        }
        outLines.push(cur);
      }
      simp = outLines;
      if (!joined) break;
    }
    simp = orderPolylines(simp);
    simp = simp.map(function (s) { return chaikin(s); });
    var out = [], total = 0;
    for (var oi = 0; oi < simp.length; oi++) {
      var xy = simp[oi].map(function (p) { return toSvgXy(p[0], p[1], nw, nh); });
      out.push(svgPath(xy, colour));
      total += pathLenMm(xy);
    }
    return { paths: out, count: simp.length, mm: total };
  }

  // ---------- gradient shading: parallel variable-spacing hatch ----------
  function variableHatchPaths(tone, mask, nw, nh, colour, angleDeg, baseGapPx, opts) {
    var w = nw, h = nh;
    var mmPerUnit = (nh >= nw ? 140 : 118) / SIZE;
    var ang = angleDeg * Math.PI / 180;
    var dx = Math.cos(ang), dy = Math.sin(ang), nx = -dy, ny = dx;
    var corners = [[0, 0], [w, 0], [0, h], [w, h]];
    var offs = corners.map(function (c) { return c[0] * nx + c[1] * ny; });
    var omin = Math.min.apply(null, offs), omax = Math.max.apply(null, offs);
    var minSegUnits = opts.minSegMm / mmPerUnit;
    var out = [], nseg = 0, total = 0;
    var tmax = Math.hypot(w, h);
    var acc = 0, off = omin;
    function atMask(x, y) {
      var ix = Math.round(x), iy = Math.round(y);
      return ix >= 0 && ix < w && iy >= 0 && iy < h && mask[iy * w + ix];
    }
    while (off <= omax) {
      var ox = off * nx, oy = off * ny;
      var tot = 0, cnt = 0;
      [-0.35, -0.175, 0, 0.175, 0.35].forEach(function (ts) {
        var sx = ox + ts * tmax * dx, sy = oy + ts * tmax * dy;
        var ix = Math.round(sx), iy = Math.round(sy);
        if (ix >= 0 && ix < w && iy >= 0 && iy < h && mask[iy * w + ix]) { tot += tone[iy * w + ix]; cnt++; }
      });
      var d = cnt ? tot / cnt : 0;
      acc += opts.floor + (1 - opts.floor) * d;
      if (acc >= baseGapPx) {
        acc = 0;
        var t = -tmax, inSeg = false, seg = null;
        while (t <= tmax) {
          var x = ox + t * dx, y = oy + t * dy;
          var inside = atMask(x, y);
          if (inside && !inSeg) { inSeg = true; seg = [x, y]; }
          else if (!inside && inSeg) {
            inSeg = false;
            var xy = [toSvgXy(seg[0], seg[1], nw, nh), toSvgXy(x, y, nw, nh)];
            var L = Math.hypot(xy[1][0] - xy[0][0], xy[1][1] - xy[0][1]);
            if (L >= minSegUnits) {
              out.push(svgPath(xy, colour)); nseg++; total += L * mmPerUnit;
            }
          }
          t += 2.0;
        }
        if (inSeg) {
          var xy2 = [toSvgXy(seg[0], seg[1], nw, nh), toSvgXy(ox + tmax * dx, oy + tmax * dy, nw, nh)];
          var L2 = Math.hypot(xy2[1][0] - xy2[0][0], xy2[1][1] - xy2[0][1]);
          if (L2 >= minSegUnits) {
            out.push(svgPath(xy2, colour)); nseg++; total += L2 * mmPerUnit;
          }
        }
      }
      off += 1.0;
    }
    return { paths: out, count: nseg, mm: total };
  }

  // ---------- wave squiggle ----------
  function squigglePaths(tone, mask, nw, nh, colour, opts) {
    var w = nw, h = nh;
    var mmPerUnit = (nh >= nw ? 140 : 118) / SIZE;
    var mmPerPx = mmPerUnit * SIZE / nw;
    var gap = opts.baseGapMm / mmPerPx / opts.density;
    var ampMax = opts.ampFrac * gap;
    var lamMax = opts.lamMaxMm / mmPerPx, lamMin = opts.lamMinMm / mmPerPx;
    var step = Math.max(0.1, 0.1 / mmPerPx);
    var minSegPx = opts.minSegMm / mmPerPx;
    function toneAt(x, y) {
      return tone[clamp(Math.floor(y), 0, h - 1) * w + clamp(Math.floor(x), 0, w - 1)];
    }
    function maskAt(x, y) {
      return mask[clamp(Math.floor(y), 0, h - 1) * w + clamp(Math.floor(x), 0, w - 1)];
    }
    var lines = [];
    function flush(seg) {
      if (seg.length < 2) return;
      var s = rdp(seg, 0.05 / mmPerPx);
      if (s.length < 2) return;
      if (polylineLength(s) < minSegPx) return;
      lines.push(s);
    }
    var lineIdx = 0;
    if (opts.vertical) {
      var x0 = 0;
      while (x0 < w) {
        var phase = lineIdx * 2.39996, seg = [], y = 0;
        while (y < h) {
          var t = toneAt(x0, y), m = maskAt(x0, y);
          var lam = lamMax - (lamMax - lamMin) * t;
          phase += step * 2 * Math.PI / lam;
          var off = ampMax * t * Math.sin(phase);
          if (m && t >= opts.thresh) seg.push([x0 + off, y]);
          else { flush(seg); seg = []; }
          y += step;
        }
        flush(seg);
        x0 += gap; lineIdx++;
      }
    } else {
      var y0 = 0;
      while (y0 < h) {
        var phase2 = lineIdx * 2.39996, seg2 = [], x = 0;
        while (x < w) {
          var t2 = toneAt(x, y0), m2 = maskAt(x, y0);
          var lam2 = lamMax - (lamMax - lamMin) * t2;
          phase2 += step * 2 * Math.PI / lam2;
          var off2 = ampMax * t2 * Math.sin(phase2);
          if (m2 && t2 >= opts.thresh) seg2.push([x, y0 + off2]);
          else { flush(seg2); seg2 = []; }
          x += step;
        }
        flush(seg2);
        y0 += gap; lineIdx++;
      }
    }
    var out = [], total = 0;
    for (var i = 0; i < lines.length; i++) {
      var xy = lines[i].map(function (p) { return toSvgXy(p[0], p[1], nw, nh); });
      out.push(svgPath(xy, colour));
      total += pathLenMm(xy);
    }
    return { paths: out, count: lines.length, mm: total };
  }

  // ---------- LBG stipple + TSP tour ----------
  function samplePoints(dark, w, h, n, seed) {
    var rng = mulberry32(seed);
    var total = 0, i;
    var weights = new Float64Array(w * h);
    for (i = 0; i < w * h; i++) {
      var v = Math.pow(dark[i], 3);
      weights[i] = v; total += v;
    }
    var cdf = new Float64Array(w * h);
    var acc = 0;
    for (i = 0; i < w * h; i++) { acc += weights[i] / total; cdf[i] = acc; }
    var pts = [];
    for (var s = 0; s < n; s++) {
      var r = rng(), lo = 0, hi = w * h - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (cdf[mid] < r) lo = mid + 1; else hi = mid;
      }
      pts.push([(lo % w) + rng(), (Math.floor(lo / w)) + rng()]);
    }
    return pts;
  }
  function lbgPoints(dark, w, h, n, iterations, seed) {
    var pts = samplePoints(dark, w, h, n, seed);
    var px = new Float64Array(w * h), py = new Float64Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) { px[y * w + x] = x; py[y * w + x] = y; }
    }
    var wt = new Float64Array(w * h);
    for (var i = 0; i < w * h; i++) wt[i] = Math.pow(dark[i], 3);
    for (var it = 0; it < iterations; it++) {
      var tree = buildKdTree(pts);
      var wsum = new Float64Array(n), xsum = new Float64Array(n), ysum = new Float64Array(n);
      for (var p = 0; p < w * h; p++) {
        if (wt[p] <= 0) continue;
        var cell = kdNearest(tree, px[p], py[p]);
        wsum[cell] += wt[p];
        xsum[cell] += px[p] * wt[p];
        ysum[cell] += py[p] * wt[p];
      }
      for (var j = 0; j < n; j++) {
        if (wsum[j] > 0) { pts[j] = [xsum[j] / wsum[j], ysum[j] / wsum[j]]; }
      }
    }
    return pts;
  }
  function orderTspFast(pts, passes) {
    var n = pts.length;
    if (n <= 2) return pts.slice();
    var tree = buildKdTree(pts);
    var visited = new Uint8Array(n);
    var order = [0];
    visited[0] = 1;
    var cur = 0;
    for (var s = 0; s < n - 1; s++) {
      var k = 16, nxt = -1;
      for (;;) {
        var kk = Math.min(k, n);
        var near = kdKNearest(tree, pts[cur][0], pts[cur][1], kk);
        for (var ci = 0; ci < near.length; ci++) {
          if (!visited[near[ci]]) { nxt = near[ci]; break; }
        }
        if (nxt !== -1) break;
        if (kk >= n) {
          for (var u = 0; u < n; u++) if (!visited[u]) { nxt = u; break; }
          break;
        }
        k *= 2;
      }
      order.push(nxt); visited[nxt] = 1; cur = nxt;
    }
    var P = order.map(function (i) { return [pts[i][0], pts[i][1]]; });
    for (var pass = 0; pass < passes; pass++) {
      var improved = false;
      for (var i = 0; i < n - 2; i++) {
        var a = P[i], b = P[i + 1];
        var bestGain = 0, bestJ = -1;
        for (var j = i + 2; j < n - 1; j++) {
          var c = P[j], d = P[j + 1];
          var oldL = Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(d[0] - c[0], d[1] - c[1]);
          var newL = Math.hypot(c[0] - a[0], c[1] - a[1]) + Math.hypot(d[0] - b[0], d[1] - b[1]);
          var gain = oldL - newL;
          if (gain > bestGain) { bestGain = gain; bestJ = j; }
        }
        if (bestGain > 1e-9) {
          var seg = P.slice(i + 1, bestJ + 1).reverse();
          for (var m = 0; m < seg.length; m++) P[i + 1 + m] = seg[m];
          improved = true;
        }
      }
      if (!improved) break;
    }
    return P;
  }
  function tspPaths(dark, nw, nh, colour, density) {
    var w = nw, h = nh;
    var mmPerUnit = (nh >= nw ? 140 : 118) / SIZE;
    var mmPerPx = mmPerUnit * SIZE / nw;
    var masked = new Float32Array(w * h);
    var sum = 0;
    for (var i = 0; i < w * h; i++) {
      masked[i] = dark[i] >= 0.12 ? dark[i] : 0;
      sum += masked[i];
    }
    var pitchMm = 1.4;
    var n = Math.round(clamp(sum * mmPerPx * mmPerPx / (pitchMm * pitchMm) * density, 200, 2500));
    var pts = lbgPoints(masked, w, h, n, 8, 7);
    var tour = orderTspFast(pts, 5);
    var xy = tour.map(function (p) { return toSvgXy(p[0], p[1], nw, nh); });
    xy = chaikinPlain(xy, 1);
    return { paths: [svgPath(xy, colour)], count: 1, mm: pathLenMm(xy) };
  }

  // ---------- main conversion (port of the reference sketch()) ----------
  function normalizeOptions(options) {
    var o = options || {};
    var shading = typeof o.shading === "string" && SHADING_MODES.indexOf(o.shading) !== -1 ? o.shading : "off";
    var density = typeof o.density === "number" && isFinite(o.density) ? clamp(o.density, 0.5, 5) : 1;
    return {
      detail: o.detail === true,
      dramatic: o.dramatic === true,
      adaptive: o.adaptive !== false,
      shading: shading,
      density: density,
      smoothnessMm: 2.5,
      shadingAngle: 45,
      squiggleVertical: false,
      brightness: 0,
      contrast: 1,
      colour: o.colour !== false,
    };
  }

  function smoothMask(mask, w, h) {
    var f = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) f[i] = mask[i] ? 1 : 0;
    var b = gaussianBlur(f, w, h, 2.0);
    var out = new Uint8Array(w * h);
    for (var j = 0; j < w * h; j++) out[j] = b[j] > 0.3 ? 1 : 0;
    return out;
  }

  function medianOf(values) {
    var s = Array.from(values).sort(function (a, b) { return a - b; });
    return s[Math.floor(s.length / 2)];
  }

  // pixels: { width, height, data } with RGBA bytes (ImageData shape).
  // Returns { svg, stats }. Yields between stages so the UI stays live.
  async function convertPixels(pixels, options, onProgress) {
    var t0 = nowMs();
    var opts = normalizeOptions(options);
    var progress = function (label) { if (typeof onProgress === "function") onProgress(label); };
    var w0 = pixels.width, h0 = pixels.height, data = pixels.data;
    if (!w0 || !h0 || !data || data.length < w0 * h0 * 4) throw new Error("Photo has no pixels.");
    // Full-resolution luminance (Rec.709, as the reference's lum).
    var lumFull = new Float32Array(w0 * h0);
    for (var i = 0; i < w0 * h0; i++) {
      lumFull[i] = 0.2125 * data[i * 4] + 0.7154 * data[i * 4 + 1] + 0.0721 * data[i * 4 + 2];
    }
    var crop = cropWhiteBorder(lumFull, w0, h0);
    var cw = Math.max(1, crop.x1 - crop.x0), ch = Math.max(1, crop.y1 - crop.y0);
    var nw = opts.detail ? 420 : WORK_W;
    var nh = Math.max(1, Math.round(ch * nw / cw));
    var rgb = resizeRgb(data, w0, h0, crop.x0, crop.y0, crop.x1, crop.y1, nw, nh);
    var N = nw * nh;
    var lum = new Float32Array(N), sat = new Float32Array(N), gray = new Float32Array(N);
    for (var p = 0; p < N; p++) {
      var r = rgb.r[p], g = rgb.g[p], b = rgb.b[p];
      lum[p] = 0.2125 * r + 0.7154 * g + 0.0721 * b;
      sat[p] = Math.max(r, g, b) - Math.min(r, g, b);
      gray[p] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    var darkCount = 0;
    for (var q = 0; q < N; q++) if (lum[q] < 50) darkCount++;
    var night = darkCount / N > 0.6;
    // Tone map: darkness normally, brightness at night.
    var tone = new Float32Array(N);
    var toneScale = opts.dramatic ? 1.15 : 0.85;
    var gamma = opts.dramatic ? 1.0 : 1.3;
    for (var ti = 0; ti < N; ti++) {
      if (night) {
        tone[ti] = clamp((lum[ti] - 20) / 180, 0, 1) * 1.2;
      } else {
        var lin = Math.pow(clamp(lum[ti], 0, 255) / 255, 2.2);
        var t = clamp(1 - lin, 0, 1);
        tone[ti] = Math.pow(clamp((t - 0.5) * 1.25 + 0.5, 0, 1), gamma) * toneScale;
      }
    }
    for (var tc = 0; tc < N; tc++) tone[tc] = clamp(tone[tc], 0, 1);
    // Vignette: tone fades toward the edges.
    for (var y = 0; y < nh; y++) {
      for (var x = 0; x < nw; x++) {
        var r2 = ((x / nw - 0.5) * (x / nw - 0.5) + (y / nh - 0.5) * (y / nh - 0.5)) / 0.5;
        tone[y * nw + x] *= 0.6 + 0.4 * clamp(1 - r2, 0, 1);
      }
    }
    if (opts.contrast !== 1) {
      for (var ci = 0; ci < N; ci++) tone[ci] = clamp((tone[ci] - 0.5) * opts.contrast + 0.5, 0, 1);
    }
    if (opts.brightness !== 0) {
      for (var bi = 0; bi < N; bi++) tone[bi] = clamp(tone[bi] - opts.brightness, 0, 1);
    }
    var mmPerUnit = (nh >= nw ? 140 : 118) / SIZE;
    var mmPerPx = mmPerUnit * SIZE / nw;
    var shading = opts.shading, density = opts.density;
    var doFlow = shading === "off" || shading === "hybrid" || shading === "plotcaster";
    var doGrad = shading === "gradient" || shading === "cross" || shading === "hybrid";
    var doSq = shading === "squiggle";
    var doTsp = shading === "tsp";
    var toneThresh = Math.max(0.03, 0.05 / density);
    var pcThresh = toneThresh;
    var shadeThresh = night ? Math.max(0.08, 0.45 / density) : toneThresh;
    var gradGapPx = (shading === "hybrid" ? 0.71 : 0.50) / mmPerPx / density;
    var gradFloor = Math.min(0.6, (shading === "hybrid" ? 0.12 : 0.18) * density);
    var flowOpts = {
      thresh: pcThresh, shadowSepMm: SHADOW_SEP_MM, lightSepMm: LIGHT_SEP_MM,
      density: density, stepMm: 0.3, smoothnessMm: opts.smoothnessMm, adaptive: opts.adaptive,
      flatAngleDeg: opts.shadingAngle, angleOffset: 0, minLenMm: 2.5, mergeMm: 0.15,
    };
    // All emitted paths, in order: structure, black tone, colour layers.
    // Kept as viewBox polylines for the final per-pen ordering pass.
    var emitted = [];
    function emitPaths(result) {
      for (var i = 0; i < result.paths.length; i++) emitted.push(result.paths[i]);
    }
    progress("Reading photo…");
    await tick();
    // ---- structure: FDoG edges over the ETF field ----
    var nStruct = 0, mmStruct = 0;
    var canny = opts.detail ? [40, 120] : [50, 150];
    var minArea = opts.detail ? 6 : 12;
    var minLineMm = opts.detail ? 1.5 : 3.0;
    if (shading !== "squiggle") {
      progress("Finding outlines…");
      await tick();
      var blur = gaussianBlur(gray, nw, nh, 1.2);
      var etf = etfField(blur, nw, nh, 2, 2.0, 3);
      var edges = fdogEdges(blur, etf.tx, etf.ty, nw, nh, 1.0, 1.6, 0.8, 2, 25);
      if (countSet(edges) < 50) edges = cannyEdges(blur, nw, nh, canny[0], canny[1]);
      var edgesFaint = cannyEdges(blur, nw, nh, 30, 90);
      var keep = componentsKeep(edges, nw, nh, minArea);
      var keepFaint = componentsKeep(edgesFaint, nw, nh, minArea);
      var traced = traceEdges(keep, nw, nh).map(function (l) { return [l, minLineMm]; });
      traced = traced.concat(traceEdges(keepFaint, nw, nh).map(function (l) { return [l, opts.detail ? 8.0 : 15.0]; }));
      var simpLines = [];
      for (var li = 0; li < traced.length; li++) {
        var line = traced[li][0], minMm = traced[li][1];
        var simp = rdp(line, 0.4 / mmPerPx);
        if (simp.length < 2) continue;
        var xy = simp.map(function (pt) { return toSvgXy(pt[0], pt[1], nw, nh); });
        var L = polylineLength(xy);
        if (L < minMm / mmPerUnit) continue;
        simpLines.push({ simp: simp, xy: xy, len: L });
      }
      // De-overlap: longest lines win; a line is dropped when more
      // than half its sampled points fall within a pen-width of a
      // kept line.
      simpLines.sort(function (a, b) { return b.len - a.len; });
      var cell = 0.5 / mmPerPx;
      var occupiedCells = new Set();
      function covered(x, y) {
        var ix = Math.floor(x / cell), iy = Math.floor(y / cell);
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            if (occupiedCells.has((ix + dx) + "," + (iy + dy))) return true;
          }
        }
        return false;
      }
      function samples(simp) {
        var pts = [];
        for (var s = 0; s + 1 < simp.length; s++) {
          var seg = Math.hypot(simp[s + 1][0] - simp[s][0], simp[s + 1][1] - simp[s][1]);
          var steps = Math.max(1, Math.floor(seg / (cell / 2)));
          for (var i = 0; i < steps; i++) {
            var t = i / steps;
            pts.push([simp[s][0] + (simp[s + 1][0] - simp[s][0]) * t, simp[s][1] + (simp[s + 1][1] - simp[s][1]) * t]);
          }
        }
        return pts;
      }
      for (var si = 0; si < simpLines.length; si++) {
        var entry = simpLines[si];
        var pts = samples(entry.simp);
        if (pts.length) {
          var cov = 0;
          for (var pi = 0; pi < pts.length; pi++) if (covered(pts[pi][0], pts[pi][1])) cov++;
          if (cov / pts.length > 0.5) continue;
        }
        for (var mi = 0; mi < pts.length; mi++) {
          occupiedCells.add(Math.floor(pts[mi][0] / cell) + "," + Math.floor(pts[mi][1] / cell));
        }
        emitted.push(svgPath(entry.xy, BLACK));
        nStruct++; mmStruct += entry.len * mmPerUnit;
      }
    }
    // ---- tone: heavily smoothed, floored outside paper ----
    var toneS = gaussianBlur(tone, nw, nh, 2.5);
    var paper = new Uint8Array(N);
    for (var pp = 0; pp < N; pp++) {
      paper[pp] = night ? (lum[pp] < 45 ? 1 : 0) : (lum[pp] > 245 && sat[pp] < 25 ? 1 : 0);
    }
    for (var pf = 0; pf < N; pf++) {
      if (paper[pf]) toneS[pf] = 0;
      else toneS[pf] = Math.max(toneS[pf], 0.08);
    }
    var nTone = 0, mmTone = 0;
    progress("Shading…");
    await tick();
    function maskWhere(pred) {
      var m = new Float32Array(N);
      for (var i = 0; i < N; i++) m[i] = pred(i) ? toneS[i] : 0;
      return m;
    }
    function boolMask(pred) {
      var m = new Uint8Array(N);
      for (var i = 0; i < N; i++) m[i] = pred(i) ? 1 : 0;
      return m;
    }
    function runFlow(darkArr, colour, angleOffset) {
      var o = Object.assign({}, flowOpts, { angleOffset: angleOffset || 0 });
      var r = plotcasterFlowPaths(darkArr, nw, nh, colour, o);
      emitPaths(r); nTone += r.count; mmTone += r.mm;
    }
    function runGrad(mask, colour, angle) {
      var r = variableHatchPaths(toneS, mask, nw, nh, colour, angle, gradGapPx, { floor: gradFloor, minSegMm: 1.5 });
      emitPaths(r); nTone += r.count; mmTone += r.mm;
    }
    function runSq(mask, colour) {
      var r = squigglePaths(toneS, mask, nw, nh, colour, {
        vertical: opts.squiggleVertical, baseGapMm: 2.5, ampFrac: 0.45,
        lamMaxMm: 8.0, lamMinMm: 3.0, density: density, thresh: toneThresh, minSegMm: 3.0,
      });
      emitPaths(r); nTone += r.count; mmTone += r.mm;
    }
    function runTsp(darkArr, colour) {
      var r = tspPaths(darkArr, nw, nh, colour, density);
      emitPaths(r); nTone += r.count; mmTone += r.mm;
    }
    if (doGrad) {
      var blackMask = smoothMask(boolMask(function (i) { return sat[i] < 60 && toneS[i] > shadeThresh; }), nw, nh);
      runGrad(blackMask, BLACK, opts.shadingAngle);
      if (shading === "cross") {
        var darkMask = new Uint8Array(N);
        for (var dm = 0; dm < N; dm++) darkMask[dm] = blackMask[dm] && toneS[dm] > 0.45 ? 1 : 0;
        runGrad(darkMask, BLACK, opts.shadingAngle + 90);
      }
    }
    if (doFlow) {
      runFlow(maskWhere(function (i) { return sat[i] < 60; }), BLACK, 0);
      if (opts.dramatic) {
        runFlow(maskWhere(function (i) { return toneS[i] > 0.55 && sat[i] < 60; }), BLACK, Math.PI / 2);
      }
    }
    if (doTsp) {
      runTsp(maskWhere(function (i) { return sat[i] < 60; }), BLACK);
    }
    if (doSq) {
      var sqMask = smoothMask(boolMask(function (i) { return sat[i] < 60 && toneS[i] > shadeThresh; }), nw, nh);
      runSq(sqMask, BLACK);
    }
    // ---- colour layers, one pen per ~3mm cell ----
    var colourInfo = [];
    if (opts.colour) {
      progress("Colour…");
      await tick();
      var labIdx = quantiseToPens(rgb, nw, nh);
      var notPaper = new Uint8Array(N);
      for (var np = 0; np < N; np++) notPaper[np] = paper[np] ? 0 : 1;
      labIdx = cellQuantise(labIdx, nw, nh, Math.max(2, Math.round(3.0 / mmPerPx)), notPaper);
      var counts = new Array(8).fill(0);
      for (var cc = 0; cc < N; cc++) if (!paper[cc]) counts[labIdx[cc]]++;
      var totalPx = Math.max(1, counts.reduce(function (a, b) { return a + b; }, 0));
      for (var tool = 1; tool < 8; tool++) {
        var frac = counts[tool] / totalPx;
        var mask0 = boolMask(function (i) { return labIdx[i] === tool && !paper[i]; });
        var hasMask = false, toneSum = 0, toneCnt = 0;
        for (var mk = 0; mk < N; mk++) {
          if (mask0[mk]) { hasMask = true; toneSum += tone[mk]; toneCnt++; }
        }
        var vivid = hasMask && frac >= 0.0002 && (toneSum / Math.max(1, toneCnt)) > 0.4;
        if (frac < (night ? 0.008 : 0.015) && !vivid) continue;
        var colour = PALETTE[tool];
        var n2 = 0, t2 = 0;
        var before = nTone, beforeMm = mmTone;
        if (doGrad) {
          var subMask = smoothMask(boolMask(function (i) { return mask0[i] && toneS[i] > shadeThresh; }), nw, nh);
          runGrad(subMask, colour, opts.shadingAngle);
          if (shading === "cross") {
            var darkSub = new Uint8Array(N);
            for (var ds = 0; ds < N; ds++) darkSub[ds] = subMask[ds] && toneS[ds] > 0.45 ? 1 : 0;
            runGrad(darkSub, colour, opts.shadingAngle + 90);
          }
        }
        if (doFlow) {
          runFlow(maskWhere(function (i) { return mask0[i]; }), colour, 0);
          if (opts.dramatic) {
            runFlow(maskWhere(function (i) { return mask0[i] && toneS[i] > 0.55; }), colour, Math.PI / 2);
          }
        }
        if (doSq) {
          var sqSub = smoothMask(boolMask(function (i) { return mask0[i] && toneS[i] > shadeThresh; }), nw, nh);
          runSq(sqSub, colour);
        }
        if (doTsp) {
          runTsp(maskWhere(function (i) { return mask0[i]; }), colour);
        }
        n2 = nTone - before; t2 = mmTone - beforeMm;
        colourInfo.push([colour, Math.round(frac * 1000) / 1000, n2, Math.round(t2 / 1000 * 100) / 100]);
      }
    }
    // ---- order paths per pen + plot cost ----
    progress("Ordering…");
    await tick();
    var rePath = /<path d="([^"]+)" stroke="([^"]+)"/;
    var rePt = /[ML]\s*(-?[\d.]+)[ ,](-?[\d.]+)/g;
    var parsed = [];
    for (var ei = 0; ei < emitted.length; ei++) {
      var m = rePath.exec(emitted[ei]);
      if (!m) continue;
      var pts = [], pm;
      rePt.lastIndex = 0;
      while ((pm = rePt.exec(m[1])) !== null) pts.push([parseFloat(pm[1]), parseFloat(pm[2])]);
      if (pts.length >= 2) parsed.push({ colour: m[2], pts: pts });
    }
    var colours = [];
    parsed.forEach(function (p) { if (colours.indexOf(p.colour) === -1) colours.push(p.colour); });
    var ordered = [];
    colours.forEach(function (col) {
      var group = parsed.filter(function (p) { return p.colour === col; }).map(function (p) { return p.pts; });
      orderPolylines(group).forEach(function (pts) { ordered.push({ colour: col, pts: pts }); });
    });
    var penUpMm = 0, lifts = 0, penChanges = 0;
    var prevEnd = [0, 0], prevCol = null;
    ordered.forEach(function (p) {
      penUpMm += Math.hypot(p.pts[0][0] - prevEnd[0], p.pts[0][1] - prevEnd[1]) * mmPerUnit;
      lifts++;
      if (prevCol !== null && p.colour !== prevCol) penChanges++;
      prevEnd = p.pts[p.pts.length - 1]; prevCol = p.colour;
    });
    var lines = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480">'];
    ordered.forEach(function (p) { lines.push(svgPath(p.pts, p.colour)); });
    lines.push("<!-- pen-down " + ((mmStruct + mmTone) / 1000).toFixed(2) + " m, pen-up " + (penUpMm / 1000).toFixed(2) + " m, " + lifts + " lifts, " + penChanges + " pen changes -->");
    lines.push("</svg>");
    var stats = {
      night: night,
      medianLum: Math.round(medianOf(lum) * 10) / 10,
      structurePaths: nStruct,
      structureM: Math.round(mmStruct / 1000 * 100) / 100,
      tonePaths: nTone,
      toneM: Math.round(mmTone / 1000 * 100) / 100,
      penUpM: Math.round(penUpMm / 1000 * 100) / 100,
      lifts: lifts,
      penChanges: penChanges,
      colourLayers: colourInfo,
      ms: Math.round(nowMs() - t0),
    };
    return { svg: lines.join("\n"), stats: stats };
  }

  // Browser entry: accepts a File/Blob, an image/canvas element, an
  // ImageData-like { width, height, data }, or a data-URL string.
  function loadImageElement(source) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("Could not read the photo.")); };
      img.src = source;
    });
  }
  async function convertImage(source, options, onProgress) {
    if (typeof document === "undefined") throw new Error("Photo conversion needs a browser.");
    if (source && typeof source.width === "number" && source.data) {
      return convertPixels(source, options, onProgress);
    }
    var image = null;
    if (typeof Blob !== "undefined" && source instanceof Blob) {
      if (typeof createImageBitmap === "function") {
        image = await createImageBitmap(source);
      } else {
        image = await loadImageElement(URL.createObjectURL(source));
      }
    } else if (typeof source === "string") {
      image = await loadImageElement(source);
    } else if (source && (source.tagName === "IMG" || source.tagName === "CANVAS")) {
      image = source;
    }
    if (!image) throw new Error("Could not read the photo.");
    var iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
    if (!iw || !ih) throw new Error("Photo has no pixels.");
    // Decode cap only: the working resize below is Lanczos and does
    // the real downscaling, so this stays high to avoid pre-softening.
    var scale = Math.min(1, 3200 / Math.max(iw, ih));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(iw * scale));
    canvas.height = Math.max(1, Math.round(ih * scale));
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return convertPixels(ctx.getImageData(0, 0, canvas.width, canvas.height), options, onProgress);
  }

  var api = {
    PALETTE: PALETTE, LINE_WIDTH_MM: LINE_WIDTH_MM,
    convertPixels: convertPixels, convertImage: convertImage,
    rdp: rdp, chaikin: chaikin, orderPolylines: orderPolylines,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (typeof window !== "undefined") window.PhotoSketch = api;
})();



