// The vehicles' glide on the route map (DESIGN.md "Live while open", 2026-11-21): between two
// answers a vehicle is drawn eased along its route from where it was drawn to the new point, over
// 2 s (`vehicleGlide`); a first drawing, a backward move, a step over 1 km, a changed route shape,
// a new leg or trip and Reduce Motion put it at the answer at once, and an answer identical to the
// last one never restarts the glide. The ride marker's fix and the MBTA's position are one vehicle
// (a forward switch between them glides), and following it the camera moves with where it is drawn,
// easing over without a jump. Clock times are the page's (helpers.js).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, tick, tickTo, pauseClock, commute } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const BUS = JSON.parse(readFileSync(new URL('./fixtures/patterns-132-1.json', import.meta.url), 'utf8'));
const busStop = id => BUS.included.find(x => x.type === 'stop' && x.id === id).attributes;
const busStops = BUS.included.find(x => x.type === 'trip').relationships.stops.data.map(s => s.id);
// A bus on the 132's recorded pattern: stop 6 is 2.5 km along it, 8 is 3.3 km, 9 is 4.3 km.
// `trip` names it as the ride's own (the belled trip) where the marker must be yours.
const vehicleAt = (id, k, trip = '132in-0640') => ({ id, trip, route: '132', direction: 1, lat: busStop(busStops[k]).latitude, lon: busStop(busStops[k]).longitude });
const DENIED = () => {
  const no = err => setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, message: 'denied' }), 0);
  navigator.geolocation.watchPosition = (ok, err) => { no(err); return 1; };
  navigator.geolocation.getCurrentPosition = (ok, err) => no(err);
  navigator.geolocation.clearWatch = () => {};
};
const map = page => page.locator('#rows .main-map-item');
const vehicle = page => map(page).locator('.map-vehicle').first();
// A granted location with a watch the spec drives: `window.geo.move` sends a fix to it.
async function stubLocation(page) {
  await page.addInitScript(() => {
    let cur = { latitude: 42.4740, longitude: -71.0900, accuracy: 10 }, ok = null;
    const pos = () => ({ coords: { ...cur }, timestamp: Date.now() });
    navigator.geolocation.getCurrentPosition = o => setTimeout(() => o(pos()), 0);
    navigator.geolocation.watchPosition = o => { ok = o; return 1; };
    navigator.geolocation.clearWatch = () => {};
    navigator.permissions.query = async () => ({ state: 'granted', onchange: null });
    window.geo = { move: (latitude, longitude, accuracy = 10) => { cur = { latitude, longitude, accuracy }; ok?.(pos()); } };
  });
}
const geoAt = (page, k) => page.evaluate(([a, b]) => window.geo.move(a, b), [busStop(busStops[k]).latitude, busStop(busStops[k]).longitude]);
// The answer (dataset.x/y), the point drawn now (sx/sy, null at the answer), and the drawn
// translate (the mark's own transform, in meters).
const mark = loc => loc.evaluate(g => {
  const [tx, ty] = g.getAttribute('transform').match(/translate\(([-\d.e]+) ([-\d.e]+)\)/).slice(1).map(Number);
  return { x: +g.dataset.x, y: +g.dataset.y, sx: g.dataset.sx == null ? null : +g.dataset.sx, sy: g.dataset.sy == null ? null : +g.dataset.sy, tx, ty };
});
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Runs the page clock on until the vehicle's answer (its x/y) changes: the next poll's drawing.
async function nextAnswer(page, loc) {
  const before = await mark(loc);
  for (let i = 0; i < 100; i++) {
    const now = await mark(loc);
    if (now.x !== before.x || now.y !== before.y) return { before, at: now };
    await page.clock.runFor(150);
    await page.waitForTimeout(10);
  }
  throw new Error('no new answer for the vehicle in 15 s');
}

test('a vehicle glides along its route from where it was drawn to the new answer, and is there 2 s on', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('v1', 6)] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  const v = vehicle(page);
  await expect(v).toHaveCount(1);
  const first = await mark(v);
  expect(first.sx).toBeNull(); // the first drawing snaps: nothing was drawn before
  scenario.vehicles = [vehicleAt('v1', 8)]; // ~816 m on along the route
  const { before, at } = await nextAnswer(page, v);
  expect(gap(at, before)).toBeGreaterThan(50); // the answer moved
  expect(at.sx).not.toBeNull(); // drawn on its way, not stepped there
  expect(gap({ x: at.sx, y: at.sy }, before)).toBeLessThan(gap(before, at) * 0.5); // near where it was
  expect(gap({ x: at.sx, y: at.sy }, at)).toBeGreaterThan(1); // and not there yet
  // Still on its way after another second (the glide is 2 s), easing out: further than it was.
  const was = gap({ x: at.sx, y: at.sy }, before);
  await tick(page, 900);
  const mid = await mark(v);
  expect(mid.sx).not.toBeNull();
  expect(gap({ x: mid.sx, y: mid.sy }, before)).toBeGreaterThan(was);
  await tick(page, 1400);
  const done = await mark(v);
  expect(done.sx).toBeNull(); // arrived: drawn at the answer from here on
  expect([done.tx, done.ty]).toEqual([done.x, done.y]);
});

test('a backward move and a step over 1 km snap; an identical answer starts no glide (2026-11-21)', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('v1', 8)] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  const v = vehicle(page);
  await expect(v).toHaveCount(1);
  // Backwards (3.3 km back to 2.5 km): at the answer at once.
  scenario.vehicles = [vehicleAt('v1', 6)];
  const back = (await nextAnswer(page, v)).at;
  expect(back.sx).toBeNull();
  expect([back.tx, back.ty]).toEqual([back.x, back.y]);
  // The same answer again, a poll later: still no glide (nothing to move to).
  await tick(page, 10_000);
  const same = await mark(v);
  expect(same.sx).toBeNull();
  expect([same.tx, same.ty]).toEqual([back.tx, back.ty]);
  // Forward 1.8 km (past VEHICLE_GLIDE_MAX_METERS): at the answer at once.
  scenario.vehicles = [vehicleAt('v1', 9)];
  const far = (await nextAnswer(page, v)).at;
  expect(far.sx).toBeNull();
  expect([far.tx, far.ty]).toEqual([far.x, far.y]);
});

test('Reduce Motion: a new answer is drawn at once (2026-11-21)', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('v1', 6)] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  const v = vehicle(page);
  await expect(v).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  scenario.vehicles = [vehicleAt('v1', 8)];
  const at = (await nextAnswer(page, v)).at;
  expect(at.sx).toBeNull();
  expect([at.tx, at.ty]).toEqual([at.x, at.y]);
});

test('a redrawing answer leaves the running glide alone: no restart at each drawing', async ({ page }) => {
  // Each location fix redraws the main map with the same vehicles: their answers are identical,
  // so the glide keeps its clock and the bus arrives 2 s after the answer, not 2 s after the last
  // drawing (which here would leave it still gliding well past 2 s).
  await stubLocation(page);
  const scenario = { ...commute(), vehicles: [vehicleAt('v1', 6)] };
  await openApp(page, { map: true, time: '07:00', scenario });
  const v = vehicle(page);
  await expect(v).toHaveCount(1);
  await page.evaluate(() => window.geo.move(42.4740, -71.0900)); // the first fix: the map has a dot
  await expect(map(page).locator('.map-here')).toHaveCount(1);
  scenario.vehicles = [vehicleAt('v1', 8)];
  const { at } = await nextAnswer(page, v);
  expect(at.sx).not.toBeNull();
  // Four fixes, each drawing the map again with the same bus answer.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(k => window.geo.move(42.4740 + k * 0.0001, -71.0900), i + 1);
    await page.clock.runFor(350);
  }
  const mid = await mark(v);
  expect(mid.sx).not.toBeNull(); // ~1.4 s in: still on its way
  await page.clock.runFor(800); // past 2 s after the answer: there, were the clock not restarted
  const done = await mark(v);
  expect(done.sx).toBeNull();
  expect([done.tx, done.ty]).toEqual([done.x, done.y]);
});

test('the ridden vehicle at the phone\'s fix glides too, and the follow moves with where it is drawn', async ({ page }) => {
  await stubLocation(page);
  const scenario = { ...commute(), vehicles: [] };
  await openApp(page, { map: true, time: '07:00', scenario });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:08:30');
  await expect(page.locator('.ride-head')).toBeVisible();
  const tripId = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('t-minus:en-route')))[0].ride.legs[0].tripId);
  scenario.vehicles = [vehicleAt('mine', 12, tripId)];
  await tick(page, 20_000);
  // Follow the vehicle (a granted location: no question), at the bus's 400 m.
  await map(page).getByRole('button', { name: 'Follow Bus 132' }).click();
  await tick(page, 300);
  await geoAt(page, 14); // at your fix: the marker is yours (gps), snapped onto the line
  await expect(map(page).locator('.map-vehicle.mine.gps')).toHaveCount(1);
  // Far enough in that the fix counts, the here-and-there of it is centered.
  const onDrawn = loc => loc.locator('svg.route-svg').evaluate(s => {
    const [x, y, w, h] = s.getAttribute('viewBox').split(' ').map(Number);
    const g = s.querySelector('.map-vehicle.mine.gps');
    if (!g) return null;
    const [dx, dy] = g.getAttribute('transform').match(/translate\(([-\d.e]+) ([-\d.e]+)\)/).slice(1).map(Number);
    return { gap: Math.hypot(dx - (x + w / 2), dy - (y + h / 2)) / w, aim: Math.hypot(+g.dataset.x - (x + w / 2), +g.dataset.y - (y + h / 2)) / w };
  });
  // A fix 170 m on: the marker glides there (not stepped), the camera with it, not on the answer.
  await geoAt(page, 15);
  const v = map(page).locator('.map-vehicle.mine.gps');
  await expect.poll(async () => (await mark(v)).sx != null).toBe(true); // drawn on its way
  // A follow's ease on its way when the glide starts finishes first (2026-11-21), then the frames
  // take the view: the camera on the drawn point (the follow keeps its zoom).
  await expect.poll(async () => (await onDrawn(map(page)))?.gap).toBeLessThan(0.02);
  const view = await onDrawn(map(page));
  expect(view.gap).toBeLessThan(0.02);
  expect(view.aim).toBeGreaterThan(0.02); // while the answer is still ahead of it
  await tick(page, 2100);
  const done = await mark(v);
  expect(done.sx).toBeNull();
  await expect.poll(async () => (await onDrawn(map(page)))?.gap).toBeLessThan(0.01);
});

// The view's width, in meters (the follow's span while following).
const viewWidth = loc => loc.locator('svg.route-svg').evaluate(s => +s.getAttribute('viewBox').split(' ')[2]);
// The page's clock paused a little ahead (the read of it takes a round trip, and pauseAt refuses a
// time already past): frames run only when a spec asks, so a 250 ms ease's quarter mark holds.
const freeze = async page => page.clock.pauseAt((await page.evaluate(() => Date.now())) + 200);

test('a follow tap mid-glide: the ease finishes, then the glide\'s frames take the view (2026-11-21)', async ({ page }) => {
  await stubLocation(page);
  const scenario = { ...commute(), vehicles: [] };
  await openApp(page, { map: true, time: '07:00', scenario });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:08:30');
  await expect(page.locator('.ride-head')).toBeVisible();
  const tripId = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('t-minus:en-route')))[0].ride.legs[0].tripId);
  scenario.vehicles = [vehicleAt('mine', 12, tripId)];
  await tick(page, 20_000);
  await freeze(page);
  const before = await viewWidth(map(page)); // the trip's fit, kilometers wide
  await map(page).getByRole('button', { name: 'Follow Bus 132' }).click(); // a 250 ms ease to the follow's span
  await geoAt(page, 14); // yours at your fix (the marker snaps onto the line)
  await geoAt(page, 15); // 170 m on: it glides there, from the drawing after the tap
  await page.clock.runFor(64); // a quarter of the ease in
  const v = map(page).locator('.map-vehicle.mine.gps');
  expect((await mark(v)).sx).not.toBeNull(); // the glide is running (its frames are the ones that must wait)
  const mid = await viewWidth(map(page));
  await page.clock.runFor(500); // past the ease: the follow's span
  const after = await viewWidth(map(page));
  expect(after).toBeLessThan(before); // eased in
  expect(mid).toBeGreaterThan(after * 1.05); // still on its way: the glide's frames did not cut it
  expect(mid).toBeLessThan(before * 0.95);
});

test('Reduce Motion turned on mid-glide: the vehicles go to their answers at once (2026-11-21)', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('v1', 6)] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  const v = vehicle(page);
  await expect(v).toHaveCount(1);
  scenario.vehicles = [vehicleAt('v1', 8)];
  const at = (await nextAnswer(page, v)).at;
  expect(at.sx).not.toBeNull(); // on its way
  await freeze(page);
  // Date.now stands still while the frames keep their turn (drawing nothing): the preference must
  // be asked before that check, or a paused map would keep the glide until the clock moved again.
  await page.clock.setFixedTime(await page.evaluate(() => Date.now()));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.runFor(32); // a frame, with the clock still standing still
  const now = await mark(v);
  expect(now.sx).toBeNull(); // at the answer: the frames check the preference before the clock
  expect([now.tx, now.ty]).toEqual([now.x, now.y]);
});

test('Reduce Motion mid-glide snaps the follow camera to the ridden vehicle too', async ({ page }) => {
  await stubLocation(page);
  const scenario = { ...commute(), vehicles: [] };
  await openApp(page, { map: true, time: '07:00', scenario });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:08:30');
  await expect(page.locator('.ride-head')).toBeVisible();
  const tripId = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('t-minus:en-route')))[0].ride.legs[0].tripId);
  scenario.vehicles = [vehicleAt('mine', 6, tripId)];
  await tick(page, 20_000);
  await map(page).getByRole('button', { name: 'Follow Bus 132' }).click();
  await tick(page, 300);
  await pauseClock(page);
  const v = map(page).locator('.map-vehicle.mine');
  scenario.vehicles = [vehicleAt('mine', 8, tripId)]; // about 800 m, larger than the street view
  const { at } = await nextAnswer(page, v);
  expect(at.sx).not.toBeNull();
  const span = await viewWidth(map(page));
  expect(span).toBeCloseTo(400, 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.runFor(32); // snap on the next frame, without another drawing or poll
  const snapped = await mark(v);
  expect(snapped.sx).toBeNull();
  expect([snapped.tx, snapped.ty]).toEqual([snapped.x, snapped.y]);
  const view = await map(page).locator('svg.route-svg').evaluate(s => {
    const [x, y, w, h] = s.getAttribute('viewBox').split(' ').map(Number);
    return { x: x + w / 2, y: y + h / 2, span: w };
  });
  expect(view.span).toBeCloseTo(span, 5);
  expect(gap(view, snapped)).toBeLessThan(1);
  await expect(map(page).locator('.map-locate')).toHaveAttribute('aria-pressed', 'true');
  const snappedView = await map(page).locator('svg.route-svg').getAttribute('viewBox');
  await page.clock.runFor(300); // no old camera ease may pull it back after the snap
  await expect(map(page).locator('svg.route-svg')).toHaveAttribute('viewBox', snappedView);
});

test('basemap names entering the follow view refresh during and after a glide', async ({ page }) => {
  const nameAt = (n, k) => ({ n, lat: busStop(busStops[k]).latitude, lon: busStop(busStops[k]).longitude });
  await page.route('**/basemap.json', route => route.fulfill({ json: {
    v: 1, box: [-71.2, 42.3, -71, 42.6], names: [nameAt('Old', 6), nameAt('New', 8)],
  } }));
  await stubLocation(page);
  const scenario = { ...commute(), vehicles: [] };
  await openApp(page, { map: true, time: '07:00', scenario });
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:08:30');
  await expect(page.locator('.ride-head')).toBeVisible();
  const tripId = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('t-minus:en-route')))[0].ride.legs[0].tripId);
  scenario.vehicles = [vehicleAt('mine', 6, tripId)];
  await tick(page, 20_000);
  await map(page).getByRole('button', { name: 'Follow Bus 132' }).click();
  await tick(page, 300);
  await pauseClock(page);
  const names = () => map(page).locator('.map-name').evaluateAll(ts => ts
    .filter(t => t.closest('g').getAttribute('display') !== 'none').map(t => t.textContent).sort());
  expect(await names()).toEqual(['Old']);
  const v = map(page).locator('.map-vehicle.mine');
  scenario.vehicles = [vehicleAt('mine', 8, tripId)];
  expect((await nextAnswer(page, v)).at.sx).not.toBeNull();
  await page.clock.runFor(1200);
  expect((await mark(v)).sx).not.toBeNull(); // entering the view while the glide is still running
  expect(await names()).toEqual(['New']);
  await page.clock.runFor(1000);
  expect((await mark(v)).sx).toBeNull(); // the final camera position, with no later drawing or poll
  expect(await names()).toEqual(['New']);
});

test('closing the full map snaps the main map\'s vehicles (2026-11-21)', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('v1', 6)] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  const v = vehicle(page);
  await expect(v).toHaveCount(1);
  scenario.vehicles = [vehicleAt('v1', 8)];
  expect((await nextAnswer(page, v)).at.sx).not.toBeNull(); // on its way
  await freeze(page); // the glide holds where it is while the map opens and closes
  await map(page).getByRole('button', { name: 'Open the full map' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Close the full map' }).click();
  await expect(sheet).toHaveCount(0);
  const back = await mark(v);
  expect(back.sx).toBeNull(); // at the answer, not still on its way
  expect([back.tx, back.ty]).toEqual([back.x, back.y]);
});

test('back from the background snaps the vehicles (2026-11-21)', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('v1', 6)] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  const v = vehicle(page);
  await expect(v).toHaveCount(1);
  scenario.vehicles = [vehicleAt('v1', 8)];
  expect((await nextAnswer(page, v)).at.sx).not.toBeNull();
  await freeze(page);
  // Hidden, then back: the app reads document.hidden on visibilitychange.
  const visibility = shown => page.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, !shown);
  await visibility(false);
  await visibility(true);
  const back = await mark(v);
  expect(back.sx).toBeNull();
  expect([back.tx, back.ty]).toEqual([back.x, back.y]);
});

test('a clock that stands still does not strand a glide (2026-11-21)', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('v1', 6)] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  const v = vehicle(page);
  await expect(v).toHaveCount(1);
  const first = await mark(v);
  scenario.vehicles = [vehicleAt('v1', 8)];
  const at = (await nextAnswer(page, v)).at;
  expect(at.sx).not.toBeNull();
  await freeze(page);
  // Date.now stands still (the simulator's pause) with the frames still running: nothing moves,
  // and no new answer comes (the app's own second ticks do not redraw the map).
  const still = await page.evaluate(() => Date.now());
  await page.clock.setFixedTime(still);
  const held = await mark(v);
  expect(held.sx).not.toBeNull(); // still on its way (well short of the 2 s)
  await page.clock.runFor(1500);
  const frozen = await mark(v);
  expect([frozen.sx, frozen.sy]).toEqual([held.sx, held.sy]); // nothing drawn while it stood still
  // The clock moves again: the running glide goes on by itself, without waiting for a poll's drawing.
  await page.clock.setSystemTime(still + 400);
  await page.clock.runFor(32);
  const moved = await mark(v);
  expect(moved.sx).not.toBeNull(); // still on its way (well short of the 2 s)
  const toward = m => Math.hypot(m.sx - at.x, m.sy - at.y);
  expect(toward(held) - toward(moved)).toBeGreaterThan(5); // and further along than when it stood still
  await page.clock.runFor(2100);
  const done = await mark(v);
  expect(done.sx).toBeNull();
  expect([done.tx, done.ty]).toEqual([done.x, done.y]);
  expect(gap(done, first)).toBeGreaterThan(50);
});

test('a clock stepped backwards does not strand the next glide (2026-11-21)', async ({ page }) => {
  const scenario = { ...commute(), vehicles: [vehicleAt('v1', 6)] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  const v = vehicle(page);
  await expect(v).toHaveCount(1);
  // A glide runs, so the last frame's moment is ahead of the times that follow.
  scenario.vehicles = [vehicleAt('v1', 7)]; // 382 m on
  expect((await nextAnswer(page, v)).at.sx).not.toBeNull();
  await tick(page, 900);
  // The device's clock steps back (an NTP correction, the simulator's jump): a new answer arrives
  // at a time before the last frame's. Its glide must run from there, not stand still until the
  // clock climbs back past that old frame's moment.
  await page.clock.setSystemTime(await page.evaluate(() => Date.now() - 30_000));
  scenario.vehicles = [vehicleAt('v1', 8)]; // 434 m on, forwards
  const { at } = await nextAnswer(page, v);
  expect(at.sx).not.toBeNull();
  await tick(page, 400);
  const moved = await mark(v);
  expect(moved.sx).not.toBeNull();
  expect(Math.hypot(moved.sx - at.x, moved.sy - at.y)).toBeLessThan(Math.hypot(at.sx - at.x, at.sy - at.y));
});

// The ride card's trip id (the belled trip) for a vehicle that is the ride's own.
const rideTripId = page => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('t-minus:en-route')))[0].ride.legs[0].tripId);
// A ride of the shown trip, at the stop at 07:00 and riding by 07:08:30 (the specs above).
async function startedRide(page) {
  await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
  await tickTo(page, '07:08:30');
  await expect(page.locator('.ride-head')).toBeVisible();
}

test('the ride marker between the MBTA\'s position and your fix: forward it glides, backward it snaps (2026-11-21)', async ({ page }) => {
  // The marker is the leg's own vehicle, wherever it comes from: its fix and the MBTA's position
  // are one identity on one progress basis (routeMapModel), so the forward switch is a plain move
  // and glides, not a source change that snaps.
  await stubLocation(page);
  const scenario = { ...commute(), vehicles: [] };
  await openApp(page, { map: true, time: '07:00', scenario });
  await startedRide(page);
  scenario.vehicles = [vehicleAt('mine', 15, await rideTripId(page))]; // the MBTA's position, 3.3 km on
  await tick(page, 20_000);
  const v = map(page).locator('.map-vehicle.mine');
  await expect(v).not.toHaveClass(/gps/);
  const mbta = await mark(v);
  expect(mbta.sx).toBeNull(); // a first appearance
  // Your fix 170 m behind it, with no held point yet: the marker is at your fix at once (backwards).
  await geoAt(page, 14);
  await expect(v).toHaveClass(/gps/);
  const back = await mark(v);
  expect(back.sx).toBeNull();
  expect([back.tx, back.ty]).toEqual([back.x, back.y]);
  expect(gap(back, mbta)).toBeGreaterThan(50);
  // The same fix, now too rough to count: the marker goes back to the MBTA's position, 170 m on.
  // Forwards, so it glides there: the camera and the drawing follow it, not a step.
  await page.evaluate(([a, b]) => window.geo.move(a, b, 500), [busStop(busStops[14]).latitude, busStop(busStops[14]).longitude]);
  await expect(v).not.toHaveClass(/gps/);
  const at = await mark(v);
  expect(at.sx).not.toBeNull(); // drawn on its way
  expect(gap({ x: at.sx, y: at.sy }, back)).toBeLessThan(gap(back, at) * 0.5); // near where it was drawn
  expect(gap({ x: at.sx, y: at.sy }, at)).toBeGreaterThan(1); // and not there yet
  await tick(page, 2200);
  const done = await mark(v);
  expect(done.sx).toBeNull();
  expect([done.tx, done.ty]).toEqual([done.x, done.y]);
  expect(gap(done, back)).toBeGreaterThan(50);
});

test('a vehicle that comes back as another trip snaps to the new answer (2026-11-21)', async ({ page }) => {
  // The same vehicle id is not the same bus: a new trip is a new vehicle, at the answer at once
  // (its state is kept by id, leg, trip and route shape).
  const scenario = { ...commute(), vehicles: [vehicleAt('v1', 13, '132in-0640')] };
  await openApp(page, { map: true, time: '07:00', scenario, init: DENIED });
  const v = vehicle(page);
  await expect(v).toHaveCount(1);
  expect((await mark(v)).sx).toBeNull(); // the first drawing
  scenario.vehicles = [vehicleAt('v1', 14, '132in-0640')]; // the same trip, 81 m on: it glides
  const on = (await nextAnswer(page, v)).at;
  expect(on.sx).not.toBeNull();
  await tick(page, 2200); // arrived: drawn at 81 m on
  // Another trip at the next stop (171 m on): a new vehicle, drawn there at once.
  scenario.vehicles = [vehicleAt('v1', 15, '132in-0712')];
  const other = (await nextAnswer(page, v)).at;
  expect(other.sx).toBeNull();
  expect([other.tx, other.ty]).toEqual([other.x, other.y]);
  expect(gap(other, on)).toBeGreaterThan(50);
});

// The camera's center and width (meters), and where the ridden vehicle is drawn.
const camera = loc => loc.locator('svg.route-svg').evaluate(s => {
  const [x, y, w, h] = s.getAttribute('viewBox').split(' ').map(Number);
  const [dx, dy] = s.querySelector('.map-vehicle.mine').getAttribute('transform').match(/translate\(([-\d.e]+) ([-\d.e]+)\)/).slice(1).map(Number);
  return { cx: x + w / 2, cy: y + h / 2, w, dx, dy };
});

test('a follow ease running when a glide starts hands the view over without a jump (2026-11-21)', async ({ page }) => {
  // Following the vehicle at the street span: an answer that snaps back to your fix eases the
  // camera back (250 ms), a fix 650 m on starts a glide under that ease, and another one retargets
  // it. The ease tracks the drawn vehicle each frame, so it ends where the vehicle is drawn then;
  // sampling every frame through its end, the camera moves by the glide's own step, not by the
  // glide's progress at once.
  await stubLocation(page);
  const scenario = { ...commute(), vehicles: [] };
  await openApp(page, { map: true, time: '07:00', scenario });
  await startedRide(page);
  scenario.vehicles = [vehicleAt('mine', 15, await rideTripId(page))];
  await tick(page, 20_000);
  await map(page).getByRole('button', { name: 'Follow Bus 132' }).click();
  await tick(page, 400); // the follow's own ease, to the street span
  await freeze(page);
  await geoAt(page, 14); // 170 m back: the marker snaps there, the camera eases back
  await page.clock.runFor(100);
  const m = map(page).locator('.map-vehicle.mine');
  await geoAt(page, 18); // 650 m on: it glides there while the ease is still running
  await page.clock.runFor(60);
  const at18 = await mark(m);
  await geoAt(page, 19); // and another answer under the ease: the glide retargets from where it is drawn
  expect(gap(await mark(m), at18)).toBeGreaterThan(50); // the answer moved: the retarget landed
  const width = await viewWidth(map(page));
  const samples = [];
  for (let i = 0; i < 14; i++) { // every frame, from 160 ms to ~380 ms: through the ease's end (250)
    await page.clock.runFor(16);
    samples.push(await camera(map(page)));
  }
  const step = [];
  for (let i = 1; i < samples.length; i++) step.push(Math.hypot(samples[i].cx - samples[i - 1].cx, samples[i].cy - samples[i - 1].cy));
  // From the ease's second half on (the first frames pan back across the span), no frame jumps: the
  // glide's own step is a few percent of the view, the progress it had made by the ease's end a
  // third of it, and a retarget starts where it is drawn (no step of its own).
  expect(Math.max(...step.slice(4)) / width).toBeLessThan(0.09);
  // The ease ended on the vehicle as drawn (not on the fixed pan's target), and the follow is still
  // at its street span: the glide's frames took over, no zoom was cut.
  const last = samples.at(-1);
  expect(Math.hypot(last.cx - last.dx, last.cy - last.dy) / width).toBeLessThan(0.04);
  expect(last.w).toBe(width);
  // A double-tap while it still glides zooms in (another ease, at the follow's new span): its target
  // tracks the drawn vehicle too, so that handoff is smooth as well.
  const box = await map(page).locator('svg.route-svg').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const zoomed = [];
  for (let i = 0; i < 14; i++) {
    await page.clock.runFor(16);
    zoomed.push(await camera(map(page)));
  }
  const zstep = [];
  for (let i = 1; i < zoomed.length; i++) zstep.push(Math.hypot(zoomed[i].cx - zoomed[i - 1].cx, zoomed[i].cy - zoomed[i - 1].cy) / zoomed[i].w);
  expect(Math.max(...zstep.slice(4))).toBeLessThan(0.08);
  const zlast = zoomed.at(-1);
  expect(zlast.w).toBeLessThan(width * 0.75); // zoomed in
  expect(Math.hypot(zlast.cx - zlast.dx, zlast.cy - zlast.dy) / zlast.w).toBeLessThan(0.04); // and on the bus
});
