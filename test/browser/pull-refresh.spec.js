// Pull-to-refresh: a downward drag from the top of the main list moves it down; released past
// the threshold (64 px of offset = 128 px of finger), it refreshes and holds a gap until the
// header ↻ stops. No rubber-band bounce anywhere.
import { test, expect } from '@playwright/test';
import { openApp, tick, drag } from './helpers.js';

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
  page.on('pageerror', e => { throw e; });
  // Whether the app took over the last touchmove (so the page itself doesn't move or bounce).
  await page.addInitScript(() => addEventListener('touchmove', e => { window.lastMovePrevented = e.defaultPrevented; }));
});

const ptrText = page => page.locator('#ptr .ptr-text');
const offset = page => page.locator('#app').evaluate(el => el.style.transform);
const prevented = page => page.evaluate(() => window.lastMovePrevented);
const dataHits = mbta => mbta.hits.filter(h => h.path === '/schedules' || h.path === '/predictions');

test('a short pull springs back without refreshing', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00' });
  mbta.hits.length = 0;
  const release = await drag(page, [200, 300], 100);
  await expect(ptrText(page)).toHaveText('Pull to refresh');
  expect(await offset(page)).toBe('translateY(50px)');
  expect(await prevented(page)).toBe(true);
  await release();
  await expect.poll(() => offset(page)).toBe('');
  await tick(page, 1000);
  expect(dataHits(mbta)).toHaveLength(0);
  await expect(page.locator('.row').first()).toHaveAttribute('aria-expanded', 'false'); // the drag is not a tap
});

test('a long pull refreshes, holding the gap until the ↻ stops', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00' });
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000); // the hold is timed by the page clock
  mbta.hits.length = 0;
  const release = await drag(page, [200, 300], 200);
  await expect(ptrText(page)).toHaveText('Release to refresh');
  await release();
  await expect(ptrText(page)).toHaveText('Refreshing…');
  await expect(page.locator('#ptr')).toHaveClass(/busy/);
  expect(await offset(page)).toBe('translateY(48px)');
  await expect.poll(() => dataHits(mbta).some(h => h.path === '/schedules')).toBe(true); // forced, as ↻
  await expect(page.locator('#refresh')).toHaveClass(/busy/);
  await tick(page, 1000); // the ↻ finishes its turn
  await expect(page.locator('#refresh')).not.toHaveClass(/busy/);
  await expect.poll(() => offset(page)).toBe('');
  await expect(page.locator('#ptr')).not.toHaveClass(/busy/);
  await expect(page.locator('.row').first()).toHaveAttribute('aria-expanded', 'false');
});

test('a pull while a refresh is in flight waits for it', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00' });
  mbta.mode = 'hang';
  await page.locator('#refresh').click();
  await drag(page, [200, 300], 200, { release: true });
  await expect(ptrText(page)).toHaveText('Refreshing…');
  await tick(page, 2000);
  expect(await offset(page)).toBe('translateY(48px)');
  mbta.release();
  await expect(page.locator('#status-text')).toHaveText(/^Updated /);
  await tick(page, 1000);
  await expect.poll(() => offset(page)).toBe('');
});

test('scrolled down, a downward drag is ordinary scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 400 });
  const mbta = await openApp(page, { time: '07:00' });
  await page.evaluate(() => scrollTo(0, 200));
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  mbta.hits.length = 0;
  await drag(page, [200, 150], 200, { release: true });
  expect(await prevented(page)).toBe(false);
  expect(await offset(page)).toBe('');
  await tick(page, 1000);
  expect(dataHits(mbta)).toHaveLength(0);
});

test('no pull in setup, and no rubber-band bounce', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00' });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY)).toBe('none');
  await page.locator('#open-setup').click();
  await expect(page.locator('#setup-done')).toBeVisible();
  mbta.hits.length = 0;
  const release = await drag(page, [200, 300], 200);
  expect(await prevented(page)).toBe(false);
  expect(await offset(page)).toBe('');
  await release();
  await tick(page, 1000);
  expect(dataHits(mbta)).toHaveLength(0);
});
