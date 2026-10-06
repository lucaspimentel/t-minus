// Setup: first run, adding a trip through the pickers (recorded route and stop lists), and the
// Undo toasts (discarded edits, removed leg, deleted trip, import), export.
import { test, expect } from '@playwright/test';
import { openApp, CONFIG } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
  // Dialogs only where a test expects one (`page.answerDialog`, used once).
  page.on('dialog', d => {
    const answer = page.answerDialog;
    page.answerDialog = null;
    if (!answer) throw new Error(`unexpected dialog: ${d.message()}`);
    answer(d);
  });
});

const setup = page => page.locator('#setup');
const toast = page => page.locator('#toast');
const tripNames = page => setup(page).locator('.trip-row .item b').allInnerTexts();
const storedNames = page => page.evaluate(() => JSON.parse(localStorage.getItem('mbta-leave-by:config')).trips.map(t => t.name));
const button = (page, name) => setup(page).getByRole('button', { name, exact: true });

// No trips: the main screen's empty state; "Set up a trip" opens a new trip.
async function startFirstTrip(page) {
  await page.locator('.empty .big-btn', { hasText: 'Set up a trip' }).click();
}

async function openSetup(page) {
  await openApp(page, { time: '07:00' });
  await page.locator('#open-setup').click();
  await expect(page.locator('#setup-done')).toBeVisible();
}

test('first run: build a trip with the pickers, save it, and see its rows', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  // No trips: the main screen's empty state, with Set up a trip and Import trips.
  await expect(page.locator('.empty-help')).toHaveText('Add the bus and train legs you take, and T-Minus tells you when to leave.');
  await expect(page.locator('.empty .secondary-btn')).toHaveText('Import trips');
  await startFirstTrip(page);
  await expect(button(page, 'Cancel')).toBeVisible();
  // An empty trip says what to do first; Save waits for a leg; the settings sit under "More".
  await expect(setup(page).locator('.legs-empty')).toContainText('No legs yet. Add the bus or train you take first.');
  await expect(button(page, 'Save')).toBeDisabled();
  await expect(button(page, '+ Add transit leg')).toHaveClass(/primary/);
  await expect(setup(page).getByLabel('Show automatically')).toBeHidden();
  await setup(page).locator('details.more summary').click();
  await setup(page).getByLabel('Show automatically').selectOption('window');
  await expect(setup(page).getByLabel('Shown from')).toBeVisible();
  // A change right after opening, before the 'toggle' event (it fires asynchronously), keeps "More" open.
  await setup(page).locator('details.more summary').click(); // close
  await expect(setup(page).getByLabel('Show automatically')).toBeHidden();
  await page.evaluate(() => new Promise(r => setTimeout(r, 50))); // the close's 'toggle' runs
  await page.evaluate(() => {
    document.querySelector('#setup details.more summary').click();
    const select = document.querySelector('#setup details.more select');
    select.value = 'never';
    select.dispatchEvent(new Event('change'));
  });
  await expect(setup(page).getByLabel('Show automatically')).toBeVisible();
  await setup(page).getByLabel('Show automatically').selectOption('never');
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('132');
  await setup(page).locator('.item', { hasText: 'Bus 132' }).click();
  // The ends of the line: Malden Center is boarded only toward Redstone (first under it), not
  // listed as served both ways.
  await setup(page).locator('#picker-search').fill('Malden');
  const listed = () => setup(page).locator('.section-head, .item').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
  expect((await listed())[0]).toBe('toward Redstone Shopping Center');
  expect((await listed()).filter(x => x.startsWith('Malden Center'))).toHaveLength(1);
  await setup(page).locator('#picker-search').fill('Main St @ South');
  // No direction step: stops on each side of the street are listed under their direction.
  await expect(setup(page).locator('.section-head')).toHaveText(['toward Redstone Shopping Center', 'toward Malden Center Station']);
  await setup(page).locator('.item', { hasText: 'Main St @ South St' }).nth(1).click(); // toward Malden Center Station
  await expect(setup(page).locator('.section-head')).toHaveText(['toward Malden Center Station']);
  // Rail connections at the stops (Malden Center and across from Oak Grove: Orange).
  await expect(setup(page).locator('.item', { hasText: 'Washington St opp Oak Grove Sta' }).locator('.conn')).toHaveText('Orange');
  // Only the stop nearest each station: not Glen Rock Rd or 14 Summer St (~124 m away, a block off).
  await expect(setup(page).locator('.item', { hasText: 'Washington St @ Glen Rock Rd' }).locator('.conn')).toHaveCount(0);
  await expect(setup(page).locator('.item', { hasText: '14 Summer St' }).locator('.conn')).toHaveCount(0);
  await expect(setup(page).locator('.item', { hasText: 'Malden Center' }).locator('.conn')).toHaveText('Orange');
  await expect(setup(page).locator('.item', { hasText: 'Pond St @ Stone Zoo' }).locator('.conn')).toHaveCount(0);
  await setup(page).locator('.item', { hasText: 'Washington St opp Oak Grove Sta' }).click();
  await expect(setup(page)).toContainText('Main St @ South St → Washington St opp Oak Grove Sta');
  await expect(setup(page).locator('.legs-empty')).toHaveCount(0);
  await expect(button(page, 'Save')).toBeEnabled();
  await expect(button(page, '+ Add transit leg')).toHaveClass(/accent/);
  // The name comes from the stops until one is typed.
  await expect(setup(page).getByLabel('Trip name')).toHaveValue('Main St @ South St → Washington St opp Oak Grove Sta');
  await setup(page).getByLabel('Trip name').fill('Commute');
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(1);
  expect(await storedNames(page)).toEqual(['Commute']);
  await page.locator('#setup-done').click();
  await expect(page.locator('.row').first()).toBeVisible();
  await expect(page.locator('.row').first().locator('.strip')).toContainText('Bus 132');
});

test('boarding at the end of a line asks for no direction', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('Orange');
  await setup(page).locator('.item', { hasText: 'Orange' }).first().click();
  await expect(setup(page).locator('.section-head')).toHaveCount(0); // stations serve both ways
  await setup(page).locator('#picker-search').fill('Oak Grove');
  await setup(page).locator('.item', { hasText: 'Oak Grove' }).click();
  await expect(setup(page).locator('.section-head')).toHaveText(['toward Forest Hills']);
  // Its own line is not a connection; Green branches merge.
  await expect(setup(page).locator('.item', { hasText: 'Haymarket' }).locator('.conn')).toHaveText('Green D/E');
  await expect(setup(page).locator('.item', { hasText: 'Wellington' }).locator('.conn')).toHaveCount(0);
  await setup(page).locator('.item', { hasText: 'Wellington' }).click();
  await expect(setup(page)).toContainText('toward Forest Hills · Oak Grove → Wellington');
});

test('the next leg lists the stations and routes near the transfer; a route boards at the nearest stop', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('132');
  await setup(page).locator('.item', { hasText: 'Bus 132' }).click();
  await setup(page).locator('.item', { hasText: 'Main St @ South St' }).nth(1).click();
  await setup(page).locator('.item', { hasText: 'Washington St opp Oak Grove Sta' }).click();
  await button(page, '+ Add transit leg').click();
  await expect(setup(page)).toContainText('Near Washington St opp Oak Grove Sta');
  await expect(setup(page).locator('.section-head')).toHaveText(['Stations', 'Routes']);
  await expect(setup(page).locator('.item b')).toHaveText(['Oak Grove', 'Orange']); // not Bus 132, just ridden
  await button(page, 'Show all routes').click();
  await expect(setup(page).locator('.item b', { hasText: /^Bus 132$/ })).toBeVisible();
  await expect(setup(page).locator('.item b', { hasText: /^Blue$/ })).toBeVisible();
  await expect(setup(page).locator('.item b', { hasText: /^Green D$/ })).toBeVisible();
  await setup(page).locator('.item', { hasText: 'Orange' }).first().click();
  // Straight to the drop-off: Oak Grove is the nearest Orange stop, and the end of the line.
  await expect(setup(page).locator('.muted').first()).toHaveText('Orange Line · from Oak Grove');
  await expect(setup(page).locator('.section-head')).toHaveText(['toward Forest Hills']);
});

test('after the Orange Line to Oak Grove, the next leg lists the buses there; elsewhere one tap away', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('State');
  await setup(page).locator('.item.station', { hasText: /^State/ }).first().click();
  await setup(page).locator('#picker-search').fill('Oak Grove');
  await setup(page).locator('.item', { hasText: 'Oak Grove' }).first().click();
  await expect(setup(page)).toContainText('· State → Oak Grove');
  // Oak Grove has only the Orange Line: the nearby routes instead (no Orange, no Oak Grove station).
  await button(page, '+ Add transit leg').click();
  await expect(setup(page)).toContainText('Near Oak Grove');
  await expect(setup(page).locator('.item b', { hasText: /^Bus 132$/ })).toBeVisible();
  await expect(setup(page).locator('.item b', { hasText: /^Orange$/ })).toHaveCount(0);
  await expect(setup(page).locator('.item.station')).toHaveCount(0);
  await button(page, 'Show all routes').click();
  await expect(setup(page).locator('.item b', { hasText: /^Orange$/ })).toBeVisible();
});

test('station-first: from a station to any station reachable without a transfer', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('Oak Gro');
  await expect(setup(page).locator('.item.station')).toHaveText([/^Oak Grove\s*Orange$/]);
  await setup(page).locator('.item.station', { hasText: 'Oak Grove' }).click();
  await expect(setup(page).locator('.muted').first()).toHaveText('From Oak Grove · Change');
  await expect(setup(page).locator('.section-head')).toHaveText(['Orange toward Forest Hills']);
  await setup(page).locator('#picker-search').fill('Downtown');
  await setup(page).locator('.item', { hasText: 'Downtown Crossing' }).click();
  await expect(setup(page)).toContainText('Orange toward Forest Hills · Oak Grove → Downtown Crossing');
  await expect(setup(page).locator('.leg-item .leg-title')).toHaveText(['Leg 1']);
  // The next leg starts from Downtown Crossing: one tap to Park Street on the Red Line.
  await button(page, '+ Add transit leg').click();
  await expect(setup(page).locator('.muted').first()).toHaveText('From Downtown Crossing · Change');
  // Not the Orange Line, just ridden; "Show Orange Line" brings it back.
  await expect(setup(page).locator('.section-head')).toHaveText(['Red toward Braintree / Ashmont', 'Red toward Alewife']);
  await expect(setup(page).locator('.arrived-note')).toHaveText('Hidden: the line you arrived on.');
  await button(page, 'Show Orange Line').click();
  await expect(setup(page).locator('.section-head')).toHaveText(['Red toward Braintree / Ashmont', 'Red toward Alewife', 'Orange toward Forest Hills', 'Orange toward Oak Grove']);
  await expect(button(page, 'Show Orange Line')).toHaveCount(0);
  await setup(page).getByRole('button', { name: 'Change' }).click();
  await expect(setup(page).locator('#picker-search')).toHaveAttribute('placeholder', 'Search stations or routes');
});

test('after the Blue Line to State, the next leg lists the Orange Line; a search still finds Blue', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('Airport');
  await setup(page).locator('.item.station', { hasText: 'Airport' }).first().click();
  await setup(page).locator('#picker-search').fill('State');
  await setup(page).locator('.item', { hasText: 'State' }).first().click();
  await button(page, '+ Add transit leg').click();
  await expect(setup(page).locator('.muted').first()).toHaveText('From State · Change');
  await expect(setup(page).locator('.section-head')).toHaveText(['Orange toward Forest Hills', 'Orange toward Oak Grove']);
  await setup(page).locator('#picker-search').fill('Bowd');
  await expect(setup(page).locator('.section-head')).toHaveText(['Blue toward Bowdoin']);
  await setup(page).locator('#picker-search').fill('');
  await expect(button(page, 'Show Blue Line')).toBeVisible();
  await button(page, 'Show Blue Line').click();
  await expect(setup(page).locator('.section-head')).toHaveText(['Orange toward Forest Hills', 'Orange toward Oak Grove', 'Blue toward Bowdoin', 'Blue toward Wonderland']);
});

test('a station list offers the buses near the drop-off', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  // The recorded stop lists have no bus near State: say bus 132 stops there.
  await page.route(/\/routes\?.*filter%5Bstop%5D/, route => route.fulfill({ json: { data: [
    { type: 'route', id: '132', attributes: { short_name: '132' } }, { type: 'route', id: 'Blue', attributes: { short_name: '' } }] } }));
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('Airport');
  await setup(page).locator('.item.station', { hasText: 'Airport' }).first().click();
  await setup(page).locator('#picker-search').fill('State');
  await setup(page).locator('.item', { hasText: 'State' }).first().click();
  await button(page, '+ Add transit leg').click();
  await expect(setup(page).locator('.section-head')).toHaveText(['Orange toward Forest Hills', 'Orange toward Oak Grove']);
  await button(page, 'Buses near State').click();
  await expect(setup(page)).toContainText('Near State');
  await expect(setup(page).locator('.item b', { hasText: /^Bus 132$/ })).toBeVisible();
});

test('the picker\'s search stays at the top, uncovered, while the list scrolls', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('Oak Grove');
  await setup(page).locator('.item.station', { hasText: 'Oak Grove' }).click();
  await expect(setup(page).locator('.item', { hasText: 'Forest Hills' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const search = setup(page).locator('#picker-search');
  await expect(search).toBeInViewport();
  const box = await search.boundingBox();
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [box.x + 2, box.y + 2]);
  expect(hit).toBe('picker-search');
  await search.fill('Wellington');
  await expect(setup(page).locator('.item')).toHaveText(['Wellington']);
});

test('station-first takes every line that makes the ride; the editor trims them', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await setup(page).getByLabel('Trip name').fill('Green');
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('Government');
  await setup(page).locator('.item.station', { hasText: 'Government Center' }).click();
  // Kenmore: not every branch stops there.
  await expect(setup(page).locator('.item', { hasText: 'Kenmore' })).toContainText('Kenmore · Green B/C/D');
  await expect(setup(page).locator('.item', { hasText: 'Copley' })).toContainText('Copley · Green (any)');
  await setup(page).locator('.item', { hasText: 'Park Street' }).first().click();
  await expect(setup(page)).toContainText('Green B/C/D/E toward Boston College · Government Center → Park Street');
  await setup(page).getByRole('checkbox', { name: 'Take Green D' }).click(); // re-renders without it
  await expect(setup(page)).toContainText('Green B/C/E toward');
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(1);
  const leg = await page.evaluate(() => JSON.parse(localStorage.getItem('mbta-leave-by:config')).trips[0].legs.find(l => l.kind === 'transit'));
  expect([leg.route, leg.also, leg.direction_id, leg.stop, leg.alight]).toEqual(['Green-B', ['Green-C', 'Green-E'], 0, 'place-gover', 'place-pktrm']);
});

test('route-first on a branching line offers only its branch (no Ashmont → Quincy)', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('Red');
  await setup(page).locator('.item', { hasText: 'Red' }).filter({ hasNot: page.locator('.conn') }).first().click();
  await setup(page).locator('#picker-search').fill('Ashmont');
  await setup(page).locator('.item', { hasText: 'Ashmont' }).click();
  await expect(setup(page).locator('.item', { hasText: 'JFK/UMass' })).toBeVisible();
  await expect(setup(page).locator('.item', { hasText: 'Quincy Center' })).toHaveCount(0);
});

test('a rail station shows only its own lines, not a nearby station\'s', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('Blue');
  await setup(page).locator('.item', { hasText: 'Blue' }).first().click();
  await setup(page).locator('#picker-search').fill('Maverick');
  await setup(page).locator('.item', { hasText: 'Maverick' }).click();
  await expect(setup(page).locator('.item', { hasText: 'State' }).locator('.conn')).toHaveText(['Orange']);
  await expect(setup(page).locator('.item', { hasText: 'Government Center' }).locator('.conn')).toHaveText(['Green B/C/D/E']);
});

test('a leg can take any route between its stops (Green branches)', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await setup(page).getByLabel('Trip name').fill('Green');
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('Green B');
  await setup(page).locator('.item', { hasText: 'Green B' }).click();
  await setup(page).locator('#picker-search').fill('Government');
  await setup(page).locator('.item', { hasText: 'Government Center' }).click();
  await setup(page).locator('#picker-search').fill('Park Street');
  await expect(setup(page).locator('.section-head')).toHaveText(['toward Boston College']);
  await setup(page).locator('.item', { hasText: 'Park Street' }).click();
  await expect(setup(page).locator('b')).toContainText(['Also take']);
  const boxes = setup(page).locator('label.check');
  await expect(boxes).toHaveText(['Green C', 'Green D', 'Green E']);
  for (const box of await boxes.all()) await expect(box.locator('input')).toBeChecked();
  await boxes.nth(1).locator('input').uncheck();
  await button(page, 'Done').click();
  await expect(setup(page)).toContainText('Green B/C/E toward Boston College · Government Center → Park Street');
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(1);
  const leg = await page.evaluate(() => JSON.parse(localStorage.getItem('mbta-leave-by:config')).trips[0].legs.find(l => l.kind === 'transit'));
  expect([leg.route, leg.also, leg.label, leg.routeLabels]).toEqual(['Green-B', ['Green-C', 'Green-E'], 'Green', { 'Green-B': 'Green B', 'Green-C': 'Green C', 'Green-E': 'Green E' }]);
});

test('Cancel discards edits with Undo; without edits there is no toast', async ({ page }) => {
  await openSetup(page);
  await setup(page).locator('.trip-row .item').first().click();
  await button(page, 'Cancel').click();
  await expect(toast(page)).toBeHidden();

  await setup(page).locator('.trip-row .item').first().click();
  await setup(page).getByLabel('Trip name').fill('Changed name');
  await button(page, 'Cancel').click();
  await expect(toast(page)).toContainText('Edits discarded');
  expect(await tripNames(page)).toEqual(['Home to office', 'Office to home']);
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(setup(page).getByLabel('Trip name')).toHaveValue('Changed name');
});

test('a saved trip with a time window opens with "More" open; removing every leg brings back the hint', async ({ page }) => {
  await openSetup(page);
  await setup(page).locator('.trip-row .item').first().click();
  await expect(setup(page).locator('details.more')).toHaveAttribute('open', '');
  await expect(setup(page).getByLabel('Show automatically')).toHaveValue('window');
  await expect(setup(page).getByLabel('Trip name')).toHaveValue('Home to office'); // a saved name is kept
  for (let i = 0; i < 2; i++) {
    await setup(page).getByRole('button', { name: 'Change leg 1' }).click();
    await button(page, 'Remove leg').click();
  }
  await expect(setup(page).locator('.legs-empty')).toBeVisible();
  await expect(button(page, 'Save')).toBeDisabled();
});

test('legs: tap to change (Remove leg is in there, with Undo), ↑↓ to reorder', async ({ page }) => {
  await openSetup(page);
  await setup(page).locator('.trip-row .item').first().click();
  const legs = setup(page).locator('.leg-row');
  await expect(legs).toHaveCount(2);
  await expect(setup(page).getByRole('button', { name: 'Move leg 1 up' })).toBeDisabled();
  await expect(setup(page).getByRole('button', { name: 'Move leg 2 down' })).toBeDisabled();
  await setup(page).getByRole('button', { name: 'Move leg 1 down' }).click();
  await expect(legs.locator('.leg-text')).toHaveText([/^Orange/, /^Bus 132/]);
  await setup(page).getByRole('button', { name: 'Move leg 2 up' }).click();
  // A new leg's picker has nothing to remove.
  await button(page, '+ Add transit leg').click();
  await expect(button(page, 'Remove leg')).toHaveCount(0);
  await button(page, 'Back').click(); // the To list from State, then the search
  await button(page, 'Back').click();
  await setup(page).getByRole('button', { name: 'Change leg 2' }).click();
  await button(page, 'Remove leg').click();
  await expect(legs).toHaveCount(1);
  await expect(toast(page)).toContainText('Leg removed');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(legs).toHaveCount(2);
  await expect(setup(page).getByLabel('Minutes to transfer')).toHaveValue('5');
});

test('Delete removes the trip at once, with Undo; a later save hides the toast', async ({ page }) => {
  await openSetup(page);
  await setup(page).locator('.trip-row .item').first().click();
  await button(page, 'Delete trip').click();
  expect(await tripNames(page)).toEqual(['Office to home']);
  expect(await storedNames(page)).toEqual(['Office to home']);
  await expect(toast(page)).toContainText('Trip deleted');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(2);
  expect(await tripNames(page)).toEqual(['Home to office', 'Office to home']);
  expect(await storedNames(page)).toEqual(['Home to office', 'Office to home']);

  await setup(page).locator('.trip-row .item').first().click();
  await button(page, 'Delete trip').click();
  await expect(toast(page)).toBeVisible();
  await setup(page).locator('.trip-row .item').first().click();
  await setup(page).getByLabel('Trip name').fill('Renamed');
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(1);
  await expect(toast(page)).toBeHidden();
});

test('the last trip can be deleted: settings stay, Done shows the empty main screen, setup reopens as first run', async ({ page }) => {
  const one = { ...CONFIG, trips: [CONFIG.trips[0]], departureCount: 3, apiKey: 'k1' };
  await openApp(page, { time: '07:00', config: one });
  await page.locator('#open-setup').click();
  await setup(page).locator('.trip-row .item').first().click();
  await button(page, 'Delete trip').click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(0);
  await expect(button(page, '+ Add trip')).toHaveClass(/primary/); // stands out with no trips
  await expect(setup(page).locator('.legs-empty')).toContainText('No trips yet.');
  await expect(toast(page)).toContainText('Trip deleted');
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('mbta-leave-by:config')));
  expect(await stored()).toMatchObject({ trips: [], departureCount: 3, apiKey: 'k1' });
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(1);
  await expect(button(page, '+ Add trip')).not.toHaveClass(/primary/);
  await setup(page).locator('.trip-row .item').first().click();
  await button(page, 'Delete trip').click();
  await expect(page.locator('#setup-done')).toBeEnabled();
  await page.locator('#setup-done').click();
  await expect(page.locator('#status-text')).toHaveText('No trips set up yet.');
  // The empty screen: a line of help and a large "Set up a trip"; no en-route bar or ↻.
  await expect(page.locator('#enroute')).toBeHidden();
  await expect(page.locator('#refresh')).toBeHidden();
  await expect(page.locator('.empty-help')).toHaveText('Add the bus and train legs you take, and T-Minus tells you when to leave.');
  const setUp = page.locator('.empty .big-btn');
  await expect(setUp).toHaveText('Set up a trip');
  expect((await setUp.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await setUp.click();
  await expect(button(page, '+ Add transit leg')).toBeVisible(); // a new trip
  // Cancel on that new trip: back to the empty state. Reopened with no trips: the same; the
  // settings are kept.
  await button(page, 'Cancel').click();
  await expect(page.locator('.empty .big-btn')).toBeVisible();
  await page.reload();
  await expect(page.locator('.empty .big-btn')).toBeVisible();
  expect(await stored()).toMatchObject({ trips: [], departureCount: 3, apiKey: 'k1' });
});

test('Reset deletes all trips and saved data after a confirm, keeping the API key', async ({ page }) => {
  await openApp(page, { time: '07:00', config: { ...CONFIG, apiKey: 'k1', departureCount: 3 } });
  await page.evaluate(() => {
    localStorage.setItem('mbta-leave-by:trip-override', JSON.stringify({ index: 1, setAt: Date.now() }));
    localStorage.setItem('mbta-leave-by:last-trip', '1');
  });
  await page.locator('#open-setup').click();
  const reset = button(page, 'Delete all trips and settings');
  // Cancelled: nothing changes.
  page.answerDialog = d => d.dismiss();
  await reset.click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(2);
  let asked = null;
  page.answerDialog = d => { asked = d.message(); d.accept(); };
  await reset.click();
  await expect(page.locator('.empty .big-btn')).toBeVisible(); // reloaded into the empty main screen
  expect(asked).toBe('Delete all trips and settings?');
  const keys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('mbta-leave-by:')));
  expect(keys).toEqual(['mbta-leave-by:config']);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mbta-leave-by:config')))).toEqual({ trips: [], apiKey: 'k1' });
});

test('no trips: Import trips opens setup with the import box; the empty list shares the help line', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await page.locator('.empty .secondary-btn').click();
  await expect(page.locator('#setup-io')).toBeVisible();
  await expect(setup(page).locator('.legs-empty')).toHaveText(/^No trips yet\. Add the bus and train legs you take, and T-Minus tells you when to leave\./);
  // Done with nothing set up: back to the empty state.
  await page.locator('#setup-done').click();
  await expect(page.locator('.empty .big-btn')).toBeVisible();
  await page.locator('.empty .secondary-btn').click();
  await setup(page).locator('textarea').fill(JSON.stringify(CONFIG));
  await button(page, 'Load').click();
  await expect(setup(page).locator('.trip-row .item b')).toHaveText(['Home to office', 'Office to home']);
});

test('Import over existing trips can be undone, settings included', async ({ page }) => {
  await openSetup(page);
  const departures = setup(page).getByLabel('Departures shown (1-8)');
  await expect(departures).toHaveValue('4');
  await button(page, 'Import').click();
  await setup(page).locator('textarea').fill(JSON.stringify({ ...CONFIG, trips: [CONFIG.trips[0]], departureCount: 6 }));
  await button(page, 'Load').click();
  await expect(toast(page)).toContainText('Trips replaced');
  expect(await tripNames(page)).toEqual(['Home to office']);
  await expect(departures).toHaveValue('6');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(2);
  await expect(departures).toHaveValue('4');
  expect(await storedNames(page)).toEqual(['Home to office', 'Office to home']);
});

test('Export shows the saved config; Done leaves setup and hides a pending toast', async ({ page }) => {
  await openSetup(page);
  await button(page, 'Export').click();
  const exported = JSON.parse(await setup(page).locator('textarea').inputValue());
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mbta-leave-by:config')));
  expect(exported).toEqual(stored);

  await setup(page).locator('.trip-row .item').first().click();
  await setup(page).getByLabel('Trip name').fill('x');
  await button(page, 'Cancel').click();
  await expect(toast(page)).toBeVisible();
  await page.locator('#setup-done').click();
  await expect(page.locator('.row').first()).toBeVisible();
  await expect(toast(page)).toBeHidden();
});

// "Show nearby" on the first leg: ~200 m north of Oak Grove.
const NEAR_OAK_GROVE = { latitude: 42.4385, longitude: -71.0711 };
const meters = t => { const m = t.match(/([\d.]+) (m|km)$/); return m ? +m[1] * (m[2] === 'km' ? 1000 : 1) : Infinity; };

test('Show nearby lists the stations and routes around you, nearest first; a route\'s stops sort by distance', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(NEAR_OAK_GROVE);
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await button(page, 'Show nearby').click();
  await expect(setup(page).getByText('Near you · within 800 m')).toBeVisible();
  const items = setup(page).locator('.list .item');
  // Stations: Oak Grove (its recorded network position, ~90 m); Malden Center is ~1.3 km away.
  await expect(setup(page).locator('.list .item.station')).toHaveText([/^Oak Grove.*90 m$/]);
  // Routes: 132 (its stop on Washington St, from the schedules) and Orange (its station).
  const routes = (await setup(page).locator('.list .item:not(.station)').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
  expect(routes).toHaveLength(2);
  expect(routes).toContainEqual(expect.stringMatching(/^Orange .* 90 m$/));
  expect(routes).toContainEqual(expect.stringMatching(/^Bus 132 .* 180 m$/)); // from the schedules
  const ds = routes.map(meters);
  expect(ds).toEqual([...ds].sort((a, b) => a - b));
  // 132: the boarding stops nearest first, with distances, within each section.
  await items.filter({ hasText: 'Bus 132' }).click();
  await expect(setup(page).getByText('Where do you board?')).toBeVisible();
  const sections = await setup(page).locator('.list').evaluate(list => {
    const out = [[]];
    for (const el of list.children) {
      if (el.classList.contains('section-head')) out.push([]);
      else if (el.classList.contains('item')) out.at(-1).push(el.innerText.replace(/\s+/g, ' ').trim());
    }
    return out.filter(s => s.length);
  });
  expect(sections.length).toBeGreaterThan(1);
  for (const s of sections) {
    const d = s.map(meters);
    expect(d.every(Number.isFinite)).toBe(true);
    expect(d).toEqual([...d].sort((a, b) => a - b));
  }
  // Sections by their nearest stop: the nearest of all is at the top.
  const firsts = sections.map(s => meters(s[0]));
  expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
  // Back twice: the plain first-leg list again.
  await button(page, 'Back').click();
  await button(page, 'Back').click();
  await expect(button(page, 'Show nearby')).toBeVisible();
});

test('Show nearby without location permission says so and keeps the list', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await startFirstTrip(page);
  await button(page, '+ Add transit leg').click();
  await button(page, 'Show nearby').click();
  await expect(setup(page).getByText('Location is off for this app.')).toBeVisible();
  await expect(setup(page).locator('.list .item', { hasText: 'Forest Hills - Oak Grove' })).toBeVisible();
});

test('Show nearby is only on the first leg', async ({ page }) => {
  await openSetup(page);
  await setup(page).locator('.trip-row .item').first().click();
  await button(page, '+ Add transit leg').click();
  await expect(setup(page).locator('#picker-search')).toBeVisible();
  await expect(button(page, 'Show nearby')).toHaveCount(0);
});

// Route and stop lists kept on the phone (7 days, refreshed in the background).
const listHits = mbta => mbta.hits.filter(h => (h.path === '/routes' && !h.query.has('filter[stop]'))
  || (h.path === '/stops' && h.query.has('filter[route]')) || h.path === '/route_patterns');

async function warmLists(page) {
  await page.locator('#open-setup').click();
  await expect(setup(page).locator('.trip-row .item').first()).toContainText('Bus 132');
  await page.waitForFunction(() => localStorage.getItem('mbta-leave-by:stops:132/1') && localStorage.getItem('mbta-leave-by:routes'));
}

test('route and stop lists are kept on the phone: a later session makes no list requests', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00' });
  // Setup, a trip, Change leg 1, Bus 132: the route list, stop lists and rail network.
  const session = async () => {
    await warmLists(page);
    await setup(page).locator('.trip-row .item').first().click();
    await button(page, 'Change leg 1').click();
    await setup(page).locator('#picker-search').fill('132');
    await setup(page).locator('.item', { hasText: 'Bus 132' }).click();
    await expect(setup(page).locator('.list .item').first()).toBeVisible();
  };
  await session();
  await page.waitForFunction(() => localStorage.getItem('mbta-leave-by:rail-network'));
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('mbta-leave-by:stops:132/1')));
  expect(kept.data.data[0]).toEqual({ type: 'stop', id: expect.any(String), attributes: expect.objectContaining({ name: expect.any(String) }), relationships: { child_stops: { data: expect.any(Array) } } });
  await page.reload();
  await page.locator('.row').first().waitFor();
  const before = mbta.hits.length;
  await session();
  expect(listHits({ hits: mbta.hits.slice(before) }).map(h => `${h.path}?${h.query}`)).toEqual([]);
});

test('a copy past 7 days is used at once and refreshed in the background', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00' });
  await warmLists(page);
  await page.evaluate(() => {
    const k = 'mbta-leave-by:stops:132/1';
    const c = JSON.parse(localStorage.getItem(k));
    localStorage.setItem(k, JSON.stringify({ ...c, at: Date.now() - 8 * 24 * 60 * 60_000 }));
  });
  await page.reload();
  await page.locator('.row').first().waitFor();
  mbta.mode = 'hang';
  const before = mbta.hits.length;
  await page.locator('#open-setup').click();
  // Names from the saved copy while the API holds every request.
  await expect(setup(page).locator('.trip-row .item').first()).toContainText('Bus 132');
  await expect.poll(() => mbta.hits.slice(before).filter(h => h.path === '/stops' && h.query.get('filter[route]') === '132' && h.query.get('filter[direction_id]') === '1').length).toBe(1);
  mbta.release();
  await expect.poll(() => page.evaluate(() => Date.now() - JSON.parse(localStorage.getItem('mbta-leave-by:stops:132/1')).at)).toBeLessThan(60_000);
});

test('with saved lists, setup works while the API is down', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00' });
  await warmLists(page);
  mbta.mode = '503';
  await page.reload();
  await page.locator('#open-setup').click();
  await setup(page).locator('.trip-row .item').first().click();
  await button(page, 'Change leg 1').click();
  await setup(page).locator('#picker-search').fill('132');
  await setup(page).locator('.item', { hasText: 'Bus 132' }).click();
  await expect(setup(page).locator('.list .item', { hasText: 'Main St @ South St' }).first()).toBeVisible();
  await button(page, 'Back').click();
  await button(page, 'Back').click();
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(2);
  await expect(setup(page).locator('.msg.error, .errors')).toHaveCount(0);
});
