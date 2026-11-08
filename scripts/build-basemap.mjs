// Builds basemap.json, the route map's background (DESIGN.md "Route map", Base map): land and
// water, town and Boston neighborhood borders and names, and faint subway, Silver Line and
// commuter rail lines. Detailed for the bus service area; for commuter rail's reach, coarser
// Massachusetts towns (land, borders, names; 2026-11-08) and the neighboring states' land.
// Run: NODE_USE_ENV_PROXY=1 node scripts/build-basemap.mjs   (MBTA_API_KEY optional, never stored)
// Sources: MassGIS (towns, water), City of Boston (BPDA neighborhoods), US Census TIGERweb
// (coarse land: MA, RI, NH, CT), the MBTA V3 API (extents, line shapes). Commit basemap.json.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodePolyline, encodePolyline } from '../core.js';
import { simplify, simplifyRing, dissolve, clipRing, clipLine, outsideStrips, ringsOf, ringArea, areaKm2, labelPoint, titleCase } from './basemap-geo.mjs';

const OUT = new URL('../basemap.json', import.meta.url);
const MBTA = 'https://api-v3.mbta.com';
const MASSGIS = 'https://arcgisserver.digital.mass.gov/arcgisserver/rest/services';
const TOWNS = `${MASSGIS}/Basemaps/Mass_Towns_Yellow_Lines_and_Labels/FeatureServer/0/query`;
const HYDRO = `${MASSGIS}/AGOL/Hydro_Major/FeatureServer`;
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2025/State_County/MapServer/7/query';
const BPDA = 'https://data.boston.gov/dataset/bf1a7b50-4c72-4637-b0fa-11d632e3aff1/resource/e5849875-a6f6-4c9c-9d8a-5048b0fbd03e/download/boston_neighborhood_boundaries.geojson';
const CREDIT = 'Base map: MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS; City of Boston; US Census Bureau; MBTA';
const DETAIL_M = 25; // simplification, detailed tier
const COARSE_M = 100; // coarse tier
const MIN_LAKE_M2 = 20_000; // detailed lakes
const MIN_COARSE_LAKE_M2 = 1_000_000;
const PACE_MS = process.env.MBTA_API_KEY ? 0 : 3500; // keyless: 20 requests a minute

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url.split('?')[0]}: HTTP ${res.status}`);
  return res.json();
}
async function mbta(path, params) {
  await new Promise(r => setTimeout(r, PACE_MS));
  const qs = new URLSearchParams(params);
  return getJson(`${MBTA}${path}?${qs}`, { Accept: 'application/vnd.api+json', ...(process.env.MBTA_API_KEY && { 'x-api-key': process.env.MBTA_API_KEY }) });
}
// An ArcGIS layer's features in a rect, as GeoJSON (full resolution: shared edges stay shared).
async function arcgis(url, [w, s, e, n], params = {}) {
  const qs = new URLSearchParams({
    where: '1=1', outFields: '*', geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', f: 'geojson', geometryPrecision: '6', ...params,
  });
  const doc = await getJson(`${url}?${qs}`);
  if (doc.error) throw new Error(`${url}: ${JSON.stringify(doc.error)}`);
  if (doc.exceededTransferLimit || doc.properties?.exceededTransferLimit) throw new Error(`${url}: more features than one page; narrow the query`);
  return doc.features ?? [];
}

const round = x => Math.round(x * 1e4) / 1e4;
const bbox = pts => pts.reduce(([w, s, e, n], [x, y]) => [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)], [Infinity, Infinity, -Infinity, -Infinity]);
const pad = ([w, s, e, n], dLon, dLat) => [w - dLon, s - dLat, e + dLon, n + dLat].map(round);
const enc = pts => encodePolyline(pts.map(([lon, lat]) => ({ lat, lon })));
const dec = str => decodePolyline(str).map(p => [p.lon, p.lat]);
const ringOk = r => r.length >= 3 && ringArea(r) * 1e6 >= 2000;

// The stops of every pattern of these routes: [lon, lat].
async function routeStops(type) {
  const routes = await mbta('/routes', { 'filter[type]': type, 'fields[route]': 'color' });
  const doc = await mbta('/route_patterns', {
    'filter[route]': routes.data.map(r => r.id).join(','), include: 'representative_trip.stops',
    'fields[route_pattern]': 'typicality', 'fields[trip]': '', 'fields[stop]': 'latitude,longitude',
  });
  return { routes, stops: (doc.included ?? []).filter(x => x.type === 'stop' && x.attributes.latitude != null).map(x => [x.attributes.longitude, x.attributes.latitude]) };
}
// Faint lines: [{ k, c, p: [polyline] }] per color.
async function lines(kind, routeIds, canonical) {
  const doc = await mbta('/route_patterns', {
    'filter[route]': routeIds.join(','), ...(canonical && { 'filter[canonical]': 'true' }), 'filter[direction_id]': '0',
    include: 'representative_trip.shape,route', 'fields[route_pattern]': 'typicality', 'fields[trip]': '', 'fields[shape]': 'polyline', 'fields[route]': 'color',
  });
  const inc = new Map((doc.included ?? []).map(x => [`${x.type}/${x.id}`, x]));
  const byColor = new Map();
  for (const p of doc.data) {
    if (!canonical && p.attributes.typicality !== 1) continue;
    const trip = inc.get(`trip/${p.relationships.representative_trip.data.id}`);
    const shape = inc.get(`shape/${trip?.relationships?.shape?.data?.id}`)?.attributes?.polyline;
    if (!shape) continue;
    const color = inc.get(`route/${p.relationships.route.data.id}`)?.attributes?.color ?? '7C878E';
    if (!byColor.has(color)) byColor.set(color, []);
    byColor.get(color).push(enc(simplify(dec(shape), DETAIL_M)));
  }
  return [...byColor].map(([c, p]) => ({ k: kind, c, p }));
}

// 1. Extents: the bus stops' box padded by 1 km (detailed); commuter rail's by 0.3° (coarse).
const bus = await routeStops('3');
const detail = pad(bbox(bus.stops), 1000 / 82_000, 1000 / 111_320);
const cr = await routeStops('2');
const box = pad(bbox(cr.stops), 0.3, 0.3);
console.log('detail', detail.join(','), 'box', box.join(','));

// 2. Faint lines: commuter rail, Silver Line, rapid transit (the draw order).
const faint = [
  ...await lines('cr', cr.routes.data.map(r => r.id), true),
  ...await lines('sl', ['741', '742', '743', '746', '749', '751'], false),
  ...await lines('rt', ['Red', 'Mattapan', 'Orange', 'Blue', 'Green-B', 'Green-C', 'Green-D', 'Green-E'], true),
];

// 3. Towns: one land outline, the borders between towns, a name per town. Fetched over the
// whole box (every Massachusetts town commuter rail reaches): detailed inside `detail`, coarse
// outside it (step 5).
const towns = await arcgis(TOWNS, box, { outFields: 'TOWN' });
const merged = dissolve(towns, f => f.properties.TOWN);
const land = merged.outline.flatMap(r => { const c = clipRing(simplifyRing(r, DETAIL_M), detail); return ringOk(c) ? [enc(c)] : []; });
const townLines = merged.borders.flatMap(l => clipLine(simplify(l, DETAIL_M), detail)).map(enc);
const byTown = new Map();
for (const f of towns) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  byTown.set(f.properties.TOWN, [...(byTown.get(f.properties.TOWN) ?? []), ...polys]);
}
const inRect = ([x, y], [w, s, e, n]) => x >= w && x <= e && y >= s && y <= n;
const names = [];
for (const [town, polys] of byTown) {
  const [lon, lat] = labelPoint(polys);
  if (!inRect([lon, lat], box)) continue;
  names.push({ n: titleCase(town), k: 't', lat: round5(lat), lon: round5(lon), a: Math.round(areaKm2(polys) * 100) / 100, ...(town === 'BOSTON' && { sub: 1 }) });
}
function round5(x) { return Math.round(x * 1e5) / 1e5; }

// 4. Water, detailed: lakes and wide rivers (polygons), narrow rivers (lines).
const lakeFeatures = await arcgis(`${HYDRO}/2/query`, detail, { where: `SQ_METERS>=${MIN_LAKE_M2}`, outFields: 'OBJECTID' });
const lakeIds = new Set(lakeFeatures.map(f => f.properties.OBJECTID));
const lakes = lakeFeatures.flatMap(f => ringsOf(f.geometry)).flatMap(r => { const c = clipRing(simplifyRing(r, DETAIL_M), detail); return c.length >= 3 ? [enc(c)] : []; });
const riverFeatures = await arcgis(`${HYDRO}/1/query`, detail, { outFields: 'OBJECTID' });
const rivers = riverFeatures.flatMap(f => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates))
  .flatMap(l => clipLine(simplify(l, DETAIL_M), detail)).map(enc);

// 5. Coarse tier, outside the detailed rect (with a 50 m overlap): Massachusetts from its towns
// (the shoreline, the borders between towns), the other states' land from the Census; big lakes.
const inner = pad(detail, -50 / 82_000, -50 / 111_320);
const strips = outsideStrips(box, inner);
const outside = rings => rings.map(r => simplifyRing(r, COARSE_M)).flatMap(r => strips.map(st => clipRing(r, st))).filter(ringOk).map(enc);
const states = await arcgis(TIGER, box, { where: "STUSAB IN ('RI','NH','CT')", outFields: 'STUSAB', geometryPrecision: '5' });
const coarse = [...outside(merged.outline), ...outside(states.flatMap(f => ringsOf(f.geometry)))];
townLines.push(...merged.borders.map(l => simplify(l, COARSE_M)).flatMap(l => strips.flatMap(st => clipLine(l, st))).filter(l => l.length >= 2).map(enc));
const bigLakes = await arcgis(`${HYDRO}/2/query`, box, { where: `SQ_METERS>=${MIN_COARSE_LAKE_M2}`, outFields: 'OBJECTID' });
for (const f of bigLakes) {
  if (lakeIds.has(f.properties.OBJECTID)) continue;
  for (const r of ringsOf(f.geometry)) { const s = simplifyRing(r, COARSE_M); if (s.length >= 3) lakes.push(enc(s)); }
}

// 6. Boston neighborhoods (BPDA): borders between them, a name each (not the Harbor Islands).
const bpda = (await getJson(BPDA)).features;
const hoods = dissolve(bpda, f => f.properties.name).borders.map(l => enc(simplify(l, DETAIL_M)));
for (const f of bpda) {
  if (f.properties.name === 'Harbor Islands') continue;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const [lon, lat] = labelPoint(polys);
  names.push({ n: f.properties.name, k: 'h', lat: round5(lat), lon: round5(lon), a: Math.round(areaKm2(polys) * 100) / 100 });
}

// 7. The file.
const doc = { v: 1, built: new Date().toISOString().slice(0, 10), credit: CREDIT, box, detail, coarse, land, lakes, rivers, towns: townLines, hoods, lines: faint, names };
const json = JSON.stringify(doc) + '\n';
writeFileSync(OUT, json);
const kb = x => (Buffer.byteLength(JSON.stringify(x)) / 1024).toFixed(1);
for (const k of ['coarse', 'land', 'lakes', 'rivers', 'towns', 'hoods', 'lines', 'names']) console.log(k.padEnd(7), `${kb(doc[k])} KB`, Array.isArray(doc[k]) ? doc[k].length : '');
console.log(`basemap.json: ${(json.length / 1024).toFixed(1)} KB, ${(gzipSync(json).length / 1024).toFixed(1)} KB gzipped`);
