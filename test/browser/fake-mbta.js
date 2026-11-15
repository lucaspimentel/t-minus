// The fake MBTA V3 API for the browser tests: Playwright routes for the MBTA and the server's
// proxy (/api/mbta/*), answered by ../../sim-mbta.js (the scenario logic and its format, shared
// with the simulator) from recorded fixtures, so tests never touch the live API.
// The route map's shapes (/route_patterns with `include` naming the shape) come from the recorded
// `patterns-<route>-<dir>.json`; other /route_patterns requests get the rail network.
// "Now" is the page's (fake) clock at each request. Tests may change a trip's `live` mid-run (a
// bus running late).
import { readFileSync, readdirSync } from 'node:fs';
import { createFakeMbta, series } from '../../sim-mbta.js';

export { series };

const FIXTURES = new URL('./fixtures/', import.meta.url);
const fixture = name => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
const ROUTES = fixture('routes.json');
const STOP_DOCS = new Map(readdirSync(FIXTURES).filter(f => f.startsWith('stops-'))
  .map(f => [f.slice(6, -5), fixture(f)])); // "132-1" → doc

const RAIL_NETWORK = fixture('rail-network.json'); // /route_patterns (canonical, with trip stops)
const SHAPE_DOCS = new Map(readdirSync(FIXTURES).filter(f => f.startsWith('patterns-'))
  .map(f => [f.slice(9, -5), fixture(f)])); // "132-1" → /route_patterns doc with shapes

// Child platform id → parent station id, and stop names, from the recorded stop lists.
const PARENT = new Map();
const NAMES = new Map();
const COORDS = new Map(); // stop id → { latitude, longitude } (included stops carry them, as the API's do)
for (const doc of STOP_DOCS.values()) {
  for (const s of doc.data) {
    NAMES.set(s.id, s.attributes.name);
    if (s.attributes.latitude != null) COORDS.set(s.id, { latitude: s.attributes.latitude, longitude: s.attributes.longitude });
    for (const c of s.relationships?.child_stops?.data ?? []) { PARENT.set(c.id, s.id); NAMES.set(c.id, s.attributes.name); }
  }
}

const STATIC = { names: NAMES, parents: PARENT, coords: COORDS, routes: ROUTES, stopDocs: STOP_DOCS, railNetwork: RAIL_NETWORK, shapeDocs: SHAPE_DOCS };

export async function fakeMbta(context, scenario, { now }) {
  const fake = createFakeMbta(scenario, STATIC);
  const mbta = {
    scenario, now, mode: 'ok', hits: [],
    held: [], // requests held while mode is 'hang'
    release() { const h = this.held.splice(0); this.mode = 'ok'; for (const r of h) respond(r); },
  };
  const answer = url => fake.answer(url, mbta.now);

  function respond(route) {
    const url = new URL(route.request().url());
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/vnd.api+json' };
    if (mbta.mode === '503') return route.fulfill({ status: 503, headers, body: '{}' }).catch(() => {});
    if (mbta.mode === '429') return route.fulfill({ status: 429, headers, body: '{}' }).catch(() => {});
    const body = answer(url);
    if (body === undefined) return route.fulfill({ status: 503, headers, body: '{}' }).catch(() => {});
    return route.fulfill({ status: body ? 200 : 404, headers, body: JSON.stringify(body ?? {}) }).catch(() => {});
  }

  await context.route('https://api-v3.mbta.com/**', async route => {
    // "Now" is the page's (fake) clock at the time of the request.
    mbta.now = await route.request().frame().evaluate(() => Date.now()).catch(() => mbta.now);
    const hit = new URL(route.request().url());
    mbta.hits.push({ at: mbta.now, path: hit.pathname, query: hit.searchParams });
    if (mbta.mode === 'hang') { mbta.held.push(route); return; }
    return respond(route);
  });

  // The server's MBTA proxy (/api/mbta/*), answering from the same scenario: `status` other than
  // 200 refuses (e.g. 503, the kill switch); `age` (s) sends `x-data-age` (a stale copy).
  mbta.proxyHits = [];
  mbta.serveProxy = (page, { status = 200, age = null } = {}) => page.route(/\/api\/mbta\//, async route => {
    mbta.now = await route.request().frame().evaluate(() => Date.now()).catch(() => mbta.now);
    const url = new URL(route.request().url());
    url.pathname = url.pathname.replace(/^\/api\/mbta/, '');
    mbta.proxyHits.push({ at: mbta.now, path: url.pathname, query: url.searchParams });
    if (status !== 200) return route.fulfill({ status, contentType: 'application/json', body: '{}' }).catch(() => {});
    const body = answer(url);
    if (body === undefined) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }).catch(() => {});
    return route.fulfill({
      status: body ? 200 : 404, headers: { 'content-type': 'application/json', ...(age && { 'x-data-age': String(age) }) },
      body: JSON.stringify(body ?? {}),
    }).catch(() => {});
  });
  return mbta;
}
