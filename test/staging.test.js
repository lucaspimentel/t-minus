// scripts/staging.mjs: after the push, it waits until the staging page's footer matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footerVersion, waitForVersion } from '../scripts/staging.mjs';

const page = v => `<footer class="version">${v}</footer>`;
const V1 = 'Version 2026-11-15 · aaaaaaaaaa';
const V2 = 'Version 2026-11-15 · bbbbbbbbbb';

// A fake clock: sleep advances it; fetch returns the next answer.
function fake(answers) {
  let t = 0;
  const calls = [];
  return {
    calls,
    opts: {
      now: () => t,
      sleep: async ms => { t += ms; },
      fetch: async url => {
        calls.push(url);
        const a = answers[Math.min(calls.length - 1, answers.length - 1)];
        if (a instanceof Error) throw a;
        return typeof a === 'number' ? { ok: false, status: a, text: async () => '' } : { ok: true, status: 200, text: async () => a };
      },
    },
  };
}

test('footerVersion reads the footer version, null without one', () => {
  assert.equal(footerVersion(page(V1)), V1);
  assert.equal(footerVersion('<p>nothing</p>'), null);
});

test('waitForVersion returns once the footer matches, through errors and old versions', async () => {
  const f = fake([new Error('connect failed'), 502, page(V1), page(V2)]);
  assert.deepEqual(await waitForVersion(V2, { ...f.opts, pollMs: 10, timeoutMs: 1000 }), { ok: true, last: V2 });
  assert.equal(f.calls.length, 4);
});

test('waitForVersion gives up after the timeout with the last answer', async () => {
  const f = fake([page(V1)]);
  assert.deepEqual(await waitForVersion(V2, { ...f.opts, pollMs: 10, timeoutMs: 35 }), { ok: false, last: V1 });
  assert.equal(f.calls.length, 4); // t = 0, 10, 20, 30
  const g = fake([500]);
  assert.deepEqual(await waitForVersion(V2, { ...g.opts, pollMs: 10, timeoutMs: 5 }), { ok: false, last: 'HTTP 500' });
});
