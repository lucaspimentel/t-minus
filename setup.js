// Full-screen setup view: a list of trips, one trip's editor at a time, and the leg picker
// (station-first for subway and light rail, route-first for buses; the direction follows from
// the stops picked). Each trip is saved on its own. Pure helpers live in core.js; this module owns the DOM
// and the setup-time requests.
import {
  validateConfig, checkStops, stopQueries, stopsKey, locateLegs, tripLabel, tripToForm, formToTrip, routeLabel, routeEnds, shortRouteLabel, labelLegs,
  searchRoutes, searchStops, boardGroups, alightGroups, railConnections, servesInOrder, commonLabel, legRoutes,
  railNetwork, networkStation, railStopsFrom, searchStations, reachableFrom, legBetween, trimRoutes, distanceMeters, defaultTransferMinutes, departureCount, stopSlackMinutes, wakeMinutes,
  reverseTrip, nearestStop, windowLabel,
} from './core.js?v=823673841b';

const ROUTE_LIMIT = 60;

// Session caches (kept across openSetup calls; route and stop lists rarely change).
let routesPromise = null;
const stopDocs = new Map(); // stopsKey → /stops doc (trip order, with child_stops)
// The subway and light-rail network (railNetwork): station-first legs and the connections shown
// in the drop-off lists. One request, cached for a week.
const RAIL_KEY = 'mbta-leave-by:rail-network';
const RAIL_TTL = 7 * 24 * 60 * 60_000;
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

const emptyTrip = n => ({ name: n === 0 ? 'My trip' : `Trip ${n + 1}`, window: null, near: false, timingLeg: null, walkBefore: 5, walkAfter: 5, transit: [] });
const numberValue = v => (v === '' ? NaN : Number(v));
const info = text => ({ text, err: false });
const errs = list => list.map(text => ({ text, err: true }));

// Radius for next-leg suggestions, in degrees (~300 m).
const NEARBY_RADIUS = 0.003;

// `onSave(config, warning)` stores a config and keeps setup open; `onClose()` leaves setup.
// `timingFor(i)` returns the timing leg the app currently uses for saved trip i (or null).
// `toast(text, action, onAction)` / `hideToast()`: the app's Undo toast.
export function openSetup({ root, config, api, onSave, onClose, timingFor = () => null, toast = () => {}, hideToast = () => {} }) {
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
  let editing = saved ? null : editor(null, 0, emptyTrip(0));
  let routes = null;
  // { legIdx (null = new leg), step, query, near, ... }. Steps: 'search' (stations and routes);
  // station-first 'to' { from }; route-first 'board' → 'alight' → 'also' { route, board, alight,
  // direction, also: [{ route, checked }] (other routes for the same ride) }.
  // `near`: { name, lat, lon, routeIds } around the previous leg's drop-off, for suggestions.
  let picker = null;
  let listMessages = [];
  let busy = false;

  const loadRoutes = () => (routesPromise ??= api('/routes', {
    'filter[type]': '0,1,3',
    'fields[route]': 'short_name,long_name,type,color,direction_names,direction_destinations,sort_order',
  }).then(doc => doc.data).catch(e => { routesPromise = null; throw e; }));

  async function loadStops(route, direction) {
    const key = stopsKey(route, direction);
    if (!stopDocs.has(key)) {
      stopDocs.set(key, await api('/stops', {
        'filter[route]': route,
        'filter[direction_id]': direction,
        'fields[stop]': 'name,latitude,longitude',
        include: 'child_stops',
      }));
    }
    return stopDocs.get(key);
  }

  // The rail network (route types 0 and 1) from the cache or the API: canonical route patterns
  // with their stations in order.
  function loadRailNetwork() {
    const use = net => { railNet = net; railStops = railStopsFrom(net); return net; };
    if (railNet) return Promise.resolve(railNet);
    try {
      const cached = JSON.parse(localStorage.getItem(RAIL_KEY));
      if (cached && Date.now() - cached.at < RAIL_TTL) return Promise.resolve(use(cached.data));
    } catch {}
    return (railPromise ??= loadRoutes()
      .then(rs => {
        const rail = rs.filter(r => r.attributes?.type <= 1);
        return api('/route_patterns', {
          'filter[route]': rail.map(r => r.id).join(','), 'filter[canonical]': 'true',
          include: 'representative_trip.stops', 'fields[route_pattern]': 'direction_id', 'fields[trip]': '',
          'fields[stop]': 'name,latitude,longitude',
        }).then(doc => railNetwork(doc, rail));
      })
      .then(net => {
        try { localStorage.setItem(RAIL_KEY, JSON.stringify({ at: Date.now(), data: net })); } catch {}
        return use(net);
      })
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
    const cfg = { ...saved, ...app, apiKey: app.apiKey.trim() };
    const errors = validateConfig(cfg);
    if (errors.length) { listMessages = errs(errors); return render(); }
    const before = appFields(saved);
    if (cfg.departureCount !== before.departureCount || cfg.stopSlackMinutes !== before.stopSlackMinutes || cfg.wakeMinutes !== before.wakeMinutes || cfg.apiKey !== before.apiKey) {
      persist(cfg);
    }
    onClose();
  }

  let ioArea = null; // { mode: 'export' | 'import', text }

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
        h('b', {}, t.name),
        h('div', { class: 'muted' }, `${t.near ? 'Near first stop' : windowLabel(t.window)} · `, ...chain)),
      h('button', { type: 'button', 'aria-label': `Move ${t.name} up`, disabled: i === 0, onclick: () => moveTrip(i, -1) }, '↑'),
      h('button', { type: 'button', 'aria-label': `Move ${t.name} down`, disabled: i === n - 1, onclick: () => moveTrip(i, 1) }, '↓'));
  }

  function listScreen() {
    const trips = savedTrips();
    return [
      h('div', { class: 'setup-head' },
        h('span'),
        h('b', {}, 'Setup'),
        h('button', { type: 'button', class: 'primary', id: 'setup-done', disabled: busy || !saved, onclick: done }, 'Done')),
      ...listMessages.map(m => h('div', { class: m.err ? 'msg err' : 'msg' }, m.text)),
      h('div', { class: 'list trips' }, trips.map((t, i) => tripRow(t, i, trips.length))),
      h('button', { type: 'button', class: 'add', onclick: addTrip }, '+ Add trip'),
      h('div', { class: 'muted section' }, 'Settings'),
      h('div', { class: 'card' },
        numberField('Departures shown (1-8)', app.departureCount, v => { app.departureCount = v; }, { min: '1', max: '8' }),
        numberField('Minutes early at the stop', app.stopSlackMinutes, v => { app.stopSlackMinutes = v; }),
        numberField('Keep screen on before leave-by (min, 0 = off)', app.wakeMinutes, v => { app.wakeMinutes = v; }),
        h('label', { class: 'field' }, 'MBTA API key (optional)',
          // Masked so the key isn't exposed on screen (or in screenshots).
          h('input', { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'Keyless: 20 requests/min', value: app.apiKey, oninput: e => { app.apiKey = e.target.value; } }))),
      h('div', { class: 'btns io' },
        saved && h('button', { type: 'button', onclick: exportConfig }, 'Export'),
        h('button', { type: 'button', onclick: () => { ioArea = { mode: 'import', text: '' }; render(); } }, 'Import'),
        // Reloads the page (the service worker is network-first, so this picks up a new version).
        h('button', { type: 'button', onclick: () => location.reload() }, 'Reload app')),
      ioArea && h('div', { class: 'card' },
        ioArea.note && h('div', { class: 'msg' }, ioArea.note),
        h('textarea', { id: 'setup-io', readOnly: ioArea.mode === 'export', value: ioArea.text, placeholder: 'Paste a trips config (JSON)', oninput: e => { ioArea.text = e.target.value; } }),
        ioArea.mode === 'import' && h('button', { type: 'button', disabled: busy, onclick: () => importConfig(ioArea.text) }, 'Load')),
    ];
  }

  // ---------- trip screen ----------

  async function saveTrip() {
    const pos = editing.idx ?? editing.insertAt;
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

  function tripScreen() {
    const t = editing.form;
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
    const removeLeg = j => {
      const ed = editing, before = structuredClone(t);
      if (t.timingLeg === j) t.timingLeg = null; else if (t.timingLeg > j) t.timingLeg--;
      t.transit.splice(j, 1);
      render();
      toast('Leg removed', 'Undo', () => { if (editing === ed) { ed.form = before; render(); } });
    };
    const legs = t.transit.flatMap((l, j) => [
      j > 0 && numberField('Transfer (min)', l.transferBefore, v => { l.transferBefore = v; }),
      h('div', { class: 'leg-item' },
        h('div', { class: 'leg-text' }, legSummary(l)),
        // A leg on several routes: each can be dropped (one always stays).
        l.also?.length > 0 && h('div', { class: 'leg-routes' }, ...legRoutes(l).map(r => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: true, 'aria-label': `Take ${shortName(r)}`, onchange: () => {
            Object.assign(l, trimRoutes(l, legRoutes(l).filter(x => x !== r)));
            if (!l.also.length) delete l.also;
            render();
          } }), dot(routeById(r)?.attributes?.color), shortName(r)))),
        h('div', { class: 'btns' },
          h('button', { type: 'button', onclick: () => openPicker(j) }, 'Edit'),
          h('button', { type: 'button', 'aria-label': 'Move up', onclick: () => moveLeg(j, -1) }, '↑'),
          h('button', { type: 'button', 'aria-label': 'Move down', onclick: () => moveLeg(j, 1) }, '↓'),
          h('button', { type: 'button', 'aria-label': 'Remove leg', onclick: () => removeLeg(j) }, '✕'))),
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
        savedTrips().length
          ? h('button', { type: 'button', onclick: cancelEdit }, 'Cancel')
          // First run: no list to cancel back to; offer the list's import box instead.
          : h('button', { type: 'button', id: 'setup-import', onclick: () => { editing = null; ioArea = { mode: 'import', text: '' }; render(); } }, 'Import'),
        h('b', {}, isSaved ? 'Edit trip' : 'New trip'),
        h('button', { type: 'button', class: 'primary', id: 'setup-save', disabled: busy, onclick: saveTrip }, 'Save')),
      ...editing.messages.map(m => h('div', { class: m.err ? 'msg err' : 'msg' }, m.text)),
      h('div', { class: 'card' },
        h('label', { class: 'field' }, 'Trip name',
          h('input', { type: 'text', value: t.name, oninput: e => { t.name = e.target.value; } })),
        h('label', { class: 'field' }, 'Show automatically',
          h('select', { onchange: e => setMode(e.target.value) },
            h('option', { value: 'window', selected: mode === 'window' }, 'During a time window'),
            h('option', { value: 'near', selected: mode === 'near' }, "When I'm near its first stop"),
            h('option', { value: 'never', selected: mode === 'never' }, 'Never (only when chosen)'))),
        mode === 'window' && h('div', { class: 'row2' },
          h('label', { class: 'field' }, 'Shown from', timeInput('from')),
          h('label', { class: 'field' }, 'until', timeInput('to'))),
        numberField('Time to first stop (min)', t.walkBefore, v => { t.walkBefore = v; }),
        ...legs,
        h('button', { type: 'button', class: 'add', onclick: () => openPicker(null) }, '+ Add transit leg'),
        numberField('Time from last stop (min)', t.walkAfter, v => { t.walkAfter = v; }),
        timing),
      isSaved && h('div', { class: 'btns trip-btns' },
        t.transit.length > 0 && h('button', { type: 'button', onclick: addReturnTrip }, 'Add return trip'),
        savedTrips().length > 1 && h('button', { type: 'button', class: 'danger', onclick: deleteTrip }, 'Delete trip')),
    ];
  }

  // ---------- picker ----------

  // One search for stations and routes. A later leg whose previous one ended at a rail station
  // opens straight on the drop-off list from that station ("Change" leads to the search).
  function openPicker(legIdx) {
    picker = { legIdx, step: 'search', query: '' };
    loadRoutes().then(r => { routes = r; render(); }).catch(e => { if (picker) picker.error = e.message || String(e); render(); });
    const prev = legIdx == null ? editing.form.transit.at(-1) : null;
    const opened = picker;
    loadRailNetwork().then(net => {
      const st = prev && networkStation(net, prev.alight);
      if (st && picker === opened && !picker.query) picker = { ...picker, step: 'to', from: st.id };
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
  const stationLines = (id, exclude = []) => lineTags(railConnections({ id }, railStops, exclude));

  function pickerList() {
    const q = picker.query;
    const heading = text => h('div', { class: 'muted section-head' }, text);
    if (picker.step === 'search') {
      if (!routes) return [h('div', { class: 'muted' }, picker.error ?? 'Loading routes…')];
      const found = searchRoutes(routes, q);
      const routeButton = r => h('button', { type: 'button', class: 'item', onclick: () => chooseRoute(r) }, dot(r.attributes.color), h('b', {}, shortRouteLabel(r)), routeEnds(r) && h('span', { class: 'muted' }, ` ${routeEnds(r)}`));
      const stationButton = st => h('button', { type: 'button', class: 'item station', onclick: () => {
        picker = { ...picker, step: 'to', from: st.id, query: '' };
        render();
      } }, h('b', {}, st.name), ...stationLines(st.id));
      const showAll = h('button', { type: 'button', class: 'add', onclick: () => { picker.allRoutes = true; render(); } }, 'Show all routes');
      if (q.trim()) {
        const stations = railNet ? searchStations(railNet, q).slice(0, 8) : [];
        return [
          stations.length ? heading('Stations') : null, ...stations.map(stationButton),
          stations.length && found.length ? heading('Routes') : null,
          ...found.slice(0, ROUTE_LIMIT).map(routeButton),
          found.length > ROUTE_LIMIT ? h('div', { class: 'muted' }, `${found.length - ROUTE_LIMIT} more; refine the search.`) : null,
        ].filter(Boolean);
      }
      if (!picker.allRoutes) {
        // A next leg: the stations and routes near the previous drop-off (you transfer there).
        if (picker.nearLoading) return [h('div', { class: 'muted' }, 'Finding routes nearby…')];
        if (picker.near) {
          const here = { lat: picker.near.lat, lon: picker.near.lon };
          const stations = (railNet?.stations ?? []).filter(st => st.lat != null && distanceMeters(here, st) <= NEARBY_STATION_METERS);
          const nearRoutes = found.filter(r => picker.near.routeIds.includes(r.id));
          if (stations.length || nearRoutes.length) {
            return [
              h('div', { class: 'muted' }, `Near ${picker.near.name}`),
              stations.length ? heading('Stations') : null, ...stations.map(stationButton),
              nearRoutes.length ? heading('Routes') : null, ...nearRoutes.map(routeButton),
              showAll,
            ].filter(Boolean);
          }
        } else {
          // A first leg: the rail lines; type to find a station or a bus route.
          return [h('div', { class: 'muted' }, 'Type a station (e.g. Oak Grove) or a route (e.g. 132).'),
            ...found.filter(r => r.attributes?.type <= 1).map(routeButton), showAll];
        }
      }
      return [
        ...found.slice(0, ROUTE_LIMIT).map(routeButton),
        found.length > ROUTE_LIMIT ? h('div', { class: 'muted' }, `${found.length - ROUTE_LIMIT} more; refine the search.`) : null,
      ].filter(Boolean);
    }
    if (picker.step === 'to') {
      // Station-first drop-off: stations reachable without a transfer, per line and direction;
      // branch letters only where just some branches stop.
      if (!railNet) return [h('div', { class: 'muted' }, 'Loading stations…')];
      return reachableFrom(railNet, picker.from).flatMap(g => {
        const found = searchStops(g.stations.map(st => ({ ...st, attributes: { name: st.name } })), q);
        if (!found.length) return [];
        const label = id => railNet.lines.find(l => l.id === id)?.label ?? id;
        return [h('div', { class: 'muted section-head' }, dot(g.color), `${g.label} toward ${g.toward.join(' / ')}`),
          ...found.map(st => h('button', { type: 'button', class: 'item', onclick: () => chooseTo(st.id) },
            st.name,
            g.routes.length > 1 && st.routes.length < g.routes.length && h('span', { class: 'muted' }, ` · ${commonLabel(st.routes.map(label))}`),
            ...stationLines(st.id, g.routes)))];
      });
    }
    const docs = bothDocs(picker.route.id);
    if (picker.loading && picker.alight) return [h('div', { class: 'muted' }, 'Checking other routes…')];
    if (picker.loading || !docs[0] || !docs[1]) return [h('div', { class: 'muted' }, picker.error ?? 'Loading stops…')];
    const toward = d => `toward ${destination(picker.route.id, d)}`;
    if (picker.step === 'board') {
      // Stops served both ways first, then each direction's own (the two sides of a street).
      const { both, only } = boardGroups(...docs);
      const pick = s => h('button', { type: 'button', class: 'item', onclick: () => {
        picker = { ...picker, board: s.id, step: 'alight', query: '' };
        render();
      } }, s.attributes?.name ?? s.id);
      const out = searchStops(both, q).map(pick);
      only.forEach((list, d) => {
        const found = searchStops(list, q);
        if (found.length) out.push(heading(toward(d)), ...found.map(pick));
      });
      return out;
    }
    // Drop-off: the stops after the board stop, per direction it serves (one at the end of a
    // line), each with the rail lines there (loaded in the background; none if that fails).
    if (!railStops) loadRailNetwork().then(() => { if (picker?.step === 'alight') render(); }, () => {});
    const connections = s => lineTags(railConnections(s, railStops, [picker.route.id]));
    // A rail route's per-direction stop list merges its branches: keep only the stations the
    // network says are reachable from the board stop on this route (no Ashmont → Quincy).
    const onNetwork = railNet?.lines.some(l => l.id === picker.route.id);
    const reach = d => new Set(reachableFrom(railNet, picker.board).filter(g => g.direction === d)
      .flatMap(g => g.stations.filter(st => st.routes.includes(picker.route.id)).map(st => st.id)));
    return alightGroups(...docs, picker.board).flatMap(g => {
      const ok = onNetwork ? reach(g.direction) : null;
      const found = searchStops(ok ? g.stops.filter(s => ok.has(s.id)) : g.stops, q);
      return found.length ? [heading(toward(g.direction)), ...found.map(s => h('button', { type: 'button', class: 'item', onclick: () => chooseAlight(s.id, g.direction) },
        s.attributes?.name ?? s.id, ...connections(s)))] : [];
    });
  }

  function pickerScreen() {
    const titles = { search: picker.legIdx == null ? 'Add a leg' : 'Change leg', to: 'Where do you get off?', board: 'Where do you board?', alight: 'Where do you get off?', also: 'Also take' };
    const back = () => {
      const prev = { search: null, to: 'search', board: 'search', alight: 'board', also: 'alight' }[picker.step];
      if (prev) { picker = { ...picker, step: prev, query: '' }; } else { picker = null; }
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
      type: 'search', id: 'picker-search', placeholder: picker.step === 'search' ? 'Search stations or routes' : picker.step === 'to' ? 'Search stations' : 'Search stops',
      value: picker.query, oninput: e => { picker.query = e.target.value; list.replaceChildren(...pickerList()); },
    });
    // Header, context and search stay at the top while the list scrolls under them (and iOS's
    // scroll for the keyboard can't slide the search under the header).
    return [h('div', { class: 'picker-top' }, head, context, search), list];
  }

  // The list keeps its scroll position while a trip is open, and a trip keeps its own while a
  // picker is open; opening a trip and each picker step start at the top.
  let shown = null;
  const scrollY = { list: 0, trip: 0 };
  function render() {
    const screen = picker ? `picker:${picker.step}` : editing ? 'trip' : 'list';
    if (screen !== shown && (shown === 'list' || shown === 'trip')) scrollY[shown] = window.scrollY;
    root.replaceChildren(...(picker ? pickerScreen() : editing ? tripScreen() : listScreen()).filter(Boolean));
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
  return { close() { root.hidden = true; root.replaceChildren(); } };
}
