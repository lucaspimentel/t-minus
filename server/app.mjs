// Leave-time reminders and stop alerts (followed rides): the HTTP API (/api/*) and the polling loop; also setup's "Show nearby"
// (/api/nearby), the MBTA proxy (/api/mbta/*, a shared cache under the server's key) and the app's own files. No npm imports, so tests load it directly; main.mjs wires
// in web-push, the store, and the clock.
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validateConfig, tripShape, legQuery, scheduleWindow, rowsFromDocs, reminderStep, reminderText, reminderPollMs,
  headsUpDue, HEADS_UP_MIN, testPushText, TEST_PUSH_DELAY_MS, routeDistances, NEARBY_ME_DEGREES,
  checkRide, mergeTrips, legVehicles, trackLegs, ridePhase, transferOutlook, rideStops, rideStopsQuery, rideAlertStep,
  rideAlertText, RIDE_POLL_MS, MBTA_PROXY_PATHS, CACHE_CLASSES, proxyRequestError, mbtaCacheKey,
} from '../core.js';

const MIN = 60_000;
const API = 'https://api-v3.mbta.com';
const SCHEDULE_TTL = 15 * MIN;
const MAX_AHEAD = 12 * 60 * MIN; // how far ahead a reminder may be set
const MAX_PER_SUBSCRIPTION = 5;
const RATE_LIMIT = 30; // requests per IP per minute
const MAX_BODY = 16 * 1024;
const RETRY_MS = 20_000; // after an MBTA error
const MAX_TESTS = 100; // pending test notifications, in memory only
const DAY = 24 * 60 * MIN;
const NEARBY_CELL = 0.0005; // degrees (~50 m): nearby stop lists are cached per cell
const MAX_NEARBY_STOPS = 500; // cached cells
const MAX_NEARBY_SETS = 200; // cached stop sets (routes and the hour's schedules)
const PROXY_RATE_LIMIT = 120; // proxy requests per IP per minute
const MBTA_BUDGET = 800; // MBTA calls per minute past which proxy misses are refused (the key allows 1,000)
const MAX_MEMORY_COPIES = 2000; // the proxy's realtime copies, in memory
const MAX_DISK_COPIES = 2000; // its static copies, in SQLite
const MBTA_TIMEOUT_MS = 10_000;

// The app's files (an allowlist: nothing else under the repo root is served).
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/core.js': 'core.js', '/setup.js': 'setup.js', '/sw.js': 'sw.js',
  '/manifest.json': 'manifest.json', '/icons/icon.svg': 'icons/icon.svg', '/icons/icon-192.png': 'icons/icon-192.png',
  '/icons/icon-512.png': 'icons/icon-512.png',
};
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png' };

export function createApp({ fetch, send, store, now = Date.now, apiKey, publicKey, staticRoot = null, proxy = true, mbtaBudget = MBTA_BUDGET, log = () => {} }) {
  const schedules = new Map(); // reminder id -> { at, docs }
  const hits = new Map(); // ip -> { minute, count }
  let tests = []; // pending test notifications: { subscription, at }
  const nearbyStopsCache = new Map(); // cell -> { at, stops }
  const nearbySetCache = new Map(); // stop ids + hour -> { routeIds, schedules }
  const files = new Map(); // file -> { body, etag }
  let ticking = false;
  const copies = new Map(); // MBTA cache key -> { at, doc | text, lastModified } (realtime classes)
  const inFlight = new Map(); // MBTA cache key -> the pending fetch, shared
  const proxyHits = new Map(); // ip -> { minute, count }
  let calls = { minute: 0, count: 0 }; // the server's MBTA calls this minute (the budget guard)

  // ---------- MBTA (through the shared cache) ----------

  const docOf = e => (e.doc ??= JSON.parse(e.text));
  const textOf = e => (e.text ??= JSON.stringify(e.doc));

  async function fetchMbta(path, params, key, prev, cls, t) {
    const minute = Math.floor(t / MIN);
    calls = calls.minute === minute ? { minute, count: calls.count + 1 } : { minute, count: 1 };
    const qs = new URLSearchParams(params);
    if (apiKey) qs.set('api_key', apiKey);
    const headers = { Accept: 'application/vnd.api+json', ...(prev?.lastModified && { 'If-Modified-Since': prev.lastModified }) };
    let res;
    try {
      res = await fetch(`${API}${path}?${qs}`, { headers, signal: AbortSignal.timeout(MBTA_TIMEOUT_MS) });
    } catch (e) { throw new Error(`MBTA ${path}: ${e.message}`); }
    const at = now();
    if (res.status === 304 && prev) {
      if (cls.disk) store.cacheTouch(key, at);
      return Object.assign(prev, { at });
    }
    if (!res.ok) throw Object.assign(new Error(`MBTA ${path}: HTTP ${res.status}`), { status: res.status });
    const e = { at, doc: await res.json(), lastModified: res.headers?.get?.('last-modified') ?? null };
    if (cls.disk) store.cachePut(key, { ...e, text: textOf(e) });
    else remember(copies, key, e, MAX_MEMORY_COPIES);
    return e;
  }

  // An MBTA document through the cache: { at, doc | text, stale }. A fresh copy is reused and
  // concurrent requests share one call. When the MBTA fails (error, 5xx, 429), `stale` allows a
  // copy within its class's limit. `guard`: refuse a call past the budget (proxy requests).
  async function cached(path, params, { stale = false, guard = false } = {}) {
    const cls = CACHE_CLASSES[MBTA_PROXY_PATHS[path].cache];
    const key = mbtaCacheKey(path, params);
    const t = now();
    const prev = cls.disk ? store.cacheGet(key) : copies.get(key);
    if (prev && t - prev.at < cls.fresh) return prev;
    const usable = () => stale && prev && now() - prev.at <= cls.stale ? { ...prev, stale: true } : null;
    if (guard && !inFlight.has(key) && calls.minute === Math.floor(t / MIN) && calls.count >= mbtaBudget) {
      const copy = usable();
      if (copy) return copy;
      throw Object.assign(new Error('Busy'), { busy: true });
    }
    let p = inFlight.get(key);
    if (!p) {
      p = fetchMbta(path, params, key, prev, cls, t).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
    try {
      return await p;
    } catch (e) {
      const copy = e.status && e.status < 500 && e.status !== 429 ? null : usable();
      if (copy) return copy;
      throw e;
    }
  }

  // The server's own requests (reminders, stop alerts, nearby): fresh copies only.
  const mbta = async (path, params) => docOf(await cached(path, params));

  function proxyLimited(ip, t) {
    const minute = Math.floor(t / MIN);
    const h = proxyHits.get(ip);
    if (!h || h.minute !== minute) { proxyHits.set(ip, { minute, count: 1 }); return false; }
    return ++h.count > PROXY_RATE_LIMIT;
  }

  // GET /api/mbta/<path>?<params>: the app's MBTA requests under the server's key. Same origin
  // only, allowlisted, 120/min per IP; a stale copy carries `x-data-age` (seconds).
  async function proxyMbta(req, res, url, path, ip, t) {
    if (!proxy) return reply(res, 503, { error: 'Proxy off' });
    if (req.method !== 'GET') return reply(res, 404, { error: 'Not found' });
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return reply(res, 403, { error: 'Origin not allowed' });
    if (proxyLimited(ip, t)) return reply(res, 429, { error: 'Too many requests' }, { 'retry-after': String(Math.ceil((MIN - (t % MIN)) / 1000)) });
    const mbtaPath = path.slice('/mbta'.length);
    const params = [...url.searchParams];
    const err = proxyRequestError(mbtaPath, params);
    if (err) return reply(res, 400, { error: err });
    let e;
    try {
      e = await cached(mbtaPath, Object.fromEntries(params), { stale: true, guard: true });
    } catch (x) {
      if (x.busy) return reply(res, 503, { error: 'Busy' });
      if (x.status && x.status < 500 && x.status !== 429) return reply(res, x.status, { error: x.message });
      return reply(res, 502, { error: x.message });
    }
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (e.stale) headers['x-data-age'] = String(Math.max(1, Math.round((now() - e.at) / 1000)));
    let body = Buffer.from(textOf(e));
    if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
      body = gzipSync(body);
      headers['content-encoding'] = 'gzip';
    }
    res.writeHead(200, { ...headers, vary: 'accept-encoding', 'content-length': body.length });
    res.end(body);
  }

  // Drops copies past their stale limit (memory) and old static rows (SQLite).
  function pruneCopies(t) {
    for (const [key, e] of copies) {
      if (t - e.at > CACHE_CLASSES[MBTA_PROXY_PATHS[key.slice(0, key.indexOf('?'))].cache].stale) copies.delete(key);
    }
    store.cachePrune(MAX_DISK_COPIES);
  }

  // ---------- HTTP ----------

  function reply(res, status, body, headers = {}) {
    res.writeHead(status, { ...headers, ...(body !== undefined && { 'content-type': 'application/json' }) });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  function limited(ip, t) {
    const minute = Math.floor(t / MIN);
    const h = hits.get(ip);
    if (!h || h.minute !== minute) { hits.set(ip, { minute, count: 1 }); return false; }
    return ++h.count > RATE_LIMIT;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const validSubscription = sub => typeof sub?.endpoint === 'string' && sub.endpoint.startsWith('https://')
    && typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string';

  // The request body for a new reminder, or an error message.
  function checkReminder(b, t) {
    if (!validSubscription(b?.subscription)) return 'subscription is invalid';
    if (!b.trip || validateConfig({ trips: [b.trip] }).length) return 'trip is invalid';
    const n = tripShape(b.trip).transit.length;
    if (!Number.isInteger(b.timingIdx) || b.timingIdx < 0 || b.timingIdx >= n) return 'timingIdx is invalid';
    if (typeof b.key !== 'string' || !b.key || b.key.length > 200) return 'key is invalid';
    if (!Number.isFinite(b.leaveBy) || b.leaveBy <= t || b.leaveBy - t > MAX_AHEAD) return 'leaveBy must be in the next 12 hours';
    if (b.stopSlackMinutes != null && !(Number.isFinite(b.stopSlackMinutes) && b.stopSlackMinutes >= 0 && b.stopSlackMinutes <= 60)) return 'stopSlackMinutes is invalid';
    if (b.tripName != null && (typeof b.tripName !== 'string' || b.tripName.length > 100)) return 'tripName is invalid';
    return null;
  }

  // ---------- the app's files ----------

  // Cache-Control: the page, the service worker and the manifest are revalidated each time;
  // `?v=<hash>` modules never change; icons for a day.
  function cacheControl(url, file) {
    if (url.searchParams.has('v') && file.endsWith('.js')) return 'public, max-age=31536000, immutable';
    if (file.startsWith('icons/')) return 'public, max-age=86400';
    return 'no-cache';
  }

  async function serveFile(req, res, url) {
    const file = STATIC[url.pathname];
    if (!file) return reply(res, 404, { error: 'Not found' });
    let f = files.get(file);
    if (!f) {
      const body = await readFile(join(staticRoot, file));
      f = { body, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"` };
      files.set(file, f);
    }
    const headers = { 'content-type': TYPES[file.split('.').pop()], 'cache-control': cacheControl(url, file), etag: f.etag };
    if (file.endsWith('.html')) Object.assign(headers, { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
    if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'content-length': f.body.length });
    res.end(req.method === 'HEAD' ? undefined : f.body);
  }

  async function handle(req, res) {
    const t = now();
    const url = new URL(req.url, 'http://x');
    // The API lives under /api/; /health also answers at the root (Railway's health check).
    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/health';
    if (!isApi) {
      if (staticRoot && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(req, res, url);
      return reply(res, 404, { error: 'Not found' });
    }
    const path = url.pathname === '/health' ? '/health' : url.pathname.slice(4);
    // Same origin only: the app is served from here and sends its own origin on POST and DELETE;
    // other sites can't make a visitor's browser set or cancel reminders.
    const origin = req.headers.origin;
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reply(res, 403, { error: 'Origin not allowed' });
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    if (path.startsWith('/mbta/')) return proxyMbta(req, res, url, path, ip, t);
    if (limited(ip, t)) return reply(res, 429, { error: 'Too many requests' });

    if (req.method === 'GET' && path === '/health') return reply(res, 200, { ok: true, reminders: store.count() });
    if (req.method === 'GET' && path === '/vapid') return reply(res, 200, { publicKey });
    if (req.method === 'GET' && path === '/nearby') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!(lat >= 41.5 && lat <= 43.5 && lon >= -72.5 && lon <= -69.5)) return reply(res, 400, { error: 'lat/lon must be near Boston' });
      return reply(res, 200, await nearby(lat, lon, t));
    }

    let body;
    if (req.method === 'POST') {
      try { body = JSON.parse(await readBody(req)); } catch (e) { return reply(res, e.status ?? 400, { error: e.status ? 'Body too large' : 'Invalid JSON' }); }
    }

    // The setup's test notification, sent TEST_PUSH_DELAY_MS later; one pending per subscription.
    if (req.method === 'POST' && path === '/test-push') {
      if (!validSubscription(body?.subscription)) return reply(res, 400, { error: 'subscription is invalid' });
      if (tests.length >= MAX_TESTS || tests.some(x => x.subscription.endpoint === body.subscription.endpoint)) {
        return reply(res, 429, { error: 'A test notification is already on its way' });
      }
      tests.push({ subscription: body.subscription, at: t + TEST_PUSH_DELAY_MS });
      return reply(res, 202, { at: t + TEST_PUSH_DELAY_MS });
    }

    if (req.method === 'POST' && path === '/reminders') {
      const err = checkReminder(body, t);
      if (err) return reply(res, 400, { error: err });
      if (store.countFor(body.subscription.endpoint) >= MAX_PER_SUBSCRIPTION) {
        return reply(res, 429, { error: `At most ${MAX_PER_SUBSCRIPTION} reminders at a time` });
      }
      const rem = {
        id: randomUUID(), subscription: body.subscription, trip: body.trip, tripName: body.tripName ?? body.trip.name,
        stopSlackMinutes: body.stopSlackMinutes ?? 1, timingIdx: body.timingIdx, key: body.key,
        leaveBy: body.leaveBy, headsUp: headsUpDue(body.leaveBy, t), missing: 0, nextPollAt: t, createdAt: t,
      };
      store.add(rem);
      log(`reminder ${rem.id} for ${rem.key}, leave by ${new Date(rem.leaveBy).toISOString()}`);
      return reply(res, 201, { id: rem.id, headsUp: rem.headsUp });
    }

    // Stop alerts: the server follows a tracked ride (re-planning connections) and pushes before
    // each drop-off. PUT replaces the legs (the app switched vehicles), keeping what was sent.
    if (req.method === 'POST' && path === '/rides') {
      if (!validSubscription(body?.subscription)) return reply(res, 400, { error: 'subscription is invalid' });
      const err = checkRide(body.trip, body.ride, t);
      if (err) return reply(res, 400, { error: err });
      if (body.tripName != null && (typeof body.tripName !== 'string' || body.tripName.length > 100)) return reply(res, 400, { error: 'tripName is invalid' });
      if (store.countFor(body.subscription.endpoint) >= MAX_PER_SUBSCRIPTION) {
        return reply(res, 429, { error: `At most ${MAX_PER_SUBSCRIPTION} reminders at a time` });
      }
      const ride = {
        kind: 'ride', id: randomUUID(), subscription: body.subscription, trip: body.trip, tripName: body.tripName ?? body.trip.name,
        ride: { legs: body.ride.legs, boardedAt: body.ride.boardedAt }, alert: { sent: {}, missedDep: null, none: false },
        nextPollAt: t, createdAt: t,
      };
      store.add(ride);
      log(`ride ${ride.id} on ${ride.ride.legs.map(l => l.tripId).join(', ')}`);
      return reply(res, 201, { id: ride.id });
    }
    const r = path.match(/^\/rides\/([\w-]{1,64})$/);
    if (req.method === 'PUT' && r) {
      let b;
      try { b = JSON.parse(await readBody(req)); } catch (e) { return reply(res, e.status ?? 400, { error: e.status ? 'Body too large' : 'Invalid JSON' }); }
      const ride = store.get(r[1]);
      if (ride?.kind !== 'ride') return reply(res, 404, { error: 'Not found' });
      const err = checkRide(ride.trip, b?.ride, t);
      if (err) return reply(res, 400, { error: err });
      ride.ride = { legs: b.ride.legs, boardedAt: b.ride.boardedAt };
      ride.nextPollAt = t;
      store.update(ride);
      return reply(res, 204, undefined);
    }
    if (req.method === 'DELETE' && r) {
      const ride = store.get(r[1]);
      const found = ride?.kind === 'ride' && store.delete(r[1]);
      schedules.delete(r[1]);
      return reply(res, found ? 204 : 404, undefined);
    }

    const m = path.match(/^\/reminders\/([\w-]{1,64})$/);
    if (req.method === 'DELETE' && m) {
      const found = store.delete(m[1]);
      schedules.delete(m[1]);
      return reply(res, found ? 204 : 404, undefined);
    }
    return reply(res, 404, { error: 'Not found' });
  }

  // ---------- nearby (setup's "Show nearby") ----------

  // A Map used as a small cache: set, dropping the oldest entry past `max`.
  function remember(map, key, value, max) {
    map.delete(key);
    map.set(key, value);
    if (map.size > max) map.delete(map.keys().next().value);
    return value;
  }

  // The routes at stops within NEARBY_ME_DEGREES of a point and each one's distance (meters,
  // whole; null without a scheduled trip there in the next hour), from 3 MBTA requests: the
  // stops (cached a day per ~50 m cell), and per stop set and hour their routes and schedules.
  async function nearby(lat, lon, t) {
    const cell = `${Math.round(lat / NEARBY_CELL)},${Math.round(lon / NEARBY_CELL)}`;
    let hit = nearbyStopsCache.get(cell);
    if (!hit || t - hit.at >= DAY) {
      const doc = await mbta('/stops', {
        'filter[latitude]': lat, 'filter[longitude]': lon, 'filter[radius]': NEARBY_ME_DEGREES,
        'filter[route_type]': '0,1,3', 'fields[stop]': 'name,latitude,longitude',
      });
      hit = remember(nearbyStopsCache, cell, { at: t, stops: doc.data }, MAX_NEARBY_STOPS);
    }
    if (!hit.stops.length) return { routes: [] };
    const ids = hit.stops.map(s => s.id).join(',');
    const w = scheduleWindow(t, 0, 60);
    const setKey = `${ids}@${w.date} ${w.minTime.slice(0, 2)}`;
    let set = nearbySetCache.get(setKey);
    if (!set) {
      const routes = await mbta('/routes', { 'filter[stop]': ids, 'filter[type]': '0,1,3', 'fields[route]': 'short_name' });
      let schedules = null;
      try {
        schedules = (await mbta('/schedules', {
          'filter[stop]': ids, 'filter[date]': w.date, 'filter[min_time]': w.minTime, 'filter[max_time]': w.maxTime,
          'fields[schedule]': 'stop_sequence',
        })).data;
      } catch (e) { log(`nearby schedules: ${e.message}`); }
      set = { routeIds: routes.data.map(r => r.id), schedules };
      // Without schedules, not kept: the next call tries again.
      if (schedules) remember(nearbySetCache, setKey, set, MAX_NEARBY_SETS);
    }
    const dist = set.schedules ? routeDistances(hit.stops, set.schedules, { lat, lon }) : new Map();
    return { routes: set.routeIds.map(id => ({ id, meters: dist.has(id) ? Math.round(dist.get(id)) : null })) };
  }

  // ---------- loop ----------

  // Each leg's predictions, and its schedules (cached SCHEDULE_TTL) up to `until`.
  async function fetchDocs(rem, t, until) {
    const transit = tripShape(rem.trip).transit;
    const predictions = await Promise.all(transit.map(l => mbta('/predictions', legQuery(l))));
    let cached = schedules.get(rem.id);
    if (!cached || t - cached.at >= SCHEDULE_TTL) {
      // Wide enough to still hold the ride when it is hours away.
      const w = scheduleWindow(t, 30, Math.max(360, Math.ceil((until - t) / MIN) + 120));
      const win = { 'filter[date]': w.date, 'filter[min_time]': w.minTime, 'filter[max_time]': w.maxTime };
      cached = { at: t, docs: await Promise.all(transit.map(l => mbta('/schedules', { ...legQuery(l), ...win }))) };
      schedules.set(rem.id, cached);
    }
    return { predictions, schedules: cached.docs };
  }

  async function push(rem, kind, row, t) {
    const { title, body } = reminderText(kind, rem.tripName, row, t);
    try {
      await send(rem.subscription, { kind, title, body, tag: rem.key });
      log(`sent ${kind} for ${rem.id}`);
      return true;
    } catch (e) {
      log(`send ${kind} for ${rem.id} failed: ${e.statusCode ?? ''} ${e.message}`);
      return e.statusCode !== 404 && e.statusCode !== 410; // false: the subscription is gone
    }
  }

  function drop(rem) {
    store.delete(rem.id);
    schedules.delete(rem.id);
    return true;
  }

  // Updates rem for its next poll; returns true when it was dropped.
  async function check(rem) {
    const t = now();
    let docs;
    try { docs = await fetchDocs(rem, t, rem.leaveBy); } catch (e) {
      log(`${rem.id}: ${e.message}`);
      rem.nextPollAt = t + RETRY_MS;
      return false;
    }
    const row = rowsFromDocs(rem.trip, docs.predictions, docs.schedules, rem.timingIdx, t, rem.stopSlackMinutes).find(r => r.key === rem.key) ?? null;
    const step = reminderStep(rem, row, t);
    rem.leaveBy = step.leaveBy;
    rem.missing = step.missing;
    if (step.action === 'leave' || step.action === 'cancelled') {
      await push(rem, step.action, row, t);
      return drop(rem);
    }
    if (step.action === 'expire') return drop(rem);
    if (step.action === 'headsUp') {
      rem.headsUp = false;
      if (!(await push(rem, 'headsUp', row, t))) return drop(rem);
    }
    // Poll again in time for the next notification.
    const due = rem.headsUp ? rem.leaveBy - HEADS_UP_MIN * MIN : rem.leaveBy;
    const next = t + reminderPollMs(rem.leaveBy, t);
    rem.nextPollAt = due > t ? Math.min(next, due) : next;
    return false;
  }

  // A followed ride: refresh its legs, re-plan a missed connection, read the ridden vehicle's
  // stops, and send what rideAlertStep decides. Returns true when it was dropped.
  async function checkFollowed(rec) {
    const t = now();
    const { transit, walkAfter, transfers } = tripShape(rec.trip);
    const ride0 = rec.ride;
    let docs;
    try { docs = await fetchDocs(rec, t, ride0.legs[ride0.legs.length - 1].arr); } catch (e) {
      log(`${rec.id}: ${e.message}`);
      rec.nextPollAt = t + RETRY_MS;
      return false;
    }
    const maps = transit.map((l, i) => mergeTrips(docs.predictions[i], docs.schedules[i]));
    const ride = { ...ride0, legs: trackLegs(ride0.legs, transit, maps) };
    const phase = ridePhase(ride, walkAfter, t);
    const outlook = transferOutlook(ride, phase, transit.map((l, i) => legVehicles(maps[i], l)), transfers, t);
    let stops = null;
    if (phase.kind === 'riding') {
      try { stops = rideStops(await mbta('/predictions', rideStopsQuery(ride.legs[phase.leg].tripId)), transit[phase.leg].alight, t); } catch (e) {
        log(`${rec.id}: ${e.message}`); // the time fallback applies
      }
    }
    const step = rideAlertStep(rec.alert, ride, phase, stops, outlook, t);
    if (step.done) return drop(rec);
    for (const s of step.sends) {
      const stopName = stops?.stops[stops.stops.length - 1]?.name;
      const { title, body } = rideAlertText(s, { ride, outlook, stopName, walkAfter, nowMs: t });
      const tag = s.kind === 'missed' || s.kind === 'none' ? `ride:${rec.id}:plan` : `ride:${rec.id}:${s.leg}`;
      try {
        await send(rec.subscription, { kind: s.kind, title, body, tag });
        log(`sent ${s.kind} (leg ${s.leg}) for ${rec.id}`);
      } catch (e) {
        log(`send ${s.kind} for ${rec.id} failed: ${e.statusCode ?? ''} ${e.message}`);
        if (e.statusCode === 404 || e.statusCode === 410) return drop(rec);
      }
    }
    rec.alert = step.alert;
    rec.ride = { ...ride, legs: outlook && (outlook.missedDep != null || outlook.earlier) ? outlook.legs : ride.legs };
    rec.nextPollAt = t + RIDE_POLL_MS;
    return false;
  }

  async function sendTests(t) {
    const due = tests.filter(x => x.at <= t);
    tests = tests.filter(x => x.at > t);
    for (const x of due) {
      try {
        await send(x.subscription, { kind: 'test', ...testPushText(t), tag: 'test' });
        log('sent test');
      } catch (e) {
        log(`send test failed: ${e.statusCode ?? ''} ${e.message}`);
      }
    }
  }

  // Sends due test notifications and checks every reminder that is due. Overlapping calls are
  // skipped.
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await sendTests(now());
      pruneCopies(now());
      for (const rem of store.due(now())) {
        if (!(await (rem.kind === 'ride' ? checkFollowed(rem) : check(rem)))) store.update(rem);
      }
    } finally {
      ticking = false;
    }
  }

  return {
    handler: (req, res) => handle(req, res).catch(e => { log(`error: ${e.stack}`); if (!res.headersSent) reply(res, 500, { error: 'Server error' }); }),
    tick,
  };
}
