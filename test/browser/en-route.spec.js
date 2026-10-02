// En route and trip tracking: Leaving now / At the stop, Track this trip, the ride card
// through its phases, Missed it, Later one?, transfer re-plan, Cancel + Undo, wake lock.
// Timeline used below (home to office): bus 132 7:08 → 7:22 (via Pond St 7:12), 5-min
// transfer, Orange 7:32 → 7:47 (every 6 min), 10-min walk → arrive 7:57.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, rowHeads, commute, WAKE_STUB } from './helpers.js';

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
  await expect(page.locator('.row.tracked').getByRole('button', { name: 'Tracking' })).toBeDisabled();
  await expect(bar(page)).toContainText('Tracking Bus 132 7:36am');
  await tickTo(page, '07:09');
  await expect(card(page)).toHaveCount(0); // the 7:08 left without boarding
  await tickTo(page, '07:36:30');
  await expect(head(page)).toHaveText('On Bus 132 · off at 7:50am');
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
