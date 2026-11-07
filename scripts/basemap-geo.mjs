// Geometry for scripts/build-basemap.mjs (pure: no fetches): simplification in meters, merging
// towns into one land outline with their shared borders, clipping to a rectangle, label points
// and areas. Points are [lon, lat] (GeoJSON order); rects are [west, south, east, north].

const M_PER_DEG = 111_320;
// Meters per degree at `lat0` (equirectangular, fine at city scale).
export const toMeters = lat0 => ({ kx: Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG, ky: M_PER_DEG });

// Douglas–Peucker in meters; the ends are kept.
export function simplify(points, eps) {
  if (points.length < 3) return points.slice();
  const { kx, ky } = toMeters(points[0][1]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = [points[i][0] * kx, points[i][1] * ky], [bx, by] = [points[j][0] * kx, points[j][1] * ky];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let far = -1, dmax = 0;
    for (let k = i + 1; k < j; k++) {
      const px = points[k][0] * kx, py = points[k][1] * ky;
      const d = len ? Math.abs(dy * (px - ax) - dx * (py - ay)) / len : Math.hypot(px - ax, py - ay);
      if (d > dmax) { dmax = d; far = k; }
    }
    if (far >= 0 && dmax > eps) { keep[far] = 1; stack.push([i, far], [far, j]); }
  }
  return points.filter((_, k) => keep[k]);
}

// A closed ring (first point not repeated at the end), simplified: split at its first point and
// the point farthest from it, so both halves keep their ends.
export function simplifyRing(ring, eps) {
  const r = sameP(ring[0], ring.at(-1)) ? ring.slice(0, -1) : ring.slice();
  if (r.length < 4) return r;
  const { kx, ky } = toMeters(r[0][1]);
  let far = 1, dmax = -1;
  for (let k = 1; k < r.length; k++) {
    const d = Math.hypot((r[k][0] - r[0][0]) * kx, (r[k][1] - r[0][1]) * ky);
    if (d > dmax) { dmax = d; far = k; }
  }
  const a = simplify(r.slice(0, far + 1), eps), b = simplify([...r.slice(far), r[0]], eps);
  return [...a, ...b.slice(1, -1)];
}

const sameP = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
const vkey = p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Rings of a GeoJSON Polygon / MultiPolygon geometry.
export const ringsOf = g => (g?.type === 'Polygon' ? g.coordinates : g?.type === 'MultiPolygon' ? g.coordinates.flat() : []);

// Areas (towns, neighborhoods) → { outline: [ring], borders: [line] }: edges used once are the
// outline (the union's boundary, rings for fill-rule evenodd); edges shared by two different
// areas are borders (never the coastline), chained between junctions.
export function dissolve(features, keyOf) {
  const pts = new Map(); // vertex key → [lon, lat]
  const edges = new Map(); // edge key → { a, b, owners: Set, n }
  for (const f of features) {
    const owner = keyOf(f);
    for (const ring of ringsOf(f.geometry)) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = vkey(ring[i]), b = vkey(ring[i + 1]);
        if (a === b) continue;
        pts.set(a, ring[i]); pts.set(b, ring[i + 1]);
        const k = ekey(a, b);
        const e = edges.get(k) ?? { a, b, owners: new Set(), n: 0 };
        e.n++; e.owners.add(owner);
        edges.set(k, e);
      }
    }
  }
  const outline = walk([...edges.values()].filter(e => e.n === 1), pts, true);
  const borders = walk([...edges.values()].filter(e => e.n >= 2 && e.owners.size >= 2), pts, false);
  return { outline, borders };
}

// Chains edges into rings (closed: every vertex has even degree) or lines (broken at junctions).
function walk(list, pts, closed) {
  const adj = new Map();
  for (const e of list) {
    for (const [u, v] of [[e.a, e.b], [e.b, e.a]]) {
      if (!adj.has(u)) adj.set(u, []);
      adj.get(u).push({ v, e });
    }
  }
  const used = new Set();
  const out = [];
  const next = u => adj.get(u)?.find(x => !used.has(x.e));
  const starts = [...adj.keys()].sort((x, y) => (adj.get(y).length !== 2) - (adj.get(x).length !== 2));
  for (const s of starts) {
    while (next(s)) {
      const line = [s];
      let u = s;
      for (;;) {
        const x = next(u);
        if (!x) break;
        used.add(x.e);
        line.push(x.v);
        u = x.v;
        if (u === s) break;
        if (!closed && adj.get(u).length !== 2) break;
      }
      const coords = line.map(k => pts.get(k));
      if (closed) { if (line.length > 3 && line.at(-1) === s) out.push(coords.slice(0, -1)); }
      else out.push(coords);
    }
  }
  return out;
}

// Sutherland–Hodgman: a ring clipped to a rect (convex), [] if nothing is left.
export function clipRing(ring, [w, s, e, n]) {
  let poly = ring;
  const edges = [
    [p => p[0] >= w, (a, b) => at(a, b, (w - a[0]) / (b[0] - a[0]))],
    [p => p[0] <= e, (a, b) => at(a, b, (e - a[0]) / (b[0] - a[0]))],
    [p => p[1] >= s, (a, b) => at(a, b, (s - a[1]) / (b[1] - a[1]))],
    [p => p[1] <= n, (a, b) => at(a, b, (n - a[1]) / (b[1] - a[1]))],
  ];
  for (const [inside, cross] of edges) {
    const res = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
      if (inside(cur)) { if (!inside(prev)) res.push(cross(prev, cur)); res.push(cur); }
      else if (inside(prev)) res.push(cross(prev, cur));
    }
    poly = res;
    if (!poly.length) return [];
  }
  return poly;
}
const at = (a, b, t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];

// Liang–Barsky per segment: the parts of a line inside a rect, split where it leaves.
export function clipLine(line, [w, s, e, n]) {
  const out = [];
  let cur = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let t0 = 0, t1 = 1;
    let ok = true;
    for (const [p, q] of [[-dx, a[0] - w], [dx, e - a[0]], [-dy, a[1] - s], [dy, n - a[1]]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { if (cur) { out.push(cur); cur = null; } continue; }
    const p0 = t0 > 0 ? at(a, b, t0) : a, p1 = t1 < 1 ? at(a, b, t1) : b;
    if (!cur) cur = [p0];
    cur.push(p1);
    if (t1 < 1) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter(l => l.length >= 2);
}

// Four rects covering `box` outside `rect` (inside it): left and right full height, top and
// bottom between them.
export function outsideStrips([W, S, E, N], [w, s, e, n]) {
  return [[W, S, w, N], [e, S, E, N], [w, S, e, s], [w, n, e, N]].filter(([a, b, c, d]) => c > a && d > b);
}

// Area in km² (shoelace in meters; holes, listed after their outer ring, subtract).
export function ringArea(ring) {
  const { kx, ky } = toMeters(ring[0][1]);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * kx * q[1] * ky - q[0] * kx * p[1] * ky;
  }
  return Math.abs(a) / 2 / 1e6;
}
export const areaKm2 = polygons => polygons.reduce((m, poly) => m + ringArea(poly[0]) - poly.slice(1).reduce((h, r) => h + ringArea(r), 0), 0);

function inside(ring, [x, y]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// A label point for an area ([polygon], each [outer, ...holes]): its largest piece's centroid,
// or, when that falls outside the piece (a C shape), the middle of the widest span inside it on
// the centroid's latitude.
export function labelPoint(polygons) {
  const outer = polygons.map(p => p[0]).sort((a, b) => ringArea(b) - ringArea(a))[0];
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < outer.length; i++) {
    const [x0, y0] = outer[i], [x1, y1] = outer[(i + 1) % outer.length];
    const k = x0 * y1 - x1 * y0;
    A += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
  }
  const c = A ? [cx / (3 * A), cy / (3 * A)] : outer[0];
  if (inside(outer, c)) return c;
  const xs = [];
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const [xi, yi] = outer[i], [xj, yj] = outer[j];
    if ((yi > c[1]) !== (yj > c[1])) xs.push(((xj - xi) * (c[1] - yi)) / (yj - yi) + xi);
  }
  xs.sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i + 1 < xs.length; i += 2) if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
  return best ? [(best[0] + best[1]) / 2, c[1]] : outer[0];
}

// "MANCHESTER-BY-THE-SEA" → "Manchester-by-the-Sea"; "NORTH READING" → "North Reading".
const SMALL = new Set(['by', 'the', 'of']);
export const titleCase = name => name.toLowerCase().replace(/[a-z]+/g, (w, i) => (i > 0 && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
