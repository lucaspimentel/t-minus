// "Plan a trip" (station to station on rail): setup's "+ Plan a trip" and the main screen's
// "Plan a trip…" open the same planner; "Save trip" opens the pick in the trip editor, "See
// departures" (timed options only) makes a one-off trip (a banner: Save, ✕, removed once its ride
// is over). Stations from the recorded rail network; without the server (unreachable here) the
// options are untimed.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, at, planOptions, optionLines, expandOption, pickOption } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const setup = page => page.locator('#setup');
const button = (page, name) => setup(page).getByRole('button', { name, exact: true });
const toast = page => page.locator('#toast');
const options = planOptions;
// An option's lines: the total, the walks and each ride.
const lines = optionLines;

// From or To: the leg picker (plan mode), a station by name; back on the planner.
async function pickStation(page, field, query, name) {
  await setup(page).locator(`#plan-${field}`).click();
  await setup(page).locator('#picker-search').fill(query);
  await setup(page).locator('.list .item', { hasText: name }).first().click();
}

test('setup: auto-route lists the ways between two stations and opens the pick in the trip editor', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.locator('#open-setup').click();
  await button(page, '+ Plan a trip').click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'kendall', 'Kendall/MIT');
  await expect(options(page)).toHaveCount(3);
  await expect(lines(page, 0)).toHaveText(['12 stops', /^Orange\s*Red$/]);
  await expect(lines(page, 1)).toHaveText(['11 stops', /^Orange\s*Green.*Red$/]);
  // Expanded: the timeline, without times (a saved trip is used at many times of day).
  const tl = await expandOption(page, 1);
  await expect(tl.locator('.step.stop .n')).toHaveText(['Oak Grove', 'Haymarket', 'Haymarket', 'Park Street', 'Park Street', 'Kendall/MIT']);
  await expect(tl.locator('.step.ride')).toHaveText(['Orange Line · 7 stops', /^Green Line.* · 2 stops$/, 'Red Line · 2 stops']);
  await expect(tl.locator('.step.walk')).toHaveText(['Walk 5 min', 'Transfer', 'Transfer', 'Walk 5 min']);
  await expect(tl.locator('.step.stop .t, .step.end .t')).toHaveText(['', '', '', '', '', '', '', '']);
  await expect(tl.locator('.badge')).toHaveCount(0);
  // Untimed: "Save trip" only; the request asked for times.
  await expect(options(page).nth(1).locator('.row-foot button')).toHaveText(['Save trip']);
  await expect(setup(page)).toContainText('Pick one to save it');
  await options(page).nth(1).locator('.row-toggle').click(); // collapses
  await expect(options(page).nth(1).locator('.timeline')).toHaveCount(0);
  // Change a station: the search comes back for it.
  await pickStation(page, 'to', 'state', 'State');
  await expect(options(page)).toHaveCount(1);
  await expect(lines(page, 0)).toHaveText(['8 stops', /^Orange$/]);
  await pickStation(page, 'to', 'kendall', 'Kendall/MIT');
  await setup(page).getByLabel('Minutes from last stop').fill('7');
  await pickOption(page);
  await expect(setup(page).getByLabel('Trip name')).toHaveValue('Oak Grove → Kendall/MIT');
  await expect(setup(page).getByLabel('Minutes to first stop')).toHaveValue('5');
  await expect(setup(page).getByLabel('Minutes from last stop')).toHaveValue('7');
  await expect(setup(page).getByLabel('Minutes to transfer')).toHaveValue('3');
  await expect(setup(page).locator('.leg-item')).toHaveText([/Orange.*Oak Grove → Downtown Crossing/, /Red.*Downtown Crossing → Kendall\/MIT/]);
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row .item b')).toHaveText(['Home to office', 'Office to home', 'Oak Grove → Kendall/MIT']);
  const trip = await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:config')).trips[2]);
  expect(trip.legs.map(l => [l.kind, l.route ?? l.minutes, l.stop, l.alight])).toEqual([
    ['walk', 5, undefined, undefined], ['transit', 'Orange', 'place-ogmnl', 'place-dwnxg'], ['transfer', 3, undefined, undefined],
    ['transit', 'Red', 'place-dwnxg', 'place-knncl'], ['walk', 7, undefined, undefined]]);
});

test('setup: no way within 2 transfers says so; "Build it by hand" opens an empty trip', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.locator('#open-setup').click();
  await button(page, '+ Plan a trip').click();
  await pickStation(page, 'from', 'mattapan', 'Mattapan');
  await pickStation(page, 'to', 'wonderland', 'Wonderland');
  await expect(setup(page)).toContainText('No way on the subway with 2 transfers or fewer.');
  await button(page, 'Build it by hand').click();
  await expect(setup(page).locator('.legs-empty')).toContainText('No legs yet.');
  await button(page, 'Cancel').click(); // back to the setup list
  await expect(button(page, '+ Plan a trip')).toBeVisible();
});

// The one-off: Oak Grove → State on the Orange Line (the commute's Orange runs every 6 min from
// 5:20, 15 min to State); 5-min walks. The server's timed answer is stubbed ("See departures" needs
// times).
const TIMED_OAK_STATE = () => ({ from: 'Oak Grove', to: 'State', timed: true, options: [{
  legs: [{ route: 'Orange', also: [], direction_id: 0, stop: 'place-ogmnl', alight: 'place-state', stopName: 'Oak Grove', alightName: 'State', stops: 8 }],
  transfers: [], minutes: 15, walkBefore: 0, walkAfter: 0, leave: at('07:02'), arrive: at('07:28'),
  deps: [{ dep: at('07:08'), arr: at('07:23'), source: 'scheduled' }],
}] });
async function goSomewhere(page) {
  await page.route(/\/api\/plan\?/, route => route.fulfill({ json: TIMED_OAK_STATE() }));
  await page.getByRole('button', { name: 'Plan a trip…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await expect(setup(page)).toContainText('Pick one to see its departures or save it');
  await pickOption(page, 0, 'See departures');
  await tick(page, 1000);
}

test('main screen: Plan a trip… and See departures make a one-off trip, kept across reloads, removed with Undo, then saved', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  // Under the trip buttons, above the rows; the status line at the bottom, above the version.
  const order = await page.evaluate(() => ['header', '#plan-trip', '#rows', '#status', 'footer.version']
    .map(sel => document.querySelector(sel).getBoundingClientRect().top));
  expect(order).toEqual([...order].sort((x, y) => x - y));
  await expect(page.locator('#status-text')).toHaveText('Updated 7:00am');
  await goSomewhere(page);
  const bar = page.locator('#oneoff');
  await expect(bar).toBeVisible();
  // A banner under the trip buttons, above "Plan a trip…" and the trip's own bar.
  await expect(bar).toHaveText(/^One-off trip: not saved\s*Save\s*✕$/);
  const tops = await page.evaluate(() => ['header', '#oneoff', '#plan-trip', '#enroute']
    .map(sel => document.querySelector(sel).getBoundingClientRect().top));
  expect(tops).toEqual([...tops].sort((x, y) => x - y));
  await expect(page.locator('#toggle select')).toHaveValue('2');
  await expect(page.locator('#toggle select option:checked')).toHaveText('Oak Grove → State (one-off)');
  await expect(page.locator('.row .strip').first()).toHaveText(/^\s*Orange\s*$/);
  await expect(page.locator('.row:not(.missed) .big').first()).toContainText('7:02am'); // the 7:08 train, 5-min walk + 1 min early
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:config')).trips.length)).toBe(2); // not saved
  // Kept across a reload, and shown first.
  await page.reload();
  await page.locator('.row').first().waitFor();
  await expect(bar).toBeVisible();
  // Another trip picked by hand: the bar goes; back on the one-off, it returns.
  await page.locator('#toggle select').selectOption('0');
  await expect(bar).toBeHidden();
  await page.locator('#toggle select').selectOption('2');
  await expect(bar).toBeVisible();
  // ✕ (Remove), then Undo.
  await bar.getByRole('button', { name: 'Remove one-off trip' }).click();
  await expect(bar).toBeHidden();
  await expect(page.locator('#toggle button')).toHaveText(['Home to office', 'Office to home']);
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(bar).toBeVisible();
  await expect(page.locator('#toggle select option:checked')).toHaveText('Oak Grove → State (one-off)');
  // Save: a saved trip at the same place; the bar goes.
  await bar.getByRole('button', { name: 'Save' }).click();
  await expect(bar).toBeHidden();
  await expect(toast(page)).toContainText('Trip saved');
  await expect(page.locator('#toggle select option:checked')).toHaveText('Oak Grove → State');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:config')).trips.map(t => t.name)))
    .toEqual(['Home to office', 'Office to home', 'Oak Grove → State']);
  expect(await page.evaluate(() => localStorage.getItem('t-minus:one-off'))).toBeNull();
});

test('a one-off trip ends with its ride', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await goSomewhere(page);
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:02:30'); // the 7:02 train left: boarded
  await expect(page.locator('.row.ride')).toBeVisible();
  await tickTo(page, '07:23'); // off at 7:17, 5-min walk: arrived
  await page.locator('.row.ride').getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#oneoff')).toBeHidden();
  await expect(page.locator('#toggle button')).toHaveText(['Home to office', 'Office to home']);
  expect(await page.evaluate(() => localStorage.getItem('t-minus:one-off'))).toBeNull();
});
