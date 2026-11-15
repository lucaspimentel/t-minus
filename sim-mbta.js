// A fake MBTA V3 API: answers the app's queries (see `legQuery`, `fetchSchedules`,
// `fetchPredictions`, `legStopCounts` (a trip's stop list), `fetchRideStops`, `fetchAlerts` in
// index.html and the setup.js route/stop lists) from a readable scenario. Shared by the browser
// tests (test/browser/fake-mbta.js feeds it recorded fixtures) and the simulator (sim-page.js,
// DESIGN.md "Simulator"). No imports: it loads in Node and in the page.
//
// scenario = {
//   trips: [{ id, route, direction, stops: [[stopId, 'HH:MM' | 'HH:MM:SS'], …], live?: true | { delay, stops?, delays? },
//             cancelled?: [stopId, …], headsign?: string | null (default: the route's per direction),
//             added?: true (an ADDED trip: predictions only, no schedule),
//             date?: '2026-10-05' (only on that service date; default every date),
//             commuter rail: name?: '2317' (the train number), alsoRoute?: 'CR-Other' (listed under
//             a second route too), track?: { [stopId]: platformId } (predictions at the platform,
//             schedules at the stop), trackAt?: 'HH:MM' (the track only from then on),
//             pickup?/dropOff?: { [stopId]: GTFS type } }],
//   alerts: [{ id, effect, header, route, stop?, trip? }],
//   platforms?: { [platformId]: code } (platform_code of included stops, e.g. Track 5),
//   unnamed?: true (included stops without names),
//   vehicles?: [{ id, trip, route, direction, lat, lon }] (/vehicles: positions, updated now),
//   moving?: true (/vehicles: every trip's vehicle, moving between its stops: `vehicleAt`),
//   liveWithinMin?: 60 (a trip without `live` has predictions from that many minutes before its
//     first stop until its last, like the real API's horizon),
//   noShapes?: true (the route map's shape requests fail: its straight-line fallback),
//   dwell?: true (a ride's vehicle stopped at a stop for 30 s after its time),
// }
// `live.delay` shifts every stop (or only `live.stops`) by minutes; `live.delays` gives minutes
// per stop (the simulator's "+2 min late" from a stop on). Times are local
// (America/New_York) on whatever service date the app asks for, so the same scenario serves
// today's and the next day's schedules. Live trips also get predictions until they leave each
// stop, as the real API drops passed stops. Callers may change a trip mid-run: the scenario is
// read on every answer.

const TZ = 'America/New_York';
const MIN = 60_000;

// Epoch ms of a local date ('2026-10-05') and minute of day (may exceed 24h; fractions are seconds).
export function localMs(date, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0) + minutes * MIN;
  // The zone offset at that instant (EDT -4 / EST -5).
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return guess + (Math.floor(guess / MIN) * MIN - asUtc);
}
// Minutes of 'HH:MM' or 'HH:MM:SS' (hours past 24 for after midnight); a number as is.
export const minutesOf = hhmm => {
  if (typeof hhmm === 'number') return hhmm;
  const [h, m, s = 0] = hhmm.split(':').map(Number);
  return h * 60 + m + s / 60;
};
// ISO with the local offset, as the API returns ("2026-10-05T07:12:00-04:00").
export function iso(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const off = Math.round((local - ms) / MIN);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}:${p.second}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
// Service date (a service day runs until 3am) of an instant.
export function serviceDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms - 3 * 60 * MIN));
}

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

const HEADSIGNS = { 132: ['Redstone', 'Malden'], Orange: ['Forest Hills', 'Oak Grove'], 'CR-Haverhill': ['Haverhill', 'North Station'] };

// staticData = { names: Map(stop id → name), parents: Map(child → parent), coords: Map(stop id →
// { latitude, longitude }), routes?: /routes doc, stopDocs?: Map('132-1' → /stops doc),
// railNetwork?: /route_patterns doc, shapeDocs?: Map('132-1' → doc) }.
// Returns { answer(url, nowMs) } and helpers: undefined answers stand for a 503, null for a 404.
export function createFakeMbta(scenario, staticData = {}) {
  const NAMES = new Map(staticData.names ?? []);
  const PARENT = new Map(staticData.parents ?? []);
  const COORDS = staticData.coords ?? new Map();
  const STOP_DOCS = staticData.stopDocs ?? new Map();
  const SHAPE_DOCS = staticData.shapeDocs ?? new Map();
  const ROUTES = staticData.routes ?? { data: [] };
  const RAIL_NETWORK = staticData.railNetwork ?? { data: [] };
  let now = 0;

  const PLATFORMS = () => scenario.platforms ?? {};
  // A platform given in a scenario (BNT-0000-05) belongs to its stop's station.
  const parentOf = id => PARENT.get(id) ?? PARENT.get(id.replace(/-\d\d$/, ''));
  for (const id of Object.keys(PLATFORMS())) if (!PARENT.has(id) && parentOf(id)) { PARENT.set(id, parentOf(id)); NAMES.set(id, NAMES.get(parentOf(id))); }
  const matchesStop = (id, wanted) => wanted.has(id) || wanted.has(parentOf(id));
  const routesOf = q => new Set(q.get('filter[route]').split(',')); // a leg with `also` asks for several
  const stopRef = id => ({ data: { id, type: 'stop' } });
  const coordsOf = id => COORDS.get(id) ?? COORDS.get(PARENT.get(id));
  const stopRecord = id => ({
    type: 'stop', id,
    attributes: { name: NAMES.get(id) ?? id, ...coordsOf(id), ...(PLATFORMS()[id] && { platform_code: PLATFORMS()[id] }) },
    relationships: { parent_station: { data: PARENT.has(id) ? { id: PARENT.get(id), type: 'stop' } : null } },
  });
  // The routes a trip is listed under (a commuter rail trip can be on two) that a query asks for.
  const routesFor = (t, q) => [t.route, t.alsoRoute].filter(r => r && routesOf(q).has(r));
  const onDate = (t, date) => !t.date || t.date === date;

  // A trip's headsign (`headsign` on the scenario trip, else the route's for its direction;
  // null leaves it out).
  const headsignOf = t => (t.headsign !== undefined ? t.headsign : HEADSIGNS[t.route]?.[t.direction] ?? null);
  const tripRecords = trips => [...trips].map(t => ({ type: 'trip', id: t.id, attributes: { headsign: headsignOf(t), ...(t.name && { name: t.name }) } }))
    .filter(r => r.attributes.headsign || r.attributes.name);

  // Stop times of a trip on a service date: [{ stopId, ms, seq }].
  const timesOf = (trip, date) => trip.stops.map(([stopId, hhmm], i) => ({ stopId, ms: localMs(date, minutesOf(hhmm)), seq: i + 1 }));
  const delayOf = (trip, stopId) => {
    const l = trip.live;
    if (l?.delays?.[stopId] != null) return l.delays[stopId] * MIN;
    return (l === true || l == null || (l.stops && !l.stops.includes(stopId)) ? 0 : l.delay ?? 0) * MIN;
  };
  // Live: `live` set, or within `liveWithinMin` of the trip's first stop until its last.
  const isLive = (t, date) => {
    if (t.live) return true;
    if (scenario.liveWithinMin == null) return false;
    const times = timesOf(t, date);
    return now >= times[0].ms - scenario.liveWithinMin * MIN && now <= times[times.length - 1].ms + delayOf(t, times[times.length - 1].stopId) + MIN;
  };
  // The stop a prediction names: the track's platform once assigned.
  const predictedStop = (t, stopId, date) => (t.track?.[stopId] && (!t.trackAt || now >= localMs(date, minutesOf(t.trackAt))) ? t.track[stopId] : stopId);

  function schedules(q) {
    // One trip's stop list (an expanded row's stop counts): sequences 10, 20, … like the MBTA's
    // rail (not a count).
    if (q.has('filter[trip]')) {
      const date = q.get('filter[date]') ?? serviceDate(now);
      const t = scenario.trips.find(x => x.id === q.get('filter[trip]') && !x.added && onDate(x, date));
      if (!t) return { data: [], included: [] };
      const data = timesOf(t, date).map(({ stopId, ms, seq }) => ({ type: 'schedule', id: `sch-${t.id}-${stopId}`,
        attributes: { stop_sequence: seq * 10, arrival_time: iso(ms), departure_time: iso(ms) },
        relationships: { route: { data: { id: t.route, type: 'route' } }, trip: { data: { id: t.id, type: 'trip' } }, stop: stopRef(stopId) } }));
      return { data, included: t.stops.map(([stopId]) => stopRecord(stopId)) };
    }
    if (!q.has('filter[stop]')) return { data: [], included: [] }; // the planner's network sample: none here
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
      if (t.added || !onDate(t, date)) continue;
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
    const date = serviceDate(now);
    const data = [];
    const inc = new Set();
    const trips = new Set();
    for (const t of scenario.trips) {
      if (!onDate(t, date) || !routesFor(t, q).length || String(t.direction) !== q.get('filter[direction_id]') || !isLive(t, date)) continue;
      for (const { stopId: scheduled, ms } of timesOf(t, date)) {
        const at = ms + delayOf(t, scheduled);
        const stopId = predictedStop(t, scheduled, date);
        if (!matchesStop(stopId, wanted) || at < now) continue;
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

  // A trip's stop times today with its delays: [{ stopId, ms, seq }].
  const liveTimes = t => timesOf(t, serviceDate(now)).map(s => ({ ...s, ms: s.ms + delayOf(t, s.stopId) }));

  // Remaining stops of one trip and its vehicle (heading to the next stop; with `scenario.dwell`,
  // stopped at a stop for 30 s after its time).
  function tripPredictions(tripId) {
    const t = scenario.trips.find(x => x.id === tripId && onDate(x, serviceDate(now)));
    if (!t) return { data: [], included: [] };
    const times = liveTimes(t);
    const left = times.filter(s => s.ms >= now - 30_000);
    const at = scenario.dwell ? left.find(s => s.ms <= now) : null;
    const next = at ?? left.find(s => s.ms > now) ?? left[0];
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

  // Where a trip's vehicle is at `ms`: { lat, lon, status, seq } or null (not out yet, or gone).
  // Out 10 min before its first stop (stopped there); between stops by time (stopped for 20 s
  // after each stop's time); past the last stop it goes on along the last segment for 2 min.
  function vehicleAt(tripId, ms = now) {
    const t = scenario.trips.find(x => x.id === tripId && onDate(x, serviceDate(ms)));
    if (!t) return null;
    const pts = liveTimes(t).map(s => ({ ...s, c: coordsOf(s.stopId) })).filter(s => s.c);
    if (!pts.length || ms < pts[0].ms - 10 * MIN) return null;
    const pos = (c, status, seq) => ({ lat: c.latitude, lon: c.longitude, status, seq });
    if (ms <= pts[0].ms + 20_000) return pos(pts[0].c, 'STOPPED_AT', pts[0].seq);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (ms > b.ms + 20_000) continue;
      if (ms >= b.ms) return pos(b.c, 'STOPPED_AT', b.seq);
      const f = Math.max(0, Math.min(1, (ms - a.ms - 20_000) / Math.max(1, b.ms - a.ms - 20_000)));
      return { lat: a.c.latitude + (b.c.latitude - a.c.latitude) * f, lon: a.c.longitude + (b.c.longitude - a.c.longitude) * f, status: 'IN_TRANSIT_TO', seq: b.seq };
    }
    const last = pts[pts.length - 1];
    const after = ms - last.ms - 20_000;
    if (after > 2 * MIN || pts.length < 2) return after > 2 * MIN ? null : pos(last.c, 'STOPPED_AT', last.seq);
    const prev = pts[pts.length - 2];
    const f = after / Math.max(1, last.ms - prev.ms);
    return { lat: last.c.latitude + (last.c.latitude - prev.c.latitude) * f, lon: last.c.longitude + (last.c.longitude - prev.c.longitude) * f, status: 'IN_TRANSIT_TO', seq: null };
  }

  function vehicles(q) {
    const routes = (q.get('filter[route]') ?? '').split(',');
    const dir = q.get('filter[direction_id]');
    const listed = (scenario.vehicles ?? []).filter(v => routes.includes(v.route) && (dir == null || String(v.direction) === dir));
    const moving = !scenario.moving ? [] : scenario.trips
      .filter(t => routes.includes(t.route) && (dir == null || String(t.direction) === dir) && !t.cancelled?.length)
      .map(t => ({ t, p: vehicleAt(t.id) })).filter(x => x.p)
      .map(({ t, p }) => ({ id: `veh-${t.id}`, trip: t.id, route: t.route, lat: p.lat, lon: p.lon, status: p.status }));
    const updated = iso(Math.floor(now / 5000) * 5000);
    return { data: [...listed, ...moving].map(v => ({
      type: 'vehicle', id: v.id, attributes: { latitude: v.lat, longitude: v.lon, updated_at: v.status ? updated : iso(now), current_status: v.status ?? 'IN_TRANSIT_TO' },
      relationships: { trip: { data: { type: 'trip', id: v.trip } }, route: { data: { type: 'route', id: v.route } } },
    })) };
  }

  function answerAt(url) {
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

  return {
    // `url`: a URL whose pathname is the API path ('/schedules'); `nowMs`: the clock.
    answer(url, nowMs) {
      now = nowMs;
      const body = answerAt(url);
      // `scenario.unnamed`: stops come without names (the app shows "—").
      if (body && scenario.unnamed) for (const inc of body.included ?? []) if (inc.attributes) delete inc.attributes.name;
      return body;
    },
    vehicleAt: (tripId, nowMs) => { now = nowMs; return vehicleAt(tripId, nowMs); },
    coordsOf,
    nameOf: id => NAMES.get(id) ?? NAMES.get(PARENT.get(id)) ?? null,
  };
}

// ---------- the simulator's replay (DESIGN.md "Simulator") ----------

const msOf = t => (t ? Date.parse(t) : null);

// A real /schedules doc (a leg's day, `include=stop,trip`) as scenario trips: each trip's stops
// at minutes after the service date's midnight (past 24h after midnight), with its headsign,
// train number, flag stops and the leg's direction. Only on `date`.
export function scenarioFromSchedules(doc, { direction, date }) {
  const midnight = localMs(date, 0);
  const info = new Map((doc.included ?? []).filter(x => x.type === 'trip').map(x => [x.id, x.attributes ?? {}]));
  const trips = new Map();
  for (const s of doc.data ?? []) {
    const id = s.relationships?.trip?.data?.id;
    const stopId = s.relationships?.stop?.data?.id;
    const ms = msOf(s.attributes.departure_time) ?? msOf(s.attributes.arrival_time);
    if (!id || !stopId || ms == null) continue;
    let t = trips.get(id);
    if (!t) {
      const a = info.get(id) ?? {};
      t = { id, route: s.relationships.route?.data?.id, direction: Number(direction), date, stops: [],
        ...(a.headsign !== undefined && { headsign: a.headsign }), ...(a.name && { name: a.name }) };
      trips.set(id, t);
    }
    if (t.stops.some(([x]) => x === stopId)) continue;
    t.stops.push([stopId, (ms - midnight) / MIN]);
    if (s.attributes.pickup_type) (t.pickup ??= {})[stopId] = s.attributes.pickup_type;
    if (s.attributes.drop_off_type) (t.dropOff ??= {})[stopId] = s.attributes.drop_off_type;
  }
  for (const t of trips.values()) t.stops.sort((a, b) => a[1] - b[1]);
  return [...trips.values()];
}

// Names, parent stations, coordinates and platform codes from docs' included stops.
export function staticFromIncluded(docs, into = { names: new Map(), parents: new Map(), coords: new Map(), platforms: {} }) {
  for (const doc of docs) {
    for (const x of doc?.included ?? []) {
      if (x.type !== 'stop') continue;
      const a = x.attributes ?? {};
      if (a.name) into.names.set(x.id, a.name);
      if (a.latitude != null) into.coords.set(x.id, { latitude: a.latitude, longitude: a.longitude });
      const parent = x.relationships?.parent_station?.data?.id;
      if (parent) into.parents.set(x.id, parent);
      if (a.platform_code) into.platforms[x.id] = a.platform_code;
    }
  }
  return into;
}

// A trip's whole stop list (a /schedules doc with `filter[trip]`) in place of the leg's two stops.
export function mergeTripStops(trip, doc) {
  const midnight = localMs(trip.date, 0);
  const all = (doc.data ?? []).map(s => ({ stopId: s.relationships?.stop?.data?.id, seq: s.attributes.stop_sequence ?? 0,
    ms: msOf(s.attributes.departure_time) ?? msOf(s.attributes.arrival_time) })).filter(s => s.stopId && s.ms != null);
  if (all.length < trip.stops.length) return trip;
  all.sort((a, b) => a.seq - b.seq || a.ms - b.ms);
  return { ...trip, stops: all.map(s => [s.stopId, (s.ms - midnight) / MIN]), full: true };
}

// The simulator's changes during playback, applied in order to a copy of the scenario:
// { type: 'late', tripId, date, at, min } adds `min` at every stop not yet passed at `at`;
// { type: 'cancel', … } skips the stops not yet passed; { type: 'earlier', … } adds a train or bus
// 3 min before (`${tripId}~early1`, predictions only, like the MBTA's ADDED trips).
export const EARLIER_BY_MIN = 3;
export function applyTweaks(base, tweaks = []) {
  const trips = [...base.trips];
  const idx = new Map(trips.map((t, i) => [t.id, i]));
  const timeOf = (t, stopId, hhmm) => localMs(t.date ?? tweakDate, minutesOf(hhmm)) + ((t.live?.delays?.[stopId] ?? (t.live?.stops && !t.live.stops.includes(stopId) ? 0 : t.live?.delay ?? 0)) * MIN);
  let tweakDate;
  let early = 0;
  for (const w of tweaks) {
    tweakDate = w.date;
    const i = idx.get(w.tripId);
    if (i == null) continue;
    const t = trips[i];
    if (w.type === 'earlier') {
      const id = `${t.id}~early${++early}`;
      const copy = { ...t, id, added: true, live: true, date: t.date ?? w.date, stops: t.stops.map(([s, m]) => [s, minutesOf(m) - EARLIER_BY_MIN]) };
      delete copy.cancelled;
      idx.set(id, trips.push(copy) - 1);
      continue;
    }
    const ahead = t.stops.filter(([s, m]) => timeOf(t, s, m) >= w.at).map(([s]) => s);
    const live = t.live && t.live !== true ? { ...t.live } : {};
    if (w.type === 'late') {
      const delays = { ...live.delays };
      for (const [s] of t.stops) delays[s] = (delays[s] ?? (live.stops && !live.stops.includes(s) ? 0 : live.delay ?? 0)) + (ahead.includes(s) ? w.min : 0);
      trips[i] = { ...t, live: { ...live, delays } };
    } else if (w.type === 'cancel') {
      trips[i] = { ...t, live: t.live || true, cancelled: [...new Set([...(t.cancelled ?? []), ...ahead])] };
    }
  }
  return { ...base, trips };
}
