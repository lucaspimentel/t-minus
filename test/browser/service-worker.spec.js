// Service worker fallbacks: the test server (server.mjs) fails or stalls on purpose, and the
// installed app must still open from its cache. Uses real time (the worker's 3-s timeout).
import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

test.use({ serviceWorkers: 'allow' });

const mode = m => fetch(`http://localhost:8765/__mode?m=${m}`);
const status = page => page.locator('#status-text');
const footer = page => page.locator('footer.version');

test.beforeEach(async ({ page }) => {
  page.on('pageerror', e => { throw e; });
  await mode('normal');
  await openApp(page, { time: '07:00' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the worker, cache filled
  await expect(page.locator('.row').first()).toBeVisible();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});

test.afterEach(() => mode('normal'));

test('a 5xx page is replaced by the saved copy', async ({ page }) => {
  const version = await footer(page).innerText();
  await mode('502');
  await page.reload();
  await expect(footer(page)).toHaveText(version);
  await expect(status(page)).toContainText('Saved copy');
});

test('a 4xx is shown as is', async ({ page }) => {
  await mode('404');
  await page.reload();
  await expect(page.locator('h1')).toHaveText('Not found');
});

test('a slow server: the saved copy after 3 s, cleared when the same page arrives', async ({ page }) => {
  await mode('slow');
  const start = Date.now();
  await page.reload();
  await expect(status(page)).toContainText('Saved copy');
  expect(Date.now() - start).toBeLessThan(6000);
  await expect(status(page)).not.toContainText('Saved copy', { timeout: 15_000 });
  await expect(page.locator('#newversion')).toBeHidden();
});

test('a slow server with a new version: reload banner, then the new page', async ({ page }) => {
  await mode('slow-new');
  await page.reload();
  await expect(status(page)).toContainText('Saved copy');
  await expect(page.locator('#newversion')).toBeVisible({ timeout: 15_000 });
  await mode('new');
  await page.locator('#reload-new').click();
  await expect(footer(page)).toHaveText('Version NEW');
});

test('an unreachable server: the saved copy', async ({ page }) => {
  const version = await footer(page).innerText();
  await mode('down');
  await page.reload();
  await expect(footer(page)).toHaveText(version);
  await expect(status(page)).toContainText('Saved copy');
});

// A push delivered to the worker (CDP), as the push server sends it, and from an older server.
test('a push shows its notification: declarative and plain payloads', async ({ page, context }) => {
  await context.grantPermissions(['notifications'], { origin: 'http://localhost:8765' });
  const cdp = await context.newCDPSession(page);
  const registered = new Promise(resolve => cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    const r = registrations.find(x => x.scopeURL === 'http://localhost:8765/' && !x.isDeleted);
    if (r) resolve(r.registrationId);
  }));
  await cdp.send('ServiceWorker.enable');
  const registrationId = await registered;
  const deliver = async payload => cdp.send('ServiceWorker.deliverPushMessage', {
    origin: 'http://localhost:8765', registrationId, data: JSON.stringify(payload),
  });
  const shown = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications())
    .map(n => ({ title: n.title, body: n.body, tag: n.tag })));

  await deliver({
    web_push: 8030, mutable: true,
    notification: { title: 'Leave now · Home to office', body: '132 at 7:13am', tag: 'r1', renotify: true, navigate: 'http://localhost:8765/', lang: 'en-US', data: { kind: 'leave' } },
  });
  await expect.poll(shown).toEqual([{ title: 'Leave now · Home to office', body: '132 at 7:13am', tag: 'r1' }]);

  await deliver({ title: 'Test notification', body: 'Push works.', tag: 'test' });
  await expect.poll(async () => (await shown()).find(n => n.tag === 'test')).toEqual({ title: 'Test notification', body: 'Push works.', tag: 'test' });
});
