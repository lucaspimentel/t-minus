// Deploys the current commit to staging (https://staging.t-minus.lucasp.net/): force-pushes HEAD
// to the `staging` branch, which Railway's staging environment deploys without waiting for CI
// (DESIGN.md "Staging"). Refuses uncommitted changes or a stale stamp, so what's deployed is a commit.
// Run: npm run staging
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = msg => { console.error(msg); process.exit(1); };

if (git('status', '--porcelain')) fail('Uncommitted changes: commit them first.');
execFileSync(process.execPath, ['scripts/stamp.mjs'], { stdio: 'ignore' });
if (git('status', '--porcelain')) fail('npm run stamp changed files: commit them, then run this again.');
const head = git('rev-parse', '--short', 'HEAD');
execFileSync('git', ['push', '--force', 'origin', 'HEAD:refs/heads/staging'], { stdio: 'inherit' });
console.log(`Pushed ${head} to staging. Railway deploys it in 1-2 min: https://staging.t-minus.lucasp.net/`);
