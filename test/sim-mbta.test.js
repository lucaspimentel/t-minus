// The fake MBTA (sim-mbta.js): shared by the browser tests and the simulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeMbta, localMs, minutesOf, series, scenarioFromSchedules, staticFromIncluded, mergeTripStops, applyTweaks } from '../sim-mbta.js';

const DATE = '2026-10-05';
const at = hhmm => localMs(DATE, minutesOf(hhmm));
const url = (path, params) => new URL(`https://api-v3.mbta.com${path}?${new URLSearchParams(params)}`);
const STATIC = {
  names: new Map([['A', 'Alpha'], ['B', 'Beta'], ['P', 'Station'], ['P-1', 'Station']]),
  parents: new Map([['P-1', 'P']]),
  coords: new Map([['A', { latitude: 42.4, longitude: -71.0 }], ['B', { latitude: 42.5, longitude: -71.0 }], ['P', { latitude: 42.6, longitude: -71.0 }]]),
};
const leg = { 'filter[route]': '132', 'filter[direction_id]': '1', 'filter[stop]': 'A,P', include: 'stop,trip' };

function scenario() {
  return { alerts: [], trips: series({ prefix: 'b', route: '132', direction: 1, first: '07:00', every: 30, count: 3, stops: [['A', 0], ['B', 5], ['P-1', 10]] }) };
}

test('minutesOf reads HH:MM, HH:MM:SS and numbers', () => {
  assert.equal(minutesOf('07:12'), 432);
  assert.equal(minutesOf('25:00:30'), 1500.5);
  assert.equal(minutesOf(12), 12);
  assert.equal(localMs(DATE, 432.5) - localMs(DATE, 432), 30_000);
});

test('schedules: window, route, direction and parent stations', () => {
  const fake = createFakeMbta(scenario(), STATIC);
  const doc = fake.answer(url('/schedules', { ...leg, 'filter[date]': DATE, 'filter[min_time]': '07:20', 'filter[max_time]': '08:00' }), at('07:00'));
  assert.deepEqual(doc.data.map(d => d.relationships.trip.data.id), ['b-0730', 'b-0730', 'b-0800']);
  assert.ok(doc.included.some(s => s.id === 'P-1' && s.relationships.parent_station.data.id === 'P'));
  const other = fake.answer(url('/schedules', { ...leg, 'filter[direction_id]': '0', 'filter[date]': DATE, 'filter[min_time]': '00:00', 'filter[max_time]': '28:00' }), at('07:00'));
  assert.equal(other.data.length, 0);
});

test('predictions: only live trips, passed stops dropped, delays applied', () => {
  const s = scenario();
  s.trips[0].live = { delay: 2 };
  const fake = createFakeMbta(s, STATIC);
  const doc = fake.answer(url('/predictions', leg), at('07:05'));
  assert.deepEqual(doc.data.map(d => [d.relationships.stop.data.id, d.attributes.departure_time.slice(11, 16)]), [['P-1', '07:12']]);
  s.trips[0].live = { delays: { 'P-1': 4 } }; // read live on every answer
  assert.equal(fake.answer(url('/predictions', leg), at('07:05')).data[0].attributes.departure_time.slice(11, 16), '07:14');
});

test('liveWithinMin: predictions only near the trip', () => {
  const s = { ...scenario(), liveWithinMin: 20 };
  const fake = createFakeMbta(s, STATIC);
  const trips = doc => [...new Set(doc.data.map(d => d.relationships.trip.data.id))];
  assert.deepEqual(trips(fake.answer(url('/predictions', leg), at('06:50'))), ['b-0700']);
  assert.deepEqual(trips(fake.answer(url('/predictions', leg), at('07:15'))), ['b-0730']);
});

test('cancelled stops are SKIPPED', () => {
  const s = scenario();
  Object.assign(s.trips[1], { live: true, cancelled: ['A', 'B', 'P-1'] });
  const doc = createFakeMbta(s, STATIC).answer(url('/predictions', leg), at('07:20'));
  assert.ok(doc.data.every(d => d.attributes.schedule_relationship === 'SKIPPED' && d.attributes.departure_time === null));
});

test('a trip on a date answers only on that date', () => {
  const s = scenario();
  s.trips[0].date = '2026-10-06';
  const doc = createFakeMbta(s, STATIC).answer(url('/schedules', { ...leg, 'filter[date]': DATE, 'filter[min_time]': '00:00', 'filter[max_time]': '28:00' }), at('06:00'));
  assert.ok(!doc.data.some(d => d.relationships.trip.data.id === 'b-0700'));
});

test('filter[trip] schedules: the stop list with sequences', () => {
  const doc = createFakeMbta(scenario(), STATIC).answer(url('/schedules', { 'filter[trip]': 'b-0700', 'filter[date]': DATE }), at('06:00'));
  assert.deepEqual(doc.data.map(d => d.attributes.stop_sequence), [10, 20, 30]);
});

test('noShapes answers a shape request with undefined (a 503)', () => {
  const fake = createFakeMbta({ ...scenario(), noShapes: true }, STATIC);
  assert.equal(fake.answer(url('/route_patterns', { 'filter[route]': '132', 'filter[direction_id]': '1', include: 'representative_trip.shape' }), at('07:00')), undefined);
  assert.equal(fake.answer(url('/nothing', {}), at('07:00')), null);
});

test('moving vehicles: at the first stop, between stops, past the last', () => {
  const s = { ...scenario(), moving: true };
  const fake = createFakeMbta(s, STATIC);
  assert.equal(fake.vehicleAt('b-0700', at('06:40')), null);
  assert.equal(fake.vehicleAt('b-0700', at('06:55')).status, 'STOPPED_AT');
  const mid = fake.vehicleAt('b-0700', at('07:02:40'));
  assert.equal(mid.status, 'IN_TRANSIT_TO');
  assert.ok(mid.lat > 42.4 && mid.lat < 42.5);
  const after = fake.vehicleAt('b-0700', at('07:11'));
  assert.ok(after.lat > 42.6); // past the last stop, on the same bearing
  assert.equal(fake.vehicleAt('b-0700', at('07:20')), null);
  const doc = fake.answer(url('/vehicles', { 'filter[route]': '132', 'filter[direction_id]': '1' }), at('07:02'));
  assert.deepEqual(doc.data.map(v => v.relationships.trip.data.id), ['b-0700']);
});

test('replay: a real schedules doc becomes scenario trips on its date', () => {
  const doc = {
    data: [
      { type: 'schedule', attributes: { departure_time: '2026-10-05T07:10:00-04:00', arrival_time: '2026-10-05T07:10:00-04:00' }, relationships: { route: { data: { id: '132' } }, trip: { data: { id: 'T1' } }, stop: { data: { id: 'A' } } } },
      { type: 'schedule', attributes: { departure_time: null, arrival_time: '2026-10-05T07:24:30-04:00', drop_off_type: 3 }, relationships: { route: { data: { id: '132' } }, trip: { data: { id: 'T1' } }, stop: { data: { id: 'P-1' } } } },
      { type: 'schedule', attributes: { departure_time: '2026-10-06T00:30:00-04:00' }, relationships: { route: { data: { id: '132' } }, trip: { data: { id: 'T2' } }, stop: { data: { id: 'A' } } } },
    ],
    included: [
      { type: 'trip', id: 'T1', attributes: { headsign: 'Malden' } },
      { type: 'stop', id: 'P-1', attributes: { name: 'Station', latitude: 1, longitude: 2, platform_code: '3' }, relationships: { parent_station: { data: { id: 'P' } } } },
    ],
  };
  const trips = scenarioFromSchedules(doc, { direction: '1', date: DATE });
  assert.deepEqual(trips[0], { id: 'T1', route: '132', direction: 1, date: DATE, headsign: 'Malden', stops: [['A', 430], ['P-1', 444.5]], dropOff: { 'P-1': 3 } });
  assert.deepEqual(trips[1].stops, [['A', 24 * 60 + 30]]); // after midnight: past 24h
  const st = staticFromIncluded([doc]);
  assert.equal(st.names.get('P-1'), 'Station');
  assert.equal(st.parents.get('P-1'), 'P');
  assert.deepEqual(st.coords.get('P-1'), { latitude: 1, longitude: 2 });
  assert.equal(st.platforms['P-1'], '3');
  // The replayed trip answers like the recorded one.
  const fake = createFakeMbta({ alerts: [], trips }, STATIC);
  const sch = fake.answer(url('/schedules', { ...leg, 'filter[date]': DATE, 'filter[min_time]': '07:00', 'filter[max_time]': '08:00' }), at('06:00'));
  assert.deepEqual(sch.data.map(d => d.attributes.arrival_time), ['2026-10-05T07:10:00-04:00', '2026-10-05T07:24:30-04:00']);
  const full = mergeTripStops(trips[0], { data: [['A', 10, '07:10'], ['B', 20, '07:17'], ['P-1', 30, '07:24:30']].map(([id, seq, t]) => ({ attributes: { stop_sequence: seq, departure_time: `2026-10-05T${t.length === 5 ? `${t}:00` : t}-04:00` }, relationships: { stop: { data: { id } } } })) });
  assert.deepEqual(full.stops.map(([id]) => id), ['A', 'B', 'P-1']);
});

test('tweaks: late from the next stop on (cumulative), cancel, an earlier one', () => {
  const base = scenario();
  base.trips[0].live = true;
  const late = applyTweaks(base, [{ type: 'late', tripId: 'b-0700', date: DATE, at: at('07:03'), min: 2 }, { type: 'late', tripId: 'b-0700', date: DATE, at: at('07:03'), min: 2 }]);
  assert.deepEqual(late.trips[0].live.delays, { A: 0, B: 4, 'P-1': 4 });
  assert.equal(base.trips[0].live, true); // the base is unchanged
  const fake = createFakeMbta(late, STATIC);
  assert.equal(fake.answer(url('/predictions', leg), at('07:05')).data[0].attributes.departure_time.slice(11, 16), '07:14');
  const cancelled = applyTweaks(base, [{ type: 'cancel', tripId: 'b-0700', date: DATE, at: at('07:03') }]);
  assert.deepEqual(cancelled.trips[0].cancelled, ['B', 'P-1']);
  const early = applyTweaks(base, [{ type: 'earlier', tripId: 'b-0730', date: DATE, at: at('07:10') }]);
  const added = early.trips.find(t => t.id === 'b-0730~early1');
  assert.deepEqual(added.stops, [['A', 447], ['B', 452], ['P-1', 457]]);
  assert.equal(added.added, true);
  const preds = createFakeMbta(early, STATIC).answer(url('/predictions', leg), at('07:20'));
  assert.ok(preds.data.some(d => d.relationships.trip.data.id === 'b-0730~early1' && d.attributes.schedule_relationship === 'ADDED'));
});

test('trackAt: the platform only once assigned', () => {
  const s = scenario();
  Object.assign(s.trips[0], { live: true, track: { 'P-1': 'P-9' }, trackAt: '07:05' });
  const fake = createFakeMbta(s, STATIC);
  const stopAt = t => fake.answer(url('/predictions', { ...leg, 'filter[stop]': 'A,P,P-9' }), at(t)).data.map(d => d.relationships.stop.data.id);
  assert.deepEqual(stopAt('07:01'), ['P-1']);
  assert.deepEqual(stopAt('07:06'), ['P-9']);
});

test('the presets are the browser specs\' commutes', async () => {
  const { PRESETS, COMMUTE_CONFIG, commute: presetCommute, CR_COMMUTE_CONFIG, crCommute: presetCr } = await import('../sim-presets.js');
  const cfg = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/bus-orange.json', import.meta.url), 'utf8'));
  cfg.trips.forEach((t, i) => { t.id = ['home', 'office'][i]; });
  for (const t of cfg.trips) for (const l of t.legs) if (l.kind === 'transit') Object.assign(l, l.route === '132' ? { label: 'Bus 132', color: 'FFC72C' } : { label: 'Orange', color: 'ED8B00' });
  assert.deepEqual(COMMUTE_CONFIG, cfg);
  const helpers = await import('./browser/helpers.js'); // no Playwright imports
  assert.deepEqual(presetCommute({ live: true }), helpers.commute({ live: true }));
  assert.deepEqual(presetCr(), helpers.crCommute());
  assert.deepEqual(CR_COMMUTE_CONFIG, helpers.CR_CONFIG);
  assert.deepEqual(PRESETS.map(p => p.id), ['on-time', 'tight', 'missed', 'earlier', 'cancelled', 'track']);
  for (const p of PRESETS) assert.equal(p.scenario().liveWithinMin, 60);
});

test('rideVehicleAt: a ride\'s vehicle stays stopped at that stop, which stays listed', () => {
  const s = scenario();
  const ask = (sc, time) => createFakeMbta(sc, STATIC).answer(url('/predictions', { 'filter[trip]': 'b-0700' }), at(time));
  const plain = ask(s, '07:03');
  assert.equal(plain.data[0].relationships.stop.data.id, 'B'); // A has passed
  s.rideVehicleAt = { 'b-0700': 'A' };
  const held = ask(s, '07:03');
  assert.deepEqual(held.data.map(d => d.relationships.stop.data.id), ['A', 'B', 'P-1']);
  const v = held.included.find(i => i.type === 'vehicle');
  assert.equal(v.attributes.current_status, 'STOPPED_AT');
  assert.equal(v.attributes.current_stop_sequence, held.data[0].attributes.stop_sequence);
});
