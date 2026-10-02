// Pure logic for mbta-leave-by. No DOM, no network; unit tested with `node --test`.

export const TZ = 'America/New_York';
const MIN = 60_000;
export const DEFAULT_DEPARTURE_COUNT = 4;
export const MISSED_MINUTES = 10;
export const MAX_DEPARTURE_COUNT = 8;
export const DEFAULT_STOP_SLACK_MINUTES = 1;
export const DEFAULT_WAKE_MINUTES = 10;
// A leg becomes the timing leg only when its headway is this much longer than the current one's,
// so the choice doesn't flip back and forth between refreshes.
export const TIMING_HYSTERESIS = 1.5;

// Effects that affect whether/when a trip runs. Facility and station-amenity alerts are excluded.
export const ALERT_EFFECTS = new Set([
  'DELAY', 'DETOUR', 'SUSPENSION', 'SHUTTLE', 'STOP_CLOSURE', 'STATION_CLOSURE',
  'CANCELLATION', 'SERVICE_CHANGE', 'STOP_MOVE', 'STOP_MOVED', 'NO_SERVICE',
]);

// ---------- config ----------

const HHMM_RE = /^\d{1,2}:\d{2}$/;
const COLOR_RE = /^[0-9A-Fa-f]{6}$/;

function parseHHMM(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['Config must be a JSON object.'];
  if (cfg.stopSlackMinutes !== undefined && !(Number.isFinite(cfg.stopSlackMinutes) && cfg.stopSlackMinutes >= 0)) {
    errors.push('stopSlackMinutes must be a number >= 0.');
  }
  if (cfg.wakeMinutes !== undefined && !(Number.isFinite(cfg.wakeMinutes) && cfg.wakeMinutes >= 0)) {
    errors.push('wakeMinutes must be a number >= 0.');
  }
  if (cfg.departureCount !== undefined &&
      !(Number.isInteger(cfg.departureCount) && cfg.departureCount >= 1 && cfg.departureCount <= MAX_DEPARTURE_COUNT)) {
    errors.push(`departureCount must be an integer from 1 to ${MAX_DEPARTURE_COUNT}.`);
  }
  if (!Array.isArray(cfg.trips) || cfg.trips.length < 1) {
    errors.push(cfg.commutes
      ? 'This is the old config format (commutes); rebuild it as trips in setup.'
      : 'trips must be a non-empty array.');
    return errors;
  }
  cfg.trips.forEach((t, i) => {
    const p = `${tripLabel(cfg.trips, i)}:`;
    if (!t?.name) errors.push(`${p} name is required.`);
    if (!Array.isArray(t?.legs)) { errors.push(`${p} legs must be an array.`); return; }
    const transitCount = t.legs.filter(l => l?.kind === 'transit').length;
    if (transitCount < 1) errors.push(`${p} needs at least one transit leg.`);
    t.legs.forEach((l, j) => {
      const q = `${p} legs[${j}]`;
      if (l?.kind === 'walk' || l?.kind === 'transfer') {
        if (!Number.isFinite(l.minutes) || l.minutes < 0) errors.push(`${q}.minutes must be a number >= 0.`);
      } else if (l?.kind === 'transit') {
        if (!l.route) errors.push(`${q}.route is required.`);
        if (l.direction_id !== 0 && l.direction_id !== 1) errors.push(`${q}.direction_id must be 0 or 1.`);
        if (!l.stop || !l.alight) errors.push(`${q}.stop and .alight are required.`);
        else if (l.stop === l.alight) errors.push(`${q}.stop and .alight must differ.`);
        if (l.label !== undefined && typeof l.label !== 'string') errors.push(`${q}.label must be a string.`);
        if (l.color !== undefined && !COLOR_RE.test(l.color)) errors.push(`${q}.color must be a 6-digit hex color like "ED8B00".`);
        for (const k of ['lat', 'lon']) {
          if (l[k] !== undefined && !Number.isFinite(l[k])) errors.push(`${q}.${k} must be a number.`);
        }
      } else {
        errors.push(`${q}.kind must be walk, transfer, or transit.`);
      }
    });
    if (t.window !== undefined) {
      const w = t.window;
      const ok = w && HHMM_RE.test(w.from ?? '') && HHMM_RE.test(w.to ?? '') &&
        parseHHMM(w.from) < 24 * 60 && parseHHMM(w.to) <= 24 * 60;
      if (!ok) errors.push(`${p} window must be { "from": "HH:MM", "to": "HH:MM" } (to may be 24:00).`);
    }
    if (t.near !== undefined && t.near !== true) errors.push(`${p} near must be true if present.`);
    if (t.near === true && t.window != null) errors.push(`${p} can't have both near and window.`);
    if (t.timingLeg !== undefined && t.timingLeg !== null &&
        !(Number.isInteger(t.timingLeg) && t.timingLeg >= 0 && t.timingLeg < transitCount)) {
      errors.push(`${p} timingLeg must be a transit leg index from 0 to ${transitCount - 1}.`);
    }
  });
  return errors;
}

// Number of departures to show; optional in saved configs.
export function departureCount(cfg) {
  return cfg.departureCount ?? DEFAULT_DEPARTURE_COUNT;
}

export function stopSlackMinutes(cfg) {
  return cfg.stopSlackMinutes ?? DEFAULT_STOP_SLACK_MINUTES;
}

export function wakeMinutes(cfg) {
  return cfg.wakeMinutes ?? DEFAULT_WAKE_MINUTES;
}

// Transit legs plus the minutes around them: walking before the first transit leg, after the
// last one, and the transfer time between each consecutive pair (missing transfer = 0).
export function tripShape(trip) {
  const transit = [];
  const gaps = [0];
  for (const l of trip.legs) {
    if (l.kind === 'transit') { transit.push(l); gaps.push(0); } else gaps[gaps.length - 1] += l.minutes;
  }
  return { transit, walkBefore: gaps[0], walkAfter: gaps[gaps.length - 1], transfers: gaps.slice(1, -1) };
}

// Stops and routes worth fetching/alerting for a trip.
export function commuteEntities(trip) {
  const routes = new Set();
  const stops = new Set();
  for (const l of trip.legs) {
    if (l.kind !== 'transit') continue;
    routes.add(l.route);
    for (const s of [l.stop, l.alight]) if (s) stops.add(s);
  }
  return { routes, stops };
}

// ---------- setup form model ----------

// Editor model for one trip: walk/transfer minutes as fields around the transit legs instead
// of separate legs. `formToTrip` writes the canonical legs back (walk, transit, transfer,
// transit, ..., walk), omitting zero-minute walks and transfers.
export function tripToForm(trip) {
  const { transit, walkBefore, walkAfter, transfers } = tripShape(trip);
  return {
    name: trip.name ?? '',
    window: trip.window ? { ...trip.window } : null,
    near: trip.near === true,
    timingLeg: Number.isInteger(trip.timingLeg) ? trip.timingLeg : null,
    walkBefore,
    walkAfter,
    transit: transit.map((l, i) => ({
      route: l.route, direction_id: l.direction_id, stop: l.stop, alight: l.alight,
      ...routeLook(l),
      transferBefore: i === 0 ? 0 : transfers[i - 1],
    })),
  };
}

// A transit leg's stored label, color, and board stop coordinates, when present.
const routeLook = l => ({
  ...(l.label !== undefined && { label: l.label }),
  ...(l.color !== undefined && { color: l.color }),
  ...(l.lat !== undefined && { lat: l.lat, lon: l.lon }),
});

export function formToTrip(form) {
  const legs = [];
  if (form.walkBefore > 0) legs.push({ kind: 'walk', minutes: form.walkBefore });
  form.transit.forEach((t, i) => {
    if (i > 0 && t.transferBefore > 0) legs.push({ kind: 'transfer', minutes: t.transferBefore });
    legs.push({ kind: 'transit', route: t.route, direction_id: t.direction_id, stop: t.stop, alight: t.alight, ...routeLook(t) });
  });
  if (form.walkAfter > 0) legs.push({ kind: 'walk', minutes: form.walkAfter });
  const trip = { name: form.name };
  if (form.window) trip.window = { ...form.window };
  else if (form.near) trip.near = true;
  if (Number.isInteger(form.timingLeg)) trip.timingLeg = form.timingLeg;
  trip.legs = legs;
  return trip;
}

// Buses are known by number ("132"); rail by name ("Orange Line", "Green Line B").
export function routeLabel(route) {
  const a = route.attributes ?? {};
  return (a.type === 3 ? a.short_name : a.long_name) || a.short_name || a.long_name || route.id;
}

// Compact label for rows and setup summaries: "Orange", "Green B", "Mattapan" for rail,
// "Silver SL1" for the Silver Line, "Bus 132" / "Bus CT3" for other buses.
export function shortRouteLabel(route) {
  const a = route.attributes ?? {};
  if (a.type === 3 && a.short_name) return `${a.short_name.startsWith('SL') ? 'Silver' : 'Bus'} ${a.short_name}`;
  return (a.long_name || routeLabel(route)).replace(/ Line\b/, '');
}

// Refreshes each transit leg's `label` and `color` from `/routes` resources; legs whose route
// isn't listed keep what they have.
export function labelLegs(cfg, routes) {
  const byId = new Map(routes.map(r => [r.id, r]));
  return {
    ...cfg,
    trips: cfg.trips.map(t => ({
      ...t,
      legs: t.legs.map(l => {
        const r = l.kind === 'transit' && byId.get(l.route);
        if (!r) return l;
        const color = r.attributes?.color;
        return { ...l, label: shortRouteLabel(r), ...(COLOR_RE.test(color ?? '') && { color }) };
      }),
    })),
  };
}

// The route's two ends, "A - B": a bus's long name already is; rail long names are just the
// line ("Orange Line"), so use the direction destinations ("Forest Hills - Oak Grove").
export function routeEnds(route) {
  const a = route.attributes ?? {};
  if (a.type === 3) return a.long_name ?? '';
  const d = a.direction_destinations;
  return Array.isArray(d) && d[0] && d[1] ? `${d[0]} - ${d[1]}` : '';
}

// Routes whose label, number, long name, or ends contain the query, in MBTA sort order.
export function searchRoutes(routes, query = '') {
  const q = query.trim().toLowerCase();
  return routes
    .filter(r => !q || [routeLabel(r), shortRouteLabel(r), routeEnds(r), r.attributes?.short_name, r.attributes?.long_name, r.id]
      .some(s => s && String(s).toLowerCase().includes(q)))
    .sort((a, b) => (a.attributes?.sort_order ?? 0) - (b.attributes?.sort_order ?? 0));
}

// Stops (JSON:API stop resources) whose name contains the query, keeping trip order.
export function searchStops(stops, query = '') {
  const q = query.trim().toLowerCase();
  return q ? stops.filter(s => (s.attributes?.name ?? s.id).toLowerCase().includes(q)) : stops;
}

// Drop-off candidates: the stops after the board stop in this direction's trip order.
export function stopsAfter(stops, boardId) {
  const i = stops.findIndex(s => s.id === boardId);
  return i < 0 ? [] : stops.slice(i + 1);
}

// The trip back: legs in reverse order, opposite directions, board and drop-off swapped,
// walks swapped, each transfer kept between the same pair of legs. No time window. Reversed
// bus stops are usually on the other side of the street; the save-time stop check flags them.
export function reverseTrip(trip) {
  const form = tripToForm(trip);
  const n = form.transit.length;
  const transit = form.transit.map((_, i) => {
    const t = form.transit[n - 1 - i];
    return {
      route: t.route, direction_id: 1 - t.direction_id, stop: t.alight, alight: t.stop, ...routeLook(t),
      transferBefore: i === 0 ? 0 : form.transit[n - i].transferBefore,
    };
  });
  return formToTrip({
    name: `${form.name} (return)`,
    window: null,
    timingLeg: form.timingLeg == null ? null : n - 1 - form.timingLeg,
    walkBefore: form.walkAfter,
    walkAfter: form.walkBefore,
    transit,
  });
}

// Sets each transit leg's board stop coordinates (`lat`, `lon`) from loaded /stops docs (a child
// platform id takes its listed parent's); legs whose docs aren't loaded keep what they have.
export function locateLegs(cfg, stopsByKey) {
  return {
    ...cfg,
    trips: cfg.trips.map(t => ({
      ...t,
      legs: t.legs.map(l => {
        if (l.kind !== 'transit') return l;
        const listed = stopsByKey.get(stopsKey(l.route, l.direction_id))?.data ?? [];
        const s = listed.find(x => x.id === l.stop || (x.relationships?.child_stops?.data ?? []).some(c => c.id === l.stop));
        const { latitude: lat, longitude: lon } = s?.attributes ?? {};
        return Number.isFinite(lat) && Number.isFinite(lon) ? { ...l, lat, lon } : l;
      }),
    })),
  };
}

// Approximate distance in meters (equirectangular; fine at city scale).
export function distanceMeters(a, b) {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const dy = (a.lat - b.lat) * 111_320;
  const dx = (a.lon - b.lon) * 111_320 * k;
  return Math.hypot(dx, dy);
}

export const NEAR_METERS = 1000;

// Trip to show for a position `{ lat, lon }`, or -1: among `near` trips with first-stop
// coordinates, the nearest within NEAR_METERS that is at least 2x closer than any `near` trip
// with a different first stop. Trips sharing the first stop go by list order.
export function pickByLocation(trips, pos) {
  const cands = [];
  trips.forEach((t, i) => {
    const first = t.near === true && t.legs.find(l => l.kind === 'transit');
    if (first && Number.isFinite(first.lat) && Number.isFinite(first.lon)) {
      cands.push({ i, stop: first.stop, d: distanceMeters(pos, first) });
    }
  });
  if (!cands.length) return -1;
  const best = cands.reduce((a, b) => (b.d < a.d ? b : a));
  if (best.d > NEAR_METERS) return -1;
  const rival = Math.min(...cands.filter(c => c.stop !== best.stop).map(c => c.d));
  return rival >= 2 * best.d ? best.i : -1;
}

// The stop (JSON:API resource with latitude/longitude) closest to a point.
export function nearestStop(stops, lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180); // shrink longitude degrees at this latitude
  let best = null;
  let bestD = Infinity;
  for (const s of stops) {
    const a = s.attributes ?? {};
    if (a.latitude == null || a.longitude == null) continue;
    const d = (a.latitude - lat) ** 2 + ((a.longitude - lon) * k) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// Suggested transfer minutes between two legs: 3 within the same station, else 5.
export function defaultTransferMinutes(prevAlight, nextBoard, parentOf = new Map()) {
  const station = id => parentOf.get(id) ?? id;
  return prevAlight && nextBoard && station(prevAlight) === station(nextBoard) ? 3 : 5;
}

// ---------- config vs. API ----------

export const stopsKey = (route, directionId) => `${route}/${directionId}`;

// Names a trip in error messages: `Trip "Name"`, with its 1-based position when the name is
// missing (`Trip 2`) or shared with another trip (`Trip 2 "Name"`).
export function tripLabel(trips, i) {
  const name = typeof trips[i]?.name === 'string' ? trips[i].name.trim() : '';
  if (!name) return `Trip ${i + 1}`;
  const shared = trips.some((t, j) => j !== i && typeof t?.name === 'string' && t.name.trim() === name);
  return shared ? `Trip ${i + 1} "${name}"` : `Trip "${name}"`;
}

// Trip indices to check: all, or only those listed in `only`.
const selectedTrips = (cfg, only) =>
  cfg.trips.map((t, i) => [t, i]).filter(([, i]) => !only || [...only].includes(i));

// Unique route/direction pairs whose stop lists are needed to check a config
// (optionally only the trips at indices `only`).
export function stopQueries(cfg, only) {
  const pairs = new Map();
  for (const [t] of selectedTrips(cfg, only)) {
    for (const l of t.legs) {
      if (l.kind === 'transit') pairs.set(stopsKey(l.route, l.direction_id), { route: l.route, direction_id: l.direction_id });
    }
  }
  return [...pairs.values()];
}

// Checks configured stops against `/stops?filter[route]&filter[direction_id]&include=child_stops`
// docs (keyed by `stopsKey`). The API lists stops in trip order for the direction, so order
// errors reveal a wrong direction_id even when both stops are served both ways.
// `only` limits the check to those trip indices; labels still use the full trip list.
export function checkStops(cfg, stopsByKey, only) {
  const errors = [];
  for (const [t, i] of selectedTrips(cfg, only)) {
    for (const l of t.legs) {
      if (l.kind !== 'transit') continue;
      const p = `${tripLabel(cfg.trips, i)}: route ${l.route}`;
      const listed = stopsByKey.get(stopsKey(l.route, l.direction_id))?.data ?? [];
      if (listed.length === 0) {
        errors.push(`${p}: no stops for route "${l.route}" in direction ${l.direction_id}; check route and direction_id.`);
        continue;
      }
      // Stop id (or child platform id) → position in trip order.
      const position = new Map();
      listed.forEach((s, idx) => {
        position.set(s.id, idx);
        for (const child of s.relationships?.child_stops?.data ?? []) position.set(child.id, idx);
      });
      for (const field of ['stop', 'alight']) {
        const id = l[field];
        if (id && !position.has(id)) {
          errors.push(`${p}: ${field} "${id}" is not served by route ${l.route} in direction ${l.direction_id}.`);
        }
      }
      if (position.has(l.stop) && position.has(l.alight) && position.get(l.stop) >= position.get(l.alight)) {
        errors.push(`${p}: stop "${l.stop}" comes after alight "${l.alight}" in direction ${l.direction_id}; direction_id is probably wrong.`);
      }
    }
  }
  return errors;
}

// ---------- time ----------

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

// Local wall-clock parts in America/New_York.
export function localParts(nowMs) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const pad = n => String(n).padStart(2, '0');
const hhmm = mins => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

// MBTA service days run past midnight; before 03:00 the service date is the previous day
// and times are expressed with hours >= 24.
export function serviceDate(nowMs) {
  const { date, hour, minute } = localParts(nowMs);
  return hour < 3
    ? { date: addDays(date, -1), minutes: (hour + 24) * 60 + minute }
    : { date, minutes: hour * 60 + minute };
}

// Service days end by 04:00 the next morning (28:00).
const SERVICE_DAY_END = 28 * 60;
// Windows reaching past this point are extended to the end of the service day.
const LATE_EXTEND_FROM = 22 * 60;

// Schedule query window for the current service day. Late windows are extended to the end
// of the service day so `coversEndOfService` tells whether "few rows" means service is ending.
export function scheduleWindow(nowMs, backMinutes = 5, aheadMinutes = 360) {
  const { date, minutes } = serviceDate(nowMs);
  const min = Math.max(0, minutes - backMinutes);
  let max = minutes + aheadMinutes;
  if (max >= LATE_EXTEND_FROM) max = Math.max(max, SERVICE_DAY_END);
  return { date, minTime: hhmm(min), maxTime: hhmm(max), coversEndOfService: max >= SERVICE_DAY_END };
}

// Morning of the next service day, used to fill rows once today's service has ended.
export function nextServiceWindow(nowMs) {
  return { date: addDays(serviceDate(nowMs).date, 1), minTime: '03:00', maxTime: '12:00' };
}

// ---------- trip selection ----------

const DAY_MIN = 24 * 60;

function minuteOfDay(nowMs) {
  const { hour, minute } = localParts(nowMs);
  return hour * 60 + minute;
}

// Whether a local minute-of-day falls in a window; `to < from` crosses midnight and
// `from == to` covers the whole day.
export function inWindow(minute, window) {
  const from = parseHHMM(window.from);
  const to = parseHHMM(window.to);
  if (from === to) return true;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

// Next time (ms) any trip's window starts strictly after `ms`; Infinity if no trip has a window.
function nextWindowStart(ms, trips) {
  const m = minuteOfDay(ms);
  let best = Infinity;
  for (const t of trips) {
    if (!t.window) continue;
    const delta = ((parseHHMM(t.window.from) - m + DAY_MIN) % DAY_MIN) || DAY_MIN;
    best = Math.min(best, ms - (ms % MIN) + delta * MIN);
  }
  return best;
}

// Trip index to show: a manual override `{ index, setAt }` holds until the next window start
// after it was set; then a location match (`located`, from pickByLocation); then the first trip
// whose window contains now; otherwise the last used.
export function pickTrip(nowMs, cfg, override, lastUsed, located = -1) {
  const n = cfg.trips.length;
  if (override && override.index >= 0 && override.index < n && nowMs < nextWindowStart(override.setAt, cfg.trips)) {
    return override.index;
  }
  if (located >= 0 && located < n) return located;
  const m = minuteOfDay(nowMs);
  const inside = cfg.trips.findIndex(t => t.window && inWindow(m, t.window));
  if (inside >= 0) return inside;
  return Number.isInteger(lastUsed) && lastUsed >= 0 && lastUsed < n ? lastUsed : 0;
}

// ---------- trips ----------

function parentMapOf(...docs) {
  const map = new Map();
  for (const doc of docs) {
    for (const inc of doc?.included ?? []) {
      if (inc.type !== 'stop') continue;
      const parent = inc.relationships?.parent_station?.data?.id;
      if (parent) map.set(inc.id, parent);
    }
  }
  return map;
}

const toMs = s => (s ? Date.parse(s) : null);

// Merges /predictions and /schedules JSON:API docs into
// Map<tripId, Map<stopId, { arr, dep, source }>>, keyed by both child and parent stop id.
// A prediction replaces the schedule for the same trip and stop.
export function mergeTrips(predictionsDoc, schedulesDoc) {
  const parents = parentMapOf(predictionsDoc, schedulesDoc);
  const trips = new Map();
  const put = (rec, source) => {
    const tripId = rec.relationships?.trip?.data?.id;
    const stopId = rec.relationships?.stop?.data?.id;
    if (!tripId || !stopId) return;
    const a = rec.attributes ?? {};
    let stops = trips.get(tripId);
    if (!stops) trips.set(tripId, (stops = new Map()));
    if (source === 'live' && (a.schedule_relationship === 'SKIPPED' || a.schedule_relationship === 'CANCELLED')) {
      stops.set(stopId, { cancelled: true });
      if (parents.has(stopId)) stops.set(parents.get(stopId), { cancelled: true });
      return;
    }
    const arr = toMs(a.arrival_time);
    const dep = toMs(a.departure_time);
    if (arr == null && dep == null) return;
    const entry = { arr, dep, source };
    stops.set(stopId, entry);
    if (parents.has(stopId)) stops.set(parents.get(stopId), entry);
  };
  for (const rec of schedulesDoc?.data ?? []) put(rec, 'scheduled');
  for (const rec of predictionsDoc?.data ?? []) put(rec, 'live');
  return trips;
}

const depOf = e => e?.dep ?? e?.arr ?? null;
const arrOf = e => e?.arr ?? e?.dep ?? null;
const usable = e => e && !e.cancelled;

// Vehicles for one transit leg, sorted by departure: `{ tripId, dep, arr, source }` where
// `dep` is at the leg's board stop and `arr` at its alight stop. The source is the board
// stop's: that's the time the rider has to catch.
export function legVehicles(tripsMap, leg) {
  const out = [];
  for (const [tripId, stops] of tripsMap) {
    const board = stops.get(leg.stop);
    const alight = stops.get(leg.alight);
    if (!usable(board) || !usable(alight)) continue;
    const dep = depOf(board);
    const arr = arrOf(alight);
    if (dep == null || arr == null || arr <= dep) continue;
    out.push({ tripId, dep, arr, source: board.source });
  }
  return out.sort((a, b) => a.dep - b.dep);
}

// Live predictions disappear once a vehicle leaves the board stop. The last live times seen per
// leg (`[Map<tripId, {dep, arr}>]`) keep a just-missed ride on its real time instead of the
// schedule's. Entries that departed more than 30 min ago are dropped.
export function rememberLive(memory, liveByLeg, nowMs) {
  return liveByLeg.map((live, i) => {
    const m = new Map([...(memory?.[i] ?? [])].filter(([, e]) => e.dep > nowMs - 30 * MIN));
    for (const v of live) m.set(v.tripId, { dep: v.dep, arr: v.arr });
    return m;
  });
}

// Leg vehicles with remembered live times applied to those no longer predicted.
export function withRemembered(vehiclesByLeg, memory) {
  return vehiclesByLeg.map((vs, i) => {
    const m = memory?.[i];
    if (!m?.size) return vs;
    return vs.map(v => (v.source !== 'live' && m.has(v.tripId) ? { ...v, ...m.get(v.tripId), source: 'live' } : v))
      .sort((a, b) => a.dep - b.dep);
  });
}

// Mean gap between consecutive departures; Infinity with fewer than 2 (a leg that barely
// runs is the constraint).
export function averageHeadway(vehicles) {
  if (vehicles.length < 2) return Infinity;
  const deps = vehicles.map(v => v.dep).sort((a, b) => a - b);
  return (deps[deps.length - 1] - deps[0]) / (deps.length - 1);
}

// Index of the transit leg the leave-by time is based on: the pinned override, else the leg
// with the longest headway. The previous choice is kept unless the new candidate's headway is
// at least TIMING_HYSTERESIS times longer.
export function pickTimingLeg(headways, previous, override) {
  const n = headways.length;
  if (Number.isInteger(override) && override >= 0 && override < n) return override;
  if (n === 0) return 0;
  let best = 0;
  for (let i = 1; i < n; i++) if (headways[i] > headways[best]) best = i;
  if (Number.isInteger(previous) && previous >= 0 && previous < n && previous !== best &&
      !(headways[best] >= TIMING_HYSTERESIS * headways[previous])) {
    return previous;
  }
  return best;
}

// ---------- leave-by ----------

// Departure rows for a trip. For each timing-leg vehicle, earlier legs take the latest vehicle
// that still makes the next one (minimal waiting), later legs the earliest one after arrival.
// A departure is skipped if any leg has no feasible vehicle.
// Rows whose last chance has passed are "missed" until MISSED_MINUTES after the first vehicle
// departs; the most recent one leads the list (counting toward `count`, if `count` >= 2).
// En route (`enRoute` = { at, atStop }: "Leaving now" / "At the stop"), a ride is reachable if
// its first vehicle leaves at or after `atStop` (no stop slack), and rows have no leave-by.
export function tripRows(trip, vehiclesByLeg, timingIdx, nowMs, slackMinutes, count = DEFAULT_DEPARTURE_COUNT, enRoute = null) {
  const { transit, walkBefore, walkAfter, transfers } = tripShape(trip);
  const n = transit.length;
  const rows = [];
  let missed = null;
  for (const v of vehiclesByLeg[timingIdx] ?? []) {
    if (rows.length >= count) break;
    // The first vehicle leaves no later than the timing one.
    if (v.dep + MISSED_MINUTES * MIN <= nowMs) continue;
    const chain = new Array(n);
    chain[timingIdx] = v;
    let ok = true;

    for (let i = timingIdx - 1; i >= 0 && ok; i--) {
      const latestArr = chain[i + 1].dep - transfers[i] * MIN;
      let best = null;
      for (const c of vehiclesByLeg[i] ?? []) if (c.arr <= latestArr && (!best || c.dep > best.dep)) best = c;
      if (best) chain[i] = best; else ok = false;
    }
    if (!ok) continue;
    // En route, an unreachable ride's last chance is the (past) tap time: missed right away.
    const dep0 = chain[0].dep;
    const lastChance = enRoute ? (enRoute.atStop <= dep0 ? dep0 : enRoute.at) : dep0 - walkBefore * MIN;
    // Unreachable (last chance passed): a missed candidate while recent.
    const isMissed = lastChance <= nowMs;
    if (isMissed && (chain[0].dep + MISSED_MINUTES * MIN <= nowMs || (missed && missed.firstDep >= chain[0].dep))) continue;

    for (let i = timingIdx + 1; i < n && ok; i++) {
      const earliestDep = chain[i - 1].arr + transfers[i - 1] * MIN;
      const next = (vehiclesByLeg[i] ?? []).find(c => c.dep >= earliestDep);
      if (next) chain[i] = next; else ok = false;
    }
    if (!ok) continue;

    const row = {
      key: v.tripId,
      leaveBy: enRoute ? null : dep0 - (walkBefore + slackMinutes) * MIN,
      lastChance, // normally: arrive at the stop as it leaves
      ...(enRoute && { enRoute: true }),
      firstDep: chain[0].dep,
      eta: chain[n - 1].arr + walkAfter * MIN,
      timingIdx,
      legs: chain.map((c, i) => ({
        route: transit[i].route, label: transit[i].label ?? transit[i].route, color: transit[i].color ?? null,
        dep: c.dep, arr: c.arr, source: c.source, tripId: c.tripId,
      })),
    };
    if (isMissed) missed = { ...row, missed: true }; else rows.push(row);
  }
  return missed && count >= 2 ? [missed, ...rows.slice(0, count - 1)] : rows;
}

// Keep the screen on while an upcoming row is within `minutes` of its leave-by, until its last
// chance (0 = never).
export function keepAwake(rows, nowMs, minutes) {
  return minutes > 0 && rows.some(r => !r.missed && r.leaveBy != null && nowMs >= r.leaveBy - minutes * MIN && nowMs < r.lastChance);
}

// Steps of an expanded row: walk to the first stop (not en route; with the stop slack), legs,
// the actual gap at each transfer, and the final walk with the arrival time.
export function timelineSteps(row, trip, slackMinutes, nowMs) {
  const { walkBefore, walkAfter } = tripShape(trip);
  const steps = [];
  if (!row.enRoute) {
    const parts = [walkBefore > 0 && `Walk ${walkBefore} min`, slackMinutes > 0 && `${slackMinutes} min early at the stop`].filter(Boolean);
    if (parts.length) steps.push({ kind: 'walk', text: parts.join(' · ') });
  }
  row.legs.forEach((leg, i) => {
    if (i > 0) steps.push({ kind: 'walk', text: `${formatCountdown(leg.dep - row.legs[i - 1].arr)} to transfer` });
    steps.push({ kind: 'leg', leg });
  });
  const arrive = formatTime(row.eta, nowMs);
  steps.push({ kind: 'walk', text: walkAfter > 0 ? `Walk ${walkAfter} min · arrive ${arrive}` : `Arrive ${arrive}` });
  return steps;
}

// State of a row: 'enroute' for a reachable en-route row, else countdownState.
export function rowState(nowMs, row) {
  if (row.enRoute && nowMs < row.lastChance) return 'enroute';
  return countdownState(nowMs, row.leaveBy, row.lastChance, row.firstDep);
}

// "Leaving now" (at the stop after the walk) or "At the stop" (now). `at` is the first tap,
// kept when "At the stop" follows "Leaving now"; it caps the mode at 30 min.
export function startEnRoute(kind, nowMs, walkBefore, prev = null) {
  return { kind, at: prev?.at ?? nowMs, atStop: kind === 'leaving' ? nowMs + walkBefore * MIN : nowMs };
}

// Before boarding: the target is the first reachable en-route row, re-taken every tick. Once
// the target's first vehicle departs while it was reachable, boarding is assumed and its legs
// become the ride ({ legs, boardedAt }).
export function advanceEnRoute(state, rows, nowMs) {
  if (state.ride) return state;
  const t = state.target;
  if (t) {
    const row = rows.find(r => r.key === t.key);
    const dep = row?.firstDep ?? t.legs[0].dep;
    if (nowMs >= dep && state.atStop <= dep) {
      const { target: _, ...rest } = state;
      return { ...rest, ride: { legs: row?.legs ?? t.legs, boardedAt: dep } };
    }
  }
  const r = rows.find(x => x.enRoute && !x.missed);
  return r ? { ...state, target: { key: r.key, legs: r.legs } } : { ...state, target: null };
}

// Refreshes a ride's legs from the merged per-leg trip maps (mergeTrips) by trip id: live
// times first, then remembered live times (rememberLive), then schedules, else what's stored.
// A departed vehicle has no board entry; an arrived one no drop-off entry.
export function trackLegs(legs, transit, tripsMaps, memory = null) {
  return legs.map((leg, i) => {
    const stops = tripsMaps[i]?.get(leg.tripId);
    const board = stops?.get(transit[i].stop);
    const alight = stops?.get(transit[i].alight);
    const mem = memory?.[i]?.get(leg.tripId);
    const pick = (entry, remembered, of) => {
      if (usable(entry) && entry.source === 'live' && of(entry) != null) return [of(entry), 'live'];
      if (remembered != null) return [remembered, 'live'];
      if (usable(entry) && of(entry) != null) return [of(entry), entry.source];
      return null;
    };
    const d = pick(board, mem?.dep, depOf);
    const a = pick(alight, mem?.arr, arrOf);
    return {
      ...leg,
      ...(d && { dep: d[0], source: d[1] }),
      ...(a && { arr: a[0], arrSource: a[1] }),
    };
  });
}

// Phase of a ride: riding leg i (boarded, before its arrival), transfer before leg i (before
// its departure), walking (after the last arrival, before the ETA), arrived (5 min), done.
export function ridePhase(ride, walkAfter, nowMs) {
  const legs = ride.legs;
  const eta = legs[legs.length - 1].arr + walkAfter * MIN;
  for (let i = 0; i < legs.length; i++) {
    if (i > 0 && nowMs < legs[i].dep) return { kind: 'transfer', leg: i, eta };
    if (nowMs < legs[i].arr) return { kind: 'riding', leg: i, eta };
  }
  if (nowMs < eta) return { kind: 'walking', leg: legs.length, eta };
  return { kind: nowMs < eta + 5 * MIN ? 'arrived' : 'done', leg: legs.length, eta };
}

// "Missed it" is offered for 2 min after each boarding.
export function canUndoBoarding(ride, phase, nowMs) {
  if (phase.kind !== 'riding') return false;
  const boarded = phase.leg === 0 ? ride.boardedAt : ride.legs[phase.leg].dep;
  return nowMs < boarded + 2 * MIN;
}

// After missing leg `from`: its next vehicle departing at or after now (other than the missed
// one), then the earliest feasible later legs. Vehicles, or null if there's no connection.
export function replanFrom(vehiclesByLeg, from, nowMs, transfers, skipTripId = null) {
  const chain = [];
  let earliest = nowMs;
  for (let i = from; i < vehiclesByLeg.length; i++) {
    const next = (vehiclesByLeg[i] ?? []).find(v => v.dep >= earliest && v.tripId !== skipTripId);
    if (!next) return null;
    chain.push(next);
    earliest = next.arr + (transfers[i] ?? 0) * MIN;
  }
  return chain;
}

// Remaining stops of the ridden vehicle from `/predictions?filter[trip]=…&include=stop,vehicle`:
// `{ vehicle: { status, name } | null, stops: [{ id, name, time, dropOff }] }` up to the drop-off
// (`alightId`, or a child platform of it), or null if the drop-off isn't listed.
export function rideStops(doc, alightId, nowMs) {
  const inc = new Map((doc?.included ?? []).map(x => [`${x.type}/${x.id}`, x]));
  const stopOf = id => inc.get(`stop/${id}`);
  const preds = (doc?.data ?? [])
    .map(p => ({
      id: p.relationships?.stop?.data?.id,
      seq: p.attributes?.stop_sequence,
      time: toMs(p.attributes?.arrival_time) ?? toMs(p.attributes?.departure_time),
      last: Math.max(toMs(p.attributes?.arrival_time) ?? 0, toMs(p.attributes?.departure_time) ?? 0),
      vehicleId: p.relationships?.vehicle?.data?.id,
    }))
    .filter(p => p.id && p.time != null)
    .sort((a, b) => a.seq - b.seq);
  const isDropOff = id => id === alightId || stopOf(id)?.relationships?.parent_station?.data?.id === alightId;
  const end = preds.findIndex(p => isDropOff(p.id));
  if (end < 0) return null;
  const vid = preds.find(p => p.vehicleId)?.vehicleId;
  const v = vid && inc.get(`vehicle/${vid}`)?.attributes;
  // Not listed: stops already left (stale doc), and the stop the vehicle is stopped at (named
  // by `vehicle` instead), unless it's the drop-off.
  const stops = preds.slice(0, end + 1)
    .filter(p => p.last >= nowMs - 30_000)
    .filter(p => !(v?.current_status === 'STOPPED_AT' && p.seq === v.current_stop_sequence && !isDropOff(p.id)))
    .map(p => ({ id: p.id, name: stopOf(p.id)?.attributes?.name ?? p.id, time: p.time, dropOff: isDropOff(p.id) }));
  let vehicle = null;
  if (v) {
    const at = preds.find(p => p.seq === v.current_stop_sequence);
    const name = at ? stopOf(at.id)?.attributes?.name : null;
    if (name) vehicle = { status: v.current_status, name };
  }
  return { vehicle, stops };
}

// Copies a vehicle's trip and times onto a planned leg.
const onVehicle = (leg, v) => ({ ...leg, tripId: v.tripId, dep: v.dep, arr: v.arr, source: v.source, arrSource: undefined });

// The next connection while riding leg i (or in the transfer before leg i+1): needed = leg i's
// arrival + transfer; margin = leg i+1's departure − needed. A missed connection (margin < 0)
// re-plans legs i+1… to the earliest feasible chain after `needed` (never an earlier vehicle);
// `none` when there's no such chain (plan kept). Null without a next leg.
export function transferOutlook(ride, phase, vehiclesByLeg, transfers) {
  const i = phase.kind === 'riding' ? phase.leg : phase.kind === 'transfer' ? phase.leg - 1 : -1;
  const next = i + 1;
  if (i < 0 || next >= ride.legs.length) return null;
  const needed = ride.legs[i].arr + (transfers[i] ?? 0) * MIN;
  const planned = ride.legs[next];
  const base = { leg: next, needed, margin: planned.dep - needed, legs: ride.legs, missedDep: null, none: false };
  if (base.margin >= 0) return base;
  const chain = replanFrom(vehiclesByLeg, next, needed, transfers);
  if (!chain) return { ...base, none: true };
  const legs = ride.legs.map((l, k) => (k >= next ? onVehicle(l, chain[k - next]) : l));
  return { ...base, legs, margin: legs[next].dep - needed, missedDep: planned.dep };
}

// The outlook line: "Then Orange 7:31am · 4 min to spare" / "· tight" (under 2 min) /
// "(missed 7:31am)" after a re-plan (`ride.missed`) / "No connection after 7:26am".
export function outlookText(outlook, ride, nowMs) {
  if (!outlook) return null;
  if (outlook.none) return { text: `No connection after ${formatTime(outlook.needed, nowMs)}`, warn: true };
  const leg = outlook.legs[outlook.leg];
  const head = `Then ${leg.label} ${formatTime(leg.dep, nowMs)}`;
  const missed = outlook.missedDep ?? (ride.missed?.leg === outlook.leg ? ride.missed.dep : null);
  if (missed != null) return { text: `${head} (missed ${formatTime(missed, nowMs)})`, warn: true };
  if (outlook.margin < 2 * MIN) return { text: `${head} · tight`, warn: true };
  return { text: `${head} · ${formatCountdown(outlook.margin)} to spare`, warn: false };
}

// Vehicles of a leg that left after the assumed one and by now (up to 3): "I'm on a later one".
export function laterVehicles(vehicles, leg, nowMs) {
  return vehicles.filter(v => v.dep > leg.dep && v.dep <= nowMs && v.tripId !== leg.tripId).slice(0, 3);
}

// The ride with leg i on `vehicle` and the later legs re-planned from its arrival (kept if
// there's no connection).
export function switchLeg(ride, i, vehicle, vehiclesByLeg, transfers) {
  const chain = replanFrom(vehiclesByLeg, i + 1, vehicle.arr + (transfers[i] ?? 0) * MIN, transfers) ?? [];
  const legs = ride.legs.map((l, k) => (k === i ? onVehicle(l, vehicle) : chain[k - i - 1] ? onVehicle(l, chain[k - i - 1]) : l));
  const { missed: _, ...rest } = ride;
  return { ...rest, legs, ...(i === 0 && { boardedAt: vehicle.dep }) };
}

export function rideHeadline(phase, ride, nowMs) {
  const leg = ride.legs[phase.leg];
  switch (phase.kind) {
    case 'riding': return `On ${leg.label} · off at ${formatTime(leg.arr, nowMs)}`;
    case 'transfer': return `Transfer · ${leg.label} ${formatTime(leg.dep, nowMs)}`;
    case 'walking': return `Walking · arrive ${formatTime(phase.eta, nowMs)}`;
    default: return `Arrived ~${formatTime(phase.eta, nowMs)}`;
  }
}

// Before boarding: 30 min after the first tap. With a ride: until it's done.
export function enRouteActive(state, walkAfter, nowMs) {
  if (!state) return false;
  if (state.ride) return ridePhase(state.ride, walkAfter, nowMs).kind !== 'done';
  return nowMs < state.at + 30 * MIN;
}

export function enRouteStatus(state, nowMs) {
  if (state.kind === 'stop') return `At the stop since ${formatTime(state.atStop, nowMs)}`;
  if (nowMs >= state.atStop) return `At the stop since ~${formatTime(state.atStop, nowMs)}`;
  return `Walking · at the stop ~${formatTime(state.atStop, nowMs)}`;
}

// green until 3 min before leave-by, amber until leave-by, red ("Hurry") until the last chance,
// then gray ("Missed") until MISSED_MINUTES after the first vehicle departs.
export function countdownState(nowMs, leaveBy, lastChance, firstDep) {
  if (nowMs >= lastChance) return nowMs < firstDep + MISSED_MINUTES * MIN ? 'missed' : 'hidden';
  if (leaveBy == null) return 'none';
  if (nowMs < leaveBy - 3 * MIN) return 'green';
  if (nowMs < leaveBy) return 'amber';
  return 'red';
}

// Today's rows first; remaining slots filled from the next service day.
export function fillRows(todayRows, nextRows, count = DEFAULT_DEPARTURE_COUNT) {
  return [...todayRows, ...nextRows.map(r => ({ ...r, nextDay: true }))].slice(0, count);
}

export function pollIntervalMs(rows, nowMs, riding = false) {
  if (riding) return 60_000;
  const soon = rows.some(r => r.lastChance > nowMs && (r.enRoute || (r.leaveBy != null && r.leaveBy - nowMs <= 15 * MIN)));
  return soon ? 60_000 : 120_000;
}

// ---------- alerts ----------

// Expands configured stop ids with child stops found in trip data (child → parent map).
export function expandStops(stops, childToParent) {
  const out = new Set(stops);
  for (const [child, parent] of childToParent) if (stops.has(parent)) out.add(child);
  return out;
}

export function childToParentMap(...docs) {
  return parentMapOf(...docs);
}

export function filterAlerts(alertsDoc, routes, stops, nowMs) {
  const out = [];
  for (const a of alertsDoc?.data ?? []) {
    const at = a.attributes ?? {};
    if (!ALERT_EFFECTS.has(at.effect)) continue;
    const active = (at.active_period ?? []).some(p =>
      (p.start == null || Date.parse(p.start) <= nowMs) && (p.end == null || Date.parse(p.end) > nowMs));
    if (!active) continue;
    const relevant = (at.informed_entity ?? []).some(e =>
      e.route && routes.has(e.route) && (!e.stop || stops.has(e.stop)));
    if (!relevant) continue;
    out.push({ id: a.id, effect: at.effect, header: at.short_header || at.header, severity: at.severity });
  }
  return out.sort((x, y) => (y.severity ?? 0) - (x.severity ?? 0));
}

// ---------- formatting ----------

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });

// Compact clock time ("5:48pm"). Prefixes the weekday when `ms` falls on a different local
// calendar date than `nowMs` ("Thu 6:03am").
export function formatTime(ms, nowMs) {
  const t = timeFmt.format(new Date(ms)).replace(/\s*([AP])M$/, (_, p) => `${p.toLowerCase()}m`);
  if (nowMs == null || localParts(ms).date === localParts(nowMs).date) return t;
  return `${weekdayFmt.format(new Date(ms))} ${t}`;
}

// A trip's time window for the setup list: "When chosen", or "6:00am–12:00pm" ("midnight" for
// 00:00 and 24:00).
export function windowLabel(window) {
  if (!window) return 'When chosen';
  const clock = s => {
    const [h, m] = s.split(':').map(Number);
    if (h % 24 === 0 && m === 0) return 'midnight';
    return `${h % 12 || 12}:${pad(m)}${h % 24 < 12 ? 'am' : 'pm'}`;
  };
  return `${clock(window.from)}–${clock(window.to)}`;
}

// Headline for a departure row, given its countdownState and the time left until leave-by
// (green, amber), the last chance (red), or the first departure (missed).
export function countdownLabel(state, msLeft, label = '') {
  switch (state) {
    case 'enroute': return `${label} in ${formatCountdown(msLeft)}`;
    case 'green':
    case 'amber': return `Leave in ${formatCountdown(msLeft)}`;
    case 'red': return `Hurry · ${formatCountdown(msLeft)}`;
    // msLeft: until the first vehicle departs (negative once it has).
    case 'missed': return msLeft > 0 ? `Missed · leaves in ${formatCountdown(msLeft)}` : `Missed · ${formatCountdown(-msLeft)} ago`;
    default: return 'No connection';
  }
}

// Whole minutes, rounded down (7:10 left shows "7 min") so the countdown never overstates the
// time left and agrees with the leave-by time, whose seconds are dropped too.
export function formatCountdown(ms) {
  if (ms > 0 && ms < MIN) return '<1 min';
  const total = Math.max(0, Math.floor(ms / MIN));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m} min`;
}
