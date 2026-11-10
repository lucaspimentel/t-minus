// The iOS app (IOS.md): the page with a fake Capacitor bridge (window.Capacitor): APNs
// registration through PushNotifications, the device token as the subscription, keep-awake
// through the app's TMinus plugin, the app log, and no Web Push or service worker. The push
// server is stubbed at https://push.test. Home to office at 6:50: the 7:08 bus 132, leave by 7:02.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, tick, tickTo, at, riding } from './helpers.js';

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
// liveActivityList from window.fakeActivities, liveActivityDismissed from window.fakeDismissed);
// window.emitStartToken(token) fires its event.
// `widget` (Phase 3b): the plugin has widgetSave; its bodies land in window.widgetBodies.
// `boarding` (boarding from location): the plugin has locationStatus (window.locStatus) and the
// boarding* methods, recorded in window.boardingCalls; boardingPending returns window.boardingAction
// once, boardingLog window.boardingLines; window.emitBoarding() fires the `boarding` event.
// locationAuthorize moves window.locStatus to window.authorizeTo ('always' by default).
// `locStatus`: the starting location status (boarding detection runs while it is While Using or Always).
// `perms` (setup's Permissions): the plugin has permissionsStatus (notifications from the push
// permission, window.liveActivities, window.locStatus, window.precise) and openSettings (in nativeCalls).
function capacitorStub({ server, permission = 'prompt', fail = null, token, leave = false, widget = false, boarding = false, locStatus = null, perms = false }) {
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
      liveActivityDismissed: async () => ({ activities: window.fakeDismissed ?? [] }),
    }),
    ...(widget && { widgetSave: async ({ body }) => { (window.widgetBodies ??= []).push(JSON.parse(body)); } }),
    ...(boarding && {
      locationStatus: async () => ({ status: window.locStatus ?? 'notDetermined' }),
      locationAuthorize: async () => {
        window.boardingCalls.push({ call: 'authorize' });
        window.locStatus = window.authorizeTo ?? 'always';
        return { status: window.locStatus };
      },
      boardingSetting: async a => { window.boardingCalls.push({ call: 'setting', ...a }); },
      boardingArm: async a => { window.boardingCalls.push({ call: 'arm', ...a }); },
      boardingDisarm: async () => { window.boardingCalls.push({ call: 'disarm' }); },
      boardingPending: async () => { const action = window.boardingAction ?? null; window.boardingAction = null; return { action }; },
      boardingUndo: async a => { window.boardingCalls.push({ call: 'undo', ...a }); },
      boardingLog: async () => ({ lines: window.boardingLines ?? [] }),
    }),
    ...(perms && {
      permissionsStatus: async () => ({
        notifications: { prompt: 'notDetermined', granted: 'authorized', denied: 'denied' }[perm],
        liveActivities: window.liveActivities ?? true, location: window.locStatus ?? 'notDetermined', precise: window.precise ?? true,
      }),
      openSettings: async () => { window.nativeCalls.push('openSettings'); },
    }),
  };
  window.boardingCalls = [];
  if (locStatus) window.locStatus = locStatus;
  window.emitBoarding = () => emit('TMinus.boarding', {});
  window.emitStartToken = t => emit('TMinus.startToken', { token: t });
  // A tap on a notification's action (`actionId`: 'tap', 'yes', 'missed').
  window.emitAction = (actionId, data) => emit('pushNotificationActionPerformed', { actionId, notification: { data } });
  window.emitAnswer = (answer, dep) => emit('TMinus.answer', { answer, dep });
  window.Capacitor = { isNativePlatform: () => true, Plugins: { PushNotifications, TMinus } };
}

async function fakeServer(page, { appLog = [], bells = [] } = {}) {
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
    if (path === '/bells') return route.fulfill({ json: { bells }, headers: cors });
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
  // A build without openSettings: Retry.
  await expect(page.locator('#toast').getByRole('button')).toHaveText('Retry');
});

test('notifications refused, a build with Permissions: the toast opens iOS Settings (the bell and the test notification)', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, fail: 'deny', token: TOKEN, perms: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await expect(page.locator('#toast')).toContainText('notifications are off for this app in Settings');
  await page.locator('#toast').getByRole('button', { name: 'Settings' }).click();
  expect(await nativeCalls(page)).toContain('openSettings');
  await page.locator('#open-setup').click();
  await page.getByRole('button', { name: 'Send test notification in 10 s' }).click();
  await expect(page.locator('#toast')).toContainText("Couldn't send the test: notifications are off");
  await expect(page.locator('#toast').getByRole('button')).toHaveText('Settings');
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

test('the widget\'s request carries the followed state: Leaving now, Cancel, At the stop, the ride', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, widget: true });
  await openApp(page, { time: '07:00' });
  const last = async () => (await page.evaluate(() => window.widgetBodies ?? [])).at(-1);
  await expect.poll(async () => (await last())?.state).toBe(null);
  await page.locator('#enroute').getByRole('button', { name: 'Leaving now' }).click();
  await expect.poll(async () => (await last()).state?.kind).toBe('leaving');
  expect((await last()).state).toMatchObject({ trip: 0, name: 'Home to office', pinned: false, target: { key: expect.any(String) } });
  await page.locator('#enroute').getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await last()).state).toBe(null);
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await expect.poll(async () => (await last()).state?.kind).toBe('stop');
  await tickTo(page, '07:12'); // the 7:08 bus left: boarded
  await expect.poll(async () => (await last()).state?.ride?.legs.length).toBe(2);
  expect((await last()).state.ride.legs[0]).toMatchObject({ tripId: expect.any(String), label: 'Bus 132' });
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

test('no card from the server: Leaving now starts the walk card from the app; Cancel ends it', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, leave: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await tickTo(page, '07:00');
  await page.locator('#enroute').getByRole('button', { name: 'Leaving now' }).click();
  await expect.poll(async () => (await activityCalls(page))[0]?.call).toBe('start');
  const [start] = await activityCalls(page);
  expect(start.tripName).toBe('Home to office');
  expect(start.state).toMatchObject({ phase: 'walk', head: 'Departs in', headTime: '7:08am' });
  await page.locator('#enroute').getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await activityCalls(page)).at(-1)).toMatchObject({ call: 'end', id: 'act1' });
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

test('the card\'s Yes / Missed it: applied to the open question for its departure; a stale one toasts "Question closed"', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await tickTo(page, '07:08:30');
  await expect(page.locator('#enroute')).toContainText('Did you get on the 7:08am Bus 132?');
  const dep = await page.evaluate(() => { const d = new Date(); d.setHours(7, 8, 0, 0); return d.getTime() / 1000; });
  // Another departure (an older question): nothing answered.
  await page.evaluate(d => window.emitAnswer('yes', d), dep - 30 * 60);
  await expect(page.locator('#toast')).toContainText('Question closed');
  await expect(page.locator('#enroute')).toContainText('Did you get on the 7:08am Bus 132?');
  await page.evaluate(d => window.emitAnswer('missed', d), dep);
  await expect(page.locator('#enroute')).not.toContainText('Did you get on');
  await expect(page.locator('.row.ride')).toHaveCount(0);
  // Answered: a second tap is stale.
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });
  await page.evaluate(d => window.emitAnswer('yes', d), dep);
  await expect(page.locator('#toast')).toContainText('Question closed');
  await expect(page.locator('.row.ride')).toHaveCount(0);
});

test('the card\'s Yes boards the asked ride', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await tickTo(page, '07:08:30');
  const dep = await page.evaluate(() => { const d = new Date(); d.setHours(7, 8, 0, 0); return d.getTime() / 1000; });
  await page.evaluate(d => window.emitAnswer('yes', d), dep);
  await tick(page, 1000);
  await expect(page.locator('.row.ride')).toHaveCount(1);
});

// Auto-bell: the server set a bell and started its card before the app opened. At launch the
// app picks the bell up first, so the card stays; a card whose reminder is gone still ends.
test('at launch, the card of a bell the server set stays; a card from a gone reminder ends', async ({ page }) => {
  const legs = [
    { route: '132', label: 'Bus 132', color: 'FFC72C', tripId: 'b1', dep: at('07:08'), arr: at('07:20'), source: 'schedule' },
    { route: 'Orange', label: 'Orange', color: 'ED8B00', tripId: 'o1', dep: at('07:27'), arr: at('07:45'), source: 'schedule' },
  ];
  await fakeServer(page, { bells: [{ id: 'auto1', index: 0, tripName: 'Home to office', key: '132in-0708', leaveBy: at('07:02'), dep: at('07:08'), headsUps: [60, 10, 5], timingIdx: 0, legs }] });
  await page.addInitScript(capacitorStub, { server: PUSH, token: TOKEN, leave: true });
  await page.addInitScript(token => {
    localStorage.setItem('t-minus:apns-token', JSON.stringify(token));
    window.fakeActivities = [{ id: 'leave1', reminderId: 'auto1', tripName: 'Home to office' }, { id: 'leave2', reminderId: 'gone1', tripName: 'Home to office' }];
  }, TOKEN.toLowerCase());
  await openApp(page, { time: '06:50' });
  await expect(firstRow(page).locator('.summary .bell')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.activityCalls.filter(c => c.call === 'end').map(c => c.id))).toEqual(['leave2']);
});

// A swiped-away card: on return to the app, "Lock Screen card closed · Show again".
const backToApp = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('a swiped-away leave card: on return, Show again asks the server to start it again', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, leave: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await page.evaluate(() => { window.fakeDismissed = [{ id: 'leave1', reminderId: 'r1' }]; });
  await backToApp(page);
  await expect(page.locator('#toast')).toContainText('Lock Screen card closed');
  await page.locator('#toast').getByRole('button', { name: 'Show again' }).click();
  await expect.poll(() => calls.find(c => c.method === 'PUT' && c.path === '/reminders/r1')?.body).toEqual({ restartCard: true });
});

test('a swiped-away ride card: on return, Show again starts a new one', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, leave: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await tickTo(page, '07:00');
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tickTo(page, '07:12'); // boarded
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:activity'))?.key ?? null)).not.toBeNull();
  const starts = async () => (await activityCalls(page)).filter(c => c.call === 'start').length;
  const before = await starts(); // the walk card's, then the ride card's
  await page.evaluate(() => { window.fakeDismissed = [{ id: 'act1', reminderId: null }]; });
  await backToApp(page);
  await expect(page.locator('#toast')).toContainText('Lock Screen card closed');
  await page.locator('#toast').getByRole('button', { name: 'Show again' }).click();
  await expect.poll(starts).toBe(before + 1);
});

// ---------- boarding from location ----------

const boardingCalls = (page, call) => page.evaluate(c => window.boardingCalls.filter(x => x.call === c), call);
// What the native code decided, from the trip's current state: `switch` (the 7:26am Orange
// instead of the 7:32am), `missed` (back at the stop), `gotOff` (off the Orange now); then the
// `boarding` event.
async function detect(page, kind, toast) {
  await page.evaluate(async ([kind, toast]) => {
    const { boardingBase } = await import('/core.js');
    const cur = JSON.parse(localStorage.getItem('t-minus:en-route'))[0];
    const now = Date.now();
    const leg1 = f => ({ ...cur, ride: { ...cur.ride, legs: cur.ride.legs.map((l, i) => (i === 1 ? f(l) : l)) } });
    const state = kind === 'switch' ? leg1(l => ({ ...l, tripId: 'OLin-0726', dep: l.dep - 6 * 60_000, arr: l.arr - 6 * 60_000 }))
      : kind === 'missed' ? { kind: 'stop', at: now, atStop: now, name: cur.name }
        : leg1(l => ({ ...l, off: now }));
    window.boardingAction = { undoId: 'u1', tripIdx: 0, tripName: cur.name, toast, at: now, state, base: boardingBase(cur), from: boardingBase(cur) };
    window.emitBoarding();
  }, [kind, toast]);
  await tick(page, 300);
}
const toastEl = page => page.locator('#toast');

const permRows = page => page.locator('#permissions .perm-row');

test('Permissions: the states, amber when off, the While Using hint; axe finds nothing', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true, perms: true, locStatus: 'whenInUse' });
  await page.addInitScript(() => { window.precise = false; window.liveActivities = false; });
  await openApp(page, { time: '06:50' });
  await page.locator('#open-setup').click();
  await expect(permRows(page)).toHaveText(['NotificationsOn', 'Live ActivitiesOff', 'LocationWhile Using', 'Precise LocationOff']);
  await expect(page.locator('#permissions .perm-off')).toHaveText(['Off', 'Off']);
  await expect(page.locator('#location-hint')).toHaveText(/^Detects which bus or train you got on after Leaving now or At the stop\. Allow Always/);
  const v = await new AxeBuilder({ page }).disableRules(['meta-viewport']).analyze();
  expect(v.violations.map(x => x.id)).toEqual([]);
});

test('Permissions: Allow asks for location (boarding on, nothing saved) and for notifications', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'prompt', token: TOKEN, boarding: true, perms: true });
  await openApp(page, { time: '06:50' });
  await page.locator('#open-setup').click();
  await expect(permRows(page)).toHaveText(['NotificationsAllow', 'Live ActivitiesOn', 'LocationAllow', 'Precise Location—']);
  await expect(page.locator('#location-hint')).toHaveText('Lets T-Minus tell which bus or train you got on. Your location stays on this phone.');
  expect((await boardingCalls(page, 'setting')).some(c => c.on)).toBe(false);
  await page.locator('#allow-location').click();
  await expect(permRows(page).nth(2)).toHaveText('LocationAlways');
  await expect(page.locator('#location-hint')).toHaveText(/^Detects arriving at the stop of a belled ride/);
  expect(await boardingCalls(page, 'authorize')).toHaveLength(1);
  expect((await boardingCalls(page, 'setting')).at(-1)).toMatchObject({ on: true, defaults: { slack: 1 } });
  expect(await page.evaluate(() => localStorage.getItem('t-minus:boarding-location'))).toBeNull();
  await page.locator('#allow-notifications').click();
  await expect(permRows(page).first()).toHaveText('NotificationsOn');
  expect(await nativeCalls(page)).toEqual(expect.arrayContaining(['requestPermissions', 'register']));
});

test('Permissions: read again on return to the app (Location turned off: boarding off); iOS Settings opens them', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true, perms: true, locStatus: 'always' });
  await openApp(page, { time: '06:50' });
  await expect.poll(async () => (await boardingCalls(page, 'setting')).at(-1)?.on).toBe(true);
  await page.locator('#open-setup').click();
  await expect(permRows(page).nth(2)).toHaveText('LocationAlways');
  await page.evaluate(() => { window.locStatus = 'denied'; });
  await backToApp(page);
  await expect(permRows(page).nth(2)).toHaveText('LocationOff');
  await expect(permRows(page).nth(2).locator('.perm-off')).toHaveCount(1);
  await expect(page.locator('#location-hint')).toHaveText('Location is off for T-Minus.');
  await expect(permRows(page).nth(3)).toHaveText('Precise Location—');
  await expect.poll(async () => (await boardingCalls(page, 'setting')).at(-1)?.on).toBe(false);
  await page.getByRole('button', { name: 'iOS Settings' }).click();
  expect(await nativeCalls(page)).toContain('openSettings');
});

test('Permissions: not in the browser; a build without them keeps the Boarding log only', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true, locStatus: 'whenInUse' });
  await openApp(page, { time: '06:50' });
  // An older build: boarding still follows Location.
  await expect.poll(async () => (await boardingCalls(page, 'setting')).at(-1)?.on).toBe(true);
  await page.locator('#open-setup').click();
  await expect(page.getByRole('button', { name: 'Boarding log' })).toBeVisible();
  await expect(page.locator('#permissions')).toHaveCount(0);
});

test('Permissions and the Boarding log: not offered by a build without boarding', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN });
  await openApp(page, { time: '06:50' });
  await page.locator('#open-setup').click();
  await expect(page.locator('#setup .check').first()).toBeVisible();
  await expect(page.locator('#permissions')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Boarding log' })).toHaveCount(0);
});

test('Location not allowed: boarding detection stays off', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true, perms: true });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await tick(page, 300);
  expect((await boardingCalls(page, 'setting')).some(c => c.on)).toBe(false);
  expect(await boardingCalls(page, 'arm')).toHaveLength(0);
});

test('the route map in the app: locate refused shows a toast that opens iOS Settings', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true, perms: true });
  await page.addInitScript(() => {
    const no = err => setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, message: 'denied' }), 0);
    navigator.geolocation.watchPosition = (ok, err) => { no(err); return 1; };
    navigator.geolocation.getCurrentPosition = (ok, err) => no(err);
    navigator.geolocation.clearWatch = () => {};
  });
  await openApp(page, { time: '06:50' });
  await page.getByRole('button', { name: 'Route map' }).click();
  await tick(page, 300);
  await page.getByRole('dialog').getByRole('button', { name: 'Center on my location' }).click();
  await tick(page, 100);
  await expect(toastEl(page)).toContainText('Location is off for T-Minus');
  await toastEl(page).getByRole('button', { name: 'Settings' }).click();
  expect(await nativeCalls(page)).toContain('openSettings');
});

test('with the setting on, a belled ride is armed: its window and state, the core.js URL, no position anywhere', async ({ page }) => {
  const calls = await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true, locStatus: 'always' });
  await openApp(page, { time: '06:50' });
  await notifyMe(page);
  await expect.poll(async () => (await boardingCalls(page, 'arm')).length).toBeGreaterThan(0);
  const { session, coreUrl } = (await boardingCalls(page, 'arm')).at(-1);
  expect(coreUrl).toMatch(/\/core\.js\?v=[0-9a-f]{10}$/);
  expect(session).toMatchObject({ on: true, tripIdx: 0, reminderId: 'r1', window: { from: at('07:02') - 15 * 60_000, to: at('07:08') + 30 * 60_000 } });
  expect(session.enRoute).toMatchObject({ kind: 'track', bell: true });
  expect(session.subscription).toEqual({ endpoint: `apns:${TOKEN.toLowerCase()}` });
  for (const c of calls) expect(JSON.stringify(c.body ?? {})).not.toMatch(/"lat"|"lon"|latitude|longitude/);
  // Bell off: disarmed.
  const disarms = (await boardingCalls(page, 'disarm')).length;
  await firstRow(page).getByRole('button', { name: 'Tracking', exact: true }).click();
  await expect.poll(async () => (await boardingCalls(page, 'disarm')).length).toBe(disarms + 1);
});

test('another train detected: the ride switches, with Undo (which tells the native code)', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true, locStatus: 'always' });
  await openApp(page, { time: '07:00' });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tickTo(page, '07:24'); // off the bus, in the transfer (the 7:32am planned)
  await expect(page.locator('.row.ride .big')).toHaveText(/7:32am$/);
  await detect(page, 'switch', 'On the 7:26am Orange, not the 7:32am');
  await expect(toastEl(page)).toContainText('On the 7:26am Orange, not the 7:32am');
  await expect(page.locator('.row.ride .big')).toHaveText(/7:26am$/);
  await toastEl(page).getByRole('button', { name: 'Undo' }).click();
  await tick(page, 300);
  await expect(page.locator('.row.ride .big')).toHaveText(/7:32am$/);
  expect(await boardingCalls(page, 'undo')).toEqual([{ call: 'undo', undoId: 'u1' }]);
});

test('missed the bus detected: back at the stop; got off detected: the walk', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true, locStatus: 'always' });
  await openApp(page, { time: '07:00' });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tickTo(page, '07:09'); // boarded the 7:08am (assumed)
  await expect(page.locator('.row.ride')).toHaveCount(1);
  await detect(page, 'missed', 'Missed the 7:08am Bus 132');
  await expect(toastEl(page)).toContainText('Missed the 7:08am Bus 132');
  await expect(page.locator('#enroute')).toContainText('At the stop since 7:09am');
  await expect(page.locator('.row.ride')).toHaveCount(0);

  await tickTo(page, '07:36:30'); // boarded the 7:36am
  await tickTo(page, '08:10'); // on the Orange
  await expect(page.locator('.ride-head')).toHaveText(riding('Orange'));
  await detect(page, 'gotOff', 'Got off at State');
  await expect(toastEl(page)).toContainText('Got off at State');
  await expect(page.locator('.ride-head')).toHaveText(/^Walking · arrive/);
});

test('at the next open: the latest action applies with its toast while its ride is on; not once it is over', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true, locStatus: 'always' });
  await page.addInitScript(([t]) => {
    if (sessionStorage.getItem('opened')) return;
    sessionStorage.setItem('opened', '1');
    window.boardingAction = { undoId: 'u2', tripIdx: 0, tripName: 'Home to office', toast: 'At the stop (location)', at: t, state: { kind: 'stop', at: t, atStop: t, name: 'Home to office' }, base: 'null', from: 'null' };
  }, [at('06:58')]);
  await openApp(page, { time: '07:00' });
  await expect(toastEl(page)).toContainText('At the stop (location)');
  await expect(page.locator('#enroute')).toContainText('At the stop since 6:58am');
});

test('at the next open: an action for a ride that is over is dropped', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true, locStatus: 'always' });
  await page.addInitScript(([t]) => {
    const legs = [{ tripId: '132in-0544', dep: t, arr: t + 60_000 }, { tripId: 'OLin-0600', dep: t + 120_000, arr: t + 180_000 }];
    window.boardingAction = { undoId: 'u3', tripIdx: 0, tripName: 'Home to office', toast: 'Got off at State', at: t, state: { kind: 'stop', at: t, atStop: t, ride: { legs, boardedAt: t }, name: 'Home to office' }, base: 'null', from: 'null' };
  }, [at('05:44')]);
  await openApp(page, { time: '07:00' });
  await tick(page, 500);
  await expect(toastEl(page)).toBeHidden();
  await expect(page.locator('.row.ride')).toHaveCount(0);
});

test('the Boarding log: newest first, Copy; axe finds nothing', async ({ page }) => {
  await fakeServer(page);
  await page.addInitScript(capacitorStub, { server: PUSH, permission: 'granted', token: TOKEN, boarding: true });
  await page.addInitScript(([t]) => {
    window.boardingLines = [{ at: t, line: 'geofence entered' }, { at: t + 60_000, line: 'leg 0 boarded 132in-0708 (planned 132in-0708) meters 12,20' }];
    navigator.clipboard.writeText = async text => { window.copied = text; };
  }, [at('07:04')]);
  await openApp(page, { time: '07:10' });
  await page.locator('#open-setup').click();
  await page.getByRole('button', { name: 'Boarding log' }).click();
  await expect(page.locator('.boarding-log > div')).toHaveText(['7:05am leg 0 boarded 132in-0708 (planned 132in-0708) meters 12,20', '7:04am geofence entered']);
  const v = await new AxeBuilder({ page }).disableRules(['meta-viewport']).analyze();
  expect(v.violations.map(x => x.id)).toEqual([]);
  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(toastEl(page)).toContainText('Copied');
  expect(await page.evaluate(() => window.copied)).toMatch(/geofence entered$/);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('button', { name: 'Boarding log' })).toBeVisible();
});
