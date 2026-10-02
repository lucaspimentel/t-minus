// Update check: on return to the app and every 30 min, the page is fetched and a different
// footer version shows "New version available" (the test server's `new` mode serves "Version NEW").
import { test, expect } from '@playwright/test';
import { openApp, tick } from './helpers.js';

const mode = m => fetch(`http://localhost:8765/__mode?m=${m}`);
const banner = page => page.locator('#newversion');
const returnToApp = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});
test.afterEach(() => mode('normal'));

test('every 30 min: a new version shows the banner, and Reload loads it', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await tick(page, 30 * 60_000);
  await expect(banner(page)).toBeHidden(); // same version
  await mode('new');
  await tick(page, 30 * 60_000);
  await expect(banner(page)).toBeVisible();
  await page.locator('#reload-new').click();
  await expect(page.locator('footer.version')).toHaveText('Version NEW');
});

test('returning to the app checks, at most once a minute', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await tick(page, 60_000);
  await returnToApp(page);
  await tick(page, 500);
  await expect(banner(page)).toBeHidden();
  await mode('new');
  await returnToApp(page); // checked under a minute ago
  await tick(page, 500);
  await expect(banner(page)).toBeHidden();
  await tick(page, 60_000);
  await returnToApp(page);
  await expect(banner(page)).toBeVisible();
});
