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
// is refused), 'register' (iOS reports a registration error) or 'activity' (iOS refuses the Live
// Activity). Calls land in window.nativeCalls; Live Activity calls in window.activityCalls (the
// activity's push token follows a start by 50 ms).
// `leave` (Phase 3a): the plugin has the leave-card methods (liveActivityStartToken, and
// liveActivityList from window.fakeActivities); window.emitStartToken(token) fires its event.
// `widget` (Phase 3b): the plugin has widgetSave; its bodies land in window.widgetBodies.
function capacitorStub({ server, permission = 'prompt', fail = null, token, leave = false, widget = false }) {
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
  window.activityCalls = [];
  const TMinus = {
    keepAwake: async ({ on }) => { window.nativeCalls.push(`keepAwake:${on}`); },
    addListener: async (ev, f) => {
      (listeners[`TMinus.${ev}`] ??= []).push(f);
      return { remove: async () => {} };
    },
    liveActivityStart: async ({ tripName, state }) => {
      window.activityCalls.push({ call: 'start', tripName, state });
      if (fail === 'activity') throw new Error('Live Activities are off for this app');
      setTimeout(() => emit('TMinus.activityToken', { id: 'act1', token: 'CD'.repeat(40) }), 50);
      return { id: 'act1' };
    },
    liveActivityUpdate: async ({ id, state }) => { window.activityCalls.push({ call: 'update', id, state }); },
    liveActivityEnd: async ({ id }) => { window.activityCalls.push({ call: 'end', id }); },
    ...(leave && {
      liveActivityStartToken: async () => ({ token: 'EF'.repeat(40) }),
      liveActivityList: async () => ({ activities: window.fakeActivities ?? [] }),
    }),
    ...(widget && { widgetSave: async ({ body }) => { (window.widgetBodies ??= []).push(JSON.parse(body)); } }),
  };
  window.emitStartToken = t => emit('TMinus.startToken', { token: t });
  // A tap on a notification's action (`actionId`: 'tap', 'yes', 'missed').
  window.emitAction = (actionId, data) => emit('pushNotificationActionPerformed', { actionId, notification: { data } });
  window.Capacitor = { isNativePlatform: () => true, Plugins: { PushNotifications, TMinus } };
}

async function fakeServer(page, { appLog = [] } = {}) {
  const calls = [];
  await page.context().route(`${PUSH}/**`, async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    calls.push({ method: req.method(), path, search: new URL(req.url()).search, body: req.postDataJSON?.() ?? null });
    const cors = { 'access-control-allow-origin': '*' };
    if (path === '/reminders') return route.fulfill({ status: 201, json: { id: 'r1', headsUps: [10, 5] }, headers: cors });
    if (path === '/rides') return route.fulfill({ status: 201, json: { id: 'ride1' }, headers: cors });
    if (path.startsWith('/rides/') || path.startsWith('/reminders/')) return route.fulfill({ status: 204, headers: cors });
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
  await firstRow(page).getByRole('button', { name: 'Track', exact: true }).click();
  await tick(page, 200); // the token arrives 50 ms after register()
}

test('the bell asks iOS for permission, registers, and posts the device token; no Home Screen hint, no service worker', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, token: TOKEN });
  await openApp(page, { time: '06:50' });
  await firstRow(page).click();
  await expect(page.locator('.push-hint')).toHaveCount(0);
  await firstRow(page).getByRole('button', { name: 'Track', exact: true }).click();
  await tick(page, 200);
  await expect(firstRow(page).locator('.track-btn.on')).toHaveText('Tracking');
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

test('the widget\'s request goes to the shared keychain on open, when the trip choice or the next ride changes, and on return; not on every redraw', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, widget: true });
  await openApp(page, { time: '06:50' });
  const bodies = () => page.evaluate(() => window.widgetBodies ?? []);
  await expect.poll(async () => (await bodies()).length).toBe(1);
  const [first] = await bodies();
  expect(first.trips.map(t => t.name)).toEqual(['Home to office', 'Office to home']);
  expect(first).toMatchObject({ stopSlackMinutes: 1, oneOffAt: null, override: null });
  await tick(page, 3000);
  expect(await bodies()).toHaveLength(1);
  await page.locator('#toggle button', { hasText: 'Office to home' }).click();
  await expect.poll(async () => (await bodies()).length).toBe(2);
  expect((await bodies())[1]).toMatchObject({ override: { index: 1 }, lastUsed: 1 });
  await tick(page, 3000);
  expect(await bodies()).toHaveLength(2); // the other trip's next ride is a new baseline, not a change
  // Back in the app: rewritten (reloading the widget), the request unchanged.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(async () => (await bodies()).length).toBe(3);
  expect((await bodies())[2]).toEqual((await bodies())[1]);
  // The shown next ride changing (the first one left): rewritten too.
  const n = (await bodies()).length;
  await tickTo(page, '07:30');
  await expect.poll(async () => (await bodies()).length).toBeGreaterThan(n);
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

// Live Activities: the tracked ride on the Lock Screen. Home to office from 7:00: "At the stop",
// the 7:08 bus 132 boards, the Orange Line connection.
const activityCalls = page => page.evaluate(() => window.activityCalls);
const ridePosts = calls => calls.filter(c => c.path === '/rides' || c.path.startsWith('/rides/'));
async function boardTheBus(page) {
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tickTo(page, '07:12');
}

test('a tracked ride starts a Live Activity, updates it when its content changes, sends its token with the ride, and Done ends it', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN });
  await openApp(page, { time: '07:00' });
  await boardTheBus(page);
  await expect.poll(async () => (await activityCalls(page))[0]?.call).toBe('start');
  const [start] = await activityCalls(page);
  expect(start.tripName).toBe('Home to office');
  expect(start.state).toMatchObject({ phase: 'riding', label: '132', color: 'FFC72C' });
  expect(start.state.title).toMatch(/^Bus 132/);
  // The token reaches the server with the ride (alerts on: notifications are allowed).
  await expect.poll(() => ridePosts(calls).some(c => c.body?.activity?.token === 'cd'.repeat(40))).toBe(true);
  expect(ridePosts(calls).filter(c => c.method !== 'DELETE').every(c => c.body.alerts === true)).toBe(true);
  // Updated only when the content changes (the stops left, the transfer), never twice the same.
  await tickTo(page, '07:27');
  await expect.poll(async () => (await activityCalls(page)).filter(c => c.call === 'update').at(-1)?.state.phase).toBe('transfer');
  expect((await activityCalls(page)).filter(c => c.call === 'update').at(-1).state).toMatchObject({ title: 'Orange', sub: expect.stringMatching(/^Toward Forest Hills · ~7:32am · \d+ min to spare$/) });
  const states = [start, ...(await activityCalls(page)).filter(c => c.call === 'update')].map(c => JSON.stringify(c.state));
  expect(states.every((x, i) => i === 0 || x !== states[i - 1])).toBe(true);
  // Done (from the card once arrived) ends it at once.
  await tickTo(page, '07:58');
  await page.locator('.row.ride').getByRole('button', { name: 'Done' }).click();
  await expect.poll(async () => (await activityCalls(page)).at(-1)).toEqual({ call: 'end', id: 'act1' });
});

test('without notification permission, the ride is followed for its Live Activity only: no prompt, alerts off', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'prompt', token: TOKEN });
  await openApp(page, { time: '07:00' });
  await boardTheBus(page);
  await expect.poll(() => ridePosts(calls).length).toBeGreaterThan(0);
  const post = ridePosts(calls).find(c => c.method === 'POST');
  expect(post.body).toMatchObject({ subscription: { endpoint: `apns:${TOKEN.toLowerCase()}` }, alerts: false, activity: { token: 'cd'.repeat(40) } });
  expect(await nativeCalls(page)).not.toContain('requestPermissions');
});

test('iOS refusing the Live Activity is logged once; the ride carries on', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, fail: 'activity' });
  await openApp(page, { time: '07:00' });
  await boardTheBus(page);
  await tick(page, 5000);
  expect((await activityCalls(page)).map(c => c.call)).toEqual(['start']);
  await expect.poll(() => calls.filter(c => c.path === '/log').map(c => c.body.message)).toEqual(['start: Live Activities are off for this app']);
  await expect(page.locator('.row.ride')).toHaveCount(1);
});

// Leave cards (Phase 3a): the server starts them; the app sends its push-to-start token and takes
// a card over when the trip starts.
const leaveCalls = async page => (await activityCalls(page)).filter(c => c.id === 'leave1');

test('the bell sends the push-to-start token; a new token goes to the pending reminders; older builds post without it', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, leave: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  expect(calls.find(c => c.path === '/reminders').body.startToken).toBe('ef'.repeat(40));
  await page.evaluate(() => window.emitStartToken('AA'.repeat(40)));
  await expect.poll(() => calls.find(c => c.method === 'PUT' && c.path === '/reminders/r1')?.body).toEqual({ startToken: 'aa'.repeat(40) });
});

test('a build without the leave-card methods: the reminder posts without a start token, nothing logged', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  const post = calls.find(c => c.path === '/reminders');
  expect(post.body.subscription).toBeTruthy();
  expect(post.body.startToken).toBeUndefined();
  expect(calls.filter(c => c.path === '/log')).toEqual([]);
});

test('At the stop marks the reminder started and keeps the server\'s card as the walk card; boarding ends it before the ride card starts', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, leave: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await page.evaluate(() => { window.fakeActivities = [{ id: 'leave1', reminderId: 'r1', tripName: 'Home to office' }]; });
  await tickTo(page, '07:00');
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await expect.poll(() => calls.find(c => c.method === 'PUT' && c.path === '/reminders/r1')?.body?.started?.atStop).toBeGreaterThanOrEqual(at('07:00'));
  expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  await expect.poll(async () => (await leaveCalls(page))[0]?.call).toBe('update');
  const [walk] = await leaveCalls(page);
  expect(walk.state).toMatchObject({ phase: 'walk', title: 'Bus 132 in', island: 'Departs', join: ' ' });
  expect(walk.state.sub).toMatch(/^At the stop since 7:00am · [78] min to spare/);
  expect((await leaveCalls(page)).some(c => c.call === 'end')).toBe(false);
  await tickTo(page, '07:12'); // boarded
  await expect.poll(async () => (await activityCalls(page)).some(c => c.call === 'start')).toBe(true);
  const order = (await activityCalls(page)).map(c => (c.id === 'leave1' ? `leave:${c.call}` : c.call)).filter(c => c === 'leave:end' || c === 'start');
  expect(order.slice(0, 2)).toEqual(['leave:end', 'start']); // (the fake list still has it: ended again, harmless)
});

test('Leaving now then Cancel ends the walk card', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, leave: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await page.evaluate(() => { window.fakeActivities = [{ id: 'leave1', reminderId: 'r1', tripName: 'Home to office' }]; });
  await tickTo(page, '07:00');
  await page.locator('#enroute').getByRole('button', { name: 'Leaving now' }).click();
  await expect.poll(async () => (await leaveCalls(page))[0]?.state?.sub).toMatch(/^At the stop ~7:05am · [23] min to spare/);
  await page.locator('#enroute').getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await leaveCalls(page)).at(-1)?.call).toBe('end');
});

test('bell off: a plain DELETE (the server ends the card), and the app ends it too', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, leave: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await page.evaluate(() => { window.fakeActivities = [{ id: 'leave1', reminderId: 'r1', tripName: 'Home to office' }]; });
  await firstRow(page).locator('.track-btn.on').click();
  await expect.poll(() => calls.filter(c => c.method === 'DELETE' && c.path === '/reminders/r1').at(-1)?.search).toBe('');
  await expect.poll(async () => (await leaveCalls(page)).at(-1)?.call).toBe('end');
});

test('no card from the server: Leaving now makes no Live Activity calls', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, leave: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await tickTo(page, '07:00');
  await page.locator('#enroute').getByRole('button', { name: 'Leaving now' }).click();
  await tick(page, 2000);
  expect(await activityCalls(page)).toEqual([]);
});

test('Leaving now misses the belled bus: at its departure the walk card asks "Did you get on?"; Missed it ends it', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, leave: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await page.evaluate(() => { window.fakeActivities = [{ id: 'leave1', reminderId: 'r1', tripName: 'Home to office' }]; });
  await tickTo(page, '07:05');
  await page.locator('#enroute').getByRole('button', { name: 'Leaving now' }).click(); // at the stop ~7:10
  await expect.poll(async () => (await leaveCalls(page))[0]?.state?.phase).toBe('walk');
  await tickTo(page, '07:08:30');
  await expect.poll(async () => (await leaveCalls(page)).at(-1)?.state?.phase).toBe('ask');
  expect((await leaveCalls(page)).at(-1).state).toMatchObject({ title: 'Did you get on?', sub: 'Bus 132 toward Malden left at 7:08am', next: 'Tap to answer', island: 'Got on?' });
  await page.locator('#enroute').getByRole('button', { name: 'Missed it' }).click();
  await expect.poll(async () => (await leaveCalls(page)).at(-1)?.call).toBe('end');
  await expect.poll(() => calls.some(c => c.method === 'DELETE' && c.path === '/reminders/r1' && c.search === '')).toBe(true);
});

test('the push\'s Yes action answers the boarding question (the bell\'s trip shown); a plain tap only opens it', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await tickTo(page, '07:08:30');
  await page.evaluate(() => window.emitAction('tap', { kind: 'board', reminderId: 'r1' }));
  await tick(page, 300);
  await expect(page.locator('#enroute')).toContainText('Did you get on the 7:08am Bus 132?');
  await page.evaluate(() => window.emitAction('yes', { kind: 'board', reminderId: 'r1' }));
  await tick(page, 1000);
  await expect(page.locator('.row.ride')).toHaveCount(1);
});
