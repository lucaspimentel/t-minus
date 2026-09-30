// Stamps module imports with a content hash so a changed module always has a new URL and can
// never be mixed with a stale cached copy. Run: npm run stamp
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Stamped in this order: setup.js's own core.js import changes setup.js's hash, so it is
// stamped before index.html's setup.js import.
export const IMPORTS = [
  { file: 'setup.js', dep: 'core.js' },
  { file: 'index.html', dep: 'core.js' },
  { file: 'index.html', dep: 'setup.js' },
];

export const importRe = dep => new RegExp(`from '\\./${dep.replace('.', '\\.')}(\\?v=[0-9a-f]*)?'`);

// Line endings are normalized to LF first: a Windows checkout (core.autocrlf) has CRLF on
// disk while CI has LF, and the hash must be identical on both.
export function fileHash(name, root = '.') {
  const source = readFileSync(`${root}/${name}`, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(source).digest('hex').slice(0, 10);
}

// pathToFileURL (not a bare `file://` template) so this comparison also works on Windows,
// where process.argv[1] uses backslashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const { file, dep } of IMPORTS) {
    const source = readFileSync(file, 'utf8');
    const re = importRe(dep);
    if (!re.test(source)) throw new Error(`${dep} import not found in ${file}`);
    writeFileSync(file, source.replace(re, `from './${dep}?v=${fileHash(dep)}'`));
    console.log(`${file} now imports ${dep}?v=${fileHash(dep)}`);
  }
}
