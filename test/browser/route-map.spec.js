// The route map (DESIGN.md "Route map"): the main screen's map (2026-11-12) opens the sheet with
// the shown trip at true positions, the phone's location and the legs' vehicles while open; setup's planner options and trip
// editor draw the same map inline. Shapes come from the recorded patterns (fake-mbta.js).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, tick, tickTo, commute, riding, planOptions, expandOption, cssColor } from './helpers.js';
import { encodePolyline, areaRect, projector } from '../../core.js';
import { series } from './fake-mbta.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const sheet = page => page.getByRole('dialog');
const mainMap = page => page.locator('#rows .main-map-item');
const svg = page => sheet(page).locator('svg.route-svg');
const locateBtn = loc => loc.getByRole('button', { name: 'Center on my location' });
const legs = loc => loc.locator('polyline.map-leg:not(.off)');
const pins = loc => loc.locator('.map-pin'); // each leg's stretch (not a bus line's faded ends)
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

// A tap on the main screen's map, away from its corner buttons.
async function openMap(page) {
  await mainMap(page).locator('svg.route-svg').click({ position: { x: 12, y: 12 } });
  await tick(page, 300);
  await expect(sheet(page)).toBeVisible();
}

test('a tap on the main screen\'s map opens the trip: both legs at their shapes, labeled ends, stop names on tap; shapes kept on the phone', async ({ page }) => {
  const mbta = await openApp(page, { map: true, time: '07:00', init: DENIED });
  await expect(page.locator('header').getByRole('button', { name: 'Route map' })).toHaveCount(0); // until 2026-11-12
  await openMap(page);
  await expect(sheet(page).getByRole('heading')).toHaveText('Home to office');
  await expect(svg(page)).toHaveAttribute('aria-label', 'Map of Home to office');
  await expect(legs(svg(page))).toHaveCount(2);
  expect(await legs(svg(page)).evaluateAll(ls => ls.map(l => l.dataset.color))).toEqual(['FFC72C', 'ED8B00']);
  // The shapes, not straight lines: the bus leg follows its streets.
  expect(Number(await legs(svg(page)).first().evaluate(l => l.points.length))).toBeGreaterThan(20);
  // The leg ends are labeled; a transfer between close stops shows the next leg's name.
  await expect(svg(page).locator('.map-label')).toHaveText(['Main St @ South St', 'Oak Grove', 'State']);
  // Pins on the first and last stops (2026-11-09), unlabeled (the stops' labels name them),
  // decorative, drawn over the stops and under the vehicles.
  await expect(pins(svg(page))).toHaveCount(2);
  expect(await pins(svg(page)).evaluateAll(ps => ps.map(p => p.getAttribute('class')))).toEqual(['map-pin start on-stop', 'map-pin end on-stop']);
  await expect(pins(svg(page)).locator('text')).toHaveCount(0);
  expect(await pins(svg(page)).evaluateAll(ps => ps.map(p => [p.getAttribute('role'), p.getAttribute('tabindex'), p.getAttribute('aria-hidden')]))).toEqual([[null, null, 'true'], [null, null, 'true']]);
  const xy = l => l.evaluate(g => [g.dataset.x, g.dataset.y]);
  expect(await xy(pins(svg(page)).first())).toEqual(await xy(svg(page).getByRole('button', { name: 'Main St @ South St' })));
  expect(await xy(pins(svg(page)).last())).toEqual(await xy(svg(page).getByRole('button', { name: 'State', exact: true })));
  expect(await svg(page).evaluate(s => { const kids = [...s.children]; return kids.indexOf(s.querySelector('.map-pin.start')) > kids.indexOf([...s.querySelectorAll('.map-stop')].at(-1)); })).toBe(true);
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
  // A tap focuses nothing, and nothing gets the focus back (focusing the trip picker opened it on iOS).
  await expect(page.locator('#toggle select')).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  // From the keyboard: "Open the full map", shown while focused, opens it and gets the focus back.
  const open = mainMap(page).getByRole('button', { name: 'Open the full map' });
  await open.focus();
  await expect(open).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toBeHidden();
  await expect(open).toBeFocused();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('t-minus:shapes:')).sort())).toEqual(['t-minus:shapes:132/1', 't-minus:shapes:Orange/0']);
  await page.reload();
  await page.locator('.row').first().waitFor();
  await openMap(page);
  await expect(legs(svg(page))).toHaveCount(2);
  expect(shapeHits(mbta)).toHaveLength(2);
});

test('no trips: no map', async ({ page }) => {
  await openApp(page, { map: true, time: '07:00', config: { trips: [] }, waitForRows: false });
  await expect(page.locator('.route-map')).toHaveCount(0);
});

test('the phone\'s location, already granted: the dot in the fit, no walk to the first stop; locate centers on it', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 42.4740, longitude: -71.0900 }); // north of the first stop
  await openApp(page, { map: true, time: '07:00' });
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
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10)); // the ease runs on the page clock only
  await locateBtn(sheet(page)).click();
  await tick(page, 50);
  const moving = await inView(); // eased like ⤢ (2026-11-09): on its way
  expect(Math.abs(moving.y - 0.5)).toBeGreaterThan(0.02);
  await tick(page, 300);
  const centered = await inView();
  expect(centered.x).toBeCloseTo(0.5, 2); expect(centered.y).toBeCloseTo(0.5, 2);
  expect((await view(page))[2]).toBeCloseTo(400, -1); // street level, following (2026-11-10)
  await expect(sheet(page).locator('.map-locate')).toHaveAttribute('aria-pressed', 'true');
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
  await openApp(page, { map: true, time: '07:00', init: DENIED });
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
  await expect(page.locator('#toast')).toBeHidden(); // the iOS app's Settings toast only
});

test('vehicles on the legs every 10 s while open, yours outlined; nothing after Done', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('before', '132in-0640', 3), vehicleAt('inside', '132in-0612', 15), vehicleAt('mine', '132in-0736', 18)] };
  const mbta = await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  // Bell the 7:36 bus (the second row).
  const second = page.locator('.row').nth(1);
  await second.click();
  await second.getByRole('button', { name: 'Track', exact: true }).click();
  await tick(page, 1000);
  const base = vehicleHits(mbta).length; // the main screen's map's
  await openMap(page);
  await expect(svg(page).locator('.map-vehicle')).toHaveCount(3); // the one before the boarding stop too (2026-11-09: coming toward it)
  await expect(svg(page).locator('.map-vehicle.mine')).toHaveCount(1);
  await expect(svg(page).locator('.map-vehicle.mine')).toHaveAttribute('data-vehicle', 'mine');
  await expect(svg(page).locator('.map-vehicle text').first()).toHaveText('132');
  const first = vehicleHits(mbta).length;
  expect(first).toBe(base + 2); // one per leg at opening
  await tick(page, 10_000);
  expect(vehicleHits(mbta).length).toBe(base + 4); // the sheet's only: the main map's wait
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
  expect(vehicleHits(mbta).length).toBeLessThanOrEqual(after + 6); // the main screen's map's again, no more
});

test('riding: the first walk is gone and finished legs fade', async ({ page }) => {
  await openApp(page, { map: true, time: '07:00', init: DENIED });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:24');
  await openMap(page);
  expect(await legs(svg(page)).evaluateAll(ls => ls.map(l => l.classList.contains('faded')))).toEqual([true, false]);
  await expect(svg(page).locator('.map-walk[data-kind="start"]')).toHaveCount(0);
  // The start pin fades with the finished leg; the end pin stays.
  await expect(svg(page).locator('.map-pin.start')).toHaveClass(/faded/);
  await expect(svg(page).locator('.map-pin.end')).not.toHaveClass(/faded/);
});

test('without shapes (MBTA down, nothing kept): straight lines through the stops, no message', async ({ page }) => {
  await openApp(page, { map: true, time: '07:00', scenario: { ...commute(), noShapes: true }, init: DENIED });
  await openMap(page);
  await expect(legs(svg(page))).toHaveCount(2);
  expect(await legs(svg(page)).evaluateAll(ls => ls.map(l => l.points.length))).toEqual([2, 2]); // the legs' ends from the loaded times
  await expect(page.locator('#map-caption')).toHaveText('');
});

test('pinch zooms and a drag pans', async ({ page }) => {
  await openApp(page, { map: true, time: '07:00', init: DENIED });
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
  await openApp(page, { map: true, time: '07:00' });
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
  // Pins (2026-11-09): at the place, labeled to its first comma on the side away from the walk
  // (the stop is west: on the right), fitted inside the map; the end's on State, unlabeled.
  await expect(pins(map)).toHaveCount(2);
  const startPin = map.locator('.map-pin.start');
  await expect(startPin.locator('.map-label')).toHaveText('Main St');
  await expect(startPin.locator('.map-label')).not.toHaveAttribute('text-anchor', 'end');
  await expect(startPin).not.toHaveClass(/on-stop/);
  await expect(map.locator('.map-pin.end')).toHaveClass(/on-stop/);
  await expect(map.locator('.map-pin.end .map-label')).toHaveCount(0);
  const walk = map.locator('.map-walk[data-kind="start"]');
  expect(await startPin.evaluate(g => [Number(g.dataset.x), Number(g.dataset.y)])).toEqual([Number(await walk.getAttribute('x1')), Number(await walk.getAttribute('y1'))]);
  const [pb, sb] = [await startPin.boundingBox(), await map.locator('svg').boundingBox()];
  expect(pb.x >= sb.x && pb.y >= sb.y && pb.x + pb.width <= sb.x + sb.width && pb.y + pb.height <= sb.y + sb.height).toBe(true);
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
  await expect(editorMap.locator('.map-pin.on-stop')).toHaveCount(2);
  // The bus's whole line there too, its other stops as plain (not tappable) dots (2026-11-09).
  await expect(editorMap.locator('polyline.map-leg.off')).not.toHaveCount(0);
  // The bus's other stops only: no Orange stations outside the stretch, as before 2026-11-12.
  await expect(editorMap.locator('.map-stop.off')).toHaveCount(8 + (busStops.length - 25));
  // Small and zoomed out: the leg ends stay, the bus's crowded stops thin out.
  const stopDisplay = sel => editorMap.locator(sel).evaluateAll(gs => gs.map(g => g.getAttribute('display') !== 'none'));
  expect(await stopDisplay('.map-stop.major')).not.toContain(false);
  const minor = await stopDisplay('.map-stop:not(.major)');
  expect(minor.filter(Boolean).length).toBeLessThan(minor.length / 2);
  await setup.getByRole('button', { name: /^Change leg 2/ }).click();
  await setup.getByRole('button', { name: 'Remove leg', exact: true }).click();
  await expect(legs(setup.locator('.route-map'))).toHaveCount(1);
  await expect(pins(setup.locator('.route-map'))).toHaveCount(2);
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
  green: [enc([[42.42, -71.11], [42.43, -71.11], [42.43, -71.09], [42.42, -71.09]])],
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
  await openApp(page, { map: true, time: '07:00', init: DENIED });
  await openMap(page);
  const base = svg(page).locator('> g.map-base');
  await expect(base).toHaveAttribute('aria-hidden', 'true');
  expect(await svg(page).evaluate(s => s.firstElementChild.classList.contains('map-base'))).toBe(true); // beneath the trip
  for (const cls of ['map-water', 'map-land', 'map-green', 'map-lake', 'map-river', 'map-town-line', 'map-hood-line']) await expect(base.locator(`.${cls}`)).toHaveCount(1);
  // Parks above the land, beneath the water and borders, in --map-green (soft in light, stronger in dark).
  expect(await base.evaluate(g => [...g.children].map(c => c.getAttribute('class')).slice(0, 4))).toEqual(['map-water', 'map-land', 'map-green', 'map-lake']);
  const greenFill = () => base.locator('.map-green').evaluate(p => getComputedStyle(p).fill);
  expect(await greenFill()).toBe(await cssColor(page, '--map-green'));
  expect(await greenFill()).toBe('rgb(228, 239, 220)');
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await greenFill()).toBe('rgb(37, 54, 42)');
  await page.emulateMedia({ colorScheme: 'light' });
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

const backToFit = async page => {
  await sheet(page).locator('.map-fit').click();
  await tick(page, 400);
};
test('base map names follow the view: zoomed out, Boston instead of neighborhoods; zoomed in, both neighborhoods; panned, the town at the edge', async ({ page }) => {
  await serveBase(page);
  await openApp(page, { map: true, time: '07:00', init: DENIED });
  await openMap(page);
  const box = await svg(page).boundingBox();
  // Out (the wheel, about the map's middle) past 10 km across.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 4 && await viewWidth(page) < 10_000; i++) await page.mouse.wheel(0, 100);
  expect(await viewWidth(page)).toBeGreaterThan(10_000);
  const out = await shownNames(page);
  expect(out).toEqual(expect.arrayContaining(['Boston', 'Malden']));
  expect(out.filter(n => ['Charlestown', 'Downtown', 'North End'].includes(n))).toEqual([]);
  // Back to the fit (the view carries to the next opening, 2026-11-12), zoomed in over Downtown:
  // North End separates from it.
  await backToFit(page);
  const at = await svg(page).evaluate(s => {
    const g = [...s.querySelectorAll('.map-name')].find(x => x.textContent === 'Downtown').closest('g');
    const [vx, vy, vw, vh] = s.getAttribute('viewBox').split(' ').map(Number), r = s.getBoundingClientRect();
    return { x: r.x + ((g.dataset.x - vx) / vw) * r.width, y: r.y + ((g.dataset.y - vy) / vh) * r.height };
  });
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);
  expect(await shownNames(page)).toEqual(expect.arrayContaining(['Downtown', 'North End']));
  // Back to the fit, dragged east: Arlington comes into view.
  await backToFit(page);
  expect(await shownNames(page)).not.toContain('Arlington');
  await page.mouse.move(box.x + 100, box.y + 300);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(box.x + 100 + i * 10, box.y + 300);
  await page.mouse.up();
  expect(await shownNames(page)).toContain('Arlington');
});

test('without the base map the map draws as today; the next opening tries again', async ({ page }) => {
  const served = await serveBase(page, { fail: true });
  await openApp(page, { map: true, time: '07:00', init: DENIED });
  await openMap(page);
  await expect(legs(svg(page))).toHaveCount(2);
  await expect(svg(page).locator('.map-base')).toHaveCount(0);
  await expect(page.locator('#map-credit')).toBeHidden();
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  served.fail = false;
  await openMap(page);
  await expect(svg(page).locator('.map-base')).toHaveCount(1);
  await expect(page.locator('#map-credit')).toBeVisible();
  expect(served.hits).toBe(3); // the main screen's map at load, then each opening
});

// Panning and zooming out (2026-11-08; the view's edges within the bound since 2026-11-09):
// commuter rail's farthest stations (the base map's `reach`, 2 km more), and back to the trip.
const REACH = { ...BASE, reach: [-71.35, 42.15, -70.85, 42.65] }; // ~41 × 56 km
const view = async page => (await svg(page).getAttribute('viewBox')).split(' ').map(Number);
// The bound in the sheet's meters: the reach, 2 km more (the map's origin is the first boarding stop).
const bound = () => areaRect(REACH.reach, projector(busStop('25996').latitude, busStop('25996').longitude));
const aspectOf = async page => { const b = await svg(page).boundingBox(); return b.width / b.height; };
async function zoomOut(page, n = 30) {
  const box = await svg(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < n; i++) await page.mouse.wheel(0, 300);
}
test('the sheet zooms out to all of commuter rail\'s reach and pans over it; without it, twice the trip', async ({ page }) => {
  await serveBase(page, { base: REACH });
  await openApp(page, { map: true, time: '07:00', init: DENIED });
  await openMap(page);
  const fit = await view(page);
  await zoomOut(page);
  const out = await view(page);
  const b = bound(), aspect = await aspectOf(page);
  expect(out[2]).toBeGreaterThan(fit[2] * 2.5); // past the 2× limit without the base map
  expect(out[2]).toBeCloseTo(Math.max(b.w, b.h * aspect), -2); // all of the bound in one view, no further
  expect(out[2]).toBeGreaterThanOrEqual(b.w - 1); expect(out[3]).toBeGreaterThanOrEqual(b.h - 1);
  if (out[3] > b.h) expect(out[1] + out[3] / 2).toBeCloseTo(b.y + b.h / 2, -1); // the long axis centered
  // Panned far north, then far east: the view's edges stop at the bound's (not its center).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Show the whole trip' }).click();
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
  const drag = async (dx, dy) => {
    const box = await svg(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + box.width / 2 + dx * i / 20, box.y + box.height / 2 + dy * i / 20);
    await page.mouse.up();
  };
  for (let i = 0; i < 4; i++) await drag(0, 600);
  const north = await view(page);
  expect(north[1]).toBeCloseTo(b.y, -1);
  for (let i = 0; i < 4; i++) await drag(-600, 0);
  const east = await view(page);
  expect(east[0] + east[2]).toBeCloseTo(b.x + b.w, -1);
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  // The old file (no `reach`): today's limits.
  await page.unroute('**/basemap.json');
  await serveBase(page);
  await page.reload();
  await page.locator('.row').first().waitFor();
  await openMap(page);
  const fit2 = await view(page);
  await zoomOut(page);
  expect((await view(page))[2]).toBeCloseTo(fit2[2] * 2, 0);
});

test('back to the trip (an icon) shows once the view moves and eases back; with Reduce Motion it jumps', async ({ page }) => {
  await serveBase(page, { base: REACH });
  await openApp(page, { map: true, time: '07:00', init: DENIED });
  await openMap(page);
  const fitBtn = sheet(page).getByRole('button', { name: 'Show the whole trip' });
  await expect(fitBtn).toBeHidden();
  const fit = await view(page);
  await zoomOut(page, 3);
  await expect(fitBtn.locator('svg circle')).toHaveCount(2); // a route in frame corners, not ⤢ (2026-11-09)
  await expect(fitBtn).toHaveText('');
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

// The whole map (the sheet, 2026-11-09): below back to the trip; fully zoomed out over the bound.
test('the whole map button: shown once the base map is in, eases all the way out, hidden there', async ({ page }) => {
  let release;
  const held = new Promise(r => { release = r; });
  await page.route('**/basemap.json', async route => { await held; return route.fulfill({ json: REACH }); });
  await openApp(page, { map: true, time: '07:00', init: DENIED });
  await openMap(page);
  const whole = sheet(page).getByRole('button', { name: 'Show the whole map' });
  await expect(whole).toBeHidden(); // no bound yet
  release();
  await expect(svg(page).locator('.map-base')).toHaveCount(1);
  await expect(whole).toBeVisible();
  const order = await sheet(page).locator('.map-tools .map-tool').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')));
  expect(order).toEqual(['Center on my location', 'Show the whole trip', 'Show the whole map']);
  await expect(whole.locator('svg path')).toHaveCount(1);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10));
  await whole.click();
  await tick(page, 50);
  const b = bound(), aspect = await aspectOf(page), all = Math.max(b.w, b.h * aspect);
  expect((await view(page))[2]).toBeLessThan(all * 0.99); // on its way
  await tick(page, 400);
  const out = await view(page);
  expect(out[2]).toBeCloseTo(all, -2);
  expect(out[0] + out[2] / 2).toBeCloseTo(b.x + b.w / 2, -1);
  expect(out[1] + out[3] / 2).toBeCloseTo(b.y + b.h / 2, -1);
  await expect(whole).toBeHidden();
  await expect(sheet(page).getByRole('button', { name: 'Show the whole trip' })).toBeVisible();
});

// Outside the bound (2026-11-09): your location left out of the fit, no dot, locate off.
test('your location outside the map: no dot, not in the fit, locate disabled; back inside, it comes back', async ({ page, context }) => {
  await serveBase(page, { base: REACH });
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 40.71, longitude: -74.0 }); // New York
  await openApp(page, { map: true, time: '07:00' });
  await openMap(page);
  await expect(svg(page).locator('.map-base')).toHaveCount(1);
  await expect(svg(page).locator('.map-here')).toHaveCount(0);
  expect((await view(page))[2]).toBeLessThan(30_000); // the trip's fit, not stretched to New York
  const off = sheet(page).getByRole('button', { name: 'Center on my location (outside the map)' });
  await expect(off).toBeDisabled();
  await expect(page.locator('#map-caption')).toHaveText(''); // the caption only after a locate tap
  await context.setGeolocation({ latitude: 42.4740, longitude: -71.0900 });
  await expect(svg(page).locator('.map-here')).toHaveCount(1);
  await expect(locateBtn(sheet(page))).toBeEnabled();
});

test('locate tapped while outside the map: no move, "Outside the map", the button off', async ({ page }) => {
  await serveBase(page, { base: REACH });
  await openApp(page, { map: true,
    time: '07:00',
    init: () => {
      const at = { coords: { latitude: 40.71, longitude: -74.0, accuracy: 10 } };
      navigator.geolocation.watchPosition = ok => { setTimeout(() => ok(at), 0); return 1; };
      navigator.geolocation.getCurrentPosition = ok => setTimeout(() => ok(at), 0);
      navigator.geolocation.clearWatch = () => {};
    },
  });
  await openMap(page);
  await expect(svg(page).locator('.map-base')).toHaveCount(1);
  const before = await view(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await locateBtn(sheet(page)).click();
  await tick(page, 100);
  await expect(page.locator('#map-caption')).toHaveText('Outside the map');
  expect(await view(page)).toEqual(before);
  await expect(sheet(page).getByRole('button', { name: 'Center on my location (outside the map)' })).toBeDisabled();
  await expect(svg(page).locator('.map-here')).toHaveCount(0);
});

// The main screen's map (2026-11-12; on the empty screen only from 2026-11-09): first in the
// list, 26% of the screen's height, no caption or credit, vehicles every 10 s; hidden on demand.
const mapSvg = page => mainMap(page).locator('svg.route-svg');
test('the main screen\'s map: above the rows, 26% of the screen, vehicles every 10 s (paused for the sheet); a tap opens the sheet', async ({ page }) => {
  await serveBase(page);
  const scenario = { ...commute(), vehicles: [vehicleAt('inside', '132in-0612', 15)] };
  const mbta = await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  const map = mainMap(page);
  // First in the list, above the rows.
  expect(await page.evaluate(() => document.querySelector('#rows').firstElementChild.className)).toBe('main-map-item');
  await expect(mapSvg(page)).toHaveAttribute('role', 'img');
  await expect(mapSvg(page)).toHaveAttribute('aria-label', 'Map of Home to office');
  await expect(legs(map)).toHaveCount(2);
  await expect(pins(map)).toHaveCount(2);
  // 26% of the 844 px screen; no caption, no credit (the sheet has it).
  const h = await mapSvg(page).evaluate(s => s.getBoundingClientRect().height);
  expect(Math.abs(h - 844 * 0.26)).toBeLessThanOrEqual(1);
  await expect(map.locator('.map-caption')).toBeHidden();
  await expect(map.locator('.map-credit')).toHaveCount(0);
  await expect(map.getByRole('button', { name: 'Center on my location' })).toBeVisible();
  await expect(map.getByRole('button', { name: 'Hide map' })).toBeVisible();
  await expect(map.locator('.map-vehicle')).toHaveCount(1);
  // No prompt on its own; the once-a-second redraw keeps the same map.
  await tick(page, 3000);
  expect(await page.evaluate(() => window.geoAsks)).toBe(0);
  expect(await mapSvg(page).evaluate(s => (s.dataset.kept = '1'))).toBe('1');
  await tick(page, 2000);
  await expect(map.locator('svg.route-svg[data-kept="1"]')).toHaveCount(1);
  // Vehicles every 10 s, one per leg; paused while the sheet is open (it polls instead).
  await tick(page, 1000);
  const polled = vehicleHits(mbta).length;
  await tick(page, 10_000);
  expect(vehicleHits(mbta).length).toBe(polled + 2);
  const beforeSheet = vehicleHits(mbta).length;
  await openMap(page);
  await expect.poll(() => vehicleHits(mbta).length).toBe(beforeSheet + 2); // the sheet's first poll
  const sheetOpen = vehicleHits(mbta).length;
  await tick(page, 10_000);
  expect(vehicleHits(mbta).length).toBe(sheetOpen + 2); // the sheet's only
  await expect(page.locator('#map-credit')).toHaveText('Base map: test credit');
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  await expect(mapSvg(page)).toBeVisible();
});

test('no rows: the map first, then the message; kept across a refresh with rows', async ({ page }) => {
  const scenario = { ...commute() };
  const trips = scenario.trips;
  scenario.trips = [];
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED, waitForRows: false });
  await expect(page.locator('#rows .empty')).toHaveText('No upcoming departures found.');
  expect(await page.evaluate(() => [...document.querySelector('#rows').children].map(li => li.className))).toEqual(['main-map-item', 'empty']);
  const h = await mapSvg(page).evaluate(s => s.getBoundingClientRect().height);
  expect(Math.abs(h - 844 * 0.26)).toBeLessThanOrEqual(1); // no longer down to the footer
  expect(await mapSvg(page).evaluate(s => (s.dataset.kept = '1'))).toBe('1');
  scenario.trips = trips;
  await page.locator('#refresh').click();
  await tick(page, 1000);
  await expect(page.locator('.row').first()).toBeVisible();
  await expect(mainMap(page).locator('svg.route-svg[data-kept="1"]')).toHaveCount(1);
});

test('Hide map: "Show map ▾" instead, no requests and no location, kept across a reload; Show map polls at once', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 42.4740, longitude: -71.0900 });
  await page.addInitScript(() => {
    window.watches = 0;
    const w = navigator.geolocation.watchPosition.bind(navigator.geolocation), c = navigator.geolocation.clearWatch.bind(navigator.geolocation);
    navigator.geolocation.watchPosition = (...a) => { window.watches++; return w(...a); };
    navigator.geolocation.clearWatch = id => { window.watches--; c(id); };
  });
  const mbta = await openApp(page, { map: true, time: '07:00' });
  await expect(mainMap(page).locator('.map-here')).toHaveCount(1);
  expect(await page.evaluate(() => window.watches)).toBe(1);
  await mainMap(page).getByRole('button', { name: 'Hide map' }).click();
  const show = page.getByRole('button', { name: 'Show map ▾' });
  await expect(show).toBeVisible();
  await expect(show).toBeFocused();
  await expect(page.locator('.route-map')).toHaveCount(0);
  await expect(page.locator('#rows > li').first()).toContainText('Show map ▾');
  await expect(sheet(page)).toBeHidden(); // the button doesn't open the sheet
  expect(await page.evaluate(() => window.watches)).toBe(0);
  const hits = vehicleHits(mbta).length;
  await tick(page, 30_000);
  expect(vehicleHits(mbta).length).toBe(hits);
  expect(await page.evaluate(() => localStorage.getItem('t-minus:mapHidden'))).toBe('true');
  await page.reload();
  await page.locator('.row').first().waitFor();
  await expect(page.getByRole('button', { name: 'Show map ▾' })).toBeVisible();
  await expect(page.locator('.route-map')).toHaveCount(0);
  // Shown again: drawn at once, polled at once, the focus on Hide map.
  const before = vehicleHits(mbta).length;
  await page.getByRole('button', { name: 'Show map ▾' }).click();
  await expect(legs(mainMap(page))).toHaveCount(2);
  await expect.poll(() => vehicleHits(mbta).length).toBe(before + 2);
  await expect(mainMap(page).getByRole('button', { name: 'Hide map' })).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('t-minus:mapHidden'))).toBe(null);
});

test('in the background: no vehicle polls and no location watch; back: both again', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 42.4740, longitude: -71.0900 });
  await page.addInitScript(() => {
    window.watches = 0;
    const w = navigator.geolocation.watchPosition.bind(navigator.geolocation), c = navigator.geolocation.clearWatch.bind(navigator.geolocation);
    navigator.geolocation.watchPosition = (...a) => { window.watches++; return w(...a); };
    navigator.geolocation.clearWatch = id => { window.watches--; c(id); };
    let hidden = false;
    Object.defineProperty(document, 'hidden', { get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible') });
    window.setHidden = h => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); };
  });
  const mbta = await openApp(page, { map: true, time: '07:00' });
  await expect(mainMap(page).locator('.map-here')).toHaveCount(1);
  await page.evaluate(() => window.setHidden(true));
  expect(await page.evaluate(() => window.watches)).toBe(0);
  const hits = vehicleHits(mbta).length;
  await tick(page, 30_000);
  expect(vehicleHits(mbta).length).toBe(hits);
  await page.evaluate(() => window.setHidden(false));
  await expect.poll(() => page.evaluate(() => window.watches)).toBe(1);
  await tick(page, 10_000);
  expect(vehicleHits(mbta).length).toBeGreaterThan(hits);
});

test('riding: the map stays above the ride card, the ridden leg faded, fitted to the rest of the ride', async ({ page }) => {
  await openApp(page, { map: true, time: '07:00', init: DENIED });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:08:30');
  await expect(page.locator('.ride-head')).toBeVisible();
  expect(await page.evaluate(() => [...document.querySelector('#rows').children].map(li => li.className.split(' ')[0]))).toEqual(['main-map-item', 'row']);
  await expect(mainMap(page).locator('polyline.map-leg.faded:not(.off)')).toHaveCount(0);
  // The first leg: the whole trip, the boarding stop in view.
  const boardingInView = () => mapSvg(page).evaluate(s => {
    const [x, y, w, h] = s.getAttribute('viewBox').split(' ').map(Number);
    const g = [...s.querySelectorAll('.map-stop')].find(m => m.querySelector('text')?.textContent === 'Main St @ South St');
    return g.dataset.x >= x && g.dataset.x <= x + w && g.dataset.y >= y && g.dataset.y <= y + h;
  });
  expect(await boardingInView()).toBe(true);
  await tickTo(page, '07:33');
  await expect(page.locator('.ride-head')).toHaveText(riding('Orange'));
  await expect(mainMap(page).locator('polyline.map-leg.faded:not(.off)')).toHaveCount(1);
  expect(await mainMap(page).locator('polyline.map-leg:not(.off)').evaluateAll(ls => ls.map(l => [l.dataset.color, l.classList.contains('faded')])))
    .toEqual([['FFC72C', true], ['ED8B00', false]]);
  // The rest of the ride: the bus's boarding stop is out of the view.
  await expect.poll(boardingInView).toBe(false);
});

test('no rows, locate: asks, then "Location off" when denied; granted: centered on you with back to the trip', async ({ page, context }) => {
  const scenario = { ...commute(), trips: [] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED, waitForRows: false });
  const map = mainMap(page);
  await expect(map.locator('.map-here')).toHaveCount(0);
  await locateBtn(map).click();
  await tick(page, 100);
  expect(await page.evaluate(() => window.geoAsks)).toBe(1);
  await expect(map.locator('.map-caption')).toHaveText('Location off');
  await expect(sheet(page)).toBeHidden(); // the button doesn't open the sheet
  // Granted (a new page): the dot without asking; locate centers; back to the trip goes back.
  const p2 = await context.newPage();
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 42.4740, longitude: -71.0900 });
  await openApp(p2, { map: true, time: '07:00', scenario, waitForRows: false });
  const map2 = mainMap(p2);
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
  const mbta = await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
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
  const mbta = await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
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

// A bus leg's whole line (2026-11-09): faded outside your stretch, its other stops as faded dots,
// and vehicles from its start to the drop-off.
test('the bus leg\'s whole line, faded outside the stretch, with its stops and the buses coming toward yours', async ({ page }) => {
  const past = busStops.length - 2; // the pattern runs on past the drop-off (index 24)
  const scenario = { ...commute(), vehicles: [vehicleAt('coming', '132in-0640', 3), vehicleAt('past', '132in-0540', past)] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  await openMap(page);
  const off = svg(page).locator('polyline.map-leg.off');
  await expect(off).toHaveCount(2); // before the boarding stop, after the drop-off
  expect(await off.evaluateAll(ls => ls.map(l => [l.dataset.color, l.classList.contains('faded')]))).toEqual([['FFC72C', true], ['FFC72C', true]]);
  // Drawn beneath the legs' stretches.
  expect(await svg(page).locator('polyline.map-leg').evaluateAll(ls => ls.map(l => l.classList.contains('off')))).toEqual([true, true, false, false]);
  // The line's other stops: faded, and their names on a tap.
  const name = busStop(busStops[3]).name;
  const dot = svg(page).locator(`.map-stop.off[aria-label="${name}"]`);
  await expect(dot).toHaveCount(1);
  // The 132's 8 before and the rest after, less Malden Center (its parent station is on the Orange
  // leg: drawn once); and the Orange pattern's 11 stations past State (2026-11-12).
  await expect(svg(page).locator('.map-stop.off')).toHaveCount(8 + (busStops.length - 25) - 1 + 11);
  await dot.dispatchEvent('click'); // off the screen at the fit
  await expect(page.locator('#map-caption')).toHaveText(name);
  // A bus coming toward your stop shows; one past the drop-off doesn't.
  await expect(svg(page).locator('[data-vehicle="coming"]')).toHaveCount(1);
  await expect(svg(page).locator('[data-vehicle="past"]')).toHaveCount(0);
  // The view still frames your trip: the line's first stop is off the screen.
  const [x, y, w, h] = (await svg(page).getAttribute('viewBox')).split(' ').map(Number);
  const first = await svg(page).locator('.map-stop.off').first().evaluate(g => [Number(g.dataset.x), Number(g.dataset.y)]);
  expect(first[0] < x || first[0] > x + w || first[1] < y || first[1] > y + h).toBe(true);
});

test('no rows, your location outside the map: no dot, locate off, no whole-map button on the picture', async ({ page, context }) => {
  await serveBase(page, { base: REACH });
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 40.71, longitude: -74.0 }); // New York
  const scenario = { ...commute(), trips: [] };
  await openApp(page, { map: true, time: '07:00', scenario, waitForRows: false });
  const map = mainMap(page);
  await expect(map.locator('.map-base')).toHaveCount(1);
  await expect(map.locator('.map-here')).toHaveCount(0);
  await expect(map.getByRole('button', { name: 'Center on my location (outside the map)' })).toBeDisabled();
  await expect(map.locator('.map-caption')).toBeHidden(); // "Outside the map" only after a locate tap
  await expect(map.getByRole('button', { name: 'Show the whole map' })).toHaveCount(0); // the sheet only
});

// Locate follows you (2026-11-10): street (400 m) first, then a tap switches area (2 km) / street;
// each position recenters; a drag, back to the trip, the whole map or leaving the bound ends it.
// A stub the test moves: not granted up front, so the watch starts with the first locate.
const GEO = () => {
  let cur = { latitude: 42.4740, longitude: -71.0900 }, ok = null, err = null;
  const pos = () => ({ coords: { ...cur, accuracy: 10 }, timestamp: Date.now() });
  navigator.geolocation.getCurrentPosition = o => setTimeout(() => o(pos()), 0);
  navigator.geolocation.watchPosition = (o, e) => { ok = o; err = e; return 1; };
  navigator.geolocation.clearWatch = () => {};
  window.geo = {
    move: (latitude, longitude) => { cur = { latitude, longitude }; ok?.(pos()); },
    lose: () => err?.({ code: 2, message: 'unavailable' }),
  };
};
const locateTool = loc => loc.locator('.map-locate');
// The dot's place in the view (0..1) and the view's width, in meters; null without a dot.
const dotIn = s => s.evaluate(s => {
  const [vx, vy, vw, vh] = s.getAttribute('viewBox').split(' ').map(Number), g = s.querySelector('.map-here');
  return g ? { x: Math.round(((g.dataset.x - vx) / vw) * 100) / 100, y: Math.round(((g.dataset.y - vy) / vh) * 100) / 100, w: Math.round(vw) } : null;
});
const move = (page, lat, lon) => page.evaluate(([a, b]) => window.geo.move(a, b), [lat, lon]);

test('locate follows you: street first, then each tap switches area / street', async ({ page }) => {
  await openApp(page, { map: true, time: '07:00', init: GEO });
  await openMap(page);
  const btn = locateTool(sheet(page));
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAttribute('aria-label', 'Center on my location');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10));
  await btn.click();
  await tick(page, 50);
  expect((await view(page))[2]).toBeGreaterThan(600); // on its way in
  await tick(page, 300);
  expect(await dotIn(svg(page))).toEqual({ x: 0.5, y: 0.5, w: 400 });
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(btn).toHaveAttribute('aria-label', 'Zoom out to the area');
  await expect(sheet(page).getByRole('button', { name: 'Show the whole trip' })).toBeVisible();
  await btn.click();
  await tick(page, 300);
  expect(await dotIn(svg(page))).toEqual({ x: 0.5, y: 0.5, w: 2000 });
  await expect(btn).toHaveAttribute('aria-label', 'Zoom in to the street');
  await btn.click();
  await tick(page, 300);
  expect(await dotIn(svg(page))).toEqual({ x: 0.5, y: 0.5, w: 400 });
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
});

test('following: a new position recenters; a lost one keeps follow and the map still; under 2 px, no move', async ({ page }) => {
  await openApp(page, { map: true, time: '07:00', init: GEO });
  await openMap(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await locateTool(sheet(page)).click();
  await tick(page, 100);
  const first = await view(page);
  await move(page, 42.4758, -71.0900); // ~200 m north
  await tick(page, 50);
  expect(await dotIn(svg(page))).toEqual({ x: 0.5, y: 0.5, w: 400 });
  expect((await view(page))[1]).toBeLessThan(first[1] - 150);
  await page.evaluate(() => window.geo.lose());
  await tick(page, 50);
  await expect(svg(page).locator('.map-here')).toHaveCount(0);
  await expect(locateTool(sheet(page))).toHaveAttribute('aria-pressed', 'true');
  const held = await view(page);
  await tick(page, 1000);
  expect(await view(page)).toEqual(held);
  await move(page, 42.4740, -71.0900);
  await tick(page, 50);
  expect(await dotIn(svg(page))).toEqual({ x: 0.5, y: 0.5, w: 400 });
  const still = await view(page);
  await move(page, 42.474003, -71.0900); // ~0.3 m: under 2 px
  await tick(page, 50);
  expect(await view(page)).toEqual(still);
});

test('a drag ends following; the next tap starts again at street level', async ({ page }) => {
  await openApp(page, { map: true, time: '07:00', init: GEO });
  await openMap(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const btn = locateTool(sheet(page));
  await btn.click();
  await tick(page, 100);
  await btn.click(); // area
  await tick(page, 50);
  const box = await svg(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAttribute('aria-label', 'Center on my location');
  const dragged = await view(page);
  await move(page, 42.4758, -71.0900);
  await tick(page, 50);
  expect(await view(page)).toEqual(dragged);
  await btn.click();
  await tick(page, 100);
  expect(await dotIn(svg(page))).toEqual({ x: 0.5, y: 0.5, w: 400 });
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
});

test('a pinch keeps following at its zoom; the next tap goes to the farther level', async ({ page }) => {
  await openApp(page, { map: true, time: '07:00', init: GEO });
  await openMap(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const btn = locateTool(sheet(page));
  await btn.click();
  await tick(page, 100);
  await btn.click(); // area, 2 km
  await tick(page, 50);
  const box = await svg(page).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const cx = box.x + box.width / 2 - 50, cy = box.y + box.height / 2 + 40; // off you: the zoom stays about you
  await touch('touchStart', [{ x: cx - 20, y: cy, id: 1 }, { x: cx + 20, y: cy, id: 2 }]);
  for (let i = 1; i <= 4; i++) await touch('touchMove', [{ x: cx - 20 - i * 5, y: cy, id: 1 }, { x: cx + 20 + i * 5, y: cy, id: 2 }]);
  await touch('touchEnd', []);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  const pinched = await dotIn(svg(page));
  expect(pinched.x).toBe(0.5); expect(pinched.y).toBe(0.5);
  expect(pinched.w).toBeGreaterThan(900); expect(pinched.w).toBeLessThan(1100);
  await expect(btn).toHaveAttribute('aria-label', 'Zoom out to the area'); // under 1200 m
  await move(page, 42.4758, -71.0900);
  await tick(page, 50);
  expect(await dotIn(svg(page))).toEqual({ x: 0.5, y: 0.5, w: pinched.w });
  await btn.click();
  await tick(page, 50);
  expect(await dotIn(svg(page))).toEqual({ x: 0.5, y: 0.5, w: 2000 });
});

test('following ends when you leave the map, on back to the trip and on the whole map', async ({ page }) => {
  await serveBase(page, { base: REACH });
  await openApp(page, { map: true, time: '07:00', init: GEO });
  await openMap(page);
  await expect(svg(page).locator('.map-base')).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const btn = locateTool(sheet(page));
  await btn.click();
  await tick(page, 100);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await move(page, 40.71, -74.0); // New York
  await tick(page, 50);
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveAttribute('aria-label', 'Center on my location (outside the map)');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await move(page, 42.4740, -71.0900);
  await tick(page, 50);
  await expect(btn).toBeEnabled();
  await expect(btn).toHaveAttribute('aria-label', 'Center on my location');
  const back = await view(page);
  await move(page, 42.4758, -71.0900);
  await tick(page, 50);
  expect(await view(page)).toEqual(back);
  // Back to the trip, then the whole map.
  for (const name of ['Show the whole trip', 'Show the whole map']) {
    await btn.click();
    await tick(page, 100);
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await sheet(page).getByRole('button', { name }).click();
    await tick(page, 50);
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveAttribute('aria-label', 'Center on my location');
  }
});

test('no rows, locate follows you on the empty map too, and on into the sheet and back (2026-11-12)', async ({ page }) => {
  await openApp(page, { map: true, time: '07:00', scenario: { ...commute(), trips: [] }, init: GEO, waitForRows: false });
  const map = mainMap(page), pic = map.locator('svg.route-svg');
  await tick(page, 1500); // its height settled
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const btn = locateTool(map);
  await btn.click();
  await tick(page, 100);
  await expect(sheet(page)).toBeHidden(); // the button doesn't open the sheet
  expect(await dotIn(pic)).toEqual({ x: 0.5, y: 0.5, w: 400 });
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await btn.click();
  await tick(page, 50);
  expect(await dotIn(pic)).toEqual({ x: 0.5, y: 0.5, w: 2000 });
  await move(page, 42.4758, -71.0900);
  await tick(page, 50);
  expect(await dotIn(pic)).toEqual({ x: 0.5, y: 0.5, w: 2000 });
  // The sheet goes on following at the same level (until 2026-11-12 opening it ended follow).
  await pic.click();
  await tick(page, 300);
  await expect(sheet(page)).toBeVisible();
  const sbtn = locateTool(sheet(page));
  await expect(sbtn).toHaveAttribute('aria-pressed', 'true');
  await expect(sbtn).toHaveAttribute('aria-label', 'Zoom in to the street');
  expect(await dotIn(svg(page))).toEqual({ x: 0.5, y: 0.5, w: 2000 });
  await move(page, 42.4776, -71.0900);
  await tick(page, 50);
  expect(await dotIn(svg(page))).toEqual({ x: 0.5, y: 0.5, w: 2000 });
  // Back on the main map, still following.
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  await tick(page, 100);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  expect(await dotIn(pic)).toEqual({ x: 0.5, y: 0.5, w: 2000 });
  // A drag in the sheet ends it; the main map gets the moved view.
  await pic.click();
  await tick(page, 300);
  const box = await svg(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(box.x + box.width / 2 + i * 10, box.y + box.height / 2);
  await page.mouse.up();
  await expect(sbtn).toHaveAttribute('aria-pressed', 'false');
  const moved = await dotIn(svg(page));
  expect(moved.x).toBeGreaterThan(0.55);
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  await tick(page, 100);
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAttribute('aria-label', 'Center on my location');
  const back = await dotIn(pic);
  expect(back.w).toBeCloseTo(2000, -1);
  expect(back.x).toBeGreaterThan(0.55);
  await expect(map.locator('.map-fit')).toBeVisible();
});

// ---------- incoming trains and a leg's other routes (2026-11-12) ----------
// The Orange Line's recorded pattern toward Oak Grove (Office to home boards at State).
const OL = JSON.parse(readFileSync(new URL('./fixtures/patterns-Orange-1.json', import.meta.url), 'utf8'));
const olStop = id => OL.included.find(x => x.type === 'stop' && x.id === id);
const olStops = OL.included.find(x => x.type === 'trip' && x.id === OL.data[0].relationships.representative_trip.data.id).relationships.stops.data.map(s => s.id);
const olAt = (id, trip, name) => {
  const s = olStops.map(olStop).find(x => x.attributes.name === name).attributes;
  return { id, trip, route: 'Orange', direction: 1, lat: s.latitude, lon: s.longitude };
};

test('a rail leg: trains still coming toward your station, its other stations faded, no line; yours outlined', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [olAt('coming', 'OLout-0659', 'Back Bay'), olAt('on', 'OLout-0641', 'Sullivan Square')] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  await page.locator('#toggle select').selectOption({ label: 'Office to home' });
  await tick(page, 1000);
  await openMap(page);
  await expect(svg(page).locator('.map-vehicle')).toHaveCount(2);
  await expect(svg(page).locator('.map-vehicle text')).toHaveText(['OL', 'OL']);
  // No line before State or after Oak Grove: only the bus leg's faded ends.
  expect(await svg(page).locator('polyline.map-leg.off').evaluateAll(ls => ls.map(l => l.dataset.color))).toEqual(['FFC72C', 'FFC72C']);
  // The stations before State, faded and named on a tap.
  const bb = svg(page).locator('.map-stop.off[aria-label="Back Bay"]');
  await expect(bb).toHaveCount(1);
  await expect(svg(page).locator('.map-stop.off[aria-label="Forest Hills"]')).toHaveCount(1);
  await bb.dispatchEvent('click');
  await expect(page.locator('#map-caption')).toHaveText('Back Bay');
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  // Bell the ride whose train is still coming: outlined as yours.
  const first = page.locator('.row').first();
  await first.click();
  await first.getByRole('button', { name: 'Track', exact: true }).click();
  await tick(page, 1000);
  const trip = await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:en-route')).office.target.legs[0].tripId);
  scenario.vehicles[0].trip = trip;
  await openMap(page);
  await expect(svg(page).locator('.map-vehicle.mine')).toHaveAttribute('data-vehicle', 'coming');
});

const GREEN_LABELS = { 'Green-B': 'Green B', 'Green-C': 'Green C', 'Green-D': 'Green D' };
const GREEN = { trips: [{ id: 'green', name: 'Downtown', legs: [
  { kind: 'walk', minutes: 5 },
  { kind: 'transit', route: 'Green-B', also: ['Green-C', 'Green-D'], direction_id: 1, stop: 'place-kencl', alight: 'place-pktrm', label: 'Green', color: '00843D', routeLabels: GREEN_LABELS },
  { kind: 'walk', minutes: 5 },
] }] };
const greenAt = (id, route, name) => {
  const doc = JSON.parse(readFileSync(new URL(`./fixtures/patterns-${route}-1.json`, import.meta.url), 'utf8'));
  const s = doc.included.find(x => x.type === 'stop' && x.attributes.name === name).attributes;
  return { id, trip: `${id}-trip`, route, direction: 1, lat: s.latitude, lon: s.longitude };
};

test('a leg\'s other routes: each branch\'s trains on its own line, labeled by letter; their shapes kept on the phone', async ({ page }) => {
  const stops = [['place-kencl', 0], ['place-pktrm', 10]];
  const scenario = { alerts: [], trips: [
    ...series({ prefix: 'GB', route: 'Green-B', direction: 1, first: '06:05', every: 10, count: 20, stops }),
    ...series({ prefix: 'GC', route: 'Green-C', direction: 1, first: '06:00', every: 10, count: 20, stops }),
  ], vehicles: [greenAt('c', 'Green-C', 'Saint Mary\'s Street'), greenAt('b', 'Green-B', 'Boston University East')] };
  const mbta = await openApp(page, { map: true, time: '06:40', config: GREEN, scenario, init: DENIED });
  await tick(page, 1000);
  const base = vehicleHits(mbta).length;
  await openMap(page);
  await expect(svg(page).locator('.map-vehicle')).toHaveCount(2);
  expect(await svg(page).locator('.map-vehicle').evaluateAll(gs => gs.map(g => [g.dataset.vehicle, g.querySelector('text').textContent]).sort())).toEqual([['b', 'B'], ['c', 'C']]);
  // The C branch's stations before Kenmore, faded; Kenmore itself once.
  await expect(svg(page).locator('.map-stop.off[aria-label="Saint Mary\'s Street"]')).toHaveCount(1);
  await expect(svg(page).locator('.map-stop[aria-label="Kenmore"]')).toHaveCount(1);
  await expect(svg(page).locator('polyline.map-leg.off')).toHaveCount(0);
  // One /vehicles request per leg and poll, as before.
  expect(vehicleHits(mbta).length).toBe(base + 1);
  await tick(page, 10_000);
  expect(vehicleHits(mbta).length).toBe(base + 2);
  // One shapes request per route and direction, kept across a reload.
  const routesAsked = () => shapeHits(mbta).map(h => h.query.get('filter[route]')).sort();
  expect(routesAsked()).toEqual(['Green-B', 'Green-C', 'Green-D']);
  await page.reload();
  await tick(page, 1000);
  await openMap(page);
  await expect(svg(page).locator('.map-vehicle')).toHaveCount(2);
  expect(routesAsked()).toEqual(['Green-B', 'Green-C', 'Green-D']);
});

// ---------- the two fits and the shared view (2026-11-12) ----------
// Far from the trip (Framingham, inside commuter rail's reach) and within its fit (Malden).
const FAR = { latitude: 42.2793, longitude: -71.4162 };
const WITHIN = { latitude: 42.43, longitude: -71.075 };
const dotShown = async s => { const d = await dotIn(s); return !!d && d.x >= 0 && d.x <= 1 && d.y >= 0 && d.y <= 1; };
const fitTool = loc => loc.locator('.map-fit');
async function granted(page, context, at) {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(at);
  await openApp(page, { map: true, time: '07:00' });
  await tick(page, 1500); // the main map's height settled, the base map in
}

test('far from the trip: the first view is the trip alone; the fit button switches to the trip and you, and back', async ({ page, context }) => {
  await granted(page, context, FAR);
  const map = mainMap(page), pic = map.locator('svg.route-svg'), fit = fitTool(map);
  await expect(fit).toBeVisible();
  await expect(fit).toHaveAttribute('aria-label', 'Show the trip and my location');
  await expect(fit.locator('circle')).toHaveCount(3); // the route's ends and you
  await expect.poll(() => dotShown(pic)).toBe(false);
  const first = await pic.getAttribute('viewBox');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10));
  await fit.click();
  await tick(page, 300);
  await expect(sheet(page)).toBeHidden(); // the button doesn't open the sheet
  expect(await dotShown(pic)).toBe(true);
  await expect(fit).toHaveAttribute('aria-label', 'Show the whole trip');
  await expect(fit.locator('circle')).toHaveCount(2);
  await fit.click();
  await tick(page, 300);
  expect(await pic.getAttribute('viewBox')).toBe(first);
  await expect(fit).toHaveAttribute('aria-label', 'Show the trip and my location');
});

test('within the trip\'s fit: you in the first view, the fit button only once the view moves', async ({ page, context }) => {
  await granted(page, context, WITHIN);
  const map = mainMap(page), pic = map.locator('svg.route-svg');
  await expect.poll(() => dotShown(pic)).toBe(true);
  await expect(fitTool(map)).toBeHidden();
  await openMap(page);
  await expect.poll(() => dotShown(svg(page))).toBe(true);
  await expect(fitTool(sheet(page))).toBeHidden();
  await zoomOut(page, 3);
  await expect(fitTool(sheet(page))).toBeVisible();
  await expect(fitTool(sheet(page))).toHaveAttribute('aria-label', 'Show the whole trip');
  await fitTool(sheet(page)).click();
  await tick(page, 400);
  await expect(fitTool(sheet(page))).toBeHidden();
});

test('one view for both maps: the sheet opens at the main map\'s fit, and a pan there comes back to the main map', async ({ page, context }) => {
  await granted(page, context, FAR);
  const map = mainMap(page), pic = map.locator('svg.route-svg');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fitTool(map).click(); // trip + me
  await tick(page, 100);
  await openMap(page);
  await expect.poll(() => dotShown(svg(page))).toBe(true);
  await expect(fitTool(sheet(page))).toHaveAttribute('aria-label', 'Show the whole trip');
  await fitTool(sheet(page)).click(); // the trip alone
  await tick(page, 100);
  expect(await dotShown(svg(page))).toBe(false);
  const box = await svg(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width / 2 + i * 10, box.y + box.height / 2 + i * 5);
  await page.mouse.up();
  const scaleOf = async s => s.evaluate(el => {
    const [x, y, w, h] = el.getAttribute('viewBox').split(' ').map(Number);
    return { cx: x + w / 2, cy: y + h / 2, mpp: w / el.getBoundingClientRect().width };
  });
  const there = await scaleOf(svg(page));
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  await tick(page, 100);
  // The same center and scale (both maps' origin is the first boarding stop).
  const here = await scaleOf(pic);
  expect(here.cx).toBeCloseTo(there.cx, -1);
  expect(here.cy).toBeCloseTo(there.cy, -1);
  expect(here.mpp).toBeCloseTo(there.mpp, 3);
  // Moved: the fit button goes to the first view (the trip alone, you far away).
  await expect(fitTool(map)).toHaveAttribute('aria-label', 'Show the whole trip');
  await fitTool(map).click();
  await tick(page, 100);
  await expect(fitTool(map)).toHaveAttribute('aria-label', 'Show the trip and my location');
  expect(await dotShown(pic)).toBe(false);
});

test('Hide map / Show map keeps the chosen fit', async ({ page, context }) => {
  await granted(page, context, FAR);
  const map = mainMap(page), pic = map.locator('svg.route-svg');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fitTool(map).click();
  await tick(page, 100);
  expect(await dotShown(pic)).toBe(true);
  await map.getByRole('button', { name: 'Hide map' }).click();
  await page.getByRole('button', { name: 'Show map ▾' }).click();
  await tick(page, 500);
  await expect.poll(() => dotShown(pic)).toBe(true);
  await expect(fitTool(map)).toHaveAttribute('aria-label', 'Show the whole trip');
// The ridden vehicle at your GPS position (2026-11-12): a fix that counts puts your bus on its
// line in a blue ring, without the dot; without one it holds until the MBTA position passes it
// or 60 s go by. A stub granted up front (the watch starts with the map), its accuracy set.
const RIDE_GEO = () => {
  let cur = { latitude: 42.4740, longitude: -71.0900, accuracy: 10 }, ok = null;
  const pos = () => ({ coords: { ...cur }, timestamp: Date.now() });
  navigator.geolocation.getCurrentPosition = o => setTimeout(() => o(pos()), 0);
  navigator.geolocation.watchPosition = o => { ok = o; return 1; };
  navigator.geolocation.clearWatch = () => {};
  window.geo = { move: (latitude, longitude, accuracy = 10) => { cur = { latitude, longitude, accuracy }; ok?.(pos()); } };
};
const geoAt = (page, k, accuracy = 10) => {
  const s = busStop(busStops[k]);
  return page.evaluate(([a, b, c]) => window.geo.move(a, b, c), [s.latitude, s.longitude, accuracy]);
};
// Your vehicle on a map: { gps, x, y } or null; the dot's count.
const myVehicle = loc => loc.locator('svg.route-svg').evaluate(s => {
  const g = s.querySelector('.map-vehicle.mine');
  return g ? { gps: g.classList.contains('gps'), x: Math.round(+g.dataset.x), y: Math.round(+g.dataset.y), halo: !!g.querySelector('.halo'), stroke: getComputedStyle(g.querySelector('path')).stroke } : null;
});
const stopXY = (loc, k) => loc.locator('svg.route-svg').evaluate((s, id) => {
  const g = s.querySelector(`.map-stop[data-stop="${id}"]`);
  return g ? { x: Math.round(+g.dataset.x), y: Math.round(+g.dataset.y) } : null;
}, busStops[k]);

async function rideWithGps(page, context, vehicles) {
  await context.grantPermissions(['geolocation']);
  const scenario = { ...commute(), vehicles: [] };
  const mbta = await openApp(page, { map: true, time: '07:00', scenario, init: RIDE_GEO });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:08:30');
  await expect(page.locator('.ride-head')).toBeVisible();
  const tripId = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('t-minus:en-route')))[0].ride.legs[0].tripId);
  expect(tripId).toBe('132in-0708');
  scenario.vehicles = vehicles(tripId);
  await tick(page, 20_000); // the vehicle poll and the ride's stops
  return { mbta, scenario, tripId };
}

test('riding: your bus at your GPS position in a blue ring, without the dot, on the main map and the sheet', async ({ page, context }) => {
  await rideWithGps(page, context, t => [vehicleAt('mine', t, 12)]);
  const map = mainMap(page);
  await expect.poll(() => myVehicle(map)).toMatchObject({ gps: false });
  await geoAt(page, 14);
  await expect.poll(() => myVehicle(map)).toEqual(expect.objectContaining({ gps: true, halo: true, stroke: 'rgb(26, 115, 232)' }));
  await expect(map.locator('.map-here')).toHaveCount(0);
  await openMap(page);
  // Held from the main map until the sheet's own watch has a fix.
  await tick(page, 500);
  await expect.poll(() => myVehicle(sheet(page)).then(v => v?.gps)).toBe(true);
  await geoAt(page, 14);
  await tick(page, 50);
  const at = await myVehicle(sheet(page));
  expect(at.gps).toBe(true);
  await expect(sheet(page).locator('.map-here')).toHaveCount(0);
  const stop = await stopXY(sheet(page), 14);
  expect(Math.hypot(at.x - stop.x, at.y - stop.y)).toBeLessThan(20);
});

test('riding: without a counted fix the GPS point holds until the MBTA position passes it, or 60 s', async ({ page, context }) => {
  const { scenario, tripId } = await rideWithGps(page, context, t => [vehicleAt('mine', t, 12)]);
  const map = mainMap(page);
  await geoAt(page, 14);
  await expect.poll(() => myVehicle(map).then(v => v?.gps)).toBe(true);
  const held = await myVehicle(map);
  await geoAt(page, 15, 80); // too coarse to count
  await tick(page, 50);
  expect(await myVehicle(map)).toEqual(held);
  await expect(map.locator('.map-here')).toHaveCount(0);
  // The MBTA position passes the held point: back to it, with the dot.
  scenario.vehicles = [vehicleAt('mine', tripId, 18)];
  await tick(page, 10_000);
  await expect.poll(() => myVehicle(map).then(v => v?.gps)).toBe(false);
  expect((await myVehicle(map)).y).not.toBe(held.y);
  await expect(map.locator('.map-here')).toHaveCount(1);
  // 60 s: counted again ahead of the vehicle, then a coarse fix; held, then released.
  await geoAt(page, 20);
  await expect.poll(() => myVehicle(map).then(v => v?.gps)).toBe(true);
  await geoAt(page, 20, 80);
  await tick(page, 30_000);
  expect((await myVehicle(map)).gps).toBe(true);
  await tick(page, 31_000);
  await expect.poll(() => myVehicle(map).then(v => v?.gps)).toBe(false);
  await expect(map.locator('.map-here')).toHaveCount(1);
});

test('riding: the ride\'s vehicle not in /vehicles: no marker of yours, the dot shows', async ({ page, context }) => {
  await rideWithGps(page, context, () => [vehicleAt('other', '132in-0612', 15)]);
  const map = mainMap(page);
  await geoAt(page, 14);
  await tick(page, 50);
  await expect(map.locator('.map-vehicle.mine')).toHaveCount(0);
  await expect(map.locator('.map-vehicle.gps')).toHaveCount(0);
  await expect(map.locator('.map-here')).toHaveCount(1);
});

test('before boarding (belled or waiting), a fix by your bus leaves it at its MBTA position', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  const scenario = { ...commute(), vehicles: [vehicleAt('mine', '132in-0708', 6)] };
  await openApp(page, { map: true, time: '07:00', scenario, init: RIDE_GEO });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 10_000);
  await geoAt(page, 6);
  await tick(page, 50);
  await expect(mainMap(page).locator('.map-vehicle.gps')).toHaveCount(0);
  await expect(mainMap(page).locator('.map-here')).toHaveCount(1);
});
