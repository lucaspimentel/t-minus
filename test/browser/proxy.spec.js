// The server's MBTA proxy (/api/mbta/*): the app asks it first, shows a stale copy's age with
// "MBTA down", and calls the MBTA directly when the proxy refuses (skipping it for 10 min).
import { test, expect } from '@playwright/test';
import { openApp, tick, rowHeads } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

test('requests go through the proxy, not to the MBTA', async ({ page }) => {
  const mbta = await openApp(page, { time: '06:55', proxy: {} });
  expect(await rowHeads(page)).toEqual(['Leave in 6 min 7:02am', 'Leave in 34 min 7:30am', 'Leave in 1h 02m 7:58am', 'Leave in 1h 30m 8:26am']);
  await expect(page.locator('#status-text')).toHaveText('Updated 6:55am');
  expect(mbta.proxyHits.map(h => h.path)).toEqual(expect.arrayContaining(['/predictions', '/schedules', '/alerts']));
  expect(mbta.hits).toHaveLength(0);
});

test('a stale copy from the proxy shows its age and "MBTA down"', async ({ page }) => {
  await openApp(page, { time: '06:55', proxy: { age: 180 } });
  await expect(page.locator('#status-text')).toHaveText('Updated 6:52am (3 min ago) · MBTA down');
  await expect(page.locator('#status')).toHaveClass(/\bold\b/);
});

test('a refusing proxy (503): the MBTA directly, and the proxy skipped for a while', async ({ page }) => {
  const mbta = await openApp(page, { time: '06:55', proxy: { status: 503 } });
  await expect(page.locator('#status-text')).toHaveText('Updated 6:55am');
  expect(mbta.proxyHits.length).toBeGreaterThan(0);
  expect(mbta.hits.length).toBeGreaterThan(0);
  const proxied = mbta.proxyHits.length;
  const direct = mbta.hits.length;
  await page.locator('#refresh').click();
  await tick(page, 1000);
  await expect(page.locator('#status-text')).toHaveText('Updated 6:55am');
  expect(mbta.hits.length).toBeGreaterThan(direct);
  expect(mbta.proxyHits).toHaveLength(proxied);
});
