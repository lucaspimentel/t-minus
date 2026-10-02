// Static server for the browser tests (the repo root on localhost:8765). `GET /__mode?m=…`
// switches how the app's own files are served, for the service-worker spec:
// normal | 502 | 404 | slow (8 s) | slow-new (8 s, changed footer) | new (changed footer) | down.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8765);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let mode = 'normal';

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__mode') { mode = url.searchParams.get('m') ?? 'normal'; res.end(mode); return; }
  if (mode === 'down') { req.socket.destroy(); return; }
  if (mode === '502') { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<h1>Application failed to respond</h1>'); return; }
  if (mode === '404') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>'); return; }
  if (mode.startsWith('slow')) await new Promise(r => setTimeout(r, 8000));
  const path = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  try {
    let body = await readFile(join(ROOT, path));
    if ((mode === 'slow-new' || mode === 'new') && path === '/index.html') body = Buffer.from(body.toString().replace(/Version [^<]*/, 'Version NEW'));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, () => console.log(`test server on http://localhost:${PORT}`));
