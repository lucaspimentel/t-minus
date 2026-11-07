// The route map (core.js "route map"): shapes, trimming, the view and the drawn model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapesQuery, decodePolyline, trimShapesDoc, pickPattern, projector, nearestOnPath, trimPath, vehiclesOnStretch,
  fitView, viewLimits, zoomView, panView, routeMapModel, mapPoint, stopListStretch, encodePolyline, basemapLayers, basemapNames, nameBox, stopsToShow, proxyRequestError, distanceMeters,
} from '../core.js';

// Encodes [{lat, lon}] the way the MBTA's shapes are (Google polyline, precision 5).
function encode(points) {
  let out = '', plat = 0, plon = 0;
  const one = v => { let x = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (x >= 0x20) { s += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; } return s + String.fromCharCode(x + 63); };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5), lon = Math.round(p.lon * 1e5);
    out += one(lat - plat) + one(lon - plon);
    plat = lat; plon = lon;
  }
  return out;
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// A north-south line of 5 stops (~111 m apart), and the doc /route_patterns returns for it.
const LINE = [0, 1, 2, 3, 4].map(k => ({ id: `s${k}`, name: `Stop ${k}`, lat: Math.round((42.4 + k * 0.001) * 1e5) / 1e5, lon: -71.07 }));
function doc({ patterns = [{ id: 'p1', canonical: false, typicality: 1, stops: LINE.map(s => s.id) }], parent = {} } = {}) {
  return {
    data: patterns.map((p, k) => ({
      type: 'route_pattern', id: p.id, attributes: { canonical: p.canonical, typicality: p.typicality, sort_order: k },
      relationships: { representative_trip: { data: { type: 'trip', id: `t${p.id}` } } },
    })),
    included: [
      ...patterns.map(p => ({ type: 'trip', id: `t${p.id}`, relationships: { shape: { data: { type: 'shape', id: `sh${p.id}` } }, stops: { data: p.stops.map(id => ({ type: 'stop', id })) } } })),
      ...patterns.map(p => ({ type: 'shape', id: `sh${p.id}`, attributes: { polyline: encode(p.stops.map(id => LINE.find(s => s.id === id) ?? LINE[0])) } })),
      ...LINE.map(s => ({ type: 'stop', id: s.id, attributes: { name: s.name, latitude: s.lat + 1e-7, longitude: s.lon }, links: { self: 'x' }, relationships: { parent_station: { data: parent[s.id] ? { id: parent[s.id] } : null } } })),
    ],
  };
}

test('shapesQuery: route and direction only, and the proxy allows it', () => {
  const q = shapesQuery('132', 1);
  assert.deepEqual(Object.keys(q).filter(k => k.startsWith('filter')), ['filter[route]', 'filter[direction_id]']);
  assert.equal(q['filter[direction_id]'], '1');
  assert.equal(proxyRequestError('/route_patterns', Object.entries(q)), null);
  assert.equal(proxyRequestError('/route_patterns', [['filter[stop]', 'x']]), 'filter[stop] is not allowed');
});

test('decodePolyline: Google\'s sample and a round trip', () => {
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(pts.length, 3);
  near(pts[0].lat, 38.5); near(pts[0].lon, -120.2); near(pts[1].lat, 40.7); near(pts[1].lon, -120.95); near(pts[2].lat, 43.252); near(pts[2].lon, -126.453);
  assert.deepEqual(decodePolyline(encode(LINE)).map(p => [p.lat, p.lon]), LINE.map(s => [s.lat, s.lon]));
  assert.deepEqual(decodePolyline(''), []);
});

test('trimShapesDoc: patterns with their stops, no included records', () => {
  const kept = trimShapesDoc(doc({ parent: { s0: 'place-x' } }));
  assert.deepEqual(Object.keys(kept), ['patterns', 'stops']);
  assert.deepEqual(Object.keys(kept.patterns[0]), ['id', 'canonical', 'typicality', 'sort', 'polyline', 'stops']);
  assert.deepEqual(kept.stops.s0, { name: 'Stop 0', lat: 42.4, lon: -71.07, parent: 'place-x' });
  assert.equal(kept.stops.s1.parent, null);
  assert.ok(JSON.stringify(kept).length < JSON.stringify(doc()).length);
  // A pattern without a shape is dropped.
  const d = doc(); d.included = d.included.filter(x => x.type !== 'shape');
  assert.deepEqual(trimShapesDoc(d).patterns, []);
  assert.deepEqual(trimShapesDoc(null), { patterns: [], stops: {} });
});

test('pickPattern: both stops in order; canonical, then typical; parent stations match', () => {
  const kept = trimShapesDoc(doc({
    patterns: [
      { id: 'short', canonical: false, typicality: 1, stops: ['s0', 's1', 's2'] },
      { id: 'odd', canonical: false, typicality: 3, stops: ['s0', 's1', 's2', 's3', 's4'] },
      { id: 'main', canonical: false, typicality: 1, stops: ['s0', 's1', 's2', 's3', 's4'] },
    ],
    parent: { s1: 'place-a', s3: 'place-b' },
  }));
  assert.deepEqual(pickPattern(kept, 's1', 's3'), { pattern: kept.patterns[2], from: 1, to: 3 });
  assert.equal(pickPattern(kept, 'place-a', 'place-b').pattern.id, 'main');
  assert.equal(pickPattern(kept, 's0', 's2').pattern.id, 'short'); // the first of the most typical
  assert.equal(pickPattern(kept, 's3', 's1'), null); // the wrong way
  assert.equal(pickPattern(kept, 's1', 'nope'), null);
  kept.patterns[1].canonical = true;
  assert.equal(pickPattern(kept, 's0', 's2').pattern.id, 'odd');
  // An atypical pattern alone serving both stops is still used.
  const only = trimShapesDoc(doc({ patterns: [{ id: 'odd', canonical: false, typicality: 4, stops: ['s0', 's4'] }] }));
  assert.equal(pickPattern(only, 's0', 's4').pattern.id, 'odd');
});

test('projector: meters east and south of the origin, matching distanceMeters', () => {
  const o = { lat: 42.36, lon: -71.06 };
  const p = projector(o.lat, o.lon);
  const ne = { lat: 42.36 + 1000 / 111_195, lon: -71.06 + 1000 / (111_195 * Math.cos(42.36 * Math.PI / 180)) };
  const q = p.toXY(ne);
  assert.ok(Math.abs(q.x - 1000) < 10 && Math.abs(q.y + 1000) < 10, JSON.stringify(q)); // north is up (y < 0)
  assert.ok(Math.abs(Math.hypot(q.x, q.y) / distanceMeters(o, ne) - 1) < 0.01);
  const back = p.toLatLon(q);
  near(back.lat, ne.lat); near(back.lon, ne.lon);
});

test('nearestOnPath and trimPath: projected ends, loops searched after the start', () => {
  const L = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.deepEqual(nearestOnPath(L, { x: 50, y: 10 }), { index: 0, t: 0.5, point: { x: 50, y: 0 }, along: 50, meters: 10 });
  assert.equal(nearestOnPath(L, { x: 120, y: 50 }).along, 150);
  const t = trimPath(L, { x: 20, y: 5 }, { x: 105, y: 60 });
  assert.deepEqual(t.path, [{ x: 20, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }]);
  assert.deepEqual([t.from, t.to], [20, 160]);
  // A loop: out along y = 0 and back along y = 10; the drop-off near the start is on the way back.
  const loop = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 10 }, { x: 0, y: 10 }];
  const back = trimPath(loop, { x: 150, y: 1 }, { x: 10, y: 4 });
  assert.deepEqual(back.path.at(-1), { x: 10, y: 10 });
  assert.equal(back.to, 200 + 10 + 190);
  // The same segment, the drop-off first: no backward stretch.
  const same = trimPath([{ x: 0, y: 0 }, { x: 100, y: 0 }], { x: 60, y: 0 }, { x: 30, y: 0 });
  assert.equal(same.from, same.to);
});

test('vehiclesOnStretch: fresh, on the path, between the stops', () => {
  const proj = projector(42.4, -71.07);
  const path = [proj.toXY({ lat: 42.4, lon: -71.07 }), proj.toXY({ lat: 42.41, lon: -71.07 })]; // ~1112 m north
  const now = 1_000_000;
  const v = (id, lat, lon, age = 0) => ({ id, tripId: `t${id}`, lat, lon, updatedAt: now - age });
  const got = vehiclesOnStretch([
    v('in', 42.405, -71.07), v('before', 42.39, -71.07), v('after', 42.42, -71.07),
    v('off', 42.405, -71.06), v('stale', 42.405, -71.07, 91_000), v('fresh', 42.402, -71.0701, 89_000),
  ], path, 100, 1000, proj, now);
  assert.deepEqual(got.map(x => x.id), ['in', 'fresh']);
  assert.ok(Math.abs(got[0].point.x) < 1e-6);
  assert.deepEqual(vehiclesOnStretch(undefined, path, 0, 1, proj, now), []);
});

test('fitView, zoomView and panView', () => {
  const v = fitView([{ x: 0, y: 0 }, { x: 1000, y: 500 }], { pad: 0, aspect: 1 });
  assert.deepEqual(v, { x: 0, y: -250, w: 1000, h: 1000 });
  assert.deepEqual(fitView([{ x: 0, y: 0 }], { minSpan: 400, aspect: 2 }), { x: -400, y: -200, w: 800, h: 400 });
  assert.equal(fitView([], { minSpan: 400 }).w, 400);
  const lim = viewLimits(v);
  // Zooming about a point keeps it in place.
  const z = zoomView(v, 2, 250, 0, lim);
  assert.equal(z.w, 500); assert.equal(z.h, 500);
  near((250 - z.x) / z.w, (250 - v.x) / v.w);
  // Clamped: no closer than 150 m, no wider than twice the fit.
  assert.equal(zoomView(v, 100, 0, 0, lim).w, 150);
  assert.equal(zoomView(v, 0.01, 0, 0, lim).w, 2000);
  // Panning moves the view, and the center stays within the bounds.
  assert.deepEqual(panView(v, 100, -50, lim), { x: 100, y: -300, w: 1000, h: 1000 });
  const far = panView(v, 1e6, 0, lim);
  assert.equal(far.x + far.w / 2, lim.bounds.x + lim.bounds.w);
});

test('routeMapModel: legs from shapes, transfer and end walks, fallbacks, faded legs, vehicles', () => {
  const bus = trimShapesDoc(doc({ patterns: [{ id: 'b', canonical: false, typicality: 1, stops: ['s0', 's1', 's2'] }] }));
  // The train starts 300 m east of the bus's last stop.
  const train = [{ id: 'r0', name: 'Station', lat: 42.402, lon: -71.0663 }, { id: 'r1', name: 'Mid', lat: 42.405, lon: -71.0663 }, { id: 'r2', name: 'End', lat: 42.41, lon: -71.0663 }];
  const legs = [
    { route: '132', direction_id: 1, stop: 's0', alight: 's2', color: 'FFC72C', label: 'Bus 132' },
    { route: 'Orange', direction_id: 0, stop: 'r0', alight: 'r2', color: 'ED8B00', label: 'Orange' },
  ];
  const now = 5_000_000;
  const m = routeMapModel({
    legs, shapes: [bus, null], fallback: [null, train], start: { lat: 42.399, lon: -71.07 }, end: { lat: 42.41, lon: -71.065 }, finished: 1,
    vehicles: [[{ id: 'v1', tripId: 'a', lat: 42.401, lon: -71.07, updatedAt: now }], [{ id: 'v2', tripId: 'b', lat: 42.406, lon: -71.0663, updatedAt: now }, { id: 'v3', tripId: 'c', lat: 42.42, lon: -71.0663, updatedAt: now }]],
    mine: [null, 'b'], nowMs: now,
  });
  assert.deepEqual(m.origin, { lat: 42.4, lon: -71.07 });
  assert.equal(m.legs.length, 2);
  assert.deepEqual(m.legs.map(l => [l.color, l.faded]), [['FFC72C', true], ['ED8B00', false]]);
  assert.equal(m.legs[1].path.length, 3); // straight lines through the stops
  assert.deepEqual(m.stops.filter(s => s.major).map(s => [s.name, s.label]), [['Stop 0', true], ['Stop 2', true], ['Station', true], ['End', true]]);
  assert.deepEqual(m.stops.filter(s => !s.major).map(s => s.name), ['Stop 1', 'Mid']);
  assert.deepEqual(m.walks.map(w => w.kind), ['transfer', 'start', 'end']);
  assert.deepEqual(m.vehicles.map(v => [v.id, v.label, v.mine]), [['v1', '132', false], ['v2', 'OL', true]]);
  // The view holds every leg and walk.
  for (const p of [...m.legs.flatMap(l => l.path), ...m.walks.flatMap(w => [w.from, w.to])]) {
    assert.ok(p.x >= m.view.x && p.x <= m.view.x + m.view.w && p.y >= m.view.y && p.y <= m.view.y + m.view.h);
  }
  const here = mapPoint(m, { lat: 42.4, lon: -71.07 });
  near(here.x, 0); near(here.y, 0);
  // No shape and no fallback: the leg is left out; nothing at all: an empty map.
  const one = routeMapModel({ legs, shapes: [bus, null], fallback: [] });
  assert.equal(one.legs.length, 1);
  assert.deepEqual(one.walks, []);
  const none = routeMapModel({ legs, shapes: [], fallback: [] });
  assert.deepEqual([none.origin, none.legs, mapPoint(none, { lat: 1, lon: 1 })], [null, [], null]);
});

test('routeMapModel: a transfer at one station is one labeled dot, with no walk', () => {
  const a = [{ id: 'x0', name: 'A', lat: 42.40, lon: -71.07 }, { id: 'x1', name: 'Hub', lat: 42.41, lon: -71.07 }];
  const b = [{ id: 'y0', name: 'Hub', lat: 42.41, lon: -71.0701 }, { id: 'y1', name: 'B', lat: 42.42, lon: -71.07 }];
  const m = routeMapModel({ legs: [{ stop: 'x0', alight: 'x1' }, { stop: 'y0', alight: 'y1' }], fallback: [a, b] });
  assert.deepEqual(m.stops.map(s => s.name), ['A', 'Hub', 'B']);
  assert.deepEqual(m.walks, []);
});

test('stopListStretch: boarding to drop-off from a kept stop list, child stops matching', () => {
  const doc = { data: LINE.map((x, k) => ({ id: x.id, attributes: { name: x.name, latitude: x.lat, longitude: x.lon }, relationships: { child_stops: { data: k === 3 ? [{ id: '70001' }] : [] } } })) };
  assert.deepEqual(stopListStretch(doc, 's1', '70001').map(x => x.id), ['s1', 's2', 's3']);
  assert.deepEqual(stopListStretch(doc, 's1', 's2')[0], { id: 's1', name: 'Stop 1', lat: LINE[1].lat, lon: -71.07 });
  assert.equal(stopListStretch(doc, 's3', 's1'), null);
  assert.equal(stopListStretch(null, 's1', 's2'), null);
});

test('routeMapModel: a transfer between differently named stops close by keeps the next leg\'s label', () => {
  const a = [{ id: 'x0', name: 'A', lat: 42.40, lon: -71.07 }, { id: 'x1', name: 'Washington St opp Oak Grove Sta', lat: 42.41, lon: -71.07 }];
  const b = [{ id: 'y0', name: 'Oak Grove', lat: 42.4102, lon: -71.0703 }, { id: 'y1', name: 'B', lat: 42.42, lon: -71.07 }];
  const m = routeMapModel({ legs: [{ stop: 'x0', alight: 'x1' }, { stop: 'y0', alight: 'y1' }], fallback: [a, b] });
  assert.deepEqual(m.stops.map(s => [s.name, s.label]), [['A', true], ['Washington St opp Oak Grove Sta', false], ['Oak Grove', true], ['B', true]]);
});

test('routeMapModel: vehicles on a trimmed shape are measured along the leg, not the whole route', () => {
  const kept = trimShapesDoc(doc());
  const now = 1_000;
  const v = (id, k, off = 0.0004) => ({ id, tripId: id, lat: LINE[k].lat + off, lon: -71.07, updatedAt: now });
  // The leg runs from s2 to s4 (the shape's end): 'after' is ~220 m past it.
  const m = routeMapModel({ legs: [{ stop: 's2', alight: 's4', label: 'Bus 132' }], shapes: [kept], vehicles: [[v('before', 0), v('in', 2), v('in2', 3), v('after', 4, 0.002)]], nowMs: now });
  assert.deepEqual(m.vehicles.map(x => x.id), ['in', 'in2']);
});

test('encodePolyline: decodePolyline\'s inverse', () => {
  assert.equal(encodePolyline(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(encodePolyline(LINE), encode(LINE));
  assert.equal(encodePolyline([]), '');
});

test('basemapLayers: paths in meters from the origin, the water rect, lines in draw order, names', () => {
  const o = { lat: 42.4, lon: -71.07 };
  const sq = encodePolyline([{ lat: 42.4, lon: -71.07 }, { lat: 42.41, lon: -71.07 }, { lat: 42.41, lon: -71.06 }]);
  const base = {
    v: 1, box: [-71.08, 42.39, -71.06, 42.42], land: [sq], coarse: [], lakes: [sq, 5], rivers: [sq], towns: [sq], hoods: [],
    lines: [{ k: 'rt', c: 'DA291C', p: [sq] }, { k: 'cr', c: '80276C', p: [sq] }, { k: 'zz', p: [sq] }, { k: 'sl', c: 'bad', p: [sq] }],
    names: [{ n: 'Malden', k: 't', lat: 42.4, lon: -71.07, a: 13 }, { n: 'Back Bay', k: 'h', lat: 42.41, lon: -71.07, a: 1.6 }, { n: 'Boston', k: 't', lat: 42.35, lon: -71.06, a: 125, sub: 1 }, { n: 5 }],
  };
  const m = basemapLayers(base, o);
  assert.match(m.land, /^M0 0L0 -1112L\d+ -1112Z$/);
  assert.equal(m.lakes, m.land); // a bad entry is skipped
  assert.equal(m.rivers, m.land.slice(0, -1));
  assert.equal(m.coarse, '');
  assert.deepEqual(m.lines.map(l => [l.kind, l.color]), [['cr', '80276C'], ['sl', null], ['rt', 'DA291C']]);
  assert.ok(Math.abs(m.water.x + 822) < 2 && Math.abs(m.water.y + 2224) < 2 && Math.abs(m.water.w - 1644) < 3 && Math.abs(m.water.h - 3336) < 3, JSON.stringify(m.water));
  assert.deepEqual(m.names.map(n => [n.name, n.kind, n.sub]), [['Malden', 'town', false], ['Back Bay', 'hood', false], ['Boston', 'town', true]]);
  assert.equal(basemapLayers({ ...base, v: 2 }, o), null);
  assert.equal(basemapLayers(base, null), null);
  assert.equal(basemapLayers(null, o), null);
});

test('basemapNames: neighborhoods only zoomed in, Boston only zoomed out, fully inside, larger first', () => {
  const size = { width: 300, height: 600 };
  const view = (w, cx = 0, cy = 0) => ({ x: cx - w / 2, y: cy - w, w, h: w * 2 });
  const names = [
    { name: 'Malden', kind: 'town', x: 0, y: -2000, area: 13 },
    { name: 'Boston', kind: 'town', x: 0, y: 1000, area: 125, sub: true },
    { name: 'Downtown', kind: 'hood', x: 0, y: 0, area: 2.9 },
    { name: 'North End', kind: 'hood', x: 150, y: 20, area: 0.5 },
    { name: 'Medford', kind: 'town', x: -4400, y: -1000, area: 22 },
  ];
  const at = (v, opts) => [...basemapNames(names, v, size, opts)].map(i => names[i].name).sort();
  // 9 km across: neighborhoods; North End overlaps Downtown (smaller, hidden); Medford is cut off.
  assert.deepEqual(at(view(9000)), ['Downtown', 'Malden']);
  // 11 km: towns only, Boston too.
  assert.deepEqual(at(view(11_000)), ['Boston', 'Malden', 'Medford']);
  // Zoomed in, the two neighborhoods separate.
  assert.deepEqual(at(view(500)), ['Downtown', 'North End']);
  // Panned west, Medford fits.
  assert.ok(at(view(9000, -3000)).includes('Medford'));
  // A town beats an overlapping neighborhood.
  const clash = [{ name: 'Chelsea', kind: 'town', x: 0, y: 0, area: 6 }, { name: 'East Boston', kind: 'hood', x: 10, y: 10, area: 12 }];
  assert.deepEqual([...basemapNames(clash, view(5000), size)], [0]);
  assert.deepEqual(nameBox('Malden', 'town'), { w: 6 * 7.9, h: 11 });
  assert.equal(basemapNames(names, null, size).size, 0);
});

test('stopsToShow: leg ends always; intermediate stops only with room between them', () => {
  // A leg of stops 100 m apart (ends major), then a second leg.
  const legA = [0, 100, 200, 300, 400].map((y, k) => ({ id: `a${k}`, x: 0, y, major: k === 0 || k === 4, leg: 0 }));
  const legB = [{ id: 'b0', x: 50, y: 400, major: true, leg: 1 }, { id: 'b1', x: 50, y: 600, major: false, leg: 1 }, { id: 'b2', x: 50, y: 900, major: true, leg: 1 }];
  const stops = [...legA, ...legB];
  const ids = (ppm, opts) => [...stopsToShow(stops, ppm, opts)].map(i => stops[i].id);
  // Zoomed in (0.2 px/m: 20 px apart): every stop.
  assert.deepEqual(ids(0.2), stops.map(s => s.id));
  // Zoomed out (0.1 px/m: 10 px apart): every other stop, never next to the end; leg B's (20 px) kept.
  assert.deepEqual(ids(0.1), ['a0', 'a2', 'a4', 'b0', 'b1', 'b2']);
  // Far out: the ends only, and a selected stop.
  assert.deepEqual(ids(0.01), ['a0', 'a4', 'b0', 'b2']);
  assert.deepEqual(ids(0.01, { keep: 'a1' }), ['a0', 'a1', 'a4', 'b0', 'b2']);
});
