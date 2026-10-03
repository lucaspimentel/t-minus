// Reminders kept in one JSON file, rewritten whole (temp file + rename) after each change.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function openStore(dir) {
  const file = join(dir, 'reminders.json');
  const map = new Map();
  try {
    for (const r of JSON.parse(await readFile(file, 'utf8'))) map.set(r.id, r);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let writing = Promise.resolve();
  return {
    all: () => [...map.values()],
    put: r => { map.set(r.id, r); },
    delete: id => map.delete(id),
    // Saves run one after another, each writing the latest state.
    save() {
      writing = writing.then(async () => {
        await mkdir(dir, { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify([...map.values()]));
        await rename(`${file}.tmp`, file);
      });
      return writing;
    },
  };
}
