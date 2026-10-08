// A fake MBTA V3 API for the browser tests: answers the app's queries (see `legQuery`,
// `fetchSchedules`, `fetchPredictions`, `fetchRideStops`, `fetchAlerts` in index.html and the
// setup.js route/stop lists) from a readable scenario, so tests never touch the live API.
//
// scenario = {
//   trips: [{ id, route, direction, stops: [[stopId, 'HH:MM'], …], live?: true | { delay, stops? },
//             cancelled?: [stopId, …], headsign?: string | null (default: the route's per direction) }],
//   alerts: [{ id, effect, header, route, stop? }],
//   unnamed?: true (included stops without names),
// }
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

// Child platform id → parent station id, and stop names, from the recorded stop lists.
const PARENT = new Map();
const NAMES = new Map();
for (const doc of STOP_DOCS.values()) {
  for (const s of doc.data) {
    NAMES.set(s.id, s.attributes.name);
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
const stopRecord = id => ({
  type: 'stop', id,
  attributes: { name: NAMES.get(id) ?? id },
  relationships: { parent_station: { data: PARENT.has(id) ? { id: PARENT.get(id), type: 'stop' } : null } },
});
const matchesStop = (id, wanted) => wanted.has(id) || wanted.has(PARENT.get(id));

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

  // A trip's headsign (`headsign` on the scenario trip, else the route's for its direction;
  // null leaves it out).
  const HEADSIGNS = { 132: ['Redstone', 'Malden'], Orange: ['Forest Hills', 'Oak Grove'] };
  const headsignOf = t => (t.headsign !== undefined ? t.headsign : HEADSIGNS[t.route]?.[t.direction] ?? null);
  const tripRecords = trips => [...trips].map(t => ({ type: 'trip', id: t.id, attributes: { headsign: headsignOf(t) } }))
    .filter(r => r.attributes.headsign);

  // Stop times of a trip on a service date: [{ stopId, ms, seq }].
  const timesOf = (trip, date) => trip.stops.map(([stopId, hhmm], i) => ({ stopId, ms: localMs(date, minutesOf(hhmm)), seq: i + 1 }));
  const delayOf = (trip, stopId) => (trip.live === true || (trip.live?.stops && !trip.live.stops.includes(stopId)) ? 0 : trip.live?.delay ?? 0) * MIN;

  function schedules(q) {
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
      if (!anyRoute && (!routesOf(q).has(t.route) || String(t.direction) !== q.get('filter[direction_id]'))) continue;
      for (const [stopId, hhmm] of t.stops) {
        const m = minutesOf(hhmm);
        if (!matchesStop(stopId, wanted) || m < lo || m > hi) continue;
        const at = iso(localMs(date, m));
        data.push({ type: 'schedule', id: `sch-${t.id}-${stopId}`, attributes: { arrival_time: at, departure_time: at },
          relationships: { route: { data: { id: t.route, type: 'route' } }, trip: { data: { id: t.id, type: 'trip' } }, stop: stopRef(stopId) } });
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
      if (!t.live || !routesOf(q).has(t.route) || String(t.direction) !== q.get('filter[direction_id]')) continue;
      for (const { stopId, ms } of timesOf(t, date)) {
        const at = ms + delayOf(t, stopId);
        if (!matchesStop(stopId, wanted) || at < mbta.now) continue;
        const cancelled = t.cancelled?.includes(stopId);
        data.push({ type: 'prediction', id: `pre-${t.id}-${stopId}`,
          attributes: { arrival_time: cancelled ? null : iso(at), departure_time: cancelled ? null : iso(at), schedule_relationship: cancelled ? 'SKIPPED' : null },
          relationships: { route: { data: { id: t.route, type: 'route' } }, trip: { data: { id: t.id, type: 'trip' } }, stop: stopRef(stopId) } });
        inc.add(stopId);
        trips.add(t);
      }
    }
    return { data, included: [...[...inc].map(stopRecord), ...tripRecords(trips)] };
  }

  // Remaining stops of one trip and its vehicle (heading to the next stop).
  function tripPredictions(tripId) {
    const t = scenario.trips.find(x => x.id === tripId);
    if (!t) return { data: [], included: [] };
    const times = timesOf(t, serviceDate(mbta.now)).map(s => ({ ...s, ms: s.ms + delayOf(t, s.stopId) }));
    const left = times.filter(s => s.ms >= mbta.now - 30_000);
    const next = left[0];
    const vehicle = { type: 'vehicle', id: `veh-${t.id}`, attributes: { current_status: 'IN_TRANSIT_TO', current_stop_sequence: next?.seq ?? null } };
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
        active_period: [{ start: null, end: null }], informed_entity: [{ route: a.route, stop: a.stop ?? null }] } })) };
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

  function answer(url) {
    const q = url.searchParams;
    switch (url.pathname) {
      case '/schedules': return schedules(q);
      case '/predictions': return q.has('filter[trip]') ? tripPredictions(q.get('filter[trip]')) : legPredictions(q);
      case '/alerts': return alerts();
      case '/stops': return stops(q);
      case '/route_patterns': return RAIL_NETWORK;
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
    return route.fulfill({
      status: body ? 200 : 404, headers: { 'content-type': 'application/json', ...(age && { 'x-data-age': String(age) }) },
      body: JSON.stringify(body ?? {}),
    }).catch(() => {});
  });
  return mbta;
}
