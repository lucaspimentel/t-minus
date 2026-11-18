// DOM rendering shared by the app (index.html) and the share page (share.js): the timeline, the
// route map widget and the base map. No app state: callers pass in what varies.
import {
  DOUBLE_TAP_MS, FOLLOW_SPANS, PIN_LABEL_X, TAP_SLOP_PX, TAP_ZOOM, areaRect, basemapLayers, basemapNames, doubleTap, easeView, fitChoice, fitTap, flagStop, formatTime, legTime, mapPoint, nextFollowLevel, panView, projector, rideLine, routeMapModel, sameView, shownStops, sourceText, stopsToShow, toward, twoFingerTap, vehicleShown, viewAt, viewLimits, wheelZoom, wholeView, zoomView, zoomedOut,
} from './core.js?v=2a3f98cd33';

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// LIVE / SCHEDULED, or "every 6 min" (styled as scheduled) on a subway leg with no predictions.
export function badge(leg) {
  return el('span', `badge ${leg.source}`, sourceText(leg));
}


export const BELL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

// A walking figure on the timeline rail for steps that involve walking (Material
// "directions_walk", Apache 2.0).
export const SHARE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 9H6.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2"/><path d="M12 14V3M8.5 6.5L12 3l3.5 3.5"/></svg>';
export const WALK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7"/></svg>';
export function walkStep(line, step) {
  if (!step.walking) return line;
  const icon = el('span', 'walk-icon');
  icon.innerHTML = WALK_SVG;
  line.prepend(icon);
  return line;
}

// The timeline: each stop once and "Arrive" at the end ("Leave" first only in setup's auto-route
// options: a row's header has its leave-by, 2026-11-17), as nodes with their times; each ride as a
// bar in its route's color from its first stop to its last, with "Bus 132 · 9 min" and "toward
// Malden LIVE" between them; walks and transfers on the dotted rail. Names not known yet show "—". Long names are cut; tapping a stop
// shows it in full (kept per `key` across re-renders) without collapsing the row.
// `phase` (ride card): what's done is dimmed, the current step is bold. `along` (ride card): rows
// placed on the ridden leg's bar, before its drop-off ({ leg, rows, boarding }; `boarding`: the vehicle
// hasn't left the boarding stop, its dot is on that stop's node).
export const fullStops = new Set();
export function renderTimeline(steps, now, { phase = null, key = '', along = null } = {}) {
  const timeline = el('div', 'timeline');
  const n = steps.filter(s => s.kind === 'leg').length;
  const p = phase ? phase.leg : -1; // index of the leg being ridden, or the one after the transfer
  const kind = phase?.kind;
  // Walk step before leg `i` (i === n: the last walk).
  const walkState = i => !phase ? ''
    : kind === 'riding' ? (i <= p ? ' done' : '')
      : kind === 'transfer' ? (i < p ? ' done' : i === p ? ' current' : '')
        : i < n ? ' done' : ' current';
  // Leg `i`'s parts: its boarding stop, ride line, and drop-off stop.
  const legState = (i, part) => {
    if (!phase || i > p) return '';
    if (kind !== 'riding' && kind !== 'transfer') return ' done';
    if (i < p) return ' done';
    if (kind === 'riding') return part === 'from' ? ' done' : ' current';
    return part === 'from' ? ' current' : '';
  };
  // `veh`: the vehicle's dot on the node (the boarding stop, before the vehicle leaves it).
  const stopLine = (name, time, id, cls, leg, at, veh = false) => {
    const line = el('div', `step stop${cls}${fullStops.has(id) ? ' full' : ''}`);
    const n = el('span', 'n', name ?? '—');
    // "Malden Center · Flag stop": tell the crew to stop there.
    if (name && flagStop(leg, at)) n.append(' · ', el('span', 'flag', flagStop(leg, at)));
    line.append(el('span', veh ? 'veh' : 'node'), n, el('span', 't', time == null ? '' : legTime(leg, time, now)));
    if (name) {
      line.onclick = e => {
        e.stopPropagation();
        if (fullStops.has(id)) fullStops.delete(id); else fullStops.add(id);
        line.classList.toggle('full');
      };
    }
    return line;
  };
  let i = 0;
  for (const s of steps) {
    if (s.kind === 'end') {
      // "Arrive 11:16pm" (an option's "Leave 10:30pm"): a gray node with the time in the stops' column.
      const line = el('div', `step end${walkState(i)}`);
      line.append(el('span', 'node end-node'), el('span', 'n', s.label), el('span', 't', s.time == null ? '' : `${s.approx ? '~' : ''}${formatTime(s.time, now)}`));
      timeline.append(line);
      continue;
    }
    if (s.kind === 'walk') {
      timeline.append(walkStep(el('div', `step walk${walkState(i)}`, s.text), s));
      continue;
    }
    const leg = el('div', 'tl-leg');
    leg.style.setProperty('--c', s.leg.color ? `#${s.leg.color}` : 'var(--muted)');
    // "Orange Line · 13 stops · 15 min" (stops when known), then "toward Forest Hills LIVE" (the
    // trip's headsign and the badge, 2026-11-17) below; no headsign on the leg being ridden
    // (2026-11-06: it matters only before boarding; the leg's last row names the drop-off), the
    // badge then on the ride line. Untimed (an auto-route option in setup): no minutes.
    const ride = el('div', `step ride${legState(i, 'ride')}`, rideLine(s));
    const towardLine = s.leg.headsign && !(kind === 'riding' && i === p) ? el('div', 'toward', toward(s.leg)) : null;
    if (s.leg.source) (towardLine ?? ride).append(badge(s.leg));
    if (towardLine) ride.append(towardLine);
    // Commuter rail: "Train 2317 · Track 5", and the train's own alerts.
    const train = [s.leg.train && `Train ${s.leg.train}`, s.leg.track && `Track ${s.leg.track}`].filter(Boolean).join(' · ');
    if (train) ride.append(el('div', 'train', train));
    for (const a of s.leg.alerts ?? []) ride.append(el('div', 'leg-alert', a));
    leg.append(stopLine(s.from, s.leg.dep, `${key}/${i}/from`, legState(i, 'from'), s.leg, 'board', along?.leg === i && along.boarding), ride,
      ...(along?.leg === i ? along.rows : []), stopLine(s.to, s.leg.arr, `${key}/${i}/to`, legState(i, 'to'), s.leg, 'alight'));
    timeline.append(leg);
    i++;
  }
  return timeline;
}


// The ridden leg's rows on its timeline bar, before the drop-off: the vehicle ("At <stop>" while
// stopped at one, else a marker just above the next stop; none at the drop-off, nor before it leaves
// the boarding stop), then the stops
// left (shownStops: next 2, "… N more", the stop before the drop-off; "… N more" expands).
export function rideStopRows(stops, tripId, now, { open = false, onToggle = () => {} } = {}) {
  const mid = (cls, ...kids) => {
    const d = el('div', `step mid${cls}`);
    d.append(...kids);
    return d;
  };
  const rows = [];
  const v = stops.vehicle;
  // Not on the bar at the drop-off, nor before leaving the boarding stop (its dot is on that stop's node).
  const onBar = !v?.atDropOff && !v?.boarding;
  if (onBar && v?.status === 'STOPPED_AT') rows.push(mid(' here', el('span', 'veh'), el('span', 'n', `At ${v.name}`)));
  else if (onBar) rows.push(mid(' gap', el('span', 'veh')));
  const toggle = (text, value) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.dataset.focus = 'ride:more';
    b.onclick = e => { e.stopPropagation(); onToggle(value); };
    return mid(' more', b);
  };
  for (const st of shownStops(stops.stops, open)) {
    if (st.more) { rows.push(toggle(`… ${st.more} more`, tripId)); continue; }
    if (st.dropOff) continue; // the timeline's drop-off row
    rows.push(mid('', el('span', 'mid-dot'), el('span', 'n', st.name), el('span', 't', formatTime(st.time, now))));
  }
  if (open && shownStops(stops.stops).length < stops.stops.length) rows.push(toggle('Show fewer', null));
  return rows;
}


export const SVG_NS = 'http://www.w3.org/2000/svg';
export const svgEl = (tag, attrs = {}, text = null) => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};

// Readable text on a route color (dark on the 132's yellow, white on the Orange Line's orange).
export function textOn(hex) {
  const n = parseInt(hex ?? '6b7078', 16);
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#1c1f24' : '#ffffff';
}
export const mapColor = c => (c ? `#${c}` : 'var(--muted)');

// The base map (basemap.json, scripts/build-basemap.mjs): land, green areas, water, borders, names
// and faint lines behind every map. Fetched the first time a map opens (a plain same-origin GET, nothing
// about the rider); a failure leaves the maps without it until the next opening. Its paths are
// projected once per map origin (basemapLayers), not on every redraw.
export let basemap = null;
export let basemapLoad = null;
export const basemapWidgets = new Set(); // maps to redraw when it arrives
export const basemapCache = new Map(); // origin → basemapLayers (the last 8)
export function loadBasemap() {
  if (basemap || basemapLoad) return;
  basemapLoad = fetch('basemap.json').then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(doc => {
    if (doc?.v !== 1) return;
    basemap = doc;
    for (const w of basemapWidgets) { if (w.svg.isConnected) (w.onBasemap ?? w.redraw)?.(); else basemapWidgets.delete(w); }
  }).catch(() => {}).finally(() => { basemapLoad = null; });
}
export function basemapFor(origin) {
  const k = `${origin.lat},${origin.lon}`;
  if (!basemapCache.has(k)) {
    basemapCache.set(k, basemapLayers(basemap, origin));
    if (basemapCache.size > 8) basemapCache.delete(basemapCache.keys().next().value);
  }
  return basemapCache.get(k);
}
// The base map's SVG group for a map (each map owns its own: a node is in one SVG only), with
// its names as marks (sized in px, shown by basemapNames).
export function basemapGroup(layers) {
  const g = svgEl('g', { class: 'map-base', 'aria-hidden': 'true' });
  const path = (d, cls, attrs = {}) => d && g.append(svgEl('path', { d, class: cls, ...attrs }));
  g.append(svgEl('rect', { class: 'map-water', x: layers.water.x, y: layers.water.y, width: layers.water.w, height: layers.water.h }));
  path(layers.coarse, 'map-land');
  path(layers.land, 'map-land');
  path(layers.green, 'map-green');
  path(layers.lakes, 'map-lake');
  path(layers.rivers, 'map-river');
  path(layers.towns, 'map-town-line');
  path(layers.hoods, 'map-hood-line');
  for (const l of layers.lines) path(l.d, `map-faint ${l.kind}`, { stroke: mapColor(l.color) });
  const marks = layers.names.map(n => {
    const m = svgEl('g');
    m.dataset.x = n.x; m.dataset.y = n.y;
    m.append(svgEl('text', { class: `map-name ${n.kind}`, y: 4 }, n.name));
    g.append(m);
    return m;
  });
  return { g, names: layers.names, marks };
}

// A corner button's 24 px line icon, and a corner button (its clicks don't reach the map).
export const toolIcon = (...parts) => { const i = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }); i.append(...parts); return i; };
export function mapToolButton(cls, label, focus, icon, onClick) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: `map-tool ${cls}` });
  b.setAttribute('aria-label', label);
  b.dataset.focus = focus;
  b.append(icon);
  b.addEventListener('click', e => { e.stopPropagation(); onClick(e); });
  return b;
}

// A map widget: `el` (a div with the SVG and, when interactive, a caption) and draw(input, here)
// (input: routeMapModel's, without `aspect`; here: the phone's { lat, lon } or null). Interactive:
// pinch / drag / wheel to zoom and pan, stops as buttons whose names show in the caption.
// `pan` (the main screen's map, 2026-11-13; on with `interactive`): the same drag and pinch, the
// wheel only with ctrl, and a tap on a stop labels it on the map (pointer only: no stop buttons,
// caption or whole map). Both: a double-tap zooms in, a two-finger tap out (2026-11-13).
// The view the rider zoomed to is kept across redraws; marks keep their size in pixels.
// `live` (the main screen's map and the sheet, 2026-11-12): refits at a fit are eased.
export function mapWidget({ label, interactive = false, pan = interactive, focusKey = 'map', caption = null, locate = false, live = false }) {
  const svg = svgEl('svg', { class: `route-svg${pan ? '' : ' still'}`, role: interactive ? 'group' : 'img', 'aria-label': label });
  const el = document.createElement('div');
  el.className = 'route-map';
  el.append(svg);
  const cap = caption ?? (interactive ? Object.assign(document.createElement('p'), { className: 'map-caption' }) : null);
  if (cap && !caption) { cap.setAttribute('aria-live', 'polite'); el.append(cap); }
  const w = { el, svg, model: null, view: null, touched: false, selected: null, marks: [], stopMarks: [], vehicleMarks: [], note: '', base: null, out: false,
    following: false, level: null, followSpan: null, followAt: null, // locate's follow (2026-11-10)
    // The two fits (2026-11-12): `fits` { trip, me }, the chosen `mode` ('first' | 'trip' | 'me';
    // `fit` is its view), a view state to restore on the next draw (`pending`, from the other
    // map: w.restore), the ride's phase drawn last (`finished`: a change resets the view).
    fits: null, mode: 'first', pending: null, finished: null };
  Object.defineProperty(w, 'fit', { get: () => (w.fits ? w.fits[fitChoice(w.fits, w.mode)] : null) });
  basemapWidgets.add(w);
  loadBasemap();
  const size = () => ({ width: svg.clientWidth || 340, height: svg.clientHeight || 200 });
  const mpp = () => (w.view ? w.view.w / size().width : 1); // meters per pixel
  let fitBtn = null, wholeBtn = null, limitsOf = null;
  // The mode the fit button's next tap goes to; null: nothing to switch to.
  const nextFit = () => (w.fits ? fitTap({ fits: w.fits, mode: w.mode, moved: w.touched }) : null);
  function apply() {
    // The fit button (2026-11-12): hidden with nothing to switch to; its label and icon name the next tap.
    if (fitBtn) {
      const next = nextFit();
      fitBtn.hidden = !next;
      const kind = next ? fitChoice(w.fits, next) : 'trip';
      if (fitBtn.dataset.kind !== kind) {
        fitBtn.dataset.kind = kind;
        fitBtn.setAttribute('aria-label', kind === 'me' ? 'Show the trip and my location' : 'Show the whole trip');
        fitBtn.replaceChildren(fitIcon(kind));
      }
    }
    if (wholeBtn) {
      const lim = w.fit && limitsOf ? limitsOf() : null;
      wholeBtn.hidden = !lim?.edges || (!!w.view && Math.abs(w.view.w - lim.maxSpan) / lim.maxSpan < 0.01);
    }
    if (!w.view) return;
    svg.setAttribute('viewBox', `${w.view.x} ${w.view.y} ${w.view.w} ${w.view.h}`);
    const s = mpp();
    for (const m of w.marks) m.setAttribute('transform', `translate(${m.dataset.x} ${m.dataset.y}) scale(${s})`);
    // Intermediate stops only with room between them (a zoomed-out bus leg isn't a row of dots).
    if (w.model) {
      const shown = stopsToShow(w.model.stops, 1 / s, { keep: w.selected });
      w.stopMarks.forEach((m, i) => { if (shown.has(i)) m.removeAttribute('display'); else m.setAttribute('display', 'none'); });
    }
    // Zoomed out: your ride's vehicle only; zooming back in polls at once (`w.onZoomIn`).
    const out = zoomedOut(w.view, w.fit);
    for (const { g, v } of w.vehicleMarks) { if (vehicleShown(v, out)) g.removeAttribute('display'); else g.setAttribute('display', 'none'); }
    if (w.out && !out) setTimeout(() => w.onZoomIn?.());
    w.out = out;
    w.updateLocate?.();
    if (w.base) {
      const shown = basemapNames(w.base.names, w.view, size());
      w.base.marks.forEach((m, i) => {
        if (shown.has(i)) { m.removeAttribute('display'); m.setAttribute('transform', `translate(${m.dataset.x} ${m.dataset.y}) scale(${s})`); }
        else m.setAttribute('display', 'none');
      });
    }
  }
  function showCaption() {
    if (!cap) return;
    const st = w.model?.stops.find(x => x.id === w.selected);
    cap.textContent = st?.name ?? w.note;
  }
  function select(id) {
    w.selected = w.selected === id ? null : id;
    w.redraw?.();
  }
  // Moves the view to `to`, eased over FIT_MS (a jump with Reduce Motion). A pan, pinch or
  // another move takes over (fitAnim).
  const FIT_MS = 250;
  let fitAnim = 0;
  let animGoal = null; // the view an ease is heading to (follow and refits compare against it)
  const animateTo = to => {
    const id = ++fitAnim;
    if (!w.view || matchMedia('(prefers-reduced-motion: reduce)').matches) { animGoal = null; w.view = to; apply(); return; }
    const from = w.view, t0 = performance.now();
    animGoal = to;
    const step = now => {
      if (id !== fitAnim) return;
      const t = (now - t0) / FIT_MS;
      if (t >= 1) { animGoal = null; w.view = to; apply(); return; }
      w.view = easeView(from, to, t);
      apply();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  // Off the fits (a pan, pinch, wheel, locate, the whole map): the next fit tap goes to the first view.
  const markMoved = () => { w.touched = true; w.mode = 'first'; };
  // The view's state for the other map (2026-11-12): the fit mode, follow, or a moved view (its
  // center as a position, the two maps' origins can differ; meters per pixel).
  w.viewState = () => {
    const o = w.model?.origin, v = animGoal ?? w.view;
    const moved = w.touched && !w.following && v && o;
    return {
      mode: w.mode,
      follow: w.following ? { level: w.level, span: w.followSpan } : null,
      moved: moved ? { center: projector(o.lat, o.lon).toLatLon({ x: v.x + v.w / 2, y: v.y + v.h / 2 }), mpp: v.w / size().width } : null,
    };
  };
  w.restore = state => { w.pending = state; };
  // A ride phase change: the first view, follow off.
  const reset = () => { w.stopFollow?.(); w.mode = 'first'; w.touched = false; w.pending = null; };
  // A restored state at this map's size: fits and follow recomputed, a moved view at its center
  // and scale within this map's limits.
  function restoreNow(st, p, width, height) {
    if (w.following && !st.follow) w.stopFollow?.();
    const lim = limitsOf?.() ?? null;
    if (st.follow && w.startFollow) {
      markMoved();
      Object.assign(w, { following: true, level: st.follow.level, followSpan: st.follow.span });
      if (p) { w.followAt = p; w.view = viewAt(p, w.followSpan, width / height, lim); } else w.view = w.fit;
      w.updateLocate();
    } else if (st.moved && w.model.origin) {
      markMoved();
      w.view = viewAt(mapPoint(w.model, st.moved.center), st.moved.mpp * width, width / height, lim);
    } else {
      Object.assign(w, { mode: st.mode ?? 'first', touched: false });
      w.view = w.fit;
    }
  }
  // `jump`: a size change, no ease.
  w.draw = (input, here = null, note = '', { jump = false } = {}) => {
    w.redraw = opts => w.draw(input, here, note, opts);
    // A ride phase change: the first view, follow off (2026-11-12).
    if (w.finished != null && input.finished !== w.finished) reset();
    w.finished = input.finished;
    const { width, height } = size();
    const model = routeMapModel({ ...input, aspect: width / height, width });
    const focused = svg.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    w.model = model;
    w.note = note;
    w.fits = model.fits;
    const p = mapPoint(model, here);
    if (w.pending) {
      const st = w.pending;
      w.pending = null;
      restoreNow(st, p, width, height);
    } else if (!w.touched || !w.view) {
      // At a fit, it follows the changes (2026-11-12): eased on the live maps; the first drawing
      // and a size change jump.
      if (!w.view || jump || !live) w.view = w.fit;
      else if (!sameView(animGoal ?? w.view, w.fit, width)) animateTo(w.fit);
    }
    const mark = (x, y, cls) => { const g = svgEl('g', { class: cls }); g.dataset.x = x; g.dataset.y = y; w.marks.push(g); return g; };
    w.marks = [];
    w.stopMarks = [];
    const parts = [];
    for (const wk of model.walks) parts.push(svgEl('line', { class: 'map-walk', x1: wk.from.x, y1: wk.from.y, x2: wk.to.x, y2: wk.to.y, 'data-kind': wk.kind }));
    for (const l of model.legs) parts.push(svgEl('polyline', { class: `map-leg${l.faded ? ' faded' : ''}${l.off ? ' off' : ''}`, stroke: mapColor(l.color), 'data-color': l.color ?? '', points: l.path.map(p => `${p.x},${p.y}`).join(' ') }));
    for (const st of model.stops) {
      const g = mark(st.x, st.y, `map-stop${st.major ? ' major' : ''}${st.off ? ' off' : ''}`);
      w.stopMarks.push(g);
      g.append(svgEl('circle', { r: st.major ? 6 : 3.5, stroke: mapColor(st.color) }));
      if (st.label || w.selected === st.id) g.append(svgEl('text', { x: 10, y: 4, class: 'map-label' }, st.name));
      if (pan) {
        g.append(svgEl('circle', { r: 14, class: 'map-hit' }));
        g.dataset.stop = st.id;
        if (interactive) { // the sheet's stops are buttons
          g.dataset.focus = `${focusKey}:stop:${st.id}`;
          g.setAttribute('role', 'button');
          g.setAttribute('tabindex', '0');
          g.setAttribute('aria-label', st.name);
          g.setAttribute('aria-pressed', String(w.selected === st.id));
        }
      }
      parts.push(g);
    }
    // The start and end pins (2026-11-09): decorative, above the stops and below the vehicles.
    for (const pl of model.places) {
      const g = mark(pl.x, pl.y, `map-pin ${pl.kind}${pl.faded ? ' faded' : ''}${pl.onStop ? ' on-stop' : ''}`);
      g.setAttribute('aria-hidden', 'true');
      g.append(svgEl('path', { d: 'M0 0C-2 -6 -8 -10 -8 -16A8 8 0 1 1 8 -16C8 -10 2 -6 0 0Z' }), svgEl('circle', { cy: -16, r: 3, class: 'hole' }));
      if (pl.label) g.append(svgEl('text', { x: pl.side === 'left' ? -PIN_LABEL_X : PIN_LABEL_X, y: -12, 'text-anchor': pl.side === 'left' ? 'end' : null, class: 'map-label' }, pl.label));
      parts.push(g);
    }
    w.vehicleMarks = [];
    for (const v of model.vehicles) {
      const g = mark(v.x, v.y, `map-vehicle${v.mine ? ' mine' : ''}${v.gps ? ' gps' : ''}`);
      // A circle with a point at `heading` (the travel direction); the label stays upright.
      const r = Math.max(11, v.label.length * 3 + 3) * (v.mine ? 1.25 : 1), tip = r + 7;
      const pin = svgEl('path', { d: `M${tip} 0L${r * 0.5} ${-r * 0.866}A${r} ${r} 0 1 0 ${r * 0.5} ${r * 0.866}Z`, fill: mapColor(v.color), transform: `rotate(${v.heading ?? 0})` });
      // At your GPS position (2026-11-12): a blue ring and halo, like the location dot it replaces.
      if (v.gps) g.append(svgEl('circle', { r: r + 9, class: 'halo' }));
      g.append(pin, svgEl('text', { y: v.mine ? 4 : 3.2, 'text-anchor': 'middle', fill: textOn(v.color) }, v.label));
      Object.assign(g.dataset, { vehicle: v.id, heading: Math.round(v.heading ?? 0) });
      w.vehicleMarks.push({ g, v });
      parts.push(g);
    }
    if (p && !model.ride?.gps) { const g = mark(p.x, p.y, 'map-here'); g.append(svgEl('circle', { r: 14, class: 'halo' }), svgEl('circle', { r: 6, class: 'dot' })); parts.push(g); }
    // The base map beneath, built once per origin (a vehicle or location redraw reuses it).
    const baseKey = model.origin && basemap ? `${model.origin.lat},${model.origin.lon}` : null;
    if (w.base?.key !== baseKey) {
      const layers = baseKey && basemapFor(model.origin);
      w.base = layers ? { key: baseKey, ...basemapGroup(layers) } : null;
    }
    svg.replaceChildren(...(w.base ? [w.base.g] : []), ...parts);
    apply();
    // Following (2026-11-10): each new position recenters; none (lost, outside) leaves the map still.
    if (w.following && p) { w.followAt = p; w.followTo?.(p); }
    showCaption();
    if (focused) svg.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  };
  new ResizeObserver(() => { if (!w.touched && w.redraw) w.redraw({ jump: true }); else apply(); }).observe(svg);
  // Inside an option card: a tap on the map doesn't toggle the card (a picture too).
  el.addEventListener('click', e => e.stopPropagation());
  const pointers = new Map(); // the sheet's fingers on the map (a gesture holds off follow's recenter)
  if (!pan && !locate) return w;

  // Pan and zoom limits once the base map is in: the view's edges within commuter rail's farthest
  // stations (the base map's `reach`, 2 km more) and the trip, out until all of it shows
  // (2026-11-09; until then the center, 5 km more).
  const limits = limitsOf = () => {
    const o = w.model?.origin;
    const area = basemap && o ? areaRect(basemap.reach, projector(o.lat, o.lon)) : null;
    const { width, height } = size();
    return viewLimits(w.fit, { area, aspect: width / height });
  };
  const tools = Object.assign(document.createElement('div'), { className: 'map-tools' });
  // Locate (2026-11-09; `w.onLocate`, the caller's: the location, then w.startFollow). From
  // 2026-11-10 it follows you: a first tap zooms to the street, later ones switch street / area.
  let followTo = null;
  if (locate) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'map-tool map-locate' });
    b.setAttribute('aria-label', 'Center on my location');
    b.setAttribute('aria-pressed', 'false');
    b.dataset.focus = `${focusKey}:locate`; // the main list's redraw keeps its focus
    const icon = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    icon.append(svgEl('path', { d: 'M3 11 21 3l-8 18-2-8z' }));
    b.append(icon);
    const nextLevel = () => nextFollowLevel({ following: w.following, level: w.level, width: w.view?.w ?? 0 });
    // The label names what a tap does next.
    w.updateLocate = () => {
      const label = b.disabled ? 'Center on my location (outside the map)'
        : !w.following ? 'Center on my location'
        : nextLevel() === 'area' ? 'Zoom out to the area' : 'Zoom in to the street';
      if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', String(w.following));
    };
    b.addEventListener('click', e => {
      e.stopPropagation();
      if (w.following && w.followAt) {
        w.level = nextLevel();
        w.followSpan = FOLLOW_SPANS[w.level];
        followTo(w.followAt, true);
        w.updateLocate();
      } else w.onLocate?.();
    });
    tools.append(b);
    // Off while your known position is outside the base map's bound (2026-11-09); it ends follow.
    w.setLocateOutside = out => {
      if (b.disabled === out) return;
      b.disabled = out;
      if (out) w.stopFollow();
      w.updateLocate();
    };
    // The first position after a tap: follow on, at street level.
    w.startFollow = here => {
      const p = mapPoint(w.model, here);
      if (!p || !w.fit) return;
      Object.assign(w, { following: true, level: 'street', followSpan: FOLLOW_SPANS.street, followAt: p });
      markMoved(); // the fit button shows; a redraw keeps the view
      followTo(p, true);
      w.updateLocate();
    };
    // A drag, back to the trip, the whole map, or leaving the bound: the view stays where it is.
    w.stopFollow = () => {
      Object.assign(w, { following: false, level: null, followSpan: null });
      w.updateLocate();
    };
    // You at the follow span, eased; skipped during a gesture or when it would move under 2 px.
    followTo = w.followTo = (p, force = false) => {
      if (!w.following || !w.view) return;
      const { width, height } = size();
      const to = viewAt(p, w.followSpan, width / height, limits());
      if (!force) {
        if (pointers.size) return;
        if (sameView(animGoal ?? w.view, to, width)) return;
      }
      animateTo(to);
    };
  }
  // Back to the trip (⤢ until 2026-11-09): a route inside frame corners.
  // Trip + me (2026-11-12): the same with a filled dot, you, in the top-left corner.
  const fitIcon = kind => toolIcon(svgEl('path', { d: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4' }), svgEl('circle', { cx: 9, cy: 15, r: 1.6 }), svgEl('circle', { cx: 15, cy: 9, r: 1.6 }), svgEl('path', { d: 'M10.2 13.8 13.8 10.2' }),
    ...(kind === 'me' ? [svgEl('circle', { cx: 8.6, cy: 8.6, r: 2.2, fill: 'currentColor', stroke: 'none' })] : []));
  fitBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'map-tool map-fit', hidden: true });
  fitBtn.dataset.focus = `${focusKey}:fit`;
  // From a moved view, the first view; at a fit, the other one (2026-11-12).
  fitBtn.addEventListener('click', e => {
    e.stopPropagation();
    const next = nextFit();
    if (!next || !w.view) return;
    w.stopFollow?.();
    Object.assign(w, { mode: next, touched: false });
    animateTo(w.fit);
    apply(); // the button's label now, not after the ease
  });
  tools.append(fitBtn);
  // The whole map (the sheet, 2026-11-09): fully zoomed out over the bound; hidden until the base
  // map is in and while already all the way out (apply).
  if (interactive) {
    wholeBtn = mapToolButton('map-whole', 'Show the whole map', `${focusKey}:whole`, toolIcon(svgEl('path', { d: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z M9 4v14 M15 6v14' })), () => {
      const lim = w.fit && limits();
      if (!lim?.edges || !w.view) return;
      w.stopFollow?.();
      const { width, height } = size();
      markMoved();
      animateTo(wholeView(lim, width / height));
    });
    wholeBtn.hidden = true;
    tools.append(wholeBtn);
  }
  el.append(tools);
  if (!pan) return w;

  // Taps and keys on stops; drags and pinches move the view. While following (2026-11-10), a drag
  // ends it; a pinch, the wheel, a double-tap or a two-finger tap keeps it, zooming about you, at
  // the new span. A single tap waits DOUBLE_TAP_MS for a second one (2026-11-13).
  // A gesture: px moved, a drag, a pinch, the most fingers down, when the first went down, the
  // first two's midpoint (a two-finger tap).
  let moved = 0, dragged = false, pinched = false, maxPointers = 0, downAt = 0, downMid = null;
  let lastTap = null, tapTimer = 0;
  const stopFit = () => { fitAnim++; animGoal = null; };
  // `from` zoomed by `factor` about `at`, or you while following (which goes on at the new span).
  const zoomFollow = (from, factor, at) => {
    const c = w.following && w.followAt ? w.followAt : at;
    const to = zoomView(from, factor, c.x, c.y, limits());
    if (w.following) { w.level = null; w.followSpan = to.w; }
    return to;
  };
  const toView = (cx, cy) => { const r = svg.getBoundingClientRect(); return { x: w.view.x + (cx - r.left) * mpp(), y: w.view.y + (cy - r.top) * mpp() }; };
  // A stop: selected (the sheet: toggled, its name in the caption; the main map: labeled). Elsewhere:
  // the main map's label cleared.
  const tapSelect = id => {
    if (!svg.isConnected) return;
    if (id) select(id);
    else if (!interactive && w.selected) { w.selected = null; w.redraw?.(); }
  };
  // Twice in or out about the point (you while following), eased; a moved view.
  const tapZoom = (factor, client) => {
    if (!w.view) return;
    const to = zoomFollow(animGoal ?? w.view, factor, toView(client.x, client.y));
    markMoved();
    animateTo(to);
    apply(); // the fit button now, not after the ease
  };
  svg.addEventListener('click', e => {
    if (dragged || maxPointers > 1) return;
    const t = { t: performance.now(), x: e.clientX, y: e.clientY };
    clearTimeout(tapTimer);
    if (doubleTap(lastTap, t)) { lastTap = null; tapZoom(TAP_ZOOM, t); return; }
    lastTap = t;
    // The tapped stop, or a nearer drawn one whose hit circle (14 px) also holds the tap: dots can
    // be 10 px apart (2026-11-17), so the topmost hit circle isn't always the dot tapped.
    const hit = e.target.closest?.('[data-stop]');
    const near = !hit ? null : [...svg.querySelectorAll('.map-stop[data-stop]:not([display])')]
      .map(g => { const r = g.querySelector('circle').getBoundingClientRect(); return { g, d: Math.hypot(r.x + r.width / 2 - t.x, r.y + r.height / 2 - t.y) }; })
      .filter(c => c.d <= 14)
      .reduce((a, b) => (!a || b.d < a.d ? b : a), null);
    const id = (near?.g ?? hit)?.dataset.stop ?? null;
    tapTimer = setTimeout(() => tapSelect(id), DOUBLE_TAP_MS);
  });
  if (interactive) svg.addEventListener('keydown', e => {
    const g = e.target.closest?.('[data-stop]');
    if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(g.dataset.stop); }
  });
  svg.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stopFit();
    if (!pointers.size) { moved = 0; dragged = false; pinched = false; maxPointers = 0; downMid = null; downAt = performance.now(); }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    maxPointers = Math.max(maxPointers, pointers.size);
    if (pointers.size === 2) { const [a, b] = pointers.values(); downMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  });
  svg.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId);
    if (!prev || !w.view) return;
    const cur = { x: e.clientX, y: e.clientY };
    moved += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    if (!dragged && moved < TAP_SLOP_PX) return;
    if (!dragged) { dragged = true; try { svg.setPointerCapture(e.pointerId); } catch {} }
    const others = [...pointers].filter(([id]) => id !== e.pointerId).map(([, q]) => q);
    if (others.length) {
      const o = others[0], d0 = Math.hypot(prev.x - o.x, prev.y - o.y), d1 = Math.hypot(cur.x - o.x, cur.y - o.y);
      const mid = toView((cur.x + o.x) / 2, (cur.y + o.y) / 2);
      pinched = true;
      if (d0 > 0) w.view = zoomFollow(w.view, d1 / d0, mid);
    } else {
      if (!pinched) w.stopFollow?.(); // a finger left from a pinch keeps following
      w.view = panView(w.view, -(cur.x - prev.x) * mpp(), -(cur.y - prev.y) * mpp(), limits());
    }
    pointers.set(e.pointerId, cur);
    markMoved();
    apply();
  });
  const up = e => {
    if (!pointers.delete(e.pointerId) || pointers.size) return;
    if (!dragged && twoFingerTap({ pointers: maxPointers, moved, ms: performance.now() - downAt })) {
      lastTap = null;
      clearTimeout(tapTimer);
      tapZoom(1 / TAP_ZOOM, downMid);
    }
    setTimeout(() => { dragged = false; });
  };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
  // The wheel (2026-11-13): the main map's plain wheel scrolls the page; ctrl (a trackpad pinch) zooms.
  svg.addEventListener('wheel', e => {
    if (!w.view) return;
    const f = wheelZoom({ deltaY: e.deltaY, ctrlKey: e.ctrlKey, plain: interactive });
    if (f == null) return;
    stopFit();
    e.preventDefault();
    w.view = zoomFollow(w.view, f, toView(e.clientX, e.clientY));
    markMoved();
    apply();
  }, { passive: false });
  // Drags don't reach setup's card, nor pull-to-refresh (2026-11-13); the main map's taps still
  // reach the wake lock (pointerdown).
  el.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  if (interactive) el.addEventListener('pointerdown', e => e.stopPropagation(), { passive: true });
  return w;
}

