import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateConfig, tripShape, scheduleWindow, mergeTrips, legVehicles, averageHeadway, pickTimingLeg,
  tripRows, rememberLive, withRemembered, rowState, timelineSteps, startEnRoute, pinTarget, unpinTarget, advanceEnRoute, enRouteActive, enRouteStatus, trackLegs, ridePhase, canUndoBoarding, replanFrom, rideHeadline, rideStops, shownStops, transferOutlook, outlookText, laterVehicles, switchLeg, pickTrip, inWindow, countdownState, pollIntervalMs, dataAgeText, retryDelayMs, rateLimitDelayMs, pullOffset, PULL_MAX, pageVersion, isNewerPage,
  filterAlerts, expandStops, childToParentMap, commuteEntities, formatCountdown, countdownLabel,
  nextServiceWindow, fillRows, formatTime, departureCount, stopSlackMinutes, wakeMinutes, keepAwake, keepAwakeRiding, stopQueries, checkStops, stopsKey, tripLabel,
  tripToForm, formToTrip, locateLegs, distanceMeters, pickByLocation, routeLabel, routeEnds, searchRoutes, searchStops, stopsAfter, boardGroups, alightGroups, commonLabel, railConnections, servesInOrder, legRoutes, vehicleLabel, onVehicle,
  railNetwork, networkStation, railStopsFrom, searchStations, reachableFrom, legBetween, trimRoutes, defaultTransferMinutes,
  reverseTrip, nearestStop, windowLabel, shortRouteLabel, labelLegs,
} from '../core.js';

const MIN = 60_000;
// 2026-09-30 is EDT (UTC-4).
const at = hhmm => Date.parse(`2026-09-30T${hhmm}:00-04:00`);
const iso = hhmm => `2026-09-30T${hhmm}:00-04:00`;

function rec(type, trip, stop, arr, dep, extra = {}) {
  return {
    type,
    attributes: { arrival_time: arr && iso(arr), departure_time: dep && iso(dep), ...extra },
    relationships: { trip: { data: { id: trip } }, stop: { data: { id: stop } } },
  };
}
const doc = (data, included = []) => ({ data, included });
const stopInc = (id, parent) => ({ type: 'stop', id, relationships: { parent_station: { data: parent ? { id: parent } : null } } });
// Vehicle fixture: [tripId, dep HH:MM, arr HH:MM, source].
const veh = (tripId, dep, arr, source = 'scheduled') => ({ tripId, dep: at(dep), arr: at(arr), source });

const EXAMPLE = JSON.parse(readFileSync('test/fixtures/bus-orange.json', 'utf8'));
const [homeToOffice, officeToHome] = EXAMPLE.trips;

// ---------- config ----------

test('example config is valid', () => {
  assert.deepEqual(validateConfig(EXAMPLE), []);
});

test('validateConfig rejects the old format and bad legs, windows, timingLeg', () => {
  assert.deepEqual(validateConfig({ commutes: [] }),
    ['This is the old config format (commutes); rebuild it as trips in setup.']);
  const cfg = structuredClone(EXAMPLE);
  delete cfg.trips[0].legs[1].alight;
  cfg.trips[0].window = { from: '25:00', to: '12:00' };
  cfg.trips[1].timingLeg = 2;
  cfg.trips[1].legs[0].minutes = -1;
  assert.deepEqual(validateConfig(cfg), [
    'Trip "Home to office": legs[1].stop and .alight are required.',
    'Trip "Home to office": window must be { "from": "HH:MM", "to": "HH:MM" } (to may be 24:00).',
    'Trip "Office to home": legs[0].minutes must be a number >= 0.',
    'Trip "Office to home": timingLeg must be a transit leg index from 0 to 1.',
  ]);
  assert.deepEqual(validateConfig({ trips: [{ name: 'x', legs: [{ kind: 'walk', minutes: 3 }] }] }),
    ['Trip "x": needs at least one transit leg.']);
});

test('departureCount and stopSlackMinutes default and validate', () => {
  const { departureCount: _, stopSlackMinutes: __, ...bare } = EXAMPLE;
  assert.equal(departureCount(bare), 4);
  assert.equal(stopSlackMinutes(bare), 1);
  assert.deepEqual(validateConfig(bare), []);
  assert.deepEqual(validateConfig({ ...EXAMPLE, departureCount: 6 }), []);
  for (const bad of [0, 9, 2.5, '4']) {
    assert.ok(validateConfig({ ...EXAMPLE, departureCount: bad }).some(e => e.startsWith('departureCount')));
  }
});

test('wakeMinutes default and validate', () => {
  assert.equal(wakeMinutes(EXAMPLE), 10);
  assert.deepEqual(validateConfig({ ...EXAMPLE, wakeMinutes: 0 }), []);
  for (const bad of [-1, 'x']) assert.deepEqual(validateConfig({ ...EXAMPLE, wakeMinutes: bad }), ['wakeMinutes must be a number >= 0.']);
});

test('keepAwake: from N min before leave-by until the last chance', () => {
  const row = { leaveBy: at('08:00'), lastChance: at('08:01') };
  const awake = (t, rows = [row], minutes = 10) => keepAwake(rows, at(t), minutes);
  assert.equal(keepAwake([row], at('07:50') - 1000, 10), false);
  assert.equal(awake('07:50'), true);
  assert.equal(keepAwake([row], at('08:00') + 30_000, 10), true);
  assert.equal(awake('08:01'), false);
  assert.equal(awake('07:55', [row], 0), false);
  assert.equal(awake('07:55', [{ ...row, missed: true }]), false);
  const next = { leaveBy: at('08:08'), lastChance: at('08:09') };
  assert.equal(awake('08:02', [{ ...row, missed: true }, next]), true);
  assert.equal(awake('08:02', []), false);
});

test('keepAwakeRiding: 2 min before a drop-off or the next departure', () => {
  const ride = { boardedAt: at('07:40'), legs: [{ dep: at('07:40'), arr: at('07:54') }, { dep: at('08:02'), arr: at('08:20') }] };
  const awake = (t, minutes = 10) => keepAwakeRiding(ride, 5, at(t), minutes);
  assert.equal(awake('07:45'), false);
  assert.equal(awake('07:52'), true);
  assert.equal(awake('07:56'), false); // transfer, 6 min before the next departure
  assert.equal(awake('08:00'), true);
  assert.equal(awake('08:10'), false);
  assert.equal(awake('08:19'), true);
  assert.equal(awake('08:22'), false); // walking
  assert.equal(awake('08:19', 0), false);
});

test('tripShape splits walk, transfer, and transit legs', () => {
  const s = tripShape(officeToHome);
  assert.deepEqual(s.transit.map(l => l.route), ['Orange', '132']);
  assert.equal(s.walkBefore, 10);
  assert.equal(s.walkAfter, 5);
  assert.deepEqual(s.transfers, [5]);
  // A missing transfer leg between two transit legs counts as 0.
  const noTransfer = { legs: [homeToOffice.legs[1], homeToOffice.legs[3]] };
  assert.deepEqual(tripShape(noTransfer).transfers, [0]);
});

// ---------- time ----------

test('scheduleWindow handles service day past midnight', () => {
  assert.deepEqual(scheduleWindow(at('10:00')),
    { date: '2026-09-30', minTime: '09:55', maxTime: '16:00', coversEndOfService: false });
  // Windows reaching 22:00 extend to the end of the service day (28:00).
  assert.deepEqual(scheduleWindow(at('17:30')),
    { date: '2026-09-30', minTime: '17:25', maxTime: '28:00', coversEndOfService: true });
  const lateNight = Date.parse('2026-10-01T00:40:00-04:00');
  assert.deepEqual(scheduleWindow(lateNight),
    { date: '2026-09-30', minTime: '24:35', maxTime: '30:40', coversEndOfService: true });
});

test('nextServiceWindow targets the morning after the current service date', () => {
  assert.deepEqual(nextServiceWindow(at('23:40')), { date: '2026-10-01', minTime: '03:00', maxTime: '12:00' });
  // 00:40 on Oct 1 is still the Sep 30 service day, so the next one is Oct 1.
  assert.deepEqual(nextServiceWindow(Date.parse('2026-10-01T00:40:00-04:00')),
    { date: '2026-10-01', minTime: '03:00', maxTime: '12:00' });
  assert.equal(nextServiceWindow(Date.parse('2026-10-01T03:10:00-04:00')).date, '2026-10-02');
});

// ---------- trip selection ----------

test('inWindow handles normal, midnight-crossing, and whole-day windows', () => {
  const m = hhmm => { const [h, mm] = hhmm.split(':').map(Number); return h * 60 + mm; };
  assert.ok(inWindow(m('11:59'), { from: '00:00', to: '12:00' }));
  assert.ok(!inWindow(m('12:00'), { from: '00:00', to: '12:00' }));
  assert.ok(inWindow(m('23:59'), { from: '12:00', to: '24:00' }));
  assert.ok(inWindow(m('01:00'), { from: '22:00', to: '02:00' }));
  assert.ok(!inWindow(m('03:00'), { from: '22:00', to: '02:00' }));
  assert.ok(inWindow(m('03:00'), { from: '06:00', to: '06:00' }));
});

test('location: near trips, first-stop coordinates, pickByLocation, precedence', () => {
  // Config: near is exclusive with window; coordinates are numbers.
  const near = structuredClone(EXAMPLE);
  near.trips.forEach(t => { delete t.window; t.near = true; });
  assert.deepEqual(validateConfig(near), []);
  const both = structuredClone(near);
  both.trips[0].window = { from: '06:00', to: '12:00' };
  assert.deepEqual(validateConfig(both), [`Trip "${both.trips[0].name}": can't have both near and window.`]);
  const bad = structuredClone(near);
  bad.trips[0].near = 'yes';
  bad.trips[0].legs[1].lat = 'x';
  assert.deepEqual(validateConfig(bad), [
    `Trip "${bad.trips[0].name}": legs[1].lat must be a number.`, `Trip "${bad.trips[0].name}": near must be true if present.`]);

  // locateLegs: board stop (or a child platform) → coordinates; unloaded docs keep what they have.
  const stopsDoc = (...stops) => ({ data: stops.map(([id, lat, lon, children = []]) => ({
    id, attributes: { latitude: lat, longitude: lon }, relationships: { child_stops: { data: children.map(c => ({ id: c })) } } })) });
  const docs = new Map([
    ['132/1', stopsDoc(['25996', 42.43, -71.07], ['5991', 42.44, -71.08])],
    ['Orange/1', stopsDoc(['place-ogmnl', 42.437, -71.071, ['70036']])],
  ]);
  const cfg = { trips: [{ name: 'T', near: true, legs: [
    { kind: 'transit', route: '132', direction_id: 1, stop: '25996', alight: '5991' },
    { kind: 'transit', route: 'Orange', direction_id: 1, stop: '70036', alight: 'place-state' },
    { kind: 'transit', route: '99', direction_id: 0, stop: 'a', alight: 'b', lat: 1, lon: 2 }] }] };
  const located = locateLegs(cfg, docs).trips[0].legs;
  assert.deepEqual(located.map(l => [l.lat, l.lon]), [[42.43, -71.07], [42.437, -71.071], [1, 2]]);
  // Coordinates survive the setup form.
  assert.deepEqual(formToTrip(tripToForm({ ...cfg.trips[0], legs: located })), { ...cfg.trips[0], legs: located });

  // distanceMeters: 0.01° latitude ≈ 1113 m.
  assert.equal(Math.round(distanceMeters({ lat: 42.40, lon: -71.07 }, { lat: 42.41, lon: -71.07 })), 1113);

  // pickByLocation: within 1 km and 2x closer than a different first stop.
  const trip = (name, lat, stop = name, extra = { near: true }) =>
    ({ name, ...extra, legs: [{ kind: 'transit', route: 'R', direction_id: 0, stop, alight: 'z', lat, lon: -71.07 }] });
  const home = trip('home', 42.400);
  const work = trip('work', 42.360);
  const pos = lat => ({ lat, lon: -71.07 });
  assert.equal(pickByLocation([home, work], pos(42.401)), 0);
  assert.equal(pickByLocation([home, work], pos(42.361)), 1);
  assert.equal(pickByLocation([home, work], pos(42.420)), -1); // 2.2 km from home
  assert.equal(pickByLocation([home, trip('close', 42.405)], pos(42.4025)), -1); // no clear winner
  assert.equal(pickByLocation([trip('a', 42.400, 's'), trip('b', 42.400, 's')], pos(42.401)), 0); // same stop: list order
  assert.equal(pickByLocation([trip('w', 42.400, 'w', { window: { from: '06:00', to: '12:00' } })], pos(42.401)), -1);
  assert.equal(pickByLocation([{ name: 'x', near: true, legs: [] }], pos(42.4)), -1);

  // pickTrip: override > location > window > last used.
  const cfgW = { trips: [{ ...work, near: undefined, window: { from: '06:00', to: '12:00' } }, home] };
  assert.equal(pickTrip(at('08:00'), cfgW, null, 0, 1), 1);
  assert.equal(pickTrip(at('08:00'), cfgW, null, 1, -1), 0);
  assert.equal(pickTrip(at('08:00'), cfgW, { index: 0, setAt: at('07:59') }, 1, 1), 0);
});

test('pickTrip: windows, overlap order, override expiry, last used', () => {
  assert.equal(pickTrip(at('08:00'), EXAMPLE, null, null), 0);
  assert.equal(pickTrip(at('13:00'), EXAMPLE, null, null), 1);

  const trips = (...windows) => ({ trips: windows.map((window, i) => ({ name: `t${i}`, legs: [], ...(window && { window }) })) });
  // Overlapping windows: the first trip in the list wins.
  assert.equal(pickTrip(at('11:00'), trips({ from: '06:00', to: '12:00' }, { from: '10:00', to: '14:00' }), null, null), 0);
  // No window matches: last used, else the first trip.
  const none = trips(null, null, null);
  assert.equal(pickTrip(at('11:00'), none, null, 2), 2);
  assert.equal(pickTrip(at('11:00'), none, null, 7), 0);
  // Without any windows, a manual choice holds indefinitely.
  assert.equal(pickTrip(at('23:00'), none, { index: 1, setAt: at('06:00') }, 2), 1);

  // A manual switch holds until the next window starts after it was set.
  const cfg = trips({ from: '06:00', to: '09:00' }, { from: '09:00', to: '18:00' }, null);
  const override = { index: 2, setAt: at('07:00') };
  assert.equal(pickTrip(at('08:59'), cfg, override, null), 2);
  assert.equal(pickTrip(at('09:00'), cfg, override, null), 1);
});

// ---------- trips ----------

test('mergeTrips: prediction beats schedule; parent ids mapped; skipped stops dropped', () => {
  const sched = doc([
    rec('schedule', 't1', '70023', '17:00', '17:01'),
    rec('schedule', 't2', '70023', '17:05', '17:06'),
  ], [stopInc('70023', 'place-state')]);
  const pred = doc([
    rec('prediction', 't1', '70023', '17:02', '17:03'),
    rec('prediction', 't2', '70023', null, null, { schedule_relationship: 'SKIPPED' }),
  ], [stopInc('70023', 'place-state')]);
  const trips = mergeTrips(pred, sched);
  const t1 = trips.get('t1').get('place-state');
  assert.equal(t1.source, 'live');
  assert.equal(t1.dep, at('17:03'));
  assert.equal(trips.get('t1').get('70023'), t1);
  assert.ok(trips.get('t2').get('place-state').cancelled);
});

test('legVehicles pairs board and alight times per vehicle trip', () => {
  const leg = officeToHome.legs[1]; // Orange place-state → place-ogmnl
  const included = [stopInc('70023', 'place-state'), stopInc('70036', 'place-ogmnl')];
  const trips = mergeTrips(
    doc([rec('prediction', 'o2', '70023', '17:15', '17:16'), rec('prediction', 'o2', '70036', '17:32', null),
      rec('prediction', 'o3', '70023', null, null, { schedule_relationship: 'SKIPPED' })], included),
    doc([rec('schedule', 'o1', '70023', '17:10', '17:11'), rec('schedule', 'o1', '70036', '17:27', '17:27'),
      rec('schedule', 'o3', '70023', '17:20', '17:21'), rec('schedule', 'o3', '70036', '17:37', '17:37'),
      rec('schedule', 'o4', '70023', '17:25', '17:26')], included));
  // o3 is skipped at the board stop; o4 has no alight time.
  assert.deepEqual(legVehicles(trips, leg), [
    { tripId: 'o1', dep: at('17:11'), arr: at('17:27'), source: 'scheduled' },
    { tripId: 'o2', dep: at('17:16'), arr: at('17:32'), source: 'live' },
  ]);
});

test('averageHeadway and pickTimingLeg with hysteresis and override', () => {
  assert.equal(averageHeadway([veh('a', '08:00', '08:05'), veh('b', '08:30', '08:35'), veh('c', '09:00', '09:05')]), 30 * MIN);
  assert.equal(averageHeadway([veh('a', '08:00', '08:05')]), Infinity);

  assert.equal(pickTimingLeg([30 * MIN, 5 * MIN], null, null), 0);
  assert.equal(pickTimingLeg([5 * MIN, 30 * MIN], null, null), 1);
  // Keep the previous leg unless the candidate is at least 1.5x longer.
  assert.equal(pickTimingLeg([20 * MIN, 25 * MIN], 0, null), 0);
  assert.equal(pickTimingLeg([20 * MIN, 30 * MIN], 0, null), 1);
  // A leg with fewer than 2 departures (Infinity) wins.
  assert.equal(pickTimingLeg([30 * MIN, Infinity], 0, null), 1);
  // The pinned override wins; out-of-range overrides are ignored.
  assert.equal(pickTimingLeg([30 * MIN, 5 * MIN], null, 1), 1);
  assert.equal(pickTimingLeg([30 * MIN, 5 * MIN], null, 5), 0);
});

// ---------- leave-by ----------

test('tripRows: single leg with stop slack, "Hurry" window, and ETA', () => {
  const trip = { legs: [{ kind: 'walk', minutes: 5 }, homeToOffice.legs[1], { kind: 'walk', minutes: 2 }] };
  const buses = [veh('b1', '07:10', '07:20'), veh('b2', '07:40', '07:50', 'live'), veh('b3', '08:10', '08:21')];
  const rows = tripRows(trip, [buses], 0, at('07:21'), 1); // b1 left 11 min ago
  assert.deepEqual(rows.map(r => r.key), ['b2', 'b3']);
  assert.equal(rows[0].leaveBy, at('07:34')); // 07:40 - 5 walk - 1 slack
  assert.equal(rows[0].lastChance, at('07:35')); // 07:40 - 5 walk
  assert.equal(rows[0].firstDep, at('07:40'));
  assert.equal(rows[0].eta, at('07:52'));
  assert.deepEqual(rows[0].legs, [{ route: '132', label: '132', color: null, dep: at('07:40'), arr: at('07:50'), source: 'live', tripId: 'b2' }]);
  // Past leave-by but before the last chance: the row stays ("Hurry").
  assert.deepEqual(tripRows(trip, [buses], 0, at('07:34'), 1).map(r => r.key), ['b2', 'b3']);
  assert.equal(countdownState(at('07:34'), rows[0].leaveBy, rows[0].lastChance, rows[0].firstDep), 'red');
  // From the last chance until 10 min after it leaves: missed, first, counting toward `count`.
  const missedAt = t => tripRows(trip, [buses], 0, at(t), 1).map(r => [r.key, !!r.missed]);
  assert.deepEqual(missedAt('07:35'), [['b2', true], ['b3', false]]);
  assert.deepEqual(missedAt('07:49'), [['b2', true], ['b3', false]]);
  assert.deepEqual(missedAt('07:50'), [['b3', false]]);
  assert.deepEqual(tripRows(trip, [buses], 0, at('07:36'), 1, 2).map(r => r.key), ['b2', 'b3']);
  assert.deepEqual(tripRows(trip, [buses], 0, at('07:36'), 1, 1).map(r => r.key), ['b3']);
  // Count limit.
  assert.equal(tripRows(trip, [buses], 0, at('07:15'), 1, 1).length, 1);
});

test('tripRows: train then bus picks the latest viable train and skips unreachable buses', () => {
  const trains = [veh('o1', '17:11', '17:27'), veh('o2', '17:16', '17:32', 'live'),
    veh('o3', '17:21', '17:37'), veh('o9', '18:01', '18:17')];
  const buses = [veh('b0', '17:05', '17:15'), veh('b1', '17:40', '17:50'), veh('b2', '17:57', '18:07'),
    veh('b3', '18:39', '18:49')];
  const rows = tripRows(officeToHome, [trains, buses], 1, at('17:00'), 1);
  // b0 leaves before any train can arrive.
  assert.deepEqual(rows.map(r => r.key), ['b1', 'b2', 'b3']);
  // b1 17:40 - 5 transfer: latest train arriving by 17:35 is o2; 17:16 - 10 walk - 1 slack.
  assert.equal(rows[0].legs[0].dep, at('17:16'));
  assert.equal(rows[0].leaveBy, at('17:05'));
  assert.equal(rows[0].lastChance, at('17:06'));
  assert.equal(rows[0].eta, at('17:55'));
  // Each leg keeps its own source.
  assert.deepEqual(rows[0].legs.map(l => l.source), ['live', 'scheduled']);
  assert.equal(rows[1].legs[0].dep, at('17:21'));
  assert.equal(rows[2].legs[0].dep, at('18:01'));
  // At 17:08, o2 (17:16) can't be reached with a 10-minute walk and o3 arrives too late
  // for b1, so b1 is missed (until 10 min after o2 leaves), shown first.
  const late = tripRows(officeToHome, [trains, buses], 1, at('17:08'), 1);
  assert.deepEqual(late.map(r => [r.key, !!r.missed]), [['b1', true], ['b2', false], ['b3', false]]);
  assert.equal(late[0].firstDep, at('17:16'));
  assert.deepEqual(tripRows(officeToHome, [trains, buses], 1, at('17:26'), 1).map(r => r.key), ['b2', 'b3']);
});

test('tripRows: bus then train takes the earliest onward train for the ETA', () => {
  const buses = [veh('b1', '07:40', '07:50', 'live'), veh('b2', '23:32', '23:45')];
  const trains = [veh('o1', '07:52', '08:07'), veh('o2', '07:56', '08:11'), veh('o3', '08:00', '08:15')];
  const rows = tripRows(homeToOffice, [buses, trains], 0, at('07:15'), 1);
  // o1 leaves before arrival + 5 transfer (07:55); b2 has no onward train and is skipped.
  assert.deepEqual(rows.map(r => r.key), ['b1']);
  assert.equal(rows[0].legs[1].dep, at('07:56'));
  assert.equal(rows[0].eta, at('08:21')); // 08:11 + 10 walk
  assert.equal(rows[0].leaveBy, at('07:34'));
});

test('tripRows: three legs chain backwards and forwards around a middle timing leg', () => {
  const route = r => ({ kind: 'transit', route: r, direction_id: 0, stop: `${r}-in`, alight: `${r}-out` });
  const trip = { legs: [{ kind: 'walk', minutes: 2 }, route('A'), { kind: 'transfer', minutes: 3 },
    route('B'), { kind: 'transfer', minutes: 3 }, route('C'), { kind: 'walk', minutes: 4 }] };
  const a = [veh('a1', '08:00', '08:10'), veh('a2', '08:05', '08:15'), veh('a3', '08:12', '08:20'), veh('a4', '08:20', '08:28')];
  const b = [veh('b1', '08:30', '08:45')];
  const c = [veh('c1', '08:47', '09:00'), veh('c2', '08:50', '09:05')];
  const [row] = tripRows(trip, [a, b, c], 1, at('07:50'), 1);
  // Latest A arriving by 08:27 is a3; earliest C leaving at or after 08:48 is c2.
  assert.deepEqual(row.legs.map(l => [l.route, l.dep]), [['A', at('08:12')], ['B', at('08:30')], ['C', at('08:50')]]);
  assert.equal(row.leaveBy, at('08:09'));
  assert.equal(row.eta, at('09:09'));
  assert.equal(row.timingIdx, 1);
});

test('en route: reachability from the at-stop time, no leave-by', () => {
  const trip = { legs: [{ kind: 'walk', minutes: 5 }, homeToOffice.legs[1]] };
  const buses = [veh('b2', '07:40', '07:50'), veh('b3', '08:10', '08:20')];
  const rowsAt = (t, en) => tripRows(trip, [buses], 0, at(t), 1, 4, en);
  const states = (t, en) => rowsAt(t, en).map(r => [r.key, rowState(at(t), r)]);

  // Leaving at 07:30 (normal leave-by 07:34): at the stop 07:35, b2 reachable until it leaves.
  const leaving = startEnRoute('leaving', at('07:30'), 5);
  assert.deepEqual(leaving, { kind: 'leaving', at: at('07:30'), atStop: at('07:35') });
  const [r2] = rowsAt('07:30', leaving);
  assert.equal(r2.leaveBy, null);
  assert.equal(r2.lastChance, at('07:40'));
  assert.deepEqual(states('07:39', leaving), [['b2', 'enroute'], ['b3', 'enroute']]);
  assert.deepEqual(states('07:40', leaving), [['b2', 'missed'], ['b3', 'enroute']]);
  // Leaving at 07:37: at the stop 07:42, after b2 leaves: b2 is missed right away.
  assert.deepEqual(states('07:37', startEnRoute('leaving', at('07:37'), 5)), [['b2', 'missed'], ['b3', 'enroute']]);
  // At the stop at 07:38 (normal last chance was 07:35): b2 is reachable; the first tap is kept.
  const stop = startEnRoute('stop', at('07:38'), 5, leaving);
  assert.deepEqual(stop, { kind: 'stop', at: at('07:30'), atStop: at('07:38') });
  assert.deepEqual(states('07:38', stop), [['b2', 'enroute'], ['b3', 'enroute']]);

  // Before boarding the mode lasts 30 min from the first tap.
  assert.equal(enRouteActive(leaving, 0, at('07:59')), true);
  assert.equal(enRouteActive(leaving, 0, at('08:00')), false);

  // Labels, status, polling, wake lock.
  assert.equal(countdownLabel('enroute', 6 * MIN, 'Bus 132'), 'Bus 132 in 6 min');
  assert.equal(enRouteStatus(leaving, at('07:31')), 'Walking · at the stop ~7:35am');
  assert.equal(enRouteStatus(leaving, at('07:36')), 'At the stop since ~7:35am');
  assert.equal(enRouteStatus(stop, at('07:39')), 'At the stop since 7:38am');
  assert.equal(pollIntervalMs(rowsAt('07:00', leaving), at('07:00')), 60_000);
  assert.equal(keepAwake(rowsAt('07:30', leaving), at('07:30'), 10), false);
});

test('tracking: boarding, live leg times, phases, Missed it re-plan', () => {
  const trip = homeToOffice; // walk 5, 132, transfer 5, Orange, walk 10
  const { transit, transfers } = tripShape(trip);
  const buses = [veh('b1', '07:12', '07:26'), veh('b2', '07:40', '07:54')];
  const trains = [veh('o1', '07:31', '07:46'), veh('o2', '07:36', '07:51'), veh('o3', '08:00', '08:15')];
  const stop = startEnRoute('stop', at('07:10'), 5);
  const rowsAt = (t, en) => tripRows(trip, [buses, trains], 0, at(t), 1, 4, en);
  assert.deepEqual(rowsAt('07:10', stop)[0].legs.map(l => l.tripId), ['b1', 'o1']);

  // Target re-taken while reachable; boarding when it departs.
  let s = advanceEnRoute(stop, rowsAt('07:10', stop), at('07:10'));
  assert.equal(s.target.key, 'b1');
  assert.equal(s.ride, undefined);
  s = advanceEnRoute(s, rowsAt('07:12', s), at('07:12'));
  assert.deepEqual([s.ride.boardedAt, s.ride.legs.map(l => l.tripId), s.target], [at('07:12'), ['b1', 'o1'], undefined]);
  assert.equal(advanceEnRoute(s, [], at('07:20')), s);
  // No boarding if the target was unreachable (at the stop after it left).
  const late = { kind: 'leaving', at: at('07:05'), atStop: at('07:13'), target: { key: 'b1', legs: s.ride.legs } };
  assert.equal(advanceEnRoute(late, rowsAt('07:12', late), at('07:12')).ride, undefined);

  // Phases and headlines (walk after 10 min: ETA 07:56).
  const ride = s.ride;
  const at_ = t => ridePhase(ride, 10, at(t));
  assert.deepEqual(at_('07:20'), { kind: 'riding', leg: 0, eta: at('07:56') });
  assert.equal(at_('07:27').kind, 'transfer');
  assert.deepEqual([at_('07:32').kind, at_('07:32').leg], ['riding', 1]);
  assert.equal(at_('07:50').kind, 'walking');
  assert.equal(at_('07:58').kind, 'arrived');
  assert.equal(at_('08:01').kind, 'done');
  assert.equal(rideHeadline(at_('07:20'), ride, at('07:20')), 'On 132 · off at 7:26am');
  assert.equal(rideHeadline(at_('07:27'), ride, at('07:27')), 'Transfer · Orange 7:31am');
  assert.equal(rideHeadline(at_('07:50'), ride, at('07:50')), 'Walking · arrive 7:56am');
  assert.equal(rideHeadline(at_('07:58'), ride, at('07:58')), 'Arrived ~7:56am');
  assert.equal(enRouteActive(s, 10, at('08:00')), true);
  assert.equal(enRouteActive(s, 10, at('08:01')), false);

  // Missed it: 2 min after each boarding.
  assert.equal(canUndoBoarding(ride, at_('07:13'), at('07:13')), true);
  assert.equal(canUndoBoarding(ride, at_('07:14'), at('07:14')), false);
  assert.equal(canUndoBoarding(ride, at_('07:32'), at('07:32')), true);
  assert.equal(canUndoBoarding(ride, at_('07:27'), at('07:27')), false);

  // Live times by trip id; a departed vehicle keeps its dep; memory before schedules.
  const live = mergeTrips(
    { data: [{ attributes: { arrival_time: iso('07:29'), departure_time: null }, relationships: { trip: { data: { id: 'b1' } }, stop: { data: { id: transit[0].alight } } } }] },
    null);
  const sched = mergeTrips(null, { data: [{ attributes: { arrival_time: iso('07:31'), departure_time: iso('07:31') }, relationships: { trip: { data: { id: 'o1' } }, stop: { data: { id: transit[1].stop } } } }] });
  const memory = [new Map(), new Map([['o1', { dep: at('07:33'), arr: at('07:48') }]])];
  const legs = trackLegs(ride.legs, transit, [live, sched], memory);
  assert.deepEqual(legs.map(l => [l.dep, l.arr, l.source, l.arrSource]), [
    [at('07:12'), at('07:29'), 'scheduled', 'live'], [at('07:33'), at('07:48'), 'live', 'live']]);
  assert.deepEqual(trackLegs(ride.legs, transit, [], null), ride.legs);

  // Re-plan after missing leg 1 at 07:32: o2 (07:36) skipping o1; nothing after 08:00.
  assert.deepEqual(replanFrom([buses, trains], 1, at('07:32'), transfers, 'o1').map(v => v.tripId), ['o2']);
  assert.deepEqual(replanFrom([buses, trains], 0, at('07:13'), transfers, 'b1').map(v => v.tripId), ['b2', 'o3']);
  assert.equal(replanFrom([buses, trains], 1, at('08:01'), transfers), null);
});

test('Track this trip: pinned target', () => {
  const trip = homeToOffice;
  const buses = [veh('b1', '07:12', '07:26'), veh('b2', '07:40', '07:54')];
  const trains = [veh('o1', '07:31', '07:46'), veh('o3', '08:00', '08:15')];
  const rowsAt = (t, en) => tripRows(trip, [buses, trains], 0, at(t), 1, 4, en);
  const [r1, r2] = rowsAt('07:00', null);

  // From the normal list: kind 'track', no at-stop time.
  const tracked = pinTarget(null, r2, at('07:00'));
  assert.deepEqual([tracked.kind, tracked.pinned, tracked.target.key, tracked.atStop], ['track', true, 'b2', undefined]);
  assert.equal(enRouteStatus(tracked, at('07:00')), 'Tracking 132 7:40am');
  // Not re-targeted when b1 departs; boards at b2's departure; no 30-min cap before that.
  let s = advanceEnRoute(tracked, rowsAt('07:12', null), at('07:12'));
  assert.deepEqual([s.ride, s.target.key], [undefined, 'b2']);
  assert.equal(enRouteActive(s, 10, at('07:39')), true);
  s = advanceEnRoute(s, rowsAt('07:40', null), at('07:40'));
  assert.deepEqual([s.ride.boardedAt, s.ride.legs.map(l => l.tripId)], [at('07:40'), ['b2', 'o3']]);

  // Keeping an en-route state; "Leaving now" afterwards keeps the pin.
  const stop = startEnRoute('stop', at('07:05'), 5);
  const pinned = pinTarget(stop, r2, at('07:06'));
  assert.deepEqual([pinned.kind, pinned.atStop, pinned.target.key], ['stop', at('07:05'), 'b2']);
  const leaving = startEnRoute('leaving', at('07:08'), 5, tracked);
  assert.deepEqual([leaving.pinned, leaving.target.key], [true, 'b2']);
  // Unpinning: plain tracking ends; an en-route state stays, without the pin.
  assert.equal(unpinTarget(tracked), null);
  assert.deepEqual(unpinTarget(pinned), { kind: 'stop', at: stop.at, atStop: at('07:05') });
  assert.deepEqual([unpinTarget(leaving).kind, unpinTarget(leaving).pinned, unpinTarget(leaving).target], ['leaving', undefined, undefined]);
  // Pinned boards even if the at-stop estimate says it was unreachable.
  const late = pinTarget({ kind: 'leaving', at: at('07:10'), atStop: at('07:15') }, r1, at('07:10'));
  assert.equal(advanceEnRoute(late, rowsAt('07:12', late), at('07:12')).ride.boardedAt, at('07:12'));
});

test('transfer outlook, auto re-plan, and switching to a later vehicle', () => {
  const { transfers } = tripShape(homeToOffice); // transfer 5
  const buses = [veh('b1', '07:12', '07:26'), veh('b2', '07:40', '07:54')];
  const trains = [veh('o0', '07:28', '07:43'), veh('o1', '07:31', '07:46'), veh('o2', '07:36', '07:51'), veh('o3', '08:00', '08:15')];
  const leg = (v, route) => ({ route, label: route, color: null, tripId: v.tripId, dep: v.dep, arr: v.arr, source: 'scheduled' });
  const ride = (bus, train) => ({ boardedAt: bus.dep, legs: [leg(bus, 'Bus 132'), leg(train, 'Orange')] });
  const riding0 = { kind: 'riding', leg: 0 };
  const vs = [buses, trains];
  const now = at('07:20');

  // Comfortable / tight (b1 arrives 07:26 + 5 = 07:31).
  const ok = transferOutlook(ride(buses[0], trains[2]), riding0, [buses, [trains[0], trains[2], trains[3]]], transfers, now);
  assert.deepEqual([ok.leg, ok.margin, ok.missedDep, ok.none], [1, 5 * MIN, null, false]);
  assert.deepEqual(outlookText(ok, ride(buses[0], trains[2]), now), { text: 'Then Orange 7:36am · 5 min to spare', warn: false });
  const tight = transferOutlook(ride(buses[0], trains[1]), riding0, vs, transfers, now);
  assert.equal(outlookText(tight, ride(buses[0], trains[1]), now).text, 'Then Orange 7:31am · tight');
  // Missed (o0 leaves 07:28): earliest feasible after 07:31 is o1; never an earlier vehicle.
  const r = ride(buses[0], trains[0]);
  const missed = transferOutlook(r, riding0, vs, transfers, now);
  assert.deepEqual([missed.legs[1].tripId, missed.missedDep, missed.margin], ['o1', at('07:28'), 0]);
  assert.equal(outlookText(missed, r, now).text, 'Then Orange 7:31am (missed 7:28am)');
  // After the switch is stored, the text keeps saying what was missed.
  const stored = { ...r, legs: missed.legs, missed: { leg: 1, dep: at('07:28') } };
  assert.equal(outlookText(transferOutlook(stored, riding0, vs, transfers, now), stored, now).text, 'Then Orange 7:31am (missed 7:28am)');
  // Also during the transfer; nothing after the last train; no next leg.
  const late = { ...ride(buses[1], trains[3]), legs: [{ ...leg(buses[1], 'Bus 132'), arr: at('08:10') }, leg(trains[3], 'Orange')] };
  const none = transferOutlook(late, { kind: 'transfer', leg: 1 }, vs, transfers, now);
  assert.equal(none.none, true);
  assert.equal(outlookText(none, late, now).text, 'No connection after 8:15am');
  assert.equal(transferOutlook(r, { kind: 'riding', leg: 1 }, vs, transfers), null);
  assert.equal(transferOutlook(r, { kind: 'walking', leg: 2 }, vs, transfers), null);

  // Earlier connection: the planned o3 (8:00) still works, but o1 (7:31) is catchable: switch,
  // silently (no missedDep), even when tight.
  const slow = ride(buses[0], trains[3]);
  const earlier = transferOutlook(slow, riding0, vs, transfers, now);
  assert.deepEqual([earlier.earlier, earlier.legs[1].tripId, earlier.margin, earlier.missedDep], [true, 'o1', 0, null]);
  assert.equal(outlookText(earlier, slow, now).text, 'Then Orange 7:31am · tight');
  // Under EARLIER_MIN sooner: kept.
  const near = [buses, [veh('p1', '07:35', '07:50'), veh('p2', '07:36', '07:51')]];
  const kept = transferOutlook(ride(buses[0], near[1][1]), riding0, near, transfers, now);
  assert.deepEqual([kept.earlier, kept.legs[1].tripId], [undefined, 'p2']);
  // In the transfer with `needed` past: a vehicle that already left isn't picked.
  const waiting = ride(buses[0], trains[3]);
  const atPlatform = transferOutlook(waiting, { kind: 'transfer', leg: 1 }, vs, transfers, at('07:33'));
  assert.deepEqual([atPlatform.earlier, atPlatform.legs[1].tripId], [true, 'o2']);

  // Later vehicles of a leg: left after the assumed one, by now.
  assert.deepEqual(laterVehicles(buses, leg(buses[0], 'Bus 132'), at('07:45')).map(v => v.tripId), ['b2']);
  assert.deepEqual(laterVehicles(buses, leg(buses[0], 'Bus 132'), at('07:39')), []);
  // Switching re-plans the later legs from the new arrival (07:54 + 5 → o3 at 08:00).
  const sw = switchLeg(stored, 0, buses[1], vs, transfers);
  assert.deepEqual([sw.legs.map(l => l.tripId), sw.boardedAt, sw.missed], [['b2', 'o3'], at('07:40'), undefined]);
});

test('rideStops: remaining stops to the drop-off and the vehicle', () => {
  const pred = (stop, seq, t) => ({ attributes: { arrival_time: iso(t), departure_time: iso(t), stop_sequence: seq },
    relationships: { stop: { data: { id: stop } }, vehicle: { data: { id: 'v1' } } } });
  const stop = (id, name, parent) => ({ type: 'stop', id, attributes: { name },
    relationships: { parent_station: { data: parent ? { id: parent } : null } } });
  const vehicle = (status, seq) => ({ type: 'vehicle', id: 'v1', attributes: { current_status: status, current_stop_sequence: seq } });
  const doc = (v, ...extra) => ({
    data: [pred('70030', 120, '07:40'), pred('70026', 100, '07:35'), pred('70028', 110, '07:37'), pred('70036', 130, '07:44'), ...extra],
    included: [stop('70026', 'Sullivan Square', 'place-sull'), stop('70028', 'Malden Center', 'place-mlmnl'),
      stop('70030', 'Wellington', 'place-welln'), stop('70036', 'Oak Grove', 'place-ogmnl'), ...(v ? [v] : [])],
  });
  const r = rideStops(doc(vehicle('IN_TRANSIT_TO', 100)), 'place-ogmnl', at('07:30'));
  assert.deepEqual(r.vehicle, { status: 'IN_TRANSIT_TO', name: 'Sullivan Square' });
  assert.deepEqual(r.stops.map(x => [x.name, x.dropOff]), [
    ['Sullivan Square', false], ['Malden Center', false], ['Wellington', false], ['Oak Grove', true]]);
  assert.equal(r.stops[3].time, at('07:44'));
  // Drop-off by child id; stops after it are cut; stale entries skipped; no vehicle.
  const after = pred('70099', 140, '07:47');
  const r2 = rideStops(doc(null, after), '70030', at('07:36'));
  assert.deepEqual(r2.stops.map(x => x.name), ['Malden Center', 'Wellington']);
  assert.equal(r2.vehicle, null);
  // Stopped at a stop: named by the vehicle, not listed (kept while its departure is ahead).
  const stopped = rideStops(doc(vehicle('STOPPED_AT', 110)), 'place-ogmnl', at('07:30'));
  assert.equal(stopped.vehicle.name, 'Malden Center');
  assert.deepEqual(stopped.stops.map(x => x.name), ['Sullivan Square', 'Wellington', 'Oak Grove']);
  const dwell = { ...pred('70026', 100, '07:35'), attributes: { arrival_time: iso('07:35'), departure_time: iso('07:38'), stop_sequence: 100 } };
  const d = doc(null);
  d.data[1] = dwell;
  assert.equal(rideStops(d, 'place-ogmnl', at('07:37')).stops[0].name, 'Sullivan Square');
  assert.equal(rideStops(doc(null), 'place-state', at('07:30')), null);
  assert.equal(rideStops(null, 'place-ogmnl', at('07:30')), null);
});

test('timelineSteps: walks, legs, actual transfer gaps, arrival', () => {
  const buses = [veh('b1', '10:24', '10:34', 'live')];
  const trains = [veh('o1', '10:43', '10:57', 'live')];
  const [row] = tripRows(homeToOffice, [buses, trains], 0, at('10:00'), 1);
  const texts = steps => steps.map(s => (s.kind === 'leg' ? `[${s.leg.route} ${s.leg.source}]` : s.text));
  assert.deepEqual(texts(timelineSteps(row, homeToOffice, 1, at('10:00'))), [
    'Walk 5 min · 1 min early at the stop', '[132 live]', '9 min to transfer', '[Orange live]',
    'Walk 10 min · arrive 11:07am',
  ]);
  assert.equal(timelineSteps(row, homeToOffice, 0, at('10:00'))[0].text, 'Walk 5 min');
  // En route: no first walk.
  assert.equal(texts(timelineSteps({ ...row, enRoute: true }, homeToOffice, 1, at('10:00')))[0], '[132 live]');
  // No walks configured: slack only, then "Arrive".
  const bare = { legs: homeToOffice.legs.filter(l => l.kind !== 'walk') };
  const tight = { ...row, legs: [row.legs[0], { ...row.legs[1], dep: row.legs[0].arr + 30_000 }], eta: at('10:57') };
  assert.deepEqual(texts(timelineSteps(tight, bare, 1, at('10:00'))), [
    '1 min early at the stop', '[132 live]', '<1 min to transfer', '[Orange live]', 'Arrive 10:57am',
  ]);
  assert.equal(timelineSteps(tight, bare, 0, at('10:00'))[0].kind, 'leg');
});

test('tripRows: only the most recent missed ride', () => {
  const trip = { legs: [{ kind: 'walk', minutes: 5 }, homeToOffice.legs[1]] };
  const buses = [veh('b1', '07:30', '07:40'), veh('b2', '07:33', '07:43'), veh('b3', '07:50', '08:00')];
  assert.deepEqual(tripRows(trip, [buses], 0, at('07:36'), 1).map(r => [r.key, !!r.missed]), [['b2', true], ['b3', false]]);
});

test('rememberLive and withRemembered keep a departed ride on its last live time', () => {
  const live = [veh('b2', '07:42', '07:52', 'live')];
  let mem = rememberLive(null, [live], at('07:30'));
  // The prediction is gone after it leaves: the memory keeps it.
  mem = rememberLive(mem, [[]], at('07:43'));
  const scheduled = [veh('b2', '07:40', '07:50'), veh('b1', '07:41', '07:51'), veh('b3', '08:10', '08:20', 'live')];
  assert.deepEqual(withRemembered([scheduled], mem)[0].map(v => [v.tripId, v.dep, v.source]),
    [['b1', at('07:41'), 'scheduled'], ['b2', at('07:42'), 'live'], ['b3', at('08:10'), 'live']]);
  // A current prediction wins over the memory.
  const predicted = [veh('b2', '07:44', '07:54', 'live')];
  assert.equal(withRemembered([predicted], mem)[0][0].dep, at('07:44'));
  // Dropped 30 min after it left.
  assert.equal(rememberLive(mem, [[]], at('08:12'))[0].size, 0);
  assert.deepEqual(withRemembered([scheduled], null), [scheduled]);
});

test('countdownState boundaries', () => {
  const leave = at('08:00');
  const last = at('08:01');
  const dep = at('08:06');
  assert.equal(countdownState(at('07:56'), leave, last, dep), 'green');
  assert.equal(countdownState(at('07:57'), leave, last, dep), 'amber');
  assert.equal(countdownState(at('08:00'), leave, last, dep), 'red');
  assert.equal(countdownState(at('08:01'), leave, last, dep), 'missed');
  assert.equal(countdownState(at('08:15'), leave, last, dep), 'missed');
  assert.equal(countdownState(at('08:16'), leave, last, dep), 'hidden');
  assert.equal(countdownState(at('08:00'), null, last, dep), 'none');
});

test('retryDelayMs: 10 s doubling, capped at the poll interval', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(n => retryDelayMs(n, 120_000)), [10_000, 20_000, 40_000, 80_000, 120_000]);
  assert.equal(retryDelayMs(4, 60_000), 60_000);
});

test('rateLimitDelayMs: to the next whole minute + 1 s', () => {
  const m = Date.UTC(2026, 9, 5, 11, 0);
  assert.equal(rateLimitDelayMs(m), 61_000);
  assert.equal(rateLimitDelayMs(m + 20_000), 41_000);
  assert.equal(rateLimitDelayMs(m + 59_500), 1_500);
});

test('dataAgeText: the age once older than two poll intervals', () => {
  const t0 = at('07:00');
  assert.equal(dataAgeText(t0, 60_000, t0 + 114_000), null);
  assert.equal(dataAgeText(t0, 60_000, t0 + 150_000), '2 min ago');
  assert.equal(dataAgeText(t0, 120_000, t0 + 200_000), null);
  assert.equal(dataAgeText(t0, 120_000, t0 + 25 * 60_000), '25 min ago');
  assert.equal(dataAgeText(t0, 120_000, t0 + 65 * 60_000), '1h 05m ago');
});

test('shownStops: up to 6 as is; else next 3, the count, the last two; all when expanded', () => {
  const stops = n => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }));
  assert.deepEqual(shownStops(stops(6)), stops(6));
  assert.deepEqual(shownStops(stops(15)), [{ id: 's0' }, { id: 's1' }, { id: 's2' }, { more: 10 }, { id: 's13' }, { id: 's14' }]);
  assert.deepEqual(shownStops(stops(7)), [{ id: 's0' }, { id: 's1' }, { id: 's2' }, { more: 2 }, { id: 's5' }, { id: 's6' }]);
  assert.deepEqual(shownStops(stops(15), true), stops(15));
});

test('pageVersion and isNewerPage: the footer version of a fetched page', () => {
  const page = v => `<main><footer class="version">${v}</footer></main>`;
  assert.equal(pageVersion(page('Version 2026-10-02 · c712cb1543')), 'Version 2026-10-02 · c712cb1543');
  assert.equal(pageVersion('<h1>Not found</h1>'), null);
  assert.equal(isNewerPage(page('Version B'), 'Version A'), true);
  assert.equal(isNewerPage(page('Version A'), 'Version A'), false);
  assert.equal(isNewerPage('<h1>Application failed to respond</h1>', 'Version A'), false);
});

test('pullOffset: half the finger distance, capped, never negative', () => {
  assert.equal(pullOffset(0), 0);
  assert.equal(pullOffset(-30), 0);
  assert.equal(pullOffset(100), 50);
  assert.equal(pullOffset(500), PULL_MAX);
});

test('pollIntervalMs: 60s within 15 minutes of leave-by, otherwise 120s', () => {
  const dep = at('09:00');
  assert.equal(pollIntervalMs([{ leaveBy: at('08:45'), lastChance: dep }], at('08:30')), 60_000);
  assert.equal(pollIntervalMs([{ leaveBy: at('08:46'), lastChance: dep }], at('08:30')), 120_000);
  assert.equal(pollIntervalMs([], at('08:30')), 120_000);
});

test('fillRows tops up from the next service day without trip id collisions', () => {
  const trip = { legs: [{ kind: 'walk', minutes: 5 }, homeToOffice.legs[1]] };
  const tomorrow = hhmm => Date.parse(`2026-10-01T${hhmm}:00-04:00`);
  const today = [veh('b1', '23:32', '23:45')];
  // GTFS trip ids repeat across days: same id 'b1' tomorrow morning.
  const next = ['06:03', '06:33', '06:51'].map((t, i) => ({
    tripId: i === 0 ? 'b1' : `b${i + 1}`, dep: tomorrow(t), arr: tomorrow(t) + 10 * MIN, source: 'scheduled',
  }));
  const now = at('23:20');
  const rows = fillRows(tripRows(trip, [today], 0, now, 1), tripRows(trip, [next], 0, now, 1));
  assert.deepEqual(rows.map(r => r.key), ['b1', 'b1', 'b2', 'b3']);
  assert.deepEqual(rows.map(r => !!r.nextDay), [false, true, true, true]);
  assert.equal(rows[1].firstDep, tomorrow('06:03'));
  const full = [{ key: 'x' }, { key: 'y' }, { key: 'z' }];
  assert.deepEqual(fillRows(full, [{ key: 'n' }], 3).map(r => r.key), ['x', 'y', 'z']);
});

// ---------- alerts ----------

test('filterAlerts keeps service-impacting alerts on configured stops only', () => {
  const alert = (id, effect, entities, period = [{ start: iso('06:00'), end: null }]) => ({
    id, attributes: { effect, header: id, severity: 5, active_period: period, informed_entity: entities },
  });
  const alerts = doc([
    alert('jackson', 'STATION_ISSUE', [{ route: 'Orange', stop: 'place-jaksn' }]),
    alert('jackson-shuttle', 'SHUTTLE', [{ route: 'Orange', stop: 'place-jaksn' }]),
    alert('state-delay', 'DELAY', [{ route: 'Orange', stop: '70023' }]),
    alert('bus-detour', 'DETOUR', [{ route: '132' }]),
    alert('future', 'DETOUR', [{ route: '132' }], [{ start: iso('20:00'), end: null }]),
    alert('other-route', 'DELAY', [{ route: '137' }]),
  ]);
  const { routes, stops } = commuteEntities(officeToHome);
  const expanded = expandStops(stops, childToParentMap(doc([], [stopInc('70023', 'place-state')])));
  const ids = filterAlerts(alerts, routes, expanded, at('12:00')).map(a => a.id);
  assert.deepEqual(ids.sort(), ['bus-detour', 'state-delay']);
});

// ---------- formatting ----------

test('countdownLabel text per state', () => {
  assert.equal(countdownLabel('green', 12 * MIN + 30_000), 'Leave in 12 min');
  assert.equal(countdownLabel('amber', 150_000), 'Leave in 2 min');
  assert.equal(countdownLabel('amber', 59_000), 'Leave in <1 min');
  assert.equal(countdownLabel('red', 45_000), 'Hurry · <1 min');
  assert.equal(countdownLabel('missed', 150_000), 'Missed · leaves in 2 min');
  assert.equal(countdownLabel('missed', -30_000), 'Missed · <1 min ago');
  assert.equal(countdownLabel('missed', -3 * MIN - 10_000), 'Missed · 3 min ago');
  assert.equal(countdownLabel('none', 0), 'No connection');
});

test('windowLabel formats trip windows for the setup list', () => {
  assert.equal(windowLabel(null), 'When chosen');
  assert.equal(windowLabel({ from: '06:00', to: '12:00' }), '6:00am–12:00pm');
  assert.equal(windowLabel({ from: '12:00', to: '24:00' }), '12:00pm–midnight');
  assert.equal(windowLabel({ from: '22:30', to: '02:15' }), '10:30pm–2:15am');
  assert.equal(windowLabel({ from: '00:00', to: '09:05' }), 'midnight–9:05am');
});

test('formatCountdown shows whole minutes, rounding down', () => {
  assert.equal(formatCountdown(7 * MIN + 10_000), '7 min'); // 7:10 left → 7
  assert.equal(formatCountdown(8 * MIN - 1_000), '7 min');
  assert.equal(formatCountdown(8 * MIN), '8 min');
  assert.equal(formatCountdown(59_000), '<1 min');
  assert.equal(formatCountdown(0), '0 min');
  assert.equal(formatCountdown(-5), '0 min');
  assert.equal(formatCountdown(60 * MIN + 59_000), '1h 00m');
  assert.equal(formatCountdown(62 * MIN + 3_000), '1h 02m');
});

test('formatTime is compact with am/pm, adding the weekday only across a date change', () => {
  const now = at('23:20');
  assert.equal(formatTime(at('23:32'), now), '11:32pm');
  assert.equal(formatTime(Date.parse('2026-10-01T06:03:00-04:00'), now), 'Thu 6:03am');
  assert.equal(formatTime(at('23:32')), '11:32pm');
  assert.equal(formatTime(at('12:05')), '12:05pm');
  assert.equal(formatTime(Date.parse('2026-10-01T00:10:00-04:00')), '12:10am');
});

// ---------- config vs. API ----------

// /stops?filter[route]&filter[direction_id]&include=child_stops fixtures, in trip order,
// modeled on live responses (132 lists child street stops, Orange lists parent stations).
const stopsDoc = stops => ({
  data: stops.map(s => (typeof s === 'string' ? { id: s } : {
    id: s.id, relationships: { child_stops: { data: s.children.map(id => ({ id })) } },
  })),
});
const liveStops = () => new Map([
  [stopsKey('132', 1), stopsDoc(['25989', '25996', '5991', 'place-mlmnl'])],
  [stopsKey('132', 0), stopsDoc(['place-mlmnl', '9326', '15982', '15989'])],
  [stopsKey('Orange', 0), stopsDoc([
    { id: 'place-ogmnl', children: ['70036'] }, { id: 'place-state', children: ['70022', '70023'] }, 'place-forhl'])],
  [stopsKey('Orange', 1), stopsDoc([
    'place-forhl', { id: 'place-state', children: ['70022', '70023'] }, { id: 'place-ogmnl', children: ['70036'] }])],
]);

test('stopQueries lists unique route/direction pairs', () => {
  assert.deepEqual(stopQueries(EXAMPLE).map(q => stopsKey(q.route, q.direction_id)).sort(),
    ['132/0', '132/1', 'Orange/0', 'Orange/1']);
});

test('checkStops accepts the example config and child platform ids', () => {
  assert.deepEqual(checkStops(EXAMPLE, liveStops()), []);
  const cfg = structuredClone(EXAMPLE);
  cfg.trips[1].legs[1].stop = '70023';
  assert.deepEqual(checkStops(cfg, liveStops()), []);
});

test('checkStops reports unknown stops, wrong direction, and unknown routes', () => {
  const badStop = structuredClone(EXAMPLE);
  badStop.trips[1].legs[3].stop = '99999';
  assert.deepEqual(checkStops(badStop, liveStops()),
    ['Trip "Office to home": route 132: stop "99999" is not served by route 132 in direction 0.']);
  // `only` checks a subset of trips but still labels them against the full list.
  assert.deepEqual(checkStops(badStop, liveStops(), [0]), []);
  assert.deepEqual(checkStops(badStop, liveStops(), [1]),
    ['Trip "Office to home": route 132: stop "99999" is not served by route 132 in direction 0.']);
  assert.deepEqual(stopQueries(badStop, [1]).map(q => stopsKey(q.route, q.direction_id)).sort(), ['132/0', 'Orange/1']);

  const swapped = structuredClone(EXAMPLE);
  swapped.trips[1].legs[1].direction_id = 0;
  assert.deepEqual(checkStops(swapped, liveStops()),
    ['Trip "Office to home": route Orange: stop "place-state" comes after alight "place-ogmnl" in direction 0; direction_id is probably wrong.']);

  const badRoute = structuredClone(EXAMPLE);
  badRoute.trips[0].legs[1].route = '999x';
  const errors = checkStops(badRoute, new Map([...liveStops(), [stopsKey('999x', 1), stopsDoc([])]]));
  assert.deepEqual(errors, ['Trip "Home to office": route 999x: no stops for route "999x" in direction 1; check route and direction_id.']);
});

test('tripLabel uses the name, adding the position for missing or shared names', () => {
  const trips = [{ name: 'Home' }, { name: 'Work' }, { name: ' Home ' }, { name: '' }, {}];
  assert.equal(tripLabel(trips, 1), 'Trip "Work"');
  assert.equal(tripLabel(trips, 0), 'Trip 1 "Home"');
  assert.equal(tripLabel(trips, 2), 'Trip 3 "Home"');
  assert.equal(tripLabel(trips, 3), 'Trip 4');
  assert.equal(tripLabel(trips, 4), 'Trip 5');
  assert.deepEqual(validateConfig({ trips: [{ legs: [] }] }),
    ['Trip 1: name is required.', 'Trip 1: needs at least one transit leg.']);
});

// ---------- setup form model ----------

test('tripToForm / formToTrip round-trip the example and simpler shapes', () => {
  for (const trip of EXAMPLE.trips) assert.deepEqual(formToTrip(tripToForm(trip)), trip);
  const form = tripToForm(officeToHome);
  assert.equal(form.walkBefore, 10);
  assert.equal(form.walkAfter, 5);
  assert.deepEqual(form.transit.map(t => [t.route, t.transferBefore]), [['Orange', 0], ['132', 5]]);

  const single = { name: 'Bus', legs: [homeToOffice.legs[1]] };
  assert.deepEqual(formToTrip(tripToForm(single)), single);
  // A missing transfer stays missing; a pinned timing leg survives.
  const route = r => ({ kind: 'transit', route: r, direction_id: 0, stop: `${r}-in`, alight: `${r}-out` });
  const three = { name: 'Three', timingLeg: 2, legs: [{ kind: 'walk', minutes: 2 }, route('A'), route('B'),
    { kind: 'transfer', minutes: 4 }, route('C')] };
  assert.deepEqual(formToTrip(tripToForm(three)), three);
});

test('routeLabel and searchRoutes', () => {
  const r = (id, type, short, long, order) => ({ id, attributes: { type, short_name: short, long_name: long, sort_order: order } });
  const routes = [r('132', 3, '132', 'Redstone Shopping Center - Malden Center Station', 51320),
    r('Orange', 1, '', 'Orange Line', 10020), r('Green-B', 0, 'B', 'Green Line B', 10032)];
  assert.deepEqual(routes.map(routeLabel), ['132', 'Orange Line', 'Green Line B']);
  assert.deepEqual(searchRoutes(routes).map(x => x.id), ['Orange', 'Green-B', '132']);
  assert.deepEqual(searchRoutes(routes, 'orange').map(x => x.id), ['Orange']);
  assert.deepEqual(searchRoutes(routes, ' MALDEN ').map(x => x.id), ['132']);
  assert.deepEqual(searchRoutes(routes, '13').map(x => x.id), ['132']);
  assert.deepEqual(searchRoutes(routes, 'bus').map(x => x.id), ['132']);
});

test('routeEnds', () => {
  const r = (type, long, dd) => ({ attributes: { type, long_name: long, direction_destinations: dd } });
  assert.equal(routeEnds(r(3, 'Redstone Shopping Center - Malden Center Station', ['Redstone', 'Malden Center'])),
    'Redstone Shopping Center - Malden Center Station');
  assert.equal(routeEnds(r(1, 'Orange Line', ['Forest Hills', 'Oak Grove'])), 'Forest Hills - Oak Grove');
  assert.equal(routeEnds(r(0, 'Green Line B', ['Boston College', 'Government Center'])), 'Boston College - Government Center');
  assert.equal(routeEnds(r(1, 'Orange Line', undefined)), '');
  const routes = [{ id: 'Red', attributes: { type: 1, long_name: 'Red Line', direction_destinations: ['Ashmont/Braintree', 'Alewife'] } }];
  assert.deepEqual(searchRoutes(routes, 'alewife').map(x => x.id), ['Red']);
});

test('shortRouteLabel and labelLegs', () => {
  const r = (id, type, short, long, color) => ({ id, attributes: { type, short_name: short, long_name: long, color } });
  const routes = [r('132', 3, '132', 'Redstone Shopping Center - Malden Center Station', 'FFC72C'),
    r('741', 3, 'SL1', 'Logan Airport Terminals - South Station', '7C878E'),
    r('708', 3, 'CT3', 'Beth Israel Deaconess Hospital - Andrew Station', 'FFC72C'),
    r('Orange', 1, '', 'Orange Line', 'ED8B00'), r('Green-B', 0, 'B', 'Green Line B', '00843D'),
    r('Mattapan', 0, '', 'Mattapan Line', 'DA291C')];
  assert.deepEqual(routes.map(shortRouteLabel), ['Bus 132', 'Silver SL1', 'Bus CT3', 'Orange', 'Green B', 'Mattapan']);

  const labeled = labelLegs(EXAMPLE, routes);
  assert.deepEqual(labeled.trips[0].legs.filter(l => l.kind === 'transit').map(l => [l.label, l.color]),
    [['Bus 132', 'FFC72C'], ['Orange', 'ED8B00']]);
  assert.deepEqual(validateConfig(labeled), []);
  // Unknown routes keep their stored look; stale labels are refreshed.
  const stale = structuredClone(labeled);
  stale.trips[0].legs[1].label = 'old';
  assert.equal(labelLegs(stale, routes).trips[0].legs[1].label, 'Bus 132');
  assert.equal(labelLegs(stale, []).trips[0].legs[1].label, 'old');
  // Labels and colors survive the setup form and reversing.
  for (const trip of labeled.trips) assert.deepEqual(formToTrip(tripToForm(trip)), trip);
  assert.deepEqual(reverseTrip(labeled.trips[0]).legs.filter(l => l.kind === 'transit').map(l => l.label), ['Orange', 'Bus 132']);
  const bad = structuredClone(labeled);
  bad.trips[0].legs[1].color = 'orange';
  assert.ok(validateConfig(bad).some(e => e.includes('.color')));
});

test('multi-route legs (also): config, labels, queries, vehicles', () => {
  const leg = { kind: 'transit', route: 'Green-B', also: ['Green-C', 'Green-D'], direction_id: 0, stop: 'place-gover', alight: 'place-pktrm' };
  const cfg = { trips: [{ name: 'Green', legs: [leg] }] };
  assert.deepEqual(validateConfig(cfg), []);
  assert.deepEqual(legRoutes(leg), ['Green-B', 'Green-C', 'Green-D']);
  assert.deepEqual([...commuteEntities(cfg.trips[0]).routes], ['Green-B', 'Green-C', 'Green-D']);
  assert.deepEqual(stopQueries(cfg).map(q => q.route), ['Green-B', 'Green-C', 'Green-D']);
  const bad = structuredClone(cfg);
  bad.trips[0].legs[0].also = ['Green-B'];
  assert.ok(validateConfig(bad).some(e => e.includes('.also')));
  // Labels: the shared part for the leg, each route's own for its vehicles.
  const route = (id, long) => ({ id, attributes: { type: 0, long_name: long, color: '00843D' } });
  const labeled = labelLegs(cfg, [route('Green-B', 'Green Line B'), route('Green-C', 'Green Line C'), route('Green-D', 'Green Line D')]).trips[0].legs[0];
  assert.deepEqual([labeled.label, labeled.color, labeled.routeLabels], ['Green', '00843D', { 'Green-B': 'Green B', 'Green-C': 'Green C', 'Green-D': 'Green D' }]);
  assert.deepEqual(formToTrip(tripToForm({ name: 'Green', legs: [labeled] })).legs[0], labeled);
  // Stop check covers every route: Green-D missing its stop list.
  const sd = ids => ({ data: ids.map(id => ({ id })) });
  const byKey = new Map([['Green-B/0', sd(['place-gover', 'place-pktrm'])], ['Green-C/0', sd(['place-gover', 'place-pktrm'])]]);
  assert.deepEqual(checkStops(cfg, byKey).length, 1);
  assert.ok(checkStops(cfg, byKey)[0].includes('Green-D'));
  // Vehicles carry their route; the planned leg names it.
  const routed = (r, route) => ({ ...r, relationships: { ...r.relationships, route: { data: { id: route } } } });
  const sched = doc([routed(rec('schedule', 't1', 'place-gover', '07:00', '07:00'), 'Green-D'), routed(rec('schedule', 't1', 'place-pktrm', '07:02', '07:02'), 'Green-D')]);
  const [v] = legVehicles(mergeTrips(null, sched), leg);
  assert.equal(v.route, 'Green-D');
  const planned = onVehicle({ label: 'Green', routeLabels: labeled.routeLabels }, v);
  assert.equal(vehicleLabel(planned), 'Green D');
  assert.equal(vehicleLabel({ label: 'Orange' }), 'Orange');
  assert.equal(servesInOrder(sd(['a', 'b', 'c']), 'a', 'c'), true);
  assert.equal(servesInOrder(sd(['a', 'b', 'c']), 'c', 'a'), false);
});

test('rail network: station search, reachable stations per branch, legs between stations', () => {
  const net = railNetwork(JSON.parse(readFileSync('test/browser/fixtures/rail-network.json', 'utf8')),
    JSON.parse(readFileSync('test/browser/fixtures/routes.json', 'utf8')).data);
  assert.deepEqual(net.lines.map(l => l.label), ['Red', 'Mattapan', 'Orange', 'Green B', 'Green C', 'Green D', 'Green E', 'Blue']);
  assert.deepEqual(networkStation(net, '70036')?.id, 'place-ogmnl'); // a platform
  assert.equal(networkStation(net, '5991'), null); // a bus stop
  assert.deepEqual(searchStations(net, 'park').map(s => s.name).slice(0, 1), ['Park Street']);
  assert.deepEqual(searchStations(net, ''), []);
  assert.ok(railStopsFrom(net).find(l => l.route === 'Orange').stops.some(s => s.id === 'place-ogmnl'));

  const brief = groups => groups.map(g => [g.label, g.direction, g.toward.join('/'), g.stations.length]);
  // Oak Grove: the end of the line, one way.
  assert.deepEqual(brief(reachableFrom(net, 'place-ogmnl')), [['Orange', 0, 'Forest Hills', 19]]);
  // JFK/UMass southbound: both branches in one group; Ashmont never reaches Quincy.
  const jfk = reachableFrom(net, 'place-jfk');
  assert.deepEqual(brief(jfk)[0], ['Red', 0, 'Braintree/Ashmont', 9]);
  assert.ok(!reachableFrom(net, 'place-asmnl').some(g => g.stations.some(s => s.id === 'place-qnctr')));
  assert.equal(legBetween(net, 'place-asmnl', 'place-qnctr'), null);
  // Government Center → Park Street: any Green branch; Kenmore only on some.
  const gov = reachableFrom(net, 'place-gover').find(g => g.label === 'Green' && g.direction === 0);
  assert.deepEqual(gov.stations.find(s => s.id === 'place-pktrm').routes, ['Green-B', 'Green-C', 'Green-D', 'Green-E']);
  assert.deepEqual(gov.stations.find(s => s.id === 'place-kencl').routes, ['Green-B', 'Green-C', 'Green-D']);
  assert.deepEqual(legBetween(net, 'place-gover', 'place-pktrm'), { route: 'Green-B', also: ['Green-C', 'Green-D', 'Green-E'], direction: 0 });
  assert.deepEqual(legBetween(net, '70036', 'place-dwnxg'), { route: 'Orange', also: [], direction: 0 });
  assert.deepEqual(legBetween(net, 'place-dwnxg', 'place-ogmnl'), { route: 'Orange', also: [], direction: 1 });
  // Trimming routes keeps at least one, the first kept becoming primary.
  const leg = { route: 'Green-B', also: ['Green-C', 'Green-D'] };
  assert.deepEqual(trimRoutes(leg, ['Green-C', 'Green-D']), { route: 'Green-C', also: ['Green-D'] });
  assert.deepEqual(trimRoutes(leg, []), { route: 'Green-B', also: ['Green-C', 'Green-D'] });
});

test('commonLabel: shared words, then the rest', () => {
  assert.equal(commonLabel(['Green B', 'Green C', 'Green D', 'Green E']), 'Green B/C/D/E');
  assert.equal(commonLabel(['Green B', 'Green D'], true), 'Green');
  assert.equal(commonLabel(['Bus 136', 'Bus 137'], true), 'Bus 136/137');
  assert.equal(commonLabel(['Silver SL1', 'Silver SL2'], true), 'Silver SL1/SL2');
  assert.equal(commonLabel(['Orange', 'Bus 132'], true), 'Orange/Bus 132');
  assert.equal(commonLabel(['Orange', 'Orange']), 'Orange');
  assert.equal(commonLabel([]), '');
});

test('railConnections: same station or within 200 m, own routes left out, branches merged', () => {
  const st = (id, lat, lon) => ({ id, lat, lon });
  const rail = [
    { route: 'Orange', label: 'Orange', color: 'ED8B00', stops: [st('place-ogmnl', 42.43668, -71.07097), st('place-haecl', 42.36279, -71.05829)] },
    { route: 'Green-C', label: 'Green C', color: '00843D', stops: [st('place-haecl', 42.36279, -71.05829)] },
    { route: 'Green-D', label: 'Green D', color: '00843D', stops: [st('place-haecl', 42.36279, -71.05829)] },
    { route: 'Red', label: 'Red', color: 'DA291C', stops: [st('place-pktrm', 42.35639, -71.0624)] },
  ];
  const stop = (id, lat, lon) => ({ id, attributes: { latitude: lat, longitude: lon } });
  // A bus stop across the street from Oak Grove (~30 m).
  assert.deepEqual(railConnections(stop('5991', 42.436927, -71.071292), rail), [{ label: 'Orange', color: 'ED8B00' }]);
  assert.deepEqual(railConnections(stop('5991', 42.436927, -71.071292), rail, ['Orange']), []);
  // Haymarket: the station itself (no coordinates needed), Green branches merged.
  assert.deepEqual(railConnections(stop('place-haecl'), rail, ['Orange']), [{ label: 'Green C/D', color: '00843D' }]);
  // ~700 m from Park Street: none.
  assert.deepEqual(railConnections(stop('x', 42.3627, -71.0624), rail), []);
  // Stations connect by id only: State and Government Center are ~155 m apart.
  const blue = [
    { route: 'Blue', label: 'Blue', color: '003DA5', stops: [st('place-state', 42.358978, -71.057598), st('place-gover', 42.359705, -71.059215)] },
    { route: 'Orange', label: 'Orange', color: 'ED8B00', stops: [st('place-state', 42.358978, -71.057598)] },
    { route: 'Green-B', label: 'Green B', color: '00843D', stops: [st('place-gover', 42.359705, -71.059215)] },
  ];
  assert.deepEqual(railConnections(stop('place-state', 42.358978, -71.057598), blue, ['Blue']), [{ label: 'Orange', color: 'ED8B00' }]);
  assert.deepEqual(railConnections(stop('place-gover', 42.359705, -71.059215), blue, ['Blue']), [{ label: 'Green B', color: '00843D' }]);
  // A bus stop between them still sees both.
  assert.deepEqual(railConnections(stop('bus', 42.3593, -71.0584), blue).map(c => c.label), ['Blue', 'Orange', 'Green B']);
});

test('boardGroups and alightGroups: no direction step', () => {
  const s = (id, children = []) => ({ id, attributes: { name: id }, relationships: { child_stops: { data: children.map(c => ({ id: c })) } } });
  // Orange: parent stations in both directions; Oak Grove is a terminus.
  const orange0 = { data: [s('place-ogmnl', ['70036']), s('place-mlmnl'), s('place-welln'), s('place-forhl')] };
  const orange1 = { data: [s('place-forhl'), s('place-welln'), s('place-mlmnl'), s('place-ogmnl', ['70035'])] };
  const g = boardGroups(orange0, orange1);
  assert.deepEqual(g.both.map(x => x.id), ['place-ogmnl', 'place-mlmnl', 'place-welln', 'place-forhl']);
  assert.deepEqual(g.only, [[], []]);
  const fromOak = alightGroups(orange0, orange1, 'place-ogmnl');
  assert.deepEqual(fromOak.map(x => [x.direction, x.stops.map(y => y.id)]), [[0, ['place-mlmnl', 'place-welln', 'place-forhl']]]);
  assert.deepEqual(alightGroups(orange0, orange1, '70036')[0].stops.length, 3); // child platform id
  assert.deepEqual(alightGroups(orange0, orange1, 'place-mlmnl').map(x => [x.direction, x.stops.length]), [[0, 2], [1, 1]]);
  // Bus: shared terminal, separate sides of the street.
  const bus0 = { data: [s('T'), s('a0'), s('b0'), s('M')] };
  const bus1 = { data: [s('M'), s('b1'), s('a1'), s('T')] };
  const b = boardGroups(bus0, bus1);
  assert.deepEqual([b.both.map(x => x.id), b.only.map(l => l.map(x => x.id))], [['T', 'M'], [['a0', 'b0'], ['b1', 'a1']]]);
  assert.deepEqual(alightGroups(bus0, bus1, 'b1').map(x => [x.direction, x.stops.map(y => y.id)]), [[1, ['a1', 'T']]]);
  assert.deepEqual(alightGroups(bus0, bus1, 'nope'), []);
  assert.deepEqual(boardGroups(null, bus1).only[1].length, 4);
});

test('searchStops, stopsAfter, and defaultTransferMinutes', () => {
  const s = (id, name) => ({ id, attributes: { name } });
  const stops = [s('25989', 'Redstone Shopping Center Access Rd'), s('25996', 'Main St @ South St'),
    s('5991', 'Washington St opp Oak Grove Sta'), s('place-mlmnl', 'Malden Center')];
  assert.deepEqual(searchStops(stops, 'main st').map(x => x.id), ['25996']);
  assert.equal(searchStops(stops, '').length, 4);
  assert.deepEqual(stopsAfter(stops, '25996').map(x => x.id), ['5991', 'place-mlmnl']);
  assert.deepEqual(stopsAfter(stops, 'nope'), []);

  const parentOf = new Map([['70036', 'place-ogmnl'], ['70023', 'place-state']]);
  assert.equal(defaultTransferMinutes('70036', 'place-ogmnl', parentOf), 3);
  assert.equal(defaultTransferMinutes('5991', 'place-ogmnl', parentOf), 5);
  assert.equal(defaultTransferMinutes(null, 'place-ogmnl', parentOf), 5);
});

test('reverseTrip flips legs, directions, stops, and walks', () => {
  const back = reverseTrip(homeToOffice);
  assert.deepEqual(back, {
    name: 'Home to office (return)',
    legs: [
      { kind: 'walk', minutes: 10 },
      { kind: 'transit', route: 'Orange', direction_id: 1, stop: 'place-state', alight: 'place-ogmnl' },
      { kind: 'transfer', minutes: 5 },
      { kind: 'transit', route: '132', direction_id: 0, stop: '5991', alight: '25996' },
      { kind: 'walk', minutes: 5 },
    ],
  });
  // Transfers stay between the same pair of legs; a pinned timing leg follows its leg.
  const route = r => ({ kind: 'transit', route: r, direction_id: 0, stop: `${r}-in`, alight: `${r}-out` });
  const three = { name: 'T', timingLeg: 0, legs: [route('A'), { kind: 'transfer', minutes: 2 }, route('B'),
    { kind: 'transfer', minutes: 7 }, route('C')] };
  const r3 = reverseTrip(three);
  assert.deepEqual(r3.legs.map(l => (l.kind === 'transit' ? l.route : l.minutes)), ['C', 7, 'B', 2, 'A']);
  assert.equal(r3.timingLeg, 2);
});

test('nearestStop picks the closest stop with coordinates', () => {
  const s = (id, lat, lon) => ({ id, attributes: { latitude: lat, longitude: lon } });
  // Bus stop 5991 at Oak Grove; the Orange Line station is ~30 m away.
  const orange = [s('place-mlmnl', 42.426632, -71.07411), s('place-ogmnl', 42.43668, -71.071097), s('nocoords', null, null)];
  assert.equal(nearestStop(orange, 42.436927, -71.071292).id, 'place-ogmnl');
  assert.equal(nearestStop([], 42.4, -71.0), null);
});
