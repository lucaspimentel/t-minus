import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IMPORTS, importRe, fileHash, versionRe, versionHash } from '../scripts/stamp.mjs';

for (const { file, dep } of IMPORTS) {
  test(`${file} imports ${dep} stamped with its current content hash`, () => {
    const match = readFileSync(file, 'utf8').match(importRe(dep));
    assert.ok(match, `${dep} import not found in ${file}`);
    assert.equal(match[1], `?v=${fileHash(dep)}`, `${dep} changed: run \`npm run stamp\``);
  });
}

test('index.html version footer matches the current shell files', () => {
  const match = readFileSync('index.html', 'utf8').match(versionRe);
  assert.ok(match, 'version footer not found in index.html');
  assert.equal(match[2], versionHash(), 'shell files changed: run `npm run stamp`');
});
