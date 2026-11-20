// Follow your vehicle (DESIGN.md "Route map" › "Follow your vehicle", 2026-11-19): while riding, the
// app's locate button is the vehicle's glyph and keeps the map on the ridden vehicle. The first tap
// asks (use the location, or just follow the MBTA's position) until answered once.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, tick, tickTo, commute } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const BUS = JSON.parse(readFileSync(new URL('./fixtures/patterns-132-1.json', import.meta.url), 'utf8'));
const busStop = id => BUS.included.find(x => x.type === 'stop' && x.id === id).attributes;
const busStops = BUS.included.find(x => x.type === 'trip').relationships.stops.data.map(s => s.id);
const vehicleAt = (id, trip, k) => ({ id, trip, route: '132', direction: 1, lat: busStop(busStops[k]).latitude, lon: busStop(busStops[k]).longitude });
const OL = JSON.parse(readFileSync(new URL('./fixtures/patterns-Orange-1.json', import.meta.url), 'utf8'));
const olStops = OL.included.find(x => x.type === 'trip' && x.id === OL.data[0].relationships.representative_trip.data.id).relationships.stops.data.map(s => s.id);
const olAt = (id, trip, name) => {
  const s = olStops.map(i => OL.included.find(x => x.type === 'stop' && x.id === i)).find(x => x.attributes.name === name).attributes;
  return { id, trip, route: 'Orange', direction: 1, lat: s.latitude, lon: s.longitude };
};

const mainMap = page => page.locator('#rows .main-map-item');
const sheet = page => page.getByRole('dialog', { name: 'Home to office' });
const locate = loc => loc.locator('.map-locate');
const ask = page => page.locator('#follow-ask');
// A stub for the location: `perm` is what the Permissions API says (null: leave it), the calls are
// counted (window.geoCalls: getCurrentPosition, window.watches: watchPosition), and window.geo.move
// sends a fix to the watch.
async function stubLocation(page, perm) {
  await page.addInitScript(({ perm }) => {
    let cur = { latitude: 42.4740, longitude: -71.0900, accuracy: 10 }, ok = null;
    const pos = () => ({ coords: { ...cur }, timestamp: Date.now() });
    const no = err => setTimeout(() => err?.({ code: 1, PERMISSION_DENIED: 1, message: 'denied' }), 0);
    window.geoCalls = 0; window.watches = 0;
    navigator.geolocation.getCurrentPosition = (o, e) => { window.geoCalls++; if (perm === 'denied') no(e); else setTimeout(() => o(pos()), 0); };
    navigator.geolocation.watchPosition = (o, e) => { window.watches++; ok = o; if (perm === 'denied') no(e); return 1; };
    navigator.geolocation.clearWatch = () => {};
    window.geo = { move: (latitude, longitude, accuracy = 10) => { cur = { latitude, longitude, accuracy }; ok?.(pos()); } };
    if (perm) navigator.permissions.query = async () => ({ state: perm, onchange: null });
  }, { perm });
}
const geoAt = (page, k, accuracy = 10) => {
  const s = busStop(busStops[k]);
  return page.evaluate(([a, b, c]) => window.geo.move(a, b, c), [s.latitude, s.longitude, accuracy]);
};
// A map's view width and how far its center is from the vehicle that is yours, as fractions of the width.
const onVehicle = (loc, sel = '.map-vehicle.mine') => loc.locator('svg.route-svg').evaluate((s, sel) => {
  const [x, y, w, h] = s.getAttribute('viewBox').split(' ').map(Number);
  const g = s.querySelector(sel);
  return { width: Math.round(w), dx: g ? Math.abs(+g.dataset.x - (x + w / 2)) / w : null, dy: g ? Math.abs(+g.dataset.y - (y + h / 2)) / w : null };
}, sel);
const centered = async (loc, width, sel) => {
  await expect.poll(async () => { const v = await onVehicle(loc, sel); return v.width === width && v.dx != null && v.dx < 0.02 && v.dy < 0.02; }).toBe(true);
};
const viewBox = loc => loc.locator('svg.route-svg').getAttribute('viewBox');

// At the stop, then riding bus 132 (7:08:30); `vehicles(tripId)` is listed once the ride's trip is known.
async function ride(page, { perm = 'prompt', vehicles = t => [vehicleAt('mine', t, 12)], extra = {}, start = true } = {}) {
  await stubLocation(page, perm);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const scenario = { ...commute(), vehicles: [], ...extra };
  const mbta = await openApp(page, { map: true, time: '07:00', scenario });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  if (!start) return { mbta, scenario };
  await tickTo(page, '07:08:30');
  await expect(page.locator('.ride-head')).toBeVisible();
  const tripId = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('t-minus:en-route')))[0].ride.legs[0].tripId);
  scenario.vehicles = vehicles(tripId);
  await tick(page, 20_000);
  return { mbta, scenario, tripId };
}

test('never asked: the glyph asks first; "Just follow Bus 132" follows the MBTA position with no location call and is remembered', async ({ page }) => {
  await ride(page);
  const map = mainMap(page), btn = locate(map);
  await expect(btn).toHaveAttribute('aria-label', 'Follow Bus 132');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn.locator('svg.veh-glyph')).toHaveCount(1);
  await btn.click();
  await expect(ask(page)).toBeVisible();
  await expect(ask(page).getByRole('heading')).toHaveText('Follow Bus 132');
  await expect(ask(page)).toContainText('With your location, the map places the bus where you are.');
  await expect(ask(page).getByRole('button', { name: 'Use my location' })).toBeVisible();
  // Cancel answers nothing: the next tap asks again.
  await ask(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(ask(page)).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('t-minus:follow-vehicle'))).toBeNull();
  await btn.click();
  await expect(ask(page)).toBeVisible();
  await page.keyboard.press('Escape'); // closes the question, not a map
  await expect(ask(page)).toBeHidden();
  await btn.click();
  await ask(page).getByRole('button', { name: 'Just follow Bus 132' }).click();
  await expect(ask(page)).toBeHidden();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(btn).toHaveAttribute('aria-label', 'Zoom out to the area');
  await centered(map, 400);
  expect(await page.evaluate(() => [window.geoCalls, window.watches])).toEqual([0, 0]);
  expect(await page.evaluate(() => localStorage.getItem('t-minus:follow-vehicle'))).toBe('true');
  // A drag ends it; the next tap follows without the question.
  const box = await map.locator('svg.route-svg').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAttribute('aria-label', 'Follow Bus 132');
  await btn.click();
  await expect(ask(page)).toBeHidden();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await centered(map, 400);
  // The levels toggle.
  await btn.click();
  await centered(map, 2000);
  await expect(btn).toHaveAttribute('aria-label', 'Zoom in to the street');
});

test('"Use my location": the prompt, then the ridden vehicle at your fix when it counts', async ({ page }) => {
  await ride(page);
  const map = mainMap(page), btn = locate(map);
  await btn.click();
  await ask(page).getByRole('button', { name: 'Use my location' }).click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.geoCalls)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('t-minus:follow-vehicle'))).toBeNull(); // the OS remembers
  await expect.poll(() => page.evaluate(() => window.watches)).toBe(1);
  await geoAt(page, 14);
  await expect(map.locator('.map-vehicle.mine.gps')).toHaveCount(1);
  await centered(map, 400, '.map-vehicle.mine.gps');
  await expect(btn).toHaveAttribute('aria-label', 'Zoom out to the area');
});

test('location denied: a tap follows the vehicle with no question and no location call', async ({ page }) => {
  await ride(page, { perm: 'denied' });
  const map = mainMap(page), btn = locate(map);
  await expect(btn).toHaveAttribute('aria-label', 'Follow Bus 132');
  await btn.click();
  await expect(ask(page)).toBeHidden();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await centered(map, 400);
  expect(await page.evaluate(() => [window.geoCalls, window.watches])).toEqual([0, 0]);
});

test('location granted: no question; follows your fix when it counts, else the MBTA position', async ({ page }) => {
  await ride(page, { perm: 'granted' });
  const map = mainMap(page), btn = locate(map);
  await geoAt(page, 15, 80); // too coarse to count
  await tick(page, 50);
  await btn.click();
  await expect(ask(page)).toBeHidden();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(map.locator('.map-vehicle.mine')).toHaveCount(1);
  await expect(map.locator('.map-vehicle.gps')).toHaveCount(0);
  await centered(map, 400);
  await geoAt(page, 14);
  await expect(map.locator('.map-vehicle.mine.gps')).toHaveCount(1);
  await centered(map, 400, '.map-vehicle.mine.gps');
});

test('boarding while following you: the follow goes on to the vehicle at 400 m; alighting ends it', async ({ page }) => {
  test.setTimeout(300_000); // 15 min of clock with the map redrawing
  const { scenario } = await ride(page, { perm: 'granted', start: false });
  const map = mainMap(page), btn = locate(map);
  await geoAt(page, 8);
  await tick(page, 50);
  await expect(btn).toHaveAttribute('aria-label', 'Center on my location');
  await expect(btn.locator('svg.veh-glyph')).toHaveCount(0);
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(map.locator('.map-here')).toHaveCount(1);
  await tickTo(page, '07:08:30');
  const tripId = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('t-minus:en-route')))[0].ride.legs[0].tripId);
  scenario.vehicles = [vehicleAt('mine', tripId, 12)];
  await tick(page, 20_000);
  await expect(btn.locator('svg.veh-glyph')).toHaveCount(1);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(btn).toHaveAttribute('aria-label', /^Zoom (out to the area|in to the street)$/);
  await centered(map, 400);
  // The sheet carries it over, and back.
  await map.getByRole('button', { name: 'Open the full map' }).click();
  await tick(page, 300);
  await expect(sheet(page)).toBeVisible();
  await expect(locate(sheet(page))).toHaveAttribute('aria-pressed', 'true');
  await expect(locate(sheet(page)).locator('svg.veh-glyph')).toHaveCount(1);
  await centered(sheet(page), 400);
  await sheet(page).getByRole('button', { name: 'Close the full map' }).click();
  await tick(page, 300);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await centered(map, 400);
  // Lost position: follow stays on and the map holds.
  const held = await viewBox(map);
  scenario.vehicles = [];
  await tick(page, 10_000);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  expect(await viewBox(map)).toBe(held);
  // Alighting (7:22): back to the arrow, the fit, follow off.
  scenario.vehicles = [vehicleAt('mine', tripId, 20)];
  await tickTo(page, '07:23');
  await tick(page, 10_000);
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAttribute('aria-label', 'Center on my location');
  await expect(btn.locator('svg.veh-glyph')).toHaveCount(0);
  expect((await onVehicle(map)).width).not.toBe(400); // the view is back at the fit
});

test('a ride on the Orange Line: the train glyph, "Follow the Orange Line", first tap at 2 km', async ({ page }) => {
  test.setTimeout(120_000);
  await stubLocation(page, 'denied');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const scenario = { ...commute(), vehicles: [] };
  await openApp(page, { map: true, time: '07:00', scenario });
  await page.locator('#toggle select').selectOption({ label: 'Office to home' });
  await tick(page, 1000);
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:17:30');
  await expect(page.locator('.ride-head')).toBeVisible();
  const tripId = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('t-minus:en-route'))).find(s => s.ride).ride.legs[0].tripId);
  scenario.vehicles = [olAt('mine', tripId, 'State')];
  await tick(page, 20_000);
  const map = mainMap(page), btn = locate(map);
  await expect(btn).toHaveAttribute('aria-label', 'Follow the Orange Line');
  await expect(btn.locator('svg.veh-glyph .body')).toHaveAttribute('rx', '4');
  await btn.click();
  await expect(ask(page)).toBeHidden(); // denied
  await centered(map, 2000);
  await expect(btn).toHaveAttribute('aria-label', 'Zoom in to the street');
});
