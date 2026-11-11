// Setup saves keep tracking (2026-11-11): per-trip state follows the trip's id. Same legs: kept,
// the server's copies renamed; a started trip whose legs change or that is deleted continues as
// the one-off; the rest is dropped. Saving a trip with another's legs notes it. Home to office:
// bus 132 7:08 → 7:22, Orange 7:32 → 7:47; the one-off: Oak Grove → State on the Orange Line.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, at, pickOption } from './helpers.js';

const PUSH = 'https://push.test';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

// The Push API, notifications allowed.
function pushStub() {
  return ({ server }) => {
    localStorage.setItem('t-minus:push-server', JSON.stringify(server));
    Object.defineProperty(window.Notification, 'permission', { configurable: true, get: () => 'granted' });
    window.Notification.requestPermission = async () => 'granted';
    const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } };
    const pushManager = { getSubscription: async () => ({ toJSON: () => sub }), subscribe: async () => ({ toJSON: () => sub }) };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager }) });
  };
}

// The push server: rides are ride1, reminders r1; the planner's timed answer for Oak Grove → State.
const TIMED_OAK_STATE = () => ({ from: 'Oak Grove', to: 'State', timed: true, options: [{
  legs: [{ route: 'Orange', also: [], direction_id: 0, stop: 'place-ogmnl', alight: 'place-state', stopName: 'Oak Grove', alightName: 'State', stops: 8 }],
  transfers: [], minutes: 15, walkBefore: 0, walkAfter: 0, leave: at('07:02'), arrive: at('07:28'),
  deps: [{ dep: at('07:08'), arr: at('07:23'), source: 'scheduled' }],
}] });
async function fakeServer(page) {
  const calls = [];
  await page.context().route(`${PUSH}/**`, async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    calls.push({ method: req.method(), path, url: req.url(), body: req.postDataJSON?.() ?? null });
    const cors = { 'access-control-allow-origin': '*' };
    if (path === '/vapid') return route.fulfill({ json: { publicKey: 'BAAA' }, headers: cors });
    if (path === '/bells') return route.fulfill({ json: { bells: [] }, headers: cors });
    if (path === '/plan') return route.fulfill({ json: TIMED_OAK_STATE(), headers: cors });
    if (req.method() === 'POST' && path === '/rides') return route.fulfill({ status: 201, json: { id: 'ride1' }, headers: cors });
    if (req.method() === 'POST' && path === '/reminders') return route.fulfill({ status: 201, json: { id: 'r1', headsUps: [10, 5] }, headers: cors });
    return route.fulfill({ status: 204, headers: cors });
  });
  return calls;
}

const setup = page => page.locator('#setup');
const button = (page, name) => setup(page).getByRole('button', { name, exact: true });
const toast = page => page.locator('#toast');
const banner = page => page.locator('#oneoff');
const stored = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k)), key);
const at2 = (calls, method, prefix) => calls.filter(c => c.method === method && c.path.startsWith(prefix));

async function pickStation(page, field, query, name) {
  await setup(page).locator(`#plan-${field}`).click();
  await setup(page).locator('#picker-search').fill(query);
  await setup(page).locator('.list .item', { hasText: name }).first().click();
}
// "Plan a trip…" → Oak Grove → State → See departures: the one-off.
async function goSomewhere(page) {
  await page.getByRole('button', { name: 'Plan a trip…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await expect(setup(page)).toContainText('Pick one to see its departures or save it');
  await pickOption(page, 0, 'See departures');
  await tick(page, 1000);
}
async function start(page) {
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub(), { server: PUSH });
  await openApp(page, { time: '07:00' });
  return calls;
}
// Boards the shown trip's first ride ("At the stop", then its departure).
async function board(page, time) {
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, time);
  await expect(page.locator('.row.ride')).toBeVisible();
}
async function editTrip(page, i) {
  await page.locator('#open-setup').click();
  await setup(page).locator('.trip-row .item').nth(i).click();
}

test('a ride on a saved one-off: renamed with a longer walk in setup, it keeps going; the server gets the new name', async ({ page }) => {
  const calls = await start(page);
  await goSomewhere(page);
  await board(page, '07:02:30');
  await expect.poll(() => at2(calls, 'POST', '/rides').length).toBe(1);
  const ref = (await stored(page, 't-minus:one-off')).trip.id;
  await banner(page).getByRole('button', { name: 'Save' }).click();
  await expect(toast(page)).toHaveText(/^Trip saved/);
  await editTrip(page, 2);
  await setup(page).getByLabel('Trip name').fill('To work');
  await setup(page).getByLabel('Minutes from last stop').fill('12');
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row .item b')).toHaveText(['Home to office', 'Office to home', 'To work']);
  await page.locator('#setup-done').click();
  await expect(page.locator('.row.ride')).toBeVisible();
  expect(Object.keys(await stored(page, 't-minus:en-route'))).toEqual([ref]);
  await expect.poll(() => at2(calls, 'PUT', '/rides/ride1').find(c => c.body?.tripName)?.body).toMatchObject({ tripName: 'To work', trip: { id: ref, name: 'To work' } });
  expect(at2(calls, 'PUT', '/rides/ride1').find(c => c.body?.tripName).body.trip.legs.at(-1)).toEqual({ kind: 'walk', minutes: 12 });
  expect(at2(calls, 'DELETE', '/rides')).toEqual([]);
});

test('a riding trip whose legs change in setup continues as the one-off, with its own id', async ({ page }) => {
  const calls = await start(page);
  await board(page, '07:09');
  await expect.poll(() => at2(calls, 'POST', '/rides').length).toBe(1);
  const before = (await stored(page, 't-minus:config')).trips[0];
  await editTrip(page, 0);
  await setup(page).getByRole('button', { name: 'Change leg 2' }).click();
  await button(page, 'Remove leg').click();
  await button(page, 'Save').click();
  await page.locator('#setup-done').click();
  await expect(page.locator('.row.ride')).toBeVisible();
  await expect(banner(page)).toBeVisible();
  await expect(page.locator('#toggle select option:checked')).toHaveText('Home to office (one-off)');
  const { trip } = await stored(page, 't-minus:one-off');
  expect(trip).toEqual({ ...before, id: trip.id });
  expect(trip.id).not.toBe('home');
  const saved = (await stored(page, 't-minus:config')).trips[0];
  expect([saved.id, saved.legs.filter(l => l.kind === 'transit').length]).toEqual(['home', 1]);
  expect(Object.keys(await stored(page, 't-minus:en-route'))).toEqual([trip.id]);
  expect(at2(calls, 'DELETE', '/rides')).toEqual([]);
  // The saved trip, edited, shows no ride.
  await page.locator('#toggle select').selectOption('0');
  await expect(page.locator('.row.ride')).toHaveCount(0);
});

test('a riding trip deleted in setup continues as the one-off; Undo makes it the saved trip again', async ({ page }) => {
  const calls = await start(page);
  await board(page, '07:09');
  await expect.poll(() => at2(calls, 'POST', '/rides').length).toBe(1);
  await editTrip(page, 0);
  await button(page, 'Delete trip').click();
  expect((await stored(page, 't-minus:one-off')).trip.id).toBe('home');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(2);
  expect(await stored(page, 't-minus:one-off')).toBeNull();
  await page.locator('#setup-done').click();
  await expect(page.locator('.row.ride')).toBeVisible();
  await expect(banner(page)).toBeHidden();
  expect(Object.keys(await stored(page, 't-minus:en-route'))).toEqual(['home']);
  expect(at2(calls, 'DELETE', '/rides')).toEqual([]);
});

test('deleting a belled trip in setup cancels its reminder (no leave card kept)', async ({ page }) => {
  const calls = await start(page);
  await tickTo(page, '06:50');
  await page.locator('.row').first().click();
  await page.locator('.row').first().getByRole('button', { name: 'Track', exact: true }).click();
  await expect.poll(() => at2(calls, 'POST', '/reminders').length).toBe(1);
  await editTrip(page, 0);
  await button(page, 'Delete trip').click();
  await expect.poll(() => at2(calls, 'DELETE', '/reminders/r1').map(c => c.url)).toEqual([`${PUSH}/reminders/r1`]);
  expect(await stored(page, 't-minus:en-route') ?? {}).toEqual({});
  expect(await stored(page, 't-minus:reminders') ?? {}).toEqual({});
});

test('a trip with the same legs as another is saved, with a note', async ({ page }) => {
  await start(page);
  await goSomewhere(page);
  await banner(page).getByRole('button', { name: 'Save' }).click();
  await expect(toast(page)).toHaveText('Trip saved');
  await goSomewhere(page);
  await banner(page).getByRole('button', { name: 'Save' }).click();
  await expect(toast(page)).toHaveText("Trip saved · same legs as 'Oak Grove → State'");
  expect((await stored(page, 't-minus:config')).trips).toHaveLength(4);
  // In setup: saving one notes the other.
  await editTrip(page, 3);
  await setup(page).getByLabel('Trip name').fill('Downtown');
  await button(page, 'Save').click();
  await expect(setup(page)).toContainText("Same legs as 'Oak Grove → State'");
});
