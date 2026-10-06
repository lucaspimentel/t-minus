// "Notify me": leave-time reminders through the push server (stubbed here at https://push.test;
// Push API stubbed too). Home to office at 6:50: the 7:08 bus 132 means leave by 7:02.
import { test, expect } from '@playwright/test';
import { openApp, tick } from './helpers.js';

const PUSH = 'https://push.test';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

// The Push API (permission, the service worker's pushManager) and the push server's address.
function pushStub({ supported = true, server = PUSH } = {}) {
  return ({ supported, server }) => {
    if (server != null) localStorage.setItem('t-minus:push-server', JSON.stringify(server));
    if (!supported) { delete window.PushManager; return; }
    window.Notification.requestPermission = async () => 'granted';
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
    const cors = { 'access-control-allow-origin': '*' };
    if (path === '/vapid') return route.fulfill({ json: { publicKey: 'BAAA' }, headers: cors });
    if (req.method() === 'POST') return route.fulfill({ status: 201, json: { id: 'r1', headsUp: true }, headers: cors });
    return route.fulfill({ status: 204, headers: cors });
  });
  return calls;
}

const firstRow = page => page.locator('.row').first();

test('Notify me sets a reminder: the times on the button, a bell on the collapsed row; tap again to cancel', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await firstRow(page).getByRole('button', { name: 'Notify me' }).click();
  const on = firstRow(page).locator('.track-btn.on');
  await expect(on).toHaveText('6:57am · 7:02am ✕');
  const post = calls.find(c => c.method === 'POST');
  expect(post.path).toBe('/reminders');
  expect(post.body).toMatchObject({ key: '132in-0708', timingIdx: 0, tripName: 'Home to office', leaveBy: Date.parse('2026-10-05T07:02:00-04:00'), stopSlackMinutes: 1 });
  expect(post.body.subscription.endpoint).toBe('https://push.example/1');
  expect(post.body.trip.legs).toHaveLength(5);
  // Collapsed, a bell beside the badge; other rows have none.
  await firstRow(page).locator('.big').click();
  await expect(firstRow(page).locator('.summary .bell')).toHaveCount(1);
  await expect(page.locator('.row').nth(1).locator('.bell')).toHaveCount(0);
  // Kept across a reload.
  await page.reload();
  await page.locator('.row').first().waitFor();
  await tick(page, 1000);
  await expect(firstRow(page).locator('.summary .bell')).toHaveCount(1);
  await firstRow(page).click();
  await firstRow(page).getByRole('button', { name: 'Cancel the reminder' }).click();
  await expect(firstRow(page).getByRole('button', { name: 'Notify me' })).toBeVisible();
  await firstRow(page).locator('.big').click();
  await expect(firstRow(page).locator('.bell')).toHaveCount(0);
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/reminders/r1' });
});

test('once leave-by passes, the reminder is done: no bell, no button', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await firstRow(page).getByRole('button', { name: 'Notify me' }).click();
  await expect(firstRow(page).locator('.track-btn.on')).toHaveCount(1);
  await firstRow(page).locator('.big').click();
  await expect(firstRow(page).locator('.bell')).toHaveCount(1);
  await tick(page, 12 * 60_000 + 1000); // 7:02:01
  await expect(page.locator('.bell')).toHaveCount(0);
  await firstRow(page).click();
  await expect(firstRow(page).getByRole('button', { name: 'Notify me' })).toHaveCount(0);
});

test('without push (a Safari tab), Notify me is disabled with a hint; without a server, absent', async ({ page }) => {
  await page.addInitScript(pushStub(), { supported: false, server: PUSH });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await expect(firstRow(page).getByRole('button', { name: 'Notify me' })).toBeDisabled();
  await expect(firstRow(page).locator('.push-hint')).toHaveText('Add to Home Screen to get notifications.');
});

test('no push server configured: no Notify me', async ({ page }) => {
  await page.addInitScript(pushStub(), { supported: true, server: '' });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await expect(firstRow(page).getByRole('button', { name: 'Track this trip' })).toBeVisible();
  await expect(firstRow(page).getByRole('button', { name: 'Notify me' })).toHaveCount(0);
});

test('a server error shows a toast with Retry', async ({ page }) => {
  await page.context().route(`${PUSH}/**`, route => route.fulfill({ status: 500, json: { error: 'trip is invalid' }, headers: { 'access-control-allow-origin': '*' } }));
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await firstRow(page).getByRole('button', { name: 'Notify me' }).click();
  await expect(page.locator('#toast')).toContainText("Couldn't set the reminder: trip is invalid");
  await expect(firstRow(page).getByRole('button', { name: 'Notify me' })).toBeEnabled();
});

// Setup's "Send test notification in 10 s": the server sends it; nothing is stored here.
const testButton = page => page.getByRole('button', { name: 'Send test notification in 10 s' });
async function openSetupScreen(page) {
  await page.locator('#open-setup').click();
  await page.locator('#setup-done').waitFor();
}

test('setup sends a test notification through the server', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await openApp(page, { time: '06:50' });
  await openSetupScreen(page);
  await testButton(page).click();
  await expect(page.locator('#toast span')).toHaveText('Test notification in 10 s. Lock the phone to check.');
  await expect(page.locator('#toast button')).toBeHidden();
  const post = calls.find(c => c.method === 'POST');
  expect(post).toMatchObject({ path: '/test-push', body: { subscription: { endpoint: 'https://push.example/1' } } });
});

test('setup test notification: disabled with a hint without push', async ({ page }) => {
  await page.addInitScript(pushStub(), { supported: false, server: PUSH });
  await openApp(page, { time: '06:50' });
  await openSetupScreen(page);
  await expect(testButton(page)).toBeDisabled();
  await expect(page.locator('#setup .push-hint:not(.reset-note)')).toHaveText('Add to Home Screen to get notifications.');
});

test('setup test notification: absent without a push server', async ({ page }) => {
  await page.addInitScript(pushStub(), { supported: true, server: '' });
  await openApp(page, { time: '06:50' });
  await openSetupScreen(page);
  await expect(page.locator('#setup-done')).toBeVisible();
  await expect(testButton(page)).toHaveCount(0);
});

test('Reset in setup cancels pending reminders on the server', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await firstRow(page).getByRole('button', { name: 'Notify me' }).click();
  await expect(firstRow(page).locator('.track-btn.on')).toHaveCount(1);
  await page.locator('#open-setup').click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Delete all trips and settings' }).click();
  await expect.poll(() => calls.some(c => c.method === 'DELETE' && c.path === '/reminders/r1')).toBe(true);
});
