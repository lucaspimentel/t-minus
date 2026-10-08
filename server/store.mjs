// Reminders and followed rides (stop alerts, `kind: 'ride'`) in SQLite (node:sqlite, $DATA_DIR/reminders.db): columns for what the server
// queries, the whole reminder as JSON in `body`. Writes are per row. Also the MBTA proxy's static
// copies (`mbta_cache`: routes, stops, route patterns), kept across restarts.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'reminders.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      next_poll_at INTEGER NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reminders_due ON reminders (next_poll_at);
    CREATE INDEX IF NOT EXISTS reminders_endpoint ON reminders (endpoint);
    CREATE TABLE IF NOT EXISTS mbta_cache (
      key TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      last_modified TEXT,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mbta_cache_fetched ON mbta_cache (fetched_at);
  `);
  const q = {
    add: db.prepare('INSERT INTO reminders (id, endpoint, next_poll_at, body) VALUES (?, ?, ?, ?)'),
    // Never inserts: a reminder deleted while a tick waited on the MBTA stays deleted.
    update: db.prepare('UPDATE reminders SET next_poll_at = ?, body = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM reminders WHERE id = ?'),
    get: db.prepare('SELECT body FROM reminders WHERE id = ?'),
    due: db.prepare('SELECT body FROM reminders WHERE next_poll_at <= ? ORDER BY next_poll_at'),
    all: db.prepare('SELECT body FROM reminders ORDER BY next_poll_at'),
    count: db.prepare('SELECT count(*) AS n FROM reminders'),
    countFor: db.prepare('SELECT count(*) AS n FROM reminders WHERE endpoint = ?'),
    cacheGet: db.prepare('SELECT body, last_modified, fetched_at FROM mbta_cache WHERE key = ?'),
    cachePut: db.prepare('INSERT OR REPLACE INTO mbta_cache (key, body, last_modified, fetched_at) VALUES (?, ?, ?, ?)'),
    cacheTouch: db.prepare('UPDATE mbta_cache SET fetched_at = ? WHERE key = ?'),
    // The newest `max` rows stay (a revalidation moves fetched_at).
    cachePrune: db.prepare('DELETE FROM mbta_cache WHERE key NOT IN (SELECT key FROM mbta_cache ORDER BY fetched_at DESC LIMIT ?)'),
  };
  const parse = rows => rows.map(r => JSON.parse(r.body));
  return {
    add: r => { q.add.run(r.id, r.subscription.endpoint, r.nextPollAt, JSON.stringify(r)); },
    update: r => { q.update.run(r.nextPollAt, JSON.stringify(r), r.id); },
    delete: id => q.delete.run(id).changes > 0,
    get: id => parse([q.get.get(id)].filter(Boolean))[0] ?? null,
    due: t => parse(q.due.all(t)),
    all: () => parse(q.all.all()),
    count: () => q.count.get().n,
    countFor: endpoint => q.countFor.get(endpoint).n,
    // { text, lastModified, at } or null.
    cacheGet: key => {
      const r = q.cacheGet.get(key);
      return r ? { text: r.body, lastModified: r.last_modified, at: r.fetched_at } : null;
    },
    cachePut: (key, e) => { q.cachePut.run(key, e.text, e.lastModified ?? null, e.at); },
    cacheTouch: (key, at) => { q.cacheTouch.run(at, key); },
    cachePrune: max => q.cachePrune.run(max).changes,
    close: () => db.close(),
  };
}
