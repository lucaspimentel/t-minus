// Leave-time reminders and stop alerts (followed rides): the HTTP API (/api/*) and the polling loop; also setup's "Show nearby"
// (/api/nearby), auto-route (/api/plan, /api/places: addresses and places), the MBTA proxy (/api/mbta/*, a shared cache under the server's key) and the app's own files. No npm imports, so tests load it directly; main.mjs wires
// in web-push, the store, and the clock.
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validateConfig, tripShape, legQuery, scheduleWindow, rowsFromDocs, reminderStep, reminderText, reminderPollMs,
  headsUpsDue, remHeadsUps, testPushText, TEST_PUSH_DELAY_MS, routeDistances, NEARBY_ME_DEGREES,
  checkRide, mergeTrips, tripVehicles, trackLegs, ridePhase, transferOutlook, rideStops, rideStopsQuery, rideAlertStep, liveActivityState,
  rideAlertText, nextPush, RIDE_POLL_MS, MBTA_PROXY_PATHS, CACHE_CLASSES, proxyRequestError, mbtaCacheKey,
  transitNetwork, planTrips, pointEnds, nextWeekday, optionToForm, formToTrip, timedOptions, TIMED_WINDOW_MIN,
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
const LOG_MAX = 50; // sent pushes kept per phone (24 h)
const APP_LOG_MAX = 200; // app log lines kept per device (24 h)
const DAY = 24 * 60 * MIN;
const NEARBY_CELL = 0.0005; // degrees (~50 m): nearby stop lists are cached per cell
const MAX_NEARBY_STOPS = 500; // cached cells
const MAX_NEARBY_SETS = 200; // cached stop sets (routes and the hour's schedules)
const PROXY_RATE_LIMIT = 120; // proxy requests per IP per minute
const MBTA_BUDGET = 800; // MBTA calls per minute past which proxy misses are refused (the key allows 1,000)
const MAX_MEMORY_COPIES = 2000; // the proxy's realtime copies, in memory
const MAX_DISK_COPIES = 2000; // its static copies, in SQLite
const MBTA_TIMEOUT_MS = 10_000;
const NETWORK_TIMEOUT_MS = 60_000; // the network's large requests (patterns ~3 MB, schedules ~12 MB)
const NETWORK_RETRY_MS = 10 * MIN; // after a failed daily rebuild (the old network stays)
const MAX_PLANS = 500; // cached plans (from > to), cleared with each new network
const TIMED_CANDIDATES = 8; // "Go somewhere else…": candidates timed from now
const TIMED_TTL = 30_000; // timed answers, shared by the phones' 60 s refreshes
const MAX_TIMED = 200;
// Auto-route's place search (addresses and named places): Photon, else Nominatim (1 request a
// second, its usage policy), near Boston. The searched text is never logged.
const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const PLACES_BBOX = [-71.6, 42.0, -70.6, 42.75]; // west, south, east, north: the MBTA area, roughly
const PLACES_TIMEOUT_MS = 6000; // Photon's public instance answers in ~1.5-4 s
const PLACES_TTL = DAY;
const MAX_PLACE_QUERIES = 500;
const MAX_PLACES = 5;
const USER_AGENT = 'T-Minus (https://t-minus.lucasp.net)';

// The app's files (an allowlist: nothing else under the repo root is served).
// Declarative Web Push (W3C Push API; Safari 18.4+ shows it even when the service worker fails).
// `mutable`: the worker still runs first (it closes a same-tag notification on iOS). The top-level
// copy is for workers from before this format (they read `event.data` only).
export const PUBLIC_URL = 'https://t-minus.lucasp.net/';
export function declarativePush({ kind, title, body, tag, renotify }, navigate) {
  const n = { title, body, tag, renotify };
  return { web_push: 8030, mutable: true, notification: { ...n, navigate, lang: 'en-US', data: { kind } }, ...n };
}

// The same push for APNs (the iOS app; `endpoint: 'apns:<token>'`): headers and JSON body for
// server/apns.mjs. The tag replaces a same-tag notification (`apns-collapse-id`, at most 64 bytes:
// longer tags are hashed). First sends and earlier times are Time Sensitive with a sound; quiet
// updates (`renotify: false`) are passive.
export const APNS_PREFIX = 'apns:';
export function apnsPush({ kind, title, body, tag, renotify }) {
  const quiet = renotify === false;
  const collapse = tag == null ? null : Buffer.byteLength(tag) <= 64 ? tag : createHash('sha256').update(tag).digest('base64url');
  return {
    headers: { 'apns-push-type': 'alert', 'apns-priority': quiet ? '5' : '10', ...(collapse && { 'apns-collapse-id': collapse }) },
    body: { aps: { alert: { title, body }, 'interruption-level': quiet ? 'passive' : 'time-sensitive', ...(!quiet && { sound: 'default' }) }, kind },
  };
}

// A Live Activity push (the iOS app's Lock Screen card for a followed ride): `event` 'update' or
// 'end', `state` from liveActivityState. server/apns.mjs sends it to the activity's own push token
// with the `<bundle id>.push-type.liveactivity` topic. The card goes stale (dimmed) after
// ACTIVITY_STALE_MS without an update; an end is dismissed at `dismissAt`.
export const ACTIVITY_STALE_MS = 2 * 60_000;
export function apnsActivityPush({ event, state, nowMs, urgent = false, dismissAt = null }) {
  const sec = ms => Math.floor(ms / 1000);
  return {
    headers: { 'apns-push-type': 'liveactivity', 'apns-priority': urgent ? '10' : '5' },
    body: {
      aps: {
        timestamp: sec(nowMs), event, 'content-state': state,
        ...(event === 'update' && { 'stale-date': sec(nowMs + ACTIVITY_STALE_MS) }),
        ...(dismissAt != null && { 'dismissal-date': sec(dismissAt) }),
      },
    },
  };
}

const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/core.js': 'core.js', '/setup.js': 'setup.js', '/sw.js': 'sw.js',
  '/manifest.json': 'manifest.json', '/icons/icon.svg': 'icons/icon.svg', '/icons/icon-192.png': 'icons/icon-192.png',
  '/icons/icon-512.png': 'icons/icon-512.png',
};
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png' };

// "Pending notifications": a stored reminder or followed ride as the phone sees it (no
// subscription keys), with its next push.
function pendingView(e, t) {
  const base = { id: e.id, kind: e.kind === 'ride' ? 'ride' : 'reminder', tripName: e.tripName, createdAt: e.createdAt, lastCheckAt: e.lastCheckAt ?? null, next: nextPush(e, t) };
  if (e.kind === 'ride') {
    const activity = e.activity ? { sent: e.activity.sent ?? 0, title: e.activity.last?.title ?? null, error: e.activity.error ?? null } : null;
    return { ...base, ride: e.ride, phase: ridePhase(e.ride, tripShape(e.trip).walkAfter, t).kind, alert: e.alert, alerts: e.alerts !== false, activity };
  }
  const first = tripShape(e.trip).transit[0];
  return { ...base, key: e.key, leaveBy: e.leaveBy, headsUps: remHeadsUps(e), route: first?.label ?? first?.route ?? null };
}

const nearBoston = (lat, lon) => lat >= 41.5 && lat <= 43.5 && lon >= -72.5 && lon <= -69.5;
const TRANSIT_KINDS = /^(highway=(bus_stop|platform)|public_transport=|railway=(station|halt|stop|tram_stop|subway_entrance|platform)|amenity=(bus_station|shelter))/;
const round5 = x => Number(Number(x).toFixed(5));
// A place's second line: its street address and town, or what it is and the town.
function placeDetail({ house, street, city, kind }) {
  const what = /^place=(suburb|neighbourhood|quarter)/.test(kind) ? 'neighborhood' : kind.startsWith('highway=') ? 'street' : null;
  const addr = street ? [house, street].filter(Boolean).join(' ') : null;
  return [what ?? addr, city].filter(Boolean).join(', ');
}
function uniquePlaces(list) {
  const seen = new Set();
  return list.filter(p => p.name && !TRANSIT_KINDS.test(p.kind) && !seen.has(`${p.name}|${p.detail}`) && seen.add(`${p.name}|${p.detail}`))
    .slice(0, MAX_PLACES).map(({ kind: _, ...p }) => p);
}
function photonPlaces(doc) {
  return uniquePlaces((doc?.features ?? []).map(f => {
    const a = f.properties ?? {};
    const kind = `${a.osm_key}=${a.osm_value}`;
    const [lon, lat] = f.geometry?.coordinates ?? [];
    const house = a.housenumber, street = a.street, city = a.city ?? a.town ?? a.village ?? a.district;
    // An address alone (no name): the street address as the name, the town as the detail.
    if (!a.name && street) return { name: [house, street].filter(Boolean).join(' '), detail: city ?? '', lat: round5(lat), lon: round5(lon), kind };
    return { name: a.name, detail: placeDetail({ house, street: a.name === street ? null : street, city, kind }), lat: round5(lat), lon: round5(lon), kind };
  }));
}
function nominatimPlaces(list) {
  return uniquePlaces((Array.isArray(list) ? list : []).map(x => {
    const a = x.address ?? {};
    const kind = `${x.category}=${x.type}`;
    const house = a.house_number, street = a.road, city = a.city ?? a.town ?? a.village ?? a.suburb;
    const name = x.name || [house, street].filter(Boolean).join(' ') || String(x.display_name ?? '').split(',')[0];
    return { name, detail: placeDetail({ house: x.name ? house : null, street: x.name ? street : null, city, kind }), lat: round5(x.lat), lon: round5(x.lon), kind };
  }));
}

export function createApp({ fetch, send, store, now = Date.now, apiKey, publicKey, publicUrl = PUBLIC_URL, staticRoot = null, proxy = true, mbtaBudget = MBTA_BUDGET, log = () => {} }) {
  const schedules = new Map(); // reminder id -> { at, docs }
  const hits = new Map(); // ip -> { minute, count }
  let tests = []; // pending test notifications: { subscription, at }
  const nearbyStopsCache = new Map(); // cell -> { at, stops }
  let network = null; // auto-route: { net, at } (transitNetwork), rebuilt daily
  let building = null;
  const plans = new Map(); // `${from}>${to}` -> planTrips options
  const places = new Map(); // lowercased query -> { at, places }
  const timedPlans = new Map(); // plan key + walks + slack -> { at, body }
  let nominatimAt = -Infinity; // its last request (1 a second)
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

  // Web Push ({ endpoint: 'https://…', keys }) or the iOS app's APNs device token ({ endpoint: 'apns:<hex>' }).
  const validSubscription = sub => typeof sub?.endpoint === 'string' && (/^apns:[0-9a-f]{64,200}$/.test(sub.endpoint)
    || (sub.endpoint.startsWith('https://') && typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string'));
  const validDevice = d => typeof d === 'string' && /^[0-9a-f-]{36}$/.test(d);
  // A ride's Live Activity: `{ token }`, the activity's APNs push token (hex).
  const activityError = a => (a == null || (typeof a?.token === 'string' && /^[0-9a-f]{32,400}$/.test(a.token)) ? null : 'activity is invalid');

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
    // Auto-route: plans from the daily network.
    if (req.method === 'GET' && path === '/plan') {
      let net;
      try { net = await transit(t); } catch (e) { log(`network: ${e.message}`); return reply(res, 503, { error: 'Network unavailable' }); }
      const q = url.searchParams;
      // Up to 4 comma-separated ids each (both sides of a street: either one), or a point
      // ("@lat,lon": an address, a place, the phone's location; ~10 m, the stops within a walk).
      const end = raw => {
        const pt = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(raw);
        if (pt) {
          const [lat, lon] = [Number(pt[1]), Number(pt[2])];
          if (!nearBoston(lat, lon)) return null;
          const key = `@${lat.toFixed(4)},${lon.toFixed(4)}`;
          return { key, ends: pointEnds(net, { lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) }), name: null };
        }
        const ids = raw.split(',');
        if (ids.length > 4 || !ids.every(id => !!(net.stops[id] || net.stations[id]))) return null;
        return { key: raw, ends: raw, name: (net.stations[ids[0]] ?? net.stops[ids[0]]).name };
      };
      const from = end(q.get('from') ?? '');
      const to = end(q.get('to') ?? '');
      if (!from || !to) return reply(res, 400, { error: 'from and to must be up to 4 stop or station ids, or @lat,lon near Boston' });
      const key = `${from.key}>${to.key}`;
      if (q.get('now') !== '1') {
        const options = plans.get(key) ?? remember(plans, key, planTrips(net, from.ends, to.ends), MAX_PLANS);
        return reply(res, 200, { from: from.name, to: to.name, options });
      }
      // Timed from now ("Go somewhere else…"): the walks at a stop or station end and the stop
      // slack come from the app (a point's walks come with each option).
      const minutes = (name, dflt) => { const v = q.has(name) ? Number(q.get(name)) : NaN; return Number.isInteger(v) && v >= 0 && v <= 60 ? v : dflt; };
      const walks = { wb: minutes('wb', 5), wa: minutes('wa', 5), slack: minutes('slack', 1) };
      const tkey = `${key}#${walks.wb},${walks.wa},${walks.slack}`;
      const hit = timedPlans.get(tkey);
      if (hit && t - hit.at < TIMED_TTL) return reply(res, 200, hit.body);
      const pkey = `${key}#${TIMED_CANDIDATES}`;
      const candidates = plans.get(pkey) ?? remember(plans, pkey, planTrips(net, from.ends, to.ends, 2, TIMED_CANDIDATES), MAX_PLANS);
      const body = { from: from.name, to: to.name, ...(await timePlans(candidates, from, to, walks, t)) };
      if (!body.timedError) remember(timedPlans, tkey, { at: t, body }, MAX_TIMED);
      return reply(res, 200, body);
    }
    if (req.method === 'GET' && path === '/places') {
      const query = (url.searchParams.get('q') ?? '').trim().replace(/\s+/g, ' ');
      if (query.length < 3 || query.length > 100) return reply(res, 400, { error: 'q must be 3 to 100 characters' });
      const key = query.toLowerCase();
      const hit = places.get(key);
      if (hit && t - hit.at < PLACES_TTL) return reply(res, 200, { places: hit.places });
      const found = await searchPlaces(query, t);
      if (!found) return reply(res, 502, { error: 'Place search unavailable' });
      if (found.length) remember(places, key, { at: t, places: found }, MAX_PLACE_QUERIES); // an empty answer is asked again
      return reply(res, 200, { places: found });
    }
    if (req.method === 'GET' && path === '/nearby') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!nearBoston(lat, lon)) return reply(res, 400, { error: 'lat/lon must be near Boston' });
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

    // The setup's "Pending notifications" (debug): this phone's reminders and followed rides, each
    // with its next push, and the pushes sent to it in the last 24 h. POST, so the push endpoint
    // (a secret) stays out of URLs. Clear deletes them all; the log stays.
    if (req.method === 'POST' && (path === '/pending' || path === '/pending/clear')) {
      if (!validSubscription(body?.subscription)) return reply(res, 400, { error: 'subscription is invalid' });
      const ep = body.subscription.endpoint;
      if (path === '/pending/clear') {
        const ids = store.forEndpoint(ep).map(e => e.id);
        store.deleteFor(ep);
        for (const id of ids) schedules.delete(id);
        return reply(res, 200, { deleted: ids.length });
      }
      return reply(res, 200, { now: t, entries: store.forEndpoint(ep).map(e => pendingView(e, t)), log: store.logFor(ep, t - DAY) });
    }

    // The iOS app's diagnostics (registration and plugin errors), per device (a random id the app
    // keeps), for setup's "Pending notifications"; 24 h, newest APP_LOG_MAX lines.
    if (req.method === 'POST' && path === '/log') {
      if (!validDevice(body?.device)) return reply(res, 400, { error: 'device is invalid' });
      if (typeof body.source !== 'string' || !body.source || body.source.length > 40) return reply(res, 400, { error: 'source is invalid' });
      if (typeof body.message !== 'string' || body.message.length > 500) return reply(res, 400, { error: 'message is invalid' });
      store.logApp(body.device, { at: t, source: body.source, message: body.message }, t - DAY, APP_LOG_MAX);
      return reply(res, 204, undefined);
    }
    if (req.method === 'POST' && path === '/log/read') {
      if (!validDevice(body?.device)) return reply(res, 400, { error: 'device is invalid' });
      return reply(res, 200, { lines: store.appLogFor(body.device, t - DAY) });
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
        leaveBy: body.leaveBy, headsUps: headsUpsDue(body.leaveBy, t), missing: 0, nextPollAt: t, createdAt: t,
      };
      store.add(rem);
      log(`reminder ${rem.id} for ${rem.key}, leave by ${new Date(rem.leaveBy).toISOString()}`);
      return reply(res, 201, { id: rem.id, headsUps: rem.headsUps });
    }

    // Stop alerts: the server follows a tracked ride (re-planning connections) and pushes before
    // each drop-off. PUT replaces the legs (the app switched vehicles), keeping what was sent.
    if (req.method === 'POST' && path === '/rides') {
      if (!validSubscription(body?.subscription)) return reply(res, 400, { error: 'subscription is invalid' });
      const err = checkRide(body.trip, body.ride, t);
      if (err) return reply(res, 400, { error: err });
      if (body.tripName != null && (typeof body.tripName !== 'string' || body.tripName.length > 100)) return reply(res, 400, { error: 'tripName is invalid' });
      const aErr = activityError(body.activity);
      if (aErr) return reply(res, 400, { error: aErr });
      if (body.alerts != null && typeof body.alerts !== 'boolean') return reply(res, 400, { error: 'alerts is invalid' });
      if (store.countFor(body.subscription.endpoint) >= MAX_PER_SUBSCRIPTION) {
        return reply(res, 429, { error: `At most ${MAX_PER_SUBSCRIPTION} reminders at a time` });
      }
      // `alerts: false`: followed only for its Live Activity (stop alerts off), no notifications.
      const ride = {
        kind: 'ride', id: randomUUID(), subscription: body.subscription, trip: body.trip, tripName: body.tripName ?? body.trip.name,
        ride: { legs: body.ride.legs, boardedAt: body.ride.boardedAt }, alert: { sent: {}, missedDep: null, none: false },
        alerts: body.alerts !== false, activity: body.activity ? { token: body.activity.token, last: null, sent: 0 } : null,
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
      // Each field is optional: `ride` (new legs), `activity` (its push token, which may come
      // after the POST), `alerts` (stop alerts turned on or off).
      if (b?.ride != null) {
        const err = checkRide(ride.trip, b.ride, t);
        if (err) return reply(res, 400, { error: err });
        ride.ride = { legs: b.ride.legs, boardedAt: b.ride.boardedAt };
      }
      const aErr = activityError(b?.activity);
      if (aErr) return reply(res, 400, { error: aErr });
      if (b?.alerts != null && typeof b.alerts !== 'boolean') return reply(res, 400, { error: 'alerts is invalid' });
      if (b?.activity && b.activity.token !== ride.activity?.token) ride.activity = { token: b.activity.token, last: null, sent: 0 };
      if (b?.alerts != null) ride.alerts = b.alerts;
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

  // ---------- auto-route: timed from now ----------

  // Each candidate as a trip (its walks: a point's from the option, else the app's), its legs'
  // predictions and next-2-hours schedules (each distinct leg fetched once, through the shared
  // cache), and its first catchable row, timed on its last leg. `options`: the timed ones, ranked (timedOptions); none
  // within the window: the untimed ones with `none`; MBTA failing: the untimed ones with
  // `timedError`.
  async function timePlans(candidates, from, to, walks, t) {
    const untimed = candidates.slice(0, 3);
    if (!candidates.length) return { options: [] };
    const w = scheduleWindow(t, 5, TIMED_WINDOW_MIN);
    const win = { 'filter[date]': w.date, 'filter[min_time]': w.minTime, 'filter[max_time]': w.maxTime };
    const docs = new Map(); // leg query -> Promise<[predictions, schedules]>
    const legDocs = l => {
      const query = legQuery(l);
      const k = JSON.stringify(query);
      if (!docs.has(k)) docs.set(k, Promise.all([mbta('/predictions', query), mbta('/schedules', { ...query, ...win })]));
      return docs.get(k);
    };
    try {
      const rows = await Promise.all(candidates.map(async o => {
        const wb = typeof from.ends === 'string' ? walks.wb : o.walkBefore;
        const wa = typeof to.ends === 'string' ? walks.wa : o.walkAfter;
        const trip = formToTrip(optionToForm(o, '', '', wb, wa));
        const transit = tripShape(trip).transit;
        const got = await Promise.all(transit.map(legDocs));
        // Timed on the last leg: earlier legs take the latest vehicle that still makes it (the
        // same arrival, leaving as late as possible, not waiting 45 min at Oak Grove for the 132).
        const row = rowsFromDocs(trip, got.map(d => d[0]), got.map(d => d[1]), transit.length - 1, t, walks.slack, 3).find(r => !r.missed);
        return row && row.firstDep <= t + TIMED_WINDOW_MIN * MIN ? row : null;
      }));
      const options = timedOptions(candidates, rows, TIMED_CANDIDATES);
      return options.length ? { options, timed: true } : { options: untimed, none: true };
    } catch (e) {
      log(`timed plan: ${e.message}`);
      return { options: untimed, timedError: true };
    }
  }

  // ---------- auto-route place search ----------

  // Up to MAX_PLACES { name, detail, lat, lon }: Photon, else (failed or nothing found) Nominatim;
  // null when both fail.
  // Stops and stations are left out (the picker lists them itself).
  async function searchPlaces(query, t) {
    const get = async u => {
      const r = await fetch(u, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(PLACES_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    let photonOk = false;
    try {
      // 15: transit stops and road pieces are dropped (no lang: "en" lost Fenway Park).
      const qs = new URLSearchParams({ q: query, limit: '15', lat: '42.36', lon: '-71.06', bbox: PLACES_BBOX.join(',') });
      const found = photonPlaces(await get(`${PHOTON}?${qs}`));
      photonOk = true;
      // Nothing but stops (600 Main St, Melrose isn't in OSM as an address): Nominatim may
      // still find the street.
      if (found.length) return found;
    } catch (e) { log(`places: Photon ${e.message}`); }
    if (t - nominatimAt < 1000) return photonOk ? [] : null;
    nominatimAt = t;
    try {
      const qs = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', limit: '10', viewbox: PLACES_BBOX.join(','), bounded: '1' });
      return nominatimPlaces(await get(`${NOMINATIM}?${qs}`));
    } catch (e) { log(`places: Nominatim ${e.message}`); return null; }
  }

  // ---------- auto-route network ----------

  // The network for /plan: built on first use and daily after (3 MBTA requests; see
  // transitNetwork). A failed rebuild keeps the old one and tries again in NETWORK_RETRY_MS.
  async function transit(t) {
    if (network && t - network.at < DAY) return network.net;
    building ??= buildNetwork(t)
      // Without the ride-time sample (distance only), tried again sooner.
      .then(({ net, partial }) => { network = { net, at: partial ? now() - DAY + NETWORK_RETRY_MS : now() }; plans.clear(); return net; })
      .finally(() => { building = null; });
    try {
      return await building;
    } catch (e) {
      if (!network) throw e;
      log(`network rebuild failed (kept the old one): ${e.message}`);
      network.at = t - DAY + NETWORK_RETRY_MS;
      return network.net;
    }
  }

  // Large one-off documents, not kept in the MBTA cache.
  async function networkDoc(path, params) {
    const qs = new URLSearchParams(params);
    if (apiKey) qs.set('api_key', apiKey);
    const res = await fetch(`${API}${path}?${qs}`, { headers: { Accept: 'application/vnd.api+json' }, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`MBTA ${path}: HTTP ${res.status}`);
    return res.json();
  }

  async function buildNetwork(t) {
    const routes = await networkDoc('/routes', {
      'filter[type]': '0,1,3', 'fields[route]': 'short_name,long_name,type,color,direction_destinations,sort_order',
    });
    const ids = routes.data.map(r => r.id).join(',');
    const patterns = await networkDoc('/route_patterns', {
      'filter[route]': ids, include: 'representative_trip.stops',
      'fields[route_pattern]': 'direction_id,canonical,typicality', 'fields[trip]': '', 'fields[stop]': 'name,latitude,longitude',
    });
    // Ride minutes from a weekday's midday trips; without them, distance at typical speeds.
    let sample = null;
    try {
      sample = await networkDoc('/schedules', {
        'filter[route]': ids, 'filter[date]': nextWeekday(t), 'filter[min_time]': '11:00', 'filter[max_time]': '13:00',
        'fields[schedule]': 'departure_time,stop_sequence',
      });
    } catch (e) { log(`network schedules: ${e.message}`); }
    const net = transitNetwork(routes, patterns, sample);
    log(`network: ${net.patterns.length} patterns, ${Object.keys(net.stops).length} stops${sample ? '' : ' (no ride-time sample)'}`);
    return { net, partial: !sample };
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

  // Sends a push and logs it (sent or failed) for the phone's "Pending notifications"; rethrows.
  async function sendLogged(sub, ref, tripName, payload, t) {
    const entry = { at: t, ref, kind: payload.kind, tripName: tripName ?? null, title: payload.title, body: payload.body };
    // A failed log write never turns a sent push into a failed one.
    const record = extra => { try { store.logPush(sub.endpoint, { ...entry, ...extra }, t - DAY, LOG_MAX); } catch (e) { log(`push log: ${e.message}`); } };
    try {
      await send(sub, sub.endpoint.startsWith(APNS_PREFIX) ? apnsPush(payload) : declarativePush(payload, publicUrl));
    } catch (e) {
      const why = e.statusCode === 410 ? 'gone' : e.statusCode === 404 ? 'not found' : e.message;
      record({ ok: false, error: `${e.statusCode ?? ''} ${why ?? ''}`.trim().slice(0, 200) });
      throw e;
    }
    record({ ok: true });
  }

  // `step`: an update's { was, earlier } (a later time replaces the notification quietly).
  async function push(rem, kind, row, t, step = {}) {
    const { title, body } = reminderText(kind, rem.tripName, row, t, step.was);
    try {
      await sendLogged(rem.subscription, rem.id, rem.tripName, { kind, title, body, tag: rem.key, renotify: !step.update || step.earlier }, t);
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
    rem.lastCheckAt = t;
    const row = rowsFromDocs(rem.trip, docs.predictions, docs.schedules, rem.timingIdx, t, rem.stopSlackMinutes).find(r => r.key === rem.key) ?? null;
    const step = reminderStep(rem, row, t);
    rem.leaveBy = step.leaveBy;
    rem.missing = step.missing;
    rem.headsUps = step.headsUps;
    delete rem.headsUp;
    if (step.action === 'leave' || step.action === 'cancelled') {
      await push(rem, step.action, row, t);
      return drop(rem);
    }
    if (step.action === 'expire') return drop(rem);
    if (step.action === 'headsUp' || step.action === 'update') {
      rem.sent = { leaveBy: step.leaveBy };
      if (!(await push(rem, step.action, row, t, step))) return drop(rem);
    }
    // Poll again in time for the next notification.
    const due = rem.headsUps.length ? rem.leaveBy - Math.max(...rem.headsUps) * MIN : rem.leaveBy;
    const next = t + reminderPollMs(rem.leaveBy, t);
    rem.nextPollAt = due > t ? Math.min(next, due) : next;
    return false;
  }

  // A ride's Live Activity push (to the activity's own token, through the same send). False when
  // it failed; a dead token (410) drops the activity. Failures go to the phone's push log.
  async function sendActivity(rec, payload, t) {
    try {
      await send({ endpoint: `${APNS_PREFIX}${rec.activity.token}` }, payload);
      if (rec.activity.error) rec.activity = { ...rec.activity, error: null };
      return true;
    } catch (e) {
      const error = `${e.statusCode ?? ''} ${e.reason ?? e.message ?? ''}`.trim().slice(0, 200);
      log(`activity ${payload.body.aps.event} for ${rec.id} failed: ${error}`);
      try { store.logPush(rec.subscription.endpoint, { at: t, ref: rec.id, kind: 'activity', tripName: rec.tripName ?? null, title: `Live Activity ${payload.body.aps.event}`, body: payload.body.aps['content-state'].title, ok: false, error }, t - DAY, LOG_MAX); } catch {}
      rec.activity = e.statusCode === 410 ? null : { ...rec.activity, error };
      return false;
    }
  }

  // The ride is over: the card shows "Arrived ~<eta>" and is dismissed 5 min after the ETA.
  async function activityEnd(rec, ride, walkAfter, t) {
    if (!rec.activity) return;
    const phase = ridePhase(ride, walkAfter, t);
    const state = liveActivityState(ride, { ...phase, kind: 'arrived' }, null, null, walkAfter, t);
    await sendActivity(rec, apnsActivityPush({ event: 'end', state, nowMs: t, dismissAt: Math.max(t, phase.eta) + 5 * MIN }), t);
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
    const outlook = transferOutlook(ride, phase, tripVehicles(transit, maps, null, t), transfers, t);
    let stops = null;
    if (phase.kind === 'riding') {
      try { stops = rideStops(await mbta('/predictions', rideStopsQuery(ride.legs[phase.leg].tripId)), transit[phase.leg].alight, t); } catch (e) {
        log(`${rec.id}: ${e.message}`); // the time fallback applies
      }
    }
    const step = rideAlertStep(rec.alert, ride, phase, stops, outlook, t);
    if (step.done) {
      await activityEnd(rec, ride, walkAfter, t);
      return drop(rec);
    }
    for (const s of rec.alerts === false ? [] : step.sends) {
      const stopName = stops?.stops[stops.stops.length - 1]?.name;
      const { title, body } = rideAlertText(s, { ride, outlook, stopName, walkAfter, nowMs: t });
      const tag = s.kind === 'missed' || s.kind === 'none' ? `ride:${rec.id}:plan` : `ride:${rec.id}:${s.leg}`;
      try {
        await sendLogged(rec.subscription, rec.id, rec.tripName, { kind: s.kind, title, body, tag, renotify: !s.update || s.earlier }, t);
        log(`sent ${s.kind} (leg ${s.leg}) for ${rec.id}`);
      } catch (e) {
        log(`send ${s.kind} for ${rec.id} failed: ${e.statusCode ?? ''} ${e.message}`);
        if (e.statusCode === 404 || e.statusCode === 410) return drop(rec);
      }
    }
    if (rec.activity) {
      const state = liveActivityState(ride, phase, stops, outlook, walkAfter, t);
      const last = rec.activity.last;
      if (JSON.stringify(state) !== JSON.stringify(last)) {
        // Urgent (priority 10, a budget iOS limits): "get off" and a missed or no connection.
        const urgent = (/^(Next stop|Get off)/.test(state.title) && !/^(Next stop|Get off)/.test(last?.title ?? '')) || (state.warn && !last?.warn);
        const ok = await sendActivity(rec, apnsActivityPush({ event: 'update', state, nowMs: t, urgent }), t);
        if (ok) rec.activity = { ...rec.activity, last: state, sent: (rec.activity.sent ?? 0) + 1 };
        else if (!rec.activity && rec.alerts === false) return drop(rec); // the activity is gone: nothing left to follow for
      }
    }
    rec.alert = step.alert;
    rec.lastCheckAt = t;
    rec.ride = { ...ride, legs: outlook && (outlook.missedDep != null || outlook.earlier) ? outlook.legs : ride.legs };
    rec.nextPollAt = t + RIDE_POLL_MS;
    return false;
  }

  async function sendTests(t) {
    const due = tests.filter(x => x.at <= t);
    tests = tests.filter(x => x.at > t);
    for (const x of due) {
      try {
        await sendLogged(x.subscription, 'test', null, { kind: 'test', ...testPushText(t), tag: 'test' }, t);
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
