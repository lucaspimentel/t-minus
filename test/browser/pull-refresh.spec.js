// Pull-to-refresh: a downward drag from the top of the main list moves it down; released past
// the threshold (64 px of offset = 128 px of finger), it refreshes and holds a gap until the
// header ↻ stops; with a newer page on the server it reloads the app instead ("Release to update" once the
// banner shows). The arrow points down, then up once released would refresh; a ring spins meanwhile. No rubber-band bounce anywhere.
import { test, expect } from '@playwright/test';
import { openApp, tick, drag } from './helpers.js';

test.use({ hasTouch: true });

const mode = m => fetch(`http://localhost:8765/__mode?m=${m}`);
test.afterEach(() => mode('normal'));

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
  await expect(ptrText(page)).toHaveText('Pull down to refresh');
  await expect(page.locator('#ptr')).not.toHaveClass(/ready/); // ↓
  await expect(page.locator('#ptr .ptr-icon')).toBeVisible();
  await expect(page.locator('#ptr .ptr-ring')).toBeHidden();
  expect(await offset(page)).toBe('translateY(50px)');
  expect(await prevented(page)).toBe(true);
  await release();
  await expect.poll(() => offset(page)).toBe('');
  await tick(page, 1000);
  expect(dataHits(mbta)).toHaveLength(0);
  await expect(page.locator('.row-toggle').first()).toHaveAttribute('aria-expanded', 'false'); // the drag is not a tap
});

test('a long pull refreshes, holding the gap until the ↻ stops', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00' });
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000); // the hold is timed by the page clock
  mbta.hits.length = 0;
  const release = await drag(page, [200, 300], 200);
  await expect(ptrText(page)).toHaveText('Release to refresh');
  await expect(page.locator('#ptr')).toHaveClass(/ready/); // ↑
  await release();
  await expect(ptrText(page)).toHaveText('Refreshing…');
  await expect(page.locator('#ptr')).toHaveClass(/busy/);
  await expect(page.locator('#ptr .ptr-ring')).toBeVisible();
  await expect(page.locator('#ptr .ptr-icon')).toBeHidden();
  expect(await offset(page)).toBe('translateY(48px)');
  await expect.poll(() => dataHits(mbta).some(h => h.path === '/schedules')).toBe(true); // forced, as ↻
  await expect(page.locator('#refresh')).toHaveClass(/busy/);
  await tick(page, 1000); // the ↻ finishes its turn
  await expect(page.locator('#refresh')).not.toHaveClass(/busy/);
  await expect.poll(() => offset(page)).toBe('');
  await expect(page.locator('#ptr')).not.toHaveClass(/busy/);
  await expect(page.locator('#ptr')).not.toHaveClass(/ready/);
  await expect(page.locator('.row-toggle').first()).toHaveAttribute('aria-expanded', 'false');
});

// A newer page on the server: the pull reloads the app (a `window` marker gone); none, or the
// check failing: only the data refresh (the marker stays).
const mark = page => page.evaluate(() => { window.pullMarker = true; });
const marked = page => page.evaluate(() => window.pullMarker === true);

test('a long pull with no newer page refreshes the data only; a failed check too', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await mark(page);
  let release = await drag(page, [200, 300], 200);
  await release();
  await expect(ptrText(page)).toHaveText('Refreshing…');
  await tick(page, 1000);
  await expect.poll(() => offset(page)).toBe('');
  expect(await marked(page)).toBe(true);
  await mode('502');
  release = await drag(page, [200, 300], 200);
  await release();
  await tick(page, 1000);
  await expect.poll(() => offset(page)).toBe('');
  expect(await marked(page)).toBe(true);
});

test('a long pull with a newer page on the server reloads the app', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await mark(page);
  await mode('new');
  const release = await drag(page, [200, 300], 200);
  await expect(ptrText(page)).toHaveText('Release to refresh'); // not known yet
  await release();
  await expect(page.locator('footer.version')).toHaveText('Version NEW');
  expect(await marked(page)).toBe(false);
});

test('with the update banner showing, the pull says update and reloads', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await mode('new');
  await tick(page, 61_000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // back in the app: the update check
  await expect(page.locator('#newversion')).toBeVisible();
  await mark(page);
  // One drag: "Pull down to update" halfway, "Release to update" past the threshold. It spans a
  // redraw (the rows are replaced each second, the touched one too): the pull carries on.
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: y == null ? [] : [{ x: 200, y }] });
  await touch('touchStart', 300);
  for (let y = 310; y <= 400; y += 10) await touch('touchMove', y);
  await tick(page, 1100);
  await expect(ptrText(page)).toHaveText('Pull down to update');
  for (let y = 410; y <= 500; y += 10) await touch('touchMove', y);
  await expect(ptrText(page)).toHaveText('Release to update');
  await touch('touchEnd');
  await expect(page.locator('footer.version')).toHaveText('Version NEW');
  expect(await marked(page)).toBe(false);
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
