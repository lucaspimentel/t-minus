// The simulator's pure helpers (core.js "simulator"; DESIGN.md "Simulator").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  simCurrentRide, simJumpTargets, simPhaseKey, pickSnapshot, simDayQuery, dayRides, simRideLabel, offsetPoint, tripShape, legQuery,
} from '../core.js';
import { createFakeMbta, series } from '../sim-mbta.js';

const at = hhmm => Date.parse(`2026-10-05T${hhmm}:00-04:00`);
const MIN = 60_000;
const [trip] = JSON.parse(readFileSync('test/fixtures/bus-orange.json', 'utf8')).trips;
trip.id = 'home';
for (const l of trip.legs) if (l.kind === 'transit') l.label = l.route === '132' ? 'Bus 132' : 'Orange';
const shape = tripShape(trip);
const legs = [
  { route: '132', label: 'Bus 132', dep: at('07:10'), arr: at('07:24'), tripId: 'b1' },
  { route: 'Orange', label: 'Orange', dep: at('07:30'), arr: at('07:45'), tripId: 'o1' },
];

test('simCurrentRide: the ride, else the bell, else the target row', () => {
  const rows = [{ key: 'b0', leaveBy: at('06:30'), lastChance: at('06:35'), firstDep: at('06:40'), legs }, { key: 'b1', leaveBy: at('07:00'), lastChance: at('07:05'), firstDep: at('07:10'), legs }];
  assert.deepEqual(simCurrentRide({ enRoute: { ride: { legs } }, rows, nowMs: at('07:15') }), { legs, leaveBy: null, source: 'ride' });
  assert.equal(simCurrentRide({ enRoute: { kind: 'track', pinned: true, bell: true, target: { key: 'b1', legs } }, rows, nowMs: at('06:00') }).leaveBy, at('07:00'));
  assert.equal(simCurrentRide({ enRoute: null, rows, nowMs: at('06:50') }).leaveBy, at('07:00'));
  assert.equal(simCurrentRide({ enRoute: null, rows: [], nowMs: at('06:50') }), null);
});

test('simJumpTargets: leave-by, departures, transfers, arrival', () => {
  const names = new Map([[shape.transit[0].alight, 'Malden Center']]);
  const t = simJumpTargets({ legs, leaveBy: at('07:00') }, shape, names);
  assert.deepEqual(t.map(x => [x.key, x.label, x.at]), [
    ['leave', 'Leave-by', at('07:00')], ['dep0', 'Bus 132', at('07:10')], ['xfer0', 'Malden', at('07:24')],
    ['dep1', 'Orange', at('07:30')], ['arrive', 'Arrive', at('07:45') + shape.walkAfter * MIN],
  ]);
  // Riding: no leave-by; a recorded get-off moves the transfer.
  const riding = simJumpTargets({ legs: [{ ...legs[0], off: at('07:20') }, legs[1]], leaveBy: null }, shape);
  assert.deepEqual(riding.map(x => x.key), ['dep0', 'xfer0', 'dep1', 'arrive']);
  assert.equal(riding[1].label, 'Transfer');
  const long = simJumpTargets({ legs, leaveBy: null }, shape, new Map([[shape.transit[0].alight, 'Washington St opp Oak Grove Sta']]));
  assert.equal(long[1].label, 'Transfer');
  assert.equal(riding[1].at, at('07:20'));
  assert.deepEqual(simJumpTargets(null, shape), []);
});

test('simPhaseKey changes with each step', () => {
  const ride = { legs };
  const key = (state, t) => simPhaseKey(state, shape.walkAfter, at(t));
  assert.equal(key(null, '07:00'), 'none');
  assert.equal(key({ kind: 'track', pinned: true }, '07:00'), 'bell');
  assert.equal(key({ kind: 'leaving' }, '07:00'), 'leaving');
  assert.equal(key({ kind: 'track', asking: { dep: 1 } }, '07:00'), 'asking');
  assert.equal(key({ ride }, '07:15'), 'riding:0');
  assert.equal(key({ ride }, '07:26'), 'transfer:1');
  assert.equal(key({ ride }, '07:35'), 'riding:1');
  assert.equal(key({ ride }, '07:46'), 'walking');
});

test('pickSnapshot: the latest at or before the target, else the earliest', () => {
  const list = [{ id: 1, at: 10 }, { id: 3, at: 30 }, { id: 2, at: 20 }];
  assert.equal(pickSnapshot(list, 25).id, 2);
  assert.equal(pickSnapshot(list, 30).id, 3);
  assert.equal(pickSnapshot(list, 5).id, 1);
  assert.equal(pickSnapshot([], 5), null);
});

test('dayRides and simRideLabel: a whole day of rides from schedules', () => {
  const fake = createFakeMbta({ alerts: [], trips: [
    ...series({ prefix: '132in', route: '132', direction: 1, first: '05:44', every: 28, count: 40, stops: [['25996', 0], ['25997', 4], ['5991', 14]] }),
    ...series({ prefix: 'OLin', route: 'Orange', direction: 0, first: '05:20', every: 6, count: 190, stops: [['70036', 0], ['70022', 15]] }),
  ] }, { parents: new Map([['70036', 'place-ogmnl'], ['70022', 'place-state']]) });
  const q = simDayQuery(shape.transit[0], '2026-10-05');
  assert.deepEqual({ ...q, 'filter[date]': undefined, 'filter[min_time]': undefined, 'filter[max_time]': undefined }, { ...legQuery(shape.transit[0]), 'filter[date]': undefined, 'filter[min_time]': undefined, 'filter[max_time]': undefined });
  assert.equal(q['filter[max_time]'], '28:00');
  const docs = shape.transit.map(l => fake.answer(new URL(`https://x/schedules?${new URLSearchParams(simDayQuery(l, '2026-10-05'))}`), at('03:00')));
  const rides = dayRides(trip, docs, '2026-10-05', 1);
  assert.ok(rides.length > 30);
  assert.equal(rides[0].legs[0].tripId, '132in-0544');
  assert.match(simRideLabel(rides[0]), /^5:44am Bus 132 → \d+:\d\dam Orange · arrive \d+:\d\dam$/);
});

test('offsetPoint moves about the given distance', () => {
  const p = offsetPoint({ lat: 42.4, lon: -71.07 }, 300, 0);
  assert.ok(Math.abs((p.lat - 42.4) * 111_320 - 300) < 1);
  assert.equal(p.lon, -71.07);
  const e = offsetPoint({ lat: 42.4, lon: -71.07 }, 300, 90);
  assert.ok(Math.abs((e.lon + 71.07) * 111_320 * Math.cos(42.4 * Math.PI / 180) - 300) < 1);
});
