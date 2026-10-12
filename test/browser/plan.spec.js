// Auto-route (station to station on rail): setup's "+ Add trip (auto-route)" opens the pick in the
// trip editor; the main screen's "Go somewhere else…" makes a one-off trip (Save, ✕ Remove,
// removed once its ride is over). Stations from the recorded rail network.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const setup = page => page.locator('#setup');
const button = (page, name) => setup(page).getByRole('button', { name, exact: true });
const toast = page => page.locator('#toast');
const options = page => setup(page).locator('#plan-options .item');
// An option's lines: the total, the walks and each ride.
const lines = (page, i) => options(page).nth(i).locator(':scope > *');

// From or To: the leg picker (plan mode), a station by name; back on the planner.
async function pickStation(page, field, query, name) {
  await setup(page).locator(`#plan-${field}`).click();
  await setup(page).locator('#picker-search').fill(query);
  await setup(page).locator('.list .item', { hasText: name }).first().click();
}

test('setup: auto-route lists the ways between two stations and opens the pick in the trip editor', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.locator('#open-setup').click();
  await button(page, '+ Add trip (auto-route)').click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'kendall', 'Kendall/MIT');
  await expect(options(page)).toHaveCount(3);
  await expect(lines(page, 0)).toHaveText(['12 stops', 'Walk 5 min to Oak Grove', 'Orange to Downtown Crossing', 'Red to Kendall/MIT', 'Walk 5 min to Kendall/MIT']);
  await expect(lines(page, 1)).toHaveText(['11 stops', 'Walk 5 min to Oak Grove', 'Orange to Haymarket', /^Green.* to Park Street$/, 'Red to Kendall/MIT', 'Walk 5 min to Kendall/MIT']);
  // Change a station: the search comes back for it.
  await pickStation(page, 'to', 'state', 'State');
  await expect(options(page)).toHaveCount(1);
  await expect(lines(page, 0)).toHaveText(['8 stops', 'Walk 5 min to Oak Grove', 'Orange to State', 'Walk 5 min to State']);
  await pickStation(page, 'to', 'kendall', 'Kendall/MIT');
  await setup(page).getByLabel('Minutes from last stop').fill('7');
  await options(page).first().click();
  await expect(setup(page).getByLabel('Trip name')).toHaveValue('Oak Grove to Kendall/MIT');
  await expect(setup(page).getByLabel('Minutes to first stop')).toHaveValue('5');
  await expect(setup(page).getByLabel('Minutes from last stop')).toHaveValue('7');
  await expect(setup(page).getByLabel('Minutes to transfer')).toHaveValue('3');
  await expect(setup(page).locator('.leg-item')).toHaveText([/Orange.*Oak Grove → Downtown Crossing/, /Red.*Downtown Crossing → Kendall\/MIT/]);
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row .item b')).toHaveText(['Home to office', 'Office to home', 'Oak Grove to Kendall/MIT']);
  const trip = await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:config')).trips[2]);
  expect(trip.legs.map(l => [l.kind, l.route ?? l.minutes, l.stop, l.alight])).toEqual([
    ['walk', 5, undefined, undefined], ['transit', 'Orange', 'place-ogmnl', 'place-dwnxg'], ['transfer', 3, undefined, undefined],
    ['transit', 'Red', 'place-dwnxg', 'place-knncl'], ['walk', 7, undefined, undefined]]);
});

test('setup: no way within 2 transfers says so; the manual button still builds a trip by hand', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.locator('#open-setup').click();
  await button(page, '+ Add trip (auto-route)').click();
  await pickStation(page, 'from', 'mattapan', 'Mattapan');
  await pickStation(page, 'to', 'wonderland', 'Wonderland');
  await expect(setup(page)).toContainText('No way on the subway with 2 transfers or fewer.');
  await button(page, 'Cancel').click();
  await button(page, '+ Add trip (manual)').click();
  await expect(setup(page).locator('.legs-empty')).toContainText('No legs yet.');
});

// The one-off: Oak Grove → State on the Orange Line (the commute's Orange runs every 6 min from
// 5:20, 15 min to State); 5-min walks.
async function goSomewhere(page) {
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await options(page).first().click();
  await tick(page, 1000);
}

test('main screen: Go somewhere else… makes a one-off trip, kept across reloads, removed with Undo, then saved', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  // Under the trip buttons, above the rows; the status line at the bottom, above the version.
  const order = await page.evaluate(() => ['header', '#go-elsewhere', '#rows', '#status', 'footer.version']
    .map(sel => document.querySelector(sel).getBoundingClientRect().top));
  expect(order).toEqual([...order].sort((x, y) => x - y));
  await expect(page.locator('#status-text')).toHaveText('Updated 7:00am');
  await goSomewhere(page);
  const bar = page.locator('#oneoff');
  await expect(bar).toBeVisible();
  await expect(page.locator('#toggle select')).toHaveValue('2');
  await expect(page.locator('#toggle select option:checked')).toHaveText('Oak Grove to State (one-off)');
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
  // ✕ Remove, then Undo.
  await bar.getByRole('button', { name: 'Remove one-off trip' }).click();
  await expect(bar).toBeHidden();
  await expect(page.locator('#toggle button')).toHaveText(['Home to office', 'Office to home']);
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(bar).toBeVisible();
  await expect(page.locator('#toggle select option:checked')).toHaveText('Oak Grove to State (one-off)');
  // Save: a saved trip at the same place; the bar goes.
  await bar.getByRole('button', { name: 'Save' }).click();
  await expect(bar).toBeHidden();
  await expect(toast(page)).toContainText('Trip saved');
  await expect(page.locator('#toggle select option:checked')).toHaveText('Oak Grove to State');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:config')).trips.map(t => t.name)))
    .toEqual(['Home to office', 'Office to home', 'Oak Grove to State']);
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
