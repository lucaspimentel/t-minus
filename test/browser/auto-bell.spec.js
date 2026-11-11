// Auto-bell: the trip editor's days and arrive-by time go to the push server (stubbed at
// https://push.test, Push API stubbed too); a bell the server set shows as belled here.
import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

const PUSH = 'https://push.test';
const at = hhmm => Date.parse(`2026-10-05T${hhmm}:00-04:00`);

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

// The Push API with a subscription already made (granted earlier), and the push server's address.
function pushStub() {
  return () => {
    localStorage.setItem('t-minus:push-server', JSON.stringify('https://push.test'));
    Object.defineProperty(window.Notification, 'permission', { configurable: true, get: () => 'granted' });
    window.Notification.requestPermission = async () => 'granted';
    const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } };
    const pushManager = { getSubscription: async () => ({ toJSON: () => sub }), subscribe: async () => ({ toJSON: () => sub }) };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager }) });
  };
}

async function fakeServer(page, bells = []) {
  const calls = [];
  await page.context().route(`${PUSH}/**`, async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    calls.push({ method: req.method(), path, body: req.postDataJSON?.() ?? null });
    const cors = { 'access-control-allow-origin': '*' };
    if (path === '/vapid') return route.fulfill({ json: { publicKey: 'BAAA' }, headers: cors });
    if (path === '/bells') return route.fulfill({ json: { bells }, headers: cors });
    if (path === '/auto-bells') return route.fulfill({ json: { next: [] }, headers: cors });
    if (req.method() === 'POST') return route.fulfill({ status: 201, json: { id: 'r1', headsUps: [60, 10, 5] }, headers: cors });
    return route.fulfill({ status: 204, headers: cors });
  });
  return calls;
}

test('setup: Tue and Thu by 10:00am saves the auto-bell, sends it to the server, and shows it in the trip list', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub());
  await openApp(page, { time: '06:50' });
  await page.locator('#open-setup').click();
  const setup = page.locator('#setup');
  await setup.locator('.trip-row .item').first().click();
  const card = setup.locator('.card.auto-bell');
  await expect(card.getByRole('button', { name: 'Tue' })).toHaveAttribute('aria-pressed', 'false');
  await card.getByRole('button', { name: 'Tue' }).click();
  await card.getByRole('button', { name: 'Thu' }).click();
  await expect(card.getByRole('button', { name: 'Thu' })).toHaveAttribute('aria-pressed', 'true');
  await card.getByLabel('Arrive by').fill('10:00');
  await setup.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(setup.locator('.trip-row').first()).toContainText('🔔 Tue Thu · by 10:00am');
  await expect(setup.locator('.trip-row').nth(1)).not.toContainText('🔔');
  await expect.poll(() => calls.find(c => c.path === '/auto-bells')?.body).toMatchObject({
    subscription: { endpoint: 'https://push.example/1' },
    trips: [{ tripRef: 'home', tripName: 'Home to office', autoBell: { days: [2, 4], arriveBy: '10:00' } }],
  });
});

test('a bell the server set shows as belled: Tracking, with its reminder kept', async ({ page }) => {
  const legs = [
    { route: '132', label: 'Bus 132', color: 'FFC72C', tripId: 'b1', dep: at('07:08'), arr: at('07:20'), source: 'schedule' },
    { route: 'Orange', label: 'Orange', color: 'ED8B00', tripId: 'o1', dep: at('07:27'), arr: at('07:45'), source: 'schedule' },
  ];
  await fakeServer(page, [{ id: 'auto1', tripRef: 'home', tripName: 'Home to office', key: '132in-0708', leaveBy: at('07:02'), dep: at('07:08'), headsUps: [60, 10, 5], timingIdx: 0, legs }]);
  await page.addInitScript(pushStub());
  await openApp(page, { time: '06:50' });
  const first = page.locator('.row').first();
  await expect(first.locator('.summary .bell')).toHaveCount(1);
  await expect(page.locator('.row').nth(1).locator('.bell')).toHaveCount(0);
  const reminders = await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:reminders')));
  expect(Object.values(reminders)).toMatchObject([{ id: 'auto1', key: '132in-0708', bell: true }]);
});
