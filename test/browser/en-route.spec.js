// En route and trip tracking: Leaving now / At the stop, the bell (pin, boarding question), the ride card
// through its phases, Missed it, Different train?, transfer re-plan, Cancel + Undo, wake lock.
// Timeline used below (home to office): bus 132 7:08 → 7:22 (via Pond St 7:12), 5-min
// transfer, Orange 7:32 → 7:47 (every 6 min), 10-min walk → arrive 7:57.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, rowHeads, commute, WAKE_STUB, riding, CONFIG } from './helpers.js';
import { series } from './fake-mbta.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const bar = page => page.locator('#enroute');
const card = page => page.locator('.row.ride');
const head = page => page.locator('.ride-head');
// The ridden leg's drop-off time, in the card's timeline (the headline has minutes, not the time).
const offAt = (page, t) => expect(page.locator('.row.ride .step.stop', { hasText: t })).not.toHaveCount(0);
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
  await expect(head(page)).toHaveText(riding('Bus 132'));
  await offAt(page, '7:22am');
  await expect(card(page)).toContainText('Then Orange Line toward Forest Hills ~7:32am · 5 min to spare');
  await expect(card(page).locator('.summary')).toHaveCount(0); // the arrival time is the timeline's end only
  // The buttons sit below the timeline, not on its last row.
  const gap = await card(page).evaluate(c => c.querySelector('.ride-btns').getBoundingClientRect().top - c.querySelector('.timeline').getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(8);
  const tl = card(page).locator('.timeline');
  await expect(tl.locator('.step.stop .n')).toHaveText(['Main St @ South St', 'Washington St opp Oak Grove Sta', 'Oak Grove', 'State']);
  await expect(tl.locator('.walk-icon')).toHaveCount(2); // transfer, final walk
  // Progress: the boarding stop is done; the ride and its drop-off are current.
  const cls = loc => loc.evaluateAll(els => els.map(e => (e.classList.contains('done') ? 'done' : e.classList.contains('current') ? 'current' : '')));
  expect(await cls(tl.locator('.step'))).toEqual(['done', 'current', '', '', 'current', '', '', '', '', '', '']); // 2 on the bar: vehicle, Pond St
  await expect(tl.locator('.step.end')).toHaveText([/^Arrive\s*~7:57am$/]); // no Leave on the ride card
  // The stops left sit on the ridden leg's bar, after the vehicle marker, before the drop-off row.
  await expect(tl.locator('.tl-leg').first().locator('.step.mid')).toHaveText(['', /^Pond St @ Stone Zoo\s*7:12am$/]);
  await expect(tl.locator('.tl-leg').first().locator('.step.mid.gap .veh')).toHaveCount(1);
  await expect(card(page).getByRole('button', { name: 'Missed it' })).toBeVisible();
  await expect(bar(page)).toBeHidden();

  await tickTo(page, '07:11');
  await expect(card(page).getByRole('button', { name: 'Missed it' })).toHaveCount(0); // 2 min after boarding
  await tickTo(page, '07:23');
  await expect(head(page)).toHaveText('Transfer · Orange ~7:32am');
  // The bus leg is done; the transfer and the Orange boarding stop are current.
  expect(await cls(tl.locator('.step'))).toEqual(['done', 'done', 'done', 'current', 'current', '', '', '', '']);
  await tickTo(page, '07:33');
  await expect(head(page)).toHaveText(riding('Orange'));
  await offAt(page, '7:47am');
  await tickTo(page, '07:48');
  await expect(head(page)).toHaveText('Walking · arrive ~7:57am');
  expect((await cls(tl.locator('.step'))).slice(-2)).toEqual(['current', 'current']); // last walk, Arrive
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

test('a bus running late: under the transfer time is tight; leaving before the arrival re-plans', async ({ page }) => {
  const scenario = commute();
  await openApp(page, { time: '07:00', scenario });
  await atTheStop(page);
  await tickTo(page, '07:09');
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange Line toward Forest Hills ~7:32am · 5 min to spare');
  // On board, the bus starts running 8 min late: off at 7:30, under the 5-min transfer to the
  // 7:32 Orange but still before it: kept, tight.
  const bus = scenario.trips.find(t => t.id === '132in-0708');
  bus.live = { delay: 8, stops: ['5991'] };
  await tickTo(page, '07:11');
  await expect(head(page)).toHaveText(riding('Bus 132'));
  await offAt(page, '7:30am');
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange Line toward Forest Hills ~7:32am · tight');
  await expect(card(page).locator('.ride-outlook')).toHaveClass(/warn/);
  // 11 min late: off at 7:33, after the 7:32 leaves: re-planned from 7:38 (7:33 + 5).
  bus.live = { delay: 11, stops: ['5991'] };
  await tickTo(page, '07:12');
  await offAt(page, '7:33am');
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange Line toward Forest Hills ~7:38am (missed 7:32am)');
  await expect(card(page).locator('.ride-outlook')).toHaveClass(/warn/);
});

// The 7:08 bus running 8 min late at every stop: leaves Main St at 7:16, off at 7:30. Once it
// has left, the fake API drops its predictions; only the schedule's 7:08 / 7:22 remain.
test('after a reload, a late bus that has left keeps its live times on the missed row', async ({ page }) => {
  const scenario = commute();
  scenario.trips.find(t => t.id === '132in-0708').live = { delay: 8 };
  await openApp(page, { time: '07:15', scenario });
  await tickTo(page, '07:17');
  const missed = page.locator('.row.missed .big');
  await expect(missed).toHaveText(/^Missed · left 1 min ago\s*7:16am$/);
  // The remembered live times are kept across the reload: the row stays on 7:16.
  await page.reload();
  await page.locator('.row').first().waitFor();
  await expect(missed).toHaveText(/^Missed · left \d min ago\s*7:16am$/);
});

test('after a reload, a ride\'s late bus keeps the live times it was stored with', async ({ page }) => {
  const scenario = commute();
  scenario.trips.find(t => t.id === '132in-0708').live = { delay: 8 };
  await openApp(page, { time: '07:00', scenario });
  await atTheStop(page);
  await tickTo(page, '07:31'); // off at 7:30: the bus has no predictions left
  await expect(head(page)).toHaveText(/^Transfer · Orange/);
  const tl = card(page).locator('.timeline');
  const busStops = tl.locator('.tl-leg').first().locator('.step.stop');
  await expect(busStops).toHaveText([/Main St @ South St\s*7:16am/, /Washington St opp Oak Grove Sta\s*7:30am/]);
  // Even without the remembered times (cleared), the ride's own stored live times win over the schedule.
  await page.evaluate(() => localStorage.removeItem('t-minus:last-live'));
  await page.reload();
  await page.locator('.row').first().waitFor();
  await expect(busStops).toHaveText([/Main St @ South St\s*7:16am/, /Washington St opp Oak Grove Sta\s*7:30am/]);
  await expect(tl.locator('.tl-leg').first().locator('.badge')).toHaveText('live');
});

// The commute's Orange runs every 6 min (7:26, 7:32, 7:38, …); the bus is off at 7:22, so the
// plan is the 7:32 (7:22 + 5-min transfer).
const choiceNames = page => card(page).locator('.ride-btns').last().getByRole('button').allInnerTexts();

test('in the transfer: I\'m at the stop takes the next train; Different train? picks one, which sticks', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await tickTo(page, '07:24');
  await expect(head(page)).toHaveText('Transfer · Orange ~7:32am');
  await card(page).getByRole('button', { name: 'Different train?' }).click();
  await tick(page, 300);
  expect(await choiceNames(page)).toEqual(['Orange ~7:26am', 'Orange ~7:38am', 'Orange ~7:44am', 'Orange ~7:50am']);
  await card(page).getByRole('button', { name: 'Orange ~7:38am' }).click();
  await tick(page, 300);
  await expect(head(page)).toHaveText('Transfer · Orange ~7:38am');
  await expect(card(page).getByRole('button', { name: 'Different train?' })).toBeVisible(); // closed
  // The pick sticks: the 7:32 is catchable and earlier, but no silent switch back.
  await tickTo(page, '07:25');
  await expect(head(page)).toHaveText('Transfer · Orange ~7:38am');
  // At the platform: the next train from now.
  await card(page).getByRole('button', { name: "I'm at the stop" }).click();
  await tick(page, 300);
  await expect(head(page)).toHaveText('Transfer · Orange ~7:26am');
  await expect(card(page).getByRole('button', { name: "I'm at the stop" })).toHaveCount(0); // nothing sooner
});

test('while riding: Different connection? lists the next leg after the arrival; the pick is kept even when tight', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await tickTo(page, '07:15');
  await card(page).getByRole('button', { name: 'Different connection?' }).click();
  await tick(page, 300);
  await expect(card(page).getByRole('button', { name: 'Keep this connection' })).toBeVisible();
  expect(await choiceNames(page)).toEqual(['Orange ~7:26am', 'Orange ~7:38am', 'Orange ~7:44am', 'Orange ~7:50am']);
  await card(page).getByRole('button', { name: 'Orange ~7:26am' }).click();
  await tick(page, 300);
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange Line toward Forest Hills ~7:26am · tight');
  await tickTo(page, '07:16');
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange Line toward Forest Hills ~7:26am · tight');
  await expect(card(page).getByRole('button', { name: 'Cancel trip' })).toBeVisible();
});

test('a planned train that falls behind gives way to an earlier one, silently', async ({ page }) => {
  // Every Orange train is predicted, as on the subway (an unpredicted scheduled one between
  // predicted ones isn't counted: predictionsFirst).
  const scenario = commute();
  for (const t of scenario.trips) if (t.route === 'Orange') t.live = true;
  await openApp(page, { time: '07:00', scenario });
  await atTheStop(page);
  await tickTo(page, '07:09');
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange Line toward Forest Hills 7:32am · 5 min to spare');
  // The planned 7:32 now leaves at 7:42; the 7:38 is still catchable (off at 7:22 + 5 min).
  scenario.trips.find(t => t.id === 'OLin-0732').live = { delay: 10 };
  await tickTo(page, '07:11');
  await expect(card(page).locator('.ride-outlook')).toHaveText('Then Orange Line toward Forest Hills 7:38am · 11 min to spare');
  await expect(card(page).locator('.ride-outlook')).not.toHaveClass(/warn/);
  await tickTo(page, '07:39');
  await expect(head(page)).toHaveText(riding('Orange'));
  await offAt(page, '7:53am');
});

test('a long ride lists the next 2 stops, the stop before the drop-off, and expands', async ({ page }) => {
  // Bus 132 inbound with its 14 stops between Pond St and Oak Grove.
  const middle = ['15999', '16000', '16001', '5975', '5976', '5978', '5980', '5982', '5983', '5985', '5986', '5987', '5988', '5990'];
  const scenario = commute();
  scenario.trips = [...scenario.trips.filter(t => !t.id.startsWith('132in')),
    ...series({ prefix: '132in', route: '132', direction: 1, first: '05:44', every: 28, count: 40,
      stops: [['25996', 0], ['25997', 4], ...middle.map((s, i) => [s, 5 + Math.floor(i * 9 / 14)]), ['5991', 14]] })];
  await openApp(page, { time: '07:00', scenario });
  await atTheStop(page);
  await tickTo(page, '07:09');
  // On the ridden leg's bar: the vehicle (between stops), then the stops left; the drop-off is the leg's last row.
  const leg = card(page).locator('.tl-leg').first();
  const stops = leg.locator('.step.mid:not(.gap):not(.more)');
  await expect(head(page)).toHaveText(riding('Bus 132', 16));
  await expect(leg.locator('.step.mid.here')).toHaveCount(0); // not stopped at a stop
  await expect(leg.locator('.step.mid')).toHaveText([
    '', /^Pond St @ Stone Zoo/, /^Wyoming Ave @ Fellsway E/, '… 12 more',
    /^Washington St @ Glen Rock Rd/]);
  await expect(leg.locator('.step.stop').last()).toHaveText(/^Washington St opp Oak Grove Sta/);
  await leg.getByRole('button', { name: '… 12 more' }).click();
  await tick(page, 300);
  await expect(stops).toHaveCount(15);
  await tick(page, 60_000); // stays open across polls
  await expect(stops).toHaveCount(15);
  await leg.getByRole('button', { name: 'Show fewer' }).click();
  await tick(page, 300);
  await expect(stops).toHaveCount(3);
});

test('stopped at a stop: an "At <stop>" row carries the vehicle on the bar', async ({ page }) => {
  const scenario = commute();
  scenario.dwell = true;
  await openApp(page, { time: '07:00', scenario });
  await atTheStop(page);
  await tickTo(page, '07:12:10'); // at Pond St (7:12), dwelling
  await page.locator('#refresh').click();
  await tick(page, 1000);
  const leg = card(page).locator('.tl-leg').first();
  await expect(leg.locator('.step.mid')).toHaveText(['At Pond St @ Stone Zoo']);
  await expect(leg.locator('.step.mid.here .veh')).toHaveCount(1);
  await expect(head(page)).toHaveText('Next stop: get off');
});

test('with only the drop-off left, the headline says to get off; the timeline names the stop', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await tickTo(page, '07:09');
  await expect(head(page)).toHaveText(riding('Bus 132', 2));
  await tickTo(page, '07:17');
  await expect(head(page)).toHaveText('Next stop: get off');
  await expect(card(page).locator('.step.mid:not(.gap)')).toHaveCount(0);
  await expect(card(page).locator('.step.mid.gap .veh')).toHaveCount(1);
  await expect(card(page).getByText('Washington St opp Oak Grove Sta')).toHaveCount(1);
});

test('Different train? moves the ride to a later or an earlier vehicle that left in the last 15 min', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await tickTo(page, '07:39');
  await expect(head(page)).toHaveText(riding('Orange'));
  await offAt(page, '7:47am');
  await card(page).getByRole('button', { name: 'Different train?' }).click();
  await expect(card(page).getByRole('button', { name: /^Orange / })).toHaveText(['Orange ~7:26am', 'Orange ~7:38am']);
  await card(page).getByRole('button', { name: 'Orange ~7:38am' }).click();
  await tick(page, 500);
  await expect(head(page)).toHaveText(riding('Orange'));
  await offAt(page, '7:53am');
  // Back to an earlier one.
  await card(page).getByRole('button', { name: 'Different train?' }).click();
  await card(page).getByRole('button', { name: 'Orange ~7:32am' }).click();
  await tick(page, 500);
  await expect(head(page)).toHaveText(riding('Orange'));
  await offAt(page, '7:47am');
});

test('Cancel ends tracking at once, with Undo in a toast; tapping the toast dismisses it', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  await tickTo(page, '07:09');
  await card(page).getByRole('button', { name: 'Cancel trip' }).click();
  await tick(page, 300);
  await expect(card(page)).toHaveCount(0);
  await expect(toast(page)).toContainText('Tracking cancelled');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await tick(page, 1000);
  await expect(head(page)).toHaveText(riding('Bus 132'));
  await offAt(page, '7:22am');
  await expect(toast(page)).toBeHidden();

  await card(page).getByRole('button', { name: 'Cancel trip' }).click();
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

// The bell ("🔔 Track"): pins the ride; it asks at the departure instead of boarding on its own.
const bell = (row, name = 'Track') => row.getByRole('button', { name, exact: true });

test('the bell pins a later departure; at its departure it asks, and Yes tracks the ride', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const second = page.locator('.row').nth(1);
  await second.click();
  await bell(second).click();
  await tick(page, 1000);
  await expect(page.locator('.row.tracked .big')).toContainText('7:30am'); // leave-by kept in the list
  await expect(bell(page.locator('.row.tracked'), 'Tracking')).toHaveAttribute('aria-pressed', 'true');
  await expect(bar(page)).toContainText('Tracking Bus 132 7:36am');
  await tickTo(page, '07:09');
  await expect(card(page)).toHaveCount(0); // the 7:08 left without boarding
  await tickTo(page, '07:36:30');
  await expect(card(page)).toHaveCount(0); // not boarded on its own
  await expect(bar(page)).toContainText('Did you get on the 7:36am Bus 132?');
  await expect(page.locator('.row.tracked')).toHaveCount(1); // the departed row stays outlined
  await bar(page).getByRole('button', { name: 'Yes' }).click();
  await tick(page, 1000);
  await expect(head(page)).toHaveText(riding('Bus 132'));
  await offAt(page, '7:50am');
});

test('"Missed it" drops the pin; unanswered, the question closes after 30 min', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const second = page.locator('.row').nth(1);
  await second.click();
  await bell(second).click();
  await tickTo(page, '07:36:30');
  await bar(page).getByRole('button', { name: 'Missed it' }).click();
  await tick(page, 1000);
  await expect(bar(page)).not.toContainText('Did you get on');
  await expect(page.locator('.row.tracked')).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  // Again on the next one, unanswered.
  const next = page.locator('.row:not(.missed)').first();
  await next.click();
  await bell(next).click();
  await tick(page, 1000);
  await expect(bar(page)).toContainText('Tracking Bus 132 8:04am');
  await tickTo(page, '08:04:30');
  await expect(bar(page)).toContainText('Did you get on the 8:04am Bus 132?');
  await tickTo(page, '08:34:30');
  await expect(bar(page)).not.toContainText('Did you get on');
  await expect(page.locator('.row.tracked')).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
});

test('the bell off ends plain tracking; Cancel in the bar has Undo; one bell at a time', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const second = page.locator('.row').nth(1);
  await second.click();
  await bell(second).click();
  await tick(page, 1000);
  await bell(page.locator('.row.tracked'), 'Tracking').click();
  await tick(page, 300);
  await expect(page.locator('.row.tracked')).toHaveCount(0);
  await expect(bar(page)).not.toContainText('Tracking');
  await bell(page.locator('.row').nth(1)).click();
  await tick(page, 300);
  await bar(page).getByRole('button', { name: 'Cancel' }).click();
  await tick(page, 300);
  await expect(page.locator('.row.tracked')).toHaveCount(0);
  await expect(toast(page)).toContainText('Tracking cancelled');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await tick(page, 1000);
  await expect(bar(page)).toContainText('Tracking Bus 132 7:36am');
  // Another departure's bell moves the pin.
  const third = page.locator('.row').nth(2);
  await third.click();
  await bell(third).click();
  await tick(page, 1000);
  await expect(page.locator('.row.tracked')).toHaveCount(1);
  await expect(bar(page)).toContainText('Tracking Bus 132 8:04am');
});

test('at the stop with the bell: boards on its own when reached; the bell off keeps the at-stop state', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await atTheStop(page);
  const second = page.locator('.row').nth(1);
  await second.click();
  await bell(second).click();
  await tick(page, 1000);
  await expect(page.locator('.row.catch .big')).toContainText('7:36am');
  await bell(page.locator('.row.tracked'), 'Tracking').click();
  await tick(page, 1000);
  await expect(bar(page)).toContainText('At the stop since 7:00am');
  await expect(page.locator('.row.tracked')).toHaveCount(0);
  await expect(page.locator('.row.catch .big')).toContainText('7:08am');
  await page.locator('.row').nth(1).click();
  await bell(page.locator('.row').nth(1)).click();
  await tickTo(page, '07:36:30');
  await expect(head(page)).toHaveText(riding('Bus 132'));
});

test('"Leaving now" with the bell on a ride it misses: asked at its departure', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const first = page.locator('.row').first();
  await first.click();
  await bell(first).click();
  await tickTo(page, '07:05');
  await bar(page).getByRole('button', { name: 'Leaving now' }).click(); // at the stop ~7:10, the 7:08 leaves first
  await tickTo(page, '07:08:30');
  await expect(card(page)).toHaveCount(0);
  await expect(bar(page)).toContainText('Did you get on the 7:08am Bus 132?');
  await bar(page).getByRole('button', { name: 'Yes' }).click();
  await tick(page, 1000);
  await expect(head(page)).toHaveText(riding('Bus 132'));
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
  await expect(greenB.locator('.timeline .step.ride')).toContainText('Green Line B · 2 min');
  await expect(greenB.locator('.timeline .step.stop .t')).toHaveText(['~6:55am', '~6:57am']);
  const greenD = rows.filter({ hasText: '6:44am' }); // leave-by for the 6:50 D
  await greenD.click();
  await expect(greenD.locator('.timeline .step.ride')).toContainText('Green Line D · 2 min');
  await atTheStop(page);
  await expect(page.locator('.row.catch .big')).toContainText('Green B in 4 min');
  await tickTo(page, '06:45:30');
  await expect(head(page)).toHaveText(riding('Green B'));
  await offAt(page, '6:47am');
});

test('the screen stays on while riding and transferring, not on the final walk', async ({ page }) => {
  await openApp(page, { time: '07:00', init: WAKE_STUB });
  await atTheStop(page);
  const held = () => page.evaluate(() => window.wakeHeld);
  const expectAt = async (time, on) => { await tickTo(page, time); expect(await held(), time).toBe(on); };
  await expectAt('07:12', true);    // riding, 10 min before the drop-off
  await expectAt('07:24', true);    // transfer, 8 min before the 7:32
  await expectAt('07:40', true);
  await expectAt('07:50', false);   // walking
});

test('with Keep screen on while riding off, a tracked ride does not hold the screen on', async ({ page }) => {
  await openApp(page, { time: '07:00', init: WAKE_STUB, config: { ...CONFIG, wakeRiding: false } });
  await atTheStop(page);
  await tickTo(page, '07:12');
  expect(await page.evaluate(() => window.wakeHeld)).toBe(false);
});
