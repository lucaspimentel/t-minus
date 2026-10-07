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
  const mbtaFetch = async url => {
    const u = new URL(url);
    world.calls.push(u.pathname);
    await world.gate;
    if (world.failing) return { ok: false, status: 500 };
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
    if (route === 'Orange' && u.pathname === '/predictions' && world.orange2) data.push(rec('prediction', 'o2', 'place-ogmnl', world.orange2), rec('prediction', 'o2', 'place-state', '07:56'));
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
    return { ok: true, json: async () => ({ data, included }) };
  };
  const sent = [];
  world.sendStatus = null;
  const send = async (sub, payload) => {
    if (world.sendStatus) throw Object.assign(new Error('gone'), { statusCode: world.sendStatus });
    sent.push(payload);
  };
  const dir = await mkdtemp(join(tmpdir(), 'leave-by-'));
  const store = openStore(dir);
  const app = createApp({ fetch: mbtaFetch, send, store, now: () => world.clock, publicKey: 'PUB', staticRoot });
  const server = createServer(app.handler);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, origin = null, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(origin && { origin }), ...headers }, body: body && JSON.stringify(body),
  });
  return { world, sent, store, dir, app, call, close: () => new Promise(r => server.close(r)).then(() => store.close()) };
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
    // The next hour: the stop list is reused, routes and schedules fetched again.
    s.world.clock = at('08:01');
    await s.call('GET', '/api/nearby?lat=42.4385&lon=-71.0711');
    assert.deepEqual(s.world.calls.slice(3), ['/routes', '/schedules']);
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
    assert.deepEqual(s.sent.at(-1), { kind: 'getOff', title: 'Next stop: Oak Grove · get off', body: 'Then Orange Line 7:33am · 3 min to spare', tag: `ride:${id}:0` });
    // The planned train leaves before the bus gets in (7:25 + 5): re-planned to o2.
    s.world.clock = at('07:24');
    s.world.orange = '07:28';
    await s.app.tick();
    assert.deepEqual(s.sent.at(-1), { kind: 'missed', title: 'Missed the 7:28am Orange', body: 'Next: Orange 7:39am · arrive 8:06am', tag: `ride:${id}:plan` });
    assert.deepEqual(s.store.get(id).ride.legs.map(l => l.tripId), ['b1', 'o2']);
    s.world.clock = at('07:25');
    await s.app.tick();
    assert.equal(s.sent.length, 3); // not again
    // On o2 with no stop list: get off 2 min before its arrival.
    s.world.clock = at('07:54');
    await s.app.tick();
    assert.deepEqual(s.sent.at(-1), { kind: 'getOff', title: 'Next stop: get off', body: 'Arrive ~8:06am', tag: `ride:${id}:1` });
    s.world.clock = at('07:57');
    await s.app.tick();
    assert.equal(s.store.get(id), null);
    assert.equal(s.sent.length, 4);
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
