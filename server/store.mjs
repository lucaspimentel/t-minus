// Reminders and followed rides (stop alerts, `kind: 'ride'`) in SQLite (node:sqlite, $DATA_DIR/reminders.db): columns for what the server
// queries, the whole reminder as JSON in `body`. Writes are per row.
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
    close: () => db.close(),
  };
}
