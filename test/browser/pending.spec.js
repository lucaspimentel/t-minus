// Setup's "Pending notifications" (debug): the server's entries for this phone (stubbed at
// https://push.test) next to the app's own copies, the sent log, Delete, Clear all.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, at } from './helpers.js';

const PUSH = 'https://push.test';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

// A push subscription already set up, and the app's saved copies: reminder r1 (also on the
// server) and r9 (lost on the server).
function stub({ server, reminders }) {
  localStorage.setItem('t-minus:push-server', JSON.stringify(server));
  localStorage.setItem('t-minus:reminders', JSON.stringify(reminders));
  window.Notification.requestPermission = async () => 'granted';
  const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } };
  const pushManager = { getSubscription: async () => ({ toJSON: () => sub }), subscribe: async () => ({ toJSON: () => sub }) };
  Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager }) });
}

async function fakeServer(page) {
  const calls = [];
  const state = {
    entries: [
      { id: 'r1', kind: 'reminder', tripName: 'Home to office', createdAt: at('06:40'), lastCheckAt: at('06:49'), next: { kind: 'leave', at: at('07:02'), text: 'Leave now' }, key: '132in-0708', leaveBy: at('07:02'), headsUp: false, route: '132' },
      { id: 'ride1', kind: 'ride', tripName: 'Office to home', createdAt: at('06:30'), lastCheckAt: at('06:49'), phase: 'riding',
        next: { kind: 'getOff', at: at('06:58'), approx: true, text: 'Next stop: get off · Orange Line' },
        ride: { boardedAt: at('06:45'), legs: [{ tripId: 'OL-0645', label: 'Orange', dep: at('06:45'), arr: at('07:00'), source: 'live' }] } },
    ],
    log: [
      { at: at('06:45'), ref: 'r1', kind: 'headsUp', tripName: 'Home to office', title: 'Leave in 5 min · Home to office', body: '', ok: true },
      { at: at('06:44'), ref: 'test', kind: 'test', tripName: null, title: 'Test notification', body: '', ok: false, error: '410 gone' },
    ],
  };
  await page.context().route(`${PUSH}/**`, async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    calls.push({ method: req.method(), path, body: req.postDataJSON?.() ?? null });
    const cors = { 'access-control-allow-origin': '*' };
    if (path === '/pending') return route.fulfill({ json: { now: at('06:50'), entries: state.entries, log: state.log }, headers: cors });
    if (path === '/pending/clear') {
      const deleted = state.entries.length;
      state.entries = [];
      return route.fulfill({ json: { deleted }, headers: cors });
    }
    if (req.method() === 'DELETE') {
      state.entries = state.entries.filter(e => !path.endsWith(`/${e.id}`));
      return route.fulfill({ status: 204, headers: cors });
    }
    return route.fulfill({ status: 404, json: { error: 'Not found' }, headers: cors });
  });
  return calls;
}

const setup = page => page.locator('#setup');
const cards = page => setup(page).locator('.card.pn');

async function openPending(page) {
  await page.locator('#open-setup').click();
  await setup(page).getByRole('button', { name: 'Pending notifications' }).click();
}

test('pending notifications: server entries with sent and next pushes, local-only copies, the log; Delete, Clear all, Back', async ({ page }) => {
  const calls = await fakeServer(page);
  const reminders = {
    '0/132in-0708': { id: 'r1', leaveBy: at('07:02'), headsUp: false, timingIdx: 0, key: '132in-0708' },
    '1/OL-1735': { id: 'r9', leaveBy: at('17:29'), headsUp: true, timingIdx: 0, key: 'OL-1735' },
  };
  await page.addInitScript(stub, { server: PUSH, reminders });
  await openApp(page, { time: '06:50' });
  await openPending(page);
  expect(calls.find(c => c.path === '/pending').body.subscription.endpoint).toBe('https://push.example/1');
  await expect(setup(page).locator('.muted.section')).toHaveText(['On the server · checked 6:50am', 'Only on this phone', 'Sent · last 24 h']);
  await expect(cards(page)).toHaveCount(3);
  const r1 = cards(page).nth(0);
  await expect(r1.locator('.k')).toHaveText('Leave reminder');
  await expect(r1.locator('.t1')).toHaveText('Home to office · 132');
  await expect(r1.locator('.pn-line')).toHaveText([/^6:45am\s*✓ sent “Leave in 5 min · Home to office”$/, /^7:02am\s*next: “Leave now”$/]);
  await expect(r1.locator('.det')).toHaveText('Leave by 7:02am · row 132in-0708 · checked 6:49am');
  const ride = cards(page).nth(1);
  await expect(ride.locator('.k')).toHaveText('Stop alerts · riding');
  await expect(ride.locator('.pn-line')).toHaveText([/^~6:58am\s*next: “Next stop: get off · Orange Line”$/]);
  await expect(ride.locator('.det')).toHaveText(['OL-0645 6:45am→7:00am live · checked 6:49am', 'Not saved on this phone.']);
  const lost = cards(page).nth(2);
  await expect(lost).toHaveClass(/warn/);
  await expect(lost.locator('.t1')).toHaveText('Office to home · leave by 5:29pm');
  await expect(lost.locator('.det')).toHaveText('The server has no such reminder (lost or already done).');
  await expect(setup(page).locator('.pn-log .e')).toHaveText([/^6:45am\s*✓ sent Leave in 5 min · Home to office$/, /^6:44am\s*✕ failed: 410 gone Test notification$/]);

  // Delete: the server's DELETE, the local copy goes, the list reloads.
  await r1.getByRole('button', { name: 'Delete leave reminder for Home to office' }).click();
  await expect(cards(page)).toHaveCount(2);
  expect(calls.some(c => c.method === 'DELETE' && c.path === '/reminders/r1')).toBe(true);
  expect(Object.keys(await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:reminders'))))).toEqual(['1/OL-1735']);
  // ↻ reloads.
  const before = calls.filter(c => c.path === '/pending').length;
  await setup(page).getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => calls.filter(c => c.path === '/pending').length).toBe(before + 1);
  // Clear all (after a confirm): the server's entries and the local copies go; the log stays.
  page.once('dialog', d => d.accept());
  await setup(page).getByRole('button', { name: 'Clear all pending' }).click();
  await expect(cards(page)).toHaveCount(0);
  await expect(setup(page)).toContainText('Nothing pending.');
  expect(calls.some(c => c.path === '/pending/clear')).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:reminders')))).toEqual({});
  await expect(setup(page).locator('.pn-log .e')).toHaveCount(2);
  await setup(page).getByRole('button', { name: 'Back' }).click();
  await expect(setup(page).getByRole('button', { name: 'Pending notifications' })).toBeVisible();
});

test('pending notifications: no subscription yet says so; a server error shows Retry', async ({ page }) => {
  await page.context().route(`${PUSH}/**`, route => route.fulfill({ status: 500, json: { error: 'Server error' }, headers: { 'access-control-allow-origin': '*' } }));
  await page.addInitScript(stub, { server: PUSH, reminders: {} });
  await openApp(page, { time: '06:50' });
  await openPending(page);
  await expect(setup(page).locator('.msg.err')).toHaveText("Couldn't load: Server error");
  await expect(setup(page).getByRole('button', { name: 'Retry' })).toBeVisible();
  await page.evaluate(() => {
    const pushManager = { getSubscription: async () => null };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager }) });
  });
  await setup(page).getByRole('button', { name: 'Retry' }).click();
  await expect(setup(page).locator('.msg')).toHaveText('No notifications set up on this phone.');
});

// The a11y scan of this screen lives here (it needs the stubbed server); see a11y.spec.js.
for (const scheme of ['light', 'dark']) {
  test(`axe finds nothing on the pending notifications screen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await fakeServer(page);
    await page.addInitScript(stub, { server: PUSH, reminders: { '1/OL-1735': { id: 'r9', leaveBy: at('17:29'), headsUp: true, timingIdx: 0, key: 'OL-1735' } } });
    await openApp(page, { time: '06:50' });
    await openPending(page);
    await expect(cards(page)).toHaveCount(3);
    const found = (await new AxeBuilder({ page }).disableRules(['meta-viewport']).analyze()).violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
    expect(found).toEqual([]);
  });
}
