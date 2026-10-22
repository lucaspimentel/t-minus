// The bell: leave-time reminders through the push server (stubbed here at https://push.test;
// Push API stubbed too). Home to office at 6:50: the 7:08 bus 132 means leave by 7:02.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo } from './helpers.js';

const PUSH = 'https://push.test';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

// The Push API (permission, the service worker's pushManager) and the push server's address.
function pushStub({ supported = true, server = PUSH } = {}) {
  return ({ supported, server }) => {
    if (server != null) localStorage.setItem('t-minus:push-server', JSON.stringify(server));
    if (!supported) { delete window.PushManager; return; }
    // Not yet asked (the headless shell says 'denied', which pins without notifications).
    Object.defineProperty(window.Notification, 'permission', { configurable: true, get: () => 'default' });
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
    if (req.method() === 'POST') return route.fulfill({ status: 201, json: { id: 'r1', headsUps: [10, 5] }, headers: cors });
    return route.fulfill({ status: 204, headers: cors });
  });
  return calls;
}

const firstRow = page => page.locator('.row').first();

// The bell ("🔔 Track"): pins the ride and sets its reminders where notifications work.
const bell = (row, name = 'Track') => row.getByRole('button', { name, exact: true });

test('the bell sets a reminder: Tracking on the button, a bell on the collapsed row; tap again to cancel', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await bell(firstRow(page)).click();
  const on = firstRow(page).locator('.track-btn.on');
  await expect(on).toHaveText('Tracking');
  await expect(on).toHaveAttribute('aria-pressed', 'true');
  await expect(firstRow(page)).toHaveClass(/tracked/);
  const post = calls.find(c => c.method === 'POST');
  expect(post.path).toBe('/reminders');
  expect(post.body).toMatchObject({ key: '132in-0708', timingIdx: 0, tripName: 'Home to office', leaveBy: Date.parse('2026-10-05T07:02:00-04:00'), stopSlackMinutes: 1 });
  expect(post.body.subscription.endpoint).toBe('https://push.example/1');
  expect(post.body.trip.legs).toHaveLength(5);
  // Collapsed, a bell beside the badge; other rows have none.
  await firstRow(page).locator('.big').click();
  await expect(firstRow(page).locator('.summary .bell')).toHaveCount(1);
  await expect(page.locator('.row').nth(1).locator('.bell')).toHaveCount(0);
  // Kept across a reload, also past the leave-by (until the boarding question closes).
  await page.reload();
  await page.locator('.row').first().waitFor();
  await tick(page, 12 * 60_000 + 1000); // 7:02:01
  await expect(firstRow(page).locator('.summary .bell')).toHaveCount(1);
  await firstRow(page).click();
  await bell(firstRow(page), 'Tracking').click();
  await expect(bell(firstRow(page))).toBeVisible();
  await expect(page.locator('.bell, .row.tracked')).toHaveCount(0);
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/reminders/r1' });
});

test('one bell at a time: another departure\'s bell cancels the first one\'s reminder', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await bell(firstRow(page)).click();
  await expect(firstRow(page).locator('.track-btn.on')).toHaveCount(1);
  const second = page.locator('.row').nth(1);
  await second.click();
  await bell(second).click();
  await expect.poll(() => calls.some(c => c.method === 'DELETE' && c.path === '/reminders/r1')).toBe(true);
  await expect.poll(() => calls.filter(c => c.method === 'POST' && c.path === '/reminders').length).toBe(2);
  await expect(page.locator('.row.tracked')).toHaveCount(1);
  await expect(page.locator('.track-btn.on')).toHaveCount(1);
});

test('without push (a Safari tab), the bell pins only, with a hint; without a server, too', async ({ page }) => {
  await page.addInitScript(pushStub(), { supported: false, server: PUSH });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await expect(firstRow(page).locator('.push-hint')).toHaveCount(0);
  await bell(firstRow(page)).click();
  await expect(firstRow(page).locator('.track-btn.on')).toHaveText('Tracking');
  await expect(firstRow(page).locator('.push-hint')).toHaveText('Notifications are off: tracking in the app only. Add to Home Screen to get them.');
});

test('no push server configured: the bell pins only', async ({ page }) => {
  await page.addInitScript(pushStub(), { supported: true, server: '' });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await bell(firstRow(page)).click();
  await expect(firstRow(page).locator('.push-hint')).toHaveText('Notifications are off: tracking in the app only.');
  await expect(page.locator('#enroute')).toContainText('Tracking');
});

test('a server error shows a toast with Retry; the pin stays', async ({ page }) => {
  await page.context().route(`${PUSH}/**`, route => route.fulfill({ status: 500, json: { error: 'trip is invalid' }, headers: { 'access-control-allow-origin': '*' } }));
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await bell(firstRow(page)).click();
  await expect(page.locator('#toast')).toContainText("Couldn't set the reminder: trip is invalid");
  await expect(bell(firstRow(page), 'Tracking')).toBeEnabled();
  await expect(firstRow(page).locator('.summary .bell')).toHaveCount(0);
});

test('reminders from before the bell ("Notify me", no pin) are cancelled at load', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('t-minus:reminders', JSON.stringify({ '0/132in-0708': { id: 'old', leaveBy: Date.now() + 600_000, headsUps: [5], timingIdx: 0, key: '132in-0708' } }));
    }
  });
  await openApp(page, { time: '06:50' });
  await expect.poll(() => calls.some(c => c.method === 'DELETE' && c.path === '/reminders/old')).toBe(true);
  await expect(page.locator('.bell')).toHaveCount(0);
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
  await setReminder(page, firstRow(page));
  await page.locator('#open-setup').click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Delete all trips and settings' }).click();
  await expect.poll(() => calls.some(c => c.method === 'DELETE' && c.path === '/reminders/r1')).toBe(true);
});

async function setReminder(page, row) {
  await row.click();
  await bell(row).click();
  await expect(row.locator('.track-btn.on')).toBeVisible();
  await expect(row.locator('.summary .bell, .track-btn.on')).toHaveCount(1);
}
const posted = calls => calls.some(c => c.method === 'POST' && c.path === '/reminders');

for (const name of ['Leaving now', 'At the stop']) {
  test(`${name} with the bell keeps its reminder, marked started (no more leave alerts)`, async ({ page }) => {
    const calls = await fakeServer(page);
    await page.addInitScript(pushStub(), { supported: true, server: PUSH });
    await openApp(page, { time: '06:50' });
    await setReminder(page, firstRow(page));
    await expect.poll(() => posted(calls)).toBe(true);
    await page.locator('#enroute').getByRole('button', { name, exact: true }).click();
    await expect.poll(() => calls.some(c => c.method === 'PUT' && c.path === '/reminders/r1')).toBe(true);
    // The at-stop time: now, or now + the 5-min walk (the page clock runs on: within a minute).
    const atStop = calls.find(c => c.method === 'PUT').body.started.atStop - Date.parse(`2026-10-05T${name === 'At the stop' ? '06:50' : '06:55'}:00-04:00`);
    expect(atStop >= 0 && atStop < 60_000).toBe(true);
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    await expect(page.locator('.track-btn.on')).toHaveCount(1);
  });
}

test('answering the boarding question deletes the reminder (Yes boards)', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await openApp(page, { time: '06:50' });
  await setReminder(page, firstRow(page));
  await expect.poll(() => posted(calls)).toBe(true);
  await tickTo(page, '07:08:30');
  await expect(page.locator('#enroute')).toContainText('Did you get on the 7:08am Bus 132?');
  expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  await page.locator('#enroute').getByRole('button', { name: 'Yes' }).click();
  await expect(page.locator('.row.ride')).toHaveCount(1);
  await expect.poll(() => calls.some(c => c.method === 'DELETE' && c.path === '/reminders/r1')).toBe(true);
});

test('I got on cancels the reminders; its Undo sets them again', async ({ page }) => {
  // Office to home at 5:43pm (see rides-more.spec.js): a reminder on the next ride, then the 5:41pm train.
  const calls = await fakeServer(page);
  await page.addInitScript(pushStub(), { supported: true, server: PUSH });
  await openApp(page, { time: '17:43' });
  const row = page.locator('.row:not(.missed)').first();
  await setReminder(page, row);
  await expect.poll(() => posted(calls)).toBe(true);
  const post = calls.find(c => c.method === 'POST' && c.path === '/reminders');
  await page.locator('#rows').getByRole('button', { name: 'Show previous rides ▾', exact: true }).click();
  await page.locator('.row.prev', { hasText: '5:41pm' }).locator('.row-toggle').click();
  await page.getByRole('button', { name: 'I got on the 5:41pm Orange' }).click();
  await expect.poll(() => calls.some(c => c.method === 'DELETE' && c.path === '/reminders/r1')).toBe(true);
  await page.locator('#toast').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => calls.filter(c => c.method === 'POST' && c.path === '/reminders').length).toBe(2);
  const again = calls.filter(c => c.method === 'POST' && c.path === '/reminders')[1];
  expect(again.body).toMatchObject({ key: post.body.key, leaveBy: post.body.leaveBy, timingIdx: post.body.timingIdx });
  await expect(page.locator('.row.ride')).toHaveCount(0);
  await expect(page.locator('.row.tracked')).toHaveCount(1);
});
