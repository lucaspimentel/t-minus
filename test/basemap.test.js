// The base map's build geometry (scripts/basemap-geo.mjs): simplification, merging towns into
// land and shared borders, clipping, label points and areas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplify, simplifyRing, dissolve, clipRing, clipLine, outsideStrips, ringArea, areaKm2, labelPoint, titleCase, toMeters, tierRings, tierLines } from '../scripts/basemap-geo.mjs';

// A square `km` on a side at (lon0, lat0) as a closed GeoJSON ring.
const { kx, ky } = toMeters(42.4);
const sq = (lon0, lat0, km = 1) => {
  const dx = (km * 1000) / kx, dy = (km * 1000) / ky;
  return [[lon0, lat0], [lon0 + dx, lat0], [lon0 + dx, lat0 + dy], [lon0, lat0 + dy], [lon0, lat0]];
};
const poly = ring => ({ type: 'Polygon', coordinates: [ring] });

test('simplify: ends kept, a vertex 10 m off the line dropped at 25 m, one 40 m off kept', () => {
  const line = [[-71, 42.4], [-70.99, 42.4 + 10 / ky], [-70.98, 42.4]];
  assert.deepEqual(simplify(line, 25), [line[0], line[2]]);
  const bent = [[-71, 42.4], [-70.99, 42.4 + 40 / ky], [-70.98, 42.4]];
  assert.deepEqual(simplify(bent, 25), bent);
  assert.equal(simplifyRing(sq(-71, 42.4), 25).length, 4); // the corners stay; no repeated end
});

test('dissolve: two squares sharing an edge are one outline and one border; the coast is never a border', () => {
  const a = sq(-71, 42.4), b = sq(-71 + 1000 / kx, 42.4);
  const { outline, borders } = dissolve([{ t: 'A', geometry: poly(a) }, { t: 'B', geometry: poly(b) }], f => f.t);
  assert.equal(outline.length, 1);
  assert.equal(outline[0].length, 6); // the 2 × 1 rectangle's ring, the shared edge's ends included
  assert.ok(Math.abs(ringArea(outline[0]) - 2) < 0.01);
  assert.equal(borders.length, 1);
  assert.deepEqual(borders[0].map(p => p[0].toFixed(6)), [b[0][0].toFixed(6), b[0][0].toFixed(6)]);
  // One town alone: no borders.
  assert.deepEqual(dissolve([{ t: 'A', geometry: poly(a) }], f => f.t).borders, []);
  // A town split in two pieces sharing an edge: not a border between towns.
  assert.deepEqual(dissolve([{ t: 'A', geometry: poly(a) }, { t: 'A', geometry: poly(b) }], f => f.t).borders, []);
});

test('clipRing, clipLine, outsideStrips', () => {
  // An L shape (3 unit squares) clipped to its lower row.
  const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  const c = clipRing(L, [0, 0, 2, 1]);
  const area = r => Math.abs(r.reduce((m, p, i) => m + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0)) / 2;
  assert.equal(area(c), 2);
  assert.deepEqual(clipRing(L, [5, 5, 6, 6]), []);
  // A line in, out and back in: two pieces.
  const parts = clipLine([[-1, 0.5], [0.5, 0.5], [0.5, 2], [0.8, 2], [0.8, 0.5], [2, 0.5]], [0, 0, 1, 1]);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], [[0, 0.5], [0.5, 0.5], [0.5, 1]]);
  assert.deepEqual(parts[1], [[0.8, 1], [0.8, 0.5], [1, 0.5]]);
  // The strips and the rect tile the box.
  const box = [0, 0, 10, 10], r = [3, 4, 6, 7];
  const strips = outsideStrips(box, r);
  const a = ([w, s, e, n]) => (e - w) * (n - s);
  assert.equal(strips.reduce((m, x) => m + a(x), 0) + a(r), 100);
});

test('areas, label points, names', () => {
  assert.ok(Math.abs(areaKm2([[sq(-71, 42.4)]]) - 1) < 0.005);
  assert.ok(Math.abs(areaKm2([[sq(-71, 42.4, 2), sq(-70.99, 42.405, 1)]]) - 3) < 0.02); // a hole
  // A C shape: its centroid falls in the gap; the label point stays inside.
  const C = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [3, 2], [3, 3], [0, 3]];
  const p = labelPoint([[C]]);
  assert.ok(p[0] > 0 && p[0] < 1 && p[1] > 0 && p[1] < 3, JSON.stringify(p));
  const sqp = labelPoint([[sq(-71, 42.4)]]);
  assert.ok(sqp[0] > -71 && sqp[1] > 42.4);
  assert.equal(titleCase('MANCHESTER-BY-THE-SEA'), 'Manchester-by-the-Sea');
  assert.equal(titleCase('NORTH READING'), 'North Reading');
  assert.equal(titleCase('BOSTON'), 'Boston');
});

// The committed file (scripts/build-basemap.mjs, 2026-11-08): Massachusetts towns across
// commuter rail's reach, not only the bus service area.
test('basemap.json: town borders, names and coastline outside the detailed area', async () => {
  const { readFileSync } = await import('node:fs');
  const { decodePolyline } = await import('../core.js');
  const base = JSON.parse(readFileSync(new URL('../basemap.json', import.meta.url), 'utf8'));
  const [w, s, e, n] = base.detail;
  const outside = ({ lat, lon }) => lat > n || lat < s || lon > e || lon < w;
  const names = new Map(base.names.map(x => [x.n, x]));
  for (const town of ['Gloucester', 'Newburyport', 'Worcester', 'Fitchburg', 'Fall River', 'Attleboro', 'Plymouth']) {
    assert.ok(names.has(town) && outside(names.get(town)) && names.get(town).k === 't', town);
  }
  assert.ok(names.has('Malden') && !outside(names.get('Malden'))); // the detailed area's, still there
  const pts = list => list.flatMap(decodePolyline);
  assert.ok(pts(base.towns).some(p => p.lat > n + 0.1), 'borders north of the detailed area');
  assert.ok(pts(base.coarse).some(p => p.lat > 42.6 && p.lon > -70.7), 'Cape Ann land');
  assert.equal(new Set(base.names.map(x => `${x.k}:${x.n}`)).size, base.names.length); // one name per town
});

// Lakes from Hydro_100k (2026-11-09): Hydro_Major had no Spot Pond nor the Fells reservoirs.
// Detailed lakes from MassGIS's 1:25,000 layer (2026-11-10): Hydro_100k drew the Charles between
// the Museum of Science dam and the locks as land. Hydro_100k's big lakes stay outside `detail`.
test('basemap.json: Spot Pond and the Charles between its dams are water', async () => {
  const { readFileSync } = await import('node:fs');
  const { decodePolyline } = await import('../core.js');
  const base = JSON.parse(readFileSync(new URL('../basemap.json', import.meta.url), 'utf8'));
  const inside = (pts, { lat, lon }) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.lat > lat) !== (b.lat > lat) && lon < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) c = !c;
    }
    return c;
  };
  const spot = { lat: 42.4557, lon: -71.0967 }; // its centroid
  assert.ok(base.lakes.some(l => inside(decodePolyline(l), spot)), 'Spot Pond');
  assert.ok(!base.lakes.some(l => inside(decodePolyline(l), { lat: 42.4655, lon: -71.0990 })), 'Melrose, not water');
  assert.ok(base.lakes.some(l => inside(decodePolyline(l), { lat: 42.3690, lon: -71.0640 })), 'the Charles between its dams');
  const [w, s, e, n] = base.detail;
  const rings = base.lakes.map(decodePolyline);
  const strictlyIn = p => p.lon > w + 1e-5 && p.lon < e - 1e-5 && p.lat > s + 1e-5 && p.lat < n - 1e-5;
  const outside = rings.filter(r => r.some(p => p.lon < w - 1e-5 || p.lon > e + 1e-5 || p.lat < s - 1e-5 || p.lat > n + 1e-5));
  assert.ok(outside.some(r => r.some(p => p.lon < -71.31)) && outside.some(r => r.some(p => p.lat > 42.6)), 'big lakes west and north of detail');
  for (const r of outside) assert.ok(!r.some(strictlyIn), 'a coarse lake ring reaches inside detail');
});

// Tiers: an inner rect at 5 m and the strips around it inside an outer rect at 20 m.
const tierSet = (inner, outer) => [{ rects: [inner], eps: 5 }, { rects: outsideStrips(outer, inner), eps: 20 }];

test('tierRings: a square across the inner rect\'s edge gives two pieces sharing that edge exactly', () => {
  const s = sq(-71.01, 42.4, 2); // ~2 km square
  const edge = -71.0; // inner rect's west edge cuts it
  const inner = [edge, 42.3, -70.9, 42.5], outer = [-71.2, 42.2, -70.8, 42.6];
  const pieces = tierRings([s.slice(0, -1)], tierSet(inner, outer));
  assert.equal(pieces.length, 2);
  for (const p of pieces) assert.ok(p.some(([x]) => x === edge), 'each piece runs along the shared edge');
  const area = r => Math.abs(ringArea(r));
  assert.ok(Math.abs(area(pieces[0]) + area(pieces[1]) - area(s.slice(0, -1))) < 1e-9); // nothing lost or doubled
});

test('tierRings / tierLines: a vertex 10 m off is kept in the 5 m tier, dropped in the 20 m tier', () => {
  const { kx: x, ky: y } = toMeters(42.4);
  const line = lon0 => [[lon0, 42.4], [lon0 + 500 / x, 42.4 + 10 / y], [lon0 + 1000 / x, 42.4]];
  const inner = [-71.0, 42.3, -70.9, 42.5], outer = [-71.2, 42.2, -70.8, 42.6];
  const t = tierSet(inner, outer);
  assert.deepEqual(tierLines([line(-70.98)], t).map(l => l.length), [3]); // inside: 5 m
  assert.deepEqual(tierLines([line(-71.15)], t).map(l => l.length), [2]); // outside: 20 m
  const ring = lon0 => [...line(lon0), [lon0 + 1000 / x, 42.41], [lon0, 42.41]];
  assert.equal(tierRings([ring(-70.98)], t)[0].length, 5);
  assert.equal(tierRings([ring(-71.15)], t)[0].length, 4);
});

test('tierLines: a line crossing from the inner rect into a strip is split in two at the edge', () => {
  const inner = [-71.0, 42.3, -70.9, 42.5], outer = [-71.2, 42.2, -70.8, 42.6];
  const parts = tierLines([[[-71.1, 42.4], [-70.95, 42.4]]], tierSet(inner, outer));
  assert.equal(parts.length, 2);
  assert.ok(parts.every(p => p.some(([px]) => px === -71.0)));
});
