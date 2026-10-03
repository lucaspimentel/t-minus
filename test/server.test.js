// The notification server (server/app.mjs) against a fake MBTA, a recording push sender, a temp
// store, and a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/app.mjs';
import { openStore } from '../server/store.mjs';

const at = hhmm => Date.parse(`2026-09-30T${hhmm}:00-04:00`);
const iso = hhmm => `2026-09-30T${hhmm}:00-04:00`;
const ORIGIN = 'https://lucaspimentel.github.io';
const [trip] = JSON.parse(readFileSync('test/fixtures/bus-orange.json', 'utf8')).trips;

const rec = (type, tripId, stop, t) => ({
  type, attributes: { arrival_time: iso(t), departure_time: iso(t) },
  relationships: { trip: { data: { id: tripId } }, stop: { data: { id: stop } } },
});

// Bus b1 7:10 (`bus` can change) → 7:25 (schedules); Orange o1 7:33 → 7:50 (predictions; `orange` can change).
async function setup() {
  const world = { clock: at('07:00'), bus: '07:10', orange: '07:33', cancelled: false, failing: false, calls: [] };
  const mbtaFetch = async url => {
    const u = new URL(url);
    world.calls.push(u.pathname);
    if (world.failing) return { ok: false, status: 500 };
    const route = u.searchParams.get('filter[route]');
    let data = [];
    if (route === '132' && u.pathname === '/schedules') data = [rec('schedule', 'b1', '25996', world.bus), rec('schedule', 'b1', '5991', '07:25')];
    if (route === 'Orange' && u.pathname === '/predictions' && !world.cancelled) data = [rec('prediction', 'o1', 'place-ogmnl', world.orange), rec('prediction', 'o1', 'place-state', '07:50')];
    return { ok: true, json: async () => ({ data, included: [] }) };
  };
  const sent = [];
  world.sendStatus = null;
  const send = async (sub, payload) => {
    if (world.sendStatus) throw Object.assign(new Error('gone'), { statusCode: world.sendStatus });
    sent.push(payload);
  };
  const dir = await mkdtemp(join(tmpdir(), 'leave-by-'));
  const store = await openStore(dir);
  const app = createApp({ fetch: mbtaFetch, send, store, now: () => world.clock, publicKey: 'PUB', allowedOrigins: [ORIGIN] });
  const server = createServer(app.handler);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, origin = ORIGIN) => fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(origin && { origin }) }, body: body && JSON.stringify(body),
  });
  return { world, sent, store, dir, app, call, close: () => new Promise(r => server.close(r)) };
}

const subscription = (n = 1) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'k', auth: 'a' } });
const reminder = (extra = {}) => ({ subscription: subscription(), trip, tripName: 'Home to office', stopSlackMinutes: 1, timingIdx: 1, key: 'o1', leaveBy: at('07:04'), ...extra });

test('a reminder sends the heads-up, then "Leave now", then is gone', async () => {
  const s = await setup();
  try {
    assert.deepEqual(await (await s.call('GET', '/vapid')).json(), { publicKey: 'PUB' });
    s.world.clock = at('06:50');
    const res = await s.call('POST', '/reminders', reminder());
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    const { id, headsUp } = await res.json();
    assert.ok(id);
    assert.equal(headsUp, true);
    await s.app.tick();
    assert.deepEqual(s.sent, []);
    // Polls again no later than the heads-up time.
    s.world.clock = at('06:59');
    await s.app.tick();
    assert.deepEqual(s.sent.map(p => p.title), ['Leave in 5 min · Home to office']);
    assert.equal(s.sent[0].body, '132 at 7:10am'); // the fixture has no labels
    assert.equal(s.sent[0].tag, 'o1');
    s.world.clock = at('07:04');
    await s.app.tick();
    assert.deepEqual(s.sent.map(p => p.title), ['Leave in 5 min · Home to office', 'Leave now · Home to office']);
    assert.equal(s.store.all().length, 0);
    const saved = JSON.parse(await readFile(join(s.dir, 'reminders.json'), 'utf8'));
    assert.deepEqual(saved, []);
  } finally { await s.close(); }
});

test('a reminder follows the ride: a later bus moves leave-by and the next poll', async () => {
  const s = await setup();
  try {
    s.world.clock = at('06:50');
    await s.call('POST', '/reminders', reminder());
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
    await s.call('POST', '/reminders', reminder());
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
    const { id } = await (await s.call('POST', '/reminders', reminder())).json();
    assert.equal((await s.call('DELETE', `/reminders/${id}`)).status, 204);
    assert.equal((await s.call('DELETE', `/reminders/${id}`)).status, 404);
    assert.equal(s.store.all().length, 0);
    await s.call('POST', '/reminders', reminder());
    s.world.sendStatus = 410;
    s.world.clock = at('07:00');
    await s.app.tick();
    assert.equal(s.store.all().length, 0);
  } finally { await s.close(); }
});

test('origins, validation, and per-subscription cap', async () => {
  const s = await setup();
  try {
    assert.equal((await s.call('POST', '/reminders', reminder(), 'https://evil.example')).status, 403);
    const pre = await s.call('OPTIONS', '/reminders');
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-methods'), /DELETE/);
    assert.equal((await s.call('POST', '/reminders', reminder({ leaveBy: at('06:00') }))).status, 400); // passed
    assert.equal((await s.call('POST', '/reminders', reminder({ timingIdx: 2 }))).status, 400);
    assert.equal((await s.call('POST', '/reminders', reminder({ subscription: { endpoint: 'http://x' } }))).status, 400);
    assert.equal((await s.call('POST', '/reminders', reminder({ trip: { name: 'x', legs: [] } }))).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/reminders', reminder())).status, 201);
    assert.equal((await s.call('POST', '/reminders', reminder())).status, 429);
    assert.equal((await s.call('POST', '/reminders', reminder({ subscription: subscription(2) }))).status, 201);
    // Set inside the heads-up window: no heads-up.
    s.world.clock = at('07:00');
    const late = await (await s.call('POST', '/reminders', reminder({ subscription: subscription(3) }))).json();
    assert.equal(late.headsUp, false);
  } finally { await s.close(); }
});

test('reminders survive a restart', async () => {
  const s = await setup();
  try {
    s.world.clock = at('06:50');
    const { id } = await (await s.call('POST', '/reminders', reminder())).json();
    const reopened = await openStore(s.dir);
    assert.deepEqual(reopened.all().map(r => r.id), [id]);
  } finally { await s.close(); }
});
