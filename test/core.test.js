import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG, validateConfig, analyzeCommute, pickDirection, periodKey, scheduleWindow,
  mergeTrips, directRows, connectionRows, countdownState, pollIntervalMs,
  filterAlerts, expandStops, childToParentMap, commuteEntities, formatCountdown,
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
  assert.deepEqual(scheduleWindow(at('17:30')), { date: '2026-09-30', minTime: '17:25', maxTime: '21:30' });
  const lateNight = Date.parse('2026-10-01T00:40:00-04:00');
  assert.deepEqual(scheduleWindow(lateNight), { date: '2026-09-30', minTime: '24:35', maxTime: '28:40' });
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
  const rows = directRows(homeToOffice, trips, at('07:15'), 1);
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
  // b1 17:40: latest train arriving by 17:35 is o2 (dep 17:16).
  assert.equal(rows[0].train.dep, at('17:16'));
  assert.equal(rows[0].leaveBy, at('17:06'));
  assert.equal(rows[0].source, 'scheduled'); // bus scheduled
  // b2 17:57: o3 (arr 17:37) is latest before 17:52.
  assert.equal(rows[1].train.dep, at('17:21'));
  assert.equal(rows[1].source, 'scheduled');
  // b3 18:39: o9 arr 18:17 <= 18:34.
  assert.equal(rows[2].train.dep, at('18:01'));

  const live = connectionRows(officeToHome, buses2, orange, now);
  assert.equal(live[0].source, 'live');

  // Train must be reachable: at 17:08 o1/o2 departures (17:11, 17:16) are before now + 10 walk,
  // and o3 arrives too late for the 17:40 bus.
  const late = connectionRows(officeToHome, buses2, orange, at('17:08'));
  assert.equal(late[0].noConnection, true);
  assert.equal(late[0].leaveBy, null);

  // At 17:10, the 17:40 bus needs arrival by 17:35 but boarding is 17:20 + 16 min ride: skipped.
  assert.deepEqual(connectionRows(officeToHome, buses2, orange, at('17:10')), []);
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
