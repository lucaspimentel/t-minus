import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG, validateConfig, analyzeCommute, pickDirection, periodKey, scheduleWindow,
  mergeTrips, directRows, connectionRows, countdownState, pollIntervalMs,
  filterAlerts, expandStops, childToParentMap, commuteEntities, formatCountdown,
  nextServiceWindow, fillRows, formatTime, departureCount, stopQueries, checkStops, stopsKey,
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

const [homeToOffice, officeToHome] = DEFAULT_CONFIG.commutes;

test('default config is valid', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});

test('validateConfig rejects missing bottleneck and misplaced connection', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.commutes[0].legs[1].role = 'filler';
  const legs = cfg.commutes[1].legs;
  [legs[1], legs[3]] = [legs[3], legs[1]];
  const errors = validateConfig(cfg);
  assert.ok(errors.some(e => e.includes('commutes[0] needs exactly one bottleneck')));
  assert.ok(errors.some(e => e.includes('connection leg must come before')));
});

test('analyzeCommute derives offsets', () => {
  assert.deepEqual(
    (({ walkBefore, transfer, after }) => ({ walkBefore, transfer, after }))(analyzeCommute(homeToOffice)),
    { walkBefore: 5, transfer: 0, after: 5 + 15 + 10 });
  const o = analyzeCommute(officeToHome);
  assert.equal(o.walkBefore, 10);
  assert.equal(o.transfer, 5);
});

test('pickDirection uses cutoff and period-scoped override', () => {
  assert.equal(pickDirection(at('11:59'), DEFAULT_CONFIG, null), 0);
  assert.equal(pickDirection(at('12:00'), DEFAULT_CONFIG, null), 1);
  const override = { index: 1, period: periodKey(at('08:00'), '12:00') };
  assert.equal(pickDirection(at('09:00'), DEFAULT_CONFIG, override), 1);
  // Override expires once the cutoff is crossed.
  assert.equal(pickDirection(at('13:00'), DEFAULT_CONFIG, { index: 0, period: override.period }), 1);
});

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

test('directRows: leave-by, ETA, ordering, past buses excluded', () => {
  const trips = mergeTrips(
    doc([rec('prediction', 'b2', '25996', '07:40', '07:40'), rec('prediction', 'b2', '5991', '07:50', '07:50')]),
    doc([
      rec('schedule', 'b1', '25996', '07:10', '07:10'),
      rec('schedule', 'b2', '25996', '07:41', '07:41'),
      rec('schedule', 'b3', '25996', '08:10', '08:10'),
      rec('schedule', 'b3', '5991', '08:21', '08:21'),
      rec('schedule', 'b4', '25996', '08:44', '08:44'),
      rec('schedule', 'b5', '25996', '09:23', '09:23'),
    ]));
  const rows = directRows(homeToOffice, trips, at('07:15'), 1, 3);
  assert.deepEqual(rows.map(r => r.tripId), ['b2', 'b3', 'b4']);
  assert.equal(rows[0].source, 'live');
  assert.equal(rows[0].leaveBy, at('07:34'));
  // 07:50 at Oak Grove + 5 transfer + 15 Orange + 10 walk.
  assert.equal(rows[0].eta, at('08:20'));
  assert.equal(rows[1].source, 'scheduled');
  assert.equal(rows[2].eta, null);
});

test('connectionRows picks the latest viable train and flags gaps', () => {
  const orange = mergeTrips(
    doc([
      rec('prediction', 'o1', '70023', '17:10', '17:11'), rec('prediction', 'o1', '70036', '17:27', null),
      rec('prediction', 'o2', '70023', '17:15', '17:16'), rec('prediction', 'o2', '70036', '17:32', null),
    ], [stopInc('70023', 'place-state'), stopInc('70036', 'place-ogmnl')]),
    doc([
      rec('schedule', 'o3', '70023', '17:20', '17:21'), rec('schedule', 'o3', '70036', '17:37', '17:37'),
      rec('schedule', 'o9', '70023', '18:00', '18:01'), rec('schedule', 'o9', '70036', '18:17', '18:17'),
    ], [stopInc('70023', 'place-state'), stopInc('70036', 'place-ogmnl')]));
  const buses = mergeTrips(doc([]), doc([
    rec('schedule', 'b0', '9326', '17:05', '17:05'),
    rec('schedule', 'b1', '9326', '17:40', '17:40'),
    rec('schedule', 'b2', '9326', '17:57', '17:57'),
    rec('schedule', 'b3', '9326', '18:39', '18:39'),
  ]));
  const buses2 = mergeTrips(doc([rec('prediction', 'b1', '9326', '17:40', '17:40')]), doc([]));
  const now = at('17:00');

  const rows = connectionRows(officeToHome, buses, orange, now);
  // b0 is unreachable and skipped.
  assert.deepEqual(rows.map(r => r.tripId), ['b1', 'b2', 'b3']);
  // b1 17:40: latest train arriving by 17:35 is o2 (dep 17:16). Bus and train source
  // are independent: a scheduled bus paired with a live train reports each separately.
  assert.equal(rows[0].train.dep, at('17:16'));
  assert.equal(rows[0].leaveBy, at('17:06'));
  assert.equal(rows[0].source, 'scheduled'); // bus scheduled
  assert.equal(rows[0].train.source, 'live'); // o2 is a live prediction
  // b2 17:57: o3 (arr 17:37) is latest before 17:52.
  assert.equal(rows[1].train.dep, at('17:21'));
  assert.equal(rows[1].source, 'scheduled');
  assert.equal(rows[1].train.source, 'scheduled'); // o3 is a schedule only
  // b3 18:39: o9 arr 18:17 <= 18:34.
  assert.equal(rows[2].train.dep, at('18:01'));

  // A live bus keeps its own 'live' source even when paired with a scheduled train:
  // b4 (live, 17:45) is close enough that only the scheduled o3 (arr 17:37) fits the
  // transfer window; the live o1/o2 arrive too early to be "latest viable".
  const buses4 = mergeTrips(doc([rec('prediction', 'b4', '9326', '17:45', '17:45')]), doc([]));
  const liveBusScheduledTrain = connectionRows(officeToHome, buses4, orange, at('17:05'));
  assert.equal(liveBusScheduledTrain[0].train.dep, at('17:21')); // o3, the latest viable train
  assert.equal(liveBusScheduledTrain[0].source, 'live'); // b4 is a live prediction
  assert.equal(liveBusScheduledTrain[0].train.source, 'scheduled'); // matched to o3

  const live = connectionRows(officeToHome, buses2, orange, now);
  assert.equal(live[0].source, 'live');
  assert.equal(live[0].train.source, 'live');

  // At 17:08, o1/o2 (17:11, 17:16) depart before now + 10 walk and o3 arrives too late
  // for the 17:40 bus: no train can make it, so the bus is skipped.
  assert.deepEqual(connectionRows(officeToHome, buses2, orange, at('17:08')), []);

  // Without any connection data the bus is shown as "no connection".
  const noData = connectionRows(officeToHome, buses2, new Map(), at('17:08'));
  assert.equal(noData[0].noConnection, true);
  assert.equal(noData[0].leaveBy, null);

  // A first bus that departs before any train can arrive (start of service) is skipped
  // and the next buses still fill the rows.
  const early = connectionRows(officeToHome, buses, orange, at('16:30'));
  assert.deepEqual(early.map(r => r.tripId), ['b1', 'b2', 'b3']);
});

test('countdownState boundaries', () => {
  const leave = at('08:00');
  const bus = at('08:06');
  assert.equal(countdownState(at('07:57'), leave, bus), 'green');
  assert.equal(countdownState(at('07:58'), leave, bus), 'amber');
  assert.equal(countdownState(at('08:00'), leave, bus), 'red');
  assert.equal(countdownState(at('08:06'), leave, bus), 'hidden');
  assert.equal(countdownState(at('08:00'), null, bus), 'none');
});

test('pollIntervalMs switches at 15 minutes', () => {
  const bus = at('09:00');
  assert.equal(pollIntervalMs([{ leaveBy: at('08:45'), busDep: bus }], at('08:30')), 30_000);
  assert.equal(pollIntervalMs([{ leaveBy: at('08:46'), busDep: bus }], at('08:30')), 60_000);
  assert.equal(pollIntervalMs([], at('08:30')), 60_000);
});

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

test('formatCountdown', () => {
  assert.equal(formatCountdown(65_000), '1:05');
  assert.equal(formatCountdown(3_723_000), '1h 02m');
  assert.equal(formatCountdown(-5), '0:00');
});

test('nextServiceWindow targets the morning after the current service date', () => {
  assert.deepEqual(nextServiceWindow(at('23:40')), { date: '2026-10-01', minTime: '03:00', maxTime: '12:00' });
  // 00:40 on Oct 1 is still the Sep 30 service day, so the next one is Oct 1.
  assert.deepEqual(nextServiceWindow(Date.parse('2026-10-01T00:40:00-04:00')),
    { date: '2026-10-01', minTime: '03:00', maxTime: '12:00' });
  assert.equal(nextServiceWindow(Date.parse('2026-10-01T03:10:00-04:00')).date, '2026-10-02');
});

test('fillRows tops up from the next service day without trip id collisions', () => {
  const today = mergeTrips(null, doc([rec('schedule', 'b1', '25996', '23:32', '23:32')]));
  // GTFS trip ids repeat across days: same id 'b1' tomorrow morning.
  const tomorrowIso = hhmm => `2026-10-01T${hhmm}:00-04:00`;
  const nextDoc = doc(['06:03', '06:33', '06:51'].map((t, i) => ({
    type: 'schedule',
    attributes: { arrival_time: tomorrowIso(t), departure_time: tomorrowIso(t) },
    relationships: { trip: { data: { id: i === 0 ? 'b1' : `b${i + 1}` } }, stop: { data: { id: '25996' } } },
  })));
  const now = at('23:20');
  const rows = fillRows(
    directRows(homeToOffice, today, now, 1),
    directRows(homeToOffice, mergeTrips(null, nextDoc), now, 1));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(r => r.tripId), ['b1', 'b1', 'b2', 'b3']);
  assert.deepEqual(rows.map(r => !!r.nextDay), [false, true, true, true]);
  assert.equal(rows[1].busDep, Date.parse(tomorrowIso('06:03')));

  const full = [{ tripId: 'x' }, { tripId: 'y' }, { tripId: 'z' }];
  assert.deepEqual(fillRows(full, [{ tripId: 'n' }], 3).map(r => r.tripId), ['x', 'y', 'z']);
});

test('formatTime adds weekday only across a calendar date change', () => {
  const now = at('23:20');
  assert.equal(formatTime(at('23:32'), now), '11:32 PM');
  assert.equal(formatTime(Date.parse('2026-10-01T06:03:00-04:00'), now), 'Thu 6:03 AM');
  assert.equal(formatTime(at('23:32')), '11:32 PM');
});

test('departureCount defaults to 4 and is validated', () => {
  assert.equal(departureCount(DEFAULT_CONFIG), 4);
  const { departureCount: _, ...legacy } = DEFAULT_CONFIG;
  assert.equal(departureCount(legacy), 4);
  assert.deepEqual(validateConfig(legacy), []);
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG, departureCount: 6 }), []);
  for (const bad of [0, 9, 2.5, '4']) {
    assert.ok(validateConfig({ ...DEFAULT_CONFIG, departureCount: bad }).some(e => e.startsWith('departureCount')));
  }
});

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
  assert.deepEqual(stopQueries(DEFAULT_CONFIG).map(q => stopsKey(q.route, q.direction_id)).sort(),
    ['132/0', '132/1', 'Orange/0', 'Orange/1']);
});

test('checkStops accepts the default config and child platform ids', () => {
  assert.deepEqual(checkStops(DEFAULT_CONFIG, liveStops()), []);
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.commutes[1].legs[1].from = '70023';
  assert.deepEqual(checkStops(cfg, liveStops()), []);
});

test('checkStops reports unknown stops, wrong direction, and unknown routes', () => {
  const badStop = structuredClone(DEFAULT_CONFIG);
  badStop.commutes[1].legs[3].stop = '99999';
  assert.deepEqual(checkStops(badStop, liveStops()),
    ['commutes[1] 132: stop "99999" is not served by route 132 in direction 0.']);

  const swapped = structuredClone(DEFAULT_CONFIG);
  swapped.commutes[1].legs[1].direction_id = 0;
  assert.deepEqual(checkStops(swapped, liveStops()),
    ['commutes[1] Orange: from "place-state" comes after to "place-ogmnl" in direction 0; direction_id is probably wrong.']);

  const badRoute = structuredClone(DEFAULT_CONFIG);
  badRoute.commutes[0].legs[1].route = '999x';
  const errors = checkStops(badRoute, new Map([...liveStops(), [stopsKey('999x', 1), stopsDoc([])]]));
  assert.deepEqual(errors, ['commutes[0] 999x: no stops for route "999x" in direction 1; check route and direction_id.']);
});
