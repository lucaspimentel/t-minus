// Auto-route from and to addresses and places (phase 3): the picker's Places (the T-Minus
// server's /api/places, stubbed), "Current location", plans from a point (@lat,lon) with each
// option's own walks, and the itinerary rows.
import { test, expect } from '@playwright/test';
import { openApp, tick, planOptions, optionLines, expandOption, pickOption } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const setup = page => page.locator('#setup');
const button = (page, name) => setup(page).getByRole('button', { name, exact: true });
const options = planOptions;
const lines = optionLines;
const list = page => setup(page).locator('.list');

const FENWAY = { name: 'Fenway Park', detail: '4 Jersey Street, Boston', lat: 42.34646, lon: -71.0971 };
// From a point: the server's option walks 3 min to the bus, the walk at a station end is the field's.
const PLAN = {
  from: null, to: 'State',
  options: [{
    legs: [
      { route: '132', also: [], direction_id: 1, stop: '25996', alight: '5991', stopName: 'Main St @ South St', alightName: 'Washington St @ Oak Grove Sta' },
      { route: 'Orange', also: [], direction_id: 0, stop: 'place-ogmnl', alight: 'place-state', stopName: 'Oak Grove', alightName: 'State' },
    ],
    transfers: [{ name: 'Washington St @ Oak Grove Sta → Oak Grove', meters: 32, min: 3 }],
    minutes: 32, walkBefore: 3, walkAfter: 0,
  }],
};

async function stub(page, { places = [FENWAY], placesStatus = 200 } = {}) {
  const calls = { places: [], plan: [] };
  await page.route(/\/api\/places\?/, route => {
    calls.places.push(new URL(route.request().url()).searchParams.get('q'));
    return route.fulfill({ status: placesStatus, json: placesStatus === 200 ? { places } : { error: 'Place search unavailable' } });
  });
  await page.route(/\/api\/plan\?/, route => {
    calls.plan.push(new URL(route.request().url()).search);
    return route.fulfill({ json: PLAN });
  });
  return calls;
}

async function pickStation(page, field, query, name) {
  await setup(page).locator(`#plan-${field}`).click();
  await setup(page).locator('#picker-search').fill(query);
  await setup(page).locator('.list .item.station', { hasText: name }).first().click();
}

test('setup: an address or place from the search; the plan walks from it; the pick keeps its walk', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const calls = await stub(page);
  await page.locator('#open-setup').click();
  await button(page, '+ Add trip (auto-route)').click();
  await setup(page).locator('#plan-from').click();
  await expect(setup(page).locator('#picker-search')).toHaveAttribute('placeholder', 'Search stations, routes, places');
  await expect(list(page)).toContainText('Type a station (e.g. Oak Grove), a route (e.g. 132), an address or a place.');
  // Two letters: no place search; three and a pause: Places under stations and routes.
  await setup(page).locator('#picker-search').fill('fe');
  await tick(page, 400);
  await expect(list(page)).not.toContainText('Places');
  await setup(page).locator('#picker-search').fill('fenway');
  await expect(list(page)).toContainText('Searching places…');
  await tick(page, 400);
  await expect(setup(page).locator('.list .item.place')).toHaveText(['Fenway Park · 4 Jersey Street, Boston']);
  expect(calls.places).toEqual(['fenway']);
  await setup(page).locator('.list .item.place').click();
  await expect(setup(page).locator('#plan-from')).toHaveText(/^Fenway Park\s*· 4 Jersey Street, Boston\s*Change$/);
  // The address's walk comes with each option; the station end keeps its field.
  await expect(setup(page).getByLabel('Minutes to first stop')).toHaveCount(0);
  await expect(setup(page).getByLabel('Minutes from last stop')).toHaveValue('5');
  await pickStation(page, 'to', 'state', 'State');
  expect(calls.plan).toEqual(['?from=%4042.34646%2C-71.0971&to=place-state']);
  await expect(lines(page, 0)).toHaveText(['~40 min', /^Bus 132\s*Orange$/]);
  // The option's own walk from the place; the field's at the station.
  const tl = await expandOption(page);
  await expect(tl.locator('.step.walk')).toHaveText(['Walk 3 min', 'Walk 3 min to transfer', 'Walk 5 min']);
  await pickOption(page);
  await expect(setup(page).getByLabel('Trip name')).toHaveValue('Fenway Park to State');
  await expect(setup(page).getByLabel('Minutes to first stop')).toHaveValue('3');
  await expect(setup(page).getByLabel('Minutes from last stop')).toHaveValue('5');
});

test('place search down or empty says so; stations and routes still list', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await stub(page, { placesStatus: 502 });
  await page.locator('#open-setup').click();
  await button(page, '+ Add trip (auto-route)').click();
  await setup(page).locator('#plan-to').click();
  await setup(page).locator('#picker-search').fill('state');
  await tick(page, 400);
  await expect(list(page)).toContainText('Place search is unavailable right now.');
  await expect(setup(page).locator('.list .item.station', { hasText: 'State' })).toBeVisible();
  // To offers "Current location" too.
  await setup(page).locator('#picker-search').fill('');
  await expect(setup(page).locator('#plan-here')).toHaveText('Current location · plan to where you are');
  await page.unroute(/\/api\/places\?/);
  await stub(page, { places: [] });
  await setup(page).locator('#picker-search').fill('nowhere st');
  await tick(page, 400);
  await expect(list(page)).toContainText('No places found.');
});

test('main screen: Current location as From makes a one-off trip named from its first stop', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 42.450312, longitude: -71.070288 });
  await openApp(page, { time: '07:00' });
  const calls = await stub(page);
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  await setup(page).locator('#plan-from').click();
  await expect(setup(page).locator('#plan-here')).toHaveText('Current location · plan from where you are');
  await setup(page).locator('#plan-here').click();
  await expect(setup(page).locator('#plan-from')).toHaveText(/^Current location\s*Change$/);
  await pickStation(page, 'to', 'state', 'State');
  expect(calls.plan).toEqual([expect.stringMatching(/^\?from=%4042\.45031%2C-71\.07029&to=place-state&now=1&/)]); // timed from now
  await pickOption(page);
  await expect(page.locator('#oneoff')).toBeVisible();
  const oneOff = await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:one-off')).trip);
  expect(oneOff.name).toBe('Main St @ South St to State');
  expect(oneOff.legs[0]).toEqual({ kind: 'walk', minutes: 3 });
});

test('setup: Current location as To; the trip is named for its last stop', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 42.358, longitude: -71.0577 });
  await openApp(page, { time: '07:00' });
  const calls = await stub(page);
  await page.locator('#open-setup').click();
  await button(page, '+ Add trip (auto-route)').click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await setup(page).locator('#plan-to').click();
  await setup(page).locator('#plan-here').click();
  await expect(setup(page).locator('#plan-to')).toHaveText(/^Current location\s*Change$/);
  await expect(setup(page).getByLabel('Minutes from last stop')).toHaveCount(0);
  expect(calls.plan).toEqual(['?from=place-ogmnl&to=%4042.358%2C-71.0577']);
  await pickOption(page);
  await expect(setup(page).getByLabel('Trip name')).toHaveValue('Oak Grove to State');
});

test('Current location without permission says so and keeps the list', async ({ page }) => {
  const init = () => {
    navigator.geolocation.getCurrentPosition = (ok, err) => setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, message: 'denied' }), 0);
  };
  await openApp(page, { time: '07:00', init });
  await stub(page);
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  await setup(page).locator('#plan-from').click();
  await setup(page).locator('#plan-here').click();
  await tick(page, 100);
  await expect(list(page)).toContainText('Location is off for this app.');
  await expect(setup(page).locator('.list .item', { hasText: 'Forest Hills - Oak Grove' })).toBeVisible();
});
