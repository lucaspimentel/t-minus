import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IMPORTS, importRe, fileHash } from '../scripts/stamp.mjs';

for (const { file, dep } of IMPORTS) {
  test(`${file} imports ${dep} stamped with its current content hash`, () => {
    const match = readFileSync(file, 'utf8').match(importRe(dep));
    assert.ok(match, `${dep} import not found in ${file}`);
    assert.equal(match[1], `?v=${fileHash(dep)}`, `${dep} changed: run \`npm run stamp\``);
  });
}
