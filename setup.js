// Full-screen setup view: a list of trips, one trip's editor at a time, and route/direction/stop
// pickers. Each trip is saved on its own. Pure helpers live in core.js; this module owns the DOM
// and the setup-time requests.
import {
  validateConfig, checkStops, stopQueries, stopsKey, locateLegs, tripLabel, tripToForm, formToTrip, routeLabel, routeEnds, shortRouteLabel, labelLegs,
  searchRoutes, searchStops, stopsAfter, defaultTransferMinutes, departureCount, stopSlackMinutes, wakeMinutes,
  reverseTrip, nearestStop, windowLabel,
} from './core.js?v=5f6ca8c1d4';

const ROUTE_LIMIT = 60;

// Session caches (kept across openSetup calls; route and stop lists rarely change).
let routesPromise = null;
const stopDocs = new Map(); // stopsKey → /stops doc (trip order, with child_stops)

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
  // { legIdx (null = new leg), step, route, direction, board, near }
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
  const routeTag = l => {
    const r = routeById(l.route);
    return [h('span', { class: 'tag' }, dot(r?.attributes?.color ?? l.color), r ? shortRouteLabel(r) : (l.label ?? l.route))];
  };
  const destination = (routeId, dir) => routeById(routeId)?.attributes?.direction_destinations?.[dir] ?? `direction ${dir}`;

  // Name of a stop id (or of the station a child platform belongs to).
  function stopName(route, dir, id) {
    const doc = stopDocs.get(stopsKey(route, dir));
    const s = doc?.data?.find(x => x.id === id || x.relationships?.child_stops?.data?.some(c => c.id === id));
    return s?.attributes?.name ?? id;
  }

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

  function openPicker(legIdx) {
    picker = { legIdx, step: 'route', query: '' };
    loadRoutes().then(r => { routes = r; render(); }).catch(e => { if (picker) picker.error = e.message || String(e); render(); });
    const prev = legIdx == null ? editing.form.transit.at(-1) : null;
    if (prev) {
      loadNearby(prev).then(near => {
        if (picker && picker.legIdx == null) { picker.near = near; render(); }
      }).catch(() => {});
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

  // After a direction is chosen for a new leg, board at the stop nearest the previous drop-off
  // (skipping to the drop-off step); Back still leads to the full board list.
  async function chooseDirection(direction) {
    picker = { ...picker, direction, step: 'board', query: '', loading: true };
    render();
    try {
      const doc = await loadStops(picker.route.id, direction);
      const near = picker.near && nearestStop(doc.data, picker.near.lat, picker.near.lon);
      if (near && stopsAfter(doc.data, near.id).length) picker = { ...picker, board: near.id, step: 'alight' };
    } catch (e) { picker.error = e.message || String(e); }
    picker.loading = false;
    render();
  }

  function finishLeg(alight) {
    const trip = editing.form;
    const leg = { route: picker.route.id, direction_id: picker.direction, stop: picker.board, alight, transferBefore: 0 };
    if (picker.legIdx == null) {
      const prev = trip.transit[trip.transit.length - 1];
      if (prev) {
        const parents = parentMap(stopDocs.get(stopsKey(prev.route, prev.direction_id)), stopDocs.get(stopsKey(leg.route, leg.direction_id)));
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

  function pickerList() {
    const q = picker.query;
    if (picker.step === 'route') {
      if (!routes) return [h('div', { class: 'muted' }, picker.error ?? 'Loading routes…')];
      const found = searchRoutes(routes, q);
      const routeButton = r => h('button', { type: 'button', class: 'item', onclick: () => {
        picker = { ...picker, route: r, step: 'direction', query: '' };
        render();
      } }, dot(r.attributes.color), h('b', {}, shortRouteLabel(r)), routeEnds(r) && h('span', { class: 'muted' }, ` ${routeEnds(r)}`));
      // Without a search, routes near the previous drop-off come first.
      const nearRoutes = !q.trim() && picker.near ? found.filter(r => picker.near.routeIds.includes(r.id)) : [];
      return [
        nearRoutes.length ? h('div', { class: 'muted' }, `Near ${picker.near.name}`) : null,
        ...nearRoutes.map(routeButton),
        nearRoutes.length ? h('div', { class: 'muted' }, 'All routes') : null,
        ...found.slice(0, ROUTE_LIMIT).map(routeButton),
        found.length > ROUTE_LIMIT ? h('div', { class: 'muted' }, `${found.length - ROUTE_LIMIT} more; refine the search.`) : null,
      ].filter(Boolean);
    }
    const doc = stopDocs.get(stopsKey(picker.route.id, picker.direction));
    if (picker.loading || !doc) return [h('div', { class: 'muted' }, picker.error ?? 'Loading stops…')];
    const stops = picker.step === 'board' ? doc.data : stopsAfter(doc.data, picker.board);
    return searchStops(stops, q).map(s => h('button', { type: 'button', class: 'item', onclick: () => {
      if (picker.step === 'board') { picker = { ...picker, board: s.id, step: 'alight', query: '' }; render(); } else finishLeg(s.id);
    } }, s.attributes?.name ?? s.id));
  }

  function pickerScreen() {
    const titles = { route: 'Choose a route', direction: 'Choose a direction', board: 'Where do you board?', alight: 'Where do you get off?' };
    const back = () => {
      const prev = { route: null, direction: 'route', board: 'direction', alight: 'board' }[picker.step];
      if (prev) { picker = { ...picker, step: prev, query: '' }; } else { picker = null; }
      render();
    };
    const head = h('div', { class: 'setup-head' },
      h('button', { type: 'button', onclick: back }, 'Back'), h('b', {}, titles[picker.step]), h('span'));
    const context = picker.route && h('div', { class: 'muted' },
      [routeLabel(picker.route),
        picker.direction != null && `toward ${destination(picker.route.id, picker.direction)}`,
        picker.board && `from ${stopName(picker.route.id, picker.direction, picker.board)}`].filter(Boolean).join(' · '));
    if (picker.step === 'direction') {
      const dests = picker.route.attributes.direction_destinations ?? [];
      return [head, context, ...[0, 1].map(d => h('button', { type: 'button', class: 'item', onclick: () => chooseDirection(d) },
        `toward ${dests[d] ?? `direction ${d}`}`))];
    }
    const list = h('div', { class: 'list' }, pickerList());
    const search = h('input', {
      type: 'search', id: 'picker-search', placeholder: picker.step === 'route' ? 'Search routes (e.g. 132, Orange)' : 'Search stops',
      value: picker.query, oninput: e => { picker.query = e.target.value; list.replaceChildren(...pickerList()); },
    });
    return [head, context, search, list];
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
    if (picker && picker.step !== 'direction') root.querySelector('#picker-search')?.focus({ preventScroll: true });
  }

  root.hidden = false;
  loadNames();
  render();
  return { close() { root.hidden = true; root.replaceChildren(); } };
}
