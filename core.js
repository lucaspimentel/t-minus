// Pure logic for mbta-leave-by. No DOM, no network; unit tested with `node --test`.

export const TZ = 'America/New_York';
const MIN = 60_000;
export const DEFAULT_DEPARTURE_COUNT = 4;
export const MAX_DEPARTURE_COUNT = 8;
export const DEFAULT_STOP_SLACK_MINUTES = 1;
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
  if (cfg.departureCount !== undefined &&
      !(Number.isInteger(cfg.departureCount) && cfg.departureCount >= 1 && cfg.departureCount <= MAX_DEPARTURE_COUNT)) {
    errors.push(`departureCount must be an integer from 1 to ${MAX_DEPARTURE_COUNT}.`);
  }
  if (!Array.isArray(cfg.trips) || cfg.trips.length < 1) {
    errors.push(cfg.commutes
      ? 'This is the old config format (commutes); rebuild it as trips (see examples/bus-orange.json).'
      : 'trips must be a non-empty array.');
    return errors;
  }
  cfg.trips.forEach((t, i) => {
    const p = `trips[${i}]`;
    if (!t?.name) errors.push(`${p}.name is required.`);
    if (!Array.isArray(t?.legs)) { errors.push(`${p}.legs must be an array.`); return; }
    const transitCount = t.legs.filter(l => l?.kind === 'transit').length;
    if (transitCount < 1) errors.push(`${p} needs at least one transit leg.`);
    t.legs.forEach((l, j) => {
      const q = `${p}.legs[${j}]`;
      if (l?.kind === 'walk' || l?.kind === 'transfer') {
        if (!Number.isFinite(l.minutes) || l.minutes < 0) errors.push(`${q}.minutes must be a number >= 0.`);
      } else if (l?.kind === 'transit') {
        if (!l.route) errors.push(`${q}.route is required.`);
        if (l.direction_id !== 0 && l.direction_id !== 1) errors.push(`${q}.direction_id must be 0 or 1.`);
        if (!l.stop || !l.alight) errors.push(`${q}.stop and .alight are required.`);
        else if (l.stop === l.alight) errors.push(`${q}.stop and .alight must differ.`);
      } else {
        errors.push(`${q}.kind must be walk, transfer, or transit.`);
      }
    });
    if (t.window !== undefined) {
      const w = t.window;
      const ok = w && HHMM_RE.test(w.from ?? '') && HHMM_RE.test(w.to ?? '') &&
        parseHHMM(w.from) < 24 * 60 && parseHHMM(w.to) <= 24 * 60;
      if (!ok) errors.push(`${p}.window must be { "from": "HH:MM", "to": "HH:MM" } (to may be 24:00).`);
    }
    if (t.timingLeg !== undefined && t.timingLeg !== null &&
        !(Number.isInteger(t.timingLeg) && t.timingLeg >= 0 && t.timingLeg < transitCount)) {
      errors.push(`${p}.timingLeg must be a transit leg index from 0 to ${transitCount - 1}.`);
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
    timingLeg: Number.isInteger(trip.timingLeg) ? trip.timingLeg : null,
    walkBefore,
    walkAfter,
    transit: transit.map((l, i) => ({
      route: l.route, direction_id: l.direction_id, stop: l.stop, alight: l.alight,
      transferBefore: i === 0 ? 0 : transfers[i - 1],
    })),
  };
}

export function formToTrip(form) {
  const legs = [];
  if (form.walkBefore > 0) legs.push({ kind: 'walk', minutes: form.walkBefore });
  form.transit.forEach((t, i) => {
    if (i > 0 && t.transferBefore > 0) legs.push({ kind: 'transfer', minutes: t.transferBefore });
    legs.push({ kind: 'transit', route: t.route, direction_id: t.direction_id, stop: t.stop, alight: t.alight });
  });
  if (form.walkAfter > 0) legs.push({ kind: 'walk', minutes: form.walkAfter });
  const trip = { name: form.name };
  if (form.window) trip.window = { ...form.window };
  if (Number.isInteger(form.timingLeg)) trip.timingLeg = form.timingLeg;
  trip.legs = legs;
  return trip;
}

// Buses are known by number ("132"); rail by name ("Orange Line", "Green Line B").
export function routeLabel(route) {
  const a = route.attributes ?? {};
  return (a.type === 3 ? a.short_name : a.long_name) || a.short_name || a.long_name || route.id;
}

// Routes whose label, number, or long name contains the query, in MBTA sort order.
export function searchRoutes(routes, query = '') {
  const q = query.trim().toLowerCase();
  return routes
    .filter(r => !q || [routeLabel(r), r.attributes?.short_name, r.attributes?.long_name, r.id]
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

// Suggested transfer minutes between two legs: 3 within the same station, else 5.
export function defaultTransferMinutes(prevAlight, nextBoard, parentOf = new Map()) {
  const station = id => parentOf.get(id) ?? id;
  return prevAlight && nextBoard && station(prevAlight) === station(nextBoard) ? 3 : 5;
}

// ---------- config vs. API ----------

export const stopsKey = (route, directionId) => `${route}/${directionId}`;

// Unique route/direction pairs whose stop lists are needed to check a config.
export function stopQueries(cfg) {
  const pairs = new Map();
  for (const t of cfg.trips) {
    for (const l of t.legs) {
      if (l.kind === 'transit') pairs.set(stopsKey(l.route, l.direction_id), { route: l.route, direction_id: l.direction_id });
    }
  }
  return [...pairs.values()];
}

// Checks configured stops against `/stops?filter[route]&filter[direction_id]&include=child_stops`
// docs (keyed by `stopsKey`). The API lists stops in trip order for the direction, so order
// errors reveal a wrong direction_id even when both stops are served both ways.
export function checkStops(cfg, stopsByKey) {
  const errors = [];
  cfg.trips.forEach((t, i) => {
    for (const l of t.legs) {
      if (l.kind !== 'transit') continue;
      const p = `trips[${i}] ${l.route}`;
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
  });
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
// after it was set; otherwise the first trip whose window contains now; otherwise the last used.
export function pickTrip(nowMs, cfg, override, lastUsed) {
  const n = cfg.trips.length;
  if (override && override.index >= 0 && override.index < n && nowMs < nextWindowStart(override.setAt, cfg.trips)) {
    return override.index;
  }
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
export function tripRows(trip, vehiclesByLeg, timingIdx, nowMs, slackMinutes, count = DEFAULT_DEPARTURE_COUNT) {
  const { transit, walkBefore, walkAfter, transfers } = tripShape(trip);
  const n = transit.length;
  const rows = [];
  for (const v of vehiclesByLeg[timingIdx] ?? []) {
    if (rows.length >= count) break;
    if (v.dep <= nowMs) continue;
    const chain = new Array(n);
    chain[timingIdx] = v;
    let ok = true;

    for (let i = timingIdx - 1; i >= 0 && ok; i--) {
      const latestArr = chain[i + 1].dep - transfers[i] * MIN;
      let best = null;
      for (const c of vehiclesByLeg[i] ?? []) if (c.arr <= latestArr && (!best || c.dep > best.dep)) best = c;
      if (best) chain[i] = best; else ok = false;
    }
    // Timing leg first: show it until it leaves ("Hurry"); otherwise the first vehicle must be
    // reachable on foot from now.
    if (!ok || (timingIdx > 0 && chain[0].dep < nowMs + walkBefore * MIN)) continue;

    for (let i = timingIdx + 1; i < n && ok; i++) {
      const earliestDep = chain[i - 1].arr + transfers[i - 1] * MIN;
      const next = (vehiclesByLeg[i] ?? []).find(c => c.dep >= earliestDep);
      if (next) chain[i] = next; else ok = false;
    }
    if (!ok) continue;

    rows.push({
      key: v.tripId,
      leaveBy: chain[0].dep - (walkBefore + (timingIdx === 0 ? slackMinutes : 0)) * MIN,
      firstDep: chain[0].dep,
      eta: chain[n - 1].arr + walkAfter * MIN,
      timingIdx,
      legs: chain.map((c, i) => ({ route: transit[i].route, dep: c.dep, arr: c.arr, source: c.source })),
    });
  }
  return rows;
}

export function countdownState(nowMs, leaveBy, firstDep) {
  if (nowMs >= firstDep) return 'hidden';
  if (leaveBy == null) return 'none';
  if (nowMs < leaveBy - 2 * MIN) return 'green';
  if (nowMs < leaveBy) return 'amber';
  return 'red';
}

// Today's rows first; remaining slots filled from the next service day.
export function fillRows(todayRows, nextRows, count = DEFAULT_DEPARTURE_COUNT) {
  return [...todayRows, ...nextRows.map(r => ({ ...r, nextDay: true }))].slice(0, count);
}

export function pollIntervalMs(rows, nowMs) {
  const soon = rows.some(r => r.leaveBy != null && r.firstDep > nowMs && r.leaveBy - nowMs <= 15 * MIN);
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

// Prefixes the weekday when `ms` falls on a different local calendar date than `nowMs`.
export function formatTime(ms, nowMs) {
  const t = timeFmt.format(new Date(ms));
  if (nowMs == null || localParts(ms).date === localParts(nowMs).date) return t;
  return `${weekdayFmt.format(new Date(ms))} ${t}`;
}

export function formatCountdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}:${pad(s % 60)}`;
}
