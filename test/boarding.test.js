// Boarding from location (core.js "Boarding from location"): the matcher, the native step, and
// loading core.js the way the iOS app's JavaScriptCore does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  matchVehicle, gpsArrival, nativeBoardingStep, boardingWants, boardingSession, boardingWindow, boardingBase, geofenceEntered, vehiclesQuery,
  vehiclePositions, stopPoint, legPoints, proxyRequestError, ridePhase, checkRide, missLeg, tripShape, widgetState,
  MATCH_SECONDS_TRAIN,
} from '../core.js';

const MIN = 60_000;
const EXAMPLE = JSON.parse(readFileSync('test/fixtures/bus-orange.json', 'utf8'));
const [homeToOffice] = EXAMPLE.trips;
for (const l of homeToOffice.legs) {
  if (l.kind === 'transit') Object.assign(l, l.route === '132' ? { label: 'Bus 132' } : { label: 'Orange' });
}
// 2026-09-30 is EDT (UTC-4).
const at = t => Date.parse(`2026-09-30T${t.length === 5 ? `${t}:00` : t}-04:00`);
const iso = ms => new Date(ms).toISOString();

// Positions: meters north / east of a point.
const M = 1 / 111_320;
const move = (p, north, east = 0) => ({ lat: p.lat + north * M, lon: p.lon + (east * M) / Math.cos((p.lat * Math.PI) / 180) });
const BUS_STOP = { lat: 42.4506, lon: -71.0687 };
const OAK_GROVE = { lat: 42.43668, lon: -71.07109 };
const TRANSFER_STOP = move(OAK_GROVE, 40, 40);
const STATE = { lat: 42.35880, lon: -71.05768 };

// Phone fixes every `every` s from t0 to t1 at pos(t).
function fixes(t0, t1, pos, { every = 5, acc = 10 } = {}) {
  const out = [];
  for (let t = t0; t <= t1; t += every * 1000) out.push({ t, ...pos(t), acc });
  return out;
}
const snap = (tripId, t, p, updatedAt = t) => ({ id: `v-${tripId}`, tripId, lat: p.lat, lon: p.lon, updatedAt });
// A vehicle reporting every `every` s from t0 to t1 at pos(t).
function reports(tripId, t0, t1, pos, every = 15) {
  const out = [];
  for (let t = t0; t <= t1; t += every * 1000) out.push(snap(tripId, t, pos(t)));
  return out;
}
const T0 = at('07:08');
const s = sec => T0 + sec * 1000;
// Leaves the stop at `leave` (s) at `speed` m/s, heading south.
const leaving = (stop, leave, speed) => t => move(stop, -Math.max(0, (t - s(leave)) / 1000) * speed);

// ---------- matchVehicle ----------

test('a bus boarded on time: matched once it has moved with the phone for 30 s away from the stop', () => {
  const route = leaving(BUS_STOP, 60, 8);
  const track = fixes(s(0), s(150), route);
  const positions = reports('B708', s(0), s(150), route);
  const ctx = { mode: 'board', stop: BUS_STOP, planned: 'B708', candidates: ['B708', 'B736'], bus: true, since: s(0), nowMs: s(150) };
  const v = matchVehicle(track, positions, ctx);
  assert.equal(v.kind, 'boarded');
  assert.equal(v.tripId, 'B708');
  assert.ok(v.at >= s(55) && v.at <= s(75), 'left the stop around the departure');
  // Only 20 s together away from the stop: not yet.
  assert.equal(matchVehicle(track.filter(p => p.t <= s(95)), positions.filter(p => p.updatedAt <= s(95)), ctx).kind, 'none');
});

test('Oak Grove: of two trains side by side, only the one leaving with the phone matches', () => {
  const t1 = leaving(OAK_GROVE, 60, 10);
  const t2 = () => move(OAK_GROVE, 0, 11);
  const track = fixes(s(0), s(200), t1);
  const positions = [...reports('O726', s(0), s(200), t1, 20), ...reports('O732', s(0), s(200), t2, 20)];
  const v = matchVehicle(track, positions, { mode: 'board', stop: OAK_GROVE, planned: 'O732', candidates: ['O726', 'O732'], bus: false, since: s(0), nowMs: s(200) });
  assert.equal(v.kind, 'boarded');
  assert.equal(v.tripId, 'O726');
});

test('a stopped train with a stale position neither matches nor counts as missed', () => {
  const track = fixes(s(0), s(200), () => OAK_GROVE);
  const stale = [0, 20, 40, 60, 80].map(k => snap('O732', s(k), move(OAK_GROVE, 0, 11), s(-180)));
  const v = matchVehicle(track, stale, { mode: 'board', stop: OAK_GROVE, planned: 'O732', candidates: ['O732'], bus: false, since: s(-300), nowMs: s(200) });
  assert.equal(v.kind, 'none');
});

test('missed: the planned bus is 200 m+ past the stop while the phone stayed there', () => {
  const bus = leaving(BUS_STOP, 30, 8);
  const track = fixes(s(0), s(100), () => move(BUS_STOP, 5));
  const positions = reports('B708', s(0), s(90), bus);
  const ctx = { mode: 'board', stop: BUS_STOP, planned: 'B708', candidates: ['B708'], bus: true, since: s(0), nowMs: s(100) };
  assert.deepEqual(matchVehicle(track, positions, ctx).kind, 'missed');
  // Still approaching (never at the stop): not missed.
  const far = reports('B708', s(0), s(90), () => move(BUS_STOP, 600));
  assert.equal(matchVehicle(track, far, ctx).kind, 'none');
});

test('no usable fix (underground, poor accuracy): no verdict', () => {
  const route = leaving(BUS_STOP, 60, 8);
  const positions = reports('B708', s(0), s(150), route);
  const ctx = { mode: 'board', stop: BUS_STOP, planned: 'B708', candidates: ['B708'], bus: true, since: s(0), nowMs: s(150) };
  assert.equal(matchVehicle([], positions, ctx).kind, 'none');
  assert.equal(matchVehicle(fixes(s(0), s(150), route, { acc: 80 }), positions, ctx).kind, 'none');
});

test('got off: the ridden train goes on while the phone stays at the station', () => {
  const train = leaving(STATE, 60, 10);
  const phone = t => (t <= s(60) ? train(t) : move(STATE, -((t - s(60)) / 1000) * 1)); // walking off
  const track = fixes(s(-120), s(120), phone);
  const positions = reports('O726', s(-120), s(120), t => (t <= s(60) ? move(STATE, ((s(60) - t) / 1000) * 10) : train(t)), 20);
  const v = matchVehicle(track, positions, { mode: 'ride', rideTripId: 'O726', since: s(-120), nowMs: s(120) });
  assert.equal(v.kind, 'gotOff');
  assert.ok(Math.abs(v.lat - STATE.lat) < 0.002);
  // Still on it: nothing.
  assert.equal(matchVehicle(fixes(s(-120), s(120), train), positions, { mode: 'ride', rideTripId: 'O726', since: s(-120), nowMs: s(120) }).kind, 'none');
});

// ---------- the native step ----------

// Schedules and predictions for the commute: bus 132 7:08 (B708) and 7:36 (B736) from Main St
// (25996) to Oak Grove (5991, 7:22 / 7:50); Orange every 6 min from Oak Grove (platform 70036)
// to State (70022), 15 min.
const stopDoc = (id, name, p, parent = null) => ({ type: 'stop', id, attributes: { name, ...(p && { latitude: p.lat, longitude: p.lon }) }, relationships: { parent_station: { data: parent ? { id: parent } : null } } });
const rec = (type, trip, stop, arrMs, depMs) => ({
  type, attributes: { arrival_time: arrMs && iso(arrMs), departure_time: depMs && iso(depMs) },
  relationships: { trip: { data: { id: trip } }, stop: { data: { id: stop } } },
});
function docs(type) {
  const bus = [['B708', '07:08', '07:22'], ['B736', '07:36', '07:50']];
  const orange = ['07:20', '07:26', '07:32', '07:38', '07:44'].map(d => [`O${d.replace(':', '').slice(1)}`, at(d), at(d) + 15 * MIN]);
  return [
    { data: bus.flatMap(([t, d, a]) => [rec(type, t, '25996', null, at(d)), rec(type, t, '5991', at(a), null)]),
      included: [stopDoc('25996', 'Main St', BUS_STOP), stopDoc('5991', 'Washington St opp Oak Grove', TRANSFER_STOP)] },
    { data: orange.flatMap(([t, d, a]) => [rec(type, t, '70036', null, d), rec(type, t, '70022', a, null)]),
      included: [stopDoc('70036', 'Oak Grove', OAK_GROVE, 'place-ogmnl'), stopDoc('place-ogmnl', 'Oak Grove', null),
        stopDoc('70022', 'State', STATE, 'place-state'), stopDoc('place-state', 'State', null)] },
  ];
}
const vehiclesDoc = positions => ({ data: positions.map(p => ({ type: 'vehicle', id: p.id, attributes: { latitude: p.lat, longitude: p.lon, updated_at: iso(p.updatedAt), current_status: 'IN_TRANSIT_TO' }, relationships: { trip: { data: { id: p.tripId } } } })) });

function engine() {
  let session = null;
  const all = [];
  const step = (event, nowMs, active = false) => {
    const out = JSON.parse(nativeBoardingStep(JSON.stringify({ session, event, nowMs, active })));
    session = out.session;
    all.push(...out.actions);
    return out;
  };
  return { step, get session() { return session; }, all };
}
const target = () => {
  const legs = [
    { route: '132', label: 'Bus 132', tripId: 'B708', dep: at('07:08'), arr: at('07:22'), source: 'scheduled' },
    { route: 'Orange', label: 'Orange', tripId: 'O732', dep: at('07:32'), arr: at('07:47'), source: 'live' },
  ];
  return { key: 'B708', legs };
};
function armed(enRoute, extra = {}) {
  const e = engine();
  e.step({ type: 'arm', session: boardingSession({
    on: true, tripIdx: 0, trip: homeToOffice, timingIdx: 0, slack: 1, enRoute, alerts: true,
    subscription: { endpoint: 'apns:abc' }, card: { id: 'card1', token: 'tok', kind: 'leave' }, reminderId: 'rem1',
    window: boardingWindow(at('07:02'), at('07:08')), ...extra,
  }) }, at('06:50'));
  const sched = docs('schedule');
  const pred = docs('prediction');
  e.step({ type: 'doc', key: 's0', doc: sched[0] }, at('06:50'));
  e.step({ type: 'doc', key: 's1', doc: sched[1] }, at('06:50'));
  e.step({ type: 'doc', key: 'p1', doc: pred[1] }, at('06:50'));
  return e;
}
const belled = () => ({ kind: 'track', at: at('06:40'), pinned: true, bell: true, target: target(), name: homeToOffice.name });
const states = e => e.all.filter(a => a.type === 'state');
const http = e => e.all.filter(a => a.type === 'http');

test('the geofence: the initial inside is ignored; an entry in the window marks At the stop, outside it nothing', () => {
  const e = armed(belled());
  const w = boardingWants(e.session, at('06:50'));
  assert.deepEqual([w.region.lat, w.region.lon, w.region.radius, w.gps], [BUS_STOP.lat, BUS_STOP.lon, 100, false]);
  e.step({ type: 'geofence', inside: true }, at('06:51')); // inside when armed
  assert.equal(e.session.enRoute.kind, 'track');
  e.step({ type: 'geofence', inside: false }, at('06:52'));
  e.step({ type: 'geofence', inside: true }, at('06:53')); // before leave-by − 15 (6:47)? no: 6:53 is inside the window
  assert.equal(e.session.enRoute.kind, 'stop');
  assert.equal(states(e)[0].toast, 'At the stop (location)');
  assert.deepEqual(http(e).map(a => `${a.method} ${a.path}`), ['PUT /reminders/rem1']);
  assert.equal(http(e)[0].body.started.atStop, at('06:53'));
  assert.equal(boardingWants(e.session, at('06:53')).gps, true);
  // Before the window: ignored.
  const early = armed(belled(), { window: boardingWindow(at('07:30'), at('07:36')) });
  early.step({ type: 'geofence', inside: false }, at('06:51'));
  early.step({ type: 'geofence', inside: true }, at('06:53'));
  assert.equal(early.session.enRoute.kind, 'track');
  assert.equal(geofenceEntered(belled(), null, 5, at('06:53')).kind, 'track');
});

// "Leaving now" at 6:55 with a 5 min walk: the estimate is 7:00.
const walking = () => ({ kind: 'leaving', at: at('06:55'), atStop: at('07:00'), target: target(), name: homeToOffice.name });
// Fixes `meters` north of the stop at the given times.
const at_ = (times, meters, acc = 10) => times.map(t => ({ t: at(t), ...move(BUS_STOP, meters), acc }));

test('gpsArrival: two fixes in a row within 50 m after one outside; inaccurate fixes ignored', () => {
  const since = at('06:53');
  assert.equal(gpsArrival([...at_(['06:56'], 200), ...at_(['06:59', '06:59:05'], 20)], BUS_STOP, since), at('06:59'));
  assert.equal(gpsArrival([...at_(['06:56'], 200), ...at_(['06:59'], 20)], BUS_STOP, since), null, 'one fix inside');
  assert.equal(gpsArrival([...at_(['06:56'], 200), ...at_(['06:59'], 20), ...at_(['06:59:05'], 80), ...at_(['06:59:10'], 20)], BUS_STOP, since), null, 'not in a row');
  assert.equal(gpsArrival(at_(['06:56', '06:56:05', '06:56:10'], 20), BUS_STOP, since), null, 'started inside');
  assert.equal(gpsArrival([...at_(['06:56'], 20), ...at_(['06:57'], 200), ...at_(['06:58', '06:58:05'], 20)], BUS_STOP, since), at('06:58'), 'left, then back');
  assert.equal(gpsArrival([...at_(['06:56'], 200, 80), ...at_(['06:59', '06:59:05'], 20)], BUS_STOP, since), null, 'the outside fix is inaccurate');
  assert.equal(gpsArrival([...at_(['06:56'], 200), ...at_(['06:59', '06:59:05'], 20, 80)], BUS_STOP, since), null, 'the inside fixes are inaccurate');
  assert.equal(gpsArrival([...at_(['06:50'], 200), ...at_(['06:59', '06:59:05'], 20)], BUS_STOP, since), null, 'outside before the walk');
});

test('GPS after Leaving now: the arrival replaces the estimate, earlier or later, once per walk', () => {
  // Early: at the stop 6:58, before the 7:00 estimate; the state keeps the target and the first tap.
  const e = armed(walking());
  e.step({ type: 'location', samples: at_(['06:56'], 300) }, at('06:56'), true);
  assert.equal(states(e).length, 0);
  e.step({ type: 'location', samples: at_(['06:58', '06:58:05'], 15) }, at('06:58:10'), true);
  const st = states(e);
  assert.equal(st.length, 1);
  assert.equal(st[0].toast, 'At the stop (location)');
  assert.deepEqual([st[0].state.kind, st[0].state.atStop, st[0].state.at, st[0].state.target.key], ['stop', at('06:58'), at('06:55'), 'B708']);
  assert.equal(st[0].base, boardingBase(walking()));
  // Not taken by the page yet, re-armed with the walk: not again.
  e.step({ type: 'arm', session: boardingSession({ ...e.session, enRoute: walking() }) }, at('06:58:20'), true);
  e.step({ type: 'location', samples: at_(['06:58:15'], 15) }, at('06:58:20'), true);
  assert.equal(states(e).length, 1);
  // Undone: not taken again on this walk.
  e.step({ type: 'undo', undoId: st[0].undoId }, at('06:58:30'), true);
  assert.equal(e.session.enRoute.kind, 'leaving');
  e.step({ type: 'location', samples: [...at_(['06:59'], 300), ...at_(['06:59:30', '06:59:35'], 15)] }, at('06:59:40'), true);
  assert.equal(states(e).length, 1);
  assert.ok(e.all.some(a => a.type === 'log' && /gps arrival/.test(a.line)));

  // Late, the page closed: at the stop 7:09, after the 7:08 bus left; it isn't boarded at its departure.
  const late = armed(walking());
  late.step({ type: 'location', samples: [...at_(['07:05'], 400), ...at_(['07:09', '07:09:05'], 15)] }, at('07:09:10'));
  const ls = states(late);
  assert.deepEqual([ls[0].state.kind, ls[0].state.atStop], ['stop', at('07:09')]);
  assert.ok(!late.session.enRoute.ride, 'not boarded on the 7:08am');
});

test('GPS arrival only while walking after Leaving now', () => {
  const samples = [...at_(['06:56'], 300), ...at_(['06:58', '06:58:05'], 15)];
  for (const enRoute of [
    { ...walking(), kind: 'stop', atStop: at('06:55') },
    belled(),
    { ...walking(), asking: { dep: at('07:08') } },
    { kind: 'leaving', at: at('06:55'), atStop: at('07:00'), ride: { legs: target().legs, boardedAt: at('06:57') }, name: homeToOffice.name },
  ]) {
    const e = armed(enRoute);
    e.step({ type: 'location', samples }, at('06:58:10'), true);
    assert.ok(!states(e).some(a => a.toast === 'At the stop (location)'), JSON.stringify(enRoute.kind));
  }
  // Location off (the session not on): nothing.
  const off = armed(walking(), { on: false });
  off.step({ type: 'location', samples }, at('06:58:10'), true);
  assert.equal(states(off).length, 0);
});

test('app closed: boarding at the departure posts the ride with the card token; a match confirms it silently', () => {
  const e = armed(belled());
  e.step({ type: 'geofence', inside: false }, at('07:00'));
  e.step({ type: 'geofence', inside: true }, at('07:04'));
  e.step({ type: 'tick' }, at('07:08:10'));
  assert.equal(e.session.enRoute.ride.boardedAt, at('07:08'));
  const post = http(e).find(a => a.method === 'POST');
  assert.equal(post.path, '/rides');
  assert.deepEqual(post.body.activity, { token: 'tok' });
  assert.ok(http(e).some(a => a.method === 'DELETE' && a.path === '/reminders/rem1?reason=started'));
  assert.ok(e.all.some(a => a.type === 'card' && a.id === 'card1' && a.state));
  e.step({ type: 'posted', id: 'ride1' }, at('07:08:12'));
  assert.equal(e.session.enRoute.alert.id, 'ride1');
  assert.equal(e.session.pending.state.alert.id, 'ride1');
  // GPS: at the stop, then away with B708.
  const route = t => move(BUS_STOP, -Math.max(0, (t - at('07:08:30')) / 1000) * 8);
  e.step({ type: 'location', samples: fixes(at('07:06'), at('07:10:30'), route) }, at('07:10:30'));
  const before = states(e).length;
  e.step({ type: 'doc', key: 'v0', doc: vehiclesDoc(reports('B708', at('07:07'), at('07:10:30'), route)) }, at('07:10:30'));
  assert.equal(states(e).length, before, 'confirmed: no new action');
  assert.equal(e.session.matched[0], 'B708');
  assert.ok(e.all.some(a => a.type === 'log' && /leg 0 boarded B708/.test(a.line)));
});

test('an earlier Orange train than planned: the ride switches to it with "On the 7:26am Orange, not the 7:32am"', () => {
  const ride = { legs: target().legs, boardedAt: at('07:08') };
  const e = armed({ kind: 'stop', at: at('07:00'), atStop: at('07:04'), ride, alert: { id: 'ride1', sync: 'x' }, name: homeToOffice.name });
  // Off the bus at 7:22, at the platform from 7:24, leaves at 7:26 with O726.
  const route = t => (t < at('07:26') ? OAK_GROVE : move(OAK_GROVE, -((t - at('07:26')) / 1000) * 10));
  e.step({ type: 'location', samples: fixes(at('07:24'), at('07:28'), route) }, at('07:28'));
  e.step({ type: 'doc', key: 'v1', doc: vehiclesDoc([...reports('O726', at('07:24'), at('07:28'), route, 20), ...reports('O732', at('07:24'), at('07:28'), () => move(OAK_GROVE, 0, 11), 20)]) }, at('07:28'));
  const st = states(e).at(-1);
  assert.equal(st.toast, 'On the 7:26am Orange, not the 7:32am');
  assert.equal(e.session.enRoute.ride.legs[1].tripId, 'O726');
  assert.deepEqual(http(e).map(a => `${a.method} ${a.path}`), ['PUT /rides/ride1']);
  assert.equal(ridePhase(e.session.enRoute.ride, 10, at('07:30')).kind, 'riding');
  // Undo (in the app): restored, and the same verdict isn't applied again.
  e.step({ type: 'undo', undoId: st.undoId }, at('07:29'));
  assert.equal(e.session.enRoute.ride.legs[1].tripId, 'O732');
  e.step({ type: 'tick' }, at('07:29'));
  assert.equal(e.session.enRoute.ride.legs[1].tripId, 'O732');
});

test('missed the bus: back to waiting at the stop, with "Missed the 7:08am Bus 132"; the ride is deleted', () => {
  const ride = { legs: target().legs, boardedAt: at('07:08') };
  const e = armed({ kind: 'stop', at: at('07:00'), atStop: at('07:04'), ride, alert: { id: 'ride1', sync: 'x' }, name: homeToOffice.name });
  const bus = t => move(BUS_STOP, -Math.max(0, (t - at('07:08')) / 1000) * 8);
  e.step({ type: 'location', samples: fixes(at('07:07'), at('07:09:40'), () => move(BUS_STOP, 3)) }, at('07:09:40'));
  e.step({ type: 'doc', key: 'v0', doc: vehiclesDoc(reports('B708', at('07:07'), at('07:09:30'), bus)) }, at('07:09:40'));
  assert.equal(states(e).at(-1).toast, 'Missed the 7:08am Bus 132');
  assert.equal(e.session.enRoute.kind, 'stop');
  assert.equal(e.session.enRoute.ride, undefined);
  assert.ok(http(e).some(a => a.method === 'DELETE' && a.path === '/rides/ride1'));
});

test('got off at State with a walk after: the walking phase, "Got off at State", GPS off; at an unplanned stop the ride ends', () => {
  const legs = target().legs.map((l, i) => (i === 1 ? { ...l, tripId: 'O726', dep: at('07:26'), arr: at('07:41') } : l));
  const e = armed({ kind: 'stop', at: at('07:00'), atStop: at('07:04'), ride: { legs, boardedAt: at('07:08') }, name: homeToOffice.name });
  const train = t => (t < at('07:39') ? move(STATE, ((at('07:39') - t) / 1000) * 10) : move(STATE, -((t - at('07:39')) / 1000) * 10));
  const phone = t => (t < at('07:39') ? train(t) : move(STATE, 0, ((t - at('07:39')) / 1000) * 1));
  e.step({ type: 'location', samples: fixes(at('07:36'), at('07:40:40'), phone) }, at('07:40:40'));
  e.session.matched[1] = 'O726'; // matched when boarding
  e.step({ type: 'doc', key: 'v1', doc: vehiclesDoc(reports('O726', at('07:36'), at('07:40:40'), train, 20)) }, at('07:40:40'));
  assert.equal(states(e).at(-1).toast, 'Got off at State');
  assert.ok(e.session.enRoute.ride.legs[1].off <= at('07:40:40'));
  assert.equal(ridePhase(e.session.enRoute.ride, 10, at('07:40:45')).kind, 'walking');
  assert.equal(boardingWants(e.session, at('07:40:45')).gps, false);
  // No server action carries a position.
  for (const a of e.all.filter(x => x.type === 'http' || x.type === 'card')) assert.doesNotMatch(JSON.stringify(a), /"lat"|"lon"|latitude|longitude|meters/);

  // Got off one stop early: the ride ends.
  const early = armed({ kind: 'stop', at: at('07:00'), atStop: at('07:04'), ride: { legs, boardedAt: at('07:08') }, alert: { id: 'ride1', sync: 'x' }, name: homeToOffice.name });
  const DTX = move(STATE, 600);
  const train2 = t => (t < at('07:38') ? move(DTX, ((at('07:38') - t) / 1000) * 10) : move(DTX, -((t - at('07:38')) / 1000) * 10));
  early.step({ type: 'location', samples: fixes(at('07:35'), at('07:39:40'), t => (t < at('07:38') ? train2(t) : DTX)) }, at('07:39:40'));
  early.session.matched[1] = 'O726';
  early.step({ type: 'doc', key: 'v1', doc: vehiclesDoc(reports('O726', at('07:35'), at('07:39:40'), train2, 20)) }, at('07:39:40'));
  assert.equal(states(early).at(-1).toast, 'Got off · ride ended');
  assert.equal(early.session.enRoute, null);
  assert.ok(http(early).some(a => a.method === 'DELETE' && a.path === '/rides/ride1'));
  assert.ok(early.all.some(a => a.type === 'card' && a.end));
});

test('with the app open, the step only reports: no server or card actions', () => {
  const ride = { legs: target().legs, boardedAt: at('07:08') };
  const e = armed({ kind: 'stop', at: at('07:00'), atStop: at('07:04'), ride, alert: { id: 'ride1', sync: 'x' }, name: homeToOffice.name });
  e.step({ type: 'location', samples: fixes(at('07:07'), at('07:09:40'), () => move(BUS_STOP, 3)) }, at('07:09:40'), true);
  e.step({ type: 'doc', key: 'v0', doc: vehiclesDoc(reports('B708', at('07:07'), at('07:09:30'), t => move(BUS_STOP, -Math.max(0, (t - at('07:08')) / 1000) * 8))) }, at('07:09:40'), true);
  const st = states(e).at(-1);
  assert.equal(st.toast, 'Missed the 7:08am Bus 132');
  assert.equal(st.base, boardingBase({ kind: 'stop', at: at('07:00'), atStop: at('07:04'), ride }));
  assert.deepEqual(http(e), []);
  e.step({ type: 'take' }, at('07:09:41'), true);
  assert.equal(e.session.pending, null);
});

test('boardingWants: the region only before the trip starts, during its window; queries without positions', () => {
  const e = armed(belled());
  const w = boardingWants(e.session, at('07:00'));
  assert.ok(w.region);
  assert.deepEqual(w.queries.map(q => q.key), ['p0', 's0', 'p1', 's1']);
  for (const q of w.queries) assert.equal(proxyRequestError(q.path, Object.entries(q.params)), null);
  assert.equal(boardingWants(e.session, at('07:38')).region, null, 'after dep + 30 min');
  assert.deepEqual(boardingWants({ ...e.session, on: false }, at('07:00')), { region: null, gps: false, queries: [] });
  e.step({ type: 'geofence', inside: false }, at('07:00'));
  e.step({ type: 'geofence', inside: true }, at('07:01'));
  const g = boardingWants(e.session, at('07:01'));
  assert.equal(g.region, null);
  assert.equal(g.gps, true);
  assert.deepEqual(g.queries.at(-1).params, vehiclesQuery(tripShape(homeToOffice).transit[0]));
  assert.equal(proxyRequestError('/vehicles', Object.entries(g.queries.at(-1).params)), null);
  assert.ok(MATCH_SECONDS_TRAIN > 30);
});

// ---------- pieces ----------

test('vehiclePositions, stopPoint and legPoints read the MBTA documents', () => {
  const p = vehiclePositions(vehiclesDoc([snap('O726', at('07:26'), OAK_GROVE)]));
  assert.deepEqual(p, [{ id: 'v-O726', tripId: 'O726', lat: OAK_GROVE.lat, lon: OAK_GROVE.lon, updatedAt: at('07:26'), status: 'IN_TRANSIT_TO' }]);
  assert.deepEqual(vehiclePositions({ data: [{ id: 'x', attributes: { latitude: null }, relationships: {} }] }), []);
  const d = docs('schedule');
  assert.deepEqual(stopPoint(d, 'place-state'), { lat: STATE.lat, lon: STATE.lon, name: 'State' });
  assert.equal(stopPoint(d, 'nope'), null);
  assert.equal(legPoints(homeToOffice, d)[0].board.name, 'Main St');
});

test('ridePhase and checkRide take a leg\'s `off`; the widget state keeps it', () => {
  const legs = target().legs;
  const ride = { legs: legs.map((l, i) => (i === 0 ? { ...l, off: at('07:15') } : l)), boardedAt: at('07:08') };
  assert.deepEqual(ridePhase(ride, 10, at('07:16')), { kind: 'transfer', leg: 1, eta: at('07:57') });
  const last = { legs: legs.map((l, i) => (i === 1 ? { ...l, off: at('07:44') } : l)), boardedAt: at('07:08') };
  assert.equal(ridePhase(last, 10, at('07:45')).kind, 'walking');
  assert.equal(ridePhase(last, 10, at('08:03')).kind, 'done');
  const trip = { ...homeToOffice };
  assert.equal(checkRide(trip, last, at('07:30')), null);
  assert.equal(checkRide(trip, { ...last, legs: last.legs.map(l => ({ ...l, off: 'x' })) }, at('07:30')), 'ride leg off is invalid');
  const w = widgetState({ 0: { kind: 'stop', at: 1, atStop: 1, ride: last, name: trip.name } }, [trip]);
  assert.equal(w.ride.legs[1].off, at('07:44'));
});

test('missLeg: the first leg goes back to the stop; a later one takes its next vehicle, or keeps the plan', () => {
  const ride = { legs: target().legs, boardedAt: at('07:08') };
  const st = { kind: 'stop', at: at('07:00'), atStop: at('07:04'), ride, name: 'n' };
  assert.deepEqual(missLeg(st, 0, [], [5], at('07:10')), { state: { kind: 'stop', at: at('07:10'), atStop: at('07:10'), name: 'n' }, note: null });
  const vehicles = [[], [{ tripId: 'O732', dep: at('07:32'), arr: at('07:47') }, { tripId: 'O738', dep: at('07:38'), arr: at('07:53') }]];
  assert.equal(missLeg(st, 1, vehicles, [5], at('07:33')).state.ride.legs[1].tripId, 'O738');
  assert.deepEqual(missLeg(st, 1, [[], []], [5], at('07:33')), { state: st, note: 'No later connection.' });
});

// ---------- JavaScriptCore ----------

// The iOS app strips `export` from core.js and evaluates it in a JSContext: no modules, no
// URLSearchParams, fetch or timers. The same here, with Node's vm.
export const STRIP_EXPORTS = /^export (?=(const|let|function|async function) )/gm;
test('core.js loads as a plain script without browser APIs, and nativeBoardingStep runs there', () => {
  const src = readFileSync('core.js', 'utf8');
  assert.doesNotMatch(src, /^import /m);
  for (const line of src.match(/^export .*/gm)) assert.match(line, /^export (const|let|function|async function) /);
  const ctx = vm.createContext({});
  vm.runInContext(`${src.replace(STRIP_EXPORTS, '')}\nglobalThis.nativeBoardingStep = nativeBoardingStep;`, ctx);
  assert.equal(typeof ctx.URLSearchParams, 'undefined');
  const out = JSON.parse(ctx.nativeBoardingStep(JSON.stringify({
    session: null, nowMs: at('06:50'), active: false,
    event: { type: 'arm', session: boardingSession({ on: true, tripIdx: 0, trip: homeToOffice, enRoute: belled(), window: boardingWindow(at('07:02'), at('07:08')) }) },
  })));
  assert.equal(out.session.enRoute.kind, 'track');
  assert.deepEqual(out.wants.queries.map(q => q.key), ['p0', 's0', 'p1', 's1']);
});

test('an auto-bell armed from its bell with the page closed (native code): not over a started trip', () => {
  const e = engine();
  const bell = { id: 'rem9', index: 0, tripName: homeToOffice.name, key: 'B708', leaveBy: at('07:02'), dep: at('07:08'), timingIdx: 0, legs: target().legs };
  const defaults = { trips: [homeToOffice], subscription: { endpoint: 'apns:abc' }, slack: 1, alerts: true };
  e.step({ type: 'bell', bell, defaults, card: { id: 'card9', kind: 'leave' } }, at('06:50'));
  assert.equal(e.session.reminderId, 'rem9');
  assert.equal(e.session.enRoute.bell, true);
  assert.deepEqual(e.session.window, boardingWindow(at('07:02'), at('07:08')));
  e.step({ type: 'arm', session: { ...boardingSession(e.session), enRoute: { kind: 'stop', at: at('06:55'), atStop: at('06:55'), name: homeToOffice.name } } }, at('06:55'));
  e.step({ type: 'bell', bell: { ...bell, id: 'rem10' }, defaults, card: { id: 'card10', kind: 'leave' } }, at('06:56'));
  assert.equal(e.session.reminderId, 'rem9');
});
