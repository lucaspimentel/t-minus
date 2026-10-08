// Shared setup for the browser specs: a commute config, a matching fake MBTA scenario, and
// helpers to open the app at a given time and move the page clock.
import { readFileSync } from 'node:fs';
import { fakeMbta, series } from './fake-mbta.js';

// The unit tests' commute (bus 132 + Orange Line both ways), with the labels and colors
// setup stores on each leg.
export const CONFIG = (() => {
  const cfg = JSON.parse(readFileSync(new URL('../fixtures/bus-orange.json', import.meta.url), 'utf8'));
  for (const t of cfg.trips) {
    for (const l of t.legs) {
      if (l.kind === 'transit') Object.assign(l, l.route === '132' ? { label: 'Bus 132', color: 'FFC72C' } : { label: 'Orange', color: 'ED8B00' });
    }
  }
  return cfg;
})();

export const MONDAY = '2026-10-05';
// Epoch ms of a local time on the test Monday ('07:12' or '07:12:30').
export const at = (t, date = MONDAY) => new Date(`${date}T${t.length === 5 ? `${t}:00` : t}-04:00`).getTime();

// Weekday service for both trips (stop ids as in CONFIG; Orange uses child platforms so the
// parent-station mapping is exercised). Home to office: bus 132 every 28 min from 5:44 (14-min
// ride), Orange every 6 min from 5:20 (15-min ride). Office to home: Orange from 5:23, bus 132
// every 28 min from 5:50 (12-min ride). Pass `live` to give every trip predictions.
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

// Records Screen Wake Lock requests/releases instead of touching the screen: window.wakeHeld.
export const WAKE_STUB = () => {
  window.wakeHeld = false;
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
    window.wakeHeld = true;
    return { released: false, release() { this.released = true; window.wakeHeld = false; return Promise.resolve(); } };
  } } });
};

// Opens the app at `time` (local, on `date`) with `config` saved and the fake MBTA serving
// `scenario`; waits for the first rows unless `waitForRows` is false. The server's MBTA proxy
// is unreachable (the app calls the fake MBTA directly) unless `proxy` gives its answers
// (`mbta.serveProxy`).
export async function openApp(page, { time = '07:00', date = MONDAY, config = CONFIG, scenario = commute(), waitForRows = true, init, proxy = null } = {}) {
  const now = at(time, date);
  const mbta = await fakeMbta(page.context(), scenario, { now });
  if (proxy) await mbta.serveProxy(page, proxy);
  else await page.route(/\/mbta\/\w+\?/, route => route.abort());
  // The push server's "Show nearby" digest is unreachable unless a spec stubs it (page.route),
  // so specs never call Railway and setup takes its MBTA fallback.
  await page.context().route(/\/nearby\?/, route => route.abort());
  await page.addInitScript(c => { if (c && !localStorage.getItem('t-minus:config')) localStorage.setItem('t-minus:config', c); },
    config ? JSON.stringify(config) : null);
  if (init) await page.addInitScript(init);
  await page.clock.install({ time: now });
  await page.goto('/');
  if (waitForRows) {
    await page.locator('.row').first().waitFor();
    await tick(page, 1000);
  }
  return mbta;
}

// Advances the page clock (timers fire), then lets the fake API's replies and the render land.
export async function tick(page, ms) {
  await page.clock.runFor(ms);
  await page.waitForTimeout(100);
}

// Advances the page clock to a local time on the test day (timers, polls and renders run).
export async function tickTo(page, time, date = MONDAY) {
  const now = await page.evaluate(() => Date.now());
  const target = at(time, date);
  if (target > now) await tick(page, target - now);
}

export const statusText = page => page.locator('#status-text').innerText();
export const rowHeads = page => page.locator('.row .big').allInnerTexts().then(t => t.map(s => s.replace(/\s+/g, ' ').trim()));

// A one-finger drag from (x, y) down by dy px, as real touch events (Chromium's CDP input).
// Returns release(), which lifts the finger; pass { release: true } to lift it at once.
export async function drag(page, [x, y], dy, { release = false, steps = 10 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await touch('touchStart', [{ x, y }]);
  for (let i = 1; i <= steps; i++) await touch('touchMove', [{ x, y: y + dy * i / steps }]);
  const lift = () => touch('touchEnd', []);
  if (release) await lift();
  return lift;
}
