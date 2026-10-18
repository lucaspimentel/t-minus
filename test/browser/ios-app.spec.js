// The iOS app (IOS.md): the page with a fake Capacitor bridge (window.Capacitor): APNs
// registration through PushNotifications, the device token as the subscription, keep-awake
// through the app's TMinus plugin, the app log, and no Web Push or service worker. The push
// server is stubbed at https://push.test. Home to office at 6:50: the 7:08 bus 132, leave by 7:02.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, at } from './helpers.js';

const PUSH = 'https://push.test';
const TOKEN = 'AB'.repeat(32);

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

// `permission`: the starting state ('prompt', 'granted', 'denied'); `fail`: 'deny' (the prompt
// is refused) or 'register' (iOS reports a registration error). Calls land in window.nativeCalls.
function capacitorStub({ server, permission = 'prompt', fail = null, token }) {
  localStorage.setItem('t-minus:push-server', JSON.stringify(server));
  window.nativeCalls = [];
  const listeners = {};
  let perm = permission;
  const emit = (ev, x) => (listeners[ev] ?? []).forEach(f => f(x));
  const PushNotifications = {
    checkPermissions: async () => ({ receive: perm }),
    requestPermissions: async () => {
      window.nativeCalls.push('requestPermissions');
      if (perm === 'prompt') perm = fail === 'deny' ? 'denied' : 'granted';
      return { receive: perm };
    },
    addListener: async (ev, f) => {
      (listeners[ev] ??= []).push(f);
      return { remove: async () => { listeners[ev] = listeners[ev].filter(g => g !== f); } };
    },
    register: async () => {
      window.nativeCalls.push('register');
      setTimeout(() => (fail === 'register' ? emit('registrationError', { error: 'no valid aps-environment' }) : emit('registration', { value: token })), 50);
    },
  };
  const TMinus = { keepAwake: async ({ on }) => { window.nativeCalls.push(`keepAwake:${on}`); } };
  window.Capacitor = { isNativePlatform: () => true, Plugins: { PushNotifications, TMinus } };
}

async function fakeServer(page, { appLog = [] } = {}) {
  const calls = [];
  await page.context().route(`${PUSH}/**`, async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    calls.push({ method: req.method(), path, body: req.postDataJSON?.() ?? null });
    const cors = { 'access-control-allow-origin': '*' };
    if (path === '/reminders') return route.fulfill({ status: 201, json: { id: 'r1', headsUps: [10, 5] }, headers: cors });
    if (path === '/log') return route.fulfill({ status: 204, headers: cors });
    if (path === '/log/read') return route.fulfill({ json: { lines: appLog }, headers: cors });
    if (path === '/pending') return route.fulfill({ json: { now: at('06:50'), entries: [], log: [] }, headers: cors });
    return route.fulfill({ status: 404, json: { error: 'Not found' }, headers: cors });
  });
  return calls;
}

const firstRow = page => page.locator('.row').first();
const nativeCalls = page => page.evaluate(() => window.nativeCalls);

async function notifyMe(page) {
  await firstRow(page).click();
  await firstRow(page).getByRole('button', { name: 'Notify me' }).click();
  await tick(page, 200); // the token arrives 50 ms after register()
}

test('Notify me asks iOS for permission, registers, and posts the device token; no Home Screen hint, no service worker', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, token: TOKEN });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await expect(page.locator('.push-hint')).toHaveCount(0);
  await firstRow(page).getByRole('button', { name: 'Notify me' }).click();
  await tick(page, 200);
  await expect(firstRow(page).locator('.track-btn.on')).toHaveText('6:52am · 7:02am ✕');
  const post = calls.find(c => c.path === '/reminders');
  expect(post.body.subscription).toEqual({ endpoint: `apns:${TOKEN.toLowerCase()}` });
  expect(await nativeCalls(page)).toEqual(['requestPermissions', 'register']);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:apns-token')))).toBe(TOKEN.toLowerCase());
  expect(await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations?.() ?? []).length)).toBe(0);
});

test('a registration error: a toast, and the error in the app log for this device', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, fail: 'register', token: TOKEN });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await expect(page.locator('#toast')).toContainText("Couldn't set the reminder: registration failed: no valid aps-environment");
  const log = calls.filter(c => c.path === '/log');
  expect(log).toHaveLength(1);
  expect(log[0].body).toMatchObject({ source: 'push', message: 'registration failed: no valid aps-environment' });
  expect(log[0].body.device).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls.some(c => c.path === '/reminders')).toBe(false);
});

test('notifications refused: no registration, a toast pointing to Settings', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, fail: 'deny', token: TOKEN });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await expect(page.locator('#toast')).toContainText('notifications are off for this app in Settings');
  expect(await nativeCalls(page)).toEqual(['requestPermissions']);
  expect(calls.filter(c => c.path === '/log').map(c => c.body.message)).toEqual(['notifications are off for this app in Settings']);
});

test('the screen stays on through the TMinus plugin, told only when it changes', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN });
  await openApp(page, { time: '06:50' });
  const awake = async () => (await nativeCalls(page)).filter(c => c.startsWith('keepAwake'));
  expect(await awake()).toEqual([]); // 12 min before leave-by: off (it starts 10 min before)
  await tickTo(page, '06:53');
  await page.mouse.click(5, 5); // a tap re-syncs; no second call
  await tick(page, 1000);
  expect(await awake()).toEqual(['keepAwake:true']);
});

test('Pending notifications shows the device token and the app log', async ({ page }) => {
  const calls = await fakeServer(page, { appLog: [{ at: at('06:40'), source: 'keepAwake', message: 'TMinus plugin is not implemented on ios' }] });
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN });
  await page.addInitScript(t => localStorage.setItem('t-minus:apns-token', JSON.stringify(t)), TOKEN.toLowerCase());
  await openApp(page, { time: '06:50' });
  await page.locator('#open-setup').click();
  await page.locator('#setup').getByRole('button', { name: 'Pending notifications' }).click();
  await expect(page.locator('#setup')).toContainText(`Device token …${TOKEN.toLowerCase().slice(-8)}`);
  await expect(page.locator('#setup .pn-log').last()).toContainText('keepAwake: TMinus plugin is not implemented on ios');
  expect(calls.find(c => c.path === '/pending').body.subscription).toEqual({ endpoint: `apns:${TOKEN.toLowerCase()}` });
  expect(calls.find(c => c.path === '/log/read').body.device).toMatch(/^[0-9a-f-]{36}$/);
});
