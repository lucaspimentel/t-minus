// Accessibility: axe scans of each screen (both themes), the rows' expand buttons, keyboard
// focus kept across the once-a-second redraw, and the screen-reader announcements (#announce).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, tick, tickTo } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

// Axe violations on the page. Disabled: `meta-viewport`, since iOS ignores `user-scalable=no`
// for pinch zoom and `maximum-scale=1` stops its zoom on focusing a small input.
const violations = async page => (await new AxeBuilder({ page }).disableRules(['meta-viewport']).analyze())
  .violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);

for (const scheme of ['light', 'dark']) {
  test(`axe finds nothing on the main list (each row state), an expanded row, and setup (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, { time: '06:55' });
    expect(await violations(page)).toEqual([]);
    await page.locator('.row-toggle').first().click();
    expect(await violations(page)).toEqual([]);
    for (const t of ['06:59:30', '07:02:30', '07:03:30']) { // amber, red, missed
      await tickTo(page, t);
      expect(await violations(page)).toEqual([]);
    }
    await page.locator('#open-setup').click();
    expect(await violations(page)).toEqual([]);
    await page.locator('#setup .trip-row .item').first().click();
    expect(await violations(page)).toEqual([]);
    await page.locator('#setup').getByRole('button', { name: '+ Add transit leg', exact: true }).click();
    await page.locator('#picker-search').fill('132');
    expect(await violations(page)).toEqual([]);
  });
}

for (const scheme of ['light', 'dark']) {
  test(`axe finds nothing on the ride card and the no-trips screen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, { time: '07:00' });
    await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
    await tickTo(page, '07:08:30');
    await expect(page.locator('.ride-head')).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.evaluate(() => localStorage.setItem('mbta-leave-by:config', JSON.stringify({ trips: [] })));
    await page.reload();
    await expect(page.locator('.empty .big-btn')).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
}

test('a row is a button: its name says when to leave, and Enter expands it', async ({ page }) => {
  await openApp(page, { time: '06:55' });
  const btn = page.getByRole('button', { name: 'Leave in 6 min, 7:02am, arrive 7:57am' });
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.row').first().locator('.timeline')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('keyboard focus stays on the same control through the redraw', async ({ page }) => {
  await openApp(page, { time: '06:55' });
  const focused = () => page.evaluate(() => document.activeElement?.dataset.focus ?? null);
  await page.locator('.row-toggle').first().focus();
  const row = await focused();
  expect(row).toMatch(/^row:/);
  await tick(page, 2000);
  expect(await focused()).toBe(row);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Track this trip' }).focus();
  await tick(page, 2000);
  expect(await focused()).toMatch(/^track:/);
});

test('leave-state changes and status problems are announced', async ({ page }) => {
  const mbta = await openApp(page, { time: '06:55' });
  const announced = page.locator('#announce');
  await expect(announced).toHaveText('');
  await tickTo(page, '06:59:30');
  await expect(announced).toHaveText('Leave in 2 min · 7:02am');
  await tickTo(page, '07:02:30');
  await expect(announced).toHaveText('Hurry · <1 min · 7:03am');
  mbta.mode = '503';
  await page.locator('#refresh').click();
  await expect(announced).toHaveText('Stale (HTTP 503)');
});

for (const scheme of ['light', 'dark']) {
  test(`axe finds nothing on the Show nearby list and the sorted stops (${scheme})`, async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 42.4385, longitude: -71.0711 });
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, { time: '07:00', config: null, waitForRows: false });
    await page.locator('.empty .big-btn').click();
    const setup = page.locator('#setup');
    await setup.getByRole('button', { name: '+ Add transit leg', exact: true }).click();
    await setup.getByRole('button', { name: 'Show nearby' }).click();
    await expect(setup.getByText('Near you · within 800 m')).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await setup.locator('.list .item', { hasText: 'Bus 132' }).click();
    await expect(setup.locator('.list .item .dist').first()).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
}
