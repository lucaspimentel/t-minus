// Stop alerts: a tracked ride is posted to the push server (stubbed at https://push.test; Push
// API stubbed too), updated when its vehicles change and deleted on Cancel. Without permission
// the ride card offers "Turn on stop alerts". Home to office: bus 132 7:08 → 7:22, Orange
// 7:32 → 7:47 (every 6 min).
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, riding } from './helpers.js';

const PUSH = 'https://push.test';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

// The Push API with notification permission `permission` (a tap's prompt grants it).
function pushStub() {
  return ({ server, permission }) => {
    localStorage.setItem('t-minus:push-server', JSON.stringify(server));
    window.notificationPermission = permission;
    Object.defineProperty(window.Notification, 'permission', { configurable: true, get: () => window.notificationPermission });
    window.Notification.requestPermission = async () => (window.notificationPermission = 'granted');
    const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } };
    const pushManager = { getSubscription: async () => null, subscribe: async () => ({ toJSON: () => sub }) };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager }) });
  };
}

async function fakeServer(page) {
  const calls = [];
  await page.context().route(`${PUSH}/**`, async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    calls.push({ method: req.method(), path, body: req.postDataJSON?.() ?? null });
    if (path === '/vapid') return route.fulfill({ json: { publicKey: 'BAAA' } });
    if (req.method() === 'POST') return route.fulfill({ status: 201, json: { id: 'ride1' } });
    return route.fulfill({ status: 204 });
  });
  return calls;
}

const card = page => page.locator('.row.ride');
const rideCalls = calls => calls.filter(c => c.path.startsWith('/rides'));

async function ride(page, permission) {
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub(), { server: PUSH, permission });
  await openApp(page, { time: '07:00' });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:09');
  await expect(page.locator('.ride-head')).toHaveText(riding('Bus 132')); // off at 7:22am
  return calls;
}

test('with notifications allowed, the ride is posted, updated on a vehicle change, and deleted on Cancel', async ({ page }) => {
  const calls = await ride(page, 'granted');
  await expect.poll(() => rideCalls(calls).map(c => `${c.method} ${c.path}`)).toEqual(['POST /rides']);
  const post = rideCalls(calls)[0].body;
  expect(post.subscription.endpoint).toBe('https://push.example/1');
  expect(post.tripName).toBe('Home to office');
  expect(post.ride.legs.map(l => l.tripId)).toEqual(['132in-0708', 'OLin-0732']);
  expect(post.ride.legs[1].every).toBe('6'); // no Orange predictions: the server shows "~" times too
  expect(post.ride.boardedAt).toBe(Date.parse('2026-10-05T07:08:00-04:00'));
  await expect(card(page).getByRole('button', { name: 'Turn on stop alerts' })).toHaveCount(0);
  // On the Orange Line, a different train: the server's copy is updated.
  await tickTo(page, '07:39');
  await card(page).getByRole('button', { name: 'Different train?' }).click();
  await card(page).getByRole('button', { name: 'Orange ~7:38am' }).click();
  await tick(page, 1000);
  await expect.poll(() => rideCalls(calls).at(-1)).toMatchObject({ method: 'PUT', path: '/rides/ride1' });
  expect(rideCalls(calls).at(-1).body.ride.legs[1].dep).toBe(Date.parse('2026-10-05T07:38:00-04:00'));
  await card(page).getByRole('button', { name: 'Cancel trip' }).click();
  await expect.poll(() => rideCalls(calls).at(-1)).toMatchObject({ method: 'DELETE', path: '/rides/ride1' });
});

test('without permission, "Turn on stop alerts" asks for it, then the ride is posted', async ({ page }) => {
  const calls = await ride(page, 'default');
  const btn = card(page).getByRole('button', { name: 'Turn on stop alerts' });
  await expect(btn).toBeVisible();
  expect(rideCalls(calls)).toEqual([]);
  await btn.click();
  await tick(page, 1000);
  await expect.poll(() => rideCalls(calls).map(c => `${c.method} ${c.path}`)).toEqual(['POST /rides']);
  await expect(btn).toHaveCount(0);
});

test('with notifications denied, no button and nothing posted', async ({ page }) => {
  const calls = await ride(page, 'denied');
  await tick(page, 2000);
  await expect(card(page).getByRole('button', { name: 'Turn on stop alerts' })).toHaveCount(0);
  expect(rideCalls(calls)).toEqual([]);
});

test('deleting a ride\'s alerts in Pending notifications keeps them off until Turn on stop alerts', async ({ page }) => {
  const calls = await ride(page, 'granted');
  await expect.poll(() => rideCalls(calls).map(c => `${c.method} ${c.path}`)).toEqual(['POST /rides']);
  await page.locator('#open-setup').click();
  await page.locator('#setup').getByRole('button', { name: 'Pending notifications' }).click();
  // No subscription on this stub: the ride's alert is the app's own copy only.
  const localCard = page.locator('#setup .card.pn.warn');
  await expect(localCard.locator('.det')).toHaveText('The server isn\'t following this ride (lost or already done).');
  await localCard.getByRole('button', { name: 'Delete stop alerts for Home to office' }).click();
  await expect(localCard).toHaveCount(0);
  await page.locator('#setup').getByRole('button', { name: 'Back' }).click();
  await page.locator('#setup-done').click();
  await tick(page, 30_000);
  expect(rideCalls(calls).map(c => `${c.method} ${c.path}`)).toEqual(['POST /rides', 'DELETE /rides/ride1']); // not posted again
  await card(page).getByRole('button', { name: 'Turn on stop alerts' }).click();
  await expect.poll(() => rideCalls(calls).map(c => `${c.method} ${c.path}`)).toEqual(['POST /rides', 'DELETE /rides/ride1', 'POST /rides']);
  await expect(card(page).getByRole('button', { name: 'Turn on stop alerts' })).toHaveCount(0);
});
