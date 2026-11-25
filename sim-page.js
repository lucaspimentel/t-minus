// The simulator in the page (DESIGN.md "Simulator"), loaded by index.html only while it is on
// (sim.js's clock is then running): fake MBTA data at the virtual time (a day's real schedules
// replayed, or a test preset), this server's code in the page for the pushes and the planner,
// the boarding engine on fake locations, and snapshots for rewinding. Storage: the app's keys
// under `t-minus-sim:` (localStorage), the rest in IndexedDB `t-minus-sim` (one key-value store:
// `coverage` the replayed days' docs, `static:<url>` pass-through copies, `live` the changes,
// location and pushes, `server` the in-page server's store, `snaps` and `snap:<id>`).
import { createFakeMbta, scenarioFromSchedules, staticFromIncluded, mergeTripStops, applyTweaks } from './sim-mbta.js?v=ebe8d6ac4b';
import { PRESETS } from './sim-presets.js?v=8ad9deb13b';
import { tripShape, legQuery, simDayQuery, serviceDate, pickSnapshot, offsetPoint, legPoints, distanceMeters, ridePhase, nativeBoardingStep, GEOFENCE_METERS } from './core.js?v=30b94f3f5a';

export const SIM_PREFIX = 't-minus-sim:';
export const SIM_CTL = 't-minus-simctl';
const DB = 't-minus-sim';
const MAX_SNAPS = 200;
const MIN = 60_000;
// Sim keys that are only copies of static data (route and stop lists, shapes): not snapshotted.
const STATIC_KEY = /^t-minus-sim:(stops:|shapes:|routes:|rail-network:)/;

// ---------- IndexedDB (one key-value store) ----------
let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function idb(mode, f) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', mode);
    const req = f(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const get = key => idb('readonly', s => s.get(key));
const put = (key, value) => idb('readwrite', s => s.put(value, key));
const del = key => idb('readwrite', s => s.delete(key));

// Deletes everything the simulator kept (after it ended and its Undo passed).
export async function purgeSim() {
  for (const k of Object.keys(localStorage)) if (k.startsWith(SIM_PREFIX)) localStorage.removeItem(k);
  localStorage.removeItem(SIM_CTL);
  localStorage.removeItem('t-minus-simrestore');
  dbp = null;
  await new Promise(r => { const q = indexedDB.deleteDatabase(DB); q.onsuccess = q.onerror = q.onblocked = () => r(); });
}

// ---------- the replay's coverage ----------

// A leg's day: its route(s), direction and stops on a service date.
const legKey = (p, date) => `leg:${p['filter[route]']}|${p['filter[direction_id]']}|${p['filter[stop]']}|${date}`;
const tripKey = (id, date) => `trip:${id}|${date}`;
const LEG_FIELDS = {
  include: 'stop,trip', 'fields[stop]': 'name,parent_station,platform_code,latitude,longitude', 'fields[trip]': 'headsign,name',
  'fields[schedule]': 'arrival_time,departure_time,pickup_type,drop_off_type',
};
const legDayQuery = (p, date) => ({ 'filter[route]': p['filter[route]'], 'filter[direction_id]': p['filter[direction_id]'], 'filter[stop]': p['filter[stop]'],
  ...LEG_FIELDS, 'filter[date]': date, 'filter[min_time]': '00:00', 'filter[max_time]': '28:00' });
const tripDayQuery = (id, date) => ({ 'filter[trip]': id, 'filter[date]': date, include: 'stop',
  'fields[schedule]': 'stop_sequence,arrival_time,departure_time', 'fields[stop]': 'name,parent_station,latitude,longitude' });

// Setup's ride picker: a trip's rides on a date from the real MBTA (`mbtaApi`), and the docs to
// seed the simulator's coverage with (no second request at the start).
export async function dayDocs(trip, date, mbtaApi) {
  const { transit } = tripShape(trip);
  const docs = await Promise.all(transit.map(l => mbtaApi('/schedules', simDayQuery(l, date))));
  return { docs, coverage: Object.fromEntries(transit.map((l, i) => [legKey(legQuery(l), date), { doc: docs[i], direction: l.direction_id, date }])) };
}

// Setup's Start: the sim's config and clock, then a reload into the simulator. `real`: the real
// config. { mode: 'trip', trip, date, at, coverage } or { mode: 'preset', presetId, at }.
export async function startSim({ mode, config, tripRef, date, at, presetId, coverage = {} }) {
  await purgeSim();
  const cfg = mode === 'preset' ? PRESETS.find(p => p.id === presetId).config : config;
  localStorage.setItem(`${SIM_PREFIX}config`, JSON.stringify(cfg));
  if (tripRef) localStorage.setItem(`${SIM_PREFIX}trip-override`, JSON.stringify({ id: tripRef, setAt: at }));
  localStorage.setItem(`${SIM_PREFIX}mapHidden`, localStorage.getItem('t-minus:mapHidden') ?? 'true');
  await put('coverage', coverage);
  localStorage.setItem(SIM_CTL, JSON.stringify({ on: true, mode, presetId: presetId ?? null, tripRef: tripRef ?? null, date: date ?? null, clock: { at, speed: 1, keepPlaying: true } }));
}

// ---------- the simulator ----------

// `sim`: window.tminusSim; `mbtaApi`: the page's real MBTA request (the proxy, else the API).
// Returns the page's handle; `bind(hooks)` before use: { context() → { trip, enRoute, current
// (simCurrentRide) }, render(), refresh(), showToast(text) }.
export async function startSimPage(sim, { mbtaApi }) {
  const ctl = sim.ctl();
  let hooks = { mbtaApi };
  const preset = ctl.mode === 'preset' ? PRESETS.find(p => p.id === ctl.presetId) ?? PRESETS[0] : null;
  let coverage = (await get('coverage').catch(() => null)) ?? {};
  let live = (await get('live').catch(() => null)) ?? { tweaks: [], location: 'off', gotOff: null, pushes: [] };
  let serverDump = (await get('server').catch(() => null)) ?? null;
  let presetStatic = null;
  let base = null;
  let fake = null;
  let staticData = null;
  const listeners = new Set();
  const changed = () => { for (const f of listeners) f(); hooks?.render(); };

  // ---------- fake data ----------
  function rebuildBase() {
    if (preset) {
      base = preset.scenario();
      staticData = { names: new Map(), parents: new Map(), coords: new Map(), ...presetStatic };
    } else {
      const trips = new Map();
      for (const c of Object.values(coverage)) {
        if (c.kind === 'trip') continue;
        for (const t of scenarioFromSchedules(c.doc, { direction: c.direction, date: c.date })) {
          const k = `${t.id}|${t.date}`;
          const had = trips.get(k);
          if (!had) { trips.set(k, t); continue; }
          const stops = new Map([...had.stops, ...t.stops]);
          trips.set(k, { ...had, stops: [...stops].sort((a, b) => a[1] - b[1]), pickup: { ...had.pickup, ...t.pickup }, dropOff: { ...had.dropOff, ...t.dropOff } });
        }
      }
      for (const c of Object.values(coverage)) {
        if (c.kind !== 'trip') continue;
        const k = `${c.id}|${c.date}`;
        if (trips.has(k)) trips.set(k, mergeTripStops(trips.get(k), c.doc));
      }
      base = { trips: [...trips.values()], alerts: [], liveWithinMin: 60, moving: true };
      staticData = staticFromIncluded(Object.values(coverage).map(c => c.doc));
    }
    rebuild();
  }
  function rebuild() {
    const scenario = applyTweaks(base, live.tweaks);
    if (staticData.platforms) scenario.platforms = { ...staticData.platforms, ...scenario.platforms };
    fake = createFakeMbta(scenario, staticData);
  }

  // A preset's stop names, stations and coordinates: the real stop lists (time-independent).
  async function loadPresetStatic() {
    const out = { names: new Map(), parents: new Map(), coords: new Map(), platforms: {} };
    const pairs = new Set(preset.scenario().trips.map(t => `${t.route}|${t.direction}`));
    await Promise.all([...pairs].map(async pair => {
      const [route, dir] = pair.split('|');
      const doc = await passThrough('/stops', { 'filter[route]': route, 'filter[direction_id]': dir, include: 'child_stops', 'fields[stop]': 'name,latitude,longitude' }).catch(() => null);
      for (const s of doc?.data ?? []) {
        const a = s.attributes ?? {};
        out.names.set(s.id, a.name);
        if (a.latitude != null) out.coords.set(s.id, { latitude: a.latitude, longitude: a.longitude });
        for (const c of s.relationships?.child_stops?.data ?? []) { out.parents.set(c.id, s.id); out.names.set(c.id, a.name); }
      }
    }));
    return out;
  }

  // Time-independent requests go to the real MBTA (the proxy), kept for the simulator's life.
  async function passThrough(path, params) {
    const key = `static:${path}?${new URLSearchParams(params)}`;
    const hit = await get(key).catch(() => null);
    if (hit) return hit;
    const doc = await hooks.mbtaApi(path, params);
    put(key, doc).catch(() => {});
    return doc;
  }
  const isFake = (path, p) => path === '/predictions' || path === '/vehicles' || path === '/alerts'
    || (path === '/schedules' && (p['filter[trip]'] != null || (p['filter[route]'] != null && p['filter[stop]'] != null)));

  // The replay's data for a request: a leg's whole day, or a trip's whole stop list, fetched once.
  const inFlight = new Map();
  const failedAt = new Map();
  function fetchCoverage(key, run) {
    if (coverage[key] || inFlight.has(key) || (failedAt.get(key) ?? -Infinity) > sim.real.Date.now() - 60_000) return inFlight.get(key) ?? null;
    const p = run().then(async c => {
      coverage = { ...coverage, [key]: c };
      await put('coverage', coverage).catch(() => {});
      rebuildBase();
    }, () => { failedAt.set(key, sim.real.Date.now()); }).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }
  async function ensure(path, p) {
    if (preset) return;
    const now = Date.now();
    const waits = [];
    if (p['filter[trip]'] != null) {
      const id = String(p['filter[trip]']).replace(/~early\d+$/, '');
      const date = p['filter[date]'] ?? serviceDate(now).date;
      const key = tripKey(id, date);
      if (!coverage[key]) waits.push(fetchCoverage(key, async () => ({ kind: 'trip', id, date, doc: await hooks.mbtaApi('/schedules', tripDayQuery(id, date)) })));
    } else if (p['filter[route]'] != null && p['filter[stop]'] != null) {
      const date = p['filter[date]'] ?? serviceDate(now).date;
      const key = legKey(p, date);
      if (!coverage[key]) waits.push(fetchCoverage(key, async () => ({ doc: await hooks.mbtaApi('/schedules', legDayQuery(p, date)), direction: p['filter[direction_id]'], date })));
    }
    await Promise.all(waits.filter(Boolean));
  }

  // The page's MBTA requests in the simulator.
  async function api(path, params) {
    if (!isFake(path, params)) return passThrough(path, params);
    await ensure(path, params);
    const body = fake.answer(new URL(`https://api-v3.mbta.com${path}?${new URLSearchParams(params)}`), Date.now());
    if (body === undefined) throw new Error('HTTP 503');
    if (body === null) throw new Error('HTTP 404');
    return body;
  }

  // ---------- this server, in the page ----------
  const [{ createApp }, { createMemoryStore }] = await Promise.all([import('./server/app.mjs?v=3da1fa6d06'), import('./server/memory-store.mjs?v=a50870064e')]);
  const memStore = createMemoryStore();
  memStore.load(serverDump);
  const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  // The server's own requests: the MBTA through the simulator; anything else refused.
  async function serverMbta(url) {
    const u = new URL(url);
    if (u.hostname !== 'api-v3.mbta.com') return json(404, { error: 'Not in the simulator' });
    try { return json(200, await api(u.pathname, Object.fromEntries(u.searchParams))); } catch (e) { return json(/404/.test(e.message) ? 404 : 503, {}); }
  }
  // A push the server sent: a toast, and the bar's list. Live Activity payloads only listed.
  function sink(sub, payload) {
    const activity = payload?.headers?.['apns-push-type'] === 'liveactivity';
    const n = payload?.notification ?? {};
    const entry = { at: Date.now(), kind: activity ? 'live activity' : n.data?.kind ?? 'push', title: n.title ?? payload?.body?.aps?.alert?.title ?? '', body: n.body ?? payload?.body?.aps?.alert?.body ?? '' };
    live = { ...live, pushes: [...live.pushes, entry].slice(-50) };
    saveLive();
    if (!activity) hooks?.showToast(`SIM push · ${entry.title}${entry.body ? ` · ${entry.body}` : ''}`);
    changed();
    return Promise.resolve({ statusCode: 201 });
  }
  const app = createApp({ fetch: serverMbta, send: sink, store: memStore, now: () => Date.now(), proxy: false, staticRoot: null, publicKey: 'SIM', log: m => console.debug('[sim server]', m) });
  const subscription = (() => {
    let id = localStorage.getItem(`${SIM_PREFIX}endpoint`);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(`${SIM_PREFIX}endpoint`, id); }
    return { endpoint: `https://sim.invalid/push/${id}`, keys: { p256dh: 'sim', auth: 'sim' } };
  })();
  // A request to the server in the page: node's req/res, adapted.
  function serverFetch(path, init = {}) {
    if (rewinding) return Promise.resolve(json(503, { error: 'Rewinding' }));
    return new Promise(resolve => {
      const handlers = { data: [], end: [], error: [] };
      const body = init.body == null ? null : new TextEncoder().encode(init.body);
      let emitted = false;
      const emit = () => {
        if (emitted) return;
        emitted = true;
        if (body) for (const f of handlers.data) f(body);
        for (const f of handlers.end) f();
      };
      const req = {
        method: init.method ?? 'GET', url: `/api${path}`, headers: { host: 'sim', ...(init.headers ?? {}) }, socket: { remoteAddress: 'sim' },
        on(ev, f) { handlers[ev]?.push(f); queueMicrotask(emit); return req; },
        destroy() {},
      };
      let status = 200;
      let headers = {};
      const res = {
        headersSent: false,
        writeHead(s, h = {}) { status = s; headers = h; res.headersSent = true; },
        end(b) { resolve(new Response(status === 204 || status === 304 ? null : b ?? null, { status, headers })); },
      };
      app.handler(req, res);
    });
  }
  setInterval(() => { app.tick().catch(e => console.debug('[sim server] tick', e)); }, 15_000);

  // ---------- persistence and snapshots ----------
  let liveTimer = null;
  function saveLive() {
    sim.real.clearTimeout(liveTimer);
    liveTimer = sim.real.setTimeout(flush, 1000);
  }
  let rewinding = false;
  async function flush() {
    sim.real.clearTimeout(liveTimer);
    if (rewinding) return;
    await Promise.all([put('live', live), put('server', memStore.dump())]).catch(() => {});
  }
  window.addEventListener('pagehide', () => { flush(); });
  setInterval(() => { if (!rewinding) put('server', memStore.dump()).catch(() => {}); }, 30_000);

  const simKeys = () => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith(SIM_PREFIX) && !STATIC_KEY.test(k)).map(k => [k, localStorage.getItem(k)]));
  async function snapshot(reason) {
    if (rewinding) return;
    const id = `${sim.real.Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const at = Date.now();
    const list = (await get('snaps').catch(() => null)) ?? [];
    await put(`snap:${id}`, { at, reason, keys: simKeys(), live, server: memStore.dump() });
    list.push({ id, at, reason });
    while (list.length > MAX_SNAPS) await del(`snap:${list.shift().id}`);
    await put('snaps', list);
  }
  async function rewindTo(target) {
    const list = (await get('snaps').catch(() => null)) ?? [];
    const pick = pickSnapshot(list, target);
    rewinding = true; // this page writes nothing more: the snapshot is the state
    if (pick) {
      const snap = await get(`snap:${pick.id}`);
      localStorage.setItem('t-minus-simrestore', JSON.stringify(snap.keys)); // applied by sim.js at the reload
      live = snap.live;
      memStore.load(snap.server);
      for (const s of list.filter(s => s.at > pick.at)) await del(`snap:${s.id}`);
      await put('snaps', list.filter(s => s.at <= pick.at));
    }
    await Promise.all([put('live', live), put('server', memStore.dump())]);
    sim.saveCtl({ clock: { at: Math.max(target, pick?.at ?? target), speed: sim.speed, paused: sim.paused, keepPlaying: !sim.paused } });
    location.reload();
  }
  async function forwardTo(target) {
    await snapshot('jump');
    sim.jumpBy(target - Date.now());
    hooks.refresh();
  }
  let lastPhase = null;
  setInterval(() => { if (!sim.paused && !rewinding) snapshot('tick').catch(() => {}); }, 60_000);

  // ---------- fake location and the boarding engine ----------
  const ctx = () => hooks.context();
  // Board and alight points per leg, from the fake's stop records (coordinates).
  function points(trip) {
    const date = serviceDate(Date.now()).date;
    const docs = tripShape(trip).transit.map(l => fake.answer(new URL(`https://api-v3.mbta.com/schedules?${new URLSearchParams(legDayQuery(legQuery(l), date))}`), Date.now()));
    return legPoints(trip, docs);
  }
  // The leg the rider is at or on: the ride's phase, else the first.
  function legNow(c) {
    const ride = c.enRoute?.ride;
    if (!ride) return { leg: 0, riding: false };
    const p = ridePhase(ride, tripShape(c.trip).walkAfter, Date.now());
    const n = ride.legs.length;
    return { leg: Math.min(p.leg, n - 1), riding: p.kind === 'riding', after: p.leg >= n };
  }
  function locate() {
    const c = ctx();
    if (!c?.trip || live.location === 'off') return null;
    const pts = points(c.trip);
    const { leg } = legNow(c);
    const fix = p => (p ? { lat: p.lat, lon: p.lon, acc: 10 } : null);
    switch (live.location) {
      case 'home': return pts[0]?.board ? fix(offsetPoint(pts[0].board, 300, 0)) : null;
      case 'stop': return fix(pts[leg]?.board);
      case 'vehicle': {
        const tripId = c.enRoute?.ride?.legs[leg]?.tripId ?? c.current?.legs[leg]?.tripId;
        const v = tripId ? fake.vehicleAt(tripId, Date.now()) : null;
        return v ? fix(v) : fix(pts[leg]?.board);
      }
      case 'gotOff': return fix(live.gotOff);
      default: return null;
    }
  }
  sim.setLocationProvider(locate);
  function setLocation(kind) {
    const c = ctx();
    let gotOff = null;
    // Got off: the phone stays where it is (on the vehicle: the vehicle's spot; else the leg's
    // drop-off) while the vehicle goes on.
    if (kind === 'gotOff' && c?.trip) {
      const p = locate();
      const { leg } = legNow(c);
      gotOff = live.location === 'vehicle' && p ? { lat: p.lat, lon: p.lon } : points(c.trip)[leg]?.alight ?? null;
    }
    live = { ...live, location: kind, gotOff };
    saveLive();
    snapshot(`location:${kind}`).catch(() => {});
    engineStep({ type: 'tick' });
    changed();
  }

  // The native boarding engine (core.js nativeBoardingStep), run here on the fake locations.
  const SESSION = `${SIM_PREFIX}boarding-session`;
  let session = (() => { try { return JSON.parse(localStorage.getItem(SESSION)); } catch { return null; } })();
  let wants = { region: null, gps: false, queries: [] };
  let pending = null;
  const logLines = [];
  const boardingListeners = new Set();
  let inside = null;
  function engineStep(event) {
    const out = JSON.parse(nativeBoardingStep(JSON.stringify({ session, event, nowMs: Date.now(), active: true })));
    session = out.session;
    wants = out.wants;
    if (session) localStorage.setItem(SESSION, JSON.stringify(session)); else localStorage.removeItem(SESSION);
    for (const a of out.actions) {
      if (a.type === 'log') logLines.push(`${new Date().toISOString().slice(11, 19)} ${a.line}`);
      if (a.type === 'state') { pending = a; for (const f of boardingListeners) f(); }
    }
    if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
  }
  let engineBusy = false;
  async function engineLoop() {
    if (!session || engineBusy) return;
    engineBusy = true;
    try {
      const p = locate();
      if (wants.region && p) {
        const now = distanceMeters(p, wants.region) <= (wants.region.radius ?? GEOFENCE_METERS);
        if (now !== inside) { inside = now; engineStep({ type: 'geofence', inside: now }); }
      }
      if ((wants.gps || wants.region) && p) engineStep({ type: 'location', samples: [{ t: Date.now(), lat: p.lat, lon: p.lon, acc: p.acc }] });
      for (const q of wants.queries ?? []) {
        if (Date.now() - (session?.fetched?.[q.key] ?? -Infinity) < q.every) continue;
        const doc = await api(q.path, q.params).catch(() => null);
        if (doc && session) engineStep({ type: 'doc', key: q.key, doc });
      }
      if (session) engineStep({ type: 'tick' });
    } finally { engineBusy = false; }
  }
  setInterval(engineLoop, 5000);
  const boarding = {
    locationStatus: async () => ({ status: live.location === 'off' ? 'denied' : 'always' }),
    boardingSetting: async () => ({}),
    boardingArm: async ({ session: web }) => { engineStep({ type: 'arm', session: web }); engineLoop(); return {}; },
    boardingDisarm: async () => { engineStep({ type: 'disarm' }); return {}; },
    boardingPending: async () => {
      const action = pending;
      pending = null;
      if (action) engineStep({ type: 'take' });
      return { action };
    },
    boardingUndo: async ({ undoId }) => { engineStep({ type: 'undo', undoId }); return {}; },
    boardingLog: async () => ({ lines: [...logLines] }),
    addListener: async (ev, f) => { if (ev === 'boarding') boardingListeners.add(f); return { remove: () => boardingListeners.delete(f) }; },
  };

  // ---------- the bar's actions ----------
  function tweak(type, tripId) {
    if (!tripId) return;
    live = { ...live, tweaks: [...live.tweaks, { type, tripId, date: serviceDate(Date.now()).date, at: Date.now(), ...(type === 'late' && { min: 2 }) }] };
    rebuild();
    saveLive();
    snapshot(`tweak:${type}`).catch(() => {});
    hooks.refresh();
    changed();
  }
  function end() {
    sim.saveCtl({ on: false, endedAt: sim.real.Date.now() });
    flush().finally(() => location.reload());
  }

  if (preset) presetStatic = await loadPresetStatic().catch(() => null);
  return {
    bind(h) {
      hooks = { mbtaApi, ...h };
      rebuildBase();
      get('snaps').then(list => { if (!list?.length) snapshot('start'); }).catch(() => {});
    },
    preset,
    api,
    serverFetch,
    subscription,
    boarding,
    get pushes() { return live.pushes; },
    get location() { return live.location; },
    get tweaks() { return live.tweaks; },
    onChange: f => { listeners.add(f); return () => listeners.delete(f); },
    // The phase key changed: a snapshot (rewinds land on these).
    phase(key) {
      if (key === lastPhase) return;
      const first = lastPhase == null;
      lastPhase = key;
      if (!first) snapshot(`phase:${key}`).catch(() => {});
    },
    back: ms => rewindTo(Date.now() - ms),
    forward: ms => forwardTo(Date.now() + ms),
    jumpTo: at => (at < Date.now() ? rewindTo(at) : forwardTo(at)),
    tweak,
    setLocation,
    end,
  };
}
