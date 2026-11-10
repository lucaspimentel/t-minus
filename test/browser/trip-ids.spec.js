// Trip ids (2026-11-10): per-trip state is keyed by each trip's id. The first load of a config
// without ids gives its trips ids and clears everything stored by trip position (a clean start),
// deleting what the server held for it.
import { test, expect } from '@playwright/test';
import { openApp, CONFIG } from './helpers.js';

const PUSH = 'https://push.test';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

async function fakeServer(page) {
  const calls = [];
  await page.context().route(`${PUSH}/**`, async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    calls.push({ method: req.method(), path });
    const cors = { 'access-control-allow-origin': '*' };
    if (path === '/vapid') return route.fulfill({ json: { publicKey: 'BAAA' }, headers: cors });
    if (path === '/bells') return route.fulfill({ json: { bells: [] }, headers: cors });
    if (req.method() === 'POST') return route.fulfill({ status: 201, json: { id: 'r1', headsUps: [10, 5] }, headers: cors });
    return route.fulfill({ status: 204, headers: cors });
  });
  return calls;
}

const NO_IDS = { ...CONFIG, trips: CONFIG.trips.map(({ id: _, ...t }) => t) };
const stored = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k)), key);

test('the first load without trip ids: ids assigned, position-keyed state cleared, its server entries deleted', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(({ server }) => {
    localStorage.setItem('t-minus:push-server', JSON.stringify(server));
    Object.defineProperty(window.Notification, 'permission', { configurable: true, get: () => 'granted' });
    const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } };
    const pushManager = { getSubscription: async () => ({ toJSON: () => sub }), subscribe: async () => ({ toJSON: () => sub }) };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager }) });
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const now = Date.now();
    localStorage.setItem('t-minus:reminders', JSON.stringify({ '0/132in-0708': { id: 'r0', leaveBy: now + 600_000, dep: now + 900_000, headsUps: [5], timingIdx: 0, key: '132in-0708', bell: true } }));
    localStorage.setItem('t-minus:en-route', JSON.stringify({ 0: { kind: 'track', at: now, pinned: true, bell: true, name: 'Home to office', target: { key: '132in-0708', legs: [] }, alert: { id: 'ride0' } } }));
    localStorage.setItem('t-minus:trip-override', JSON.stringify({ index: 1, setAt: now }));
    localStorage.setItem('t-minus:last-trip', '1');
  }, { server: PUSH });
  await openApp(page, { time: '07:00', config: NO_IDS });
  const ids = (await stored(page, 't-minus:config')).trips.map(t => t.id);
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(id).toMatch(/^t[0-9a-z]{8}$/);
  expect(ids[0]).not.toBe(ids[1]);
  for (const k of ['t-minus:en-route', 't-minus:trip-override', 't-minus:last-trip']) expect(await stored(page, k)).toBeNull();
  expect(await stored(page, 't-minus:reminders') ?? {}).toEqual({});
  await expect.poll(() => calls.filter(c => c.method === 'DELETE').map(c => c.path).sort()).toEqual(['/reminders/r0', '/rides/ride0']);
  await expect(page.locator('.bell')).toHaveCount(0);
  // The override is gone: the 7:00 window's trip, not the one picked by hand.
  await expect(page.locator('#toggle button[aria-pressed="true"]')).toHaveText('Home to office');

  // Reloaded: ids are there, nothing is cleared again.
  await page.evaluate(id => localStorage.setItem('t-minus:last-trip', JSON.stringify(id)), ids[1]);
  await page.reload();
  await page.locator('.row').first().waitFor();
  expect((await stored(page, 't-minus:config')).trips.map(t => t.id)).toEqual(ids);
  expect(await stored(page, 't-minus:last-trip')).toBe(ids[1]);
});

test('per-trip state follows the trip id: a bell is stored under it and survives a reload', async ({ page }) => {
  await openApp(page, { time: '06:50' });
  await page.locator('.row').first().click();
  await page.locator('.row').first().getByRole('button', { name: 'Track', exact: true }).click();
  await expect.poll(async () => Object.keys(await stored(page, 't-minus:en-route') ?? {})).toEqual(['home']);
  await page.reload();
  await page.locator('.row').first().waitFor();
  await expect(page.locator('.row.tracked')).toHaveCount(1);
  expect(Object.keys(await stored(page, 't-minus:en-route'))).toEqual(['home']);
});
