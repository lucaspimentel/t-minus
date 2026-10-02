// Setup: first run, adding a trip through the pickers (recorded route and stop lists), and the
// Undo toasts (discarded edits, removed leg, deleted trip, import), export.
import { test, expect } from '@playwright/test';
import { openApp, CONFIG } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
  page.on('dialog', d => { throw new Error(`unexpected dialog: ${d.message()}`); });
});

const setup = page => page.locator('#setup');
const toast = page => page.locator('#toast');
const tripNames = page => setup(page).locator('.trip-row .item b').allInnerTexts();
const storedNames = page => page.evaluate(() => JSON.parse(localStorage.getItem('mbta-leave-by:config')).trips.map(t => t.name));
const button = (page, name) => setup(page).getByRole('button', { name, exact: true });

async function openSetup(page) {
  await openApp(page, { time: '07:00' });
  await page.locator('#open-setup').click();
  await expect(page.locator('#setup-done')).toBeVisible();
}

test('first run: build a trip with the pickers, save it, and see its rows', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await expect(button(page, 'Import')).toBeVisible(); // nothing to cancel back to
  await setup(page).getByLabel('Trip name').fill('Commute');
  await setup(page).getByLabel('Show automatically').selectOption('never');
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('132');
  await setup(page).locator('.item', { hasText: 'Bus 132' }).click();
  await setup(page).locator('#picker-search').fill('Main St @ South');
  // No direction step: stops on each side of the street are listed under their direction.
  await expect(setup(page).locator('.section-head')).toHaveText(['toward Redstone Shopping Center', 'toward Malden Center Station']);
  await setup(page).locator('.item', { hasText: 'Main St @ South St' }).nth(1).click(); // toward Malden Center Station
  await expect(setup(page).locator('.section-head')).toHaveText(['toward Malden Center Station']);
  await setup(page).locator('.item', { hasText: 'Washington St opp Oak Grove Sta' }).click();
  await expect(setup(page)).toContainText('Main St @ South St → Washington St opp Oak Grove Sta');
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row')).toHaveCount(1);
  expect(await storedNames(page)).toEqual(['Commute']);
  await page.locator('#setup-done').click();
  await expect(page.locator('.row').first()).toBeVisible();
  await expect(page.locator('.row').first().locator('.strip')).toContainText('Bus 132');
});

test('boarding at the end of a line asks for no direction', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('Orange');
  await setup(page).locator('.item', { hasText: 'Orange' }).first().click();
  await expect(setup(page).locator('.section-head')).toHaveCount(0); // stations serve both ways
  await setup(page).locator('#picker-search').fill('Oak Grove');
  await setup(page).locator('.item', { hasText: 'Oak Grove' }).click();
  await expect(setup(page).locator('.section-head')).toHaveText(['toward Forest Hills']);
  await setup(page).locator('.item', { hasText: 'Wellington' }).click();
  await expect(setup(page)).toContainText('toward Forest Hills · Oak Grove → Wellington');
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

test('removing a leg can be undone while the editor is open', async ({ page }) => {
  await openSetup(page);
  await setup(page).locator('.trip-row .item').first().click();
  const legs = setup(page).getByRole('button', { name: 'Remove leg' });
  await expect(legs).toHaveCount(2);
  await legs.nth(1).click();
  await expect(legs).toHaveCount(1);
  await expect(toast(page)).toContainText('Leg removed');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(legs).toHaveCount(2);
  await expect(setup(page).getByLabel('Transfer (min)')).toHaveValue('5');
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
