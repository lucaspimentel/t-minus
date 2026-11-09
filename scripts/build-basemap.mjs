// Builds basemap.json, the route map's background (DESIGN.md "Route map", Base map): land and
// water, town and Boston neighborhood borders and names, and faint subway, Silver Line and
// commuter rail lines, and green areas (parks, reservations). Three tiers of detail (2026-11-09):
// 5 m in the inner rect (downtown), 20 m over the rest of the bus service area, and for commuter
// rail's reach, 100 m Massachusetts towns (land, borders, names; 2026-11-08) and the neighboring
// states' land.
// Run: NODE_USE_ENV_PROXY=1 node scripts/build-basemap.mjs   (MBTA_API_KEY optional, never stored)
// Sources: MassGIS (towns; lakes from Hydro_100k, rivers from Hydro_Major; open space), City of Boston (BPDA neighborhoods), US Census TIGERweb
// (coarse land: MA, RI, NH, CT), the MBTA V3 API (extents, line shapes). Commit basemap.json.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodePolyline, encodePolyline } from '../core.js';
import { simplify, simplifyRing, dissolve, clipRing, clipLine, outsideStrips, ringsOf, ringArea, areaKm2, labelPoint, titleCase, tierRings, tierLines } from './basemap-geo.mjs';

const OUT = new URL('../basemap.json', import.meta.url);
const MBTA = 'https://api-v3.mbta.com';
const MASSGIS = 'https://arcgisserver.digital.mass.gov/arcgisserver/rest/services';
const TOWNS = `${MASSGIS}/Basemaps/Mass_Towns_Yellow_Lines_and_Labels/FeatureServer/0/query`;
const HYDRO = `${MASSGIS}/AGOL/Hydro_Major/FeatureServer`; // rivers (lines)
// Lakes and wide rivers (2026-11-09): USGS 1:100,000 hydrography; Hydro_Major left out Spot Pond
// and the Middlesex Fells reservoirs.
const LAKES = `${MASSGIS}/AGOL/Hydro_100k/FeatureServer/2/query`;
// Green areas (2026-11-09): Protected and Recreational OpenSpace, full public access.
const OPEN = `${MASSGIS}/AGOL/openspace/FeatureServer/0/query`;
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2025/State_County/MapServer/7/query';
const BPDA = 'https://data.boston.gov/dataset/bf1a7b50-4c72-4637-b0fa-11d632e3aff1/resource/e5849875-a6f6-4c9c-9d8a-5048b0fbd03e/download/boston_neighborhood_boundaries.geojson';
const CREDIT = 'Base map: MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS; City of Boston; US Census Bureau; MBTA';
// The inner tier's rect [w, s, e, n] (2026-11-09), each edge 1 km past its anchor: west Boston
// College (place-lake, -71.166769), south Fields Corner (place-fldcr, 42.300093), east Wonderland
// (place-wondl, -70.991648), north the 132's Main St @ South St (stop 25996, 42.466624).
const INNER = [-71.1790, 42.2911, -70.9792, 42.4756];
const INNER_M = 5; // simplification, inner tier
const MID_M = 20; // the rest of the bus service area
const COARSE_M = 100; // commuter rail's reach
const MIN_GREEN_ACRES = 20; // a site: parcels sharing a town and name, summed
const MIN_LAKE_M2 = 20_000; // detailed lakes
const MIN_COARSE_LAKE_M2 = 1_000_000;
const PACE_MS = process.env.MBTA_API_KEY ? 0 : 3500; // keyless: 20 requests a minute

// Every page of an ArcGIS layer's features in a rect (more than one page's worth).
async function arcgisAll(url, [w, s, e, n], params = {}) {
  const out = [];
  for (let offset = 0; ; offset += 2000) {
    const qs = new URLSearchParams({
      where: '1=1', outFields: '*', geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', f: 'geojson', geometryPrecision: '6', orderByFields: 'OBJECTID',
      resultOffset: String(offset), resultRecordCount: '2000', ...params,
    });
    const doc = await getJson(`${url}?${qs}`);
    if (doc.error) throw new Error(`${url}: ${JSON.stringify(doc.error)}`);
    const page = doc.features ?? [];
    if (!page.length) return out;
    out.push(...page);
  }
}
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
// An ArcGIS layer's features in a rect, as GeoJSON (full resolution: shared edges stay shared),
// page by page (a server returns up to its maxRecordCount at a time).
async function arcgis(url, [w, s, e, n], params = {}) {
  const out = [];
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({
      where: '1=1', outFields: '*', geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', f: 'geojson', geometryPrecision: '6', orderByFields: 'OBJECTID', resultOffset: String(out.length), ...params,
    });
    const doc = await getJson(`${url}?${qs}`);
    if (doc.error) throw new Error(`${url}: ${JSON.stringify(doc.error)}`);
    const got = doc.features ?? [];
    out.push(...got);
    if (!(doc.exceededTransferLimit || doc.properties?.exceededTransferLimit) || !got.length) return out;
  }
  throw new Error(`${url}: over 50 pages`);
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
    byColor.get(color).push(...[...tierLines([dec(shape)], TIERS), ...tierLines([dec(shape)], OUTSIDE)].map(enc));
  }
  return [...byColor].map(([c, p]) => ({ k: kind, c, p }));
}

// 1. Extents: the bus stops' box padded by 1 km (detailed); commuter rail's by 0.3° (coarse).
const bus = await routeStops('3');
const detail = pad(bbox(bus.stops), 1000 / 82_000, 1000 / 111_320);
const cr = await routeStops('2');
const reach = pad(bbox(cr.stops), 0, 0); // the sheet pans and zooms out over it (2026-11-08)
const box = pad(bbox(cr.stops), 0.3, 0.3);
console.log('detail', detail.join(','), 'box', box.join(','));
if (!(INNER[0] > detail[0] && INNER[1] > detail[1] && INNER[2] < detail[2] && INNER[3] < detail[3])) throw new Error(`INNER ${INNER} is not inside detail ${detail}`);
// Inner and middle rects share edges and don't overlap (one path each, no evenodd holes); faint
// lines outside the bus area keep the middle tier's 20 m (the coarse land overlaps them by 50 m).
const TIERS = [{ rects: [INNER], eps: INNER_M }, { rects: outsideStrips(detail, INNER), eps: MID_M }];
const OUTSIDE = [{ rects: outsideStrips(box, detail), eps: MID_M }];

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
const land = tierRings(merged.outline, TIERS, ringOk).map(enc);
const townLines = tierLines(merged.borders, TIERS).map(enc);
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
const lakeFeatures = await arcgis(LAKES, detail, { where: `Shape__Area>=${MIN_LAKE_M2}`, outFields: 'OBJECTID' });
const lakeIds = new Set(lakeFeatures.map(f => f.properties.OBJECTID));
const lakes = tierRings(lakeFeatures.flatMap(f => ringsOf(f.geometry)), TIERS).map(enc);
const riverFeatures = await arcgis(`${HYDRO}/1/query`, detail, { outFields: 'OBJECTID' });
const rivers = tierLines(riverFeatures.flatMap(f => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates)), TIERS).map(enc);

// 4b. Green areas: public open space (not farms, water supply, flood control or underwater; the
// Public Garden is "Other"), sites of MIN_GREEN_ACRES or more, merged into one outline.
const open = await arcgisAll(OPEN, detail, { where: "PUB_ACCESS = 'Y' AND PRIM_PURP NOT IN ('A','W','F','U')", outFields: 'OBJECTID,TOWN_ID,SITE_NAME,GIS_ACRES' });
const sites = new Map();
for (const f of open) {
  if (!f.geometry) continue;
  const name = (f.properties.SITE_NAME ?? '').trim().toUpperCase();
  const key = name ? `${f.properties.TOWN_ID}|${name}` : `#${f.properties.OBJECTID}`;
  const site = sites.get(key) ?? { acres: 0, features: [] };
  site.acres += f.properties.GIS_ACRES ?? 0;
  site.features.push(f);
  sites.set(key, site);
}
const parks = [...sites.values()].filter(x => x.acres >= MIN_GREEN_ACRES).flatMap(x => x.features);
const green = tierRings(dissolve(parks, () => 'all').outline, TIERS, ringOk).map(enc);
console.log('open space', open.length, 'parcels,', parks.length, 'kept');

// 5. Coarse tier, outside the detailed rect (with a 50 m overlap): Massachusetts from its towns
// (the shoreline, the borders between towns), the other states' land from the Census; big lakes.
const inner = pad(detail, -50 / 82_000, -50 / 111_320);
const strips = outsideStrips(box, inner);
const outside = rings => rings.map(r => simplifyRing(r, COARSE_M)).flatMap(r => strips.map(st => clipRing(r, st))).filter(ringOk).map(enc);
const states = await arcgis(TIGER, box, { where: "STUSAB IN ('RI','NH','CT')", outFields: 'STUSAB', geometryPrecision: '5' });
const coarse = [...outside(merged.outline), ...outside(states.flatMap(f => ringsOf(f.geometry)))];
townLines.push(...merged.borders.map(l => simplify(l, COARSE_M)).flatMap(l => strips.flatMap(st => clipLine(l, st))).filter(l => l.length >= 2).map(enc));
const bigLakes = await arcgis(LAKES, box, { where: `Shape__Area>=${MIN_COARSE_LAKE_M2}`, outFields: 'OBJECTID' });
for (const f of bigLakes) {
  if (lakeIds.has(f.properties.OBJECTID)) continue;
  for (const r of ringsOf(f.geometry)) { const s = simplifyRing(r, COARSE_M); if (s.length >= 3) lakes.push(enc(s)); }
}

// 6. Boston neighborhoods (BPDA): borders between them, a name each (not the Harbor Islands).
const bpda = (await getJson(BPDA)).features;
const hoods = tierLines(dissolve(bpda, f => f.properties.name).borders, TIERS).map(enc);
for (const f of bpda) {
  if (f.properties.name === 'Harbor Islands') continue;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const [lon, lat] = labelPoint(polys);
  names.push({ n: f.properties.name, k: 'h', lat: round5(lat), lon: round5(lon), a: Math.round(areaKm2(polys) * 100) / 100 });
}

// 7. The file.
const doc = { v: 1, built: new Date().toISOString().slice(0, 10), credit: CREDIT, box, detail, inner: INNER, reach, coarse, land, green, lakes, rivers, towns: townLines, hoods, lines: faint, names };
const json = JSON.stringify(doc) + '\n';
writeFileSync(OUT, json);
const kb = x => (Buffer.byteLength(JSON.stringify(x)) / 1024).toFixed(1);
for (const k of ['coarse', 'land', 'green', 'lakes', 'rivers', 'towns', 'hoods', 'lines', 'names']) console.log(k.padEnd(7), `${kb(doc[k])} KB`, Array.isArray(doc[k]) ? doc[k].length : '');
console.log(`basemap.json: ${(json.length / 1024).toFixed(1)} KB, ${(gzipSync(json).length / 1024).toFixed(1)} KB gzipped`);
