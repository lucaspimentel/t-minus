// Full-screen setup view: a list of trips, one trip's editor at a time, and the leg picker
// (station-first for subway and light rail, route-first for buses; the direction follows from
// the stops picked). Each trip is saved on its own. Pure helpers live in core.js; this module owns the DOM
// and the setup-time requests.
import {
  validateConfig, checkStops, stopQueries, stopsKey, locateLegs, tripLabel, tripToForm, formToTrip, routeLabel, routeEnds, shortRouteLabel, labelLegs,
  searchRoutes, searchStops, boardGroups, dropOffGroups, stopPairs, alightGroups, railConnections, stopConnections, servesInOrder, commonLabel, legRoutes,
  railNetwork, networkStation, railStopsFrom, searchStations, reachableFrom, legBetween, trimRoutes, planRoutes, planToForm, optionToForm, optionKey, optionSteps, sourceText, formatTime, distanceMeters, defaultTransferMinutes, departureCount, stopSlackMinutes, wakeMinutes,
  reverseTrip, nearestStop, windowLabel, withoutArrived, lineLabel, NO_TRIPS_HELP,
  scheduleWindow, formatDistance, routeDistances, byDistance, NEARBY_ME_METERS, NEARBY_ME_DEGREES, trimStopsDoc, isStale,
} from './core.js?v=c8a60c63c7';

const ROUTE_LIMIT = 60;
const PLACE_MIN_CHARS = 3; // auto-route's place search: the server's minimum
const PLACE_DEBOUNCE_MS = 300;

// Session caches (kept across openSetup calls; route and stop lists rarely change), backed by
// copies kept on the phone (`keptCopy`).
let routesPromise = null;
const stopDocs = new Map(); // stopsKey → /stops doc (trip order, with child_stops; trimmed)
// The subway and light-rail network (railNetwork): station-first legs and the connections shown
// in the drop-off lists. One request.
const RAIL_KEY = 't-minus:rail-network';
const SAVED_TTL = 7 * 24 * 60 * 60_000;

// Data kept on the phone (localStorage `{ at, data }`): the saved copy at once, and past `ttl`
// a fresh one fetched in the background for next time (a failure there is ignored). Without a
// copy, the fetch is awaited and saved. Storage errors (quota, private mode) are ignored.
function keptCopy(key, ttl, fetcher) {
  let copy = null;
  try { copy = JSON.parse(localStorage.getItem(key)); } catch {}
  const fetchAndKeep = () => fetcher().then(data => {
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch {}
    return data;
  });
  if (copy?.data == null) return fetchAndKeep();
  if (isStale(copy.at, Date.now(), ttl)) fetchAndKeep().catch(() => {});
  return Promise.resolve(copy.data);
}
let railNet = null;
let railStops = null; // railStopsFrom(railNet), for railConnections
let railPromise = null;
const NEARBY_STATION_METERS = 300;

function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'value') e.value = v; // property, so a textarea's content is set too
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...children.flat().filter(c => c != null && c !== false));
  return e;
}

// A new trip has no name until its legs suggest one (tripScreen); Save falls back to "Trip N".
const emptyTrip = () => ({ name: '', window: null, near: false, timingLeg: null, walkBefore: 5, walkAfter: 5, transit: [] });
const numberValue = v => (v === '' ? NaN : Number(v));
const info = text => ({ text, err: false });
const errs = list => list.map(text => ({ text, err: true }));

// Radius for next-leg suggestions, in degrees (~300 m).
const NEARBY_RADIUS = 0.003;

// `onSave(config, warning)` stores a config and keeps setup open; `onClose()` leaves setup.
// `timingFor(i)` returns the timing leg the app currently uses for saved trip i (or null).
// `toast(text, action, onAction)` / `hideToast()`: the app's Undo toast.
// `testPush`: { supported, send() } for "Send test notification" (null: no push server).
// `startImport`: open on the list with the import box (the main screen's "Import trips").
// `onReset(apiKey)`: "Delete all trips and settings" (after a confirm); the app reloads.
// `onPlan(trip)`: open on the auto-route planner ("Go somewhere else…"); the picked option is
// handed back as a one-off trip (labeled, not saved) and Cancel closes setup.
// `planApi(path, params)`: the T-Minus server's /stops and /plan (buses); null: rail only, in the browser.
export function openSetup({ root, config, api, onSave, onClose, timingFor = () => null, toast = () => {}, hideToast = () => {}, testPush = null, nearby = null, onReset = null, startImport = false, onPlan = null, planApi = null, timeline = null }) {
  let saved = config ?? null;
  const appFields = cfg => ({
    departureCount: cfg ? departureCount(cfg) : 4,
    stopSlackMinutes: cfg ? stopSlackMinutes(cfg) : 1,
    wakeMinutes: cfg ? wakeMinutes(cfg) : 10,
    apiKey: cfg?.apiKey ?? '',
  });
  const app = appFields(saved); // list-screen fields, saved by Done
  const savedTrips = () => saved?.trips ?? [];
  // The trip being edited: `idx` is its saved index (null for a new trip, inserted at `insertAt`).
  // `initial`: the form as opened (JSON), to tell whether Cancel discards edits (null: always).
  const editor = (idx, insertAt, form, messages = []) => ({ idx, insertAt, form, messages, initial: JSON.stringify(form) });
  // "Set up a trip" with no trips opens a new trip; "Import trips" the list with the import box.
  let editing = savedTrips().length || startImport || onPlan ? null : editor(null, 0, emptyTrip(0));
  // Auto-route: { from, to ({ id, name, routes: [{ id, label, color }] }, picked in the leg picker's
  // plan mode), plan ({ key, loading, options, error, local }), walkBefore, walkAfter, oneOff (from
  // the main screen) }.
  const newPlanner = oneOff => ({ from: null, to: null, walkBefore: 5, walkAfter: 5, oneOff });
  let planner = onPlan ? newPlanner(true) : null;
  let routes = null;
  // { legIdx (null = new leg), step, query, near, ... }. Steps: 'search' (stations and routes);
  // station-first 'to' { from }; route-first 'board' → 'alight' → 'also' { route, board, alight,
  // direction, also: [{ route, checked }] (other routes for the same ride) }.
  // `near`: { name, lat, lon, routeIds } around the previous leg's drop-off, for suggestions.
  let picker = null;
  let listMessages = [];
  let busy = false;

  const loadRoutes = () => (routesPromise ??= keptCopy('t-minus:routes', SAVED_TTL, () => api('/routes', {
    'filter[type]': '0,1,3',
    'fields[route]': 'short_name,long_name,type,color,direction_names,direction_destinations,sort_order',
  }).then(doc => doc.data)).catch(e => { routesPromise = null; throw e; }));

  async function loadStops(route, direction) {
    const key = stopsKey(route, direction);
    if (!stopDocs.has(key)) {
      stopDocs.set(key, await keptCopy(`t-minus:stops:${key}`, SAVED_TTL, () => api('/stops', {
        'filter[route]': route,
        'filter[direction_id]': direction,
        'fields[stop]': 'name,latitude,longitude',
        include: 'child_stops',
      }).then(trimStopsDoc)));
    }
    return stopDocs.get(key);
  }

  // The rail network (route types 0 and 1), kept on the phone (`keptCopy`): canonical route
  // patterns with their stations in order.
  function loadRailNetwork() {
    const use = net => { railNet = net; railStops = railStopsFrom(net); return net; };
    if (railNet) return Promise.resolve(railNet);
    return (railPromise ??= keptCopy(RAIL_KEY, SAVED_TTL, () => loadRoutes()
      .then(rs => {
        const rail = rs.filter(r => r.attributes?.type <= 1);
        return api('/route_patterns', {
          'filter[route]': rail.map(r => r.id).join(','), 'filter[canonical]': 'true',
          include: 'representative_trip.stops', 'fields[route_pattern]': 'direction_id', 'fields[trip]': '',
          'fields[stop]': 'name,latitude,longitude',
        }).then(doc => railNetwork(doc, rail));
      }))
      .then(use)
      .catch(e => { railPromise = null; throw e; }));
  }

  // Loads names for the legs in the saved trips and the form (and the route list) in the background.
  function loadNames() {
    loadRoutes().then(r => { routes = r; render(); }).catch(() => {});
    const pairs = new Set([
      ...savedTrips().flatMap(t => t.legs.filter(l => l.kind === 'transit').map(l => stopsKey(l.route, l.direction_id))),
      ...(editing?.form.transit ?? []).map(l => stopsKey(l.route, l.direction_id)),
    ]);
    for (const key of pairs) {
      const [route, dir] = key.split('/');
      loadStops(route, Number(dir)).then(render).catch(() => {});
    }
  }

  const routeById = id => routes?.find(r => r.id === id);
  const routeName = id => (routeById(id) ? routeLabel(routeById(id)) : id);
  // Colored dot plus short label ("● Bus 132"), from the route list or the leg's stored look.
  const dot = color => color && h('span', { class: 'dot', style: `background:#${color}` });
  const shortName = id => (routeById(id) ? shortRouteLabel(routeById(id)) : id);
  const routeTag = l => {
    const r = routeById(l.route);
    const label = l.also?.length ? commonLabel(legRoutes(l).map(shortName)) : r ? shortRouteLabel(r) : (l.label ?? l.route);
    return [h('span', { class: 'tag' }, dot(r?.attributes?.color ?? l.color), label)];
  };
  const destination = (routeId, dir) => routeById(routeId)?.attributes?.direction_destinations?.[dir] ?? `direction ${dir}`;

  // Name of a stop id (or of the station a child platform belongs to); `dir` null: either direction.
  function stopName(route, dir, id) {
    for (const d of dir == null ? [0, 1] : [dir]) {
      const doc = stopDocs.get(stopsKey(route, d));
      const s = doc?.data?.find(x => x.id === id || x.relationships?.child_stops?.data?.some(c => c.id === id));
      if (s) return s.attributes?.name ?? id;
    }
    return networkStation(railNet, id)?.name ?? id; // station-first legs load no stop lists
  }
  const bothDocs = route => [0, 1].map(d => stopDocs.get(stopsKey(route, d)));

  function parentMap(...docs) {
    const map = new Map();
    for (const doc of docs) {
      for (const s of doc?.data ?? []) for (const c of s.relationships?.child_stops?.data ?? []) map.set(c.id, s.id);
    }
    return map;
  }

  // Validates and stop-checks `cfg` (stops only for the trip indices in `only`, default all),
  // then saves it. Returns the error list (empty on success).
  async function checkAndPersist(cfg, only) {
    const errors = validateConfig(cfg);
    if (errors.length) return errors;
    let warning = null;
    try {
      await Promise.all(stopQueries(cfg, only).map(q => loadStops(q.route, q.direction_id)));
      const stopErrors = checkStops(cfg, stopDocs, only);
      if (stopErrors.length) return stopErrors;
    } catch (e) {
      // Wrong stops block the save; an unreachable API does not.
      warning = `Saved, but couldn't verify stops: ${e.message || e}`;
    }
    routes ??= await loadRoutes().catch(() => null);
    persist(cfg, warning);
    return [];
  }

  // Every save refreshes the legs' stored labels and colors when the route list is loaded.
  function persist(cfg, warning = null) {
    hideToast(); // a later save makes a pending Undo stale
    if (routes) cfg = labelLegs(cfg, routes);
    cfg = locateLegs(cfg, stopDocs); // first-stop coordinates for "near" trips
    saved = cfg;
    onSave(cfg, warning);
    listMessages = warning ? [info(warning)] : [];
  }

  function numberField(label, value, set, attrs = {}) {
    return h('label', { class: 'field' }, label,
      h('input', { type: 'number', inputmode: 'numeric', min: '0', value: String(value), oninput: e => set(numberValue(e.target.value)), ...attrs }));
  }

  function moveItem(list, i, delta) {
    const j = i + delta;
    if (j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    return true;
  }

  // ---------- list screen ----------

  function openTrip(idx) {
    editing = editor(idx, idx, tripToForm(savedTrips()[idx]));
    listMessages = [];
    render();
  }

  function planTrip() {
    planner = newPlanner(false);
    listMessages = [];
    loadRailNetwork().then(render).catch(() => {});
    render();
  }

  function addTrip() {
    const n = savedTrips().length;
    editing = editor(null, n, emptyTrip(n));
    listMessages = [];
    render();
  }

  function moveTrip(i, delta) {
    const trips = [...savedTrips()];
    if (!moveItem(trips, i, delta)) return;
    persist({ ...saved, trips });
    render();
  }

  // Saves the app-wide fields (if changed) and leaves setup.
  function done() {
    const cfg = { trips: [], ...saved, ...app, apiKey: app.apiKey.trim() }; // settings alone are fine
    const errors = validateConfig(cfg);
    if (errors.length) { listMessages = errs(errors); return render(); }
    const before = appFields(saved);
    if (cfg.departureCount !== before.departureCount || cfg.stopSlackMinutes !== before.stopSlackMinutes || cfg.wakeMinutes !== before.wakeMinutes || cfg.apiKey !== before.apiKey) {
      persist(cfg);
    }
    onClose();
  }

  let ioArea = startImport ? { mode: 'import', text: '' } : null; // { mode: 'export' | 'import', text }

  async function exportConfig() {
    const text = JSON.stringify(saved, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      ioArea = { mode: 'export', text, note: 'Copied to the clipboard.' };
    } catch {
      ioArea = { mode: 'export', text, note: 'Copy the JSON below.' };
    }
    render();
  }

  // Replaces every trip (and the app-wide fields it sets) after the same checks as Save.
  async function importConfig(text) {
    let cfg;
    try { cfg = JSON.parse(text); } catch (e) { listMessages = errs([`Invalid JSON: ${e.message}`]); return render(); }
    if (cfg && typeof cfg === 'object' && !cfg.apiKey && app.apiKey.trim()) cfg = { ...cfg, apiKey: app.apiKey.trim() };
    const prev = savedTrips().length ? saved : null; // first run: nothing to undo
    busy = true;
    listMessages = [info('Checking stops…')];
    render();
    const errors = await checkAndPersist(cfg);
    busy = false;
    if (errors.length) { listMessages = errs(errors); return render(); }
    Object.assign(app, appFields(cfg));
    ioArea = null;
    listMessages = [info(`Imported ${cfg.trips.length} trip${cfg.trips.length === 1 ? '' : 's'}.`), ...listMessages];
    loadNames();
    render();
    if (prev) {
      toast('Trips replaced', 'Undo', () => {
        persist(prev);
        Object.assign(app, appFields(prev));
        listMessages = [];
        ioArea = null;
        loadNames();
        render();
      });
    }
  }

  function tripRow(t, i, n) {
    const transit = t.legs.filter(l => l.kind === 'transit');
    const chain = transit.length ? transit.flatMap((l, j) => [j > 0 && ' → ', ...routeTag(l)]) : ['No transit legs'];
    return h('div', { class: 'trip-row' },
      h('button', { type: 'button', class: 'item', onclick: () => openTrip(i) },
        h('div', { class: 'trip-main' },
          h('b', {}, t.name),
          h('div', { class: 'muted' }, `${t.near ? 'Near first stop' : windowLabel(t.window)} · `, ...chain)),
        h('span', { class: 'go' }, '›')),
      h('button', { type: 'button', 'aria-label': `Move ${t.name} up`, disabled: i === 0, onclick: () => moveTrip(i, -1) }, '↑'),
      h('button', { type: 'button', 'aria-label': `Move ${t.name} down`, disabled: i === n - 1, onclick: () => moveTrip(i, 1) }, '↓'));
  }

  function listScreen() {
    const trips = savedTrips();
    return [
      h('div', { class: 'setup-head' },
        h('span'),
        h('b', {}, 'Setup'),
        h('button', { type: 'button', class: 'primary', id: 'setup-done', disabled: busy, onclick: done }, 'Done')),
      ...listMessages.map(m => h('div', { class: m.err ? 'msg err' : 'msg' }, m.text)),
      h('div', { class: 'list trips' }, trips.map((t, i) => tripRow(t, i, trips.length))),
      // No trips (the last one deleted): the add button stands out, as in an empty trip's legs.
      trips.length
        ? [h('button', { type: 'button', class: 'add', onclick: planTrip }, '+ Add trip (auto-route)'),
          h('button', { type: 'button', class: 'add', onclick: addTrip }, '+ Add trip (manual)')]
        : h('div', { class: 'legs-empty' }, `No trips yet. ${NO_TRIPS_HELP}`,
          h('button', { type: 'button', class: 'primary add', onclick: planTrip }, '+ Add trip (auto-route)'),
          h('button', { type: 'button', class: 'add', onclick: addTrip }, '+ Add trip (manual)')),
      h('div', { class: 'muted section' }, 'Settings'),
      h('div', { class: 'card' },
        numberField('Departures shown (1-8)', app.departureCount, v => { app.departureCount = v; }, { min: '1', max: '8' }),
        numberField('Minutes early at the stop', app.stopSlackMinutes, v => { app.stopSlackMinutes = v; }),
        numberField('Keep screen on before leave-by (min, 0 = off)', app.wakeMinutes, v => { app.wakeMinutes = v; }),
        h('label', { class: 'field' }, 'MBTA API key (optional)',
          // Masked so the key isn't exposed on screen (or in screenshots).
          h('input', { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'Used only when the T-Minus server is unreachable', value: app.apiKey, oninput: e => { app.apiKey = e.target.value; } }))),
      h('div', { class: 'btns io' },
        saved && h('button', { type: 'button', onclick: exportConfig }, 'Export'),
        h('button', { type: 'button', onclick: () => { ioArea = { mode: 'import', text: '' }; render(); } }, 'Import'),
        // Reloads the page (the service worker is network-first, so this picks up a new version).
        h('button', { type: 'button', onclick: () => location.reload() }, 'Reload app')),
      ioArea && h('div', { class: 'card' },
        ioArea.note && h('div', { class: 'msg' }, ioArea.note),
        h('textarea', { id: 'setup-io', readOnly: ioArea.mode === 'export', value: ioArea.text, placeholder: 'Paste a trips config (JSON)', oninput: e => { ioArea.text = e.target.value; } }),
        ioArea.mode === 'import' && h('button', { type: 'button', disabled: busy, onclick: () => importConfig(ioArea.text) }, 'Load')),
      testPush && h('div', { class: 'muted section' }, 'Notifications'),
      testPush && h('div', { class: 'btns' },
        h('button', { type: 'button', disabled: !testPush.supported, onclick: () => testPush.send() }, 'Send test notification in 10 s')),
      testPush && !testPush.supported && h('div', { class: 'push-hint' }, 'Add to Home Screen to get notifications.'),
      onReset && h('div', { class: 'muted section' }, 'Reset'),
      onReset && h('div', { class: 'btns' }, h('button', { type: 'button', class: 'danger', onclick: () => {
        if (confirm('Delete all trips and settings?')) onReset(app.apiKey.trim() || saved?.apiKey || '');
      } }, 'Delete all trips and settings')),
      onReset && h('div', { class: 'push-hint reset-note' }, 'Removes trips, settings and saved data. Keeps the MBTA API key.'),
    ];
  }

  // ---------- auto-route ----------

  // From and To (each picked in the leg picker: a station, a route's stop, or Show nearby), the
  // walks, then up to 3 ways: the server's plans (`planApi`: buses and rail), else (or when it
  // fails, between two stations) rail only, in the browser (planRoutes). Setup opens the pick in
  // the trip editor; the main screen gets a one-off trip.
  // A leg's routes as one label and color ("Bus 132", "Orange").
  const routeLook = (ids, colorOf) => {
    const look = id => { const r = routeById(id); const l = railNet?.lines.find(x => x.id === id); return { label: r ? shortRouteLabel(r) : l?.label ?? id, color: r?.attributes?.color ?? l?.color }; };
    return { label: commonLabel(ids.map(id => look(id).label), true), color: colorOf ?? look(ids[0]).color };
  };
  const placeTags = place => place.point
    ? [place.detail && h('span', { class: 'muted' }, `· ${place.detail}`)]
    : place.routes.map(r => h('span', { class: 'tag conn' }, dot(r.color), r.label));
  // An address, a place or the phone's location: planned from the stops within a walk ("@lat,lon").
  const pointPlace = (lat, lon, name, detail) => ({ id: `@${lat},${lon}`, name, detail, point: { lat, lon }, routes: [] });
  // A station from the rail network, as the server describes places.
  const stationPlace = id => {
    const st = networkStation(railNet, id);
    return { id: st?.id ?? id, name: st?.name ?? id, routes: railConnections({ id: st?.id ?? id }, railStops).map(c => ({ id: c.label, label: c.label, color: c.color })) };
  };

  function setPlace(key, place) {
    const p = planner;
    p[key] = place;
    loadPlan();
    render();
  }

  // From or To: the leg picker in plan mode (`planField`): stations, routes then a stop, or
  // Show nearby; the pick returns to the planner.
  function openPlanPicker(key) {
    picker = { legIdx: null, planField: key, step: 'search', query: '' };
    loadRoutes().then(r => { routes = r; render(); }).catch(e => { if (picker) picker.error = e.message || String(e); render(); });
    render();
  }
  function pickPlace(place) {
    const key = picker.planField;
    picker = null;
    setPlace(key, place);
  }

  // The ways between From and To: the server's, else (stations only) the browser's rail search.
  function loadPlan() {
    const p = planner;
    if (!p.from || !p.to) { p.plan = null; return; }
    const key = `${p.from.id}>${p.to.id}`;
    if (p.plan?.key === key) return;
    const local = () => {
      const a = networkStation(railNet, p.from.id);
      const b = networkStation(railNet, p.to.id);
      return a && b ? { key, local: true, options: planRoutes(railNet, a.id, b.id) } : { key, error: 'Needs the T-Minus server.' };
    };
    if (!planApi) { p.plan = local(); return; }
    p.plan = { key, loading: true };
    planApi('/plan', planQuery(p)).then(r => ({ key, options: r.options, from: r.from, to: r.to, ...timedFields(r) }), local)
      .then(plan => {
        if (planner !== p || p.plan?.key !== key) return;
        // Timed: the 3 best (times as of the answer; no refresh, so the list never changes under you).
        if (plan.timed) plan.options = plan.options.slice(0, 3);
        p.plan = plan;
        render();
      });
  }

  // "Go somewhere else…" asks for live times from now (the server times up to 8 candidates);
  // setup's planner doesn't (a saved trip is used at many times of day).
  const planQuery = p => ({ from: p.from.id, to: p.to.id, ...(p.oneOff && { now: 1, wb: p.walkBefore, wa: p.walkAfter, slack: app.stopSlackMinutes }) });
  const timedFields = r => ({ ...(r.timed && { timed: true }), ...(r.none && { none: true }), ...(r.timedError && { timedError: true }) });

  function plannerScreen() {
    const p = planner;
    const head = h('div', { class: 'setup-head' },
      h('button', { type: 'button', onclick: () => { if (p.oneOff) onClose(); else { planner = null; render(); } } }, 'Cancel'),
      h('b', {}, p.oneOff ? 'Go somewhere else' : 'Add trip (auto-route)'), h('span'));
    if (!railNet) {
      loadRailNetwork().then(render).catch(e => { listMessages = errs([`Couldn't load stations: ${e.message || e}`]); render(); });
      return [head, ...listMessages.map(m => h('div', { class: m.err ? 'msg err' : 'msg' }, m.text)), h('div', { class: 'muted' }, 'Loading stations…')];
    }
    if (!routes) loadRoutes().then(rs => { routes = rs; render(); }).catch(() => {});
    const field = (key, label) => h('div', { class: 'field' }, label,
      h('button', { type: 'button', class: 'item', id: `plan-${key}`, onclick: () => openPlanPicker(key) },
        ...(p[key] ? [h('span', { class: 'main' }, p[key].name, ' '), ...placeTags(p[key]), h('span', { class: 'change' }, 'Change')] : ['Choose a stop or station'])));
    // A point end's walk is the option's own; otherwise the field's.
    const walks = o => [p.from.point ? o.walkBefore ?? 0 : p.walkBefore, p.to.point ? o.walkAfter ?? 0 : p.walkAfter];
    const pick = o => {
      const plan = p.plan;
      const [wb, wa] = walks(o);
      // Your location has no name of its own: the trip is named from the first (or last) stop.
      const fromName = p.from.current ? o.legs[0].stopName ?? p.from.name : p.from.name;
      const toName = p.to.current ? o.legs.at(-1).alightName ?? p.to.name : p.to.name;
      const form = plan.local ? planToForm(railNet, o, wb, wa) : optionToForm(o, fromName, toName, wb, wa);
      if (p.oneOff) {
        const cfg = { trips: [formToTrip(form)] };
        loadRoutes().then(rs => { routes = rs; }).catch(() => {}).finally(() => onPlan((routes ? labelLegs(cfg, routes) : cfg).trips[0]));
        return;
      }
      planner = null;
      const n = savedTrips().length;
      editing = editor(null, n, form);
      editing.initial = null; // Cancel asks before dropping a planned trip
      render();
    };
    const lineOf = id => railNet.lines.find(l => l.id === id);
    const stationName = id => networkStation(railNet, id)?.name ?? id;
    // An option as a card like a main-list row. Head: "Arrive 8:48pm · ~44 min" and "Leave 8:03pm
    // (in 44 min)", or "~40 min" untimed. Collapsed: its routes and the first ride's badge;
    // expanded (a tap): its timeline (Leave, walks, rides, transfers, Arrive) and the pick button.
    const optionCard = (o, local) => {
      const [wb, wa] = walks(o);
      const board = l => (local ? stationName(l.stop) : l.stopName ?? l.stop);
      const alight = l => (local ? stationName(l.alight) : l.alightName ?? l.alight);
      const k = optionKey(o);
      const open = !!p.plan.open?.has(k); // expanded (p.plan.open: optionKeys)
      const tags = o.legs.map(l => routeLook([l.route, ...l.also], local ? lineOf(l.route)?.color : null));
      const now = Date.now();
      const inMin = o.leave != null && Math.round((o.leave - now) / 60_000);
      const head = o.arrive != null
        ? [h('b', { class: 'opt-head' }, `Arrive ${formatTime(o.arrive, now)} · ~${Math.round((o.arrive - o.leave) / 60_000)} min`),
          h('div', { class: 'detail' }, inMin > 0 ? `Leave ${formatTime(o.leave, now)} (in ${inMin} min)` : 'Leave now')]
        : [h('b', { class: 'opt-head' }, o.minutes != null ? `~${o.minutes + wb + wa} min` : `${o.stops} stop${o.stops === 1 ? '' : 's'}`)];
      const first = o.deps?.[0];
      const toggle = h('button', { type: 'button', class: 'row-toggle', 'aria-expanded': String(open), 'data-focus': `option:${k}` }, ...head,
        !open && h('div', { class: 'strip' }, ...tags.flatMap(t => [h('span', { class: 'seg' }), h('span', { class: 'stop' }, dot(t.color), t.label)]), h('span', { class: 'seg' })),
        !open && h('div', { class: 'detail summary' }, first ? h('span', { class: `badge ${first.source}` }, sourceText(first)) : h('span'), h('span', { class: 'chev' }, '▾')));
      const card = h('li', { class: 'row option', onclick: () => { const opened = (p.plan.open ??= new Set()); if (!opened.delete(k)) opened.add(k); render(); } }, toggle);
      if (open) {
        const legs = o.legs.map((l, i) => ({ ...tags[i], from: board(l), to: alight(l) }));
        card.append(timeline?.(optionSteps(o, { walkBefore: wb, walkAfter: wa, slack: app.stopSlackMinutes, legs }), `option:${k}`) ?? '',
          h('div', { class: 'row-foot' },
            h('button', { type: 'button', class: 'track-btn', 'data-focus': `pick:${k}`, onclick: e => { e.stopPropagation(); pick(o); } }, p.oneOff ? 'See departures' : 'Review and save'),
            h('span', { class: 'chev' }, '▴')));
      }
      return card;
    };
    const plan = p.plan;
    const optionList = !plan ? []
      : plan.loading ? [h('div', { class: 'muted section' }, 'Finding ways…')]
        : plan.error ? [h('div', { class: 'msg' }, plan.error)]
          : plan.options.length
            ? [plan.none && h('div', { class: 'msg' }, 'Nothing runs in the next 2 hours.'),
              plan.timedError && h('div', { class: 'msg' }, 'Times unavailable.'),
              h('div', { class: 'muted section' }, p.oneOff ? 'Pick one to see its departures' : 'Pick one to review and save'),
              h('ul', { class: 'rows', id: 'plan-options' }, ...plan.options.map(o => optionCard(o, plan.local)))]
            : [h('div', { class: 'msg' }, plan.local ? 'No way on the subway with 2 transfers or fewer.' : 'No way with 2 transfers or fewer.')];
    return [head,
      h('div', { class: 'card' },
        field('from', 'From'),
        field('to', 'To'),
        // A point end's walks come with each option.
        (!p.from?.point || !p.to?.point) && h('div', { class: 'field-pair' },
          !p.from?.point && numberField('Minutes to first stop', p.walkBefore, v => { p.walkBefore = v; }),
          !p.to?.point && numberField('Minutes from last stop', p.walkAfter, v => { p.walkAfter = v; }))),
      ...optionList];
  }

  // ---------- trip screen ----------

  async function saveTrip() {
    const pos = editing.idx ?? editing.insertAt;
    if (!editing.form.name.trim()) editing.form.name = `Trip ${pos + 1}`;
    const trip = formToTrip(editing.form);
    const trips = [...savedTrips()];
    if (editing.idx != null) trips[pos] = trip; else trips.splice(pos, 0, trip);
    const base = saved ?? { ...app, apiKey: app.apiKey.trim() };
    busy = true;
    editing.messages = [info('Checking stops…')];
    render();
    // Only this trip's stops are checked; the others were checked when saved.
    const errors = await checkAndPersist({ ...base, trips }, [pos]);
    busy = false;
    if (errors.length) {
      // This trip's own messages drop its label; messages about other trips keep theirs.
      const own = `${tripLabel(trips, pos)}: `;
      editing.messages = errs(errors.map(m => (m.startsWith(own) ? m.slice(own.length) : m)));
      return render();
    }
    editing = null;
    render();
  }

  function deleteTrip() {
    const { idx } = editing;
    const prev = saved;
    persist({ ...saved, trips: savedTrips().filter((_, i) => i !== idx) });
    editing = null;
    render();
    toast('Trip deleted', 'Undo', () => { persist(prev); render(); });
  }

  // Cancel in the editor: edits are discarded, with Undo when there were any.
  function cancelEdit() {
    // With no trips there is no list to go back to: back to the main screen's empty state.
    if (!savedTrips().length) { editing = null; return onClose(); }
    const { idx, insertAt, form, initial } = editing;
    const changed = JSON.stringify(form) !== initial;
    editing = null;
    render();
    if (changed) {
      toast('Edits discarded', 'Undo', () => {
        editing = { idx, insertAt, form, initial, messages: [] };
        picker = null;
        loadNames();
        render();
      });
    }
  }

  // Opens the reversed trip as a new trip after this one. A reversed bus stop is usually not
  // served in the other direction (the stop across the street is), so each stop missing from
  // the new direction's list is replaced by that list's nearest stop.
  async function addReturnTrip() {
    const { idx, form } = editing;
    const back = tripToForm(reverseTrip(formToTrip(form)));
    const replaced = [];
    try {
      for (const leg of back.transit) {
        const [fromDoc, toDoc] = await Promise.all([loadStops(leg.route, 1 - leg.direction_id), loadStops(leg.route, leg.direction_id)]);
        const has = id => toDoc.data.some(s => s.id === id || s.relationships?.child_stops?.data?.some(c => c.id === id));
        for (const field of ['stop', 'alight']) {
          if (has(leg[field])) continue;
          const original = fromDoc.data.find(s => s.id === leg[field]);
          const near = original && nearestStop(toDoc.data, original.attributes.latitude, original.attributes.longitude);
          if (near) {
            replaced.push(`${stopName(leg.route, 1 - leg.direction_id, leg[field])} → ${near.attributes.name}`);
            leg[field] = near.id;
          }
        }
      }
    } catch { /* offline: keep the reversed ids; Save's stop check reports them */ }
    editing = {
      idx: null, insertAt: idx + 1, form: back, initial: null, // a generated draft: Cancel offers Undo
      messages: [info(`Return trip for "${form.name}".` +
        (replaced.length ? ` Matched stops across the street: ${replaced.join('; ')}.` : '') + ' Review it, then Save.')],
    };
    shown = null; // a different trip: start at the top
    loadNames();
    render();
  }

  function legSummary(l) {
    return [...routeTag(l), ` toward ${destination(l.route, l.direction_id)} · ${stopName(l.route, l.direction_id, l.stop)} → ${stopName(l.route, l.direction_id, l.alight)}`];
  }

  // Choosing "near" asks for location now (the iOS prompt), not later on the main screen.
  function askLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(() => {}, err => {
      if (err.code !== err.PERMISSION_DENIED || !editing) return;
      editing.messages = errs(['Location is off for this app; this trip will only show when chosen or last used.']);
      render();
    }, { maximumAge: 5 * 60_000, timeout: 10_000 });
  }

  // Removes leg j of the trip being edited (from its "Change leg" screen), with Undo.
  function removeLeg(j) {
    const ed = editing, t = ed.form, before = structuredClone(t);
    if (t.timingLeg === j) t.timingLeg = null; else if (t.timingLeg > j) t.timingLeg--;
    t.transit.splice(j, 1);
    picker = null;
    render();
    toast('Leg removed', 'Undo', () => { if (editing === ed) { ed.form = before; render(); } });
  }

  function tripScreen() {
    const t = editing.form;
    // Name from the stops ("Main St @ South St → State") until one is typed.
    const first = t.transit[0], last = t.transit.at(-1);
    const suggestion = first ? `${stopName(first.route, first.direction_id, first.stop)} → ${stopName(last.route, last.direction_id, last.alight)}` : '';
    if (!t.name || t.name === editing.suggested) { t.name = suggestion; editing.suggested = suggestion; }
    editing.moreOpen ??= !!(t.window || t.near || Number.isInteger(t.timingLeg));
    const mode = t.window ? 'window' : t.near ? 'near' : 'never';
    const setMode = m => {
      t.window = m === 'window' ? (t.window ?? { from: '06:00', to: '12:00' }) : null;
      t.near = m === 'near';
      if (t.near) askLocation();
      render();
    };
    const timeInput = key => h('input', {
      type: 'time',
      value: t.window?.[key] === '24:00' ? '00:00' : (t.window?.[key] ?? ''),
      oninput: e => { t.window = { ...t.window, [key]: e.target.value }; },
    });
    // Moving or removing legs keeps a pinned timing leg on the same leg (or unpins it).
    const moveLeg = (j, delta) => {
      const k = j + delta;
      if (k < 0 || k >= t.transit.length) return;
      if (t.timingLeg === j) t.timingLeg = k; else if (t.timingLeg === k) t.timingLeg = j;
      moveItem(t.transit, j, delta);
      render();
    };
    const legs = t.transit.flatMap((l, j) => [
      j > 0 && numberField('Minutes to transfer', l.transferBefore, v => { l.transferBefore = v; }),
      // Each leg in its own box, like the trip list: tap to change it (Remove leg is in there),
      // ↑↓ on the right. Transfer and walk times sit between and around the boxes.
      h('div', { class: 'leg-row' },
        h('button', { type: 'button', class: 'item leg-item', 'aria-label': `Change leg ${j + 1}`, onclick: () => openPicker(j) },
          h('div', { class: 'leg-main' },
            h('div', { class: 'leg-title' }, `Leg ${j + 1}`),
            h('div', { class: 'leg-text' }, legSummary(l))),
          h('span', { class: 'go' }, '›')),
        h('button', { type: 'button', 'aria-label': `Move leg ${j + 1} up`, disabled: j === 0, onclick: () => moveLeg(j, -1) }, '↑'),
        h('button', { type: 'button', 'aria-label': `Move leg ${j + 1} down`, disabled: j === t.transit.length - 1, onclick: () => moveLeg(j, 1) }, '↓')),
      // A leg on several routes: each can be dropped (one always stays).
      l.also?.length > 0 && h('div', { class: 'leg-routes' }, ...legRoutes(l).map(r => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: true, 'aria-label': `Take ${shortName(r)}`, onchange: () => {
          Object.assign(l, trimRoutes(l, legRoutes(l).filter(x => x !== r)));
          if (!l.also.length) delete l.also;
          render();
        } }), dot(routeById(r)?.attributes?.color), shortName(r)))),
    ]);
    const current = editing.idx != null ? timingFor(editing.idx) : null;
    const timing = t.transit.length > 1 && h('label', { class: 'field' }, 'Leave-by time is based on',
      h('select', { onchange: e => { t.timingLeg = e.target.value === '' ? null : Number(e.target.value); } },
        h('option', { value: '', selected: t.timingLeg == null },
          `Automatic${current != null && t.transit[current] ? ` (currently ${routeName(t.transit[current].route)})` : ''}`),
        ...t.transit.map((l, j) => h('option', { value: String(j), selected: t.timingLeg === j }, `${routeName(l.route)} (pinned)`))));
    const isSaved = editing.idx != null;
    return [
      h('div', { class: 'setup-head' },
        h('button', { type: 'button', onclick: cancelEdit }, 'Cancel'),
        h('b', {}, isSaved ? 'Edit trip' : 'New trip'),
        h('button', { type: 'button', class: 'primary', id: 'setup-save', disabled: busy || !t.transit.length, onclick: saveTrip }, 'Save')),
      ...editing.messages.map(m => h('div', { class: m.err ? 'msg err' : 'msg' }, m.text)),
      // Order: name, walk, legs (or what to do first), walk, then the less-used settings.
      h('div', { class: 'card' },
        h('label', { class: 'field' }, 'Trip name',
          h('input', { type: 'text', value: t.name, placeholder: 'Name (suggested from your stops)', oninput: e => { t.name = e.target.value; } })),
        numberField('Minutes to first stop', t.walkBefore, v => { t.walkBefore = v; }),
        ...legs,
        t.transit.length
          ? h('button', { type: 'button', class: 'add accent', onclick: () => openPicker(null) }, '+ Add transit leg')
          : h('div', { class: 'legs-empty' }, 'No legs yet. Add the bus or train you take first.',
            h('button', { type: 'button', class: 'primary add', onclick: () => openPicker(null) }, '+ Add transit leg')),
        numberField('Minutes from last stop', t.walkAfter, v => { t.walkAfter = v; }),
        // 'toggle' fires asynchronously, so a re-render right after opening (a change inside) would
        // close it again; the summary click records the new state first.
        h('details', { class: 'more', open: editing.moreOpen, ontoggle: e => { if (editing) editing.moreOpen = e.target.open; } },
          h('summary', { onclick: e => { editing.moreOpen = !e.currentTarget.parentNode.open; } }, 'More: when to show, leave-by time'),
          h('label', { class: 'field' }, 'Show automatically',
            h('select', { onchange: e => setMode(e.target.value) },
              h('option', { value: 'window', selected: mode === 'window' }, 'During a time window'),
              h('option', { value: 'near', selected: mode === 'near' }, "When I'm near its first stop"),
              h('option', { value: 'never', selected: mode === 'never' }, 'Never (only when chosen)'))),
          mode === 'window' && h('div', { class: 'row2' },
            h('label', { class: 'field' }, 'Shown from', timeInput('from')),
            h('label', { class: 'field' }, 'until', timeInput('to'))),
          timing)),
      isSaved && h('div', { class: 'btns trip-btns' },
        t.transit.length > 0 && h('button', { type: 'button', onclick: addReturnTrip }, 'Add return trip'),
        h('button', { type: 'button', class: 'danger', onclick: deleteTrip }, 'Delete trip')),
    ];
  }

  // ---------- picker ----------

  // One search for stations and routes. A later leg whose previous one ended at a rail station
  // opens straight on the drop-off list from that station ("Change" leads to the search).
  function openPicker(legIdx) {
    picker = { legIdx, step: 'search', query: '' };
    loadRoutes().then(r => { routes = r; render(); }).catch(e => { if (picker) picker.error = e.message || String(e); render(); });
    const prev = legIdx == null ? editing.form.transit.at(-1) : null;
    // The line just ridden is left out of the lists until "Show …" or a search.
    if (prev) picker.arrived = legRoutes(prev);
    const opened = picker;
    loadRailNetwork().then(net => {
      const st = prev && networkStation(net, prev.alight);
      // Only if another line leaves from there (at Oak Grove after the Orange Line, the nearby
      // stations and routes instead: the buses).
      const other = st && withoutArrived(reachableFrom(net, st.id), picker.arrived).shown.length > 0;
      if (other && picker === opened && !picker.query) picker = { ...picker, step: 'to', from: st.id, dropOff: st.id };
      if (picker) render();
    }, () => {});
    if (prev) {
      picker.nearLoading = true;
      const done = near => { if (picker && picker.legIdx == null) { picker.near = near; picker.nearLoading = false; render(); } };
      loadNearby(prev).then(done, () => done(null));
    }
    render();
  }

  // Routes serving stops within NEARBY_RADIUS of the previous leg's drop-off stop. Uses the stop's
  // location (a street bus stop has no parent station linking it to the nearby subway station).
  async function loadNearby(prev) {
    const doc = await loadStops(prev.route, prev.direction_id);
    const stop = doc.data.find(s => s.id === prev.alight || s.relationships?.child_stops?.data?.some(c => c.id === prev.alight));
    const { latitude: lat, longitude: lon, name } = stop?.attributes ?? {};
    if (lat == null || lon == null) return null;
    const nearby = await api('/stops', {
      'filter[latitude]': lat, 'filter[longitude]': lon, 'filter[radius]': NEARBY_RADIUS,
      'filter[route_type]': '0,1,3', 'fields[stop]': 'name',
    });
    if (!nearby.data.length) return null;
    const served = await api('/routes', {
      'filter[stop]': nearby.data.map(s => s.id).join(','), 'filter[type]': '0,1,3', 'fields[route]': 'short_name',
    });
    return { name, lat, lon, routeIds: served.data.map(r => r.id) };
  }

  // "Show nearby" (first leg): the routes at stops within NEARBY_ME_METERS of `here`, with each
  // route's distance from the next hour's schedules at those stops (none if that fails). The
  // push server's digest (`nearby`) first; on any failure, the 3 MBTA requests from here.
  async function loadNearMe(here) {
    if (nearby) {
      try {
        const { routes: found } = await nearby(here);
        return { here, routeIds: found.map(r => r.id), dist: new Map(found.filter(r => r.meters != null).map(r => [r.id, r.meters])) };
      } catch { /* the MBTA directly */ }
    }
    const stops = await api('/stops', {
      'filter[latitude]': here.lat, 'filter[longitude]': here.lon, 'filter[radius]': NEARBY_ME_DEGREES,
      'filter[route_type]': '0,1,3', 'fields[stop]': 'name,latitude,longitude',
    });
    if (!stops.data.length) return { here, routeIds: [], dist: new Map() };
    const ids = stops.data.map(s => s.id).join(',');
    const served = await api('/routes', { 'filter[stop]': ids, 'filter[type]': '0,1,3', 'fields[route]': 'short_name' });
    let dist = new Map();
    try {
      const w = scheduleWindow(Date.now(), 0, 60);
      const sched = await api('/schedules', {
        'filter[stop]': ids, 'filter[date]': w.date, 'filter[min_time]': w.minTime, 'filter[max_time]': w.maxTime,
        'fields[schedule]': 'stop_sequence',
      });
      dist = routeDistances(stops.data, sched.data, here);
    } catch { /* routes without distances */ }
    return { here, routeIds: served.data.map(r => r.id), dist };
  }

  // Asks for the position (the permission prompt on first use), then loads what is near it.
  function showNearMe() {
    picker = { ...picker, meLoading: true, meError: null };
    render();
    const fail = msg => { if (picker) { picker = { ...picker, meLoading: false, meError: msg }; render(); } };
    if (!navigator.geolocation) return fail("Couldn't get your location.");
    const opened = picker;
    navigator.geolocation.getCurrentPosition(pos => {
      loadNearMe({ lat: pos.coords.latitude, lon: pos.coords.longitude }).then(me => {
        if (picker?.legIdx !== opened.legIdx || picker.step !== 'search') return;
        picker = { ...picker, me, here: me.here, meLoading: false };
        render();
      }, e => fail(e.message || String(e)));
    }, err => fail(err.code === err.PERMISSION_DENIED ? 'Location is off for this app.' : "Couldn't get your location."),
    { maximumAge: 60_000, timeout: 10_000 });
  }

  // A route is chosen: load both directions' stops. For a new leg, board at the stop nearest
  // the previous drop-off (skipping to the drop-off step); Back still leads to the board list.
  async function chooseRoute(route) {
    picker = { ...picker, route, step: 'board', query: '', loading: true, alight: null };
    render();
    try {
      const docs = await Promise.all([0, 1].map(d => loadStops(route.id, d)));
      const near = picker.near && nearestStop(docs.flatMap(d => d.data), picker.near.lat, picker.near.lon);
      if (near && alightGroups(...docs, near.id).length) picker = { ...picker, board: near.id, step: 'alight' };
    } catch (e) { picker.error = e.message || String(e); }
    picker.loading = false;
    render();
  }

  // Other routes that also go from the board stop to the drop-off in this direction (the Green
  // Line branches between Government Center and Park Street): routes at both stops, whose stop
  // list has them in order. 2 requests plus one per candidate (cached per route/direction).
  async function findAlso(route, direction, board, alight) {
    const at = id => api('/routes', { 'filter[stop]': id, 'filter[type]': '0,1,3', 'fields[route]': 'short_name' })
      .then(doc => new Set(doc.data.map(r => r.id)));
    const [a, b] = await Promise.all([at(board), at(alight)]);
    const candidates = [...a].filter(id => id !== route && b.has(id));
    const ok = await Promise.all(candidates.map(id => loadStops(id, direction).then(doc => servesInOrder(doc, board, alight), () => false)));
    return candidates.filter((_, i) => ok[i]);
  }

  // The drop-off is chosen: offer the other routes for the same ride, if any, else finish.
  async function chooseAlight(alight, direction) {
    picker = { ...picker, alight, direction, loading: true };
    render();
    let also = [];
    try { also = await findAlso(picker.route.id, direction, picker.board, alight); } catch { /* offline: just this route */ }
    if (picker?.alight !== alight) return; // Back while checking
    if (!also.length) { finishLeg(alight, direction); return; }
    picker = { ...picker, step: 'also', also: also.map(route => ({ route, checked: true })), loading: false, query: '' };
    render();
  }

  // Station-first: from the picked station to `toId`, on every line that makes the ride.
  function chooseTo(toId) {
    const leg = legBetween(railNet, picker.from, toId);
    if (!leg) return;
    picker = { ...picker, route: { id: leg.route }, board: picker.from, also: leg.also.map(route => ({ route, checked: true })) };
    finishLeg(toId, leg.direction);
  }

  function finishLeg(alight, direction) {
    const trip = editing.form;
    const also = (picker.also ?? []).filter(a => a.checked).map(a => a.route);
    const leg = { route: picker.route.id, direction_id: direction, stop: picker.board, alight, ...(also.length && { also }), transferBefore: 0 };
    if (picker.legIdx == null) {
      const prev = trip.transit[trip.transit.length - 1];
      if (prev) {
        const parents = parentMap(stopDocs.get(stopsKey(prev.route, prev.direction_id)), stopDocs.get(stopsKey(leg.route, leg.direction_id)));
        for (const [child, parent] of Object.entries(railNet?.parents ?? {})) if (!parents.has(child)) parents.set(child, parent);
        leg.transferBefore = defaultTransferMinutes(prev.alight, leg.stop, parents);
      }
      trip.transit.push(leg);
    } else {
      leg.transferBefore = trip.transit[picker.legIdx].transferBefore;
      trip.transit[picker.legIdx] = leg;
    }
    picker = null;
    render();
  }

  // Dot-labels for rail lines ("● Orange", "● Green B/C/D/E").
  const lineTags = list => list.flatMap(c => [' ', h('span', { class: 'tag conn' }, dot(c.color), c.label)]);
  // A list button with its distance at the right ("120 m"), read after the name.
  const withDist = (button, span) => {
    button.replaceChildren(h('span', { class: 'main' }, ...button.childNodes), span);
    button.classList.add('has-dist');
    return button;
  };
  const stationLines = (id, exclude = []) => lineTags(railConnections({ id }, railStops, exclude));

  // Auto-route's Places (addresses and named places, through the T-Minus server): searched once
  // the query has PLACE_MIN_CHARS and typing pauses PLACE_DEBOUNCE_MS; the list redraws when they
  // arrive. Rows for the Places section, or null (not in plan mode, or too short).
  let pickerListEl = null;
  let placeTimer = null;
  function placesFor(raw) {
    const q = raw.trim().replace(/\s+/g, ' ');
    if (!picker.planField || !planApi || q.length < PLACE_MIN_CHARS) return null;
    const heading = h('div', { class: 'muted section-head' }, 'Places');
    const got = picker.places;
    if (got?.q !== q) {
      // A token, not the picker object: picker updates copy it.
      const token = {};
      picker.places = { q, loading: true, token };
      clearTimeout(placeTimer);
      placeTimer = setTimeout(() => {
        planApi('/places', { q }).then(r => ({ q, list: r.places }), () => ({ q, error: true })).then(res => {
          if (picker?.places?.token !== token) return;
          picker.places = res;
          if (picker.query.trim().replace(/\s+/g, ' ') === q) pickerListEl?.replaceChildren(...pickerList());
        });
      }, PLACE_DEBOUNCE_MS);
      return [heading, h('div', { class: 'muted' }, 'Searching places…')];
    }
    if (got.loading) return [heading, h('div', { class: 'muted' }, 'Searching places…')];
    if (got.error) return [heading, h('div', { class: 'muted' }, 'Place search is unavailable right now.')];
    if (!got.list.length) return [heading, h('div', { class: 'muted' }, 'No places found.')];
    return [heading, ...got.list.map(pl => h('button', { type: 'button', class: 'item place', onclick: () => pickPlace(pointPlace(pl.lat, pl.lon, pl.name, pl.detail)) },
      h('b', {}, pl.name), pl.detail && h('span', { class: 'muted' }, ` · ${pl.detail}`)))];
  }

  // Auto-route's "Current location": the phone's position as From or To.
  function useMyLocation() {
    picker = { ...picker, hereLoading: true, hereError: null };
    render();
    const opened = picker;
    const fail = msg => { if (picker === opened) { picker = { ...picker, hereLoading: false, hereError: msg }; render(); } };
    if (!navigator.geolocation) return fail("Couldn't get your location.");
    navigator.geolocation.getCurrentPosition(pos => {
      if (picker !== opened) return;
      const round = x => Number(x.toFixed(5));
      pickPlace({ ...pointPlace(round(pos.coords.latitude), round(pos.coords.longitude), 'Current location', null), current: true });
    }, err => fail(err.code === err.PERMISSION_DENIED ? 'Location is off for this app.' : "Couldn't get your location."),
    { maximumAge: 60_000, timeout: 10_000 });
  }

  function pickerList() {
    const q = picker.query;
    const heading = text => h('div', { class: 'muted section-head' }, text);
    if (picker.step === 'search') {
      if (!routes) return [h('div', { class: 'muted' }, picker.error ?? 'Loading routes…')];
      const found = searchRoutes(routes, q);
      const routeButton = r => h('button', { type: 'button', class: 'item', onclick: () => chooseRoute(r) }, dot(r.attributes.color), h('b', {}, shortRouteLabel(r)), routeEnds(r) && h('span', { class: 'muted' }, ` ${routeEnds(r)}`));
      const stationButton = st => h('button', { type: 'button', class: 'item station', onclick: () => {
        if (picker.planField) return pickPlace(stationPlace(st.id));
        picker = { ...picker, step: 'to', from: st.id, query: '' };
        render();
      } }, h('b', {}, st.name), ...stationLines(st.id));
      const showAll = h('button', { type: 'button', class: 'add', onclick: () => { picker.allRoutes = true; render(); } }, 'Show all routes');
      // The first leg of the trip (a new trip's first, or changing leg 1).
      const firstLeg = !!picker.planField || picker.legIdx === 0 || (picker.legIdx == null && !editing.form.transit.length);
      if (q.trim()) {
        const stations = railNet ? searchStations(railNet, q).slice(0, 8) : [];
        const places = placesFor(q);
        return [
          stations.length ? heading('Stations') : null, ...stations.map(stationButton),
          (stations.length || places) && found.length ? heading('Routes') : null,
          ...found.slice(0, ROUTE_LIMIT).map(routeButton),
          found.length > ROUTE_LIMIT ? h('div', { class: 'muted' }, `${found.length - ROUTE_LIMIT} more; refine the search.`) : null,
          ...(places ?? []),
        ].filter(Boolean);
      }
      if (!picker.allRoutes) {
        // A next leg: the stations and routes near the previous drop-off (you transfer there).
        if (picker.nearLoading) return [h('div', { class: 'muted' }, 'Finding routes nearby…')];
        if (picker.near) {
          const here = { lat: picker.near.lat, lon: picker.near.lon };
          // Not a station whose only lines are the one just ridden (it would list nothing).
          const stations = (railNet?.stations ?? []).filter(st => st.lat != null && distanceMeters(here, st) <= NEARBY_STATION_METERS
            && withoutArrived(reachableFrom(railNet, st.id), picker.arrived).shown.length > 0);
          const nearRoutes = found.filter(r => picker.near.routeIds.includes(r.id) && !picker.arrived?.includes(r.id));
          if (stations.length || nearRoutes.length) {
            return [
              h('div', { class: 'muted' }, `Near ${picker.near.name}`),
              stations.length ? heading('Stations') : null, ...stations.map(stationButton),
              nearRoutes.length ? heading('Routes') : null, ...nearRoutes.map(routeButton),
              showAll,
            ].filter(Boolean);
          }
        } else if (picker.me) {
          // A first leg after "Show nearby": stations, then routes, nearest first.
          const { here, dist } = picker.me;
          const distSpan = m => h('span', { class: 'dist' }, m == null ? '—' : formatDistance(m));
          const stations = byDistance(railNet?.stations ?? [], here, st => st)
            .filter(x => x.meters != null && x.meters <= NEARBY_ME_METERS);
          // A rail line without a scheduled stop nearby in the next hour: its nearest station.
          const railDist = id => stations.find(x => x.item.routes.includes(id))?.meters ?? null;
          const nearRoutes = found.filter(r => picker.me.routeIds.includes(r.id))
            .map((r, i) => ({ r, i, m: dist.get(r.id) ?? railDist(r.id) }))
            .sort((a, b) => (a.m ?? Infinity) - (b.m ?? Infinity) || a.i - b.i);
          return [
            h('div', { class: 'muted' }, `Near you · within ${formatDistance(NEARBY_ME_METERS)}`),
            stations.length ? heading('Stations') : null,
            ...stations.map(x => withDist(stationButton(x.item), distSpan(x.meters))),
            nearRoutes.length ? heading('Routes') : null,
            ...nearRoutes.map(x => withDist(routeButton(x.r), distSpan(x.m))),
            !stations.length && !nearRoutes.length ? h('div', { class: 'muted' }, 'No stops found nearby.') : null,
            showAll,
          ].filter(Boolean);
        } else {
          // A first leg: the rail lines; type to find a station or a bus route. "Show nearby"
          // lists what is around you (location asked on tap, each time).
          const searchesPlaces = picker.planField && planApi;
          return [
            // Auto-route's From or To: plan from (or to) where you are.
            searchesPlaces && h('button', { type: 'button', class: 'item', id: 'plan-here', disabled: !!picker.hereLoading, onclick: useMyLocation },
              h('b', {}, 'Current location'), h('span', { class: 'muted' }, picker.hereLoading ? ' · finding your location…' : ` · plan ${picker.planField} where you are`)),
            picker.hereError ? h('div', { class: 'muted' }, picker.hereError) : null,
            firstLeg ? h('button', { type: 'button', class: 'add', disabled: !!picker.meLoading, onclick: showNearMe },
              picker.meLoading ? 'Finding your location…' : 'Show nearby stops and stations') : null,
            picker.meError ? h('div', { class: 'muted' }, picker.meError) : null,
            h('div', { class: 'muted' }, searchesPlaces ? 'Type a station (e.g. Oak Grove), a route (e.g. 132), an address or a place.' : 'Type a station (e.g. Oak Grove) or a route (e.g. 132).'),
            ...found.filter(r => r.attributes?.type <= 1).map(routeButton), showAll].filter(Boolean);
        }
      }
      return [
        ...found.slice(0, ROUTE_LIMIT).map(routeButton),
        found.length > ROUTE_LIMIT ? h('div', { class: 'muted' }, `${found.length - ROUTE_LIMIT} more; refine the search.`) : null,
      ].filter(Boolean);
    }
    if (picker.step === 'to') {
      // Station-first drop-off: stations reachable without a transfer, per line and direction;
      // on a line with branches, which ones stop ("Green B/C/D", or "Green (any)" for all).
      if (!railNet) return [h('div', { class: 'muted' }, 'Loading stations…')];
      const all = reachableFrom(railNet, picker.from);
      const { shown, hidden } = q.trim() || picker.showArrived ? { shown: all, hidden: [] } : withoutArrived(all, picker.arrived);
      const label = id => railNet.lines.find(l => l.id === id)?.label ?? id;
      const showArrived = hidden.length ? [h('div', { class: 'muted arrived-note' }, 'Hidden: the line you arrived on.'),
        h('button', { type: 'button', class: 'add', onclick: () => { picker.showArrived = true; render(); } },
          `Show ${lineLabel({ label: commonLabel(hidden.map(g => g.label)) })}`)] : [];
      // A next leg: the buses near the drop-off, one tap away (the "Near …" list).
      const buses = picker.near && picker.from === picker.dropOff && (routes ?? []).some(r => r.attributes?.type === 3 && picker.near.routeIds.includes(r.id) && !picker.arrived?.includes(r.id));
      const fromName = networkStation(railNet, picker.from)?.name ?? picker.from;
      const busesNear = buses ? [h('button', { type: 'button', class: 'add', onclick: () => { picker = { ...picker, step: 'search', query: '' }; render(); } }, `Buses near ${fromName}`)] : [];
      return [...shown.flatMap(g => {
        const found = searchStops(g.stations.map(st => ({ ...st, attributes: { name: st.name } })), q);
        if (!found.length) return [];
        return [h('div', { class: 'muted section-head' }, dot(g.color), `${g.label} toward ${g.toward.join(' / ')}`),
          ...found.map(st => h('button', { type: 'button', class: 'item', onclick: () => chooseTo(st.id) },
            st.name,
            g.routes.length > 1 && h('span', { class: 'muted' }, ` · ${st.routes.length < g.routes.length ? commonLabel(st.routes.map(label)) : `${g.label} (any)`}`),
            ...stationLines(st.id, g.routes)))];
      }), ...showArrived, ...busesNear];
    }
    const docs = bothDocs(picker.route.id);
    if (picker.loading && picker.alight) return [h('div', { class: 'muted' }, 'Checking other routes…')];
    if (picker.loading || !docs[0] || !docs[1]) return [h('div', { class: 'muted' }, picker.error ?? 'Loading stops…')];
    const toward = d => `toward ${destination(picker.route.id, d)}`;
    if (picker.step === 'board') {
      // Stops served both ways first, then each direction's own (the two sides of a street).
      if (picker.planField) return planStopRows(docs);
      const { both, only } = boardGroups(...docs);
      const pick = s => h('button', { type: 'button', class: 'item', onclick: () => {
        picker = { ...picker, board: s.id, step: 'alight', query: '' };
        render();
      } }, s.attributes?.name ?? s.id);
      const sections = [{ head: null, stops: searchStops(both, q) },
        ...only.map((list, d) => ({ head: heading(toward(d)), stops: searchStops(list, q) }))].filter(s => s.stops.length);
      const here = picker.here;
      if (!here) return sections.flatMap(s => [s.head, ...s.stops.map(pick)].filter(Boolean));
      // After "Show nearby": nearest first, with distances; the section with the nearest stop
      // comes first (at a terminal, the stop you'd board is often one direction's own).
      const ranked = sections.map(s => ({ ...s, near: byDistance(s.stops, here, st => ({ lat: st.attributes?.latitude, lon: st.attributes?.longitude })) }))
        .sort((a, b) => (a.near[0].meters ?? Infinity) - (b.near[0].meters ?? Infinity));
      return ranked.flatMap((s, i) => [
        // The both-ways section has no heading; moved below another, it gets one.
        s.head ?? (i > 0 ? heading('Both directions') : null),
        ...s.near.map(x => withDist(pick(x.item), h('span', { class: 'dist' }, x.meters == null ? '—' : formatDistance(x.meters))))].filter(Boolean));
    }
    // Drop-off: the stops after the board stop, per direction it serves (one at the end of a
    // line), each with the rail lines there (loaded in the background; none if that fails).
    if (!railStops) loadRailNetwork().then(() => { if (picker?.step === 'alight') render(); }, () => {});
    // A rail route's per-direction stop list merges its branches: keep only the stations the
    // network says are reachable from the board stop on this route (no Ashmont → Quincy).
    const onNetwork = railNet?.lines.some(l => l.id === picker.route.id);
    const reach = d => new Set(reachableFrom(railNet, picker.board).filter(g => g.direction === d)
      .flatMap(g => g.stations.filter(st => st.routes.includes(picker.route.id)).map(st => st.id)));
    return alightGroups(...docs, picker.board).flatMap(g => {
      const ok = onNetwork ? reach(g.direction) : null;
      const stops = ok ? g.stops.filter(s => ok.has(s.id)) : g.stops;
      // Tags from the whole direction list, so they don't move while searching.
      const conn = stopConnections(stops, railStops, [picker.route.id]);
      const found = searchStops(stops, q);
      return found.length ? [heading(toward(g.direction)), ...found.map(s => h('button', { type: 'button', class: 'item', onclick: () => chooseAlight(s.id, g.direction) },
        s.attributes?.name ?? s.id, ...lineTags(conn.get(s.id) ?? [])))] : [];
    });
  }

  // Auto-route's stop list for a route: the two sides of a street as one row (stopPairs; the
  // planner picks the side), "toward … only" for a stop without a partner. From lists stops you
  // can board, To those you can get off at. After "Show nearby", nearest first.
  function planStopRows(docs) {
    const r = picker.route;
    const groups = picker.planField === 'to' ? dropOffGroups(...docs) : boardGroups(...docs);
    const byId = new Map([...groups.both, ...groups.only.flat()].map(s => [s.id, s]));
    const q = picker.query.trim().toLowerCase();
    let rows = stopPairs(groups).filter(row => !q || (row.names ?? [row.name]).some(n => n.toLowerCase().includes(q)));
    const here = picker.here;
    const meters = row => (here ? Math.min(...row.ids.map(id => { const a = byId.get(id)?.attributes ?? {}; return Number.isFinite(a.latitude) ? distanceMeters(here, { lat: a.latitude, lon: a.longitude }) : Infinity; })) : null);
    if (here) rows = rows.map(row => ({ ...row, m: meters(row) })).sort((a, b) => a.m - b.m);
    return rows.map(row => {
      const note = row.both ? ' · both sides' : row.toward != null ? ` · toward ${destination(r.id, row.toward)} only` : '';
      const b = h('button', { type: 'button', class: 'item', onclick: () => pickPlace({ id: row.ids.join(','), name: row.name, routes: [{ id: r.id, label: shortRouteLabel(r), color: r.attributes?.color }] }) },
        row.name, note && h('span', { class: 'muted' }, note));
      return here && Number.isFinite(row.m) ? withDist(b, h('span', { class: 'dist' }, formatDistance(row.m))) : b;
    });
  }

  function pickerScreen() {
    const plan = { from: { search: 'From', board: 'From: where do you board?' }, to: { search: 'To', board: 'To: where do you get off?' } }[picker.planField];
    const titles = { search: picker.legIdx == null ? 'Add a leg' : 'Change leg', to: 'Where do you get off?', board: 'Where do you board?', alight: 'Where do you get off?', also: 'Also take', ...plan };
    const back = () => {
      const prev = { search: null, to: 'search', board: 'search', alight: 'board', also: 'alight' }[picker.step];
      // The nearby list goes back to the plain first-leg list.
      if (picker.step === 'search' && picker.me && !picker.allRoutes) picker = { ...picker, me: null, here: null, query: '' };
      else if (prev) { picker = { ...picker, step: prev, query: '' }; } else { picker = null; }
      render();
    };
    const head = h('div', { class: 'setup-head' },
      h('button', { type: 'button', onclick: back }, 'Back'), h('b', {}, titles[picker.step]), h('span'));
    const fromStation = picker.step === 'to' && (networkStation(railNet, picker.from)?.name ?? picker.from);
    const context = picker.step === 'to' ? h('div', { class: 'muted' }, `From ${fromStation} · `,
      h('button', { type: 'button', class: 'link', onclick: () => { picker = { ...picker, step: 'search', query: '' }; render(); } }, 'Change'))
      : picker.step !== 'search' && picker.route && h('div', { class: 'muted' },
      [routeLabel(picker.route), picker.board && `from ${stopName(picker.route.id, null, picker.board)}`,
        picker.step === 'also' && `to ${stopName(picker.route.id, picker.direction, picker.alight)}`].filter(Boolean).join(' · '));
    if (picker.step === 'also') {
      return [h('div', { class: 'picker-top' }, head, context),
        h('div', { class: 'muted' }, 'These also make this ride. Any checked route counts.'),
        h('div', { class: 'list' }, ...picker.also.map(a => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: a.checked, onchange: e => { a.checked = e.target.checked; } }),
          dot(routeById(a.route)?.attributes?.color), shortName(a.route)))),
        h('button', { type: 'button', class: 'primary add', onclick: () => finishLeg(picker.alight, picker.direction) }, 'Done')];
    }
    const list = h('div', { class: 'list' }, pickerList());
    const search = h('input', {
      type: 'search', id: 'picker-search',
      placeholder: picker.step === 'search' ? (picker.planField && planApi ? 'Search stations, routes, places' : 'Search stations or routes') : picker.step === 'to' ? 'Search stations' : 'Search stops',
      value: picker.query, oninput: e => { picker.query = e.target.value; list.replaceChildren(...pickerList()); },
    });
    pickerListEl = list;
    // Header, context and search stay at the top while the list scrolls under them (and iOS's
    // scroll for the keyboard can't slide the search under the header).
    // Changing an existing leg: removing it lives here, as "Delete trip" lives in the trip editor.
    const remove = picker.legIdx != null && (picker.step === 'search' || picker.step === 'to')
      && h('button', { type: 'button', class: 'danger add', onclick: () => removeLeg(picker.legIdx) }, 'Remove leg');
    return [h('div', { class: 'picker-top' }, head, context, search), list, remove];
  }

  // The list keeps its scroll position while a trip is open, and a trip keeps its own while a
  // picker is open; opening a trip and each picker step start at the top.
  let shown = null;
  const scrollY = { list: 0, trip: 0 };
  function render() {
    const screen = picker ? `picker:${picker.step}` : editing ? 'trip' : planner ? 'plan' : 'list';
    if (screen !== shown && (shown === 'list' || shown === 'trip')) scrollY[shown] = window.scrollY;
    root.replaceChildren(...(picker ? pickerScreen() : editing ? tripScreen() : planner ? plannerScreen() : listScreen()).flat().filter(Boolean));
    if (screen !== shown) {
      const restore = screen === 'list' || (screen === 'trip' && shown?.startsWith('picker:'));
      window.scrollTo(0, restore ? scrollY[screen] : 0);
    }
    shown = screen;
    if (picker && picker.step !== 'also') root.querySelector('#picker-search')?.focus({ preventScroll: true });
  }

  root.hidden = false;
  loadNames();
  render();
  // Closing drops the planner, so a late answer to a closed search never redraws over the next
  // setup view (they share `root`).
  return { close() { planner = null; root.hidden = true; root.replaceChildren(); } };
}
