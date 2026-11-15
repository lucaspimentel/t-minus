// server/memory-store.mjs answers like server/store.mjs (the simulator's in-page server), and
// server/app.mjs stays loadable in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { createMemoryStore } from '../server/memory-store.mjs';

const rem = (id, endpoint, nextPollAt, extra = {}) => ({ id, subscription: { endpoint }, nextPollAt, ...extra });

function run(store) {
  const out = [];
  store.add(rem('a', 'e1', 30));
  store.add(rem('b', 'e1', 10));
  store.add(rem('c', 'e2', 20, { n: 1 }));
  out.push(store.due(20).map(r => r.id), store.all().map(r => r.id), store.count(), store.countFor('e1'));
  const c = store.get('c');
  c.n = 2;
  out.push(store.get('c').n); // a copy
  store.update({ ...c, nextPollAt: 5 });
  store.update(rem('gone', 'e1', 1)); // never inserts
  out.push(store.forEndpoint('e2'), store.get('gone'), store.delete('b'), store.delete('b'), store.deleteFor('e1'), store.all().map(r => r.id));
  for (let i = 0; i < 5; i++) store.logPush('e1', { at: 100 + i, i }, 0, 3);
  store.logPush('e2', { at: 200, i: 9 }, 102, 3);
  out.push(store.logFor('e1', 0), store.logFor('e2', 0));
  store.logApp('d1', { at: 1, line: 'x' }, 0, 2);
  store.logApp('d1', { at: 2, line: 'y' }, 0, 2);
  store.logApp('d1', { at: 3, line: 'z' }, 0, 2);
  out.push(store.appLogFor('d1', 0));
  store.replaceAutoBells('e1', [{ id: 'x', nextAt: 50 }, { id: 'y', nextAt: null }]);
  store.replaceAutoBells('e2', [{ id: 'z', nextAt: 40 }]);
  store.updateAutoBell({ id: 'x', nextAt: 45, k: 1 });
  out.push(store.dueAutoBells(60), store.autoBellsFor('e1').map(a => a.id).sort());
  store.cachePut('k1', { text: 'a', lastModified: 'L', at: 1 });
  store.cachePut('k2', { text: 'b', at: 2 });
  store.cacheTouch('k1', 3);
  out.push(store.cacheGet('k1'), store.cachePrune(1), store.cacheGet('k2'));
  return out;
}

test('the memory store answers like the SQLite store', async () => {
  const sqlite = openStore(await mkdtemp(join(tmpdir(), 'mem-store-')));
  try {
    assert.deepEqual(run(createMemoryStore()), run(sqlite));
  } finally { sqlite.close(); }
});

test('dump and load keep reminders, logs and auto-bells', () => {
  const a = createMemoryStore();
  a.add(rem('r', 'e', 5, { x: 1 }));
  a.logPush('e', { at: 1 }, 0, 10);
  a.replaceAutoBells('e', [{ id: 'z', nextAt: 3 }]);
  const b = createMemoryStore();
  b.load(a.dump());
  a.delete('r');
  assert.deepEqual(b.get('r'), rem('r', 'e', 5, { x: 1 }));
  assert.equal(b.logFor('e', 0).length, 1);
  assert.equal(b.dueAutoBells(5)[0].id, 'z');
});

test('server/app.mjs has no Node-only code (the simulator loads it in the page)', async () => {
  const src = await readFile(new URL('../server/app.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'node:|\bBuffer\.|\bprocess\.|\brequire\(/);
});
