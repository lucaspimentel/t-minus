// Auto-route with buses: From/To in the leg picker's plan mode (stations, a route then its stop,
// Show nearby), the T-Minus server's /api/plan (stubbed here; the server's own tests cover the
// search), and the fallback when the server fails.
import { test, expect } from '@playwright/test';
import { openApp, tick } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const setup = page => page.locator('#setup');
const button = (page, name) => setup(page).getByRole('button', { name, exact: true });
const options = page => setup(page).locator('#plan-options .item');
const title = page => setup(page).locator('.setup-head b');

const PLAN = {
  from: 'Main St @ South St', to: 'State',
  options: [{
    legs: [{ route: '132', also: [], direction_id: 1, stop: '25996', alight: '5991' }, { route: 'Orange', also: [], direction_id: 0, stop: 'place-ogmnl', alight: 'place-state' }],
    transfers: [{ name: 'Washington St @ Oak Grove Sta → Oak Grove', meters: 32, min: 3 }],
    minutes: 32,
  }],
};

async function stubPlan(page) {
  const calls = [];
  await page.route(/\/api\/plan\?/, route => {
    calls.push(new URL(route.request().url()).search);
    return route.fulfill({ json: PLAN });
  });
  return calls;
}

// A field's picker: a station by name, or a route then one of its stops.
async function pickStation(page, field, query, name) {
  await setup(page).locator(`#plan-${field}`).click();
  await setup(page).locator('#picker-search').fill(query);
  await setup(page).locator('.list .item.station', { hasText: name }).first().click();
}
async function pickStop(page, field, route, stop) {
  await setup(page).locator(`#plan-${field}`).click();
  await setup(page).locator('#picker-search').fill(route);
  await setup(page).locator('.list .item', { hasText: `Bus ${route}` }).first().click();
  await setup(page).locator('.list .item', { hasText: stop }).first().click();
}

test('setup: a route\'s stop to a station; the pick opens in the editor with the walk as the transfer', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const calls = await stubPlan(page);
  await page.locator('#open-setup').click();
  await button(page, '+ Add trip (auto-route)').click();
  // From: the leg picker, titled for the field; stations and routes, no bus stop names.
  await setup(page).locator('#plan-from').click();
  await expect(title(page)).toHaveText('From');
  await setup(page).locator('#picker-search').fill('state');
  await expect(setup(page).locator('.list .item.station')).toHaveText([/^State\s*Orange\s*Blue$/]);
  await setup(page).locator('#picker-search').fill('132');
  await setup(page).locator('.list .item', { hasText: 'Bus 132' }).first().click();
  await expect(title(page)).toHaveText('From: where do you board?');
  // Main St @ South St has a stop on each side: the one toward Malden.
  await setup(page).locator('.list .section-head', { hasText: 'toward Malden' })
    .locator('xpath=following-sibling::button[contains(., "Main St @ South St")][1]').click();
  await expect(setup(page).locator('#plan-from')).toHaveText(/^Main St @ South St\s*Bus 132\s*Change$/);
  await pickStation(page, 'to', 'state', 'State');
  await expect(options(page)).toHaveText([/^Bus 132 → Orange\s*1 transfer at Washington St @ Oak Grove Sta → Oak Grove \(walk 32 m\) · ~42 min$/]);
  expect(calls).toEqual(['?from=25996&to=place-state']);
  await options(page).first().click();
  await expect(setup(page).getByLabel('Trip name')).toHaveValue('Main St @ South St to State');
  await expect(setup(page).getByLabel('Minutes to transfer')).toHaveValue('3');
  await expect(setup(page).locator('.leg-item')).toHaveText([/Bus 132.*Main St @ South St → Washington St/, /Orange.*Oak Grove → State/]);
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row .item b')).toHaveText(['Home to office', 'Office to home', 'Main St @ South St to State']);
});

test('main screen: a one-off trip from a bus stop has the bus and the train', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await stubPlan(page);
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  await pickStop(page, 'from', '132', 'Main St @ South St');
  await pickStation(page, 'to', 'state', 'State');
  await options(page).first().click();
  await tick(page, 1000);
  await expect(page.locator('#oneoff')).toBeVisible();
  await expect(page.locator('.row .strip').first()).toHaveText(/Bus 132\s*Orange/);
  await expect(page.locator('.row:not(.missed) .big').first()).toContainText('7:02am'); // the 7:08 bus
});

test('Show nearby in the picker; To by route lists the stops you can get off at; Back returns to the planner', async ({ page }) => {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 42.4367, longitude: -71.0711 });
  await openApp(page, { time: '07:00' });
  await stubPlan(page);
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  await setup(page).locator('#plan-from').click();
  await button(page, 'Show nearby').click();
  await setup(page).locator('.list .item.station', { hasText: 'Oak Grove' }).click();
  await expect(setup(page).locator('#plan-from')).toContainText('Oak Grove');
  await setup(page).locator('#plan-to').click();
  await expect(title(page)).toHaveText('To');
  await button(page, 'Back').click();
  await expect(setup(page).locator('#plan-to')).toHaveText('Choose a stop or station');
  await setup(page).locator('#plan-to').click();
  await setup(page).locator('#picker-search').fill('132');
  await setup(page).locator('.list .item', { hasText: 'Bus 132' }).first().click();
  await expect(title(page)).toHaveText('To: where do you get off?');
  await setup(page).locator('.list .item', { hasText: 'Main St @ South St' }).first().click();
  await expect(setup(page).locator('#plan-to')).toHaveText(/^Main St @ South St\s*Bus 132\s*Change$/);
});

test('without the server: stations still plan in the browser (rail only); a bus stop needs the server', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.route(/\/api\/plan\?/, route => route.fulfill({ status: 503, json: { error: 'Network unavailable' } }));
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await expect(options(page)).toHaveText([/^Orange\s*No transfers · 8 stops$/]);
  await pickStop(page, 'from', '132', 'Main St @ South St');
  await expect(setup(page)).toContainText('Needs the T-Minus server.');
});
