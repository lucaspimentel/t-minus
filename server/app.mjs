// Leave-time reminders: the HTTP API and the polling loop; also setup's "Show nearby" (/nearby).
// No npm imports, so tests load it directly; main.mjs wires in web-push, the store, and the clock.
import { randomUUID } from 'node:crypto';
import {
  validateConfig, tripShape, legQuery, scheduleWindow, rowsFromDocs, reminderStep, reminderText, reminderPollMs,
  headsUpDue, HEADS_UP_MIN, testPushText, TEST_PUSH_DELAY_MS, routeDistances, NEARBY_ME_DEGREES,
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

export function createApp({ fetch, send, store, now = Date.now, apiKey, publicKey, allowedOrigins = [], log = () => {} }) {
  const schedules = new Map(); // reminder id -> { at, docs }
  const hits = new Map(); // ip -> { minute, count }
  let tests = []; // pending test notifications: { subscription, at }
  const nearbyStopsCache = new Map(); // cell -> { at, stops }
  const nearbySetCache = new Map(); // stop ids + hour -> { routeIds, schedules }
  let ticking = false;

  async function mbta(path, params) {
    const qs = new URLSearchParams(params);
    if (apiKey) qs.set('api_key', apiKey);
    const res = await fetch(`${API}${path}?${qs}`, { headers: { Accept: 'application/vnd.api+json' } });
    if (!res.ok) throw new Error(`MBTA ${path}: HTTP ${res.status}`);
    return res.json();
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

  async function handle(req, res) {
    const t = now();
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return reply(res, 403, { error: 'Origin not allowed' });
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      return reply(res, 204, undefined, { ...cors, 'access-control-allow-methods': 'GET, POST, DELETE', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
    }
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    if (limited(ip, t)) return reply(res, 429, { error: 'Too many requests' }, cors);
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true, reminders: store.count() }, cors);
    if (req.method === 'GET' && url.pathname === '/vapid') return reply(res, 200, { publicKey }, cors);
    if (req.method === 'GET' && url.pathname === '/nearby') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!(lat >= 41.5 && lat <= 43.5 && lon >= -72.5 && lon <= -69.5)) return reply(res, 400, { error: 'lat/lon must be near Boston' }, cors);
      return reply(res, 200, await nearby(lat, lon, t), cors);
    }

    let body;
    if (req.method === 'POST') {
      try { body = JSON.parse(await readBody(req)); } catch (e) { return reply(res, e.status ?? 400, { error: e.status ? 'Body too large' : 'Invalid JSON' }, cors); }
    }

    // The setup's test notification, sent TEST_PUSH_DELAY_MS later; one pending per subscription.
    if (req.method === 'POST' && url.pathname === '/test-push') {
      if (!validSubscription(body?.subscription)) return reply(res, 400, { error: 'subscription is invalid' }, cors);
      if (tests.length >= MAX_TESTS || tests.some(x => x.subscription.endpoint === body.subscription.endpoint)) {
        return reply(res, 429, { error: 'A test notification is already on its way' }, cors);
      }
      tests.push({ subscription: body.subscription, at: t + TEST_PUSH_DELAY_MS });
      return reply(res, 202, { at: t + TEST_PUSH_DELAY_MS }, cors);
    }

    if (req.method === 'POST' && url.pathname === '/reminders') {
      const err = checkReminder(body, t);
      if (err) return reply(res, 400, { error: err }, cors);
      if (store.countFor(body.subscription.endpoint) >= MAX_PER_SUBSCRIPTION) {
        return reply(res, 429, { error: `At most ${MAX_PER_SUBSCRIPTION} reminders at a time` }, cors);
      }
      const rem = {
        id: randomUUID(), subscription: body.subscription, trip: body.trip, tripName: body.tripName ?? body.trip.name,
        stopSlackMinutes: body.stopSlackMinutes ?? 1, timingIdx: body.timingIdx, key: body.key,
        leaveBy: body.leaveBy, headsUp: headsUpDue(body.leaveBy, t), missing: 0, nextPollAt: t, createdAt: t,
      };
      store.add(rem);
      log(`reminder ${rem.id} for ${rem.key}, leave by ${new Date(rem.leaveBy).toISOString()}`);
      return reply(res, 201, { id: rem.id, headsUp: rem.headsUp }, cors);
    }

    const m = url.pathname.match(/^\/reminders\/([\w-]{1,64})$/);
    if (req.method === 'DELETE' && m) {
      const found = store.delete(m[1]);
      schedules.delete(m[1]);
      return reply(res, found ? 204 : 404, undefined, cors);
    }
    return reply(res, 404, { error: 'Not found' }, cors);
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

  async function fetchDocs(rem, t) {
    const transit = tripShape(rem.trip).transit;
    const predictions = await Promise.all(transit.map(l => mbta('/predictions', legQuery(l))));
    let cached = schedules.get(rem.id);
    if (!cached || t - cached.at >= SCHEDULE_TTL) {
      // Wide enough to still hold the ride when it is hours away.
      const w = scheduleWindow(t, 30, Math.max(360, Math.ceil((rem.leaveBy - t) / MIN) + 120));
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
    try { docs = await fetchDocs(rem, t); } catch (e) {
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
      for (const rem of store.due(now())) {
        if (!(await check(rem))) store.update(rem);
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
