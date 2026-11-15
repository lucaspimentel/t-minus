// The store (server/store.mjs's interface) in memory, for the simulator's in-page server
// (DESIGN.md "Simulator"). Rows are copied in and out, as SQLite's JSON round trip does (the
// server changes what it reads before `update`). `dump()` / `load()`: the reminders, logs and
// auto-bells as plain data (snapshots); the MBTA cache isn't kept.
const copy = x => JSON.parse(JSON.stringify(x));
const NEVER = Number.MAX_SAFE_INTEGER;

export function createMemoryStore() {
  let reminders = new Map(); // id → { endpoint, nextPollAt, body }
  let pushLog = []; // { id, endpoint, at, body }
  let appLog = []; // { id, device, at, body }
  let autoBells = new Map(); // id → { endpoint, nextAt, body }
  let nextId = 1;
  const cache = new Map();
  // Insertion order breaks ties, as SQLite's rowid order does.
  const byPoll = rows => [...rows].sort((a, b) => a.nextPollAt - b.nextPollAt).map(r => copy(r.body));
  return {
    add: r => {
      if (reminders.has(r.id)) throw new Error('UNIQUE constraint failed: reminders.id');
      reminders.set(r.id, { endpoint: r.subscription.endpoint, nextPollAt: r.nextPollAt, body: copy(r) });
    },
    update: r => {
      const row = reminders.get(r.id);
      if (row) Object.assign(row, { nextPollAt: r.nextPollAt, body: copy(r) });
    },
    delete: id => reminders.delete(id),
    get: id => (reminders.has(id) ? copy(reminders.get(id).body) : null),
    due: t => byPoll([...reminders.values()].filter(r => r.nextPollAt <= t)),
    all: () => byPoll(reminders.values()),
    count: () => reminders.size,
    countFor: endpoint => [...reminders.values()].filter(r => r.endpoint === endpoint).length,
    forEndpoint: endpoint => byPoll([...reminders.values()].filter(r => r.endpoint === endpoint)),
    deleteFor: endpoint => {
      let n = 0;
      for (const [id, r] of reminders) if (r.endpoint === endpoint) { reminders.delete(id); n++; }
      return n;
    },
    logPush: (endpoint, entry, since, max) => {
      pushLog.push({ id: nextId++, endpoint, at: entry.at, body: copy(entry) });
      pushLog = pushLog.filter(e => e.at >= since);
      const mine = pushLog.filter(e => e.endpoint === endpoint).sort((a, b) => b.id - a.id).slice(0, max).map(e => e.id);
      pushLog = pushLog.filter(e => e.endpoint !== endpoint || mine.includes(e.id));
    },
    logFor: (endpoint, since) => pushLog.filter(e => e.endpoint === endpoint && e.at >= since).sort((a, b) => b.id - a.id).map(e => copy(e.body)),
    logApp: (device, entry, since, max) => {
      appLog.push({ id: nextId++, device, at: entry.at, body: copy(entry) });
      appLog = appLog.filter(e => e.at >= since);
      const mine = appLog.filter(e => e.device === device).sort((a, b) => b.id - a.id).slice(0, max).map(e => e.id);
      appLog = appLog.filter(e => e.device !== device || mine.includes(e.id));
    },
    appLogFor: (device, since) => appLog.filter(e => e.device === device && e.at >= since).sort((a, b) => b.id - a.id).map(e => copy(e.body)),
    replaceAutoBells: (endpoint, list) => {
      for (const [id, a] of autoBells) if (a.endpoint === endpoint) autoBells.delete(id);
      for (const a of list) autoBells.set(a.id, { endpoint, nextAt: a.nextAt ?? NEVER, body: copy(a) });
    },
    updateAutoBell: a => {
      const row = autoBells.get(a.id);
      if (row) Object.assign(row, { nextAt: a.nextAt ?? NEVER, body: copy(a) });
    },
    autoBellsFor: endpoint => [...autoBells.values()].filter(a => a.endpoint === endpoint).map(a => copy(a.body)),
    dueAutoBells: t => [...autoBells.values()].filter(a => a.nextAt <= t).sort((a, b) => a.nextAt - b.nextAt).map(a => copy(a.body)),
    cacheGet: key => (cache.has(key) ? { ...cache.get(key) } : null),
    cachePut: (key, e) => { cache.set(key, { text: e.text, lastModified: e.lastModified ?? null, at: e.at }); },
    cacheTouch: (key, at) => { if (cache.has(key)) cache.get(key).at = at; },
    cachePrune: max => {
      const keep = new Set([...cache].sort((a, b) => b[1].at - a[1].at).slice(0, max).map(([k]) => k));
      let n = 0;
      for (const k of [...cache.keys()]) if (!keep.has(k)) { cache.delete(k); n++; }
      return n;
    },
    close: () => {},
    dump: () => copy({ reminders: [...reminders.entries()], pushLog, appLog, autoBells: [...autoBells.entries()], nextId }),
    load: d => {
      if (!d) return;
      const x = copy(d);
      reminders = new Map(x.reminders);
      pushLog = x.pushLog;
      appLog = x.appLog;
      autoBells = new Map(x.autoBells);
      nextId = x.nextId;
    },
  };
}
