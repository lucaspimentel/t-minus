// Stamps module imports with a content hash so a changed module always has a new URL and can
// never be mixed with a stale cached copy. Run: npm run stamp
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Stamped in this order: a file's own imports change its hash, so it is stamped before the
// files that import it (setup.js before index.html's setup.js import; the simulator's modules,
// DESIGN.md "Simulator", before sim-page.js and index.html).
export const IMPORTS = [
  { file: 'sim-presets.js', dep: 'sim-mbta.js' },
  { file: 'sim-page.js', dep: 'core.js' },
  { file: 'sim-page.js', dep: 'sim-mbta.js' },
  { file: 'sim-page.js', dep: 'sim-presets.js' },
  { file: 'sim-page.js', dep: 'server/app.mjs' },
  { file: 'sim-page.js', dep: 'server/memory-store.mjs' },
  { file: 'setup.js', dep: 'core.js' },
  { file: 'ui.js', dep: 'core.js' },
  { file: 'share.js', dep: 'core.js' },
  { file: 'share.js', dep: 'ui.js' },
  { file: 'share.html', dep: 'share.js' },
  { file: 'share.html', dep: 'app.css' },
  { file: 'index.html', dep: 'core.js' },
  { file: 'index.html', dep: 'setup.js' },
  { file: 'index.html', dep: 'ui.js' },
  { file: 'index.html', dep: 'app.css' },
  { file: 'index.html', dep: 'sim.js' },
  { file: 'index.html', dep: 'sim-page.js' },
  { file: 'index.html', dep: 'sim-presets.js' },
];

// Every `'./core.js?v=…'` in the file: the import, and index.html's CORE_JS (the URL the iOS
// app's native code loads core.js from: boarding from location).
export const importRe = dep => new RegExp(`'\\./${dep.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\?v=[0-9a-f]*)?'`, 'g');

// Line endings are normalized to LF first: a Windows checkout (core.autocrlf) has CRLF on
// disk while CI has LF, and the hash must be identical on both.
export function fileHash(name, root = '.') {
  const source = readFileSync(`${root}/${name}`, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(source).digest('hex').slice(0, 10);
}

// App version shown in the footer: the date it was stamped plus a hash of every shell file
// (index.html with the version itself blanked), so any change to what's served shows a new one.
export const VERSION_FILES = ['index.html', 'core.js', 'setup.js', 'sw.js', 'manifest.json', 'app.css', 'ui.js', 'share.html', 'share.js',
  'sim.js', 'sim-page.js', 'sim-mbta.js', 'sim-presets.js', 'server/app.mjs', 'server/memory-store.mjs'];
export const versionRe = /Version (\d{4}-\d{2}-\d{2}) · ([0-9a-f]{10})/;

export function versionHash(root = '.') {
  const h = createHash('sha256');
  for (const name of VERSION_FILES) {
    h.update(readFileSync(`${root}/${name}`, 'utf8').replace(/\r\n/g, '\n').replace(versionRe, 'Version'));
  }
  return h.digest('hex').slice(0, 10);
}

// pathToFileURL (not a bare `file://` template) so this comparison also works on Windows,
// where process.argv[1] uses backslashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const { file, dep } of IMPORTS) {
    const source = readFileSync(file, 'utf8');
    const re = importRe(dep);
    if (!source.match(re)) throw new Error(`${dep} import not found in ${file}`);
    writeFileSync(file, source.replace(re, `'./${dep}?v=${fileHash(dep)}'`));
    console.log(`${file} now imports ${dep}?v=${fileHash(dep)}`);
  }
  // The date only changes when the content does.
  const page = readFileSync('index.html', 'utf8');
  const current = page.match(versionRe);
  if (!current) throw new Error('Version footer not found in index.html');
  const hash = versionHash();
  if (current[2] !== hash) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    writeFileSync('index.html', page.replace(versionRe, `Version ${date} · ${hash}`));
  }
  console.log(`version ${readFileSync('index.html', 'utf8').match(versionRe).slice(1).join(' · ')}`);
}
