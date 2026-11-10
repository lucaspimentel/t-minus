// The route map (core.js "route map"): shapes, trimming, the view and the drawn model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapesQuery, decodePolyline, trimShapesDoc, pickPattern, projector, nearestOnPath, trimPath, splitPath, isBusRoute, vehiclesOnStretch, pathHeading, zoomedOut, vehicleShown, ZOOMED_OUT,
  fitView, viewLimits, areaRect, insideReach, wholeView, easeView, nextFollowLevel, viewAt, viewShiftPx, FOLLOW_SPANS, zoomView, panView, routeMapModel, mapPoint, stopListStretch, encodePolyline, basemapLayers, basemapNames, nameBox, stopsToShow, proxyRequestError, distanceMeters,
  placeLabel, PIN_BOX, PIN_LABEL_X,
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
  near(got[0].heading, -90); // north: up on the map
});

test('pathHeading: the travel direction at a segment, skipping zero-length ones', () => {
  const path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  near(pathHeading(path, 0), 0); // east
  near(pathHeading(path, 1), 90); // the empty segment: the next one, south
  near(pathHeading(path, 3), 180); // west
  near(pathHeading(path, 4), 180); // the last point: the segment before
  near(pathHeading([{ x: 5, y: 5 }, { x: 5, y: 5 }], 0), 0); // no length anywhere
});

test('zoomedOut and vehicleShown: past 1.5x the fit, your ride\'s vehicle only', () => {
  const fit = { x: 0, y: 0, w: 1000, h: 2000 };
  assert.equal(ZOOMED_OUT, 1.5);
  assert.equal(zoomedOut({ ...fit, w: 1500 }, fit), false);
  assert.equal(zoomedOut({ ...fit, w: 1501 }, fit), true);
  assert.equal(zoomedOut({ ...fit, w: 400 }, fit), false);
  assert.equal(zoomedOut(null, fit), false);
  assert.equal(vehicleShown({ mine: false }, false), true);
  assert.equal(vehicleShown({ mine: false }, true), false);
  assert.equal(vehicleShown({ mine: true }, true), true);
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

test('viewLimits with the base map\'s area; areaRect; easeView', () => {
  const proj = projector(42.36, -71.06);
  // The commuter rail box (Wickford Junction to Newburyport, Fitchburg to Kingston), 2 km more.
  const area = areaRect([-71.8, 41.58, -70.62, 42.8], proj);
  near(area.w, 100_950, 1500); near(area.h, 139_650, 1500);
  const nw = proj.toXY({ lat: 42.8, lon: -71.8 });
  near(area.x, nw.x - 2000); near(area.y, nw.y - 2000);
  near(areaRect([-71.8, 41.58, -70.62, 42.8], proj, 5000).w, area.w + 6000);
  assert.equal(areaRect(null, proj), null);
  assert.equal(areaRect([1, 2, 3], proj), null);
  assert.equal(areaRect([1, 2, 3, NaN], proj), null);
  // A 2 km trip: pan until the view's edge meets the area's; zoom out until all of it shows.
  const fit = { x: -1000, y: -1000, w: 2000, h: 3000 };
  const lim = viewLimits(fit, { area, aspect: 2 / 3 });
  assert.deepEqual(lim.bounds, area);
  assert.equal(lim.edges, true);
  assert.equal(lim.maxSpan, area.w); // this portrait map: the width decides
  assert.equal(viewLimits(fit, { area, aspect: 2 }).maxSpan, area.h * 2); // landscape: the height
  const out = zoomView(fit, 1e-6, 0, 0, lim);
  near(out.w, area.w); assert.ok(out.h >= area.h);
  near(out.x, area.x); near(out.y + out.h / 2, area.y + area.h / 2); // the long axis centered
  const north = panView(fit, 0, -1e9, lim);
  near(north.y, area.y); // the edge, not the center
  const east = panView(fit, 1e9, 0, lim);
  near(east.x + east.w, area.x + area.w);
  // Without the area: today's limits (the center within 3x the fit); a trip larger than the
  // area: the bound is the two united.
  assert.deepEqual(viewLimits(fit), { minSpan: 150, maxSpan: 4000, bounds: { x: -3000, y: -4000, w: 6000, h: 9000 } });
  const huge = { x: -2e5, y: -2e5, w: 4e5, h: 4e5 };
  const hl = viewLimits(huge, { area, aspect: 1 });
  assert.deepEqual(hl.bounds, { x: Math.min(-2e5, area.x), y: Math.min(-2e5, area.y), w: Math.max(2e5, area.x + area.w) - Math.min(-2e5, area.x), h: Math.max(2e5, area.y + area.h) - Math.min(-2e5, area.y) });
  assert.ok(hl.maxSpan >= 4e5);
});

test('wholeView: fully zoomed out, centered on the bound; insideReach', () => {
  const lim = { minSpan: 150, maxSpan: 100_000, bounds: { x: -50_000, y: -70_000, w: 100_000, h: 140_000 }, edges: true };
  assert.deepEqual(wholeView(lim, 100 / 175), { x: -50_000, y: -87_500, w: 100_000, h: 175_000 }); // portrait: taller than the bound, centered
  const land = { ...lim, maxSpan: 280_000 };
  assert.deepEqual(wholeView(land, 2), { x: -140_000, y: -70_000, w: 280_000, h: 140_000 });
  const reach = [-71.8, 41.58, -70.62, 42.8];
  assert.equal(insideReach(reach, { lat: 42.36, lon: -71.06 }), true);
  assert.equal(insideReach(reach, { lat: 42.8 + 1500 / 111_320, lon: -71.06 }), true); // within 2 km past
  assert.equal(insideReach(reach, { lat: 42.8 + 2500 / 111_320, lon: -71.06 }), false);
  assert.equal(insideReach(reach, { lat: 40.71, lon: -74.0 }), false); // New York
  assert.equal(insideReach(reach, null), false);
  assert.equal(insideReach(null, { lat: 40.71, lon: -74.0 }), true); // no base map: no bound
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
  near(m.vehicles[1].heading, -90); // the train heads north
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

test('splitPath: before, stretch and after; empty ends', () => {
  const path = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 }];
  const s = splitPath(path, { x: 50, y: 5 }, { x: 250, y: -5 });
  assert.deepEqual(s.before, [{ x: 0, y: 0 }, { x: 50, y: 0 }]);
  assert.deepEqual(s.stretch, [{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 250, y: 0 }]);
  assert.deepEqual(s.after, [{ x: 250, y: 0 }, { x: 300, y: 0 }]);
  assert.equal(s.from, 50); assert.equal(s.to, 250);
  const ends = splitPath(path, { x: 0, y: 0 }, { x: 300, y: 0 });
  assert.deepEqual([ends.before, ends.after], [[], []]);
  // A loop: the drop-off is found after the boarding point.
  const loop = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 10 }];
  const l = splitPath(loop, { x: 50, y: 0 }, { x: 0, y: 20 });
  assert.deepEqual(l.stretch.at(-1), { x: 0, y: 20 });
  assert.deepEqual(l.after, [{ x: 0, y: 20 }, { x: 0, y: 10 }]);
  assert.equal(l.to, 100 + 100 + 100 + 80); // along the whole path
});

test('isBusRoute: buses and the Silver Line, not subway, commuter rail or ferries', () => {
  for (const id of ['132', '741', 'SL1']) assert.equal(isBusRoute(id), true, id);
  for (const id of ['Orange', 'Green-E', 'Mattapan', 'CR-Haverhill', 'Boat-F1', '', undefined]) assert.equal(isBusRoute(id), false, String(id));
});

test('routeMapModel: a bus leg\'s whole line, faded outside the stretch; vehicles from its start to the drop-off', () => {
  const kept = trimShapesDoc(doc());
  const now = 1_000;
  const v = (id, k, off = 0.0004) => ({ id, tripId: id, lat: LINE[k].lat + off, lon: -71.07, updatedAt: now });
  const leg = { route: '132', stop: 's1', alight: 's3', label: 'Bus 132', color: 'FFC72C' };
  const vehicles = [[v('coming', 0), v('in', 2), v('past', 3, 0.0007)]];
  const m = routeMapModel({ legs: [leg], shapes: [kept], vehicles, nowMs: now });
  assert.deepEqual(m.legs.map(l => [l.color, !!l.faded, !!l.off]), [['FFC72C', true, true], ['FFC72C', true, true], ['FFC72C', false, false]]);
  assert.ok(m.legs[0].path.at(-1).y === m.legs[2].path[0].y); // before ends where the stretch starts
  assert.deepEqual(m.stops.map(s => [s.id, !!s.off, s.major]), [['s0', true, false], ['s1', false, true], ['s2', false, false], ['s3', false, true], ['s4', true, false]]);
  assert.ok(m.stops.filter(s => s.off).every(s => !s.label));
  assert.deepEqual(m.vehicles.map(x => x.id), ['coming', 'in']); // coming toward the stop; not past the drop-off
  near(m.vehicles[0].heading, -90);
  // The view: the stretch only, as without the whole line.
  const plain = routeMapModel({ legs: [{ ...leg, route: undefined }], shapes: [kept], nowMs: now });
  assert.deepEqual(m.view, plain.view);
  assert.equal(plain.legs.length, 1);
  assert.deepEqual(plain.vehicles, []);
  // A finished bus leg: every part faded. A subway leg: no off parts.
  const done = routeMapModel({ legs: [leg, { ...leg, route: '133' }], shapes: [kept, kept], finished: 1 });
  assert.ok(done.legs.filter(l => l.color && !l.off).map(l => l.faded).join() === 'true,false');
  assert.deepEqual(routeMapModel({ legs: [{ ...leg, route: 'Orange' }], shapes: [kept] }).legs.map(l => !!l.off), [false]);
});

test('stopsToShow: a bus line\'s faded stops thin out when zoomed out', () => {
  const st = (id, y, extra = {}) => ({ id, x: 0, y, major: false, leg: 0, ...extra });
  const stops = [st('o0', 0, { off: true }), st('o1', 50, { off: true }), st('b', 100, { major: true }), st('a', 1000, { major: true }), st('o2', 1050, { off: true }), st('o3', 1100, { off: true })];
  assert.equal(stopsToShow(stops, 1).size, 6);
  const far = stopsToShow(stops, 0.1); // 14 px = 140 m
  assert.ok(far.has(2) && far.has(3));
  assert.ok(far.size < 6);
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
    v: 1, box: [-71.08, 42.39, -71.06, 42.42], land: [sq], green: [sq], coarse: [], lakes: [sq, 5], rivers: [sq], towns: [sq], hoods: [],
    lines: [{ k: 'rt', c: 'DA291C', p: [sq] }, { k: 'cr', c: '80276C', p: [sq] }, { k: 'zz', p: [sq] }, { k: 'sl', c: 'bad', p: [sq] }],
    names: [{ n: 'Malden', k: 't', lat: 42.4, lon: -71.07, a: 13 }, { n: 'Back Bay', k: 'h', lat: 42.41, lon: -71.07, a: 1.6 }, { n: 'Boston', k: 't', lat: 42.35, lon: -71.06, a: 125, sub: 1 }, { n: 5 }],
  };
  const m = basemapLayers(base, o);
  assert.match(m.land, /^M0 0L0 -1112L\d+ -1112Z$/);
  assert.equal(m.lakes, m.land); // a bad entry is skipped
  assert.equal(m.rivers, m.land.slice(0, -1));
  assert.equal(m.coarse, '');
  assert.equal(m.green, m.land); // parks: closed like the land
  assert.equal(basemapLayers({ ...base, green: undefined }, o).green, ''); // a file from before 2026-11-09
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

test('nextFollowLevel: street first, then alternating; after a pinch the farther level', () => {
  assert.equal(nextFollowLevel({ following: false, level: 'area', width: 2000 }), 'street');
  assert.equal(nextFollowLevel({ following: true, level: 'street', width: 5000 }), 'area');
  assert.equal(nextFollowLevel({ following: true, level: 'area', width: 150 }), 'street');
  for (const width of [150, 400, 1199]) assert.equal(nextFollowLevel({ following: true, level: null, width }), 'area');
  for (const width of [1200, 2000, 5000]) assert.equal(nextFollowLevel({ following: true, level: null, width }), 'street');
  assert.deepEqual(FOLLOW_SPANS, { street: 400, area: 2000 });
});

test('viewAt: centered at the span and aspect, within the limits', () => {
  const v = viewAt({ x: 1000, y: 500 }, 400, 0.5);
  assert.deepEqual(v, { x: 800, y: 100, w: 400, h: 800 });
  const fit = { x: 0, y: 0, w: 1000, h: 2000 };
  // Spans clamped: in to minSpan, out to maxSpan (twice the fit without an area).
  near(viewAt({ x: 500, y: 1000 }, 50, 0.5, viewLimits(fit)).w, 150);
  near(viewAt({ x: 500, y: 1000 }, 9000, 0.5, viewLimits(fit)).w, 2000);
  // Without an area: the center kept within the fit grown by its size.
  const far = viewAt({ x: 5000, y: 1000 }, 400, 0.5, viewLimits(fit));
  near(far.x + far.w / 2, 2000);
  // With edges: the view stays inside the bound, so `p` near the edge is off center.
  const lim = viewLimits(fit, { area: { x: 0, y: 0, w: 4000, h: 4000 }, aspect: 0.5 });
  const e = viewAt({ x: 50, y: 2000 }, 400, 0.5, lim);
  near(e.x, 0); near(e.y, 1600);
});

test('viewShiftPx: how far the centers are apart, in screen pixels', () => {
  const a = { x: 0, y: 0, w: 400, h: 800 };
  assert.equal(viewShiftPx(a, a, 400), 0);
  near(viewShiftPx(a, { ...a, x: 2 }, 400), 2);
  near(viewShiftPx(a, { ...a, y: 3, x: 4 }, 200), 2.5);
});

test('routeMapModel fitAlso: the fit takes in the phone without a walk to it', () => {
  const legs = [{ route: 'Orange', direction_id: 0, stop: 'a', alight: 'b', color: 'ED8B00', label: 'Orange' }];
  const fallback = [[{ id: 'a', name: 'A', lat: 42.40, lon: -71.07 }, { id: 'b', name: 'B', lat: 42.36, lon: -71.06 }]];
  const plain = routeMapModel({ legs, fallback });
  const me = { lat: 42.47, lon: -71.10 };
  const m = routeMapModel({ legs, fallback, fitAlso: [me] });
  assert.deepEqual(m.walks, []);
  const p = mapPoint(m, me);
  assert.ok(p.y > m.view.y && p.x > m.view.x && p.y < m.view.y + m.view.h && p.x < m.view.x + m.view.w);
  assert.ok(m.view.w > plain.view.w);
  assert.deepEqual(routeMapModel({ legs, fallback, fitAlso: [null, { lat: NaN, lon: 1 }] }).view, plain.view);
});
test('placeLabel: a place\'s name up to its first comma', () => {
  assert.equal(placeLabel('243 Condor St, East Boston'), '243 Condor St');
  assert.equal(placeLabel('Current location'), 'Current location');
  assert.equal(placeLabel(undefined), null);
  assert.equal(placeLabel(''), null);
  assert.equal(placeLabel(', x'), null);
});

test('fitView boxes: marks of a fixed pixel size fit too', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1000, y: 0 }];
  const plain = fitView(pts, { pad: 0, aspect: 2 });
  assert.deepEqual(fitView(pts, { pad: 0, aspect: 2, boxes: [] }), plain);
  assert.deepEqual(fitView(pts, { pad: 0, aspect: 2, boxes: [{ x: 1000, y: 0, left: 0, right: 50, up: 30, down: 0 }] }), plain); // no width
  const v = fitView(pts, { pad: 0, aspect: 2, width: 200, boxes: [{ x: 1000, y: 0, left: 0, right: 50, up: 30, down: 0 }] });
  const m = v.w / 200;
  assert.ok(1000 + 50 * m <= v.x + v.w + 1e-6);
  assert.ok(0 - 30 * m >= v.y - 1e-6);
  assert.ok(v.w > 1000);
});

test('routeMapModel: start and end pins at the walks\' places, labeled away from the walk; faded start once riding; inside the fit', () => {
  const legs = [{ route: 'Orange', direction_id: 0, stop: 'a', alight: 'b', color: 'ED8B00', label: 'Orange' }];
  const fallback = [[{ id: 'a', name: 'A', lat: 42.40, lon: -71.07 }, { id: 'b', name: 'B', lat: 42.36, lon: -71.06 }]];
  // West of A, east of B: the labels on the far sides (left of the start, right of the end).
  const start = { lat: 42.401, lon: -71.08, name: 'Main St, Melrose' }, end = { lat: 42.359, lon: -71.05, name: 'Current location' };
  const m = routeMapModel({ legs, fallback, start, end, finished: 1, width: 340, aspect: 1.7 });
  assert.deepEqual(m.places.map(p => [p.kind, p.onStop, p.label, p.side, p.faded]),
    [['start', false, 'Main St', 'left', true], ['end', false, 'Current location', 'right', false]]);
  const walk = k => m.walks.find(w => w.kind === k);
  assert.deepEqual([m.places[0].x, m.places[0].y], [walk('start').from.x, walk('start').from.y]);
  assert.deepEqual([m.places[1].x, m.places[1].y], [walk('end').to.x, walk('end').to.y]);
  // Each pin and its label inside the view.
  const mpp = m.view.w / 340;
  for (const p of m.places) {
    const lw = PIN_LABEL_X + 7 * p.label.length;
    const left = p.side === 'left' ? lw : PIN_BOX.left, right = p.side === 'right' ? lw : PIN_BOX.right;
    assert.ok(p.x - left * mpp >= m.view.x - 1e-6 && p.x + right * mpp <= m.view.x + m.view.w + 1e-6);
    assert.ok(p.y - PIN_BOX.up * mpp >= m.view.y - 1e-6 && p.y <= m.view.y + m.view.h + 1e-6);
  }
  assert.ok(m.view.w >= routeMapModel({ legs, fallback, start, end, aspect: 1.7 }).view.w);
  // Mirrored: east of the start, the label on the right.
  const east = routeMapModel({ legs, fallback, start: { ...start, lon: -71.06 } });
  assert.equal(east.places[0].side, 'right');
});

test('routeMapModel: without walks the pins sit on the first and last stops, unlabeled', () => {
  const a = [{ id: 'x0', name: 'A', lat: 42.40, lon: -71.07 }, { id: 'x1', name: 'Hub', lat: 42.41, lon: -71.07 }];
  const b = [{ id: 'y0', name: 'Hub', lat: 42.41, lon: -71.0701 }, { id: 'y1', name: 'B', lat: 42.42, lon: -71.07 }];
  const m = routeMapModel({ legs: [{ stop: 'x0', alight: 'x1' }, { stop: 'y0', alight: 'y1' }], fallback: [a, b] });
  assert.deepEqual(m.places.map(p => [p.kind, p.onStop, p.label, p.faded]), [['start', true, null, false], ['end', true, null, false]]);
  const at = name => { const s = m.stops.find(x => x.name === name); return [s.x, s.y]; };
  assert.deepEqual([m.places[0].x, m.places[0].y], at('A'));
  assert.deepEqual([m.places[1].x, m.places[1].y], at('B'));
  assert.deepEqual(routeMapModel({ legs: [{ stop: 'x0', alight: 'x1' }], shapes: [], fallback: [] }).places, []);
});
