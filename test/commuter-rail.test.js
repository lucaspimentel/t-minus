// Commuter rail (route type 2): labels, the networks, merging tracks / trains / flag stops,
// per-train alerts, the track push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shortRouteLabel, routeLabel, routeEnds, commonLabel, lineLabel, islandLabel, vehicleArrow, isCommuterRailRoute, isSubwayRoute,
  EXCLUDED_ROUTES, transitNetwork, planTrips, railNetwork, reachableFrom, legBetween, mergeTrips, legVehicles, trackLegs, rowsFromDocs, checkRide,
  filterAlerts, tripAlerts, withTripAlerts, leaveActivityState, liveActivityState, reminderText, withTrack, flagStop, rideStops, tripStopCount, widgetView, trackStep, trackText,
} from '../core.js';

const MIN = 60_000;
// 2026-11-02 is EST (UTC-5).
const iso = hhmm => `2026-11-02T${hhmm}:00-05:00`;

const cr = (id, longName, dest = ['Haverhill', 'North Station']) =>
  ({ type: 'route', id, attributes: { type: 2, short_name: '', long_name: longName, color: '80276C', direction_destinations: dest, sort_order: 20000 } });
const orange = { type: 'route', id: 'Orange', attributes: { type: 1, short_name: '', long_name: 'Orange Line', color: 'ED8B00', direction_destinations: ['Forest Hills', 'Oak Grove'], sort_order: 10020 } };

test('commuter rail labels: "CR Haverhill" tight, "Haverhill Line" full, "CR" in the island', () => {
  const hav = cr('CR-Haverhill', 'Haverhill Line');
  assert.equal(shortRouteLabel(hav), 'CR Haverhill');
  assert.equal(shortRouteLabel(cr('CR-Worcester', 'Framingham/Worcester Line')), 'CR Framingham/Worcester');
  assert.equal(shortRouteLabel(cr('CR-NewBedford', 'Fall River/New Bedford Line')), 'CR Fall River/New Bedford');
  assert.equal(routeLabel(hav), 'Haverhill Line');
  assert.equal(routeEnds(hav), 'Haverhill - North Station');
  assert.equal(commonLabel(['CR Haverhill', 'CR Lowell']), 'CR Haverhill/Lowell');
  assert.equal(commonLabel(['CR Haverhill', 'CR Lowell'], true), 'CR');
  assert.equal(lineLabel({ label: 'CR Haverhill' }), 'Haverhill Line');
  assert.equal(lineLabel({ label: 'CR Framingham/Worcester' }), 'Framingham/Worcester Line');
  assert.equal(lineLabel({ label: 'CR' }), 'Commuter Rail');
  assert.equal(lineLabel({ label: 'CR', vehicleRoute: 'CR-Needham', routeLabels: { 'CR-Needham': 'CR Needham' } }), 'Needham Line');
  assert.equal(islandLabel({ label: 'CR Haverhill' }), 'CR');
  assert.equal(vehicleArrow({ label: 'CR Haverhill', headsign: 'Haverhill' }), 'CR Haverhill → Haverhill');
  // Unchanged for the subway.
  assert.equal(lineLabel({ label: 'Orange' }), 'Orange Line');
  assert.equal(shortRouteLabel(orange), 'Orange');
});

test('isCommuterRailRoute, EXCLUDED_ROUTES', () => {
  assert.equal(isCommuterRailRoute('CR-Haverhill'), true);
  assert.equal(isCommuterRailRoute('Orange'), false);
  assert.equal(isCommuterRailRoute(undefined), false);
  assert.equal(isSubwayRoute('CR-Haverhill'), false);
  assert.ok(EXCLUDED_ROUTES.has('CR-Foxboro'));
  assert.ok(!EXCLUDED_ROUTES.has('CR-Franklin'));
});

const stop = (id, name, lat, lon, parent = null) => ({ type: 'stop', id, attributes: { name, latitude: lat, longitude: lon }, relationships: { parent_station: { data: parent ? { id: parent } : null } } });
const pattern = (id, r, dir, ids, attrs) => [
  { type: 'route_pattern', id, attributes: { direction_id: dir, ...attrs }, relationships: { route: { data: { id: r } }, representative_trip: { data: { id: `rt-${id}` } } } },
  { type: 'trip', id: `rt-${id}`, relationships: { stops: { data: ids.map(x => ({ id: x })) } } },
];

// North Station → Malden Center → Reading on the Haverhill Line; the Orange Line through Malden
// Center to Oak Grove.
function crNetwork(sample = null) {
  const pats = [
    pattern('hav', 'CR-Haverhill', 0, ['BNT-0000', 'WR-0045-S', 'WR-0120-S'], { canonical: true }),
    pattern('hav-x', 'CR-Haverhill', 0, ['BNT-0000', 'WR-0120-S'], { canonical: false, typicality: 3 }),
    pattern('or', 'Orange', 0, ['70036', '70278'], { canonical: true }),
  ];
  const stops = [stop('BNT-0000', 'North Station', 42.3656, -71.0613, 'place-north'), stop('WR-0045-S', 'Malden Center', 42.4266, -71.0741, 'place-mlmnl'),
    stop('WR-0120-S', 'Reading', 42.5225, -71.1088, 'place-WR-0120'), stop('70036', 'Malden Center', 42.4267, -71.0742, 'place-mlmnl'), stop('70278', 'Oak Grove', 42.4367, -71.0712, 'place-ogmnl')];
  return transitNetwork({ data: [cr('CR-Haverhill', 'Haverhill Line'), orange] },
    { data: pats.map(p => p[0]), included: [...pats.map(p => p[1]), ...stops] }, sample);
}

test('transitNetwork: commuter rail keeps its canonical pattern, hops at 60 km/h without a sample', () => {
  const net = crNetwork();
  assert.deepEqual(net.patterns.map(p => p.route), ['CR-Haverhill', 'Orange']);
  assert.equal(net.routes['CR-Haverhill'].label, 'CR Haverhill');
  // North Station → Malden Center is ~6.9 km: ~7 min at 60 km/h.
  const km = 6.9;
  assert.ok(Math.abs(net.patterns[0].mins[0] - km / 60 * 60) < 0.5, String(net.patterns[0].mins[0]));
});

test('transitNetwork: a trip listed under two routes counts its hops once', () => {
  const rec = (route, stopId, t, seq) => ({ attributes: { departure_time: iso(t), stop_sequence: seq }, relationships: { trip: { data: { id: 'T1' } }, stop: { data: { id: stopId } }, route: { data: { id: route } } } });
  const one = [rec('CR-Haverhill', 'BNT-0000', '12:00', 1), rec('CR-Haverhill', 'WR-0045-S', '12:10', 2)];
  const two = [...one, rec('CR-Other', 'BNT-0000', '12:00', 1), rec('CR-Other', 'WR-0045-S', '12:10', 2)];
  assert.deepEqual(crNetwork({ data: two }).patterns[0].mins[0], crNetwork({ data: one }).patterns[0].mins[0]);
  assert.equal(crNetwork({ data: one }).patterns[0].mins[0], 10);
});

test('planTrips: commuter rail to the Orange Line at a shared station', () => {
  const net = crNetwork();
  const [opt] = planTrips(net, 'place-north', 'place-ogmnl');
  assert.deepEqual(opt.legs.map(l => [l.route, l.stop, l.alight]), [['CR-Haverhill', 'place-north', 'place-mlmnl'], ['Orange', 'place-mlmnl', 'place-ogmnl']]);
});

test('reachableFrom: commuter rail lines sharing a color stay apart', () => {
  const doc = {
    data: [pattern('hav', 'CR-Haverhill', 0, ['BNT-0000', 'WR-0045-S'], {})[0], pattern('low', 'CR-Lowell', 0, ['BNT-0000', 'NHRML-0055'], {})[0]],
    included: [pattern('hav', 'CR-Haverhill', 0, ['BNT-0000', 'WR-0045-S'], {})[1], pattern('low', 'CR-Lowell', 0, ['BNT-0000', 'NHRML-0055'], {})[1],
      stop('BNT-0000', 'North Station', 42.36, -71.06, 'place-north'), stop('WR-0045-S', 'Malden Center', 42.42, -71.07, 'place-mlmnl'),
      stop('NHRML-0055', 'West Medford', 42.42, -71.13, 'place-NHRML-0055')],
  };
  const net = railNetwork(doc, [cr('CR-Haverhill', 'Haverhill Line'), cr('CR-Lowell', 'Lowell Line', ['Lowell', 'North Station'])]);
  const groups = reachableFrom(net, 'place-north');
  assert.deepEqual(groups.map(g => g.label), ['CR Haverhill', 'CR Lowell']);
  assert.deepEqual(groups.map(g => g.stations.map(s => s.name)), [['Malden Center'], ['West Medford']]);
  // A station tapped in one group rides that group's line.
  assert.equal(legBetween(net, 'place-north', 'place-mlmnl', ['CR-Haverhill']).route, 'CR-Haverhill');
  assert.equal(legBetween(net, 'place-north', 'place-mlmnl', ['CR-Lowell']), null);
});

// ---------- merging predictions and schedules ----------

// Records for a trip at a stop (`route` per record: a trip on two routes comes twice).
const rec = (type, trip, stop, t, attrs = {}, route = 'CR-Haverhill') => ({
  type, id: `${type}-${trip}-${stop}-${route}`,
  attributes: { arrival_time: iso(t), departure_time: iso(t), ...attrs },
  relationships: { trip: { data: { id: trip } }, stop: { data: { id: stop } }, route: { data: { id: route } } },
});
const stopInc = (id, parent, code = null) => ({ type: 'stop', id, attributes: { name: id, platform_code: code }, relationships: { parent_station: { data: { id: parent } } } });
const tripInc = (id, name, headsign = 'Haverhill') => ({ type: 'trip', id, attributes: { headsign, name } });
const INC = [stopInc('BNT-0000', 'place-north'), stopInc('BNT-0000-05', 'place-north', '5'), stopInc('BNT-0000-07', 'place-north', '7'),
  stopInc('WR-0045-S', 'place-mlmnl', '1')];
const leg = { kind: 'transit', route: 'CR-Haverhill', direction_id: 0, stop: 'place-north', alight: 'place-mlmnl' };
const schedules = (...recs) => ({ data: recs, included: [...INC, tripInc('T1', '2317'), tripInc('T2', '2319'), tripInc('T3', '2321')] });
const predictions = (...recs) => ({ data: recs, included: [...INC, tripInc('T1', '2317'), tripInc('T2', '2319'), tripInc('T3', '2321')] });

test('legVehicles: the track assigned at North Station, the train number', () => {
  const sched = schedules(rec('schedule', 'T1', 'BNT-0000', '17:48'), rec('schedule', 'T1', 'WR-0045-S', '17:58'));
  // No prediction yet: scheduled, no track.
  let [v] = legVehicles(mergeTrips(null, sched), leg);
  assert.deepEqual([v.source, v.train, v.track], ['scheduled', '2317', undefined]);
  // Predicted at the station's no-track stop: still none.
  [v] = legVehicles(mergeTrips(predictions(rec('prediction', 'T1', 'BNT-0000', '17:49'), rec('prediction', 'T1', 'WR-0045-S', '17:59')), sched), leg);
  assert.deepEqual([v.source, v.dep, v.track], ['live', Date.parse(iso('17:49')), undefined]);
  // Given Track 5.
  [v] = legVehicles(mergeTrips(predictions(rec('prediction', 'T1', 'BNT-0000-05', '17:49'), rec('prediction', 'T1', 'WR-0045-S', '17:59')), sched), leg);
  assert.equal(v.track, '5');
  // Malden Center's scheduled stop is already a platform ("Track 1 (All Trains)"): no news there.
  const back = { ...leg, stop: 'place-mlmnl', alight: 'place-north' };
  const sb = schedules(rec('schedule', 'T1', 'WR-0045-S', '07:10'), rec('schedule', 'T1', 'BNT-0000', '07:20'));
  [v] = legVehicles(mergeTrips(predictions(rec('prediction', 'T1', 'WR-0045-S', '07:11'), rec('prediction', 'T1', 'BNT-0000', '07:21')), sb), back);
  assert.equal(v.track, undefined);
  // No schedule to compare with (an added trip): no track.
  [v] = legVehicles(mergeTrips(predictions(rec('prediction', 'T1', 'BNT-0000-05', '17:49'), rec('prediction', 'T1', 'WR-0045-S', '17:59')), null), leg);
  assert.equal(v.track, undefined);
});

test('legVehicles: no pickup (or no drop-off) leaves the trip out; flag stops are marked', () => {
  const sched = schedules(
    rec('schedule', 'T1', 'BNT-0000', '17:48', { pickup_type: 1 }), rec('schedule', 'T1', 'WR-0045-S', '17:58'),
    rec('schedule', 'T2', 'BNT-0000', '18:48'), rec('schedule', 'T2', 'WR-0045-S', '18:58', { drop_off_type: 1 }),
    rec('schedule', 'T3', 'BNT-0000', '19:48'), rec('schedule', 'T3', 'WR-0045-S', '19:58', { pickup_type: 3, drop_off_type: 3 }));
  const vs = legVehicles(mergeTrips(null, sched), leg);
  assert.deepEqual(vs.map(v => [v.tripId, v.flag]), [['T3', 'alight']]);
  // Predictions keep the schedule's pickup and drop-off.
  const live = legVehicles(mergeTrips(predictions(rec('prediction', 'T1', 'BNT-0000', '17:50'), rec('prediction', 'T1', 'WR-0045-S', '18:00'),
    rec('prediction', 'T3', 'BNT-0000', '19:50'), rec('prediction', 'T3', 'WR-0045-S', '20:00')), sched), leg);
  assert.deepEqual(live.map(v => [v.tripId, v.source, v.flag]), [['T3', 'live', 'alight']]);
  // Boarding at a flag stop too: both.
  const both = legVehicles(mergeTrips(null, schedules(rec('schedule', 'T3', 'BNT-0000', '19:48', { pickup_type: 3 }), rec('schedule', 'T3', 'WR-0045-S', '19:58', { drop_off_type: 3 }))), leg);
  assert.equal(both[0].flag, 'both');
  // Not on other modes (no "Flag stop" on a bus).
  const busLeg = { kind: 'transit', route: '132', direction_id: 0, stop: 'a', alight: 'b' };
  const bus = legVehicles(mergeTrips(null, { data: [rec('schedule', 'B1', 'a', '07:00', { pickup_type: 3 }, '132'), rec('schedule', 'B1', 'b', '07:10', {}, '132')] }), busLeg);
  assert.equal(bus[0].flag, undefined);
});

test('legVehicles: a trip on two routes is one vehicle, named by the leg\'s route', () => {
  const two = (type, t1, t2) => [rec(type, 'T1', 'BNT-0000', t1, {}, 'CR-Franklin'), rec(type, 'T1', 'BNT-0000', t1, {}, 'CR-Providence'),
    rec(type, 'T1', 'WR-0045-S', t2, {}, 'CR-Franklin'), rec(type, 'T1', 'WR-0045-S', t2, {}, 'CR-Providence')];
  const prov = { ...leg, route: 'CR-Providence' };
  const vs = legVehicles(mergeTrips(predictions(...two('prediction', '17:49', '17:59')), schedules(...two('schedule', '17:48', '17:58'))), prov);
  assert.equal(vs.length, 1);
  assert.deepEqual([vs[0].route, vs[0].source], ['CR-Providence', 'live']);
});

test('trackLegs: the track comes and stays; rowsFromDocs carries train, track and flag', () => {
  const sched = schedules(rec('schedule', 'T1', 'BNT-0000', '17:48'), rec('schedule', 'T1', 'WR-0045-S', '17:58', { drop_off_type: 3 }));
  const ride = [{ route: 'CR-Haverhill', vehicleRoute: 'CR-Haverhill', label: 'CR Haverhill', tripId: 'T1', dep: Date.parse(iso('17:48')), arr: Date.parse(iso('17:58')), source: 'scheduled' }];
  const assigned = mergeTrips(predictions(rec('prediction', 'T1', 'BNT-0000-05', '17:49'), rec('prediction', 'T1', 'WR-0045-S', '17:59')), sched);
  const [l1] = trackLegs(ride, [leg], [assigned]);
  assert.deepEqual([l1.track, l1.train, l1.flag, l1.source], ['5', '2317', 'alight', 'live']);
  // Departed: predictions at North Station are gone; the track stays.
  const gone = mergeTrips(predictions(rec('prediction', 'T1', 'WR-0045-S', '17:59')), sched);
  assert.equal(trackLegs([l1], [leg], [gone])[0].track, '5');
  const trip = { name: 'Home', legs: [{ kind: 'walk', minutes: 10 }, { ...leg, label: 'CR Haverhill' }, { kind: 'walk', minutes: 5 }] };
  const [row] = rowsFromDocs(trip, [predictions(rec('prediction', 'T1', 'BNT-0000-05', '17:49'), rec('prediction', 'T1', 'WR-0045-S', '17:59'))], [sched], 0, Date.parse(iso('17:00')), 0);
  assert.deepEqual([row.legs[0].train, row.legs[0].track, row.legs[0].flag], ['2317', '5', 'alight']);
  // The server checks what the app sends.
  const legOut = { ...row.legs[0] };
  const base = { legs: [legOut], boardedAt: Date.parse(iso('17:49')) };
  assert.equal(checkRide(trip, base, Date.parse(iso('17:50'))), null);
  assert.equal(checkRide(trip, { ...base, legs: [{ ...legOut, flag: 'nope' }] }, Date.parse(iso('17:50'))), 'ride leg flag is invalid');
  assert.equal(checkRide(trip, { ...base, legs: [{ ...legOut, track: 'x'.repeat(11) }] }, Date.parse(iso('17:50'))), 'ride leg track is invalid');
});

// ---------- alerts ----------

const alert = (id, entities, extra = {}) => ({
  type: 'alert', id,
  attributes: { effect: 'DELAY', header: `Alert ${id}`, short_header: null, severity: 3, active_period: [{ start: iso('00:00'), end: null }], informed_entity: entities, ...extra },
});
const NOW = Date.parse(iso('17:30'));

test('filterAlerts leaves a per-train alert out of the line list; tripAlerts files it by trip', () => {
  const doc = { data: [alert('a1', [{ route: 'CR-Haverhill', trip: 'T1' }]), alert('a2', [{ route: 'CR-Haverhill' }]),
    alert('a3', [{ route: 'CR-Haverhill', trip: 'T1' }], { severity: 5 }), alert('a4', [{ route: 'CR-Haverhill', trip: 'T2' }], { effect: 'TRACK_CHANGE' })] };
  assert.deepEqual(filterAlerts(doc, new Set(['CR-Haverhill']), new Set(), NOW).map(a => a.id), ['a2']);
  const byTrip = tripAlerts([doc], NOW);
  assert.deepEqual(byTrip.get('T1').map(a => a.id), ['a3', 'a1']);
  assert.equal(byTrip.has('T2'), false); // not an effect shown
  // Predictions documents name theirs in `included` (counted once with the /alerts copy).
  const preds = { data: [], included: [alert('a1', [{ route: 'CR-Haverhill', trip: 'T1' }]), alert('a5', [{ route: 'CR-Haverhill', trip: 'T9' }])] };
  const both = tripAlerts([doc, preds], NOW);
  assert.deepEqual(both.get('T1').map(a => a.id), ['a3', 'a1']);
  assert.deepEqual(both.get('T9').map(a => a.header), ['Alert a5']);
  // On the row's legs, by trip: up to 2 headers.
  const row = withTripAlerts({ legs: [{ tripId: 'T1' }, { tripId: 'T4' }] }, both);
  assert.deepEqual(row.legs.map(l => l.alerts), [['Alert a3', 'Alert a1'], undefined]);
  assert.equal(withTripAlerts(null, both), null);
  // An alert that ended leaves the leg.
  assert.equal(withTripAlerts(row, new Map()).legs[0].alerts, undefined);
});

// ---------- text lines ----------

const t = hhmm => Date.parse(iso(hhmm));
const crLeg = (extra = {}) => ({ route: 'CR-Haverhill', label: 'CR Haverhill', color: '80276C', headsign: 'Haverhill', tripId: 'T1', dep: t('17:48'), arr: t('17:58'), source: 'live', ...extra });
const crRow = (leg = {}) => ({ key: 'T1', legs: [crLeg(leg)], leaveBy: t('17:36'), lastChance: t('17:38'), firstDep: t('17:48'), eta: t('18:05') });

test('the track before the headsign; flag stops; train alerts as the card note', () => {
  assert.equal(withTrack(crLeg({ track: '5' })), 'Haverhill Line · Track 5');
  assert.equal(withTrack(crLeg()), 'Haverhill Line');
  assert.deepEqual([flagStop(crLeg({ flag: 'alight' }), 'alight'), flagStop(crLeg({ flag: 'alight' }), 'board'), flagStop(crLeg({ flag: 'both' }), 'board')], ['Flag stop', '', 'Flag stop']);
  // Leave card: "Haverhill Line · Track 5" toward Haverhill.
  const card = leaveActivityState(crRow({ track: '5' }), t('17:20'));
  assert.deepEqual([card.long, card.headsign, card.label, card.emoji], ['Haverhill Line · Track 5', 'Haverhill', 'CR', '🚶']);
  assert.equal(leaveActivityState(crRow({ track: '5' }), t('17:40')).emoji, '🚆');
  // Pushes.
  assert.equal(reminderText('leave', 'Home', crRow({ track: '5' }), t('17:36')).body, 'Haverhill Line · Track 5 toward Haverhill at 5:48pm');
  // A train alert is the note when nothing else is.
  const late = crRow({ alerts: ['Train 2317 is 10 min late'] });
  assert.equal(leaveActivityState(late, t('17:20')).note, 'Train 2317 is 10 min late');
  assert.equal(leaveActivityState(late, t('17:40')).note, 'Train 2317 is 10 min late');
  assert.equal(leaveActivityState(late, t('17:20'), { was: t('17:30') }).note, 'Moved (was 5:30pm)');
  // Ride card while riding: the flag stop; no track once aboard.
  const ride = { legs: [crLeg({ track: '5', flag: 'alight', alerts: ['Train 2317 is 10 min late'] })], boardedAt: t('17:48') };
  const riding = liveActivityState(ride, { kind: 'riding', leg: 0, eta: t('18:05') }, null, null, 7, t('17:50'));
  assert.deepEqual([riding.long, riding.note], ['Haverhill Line · Flag stop', 'Train 2317 is 10 min late']);
  // Widget rows.
  const w = widgetView('Home', [crRow({ track: '5' })], t('17:20'));
  assert.equal(w.rows[0].long, 'Haverhill Line · Track 5');
});

test('rideStops and tripStopCount: a trip on two routes lists its stops once', () => {
  const p = (stop, seq, hhmm, route) => ({ type: 'prediction', attributes: { arrival_time: iso(hhmm), departure_time: iso(hhmm), stop_sequence: seq }, relationships: { stop: { data: { id: stop } }, route: { data: { id: route } } } });
  const one = [p('A', 1, '17:50', 'CR-Franklin'), p('B', 2, '17:55', 'CR-Franklin'), p('C', 3, '18:00', 'CR-Franklin')];
  const two = [...one, ...one.map(x => ({ ...x, relationships: { ...x.relationships, route: { data: { id: 'CR-Providence' } } } }))];
  assert.deepEqual(rideStops({ data: two }, 'C', t('17:45')), rideStops({ data: one }, 'C', t('17:45')));
  assert.equal(rideStops({ data: two }, 'C', t('17:45')).stops.length, 3);
  assert.equal(tripStopCount({ data: two }, 'A', 'C'), 2);
});

test('trackStep / trackText: a push when the track is assigned, again when it changes', () => {
  const row = track => crRow(track ? { track } : {});
  let st = trackStep(undefined, row(null), t('17:30'));
  assert.equal(st.push, null);
  st = trackStep(st.sent, row('5'), t('17:35'));
  assert.deepEqual(st.push, { leg: 0, track: '5', was: null });
  assert.deepEqual(trackText(row('5').legs[0], null, t('17:35')), { title: 'Track 5', body: 'Haverhill Line toward Haverhill at 5:48pm' });
  // Unchanged: none.
  const same = trackStep(st.sent, row('5'), t('17:36'));
  assert.equal(same.push, null);
  // Changed.
  st = trackStep(st.sent, row('7'), t('17:40'));
  assert.deepEqual(st.push, { leg: 0, track: '7', was: '5' });
  assert.equal(trackText(row('7').legs[0], '5', t('17:40')).title, 'Now Track 7 (was 5)');
  // Left already: none.
  assert.equal(trackStep({}, row('5'), t('17:49')).push, null);
});

export { MIN };
