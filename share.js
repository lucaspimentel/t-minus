// The page at /r/<id> (DESIGN.md "Share my ride"): a live, read-only view of one ride, for anyone
// with the link. It reads the server's answer (`GET /api/shares/:id`) every 20 s while visible and
// words it every second (`shareView`). It never touches this origin's storage, the location or
// RUM: the recipient's own T-Minus data stays out of it.
import { shareView, mapLegs, SHARE_RESUME_MS, shapesQuery, trimShapesDoc, stopsKey, rideFollow } from './core.js?v=30b94f3f5a';
import { el, renderTimeline, rideStopRows, mapWidget, replaceKeepingFocus } from './ui.js?v=7d1374c3da';

const id = location.pathname.split('/').filter(Boolean).at(-1) ?? '';
const POLL_MS = 20_000;
const $ = x => document.getElementById(x);

let answer = null;
let timer = null;
let ended = false;
let endedDrawn = null; // the answer the ended view shows
let widget = null;
let mapSig = '';
let mapLegsNow = []; // mapLegs(answer.trip) and its signature, per answer
let legsSig = '';
const shapes = new Map(); // stopsKey -> trimmed shapes, once loaded
const loading = new Set();
let lastSpoken = '';

// The shapes of a leg's route, once (a plain proxy GET: the route and direction only).
function loadShapes(leg) {
  const k = stopsKey(leg.route, leg.direction_id);
  if (shapes.has(k) || loading.has(k)) return;
  loading.add(k);
  fetch(`/api/mbta/route_patterns?${new URLSearchParams(shapesQuery(leg.route, leg.direction_id))}`)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(doc => { shapes.set(k, trimShapesDoc(doc)); render(); })
    .catch(() => {})
    .finally(() => loading.delete(k));
}

async function poll() {
  clearTimeout(timer);
  if (ended || document.visibilityState !== 'visible') return;
  let wait = POLL_MS;
  try {
    const res = await fetch(`/api/shares/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.status === 404) answer = { v: 1, at: Date.now(), name: '', status: 'ended', end: null };
    else if (res.status === 429) wait = Math.max(wait, (Number(res.headers.get('retry-after')) || 60) * 1000);
    else if (res.ok) answer = await res.json();
    if (res.ok && answer.status === 'live') { mapLegsNow = mapLegs(answer.trip); legsSig = JSON.stringify(mapLegsNow); }
  } catch { /* keep the last answer: the footer's "Updated" shows its age */ }
  render();
  if (!ended) timer = setTimeout(poll, wait);
}

let drawnKey = '';
function drawMap(phase, now) {
  const legs = mapLegsNow;
  if (!widget || legsSig !== mapSig) {
    mapSig = legsSig;
    widget = mapWidget({ label: 'Map of the shared ride', pan: true, live: true, followRide: true });
    widget.el.classList.add('main-map');
    const li = el('div', 'main-map-item');
    li.append(widget.el);
    $('share-map').replaceChildren(li);
    $('share-map').hidden = false;
    legs.forEach(loadShapes);
  }
  const finished = phase ? Math.min(phase.leg, legs.length) : 0;
  // Redrawn with a new answer, a phase or a loaded shape, not every second (the vehicles move per answer).
  const key = `${answer.at}:${finished}:${phase?.kind}:${legs.map(l => shapes.has(stopsKey(l.route, l.direction_id))).join()}`;
  if (key === drawnKey) return;
  drawnKey = key;
  // The follow button's ride (2026-11-19): the leg being ridden, in its mode.
  const rideLeg = phase?.kind === 'riding' && answer.follow?.kind === 'ride' ? answer.follow.ride.legs[phase.leg] : null;
  const follow = rideLeg ? { leg: phase.leg, ...rideFollow(rideLeg) } : null;
  const stop = (leg, p) => ({ id: leg, ...p, name: p.name ?? leg });
  widget.draw({
    legs, shapes: legs.map(l => shapes.get(stopsKey(l.route, l.direction_id)) ?? null),
    fallback: legs.map((l, i) => { const p = answer.points?.[i]; return p?.board && p?.alight ? [stop(l.stop, p.board), stop(l.alight, p.alight)] : null; }),
    fitAlso: [], finished, fitFrom: finished, vehicles: answer.vehicles ?? [], mine: answer.mine ?? legs.map(() => null),
    nowMs: now, incoming: true, also: legs.map(() => []), follow,
  }, null);
}

// The ridden leg's stops on its timeline bar (the ride card's rows); "… N more" expands.
let stopsOpen = false;
function alongRows(view, now) {
  const f = answer.follow;
  if (f.kind !== 'ride' || !f.stops?.stops?.length || f.stopsLeg !== view.ridePhase?.leg || view.ridePhase.kind !== 'riding') return null;
  const leg = f.ride.legs[view.ridePhase.leg];
  const rows = rideStopRows(f.stops, leg.tripId, now, { open: stopsOpen, onToggle: v => { stopsOpen = v != null; render(); } });
  return { leg: view.ridePhase.leg, rows, boarding: !!f.stops.vehicle?.boarding };
}

// shareView's colors as the row's classes (green: none).
const COLOR_CLASS = { text: ' arrived', amber: ' amber', red: ' red' };

function render() {
  if (!answer) return;
  const now = Date.now();
  const view = shareView(answer, now);
  document.title = view.ogTitle;
  $('share-title').textContent = view.title;
  const rows = $('share-rows');
  if (!view.live) {
    // Final, unless the rider ended it with Cancel trip or a one-off's removal: an Undo (within SHARE_RESUME_MS
    // of the end, by the server's clock) revives it, so the page asks on until an answer is past that.
    ended = !(answer.end?.reason === 'ended' && answer.at - answer.end.at < SHARE_RESUME_MS);
    if (endedDrawn === answer) return; // only a new answer changes it
    endedDrawn = answer;
    $('share-live').hidden = true;
    $('share-map').hidden = true;
    $('share-map').replaceChildren();
    widget = null;
    $('share-foot').textContent = '';
    const li = el('li', 'row ride arrived share-ended');
    li.append(el('div', 'ride-head', view.text));
    rows.replaceChildren(li);
    announce(view.text);
    return;
  }
  $('share-live').hidden = false;
  const li = el('li', `row ride${COLOR_CLASS[view.color] ?? ''}`);
  li.append(el('div', 'ride-head', view.headline));
  if (view.phase) li.append(el('div', 'share-phase', view.phase));
  if (view.note) li.append(el('div', 'share-note', view.note));
  li.append(renderTimeline(view.steps, now, { phase: view.ridePhase, key: `share:${id}`, along: alongRows(view, now) }));
  replaceKeepingFocus(rows, li); // redrawn every second
  $('share-foot').textContent = view.footer;
  drawMap(view.ridePhase, now);
  announce(view.phase || view.headline);
}

// The phase line is announced when it changes (not the countdown).
function announce(text) {
  if (text === lastSpoken) return;
  lastSpoken = text;
  $('share-status').textContent = text;
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { widget?.snapVehicles?.(); poll(); } else clearTimeout(timer); });
setInterval(() => { if (answer && !ended && document.visibilityState === 'visible') render(); }, 1000);
poll();
