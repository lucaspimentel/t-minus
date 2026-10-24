// Datadog RUM (DESIGN.md "Observability") and the MBTA key: RUM starts only when /api/config has
// the web app's IDs, and the key goes in a header, never a URL.
import { test, expect } from '@playwright/test';
import { openApp, CONFIG } from './helpers.js';

const CDN = /datadoghq-browser-agent\.com/;
// Stands in for the SDK: records init's options.
const STUB_SDK = 'window.DD_RUM = { init(o) { window.rumInit = { ...o, tracingMatch: o.allowedTracingUrls[0].match(location.origin + "/api/mbta/stops") }; } };';

test('RUM starts with the IDs from /api/config', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: { rum: { web: { applicationId: 'app-1', clientToken: 'pub-1' }, ios: null } } }));
  await page.route(CDN, route => route.fulfill({ contentType: 'text/javascript', body: STUB_SDK }));
  await openApp(page);
  await expect.poll(() => page.evaluate(() => window.rumInit ?? null)).not.toBeNull();
  const init = await page.evaluate(() => window.rumInit);
  const version = /· ([0-9a-f]{10})/.exec(await page.locator('footer.version').textContent())[1];
  expect(init).toMatchObject({ applicationId: 'app-1', clientToken: 'pub-1', service: 't-minus-web', env: 'prod', version, sessionReplaySampleRate: 0, tracingMatch: true });
});

test('RUM stays off when /api/config has no IDs', async ({ page }) => {
  const cdn = [];
  page.on('request', r => { if (CDN.test(r.url())) cdn.push(r.url()); });
  await page.route('**/api/config', route => route.fulfill({ json: { rum: { web: null, ios: null } } }));
  await openApp(page);
  await page.waitForTimeout(300);
  expect(cdn).toEqual([]);
});

test('the MBTA fallback sends the key as x-api-key, not in the URL', async ({ page }) => {
  const calls = [];
  page.on('request', r => { if (r.url().startsWith('https://api-v3.mbta.com/') && r.method() === 'GET') calls.push({ url: r.url(), key: r.headers()['x-api-key'] }); });
  await openApp(page, { config: { ...CONFIG, apiKey: 'k1' } });
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) expect(c).toEqual({ url: expect.not.stringContaining('api_key'), key: 'k1' });
});
