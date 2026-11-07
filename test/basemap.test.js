// The base map's build geometry (scripts/basemap-geo.mjs): simplification, merging towns into
// land and shared borders, clipping, label points and areas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplify, simplifyRing, dissolve, clipRing, clipLine, outsideStrips, ringArea, areaKm2, labelPoint, titleCase, toMeters } from '../scripts/basemap-geo.mjs';

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
