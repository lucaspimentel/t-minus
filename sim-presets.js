// The simulator's test presets (Setup › Developer › Simulator › Test preset; DESIGN.md
// "Simulator"): the browser specs' commutes (test/browser/helpers.js `CONFIG`, `commute()`,
// `CR_CONFIG`, `crCommute()`; test/sim-mbta.test.js keeps them equal) with one situation each.
// A preset brings its own config: the user's trips are hidden while it runs.
import { series } from './sim-mbta.js?v=1f61968344';

const label = l => (l.route === '132' ? { label: 'Bus 132', color: 'FFC72C' } : { label: 'Orange', color: 'ED8B00' });
const transit = (route, direction_id, stop, alight) => ({ kind: 'transit', route, direction_id, stop, alight, ...label({ route }) });

// test/fixtures/bus-orange.json with the app's trip ids and setup's labels and colors.
export const COMMUTE_CONFIG = {
  departureCount: 4,
  stopSlackMinutes: 1,
  trips: [
    {
      name: 'Home to office',
      window: { from: '00:00', to: '12:00' },
      legs: [
        { kind: 'walk', minutes: 5 },
        transit('132', 1, '25996', '5991'),
        { kind: 'transfer', minutes: 5 },
        transit('Orange', 0, 'place-ogmnl', 'place-state'),
        { kind: 'walk', minutes: 10 },
      ],
      id: 'home',
    },
    {
      name: 'Office to home',
      window: { from: '12:00', to: '24:00' },
      legs: [
        { kind: 'walk', minutes: 10 },
        transit('Orange', 1, 'place-state', 'place-ogmnl'),
        { kind: 'transfer', minutes: 5 },
        transit('132', 0, '9326', '15982'),
        { kind: 'walk', minutes: 5 },
      ],
      id: 'office',
    },
  ],
};

// Bus 132 every 28 min from 5:44 (14-min ride) and the Orange Line every 6 min from 5:20
// (15-min ride), both ways.
export function commute({ live } = {}) {
  return {
    trips: [
      ...series({ prefix: '132in', route: '132', direction: 1, first: '05:44', every: 28, count: 40, stops: [['25996', 0], ['25997', 4], ['5991', 14]], live }),
      ...series({ prefix: 'OLin', route: 'Orange', direction: 0, first: '05:20', every: 6, count: 190, stops: [['70036', 0], ['70022', 15]], live }),
      ...series({ prefix: 'OLout', route: 'Orange', direction: 1, first: '05:23', every: 6, count: 190, stops: [['70023', 0], ['70036', 15]], live }),
      ...series({ prefix: '132out', route: '132', direction: 0, first: '05:50', every: 28, count: 40, stops: [['9326', 0], ['15982', 12]], live }),
    ],
    alerts: [],
  };
}

export const CR_COMMUTE_CONFIG = {
  departureCount: 4, stopSlackMinutes: 1,
  trips: [{
    id: 'cr',
    name: 'Office to home',
    legs: [
      { kind: 'walk', minutes: 10 },
      { kind: 'transit', route: 'CR-Haverhill', direction_id: 0, stop: 'place-north', alight: 'place-mlmnl', label: 'CR Haverhill', color: '80276C' },
      { kind: 'walk', minutes: 5 },
    ],
  }],
};

// Haverhill Line trains from North Station to Malden Center.
export function crCommute() {
  const stops = (dep, arr) => [['BNT-0000', dep], ['WR-0045-S', arr]];
  return {
    platforms: { 'BNT-0000-05': '5' },
    trips: [
      { id: 'T2317', route: 'CR-Haverhill', direction: 0, name: '2317', stops: stops('17:48', '17:58'), live: true, track: { 'BNT-0000': 'BNT-0000-05' } },
      { id: 'T2319', route: 'CR-Haverhill', direction: 0, name: '2319', stops: stops('18:15', '18:25'), pickup: { 'BNT-0000': 1 } },
      { id: 'T2321', route: 'CR-Haverhill', direction: 0, name: '2321', stops: stops('18:48', '18:58'), dropOff: { 'WR-0045-S': 3 } },
      { id: 'T2323', route: 'CR-Haverhill', direction: 0, name: '2323', stops: stops('19:30', '19:40') },
    ],
    alerts: [
      { id: 'a-2317', effect: 'DELAY', header: 'Train 2317 is 5-10 minutes behind schedule', route: 'CR-Haverhill', trip: 'T2317' },
    ],
  };
}

const withSim = s => ({ ...s, liveWithinMin: 60, moving: true });
const tripIn = (s, id, patch) => ({ ...s, trips: s.trips.map(t => (t.id === id ? { ...t, ...patch } : t)) });

// { id, name, time (local, on the next weekday), config, scenario() }.
export const PRESETS = [
  { id: 'on-time', name: 'On time', time: '07:00', config: COMMUTE_CONFIG, scenario: () => withSim(commute()) },
  // The 7:08am bus 8 min late at Malden: off at 7:30 for the 7:32 Orange with a 5-min transfer.
  { id: 'tight', name: 'Late bus, tight connection', time: '07:00', config: COMMUTE_CONFIG,
    scenario: () => withSim(tripIn(commute(), '132in-0708', { live: { delay: 8, stops: ['5991'] } })) },
  // 11 min late: the 7:32 Orange leaves before the bus gets in.
  { id: 'missed', name: 'Missed connection', time: '07:00', config: COMMUTE_CONFIG,
    scenario: () => withSim(tripIn(commute(), '132in-0708', { live: { delay: 11, stops: ['5991'] } })) },
  // The planned 7:32 Orange 10 min late: the 7:38 leaves first.
  { id: 'earlier', name: 'Earlier train', time: '07:00', config: COMMUTE_CONFIG,
    scenario: () => withSim(tripIn(commute({ live: true }), 'OLin-0732', { live: { delay: 10 } })) },
  { id: 'cancelled', name: 'Cancelled train', time: '07:00', config: COMMUTE_CONFIG,
    scenario: () => withSim(tripIn(commute(), 'OLin-0732', { live: true, cancelled: ['70036', '70022'] })) },
  // Train 2317's track (5) is announced 10 min before it leaves.
  { id: 'track', name: 'Commuter rail track', time: '17:20', config: CR_COMMUTE_CONFIG,
    scenario: () => withSim(tripIn(crCommute(), 'T2317', { trackAt: '17:38' })) },
];
