// Stamps index.html's core.js import with a content hash so a changed core.js always has
// a new URL and can never be mixed with a stale cached copy. Run: npm run stamp
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const IMPORT_RE = /from '\.\/core\.js(\?v=[0-9a-f]*)?'/;

export function coreHash(root = '.') {
  return createHash('sha256').update(readFileSync(`${root}/core.js`)).digest('hex').slice(0, 10);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const html = readFileSync('index.html', 'utf8');
  if (!IMPORT_RE.test(html)) throw new Error('core.js import not found in index.html');
  writeFileSync('index.html', html.replace(IMPORT_RE, `from './core.js?v=${coreHash()}'`));
  console.log(`index.html now imports core.js?v=${coreHash()}`);
}
