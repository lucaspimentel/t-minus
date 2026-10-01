import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateConfig, tripShape, scheduleWindow, mergeTrips, legVehicles, averageHeadway, pickTimingLeg,
  tripRows, pickTrip, inWindow, countdownState, pollIntervalMs,
  filterAlerts, expandStops, childToParentMap, commuteEntities, formatCountdown, countdownLabel,
  nextServiceWindow, fillRows, formatTime, departureCount, stopSlackMinutes, stopQueries, checkStops, stopsKey, tripLabel,
  tripToForm, formToTrip, routeLabel, routeEnds, searchRoutes, searchStops, stopsAfter, defaultTransferMinutes,
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
  const rows = tripRows(trip, [buses], 0, at('07:15'), 1);
  assert.deepEqual(rows.map(r => r.key), ['b2', 'b3']);
  assert.equal(rows[0].leaveBy, at('07:34')); // 07:40 - 5 walk - 1 slack
  assert.equal(rows[0].firstDep, at('07:40'));
  assert.equal(rows[0].eta, at('07:52'));
  assert.deepEqual(rows[0].legs, [{ route: '132', label: '132', color: null, dep: at('07:40'), arr: at('07:50'), source: 'live' }]);
  // Past leave-by but before the bus leaves: the row stays ("Hurry").
  assert.deepEqual(tripRows(trip, [buses], 0, at('07:38'), 1).map(r => r.key), ['b2', 'b3']);
  assert.equal(countdownState(at('07:38'), rows[0].leaveBy, rows[0].firstDep), 'red');
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
  // b1 17:40 - 5 transfer: latest train arriving by 17:35 is o2. No stop slack (timing leg is not first).
  assert.equal(rows[0].legs[0].dep, at('17:16'));
  assert.equal(rows[0].leaveBy, at('17:06'));
  assert.equal(rows[0].eta, at('17:55'));
  // Each leg keeps its own source.
  assert.deepEqual(rows[0].legs.map(l => l.source), ['live', 'scheduled']);
  assert.equal(rows[1].legs[0].dep, at('17:21'));
  assert.equal(rows[2].legs[0].dep, at('18:01'));
  // At 17:08, o2 (17:16) can't be reached with a 10-minute walk and o3 arrives too late
  // for b1, so b1 is skipped.
  assert.deepEqual(tripRows(officeToHome, [trains, buses], 1, at('17:08'), 1).map(r => r.key), ['b2', 'b3']);
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
  assert.equal(row.leaveBy, at('08:10'));
  assert.equal(row.eta, at('09:09'));
  assert.equal(row.timingIdx, 1);
});

test('countdownState boundaries', () => {
  const leave = at('08:00');
  const dep = at('08:06');
  assert.equal(countdownState(at('07:57'), leave, dep), 'green');
  assert.equal(countdownState(at('07:58'), leave, dep), 'amber');
  assert.equal(countdownState(at('08:00'), leave, dep), 'red');
  assert.equal(countdownState(at('08:06'), leave, dep), 'hidden');
  assert.equal(countdownState(at('08:00'), null, dep), 'none');
});

test('pollIntervalMs: 60s within 15 minutes of leave-by, otherwise 120s', () => {
  const dep = at('09:00');
  assert.equal(pollIntervalMs([{ leaveBy: at('08:45'), firstDep: dep }], at('08:30')), 60_000);
  assert.equal(pollIntervalMs([{ leaveBy: at('08:46'), firstDep: dep }], at('08:30')), 120_000);
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
  assert.equal(countdownLabel('amber', 90_000), 'Leave now · 1 min');
  assert.equal(countdownLabel('amber', 59_000), 'Leave now!');
  assert.equal(countdownLabel('red', -30_000), 'Hurry');
  assert.equal(countdownLabel('none', 0), 'No connection');
});

test('windowLabel formats trip windows for the setup list', () => {
  assert.equal(windowLabel(null), 'Any time');
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
