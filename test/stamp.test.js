import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IMPORTS, importRe, fileHash, versionRe, versionHash } from '../scripts/stamp.mjs';

for (const { file, dep } of IMPORTS) {
  test(`${file} imports ${dep} stamped with its current content hash`, () => {
    const matches = [...readFileSync(file, 'utf8').matchAll(importRe(dep))];
    assert.ok(matches.length, `${dep} import not found in ${file}`);
    for (const m of matches) assert.equal(m[1], `?v=${fileHash(dep)}`, `${dep} changed: run \`npm run stamp\``);
  });
}

test('index.html names the core.js it imports for the iOS app\'s native code (CORE_JS)', () => {
  const m = readFileSync('index.html', 'utf8').match(/const CORE_JS = '\.\/core\.js\?v=([0-9a-f]{10})'/);
  assert.ok(m, 'CORE_JS not found in index.html');
  assert.equal(m[1], fileHash('core.js'));
});

test('index.html version footer matches the current shell files', () => {
  const match = readFileSync('index.html', 'utf8').match(versionRe);
  assert.ok(match, 'version footer not found in index.html');
  assert.equal(match[2], versionHash(), 'shell files changed: run `npm run stamp`');
});
