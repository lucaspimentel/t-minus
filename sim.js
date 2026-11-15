// The simulator's clock (DESIGN.md "Simulator"): loaded before the app's module and inert unless
// the simulator is on (`t-minus-simctl` in localStorage, written by setup's Developer card). On,
// it replaces Date with a virtual clock (a time, a speed, paused or playing) and runs setTimeout
// and setInterval on virtual time, so every timer in the app follows the clock; intervals run at
// most 4 times a real second. Paused, Date stands still but timers run in real time (toasts hide,
// spinners spin). It pauses when the page is hidden, and comes back paused on the next launch
// (playing after the simulator's own reloads: Start, a rewind). Also a fake navigator.geolocation
// fed by sim-page.js (the bar's Location). `window.tminusSim`: the controls, or null when off.
(() => {
  const CTL = 't-minus-simctl';
  let ctl = null;
  try { ctl = JSON.parse(localStorage.getItem(CTL)); } catch { /* no storage: off */ }
  if (!ctl?.on) { window.tminusSim = null; return; }
  // A rewind's snapshot (sim-page.js), applied before the app reads its keys: the page that took
  // it kept running until the reload and could have written over them.
  try {
    const restore = JSON.parse(localStorage.getItem('t-minus-simrestore'));
    if (restore) {
      for (const k of Object.keys(localStorage)) if (k.startsWith('t-minus-sim:') && !/^t-minus-sim:(stops:|shapes:|routes:|rail-network:)/.test(k)) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(restore)) localStorage.setItem(k, v);
    }
    localStorage.removeItem('t-minus-simrestore');
  } catch { /* storage off */ }

  const RealDate = window.Date;
  const real = {
    Date: RealDate,
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
  };
  const listeners = new Set();
  const changed = () => { for (const f of listeners) { try { f(); } catch (e) { console.error(e); } } };

  // The virtual clock: `at` (virtual ms) as of `realAt` (real ms), advancing at `speed` unless paused.
  const saved = ctl.clock ?? {};
  const playing = !!saved.keepPlaying;
  const clock = { at: saved.at ?? RealDate.now(), realAt: RealDate.now(), speed: saved.speed ?? 1, paused: !playing };
  const now = () => clock.at + (clock.paused ? 0 : (RealDate.now() - clock.realAt) * clock.speed);
  // Timer time: like the clock while playing, real time while paused; jumps move both.
  const timer = { at: 0, realAt: RealDate.now() };
  const rate = () => (clock.paused ? 1 : clock.speed);
  const tnow = () => timer.at + (RealDate.now() - timer.realAt) * rate();
  const rebase = () => {
    clock.at = now(); clock.realAt = RealDate.now();
    timer.at = tnow(); timer.realAt = RealDate.now();
  };

  // A clock written for the next load (a rewind's target) is kept: no later save replaces it.
  let held = false;
  function save(patch = {}) {
    if (held) return;
    if (patch.clock) held = true;
    try {
      const c = JSON.parse(localStorage.getItem(CTL)) ?? {};
      Object.assign(c, patch);
      if (c.on) c.clock = { at: now(), speed: clock.speed, paused: clock.paused, ...(patch.clock ?? {}) };
      localStorage.setItem(CTL, JSON.stringify(c));
    } catch { /* storage full or off */ }
  }

  // ---------- timers on virtual time ----------
  const timers = new Map(); // id → { fn, args, due, period }
  let nextId = 1;
  let driver = null;
  function plan() {
    if (driver != null) real.clearTimeout(driver);
    driver = null;
    let first = Infinity;
    for (const t of timers.values()) if (t.due < first) first = t.due;
    if (first === Infinity) return;
    driver = real.setTimeout(fire, Math.max(0, Math.ceil((first - tnow()) / rate())));
  }
  function fire() {
    driver = null;
    for (let n = 0; n < 1000; n++) {
      const t0 = tnow() + 1; // within a millisecond: due (rounding)
      let next = null;
      for (const [id, t] of timers) if (t.due <= t0 && (!next || t.due < next[1].due)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      if (t.period == null) timers.delete(id);
      else t.due = Math.max(t.due + Math.max(t.period, 250 * rate()), t0);
      try { t.fn(...t.args); } catch (e) { real.setTimeout(() => { throw e; }); }
    }
    plan();
  }
  function add(fn, ms, args, period) {
    if (typeof fn !== 'function') return 0;
    const id = nextId++;
    const d = Math.max(0, Number(ms) || 0);
    timers.set(id, { fn, args, due: tnow() + d, period: period ? Math.max(d, 1) : null });
    plan();
    return id;
  }
  const clear = id => { if (timers.delete(id)) plan(); };
  window.setTimeout = (fn, ms, ...args) => add(fn, ms, args, false);
  window.setInterval = (fn, ms, ...args) => add(fn, ms, args, true);
  window.clearTimeout = clear;
  window.clearInterval = clear;

  // ---------- Date ----------
  class SimDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now()); }
    static now() { return now(); }
  }
  // `Date()` called as a function returns the current time as a string, as the real one does.
  window.Date = new Proxy(SimDate, { apply: () => new SimDate().toString() });

  // ---------- controls ----------
  function setRate(apply) { rebase(); apply(); plan(); save(); changed(); }
  const sim = {
    on: true,
    prefix: 't-minus-sim:',
    ctl: () => { try { return JSON.parse(localStorage.getItem(CTL)); } catch { return null; } },
    saveCtl: save,
    now,
    real,
    get speed() { return clock.speed; },
    get paused() { return clock.paused; },
    play: () => setRate(() => { clock.paused = false; }),
    pause: () => setRate(() => { clock.paused = true; }),
    setSpeed: s => setRate(() => { clock.speed = s; }),
    // Forward only (a rewind reloads from a snapshot): due timers fire at once.
    jumpBy: ms => {
      if (!(ms > 0)) return;
      rebase();
      clock.at += ms;
      timer.at += ms;
      fire();
      save();
      changed();
    },
    onChange: f => { listeners.add(f); return () => listeners.delete(f); },
    setLocationProvider: f => { locate = f; changed(); },
  };
  window.tminusSim = sim;
  // The ctl comes back with the clock playing only after the simulator's own reload.
  if (playing) { save({ clock: { at: clock.at, speed: clock.speed, paused: false } }); held = false; }
  real.setInterval(() => save(), 1000);
  window.addEventListener('pagehide', () => save());
  document.addEventListener('visibilitychange', () => { if (document.hidden && !clock.paused) sim.pause(); });

  // ---------- fake location ----------
  let locate = () => null; // () => { lat, lon, acc } | null
  const position = p => ({ coords: { latitude: p.lat, longitude: p.lon, accuracy: p.acc ?? 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: now() });
  const unavailable = { code: 2, message: 'Simulator location off', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
  const watches = new Map();
  let watchId = 1;
  const report = (ok, err) => { const p = locate(); if (p) ok(position(p)); else err?.(unavailable); };
  const geolocation = {
    getCurrentPosition: (ok, err) => { real.setTimeout(() => report(ok, err), 0); },
    watchPosition: (ok, err) => {
      const id = watchId++;
      report(ok, err);
      watches.set(id, real.setInterval(() => report(ok, err), 2000));
      return id;
    },
    clearWatch: id => { real.clearInterval(watches.get(id)); watches.delete(id); },
  };
  try { Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geolocation }); } catch { /* read-only */ }
  const query = navigator.permissions?.query?.bind(navigator.permissions);
  if (query) {
    navigator.permissions.query = d => (d?.name === 'geolocation'
      ? Promise.resolve({ state: locate() ? 'granted' : 'prompt', onchange: null, addEventListener() {}, removeEventListener() {} })
      : query(d));
  }
})();
