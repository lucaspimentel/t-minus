// The notification server (server/app.mjs) against a fake MBTA, a recording push sender, a temp
// store, and a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/app.mjs';
import { openStore } from '../server/store.mjs';
import { legQuery, tripShape } from '../core.js';

const at = hhmm => Date.parse(`2026-09-30T${hhmm}:00-04:00`);
const iso = hhmm => `2026-09-30T${hhmm}:00-04:00`;
const [trip] = JSON.parse(readFileSync('test/fixtures/bus-orange.json', 'utf8')).trips;

const rec = (type, tripId, stop, t) => ({
  type, attributes: { arrival_time: iso(t), departure_time: iso(t) },
  relationships: { trip: { data: { id: tripId } }, stop: { data: { id: stop } } },
});

// Bus b1 7:10 (`bus` can change) → 7:25 (schedules); Orange o1 7:33 → 7:50 (predictions; `orange` can change).
async function setup({ staticRoot = null } = {}) {
  const world = { clock: at('07:00'), bus: '07:10', orange: '07:33', orange2: null, rideStops: {}, cancelled: false, failing: false, calls: [] };
  const mbtaFetch = async (url, opts) => {
    const u = new URL(url);
    // Place search: world.photon / world.nominatim (a doc, or 'fail').
    if (u.host === 'photon.komoot.io' || u.host === 'nominatim.openstreetmap.org') {
      const which = u.host.startsWith('photon') ? 'photon' : 'nominatim';
      world.calls.push(which);
      world.placeQueries = [...(world.placeQueries ?? []), u.searchParams.get('q')];
      const doc = world[which];
      return doc === 'fail' || !doc ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => doc };
    }
    world.calls.push(u.pathname);
    await world.gate;
    if (world.failing) return { ok: false, status: world.failing === true ? 500 : world.failing };
    // Static data's Last-Modified (the MBTA sends no ETag): a matching If-Modified-Since gets 304.
    if (world.lastModified && opts?.headers?.['If-Modified-Since'] === world.lastModified) return { ok: false, status: 304 };
    const route = u.searchParams.get('filter[route]');
    let data = [];
    // "Show nearby" around Oak Grove: bus stops 5991 and 9326 and the station; 132 runs at 5991.
    if (u.searchParams.has('filter[latitude]')) {
      const stop = (id, lat, lon) => ({ type: 'stop', id, attributes: { name: id, latitude: lat, longitude: lon } });
      data = [stop('5991', 42.436927, -71.071292), stop('9326', 42.436901, -71.071145), stop('place-ogmnl', 42.43668, -71.071097)];
    }
    if (u.pathname === '/routes' && u.searchParams.has('filter[stop]')) data = [{ type: 'route', id: '132' }, { type: 'route', id: 'Orange' }];
    if (u.pathname === '/schedules' && !route) {
      if (world.nearbySchedulesFail) return { ok: false, status: 500 };
      data = [rec('schedule', 'b9', '5991', '07:20')].map(r => ({ ...r, relationships: { ...r.relationships, route: { data: { id: '132' } } } }));
    }
    if (route === '132' && u.pathname === '/schedules') data = [rec('schedule', 'b1', '25996', world.bus), rec('schedule', 'b1', '5991', '07:25')];
    if (route === 'Orange' && u.pathname === '/predictions' && !world.cancelled) data = [rec('prediction', 'o1', 'place-ogmnl', world.orange), rec('prediction', 'o1', 'place-state', '07:50')];
    // A scheduled Orange trip with no prediction (its train predicted as an ADDED trip, or not running).
    if (route === 'Orange' && u.pathname === '/schedules' && world.orangeGhost) data = [rec('schedule', 'og', 'place-ogmnl', world.orangeGhost), rec('schedule', 'og', 'place-state', '07:47')];
    // Orange schedules only (`cancelled` for no predictions): [[trip id, Oak Grove, State], ...].
    if (route === 'Orange' && u.pathname === '/schedules' && world.orangeSchedules) data = world.orangeSchedules.flatMap(([id, d, a]) => [rec('schedule', id, 'place-ogmnl', d), rec('schedule', id, 'place-state', a)]);
    if (route === 'Orange' && u.pathname === '/predictions' && world.orange2) data.push(rec('prediction', 'o2', 'place-ogmnl', world.orange2), rec('prediction', 'o2', 'place-state', '07:56'));
    // Auto-route's network (world.network): routes, route patterns with stops, the midday sample.
    const net = world.network;
    if (net && u.pathname === '/routes' && !u.searchParams.has('filter[stop]')) return { ok: true, status: 200, json: async () => ({ data: net.routes }) };
    if (net && u.pathname === '/route_patterns') return { ok: true, status: 200, json: async () => ({ data: net.patterns, included: net.included }) };
    if (net && u.pathname === '/schedules' && u.searchParams.get('filter[min_time]') === '11:00') {
      if (net.sampleFails) return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => ({ data: net.sample }) };
    }
    // A ridden vehicle's remaining stops (stop alerts): world.rideStops[tripId] = [[stop id, name, hh:mm], ...].
    const tripId = u.searchParams.get('filter[trip]');
    if (tripId) {
      const stops = world.rideStops[tripId] ?? [];
      return { ok: true, json: async () => ({
        data: stops.map(([id, , t], k) => ({ type: 'prediction', attributes: { arrival_time: iso(t), departure_time: iso(t), stop_sequence: 10 + k }, relationships: { stop: { data: { id } } } })),
        included: stops.map(([id, name]) => ({ type: 'stop', id, attributes: { name } })),
      }) };
    }
    // The bus's schedules carry its headsign (an included trip); Orange's predictions don't.
    const included = route === '132' && u.pathname === '/schedules' ? [{ type: 'trip', id: 'b1', attributes: { headsign: 'Malden' } }] : [];
    return { ok: true, status: 200, headers: { get: k => (k === 'last-modified' ? world.lastModified ?? null : null) }, json: async () => ({ data, included }) };
  };
  const sent = [];
  world.sendStatus = null;
  const send = async (sub, payload) => {
    if (world.sendStatus) throw Object.assign(new Error('gone'), { statusCode: world.sendStatus });
    sent.push(payload);
  };
  const dir = await mkdtemp(join(tmpdir(), 'leave-by-'));
  const store = openStore(dir);
  const servers = [];
  // Another app on the same store and MBTA (a restart, or other options), and a way to call it.
  const serve = async (opts = {}) => {
    const app = createApp({ fetch: mbtaFetch, send, store, now: () => world.clock, publicKey: 'PUB', staticRoot, ...opts });
    const server = createServer(app.handler);
    servers.push(server);
    await new Promise(r => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, path, body, origin = null, headers = {}) => fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(origin && { origin }), ...headers }, body: body && JSON.stringify(body),
    });
    return { app, call };
  };
  const { app, call } = await serve();
  const close = () => Promise.all(servers.map(server => new Promise(r => server.close(r)))).then(() => store.close());
  return { world, sent, store, dir, app, call, serve, close };
}

const subscription = (n = 1) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'k', auth: 'a' } });
const reminder = (extra = {}) => ({ subscription: subscription(), trip, tripName: 'Home to office', stopSlackMinutes: 1, timingIdx: 1, key: 'o1', leaveBy: at('07:04'), ...extra });

test('a reminder sends the heads-up, then "Leave now", then is gone', async () => {
  const s = await setup();
  try {
    assert.deepEqual(await (await s.call('GET', '/api/vapid')).json(), { publicKey: 'PUB' });
    s.world.clock = at('06:50');
    const res = await s.call('POST', '/api/reminders', reminder());
    assert.equal(res.status, 201);
    const { id, headsUp } = await res.json();
    assert.ok(id);
    assert.equal(headsUp, true);
    await s.app.tick();
    assert.deepEqual(s.sent, []);
    // Polls again no later than the heads-up time.
    s.world.clock = at('06:59');
    await s.app.tick();
    assert.deepEqual(s.sent.map(p => p.title), ['Leave in 5 min · Home to office']);
    assert.equal(s.sent[0].body, '132 toward Malden at 7:10am'); // the fixture has no labels; the headsign is included
    assert.equal(s.sent[0].tag, 'o1');
    s.world.clock = at('07:04');
    await s.app.tick();
    assert.deepEqual(s.sent.map(p => p.title), ['Leave in 5 min · Home to office', 'Leave now · Home to office']);
    assert.equal(s.store.all().length, 0);
  } finally { await s.close(); }
});

test('a reminder follows the ride: a later bus moves leave-by and the next poll', async () => {
  const s = await setup();
  try {
    s.world.clock = at('06:50');
    await s.call('POST', '/api/reminders', reminder());
    s.world.bus = '07:12';
    await s.app.tick();
    const [rem] = s.store.all();
    assert.equal(rem.leaveBy, at('07:06'));
    assert.equal(rem.nextPollAt, at('06:50') + 20_000); // within 20 min: every 20 s
    s.world.clock = at('07:00') + 50_000;
    await s.app.tick();
    assert.equal(s.store.all()[0].nextPollAt, at('07:01')); // not past the heads-up time
    assert.deepEqual(s.sent, []);
  } finally { await s.close(); }
});

test('after the heads-up, a leave-by moved 2+ min updates it (same tag; quiet when later)', async () => {
  const s = await setup();
  try {
    s.world.clock = at('06:44') + 30_000;
    await s.call('POST', '/api/reminders', reminder());
    await s.app.tick();
    s.world.clock = at('06:59');
    await s.app.tick();
    assert.deepEqual(s.sent.map(p => [p.kind, p.renotify]), [['headsUp', true]]);
    // The bus's schedules are refetched (15 min old): 3 min later.
    s.world.bus = '07:13';
    s.world.clock = at('07:00');
    await s.app.tick();
    assert.deepEqual(s.sent.at(-1), { kind: 'update', title: 'Leave in 7 min · Home to office', body: '132 toward Malden at 7:13am · leave by 7:07am (was 7:04am)', tag: 'o1', renotify: false });
    assert.deepEqual(s.store.all()[0].sent, { leaveBy: at('07:07') });
    s.world.clock = at('07:01');
    await s.app.tick();
    assert.equal(s.sent.length, 2); // not again
    s.world.clock = at('07:07');
    await s.app.tick();
    assert.deepEqual(s.sent.at(-1).title, 'Leave now · Home to office');
    assert.equal(s.sent.at(-1).renotify, true);
  } finally { await s.close(); }
});

test('a vanished ride is reported cancelled after three polls; MBTA errors do not count', async () => {
  const s = await setup();
  try {
    s.world.clock = at('06:40');
    await s.call('POST', '/api/reminders', reminder());
    s.world.failing = true;
    await s.app.tick();
    assert.equal(s.store.all()[0].missing, 0);
    s.world.failing = false;
    s.world.cancelled = true;
    for (let i = 0; i < 3; i++) {
      s.world.clock = s.store.all()[0]?.nextPollAt ?? s.world.clock;
      await s.app.tick();
    }
    assert.deepEqual(s.sent.map(p => p.title), ['Ride cancelled · Home to office']);
    assert.equal(s.store.all().length, 0);
  } finally { await s.close(); }
});

test('DELETE removes a reminder; a dead subscription (410) drops it', async () => {
  const s = await setup();
  try {
    s.world.clock = at('06:50');
    const { id } = await (await s.call('POST', '/api/reminders', reminder())).json();
    assert.equal((await s.call('DELETE', `/api/reminders/${id}`)).status, 204);
    assert.equal((await s.call('DELETE', `/api/reminders/${id}`)).status, 404);
    assert.equal(s.store.all().length, 0);
    await s.call('POST', '/api/reminders', reminder());
    s.world.sendStatus = 410;
    s.world.clock = at('07:00');
    await s.app.tick();
    assert.equal(s.store.all().length, 0);
  } finally { await s.close(); }
});

test('origins, validation, and per-subscription cap', async () => {
  const s = await setup();
  try {
    assert.equal((await s.call('POST', '/api/reminders', reminder(), 'https://evil.example')).status, 403);
    // Same origin only: no CORS preflight, and the old root paths are gone.
    assert.equal((await s.call('OPTIONS', '/api/reminders', undefined, 'https://evil.example')).status, 403);
    assert.equal((await s.call('POST', '/reminders', reminder())).status, 404);
    assert.equal((await s.call('POST', '/api/reminders', reminder({ leaveBy: at('06:00') }))).status, 400); // passed
    assert.equal((await s.call('POST', '/api/reminders', reminder({ timingIdx: 2 }))).status, 400);
    assert.equal((await s.call('POST', '/api/reminders', reminder({ subscription: { endpoint: 'http://x' } }))).status, 400);
    assert.equal((await s.call('POST', '/api/reminders', reminder({ trip: { name: 'x', legs: [] } }))).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/reminders', reminder())).status, 201);
    assert.equal((await s.call('POST', '/api/reminders', reminder())).status, 429);
    assert.equal((await s.call('POST', '/api/reminders', reminder({ subscription: subscription(2) }))).status, 201);
    // Set inside the heads-up window: no heads-up.
    s.world.clock = at('07:00');
    const late = await (await s.call('POST', '/api/reminders', reminder({ subscription: subscription(3) }))).json();
    assert.equal(late.headsUp, false);
  } finally { await s.close(); }
});

test('a test notification is sent 10 s later, once per subscription at a time', async () => {
  const s = await setup();
  try {
    s.world.clock = at('07:41');
    assert.equal((await s.call('POST', '/api/test-push', { subscription: subscription() }, 'https://evil.example')).status, 403);
    assert.equal((await s.call('POST', '/api/test-push', { subscription: { endpoint: 'http://x' } })).status, 400);
    assert.equal((await s.call('POST', '/api/test-push', { subscription: subscription() })).status, 202);
    assert.equal((await s.call('POST', '/api/test-push', { subscription: subscription() })).status, 429);
    s.world.clock += 9_000;
    await s.app.tick();
    assert.equal(s.sent.length, 0);
    s.world.clock += 1_000;
    await s.app.tick();
    assert.deepEqual(s.sent, [{ kind: 'test', title: 'Test notification', body: 'Push works. Sent 7:41am.', tag: 'test' }]);
    assert.equal(s.store.all().length, 0); // not stored
    assert.equal((await s.call('POST', '/api/test-push', { subscription: subscription() })).status, 202);
  } finally { await s.close(); }
});

test('reminders survive a restart', async () => {
  const s = await setup();
  try {
    s.world.clock = at('06:50');
    const { id } = await (await s.call('POST', '/api/reminders', reminder())).json();
    await s.app.tick();
    const [rem] = s.store.all();
    assert.ok(rem.nextPollAt > at('06:50'));
    const reopened = openStore(s.dir);
    try {
      assert.deepEqual(reopened.all().map(r => [r.id, r.nextPollAt]), [[id, rem.nextPollAt]]);
    } finally { reopened.close(); }
  } finally { await s.close(); }
});

test('a reminder deleted during a tick is not restored', async () => {
  const s = await setup();
  try {
    s.world.clock = at('06:50');
    const { id } = await (await s.call('POST', '/api/reminders', reminder())).json();
    let release;
    s.world.gate = new Promise(r => { release = r; });
    const ticking = s.app.tick();
    assert.equal((await s.call('DELETE', `/api/reminders/${id}`)).status, 204);
    release();
    await ticking;
    assert.equal(s.store.count(), 0);
  } finally { await s.close(); }
});

test('an old reminders.json is ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'leave-by-'));
  await writeFile(join(dir, 'reminders.json'), JSON.stringify([{ id: 'old', nextPollAt: 0 }]));
  const store = openStore(dir);
  try {
    assert.equal(store.count(), 0);
  } finally { store.close(); }
});

test('/nearby: the routes around a point with distances, cached per cell and hour', async () => {
  const s = await setup();
  try {
    const res = await s.call('GET', '/api/nearby?lat=42.4385&lon=-71.0711');
    assert.equal(res.status, 200);
    const body = await res.json();
    // 132 from its schedule at 5991 (~175 m); Orange has no schedule there (its platforms aren't in the list).
    assert.deepEqual(body.routes.map(r => r.id), ['132', 'Orange']);
    assert.ok(Math.abs(body.routes[0].meters - 175) < 10, `${body.routes[0].meters}`);
    assert.equal(Number.isInteger(body.routes[0].meters), true);
    assert.equal(body.routes[1].meters, null);
    assert.deepEqual(s.world.calls, ['/stops', '/routes', '/schedules']);
    // Again, a few meters away within the hour: no MBTA requests, distances from the new point.
    const again = await (await s.call('GET', '/api/nearby?lat=42.43852&lon=-71.0711')).json();
    assert.equal(s.world.calls.length, 3);
    assert.ok(again.routes[0].meters > body.routes[0].meters);
    // The next hour: the stop list is reused, the routes come from the proxy's static copy (a
    // day), the schedules are fetched again.
    s.world.clock = at('08:01');
    await s.call('GET', '/api/nearby?lat=42.4385&lon=-71.0711');
    assert.deepEqual(s.world.calls.slice(3), ['/schedules']);
  } finally { await s.close(); }
});

test('/nearby: bad coordinates, other origins, and failed schedules', async () => {
  const s = await setup();
  try {
    for (const q of ['', '?lat=abc&lon=1', '?lat=40.7&lon=-74', '?lat=42.4&lon=']) {
      assert.equal((await s.call('GET', `/api/nearby${q}`)).status, 400, q);
    }
    assert.equal((await s.call('GET', '/api/nearby?lat=42.4385&lon=-71.0711', undefined, 'https://evil.example')).status, 403);
    s.world.nearbySchedulesFail = true;
    const body = await (await s.call('GET', '/api/nearby?lat=42.4385&lon=-71.0711')).json();
    assert.deepEqual(body.routes, [{ id: '132', meters: null }, { id: 'Orange', meters: null }]);
    // Not kept: the next call asks for the schedules again.
    s.world.nearbySchedulesFail = false;
    const next = await (await s.call('GET', '/api/nearby?lat=42.4385&lon=-71.0711')).json();
    assert.ok(next.routes[0].meters > 0);
  } finally { await s.close(); }
});

test('the app\'s files: an allowlist from the repo root, with cache headers and ETags', async () => {
  const s = await setup({ staticRoot: process.cwd() });
  try {
    const page = await s.call('GET', '/', undefined, null);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(await page.text(), /<title>T-Minus/);
    const again = await s.call('GET', '/index.html', undefined, null, { 'if-none-match': page.headers.get('etag') });
    assert.equal(again.status, 304);
    const mod = await s.call('GET', '/core.js?v=abc', undefined, null);
    assert.equal(mod.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(mod.headers.get('content-type'), /text\/javascript/);
    assert.equal((await s.call('GET', '/sw.js', undefined, null)).headers.get('cache-control'), 'no-cache');
    assert.equal((await s.call('GET', '/icons/icon-192.png', undefined, null)).headers.get('cache-control'), 'public, max-age=86400');
    for (const p of ['/package.json', '/server/app.mjs', '/.git/config', '/%2e%2e/package.json', '/test/server.test.js', '/DESIGN.md']) {
      assert.equal((await s.call('GET', p, undefined, null)).status, 404, p);
    }
    // Loading the app doesn't count toward the API's 30 requests a minute.
    for (let i = 0; i < 40; i++) await (await s.call('GET', '/manifest.json', undefined, null)).arrayBuffer();
    assert.equal((await s.call('GET', '/api/vapid', undefined, null)).status, 200);
  } finally { await s.close(); }
});

test('the API is under /api/ (and /health at the root), same origin only', async () => {
  const s = await setup({ staticRoot: process.cwd() });
  try {
    assert.deepEqual(await (await s.call('GET', '/api/vapid')).json(), { publicKey: 'PUB' });
    assert.equal((await s.call('GET', '/api/health')).status, 200);
    assert.equal((await s.call('GET', '/api/nearby?lat=42.4385&lon=-71.0711')).status, 200);
    assert.equal((await s.call('GET', '/api/nope')).status, 404);
    assert.equal((await s.call('GET', '/health')).status, 200);
    for (const p of ['/vapid', '/nearby?lat=42.4385&lon=-71.0711']) assert.equal((await s.call('GET', p)).status, 404, p);
    const own = `http://127.0.0.1:${new URL((await s.call('GET', '/api/health')).url).port}`;
    const created = await s.call('POST', '/api/reminders', reminder(), own);
    assert.equal(created.status, 201);
    const { id } = await created.json();
    assert.equal((await s.call('DELETE', `/api/reminders/${id}`, undefined, own)).status, 204);
    const foreign = await s.call('POST', '/api/reminders', reminder(), 'https://evil.example');
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  } finally { await s.close(); }
});

// Stop alerts: bus b1 7:10 → 7:25 at Oak Grove (5991), Orange o1 7:33 → 7:50 (o2 7:39 → 7:56 when set), walk 10.
const followed = (extra = {}) => ({
  subscription: subscription(), trip, tripName: 'Home to office',
  ride: { boardedAt: at('07:10'), legs: [{ tripId: 'b1', label: 'Bus 132', dep: at('07:10'), arr: at('07:25') }, { tripId: 'o1', label: 'Orange', dep: at('07:33'), arr: at('07:50') }] },
  ...extra,
});
const busStops = (n, t) => [['s1', 'Pond St', t], ['s2', 'Elm St', t], ['s3', 'Main St', t], ['s4', 'Lynn St', t], ['5991', 'Oak Grove', '07:25']].slice(5 - n);

test('a followed ride: heads-up, get off, a missed connection, get off again, then dropped', async () => {
  const s = await setup();
  try {
    s.world.clock = at('07:12');
    s.world.orange2 = '07:39';
    const res = await s.call('POST', '/api/rides', followed());
    assert.equal(res.status, 201);
    const { id } = await res.json();
    s.world.rideStops.b1 = busStops(5, '07:15');
    await s.app.tick();
    assert.deepEqual(s.sent, []);
    assert.equal(s.store.get(id).nextPollAt, at('07:12') + 20_000);
    s.world.clock = at('07:18');
    s.world.rideStops.b1 = busStops(3, '07:20');
    await s.app.tick();
    assert.deepEqual(s.sent.map(p => [p.kind, p.title, p.body, p.tag]), [['headsUp', '3 stops to Oak Grove', 'Bus 132 · arrive 7:25am', `ride:${id}:0`]]);
    s.world.clock = at('07:22');
    s.world.rideStops.b1 = busStops(1);
    await s.app.tick();
    assert.deepEqual(s.sent.at(-1), { kind: 'getOff', title: 'Next stop: Oak Grove · get off', body: 'Then Orange Line 7:33am · 3 min to spare', tag: `ride:${id}:0`, renotify: true });
    // The planned train now leaves under the transfer time (7:25 + 5) but after the bus gets in:
    // kept, tight (the get-off alert is updated, alerting since it's earlier); no missed alert.
    s.world.clock = at('07:23');
    s.world.orange = '07:28';
    await s.app.tick();
    assert.deepEqual(s.sent.at(-1), { kind: 'getOff', title: 'Next stop: Oak Grove · get off', body: 'Then Orange Line 7:28am · tight (was 7:33am)', tag: `ride:${id}:0`, renotify: true });
    assert.deepEqual(s.store.get(id).ride.legs.map(l => l.tripId), ['b1', 'o1']);
    // It leaves before the bus gets in: re-planned to o2.
    s.world.clock = at('07:24');
    s.world.orange = '07:24';
    await s.app.tick();
    assert.deepEqual(s.sent.at(-1), { kind: 'missed', title: 'Missed the 7:24am Orange', body: 'Next: Orange 7:39am · arrive 8:06am', tag: `ride:${id}:plan`, renotify: true });
    assert.deepEqual(s.store.get(id).ride.legs.map(l => l.tripId), ['b1', 'o2']);
    s.world.clock = at('07:25');
    await s.app.tick();
    assert.equal(s.sent.length, 4); // not again
    // o2 runs 3 min late: the missed alert is updated quietly (its arrival is unchanged here).
    s.world.clock = at('07:26');
    s.world.orange2 = '07:42';
    await s.app.tick();
    assert.deepEqual(s.sent.at(-1), { kind: 'missed', title: 'Missed the 7:24am Orange', body: 'Next: Orange 7:42am (was 7:39am) · arrive 8:06am', tag: `ride:${id}:plan`, renotify: false });
    // On o2 with no stop list: get off 2 min before its arrival.
    s.world.clock = at('07:54');
    await s.app.tick();
    assert.deepEqual(s.sent.at(-1), { kind: 'getOff', title: 'Next stop: get off', body: 'Arrive ~8:06am', tag: `ride:${id}:1`, renotify: true });
    s.world.clock = at('07:57');
    await s.app.tick();
    assert.equal(s.store.get(id), null);
    assert.equal(s.sent.length, 6);
  } finally { await s.close(); }
});

test('a followed ride keeps the rider\'s pick: no switch to an earlier train, no missed alert while catchable', async () => {
  const s = await setup();
  try {
    s.world.clock = at('07:12');
    s.world.orange2 = '07:39';
    const legs = [{ tripId: 'b1', label: 'Bus 132', dep: at('07:10'), arr: at('07:25') }, { tripId: 'o2', label: 'Orange', dep: at('07:39'), arr: at('07:56'), picked: true }];
    const { id } = await (await s.call('POST', '/api/rides', followed({ ride: { boardedAt: at('07:10'), legs } }))).json();
    await s.app.tick();
    // o1 (7:33) is catchable and earlier, but o2 was picked.
    assert.deepEqual(s.store.get(id).ride.legs.map(l => [l.tripId, l.picked]), [['b1', undefined], ['o2', true]]);
    // The pick now leaves under the transfer time (7:25 + 5), after the bus gets in: kept.
    s.world.clock = at('07:20');
    s.world.orange2 = '07:27';
    await s.app.tick();
    assert.deepEqual(s.store.get(id).ride.legs.map(l => l.tripId), ['b1', 'o2']);
    assert.deepEqual(s.sent.filter(p => p.kind === 'missed'), []);
  } finally { await s.close(); }
});

test('a followed ride ignores an unpredicted scheduled train among the predicted ones (subway)', async () => {
  const s = await setup();
  try {
    s.world.clock = at('07:12');
    s.world.orange2 = '07:39';
    s.world.orangeGhost = '07:30'; // earlier than o1 (7:33) and catchable (7:25 + 5), but not predicted
    const { id } = await (await s.call('POST', '/api/rides', followed())).json();
    await s.app.tick();
    assert.deepEqual(s.store.get(id).ride.legs.map(l => l.tripId), ['b1', 'o1']);
  } finally { await s.close(); }
});

test('a followed ride on a subway leg with no predictions: "~" times in its alerts', async () => {
  const s = await setup();
  try {
    s.world.clock = at('07:12');
    s.world.cancelled = true;
    s.world.orangeSchedules = [['s1', '07:20', '07:37'], ['s2', '07:36', '07:53'], ['s3', '07:42', '07:59']];
    const legs = [{ tripId: 'b1', label: 'Bus 132', dep: at('07:10'), arr: at('07:25') }, { tripId: 's1', label: 'Orange', dep: at('07:20'), arr: at('07:37'), every: '6–16' }];
    const { id } = await (await s.call('POST', '/api/rides', followed({ ride: { boardedAt: at('07:10'), legs } }))).json();
    await s.app.tick();
    // s1 leaves before the bus gets in: re-planned onto s2, shown by the headway.
    assert.deepEqual(s.sent.find(p => p.kind === 'missed'), { kind: 'missed', title: 'Missed the 7:20am Orange', body: 'Next: Orange ~7:36am · arrive ~8:03am', tag: `ride:${id}:plan`, renotify: true });
    assert.equal(s.store.get(id).ride.legs[1].every, '6–16');
  } finally { await s.close(); }
});

// Auto-route's network: bus 132 from Main St @ South St to Washington St @ Oak Grove (30 m from
// Oak Grove's platform), the Orange Line Oak Grove → State.
function smallNetwork() {
  const stop = (id, name, lat, lon, parent = null) => ({ type: 'stop', id, attributes: { name, latitude: lat, longitude: lon }, relationships: { parent_station: { data: parent ? { id: parent } : null } } });
  const pattern = (id, route, ids, attrs) => [
    { type: 'route_pattern', id, attributes: { direction_id: 0, ...attrs }, relationships: { route: { data: { id: route } }, representative_trip: { data: { id: `rt-${id}` } } } },
    { type: 'trip', id: `rt-${id}`, relationships: { stops: { data: ids.map(x => ({ id: x })) } } },
  ];
  const pats = [pattern('p132', '132', ['25996', '5991'], { typicality: 1 }), pattern('p132o', '132', ['5991', '15982'], { typicality: 1 }), pattern('pOL', 'Orange', ['70036', '70022'], { canonical: true })];
  const sched = (trip, list) => list.map(([st, t], i) => ({ attributes: { departure_time: iso(t), stop_sequence: i + 1 }, relationships: { trip: { data: { id: trip } }, stop: { data: { id: st } } } }));
  return {
    routes: [{ type: 'route', id: '132', attributes: { type: 3, short_name: '132', direction_destinations: ['Malden', 'Redstone'] } },
      { type: 'route', id: 'Orange', attributes: { type: 1, long_name: 'Orange Line', color: 'ED8B00', direction_destinations: ['Forest Hills', 'Oak Grove'] } }],
    patterns: pats.map(p => p[0]),
    included: [...pats.map(p => p[1]), stop('25996', 'Main St @ South St', 42.45, -71.07), stop('15982', 'Main St @ South St', 42.4501, -71.0701), stop('5991', 'Washington St @ Oak Grove Sta', 42.436927, -71.071292),
      stop('70036', 'Oak Grove', 42.43668, -71.071097, 'place-ogmnl'), stop('70022', 'State', 42.358978, -71.057598, 'place-state')],
    sample: [...sched('s1', [['25996', '12:00'], ['5991', '12:14']]), ...sched('s2', [['70036', '12:20'], ['70022', '12:35']])],
  };
}

test('auto-route: the network is built from 3 MBTA requests a day; plans', async () => {
  const s = await setup();
  try {
    s.world.network = smallNetwork();
    const get = async path => { const r = await s.call('GET', path); return { status: r.status, body: await r.json() }; };
    const plan = await get('/api/plan?from=25996&to=place-state');
    assert.deepEqual(plan.body, {
      from: 'Main St @ South St', to: 'State',
      options: [{
        legs: [
          { route: '132', also: [], direction_id: 0, stop: '25996', alight: '5991', stopName: 'Main St @ South St', alightName: 'Washington St @ Oak Grove Sta' },
          { route: 'Orange', also: [], direction_id: 0, stop: 'place-ogmnl', alight: 'place-state', stopName: 'Oak Grove', alightName: 'State' },
        ],
        transfers: [{ name: 'Washington St @ Oak Grove Sta → Oak Grove', meters: 32, min: 3 }],
        minutes: 14 + 3 + 15, walkBefore: 0, walkAfter: 0,
      }],
    });
    const netCalls = () => s.world.calls.filter(c => ['/routes', '/route_patterns', '/schedules'].includes(c)).length;
    assert.equal(netCalls(), 3);
    // Bad input; the same network all day (no more requests), rebuilt the next.
    assert.equal((await get('/api/plan?from=25996&to=nowhere')).status, 400);
    // Both sides of a street: the side the route needs (15982 isn't served toward Oak Grove).
    assert.deepEqual((await get('/api/plan?from=15982,25996&to=place-state')).body.options[0].legs[0].stop, '25996');
    assert.equal((await get('/api/plan?from=a,b,c,d,25996&to=place-state')).status, 400);
    assert.equal((await get('/api/stops?q=main')).status, 404); // no stop search (the app picks by route)
    assert.equal(netCalls(), 3);
    s.world.clock += 24 * 60 * 60_000;
    s.world.network.sampleFails = true; // distance only, and a failed fetch keeps no one waiting
    assert.equal((await get('/api/plan?from=25996&to=place-state')).status, 200);
    assert.equal(netCalls(), 6);
    // A failed rebuild keeps the old network.
    s.world.clock += 24 * 60 * 60_000;
    s.world.failing = true;
    const kept = await get('/api/plan?from=25996&to=place-state');
    assert.equal(kept.status, 200);
    assert.equal(kept.body.options.length, 1);
  } finally { await s.close(); }
});

test('auto-route: plans from a point (@lat,lon) use the stops within a walk, with the walks', async () => {
  const s = await setup();
  try {
    s.world.network = smallNetwork();
    const get = async path => { const r = await s.call('GET', path); return { status: r.status, body: await r.json() }; };
    // ~40 m from Main St @ South St (25996): its walk counts and comes back.
    const plan = await get('/api/plan?from=@42.4503,-71.0703&to=place-state');
    assert.equal(plan.status, 200);
    assert.equal(plan.body.from, null); // the app names a point
    assert.equal(plan.body.to, 'State');
    assert.deepEqual(plan.body.options.map(o => [o.legs[0].stop, o.walkBefore]), [['25996', 1]]);
    assert.equal((await get('/api/plan?from=@40.7,-74.0&to=place-state')).status, 400); // not near Boston
    assert.equal((await get('/api/plan?from=@abc&to=place-state')).status, 400);
    assert.deepEqual((await get('/api/plan?from=@42.30,-71.30&to=place-state')).body.options, []); // no stop within 800 m
  } finally { await s.close(); }
});

test('places: Photon near Boston, stops left out, cached a day; Nominatim when Photon fails or finds nothing', async () => {
  const s = await setup();
  try {
    const get = async q => { const r = await s.call('GET', `/api/places?q=${encodeURIComponent(q)}`); return { status: r.status, body: await r.json() }; };
    const feature = (props, lon, lat) => ({ properties: props, geometry: { coordinates: [lon, lat] } });
    s.world.photon = { features: [
      feature({ name: 'Fenway', osm_key: 'railway', osm_value: 'halt', city: 'Boston' }, -71.1, 42.34),
      feature({ name: 'Fenway Park', osm_key: 'leisure', osm_value: 'stadium', housenumber: '4', street: 'Jersey Street', city: 'Boston' }, -71.097104, 42.346462),
      feature({ name: 'Fenway', osm_key: 'highway', osm_value: 'residential', city: 'Boston' }, -71.1, 42.345),
      feature({ name: 'Fenway', osm_key: 'highway', osm_value: 'primary', city: 'Boston' }, -71.1, 42.346), // the same street again
      feature({ osm_key: 'building', osm_value: 'yes', housenumber: '350', street: 'Washington Street', city: 'Malden' }, -71.07155, 42.43872),
      feature({ name: 'Kenmore @ Fenway', osm_key: 'highway', osm_value: 'bus_stop', city: 'Boston' }, -71.1, 42.35),
    ] };
    const r = await get('  fenway ');
    assert.deepEqual(r.body.places, [
      { name: 'Fenway Park', detail: '4 Jersey Street, Boston', lat: 42.34646, lon: -71.0971 },
      { name: 'Fenway', detail: 'street, Boston', lat: 42.345, lon: -71.1 },
      { name: '350 Washington Street', detail: 'Malden', lat: 42.43872, lon: -71.07155 },
    ]);
    assert.deepEqual(s.world.placeQueries, ['fenway']);
    await get('Fenway'); // cached (any case)
    assert.equal(s.world.calls.filter(c => c === 'photon').length, 1);
    assert.equal((await get('fe')).status, 400);
    // Photon down: Nominatim; again within a second: unavailable (its 1 request a second).
    s.world.photon = 'fail';
    s.world.nominatim = [{ name: 'Massachusetts General Hospital', category: 'amenity', type: 'hospital', lat: '42.362862', lon: '-71.068751', address: { house_number: '55', road: 'Fruit Street', city: 'Boston' } }];
    assert.deepEqual((await get('mgh')).body.places, [{ name: 'Massachusetts General Hospital', detail: '55 Fruit Street, Boston', lat: 42.36286, lon: -71.06875 }]);
    assert.equal((await get('mgh 2')).status, 502);
    // Photon with only stops: Nominatim's street.
    s.world.clock += 2000;
    s.world.photon = { features: [feature({ name: 'Main St @ Grove St', osm_key: 'highway', osm_value: 'bus_stop', city: 'Melrose' }, -71.06, 42.45)] };
    s.world.nominatim = [{ name: 'Main Street', category: 'highway', type: 'primary', lat: '42.45465', lon: '-71.06556', address: { road: 'Main Street', city: 'Melrose' } }];
    assert.deepEqual((await get('600 Main St Melrose')).body.places, [{ name: 'Main Street', detail: 'street, Melrose', lat: 42.45465, lon: -71.06556 }]);
    // Both down: 502, nothing cached.
    s.world.clock += 2000;
    s.world.nominatim = 'fail';
    s.world.photon = 'fail';
    assert.equal((await get('assembly row')).status, 502);
  } finally { await s.close(); }
});

test('auto-route: no network yet and the MBTA failing: 503', async () => {
  const s = await setup();
  try {
    s.world.failing = true;
    assert.equal((await s.call('GET', '/api/plan?from=a&to=b')).status, 503);
  } finally { await s.close(); }
});

test('rides: validation, PUT replaces the legs, DELETE, a dead subscription drops it', async () => {
  const s = await setup();
  try {
    s.world.clock = at('07:12');
    assert.equal((await s.call('POST', '/api/rides', followed(), 'https://evil.example')).status, 403);
    assert.equal((await s.call('POST', '/api/rides', followed({ subscription: { endpoint: 'http://x' } }))).status, 400);
    assert.equal((await s.call('POST', '/api/rides', followed({ ride: { boardedAt: 1, legs: [] } }))).status, 400);
    const { id } = await (await s.call('POST', '/api/rides', followed())).json();
    const moved = followed().ride;
    moved.legs[1] = { tripId: 'o2', label: 'Orange', dep: at('07:39'), arr: at('07:56') };
    assert.equal((await s.call('PUT', `/api/rides/${id}`, { ride: moved }, 'https://evil.example')).status, 403);
    assert.equal((await s.call('PUT', `/api/rides/${id}`, { ride: { legs: [] } })).status, 400);
    assert.equal((await s.call('PUT', `/api/rides/${id}`, { ride: moved })).status, 204);
    assert.deepEqual(s.store.get(id).ride.legs.map(l => l.tripId), ['b1', 'o2']);
    assert.equal((await s.call('PUT', '/api/rides/nope', { ride: moved })).status, 404);
    assert.equal((await s.call('DELETE', `/api/rides/${id}`)).status, 204);
    assert.equal((await s.call('DELETE', `/api/rides/${id}`)).status, 404);
    // A reminder's id isn't a ride.
    const rem = await (await s.call('POST', '/api/reminders', reminder({ leaveBy: at('07:30') }))).json();
    assert.equal((await s.call('DELETE', `/api/rides/${rem.id}`)).status, 404);
    // 410 from the push service: dropped.
    const r2 = await (await s.call('POST', '/api/rides', followed({ subscription: subscription(2) }))).json();
    s.world.rideStops.b1 = busStops(1);
    s.world.sendStatus = 410;
    s.world.clock = at('07:22');
    await s.app.tick();
    assert.equal(s.store.get(r2.id), null);
  } finally { await s.close(); }
});

// The Orange leg's predictions, as the app asks the proxy for them.
const orangeQuery = () => new URLSearchParams(legQuery(tripShape(trip).transit[1]));

test('/api/mbta: fresh copies are shared (with reminders too); stale copies when the MBTA fails', async () => {
  const s = await setup();
  try {
    const res = await s.call('GET', `/api/mbta/predictions?${orangeQuery()}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-data-age'), null);
    assert.equal((await res.json()).data.length, 2);
    assert.deepEqual(s.world.calls, ['/predictions']);
    // Within 10 s: the copy.
    s.world.clock += 9_000;
    assert.equal((await s.call('GET', `/api/mbta/predictions?${orangeQuery()}`)).status, 200);
    assert.equal(s.world.calls.length, 1);
    // Two at once share one call.
    s.world.clock += 2_000;
    let open;
    s.world.gate = new Promise(r => { open = r; });
    const pair = Promise.all([1, 2].map(() => s.call('GET', `/api/mbta/predictions?${orangeQuery()}`)));
    await new Promise(r => setTimeout(r, 50));
    open();
    s.world.gate = null;
    assert.deepEqual((await pair).map(r => r.status), [200, 200]);
    assert.equal(s.world.calls.length, 2);
    // A reminder's poll right after reuses the Orange copy; only the bus leg is fetched.
    s.world.clock += 11_000;
    s.world.calls = [];
    await s.call('GET', `/api/mbta/predictions?${orangeQuery()}`);
    await s.call('POST', '/api/reminders', reminder());
    await s.app.tick();
    assert.equal(s.world.calls.filter(c => c === '/predictions').length, 2); // the app's Orange, the reminder's bus
    // The MBTA fails: the copy, with its age, up to 2 min; then 502.
    s.world.failing = true;
    s.world.clock += 60_000;
    const old = await s.call('GET', `/api/mbta/predictions?${orangeQuery()}`);
    assert.equal(old.status, 200);
    assert.equal(old.headers.get('x-data-age'), '60');
    assert.equal((await old.json()).data.length, 2);
    s.world.clock += 61_000;
    assert.equal((await s.call('GET', `/api/mbta/predictions?${orangeQuery()}`)).status, 502);
    // A 429 from the MBTA (the server's key is over its limit) also gets the copy.
    s.world.failing = 429;
    s.world.clock -= 61_000;
    assert.equal((await s.call('GET', `/api/mbta/predictions?${orangeQuery()}`)).headers.get('x-data-age'), '60');
  } finally { await s.close(); }
});

test('/api/mbta: static copies survive a restart and are revalidated daily', async () => {
  const s = await setup();
  try {
    s.world.lastModified = 'Mon, 05 Oct 2026 13:58:22 GMT';
    const q = 'filter[type]=0,1,3&fields[route]=short_name';
    const first = await (await s.call('GET', `/api/mbta/routes?${q}`, null, null, { 'accept-encoding': 'gzip' })).json();
    assert.deepEqual(first.data, []);
    const restarted = await s.serve();
    s.world.clock += 23 * 60 * 60_000;
    assert.equal((await restarted.call('GET', `/api/mbta/routes?${q}`)).status, 200);
    assert.deepEqual(s.world.calls, ['/routes']);
    // A day later: revalidated (304), the copy kept; the MBTA down: the copy, however old.
    s.world.clock += 2 * 60 * 60_000;
    assert.deepEqual(await (await restarted.call('GET', `/api/mbta/routes?${q}`)).json(), first);
    assert.deepEqual(s.world.calls, ['/routes', '/routes']);
    s.world.clock += 30 * 24 * 60 * 60_000;
    s.world.failing = true;
    const res = await restarted.call('GET', `/api/mbta/routes?${q}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-data-age'), String(30 * 24 * 60 * 60));
  } finally { await s.close(); }
});

test('/api/mbta: allowlist, same origin, per-IP limit, budget guard, kill switch, MBTA 4xx', async () => {
  const s = await setup();
  try {
    const status = async (path, headers = {}, origin = null, c = s.call) => (await c('GET', path, null, origin, headers)).status;
    assert.equal(await status('/api/mbta/vehicles?filter[route]=Red'), 400);
    assert.equal(await status('/api/mbta/stops?filter[id]=x'), 400);
    assert.equal(await status('/api/mbta/stops?filter[route]=Red&api_key=k'), 400);
    assert.equal(await status('/api/mbta/stops?filter[route]=Red', { 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(await status('/api/mbta/stops?filter[route]=Red', {}, 'https://evil.example'), 403);
    assert.equal(await status('/api/mbta/stops?filter[route]=Red', { 'sec-fetch-site': 'same-origin' }), 200);
    assert.deepEqual(s.world.calls, ['/stops']);
    // An MBTA 400 is passed through, not cached.
    s.world.failing = 400;
    assert.equal(await status('/api/mbta/stops?filter[route]=Nope'), 400);
    s.world.failing = false;
    // 120 a minute per IP.
    const ip = { 'x-forwarded-for': '10.0.0.1' };
    for (let i = 0; i < 120; i++) assert.equal(await status('/api/mbta/stops?filter[route]=Red', ip), 200);
    const over = await s.call('GET', '/api/mbta/stops?filter[route]=Red', null, null, ip);
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get('retry-after')) > 0);
    s.world.clock += 60_000;
    assert.equal(await status('/api/mbta/stops?filter[route]=Red', ip), 200);
    // Past the budget: misses refused (503), copies still served.
    const tight = await s.serve({ mbtaBudget: 1 });
    assert.equal(await status('/api/mbta/stops?filter[route]=Red', {}, null, tight.call), 200); // on disk
    assert.equal(await status(`/api/mbta/predictions?${orangeQuery()}`, {}, null, tight.call), 200); // its one call
    assert.equal(await status('/api/mbta/alerts?filter[route]=Red', {}, null, tight.call), 503);
    const off = await s.serve({ proxy: false });
    assert.equal(await status('/api/mbta/stops?filter[route]=Red', {}, null, off.call), 503);
  } finally { await s.close(); }
});
