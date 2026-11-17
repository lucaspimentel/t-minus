// The pinned header row (2026-11-15): the main screen's header and setup's header stay at the top
// while the page scrolls under them.
import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

test.beforeEach(({ page }) => { page.on('pageerror', e => { throw e; }); });

const box = (page, sel) => page.evaluate(s => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, sel);

test('the main header stays at the top while the rows scroll under it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await openApp(page, { time: '07:20', map: true });
  // At the top no fade below the header (it would cover the first card); scrolled, a 20 px strip.
  const fade = () => page.evaluate(() => getComputedStyle(document.querySelector('header'), '::after').content);
  expect(await fade()).toBe('none');
  // Sticky from the start: switching to sticky on the first scroll made it flicker.
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('header')).position)).toBe('sticky');
  // The en-route bar's buttons, pulled up 4 px, aren't under the header's background.
  expect(await page.evaluate(() => {
    const b = [...document.querySelectorAll('#enroute button')].find(x => x.textContent === 'Leaving now');
    const r = b.getBoundingClientRect();
    return b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 1));
  })).toBe(true);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect.poll(async () => (await box(page, 'header')).top).toBe(0);
  await expect.poll(fade).not.toBe('none');
  const header = await box(page, 'header');
  expect((await box(page, '.row')).top).toBeLessThan(header.bottom);
  const gear = await box(page, '#open-setup');
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#open-setup'), [gear.x, gear.y])).toBe(true);
});

test('setup\'s header stays at the top while its list scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await openApp(page, { time: '07:20' });
  await page.locator('#open-setup').click();
  await expect(page.locator('#setup-done')).toBeVisible();
  // No scroll padding in setup: iOS panned the view up for the keyboard to honor it.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingTop)).toBe('auto');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect.poll(async () => (await box(page, '#setup .setup-head')).top).toBe(0);
  const done = await box(page, '#setup-done');
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [done.x, done.y])).toBe('setup-done');
});

test('"Reload app" from far down setup opens the main screen at the top', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await openApp(page, { time: '07:20' });
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('manual');
  await page.locator('#open-setup').click();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.locator('#setup').getByRole('button', { name: 'Reload app' }).click();
  await page.locator('.row').first().waitFor();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('manual');
});
