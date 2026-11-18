// Share my ride (DESIGN.md "Share my ride"): the Share / Sharing buttons, the name, the sheet, and the
// recipient's page at /r/<id>, served by the real server code on a memory store (`mbta.serveServer`).
// Timeline (home to office, Monday): bus 132 at 7:36 from Main St (the second row), 7:50 at Oak Grove,
// Orange 7:56 → 8:11, a 10-min walk: arrive 8:21.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, tick, tickTo, at } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const bell = (row, name = 'Track') => row.getByRole('button', { name, exact: true });
const bar = page => page.locator('#enroute');
const card = page => page.locator('.row.ride');
const secondRow = page => page.locator('.row').nth(1);

// navigator.share and the clipboard record what they are given (window.sharedWith, window.copied).
// Notifications are off (permission 'denied'): the bell sets no reminder, so no permission prompt hangs
// when a second page takes the focus.
const SHARE_STUB = () => {
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'denied' });
  window.sharedWith = [];
  window.copied = [];
  window.shareMode = 'ok'; // 'ok' | 'cancel' | 'none'
  Object.defineProperty(navigator, 'share', { configurable: true, get: () => (window.shareMode === 'none' ? undefined : async data => {
    window.sharedWith.push(data);
    if (window.shareMode === 'cancel') throw new DOMException('cancelled', 'AbortError');
  }) });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.copied.push(t); } } });
};

async function openShareApp(page, context, opts = {}) {
  const mbta = await openApp(page, { time: '07:00', init: SHARE_STUB, ...opts });
  const server = await mbta.serveServer(context);
  return { mbta, server };
}
async function belled(page) {
  const row = secondRow(page);
  await row.click();
  await bell(row).click();
  await tick(page, 1000);
  return page.locator('.row.tracked');
}
// Share from the belled row, giving the name the first time.
async function share(page, name = null) {
  const row = page.locator('.row.tracked');
  await row.getByRole('button', { name: 'Share', exact: true }).click();
  if (name != null) {
    await page.locator('#share-name-input').fill(name);
    await page.getByRole('button', { name: 'Share', exact: true }).last().click();
  }
  await expect(row.getByRole('button', { name: 'Sharing', exact: true })).toBeVisible();
  const urls = await page.evaluate(() => window.sharedWith.map(d => d.url));
  return urls.at(-1);
}
// The recipient's page at the link, in its own page of the same context. The page clock belongs to the
// context: one clock for both pages, moved with `tick` / `tickTo` on either.
async function recipient(context, mbta, url, sharer) {
  const rp = await context.newPage();
  rp.on('pageerror', e => { throw e; });
  await rp.addInitScript(() => {
    window.geo = 0; window.stored = 0;
    const g = navigator.geolocation;
    if (g) for (const k of ['getCurrentPosition', 'watchPosition']) g[k] = () => { window.geo++; };
    for (const k of ['getItem', 'setItem']) { const o = Storage.prototype[k]; Storage.prototype[k] = function (...a) { window.stored++; return o.apply(this, a); }; }
  });
  await mbta.serveProxy(rp);
  await rp.goto(new URL(url).pathname);
  await rp.locator('.row.ride .ride-head').filter({ hasNotText: 'Loading' }).waitFor();
  await sharer.bringToFront(); // a page in the background gets no animation frames: its clicks wouldn't settle
  return rp;
}
const head = rp => rp.locator('.row.ride .ride-head');

test('Share is on the belled row only: not on a plain row, not in the bar; none while walking without the bell', async ({ page, context }) => {
  await openShareApp(page, context);
  const row = secondRow(page);
  await row.click();
  await expect(row.getByRole('button', { name: /^Share/ })).toHaveCount(0);
  await bell(row).click();
  await tick(page, 1000);
  await expect(page.locator('.row.tracked').getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await expect(bar(page).getByRole('button', { name: /Share/ })).toHaveCount(0);
  // Bell off: gone. Leaving now without the bell: still none.
  await bell(page.locator('.row.tracked'), 'Tracking').click();
  await tick(page, 1000);
  await expect(page.getByRole('button', { name: /^Shar/ })).toHaveCount(0);
  await bar(page).getByRole('button', { name: 'Leaving now' }).click();
  await tick(page, 1000);
  await expect(page.getByRole('button', { name: /^Shar/ })).toHaveCount(0);
});

test('the first share asks for the name; the share sheet gets only the link; Sharing is green; the name is in Setup', async ({ page, context }) => {
  await openShareApp(page, context);
  await belled(page);
  const url = await share(page, 'Lucas');
  expect(url).toMatch(/\/r\/[A-Za-z0-9_-]{22}$/);
  const given = await page.evaluate(() => window.sharedWith);
  expect(given).toEqual([{ url }]); // no title, no text
  await expect(page.locator('.row.tracked').getByRole('button', { name: 'Sharing' })).toHaveCSS('color', 'rgb(27, 127, 69)');
  // Tapped again: the sheet (no name prompt); "Share link again" gives the same link.
  await page.locator('.row.tracked').getByRole('button', { name: 'Sharing' }).click();
  await expect(page.locator('#share-sheet')).toBeVisible();
  await expect(page.locator('#share-sheet-title')).toHaveText('Sharing this trip until 30 min after you arrive');
  await page.locator('#share-again').click();
  expect(await page.evaluate(() => window.sharedWith.map(d => d.url))).toEqual([url, url]);
  // Setup has the name.
  await page.locator('#open-setup').click();
  await expect(page.getByLabel('Your name (optional, for shared rides)')).toHaveValue('Lucas');
});

test('the recipient\'s page: the name, Live, the arrival, the phase, the map; never the trip name; no storage or location', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  await belled(page);
  const url = await share(page, 'Lucas');
  const rp = await recipient(context, mbta, url, page);
  await expect(rp.locator('#share-title')).toHaveText('Lucas shared a ride');
  await expect(rp.locator('#share-live')).toBeVisible();
  await expect(head(rp)).toHaveText(/^Arrives in 1h 2\dm · 8:21am$/);
  await expect(rp.locator('.share-phase')).toHaveText('Leaves at 7:30am for Bus 132 at 7:36am');
  await expect(rp.locator('.row.ride .step.end .t')).toHaveText(''); // the headline has the arrival
  await expect(rp.locator('.route-svg')).toBeVisible();
  await expect(rp.locator('.map-locate')).toHaveCount(0);
  expect(await rp.locator('body').innerText()).not.toContain('Home to office');
  expect(await rp.evaluate(() => [window.geo, window.stored])).toEqual([0, 0]);
  await expect(rp.locator('#share-foot')).toHaveText(/^Updated 7:00am · the link ends 30 min after arrival$/);
  // Past the departure, unanswered: assumed on board, not confirmed. The sharer's app answers Yes: the note goes.
  await tickTo(page, '07:37');
  await tick(page, 21_000);
  await expect(rp.locator('.share-note')).toHaveText('not confirmed');
  await expect(rp.locator('.share-phase')).toHaveText(/^On Bus 132 · /);
  // "Arrived" at the end, then the link ends 30 min later.
  await tickTo(page, '08:22');
  await tick(page, 21_000);
  await expect(head(rp)).toHaveText('Arrived 8:21am');
  await tickTo(page, '08:52');
  await tick(page, 21_000);
  await expect(head(rp)).toHaveText('This ride has ended');
  await expect(rp.locator('#share-live')).toBeHidden();
});

test('Cancel trip in the bar ends the page; a blank name reads "Shared ride"', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  await belled(page);
  const url = await share(page, '');
  const rp = await recipient(context, mbta, url, page);
  await expect(rp.locator('#share-title')).toHaveText('Shared ride');
  await bar(page).getByRole('button', { name: 'Cancel' }).click();
  await tick(page, 21_000);
  await expect(head(rp)).toHaveText('This ride has ended');
  await expect(page.getByRole('button', { name: /^Shar/ })).toHaveCount(0);
});

test('the Undo of Cancel trip resumes the same link', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  await belled(page);
  const url = await share(page, 'Lucas');
  await bar(page).getByRole('button', { name: 'Cancel' }).click();
  await page.locator('#toast button').click(); // the toast goes after 5 s of the page clock
  await tick(page, 21_000);
  await expect(page.locator('.row.tracked').getByRole('button', { name: 'Sharing' })).toBeVisible();
  const rp = await recipient(context, mbta, url, page);
  await expect(head(rp)).toHaveText(/^Arrives in /);
});

test('the Undo of Cancel trip waits for the Cancel\'s own DELETE: the resume never overtakes it', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  await belled(page);
  const url = await share(page, 'Lucas');
  const order = [];
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route(/\/api\/shares\/[A-Za-z0-9_-]{22}/, async route => {
    const method = route.request().method();
    if (method === 'GET') return route.fallback();
    order.push(`${method} start`);
    if (method === 'DELETE') await gate;
    await route.fallback();
    order.push(`${method} done`);
  });
  await bar(page).getByRole('button', { name: 'Cancel' }).click();
  await page.locator('#toast button').click();
  await tick(page, 21_000); // the changes would go by now
  expect(order).toEqual(['DELETE start']); // the resume waits
  release();
  await expect.poll(async () => { await tick(page, 2000); return order.join(', '); }).toBe('DELETE start, DELETE done, PUT start, PUT done');
  const rp = await recipient(context, mbta, url, page);
  await expect(head(rp)).toHaveText(/^Arrives in /);
});

test('a name with emoji (a family, a flag) is kept with the trips; a name with control characters is refused in the dialog', async ({ page, context }) => {
  await openShareApp(page, context);
  await belled(page);
  const row = page.locator('.row.tracked');
  await row.getByRole('button', { name: 'Share', exact: true }).click();
  await page.locator('#share-name-input').fill('Ana \u202eb'); // a bidi override
  await page.getByRole('button', { name: 'Share', exact: true }).last().click();
  await expect(page.locator('#share-name-error')).toBeVisible();
  await expect(page.locator('#share-name')).toHaveJSProperty('open', true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:config')).shareName)).toBeUndefined();
  const name = 'Ana \u{1F468}\u200D\u{1F469}\u200D\u{1F467} \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
  await page.locator('#share-name-input').fill(name);
  await page.getByRole('button', { name: 'Share', exact: true }).last().click();
  await expect(row.getByRole('button', { name: 'Sharing', exact: true })).toBeVisible();
  // Saved with the trips: the config still loads (a reload keeps the trips and the name).
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:config')));
  expect(saved.shareName).toBe(name);
  expect(saved.trips.length).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator('.row').first()).toBeVisible();
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:config')))).shareName).toBe(name);
});

test('Stop sharing from the sheet ends the page; sharing again gives a new link', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  await belled(page);
  const url = await share(page, 'Lucas');
  const rp = await recipient(context, mbta, url, page);
  await page.locator('.row.tracked').getByRole('button', { name: 'Sharing' }).click();
  await page.locator('#share-stop').click();
  await expect(page.locator('.row.tracked').getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await tick(page, 21_000);
  await expect(head(rp)).toHaveText('This ride has ended');
  const again = await share(page);
  expect(again).not.toBe(url);
});

test('the bell off ends the page', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  await belled(page);
  const url = await share(page, 'Lucas');
  const rp = await recipient(context, mbta, url, page);
  await bell(page.locator('.row.tracked'), 'Tracking').click();
  await tick(page, 21_000);
  await expect(head(rp)).toHaveText('This ride has ended');
});

test('Missed it at the question ends the page with "Missed Bus 132 7:36am"', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  await belled(page);
  const url = await share(page, 'Lucas');
  const rp = await recipient(context, mbta, url, page);
  await tickTo(page, '07:36:30');
  await bar(page).getByRole('button', { name: 'Missed it' }).click();
  await tick(page, 21_000);
  await expect(head(rp)).toHaveText('Missed Bus 132 7:36am');
});

test('a ride: Share is in the ride card, belled or not, and the share follows the vehicle; a different train is followed', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  await bar(page).getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:08:30');
  const btn = card(page).getByRole('button', { name: 'Share', exact: true });
  await expect(btn).toBeVisible();
  await btn.click();
  await page.locator('#share-name-input').fill('Lucas');
  await page.getByRole('button', { name: 'Share', exact: true }).last().click();
  await expect(card(page).getByRole('button', { name: 'Sharing' })).toBeVisible();
  const url = (await page.evaluate(() => window.sharedWith)).at(-1).url;
  const rp = await recipient(context, mbta, url, page);
  await expect(rp.locator('.share-phase')).toHaveText(/^On Bus 132 · /);
  await expect(rp.locator('.share-note')).toHaveCount(0); // boarded: confirmed
  // Arrived on the sharer's card: no Share.
  await tickTo(page, '07:58');
  await expect(card(page).getByRole('button', { name: /^Shar/ })).toHaveCount(0);
});

test('without navigator.share the link is copied; a cancelled first share sheet ends the share again', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  await belled(page);
  await page.evaluate(() => { window.shareMode = 'none'; });
  const row = page.locator('.row.tracked');
  await row.getByRole('button', { name: 'Share', exact: true }).click();
  await page.locator('#share-name-input').fill('Lucas');
  await page.getByRole('button', { name: 'Share', exact: true }).last().click();
  await expect(page.locator('#toast')).toContainText('Link copied');
  const copied = (await page.evaluate(() => window.copied)).at(-1);
  expect(copied).toMatch(/\/r\/[A-Za-z0-9_-]{22}$/);
  // Stop it; then a cancelled share sheet: back to "Share", the old link ended.
  await row.getByRole('button', { name: 'Sharing' }).click();
  await page.locator('#share-stop').click();
  await page.evaluate(() => { window.shareMode = 'cancel'; });
  await row.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  const rp = await recipient(context, mbta, copied, page);
  await expect(head(rp)).toHaveText('This ride has ended'); // the first link was stopped
});

test('another trip\'s share ends the first; the bell moved to another ride keeps it; the app closed, the page moves on', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  await belled(page);
  const url = await share(page, 'Lucas');
  const rp = await recipient(context, mbta, url, page);
  // The bell moved to a later ride on the same trip: the same link follows it.
  const later = page.locator('.row').nth(2);
  await later.click();
  await bell(later).click();
  await tick(page, 6000);
  await tick(page, 26_000);
  await expect(rp.locator('.share-phase')).toHaveText(/^Leaves at 7:5\dam for Bus 132 at 8:04am$/);
  // The app closed (no more changes): the page still moves on to the unconfirmed ride.
  await tickTo(page, '08:06');
  await tick(page, 21_000);
  await expect(rp.locator('.share-note')).toHaveText('not confirmed');
});

// Axe violations (`meta-viewport` is disabled as in a11y.spec.js: iOS ignores user-scalable=no).
const violations = async page => (await new AxeBuilder({ page }).disableRules(['meta-viewport']).analyze())
  .violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);

for (const scheme of ['light', 'dark']) {
  test(`axe finds nothing on Share and Sharing, the name dialog, the sheet, the ride card's Sharing and the share page (${scheme})`, async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const { mbta } = await openShareApp(page, context);
    const row = await belled(page);
    expect(await violations(page)).toEqual([]); // Share beside Tracking
    await row.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(page.locator('#share-name')).toBeVisible();
    expect(await violations(page)).toEqual([]); // the name dialog
    await page.locator('#share-name-input').fill('Lucas');
    await page.getByRole('button', { name: 'Share', exact: true }).last().click();
    await expect(row.getByRole('button', { name: 'Sharing' })).toBeVisible();
    expect(await violations(page)).toEqual([]); // Sharing
    const url = (await page.evaluate(() => window.sharedWith)).at(-1).url;
    await row.getByRole('button', { name: 'Sharing' }).click();
    await expect(page.locator('#share-sheet')).toBeVisible();
    expect(await violations(page)).toEqual([]); // the sheet
    await page.locator('#share-sheet-cancel').click();
    // The page: before leaving, riding (not confirmed), ended.
    const rp = await recipient(context, mbta, url, page);
    expect(await violations(rp)).toEqual([]);
    await tickTo(page, '07:37');
    await tick(page, 21_000);
    await expect(rp.locator('.share-note')).toHaveText('not confirmed');
    expect(await violations(rp)).toEqual([]);
    // The ride card with Sharing.
    await bar(page).getByRole('button', { name: 'Yes' }).click();
    await tick(page, 1000);
    await expect(card(page).getByRole('button', { name: 'Sharing' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await card(page).getByRole('button', { name: 'Sharing' }).click();
    await page.locator('#share-stop').click();
    await tick(page, 21_000);
    await expect(head(rp)).toHaveText('This ride has ended');
    expect(await violations(rp)).toEqual([]);
  });
}

// A one-off (Oak Grove → State, as plan.spec.js): "See departures" with the server's timed answer stubbed.
const TIMED_OAK_STATE = () => ({ from: 'Oak Grove', to: 'State', timed: true, options: [{
  legs: [{ route: 'Orange', also: [], direction_id: 0, stop: 'place-ogmnl', alight: 'place-state', stopName: 'Oak Grove', alightName: 'State', stops: 8 }],
  transfers: [], minutes: 15, walkBefore: 0, walkAfter: 0, leave: at('07:02'), arrive: at('07:28'),
  deps: [{ dep: at('07:08'), arr: at('07:23'), source: 'scheduled' }],
}] });
async function oneOffRide(page) {
  await page.route(/\/api\/plan\?/, route => route.fulfill({ json: TIMED_OAK_STATE() }));
  await page.locator('#toggle select').selectOption({ label: 'Plan a trip…' });
  for (const [field, query, name] of [['from', 'oak gr', 'Oak Grove'], ['to', 'state', 'State']]) {
    await page.locator(`#setup #plan-${field}`).click();
    await page.locator('#setup #picker-search').fill(query);
    await page.locator('#setup .list .item', { hasText: name }).first().click();
  }
  const opt = page.locator('#setup #plan-options > .row').first();
  await opt.locator('.row-toggle').click();
  await opt.locator('.row-foot').getByRole('button', { name: 'See departures', exact: true }).click();
  await tick(page, 1000);
  await bar(page).getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:02:30'); // boarded
  await expect(card(page)).toBeVisible();
}

test('a one-off that ends with its ride keeps its share: no DELETE, the page still shows the arrival', async ({ page, context }) => {
  const { mbta } = await openShareApp(page, context);
  const deletes = [];
  page.on('request', r => { if (r.method() === 'DELETE' && r.url().includes('/api/shares/')) deletes.push(r.url()); });
  await oneOffRide(page);
  await card(page).getByRole('button', { name: 'Share', exact: true }).click();
  await page.locator('#share-name-input').fill('Lucas');
  await page.getByRole('button', { name: 'Share', exact: true }).last().click();
  await expect(card(page).getByRole('button', { name: 'Sharing', exact: true })).toBeVisible();
  const url = (await page.evaluate(() => window.sharedWith.map(d => d.url))).at(-1);
  await tickTo(page, '07:23'); // off at 7:17, 5-min walk... arrived
  await card(page).getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#oneoff')).toBeHidden();
  await tick(page, 21_000);
  expect(deletes).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:share') ?? 'null')?.share ?? null)).toBeNull();
  const rp = await recipient(context, mbta, url, page);
  await expect(head(rp)).not.toHaveText('This ride has ended');
});
