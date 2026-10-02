// En route and trip tracking: Leaving now / At the stop, Track this trip, the ride card
// through its phases, Missed it, Later one?, transfer re-plan, Cancel + Undo, wake lock.
// Timeline used below (home to office): bus 132 7:08 → 7:22 (via Pond St 7:12), 5-min
// transfer, Orange 7:32 → 7:47 (every 6 min), 10-min walk → arrive 7:57.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, rowHeads, commute, WAKE_STUB } from './helpers.js';
import { series } from './fake-mbta.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const bar = page => page.locator('#enroute');
const card = page => page.locator('.row.ride');
const head = page => page.locator('.ride-head');
const toast = page => page.locator('#toast');

async function atTheStop(page) {
  await bar(page).getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
}

test('At the stop highlights the first ride you can catch', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await expect(bar(page)).toContainText('At the stop since 7:00am');
  const catchRow = page.locator('.row.catch');
  await expect(catchRow.locator('.big')).toHaveText(/Bus 132 in 7 min\s*7:08am/);
  await expect(page.locator('.row').nth(1)).toContainText('Bus 132 in 35 min');
});

test('Leaving now adds the walk before picking the ride', async ({ page }) => {
  await openApp(page, { time: '07:04' });
  await bar(page).getByRole('button', { name: 'Leaving now' }).click();
  await tick(page, 1000);
  await expect(bar(page)).toContainText('7:09am'); // at the stop after the 5-min walk
  await expect(page.locator('.row.catch .big')).toContainText('7:36am'); // 7:08 is out of reach
});

test('next-day rows are hidden while en route', async ({ page }) => {
  await openApp(page, { time: '23:30' });
  expect((await rowHeads(page)).some(h => h.includes('Tue '))).toBe(true);
  await atTheStop(page);
  expect((await rowHeads(page)).some(h => h.includes('Tue '))).toBe(false);
  await bar(page).getByRole('button', { name: 'Cancel' }).click();
  await tick(page, 1000);
  expect((await rowHeads(page)).some(h => h.includes('Tue '))).toBe(true);
});

test('the ride card follows the trip: riding, transfer, riding, walking, arrived', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await tickTo(page, '07:08:30');
  await expect(head(page)).toHaveText('On Bus 132 · off at 7:22am');
  await expect(card(page)).toContainText('Then Orange 7:32am · 5 min to spare');
  await expect(card(page).locator('.timeline .step-stops')).toHaveText(['Main St @ South St → Washington St opp Oak Grove Sta', 'Oak Grove → State']);
  await expect(card(page).locator('.timeline .walk-icon')).toHaveCount(2); // transfer, final walk
  await expect(card(page).locator('.ride-stops')).toContainText('Pond St @ Stone Zoo');
  await expect(card(page).locator('.ride-stops')).toContainText('Washington St opp Oak Grove Sta');
  await expect(card(page).getByRole('button', { name: 'Missed it' })).toBeVisible();
  await expect(bar(page)).toBeHidden();

  await tickTo(page, '07:11');
  await expect(card(page).getByRole('button', { name: 'Missed it' })).toHaveCount(0); // 2 min after boarding
  await tickTo(page, '07:23');
  await expect(head(page)).toHaveText('Transfer · Orange 7:32am');
  await tickTo(page, '07:33');
  await expect(head(page)).toHaveText('On Orange · off at 7:47am');
  await tickTo(page, '07:48');
  await expect(head(page)).toHaveText('Walking · arrive 7:57am');
  await tickTo(page, '07:58');
  await expect(head(page)).toHaveText('Arrived ~7:57am');
  await card(page).getByRole('button', { name: 'Done' }).click();
  await tick(page, 500);
  await expect(card(page)).toHaveCount(0);
  await expect(toast(page)).toBeHidden(); // Done has no Undo
});

test('Missed it on the first leg goes back to waiting at the stop', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await tickTo(page, '07:08:30');
  await card(page).getByRole('button', { name: 'Missed it' }).click();
  await tick(page, 1000);
  await expect(card(page)).toHaveCount(0);
  await expect(bar(page)).toContainText('At the stop since 7:08am');
  await expect(page.locator('.row.catch .big')).toContainText('7:36am');
});

test('a bus running late re-plans the transfer and says what was missed', async ({ page }) => {
  const scenario = commute();
  await openApp(page, { time: '07:00', scenario });
  await atTheStop(page);
  await tickTo(page, '07:09');
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange 7:32am · 5 min to spare');
  // On board, the bus starts running 8 min late: off at 7:30, needs 7:35 for the Orange.
  scenario.trips.find(t => t.id === '132in-0708').live = { delay: 8, stops: ['5991'] };
  await tickTo(page, '07:11');
  await expect(head(page)).toHaveText('On Bus 132 · off at 7:30am');
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange 7:38am (missed 7:32am)');
  await expect(card(page).locator('.ride-outlook')).toHaveClass(/warn/);
});

test('a planned train that falls behind gives way to an earlier one, silently', async ({ page }) => {
  const scenario = commute();
  await openApp(page, { time: '07:00', scenario });
  await atTheStop(page);
  await tickTo(page, '07:09');
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange 7:32am · 5 min to spare');
  // The planned 7:32 now leaves at 7:42; the 7:38 is still catchable (off at 7:22 + 5 min).
  scenario.trips.find(t => t.id === 'OLin-0732').live = { delay: 10 };
  await tickTo(page, '07:11');
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange 7:38am · 11 min to spare');
  await expect(card(page).locator('.ride-outlook')).not.toHaveClass(/warn/);
  await tickTo(page, '07:39');
  await expect(head(page)).toHaveText('On Orange · off at 7:53am');
});

test('a long ride lists the next 3 stops, the stop before the drop-off, and expands', async ({ page }) => {
  // Bus 132 inbound with its 14 stops between Pond St and Oak Grove.
  const middle = ['15999', '16000', '16001', '5975', '5976', '5978', '5980', '5982', '5983', '5985', '5986', '5987', '5988', '5990'];
  const scenario = commute();
  scenario.trips = [...scenario.trips.filter(t => !t.id.startsWith('132in')),
    ...series({ prefix: '132in', route: '132', direction: 1, first: '05:44', every: 28, count: 40,
      stops: [['25996', 0], ['25997', 4], ...middle.map((s, i) => [s, 5 + Math.floor(i * 9 / 14)]), ['5991', 14]] })];
  await openApp(page, { time: '07:00', scenario });
  await atTheStop(page);
  await tickTo(page, '07:09');
  const stops = card(page).locator('.ride-stops');
  await expect(stops.locator('.ride-where')).toContainText('16 stops to go');
  await expect(stops.locator('.ride-stop')).toHaveText([
    /^Pond St @ Stone Zoo/, /^Wyoming Ave @ Fellsway E/, /^Wyoming Ave @ Ravine Rd/, '… 11 more',
    /^Washington St @ Glen Rock Rd/, /^Washington St opp Oak Grove Sta/]);
  await expect(stops.locator('.ride-stop.drop')).toHaveText(/^Washington St opp Oak Grove Sta/);
  await stops.getByRole('button', { name: '… 11 more' }).click();
  await tick(page, 300);
  await expect(stops.locator('div.ride-stop')).toHaveCount(16);
  await tick(page, 60_000); // stays open across polls
  await expect(stops.locator('div.ride-stop')).toHaveCount(16);
  await stops.getByRole('button', { name: 'Show fewer' }).click();
  await tick(page, 300);
  await expect(stops.locator('div.ride-stop')).toHaveCount(5);
});

test('Later one? moves the ride to a vehicle that left after the assumed one', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await tickTo(page, '07:39');
  await expect(head(page)).toHaveText('On Orange · off at 7:47am');
  await card(page).getByRole('button', { name: 'Later one?' }).click();
  await card(page).getByRole('button', { name: 'Orange 7:38am' }).click();
  await tick(page, 500);
  await expect(head(page)).toHaveText('On Orange · off at 7:53am');
});

test('Cancel ends tracking at once, with Undo in a toast; tapping the toast dismisses it', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await tickTo(page, '07:09');
  await card(page).getByRole('button', { name: 'Cancel' }).click();
  await tick(page, 300);
  await expect(card(page)).toHaveCount(0);
  await expect(toast(page)).toContainText('Tracking cancelled');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await tick(page, 1000);
  await expect(head(page)).toHaveText('On Bus 132 · off at 7:22am');
  await expect(toast(page)).toBeHidden();

  await card(page).getByRole('button', { name: 'Cancel' }).click();
  await tick(page, 300);
  await toast(page).locator('span').click();
  await expect(toast(page)).toBeHidden();
  await expect(card(page)).toHaveCount(0);

  await atTheStop(page);
  await bar(page).getByRole('button', { name: 'Cancel' }).click();
  await tick(page, 300);
  await expect(toast(page)).toBeVisible();
  await tick(page, 5200);
  await expect(toast(page)).toBeHidden();
  await expect(bar(page)).not.toContainText('At the stop since');
});

test('Track this trip pins a later departure and boards it when it leaves', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const second = page.locator('.row').nth(1);
  await second.click();
  await second.getByRole('button', { name: 'Track this trip' }).click();
  await tick(page, 1000);
  await expect(page.locator('.row.tracked .big')).toContainText('7:30am'); // leave-by kept in the list
  await expect(page.locator('.row.tracked').getByRole('button', { name: 'Stop tracking' })).toHaveText('Tracking ✕');
  await expect(bar(page)).toContainText('Tracking Bus 132 7:36am');
  await tickTo(page, '07:09');
  await expect(card(page)).toHaveCount(0); // the 7:08 left without boarding
  await tickTo(page, '07:36:30');
  await expect(head(page)).toHaveText('On Bus 132 · off at 7:50am');
});

test('Tracking ✕ ends plain tracking, with Undo', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const second = page.locator('.row').nth(1);
  await second.click();
  await second.getByRole('button', { name: 'Track this trip' }).click();
  await tick(page, 1000);
  await page.locator('.row.tracked').getByRole('button', { name: 'Stop tracking' }).click();
  await tick(page, 300);
  await expect(page.locator('.row.tracked')).toHaveCount(0);
  await expect(bar(page)).not.toContainText('Tracking');
  await expect(toast(page)).toContainText('Tracking cancelled');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await tick(page, 1000);
  await expect(bar(page)).toContainText('Tracking Bus 132 7:36am');
  await expect(page.locator('.row.tracked .big')).toContainText('7:30am');
});

test('Tracking ✕ while at the stop keeps the at-stop state and drops the pin', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  const second = page.locator('.row').nth(1);
  await second.click();
  await second.getByRole('button', { name: 'Track this trip' }).click();
  await tick(page, 1000);
  await expect(page.locator('.row.catch .big')).toContainText('7:36am');
  await page.locator('.row.tracked').getByRole('button', { name: 'Stop tracking' }).click();
  await tick(page, 1000);
  await expect(bar(page)).toContainText('At the stop since 7:00am');
  await expect(page.locator('.row.tracked')).toHaveCount(0);
  await expect(page.locator('.row.catch .big')).toContainText('7:08am');
  await expect(toast(page)).toContainText('Tracking cancelled');
});

test('a leg with several routes is labeled by what they share, each vehicle by its own', async ({ page }) => {
  const labels = { 'Green-B': 'Green B', 'Green-C': 'Green C', 'Green-D': 'Green D', 'Green-E': 'Green E' };
  const config = { trips: [{ name: 'Downtown', legs: [
    { kind: 'walk', minutes: 5 },
    { kind: 'transit', route: 'Green-B', also: ['Green-C', 'Green-D', 'Green-E'], direction_id: 0, stop: 'place-gover', alight: 'place-pktrm',
      label: 'Green', color: '00843D', routeLabels: labels },
    { kind: 'walk', minutes: 5 },
  ] }] };
  const stops = [['place-gover', 0], ['place-pktrm', 2]];
  const scenario = { alerts: [], trips: [
    ...series({ prefix: 'GD', route: 'Green-D', direction: 0, first: '06:00', every: 10, count: 20, stops }),
    ...series({ prefix: 'GB', route: 'Green-B', direction: 0, first: '06:05', every: 10, count: 20, stops }),
  ] };
  await openApp(page, { time: '06:40', config, scenario });
  const rows = page.locator('.row');
  await expect(rows.first().locator('.strip')).toHaveText(/^\s*Green\s*$/);
  const greenB = rows.filter({ hasText: '6:49am' }); // leave-by for the 6:55 B
  await greenB.click();
  await expect(greenB.locator('.timeline')).toContainText('Green B 6:55am → 6:57am');
  const greenD = rows.filter({ hasText: '6:44am' }); // leave-by for the 6:50 D
  await greenD.click();
  await expect(greenD.locator('.timeline')).toContainText('Green D 6:50am → 6:52am');
  await atTheStop(page);
  await expect(page.locator('.row.catch .big')).toContainText('Green B in 4 min');
  await tickTo(page, '06:45:30');
  await expect(head(page)).toHaveText('On Green B · off at 6:47am');
});

test('the screen stays on only near a drop-off or a transfer departure', async ({ page }) => {
  await openApp(page, { time: '07:00', init: WAKE_STUB });
  await atTheStop(page);
  const held = () => page.evaluate(() => window.wakeHeld);
  const expectAt = async (time, on) => { await tickTo(page, time); expect(await held(), time).toBe(on); };
  await expectAt('07:12', false);   // riding, 10 min before the drop-off
  await expectAt('07:20:30', true); // 2 min before 7:22
  await expectAt('07:24', false);   // transfer, 8 min before the 7:32
  await expectAt('07:30:30', true);
  await expectAt('07:34', false);
  await expectAt('07:45:30', true);
  await expectAt('07:50', false);   // walking
});
