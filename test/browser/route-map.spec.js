// The route map (DESIGN.md "Route map"): 🗺 in the header opens the shown trip at true positions,
// with the phone's location and the legs' vehicles while open; setup's planner options and trip
// editor draw the same map inline. Shapes come from the recorded patterns (fake-mbta.js).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, tick, tickTo, commute, planOptions, expandOption } from './helpers.js';
import { encodePolyline } from '../../core.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const sheet = page => page.getByRole('dialog');
const svg = page => sheet(page).locator('svg.route-svg');
const locateBtn = loc => loc.getByRole('button', { name: 'Center on my location' });
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
  const no = err => setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, message: 'denied' }), 0);
  navigator.geolocation.watchPosition = (ok, err) => { no(err); return 1; };
  navigator.geolocation.getCurrentPosition = (ok, err) => no(err);
  navigator.geolocation.clearWatch = () => {};
  window.geoAsks = 0;
  for (const k of ['watchPosition', 'getCurrentPosition']) { const f = navigator.geolocation[k]; navigator.geolocation[k] = (...a) => { window.geoAsks++; return f(...a); }; }
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

test('the phone\'s location, already granted: the dot in the fit, no walk to the first stop; locate centers on it', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 42.4740, longitude: -71.0900 }); // north of the first stop
  await openApp(page, { time: '07:00' });
  await openMap(page);
  await expect(svg(page).locator('.map-here')).toHaveCount(1);
  await expect(svg(page).locator('.map-walk')).toHaveCount(1); // the transfer's only (2026-11-09)
  await expect(svg(page).locator('.map-walk[data-kind="start"]')).toHaveCount(0);
  await expect(page.locator('#map-caption')).toHaveText('');
  const inView = () => svg(page).evaluate(s => {
    const [vx, vy, vw, vh] = s.getAttribute('viewBox').split(' ').map(Number), g = s.querySelector('.map-here');
    return { x: (g.dataset.x - vx) / vw, y: (g.dataset.y - vy) / vh };
  });
  const fitted = await inView();
  expect(fitted.y).toBeGreaterThan(0); expect(fitted.y).toBeLessThan(0.2); // in the fit, near its top
  const fitBtn = sheet(page).getByRole('button', { name: 'Show the whole trip' });
  await expect(fitBtn).toBeHidden();
  await locateBtn(sheet(page)).click();
  await tick(page, 50);
  const moving = await inView(); // eased like ⤢ (2026-11-09): on its way
  expect(Math.abs(moving.y - 0.5)).toBeGreaterThan(0.02);
  await tick(page, 300);
  const centered = await inView();
  expect(centered.x).toBeCloseTo(0.5, 2); expect(centered.y).toBeCloseTo(0.5, 2);
  await expect(fitBtn).toBeVisible();
  // With Reduce Motion: at once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fitBtn.click();
  await locateBtn(sheet(page)).click();
  await tick(page, 20);
  const now = await inView();
  expect(now.x).toBeCloseTo(0.5, 2); expect(now.y).toBeCloseTo(0.5, 2);
});

test('location not granted: no prompt on opening, no dot; locate asks, and "Location off" once denied', async ({ page }) => {
  await openApp(page, { time: '07:00', init: DENIED });
  await openMap(page);
  await tick(page, 1000);
  expect(await page.evaluate(() => window.geoAsks)).toBe(0);
  await expect(page.locator('#map-caption')).toHaveText('');
  await expect(svg(page).locator('.map-here')).toHaveCount(0);
  await locateBtn(sheet(page)).click();
  await tick(page, 100);
  expect(await page.evaluate(() => window.geoAsks)).toBe(1);
  await expect(page.locator('#map-caption')).toHaveText('Location off');
  await expect(svg(page).locator('.map-here')).toHaveCount(0);
  await expect(locateBtn(sheet(page))).toBeVisible();
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
  await expect(page.locator('#map-caption')).toHaveText('');
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

test('setup: a planner option\'s map (a picture with both end walks; taps keep the card open); the trip editor\'s', async ({ page }) => {
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
  // A picture, as in the trip editor (2026-11-08): no stop buttons, no caption, no zoom.
  await expect(map.locator('svg')).toHaveAttribute('role', 'img');
  await expect(map.getByRole('button')).toHaveCount(0);
  await expect(map.locator('.map-caption')).toHaveCount(0);
  const box = await map.locator('svg').getAttribute('viewBox');
  await map.locator('svg').hover();
  await page.mouse.wheel(0, -300);
  await expect(map.locator('svg')).toHaveAttribute('viewBox', box);
  // A tap on the map doesn't collapse the card.
  await map.locator('svg.route-svg').click();
  await expect(planOptions(page).first().locator('.row-toggle')).toHaveAttribute('aria-expanded', 'true');
  // Saving opens the trip editor: a static map under the legs; removing a leg redraws it.
  await planOptions(page).first().locator('.row-foot').getByRole('button', { name: 'Save trip', exact: true }).click();
  const editorMap = setup.locator('.route-map');
  await expect(editorMap.locator('svg')).toHaveAttribute('role', 'img');
  await expect(legs(editorMap)).toHaveCount(2);
  await expect(editorMap.getByRole('button')).toHaveCount(0);
  // Small and zoomed out: the leg ends stay, the bus's crowded stops thin out.
  const stopDisplay = sel => editorMap.locator(sel).evaluateAll(gs => gs.map(g => g.getAttribute('display') !== 'none'));
  expect(await stopDisplay('.map-stop.major')).not.toContain(false);
  const minor = await stopDisplay('.map-stop:not(.major)');
  expect(minor.filter(Boolean).length).toBeLessThan(minor.length / 2);
  await setup.getByRole('button', { name: /^Change leg 2/ }).click();
  await setup.getByRole('button', { name: 'Remove leg', exact: true }).click();
  await expect(legs(setup.locator('.route-map'))).toHaveCount(1);
  // Nothing about the place's position is saved with the trip.
  expect(JSON.stringify(await page.evaluate(() => localStorage.getItem('t-minus:config')))).not.toContain('42.4665');
});

// ---------- the base map (basemap.json) ----------
// A small base map around the commute (Melrose to State): land, a lake, a river, borders, one
// faint line of each kind, and names: towns (Boston only zoomed out), neighborhoods (North End
// overlapping Downtown at the fit), and Arlington just west of the fit.
const enc = pts => encodePolyline(pts.map(([lat, lon]) => ({ lat, lon })));
const BASE = {
  v: 1, credit: 'Base map: test credit', box: [-71.4, 42.2, -70.8, 42.7], detail: [-71.3, 42.25, -70.9, 42.65],
  coarse: [], land: [enc([[42.25, -71.3], [42.65, -71.3], [42.65, -70.95], [42.25, -70.95]])],
  lakes: [enc([[42.41, -71.10], [42.415, -71.10], [42.415, -71.09], [42.41, -71.09]])],
  rivers: [enc([[42.40, -71.12], [42.40, -71.07]])], towns: [enc([[42.44, -71.12], [42.44, -71.02]])], hoods: [enc([[42.36, -71.08], [42.36, -71.04]])],
  lines: [{ k: 'rt', c: 'DA291C', p: [enc([[42.36, -71.10], [42.37, -71.06]])] }, { k: 'cr', c: '80276C', p: [enc([[42.38, -71.10], [42.45, -71.07]])] }, { k: 'sl', c: '7C878E', p: [enc([[42.35, -71.06], [42.34, -71.04]])] }],
  names: [
    { n: 'Malden', k: 't', lat: 42.43, lon: -71.066, a: 13 }, { n: 'Boston', k: 't', lat: 42.335, lon: -71.06, a: 125, sub: 1 },
    { n: 'Arlington', k: 't', lat: 42.415, lon: -71.14, a: 14 },
    { n: 'Charlestown', k: 'h', lat: 42.378, lon: -71.06, a: 3.6 }, { n: 'Downtown', k: 'h', lat: 42.3535, lon: -71.06, a: 2.9 },
    { n: 'North End', k: 'h', lat: 42.3545, lon: -71.059, a: 0.5 },
  ],
};
async function serveBase(page, { fail = false, base = BASE } = {}) {
  const served = { hits: 0, fail };
  await page.route('**/basemap.json', route => { served.hits++; return served.fail ? route.abort() : route.fulfill({ json: base }); });
  return served;
}
const shownNames = page => svg(page).locator('.map-name').evaluateAll(ts => ts.filter(t => t.closest('g').getAttribute('display') !== 'none').map(t => t.textContent).sort());
const viewWidth = async page => Number((await svg(page).getAttribute('viewBox')).split(' ')[2]);

test('the base map beneath the trip, fetched once; names: towns, then neighborhoods, larger first, fully inside', async ({ page }) => {
  const served = await serveBase(page);
  await openApp(page, { time: '07:00', init: DENIED });
  await openMap(page);
  const base = svg(page).locator('> g.map-base');
  await expect(base).toHaveAttribute('aria-hidden', 'true');
  expect(await svg(page).evaluate(s => s.firstElementChild.classList.contains('map-base'))).toBe(true); // beneath the trip
  for (const cls of ['map-water', 'map-land', 'map-lake', 'map-river', 'map-town-line', 'map-hood-line']) await expect(base.locator(`.${cls}`)).toHaveCount(1);
  expect(await base.locator('.map-faint').evaluateAll(ps => ps.map(p => p.classList[1]))).toEqual(['cr', 'sl', 'rt']);
  await expect(legs(svg(page))).toHaveCount(2);
  expect(await viewWidth(page)).toBeLessThan(10_000);
  expect(await shownNames(page)).toEqual(['Charlestown', 'Downtown', 'Malden']); // not North End (overlaps), Boston (zoomed in), Arlington (cut off)
  await expect(page.locator('#map-credit')).toHaveText('Base map: test credit');
  // Fetched once: reopening and setup's maps reuse it.
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#map-credit')).toBeHidden();
  await openMap(page);
  await expect(svg(page).locator('.map-base')).toHaveCount(1);
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  await page.locator('#open-setup').click();
  await page.locator('#setup').getByRole('button', { name: /Home to office/ }).first().click();
  await expect(page.locator('#setup .route-map .map-base')).toHaveCount(1);
  expect(served.hits).toBe(1);
});

test('base map names follow the view: zoomed out, Boston instead of neighborhoods; zoomed in, both neighborhoods; panned, the town at the edge', async ({ page }) => {
  await serveBase(page);
  await openApp(page, { time: '07:00', init: DENIED });
  await openMap(page);
  const box = await svg(page).boundingBox();
  // Out (the wheel, about the map's middle) past 10 km across.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 4 && await viewWidth(page) < 10_000; i++) await page.mouse.wheel(0, 100);
  expect(await viewWidth(page)).toBeGreaterThan(10_000);
  const out = await shownNames(page);
  expect(out).toEqual(expect.arrayContaining(['Boston', 'Malden']));
  expect(out.filter(n => ['Charlestown', 'Downtown', 'North End'].includes(n))).toEqual([]);
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  // A fresh fit, zoomed in over Downtown: North End separates from it.
  await openMap(page);
  const at = await svg(page).evaluate(s => {
    const g = [...s.querySelectorAll('.map-name')].find(x => x.textContent === 'Downtown').closest('g');
    const [vx, vy, vw, vh] = s.getAttribute('viewBox').split(' ').map(Number), r = s.getBoundingClientRect();
    return { x: r.x + ((g.dataset.x - vx) / vw) * r.width, y: r.y + ((g.dataset.y - vy) / vh) * r.height };
  });
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);
  expect(await shownNames(page)).toEqual(expect.arrayContaining(['Downtown', 'North End']));
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  // Another, dragged east: Arlington comes into view.
  await openMap(page);
  expect(await shownNames(page)).not.toContain('Arlington');
  await page.mouse.move(box.x + 100, box.y + 300);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(box.x + 100 + i * 10, box.y + 300);
  await page.mouse.up();
  expect(await shownNames(page)).toContain('Arlington');
});

test('without the base map the map draws as today; the next opening tries again', async ({ page }) => {
  const served = await serveBase(page, { fail: true });
  await openApp(page, { time: '07:00', init: DENIED });
  await openMap(page);
  await expect(legs(svg(page))).toHaveCount(2);
  await expect(svg(page).locator('.map-base')).toHaveCount(0);
  await expect(page.locator('#map-credit')).toBeHidden();
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  served.fail = false;
  await openMap(page);
  await expect(svg(page).locator('.map-base')).toHaveCount(1);
  await expect(page.locator('#map-credit')).toBeVisible();
  expect(served.hits).toBe(2);
});

// Panning and zooming out (2026-11-08): anywhere commuter rail reaches (the base map's `reach`,
// 5 km more), and ⤢ back to the trip.
const REACH = { ...BASE, reach: [-71.35, 42.15, -70.85, 42.65] }; // ~41 × 56 km
const view = async page => (await svg(page).getAttribute('viewBox')).split(' ').map(Number);
async function zoomOut(page, n = 30) {
  const box = await svg(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < n; i++) await page.mouse.wheel(0, 300);
}
test('the sheet zooms out to all of commuter rail\'s reach and pans over it; without it, twice the trip', async ({ page }) => {
  await serveBase(page, { base: REACH });
  await openApp(page, { time: '07:00', init: DENIED });
  await openMap(page);
  const fit = await view(page);
  await zoomOut(page);
  const out = await view(page);
  expect(out[2]).toBeGreaterThan(fit[2] * 2.5); // past today's 2× limit
  expect(out[2]).toBeGreaterThan(45_000); // the reach's 41 km width with 5 km on each side…
  expect(out[3]).toBeGreaterThan(60_000); // …and its 56 km height, both in one view
  expect(out[2]).toBeLessThan(80_000); // but no further
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  // The old file (no `reach`): today's limits.
  await page.unroute('**/basemap.json');
  await page.reload();
  await serveBase(page);
  await openMap(page);
  const fit2 = await view(page);
  await zoomOut(page);
  expect((await view(page))[2]).toBeCloseTo(fit2[2] * 2, 0);
});

test('⤢ shows once the view moves and eases back to the trip; with Reduce Motion it jumps', async ({ page }) => {
  await serveBase(page, { base: REACH });
  await openApp(page, { time: '07:00', init: DENIED });
  await openMap(page);
  const fitBtn = sheet(page).getByRole('button', { name: 'Show the whole trip' });
  await expect(fitBtn).toBeHidden();
  const fit = await view(page);
  await zoomOut(page, 3);
  await expect(fitBtn).toBeVisible();
  await fitBtn.click();
  await tick(page, 50);
  const mid = await view(page);
  expect(mid[2]).toBeGreaterThan(fit[2] * 1.01); // still on its way
  await tick(page, 400);
  expect(await view(page)).toEqual(fit);
  await expect(fitBtn).toBeHidden();
  // A drag shows it too; Reduce Motion: back at once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const box = await svg(page).boundingBox();
  await page.mouse.move(box.x + 100, box.y + 300);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 100 + i * 10, box.y + 300);
  await page.mouse.up();
  await expect(fitBtn).toBeVisible();
  await fitBtn.click();
  expect(await view(page)).toEqual(fit);
  await expect(fitBtn).toBeHidden();
});

// The empty main screen's map (2026-11-09): no rows once loaded.
const emptyMap = page => page.locator('#rows .empty-map-item');
test('no rows: the trip\'s map fills the space (vehicles, the hint, the credit); a tap opens the sheet; gone with rows', async ({ page }) => {
  await serveBase(page);
  const scenario = { ...commute(), vehicles: [vehicleAt('inside', '132in-0612', 15)] };
  const trips = scenario.trips;
  scenario.trips = [];
  const mbta = await openApp(page, { time: '07:00', scenario, init: DENIED, waitForRows: false });
  await expect(page.locator('#rows .empty')).toHaveText('No upcoming departures found.');
  const map = emptyMap(page);
  await expect(map.locator('svg.route-svg')).toHaveAttribute('role', 'img');
  await expect(legs(map)).toHaveCount(2);
  await expect(map.locator('.map-caption')).toHaveText('Tap for the full map');
  await expect(locateBtn(map).locator('svg path')).toHaveCount(1);
  await expect(locateBtn(map)).toHaveText('');
  await expect(map.locator('.map-credit')).toHaveText('Base map: test credit');
  await expect(map.locator('.map-vehicle')).toHaveCount(1);
  // Fills the space: the page ends at the screen's bottom (the footer in view), not scrolling.
  const h = await map.locator('svg.route-svg').evaluate(s => s.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(250);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
  // No prompt on its own; the once-a-second redraw keeps the same map.
  await tick(page, 3000);
  expect(await page.evaluate(() => window.geoAsks)).toBe(0);
  expect(await map.locator('svg.route-svg').evaluate(s => (s.dataset.kept = '1'))).toBe('1');
  await tick(page, 2000);
  await expect(map.locator('svg.route-svg[data-kept="1"]')).toHaveCount(1);
  // Vehicles every 10 s (the first poll at once: one per leg), paused while the sheet is open.
  await expect.poll(() => vehicleHits(mbta).length).toBeGreaterThanOrEqual(2);
  await tick(page, 1000);
  const polled = vehicleHits(mbta).length;
  await tick(page, 10_000);
  expect(vehicleHits(mbta).length).toBe(polled + 2);
  const beforeSheet = vehicleHits(mbta).length;
  await map.locator('svg.route-svg').click();
  await expect(sheet(page)).toBeVisible();
  await expect.poll(() => vehicleHits(mbta).length).toBe(beforeSheet + 2); // the sheet's first poll
  const sheetOpen = vehicleHits(mbta).length;
  await tick(page, 10_000);
  expect(vehicleHits(mbta).length).toBe(sheetOpen + 2); // the sheet's only
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  // Rides again: the map goes, and its polling stops.
  scenario.trips = trips;
  await page.locator('#refresh').click();
  await tick(page, 1000);
  await expect(page.locator('.row').first()).toBeVisible();
  await expect(emptyMap(page)).toHaveCount(0);
  const after = vehicleHits(mbta).length;
  await tick(page, 30_000);
  expect(vehicleHits(mbta).length).toBe(after);
});

test('no rows, locate: asks, then "Location off" when denied; granted: centered on you with ⤢ back', async ({ page, context }) => {
  const scenario = { ...commute(), trips: [] };
  await openApp(page, { time: '07:00', scenario, init: DENIED, waitForRows: false });
  const map = emptyMap(page);
  await expect(map.locator('.map-here')).toHaveCount(0);
  await locateBtn(map).click();
  await tick(page, 100);
  expect(await page.evaluate(() => window.geoAsks)).toBe(1);
  await expect(map.locator('.map-caption')).toHaveText('Location off');
  await expect(sheet(page)).toBeHidden(); // the button doesn't open the sheet
  // Granted (a new page): the dot without asking; locate centers; ⤢ goes back.
  const p2 = await context.newPage();
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 42.4740, longitude: -71.0900 });
  await openApp(p2, { time: '07:00', scenario, waitForRows: false });
  const map2 = emptyMap(p2);
  await expect(map2.locator('.map-here')).toHaveCount(1);
  await tick(p2, 1500); // its height settled
  const fit = await map2.locator('svg.route-svg').getAttribute('viewBox');
  const fitBtn = map2.getByRole('button', { name: 'Show the whole trip' });
  await expect(fitBtn).toBeHidden();
  await locateBtn(map2).click();
  await tick(p2, 300);
  await expect(fitBtn).toBeVisible();
  expect(await map2.locator('svg.route-svg').getAttribute('viewBox')).not.toBe(fit);
  await p2.emulateMedia({ reducedMotion: 'reduce' });
  await fitBtn.click();
  expect(await map2.locator('svg.route-svg').getAttribute('viewBox')).toBe(fit);
  await expect(fitBtn).toBeHidden();
  await expect(sheet(p2)).toBeHidden();
});

// Vehicles point the way they travel; zoomed out past 1.5× the fit, only your ride's (2026-11-09).
test('vehicles point along the route; zoomed out, hidden and not polled until you zoom back in', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('inside', '132in-0612', 15)] };
  const mbta = await openApp(page, { time: '07:00', scenario, init: DENIED });
  await openMap(page);
  const bus = svg(page).locator('[data-vehicle="inside"]');
  await expect(bus).toBeVisible();
  // The point is turned to the heading, the label upright.
  const heading = Number((await bus.locator('path').getAttribute('transform')).match(/^rotate\((.+)\)$/)[1]);
  expect(Number(await bus.getAttribute('data-heading'))).toBe(Math.round(heading));
  await expect(bus.locator('text')).not.toHaveAttribute('transform', /rotate/);
  // Toward Malden: the bus between stops 15 and 16 heads from one to the other.
  const a = busStop(busStops[15]), b = busStop(busStops[16]);
  const toward = Math.atan2(-(b.latitude - a.latitude), (b.longitude - a.longitude) * Math.cos(a.latitude * Math.PI / 180)) * 180 / Math.PI;
  expect(Math.abs(((heading - toward + 540) % 360) - 180)).toBeLessThan(60);
  // Zoomed out: hidden, and no polls while nothing would show.
  const fit = await view(page);
  await zoomOut(page, 10);
  expect((await view(page))[2]).toBeGreaterThan(fit[2] * 1.5);
  await expect(bus).toBeHidden();
  await tick(page, 10_500);
  const paused = vehicleHits(mbta).length;
  await tick(page, 20_000);
  expect(vehicleHits(mbta).length).toBe(paused);
  // ⤢: shown again, polled at once.
  await sheet(page).getByRole('button', { name: 'Show the whole trip' }).click();
  await tick(page, 400);
  await expect(bus).toBeVisible();
  await expect.poll(() => vehicleHits(mbta).length).toBe(paused + 2);
});

test('zoomed out with a ride: your vehicle stays, the others hide, polls go on', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('inside', '132in-0612', 15), vehicleAt('mine', '132in-0736', 18)] };
  const mbta = await openApp(page, { time: '07:00', scenario, init: DENIED });
  const second = page.locator('.row').nth(1);
  await second.click();
  await second.getByRole('button', { name: 'Track', exact: true }).click();
  await tick(page, 1000);
  await openMap(page);
  await expect(svg(page).locator('.map-vehicle')).toHaveCount(2);
  await zoomOut(page, 10);
  await expect(svg(page).locator('[data-vehicle="mine"]')).toBeVisible();
  await expect(svg(page).locator('[data-vehicle="inside"]')).toBeHidden();
  const was = vehicleHits(mbta).length;
  await tick(page, 10_000);
  expect(vehicleHits(mbta).length).toBe(was + 2);
});
