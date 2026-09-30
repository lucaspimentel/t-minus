// Full-screen setup view: trips, legs, and route/direction/stop pickers. Replaces the JSON
// editor. Pure helpers live in core.js; this module owns the DOM and the setup-time requests.
import {
  validateConfig, checkStops, stopQueries, stopsKey, tripToForm, formToTrip, routeLabel,
  searchRoutes, searchStops, stopsAfter, defaultTransferMinutes, departureCount, stopSlackMinutes,
  reverseTrip, nearestStop,
} from './core.js?v=6e3b80bb87';

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

const emptyTrip = n => ({ name: n === 0 ? 'My trip' : `Trip ${n + 1}`, window: null, timingLeg: null, walkBefore: 5, walkAfter: 5, transit: [] });
const numberValue = v => (v === '' ? NaN : Number(v));

// Radius for next-leg suggestions, in degrees (~300 m).
const NEARBY_RADIUS = 0.003;

// `timingFor(i)` returns the timing leg the app currently uses for saved trip i (or null).
export function openSetup({ root, config, api, canCancel, onSave, onCancel, timingFor = () => null }) {
  const app = {
    departureCount: config ? departureCount(config) : 4,
    stopSlackMinutes: config ? stopSlackMinutes(config) : 1,
    apiKey: config?.apiKey ?? '',
  };
  // `savedIdx` links a form back to its saved trip (for timingFor) across reordering.
  let trips = config ? config.trips.map((t, i) => ({ ...tripToForm(t), savedIdx: i })) : [emptyTrip(0)];
  let routes = null;
  // { tripIdx, legIdx (null = new leg), step, route, direction, board, near }
  // `near`: { name, lat, lon, routeIds } around the previous leg's drop-off, for suggestions.
  let picker = null;
  let messages = { global: [], byTrip: new Map() };
  let busy = false;

  const loadRoutes = () => (routesPromise ??= api('/routes', {
    'filter[type]': '0,1,3',
    'fields[route]': 'short_name,long_name,type,direction_names,direction_destinations,sort_order',
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

  // Loads names for the legs already in the form (and the route list) in the background.
  function loadNames() {
    loadRoutes().then(r => { routes = r; render(); }).catch(() => {});
    const pairs = new Set(trips.flatMap(t => t.transit.map(l => stopsKey(l.route, l.direction_id))));
    for (const key of pairs) {
      const [route, dir] = key.split('/');
      loadStops(route, Number(dir)).then(render).catch(() => {});
    }
  }

  const routeById = id => routes?.find(r => r.id === id);
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

  function buildConfig() {
    return {
      departureCount: app.departureCount,
      stopSlackMinutes: app.stopSlackMinutes,
      apiKey: app.apiKey.trim(),
      trips: trips.map(formToTrip),
    };
  }

  // Errors prefixed with trips[i] go to that trip's card; the rest to the top.
  function setMessages(list) {
    messages = { global: [], byTrip: new Map() };
    for (const m of list) {
      const match = /^trips\[(\d+)\]/.exec(m);
      if (match) {
        const i = Number(match[1]);
        messages.byTrip.set(i, [...(messages.byTrip.get(i) ?? []), m.replace(/^trips\[\d+\](\.)?\s*/, '')]);
      } else {
        messages.global.push(m);
      }
    }
  }

  async function save() {
    const cfg = buildConfig();
    const errors = validateConfig(cfg);
    if (errors.length) { setMessages(errors); return render(); }
    busy = true;
    setMessages(['Checking stops…']);
    render();
    let warning = null;
    try {
      await Promise.all(stopQueries(cfg).map(q => loadStops(q.route, q.direction_id)));
      const stopErrors = checkStops(cfg, stopDocs);
      if (stopErrors.length) { busy = false; setMessages(stopErrors); return render(); }
    } catch (e) {
      // Wrong stops block the save; an unreachable API does not.
      warning = `Saved, but couldn't verify stops: ${e.message || e}`;
    }
    busy = false;
    onSave(cfg, warning);
  }

  // ---------- main screen ----------

  function numberField(label, value, set, attrs = {}) {
    return h('label', { class: 'field' }, label,
      h('input', { type: 'number', inputmode: 'numeric', min: '0', value: String(value), oninput: e => set(numberValue(e.target.value)), ...attrs }));
  }

  function moveItem(list, i, delta) {
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  }

  function legSummary(l) {
    const label = routeById(l.route) ? routeLabel(routeById(l.route)) : l.route;
    return `${label} toward ${destination(l.route, l.direction_id)} · ${stopName(l.route, l.direction_id, l.stop)} → ${stopName(l.route, l.direction_id, l.alight)}`;
  }

  function tripCard(t, i) {
    const anyTime = !t.window;
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
      if (t.timingLeg === j) t.timingLeg = null; else if (t.timingLeg > j) t.timingLeg--;
      t.transit.splice(j, 1);
      render();
    };
    const legs = t.transit.flatMap((l, j) => [
      j > 0 && numberField('Transfer (min)', l.transferBefore, v => { l.transferBefore = v; }),
      h('div', { class: 'leg-item' },
        h('div', { class: 'leg-text' }, legSummary(l)),
        h('div', { class: 'btns' },
          h('button', { type: 'button', onclick: () => openPicker(i, j) }, 'Edit'),
          h('button', { type: 'button', 'aria-label': 'Move up', onclick: () => moveLeg(j, -1) }, '↑'),
          h('button', { type: 'button', 'aria-label': 'Move down', onclick: () => moveLeg(j, 1) }, '↓'),
          h('button', { type: 'button', 'aria-label': 'Remove leg', onclick: () => removeLeg(j) }, '✕'))),
    ]);
    const label = l => (routeById(l.route) ? routeLabel(routeById(l.route)) : l.route);
    const current = t.savedIdx != null ? timingFor(t.savedIdx) : null;
    const timing = t.transit.length > 1 && h('label', { class: 'field' }, 'Leave-by time is based on',
      h('select', { onchange: e => { t.timingLeg = e.target.value === '' ? null : Number(e.target.value); } },
        h('option', { value: '', selected: t.timingLeg == null },
          `Automatic${current != null && t.transit[current] ? ` (currently ${label(t.transit[current])})` : ''}`),
        ...t.transit.map((l, j) => h('option', { value: String(j), selected: t.timingLeg === j }, `${label(l)} (pinned)`))));
    return h('div', { class: 'card' },
      h('label', { class: 'field' }, 'Trip name',
        h('input', { type: 'text', value: t.name, oninput: e => { t.name = e.target.value; } })),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: anyTime, onchange: e => { t.window = e.target.checked ? null : { from: '06:00', to: '12:00' }; render(); } }),
        'Any time (show only when chosen)'),
      !anyTime && h('div', { class: 'row2' },
        h('label', { class: 'field' }, 'Shown from', timeInput('from')),
        h('label', { class: 'field' }, 'until', timeInput('to'))),
      numberField('Walk to first stop (min)', t.walkBefore, v => { t.walkBefore = v; }),
      ...legs,
      h('button', { type: 'button', class: 'add', onclick: () => openPicker(i, null) }, '+ Add transit leg'),
      numberField('Walk from last stop (min)', t.walkAfter, v => { t.walkAfter = v; }),
      timing,
      ...(messages.byTrip.get(i) ?? []).map(m => h('div', { class: 'msg err' }, m)),
      h('div', { class: 'btns trip-btns' },
        h('button', { type: 'button', onclick: () => { moveItem(trips, i, -1); render(); } }, '↑ Move up'),
        h('button', { type: 'button', onclick: () => { moveItem(trips, i, 1); render(); } }, '↓ Move down'),
        t.transit.length > 0 && h('button', { type: 'button', onclick: () => addReturnTrip(i) }, 'Add return trip'),
        h('button', { type: 'button', class: 'danger', onclick: () => {
          if (confirm(`Delete "${t.name}"?`)) { trips.splice(i, 1); render(); }
        } }, 'Delete trip')));
  }

  // Inserts the reversed trip below the original for review. A reversed bus stop is usually
  // not served in the other direction (the stop across the street is), so each stop missing
  // from the new direction's list is replaced by that list's nearest stop.
  async function addReturnTrip(i) {
    const back = tripToForm(reverseTrip(formToTrip(trips[i])));
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
    trips.splice(i + 1, 0, back);
    setMessages([`Return trip added below "${trips[i].name}".` +
      (replaced.length ? ` Matched stops across the street: ${replaced.join('; ')}.` : '') + ' Review it, then Save.']);
    loadNames();
    render();
  }

  let ioArea = null; // { mode: 'export' | 'import', text }

  async function exportConfig() {
    const text = JSON.stringify(buildConfig(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      ioArea = { mode: 'export', text, note: 'Copied to the clipboard.' };
    } catch {
      ioArea = { mode: 'export', text, note: 'Copy the JSON below.' };
    }
    render();
  }

  function importConfig(text) {
    let cfg;
    try { cfg = JSON.parse(text); } catch (e) { setMessages([`Invalid JSON: ${e.message}`]); return render(); }
    const errors = validateConfig(cfg);
    if (errors.length) { setMessages(errors); return render(); }
    app.departureCount = departureCount(cfg);
    app.stopSlackMinutes = stopSlackMinutes(cfg);
    if (cfg.apiKey) app.apiKey = cfg.apiKey;
    trips = cfg.trips.map(tripToForm);
    ioArea = null;
    setMessages(['Imported. Review, then Save.']);
    loadNames();
    render();
  }

  function mainScreen() {
    return [
      h('div', { class: 'setup-head' },
        canCancel ? h('button', { type: 'button', onclick: onCancel }, 'Cancel') : h('span'),
        h('b', {}, 'Setup'),
        h('button', { type: 'button', class: 'primary', id: 'setup-save', disabled: busy, onclick: save }, 'Save')),
      ...messages.global.map(m => h('div', { class: /…$|^Imported|^Return trip added/.test(m) ? 'msg' : 'msg err' }, m)),
      h('div', { class: 'card' },
        numberField('Departures shown (1-8)', app.departureCount, v => { app.departureCount = v; }, { min: '1', max: '8' }),
        numberField('Minutes early at the stop', app.stopSlackMinutes, v => { app.stopSlackMinutes = v; }),
        h('label', { class: 'field' }, 'MBTA API key (optional)',
          h('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: 'Keyless: 20 requests/min', value: app.apiKey, oninput: e => { app.apiKey = e.target.value; } }))),
      ...trips.map(tripCard),
      h('button', { type: 'button', class: 'add', onclick: () => { trips.push(emptyTrip(trips.length)); render(); } }, '+ Add trip'),
      h('div', { class: 'btns io' },
        h('button', { type: 'button', onclick: exportConfig }, 'Export'),
        h('button', { type: 'button', onclick: () => { ioArea = { mode: 'import', text: '' }; render(); } }, 'Import')),
      ioArea && h('div', { class: 'card' },
        ioArea.note && h('div', { class: 'msg' }, ioArea.note),
        h('textarea', { id: 'setup-io', readOnly: ioArea.mode === 'export', value: ioArea.text, placeholder: 'Paste a trips config (JSON)', oninput: e => { ioArea.text = e.target.value; } }),
        ioArea.mode === 'import' && h('button', { type: 'button', onclick: () => importConfig(ioArea.text) }, 'Load')),
    ];
  }

  // ---------- picker ----------

  function openPicker(tripIdx, legIdx) {
    picker = { tripIdx, legIdx, step: 'route', query: '' };
    loadRoutes().then(r => { routes = r; render(); }).catch(e => { if (picker) picker.error = e.message || String(e); render(); });
    const prev = legIdx == null ? trips[tripIdx].transit.at(-1) : null;
    if (prev) {
      loadNearby(prev).then(near => {
        if (picker?.tripIdx === tripIdx && picker.legIdx == null) { picker.near = near; render(); }
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
    const trip = trips[picker.tripIdx];
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
      } }, h('b', {}, routeLabel(r)), r.attributes.type === 3 ? h('span', { class: 'muted' }, ` ${r.attributes.long_name}`) : null);
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

  function render() {
    root.replaceChildren(...(picker ? pickerScreen() : mainScreen()).filter(Boolean));
    if (picker && picker.step !== 'direction') root.querySelector('#picker-search')?.focus({ preventScroll: true });
  }

  root.hidden = false;
  loadNames();
  render();
  return { close() { root.hidden = true; root.replaceChildren(); } };
}
