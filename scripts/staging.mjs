// Deploys the current commit to staging (https://staging.t-minus.lucasp.net/): force-pushes HEAD
// to the `staging` branch, which Railway's staging environment deploys without waiting for CI
// (DESIGN.md "Staging"), then waits until the staging page's footer version matches this
// checkout's. Refuses uncommitted changes or a stale stamp, so what's deployed is a commit.
// Run: npm run staging [-- --no-wait]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { versionRe } from './stamp.mjs';

export const STAGING_URL = 'https://staging.t-minus.lucasp.net/';
const POLL_MS = 10_000;
const TIMEOUT_MS = 5 * 60_000;

// The footer version ("Version 2026-11-15 · bdd9f201af") in a page's HTML, or null.
export const footerVersion = html => versionRe.exec(html)?.[0] ?? null;

// Polls the staging page until its footer is `want`. Resolves { ok, last }.
export async function waitForVersion(want, { fetch = globalThis.fetch, url = STAGING_URL, pollMs = POLL_MS, timeoutMs = TIMEOUT_MS, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const end = now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      last = res.ok ? footerVersion(await res.text()) ?? 'no footer' : `HTTP ${res.status}`;
    } catch (e) { last = e.message; }
    if (last === want) return { ok: true, last };
    if (now() + pollMs > end) return { ok: false, last };
    await sleep(pollMs);
  }
}

async function main() {
  // Behind a proxy (the Claude Code cloud sandbox), Node's fetch uses it only with
  // NODE_USE_ENV_PROXY=1, which must be set at startup: re-run with it.
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
    process.exit(r.status ?? 1);
  }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const fail = msg => { console.error(msg); process.exit(1); };

  if (git('status', '--porcelain')) fail('Uncommitted changes: commit them first.');
  execFileSync(process.execPath, ['scripts/stamp.mjs'], { stdio: 'ignore' });
  if (git('status', '--porcelain')) fail('npm run stamp changed files: commit them, then run this again.');
  const head = git('rev-parse', '--short', 'HEAD');
  const want = footerVersion(readFileSync('index.html', 'utf8'));
  execFileSync('git', ['push', '--force', 'origin', 'HEAD:refs/heads/staging'], { stdio: 'inherit' });
  console.log(`Pushed ${head} to staging (${want}).`);
  if (process.argv.includes('--no-wait')) return;

  console.log(`Waiting for ${STAGING_URL} to show it (up to ${TIMEOUT_MS / 60_000} min)…`);
  const { ok, last } = await waitForVersion(want);
  if (!ok) fail(`Staging still shows ${last} after ${TIMEOUT_MS / 60_000} min: check the deploy in Railway (staging environment).`);
  console.log(`Staging is live: ${last}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
