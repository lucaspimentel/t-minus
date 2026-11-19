// Builds basemap.json, the route map's background (DESIGN.md "Route map", Base map): land and
// water, town and Boston neighborhood borders and names, and faint subway, Silver Line and
// commuter rail lines, and green areas (parks, reservations), and names for parks, lakes, ponds, wide
// rivers, harbors and bays (`features`, 2026-11-19). Three tiers of detail (2026-11-09):
// 5 m in the inner rect (downtown), 30 m over the rest of the bus service area, and for commuter
// rail's reach, 150 m Massachusetts towns (land, borders, names; 2026-11-08) and the neighboring
// states' land.
// Run: NODE_USE_ENV_PROXY=1 node scripts/build-basemap.mjs   (MBTA_API_KEY optional, never stored)
// Sources: MassGIS (towns; detailed lakes and wide rivers from Massachusetts_Water_Features_NoLabels
// layer 6 (1:25,000), coarse lakes from Hydro_100k, rivers from Hydro_Major; open space), City of Boston (BPDA neighborhoods), US Census TIGERweb
// (coarse land: MA, RI, NH, CT), the MBTA V3 API (extents, line shapes). Commit basemap.json.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodePolyline, encodePolyline } from '../core.js';
import { simplify, simplifyRing, dissolve, clipRing, clipLine, outsideStrips, ringsOf, ringArea, areaKm2, labelPoint, titleCase, tierRings, tierLines, cleanName, groupNear, labelSpot, toMeters } from './basemap-geo.mjs';

const OUT = new URL('../basemap.json', import.meta.url);
const MBTA = 'https://api-v3.mbta.com';
const MASSGIS = 'https://arcgisserver.digital.mass.gov/arcgisserver/rest/services';
const TOWNS = `${MASSGIS}/Basemaps/Mass_Towns_Yellow_Lines_and_Labels/FeatureServer/0/query`;
const HYDRO = `${MASSGIS}/AGOL/Hydro_Major/FeatureServer`; // rivers (lines)
// Coarse lakes (the outer tier's, 1 km² or more; 2026-11-09): USGS 1:100,000 hydrography;
// Hydro_Major left out Spot Pond and the Middlesex Fells reservoirs.
const LAKES = `${MASSGIS}/AGOL/Hydro_100k/FeatureServer/2/query`;
// Detailed lakes and wide rivers (2026-11-10): MassGIS's 1:25,000 "Lakes and Ponds" (USGS with
// MassDEP additions); Hydro_100k left out the Charles between its two dams (the Museum of Science
// dam and the locks near North Station), drawing it as land.
const LAKES_25K = `${MASSGIS}/AGOL/Massachusetts_Water_Features_NoLabels/FeatureServer/6/query`;
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
// 2026-11-10: 30 and 150 m (20 and 100 m before), 21 KB less gzipped.
const MID_M = 30; // the rest of the bus service area
const COARSE_M = 150; // commuter rail's reach
const MIN_GREEN_ACRES = 20; // a site: parcels sharing a town and name, summed
const MIN_LAKE_M2 = 20_000; // detailed lakes
const MIN_COARSE_LAKE_M2 = 1_000_000;
// Feature names (2026-11-19): parks of MIN_NAMED_ACRES or more (same-name pieces within NEAR_M
// merged across towns) and the must-haves whatever their size; named lakes and wide rivers.
const MIN_NAMED_ACRES = 50;
const NEAR_M = 100;
const MUST_PARKS = new Set(['BOSTON COMMON', 'BOSTON PUBLIC GARDEN', 'JAMAICA POND PARK', 'OLMSTED PARK', 'THE RIVERWAY', 'CHRISTOPHER COLUMBUS WATERFRONT PARK', 'CASTLE ISLAND', 'DANEHY PARK']);
// Raw (upper-cased) source names → display names.
const NAME_FIX = {
  'BOSTON PUBLIC GARDEN': 'Public Garden',
  'CHRISTOPHER COLUMBUS WATERFRONT PARK': 'Christopher Columbus Park',
  'CITY AND LWSC - LYNN WOODS CR': 'Lynn Woods',
  'LYNN WOODS RESERVATION': 'Lynn Woods',
  'MT AUBURN CEMETERY': 'Mount Auburn Cemetery',
  'BACK BAY': null, // the Fens' water: "Back Bay" is the neighborhood's name
  'CONSERVATION AREA': null,
};
const SKIP_PARK = /SCHOOL|WELLFIELD/; // school grounds, wells: not landmarks
// Harbors and bays: hand-placed water points with a nominal width (m) for the zoom rule.
const HARBORS = [
  { n: 'Boston Harbor', lat: 42.338, lon: -70.990, m: 6000 },
  { n: 'Dorchester Bay', lat: 42.312, lon: -71.030, m: 2500 },
  { n: 'Quincy Bay', lat: 42.285, lon: -70.985, m: 3000 },
  { n: 'Massachusetts Bay', lat: 42.38, lon: -70.75, m: 30000 },
  { n: 'Broad Sound', lat: 42.40, lon: -70.93, m: 6000 },
  { n: 'Nahant Bay', lat: 42.450, lon: -70.915, m: 3500 },
  { n: 'Lynn Harbor', lat: 42.447, lon: -70.957, m: 2000 },
  { n: 'Hingham Bay', lat: 42.275, lon: -70.925, m: 3000 },
  { n: 'Fort Point Channel', lat: 42.350, lon: -71.051, m: 300 },
  { n: 'Salem Sound', lat: 42.515, lon: -70.845, m: 5000 },
  { n: 'Beverly Harbor', lat: 42.538, lon: -70.875, m: 1500 },
  { n: 'Cape Cod Bay', lat: 41.93, lon: -70.45, m: 40000 },
  { n: 'Plymouth Bay', lat: 41.975, lon: -70.62, m: 3000 },
  { n: 'Gloucester Harbor', lat: 42.595, lon: -70.665, m: 1500 },
];
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
// lines outside the bus area keep the middle tier's 30 m (the coarse land overlaps them by 50 m).
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
const lakeFeatures = await arcgisAll(LAKES_25K, detail, { where: `Shape__Area>=${MIN_LAKE_M2}`, outFields: 'OBJECTID,NAME' });
const lakes = tierRings(lakeFeatures.flatMap(f => ringsOf(f.geometry)), TIERS).map(enc);
const features = [];
const featureOf = (n, k, spot) => ({ n, k, lat: round5(spot.lat), lon: round5(spot.lon), a: Math.round(spot.a * 100) / 100, m: Math.round(spot.m) });
const polysOf = g => (g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : []);
const named = (list, nameOf) => list.map(f => ({ name: nameOf(f), polygons: polysOf(f.geometry), f })).filter(x => x.name && x.polygons.length);
const waterSpots = groupNear(named(lakeFeatures, f => cleanName(f.properties.NAME, NAME_FIX)), NEAR_M).map(g => ({ name: g.name, spot: labelSpot(g.polygons) }));
for (const { name, spot } of waterSpots) features.push(featureOf(name, 'w', spot));
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
  const site = sites.get(key) ?? { acres: 0, features: [], must: MUST_PARKS.has(name) };
  site.acres += f.properties.GIS_ACRES ?? 0;
  site.features.push(f);
  sites.set(key, site);
}
const parks = [...sites.values()].filter(x => x.acres >= MIN_GREEN_ACRES || x.must).flatMap(x => x.features);
const green = tierRings(dissolve(parks, () => 'all').outline, TIERS, ringOk).map(enc);
console.log('open space', open.length, 'parcels,', parks.length, 'kept');
// Park names: pieces sharing a cleaned name, merged across towns when within NEAR_M.
const parkItems = named(open.filter(f => f.properties.SITE_NAME?.trim() && !SKIP_PARK.test(f.properties.SITE_NAME.toUpperCase())), f => cleanName(f.properties.SITE_NAME, NAME_FIX));
const near = (a, b, m) => { const k = toMeters((a[1] + a[3]) / 2), dx = m / k.kx, dy = m / k.ky; return !(a[0] - dx > b[2] || b[0] - dx > a[2] || a[1] - dy > b[3] || b[1] - dy > a[3]); };
let dropped = 0, parkCount = 0;
for (const g of groupNear(parkItems, NEAR_M)) {
  const members = g.members.map(i => parkItems[i].f.properties);
  const acres = members.reduce((t, p) => t + (p.GIS_ACRES ?? 0), 0);
  const must = members.some(p => MUST_PARKS.has(p.SITE_NAME.trim().toUpperCase()));
  if (acres < MIN_NAMED_ACRES && !must) continue;
  const spot = labelSpot(g.polygons);
  const lower = g.name.toLowerCase();
  const water = waterSpots.find(w => lower.includes(w.name.toLowerCase()) && near(w.spot.box, spot.box, 300));
  if (water) { console.log('park name dropped:', g.name, '(beside', water.name + ')'); dropped++; continue; }
  features.push(featureOf(g.name, 'p', spot));
  parkCount++;
}

// 5. Coarse tier, outside the detailed rect (with a 50 m overlap): Massachusetts from its towns
// (the shoreline, the borders between towns), the other states' land from the Census; big lakes,
// clipped outside `detail` itself (not the 50 m inset): the detailed lakes' rects end exactly at
// `detail`, so the pieces abut without overlapping (an overlap would cut an evenodd hole).
const inner = pad(detail, -50 / 82_000, -50 / 111_320);
const strips = outsideStrips(box, inner);
const outside = rings => rings.map(r => simplifyRing(r, COARSE_M)).flatMap(r => strips.map(st => clipRing(r, st))).filter(ringOk).map(enc);
const states = await arcgis(TIGER, box, { where: "STUSAB IN ('RI','NH','CT')", outFields: 'STUSAB', geometryPrecision: '5' });
const coarse = [...outside(merged.outline), ...outside(states.flatMap(f => ringsOf(f.geometry)))];
townLines.push(...merged.borders.map(l => simplify(l, COARSE_M)).flatMap(l => strips.flatMap(st => clipLine(l, st))).filter(l => l.length >= 2).map(enc));
const bigLakes = await arcgis(LAKES, box, { where: `Shape__Area>=${MIN_COARSE_LAKE_M2}`, outFields: 'OBJECTID,NAME' });
// Outer lakes' names: those labeled outside the detailed rect (inside it the 1:25,000 names are).
let outerLakes = 0;
for (const g of groupNear(named(bigLakes, f => cleanName(f.properties.NAME, NAME_FIX)), NEAR_M)) {
  const spot = labelSpot(g.polygons);
  if (inRect([spot.lon, spot.lat], detail) || !inRect([spot.lon, spot.lat], box)) continue;
  features.push(featureOf(g.name, 'w', spot));
  outerLakes++;
}
for (const h of HARBORS) {
  if (!inRect([h.lon, h.lat], box)) throw new Error(`harbor ${h.n} outside the box`);
  features.push({ n: h.n, k: 'w', lat: h.lat, lon: h.lon, a: Math.round(((h.m / 1000) ** 2 / 2) * 100) / 100, m: h.m });
}
const lakeStrips = outsideStrips(box, detail);
for (const r of bigLakes.flatMap(f => ringsOf(f.geometry))) {
  const s = simplifyRing(r, COARSE_M);
  for (const st of lakeStrips) { const c = clipRing(s, st); if (c.length >= 3) lakes.push(enc(c)); }
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

// 7. The file. `features` apart from `names`: older pages map an unknown `k` there to a town.
features.sort((x, y) => (x.k === y.k ? y.a - x.a || (x.n < y.n ? -1 : 1) : x.k < y.k ? -1 : 1));
console.log('features:', waterSpots.length, 'water,', outerLakes, 'outer lakes,', HARBORS.length, 'harbors,', parkCount, 'parks,', dropped, 'park names dropped');
const doc = { v: 1, built: new Date().toISOString().slice(0, 10), credit: CREDIT, box, detail, inner: INNER, reach, coarse, land, green, lakes, rivers, towns: townLines, hoods, lines: faint, names, features };
const json = JSON.stringify(doc) + '\n';
writeFileSync(OUT, json);
const kb = x => (Buffer.byteLength(JSON.stringify(x)) / 1024).toFixed(1);
for (const k of ['coarse', 'land', 'green', 'lakes', 'rivers', 'towns', 'hoods', 'lines', 'names', 'features']) console.log(k.padEnd(7), `${kb(doc[k])} KB`, Array.isArray(doc[k]) ? doc[k].length : '');
console.log(`basemap.json: ${(json.length / 1024).toFixed(1)} KB, ${(gzipSync(json).length / 1024).toFixed(1)} KB gzipped`);
