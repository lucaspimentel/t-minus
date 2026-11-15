// The Node-only helpers createApp takes as options (server/app.mjs has no Node imports so the
// simulator can run it in the page): sha256 as base64url (APNs collapse ids, ETags), gzip
// (the MBTA proxy's answers) and reading the app's files.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const hash = s => createHash('sha256').update(s).digest('base64url');
export const gzip = body => gzipSync(body);
export const readStaticFile = (root, file) => readFile(join(root, file));
export const nodeDeps = { hash, gzip, readStaticFile };
