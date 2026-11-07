// A fake MBTA V3 API for the browser tests: answers the app's queries (see `legQuery`,
// `fetchSchedules`, `fetchPredictions`, `legStopCounts` (a trip's stop list), `fetchRideStops`, `fetchAlerts` in index.html and the
// setup.js route/stop lists) from a readable scenario, so tests never touch the live API.
//
// scenario = {
//   trips: [{ id, route, direction, stops: [[stopId, 'HH:MM'], …], live?: true | { delay, stops? },
//             cancelled?: [stopId, …], headsign?: string | null (default: the route's per direction),
//             added?: true (an ADDED trip: predictions only, no schedule),
//             commuter rail: name?: '2317' (the train number), alsoRoute?: 'CR-Other' (listed under
//             a second route too), track?: { [stopId]: platformId } (predictions at the platform,
//             schedules at the stop), pickup?/dropOff?: { [stopId]: GTFS type } }],
//   alerts: [{ id, effect, header, route, stop?, trip? }],
//   platforms?: { [platformId]: code } (platform_code of included stops, e.g. Track 5),
//   unnamed?: true (included stops without names),
//   vehicles?: [{ id, trip, route, direction, lat, lon }] (/vehicles: positions, updated now),
//   noShapes?: true (the route map's shape requests fail: its straight-line fallback),
// }
// The route map's shapes (/route_patterns with `include` naming the shape) come from the recorded
// `patterns-<route>-<dir>.json`; other /route_patterns requests get the rail network.
// Times are local (America/New_York) on whatever service date the app asks for, so the same
// scenario serves today's and the next day's schedules. Live trips also get predictions
// (shifted by `delay` minutes, at every stop or only `stops`) until they leave each stop, as
// the real API drops passed stops. Tests may change a trip's `live` mid-run (a bus running late).
import { readFileSync, readdirSync } from 'node:fs';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const fixture = name => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
const ROUTES = fixture('routes.json');
const STOP_DOCS = new Map(readdirSync(FIXTURES).filter(f => f.startsWith('stops-'))
  .map(f => [f.slice(6, -5), fixture(f)])); // "132-1" → doc

const RAIL_NETWORK = fixture('rail-network.json'); // /route_patterns (canonical, with trip stops)
const SHAPE_DOCS = new Map(readdirSync(FIXTURES).filter(f => f.startsWith('patterns-'))
  .map(f => [f.slice(9, -5), fixture(f)])); // "132-1" → /route_patterns doc with shapes

// Child platform id → parent station id, and stop names, from the recorded stop lists.
const PARENT = new Map();
const NAMES = new Map();
const COORDS = new Map(); // stop id → { latitude, longitude } (included stops carry them, as the API's do)
for (const doc of STOP_DOCS.values()) {
  for (const s of doc.data) {
    NAMES.set(s.id, s.attributes.name);
    if (s.attributes.latitude != null) COORDS.set(s.id, { latitude: s.attributes.latitude, longitude: s.attributes.longitude });
    for (const c of s.relationships?.child_stops?.data ?? []) { PARENT.set(c.id, s.id); NAMES.set(c.id, s.attributes.name); }
  }
}

// Recorded stops within `radius` degrees of a point (the API's nearby search).
function nearbyStops(lat, lon, radius) {
  const out = new Map();
  for (const doc of STOP_DOCS.values()) {
    for (const s of doc.data) {
      const a = s.attributes;
      if (Math.hypot(a.latitude - lat, a.longitude - lon) <= radius) out.set(s.id, { type: 'stop', id: s.id, attributes: { name: a.name, latitude: a.latitude, longitude: a.longitude } });
    }
  }
  return [...out.values()];
}

const TZ = 'America/New_York';
const MIN = 60_000;

// Epoch ms of a local date ('2026-10-05') and minute of day (may exceed 24h).
function localMs(date, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0) + minutes * MIN;
  // The zone offset at that instant (EDT -4 / EST -5).
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return guess + (guess - asUtc);
}
const minutesOf = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
// ISO with the local offset, as the API returns ("2026-10-05T07:12:00-04:00").
function iso(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const off = Math.round((local - ms) / MIN);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}:${p.second}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
// Service date (a service day runs until 3am) of an instant.
function serviceDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms - 3 * 60 * MIN));
}

const routesOf = q => new Set(q.get('filter[route]').split(',')); // a leg with `also` asks for several
const stopRef = id => ({ data: { id, type: 'stop' } });
let PLATFORMS = {};
const stopRecord = id => ({
  type: 'stop', id,
  attributes: { name: NAMES.get(id) ?? id, ...(COORDS.get(id) ?? COORDS.get(PARENT.get(id))), ...(PLATFORMS[id] && { platform_code: PLATFORMS[id] }) },
  relationships: { parent_station: { data: PARENT.has(id) ? { id: PARENT.get(id), type: 'stop' } : null } },
});
// A platform given in a scenario (BNT-0000-05) belongs to its stop's station.
const parentOf = id => PARENT.get(id) ?? PARENT.get(id.replace(/-\d\d$/, ''));
const matchesStop = (id, wanted) => wanted.has(id) || wanted.has(parentOf(id));

// Builds a series of trips: every `every` min from `first`, `count` times; `stops` are
// [stopId, minutesAfterFirst]. Ids are `${prefix}-HHMM`.
export function series({ prefix, route, direction, first, every, count, stops, live }) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = minutesOf(first) + i * every;
    const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    out.push({ id: `${prefix}-${hhmm(start).replace(':', '')}`, route, direction, live, stops: stops.map(([s, off]) => [s, hhmm(start + off)]) });
  }
  return out;
}

export async function fakeMbta(context, scenario, { now }) {
  const mbta = {
    scenario, now, mode: 'ok', hits: [],
    held: [], // requests held while mode is 'hang'
    release() { const h = this.held.splice(0); this.mode = 'ok'; for (const r of h) respond(r); },
  };
  PLATFORMS = scenario.platforms ?? {};
  for (const id of Object.keys(PLATFORMS)) if (!PARENT.has(id) && parentOf(id)) { PARENT.set(id, parentOf(id)); NAMES.set(id, NAMES.get(parentOf(id))); }
  // The routes a trip is listed under (a commuter rail trip can be on two) that a query asks for.
  const routesFor = (t, q) => [t.route, t.alsoRoute].filter(r => r && routesOf(q).has(r));

  // A trip's headsign (`headsign` on the scenario trip, else the route's for its direction;
  // null leaves it out).
  const HEADSIGNS = { 132: ['Redstone', 'Malden'], Orange: ['Forest Hills', 'Oak Grove'], 'CR-Haverhill': ['Haverhill', 'North Station'] };
  const headsignOf = t => (t.headsign !== undefined ? t.headsign : HEADSIGNS[t.route]?.[t.direction] ?? null);
  const tripRecords = trips => [...trips].map(t => ({ type: 'trip', id: t.id, attributes: { headsign: headsignOf(t), ...(t.name && { name: t.name }) } }))
    .filter(r => r.attributes.headsign || r.attributes.name);

  // Stop times of a trip on a service date: [{ stopId, ms, seq }].
  const timesOf = (trip, date) => trip.stops.map(([stopId, hhmm], i) => ({ stopId, ms: localMs(date, minutesOf(hhmm)), seq: i + 1 }));
  const delayOf = (trip, stopId) => (trip.live === true || (trip.live?.stops && !trip.live.stops.includes(stopId)) ? 0 : trip.live?.delay ?? 0) * MIN;

  function schedules(q) {
    // One trip's stop list (an expanded row's stop counts): sequences 10, 20, … like the MBTA's
    // rail (not a count).
    if (q.has('filter[trip]')) {
      const t = scenario.trips.find(x => x.id === q.get('filter[trip]') && !x.added);
      if (!t) return { data: [], included: [] };
      const date = q.get('filter[date]') ?? serviceDate(mbta.now);
      const data = timesOf(t, date).map(({ stopId, ms, seq }) => ({ type: 'schedule', id: `sch-${t.id}-${stopId}`,
        attributes: { stop_sequence: seq * 10, arrival_time: iso(ms), departure_time: iso(ms) },
        relationships: { route: { data: { id: t.route, type: 'route' } }, trip: { data: { id: t.id, type: 'trip' } }, stop: stopRef(stopId) } }));
      return { data, included: t.stops.map(([stopId]) => stopRecord(stopId)) };
    }
    const wanted = new Set(q.get('filter[stop]').split(','));
    const date = q.get('filter[date]');
    const lo = minutesOf(q.get('filter[min_time]'));
    const hi = minutesOf(q.get('filter[max_time]'));
    const data = [];
    const inc = new Set();
    const trips = new Set();
    // Without filter[route] (the setup's "Show nearby"): every route and direction at the stops.
    const anyRoute = !q.has('filter[route]');
    for (const t of scenario.trips) {
      if (t.added) continue;
      if (!anyRoute && (!routesFor(t, q).length || String(t.direction) !== q.get('filter[direction_id]'))) continue;
      for (const [stopId, hhmm] of t.stops) {
        const m = minutesOf(hhmm);
        if (!matchesStop(stopId, wanted) || m < lo || m > hi) continue;
        const at = iso(localMs(date, m));
        const types = { ...(t.pickup?.[stopId] && { pickup_type: t.pickup[stopId] }), ...(t.dropOff?.[stopId] && { drop_off_type: t.dropOff[stopId] }) };
        for (const route of anyRoute ? [t.route] : routesFor(t, q)) {
          data.push({ type: 'schedule', id: `sch-${t.id}-${stopId}-${route}`, attributes: { arrival_time: at, departure_time: at, ...types },
            relationships: { route: { data: { id: route, type: 'route' } }, trip: { data: { id: t.id, type: 'trip' } }, stop: stopRef(stopId) } });
        }
        inc.add(stopId);
        trips.add(t);
      }
    }
    return { data, included: [...[...inc].map(stopRecord), ...tripRecords(trips)] };
  }

  function legPredictions(q) {
    const wanted = new Set(q.get('filter[stop]').split(','));
    const date = serviceDate(mbta.now);
    const data = [];
    const inc = new Set();
    const trips = new Set();
    for (const t of scenario.trips) {
      if (!t.live || !routesFor(t, q).length || String(t.direction) !== q.get('filter[direction_id]')) continue;
      for (const { stopId: scheduled, ms } of timesOf(t, date)) {
        const at = ms + delayOf(t, scheduled);
        const stopId = t.track?.[scheduled] ?? scheduled;
        if (!matchesStop(stopId, wanted) || at < mbta.now) continue;
        const cancelled = t.cancelled?.includes(scheduled);
        for (const route of routesFor(t, q)) {
          data.push({ type: 'prediction', id: `pre-${t.id}-${stopId}-${route}`,
            attributes: { arrival_time: cancelled ? null : iso(at), departure_time: cancelled ? null : iso(at), schedule_relationship: cancelled ? 'SKIPPED' : t.added ? 'ADDED' : null },
            relationships: { route: { data: { id: route, type: 'route' } }, trip: { data: { id: t.id, type: 'trip' } }, stop: stopRef(stopId) } });
        }
        inc.add(stopId);
        trips.add(t);
      }
    }
    // include=alerts: the alerts naming these trips.
    const named = (q.get('include') ?? '').split(',').includes('alerts') ? alerts().data.filter(a => a.attributes.informed_entity.some(e => [...trips].some(t => t.id === e.trip))) : [];
    return { data, included: [...[...inc].map(stopRecord), ...tripRecords(trips), ...named] };
  }

  // Remaining stops of one trip and its vehicle (heading to the next stop; with `scenario.dwell`,
  // stopped at a stop for 30 s after its time).
  function tripPredictions(tripId) {
    const t = scenario.trips.find(x => x.id === tripId);
    if (!t) return { data: [], included: [] };
    const times = timesOf(t, serviceDate(mbta.now)).map(s => ({ ...s, ms: s.ms + delayOf(t, s.stopId) }));
    const left = times.filter(s => s.ms >= mbta.now - 30_000);
    const at = scenario.dwell ? left.find(s => s.ms <= mbta.now) : null;
    const next = at ?? left.find(s => s.ms > mbta.now) ?? left[0];
    const vehicle = { type: 'vehicle', id: `veh-${t.id}`, attributes: { current_status: at ? 'STOPPED_AT' : 'IN_TRANSIT_TO', current_stop_sequence: next?.seq ?? null } };
    return {
      data: left.map(s => ({ type: 'prediction', id: `trp-${t.id}-${s.seq}`,
        attributes: { arrival_time: iso(s.ms), departure_time: iso(s.ms), stop_sequence: s.seq },
        relationships: { stop: stopRef(s.stopId), vehicle: { data: { id: vehicle.id, type: 'vehicle' } } } })),
      included: [...left.map(s => stopRecord(s.stopId)), vehicle],
    };
  }

  function alerts() {
    return { data: (scenario.alerts ?? []).map(a => ({ type: 'alert', id: a.id,
      attributes: { effect: a.effect, header: a.header, short_header: a.header, severity: a.severity ?? 5,
        active_period: [{ start: null, end: null }], informed_entity: [{ route: a.route, stop: a.stop ?? null, ...(a.trip && { trip: a.trip }) }] } })) };
  }

  function stops(q) {
    if (q.has('filter[latitude]')) return { data: nearbyStops(+q.get('filter[latitude]'), +q.get('filter[longitude]'), +q.get('filter[radius]')) };
    return STOP_DOCS.get(`${q.get('filter[route]')}-${q.get('filter[direction_id]')}`) ?? { data: [] };
  }

  // Routes whose recorded stop lists include any of `ids` (a stop or one of its platforms).
  function routesAt(ids) {
    const wanted = new Set(ids);
    const found = new Set();
    for (const [key, doc] of STOP_DOCS) {
      if (doc.data.some(s => wanted.has(s.id) || (s.relationships?.child_stops?.data ?? []).some(c => wanted.has(c.id)))) found.add(key.replace(/-[01]$/, ''));
    }
    return { data: ROUTES.data.filter(r => found.has(r.id)) };
  }

  function vehicles(q) {
    const routes = (q.get('filter[route]') ?? '').split(',');
    const dir = q.get('filter[direction_id]');
    return { data: (scenario.vehicles ?? []).filter(v => routes.includes(v.route) && (dir == null || String(v.direction) === dir)).map(v => ({
      type: 'vehicle', id: v.id, attributes: { latitude: v.lat, longitude: v.lon, updated_at: iso(mbta.now), current_status: 'IN_TRANSIT_TO' },
      relationships: { trip: { data: { type: 'trip', id: v.trip } } },
    })) };
  }

  function answer(url) {
    const q = url.searchParams;
    if (url.pathname === '/route_patterns' && q.get('include')?.includes('shape')) {
      return scenario.noShapes ? undefined : SHAPE_DOCS.get(`${q.get('filter[route]')}-${q.get('filter[direction_id]')}`) ?? { data: [], included: [] };
    }
    switch (url.pathname) {
      case '/schedules': return schedules(q);
      case '/predictions': return q.has('filter[trip]') ? tripPredictions(q.get('filter[trip]')) : legPredictions(q);
      case '/alerts': return alerts();
      case '/stops': return stops(q);
      case '/route_patterns': return RAIL_NETWORK;
      case '/vehicles': return vehicles(q);
      case '/routes': return q.has('filter[stop]') ? routesAt(q.get('filter[stop]').split(',')) : ROUTES;
      default: return null;
    }
  }

  function respond(route) {
    const url = new URL(route.request().url());
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/vnd.api+json' };
    if (mbta.mode === '503') return route.fulfill({ status: 503, headers, body: '{}' }).catch(() => {});
    if (mbta.mode === '429') return route.fulfill({ status: 429, headers, body: '{}' }).catch(() => {});
    const body = answer(url);
    if (body === undefined) return route.fulfill({ status: 503, headers, body: '{}' }).catch(() => {});
    // `scenario.unnamed`: stops come without names (the app shows "—").
    if (scenario.unnamed) for (const inc of body?.included ?? []) if (inc.attributes) delete inc.attributes.name;
    return route.fulfill({ status: body ? 200 : 404, headers, body: JSON.stringify(body ?? {}) }).catch(() => {});
  }

  await context.route('https://api-v3.mbta.com/**', async route => {
    // "Now" is the page's (fake) clock at the time of the request.
    mbta.now = await route.request().frame().evaluate(() => Date.now()).catch(() => mbta.now);
    const hit = new URL(route.request().url());
    mbta.hits.push({ at: mbta.now, path: hit.pathname, query: hit.searchParams });
    if (mbta.mode === 'hang') { mbta.held.push(route); return; }
    return respond(route);
  });

  // The server's MBTA proxy (/api/mbta/*), answering from the same scenario: `status` other than
  // 200 refuses (e.g. 503, the kill switch); `age` (s) sends `x-data-age` (a stale copy).
  mbta.proxyHits = [];
  mbta.serveProxy = (page, { status = 200, age = null } = {}) => page.route(/\/api\/mbta\//, async route => {
    mbta.now = await route.request().frame().evaluate(() => Date.now()).catch(() => mbta.now);
    const url = new URL(route.request().url());
    url.pathname = url.pathname.replace(/^\/api\/mbta/, '');
    mbta.proxyHits.push({ at: mbta.now, path: url.pathname, query: url.searchParams });
    if (status !== 200) return route.fulfill({ status, contentType: 'application/json', body: '{}' }).catch(() => {});
    const body = answer(url);
    if (body === undefined) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }).catch(() => {});
    return route.fulfill({
      status: body ? 200 : 404, headers: { 'content-type': 'application/json', ...(age && { 'x-data-age': String(age) }) },
      body: JSON.stringify(body ?? {}),
    }).catch(() => {});
  });
  return mbta;
}
