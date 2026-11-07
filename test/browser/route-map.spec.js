// The route map (DESIGN.md "Route map"): 🗺 in the header opens the shown trip at true positions,
// with the phone's location and the legs' vehicles while open; setup's planner options and trip
// editor draw the same map inline. Shapes come from the recorded patterns (fake-mbta.js).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, tick, tickTo, commute, planOptions, expandOption } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const sheet = page => page.getByRole('dialog');
const svg = page => sheet(page).locator('svg.route-svg');
const legs = loc => loc.locator('polyline.map-leg');
const shapeHits = mbta => mbta.hits.filter(h => h.path === '/route_patterns' && h.query.get('include')?.includes('shape'));
const vehicleHits = mbta => mbta.hits.filter(h => h.path === '/vehicles');
// The 132's recorded pattern toward Malden: its stops (the trip boards at index 8, 25996, and
// gets off at index 24, 5991).
const BUS = JSON.parse(readFileSync(new URL('./fixtures/patterns-132-1.json', import.meta.url), 'utf8'));
const busStop = id => BUS.included.find(x => x.type === 'stop' && x.id === id).attributes;
const busStops = BUS.included.find(x => x.type === 'trip').relationships.stops.data.map(s => s.id);
const vehicleAt = (id, trip, k) => ({ id, trip, route: '132', direction: 1, lat: busStop(busStops[k]).latitude, lon: busStop(busStops[k]).longitude });
const DENIED = () => {
  navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, message: 'denied' }), 0); return 1; };
  navigator.geolocation.clearWatch = () => {};
};

async function openMap(page) {
  await page.getByRole('button', { name: 'Route map' }).click();
  await tick(page, 300);
  await expect(sheet(page)).toBeVisible();
}

test('🗺 opens the trip: both legs at their shapes, labeled ends, stop names on tap; shapes kept on the phone', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00', init: DENIED });
  await expect(page.locator('header').getByRole('button', { name: 'Route map' })).toBeVisible();
  await openMap(page);
  await expect(sheet(page).getByRole('heading')).toHaveText('Home to office');
  await expect(svg(page)).toHaveAttribute('aria-label', 'Map of Home to office');
  await expect(legs(svg(page))).toHaveCount(2);
  expect(await legs(svg(page)).evaluateAll(ls => ls.map(l => l.dataset.color))).toEqual(['FFC72C', 'ED8B00']);
  // The shapes, not straight lines: the bus leg follows its streets.
  expect(Number(await legs(svg(page)).first().evaluate(l => l.points.length))).toBeGreaterThan(20);
  // The leg ends are labeled; a transfer between close stops shows the next leg's name.
  await expect(svg(page).locator('.map-label')).toHaveText(['Main St @ South St', 'Oak Grove', 'State']);
  await svg(page).getByRole('button', { name: 'Pond St @ Stone Zoo' }).click();
  await expect(page.locator('#map-caption')).toHaveText('Pond St @ Stone Zoo');
  await expect(svg(page).getByRole('button', { name: 'Pond St @ Stone Zoo' })).toHaveAttribute('aria-pressed', 'true');
  // One request per leg, route and direction only.
  expect(shapeHits(mbta).map(h => [...h.query.keys()].filter(k => k.startsWith('filter')).map(k => `${k}=${h.query.get(k)}`).join('&')))
    .toEqual(['filter[route]=132&filter[direction_id]=1', 'filter[route]=Orange&filter[direction_id]=0']);
  // Done closes it and returns to the list; the shapes are kept for the next opening.
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator('#rows')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Route map' })).toBeFocused();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('t-minus:shapes:')).sort())).toEqual(['t-minus:shapes:132/1', 't-minus:shapes:Orange/0']);
  await page.reload();
  await page.locator('.row').first().waitFor();
  await openMap(page);
  await expect(legs(svg(page))).toHaveCount(2);
  expect(shapeHits(mbta)).toHaveLength(2);
});

test('no trips: no 🗺', async ({ page }) => {
  await openApp(page, { time: '07:00', config: { trips: [] }, waitForRows: false });
  await expect(page.locator('#map-btn')).toBeHidden();
});

test('the phone\'s location: a dot and the walk to the first stop; "Location off" when denied', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 42.4655, longitude: -71.0990 });
  await openApp(page, { time: '07:00' });
  await openMap(page);
  await expect(svg(page).locator('.map-here')).toHaveCount(1);
  await expect(svg(page).locator('.map-walk[data-kind="start"]')).toHaveCount(1);
  await expect(page.locator('#map-caption')).toHaveText('');
});

test('location denied: no dot, no first walk, "Location off"', async ({ page }) => {
  await openApp(page, { time: '07:00', init: DENIED });
  await openMap(page);
  await expect(page.locator('#map-caption')).toHaveText('Location off');
  await expect(svg(page).locator('.map-here')).toHaveCount(0);
  await expect(svg(page).locator('.map-walk[data-kind="start"]')).toHaveCount(0);
});

test('vehicles on the legs every 10 s while open, yours outlined; nothing after Done', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('before', '132in-0640', 3), vehicleAt('inside', '132in-0612', 15), vehicleAt('mine', '132in-0736', 18)] };
  const mbta = await openApp(page, { time: '07:00', scenario, init: DENIED });
  // Bell the 7:36 bus (the second row).
  const second = page.locator('.row').nth(1);
  await second.click();
  await second.getByRole('button', { name: 'Track', exact: true }).click();
  await tick(page, 1000);
  await openMap(page);
  await expect(svg(page).locator('.map-vehicle')).toHaveCount(2); // not the one before the boarding stop
  await expect(svg(page).locator('.map-vehicle.mine')).toHaveCount(1);
  await expect(svg(page).locator('.map-vehicle.mine')).toHaveAttribute('data-vehicle', 'mine');
  await expect(svg(page).locator('.map-vehicle text').first()).toHaveText('132');
  const first = vehicleHits(mbta).length;
  expect(first).toBe(2); // one per leg at opening
  await tick(page, 10_000);
  expect(vehicleHits(mbta).length).toBe(4);
  // Route and direction only, never a position.
  for (const h of vehicleHits(mbta)) expect([...h.query.keys()].sort()).toEqual(['fields[vehicle]', 'filter[direction_id]', 'filter[route]']);
  // The bus moves on.
  const was = await svg(page).locator('[data-vehicle="inside"]').getAttribute('transform');
  scenario.vehicles[1] = vehicleAt('inside', '132in-0612', 20);
  await tick(page, 10_000);
  await expect(svg(page).locator('[data-vehicle="inside"]')).not.toHaveAttribute('transform', was);
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  const after = vehicleHits(mbta).length;
  await tick(page, 30_000);
  expect(vehicleHits(mbta).length).toBe(after);
});

test('riding: the first walk is gone and finished legs fade', async ({ page }) => {
  await openApp(page, { time: '07:00', init: DENIED });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:24');
  await openMap(page);
  expect(await legs(svg(page)).evaluateAll(ls => ls.map(l => l.classList.contains('faded')))).toEqual([true, false]);
  await expect(svg(page).locator('.map-walk[data-kind="start"]')).toHaveCount(0);
});

test('without shapes (MBTA down, nothing kept): straight lines through the stops, no message', async ({ page }) => {
  await openApp(page, { time: '07:00', scenario: { ...commute(), noShapes: true }, init: DENIED });
  await openMap(page);
  await expect(legs(svg(page))).toHaveCount(2);
  expect(await legs(svg(page)).evaluateAll(ls => ls.map(l => l.points.length))).toEqual([2, 2]); // the legs' ends from the loaded times
  await expect(page.locator('#map-caption')).toHaveText('Location off');
});

test('pinch zooms and a drag pans', async ({ page }) => {
  await openApp(page, { time: '07:00', init: DENIED });
  await openMap(page);
  const box = await svg(page).boundingBox();
  const view = async () => (await svg(page).getAttribute('viewBox')).split(' ').map(Number);
  const before = await view();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await touch('touchStart', [{ x: cx - 20, y: cy, id: 1 }, { x: cx + 20, y: cy, id: 2 }]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: cx - 20 - i * 10, y: cy, id: 1 }, { x: cx + 20 + i * 10, y: cy, id: 2 }]);
  await touch('touchEnd', []);
  const zoomed = await view();
  expect(zoomed[2]).toBeLessThan(before[2] * 0.6);
  await touch('touchStart', [{ x: cx, y: cy, id: 1 }]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: cx + i * 10, y: cy, id: 1 }]);
  await touch('touchEnd', []);
  const panned = await view();
  expect(panned[0]).toBeLessThan(zoomed[0]);
  expect(panned[2]).toBeCloseTo(zoomed[2]);
});

const PLAN_FROM = { name: 'Main St, Melrose', lat: 42.4665, lon: -71.1005 };
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

test('setup: a planner option\'s map (both end walks, taps keep the card open); the trip editor\'s', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await page.route(/\/api\/places\?/, route => route.fulfill({ json: { places: [{ ...PLAN_FROM, detail: 'Melrose' }] } }));
  await page.route(/\/api\/plan\?/, route => route.fulfill({ json: PLAN }));
  const setup = page.locator('#setup');
  await page.locator('#open-setup').click();
  await setup.getByRole('button', { name: '+ Plan a trip', exact: true }).click();
  await setup.locator('#plan-from').click();
  await setup.locator('#picker-search').fill('main st');
  await tick(page, 400);
  await setup.locator('.list .item.place').click();
  await setup.locator('#plan-to').click();
  await setup.locator('#picker-search').fill('state');
  await setup.locator('.list .item.station', { hasText: 'State' }).first().click();
  const tl = await expandOption(page);
  await expect(tl).toBeVisible();
  const map = planOptions(page).first().locator('.route-map');
  await expect(legs(map)).toHaveCount(2);
  // Above the timeline, with dashed walks from the place and at the end (State's own position).
  expect(await planOptions(page).first().evaluate(c => [...c.children].map(x => x.className).filter(n => /route-map|timeline/.test(n)))).toEqual(['route-map', 'timeline']);
  await expect(map.locator('.map-walk[data-kind="start"]')).toHaveCount(1);
  // Taps and drags on the map don't collapse the card.
  await map.getByRole('button', { name: 'Oak Grove', exact: true }).click();
  await expect(map.locator('.map-caption')).toHaveText('Oak Grove');
  await expect(planOptions(page).first().locator('.row-toggle')).toHaveAttribute('aria-expanded', 'true');
  // Saving opens the trip editor: a static map under the legs; removing a leg redraws it.
  await planOptions(page).first().locator('.row-foot').getByRole('button', { name: 'Save trip', exact: true }).click();
  const editorMap = setup.locator('.route-map');
  await expect(editorMap.locator('svg')).toHaveAttribute('role', 'img');
  await expect(legs(editorMap)).toHaveCount(2);
  await expect(editorMap.getByRole('button')).toHaveCount(0);
  await setup.getByRole('button', { name: /^Change leg 2/ }).click();
  await setup.getByRole('button', { name: 'Remove leg', exact: true }).click();
  await expect(legs(setup.locator('.route-map'))).toHaveCount(1);
  // Nothing about the place's position is saved with the trip.
  expect(JSON.stringify(await page.evaluate(() => localStorage.getItem('t-minus:config')))).not.toContain('42.4665');
});
