// Stamps index.html's core.js import with a content hash so a changed core.js always has
// a new URL and can never be mixed with a stale cached copy. Run: npm run stamp
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const IMPORT_RE = /from '\.\/core\.js(\?v=[0-9a-f]*)?'/;

export function coreHash(root = '.') {
  return createHash('sha256').update(readFileSync(`${root}/core.js`)).digest('hex').slice(0, 10);
}

// pathToFileURL (not a bare `file://` template) so this comparison also works on Windows,
// where process.argv[1] uses backslashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const html = readFileSync('index.html', 'utf8');
  if (!IMPORT_RE.test(html)) throw new Error('core.js import not found in index.html');
  writeFileSync('index.html', html.replace(IMPORT_RE, `from './core.js?v=${coreHash()}'`));
  console.log(`index.html now imports core.js?v=${coreHash()}`);
}
