// WebKit layout checks: the app's screens on two emulated iPhones (iPhone SE, 320 px; iPhone 17
// Pro Max, 440 px), checked for horizontal overflow, clipped text, overlapping row parts and
// 44 px tap targets (layout-checks.js). Runs only in the webkit-iphone-* projects (npm run
// test:webkit; playwright.config.js); the Chromium project ignores it. Light theme only.
// Every state is reached through the fake MBTA API's scenarios (helpers.js), with an
// assertion that the state is on screen before it is measured.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, at, commute, planOptions, expandOption, pickOption, CR_CONFIG, CONFIG, crCommute, riding } from './helpers.js';
import { series } from './fake-mbta.js';
import { expectLayout } from './layout-checks.js';

test.use({ colorScheme: 'light' });

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const bar = page => page.locator('#enroute');
const card = page => page.locator('.row.ride');
const check = (page, label) => expectLayout(page, label);

async function atTheStop(page) {
  await bar(page).getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
}

test('main list: collapsed rows, an expanded row, amber, hurry and missed, previous rides', async ({ page }) => {
  test.slow();
  await openApp(page, { time: '06:55' });
  await expect(page.locator('.row').first()).toBeVisible();
  await check(page, 'collapsed rows 06:55');
  await page.locator('.row-toggle').first().click();
  await expect(page.locator('.row').first().locator('.timeline')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Track', exact: true })).toBeVisible();
  await check(page, 'expanded row');
  for (const [t, cls] of [['06:59:30', 'amber'], ['07:02:30', 'hurry'], ['07:03:30', 'missed']]) {
    await tickTo(page, t);
    await expect(page.locator('.row').first()).toHaveClass(new RegExp(`\\b${cls}\\b`));
    await check(page, `${cls} state ${t}`);
  }
  await tickTo(page, '07:12');
  await page.getByRole('button', { name: 'Show previous rides ▾' }).click();
  await expect(page.locator('.row.prev').first()).toBeVisible();
  await check(page, 'previous rides listed');
  await page.locator('.row.prev .row-toggle').first().click();
  await expect(page.locator('.row.prev .timeline').first()).toBeVisible();
  await check(page, 'previous ride expanded (I got on)');
});

// The badges on the toward lines (2026-11-17), the long "every 6 min" one beside a headsign.
test('main list: an expanded row with a headway leg (badges on the toward lines)', async ({ page }) => {
  const config = structuredClone(CONFIG);
  config.trips[1].timingLeg = 0;
  const scenario = commute();
  for (const t of scenario.trips) t.live = t.route === '132';
  await openApp(page, { time: '17:00', config, scenario });
  const row = page.locator('.row:not(.missed)').first();
  await row.locator('.row-toggle').click();
  await expect(row.locator('.timeline .step.ride .toward .badge').first()).toHaveText('every 6 min');
  await check(page, 'expanded row, headway badge on the toward line');
});

test('main list: at the stop (long departs-in heads)', async ({ page }) => {
  await openApp(page, { time: '06:55' });
  await atTheStop(page);
  await expect(page.locator('.row.catch')).toHaveCount(1);
  await check(page, 'at the stop 06:55');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await check(page, 'at the stop 06:55, scrolled');
});

test('main list: next-day rows', async ({ page }) => {
  await openApp(page, { time: '23:30' });
  await expect(page.locator('.row .big', { hasText: 'Tue ' }).first()).toBeVisible();
  await check(page, 'next-day rows 23:30');
});

test('main list: a service alert', async ({ page }) => {
  const scenario = { ...commute(), alerts: [{ id: 'a1', effect: 'DELAY', header: 'Orange Line delays of about 10 minutes', route: 'Orange' }] };
  await openApp(page, { time: '07:00', scenario });
  await expect(page.locator('#alerts')).toContainText('Orange Line delays');
  await check(page, 'alerts');
});

test('commuter rail rows: train, track, alert, flag stop', async ({ page }) => {
  await openApp(page, { time: '17:20', config: CR_CONFIG, scenario: crCommute() });
  await check(page, 'commuter rail collapsed');
  await page.locator('.row-toggle').first().click();
  await page.locator('.row-toggle').nth(1).click();
  await expect(page.locator('.step .flag')).toHaveCount(1);
  await check(page, 'commuter rail expanded');
});

test('the bell on a collapsed row, and the Tracking button', async ({ page }) => {
  // Push stubbed as notify.spec.js does (Notification may be missing in WebKit).
  await page.addInitScript(() => {
    localStorage.setItem('t-minus:push-server', JSON.stringify('https://push.test'));
    if (!('PushManager' in window)) window.PushManager = class {}; // WebKit here has no Push API
    if (!window.Notification) window.Notification = class { static requestPermission() { return Promise.resolve('granted'); } };
    Object.defineProperty(window.Notification, 'permission', { configurable: true, get: () => 'default' });
    window.Notification.requestPermission = async () => 'granted';
    const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } };
    const pushManager = { getSubscription: async () => null, subscribe: async () => ({ toJSON: () => sub }) };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => Promise.resolve({ pushManager }) });
  });
  await page.context().route('https://push.test/**', async route => {
    const cors = { 'access-control-allow-origin': '*' };
    const path = new URL(route.request().url()).pathname;
    if (path === '/vapid') return route.fulfill({ json: { publicKey: 'BAAA' }, headers: cors });
    if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: { id: 'r1', headsUps: [10, 5] }, headers: cors });
    return route.fulfill({ status: 204, headers: cors });
  });
  await openApp(page, { time: '06:50' });
  const first = page.locator('.row').first();
  await first.locator('.row-toggle').click();
  await first.getByRole('button', { name: 'Track', exact: true }).click();
  await tick(page, 1000);
  await expect(first.locator('.track-btn.on')).toHaveCount(1);
  await check(page, 'tracking, expanded');
  await first.locator('.big').click();
  await tick(page, 300);
  await expect(first.locator('.summary .bell')).toHaveCount(1);
  await check(page, 'bell on a collapsed row');
});

test('ride bar: asking, at the stop', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await expect(bar(page)).toBeVisible();
  await check(page, 'ride bar asking');
  await atTheStop(page);
  await expect(bar(page)).toContainText('At the stop since 7:00am');
  await check(page, 'at the stop since');
});

test('ride bar: leaving now', async ({ page }) => {
  await openApp(page, { time: '07:04' });
  await bar(page).getByRole('button', { name: 'Leaving now' }).click();
  await tick(page, 1000);
  await expect(bar(page)).toContainText('7:09am');
  await check(page, 'leaving now');
});

test('ride bar: tracking and the boarding question', async ({ page }) => {
  test.slow();
  await openApp(page, { time: '07:00' });
  const second = page.locator('.row').nth(1);
  await second.click();
  await second.getByRole('button', { name: 'Track', exact: true }).click();
  await tick(page, 1000);
  await expect(bar(page)).toContainText('Tracking Bus 132 7:36am');
  await check(page, 'tracking bar');
  await tickTo(page, '07:36:30');
  await expect(bar(page)).toContainText('Did you get on the 7:36am Bus 132?');
  await check(page, 'boarding question');
});

test('ride card phases: riding, transfer, riding, walking, arrived', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    if (window.Notification) Object.defineProperty(window.Notification, 'permission', { configurable: true, get: () => 'default' });
  });
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await tickTo(page, '07:08:30');
  await expect(page.locator('.ride-head')).toBeVisible();
  await expect(card(page).locator('.ride-outlook')).toContainText('Then Orange Line');
  await check(page, 'ride card: riding the bus');
  await tickTo(page, '07:23');
  await expect(card(page).locator('.big .at')).toBeVisible();
  await check(page, 'ride card: transfer');
  await tickTo(page, '07:33');
  await expect(page.locator('.ride-head')).toHaveText(riding('Orange'));
  await check(page, 'ride card: riding the Orange Line');
  await tickTo(page, '07:48');
  await expect(card(page)).toBeVisible();
  await check(page, 'ride card: walking');
  await tickTo(page, '07:58');
  await expect(card(page).getByRole('button', { name: 'Done' })).toBeVisible();
  await check(page, 'ride card: arrived');
});

test('long ride: stops left, "… 12 more" expanded', async ({ page }) => {
  test.slow();
  const middle = ['15999', '16000', '16001', '5975', '5976', '5978', '5980', '5982', '5983', '5985', '5986', '5987', '5988', '5990'];
  const scenario = commute();
  scenario.trips = [...scenario.trips.filter(t => !t.id.startsWith('132in')),
    ...series({ prefix: '132in', route: '132', direction: 1, first: '05:44', every: 28, count: 40,
      stops: [['25996', 0], ['25997', 4], ...middle.map((s, i) => [s, 5 + Math.floor(i * 9 / 14)]), ['5991', 14]] })];
  await openApp(page, { time: '07:00', scenario });
  await atTheStop(page);
  await tickTo(page, '07:09');
  const leg = card(page).locator('.tl-leg').first();
  await expect(leg.getByRole('button', { name: '… 12 more' })).toBeVisible();
  await check(page, 'long ride collapsed');
  await leg.getByRole('button', { name: '… 12 more' }).click();
  await tick(page, 300);
  await expect(leg.getByRole('button', { name: 'Show fewer' })).toBeVisible();
  await check(page, 'long ride expanded');
});

test('long ride: stopped at a stop', async ({ page }) => {
  const dwell = commute();
  dwell.dwell = true;
  await openApp(page, { time: '07:00', scenario: dwell });
  await atTheStop(page);
  await tickTo(page, '07:12:10');
  await page.locator('#refresh').click();
  await tick(page, 1000);
  await expect(card(page).locator('.step.mid')).toHaveText(['At Pond St @ Stone Zoo']);
  await check(page, 'stopped at a stop');
});

test('setup: trip list, settings, the simulator card', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.locator('#open-setup').click();
  await expect(page.locator('#setup-done')).toBeVisible();
  await check(page, 'setup list');
  await page.locator('#setup').getByRole('button', { name: 'Simulator', exact: true }).click();
  await expect(page.locator('#setup').getByLabel('Ride (that day’s schedules)')).toBeVisible();
  await check(page, 'simulator card');
  await page.locator('#setup').getByRole('button', { name: 'Test preset' }).click();
  await check(page, 'simulator, test preset');
});

test('setup: trip editor and the stop picker', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.locator('#open-setup').click();
  await page.locator('#setup .trip-row .item').first().click();
  await expect(page.locator('#setup .leg-item').first()).toBeVisible();
  await check(page, 'trip editor');
  const more = page.locator('#setup details.more');
  if (await more.count()) { await more.first().locator('summary').click(); await check(page, 'trip editor, more options'); }
  await page.locator('#setup').getByRole('button', { name: '+ Add transit leg', exact: true }).click();
  await expect(page.locator('#setup .list .item').first()).toBeVisible(); // where to get off
  await check(page, 'stop picker');
  await page.locator('#picker-search').fill('oak');
  await tick(page, 400); // the search's debounce, on the page clock
  await expect(page.locator('#setup .list .item', { hasText: 'Oak Grove' }).first()).toBeVisible();
  await check(page, 'stop picker, searched');
});

async function pickStation(page, field, query, name) {
  await page.locator(`#setup #plan-${field}`).click();
  await page.locator('#setup #picker-search').fill(query);
  await page.locator('#setup .list .item', { hasText: name }).first().click();
}

test('auto-route: untimed options, one expanded', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.locator('#open-setup').click();
  await page.locator('#setup').getByRole('button', { name: '+ Plan a trip', exact: true }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'kendall', 'Kendall/MIT');
  await expect(planOptions(page)).toHaveCount(3);
  await check(page, 'plan options (untimed)');
  await expandOption(page, 1);
  await check(page, 'plan option expanded');
});

test('auto-route: timed options, then the one-off trip banner', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.route(/\/api\/plan\?/, route => route.fulfill({ json: { from: 'Main St @ South St', to: 'State', options: [{
    legs: [{ route: '132', also: [], direction_id: 1, stop: '25996', alight: '5991' }, { route: 'Orange', also: [], direction_id: 0, stop: 'place-ogmnl', alight: 'place-state' }],
    transfers: [{ name: 'Washington St @ Oak Grove Sta → Oak Grove', meters: 32, min: 3 }], minutes: 32,
    leave: at('07:04'), arrive: at('07:55'), deps: [{ dep: at('07:10'), live: false }, { dep: at('07:33'), live: true }] }], timed: true } }));
  await page.locator('#toggle select').selectOption({ label: 'Plan a trip…' });
  await page.locator('#plan-from').click();
  await page.locator('#picker-search').fill('132');
  await page.locator('#setup .list .item', { hasText: 'Bus 132' }).first().click();
  await page.locator('#setup .list .item', { hasText: 'Main St @ South St' }).first().click();
  await page.locator('#plan-to').click();
  await page.locator('#picker-search').fill('state');
  await page.locator('#setup .list .item.station', { hasText: 'State' }).click();
  await expect(planOptions(page)).toHaveCount(1);
  await check(page, 'plan options (timed)');
  await expandOption(page);
  await expect(planOptions(page).first().locator('.timeline')).toBeVisible();
  await check(page, 'plan option expanded (timed)');
  await pickOption(page, 0, 'See departures');
  await expect(page.locator('#oneoff')).toBeVisible();
  await tick(page, 1000);
  await check(page, 'one-off banner and rows');
});

// Share my ride: Share beside Tracking, the name dialog, Sharing, the sheet; the ride card's Share; the
// recipient's page, live and ended. The server's share routes run on a memory store (mbta.serveServer).
const shareInit = () => {
  Object.defineProperty(window.Notification ?? (window.Notification = class {}), 'permission', { configurable: true, get: () => 'denied' });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { (window.sharedWith ??= []).push(data); } });
};
test('share: Share beside Tracking, the name dialog, Sharing, the sheet', async ({ page, context }) => {
  test.slow();
  const mbta = await openApp(page, { time: '07:00', init: shareInit });
  await mbta.serveServer(context);
  const row = page.locator('.row').nth(1);
  await row.click();
  await row.getByRole('button', { name: 'Track', exact: true }).click();
  await tick(page, 1000);
  const tracked = page.locator('.row.tracked');
  await expect(tracked.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await check(page, 'belled row with Share');
  await tracked.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('#share-name')).toBeVisible();
  await check(page, 'the name dialog');
  await page.locator('#share-name-input').fill('Lucas');
  await page.getByRole('button', { name: 'Share', exact: true }).last().click();
  await expect(tracked.getByRole('button', { name: 'Sharing' })).toBeVisible();
  await check(page, 'belled row with Sharing');
  await tracked.getByRole('button', { name: 'Sharing' }).click();
  await expect(page.locator('#share-sheet')).toBeVisible();
  await check(page, 'the share sheet');
});

test('share: the ride card with Share, and the recipient\'s page live and ended', async ({ page, context }) => {
  test.slow();
  const mbta = await openApp(page, { time: '07:00', init: shareInit });
  await mbta.serveServer(context);
  await atTheStop(page);
  await tickTo(page, '07:08:30');
  await expect(card(page).getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await check(page, 'ride card with Share');
  await card(page).getByRole('button', { name: 'Share', exact: true }).click();
  await page.locator('#share-name-input').fill('A long first name here');
  await page.getByRole('button', { name: 'Share', exact: true }).last().click();
  await expect(card(page).getByRole('button', { name: 'Sharing' })).toBeVisible();
  await check(page, 'ride card with Sharing');
  const { url } = (await page.evaluate(() => window.sharedWith)).at(-1);
  const rp = await context.newPage();
  await rp.setViewportSize(page.viewportSize());
  await mbta.serveProxy(rp);
  await rp.goto(new URL(url).pathname);
  await expect(rp.locator('.share-phase')).toBeVisible();
  await check(rp, 'share page, riding');
  await page.bringToFront();
  await card(page).getByRole('button', { name: 'Sharing' }).click();
  await page.locator('#share-stop').click();
  await tick(page, 21_000);
  await expect(rp.locator('.share-ended')).toBeVisible();
  await check(rp, 'share page, ended');
});
