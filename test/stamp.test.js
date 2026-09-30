import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IMPORT_RE, coreHash } from '../scripts/stamp.mjs';

test('index.html imports core.js stamped with its current content hash', () => {
  const match = readFileSync('index.html', 'utf8').match(IMPORT_RE);
  assert.ok(match, 'core.js import not found in index.html');
  assert.equal(match[1], `?v=${coreHash()}`, 'core.js changed: run `npm run stamp`');
});
