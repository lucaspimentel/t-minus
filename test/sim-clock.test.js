// sim.js: the simulator's virtual clock, loaded into a fake window with a controllable real clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../sim.js', import.meta.url), 'utf8');

// A window whose "real" Date and timers run on `real.t`, advanced by `advance(ms)`.
function load(ctl) {
  const real = { t: 1_000_000, timers: [], id: 1 };
  class RD extends Date {
    constructor(...a) { if (a.length) super(...a); else super(real.t); }
    static now() { return real.t; }
  }
  const storage = new Map(ctl === undefined ? [] : [['t-minus-simctl', JSON.stringify(ctl)]]);
  const handlers = {};
  const win = {
    Date: RD,
    setTimeout: (fn, ms = 0) => { const id = real.id++; real.timers.push({ id, fn, due: real.t + ms }); return id; },
    clearTimeout: id => { real.timers = real.timers.filter(t => t.id !== id); },
    setInterval: (fn, ms) => { const id = real.id++; real.timers.push({ id, fn, due: real.t + ms, every: ms }); return id; },
    clearInterval: id => { real.timers = real.timers.filter(t => t.id !== id); },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    addEventListener: (e, f) => { handlers[e] = f; },
    navigator: {},
    console,
  };
  win.window = win;
  win.document = { hidden: false, addEventListener: (e, f) => { handlers[e] = f; } };
  vm.createContext(win);
  vm.runInContext(SRC, win);
  const advance = ms => {
    const end = real.t + ms;
    for (;;) {
      real.timers.sort((a, b) => a.due - b.due);
      const t = real.timers[0];
      if (!t || t.due > end) break;
      real.t = t.due;
      if (t.every) t.due += t.every; else real.timers.shift();
      t.fn();
    }
    real.t = end;
  };
  return { win, real, advance, storage, handlers, sim: win.tminusSim };
}

test('inert without the ctl', () => {
  const { win, sim } = load();
  assert.equal(sim, null);
  assert.equal(win.Date.name, 'RD');
});

test('playing after a start: Date runs at the speed; timers on virtual time', () => {
  const { win, sim, advance } = load({ on: true, clock: { at: 5_000_000, speed: 10, keepPlaying: true } });
  assert.equal(sim.paused, false);
  assert.equal(win.Date.now(), 5_000_000);
  advance(1000);
  assert.equal(win.Date.now(), 5_010_000);
  assert.equal(new win.Date().getTime(), 5_010_000);
  assert.ok(new win.Date() instanceof win.Date);
  assert.equal(typeof win.Date(), 'string');
  const fired = [];
  win.setTimeout(() => fired.push(win.Date.now()), 60_000); // 60 virtual s: 6 real s at 10×
  advance(5900);
  assert.deepEqual(fired, []);
  advance(200);
  assert.equal(fired.length, 1);
});

test('paused: Date stands still, timers run in real time', () => {
  const { win, sim, advance } = load({ on: true, clock: { at: 5_000_000, speed: 60 } });
  assert.equal(sim.paused, true); // a relaunch comes back paused
  let n = 0;
  win.setTimeout(() => { n++; }, 1000);
  advance(1000);
  assert.equal(n, 1);
  assert.equal(win.Date.now(), 5_000_000);
  sim.play();
  advance(1000);
  assert.equal(win.Date.now(), 5_060_000);
});

test('intervals run at most 4 times a real second', () => {
  const { win, sim, advance } = load({ on: true, clock: { at: 0, speed: 60, keepPlaying: true } });
  let n = 0;
  win.setInterval(() => { n++; }, 1000); // every virtual second = 60 a real second at 60×
  advance(1000);
  assert.ok(n >= 3 && n <= 5, `${n}`);
  sim.pause();
});

test('jumpBy fires due timeouts in order and moves Date', () => {
  const { win, sim } = load({ on: true, clock: { at: 0, speed: 1 } });
  const order = [];
  win.setTimeout(() => order.push('b'), 120_000);
  win.setTimeout(() => order.push('a'), 60_000);
  win.setTimeout(() => order.push('c'), 600_000);
  sim.jumpBy(300_000);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(win.Date.now(), 300_000);
  sim.jumpBy(-5); // forward only
  assert.equal(win.Date.now(), 300_000);
});

test('the clock is saved; the start\'s keepPlaying is used once; hidden pauses', () => {
  const { sim, storage, advance, handlers, win } = load({ on: true, clock: { at: 1000, speed: 1, keepPlaying: true } });
  advance(1000);
  const saved = JSON.parse(storage.get('t-minus-simctl'));
  assert.equal(saved.clock.at, 2000);
  assert.equal(saved.clock.keepPlaying, undefined);
  win.document.hidden = true;
  handlers.visibilitychange();
  assert.equal(sim.paused, true);
});
