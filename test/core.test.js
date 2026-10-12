import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateConfig, tripShape, scheduleWindow, mergeTrips, legVehicles, averageHeadway, pickTimingLeg,
  tripRows, rememberLive, withRemembered, rowState, timelineSteps, stopNames, startEnRoute, tripStarted, pinTarget, isSubwayRoute, predictionsFirst, tripVehicles, subwayHeadway, legTime, sourceText, unpinTarget, advanceEnRoute, enRouteActive, enRouteStatus, trackLegs, ridePhase, canUndoBoarding, replanFrom, rideHeadline, rideStops, getOffText, shownStops, transferOutlook, outlookText, otherVehicles, connectionChoices, vehicleNoun, previousRides, switchLeg, rideAlertStep, rideAlertText, checkRide, pickTrip, inWindow, countdownState, pollIntervalMs, dataAgeText, retryDelayMs, rateLimitDelayMs, pullOffset, PULL_MAX, pageVersion, isNewerPage,
  filterAlerts, expandStops, childToParentMap, commuteEntities, formatCountdown, countdownLabel, statusProblem, rowAriaLabel, formatDistance, routeDistances, byDistance, trimStopsDoc, isStale,
  nextServiceWindow, fillRows, formatTime, departureCount, stopSlackMinutes, wakeMinutes, keepAwake, keepAwakeRiding, stopQueries, checkStops, stopsKey, tripLabel,
  tripToForm, formToTrip, locateLegs, distanceMeters, pickByLocation, routeLabel, routeEnds, searchRoutes, searchStops, stopsAfter, boardGroups, dropOffGroups, alightGroups, stopPairs, normalStopName, commonLabel, railConnections, servesInOrder, legRoutes, vehicleLabel, onVehicle,
  railNetwork, networkStation, railStopsFrom, searchStations, reachableFrom, legBetween, trimRoutes, planRoutes, planToForm, transitNetwork, planTrips, pointEnds, nextWeekday, optionToForm, defaultTransferMinutes,
  reverseTrip, nearestStop, windowLabel, shortRouteLabel, labelLegs,
  MBTA_PROXY_PATHS, CACHE_CLASSES, proxyRequestError, mbtaCacheKey, rideStopsQuery,
  legQuery, rowsFromDocs, reminderStep, reminderText, reminderPollMs, headsUpDue, HEADS_UP_MIN, UPDATE_MIN, testPushText,
  lineLabel, toward, withoutArrived, stopConnections,
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

test('validateConfig: no trips is valid (settings kept); trips must be an array', () => {
  assert.deepEqual(validateConfig({ trips: [], apiKey: 'k', departureCount: 3 }), []);
  assert.deepEqual(validateConfig({ apiKey: 'k' }), ['trips must be an array.']);
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

test('tripStarted: leaving, at the stop or a ride; not plain tracking', () => {
  const row = { key: 'b1', legs: [] };
  assert.equal(tripStarted(null), false);
  const tracked = pinTarget(null, row, at('07:00'));
  assert.equal(tripStarted(tracked), false);
  assert.equal(tripStarted(startEnRoute('leaving', at('07:01'), 5, tracked)), true);
  assert.equal(tripStarted(startEnRoute('stop', at('07:01'), 5)), true);
  assert.equal(tripStarted({ ...tracked, ride: { legs: [], boardedAt: at('07:08') } }), true);
  assert.equal(tripStarted({ kind: 'track', at: at('07:00'), ride: { legs: [], boardedAt: at('07:08') } }), true);
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
  // From the last chance until 5 min after it leaves: missed, first, counting toward `count`.
  const missedAt = t => tripRows(trip, [buses], 0, at(t), 1).map(r => [r.key, !!r.missed]);
  assert.deepEqual(missedAt('07:35'), [['b2', true], ['b3', false]]);
  assert.deepEqual(missedAt('07:44'), [['b2', true], ['b3', false]]);
  assert.deepEqual(missedAt('07:45'), [['b3', false]]);
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
  // for b1, so b1 is missed (until 5 min after o2 leaves), shown first.
  const late = tripRows(officeToHome, [trains, buses], 1, at('17:08'), 1);
  assert.deepEqual(late.map(r => [r.key, !!r.missed]), [['b1', true], ['b2', false], ['b3', false]]);
  assert.equal(late[0].firstDep, at('17:16'));
  assert.deepEqual(tripRows(officeToHome, [trains, buses], 1, at('17:21'), 1).map(r => r.key), ['b2', 'b3']);
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
  assert.equal(rideHeadline(at_('07:20'), ride, at('07:20')), '132 · 6 min'); // no stop list: minutes only
  const st = (n, vehicle = null) => ({ vehicle, stops: Array.from({ length: n }, (_, k) => ({ name: `S${k}`, dropOff: k === n - 1 })) });
  assert.equal(rideHeadline(at_('07:20'), ride, at('07:20'), st(9)), '132 · 9 stops · 6 min');
  assert.equal(rideHeadline(at_('07:20'), ride, at('07:25') + 30_000, st(2)), '132 · 2 stops · <1 min');
  // Only the drop-off left: the cue to get off instead.
  assert.equal(rideHeadline(at_('07:20'), ride, at('07:25'), st(1)), 'Next stop: get off');
  assert.equal(rideHeadline(at_('07:20'), ride, at('07:26'), st(1, { status: 'STOPPED_AT', name: 'S0', atDropOff: true })), 'Get off here');
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
  assert.deepEqual(outlookText(ok, ride(buses[0], trains[2]), now), { text: 'Then Orange Line 7:36am · 5 min to spare', warn: false });
  const tight = transferOutlook(ride(buses[0], trains[1]), riding0, vs, transfers, now);
  assert.equal(outlookText(tight, ride(buses[0], trains[1]), now).text, 'Then Orange Line 7:31am · tight');
  // Under the transfer time but after the arrival (o0 leaves 07:28, b1 arrives 07:26): kept, tight
  // (the transfer time is an estimate).
  const r0 = ride(buses[0], trains[0]);
  const short = transferOutlook(r0, riding0, vs, transfers, now);
  assert.deepEqual([short.legs[1].tripId, short.missedDep, short.margin], ['o0', null, -3 * MIN]);
  assert.equal(outlookText(short, r0, now).text, 'Then Orange Line 7:28am · tight');
  // Missed: leaves before the arrival (z0 at 07:25); earliest feasible after 07:31 is o1, never an earlier vehicle.
  const z0 = veh('z0', '07:25', '07:40');
  const r = ride(buses[0], z0);
  const missed = transferOutlook(r, riding0, [buses, [z0, ...trains]], transfers, now);
  assert.deepEqual([missed.legs[1].tripId, missed.missedDep, missed.margin], ['o1', at('07:25'), 0]);
  assert.equal(outlookText(missed, r, now).text, 'Then Orange Line 7:31am (missed 7:25am)');
  // After the switch is stored, the text keeps saying what was missed.
  const stored = { ...r, legs: missed.legs, missed: { leg: 1, dep: at('07:25') } };
  assert.equal(outlookText(transferOutlook(stored, riding0, vs, transfers, now), stored, now).text, 'Then Orange Line 7:31am (missed 7:25am)');
  // Also missed: already left (during the transfer, o0 at 07:28 seen at 07:29).
  assert.equal(transferOutlook(r0, { kind: 'transfer', leg: 1 }, vs, transfers, at('07:29')).missedDep, at('07:28'));
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
  assert.equal(outlookText(earlier, slow, now).text, 'Then Orange Line 7:31am · tight');
  // Under EARLIER_MIN sooner: kept.
  const near = [buses, [veh('p1', '07:35', '07:50'), veh('p2', '07:36', '07:51')]];
  const kept = transferOutlook(ride(buses[0], near[1][1]), riding0, near, transfers, now);
  assert.deepEqual([kept.earlier, kept.legs[1].tripId], [undefined, 'p2']);
  // The rider's pick (`picked`) is kept even with an earlier catchable vehicle.
  const pickedRide = { ...slow, legs: [slow.legs[0], { ...slow.legs[1], picked: true }] };
  const keptPick = transferOutlook(pickedRide, riding0, vs, transfers, now);
  assert.deepEqual([keptPick.earlier, keptPick.legs[1].tripId], [undefined, 'o3']);
  // In the transfer with `needed` past: a vehicle that already left isn't picked.
  const waiting = ride(buses[0], trains[3]);
  const atPlatform = transferOutlook(waiting, { kind: 'transfer', leg: 1 }, vs, transfers, at('07:33'));
  assert.deepEqual([atPlatform.earlier, atPlatform.legs[1].tripId], [true, 'o2']);

  // Other vehicles of a leg: left in the last 15 min, earlier or later than the assumed one.
  assert.deepEqual(otherVehicles(buses, leg(buses[0], 'Bus 132'), at('07:45')).map(v => v.tripId), ['b2']);
  assert.deepEqual(otherVehicles(buses, leg(buses[0], 'Bus 132'), at('07:39')), []);
  assert.deepEqual(otherVehicles(trains, leg(trains[1], 'Orange'), at('07:37')).map(v => v.tripId), ['o0', 'o2']);
  assert.deepEqual(otherVehicles(trains, leg(trains[1], 'Orange'), at('07:44')).map(v => v.tripId), ['o2']); // o0 left 16 min ago
  assert.deepEqual([vehicleNoun(leg(buses[0], 'Bus 132')), vehicleNoun(leg(trains[0], 'Orange')), vehicleNoun({ label: 'Silver SL1' })], ['bus', 'train', 'bus']);
  // Switching re-plans the later legs from the new arrival (07:54 + 5 → o3 at 08:00); the switched
  // leg is the rider's pick, the re-planned ones aren't.
  const sw = switchLeg(stored, 0, buses[1], vs, transfers);
  assert.deepEqual([sw.legs.map(l => l.tripId), sw.boardedAt, sw.missed], [['b2', 'o3'], at('07:40'), undefined]);
  assert.deepEqual(sw.legs.map(l => l.picked), [true, undefined]);
  const sw2 = switchLeg(sw, 1, trains[3], vs, transfers);
  assert.deepEqual(sw2.legs.map(l => l.picked), [true, true]);
  assert.equal('picked' in onVehicle(sw2.legs[1], trains[2]), false); // a new vehicle isn't the pick
  // Connection choices: up to 4 of the next leg from a time, other than the planned one.
  const many = [...trains, veh('o4', '08:10', '08:25'), veh('o5', '08:20', '08:35')];
  assert.deepEqual(connectionChoices(many, leg(trains[2], 'Orange'), at('07:29')).map(v => v.tripId), ['o1', 'o3', 'o4', 'o5']);
  assert.deepEqual(connectionChoices(trains, leg(trains[3], 'Orange'), at('07:26')).map(v => v.tripId), ['o0', 'o1', 'o2']);
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
  assert.deepEqual(r.vehicle, { status: 'IN_TRANSIT_TO', name: 'Sullivan Square', atDropOff: false });
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
  // Stopped at the drop-off (a child platform of it).
  assert.equal(rideStops(doc(vehicle('STOPPED_AT', 130)), 'place-ogmnl', at('07:30')).vehicle.atDropOff, true);
  assert.equal(rideStops(doc(vehicle('IN_TRANSIT_TO', 130)), 'place-ogmnl', at('07:30')).vehicle.atDropOff, false);
});

test('getOffText: only with the drop-off left; "Get off here" while stopped there', () => {
  const s = (name, dropOff = false) => ({ id: name, name, time: 0, dropOff });
  const three = [s('Sullivan Square'), s('Wellington'), s('Oak Grove', true)];
  assert.equal(getOffText({ vehicle: { status: 'STOPPED_AT', name: 'Malden Center', atDropOff: false }, stops: three }), null);
  assert.equal(getOffText({ vehicle: null, stops: [s('Oak Grove', true)] }), 'Next stop: get off');
  assert.equal(getOffText({ vehicle: { status: 'IN_TRANSIT_TO', name: 'Oak Grove', atDropOff: false }, stops: [s('Oak Grove', true)] }), 'Next stop: get off');
  assert.equal(getOffText({ vehicle: { status: 'STOPPED_AT', name: 'Oak Grove', atDropOff: true }, stops: [s('Oak Grove', true)] }), 'Get off here');
});

test('timelineSteps: walks, legs, actual transfer gaps, arrival', () => {
  const buses = [veh('b1', '10:24', '10:34', 'live')];
  const trains = [veh('o1', '10:43', '10:57', 'live')];
  const [row] = tripRows(homeToOffice, [buses, trains], 0, at('10:00'), 1);
  const texts = steps => steps.map(s => (s.kind === 'leg' ? `[${s.leg.route} ${s.leg.source}]`
    : s.kind === 'end' ? `${s.label} ${formatTime(s.time, at('10:00'))}` : s.text));
  assert.deepEqual(texts(timelineSteps(row, homeToOffice, 1, at('10:00'))), [
    'Leave 10:18am', 'Walk 5 min · 1 min early at the stop', '[132 live]', '9 min to transfer', '[Orange live]',
    'Walk 10 min', 'Arrive 11:07am',
  ]);
  assert.equal(timelineSteps(row, homeToOffice, 0, at('10:00'))[1].text, 'Walk 5 min');
  // En route: no Leave, no first walk.
  assert.equal(texts(timelineSteps({ ...row, enRoute: true }, homeToOffice, 1, at('10:00')))[0], '[132 live]');
  // No walks configured: slack only, then "Arrive".
  const bare = { legs: homeToOffice.legs.filter(l => l.kind !== 'walk') };
  const tight = { ...row, legs: [row.legs[0], { ...row.legs[1], dep: row.legs[0].arr + 30_000 }], eta: at('10:57') };
  assert.deepEqual(texts(timelineSteps(tight, bare, 1, at('10:00'))), [
    'Leave 10:18am', '1 min early at the stop', '[132 live]', '<1 min to transfer', '[Orange live]', 'Arrive 10:57am',
  ]);
  assert.equal(timelineSteps(tight, bare, 0, at('10:00'))[1].kind, 'leg');

  // With stop names: each leg's first and last stop (the walks stay short), and its duration.
  const names = stopNames(
    doc([], [stopInc('25996'), stopInc('5991'), stopInc('70036', 'place-ogmnl'), stopInc('70022', 'place-state')]
      .map((st, i) => ({ ...st, attributes: { name: ['Main St @ South St', 'Washington St opp Oak Grove Sta', 'Oak Grove', 'State'][i] } }))));
  assert.deepEqual([names.get('place-ogmnl'), names.get('70036'), names.get('5991')], ['Oak Grove', 'Oak Grove', 'Washington St opp Oak Grove Sta']);
  const named = timelineSteps(row, homeToOffice, 1, at('10:00'), names);
  assert.deepEqual(texts(named), texts(timelineSteps(row, homeToOffice, 1, at('10:00'))));
  assert.deepEqual([named[2].from, named[2].to, named[2].minutes, named[4].from, named[4].to, named[4].minutes],
    ['Main St @ South St', 'Washington St opp Oak Grove Sta', '10 min', 'Oak Grove', 'State', '14 min']);
  assert.deepEqual([timelineSteps(row, homeToOffice, 1, at('10:00'))[2].from, timelineSteps(row, homeToOffice, 1, at('10:00'))[4].to], [null, null]);
  // Walking icons: walks over 0 min and every transfer; none for slack only or "Arrive".
  const walking = steps => steps.filter(st => st.kind === 'walk').map(st => !!st.walking);
  assert.deepEqual(walking(named), [true, true, true]);
  assert.deepEqual(walking(timelineSteps(tight, bare, 1, at('10:00'))), [false, true]);
  assert.deepEqual(walking(timelineSteps({ ...row, enRoute: true }, homeToOffice, 1, at('10:00'))), [true, true]);
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

test('isSubwayRoute: heavy and light rail by route id', () => {
  for (const id of ['Red', 'Orange', 'Blue', 'Mattapan', 'Green-B', 'Green-E']) assert.equal(isSubwayRoute(id), true, id);
  for (const id of ['132', '741', 'CR-Haverhill', 'Boat-F4', 'Green']) assert.equal(isSubwayRoute(id), false, id);
});

// State, toward Oak Grove, 10:05pm (live API, 2026-10-09): the 10:09pm train is predicted only as
// ADDED-1584988985 (10:09:05), its scheduled trip 77822004 (10:09) has no prediction; 77822012
// (10:14) is predicted at 10:21.
test('predictionsFirst: on a subway leg, unpredicted scheduled trips give way to live ones', () => {
  const orange = officeToHome.legs[1];
  const bus = officeToHome.legs[3];
  const now = at('22:05');
  const vs = [veh('77822092', '22:03', '22:18'), { ...veh('ADDED-1584988985', '22:09', '22:24'), dep: at('22:09') + 5000, source: 'live', added: true },
    veh('77822004', '22:09', '22:24'), veh('77822020', '22:19', '22:34'), veh('77822012', '22:21', '22:36', 'live'),
    veh('77822036', '22:30', '22:45')];
  // 10:03 (before now, before the first live time) and 10:30 (after the last) stay.
  assert.deepEqual(predictionsFirst(vs, orange, now).map(v => v.tripId), ['77822092', 'ADDED-1584988985', '77822012', '77822036']);
  // A bus leg, or no live times: unchanged.
  assert.deepEqual(predictionsFirst(vs, bus, now), vs);
  const sched = vs.filter(v => v.source !== 'live');
  assert.deepEqual(predictionsFirst(sched, orange, now), sched);
  // A leg with `also` routes counts only if all are subway.
  assert.deepEqual(predictionsFirst(vs, { ...orange, also: ['132'] }, now), vs);
});

test('subwayHeadway: gaps between scheduled departures in the next hour on a subway leg without predictions', () => {
  const orange = officeToHome.legs[1];
  const now = at('22:00');
  const every6 = ['22:03', '22:09', '22:15'].map((d, i) => veh(`s${i}`, d, d));
  assert.equal(subwayHeadway(every6, orange, now), '6');
  const mixed = ['21:50', '22:05', '22:13', '22:26', '23:30'].map((d, i) => veh(`s${i}`, d, d));
  assert.equal(subwayHeadway(mixed, orange, now), '8–13'); // 9:50 (past) and 11:30 (after the hour) don't count
  // A bus leg, any live vehicle, or fewer than two departures in the hour: none.
  assert.equal(subwayHeadway(every6, officeToHome.legs[3], now), null);
  assert.equal(subwayHeadway([...every6, veh('l', '22:20', '22:35', 'live')], orange, now), null);
  assert.equal(subwayHeadway([veh('a', '22:03', '22:18'), veh('b', '23:30', '23:45')], orange, now), null);
  // Two branches at the same minute (Green Line) aren't a 0-min gap.
  assert.equal(subwayHeadway(['22:03', '22:03', '22:09'].map((d, i) => veh(`s${i}`, d, d)), orange, now), '6');
});

test('tripVehicles: a subway leg with predictions fetched but none tags its vehicles with the headway', () => {
  const transit = [officeToHome.legs[1]];
  const included = [stopInc('70023', 'place-state'), stopInc('70036', 'place-ogmnl')];
  const sched = doc([rec('schedule', 's1', '70023', '22:09', '22:09'), rec('schedule', 's1', '70036', '22:24', '22:24'),
    rec('schedule', 's2', '70023', '22:15', '22:15'), rec('schedule', 's2', '70036', '22:30', '22:30')], included);
  const every = vs => vs[0].map(v => [v.tripId, v.source, v.every]);
  assert.deepEqual(every(tripVehicles(transit, [mergeTrips(doc([]), sched)], null, at('22:05'))), [['s1', 'scheduled', '6'], ['s2', 'scheduled', '6']]);
  // Predictions not fetched (offline, the next service day): plain schedules.
  assert.deepEqual(every(tripVehicles(transit, [mergeTrips(null, sched)], null, at('22:05'))), [['s1', 'scheduled', undefined], ['s2', 'scheduled', undefined]]);
  // One predicted train: predictions first, no headway.
  const one = doc([rec('prediction', 's2', '70023', '22:16', '22:16'), rec('prediction', 's2', '70036', '22:31', '22:31')], included);
  assert.deepEqual(every(tripVehicles(transit, [mergeTrips(one, sched)], null, at('22:05'))), [['s2', 'live', undefined]]);
});

test('legTime, sourceText: "~" and "every N min" for a leg shown by its headway', () => {
  const now = at('22:00');
  assert.equal(legTime({ every: '6' }, at('22:09'), now), '~10:09pm');
  assert.equal(legTime({}, at('22:09'), now), '10:09pm');
  assert.equal(sourceText({ source: 'scheduled', every: '8–13' }), 'every 8–13 min');
  assert.equal(sourceText({ source: 'live' }), 'live');
});

test('headway legs: "~" on their times and what depends on them (timeline, outlook, pushes); live legs stay plain', () => {
  const now = at('17:00');
  const trains = [{ ...veh('o1', '17:17', '17:32'), every: '6' }];
  const buses = [veh('b1', '17:58', '18:10', 'live')];
  const [row] = tripRows(officeToHome, [trains, buses], 0, now, 1);
  assert.equal(row.legs[0].every, '6');
  const steps = timelineSteps(row, officeToHome, 1, now);
  assert.deepEqual(steps.filter(s => s.kind === 'leg').map(s => s.approx), [true, false]);
  assert.equal(steps.at(-1).approx, false); // arrival from the live bus
  const [last] = tripRows(homeToOffice, [[veh('b0', '17:20', '17:34', 'live')], [{ ...veh('o2', '17:45', '18:00'), every: '6' }]], 0, now, 1);
  assert.equal(timelineSteps(last, homeToOffice, 1, now).at(-1).approx, true);
  // Outlook, transfer headline, tracking status, reminder and stop alert texts.
  const ride = { boardedAt: at('17:20'), legs: last.legs };
  const outlook = { leg: 1, needed: at('17:39'), margin: 6 * MIN, legs: ride.legs, missedDep: null, none: false };
  assert.match(outlookText(outlook, ride, at('17:30')).text, /^Then Orange Line ~5:45pm/);
  assert.equal(rideHeadline({ kind: 'transfer', leg: 1 }, ride, at('17:36')), 'Transfer · Orange ~5:45pm');
  assert.equal(enRouteStatus({ kind: 'track', target: { legs: row.legs } }, now), 'Tracking Orange ~5:17pm');
  assert.equal(reminderText('leave', 'Home', row, now).body, 'Orange Line at ~5:17pm');
  assert.equal(rideAlertText({ kind: 'missed', leg: 1 }, { ride, outlook: { ...outlook, missedDep: at('17:39') }, walkAfter: 10, nowMs: at('17:40') }).body,
    'Next: Orange ~5:45pm · arrive ~6:10pm');
  assert.equal(checkRide(homeToOffice, { ...ride, legs: ride.legs.map(l => ({ ...l, every: 'x'.repeat(11) })) }, now), 'ride leg every is invalid');
});

test('tripVehicles: an ADDED train that has left stays live from memory; its scheduled twin stays out', () => {
  const transit = [officeToHome.legs[1]];
  const included = [stopInc('70023', 'place-state'), stopInc('70036', 'place-ogmnl')];
  const sched = doc([rec('schedule', 's1', '70023', '22:09', '22:09'), rec('schedule', 's1', '70036', '22:24', '22:24'),
    rec('schedule', 's2', '70023', '22:14', '22:14'), rec('schedule', 's2', '70036', '22:29', '22:29')], included);
  const before = doc([rec('prediction', 'ADDED-1', '70023', '22:09', '22:09', { schedule_relationship: 'ADDED' }),
    rec('prediction', 'ADDED-1', '70036', '22:24', '22:24', { schedule_relationship: 'ADDED' }),
    rec('prediction', 's2', '70023', '22:15', '22:15'), rec('prediction', 's2', '70036', '22:30', '22:30')], included);
  const live = mergeTrips(before, null);
  let mem = rememberLive(null, [legVehicles(live, transit[0])], at('22:05'));
  assert.equal(mem[0].get('ADDED-1').added, true);
  const ids = vs => vs[0].map(v => [v.tripId, v.source]);
  assert.deepEqual(ids(tripVehicles(transit, [mergeTrips(before, sched)], mem, at('22:05'))), [['ADDED-1', 'live'], ['s2', 'live']]);
  // 10:11pm: the ADDED train left (no board prediction); s2 is still predicted.
  const after = doc([rec('prediction', 'ADDED-1', '70036', '22:24', '22:24', { schedule_relationship: 'ADDED' }),
    rec('prediction', 's2', '70023', '22:15', '22:15'), rec('prediction', 's2', '70036', '22:30', '22:30')], included);
  mem = rememberLive(mem, [legVehicles(mergeTrips(after, null), transit[0])], at('22:11'));
  assert.deepEqual(ids(tripVehicles(transit, [mergeTrips(after, sched)], mem, at('22:11'))), [['ADDED-1', 'live'], ['s2', 'live']]);
  // Without the memory (e.g. just opened), the scheduled twin is all there is.
  assert.deepEqual(ids(tripVehicles(transit, [mergeTrips(after, sched)], null, at('22:11'))), [['s1', 'scheduled'], ['s2', 'live']]);
  // A remembered ADDED train not yet due but no longer predicted (cancelled) isn't added back.
  assert.deepEqual(ids(tripVehicles(transit, [mergeTrips(after, sched)], mem, at('22:08'))), [['s2', 'live']]);
});

test('countdownState boundaries', () => {
  const leave = at('08:00');
  const last = at('08:01');
  const dep = at('08:06');
  assert.equal(countdownState(at('07:56'), leave, last, dep), 'green');
  assert.equal(countdownState(at('07:57'), leave, last, dep), 'amber');
  assert.equal(countdownState(at('08:00'), leave, last, dep), 'red');
  assert.equal(countdownState(at('08:01'), leave, last, dep), 'missed');
  assert.equal(countdownState(at('08:10'), leave, last, dep), 'missed');
  assert.equal(countdownState(at('08:11'), leave, last, dep), 'hidden');
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
  assert.equal(countdownLabel('missed', -30_000), 'Missed · left <1 min ago');
  assert.equal(countdownLabel('missed', -3 * MIN - 10_000), 'Missed · left 3 min ago');
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

test('planRoutes: station to station on rail, fewest transfers, then fewest stops', () => {
  const net = railNetwork(JSON.parse(readFileSync('test/browser/fixtures/rail-network.json', 'utf8')),
    JSON.parse(readFileSync('test/browser/fixtures/routes.json', 'utf8')).data);
  const brief = (a, b) => planRoutes(net, a, b).map(o => [o.legs.map(l => [l.route, ...l.also].join('/')).join(' > '), o.transfers.join(', '), o.stops]);
  // A 2-transfer option is kept for riding fewer stops.
  assert.deepEqual(brief('place-ogmnl', 'place-knncl'), [
    ['Orange > Red', 'Downtown Crossing', 12],
    ['Orange > Green-D/Green-E > Red', 'Haymarket, Park Street', 11],
    ['Orange > Green-D/Green-E > Red', 'North Station, Park Street', 11],
  ]);
  // Direct: the Green branches serving both stations in one leg; detours with more stops dropped.
  assert.deepEqual(brief('place-pktrm', 'place-kencl'), [['Green-B/Green-C/Green-D', '', 5]]);
  // A change between Green branches, but no riding past Copley and back.
  assert.deepEqual(brief('place-hsmnl', 'place-kencl'), [['Green-E > Green-B/Green-C/Green-D', 'Copley', 13]]);
  // The same route the other way (Braintree to Ashmont via JFK/UMass).
  assert.deepEqual(brief('place-brntn', 'place-asmnl'), [['Red > Red', 'JFK/UMass', 9]]);
  // Platforms map to their stations; 3 transfers is beyond the limit; same station or off the network: none.
  assert.deepEqual(brief('70036', 'place-dwnxg'), [['Orange', '', 9]]);
  assert.deepEqual(brief('place-matt', 'place-wondl'), []);
  assert.equal(planRoutes(net, 'place-matt', 'place-wondl', 3).length > 0, true);
  assert.deepEqual(brief('place-ogmnl', 'place-ogmnl'), []);
  assert.deepEqual(brief('5991', 'place-ogmnl'), []);
  // The editor's form: named from the stations, walks given, 3 min to change within a station.
  assert.deepEqual(planToForm(net, planRoutes(net, 'place-ogmnl', 'place-knncl')[1], 5, 7), {
    name: 'Oak Grove to Kendall/MIT', window: null, near: false, timingLeg: null, walkBefore: 5, walkAfter: 7,
    transit: [
      { route: 'Orange', direction_id: 0, stop: 'place-ogmnl', alight: 'place-haecl', transferBefore: 0 },
      { route: 'Green-D', also: ['Green-E'], direction_id: 0, stop: 'place-haecl', alight: 'place-pktrm', transferBefore: 3 },
      { route: 'Red', direction_id: 1, stop: 'place-pktrm', alight: 'place-knncl', transferBefore: 3 },
    ],
  });
});

// Network fixtures: /routes, /stops and /route_patterns records (with the representative trip).
const route = (id, type, dest) => ({ type: 'route', id, attributes: { type, short_name: type === 3 ? id : '', long_name: type === 3 ? '' : `${id} Line`, color: 'ABCDEF', direction_destinations: dest } });
const stop = (id, name, lat, lon, parent = null) => ({ type: 'stop', id, attributes: { name, latitude: lat, longitude: lon }, relationships: { parent_station: { data: parent ? { id: parent } : null } } });
const pattern = (id, r, dir, ids, attrs) => [
  { type: 'route_pattern', id, attributes: { direction_id: dir, ...attrs }, relationships: { route: { data: { id: r } }, representative_trip: { data: { id: `rt-${id}` } } } },
  { type: 'trip', id: `rt-${id}`, relationships: { stops: { data: ids.map(x => ({ id: x })) } } },
];

// A small network: bus B1 (and B3 along the same street) to a stop by Hub station, the Orange
// Line Hub → Mid → End, bus B2 from beside Mid to Zed; B4 from Far (300 m from End: too far to walk).
function smallNetwork() {
  const pats = [
    pattern('b1', 'B1', 0, ['a1', 'a2', 'hb'], { typicality: 1 }),
    pattern('b3', 'B3', 0, ['a1', 'a2', 'hb'], { typicality: 1 }),
    pattern('b2x', 'B2', 0, ['m1', 'a1'], { typicality: 3 }), // not typical: left out
    pattern('or', 'Orange', 0, ['o1', 'o2', 'o3'], { canonical: true }),
    pattern('b2', 'B2', 0, ['m1', 'z1'], { typicality: 1 }),
    pattern('b4', 'B4', 0, ['far', 'w1'], { typicality: 1 }),
  ];
  const stops = [stop('a1', 'Elm St', 42.40, -71.10), stop('a2', 'Oak St', 42.40, -71.09), stop('hb', 'Hub Busway', 42.41, -71.0803),
    stop('o1', 'Hub', 42.4102, -71.0800, 'place-hub'), stop('o2', 'Mid', 42.42, -71.08, 'place-mid'), stop('o3', 'End', 42.43, -71.08, 'place-end'),
    stop('m1', 'Mid Busway', 42.4204, -71.0804), stop('z1', 'Zed Sq', 42.42, -71.06), stop('far', 'Far St', 42.4327, -71.08), stop('w1', 'West St', 42.44, -71.09)];
  const sched = (trip, r, list) => list.map(([st, t], i) => ({ attributes: { departure_time: iso(t), stop_sequence: i + 1 }, relationships: { trip: { data: { id: trip } }, stop: { data: { id: st } }, route: { data: { id: r } } } }));
  return transitNetwork(
    { data: [route('B1', 3, ['Hub', 'Elm']), route('B2', 3, ['Zed', 'Mid']), route('B3', 3, ['Hub', 'Elm']), route('B4', 3, ['West', 'Far']), route('Orange', 1, ['End', 'Hub'])] },
    { data: pats.map(p => p[0]), included: [...pats.map(p => p[1]), ...stops] },
    { data: [...sched('t1', 'B1', [['a1', '12:00'], ['a2', '12:04'], ['hb', '12:10']]), ...sched('t2', 'B1', [['a1', '12:30'], ['a2', '12:36'], ['hb', '12:42']])] });
}

test('transitNetwork: typical bus and canonical rail patterns, median minutes from the sample, distance otherwise', () => {
  const net = smallNetwork();
  assert.deepEqual(net.patterns.map(p => p.route), ['B1', 'B3', 'Orange', 'B2', 'B4']);
  assert.deepEqual(net.patterns[0].mins, [5, 6]); // medians of 4/6 and 6/6
  assert.ok(Math.abs(net.patterns[2].mins[0] - 1.113 / 30 * 60) < 0.05); // Orange: ~1.1 km at 30 km/h
  assert.deepEqual(net.stations['place-mid'], { id: 'place-mid', name: 'Mid', lat: 42.42, lon: -71.08 });
  assert.equal(net.routes.B1.label, 'Bus B1');
});

test('planTrips: bus to rail to bus, walks up to 250 m between stops, routes riding along', () => {
  const net = smallNetwork();
  const [hub] = planTrips(net, 'a1', 'place-mid');
  assert.deepEqual(hub.legs, [
    { route: 'B1', also: ['B3'], direction_id: 0, stop: 'a1', alight: 'hb', stopName: 'Elm St', alightName: 'Hub Busway' },
    { route: 'Orange', also: [], direction_id: 0, stop: 'place-hub', alight: 'place-mid', stopName: 'Hub', alightName: 'Mid' },
  ]);
  assert.deepEqual(hub.transfers, [{ name: 'Hub Busway → Hub', meters: 33, min: 3 }]);
  assert.equal(hub.minutes, 11 + 3 + 2); // B1 11, change 3, Orange ~2.2
  const [zed] = planTrips(net, 'a1', 'z1');
  assert.deepEqual(zed.legs.map(l => [l.route, l.stop, l.alight]), [['B1', 'a1', 'hb'], ['Orange', 'place-hub', 'place-mid'], ['B2', 'm1', 'z1']]);
  assert.deepEqual(zed.transfers.map(t => t.name), ['Hub Busway → Hub', 'Mid → Mid Busway']);
  // Far St is ~300 m from End: no walk there, so West St can't be reached; same place: none.
  assert.deepEqual(planTrips(net, 'a1', 'w1'), []);
  assert.deepEqual(planTrips(net, 'a1', 'a1'), []);
  assert.deepEqual(planTrips(net, 'nowhere', 'z1'), []);
  // At most 2 transfers.
  assert.deepEqual(planTrips(net, 'a1', 'z1', 1), []);
  // Comma-separated ids: either side of a street.
  assert.deepEqual(planTrips(net, 'nowhere,a1', 'z1')[0].legs[0].stop, 'a1');
  // Walks count twice in the ranking: riding one more stop to the one by the station beats
  // getting off 200 m away (1 min sooner by bus).
  const near = transitNetwork({ data: [route('B5', 3, ['Hub', 'Elm']), route('Orange', 1, ['End', 'Hub'])] }, {
    data: [pattern('b5', 'B5', 0, ['e1', 'far2', 'by'], { typicality: 1 })[0], pattern('or', 'Orange', 0, ['o1', 'o2'], { canonical: true })[0]],
    included: [pattern('b5', 'B5', 0, ['e1', 'far2', 'by'], {})[1], pattern('or', 'Orange', 0, ['o1', 'o2'], {})[1],
      stop('e1', 'Elm St', 42.40, -71.10), stop('far2', 'Back St', 42.4084, -71.0790), stop('by', 'By Hub', 42.4100, -71.0800),
      stop('o1', 'Hub', 42.4102, -71.0800, 'place-hub'), stop('o2', 'Mid', 42.42, -71.08, 'place-mid')],
  }, null);
  near.patterns[0].mins = [10, 1];
  assert.deepEqual(planTrips(near, 'e1', 'place-mid')[0].legs[0].alight, 'by');
  // The same routes getting off at the same station: one option, whichever bus stop you walk to.
  const twoStops = transitNetwork({ data: [route('Q', 3, ['Qz', 'Mid']), route('Orange', 1, ['End', 'Hub'])] }, {
    data: [pattern('q', 'Q', 0, ['q1', 'q2', 'qz'], { typicality: 1 })[0], pattern('or', 'Orange', 0, ['o1', 'o2'], { canonical: true })[0]],
    included: [pattern('q', 'Q', 0, ['q1', 'q2', 'qz'], {})[1], pattern('or', 'Orange', 0, ['o1', 'o2'], {})[1],
      stop('q1', 'Mid Busway', 42.4204, -71.0804), stop('q2', 'Up St', 42.4215, -71.0800), stop('qz', 'Q Sq', 42.43, -71.06),
      stop('o1', 'Hub', 42.4102, -71.0800, 'place-hub'), stop('o2', 'Mid', 42.42, -71.08, 'place-mid')],
  }, null);
  const viaMid = planTrips(twoStops, 'place-hub', 'qz');
  assert.deepEqual(viaMid.map(o => o.legs.map(l => [l.route, l.stop])), [[['Orange', 'place-hub'], ['Q', 'q1']]]);
  // The editor's form: the walk's minutes as the transfer.
  const form = optionToForm(zed, 'Elm St', 'Zed Sq', 5, 4);
  assert.equal(form.name, 'Elm St to Zed Sq');
  assert.deepEqual(form.transit.map(l => [l.route, l.also, l.transferBefore]), [['B1', ['B3'], 0], ['Orange', undefined, 3], ['B2', undefined, 3]]);
});

test('planTrips: expected waits at changes rank a frequent line above a slightly faster rare one', () => {
  // Waits: half the gap between the sample's departures (2 hours), capped at 30; none sampled: 30.
  const dep = (trip, r, st, t) => ({ attributes: { departure_time: iso(t), stop_sequence: 1 }, relationships: { trip: { data: { id: trip } }, stop: { data: { id: st } }, route: { data: { id: r } } } });
  const net = transitNetwork({ data: [route('A', 3, ['X', 'S']), route('F', 3, ['D', 'X']), route('R', 3, ['D', 'X'])] }, {
    data: ['a', 'f', 'r'].map(id => ({ type: 'route_pattern', id, attributes: { direction_id: 0, typicality: 1 }, relationships: { route: { data: { id: id.toUpperCase() } }, representative_trip: { data: { id: `rt-${id}` } } } })),
    included: [
      { type: 'trip', id: 'rt-a', relationships: { stops: { data: [{ id: 's' }, { id: 'x' }] } } },
      { type: 'trip', id: 'rt-f', relationships: { stops: { data: [{ id: 'x' }, { id: 'd' }] } } },
      { type: 'trip', id: 'rt-r', relationships: { stops: { data: [{ id: 'x' }, { id: 'd' }] } } },
      stop('s', 'S St', 42.40, -71.20), stop('x', 'X Sq', 42.41, -71.20), stop('d', 'D St', 42.42, -71.20),
    ],
  }, { data: [...Array.from({ length: 12 }, (_, i) => dep(`f${i}`, 'F', 'x', `11:${String(i * 10 % 60).padStart(2, '0')}`)), dep('r0', 'R', 'x', '11:00'), dep('r1', 'R', 'x', '12:00')] });
  assert.deepEqual(net.patterns.map(p => [p.route, p.waits]), [['A', [30, 30]], ['F', [5, 30]], ['R', [30, 30]]]);
  net.patterns[0].mins = [10];
  net.patterns[1].mins = [12];
  net.patterns[2].mins = [10];
  // F: 12 min + 5 wait beats R: 10 min + 30 wait (R rides along); minutes leave the wait out.
  assert.deepEqual(planTrips(net, 's', 'd').map(o => [o.legs[1].route, o.legs[1].also, o.minutes]), [['F', ['R'], 10 + 3 + 12]]);
});

test('planTrips: changes at different stops of one bus street are one option', () => {
  // A stops at x1 then x2; B at y1 (by x1) then y2 (by x2): change at either pair, no station near.
  const net = transitNetwork({ data: [route('A', 3, ['N', 'S']), route('B', 3, ['D', 'N'])] }, {
    data: [pattern('a', 'A', 0, ['s', 'x1', 'x2'], { typicality: 1 })[0], pattern('b', 'B', 0, ['y1', 'y2', 'd'], { typicality: 1 })[0]],
    included: [pattern('a', 'A', 0, ['s', 'x1', 'x2'], {})[1], pattern('b', 'B', 0, ['y1', 'y2', 'd'], {})[1],
      stop('s', 'S St', 42.40, -71.20), stop('x1', 'X1', 42.41, -71.20), stop('x2', 'X2', 42.42, -71.20),
      stop('y1', 'Y1', 42.4101, -71.2001), stop('y2', 'Y2', 42.4201, -71.2001), stop('d', 'D St', 42.40, -71.25)],
  }, null);
  assert.equal(planTrips(net, 's', 'd').length, 1);
});

test('planTrips: no walking back to a station ridden through; branches with their own platforms ride along', () => {
  // L rides A → B → C (C 190 m past B); M leaves B for E; bus N from beside E (n1, or n2 a bit
  // farther) to D. Every option changes at B, none rides to C and walks back to B.
  const lines = transitNetwork({ data: [route('L', 1, ['C', 'A']), route('M', 1, ['E', 'B']), route('N', 3, ['D', 'E']), route('G1', 0, ['Y', 'X']), route('G2', 0, ['Y', 'X'])] }, {
    data: [pattern('l', 'L', 0, ['la', 'lb', 'lc'], { canonical: true })[0], pattern('m', 'M', 0, ['mb', 'me'], { canonical: true })[0],
      pattern('n', 'N', 0, ['n1', 'n2', 'nd'], { typicality: 1 })[0],
      pattern('g1', 'G1', 0, ['gx', 'gy1'], { canonical: true })[0], pattern('g2', 'G2', 0, ['gx', 'gy2'], { canonical: true })[0]],
    included: [pattern('l', 'L', 0, ['la', 'lb', 'lc'], {})[1], pattern('m', 'M', 0, ['mb', 'me'], {})[1], pattern('n', 'N', 0, ['n1', 'n2', 'nd'], {})[1],
      pattern('g1', 'G1', 0, ['gx', 'gy1'], {})[1], pattern('g2', 'G2', 0, ['gx', 'gy2'], {})[1],
      stop('la', 'A', 42.30, -71.10, 'place-a'), stop('lb', 'B', 42.31, -71.10, 'place-b'), stop('lc', 'C', 42.3118, -71.10, 'place-c'),
      stop('mb', 'B', 42.3101, -71.1001, 'place-b'), stop('me', 'E', 42.33, -71.12, 'place-e'),
      stop('n1', 'N1', 42.3301, -71.12), stop('n2', 'N2', 42.3315, -71.12), stop('nd', 'D St', 42.35, -71.12),
      stop('gx', 'X', 42.35, -71.05, 'place-x'), stop('gy1', 'Y', 42.36, -71.05, 'place-y'), stop('gy2', 'Y', 42.3601, -71.0501, 'place-y')],
  }, null);
  const options = planTrips(lines, 'place-a', 'nd');
  assert.ok(options.length);
  assert.deepEqual(options.map(o => o.transfers[0].name), options.map(() => 'B'));
  // G1 and G2 stop at their own platforms at Y: one leg, the other riding along.
  assert.deepEqual(planTrips(lines, 'place-x', 'place-y').map(o => [o.legs[0].route, o.legs[0].also]), [['G1', ['G2']]]);
});

// A network from bare patterns ([id, route, type, stops]) and stops ([id, lat, lon, parent?]), with
// set ride minutes per hop and waits per stop.
function bareNetwork(pats, stops, mins = 5, wait = 5) {
  const rs = [...new Set(pats.map(p => p[1]))].map(r => route(r, pats.find(p => p[1] === r)[2], ['To', 'From']));
  const ps = pats.map(([id, r, type, ids, dir = 0]) => pattern(id, r, dir, ids, type === 3 ? { typicality: 1 } : { canonical: true }));
  const net = transitNetwork({ data: rs }, { data: ps.map(p => p[0]), included: [...ps.map(p => p[1]), ...stops.map(([id, lat, lon, parent]) => stop(id, id.toUpperCase(), lat, lon, parent))] }, null);
  for (const p of net.patterns) { p.mins = p.stops.slice(1).map(() => mins); p.waits = p.stops.map(() => wait); }
  return net;
}

test('pointEnds: the nearest stop of each pattern within 800 m, with walk minutes', () => {
  const net = smallNetwork();
  // a1 is ~330 m from the point, a2 ~490 m: B1 and B3 both stop at a1 first. Walk: × 1.3, 80 m/min.
  const ends = pointEnds(net, { lat: 42.40, lon: -71.096 });
  assert.deepEqual(ends.map(e => e.id), ['a1']);
  assert.equal(ends[0].min, Math.ceil(ends[0].meters * 1.3 / 80));
  assert.ok(ends[0].meters > 300 && ends[0].meters < 360);
  assert.deepEqual(pointEnds(net, { lat: 42.40, lon: -71.096 }, 200), []);
  // From a point: walks count; the walk to the first stop comes back as walkBefore.
  // a1 is one stop (~5 min) before a2 on B1: a 1-min walk to a1 beats a 9-min walk to a2.
  const [o] = planTrips(net, [{ id: 'a1', min: 1 }, { id: 'a2', min: 9 }], 'place-mid');
  assert.equal(o.legs[0].stop, 'a1');
  assert.equal(o.walkBefore, 1);
  assert.equal(o.walkAfter, 0);
  const [back] = planTrips(net, 'place-hub', [{ id: 'o2', min: 4 }]);
  assert.deepEqual([back.legs[0].alight, back.walkAfter], ['place-mid', 4]);
});

test('planTrips: ranked by total minutes with 5 per transfer; no route twice; one option per line\'s branches', () => {
  const stops = [['s', 42.30, -71.10], ['x', 42.31, -71.10], ['d', 42.32, -71.10], ['q1', 42.3101, -71.1001], ['q2', 42.3102, -71.1002]];
  // Direct D: 8 hops of 5 = 40 min. A to x (10) then F to d (10): 10 + 3 + 5 wait + 10 + 5 = 33.
  const net = bareNetwork([['d', 'D', 3, ['s', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'd']], ['a', 'A', 3, ['s', 'm8', 'x']], ['f', 'F', 3, ['x', 'm9', 'd']]],
    [...stops, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => [`m${i}`, 42.5 + i / 100, -71.5])]);
  assert.deepEqual(planTrips(net, 's', 'd').map(o => o.legs.map(l => l.route).join('>')), ['A>F', 'D']);
  net.patterns[0].mins = net.patterns[0].mins.map(() => 3.875); // direct: 31 min, under 28 + 5 for the transfer
  assert.deepEqual(planTrips(net, 's', 'd').map(o => o.legs.map(l => l.route).join('>')), ['D', 'A>F']);
  // L out and L back (other direction): never.
  const loop = bareNetwork([['l0', 'L', 3, ['s', 'x']], ['l1', 'L', 3, ['x', 'd'], 1]], stops);
  assert.deepEqual(planTrips(loop, 's', 'd'), []);
  // A route riding along on one leg isn't ridden again on the next (G2 rides along s → x, then G2).
  const along = bareNetwork([['g1', 'G1', 3, ['s', 'x']], ['g2', 'G2', 3, ['s', 'x', 'd']]], stops);
  assert.deepEqual(planTrips(along, 's', 'd').map(o => o.legs.map(l => [l.route, ...l.also].join('/')).join('>')), ['G2']);
  // Two branches of one line from two bus stops by x: one option.
  const branches = bareNetwork([['a', 'A', 3, ['s', 'x']], ['b1', 'T-1', 3, ['q1', 'd']], ['b2', 'T-2', 3, ['q2', 'd']]], stops);
  assert.equal(planTrips(branches, 's', 'd').length, 1);
});

test('nextWeekday: today on a weekday, else Monday', () => {
  assert.equal(nextWeekday(Date.parse('2026-10-09T09:00:00-04:00')), '2026-10-09'); // Friday
  assert.equal(nextWeekday(Date.parse('2026-10-10T09:00:00-04:00')), '2026-10-12'); // Saturday
  assert.equal(nextWeekday(Date.parse('2026-10-11T23:00:00-04:00')), '2026-10-12'); // Sunday
});

test('stopPairs: the two sides of a street as one place (names normalized, or within 25 m)', () => {
  assert.equal(normalStopName('132 Brookline Ave opp Fullerton St'), normalStopName('Brookline Ave @ Fullerton St'));
  assert.equal(normalStopName('Longwood Ave @ Brookline Ave'), normalStopName('Brookline Ave @ Longwood Ave'));
  // The recorded 132: Main St @ South St on both sides; 349 Washington St has no partner.
  const docs = ['0', '1'].map(d => JSON.parse(readFileSync(`test/browser/fixtures/stops-132-${d}.json`, 'utf8')));
  const rows = stopPairs(boardGroups(...docs));
  const row = name => rows.find(r => r.name === name);
  assert.deepEqual(row('Main St @ South St'), { ids: ['15982', '25996'], name: 'Main St @ South St', names: ['Main St @ South St', 'Main St @ South St'], both: true, toward: null });
  assert.deepEqual(row('Washington St @ Francis St').names, ['Washington St opp Francis St', 'Washington St @ Francis St']); // the "@" name shown
  assert.deepEqual(row('349 Washington St'), { ids: ['5967'], name: '349 Washington St', both: false, toward: 0 });
  assert.equal(rows.filter(r => r.both).length, 24);
  // Made up: the same name 3.5 km apart (a loop) stays apart; two names 20 m apart pair; a stop pairs once.
  const st = (id, name, lat, lon) => ({ id, attributes: { name, latitude: lat, longitude: lon } });
  const made = stopPairs({ both: [], only: [
    [st('a', 'Mass Ave @ Albany St', 42.330, -71.07), st('b', 'Summer St @ Lincoln St', 42.400, -71.07)],
    [st('c', 'Mass Ave @ Albany St', 42.361, -71.07), st('d', 'Summer St @ Chestnut St', 42.40015, -71.07), st('e', 'Summer St opp Lincoln St', 42.40016, -71.07)],
  ] });
  assert.deepEqual(made.map(r => [r.ids, r.both, r.toward]), [[['a'], false, 0], [['b', 'd'], true, null], [['c'], false, 1], [['e'], false, 1]]);
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
  // A terminus is boarded only toward the other end (not listed as served both ways).
  assert.deepEqual(g.both.map(x => x.id), ['place-mlmnl', 'place-welln']);
  assert.deepEqual(g.only.map(l => l.map(x => x.id)), [['place-ogmnl'], ['place-forhl']]);
  const fromOak = alightGroups(orange0, orange1, 'place-ogmnl');
  assert.deepEqual(fromOak.map(x => [x.direction, x.stops.map(y => y.id)]), [[0, ['place-mlmnl', 'place-welln', 'place-forhl']]]);
  assert.deepEqual(alightGroups(orange0, orange1, '70036')[0].stops.length, 3); // child platform id
  assert.deepEqual(alightGroups(orange0, orange1, 'place-mlmnl').map(x => [x.direction, x.stops.length]), [[0, 2], [1, 1]]);
  // Bus: shared terminals (each boarded one way only), separate sides of the street.
  const bus0 = { data: [s('T'), s('a0'), s('b0'), s('M')] };
  const bus1 = { data: [s('M'), s('b1'), s('a1'), s('T')] };
  const b = boardGroups(bus0, bus1);
  assert.deepEqual([b.both.map(x => x.id), b.only.map(l => l.map(x => x.id))], [[], [['T', 'a0', 'b0'], ['M', 'b1', 'a1']]]);
  assert.deepEqual(alightGroups(bus0, bus1, 'b1').map(x => [x.direction, x.stops.map(y => y.id)]), [[1, ['a1', 'T']]]);
  assert.deepEqual(alightGroups(bus0, bus1, 'nope'), []);
  assert.deepEqual(boardGroups(null, bus1).only[1].length, 3); // not its last stop
  // Getting off (auto-route's To by route): each direction without its first stop.
  const d = dropOffGroups(bus0, bus1);
  assert.deepEqual([d.both.map(x => x.id), d.only.map(l => l.map(x => x.id))], [[], [['a0', 'b0', 'M'], ['b1', 'a1', 'T']]]);
  assert.deepEqual(dropOffGroups(orange0, orange1).both.map(x => x.id), ['place-mlmnl', 'place-welln']);
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

// ---------- reminders ----------

test('legQuery: every route of the leg, both stops, sparse fields', () => {
  const q = legQuery({ kind: 'transit', route: 'Green-B', also: ['Green-C'], direction_id: 0, stop: 'place-gover', alight: 'place-pktrm' });
  assert.equal(q['filter[route]'], 'Green-B,Green-C');
  assert.equal(q['filter[direction_id]'], 0);
  assert.equal(q['filter[stop]'], 'place-gover,place-pktrm');
  assert.equal(q.include, 'stop,trip');
  assert.equal(q['fields[trip]'], 'headsign');
});

test('rowsFromDocs: rows from raw predictions and schedules', () => {
  const bus = doc([rec('schedule', 'b1', '25996', '07:10', '07:10'), rec('schedule', 'b1', '5991', '07:25', '07:25')]);
  const orange = doc([rec('prediction', 'o1', 'place-ogmnl', '07:32', '07:33'), rec('prediction', 'o1', 'place-state', '07:50', '07:50')]);
  const [row] = rowsFromDocs(homeToOffice, [null, orange], [bus, null], 1, at('07:00'), 1);
  assert.equal(row.key, 'o1');
  assert.equal(row.leaveBy, at('07:04')); // 7:10 bus - 5 min walk - 1 min slack
  assert.deepEqual(row.legs.map(l => l.source), ['scheduled', 'live']);
});

test('reminderStep: heads-up, then leave; times follow the row', () => {
  const rem = { leaveBy: at('07:14'), headsUp: true, missing: 0 };
  assert.deepEqual(reminderStep(rem, { leaveBy: at('07:14') }, at('07:00')), { action: 'wait', leaveBy: at('07:14'), missing: 0 });
  assert.equal(reminderStep(rem, { leaveBy: at('07:14') }, at('07:09')).action, 'headsUp');
  // Delayed: the heads-up waits for the new time.
  assert.deepEqual(reminderStep(rem, { leaveBy: at('07:16') }, at('07:10')), { action: 'wait', leaveBy: at('07:16'), missing: 0 });
  assert.equal(reminderStep({ ...rem, headsUp: false }, { leaveBy: at('07:14') }, at('07:10')).action, 'wait');
  assert.equal(reminderStep({ ...rem, headsUp: false }, { leaveBy: at('07:14') }, at('07:14')).action, 'leave');
  // Earlier than expected and already due: straight to "Leave now".
  assert.equal(reminderStep(rem, { leaveBy: at('07:05') }, at('07:06')).action, 'leave');
});

test('reminderStep: a ride missing three polls in a row is cancelled; long past, it expires', () => {
  const rem = { leaveBy: at('07:14'), headsUp: true, missing: 0 };
  const a = reminderStep(rem, null, at('07:00'));
  assert.deepEqual(a, { action: 'wait', leaveBy: at('07:14'), missing: 1 });
  assert.equal(reminderStep({ ...rem, missing: 1 }, null, at('07:00')).action, 'wait');
  assert.equal(reminderStep({ ...rem, missing: 2 }, null, at('07:00')).action, 'cancelled');
  assert.equal(reminderStep({ ...rem, missing: 1 }, { leaveBy: at('07:14') }, at('07:00')).missing, 0);
  assert.equal(reminderStep(rem, null, at('07:24')).action, 'expire');
});

test('reminderStep: after the heads-up, a leave-by moved UPDATE_MIN+ min is an update', () => {
  assert.equal(UPDATE_MIN, 2);
  const rem = { leaveBy: at('07:14'), headsUp: false, missing: 0, sent: { leaveBy: at('07:14') } };
  assert.deepEqual(reminderStep(rem, { leaveBy: at('07:17') }, at('07:10')),
    { action: 'update', leaveBy: at('07:17'), missing: 0, update: true, was: at('07:14'), earlier: false });
  assert.equal(reminderStep(rem, { leaveBy: at('07:12') }, at('07:10')).earlier, true);
  assert.equal(reminderStep(rem, { leaveBy: at('07:15') }, at('07:10')).action, 'wait'); // 1 min: jitter
  assert.equal(reminderStep(rem, { leaveBy: at('07:10') }, at('07:10')).action, 'leave'); // due: "Leave now" instead
  // Before the heads-up (or a reminder saved before updates existed): no update.
  assert.equal(reminderStep({ ...rem, headsUp: true, sent: undefined }, { leaveBy: at('07:20') }, at('07:05')).action, 'wait');
  assert.equal(reminderStep({ ...rem, sent: undefined }, { leaveBy: at('07:20') }, at('07:10')).action, 'wait');
});

test('headsUpDue, reminderText, reminderPollMs', () => {
  assert.equal(HEADS_UP_MIN, 5);
  assert.equal(headsUpDue(at('07:14'), at('07:08')), true);
  assert.equal(headsUpDue(at('07:14'), at('07:09')), false);
  const row = { leaveBy: at('07:14'), legs: [{ label: 'Bus 132', dep: at('07:20') }] };
  assert.deepEqual(reminderText('headsUp', 'Home to office', row, at('07:09')), { title: 'Leave in 5 min · Home to office', body: 'Bus 132 at 7:20am' });
  assert.deepEqual(reminderText('leave', 'Home to office', row, at('07:14')), { title: 'Leave now · Home to office', body: 'Bus 132 at 7:20am' });
  assert.deepEqual(reminderText('update', 'Home to office', { ...row, leaveBy: at('07:12') }, at('07:10'), at('07:14')),
    { title: 'Leave in 2 min · Home to office', body: 'Bus 132 at 7:20am · leave by 7:12am (was 7:14am)' });
  assert.deepEqual(reminderText('cancelled', 'Home to office', null, at('07:00')), { title: 'Ride cancelled · Home to office', body: 'Open the app for the next one.' });
  assert.equal(reminderPollMs(at('07:30'), at('07:00')), 60_000);
  assert.equal(reminderPollMs(at('07:15'), at('07:00')), 20_000);
});

test('testPushText', () => {
  assert.deepEqual(testPushText(at('07:41')), { title: 'Test notification', body: 'Push works. Sent 7:41am.' });
});

test('headsigns: from included trips onto vehicles, legs, outlook and push text', () => {
  const trip = (id, headsign) => ({ type: 'trip', id, attributes: { headsign } });
  const sched = doc([rec('schedule', 'o1', 'a', '07:30', '07:30'), rec('schedule', 'o1', 'b', '07:45', '07:45'),
    rec('schedule', 'o2', 'a', '07:40', '07:40'), rec('schedule', 'o2', 'b', '07:55', '07:55'),
    rec('schedule', 'o3', 'a', '07:50', '07:50'), rec('schedule', 'o3', 'b', '08:05', '08:05')], [trip('o1', 'Forest Hills')]);
  const pred = doc([rec('prediction', 'o2', 'a', '07:41', '07:41'), rec('prediction', 'o2', 'b', '07:56', '07:56')], [trip('o2', 'Ruggles')]);
  const vs = legVehicles(mergeTrips(pred, sched), { stop: 'a', alight: 'b' });
  assert.deepEqual(vs.map(v => v.headsign), ['Forest Hills', 'Ruggles', undefined]); // schedule, prediction, none
  assert.equal(onVehicle({ label: 'Orange', headsign: 'Forest Hills' }, vs[1]).headsign, 'Ruggles');
  assert.equal(toward({ headsign: 'Forest Hills' }), 'toward Forest Hills');
  assert.equal(toward({}), '');
  const leg = { label: 'Orange', headsign: 'Forest Hills', dep: at('07:32') };
  assert.equal(outlookText({ legs: [leg], leg: 0, margin: 5 * MIN }, {}, at('07:20')).text, 'Then Orange Line toward Forest Hills 7:32am · 5 min to spare');
  assert.equal(reminderText('leave', 'Home', { legs: [{ label: 'Bus 132', headsign: 'Malden', dep: at('07:08') }] }, at('07:02')).body, 'Bus 132 toward Malden at 7:08am');
});

test('lineLabel: subway lines get "Line"', () => {
  const l = (label, extra) => lineLabel({ label, ...extra });
  assert.equal(l('Orange'), 'Orange Line');
  assert.equal(l('Red'), 'Red Line');
  assert.equal(l('Green'), 'Green Line');
  assert.equal(l('Green B'), 'Green Line B');
  assert.equal(l('Green B/C'), 'Green Line B/C');
  assert.equal(l('Green', { routeLabels: { 'Green-D': 'Green D' }, vehicleRoute: 'Green-D' }), 'Green Line D');
  assert.equal(l('Bus 132'), 'Bus 132');
  assert.equal(l('Silver SL1'), 'Silver SL1');
  assert.equal(l('Mattapan Trolley'), 'Mattapan Trolley');
  assert.equal(l('Blueberry'), 'Blueberry');
});

test('withoutArrived: the next leg leaves out the routes just ridden', () => {
  const g = (key, routes) => ({ key, routes });
  const state = [g('Orange/0', ['Orange']), g('Orange/1', ['Orange']), g('Blue/0', ['Blue']), g('Blue/1', ['Blue'])];
  const keys = r => ({ shown: r.shown.map(x => x.key), hidden: r.hidden.map(x => x.key) });
  assert.deepEqual(keys(withoutArrived(state, ['Blue'])), { shown: ['Orange/0', 'Orange/1'], hidden: ['Blue/0', 'Blue/1'] });
  assert.deepEqual(keys(withoutArrived(state, null)), { shown: ['Orange/0', 'Orange/1', 'Blue/0', 'Blue/1'], hidden: [] });
  // Green-B at Kenmore: C and D stay; a B-only group goes; "any" needs every branch ridden.
  const kenmore = [g('B', ['Green-B']), g('C', ['Green-C']), g('D', ['Green-D']), g('any', ['Green-B', 'Green-C', 'Green-D', 'Green-E'])];
  assert.deepEqual(keys(withoutArrived(kenmore, ['Green-B'])), { shown: ['C', 'D', 'any'], hidden: ['B'] });
  assert.deepEqual(withoutArrived(kenmore, ['Green-B', 'Green-C', 'Green-D', 'Green-E']).shown, []);
});

test('stopConnections: each station tags only the nearest stop of the list (or itself)', () => {
  const st = (id, lat, lon) => ({ id, lat, lon });
  // Orange at its platform coordinates (as the rail network has them).
  const rail = [
    { route: 'Orange', label: 'Orange', color: 'ED8B00', stops: [st('place-ogmnl', 42.437735, -71.070875), st('place-mlmnl', 42.426677, -71.074381)] },
    { route: 'Green-C', label: 'Green C', color: '00843D', stops: [st('place-haecl', 42.36279, -71.05829)] },
    { route: 'Green-D', label: 'Green D', color: '00843D', stops: [st('place-haecl', 42.36279, -71.05829)] },
  ];
  const stop = (id, lat, lon) => ({ id, attributes: { latitude: lat, longitude: lon } });
  // Bus 132 toward Malden (live coordinates): Glen Rock Rd and 14 Summer St are ~124 m from a
  // platform but not where you transfer.
  const toMalden = [stop('5990', 42.438768, -71.071435), stop('5991', 42.436927, -71.071292), stop('5992', 42.43545, -71.071995),
    stop('5069', 42.430028, -71.074376), stop('5070', 42.427777, -71.074151), stop('place-mlmnl', 42.426632, -71.07411)];
  const tags = stopConnections(toMalden, rail);
  assert.deepEqual([...tags.keys()].sort(), ['5991', 'place-mlmnl']);
  assert.deepEqual(tags.get('5991'), [{ label: 'Orange', color: 'ED8B00' }]);
  // Without the station in the list, the nearest stop within 200 m takes it (14 Summer St).
  assert.deepEqual([...stopConnections(toMalden.slice(0, -1), rail).keys()].sort(), ['5070', '5991']);
  // Excluded routes, and nothing within 200 m.
  assert.equal(stopConnections(toMalden, rail, ['Orange']).size, 0);
  assert.equal(stopConnections([stop('x', 42.3627, -71.0624)], rail).size, 0);
  // A station in the list: its lines, branches merged.
  assert.deepEqual(stopConnections([stop('place-haecl')], rail).get('place-haecl'), [{ label: 'Green C/D', color: '00843D' }]);
});

test('statusProblem: errors, the rate limit and notices, without times', () => {
  assert.equal(statusProblem({}), '');
  assert.equal(statusProblem({ lastOk: 1 }), '');
  assert.equal(statusProblem({ lastError: 'HTTP 500' }), 'Error: HTTP 500');
  assert.equal(statusProblem({ lastError: 'HTTP 500', lastOk: 1 }), 'Stale (HTTP 500)');
  assert.equal(statusProblem({ lastError: 'HTTP 429', lastOk: 1, rateLimited: true }), 'Rate limited');
  assert.equal(statusProblem({ notice: 'No service', locationOff: true, savedCopy: true }), 'No service · Location off · Saved copy');
  assert.equal(statusProblem({ lastError: 'x', lastOk: 1, savedCopy: true }), 'Stale (x)'); // as the status line shows it
  assert.equal(statusProblem({ lastOk: 1, mbtaDown: true, savedCopy: true }), 'MBTA down · Saved copy');
});

test('rowAriaLabel', () => {
  assert.equal(rowAriaLabel('Leave in 5 min', '7:04am', '7:50am'), 'Leave in 5 min, 7:04am, arrive 7:50am');
  assert.equal(rowAriaLabel('Hurry · 1 min', '7:06am', '7:50am', true), 'Hurry · 1 min, 7:06am, arrive 7:50am, reminder set');
});

test('formatDistance: meters to 10 m under a kilometer, else km', () => {
  assert.equal(formatDistance(0), '0 m');
  assert.equal(formatDistance(124), '120 m');
  assert.equal(formatDistance(126), '130 m');
  assert.equal(formatDistance(994), '990 m');
  assert.equal(formatDistance(996), '1.0 km');
  assert.equal(formatDistance(3420), '3.4 km');
});

test('routeDistances: each route at its nearest stop; unknown stops ignored', () => {
  const here = { lat: 42.4385, lon: -71.0711 };
  const stop = (id, lat, lon) => ({ id, attributes: { latitude: lat, longitude: lon } });
  const stops = [stop('a', 42.4385, -71.0711), stop('b', 42.4367, -71.0711), stop('c', null, null)];
  const sch = (route, s) => ({ relationships: { route: { data: { id: route } }, stop: { data: { id: s } } } });
  const d = routeDistances(stops, [sch('132', 'b'), sch('132', 'a'), sch('136', 'b'), sch('99', 'zzz'), sch('101', 'c')], here);
  assert.equal(d.get('132'), 0);
  assert.ok(Math.abs(d.get('136') - 200) < 5);
  assert.equal(d.has('99'), false);
  assert.equal(d.has('101'), false);
});

test('byDistance: nearest first, stable, items without coordinates last', () => {
  const here = { lat: 42.4385, lon: -71.0711 };
  const items = [{ id: 'far', lat: 42.45, lon: -71.0711 }, { id: 'none' }, { id: 'near', lat: 42.4386, lon: -71.0711 }, { id: 'near2', lat: 42.4386, lon: -71.0711 }];
  const out = byDistance(items, here, x => (x.lat == null ? null : x));
  assert.deepEqual(out.map(x => x.item.id), ['near', 'near2', 'far', 'none']);
  assert.equal(out[3].meters, null);
  assert.ok(out[0].meters > 10 && out[0].meters < 12);
});

test('trimStopsDoc keeps ids, names, coordinates and child ids; drops included records', () => {
  const doc = JSON.parse(readFileSync('test/browser/fixtures/stops-Orange-0.json', 'utf8'));
  doc.included = [{ type: 'stop', id: 'node-x', attributes: { name: 'Entrance' } }];
  const t = trimStopsDoc(doc);
  assert.equal(t.included, undefined);
  assert.equal(t.data.length, doc.data.length);
  const og = t.data.find(s => s.id === 'place-ogmnl');
  assert.deepEqual(og.attributes, { name: 'Oak Grove', latitude: 42.43668, longitude: -71.071097 });
  assert.ok(og.relationships.child_stops.data.some(c => c.id === '70036'));
  assert.deepEqual(Object.keys(og.relationships.child_stops.data[0]), ['id']);
  assert.deepEqual(trimStopsDoc(null), { data: [] });
});

test('isStale: past the ttl, or no time', () => {
  assert.equal(isStale(1000, 1500, 1000), false);
  assert.equal(isStale(1000, 2000, 1000), true);
  assert.equal(isStale(undefined, 2000, 1000), true);
});

test('previousRides: first-leg vehicles that left in the last 15 min, with their connections', () => {
  // Bus 132 (transfer 5) then Orange.
  const buses = [veh('b0', '07:00', '07:14'), veh('b1', '07:12', '07:26'), veh('b2', '07:20', '07:34'), veh('b3', '07:40', '07:54')];
  const trains = [veh('o1', '07:31', '07:46'), veh('o2', '07:36', '07:51')];
  const rides = previousRides(homeToOffice, [buses, trains], at('07:24'));
  // b0 left 24 min ago (out of the window), b3 not yet; b2 (07:34 + 5) has no train after: skipped.
  assert.deepEqual(rides.map(r => [r.key, r.legs.map(l => l.tripId)]), [['b1', ['b1', 'o1']]]);
  const [r] = rides;
  assert.deepEqual([r.firstDep, r.eta], [at('07:12'), at('07:46') + 10 * MIN]);
  assert.deepEqual([r.legs[0].label, r.legs[0].dep, r.legs[1].route], ['132', at('07:12'), 'Orange']);
  // Window edges: leaving now and 15 min ago are in (b2 now has o3).
  const both = [buses, [...trains, veh('o3', '07:40', '07:55')]];
  assert.deepEqual(previousRides(homeToOffice, both, at('07:20')).map(r => r.key), ['b1', 'b2']);
  assert.deepEqual(previousRides(homeToOffice, both, at('07:27')).map(r => r.key), ['b1', 'b2']);
  assert.deepEqual(previousRides(homeToOffice, both, at('07:35')).map(r => r.key), ['b2']); // b1 left 23 min ago
});

test('rideAlertStep: heads-up at 3 stops, get off at 1, the time fallback, missed connections, done', () => {
  const leg = (tripId, dep, arr, label) => ({ route: label, label, tripId, dep: at(dep), arr: at(arr), source: 'live' });
  const ride = { boardedAt: at('07:10'), legs: [leg('b1', '07:10', '07:25', 'Bus 132'), leg('o1', '07:33', '07:50', 'Orange')] };
  const riding0 = { kind: 'riding', leg: 0, eta: at('08:00') };
  const stops = n => ({ vehicle: null, stops: Array.from({ length: n }, (_, k) => ({ name: `S${k}`, dropOff: k === n - 1 })) });
  const step = (alert, n, t, phase = riding0, outlook = null) => rideAlertStep(alert, ride, phase, n == null ? null : stops(n), outlook, at(t));
  const kinds = r => r.sends.map(x => x.kind);

  let r = step({}, 6, '07:12');
  assert.deepEqual([kinds(r), r.done, r.alert.sent[0].first], [[], false, 6]);
  r = step(r.alert, 3, '07:18');
  assert.deepEqual(r.sends, [{ kind: 'headsUp', leg: 0, n: 3 }]);
  r = step(r.alert, 2, '07:20');
  assert.deepEqual(kinds(r), []); // not twice
  r = step(r.alert, 1, '07:22');
  assert.deepEqual(r.sends, [{ kind: 'getOff', leg: 0 }]);
  assert.deepEqual(kinds(step(r.alert, 1, '07:23')), []);
  // Boarded within 2 stops of the drop-off: no heads-up.
  r = step({}, 3, '07:12');
  assert.deepEqual(kinds(r), []);
  assert.deepEqual(kinds(step(r.alert, 1, '07:20')), ['getOff']);
  // No stop list: get off GET_OFF_MIN before the arrival.
  assert.deepEqual(kinds(step({}, null, '07:22')), []);
  assert.deepEqual(kinds(step({}, null, '07:23')), ['getOff']);
  // The second leg is tracked separately.
  const riding1 = { kind: 'riding', leg: 1, eta: at('08:00') };
  assert.deepEqual(step(r.alert, 1, '07:48', riding1).sends, [{ kind: 'getOff', leg: 1 }]);
  // A missed connection once per missed departure; no connection once.
  const missed = { leg: 1, missedDep: at('07:33'), legs: ride.legs };
  r = step({}, 5, '07:20', riding0, missed);
  assert.deepEqual(kinds(r), ['missed']);
  assert.deepEqual(kinds(step(r.alert, 5, '07:21', riding0, missed)), []);
  assert.deepEqual(kinds(step(r.alert, 5, '07:22', riding0, { ...missed, missedDep: at('07:39') })), ['missed']);
  const none = { leg: 1, none: true, needed: at('07:30') };
  r = step({}, 5, '07:20', riding0, none);
  assert.deepEqual([kinds(r), kinds(step(r.alert, 5, '07:21', riding0, none))], [['none'], []]);
  // In the transfer: nothing; walking, or 3 h after boarding: done.
  assert.deepEqual(step({}, null, '07:30', { kind: 'transfer', leg: 1 }).done, false);
  assert.equal(step({}, null, '07:55', { kind: 'walking', leg: 2 }).done, true);
  assert.equal(step({}, 6, '10:10').done, true);
});

test('rideAlertStep: sent alerts are updated as times move UPDATE_MIN+ min', () => {
  const leg = (tripId, dep, arr) => ({ route: 'Orange', label: 'Orange', tripId, dep: at(dep), arr: at(arr), source: 'live' });
  const ride = (arr0, dep1) => ({ boardedAt: at('07:10'), legs: [leg('b1', '07:10', arr0), leg('o1', dep1, '07:50')] });
  const riding0 = { kind: 'riding', leg: 0 };
  const stops = n => ({ vehicle: null, stops: Array.from({ length: n }, (_, k) => ({ name: `S${k}`, dropOff: k === n - 1 })) });
  const outlook = (r, extra = {}) => ({ leg: 1, needed: r.legs[0].arr, margin: 5 * MIN, legs: r.legs, missedDep: null, none: false, ...extra });
  const step = (alert, r, n, t, phase = riding0, o = outlook(r)) => rideAlertStep(alert, r, phase, n == null ? null : stops(n), o, at(t));

  // The heads-up's arrival: 1 min is jitter; 2+ min later updates quietly, earlier alerts.
  let r = step({}, ride('07:25', '07:33'), 6, '07:12');
  r = step(r.alert, ride('07:25', '07:33'), 3, '07:18');
  assert.equal(r.alert.sent[0].arr, at('07:25'));
  assert.deepEqual(step(r.alert, ride('07:26', '07:33'), 3, '07:19').sends, []);
  r = step(r.alert, ride('07:27', '07:33'), 3, '07:19');
  assert.deepEqual(r.sends, [{ kind: 'headsUp', leg: 0, n: 3, update: true, was: at('07:25'), earlier: false }]);
  assert.equal(step(r.alert, ride('07:25', '07:33'), 2, '07:20').sends[0].earlier, true);
  // The get-off's next departure, through the transfer; not after the next leg is boarded.
  r = step(r.alert, ride('07:27', '07:33'), 1, '07:25');
  assert.deepEqual([r.sends, r.alert.sent[0].nextDep], [[{ kind: 'getOff', leg: 0 }], at('07:33')]);
  const transfer = { kind: 'transfer', leg: 1 };
  assert.deepEqual(step(r.alert, ride('07:27', '07:34'), null, '07:28', transfer).sends, []);
  const moved = step(r.alert, ride('07:27', '07:36'), null, '07:28', transfer);
  assert.deepEqual(moved.sends, [{ kind: 'getOff', leg: 0, update: true, was: at('07:33'), earlier: false }]);
  assert.deepEqual(step(moved.alert, ride('07:27', '07:36'), null, '07:29', transfer).sends, []);
  assert.deepEqual(step(r.alert, ride('07:27', '07:40'), 5, '07:40', { kind: 'riding', leg: 1 }, null).sends, []);
  // A missed connection's replacement; its later moves are missed-alert updates, not get-off ones.
  const r0 = ride('07:30', '07:33');
  const replaced = ride('07:30', '07:38');
  r = step({ sent: { 0: { first: 6, getOff: true, nextDep: at('07:33') } } }, r0, null, '07:31', transfer, outlook(r0, { missedDep: at('07:33'), legs: replaced.legs }));
  assert.deepEqual(r.sends, [{ kind: 'missed', leg: 1, missedDep: at('07:33') }]);
  assert.deepEqual(r.alert.missedNext, { leg: 1, dep: at('07:38') });
  const later = ride('07:30', '07:41');
  assert.deepEqual(step(r.alert, later, null, '07:32', transfer).sends,
    [{ kind: 'missed', leg: 1, missedDep: at('07:33'), update: true, was: at('07:38'), earlier: false }]);
  assert.deepEqual(step(r.alert, ride('07:30', '07:39'), null, '07:32', transfer).sends, []);
});

test('rideAlertText: heads-up, get off (transfer / last leg), missed, no connection', () => {
  const leg = (tripId, dep, arr, label, headsign) => ({ route: label, label, tripId, dep: at(dep), arr: at(arr), source: 'live', headsign });
  const ride = { boardedAt: at('17:41'), legs: [leg('o1', '17:41', '17:56', 'Orange'), leg('b1', '18:26', '18:38', 'Bus 132', 'Redstone')] };
  const ctx = (extra = {}) => ({ ride, outlook: null, stopName: 'Oak Grove', walkAfter: 5, nowMs: at('17:50'), ...extra });
  assert.deepEqual(rideAlertText({ kind: 'headsUp', leg: 0, n: 3 }, ctx()), { title: '3 stops to Oak Grove', body: 'Orange Line · arrive 5:56pm' });
  const outlook = { leg: 1, needed: at('18:01'), margin: 25 * MIN, legs: ride.legs, missedDep: null, none: false };
  assert.deepEqual(rideAlertText({ kind: 'getOff', leg: 0 }, ctx({ outlook })),
    { title: 'Next stop: Oak Grove · get off', body: 'Then Bus 132 toward Redstone 6:26pm · 25 min to spare' });
  assert.deepEqual(rideAlertText({ kind: 'getOff', leg: 1 }, ctx({ stopName: 'Main St @ South St' })),
    { title: 'Next stop: Main St @ South St · get off', body: 'Arrive ~6:43pm' });
  assert.equal(rideAlertText({ kind: 'getOff', leg: 1 }, ctx({ stopName: undefined })).title, 'Next stop: get off');
  const replanned = [ride.legs[0], leg('b2', '18:54', '19:06', 'Bus 132')];
  assert.deepEqual(rideAlertText({ kind: 'missed', leg: 1 }, ctx({ outlook: { ...outlook, legs: replanned, missedDep: at('18:26') } })),
    { title: 'Missed the 6:26pm Bus 132', body: 'Next: Bus 132 6:54pm · arrive 7:11pm' });
  // Updates show the time last sent; a missed alert's update names the departure it missed.
  assert.equal(rideAlertText({ kind: 'headsUp', leg: 0, n: 3, update: true, was: at('17:54') }, ctx()).body, 'Orange Line · arrive 5:56pm (was 5:54pm)');
  assert.equal(rideAlertText({ kind: 'getOff', leg: 0, update: true, was: at('18:22') }, ctx({ outlook })).body,
    'Then Bus 132 toward Redstone 6:26pm · 25 min to spare (was 6:22pm)');
  assert.deepEqual(rideAlertText({ kind: 'missed', leg: 1, missedDep: at('18:20'), update: true, was: at('18:50') }, ctx({ outlook: { ...outlook, legs: replanned } })),
    { title: 'Missed the 6:20pm Bus 132', body: 'Next: Bus 132 6:54pm (was 6:50pm) · arrive 7:11pm' });
  assert.equal(rideAlertText({ kind: 'none', leg: 1 }, ctx({ outlook: { ...outlook, none: true } })).title, 'No connection after 6:01pm');
});

test('checkRide: the trip, one leg per transit leg, times, and a ride ending soon', () => {
  const now = at('07:00');
  const legs = [{ tripId: 'b1', dep: at('07:10'), arr: at('07:25'), label: 'Bus 132' }, { tripId: 'o1', dep: at('07:33'), arr: at('07:50') }];
  const ride = { legs, boardedAt: at('07:10') };
  assert.equal(checkRide(homeToOffice, ride, now), null);
  assert.equal(checkRide({ name: 'x' }, ride, now), 'trip is invalid');
  assert.equal(checkRide(homeToOffice, { ...ride, legs: legs.slice(1) }, now), 'ride.legs must match the trip');
  assert.equal(checkRide(homeToOffice, { ...ride, legs: [{ ...legs[0], tripId: 7 }, legs[1]] }, now), 'ride leg tripId is invalid');
  assert.equal(checkRide(homeToOffice, { ...ride, legs: [{ ...legs[0], arr: at('07:00') }, legs[1]] }, now), 'ride leg times are invalid');
  assert.equal(checkRide(homeToOffice, { ...ride, legs: [{ ...legs[0], label: 5 }, legs[1]] }, now), 'ride leg label is invalid');
  assert.equal(checkRide(homeToOffice, { ...ride, boardedAt: 'x' }, now), 'ride.boardedAt is invalid');
  assert.equal(checkRide(homeToOffice, ride, at('14:00')), 'the ride must end in the next 6 hours');
});

test('proxyRequestError: the allowlist of paths and parameters', () => {
  const [trip] = JSON.parse(readFileSync('test/fixtures/bus-orange.json', 'utf8')).trips;
  const leg = tripShape(trip).transit[1];
  // What the app and the server send passes.
  assert.equal(proxyRequestError('/predictions', Object.entries(legQuery(leg))), null);
  assert.equal(proxyRequestError('/predictions', Object.entries(rideStopsQuery('t1'))), null);
  assert.equal(proxyRequestError('/alerts', [['filter[route]', '132,Orange'], ['filter[datetime]', 'NOW'], ['fields[alert]', 'effect']]), null);
  assert.equal(proxyRequestError('/route_patterns', [['filter[route]', 'Red'], ['filter[canonical]', 'true'], ['include', 'representative_trip.stops'], ['fields[trip]', '']]), null);
  assert.equal(proxyRequestError('/vehicles', []), 'path is not allowed');
  assert.equal(proxyRequestError('/toString', []), 'path is not allowed');
  assert.equal(proxyRequestError('/stops', [['api_key', 'k']]), 'api_key is not allowed');
  assert.equal(proxyRequestError('/alerts', [['filter[stop]', 'x']]), 'filter[stop] is not allowed');
  assert.equal(proxyRequestError('/stops', [['filter[route]', 'a'], ['filter[route]', 'b']]), 'filter[route] is repeated');
  assert.equal(proxyRequestError('/stops', [['filter[route]', 'x'.repeat(2001)]]), 'filter[route] is too long');
  assert.deepEqual(Object.fromEntries(Object.entries(MBTA_PROXY_PATHS).map(([p, v]) => [p, v.cache])), {
    '/predictions': 'predictions', '/schedules': 'schedules', '/alerts': 'alerts', '/routes': 'static', '/stops': 'static', '/route_patterns': 'static',
  });
  assert.equal(CACHE_CLASSES.predictions.stale, 2 * 60_000);
});

test('mbtaCacheKey: sorted parameters, without the API key', () => {
  assert.equal(mbtaCacheKey('/stops', { 'filter[route]': 'Red', 'fields[stop]': 'name', api_key: 'k' }), '/stops?fields%5Bstop%5D=name&filter%5Broute%5D=Red');
  assert.equal(mbtaCacheKey('/stops', { 'fields[stop]': 'name', 'filter[route]': 'Red' }), mbtaCacheKey('/stops', { 'filter[route]': 'Red', 'fields[stop]': 'name' }));
  assert.equal(mbtaCacheKey('/routes', { 'filter[type]': 3 }), '/routes?filter%5Btype%5D=3');
});
