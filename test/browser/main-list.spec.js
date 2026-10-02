// Main list: rows, countdown states, expand, trip switch, status line (loading, old data,
// Retry / backoff, rate limit), refresh spinner. Times: bus 132 leaves at 7:08, 7:36, 8:04…
// (leave-by 6 min earlier: 5-min walk + 1 min early at the stop), arriving 7:57, 8:28…
// openApp waits 1 s after the first rows, hence "6 min" at 6:55 for a 7:02 leave-by.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, rowHeads, commute } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

test('rows show the leave-by countdown, leg strip, arrival, and expand on tap', async ({ page }) => {
  await openApp(page, { time: '06:55' });
  expect(await rowHeads(page)).toEqual(['Leave in 6 min 7:02am', 'Leave in 34 min 7:30am', 'Leave in 1h 02m 7:58am', 'Leave in 1h 30m 8:26am']);
  const first = page.locator('.row').first();
  await expect(first.locator('.strip')).toHaveText(/Bus 132.*Orange/);
  await expect(first.locator('.summary')).toContainText('arrive 7:57am');
  await expect(first.locator('.summary .chev')).toHaveText('▾');
  await expect(page.locator('#status-text')).toHaveText('Updated 6:55am');

  await first.click();
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(first.locator('.timeline')).toContainText('Bus 132 7:08am → 7:22am');
  await expect(first.locator('.timeline')).toContainText('10 min to transfer'); // 7:22 arrival → 7:32 Orange
  // Stop names from the responses' included stops.
  await expect(first.locator('.step-stops')).toHaveText(['Main St @ South St → Washington St opp Oak Grove Sta', 'Oak Grove → State']);
  await expect(first.locator('.step.walk')).toHaveText([
    'Walk 5 min to Main St @ South St · 1 min early at the stop',
    '10 min to transfer, Washington St opp Oak Grove Sta → Oak Grove',
    'Walk 10 min from State · arrive 7:57am',
  ]);
  await expect(first.locator('.row-foot')).toContainText('Track this trip');
  await expect(first.locator('.row-foot .chev')).toHaveText('▴');
  await first.click();
  await expect(first.locator('.timeline')).toHaveCount(0);
});

test('countdown goes green → amber → red → missed, and the missed row leaves after 10 min', async ({ page }) => {
  await openApp(page, { time: '06:55' });
  const first = page.locator('.row').first();
  await expect(first).toHaveClass(/\bgreen\b/);
  await tickTo(page, '06:59:30');
  await expect(first).toHaveClass(/\bamber\b/);
  await expect(first.locator('.big')).toContainText('Leave in 2 min');
  await tickTo(page, '07:02:30');
  await expect(first).toHaveClass(/\bred\b/);
  await expect(first.locator('.big')).toContainText('Hurry');
  await tickTo(page, '07:03:30');
  await expect(first).toHaveClass(/\bmissed\b/);
  await expect(first.locator('.big')).toContainText('Missed · leaves in 4 min');
  await tickTo(page, '07:10');
  await expect(first.locator('.big')).toContainText('Missed · 2 min ago');
  await tickTo(page, '07:18:30');
  await expect(page.locator('.row.missed')).toHaveCount(0);
  await expect(first.locator('.big')).toContainText('7:30am');
});

test('alerts for the trip\'s routes are listed', async ({ page }) => {
  const scenario = { ...commute(), alerts: [{ id: 'a1', effect: 'DELAY', header: 'Orange Line delays of about 10 minutes', route: 'Orange' }] };
  await openApp(page, { time: '07:00', scenario });
  await expect(page.locator('#alerts')).toContainText('DELAY');
  await expect(page.locator('#alerts')).toContainText('Orange Line delays of about 10 minutes');
});

test('switching to a trip with no data yet shows its own Loading…, then "Still loading…"', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00' });
  mbta.mode = 'hang';
  await page.locator('#toggle button', { hasText: 'Office to home' }).click();
  await expect(page.locator('#status-text')).toHaveText('Loading…');
  await expect(page.locator('.row')).toHaveCount(0);
  await expect(page.locator('.empty')).toHaveText('');
  await expect(page.locator('#enroute')).toBeHidden(); // [hidden] wins over the bar's display:flex
  await expect(page.locator('#refresh')).toHaveClass(/busy/);
  await tick(page, 6000);
  await expect(page.locator('#status-text')).toHaveText('Still loading… (MBTA is slow)');
  mbta.release();
  await expect(page.locator('.row').first()).toBeVisible();
  await expect(page.locator('#status-text')).toHaveText(/^Updated 7:00am/);
});

test('old data shows its age in amber until a refresh lands', async ({ page }) => {
  const mbta = await openApp(page, { time: '06:58' });
  mbta.mode = 'hang';
  await tick(page, 60_000); // a poll starts and hangs
  await expect(page.locator('#status-text')).toHaveText('Updated 6:58am');
  await tick(page, 90_000); // older than two 60-s intervals (leave-by is near)
  await expect(page.locator('#status-text')).toHaveText('Updated 6:58am (2 min ago)');
  await expect(page.locator('#status')).toHaveClass(/\bold\b/);
  mbta.release();
  await expect(page.locator('#status-text')).toHaveText('Updated 7:00am');
  await expect(page.locator('#status')).not.toHaveClass(/\bold\b/);
});

test('errors show Retry and back off 10 s, 20 s, 40 s', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00' });
  mbta.mode = '503';
  await page.locator('#refresh').click();
  await expect(page.locator('#status-text')).toHaveText('Stale (HTTP 503) · last updated 7:00am');
  await expect(page.locator('#retry')).toBeVisible();
  const failedAt = await page.evaluate(() => Date.now());
  mbta.hits.length = 0;
  for (let i = 0; i < 75; i++) await tick(page, 1000);
  const attempts = [...new Set(mbta.hits.map(h => Math.round((h.at - failedAt) / 1000)))];
  expect(attempts.length).toBe(3);
  expect(attempts[0]).toBeGreaterThanOrEqual(9);
  expect(attempts[0]).toBeLessThanOrEqual(11);
  expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(19);
  expect(attempts[1] - attempts[0]).toBeLessThanOrEqual(21);
  expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(39);
  expect(attempts[2] - attempts[1]).toBeLessThanOrEqual(41);

  mbta.mode = 'ok';
  await page.locator('#retry').click();
  await expect(page.locator('#status-text')).toHaveText(/^Updated /);
  await expect(page.locator('#retry-wrap')).toBeHidden();
  mbta.hits.length = 0;
  for (let i = 0; i < 30; i++) await tick(page, 1000);
  expect(mbta.hits).toHaveLength(0); // back to the normal interval
});

test('rate limiting counts down to the next minute, then retries', async ({ page }) => {
  const mbta = await openApp(page, { time: '07:00:20' });
  mbta.mode = '429';
  await page.locator('#refresh').click();
  await expect(page.locator('#status-text')).toHaveText(/^Rate limited · retry in (\d+) s · last updated 7:00am$/);
  await expect(page.locator('#retry-wrap')).toBeHidden();
  const before = Number((await page.locator('#status-text').innerText()).match(/retry in (\d+)/)[1]);
  await tick(page, 5000);
  const after = Number((await page.locator('#status-text').innerText()).match(/retry in (\d+)/)[1]);
  expect(before - after).toBe(5);
  mbta.mode = 'ok';
  await tick(page, (after + 1) * 1000);
  await expect(page.locator('#status-text')).toHaveText('Updated 7:01am');
});

test('the refresh icon spins for whole turns', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  // The page clock runs in real time; pause it so test latency doesn't count as spinning.
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  const refresh = page.locator('#refresh');
  await refresh.click();
  await expect(page.locator('#status-text')).toHaveText('Updated 7:00am');
  await expect(refresh).toHaveClass(/busy/);
  await tick(page, 600);
  await expect(refresh).toHaveClass(/busy/);
  await tick(page, 300); // past one 800-ms turn
  await expect(refresh).not.toHaveClass(/busy/);
});

test('late in the evening, the next service day fills the list with weekday times', async ({ page }) => {
  await openApp(page, { time: '23:30' });
  const heads = await rowHeads(page);
  expect(heads.some(h => h.includes('Tue '))).toBe(true);
});
