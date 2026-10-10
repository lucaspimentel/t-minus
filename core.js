// Pure logic for T-Minus. No DOM, no network; unit tested with `node --test`.

export const TZ = 'America/New_York';
const MIN = 60_000;
export const DEFAULT_DEPARTURE_COUNT = 4;
export const MISSED_MINUTES = 5;
export const MAX_DEPARTURE_COUNT = 8;
export const DEFAULT_STOP_SLACK_MINUTES = 1;
export const DEFAULT_WAKE_MINUTES = 10;
export const RIDE_WAKE_MINUTES = 2;
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
  // No trips is valid: the settings stay after the last trip is deleted.
  if (!Array.isArray(cfg.trips)) {
    errors.push(cfg.commutes
      ? 'This is the old config format (commutes); rebuild it as trips in setup.'
      : 'trips must be an array.');
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
        if (l.also !== undefined && !(Array.isArray(l.also) && l.also.every(r => typeof r === 'string' && r && r !== l.route))) {
          errors.push(`${q}.also must be a list of other route ids.`);
        }
        if (l.routeLabels !== undefined && (typeof l.routeLabels !== 'object' || Array.isArray(l.routeLabels) || l.routeLabels === null)) {
          errors.push(`${q}.routeLabels must be an object.`);
        }
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

// A transit leg's routes: the primary one, then any others that also count (`also`, e.g. the
// Green Line branches between Government Center and Park Street).
export const legRoutes = l => [l.route, ...(l.also ?? [])];

// Stops and routes worth fetching/alerting for a trip.
export function commuteEntities(trip) {
  const routes = new Set();
  const stops = new Set();
  for (const l of trip.legs) {
    if (l.kind !== 'transit') continue;
    for (const r of legRoutes(l)) routes.add(r);
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

// A transit leg's other routes, stored labels, color, and board stop coordinates, when present.
const routeLook = l => ({
  ...(l.also?.length && { also: [...l.also] }),
  ...(l.routeLabels !== undefined && { routeLabels: { ...l.routeLabels } }),
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

// One label for several routes' short labels: their shared leading words, the rest joined
// with "/" ("Green B/C/D/E", "Bus 136/137"). `short`: rail lines keep only the shared part
// ("Green"); buses and the Silver Line keep the numbers.
export function commonLabel(labels, short = false) {
  const uniq = [...new Set(labels)];
  if (uniq.length < 2) return uniq[0] ?? '';
  const words = uniq.map(l => l.split(' '));
  let n = 0;
  while (words.every(w => n < w.length - 1 && w[n] === words[0][n])) n++;
  if (!n) return uniq.join('/');
  const head = words[0].slice(0, n).join(' ');
  if (short && !/^(Bus|Silver)$/.test(head)) return head;
  return `${head} ${words.map(w => w.slice(n).join(' ')).join('/')}`;
}

// Refreshes each transit leg's `label` and `color` from `/routes` resources; legs whose route
// isn't listed keep what they have. A leg with `also` routes is labeled by what they share
// ("Green", "Bus 136/137") and keeps each route's own label in `routeLabels` (for the vehicle).
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
        const { routeLabels: _, ...rest } = l;
        const out = { ...rest, label: shortRouteLabel(r), ...(COLOR_RE.test(color ?? '') && { color }) };
        if (!l.also?.length) return out;
        const labels = Object.fromEntries(legRoutes(l).map(id => [id, byId.get(id) ? shortRouteLabel(byId.get(id)) : id]));
        return { ...out, label: commonLabel(Object.values(labels), true), routeLabels: labels };
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

// ---------- rail network (station-first legs) ----------

// The subway and light-rail network from `/route_patterns?filter[canonical]=true&include=
// representative_trip.stops`: each canonical pattern's stations in order (per branch, so the Red
// Line's Ashmont and Braintree branches stay apart), stations with their lines, and the lines'
// labels and colors from `/routes` resources (sorted by MBTA sort order).
// { lines: [{ id, label, color }], stations: [{ id, name, lat, lon, routes }],
//   patterns: [{ route, direction, stations: [id] }], parents: { platformId: stationId } }
export function railNetwork(doc, routes = []) {
  const inc = new Map((doc?.included ?? []).map(x => [`${x.type}/${x.id}`, x]));
  const byRoute = new Map(routes.map(r => [r.id, r]));
  const stations = new Map();
  const parents = {};
  const patterns = [];
  for (const p of doc?.data ?? []) {
    const route = p.relationships?.route?.data?.id;
    const trip = inc.get(`trip/${p.relationships?.representative_trip?.data?.id}`);
    if (!route || !trip) continue;
    const ids = [];
    for (const ref of trip.relationships?.stops?.data ?? []) {
      const stop = inc.get(`stop/${ref.id}`);
      const id = stop?.relationships?.parent_station?.data?.id ?? ref.id;
      if (id !== ref.id) parents[ref.id] = id;
      if (!stations.has(id)) {
        const a = stop?.attributes ?? {};
        stations.set(id, { id, name: a.name ?? id, lat: a.latitude ?? null, lon: a.longitude ?? null, routes: [] });
      }
      const st = stations.get(id);
      if (!st.routes.includes(route)) st.routes.push(route);
      if (ids.at(-1) !== id) ids.push(id);
    }
    patterns.push({ route, direction: p.attributes?.direction_id, stations: ids });
  }
  const order = id => byRoute.get(id)?.attributes?.sort_order ?? Infinity;
  const lines = [...new Set(patterns.map(p => p.route))].sort((a, b) => order(a) - order(b)).map(id => {
    const r = byRoute.get(id);
    return { id, label: r ? shortRouteLabel(r) : id, color: r?.attributes?.color ?? null };
  });
  return { lines, stations: [...stations.values()], patterns, parents };
}

// The station a stop id (station or platform) belongs to, or null if it isn't on the network.
export function networkStation(net, id) {
  const sid = net?.parents?.[id] ?? id;
  return net?.stations.find(s => s.id === sid) ?? null;
}

// railConnections' input from the network: each line's stations with coordinates.
export function railStopsFrom(net) {
  return (net?.lines ?? []).map(l => ({
    route: l.id, label: l.label, color: l.color,
    stops: net.stations.filter(s => s.routes.includes(l.id)).map(s => ({ id: s.id, lat: s.lat, lon: s.lon })),
  }));
}

// Stations whose name contains the query; names starting with it first.
export function searchStations(net, query = '') {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = s => (s.name.toLowerCase().startsWith(q) ? 0 : 1);
  return (net?.stations ?? []).filter(s => s.name.toLowerCase().includes(q))
    .sort((a, b) => starts(a) - starts(b) || a.name.localeCompare(b.name));
}

// A next leg's groups (`reachableFrom`) without the line just ridden: a group is hidden when
// every one of its routes is in `arrived` (riding Green-B to Kenmore still lists C and D).
export function withoutArrived(groups, arrived) {
  const rode = new Set(arrived ?? []);
  const hidden = groups.filter(g => g.routes.length && g.routes.every(r => rode.has(r)));
  return { shown: groups.filter(g => !hidden.includes(g)), hidden };
}

// Stations reachable from `fromId` without a transfer, grouped per line color and direction:
// [{ key, routes, label, color, direction, toward: [last station names], stations: [{ id, name, routes }] }].
// Only patterns that pass `fromId` count, so branches never mix (no Ashmont → Quincy).
export function reachableFrom(net, fromId) {
  const from = networkStation(net, fromId)?.id ?? fromId;
  const line = id => net.lines.find(l => l.id === id);
  const rank = id => net.lines.findIndex(l => l.id === id);
  const groups = new Map();
  for (const p of [...net.patterns].sort((a, b) => rank(a.route) - rank(b.route))) {
    const i = p.stations.indexOf(from);
    if (i < 0 || i === p.stations.length - 1) continue;
    const color = line(p.route)?.color ?? p.route;
    const key = `${color}/${p.direction}`;
    if (!groups.has(key)) groups.set(key, { key, color: line(p.route)?.color ?? null, direction: p.direction, routes: [], toward: [], stations: new Map() });
    const g = groups.get(key);
    if (!g.routes.includes(p.route)) g.routes.push(p.route);
    const last = net.stations.find(s => s.id === p.stations.at(-1))?.name;
    if (last && !g.toward.includes(last)) g.toward.push(last);
    for (const id of p.stations.slice(i + 1)) {
      if (!g.stations.has(id)) g.stations.set(id, { id, name: net.stations.find(s => s.id === id)?.name ?? id, routes: [] });
      const st = g.stations.get(id);
      if (!st.routes.includes(p.route)) st.routes.push(p.route);
    }
  }
  return [...groups.values()].map(g => ({
    ...g, label: commonLabel(g.routes.map(r => line(r)?.label ?? r), true), stations: [...g.stations.values()],
  }));
}

// The leg for riding from one station to another without a transfer: every route with a pattern
// passing both in order (primary first by sort order), in that direction; null if none.
export function legBetween(net, fromId, toId) {
  const from = networkStation(net, fromId)?.id ?? fromId;
  const to = networkStation(net, toId)?.id ?? toId;
  const rank = id => net.lines.findIndex(l => l.id === id);
  const ok = net.patterns
    .filter(p => { const i = p.stations.indexOf(from); return i >= 0 && p.stations.indexOf(to) > i; })
    .sort((a, b) => rank(a.route) - rank(b.route));
  if (!ok.length) return null;
  const direction = ok[0].direction;
  const routes = [...new Set(ok.filter(p => p.direction === direction).map(p => p.route))];
  return { route: routes[0], also: routes.slice(1), direction };
}

// A leg's routes cut down to `keep` (at least one stays; the first kept becomes primary).
export function trimRoutes(leg, keep) {
  const routes = legRoutes(leg).filter(r => keep.includes(r));
  if (!routes.length) return { route: leg.route, also: leg.also ?? [] };
  return { route: routes[0], also: routes.slice(1) };
}

// Index of a stop in a direction's list, by its id or one of its child platforms.
const stopIndex = (stops, id) => stops.findIndex(s => s.id === id || (s.relationships?.child_stops?.data ?? []).some(c => c.id === id));

// Whether a direction's stop list (a /stops doc) has `boardId` before `alightId` (ids or child
// platforms): the route can carry the same leg.
export function servesInOrder(doc, boardId, alightId) {
  const stops = doc?.data ?? [];
  const i = stopIndex(stops, boardId);
  const j = stopIndex(stops, alightId);
  return i >= 0 && j > i;
}

// Board picker for a route without a chosen direction: stops you can board in both directions
// (most subway stations; direction 0's order) and those in one direction only (the two sides
// of a bus street), from the two directions' /stops docs. A direction's last stop can't be
// boarded, so a terminus goes under the direction leaving from it (Malden Center: toward
// Redstone only).
export function boardGroups(doc0, doc1) {
  const lists = [doc0?.data ?? [], doc1?.data ?? []].map(l => l.slice(0, -1));
  const ids = lists.map(l => new Set(l.map(s => s.id)));
  return {
    both: lists[0].filter(s => ids[1].has(s.id)),
    only: [lists[0].filter(s => !ids[1].has(s.id)), lists[1].filter(s => !ids[0].has(s.id))],
  };
}

// Drop-off choices from a board stop (id or child platform): per direction serving it, the
// stops after it. Directions with none (e.g. at the end of the line) are left out.
export function alightGroups(doc0, doc1, boardId) {
  return [doc0, doc1].map((doc, direction) => {
    const stops = doc?.data ?? [];
    const i = stopIndex(stops, boardId);
    return { direction, stops: i < 0 ? [] : stops.slice(i + 1) };
  }).filter(g => g.stops.length);
}

// The no-trips help line, on the main screen and in setup's empty trip list.
export const NO_TRIPS_HELP = 'Add the bus and train legs you take, and T-Minus tells you when to leave.';

export const CONNECTION_METERS = 200;

// Rail lines at a stop (JSON:API stop with latitude/longitude). A rail station connects only to
// the lines listing that station (State and Government Center are ~155 m apart but separate);
// another stop (a street bus stop has no parent station) to lines with a station within
// CONNECTION_METERS. `railStops`: [{ route, label, color, stops: [{ id, lat, lon }] }].
// Branches of one line (same color) merge: [{ label: 'Green B/C/D/E', color }].
export function railConnections(stop, railStops, exclude = []) {
  const a = stop?.attributes ?? {};
  const here = { lat: a.latitude, lon: a.longitude };
  const isStation = (railStops ?? []).some(line => line.stops.some(s => s.id === stop.id));
  const hasPos = !isStation && Number.isFinite(here.lat) && Number.isFinite(here.lon);
  const byColor = new Map();
  for (const line of railStops ?? []) {
    if (exclude.includes(line.route)) continue;
    const at = line.stops.some(s => s.id === stop.id || (hasPos && Number.isFinite(s.lat) && distanceMeters(here, s) <= CONNECTION_METERS));
    if (at) addLine(byColor, line);
  }
  return mergedLines(byColor);
}

// Lines per color, for one stop's tags: branches of one line merge ("Green B/C/D/E").
function addLine(byColor, line) {
  const key = line.color ?? line.route;
  if (!byColor.has(key)) byColor.set(key, { color: line.color, labels: [] });
  if (!byColor.get(key).labels.includes(line.label)) byColor.get(key).labels.push(line.label);
}
const mergedLines = byColor => [...byColor.values()].map(c => ({ label: commonLabel(c.labels), color: c.color }));

// Rail lines for each stop of one drop-off list (JSON:API stops): a station in the list tags
// itself; otherwise each station tags only the list's nearest non-station stop within
// CONNECTION_METERS (on the 132, "opp Oak Grove Sta", not Glen Rock Rd a block away).
// Returns Map<stopId, [{ label, color }]>.
export function stopConnections(stops, railStops, exclude = []) {
  const stationIds = new Set((railStops ?? []).flatMap(l => l.stops.map(s => s.id)));
  const listed = new Set(stops.map(s => s.id));
  const candidates = stops.filter(s => !stationIds.has(s.id)).map(s => ({ id: s.id, lat: s.attributes?.latitude, lon: s.attributes?.longitude }))
    .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  const tags = new Map();
  const tag = (id, line) => { if (!tags.has(id)) tags.set(id, new Map()); addLine(tags.get(id), line); };
  for (const line of railStops ?? []) {
    if (exclude.includes(line.route)) continue;
    for (const st of line.stops) {
      if (listed.has(st.id)) { tag(st.id, line); continue; }
      if (!Number.isFinite(st.lat) || !Number.isFinite(st.lon)) continue;
      let best = null;
      for (const c of candidates) {
        const m = distanceMeters(c, st);
        if (m <= CONNECTION_METERS && (!best || m < best.m)) best = { id: c.id, m };
      }
      if (best) tag(best.id, line);
    }
  }
  return new Map([...tags].map(([id, byColor]) => [id, mergedLines(byColor)]));
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
// A /stops list (route + direction, `include=child_stops`) trimmed to what setup reads, for
// keeping on the phone: ids, names, coordinates and child stop ids; no `included` records.
export function trimStopsDoc(doc) {
  return {
    data: (doc?.data ?? []).map(s => ({
      type: 'stop', id: s.id,
      attributes: { name: s.attributes?.name, latitude: s.attributes?.latitude, longitude: s.attributes?.longitude },
      relationships: { child_stops: { data: (s.relationships?.child_stops?.data ?? []).map(c => ({ id: c.id })) } },
    })),
  };
}

// A saved copy from `at` (epoch ms) is past `ttl` ms (or has no time).
export function isStale(at, nowMs, ttl) {
  return !Number.isFinite(at) || nowMs - at >= ttl;
}

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

// "Show nearby" in the first leg's picker: about a 10-minute walk, and the same radius in
// degrees for the API's nearby stop search (filter[radius]).
export const NEARBY_ME_METERS = 800;
export const NEARBY_ME_DEGREES = 0.0072;

// "120 m" (to 10 m) under a kilometer, else "1.2 km".
export function formatDistance(m) {
  return m < 995 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

// Route id → meters to its nearest stop among `stops` (JSON:API stops with latitude/longitude),
// from schedule records linking routes to stops. Records at other stops are ignored.
export function routeDistances(stops, schedules, here) {
  const at = new Map(stops.filter(s => s.attributes?.latitude != null)
    .map(s => [s.id, distanceMeters(here, { lat: s.attributes.latitude, lon: s.attributes.longitude })]));
  const out = new Map();
  for (const r of schedules) {
    const d = at.get(r.relationships?.stop?.data?.id);
    const route = r.relationships?.route?.data?.id;
    if (d == null || !route) continue;
    if (!(out.get(route) <= d)) out.set(route, d);
  }
  return out;
}

// Items with their distance from `here`, nearest first (stable); `coords(item)` gives
// { lat, lon } or null, and items without one go last with meters null.
export function byDistance(items, here, coords) {
  return items.map((item, i) => {
    const c = coords(item);
    return { item, i, meters: c && c.lat != null && c.lon != null ? distanceMeters(here, c) : null };
  }).sort((a, b) => (a.meters ?? Infinity) - (b.meters ?? Infinity) || a.i - b.i)
    .map(({ item, meters }) => ({ item, meters }));
}

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
      if (l.kind !== 'transit') continue;
      for (const route of legRoutes(l)) pairs.set(stopsKey(route, l.direction_id), { route, direction_id: l.direction_id });
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
    for (const leg of t.legs) {
      if (leg.kind !== 'transit') continue;
      for (const route of legRoutes(leg)) {
        const l = { ...leg, route };
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
  const headsigns = new Map();
  for (const doc of [schedulesDoc, predictionsDoc]) {
    for (const inc of doc?.included ?? []) if (inc.type === 'trip' && inc.attributes?.headsign) headsigns.set(inc.id, inc.attributes.headsign);
  }
  const trips = new Map();
  const put = (rec, source) => {
    const tripId = rec.relationships?.trip?.data?.id;
    const stopId = rec.relationships?.stop?.data?.id;
    if (!tripId || !stopId) return;
    const a = rec.attributes ?? {};
    let stops = trips.get(tripId);
    if (!stops) trips.set(tripId, (stops = new Map()));
    stops.route ??= rec.relationships?.route?.data?.id; // the trip's route (legs with `also`)
    stops.headsign ??= headsigns.get(tripId);
    if (source === 'live' && a.schedule_relationship === 'ADDED') stops.added = true; // not in the schedules
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
  trips.predicted = !!predictionsDoc; // predictions were fetched (none at all: subwayHeadway)
  return trips;
}

const depOf = e => e?.dep ?? e?.arr ?? null;
const arrOf = e => e?.arr ?? e?.dep ?? null;
const usable = e => e && !e.cancelled;

// Vehicles for one transit leg, sorted by departure: `{ tripId, dep, arr, source, route? }` where
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
    out.push({ tripId, dep, arr, source: board.source, ...(stops.route && { route: stops.route }), ...(stops.headsign && { headsign: stops.headsign }), ...(stops.added && { added: true }) });
  }
  return out.sort((a, b) => a.dep - b.dep);
}

// Live predictions disappear once a vehicle leaves the board stop. The last live times seen per
// leg (`[Map<tripId, {dep, arr, route?, headsign?, added?}>]`) keep a just-missed ride on its real
// time instead of the schedule's. Entries that departed more than 30 min ago are dropped.
export function rememberLive(memory, liveByLeg, nowMs) {
  return liveByLeg.map((live, i) => {
    const m = new Map([...(memory?.[i] ?? [])].filter(([, e]) => e.dep > nowMs - 30 * MIN));
    for (const { tripId, source: _, ...v } of live) m.set(tripId, v);
    return m;
  });
}

// Leg vehicles with remembered live times applied to those no longer predicted. An ADDED trip
// (no schedule) that has left is added back from memory, live.
export function withRemembered(vehiclesByLeg, memory, nowMs) {
  return vehiclesByLeg.map((vs, i) => {
    const m = memory?.[i];
    if (!m?.size) return vs;
    const ids = new Set(vs.map(v => v.tripId));
    const gone = [...m].filter(([id, e]) => e.added && !ids.has(id) && e.dep <= nowMs).map(([tripId, e]) => ({ tripId, ...e, source: 'live' }));
    return [...vs.map(v => (v.source !== 'live' && m.has(v.tripId) ? { ...v, ...m.get(v.tripId), source: 'live' } : v)), ...gone]
      .sort((a, b) => a.dep - b.dep);
  });
}

// Subway (heavy and light rail: route types 1 and 0) by the MBTA's fixed route ids.
export const isSubwayRoute = id => /^(Red|Orange|Blue|Mattapan|Green-[BCDE])$/.test(id);
const isSubwayLeg = leg => legRoutes(leg).every(isSubwayRoute);

// Subway countdowns come from predictions, not schedules (the MBTA's real-time display
// guidelines): a running train the MBTA can't match to its scheduled trip is predicted as an
// ADDED trip, its scheduled twin left unpredicted (two trains at 10:09pm otherwise). On a subway
// leg with live times, scheduled vehicles from now (or the earliest live time) to the latest
// live time are dropped; schedules fill in before and after. Other legs are unchanged.
export function predictionsFirst(vehicles, leg, nowMs) {
  if (!isSubwayLeg(leg)) return vehicles;
  const live = vehicles.filter(v => v.source === 'live').map(v => v.dep);
  if (!live.length) return vehicles;
  const lo = Math.min(nowMs, ...live);
  const hi = Math.max(...live);
  return vehicles.filter(v => v.source === 'live' || v.dep < lo || v.dep > hi);
}

// Minutes between subway departures when the leg has no predictions at all (an outage, before
// the first train): the MBTA's real-time display guidelines show headways ("every 8-13 min")
// there, not scheduled times. The smallest and largest gap between the scheduled departures in
// the next HEADWAY_WINDOW_MIN: '6' or '8–13'; null for other legs, a leg with any live vehicle,
// or fewer than two departures in the window.
export const HEADWAY_WINDOW_MIN = 60;
export function subwayHeadway(vehicles, leg, nowMs) {
  if (!isSubwayLeg(leg) || vehicles.some(v => v.source === 'live')) return null;
  const deps = vehicles.map(v => v.dep).filter(d => d >= nowMs && d <= nowMs + HEADWAY_WINDOW_MIN * MIN);
  const gaps = deps.slice(1).map((d, i) => Math.round((d - deps[i]) / MIN)).filter(g => g > 0);
  if (!gaps.length) return null;
  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  return min === max ? `${min}` : `${min}–${max}`;
}

// Each transit leg's vehicles from its merged trip maps (mergeTrips), remembered live times
// (rememberLive, if any) and the subway's predictions-first rule. A subway leg whose predictions
// were fetched but have none tags its vehicles with the headway (`every`, subwayHeadway).
export function tripVehicles(transit, tripsMaps, memory, nowMs) {
  const vs = withRemembered(transit.map((l, i) => legVehicles(tripsMaps[i] ?? new Map(), l)), memory, nowMs);
  return vs.map((v, i) => {
    const every = tripsMaps[i]?.predicted ? subwayHeadway(v, transit[i], nowMs) : null;
    return every ? v.map(x => ({ ...x, every })) : predictionsFirst(v, transit[i], nowMs);
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

// A row's leg: the trip's transit leg on vehicle `c`.
const rowLeg = (t, c) => ({
  route: t.route, label: t.label ?? t.route, color: t.color ?? null,
  ...(t.routeLabels && { routeLabels: t.routeLabels }),
  dep: c.dep, arr: c.arr, source: c.source, tripId: c.tripId, ...(c.route && { vehicleRoute: c.route }),
  ...(c.headsign && { headsign: c.headsign }), ...(c.every && { every: c.every }),
});

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
      legs: chain.map((c, i) => rowLeg(transit[i], c)),
    };
    if (isMissed) missed = { ...row, missed: true }; else rows.push(row);
  }
  return missed && count >= 2 ? [missed, ...rows.slice(0, count - 1)] : rows;
}

// One leg's /predictions and /schedules query (the page and the notification server).
export const tripFields = {
  'fields[prediction]': 'arrival_time,departure_time,schedule_relationship',
  'fields[schedule]': 'arrival_time,departure_time',
  include: 'stop,trip',
  'fields[stop]': 'name,parent_station', // names for the timeline (stopNames)
  'fields[trip]': 'headsign', // "toward Forest Hills"
};
export function legQuery(leg) {
  return { 'filter[route]': legRoutes(leg).join(','), 'filter[direction_id]': leg.direction_id, 'filter[stop]': `${leg.stop},${leg.alight}`, ...tripFields };
}

// Rows straight from each transit leg's predictions and schedules documents (either may be
// missing): the notification server's view of a trip.
export function rowsFromDocs(trip, predictionDocs, scheduleDocs, timingIdx, nowMs, slackMinutes, count = MAX_DEPARTURE_COUNT) {
  const { transit } = tripShape(trip);
  const vehicles = tripVehicles(transit, transit.map((l, i) => mergeTrips(predictionDocs?.[i], scheduleDocs?.[i])), null, nowMs);
  return tripRows(trip, vehicles, timingIdx, nowMs, slackMinutes, count);
}

// A sent notification is updated (same tag) when its time moves UPDATE_MIN+ min from the one it
// showed; `earlier` updates alert again, later ones replace it quietly.
export const UPDATE_MIN = 2;
const moved = (a, b) => Math.abs(a - b) >= UPDATE_MIN * MIN;
const update = (now, was) => ({ update: true, was, earlier: now < was });

// Leave-time reminders ("Notify me"): a heads-up HEADS_UP_MIN before leave-by, then "Leave now".
// `rem` = { leaveBy, headsUp (still due?), missing (polls in a row without its row), sent ({ leaveBy }
// the heads-up showed) }; `row` = the re-fetched row with the reminder's key, or null. Times follow
// the row; after the heads-up, a moved leave-by is an 'update' ({ was, earlier }). Missing for
// REMINDER_MISSING polls in a row, the ride is reported cancelled; long past, it just expires.
export const HEADS_UP_MIN = 5;
export const REMINDER_MISSING = 3;
export function reminderStep(rem, row, nowMs) {
  if (!row) {
    if (nowMs >= rem.leaveBy + MISSED_MINUTES * MIN) return { action: 'expire', leaveBy: rem.leaveBy, missing: rem.missing + 1 };
    const missing = rem.missing + 1;
    return { action: missing >= REMINDER_MISSING ? 'cancelled' : 'wait', leaveBy: rem.leaveBy, missing };
  }
  const { leaveBy } = row;
  if (nowMs < leaveBy && !rem.headsUp && rem.sent && moved(leaveBy, rem.sent.leaveBy)) return { action: 'update', leaveBy, missing: 0, ...update(leaveBy, rem.sent.leaveBy) };
  const action = nowMs >= leaveBy ? 'leave' : rem.headsUp && nowMs >= leaveBy - HEADS_UP_MIN * MIN ? 'headsUp' : 'wait';
  return { action, leaveBy, missing: 0 };
}
// Whether a reminder set at `nowMs` still gets its heads-up (not when set inside the window).
export const headsUpDue = (leaveBy, nowMs) => nowMs < leaveBy - HEADS_UP_MIN * MIN;

// Push text: { title, body }. `row` (when known) names the first vehicle and its time; an
// 'update' also gives the new leave-by and the one the heads-up showed (`was`).
export function reminderText(kind, tripName, row, nowMs, was) {
  const first = row?.legs[0];
  const body = first ? `${lineToward(first)} at ${legTime(first, first.dep, nowMs)}` : '';
  switch (kind) {
    case 'headsUp': return { title: `Leave in ${formatCountdown(row.leaveBy - nowMs)} · ${tripName}`, body };
    case 'update': return { title: `Leave in ${formatCountdown(row.leaveBy - nowMs)} · ${tripName}`, body: `${body} · leave by ${formatTime(row.leaveBy, nowMs)} (was ${formatTime(was, nowMs)})` };
    case 'leave': return { title: `Leave now · ${tripName}`, body };
    default: return { title: `Ride cancelled · ${tripName}`, body: 'Open the app for the next one.' };
  }
}

// The setup's test notification: sent this long after the tap, to lock the phone meanwhile.
export const TEST_PUSH_DELAY_MS = 10_000;
export const testPushText = nowMs => ({ title: 'Test notification', body: `Push works. Sent ${formatTime(nowMs)}.` });

// How often the server re-checks a reminder: every minute while far off, then every 20 s.
export function reminderPollMs(leaveBy, nowMs) {
  return leaveBy - nowMs > 20 * MIN ? 60_000 : 20_000;
}

// Keep the screen on while an upcoming row is within `minutes` of its leave-by, until its last
// chance (0 = never).
export function keepAwake(rows, nowMs, minutes) {
  return minutes > 0 && rows.some(r => !r.missed && r.leaveBy != null && nowMs >= r.leaveBy - minutes * MIN && nowMs < r.lastChance);
}

// While tracking a ride: keep the screen on for the last 2 min before the drop-off of the leg
// being ridden, and before the next leg's departure during a transfer (`minutes` 0 = never).
export function keepAwakeRiding(ride, walkAfter, nowMs, minutes) {
  if (!(minutes > 0)) return false;
  const phase = ridePhase(ride, walkAfter, nowMs);
  const leg = ride.legs[phase.leg];
  if (phase.kind === 'riding') return nowMs >= leg.arr - RIDE_WAKE_MINUTES * MIN;
  if (phase.kind === 'transfer') return nowMs >= leg.dep - RIDE_WAKE_MINUTES * MIN;
  return false;
}

// Steps of an expanded row: walk to the first stop (not en route; with the stop slack), legs,
// the actual gap at each transfer, and the final walk with the arrival time.
// `names`: stop id → name (stopNames). Leg steps carry `from`/`to` (null when unknown) and the
// ride's `minutes`; walk and transfer steps are short text, with `walking` when they involve
// walking (walks over 0 min, every transfer). `end` steps put the leave-by time ("Leave", rows
// with one) and the arrival ("Arrive") on the rail like stops.
export function timelineSteps(row, trip, slackMinutes, nowMs, names = new Map()) {
  const { walkBefore, walkAfter, transit } = tripShape(trip);
  const steps = [];
  if (!row.enRoute && row.leaveBy != null) steps.push({ kind: 'end', label: 'Leave', time: row.leaveBy });
  if (!row.enRoute) {
    const parts = [walkBefore > 0 && `Walk ${walkBefore} min`, slackMinutes > 0 && `${slackMinutes} min early at the stop`].filter(Boolean);
    if (parts.length) steps.push({ kind: 'walk', text: parts.join(' · '), walking: walkBefore > 0 });
  }
  row.legs.forEach((leg, i) => {
    if (i > 0) steps.push({ kind: 'walk', text: `${formatCountdown(leg.dep - row.legs[i - 1].arr)} to transfer`, walking: true });
    steps.push({
      kind: 'leg', leg, minutes: formatCountdown(leg.arr - leg.dep), approx: !!leg.every,
      from: names.get(transit[i]?.stop) ?? null, to: names.get(transit[i]?.alight) ?? null,
    });
  });
  if (walkAfter > 0) steps.push({ kind: 'walk', text: `Walk ${walkAfter} min`, walking: true });
  steps.push({ kind: 'end', label: 'Arrive', time: row.eta, approx: !!row.legs[row.legs.length - 1]?.every });
  return steps;
}

// Stop names from responses with `include=stop` (`fields[stop]=name,parent_station`): each
// included stop, and a parent station (a configured `place-…` id) by its platform's name.
export function stopNames(...docs) {
  const names = new Map();
  const parents = [];
  for (const doc of docs) {
    for (const inc of doc?.included ?? []) {
      if (inc.type !== 'stop' || !inc.attributes?.name) continue;
      names.set(inc.id, inc.attributes.name);
      const parent = inc.relationships?.parent_station?.data?.id;
      if (parent) parents.push([parent, inc.attributes.name]);
    }
  }
  for (const [parent, name] of parents) if (!names.has(parent)) names.set(parent, name);
  return names;
}

// State of a row: 'enroute' for a reachable en-route row, else countdownState.
export function rowState(nowMs, row) {
  if (row.enRoute && nowMs < row.lastChance) return 'enroute';
  return countdownState(nowMs, row.leaveBy, row.lastChance, row.firstDep);
}

// "Leaving now" (at the stop after the walk) or "At the stop" (now). `at` is the first tap,
// kept when "At the stop" follows "Leaving now"; it caps the mode at 30 min.
// A target pinned with "Track this trip" (`pinned`, `target`) is kept.
export function startEnRoute(kind, nowMs, walkBefore, prev = null) {
  return {
    kind, at: prev?.at ?? nowMs, atStop: kind === 'leaving' ? nowMs + walkBefore * MIN : nowMs,
    ...(prev?.pinned && { pinned: true, target: prev.target }),
  };
}

// Whether the rider has actually set off: "Leaving now" / "At the stop" or a ride. Plain tracking
// ("Track this trip", kind 'track' without a ride) is only a plan. Starting cancels reminders.
export function tripStarted(state) {
  return !!state && (!!state.ride || state.kind !== 'track');
}

// "Track this trip": pins `row` as the target, keeping an en-route state (else kind 'track':
// no at-stop time yet, the list stays normal).
export function pinTarget(prev, row, nowMs) {
  const base = prev && !prev.ride && prev.kind !== 'track' ? prev : { kind: 'track', at: nowMs };
  return { ...base, pinned: true, target: { key: row.key, legs: row.legs } };
}

// "Tracking ✕": drops the pin. Plain tracking ends; "Leaving now" / "At the stop" stays, and
// advanceEnRoute retargets the first reachable row.
export function unpinTarget(state) {
  if (!state || state.kind === 'track') return null;
  const { pinned: _, target: __, ...rest } = state;
  return rest;
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
    // A pinned target boards when it departs (chosen, so no reachability check).
    if (nowMs >= dep && (state.pinned || state.atStop <= dep)) {
      const { target: _, ...rest } = state;
      return { ...rest, ride: { legs: row?.legs ?? t.legs, boardedAt: dep } };
    }
    if (state.pinned) return row ? { ...state, target: { key: t.key, legs: row.legs } } : state;
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
      ...(d?.[1] === 'live' && { every: undefined }), // predicted now: no longer by its headway
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
// `{ vehicle: { status, name, atDropOff } | null, stops: [{ id, name, time, dropOff }] }` up to the drop-off
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
    if (name) vehicle = { status: v.current_status, name, atDropOff: v.current_status === 'STOPPED_AT' && isDropOff(at.id) };
  }
  return { vehicle, stops };
}

// The ridden vehicle's remaining stops (rideStops): the ride card and the server's stop alerts.
export function rideStopsQuery(tripId) {
  return {
    'filter[trip]': tripId,
    include: 'stop,vehicle',
    'fields[prediction]': 'arrival_time,departure_time,stop_sequence',
    'fields[stop]': 'name,parent_station',
    'fields[vehicle]': 'current_status,current_stop_sequence',
  };
}

// ---------- stop alerts (the server follows a tracked ride) ----------

// Stop alerts per leg: a heads-up at ALERT_HEADS_UP_STOPS stops to go (only if the leg started
// with more), then "get off" with the drop-off next (or, without the stop list, GET_OFF_MIN
// before its arrival). Rides are dropped RIDE_MAX_MS after boarding at the latest.
export const ALERT_HEADS_UP_STOPS = 3;
export const GET_OFF_MIN = 2;
export const RIDE_POLL_MS = 20_000;
const RIDE_MAX_MS = 3 * 60 * MIN;

// One poll of a ride's alerts. `alert` = { sent: { [leg]: { first, headsUp, arr, getOff, nextDep } },
// missedDep, missedNext ({ leg, dep } of the replacement), none }; `stops` = rideStops() for the
// leg being ridden (or null); `outlook` = transferOutlook(). Returns { alert, sends: [{ kind, leg,
// n?, missedDep?, update?, was?, earlier? }], done }. Sent alerts are updated (UPDATE_MIN) as times
// move: the heads-up's arrival, the get-off's next departure, the missed alert's replacement.
export function rideAlertStep(alert, ride, phase, stops, outlook, nowMs) {
  if (!['riding', 'transfer'].includes(phase.kind) || nowMs >= ride.boardedAt + RIDE_MAX_MS) return { alert, sends: [], done: true };
  const sends = [];
  let { sent = {}, missedDep = null, missedNext = null, none = false } = alert;
  const nextDep = outlook && !outlook.none ? outlook.legs[outlook.leg].dep : null;
  if (outlook?.missedDep != null && outlook.missedDep !== missedDep) {
    missedDep = outlook.missedDep;
    missedNext = { leg: outlook.leg, dep: nextDep };
    sends.push({ kind: 'missed', leg: outlook.leg, missedDep });
  } else if (nextDep != null && missedNext?.leg === outlook.leg && moved(nextDep, missedNext.dep)) {
    sends.push({ kind: 'missed', leg: outlook.leg, missedDep, ...update(nextDep, missedNext.dep) });
    missedNext = { ...missedNext, dep: nextDep };
  }
  if (outlook?.none && !none) {
    none = true;
    sends.push({ kind: 'none', leg: outlook.leg });
  }
  if (phase.kind === 'riding') {
    const i = phase.leg;
    const st = { ...sent[i] };
    const n = stops?.stops.length;
    const arr = ride.legs[i].arr;
    const getOff = () => {
      st.getOff = true;
      st.nextDep = outlook?.leg === i + 1 ? nextDep : null;
      sends.push({ kind: 'getOff', leg: i });
    };
    if (n != null) {
      st.first ??= n;
      if (n <= 1 && !st.getOff) getOff();
      else if (n > 1 && n <= ALERT_HEADS_UP_STOPS && st.first > ALERT_HEADS_UP_STOPS && !st.headsUp) {
        st.headsUp = true;
        st.arr = arr;
        sends.push({ kind: 'headsUp', leg: i, n });
      } else if (n > 1 && st.headsUp && !st.getOff && st.arr != null && moved(arr, st.arr)) {
        sends.push({ kind: 'headsUp', leg: i, n, ...update(arr, st.arr) });
        st.arr = arr;
      }
    } else if (!st.getOff && nowMs >= arr - GET_OFF_MIN * MIN) getOff();
    sent = { ...sent, [i]: st };
  }
  // The get-off alert's next departure, until that leg is ridden (the missed alert covers a re-plan).
  const g = outlook ? outlook.leg - 1 : -1;
  const sg = sent[g];
  if (nextDep != null && sg?.getOff && sg.nextDep != null && missedNext?.leg !== outlook.leg && !sends.some(s => s.kind === 'missed' || s.kind === 'none') && moved(nextDep, sg.nextDep)) {
    sends.push({ kind: 'getOff', leg: g, ...update(nextDep, sg.nextDep) });
    sent = { ...sent, [g]: { ...sg, nextDep } };
  }
  return { alert: { sent, missedDep, missedNext, none }, sends, done: false };
}

// Push text for a stop alert: { title, body }. `ride` is the ride before a re-plan (for what was
// missed), `outlook` the transfer outlook, `stopName` the leg's drop-off (from rideStops).
export function rideAlertText(send, { ride, outlook, stopName, walkAfter, nowMs }) {
  const leg = ride.legs[send.leg];
  const t = ms => formatTime(ms, nowMs);
  const was = send.was != null ? ` (was ${t(send.was)})` : '';
  switch (send.kind) {
    case 'headsUp': return { title: `${send.n} stops to ${stopName ?? 'your stop'}`, body: `${lineLabel(leg)} · arrive ${legTime(leg, leg.arr, nowMs)}${was}` };
    case 'getOff': {
      const next = outlook && outlook.leg === send.leg + 1 ? outlookText(outlook, ride, nowMs)?.text : null;
      const eta = ride.legs[ride.legs.length - 1].arr + walkAfter * MIN;
      return { title: stopName ? `Next stop: ${stopName} · get off` : 'Next stop: get off', body: next ? next + was : `Arrive ~${t(eta)}` };
    }
    case 'missed': {
      const legs = outlook.legs;
      const eta = legs[legs.length - 1].arr + walkAfter * MIN;
      const last = legs[legs.length - 1];
      return { title: `Missed the ${t(send.missedDep ?? leg.dep)} ${vehicleLabel(leg)}`, body: `Next: ${vehicleLabel(legs[send.leg])} ${legTime(legs[send.leg], legs[send.leg].dep, nowMs)}${was} · arrive ${legTime(last, eta, nowMs)}` };
    }
    default: return { title: `No connection after ${t(outlook.needed)}`, body: `Open the app for another way.` };
  }
}

// A ride posted for stop alerts: an error message, or null.
export function checkRide(trip, ride, nowMs) {
  if (!trip || validateConfig({ trips: [trip] }).length) return 'trip is invalid';
  const n = tripShape(trip).transit.length;
  const legs = ride?.legs;
  if (!Array.isArray(legs) || legs.length !== n) return 'ride.legs must match the trip';
  for (const l of legs) {
    if (typeof l?.tripId !== 'string' || !l.tripId || l.tripId.length > 200) return 'ride leg tripId is invalid';
    if (!Number.isFinite(l.dep) || !Number.isFinite(l.arr) || l.arr < l.dep) return 'ride leg times are invalid';
    if (l.every != null && (typeof l.every !== 'string' || l.every.length > 10)) return 'ride leg every is invalid';
    for (const k of ['label', 'route', 'headsign', 'vehicleRoute']) if (l[k] != null && (typeof l[k] !== 'string' || l[k].length > 100)) return `ride leg ${k} is invalid`;
  }
  if (!Number.isFinite(ride.boardedAt)) return 'ride.boardedAt is invalid';
  const end = legs[n - 1].arr;
  if (end < nowMs - 30 * MIN || end > nowMs + 6 * 60 * MIN) return 'the ride must end in the next 6 hours';
  return null;
}

// The ride headline's cue (from rideStops) with only the drop-off left: "Next stop: get off", or
// "Get off here" while stopped there; else null.
export function getOffText({ vehicle, stops }) {
  if (stops.length !== 1 || !stops[0].dropOff) return null;
  return vehicle?.atDropOff ? 'Get off here' : 'Next stop: get off';
}

// The ride card's stop list: all of them up to 6 (or when expanded), else the next 3,
// { more: n }, the stop before the drop-off, and the drop-off.
export function shownStops(stops, expanded = false) {
  const n = stops.length;
  if (expanded || n <= 6) return stops;
  return [...stops.slice(0, 3), { more: n - 5 }, ...stops.slice(n - 2)];
}

// Copies a vehicle's trip and times onto a planned leg.
// A new vehicle on a leg is no longer the one the rider picked (callers that pick set `picked`).
export const onVehicle = ({ picked: _, ...leg }, v) => ({ ...leg, tripId: v.tripId, dep: v.dep, arr: v.arr, source: v.source, arrSource: undefined, vehicleRoute: v.route, headsign: v.headsign, every: v.every });

// A leg's time for display: "~7:56am" on a subway leg shown by its headway (no predictions).
export const legTime = (leg, ms, nowMs) => `${leg?.every ? '~' : ''}${formatTime(ms, nowMs)}`;
// The badge's text: "every 6 min" for such a leg, else its source ('live' / 'scheduled').
export const sourceText = leg => (leg.every ? `every ${leg.every} min` : leg.source);

// A planned leg's label for its vehicle: the vehicle's own route on a leg with `also` routes
// ("Green D"), else the leg's ("Orange").
export const vehicleLabel = leg => leg.routeLabels?.[leg.vehicleRoute] ?? leg.label;

// The vehicle's line in full for the timeline, the ride card and pushes: subway lines get "Line"
// ("Orange Line", "Green Line B"); buses, the Silver Line and the Mattapan Trolley are as labeled.
export function lineLabel(leg) {
  const l = vehicleLabel(leg) ?? '';
  return /^(Red|Orange|Blue|Green)( |$)/.test(l) ? l.replace(/^(\w+)/, '$1 Line') : l;
}
// "toward Forest Hills" from the trip's headsign ('' without one).
export const toward = leg => (leg.headsign ? `toward ${leg.headsign}` : '');
const lineToward = leg => [lineLabel(leg), toward(leg)].filter(Boolean).join(' ');

// How much earlier another vehicle must leave before a working connection switches to it.
export const EARLIER_MIN = 2;

// The next connection while riding leg i (or in the transfer before leg i+1): needed = leg i's
// arrival + transfer; margin = leg i+1's departure − needed (negative: under the transfer time,
// shown as tight; the transfer is only an estimate). Missed only when it's impossible: leg i+1
// leaves before leg i arrives, or before now. Then legs i+1… are re-planned to the earliest
// feasible chain after `needed`; `none` when there's no such chain (plan kept). A working
// connection switches to a catchable vehicle leaving EARLIER_MIN+ min sooner (`earlier`; e.g.
// the planned train fell behind a delayed earlier one), unless the rider picked it (`picked`).
// Null without a next leg.
export function transferOutlook(ride, phase, vehiclesByLeg, transfers, nowMs) {
  const i = phase.kind === 'riding' ? phase.leg : phase.kind === 'transfer' ? phase.leg - 1 : -1;
  const next = i + 1;
  if (i < 0 || next >= ride.legs.length) return null;
  const needed = ride.legs[i].arr + (transfers[i] ?? 0) * MIN;
  const planned = ride.legs[next];
  const base = { leg: next, needed, margin: planned.dep - needed, legs: ride.legs, missedDep: null, none: false };
  const replanned = chain => ride.legs.map((l, k) => (k >= next ? onVehicle(l, chain[k - next]) : l));
  if (planned.dep >= Math.max(ride.legs[i].arr, nowMs)) {
    if (planned.picked) return base;
    // Not before now: in the transfer, `needed` may already be past.
    const chain = replanFrom(vehiclesByLeg, next, Math.max(needed, nowMs), transfers);
    if (!chain || chain[0].tripId === planned.tripId || chain[0].dep > planned.dep - EARLIER_MIN * MIN) return base;
    const legs = replanned(chain);
    return { ...base, legs, margin: legs[next].dep - needed, earlier: true };
  }
  const chain = replanFrom(vehiclesByLeg, next, needed, transfers);
  if (!chain) return { ...base, none: true };
  const legs = replanned(chain);
  return { ...base, legs, margin: legs[next].dep - needed, missedDep: planned.dep };
}

// The outlook line: "Then Orange Line toward Forest Hills 7:31am · 4 min to spare" / "· tight" (under 2 min) /
// "(missed 7:31am)" after a re-plan (`ride.missed`) / "No connection after 7:26am".
export function outlookText(outlook, ride, nowMs) {
  if (!outlook) return null;
  if (outlook.none) return { text: `No connection after ${formatTime(outlook.needed, nowMs)}`, warn: true };
  const leg = outlook.legs[outlook.leg];
  const head = `Then ${lineToward(leg)} ${legTime(leg, leg.dep, nowMs)}`;
  const missed = outlook.missedDep ?? (ride.missed?.leg === outlook.leg ? ride.missed.dep : null);
  if (missed != null) return { text: `${head} (missed ${formatTime(missed, nowMs)})`, warn: true };
  if (outlook.margin < 2 * MIN) return { text: `${head} · tight`, warn: true };
  return { text: `${head} · ${formatCountdown(outlook.margin)} to spare`, warn: false };
}

// How far back "Show previous rides" and "Different train?" look.
export const PREVIOUS_MINUTES = 15;

// Vehicles of a leg other than the assumed one that left in the last PREVIOUS_MINUTES (up to 4,
// the most recent): "Different train?", earlier or later.
export function otherVehicles(vehicles, leg, nowMs) {
  return vehicles.filter(v => v.dep <= nowMs && v.dep >= nowMs - PREVIOUS_MINUTES * MIN && v.tripId !== leg.tripId).slice(-4);
}

// "Different connection?" / "Different bus?" in the transfer: up to 4 vehicles of the next leg
// leaving from `fromMs` (now in the transfer, the current leg's arrival while riding), other than
// the planned one.
export function connectionChoices(vehicles, planned, fromMs) {
  return vehicles.filter(v => v.dep >= fromMs && v.tripId !== planned.tripId).slice(0, 4);
}

// "Different train?" / "Different bus?": buses and the Silver Line are buses; the rest trains.
export const vehicleNoun = leg => (/^(Bus|Silver)\b/.test(vehicleLabel(leg) ?? '') ? 'bus' : 'train');

// "Show previous rides": one ride per first-leg vehicle that left in the last PREVIOUS_MINUTES
// (oldest first), each with the earliest connections after it; a vehicle with no connection is
// skipped. Picking one ("I got on") starts the ride: { legs, boardedAt: firstDep }.
export function previousRides(trip, vehiclesByLeg, nowMs) {
  const { transit, walkAfter, transfers } = tripShape(trip);
  const out = [];
  for (const v of vehiclesByLeg[0] ?? []) {
    if (v.dep > nowMs || v.dep < nowMs - PREVIOUS_MINUTES * MIN) continue;
    const chain = transit.length > 1 ? replanFrom(vehiclesByLeg, 1, v.arr + (transfers[0] ?? 0) * MIN, transfers) : [];
    if (!chain) continue;
    const legs = [v, ...chain].map((c, i) => rowLeg(transit[i], c));
    out.push({ key: v.tripId, legs, firstDep: v.dep, eta: legs[legs.length - 1].arr + walkAfter * MIN });
  }
  return out;
}

// The ride with leg i on `vehicle` and the later legs re-planned from its arrival (kept if
// there's no connection).
// The rider's pick: kept by transferOutlook unless it becomes impossible.
export function switchLeg(ride, i, vehicle, vehiclesByLeg, transfers) {
  const chain = replanFrom(vehiclesByLeg, i + 1, vehicle.arr + (transfers[i] ?? 0) * MIN, transfers) ?? [];
  const legs = ride.legs.map((l, k) => (k === i ? { ...onVehicle(l, vehicle), picked: true } : chain[k - i - 1] ? onVehicle(l, chain[k - i - 1]) : l));
  const { missed: _, ...rest } = ride;
  return { ...rest, legs, ...(i === 0 && { boardedAt: vehicle.dep }) };
}

// `stops`: rideStops() for the leg being ridden (or null): stops left and minutes to the drop-off,
// or "Next stop: get off" / "Get off here" with only the drop-off left.
export function rideHeadline(phase, ride, nowMs, stops = null) {
  const leg = ride.legs[phase.leg];
  const n = stops?.stops.length ?? 0;
  switch (phase.kind) {
    case 'riding': {
      const cue = n ? getOffText(stops) : null;
      if (cue) return cue;
      return `${vehicleLabel(leg)}${n ? ` · ${n} stop${n === 1 ? '' : 's'}` : ''} · ${formatCountdown(leg.arr - nowMs)}`;
    }
    case 'transfer': return `Transfer · ${vehicleLabel(leg)} ${legTime(leg, leg.dep, nowMs)}`;
    case 'walking': return `Walking · arrive ${legTime(ride.legs[ride.legs.length - 1], phase.eta, nowMs)}`;
    default: return `Arrived ~${formatTime(phase.eta, nowMs)}`;
  }
}

// Before boarding: 30 min after the first tap. With a ride: until it's done.
export function enRouteActive(state, walkAfter, nowMs) {
  if (!state) return false;
  if (state.ride) return ridePhase(state.ride, walkAfter, nowMs).kind !== 'done';
  return state.pinned || nowMs < state.at + 30 * MIN;
}

export function enRouteStatus(state, nowMs) {
  if (state.kind === 'track') {
    const leg = state.target?.legs[0];
    return leg ? `Tracking ${vehicleLabel(leg)} ${legTime(leg, leg.dep, nowMs)}` : 'Tracking';
  }
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

// After a failed fetch: 10 s, 20 s, 40 s, … capped at the normal poll interval.
export function retryDelayMs(failures, normalMs) {
  return Math.min(10_000 * 2 ** Math.max(0, failures - 1), normalMs);
}

// After a 429: until the next whole minute (+1 s), when the keyless limit resets. MBTA's
// x-ratelimit-reset header isn't exposed to the page, but resets fall on whole minutes.
export function rateLimitDelayMs(nowMs) {
  return 60_000 - (nowMs % 60_000) + 1_000;
}

// The data's age ("25 min ago") once it's older than two poll intervals, else null.
export function dataAgeText(lastOk, intervalMs, nowMs) {
  const age = nowMs - lastOk;
  return age > 2 * intervalMs ? `${formatCountdown(age)} ago` : null;
}

// Pull-to-refresh: the content follows the finger at half speed, up to PULL_MAX px; released
// at PULL_READY or more, it refreshes and holds a PULL_HOLD gap until done.
export const PULL_MAX = 110;
export const PULL_READY = 64;
export const PULL_HOLD = 48;
export function pullOffset(dy) {
  return dy > 0 ? Math.min(dy * 0.5, PULL_MAX) : 0;
}

// The version in a page's footer ("Version 2026-10-02 · c712cb1543"), or null.
export function pageVersion(html) {
  return /<footer class="version">([^<]*)<\/footer>/.exec(html ?? '')?.[1].trim() || null;
}

// Whether a fetched page is a different version than the running one.
export function isNewerPage(html, currentVersion) {
  const v = pageVersion(html);
  return !!v && v !== currentVersion;
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

// The parts of the status line worth announcing to a screen reader: errors, the rate limit,
// and notices, without the times and counts that change every second or poll.
export function statusProblem({ lastError, lastOk, rateLimited, notice, locationOff, savedCopy, mbtaDown }) {
  if (lastError) return rateLimited ? 'Rate limited' : lastOk ? `Stale (${lastError})` : `Error: ${lastError}`;
  return [mbtaDown && 'MBTA down', notice, locationOff && 'Location off', savedCopy && 'Saved copy'].filter(Boolean).join(' · ');
}

// The spoken name of a row's expand button: "Leave in 5 min, 7:04am, arrive 7:50am".
export function rowAriaLabel(countdown, at, eta, reminder = false) {
  return `${countdown}, ${at}, arrive ${eta}${reminder ? ', reminder set' : ''}`;
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
    case 'missed': return msLeft > 0 ? `Missed · leaves in ${formatCountdown(msLeft)}` : `Missed · left ${formatCountdown(-msLeft)} ago`;
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

// ---------- MBTA proxy (server/, `/api/mbta/*`) ----------

// How long the server's copies are fresh, and how old a copy it may still serve when the MBTA
// fails (`stale`); `disk`: kept in SQLite (static data), otherwise in memory.
export const CACHE_CLASSES = {
  predictions: { fresh: 10_000, stale: 2 * 60_000 },
  alerts: { fresh: 60_000, stale: 15 * 60_000 },
  schedules: { fresh: 15 * 60_000, stale: 24 * 60 * 60_000 }, // the key holds filter[date]
  static: { fresh: 24 * 60 * 60_000, stale: Infinity, disk: true }, // revalidated daily
};

// The paths and parameters the app and setup send (an allowlist), with each path's cache class.
const FIELD_TYPES = ['prediction', 'schedule', 'trip', 'stop', 'vehicle', 'alert', 'route', 'route_pattern'];
const proxyPath = (cache, filters) => ({ cache, params: new Set([...filters.map(f => `filter[${f}]`), 'include', ...FIELD_TYPES.map(t => `fields[${t}]`)]) });
export const MBTA_PROXY_PATHS = {
  '/predictions': proxyPath('predictions', ['route', 'direction_id', 'stop', 'trip']),
  '/schedules': proxyPath('schedules', ['route', 'direction_id', 'stop', 'date', 'min_time', 'max_time']),
  '/alerts': proxyPath('alerts', ['route', 'datetime']),
  '/routes': proxyPath('static', ['type', 'stop']),
  '/stops': proxyPath('static', ['route', 'direction_id', 'latitude', 'longitude', 'radius', 'route_type']),
  '/route_patterns': proxyPath('static', ['route', 'canonical']),
};
const MAX_PARAM_LENGTH = 2000;

// Why a proxy request is refused (null when allowed): `params` is a list of [name, value].
export function proxyRequestError(path, params) {
  const p = Object.hasOwn(MBTA_PROXY_PATHS, path) ? MBTA_PROXY_PATHS[path] : null;
  if (!p) return 'path is not allowed';
  const seen = new Set();
  for (const [k, v] of params) {
    if (!p.params.has(k)) return `${k} is not allowed`;
    if (seen.has(k)) return `${k} is repeated`;
    if (v.length > MAX_PARAM_LENGTH) return `${k} is too long`;
    seen.add(k);
  }
  return null;
}

// The cache key: the path and its parameters, sorted (an API key is not part of it).
export function mbtaCacheKey(path, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([k]) => k !== 'api_key').map(([k, v]) => [k, String(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${path}?${qs}`;
}
