// Leave-time reminders: the HTTP API and the polling loop. No npm imports, so tests load it
// directly; main.mjs wires in web-push, the store file, and the clock.
import { randomUUID } from 'node:crypto';
import {
  validateConfig, tripShape, legQuery, scheduleWindow, rowsFromDocs, reminderStep, reminderText, reminderPollMs,
  headsUpDue, HEADS_UP_MIN,
} from '../core.js';

const MIN = 60_000;
const API = 'https://api-v3.mbta.com';
const SCHEDULE_TTL = 15 * MIN;
const MAX_AHEAD = 12 * 60 * MIN; // how far ahead a reminder may be set
const MAX_PER_SUBSCRIPTION = 5;
const RATE_LIMIT = 30; // requests per IP per minute
const MAX_BODY = 16 * 1024;
const RETRY_MS = 20_000; // after an MBTA error

export function createApp({ fetch, send, store, now = Date.now, apiKey, publicKey, allowedOrigins = [], log = () => {} }) {
  const schedules = new Map(); // reminder id -> { at, docs }
  const hits = new Map(); // ip -> { minute, count }
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

  // The request body for a new reminder, or an error message.
  function checkReminder(b, t) {
    const sub = b?.subscription;
    if (typeof sub?.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') return 'subscription is invalid';
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

    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true, reminders: store.all().length }, cors);
    if (req.method === 'GET' && url.pathname === '/vapid') return reply(res, 200, { publicKey }, cors);

    if (req.method === 'POST' && url.pathname === '/reminders') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) { return reply(res, e.status ?? 400, { error: e.status ? 'Body too large' : 'Invalid JSON' }, cors); }
      const err = checkReminder(body, t);
      if (err) return reply(res, 400, { error: err }, cors);
      if (store.all().filter(r => r.subscription.endpoint === body.subscription.endpoint).length >= MAX_PER_SUBSCRIPTION) {
        return reply(res, 429, { error: `At most ${MAX_PER_SUBSCRIPTION} reminders at a time` }, cors);
      }
      const rem = {
        id: randomUUID(), subscription: body.subscription, trip: body.trip, tripName: body.tripName ?? body.trip.name,
        stopSlackMinutes: body.stopSlackMinutes ?? 1, timingIdx: body.timingIdx, key: body.key,
        leaveBy: body.leaveBy, headsUp: headsUpDue(body.leaveBy, t), missing: 0, nextPollAt: t, createdAt: t,
      };
      store.put(rem);
      await store.save();
      log(`reminder ${rem.id} for ${rem.key}, leave by ${new Date(rem.leaveBy).toISOString()}`);
      return reply(res, 201, { id: rem.id, headsUp: rem.headsUp }, cors);
    }

    const m = url.pathname.match(/^\/reminders\/([\w-]{1,64})$/);
    if (req.method === 'DELETE' && m) {
      const found = store.delete(m[1]);
      schedules.delete(m[1]);
      if (found) await store.save();
      return reply(res, found ? 204 : 404, undefined, cors);
    }
    return reply(res, 404, { error: 'Not found' }, cors);
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
  }

  async function check(rem) {
    const t = now();
    let docs;
    try { docs = await fetchDocs(rem, t); } catch (e) {
      log(`${rem.id}: ${e.message}`);
      rem.nextPollAt = t + RETRY_MS;
      return;
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
  }

  // Checks every reminder that is due. Overlapping calls are skipped.
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const due = store.all().filter(r => r.nextPollAt <= now());
      for (const rem of due) await check(rem);
      if (due.length) await store.save();
    } finally {
      ticking = false;
    }
  }

  return {
    handler: (req, res) => handle(req, res).catch(e => { log(`error: ${e.stack}`); if (!res.headersSent) reply(res, 500, { error: 'Server error' }); }),
    tick,
  };
}
