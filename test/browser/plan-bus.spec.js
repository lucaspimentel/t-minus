// Auto-route with buses: the T-Minus server's /api/stops and /api/plan (stubbed here; the server's
// own tests cover the search), Nearby, By route… (setup's route and stop lists), and the fallback
// when the server fails.
import { test, expect } from '@playwright/test';
import { openApp, tick } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const setup = page => page.locator('#setup');
const button = (page, name) => setup(page).getByRole('button', { name, exact: true });
const options = page => setup(page).locator('#plan-options .item');

const MAIN = { id: '25996', name: 'Main St @ South St', routes: [{ id: '132', label: 'Bus 132', color: 'FFC72C' }], toward: ['Malden'] };
const STATE = { id: 'place-state', name: 'State', routes: [{ id: 'Orange', label: 'Orange', color: 'ED8B00' }, { id: 'Blue', label: 'Blue', color: '003DA5' }], toward: ['Forest Hills', 'Oak Grove'] };
const PLAN = {
  from: 'Main St @ South St', to: 'State',
  options: [{
    legs: [{ route: '132', also: [], direction_id: 1, stop: '25996', alight: '5991' }, { route: 'Orange', also: [], direction_id: 0, stop: 'place-ogmnl', alight: 'place-state' }],
    transfers: [{ name: 'Washington St @ Oak Grove Sta → Oak Grove', meters: 32, min: 3 }],
    minutes: 32,
  }],
};

// The server's answers: /stops by name (`main`, `state`) or nearby, and /plan.
async function stubServer(page, { near = [] } = {}) {
  const calls = [];
  await page.route(/\/api\/(stops|plan)\?/, route => {
    const u = new URL(route.request().url());
    calls.push(`${u.pathname} ${u.search}`);
    const q = u.searchParams.get('q')?.toLowerCase() ?? '';
    const body = u.pathname.endsWith('/plan') ? PLAN
      : u.searchParams.has('lat') ? { stops: near }
        : { stops: [MAIN, STATE].filter(s => s.name.toLowerCase().includes(q)) };
    return route.fulfill({ json: body });
  });
  return calls;
}

async function pickPlace(page, query, name) {
  await setup(page).locator('#picker-search').fill(query);
  await setup(page).locator('.list .item', { hasText: name }).first().click();
}

test('setup: a bus stop to a station, from the server; the pick opens in the editor with the walk as the transfer', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const calls = await stubServer(page);
  await page.locator('#open-setup').click();
  await button(page, '+ Add trip (auto-route)').click();
  await setup(page).locator('#picker-search').fill('main st');
  await expect(setup(page).locator('.list .item').first()).toHaveText(/^Main St @ South St\s*Bus 132\s*toward Malden$/);
  await setup(page).locator('.list .item').first().click();
  await pickPlace(page, 'state', 'State');
  await expect(options(page)).toHaveText([/^Bus 132 → Orange\s*1 transfer at Washington St @ Oak Grove Sta → Oak Grove \(walk 32 m\) · ~42 min$/]);
  expect(calls.filter(c => c.startsWith('/api/plan'))).toEqual(['/api/plan ?from=25996&to=place-state']);
  await options(page).first().click();
  await expect(setup(page).getByLabel('Trip name')).toHaveValue('Main St @ South St to State');
  await expect(setup(page).getByLabel('Minutes to transfer')).toHaveValue('3');
  await expect(setup(page).locator('.leg-item')).toHaveText([/Bus 132.*Main St @ South St → Washington St/, /Orange.*Oak Grove → State/]);
  await button(page, 'Save').click();
  await expect(setup(page).locator('.trip-row .item b')).toHaveText(['Home to office', 'Office to home', 'Main St @ South St to State']);
});

test('main screen: a one-off trip from a bus stop has the bus and the train', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await stubServer(page);
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  await pickPlace(page, 'main st', 'Main St @ South St');
  await pickPlace(page, 'state', 'State');
  await options(page).first().click();
  await tick(page, 1000);
  await expect(page.locator('#oneoff')).toBeVisible();
  await expect(page.locator('.row .strip').first()).toHaveText(/Bus 132\s*Orange/);
  await expect(page.locator('.row:not(.missed) .big').first()).toContainText('7:02am'); // the 7:08 bus
});

test('Nearby lists the server\'s stops near the phone; By route… picks a stop from a route\'s list', async ({ page }) => {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 42.4367, longitude: -71.0711 });
  await openApp(page, { time: '07:00' });
  await stubServer(page, { near: [{ ...STATE, id: 'place-ogmnl', name: 'Oak Grove', meters: 67 }] });
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  // Layout: a gap between the search and the buttons; nothing listed, no gap before To.
  const box = sel => setup(page).locator(sel).first().boundingBox();
  const [search, ways, to] = [await box('#picker-search'), await box('.plan-ways'), await box('#plan-to')];
  expect(ways.y - (search.y + search.height)).toBeGreaterThanOrEqual(6);
  expect(to.y - (ways.y + ways.height)).toBeLessThanOrEqual(36); // the To label (~20 px) and its margin
  await button(page, 'Nearby').click();
  await expect(setup(page).locator('.list .item')).toHaveText([/^Oak Grove\s*Orange\s*Blue\s*70 m\s*toward Forest Hills \/ Oak Grove$/]);
  await setup(page).locator('.list .item').first().click();
  await expect(setup(page).locator('#plan-from')).toContainText('Oak Grove');
  await button(page, 'By route…').click();
  await setup(page).locator('#plan-route-search').fill('132');
  await setup(page).locator('.list .item', { hasText: 'Bus 132' }).first().click();
  await setup(page).locator('.list .item', { hasText: 'Main St @ South St' }).first().click();
  await expect(setup(page).locator('#plan-to')).toHaveText(/^Main St @ South St\s*Bus 132\s*Change$/);
});

test('without the server: stations still plan in the browser (rail only); a bus stop needs the server', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.route(/\/api\/(stops|plan)\?/, route => route.fulfill({ status: 503, json: { error: 'Network unavailable' } }));
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  await pickPlace(page, 'oak gr', 'Oak Grove');
  await pickPlace(page, 'state', 'State');
  await expect(options(page)).toHaveText([/^Orange\s*No transfers · 8 stops$/]);
  // A bus stop (By route…, from the MBTA's stop lists) to a station: no way without the server.
  await setup(page).locator('#plan-from').click();
  await button(page, 'By route…').click();
  await setup(page).locator('#plan-route-search').fill('132');
  await setup(page).locator('.list .item', { hasText: 'Bus 132' }).first().click();
  await setup(page).locator('.list .item', { hasText: 'Main St @ South St' }).first().click();
  await expect(setup(page)).toContainText('Needs the T-Minus server.');
});
