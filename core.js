// Pure logic for mbta-leave-by. No DOM, no network; unit tested with `node --test`.

export const TZ = 'America/New_York';
const MIN = 60_000;
export const DEFAULT_DEPARTURE_COUNT = 4;
export const MAX_DEPARTURE_COUNT = 8;

export const DEFAULT_CONFIG = {
  directionCutoff: '12:00',
  stopSlackMinutes: 1,
  departureCount: DEFAULT_DEPARTURE_COUNT,
  apiKey: '',
  commutes: [
    {
      name: 'Home to office',
      legs: [
        { kind: 'walk', minutes: 5 },
        { kind: 'transit', route: '132', direction_id: 1, stop: '25996', alight: '5991', role: 'bottleneck' },
        { kind: 'transfer', minutes: 5 },
        { kind: 'transit', route: 'Orange', direction_id: 0, from: 'place-ogmnl', to: 'place-state', rideMinutes: 15, role: 'filler' },
        { kind: 'walk', minutes: 10 },
      ],
    },
    {
      name: 'Office to home',
      legs: [
        { kind: 'walk', minutes: 10 },
        { kind: 'transit', route: 'Orange', direction_id: 1, from: 'place-state', to: 'place-ogmnl', role: 'connection' },
        { kind: 'transfer', minutes: 5 },
        { kind: 'transit', route: '132', direction_id: 0, stop: '9326', role: 'bottleneck' },
        { kind: 'walk', minutes: 5 },
      ],
    },
  ],
};

// Effects that affect whether/when a trip runs. Facility and station-amenity alerts are excluded.
export const ALERT_EFFECTS = new Set([
  'DELAY', 'DETOUR', 'SUSPENSION', 'SHUTTLE', 'STOP_CLOSURE', 'STATION_CLOSURE',
  'CANCELLATION', 'SERVICE_CHANGE', 'STOP_MOVE', 'STOP_MOVED', 'NO_SERVICE',
]);

// ---------- config ----------

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['Config must be a JSON object.'];
  if (!/^\d{1,2}:\d{2}$/.test(cfg.directionCutoff ?? '')) errors.push('directionCutoff must be "HH:MM".');
  if (typeof cfg.stopSlackMinutes !== 'number') errors.push('stopSlackMinutes must be a number.');
  if (cfg.departureCount !== undefined &&
      !(Number.isInteger(cfg.departureCount) && cfg.departureCount >= 1 && cfg.departureCount <= MAX_DEPARTURE_COUNT)) {
    errors.push(`departureCount must be an integer from 1 to ${MAX_DEPARTURE_COUNT}.`);
  }
  if (!Array.isArray(cfg.commutes) || cfg.commutes.length < 1 || cfg.commutes.length > 2) {
    errors.push('commutes must be an array of 1 or 2 commutes.');
    return errors;
  }
  cfg.commutes.forEach((c, i) => {
    const p = `commutes[${i}]`;
    if (!c?.name) errors.push(`${p}.name is required.`);
    if (!Array.isArray(c?.legs)) { errors.push(`${p}.legs must be an array.`); return; }
    const bottlenecks = c.legs.filter(l => l.role === 'bottleneck');
    const connections = c.legs.filter(l => l.role === 'connection');
    if (bottlenecks.length !== 1) errors.push(`${p} needs exactly one bottleneck leg.`);
    if (connections.length > 1) errors.push(`${p} supports at most one connection leg.`);
    if (connections.length === 1 && c.legs.indexOf(connections[0]) > c.legs.indexOf(bottlenecks[0])) {
      errors.push(`${p}: the connection leg must come before the bottleneck.`);
    }
    c.legs.forEach((l, j) => {
      const q = `${p}.legs[${j}]`;
      if (l.kind === 'walk' || l.kind === 'transfer') {
        if (typeof l.minutes !== 'number') errors.push(`${q}.minutes must be a number.`);
      } else if (l.kind === 'transit') {
        if (!l.route) errors.push(`${q}.route is required.`);
        if (l.direction_id !== 0 && l.direction_id !== 1) errors.push(`${q}.direction_id must be 0 or 1.`);
        if (l.role === 'bottleneck' && !l.stop) errors.push(`${q}.stop is required for the bottleneck.`);
        if (l.role === 'connection' && (!l.from || !l.to)) errors.push(`${q}.from and .to are required for a connection.`);
      } else {
        errors.push(`${q}.kind must be walk, transfer, or transit.`);
      }
    });
  });
  return errors;
}

// Number of departures to show; optional in saved configs.
export function departureCount(cfg) {
  return cfg.departureCount ?? DEFAULT_DEPARTURE_COUNT;
}

// Splits a commute around its bottleneck (and optional connection) leg.
export function analyzeCommute(commute) {
  const legs = commute.legs;
  const bIdx = legs.findIndex(l => l.role === 'bottleneck');
  const cIdx = legs.findIndex(l => l.role === 'connection');
  const minutes = l => (l.kind === 'transit' ? l.rideMinutes : l.minutes);
  const sum = arr => arr.reduce((acc, l) => (acc == null || minutes(l) == null ? null : acc + minutes(l)), 0);
  const firstTransit = legs.findIndex(l => l.kind === 'transit');
  return {
    bottleneck: legs[bIdx],
    connection: cIdx >= 0 ? legs[cIdx] : null,
    // Walk time before the first transit leg.
    walkBefore: sum(legs.slice(0, firstTransit)) ?? 0,
    // Transfer time between connection and bottleneck.
    transfer: cIdx >= 0 ? (sum(legs.slice(cIdx + 1, bIdx)) ?? 0) : 0,
    // Time from alighting the bottleneck to the destination; null if any leg lacks a duration.
    after: sum(legs.slice(bIdx + 1)),
  };
}

// Stops and routes worth fetching/alerting for a commute.
export function commuteEntities(commute) {
  const routes = new Set();
  const stops = new Set();
  for (const l of commute.legs) {
    if (l.kind !== 'transit') continue;
    routes.add(l.route);
    for (const s of [l.stop, l.alight, l.from, l.to]) if (s) stops.add(s);
  }
  return { routes, stops };
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

function parseHHMM(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

// Identifies the half of the day (before/after cutoff) so a manual override expires at the cutoff.
export function periodKey(nowMs, cutoff) {
  const { date, hour, minute } = localParts(nowMs);
  return `${date}/${hour * 60 + minute < parseHHMM(cutoff) ? 'am' : 'pm'}`;
}

// Commute index: 0 before cutoff, 1 after. A manual override applies only within the period it was set.
export function pickDirection(nowMs, cfg, override) {
  if (cfg.commutes.length < 2) return 0;
  if (override && override.period === periodKey(nowMs, cfg.directionCutoff)) return override.index;
  const { hour, minute } = localParts(nowMs);
  return hour * 60 + minute < parseHHMM(cfg.directionCutoff) ? 0 : 1;
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

// ---------- leave-by ----------

// Rows for a commute whose first transit leg is the bottleneck (e.g. home → office).
export function directRows(commute, busTrips, nowMs, stopSlackMinutes, count = DEFAULT_DEPARTURE_COUNT) {
  const { bottleneck, walkBefore, after } = analyzeCommute(commute);
  const rows = [];
  for (const [tripId, stops] of busTrips) {
    const board = stops.get(bottleneck.stop);
    if (!usable(board)) continue;
    const busDep = depOf(board);
    if (busDep == null || busDep <= nowMs) continue;
    const alight = bottleneck.alight ? stops.get(bottleneck.alight) : null;
    const eta = usable(alight) && after != null && arrOf(alight) != null ? arrOf(alight) + after * MIN : null;
    rows.push({
      tripId,
      busDep,
      leaveBy: busDep - (walkBefore + stopSlackMinutes) * MIN,
      eta,
      source: board.source,
    });
  }
  return rows.sort((a, b) => a.busDep - b.busDep).slice(0, count);
}

// Rows for a commute with a frequent connection before the bottleneck (e.g. office → home).
// For each bus, picks the latest viable connection trip. Buses no known trip can make are
// skipped; "no connection" is reported only when there is no connection data at all.
// Bus and train carry independent source labels (see `source` below).
export function connectionRows(commute, busTrips, connTrips, nowMs, count = DEFAULT_DEPARTURE_COUNT) {
  const { bottleneck, connection, walkBefore, transfer } = analyzeCommute(commute);
  const earliestBoard = nowMs + walkBefore * MIN;

  const trains = [];
  for (const [tripId, stops] of connTrips) {
    const from = stops.get(connection.from);
    const to = stops.get(connection.to);
    if (!usable(from) || !usable(to)) continue;
    const dep = depOf(from);
    const arr = arrOf(to);
    if (dep == null || arr == null || arr <= dep) continue;
    trains.push({ tripId, dep, arr, source: from.source === 'live' && to.source === 'live' ? 'live' : 'scheduled' });
  }

  const buses = [];
  for (const [tripId, stops] of busTrips) {
    const board = stops.get(bottleneck.stop);
    if (!usable(board)) continue;
    const busDep = depOf(board);
    if (busDep == null || busDep - transfer * MIN <= earliestBoard) continue;
    buses.push({ tripId, busDep, source: board.source });
  }
  buses.sort((a, b) => a.busDep - b.busDep);

  const rows = [];
  for (const bus of buses) {
    if (rows.length >= count) break;
    const latestArr = bus.busDep - transfer * MIN;
    let best = null;
    for (const t of trains) {
      if (t.dep >= earliestBoard && t.arr <= latestArr && (!best || t.dep > best.dep)) best = t;
    }
    if (!best) {
      if (trains.length === 0) rows.push({ ...bus, leaveBy: null, train: null, noConnection: true });
      continue;
    }
    rows.push({
      tripId: bus.tripId,
      busDep: bus.busDep,
      leaveBy: best.dep - walkBefore * MIN,
      // Bus and train each keep their own source so a live bus is not hidden by a scheduled train.
      train: { dep: best.dep, arr: best.arr, source: best.source },
      source: bus.source,
      noConnection: false,
    });
  }
  return rows;
}

export function countdownState(nowMs, leaveBy, busDep) {
  if (nowMs >= busDep) return 'hidden';
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
  const soon = rows.some(r => r.leaveBy != null && r.busDep > nowMs && r.leaveBy - nowMs <= 15 * MIN);
  return soon ? 30_000 : 60_000;
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
