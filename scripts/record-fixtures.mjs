// Refreshes the browser tests' static MBTA data (route list, stop lists) from the live API.
// Run: NODE_USE_ENV_PROXY=1 node scripts/record-fixtures.mjs   (MBTA_API_KEY optional, never stored)
import { writeFileSync } from 'node:fs';

const API = 'https://api-v3.mbta.com';
const OUT = new URL('../test/browser/fixtures/', import.meta.url);
const ROUTES = ['132', '136', '137', 'Orange', 'Red'];
const STOPS = [['132', 0], ['132', 1], ['Orange', 0], ['Orange', 1]];

async function get(path, params) {
  const qs = new URLSearchParams(params);
  if (process.env.MBTA_API_KEY) qs.set('api_key', process.env.MBTA_API_KEY);
  const res = await fetch(`${API}${path}?${qs}`, { headers: { Accept: 'application/vnd.api+json' } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
const save = (name, doc) => writeFileSync(new URL(name, OUT), JSON.stringify(doc, null, 1) + '\n');

// Same fields as setup.js; only the routes the tests use.
const routes = await get('/routes', {
  'filter[type]': '0,1,3',
  'fields[route]': 'short_name,long_name,type,color,direction_names,direction_destinations,sort_order',
});
save('routes.json', { data: routes.data.filter(r => ROUTES.includes(r.id)) });

// Setup reads only the stops and their child stop ids: drop `included`, links, and the
// station's door/node children.
const slim = s => ({
  type: s.type, id: s.id, attributes: s.attributes,
  relationships: { child_stops: { data: (s.relationships?.child_stops?.data ?? []).filter(c => !/^(door|node)-/.test(c.id)) } },
});
for (const [route, dir] of STOPS) {
  const doc = await get('/stops', {
    'filter[route]': route, 'filter[direction_id]': dir, 'fields[stop]': 'name,latitude,longitude', include: 'child_stops',
  });
  save(`stops-${route}-${dir}.json`, { data: doc.data.map(slim) });
}
console.log('fixtures written');
