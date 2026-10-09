// The list's extra rides: "Show previous rides" (first-leg vehicles that left in the last
// 15 min, with "I got on") and "Show more rides" (4 more rows per tap).
// Office to home at 5:43pm: Orange from State every 6 min (5:29, 5:35, 5:41 have left; 15-min
// ride), 5-min transfer, bus 132 from Oak Grove at 5:58 and 6:26 (12-min ride), 5-min walk.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, riding } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const listBtn = (page, name) => page.locator('#rows').getByRole('button', { name, exact: true });
const prevRows = page => page.locator('.row.prev');
const toast = page => page.locator('#toast');

test('previous rides list the trains that left in the last 15 min, in place of the missed row', async ({ page }) => {
  // 5:39pm: the 5:35pm train (the missed row's) left 4 min ago; 5:23pm left 16 min ago.
  await openApp(page, { time: '17:39' });
  await expect(prevRows(page)).toHaveCount(0);
  await expect(page.locator('.row.missed')).toHaveCount(1);
  await listBtn(page, 'Show previous rides ▾').click();
  await expect(prevRows(page).locator('.big')).toHaveText([
    /Orange · left 10 min ago\s*5:29pm/, /Orange · left 4 min ago\s*5:35pm/]);
  await expect(prevRows(page).locator('.prev-line > span')).toHaveText([
    'Bus 132 5:58pm · arrive 6:15pm', 'Bus 132 5:58pm · arrive 6:15pm']);
  await expect(page.locator('.row.missed')).toHaveCount(0); // its 5:35pm train is listed above
  await listBtn(page, 'Hide previous rides ▴').click();
  await expect(prevRows(page)).toHaveCount(0);
  await expect(page.locator('.row.missed')).toHaveCount(1);
});

test('a missed ride that has not left yet stays while previous rides are open', async ({ page }) => {
  // 5:30pm: the 5:35pm train is missed (10-min walk) but leaves in 4-5 min; 5:17pm, 5:23pm and 5:29pm have left.
  await openApp(page, { time: '17:30' });
  await expect(page.locator('.row.missed .big')).toContainText('Missed · leaves in 4 min');
  await listBtn(page, 'Show previous rides ▾').click();
  await expect(prevRows(page).locator('.big .at')).toHaveText(['5:17pm', '5:23pm', '5:29pm']);
  await expect(page.locator('.row.missed')).toHaveCount(1);
});

test('I got on tracks that ride from its departure, with Undo', async ({ page }) => {
  await openApp(page, { time: '17:43' });
  await listBtn(page, 'Show previous rides ▾').click();
  await page.getByRole('button', { name: 'I got on the 5:41pm Orange' }).click();
  await tick(page, 500);
  await expect(page.locator('.ride-head')).toHaveText(riding('Orange')); // off at 5:56pm
  await expect(page.locator('.ride-outlook')).toContainText('Bus 132');
  await expect(page.locator('.ride-outlook')).toContainText('6:26pm');
  await expect(toast(page)).toContainText('Tracking started');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await tick(page, 500);
  await expect(page.locator('.row.ride')).toHaveCount(0);
  await expect(listBtn(page, 'Show previous rides ▾')).toBeVisible();
});

test('the expanded missed row has I got on once its train has left', async ({ page }) => {
  // 5:30pm: the 5:35pm train is still to leave: no I got on.
  await openApp(page, { time: '17:30' });
  const missed = page.locator('.row.missed');
  await missed.locator('.row-toggle').click();
  await expect(missed.locator('.row-foot')).toBeVisible();
  await expect(missed.getByRole('button', { name: /^I got on/ })).toHaveCount(0);
  // 5:38pm (3 min after it left): collapsed, no button; expanded, I got on.
  await tickTo(page, '17:38');
  await missed.locator('.row-toggle').click();
  await expect(missed.locator('.row-foot')).toHaveCount(0);
  await expect(missed.getByRole('button', { name: /^I got on/ })).toHaveCount(0);
  await missed.locator('.row-toggle').click();
  await missed.getByRole('button', { name: 'I got on the 5:35pm Orange' }).click();
  await tick(page, 500);
  await expect(page.locator('.ride-head')).toHaveText(riding('Orange'));
  await expect(page.locator('.ride-outlook')).toContainText('Bus 132');
  await expect(page.locator('.ride-outlook')).toContainText('5:58pm');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await tick(page, 500);
  await expect(page.locator('.row.ride')).toHaveCount(0);
  await expect(page.locator('.row.missed')).toHaveCount(1);
});

test('Show more rides adds 4 rows per tap', async ({ page }) => {
  await openApp(page, { time: '17:43' });
  const rows = page.locator('#rows > li.row');
  await expect(rows).toHaveCount(4);
  await listBtn(page, 'Show more rides ▾').click();
  await expect(rows).toHaveCount(8);
  await expect(rows.nth(7).locator('.big')).toContainText('9:06pm');
  // Switching trips resets it.
  await page.locator('#toggle').getByRole('button', { name: 'Home to office' }).click();
  await page.locator('#toggle').getByRole('button', { name: 'Office to home' }).click();
  await expect(rows).toHaveCount(4);
});
