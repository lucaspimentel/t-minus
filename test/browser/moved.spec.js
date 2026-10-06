// The old GitHub Pages copy (until the move to t-minus.lucasp.net is done): the "moved" banner,
// its Copy trips button, and the data saved under the old key prefix copied to the new one.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { CONFIG, openApp } from './helpers.js';

const PAGES = 'https://lucaspimentel.github.io/mbta-leave-by/';
const ROOT = new URL('../..', import.meta.url).pathname;
const TYPES = { html: 'text/html', js: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png' };

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

// Serves the repo's files at the Pages address.
async function servePages(context) {
  await context.route(`${PAGES}**`, async route => {
    const path = new URL(route.request().url()).pathname.replace('/mbta-leave-by/', '') || 'index.html';
    try {
      route.fulfill({ body: await readFile(ROOT + path), contentType: TYPES[path.split('.').pop()] });
    } catch { route.fulfill({ status: 404 }); }
  });
}

// Data saved by the Pages build before the key rename.
const OLD_KEYS = cfg => { localStorage.setItem('mbta-leave-by:config', cfg); localStorage.setItem('mbta-leave-by:last-trip', '1'); };

test('on GitHub Pages: the moved banner, old data under the new keys, and Copy trips', async ({ page, context }) => {
  await servePages(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://lucaspimentel.github.io' });
  await openApp(page, { url: PAGES, config: null, init: [OLD_KEYS, JSON.stringify(CONFIG)] });
  const banner = page.getByRole('region', { name: 'T-Minus moved to t-minus.lucasp.net.' });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('link', { name: 'Open T-Minus' })).toHaveAttribute('href', 'https://t-minus.lucasp.net/');
  expect(await page.evaluate(() => [localStorage.getItem('t-minus:config') != null, localStorage.getItem('t-minus:last-trip')]))
    .toEqual([true, '1']);
  await banner.getByRole('button', { name: 'Copy trips' }).click();
  await expect(page.locator('#toast')).toContainText('Trips copied');
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(CONFIG);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    expect((await new AxeBuilder({ page }).disableRules(['meta-viewport']).analyze()).violations.map(v => v.id)).toEqual([]);
  }
});

test('on the app\'s own address: no banner, and old keys are not copied', async ({ page }) => {
  await openApp(page, { init: [OLD_KEYS, '{}'] });
  await expect(page.locator('#moved')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('t-minus:last-trip'))).toBeNull();
});
