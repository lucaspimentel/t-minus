// Main list: rows, countdown states, expand, trip switch, status line (loading, old data,
// Retry / backoff, rate limit), refresh spinner. Times: bus 132 leaves at 7:08, 7:36, 8:04…
// (leave-by 6 min earlier: 5-min walk + 1 min early at the stop), arriving 7:57, 8:28…
// openApp waits 1 s after the first rows, hence "6 min" at 6:55 for a 7:02 leave-by.
import { test, expect } from '@playwright/test';
import { openApp, tick, tickTo, rowHeads, commute, CONFIG } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

test('rows show the leave-by countdown, leg strip, arrival, and expand on tap', async ({ page }) => {
  await openApp(page, { time: '06:55' });
  expect(await rowHeads(page)).toEqual(['Leave in 6 min 7:02am', 'Leave in 34 min 7:30am', 'Leave in 1h 02m 7:58am', 'Leave in 1h 30m 8:26am']);
  const first = page.locator('.row').first();
  await expect(first.locator('.strip')).toHaveText(/Bus 132.*Orange/);
  await expect(first.locator('.summary')).toContainText('arrive ~7:57am'); // Orange has no predictions: by its headway
  await expect(first.locator('.summary .chev')).toHaveText('▾');
  await expect(page.locator('#status-text')).toHaveText('Updated 6:55am');

  await first.click();
  await expect(first.locator('.row-toggle')).toHaveAttribute('aria-expanded', 'true');
  // Stops as the rail's nodes (names from the responses' included stops), each with its time;
  // each ride between its stops, as a bar in the route's color; walks and transfers short.
  const tl = first.locator('.timeline');
  await expect(tl.locator('.step.stop .n')).toHaveText(['Main St @ South St', 'Washington St opp Oak Grove Sta', 'Oak Grove', 'State']);
  await expect(tl.locator('.step.stop .t')).toHaveText(['7:08am', '7:22am', '~7:32am', '~7:47am']);
  await expect(tl.locator('.step.ride')).toHaveText([/^Bus 132 · 14 min\s*scheduled\s*toward Malden$/i, /^Orange Line · 15 min\s*every 6 min\s*toward Forest Hills$/i]);
  await expect(tl.locator('.step.ride .toward')).toHaveText(['toward Malden', 'toward Forest Hills']); // the trip's headsign, on its own line
  expect(await tl.locator('.tl-leg').evaluateAll(ls => ls.map(l => l.style.getPropertyValue('--c')))).toEqual(['#FFC72C', '#ED8B00']);
  await expect(tl.locator('.step.walk')).toHaveText(['Walk 5 min · 1 min early at the stop', '10 min to transfer', 'Walk 10 min']);
  // Leave and Arrive at the ends, in the same time column.
  await expect(tl.locator('.step.end')).toHaveText([/^Leave\s*7:02am$/, /^Arrive\s*~7:57am$/]);
  await expect(tl.locator('.step').first()).toHaveClass(/\bend\b/);
  await expect(tl.locator('.step').last()).toHaveClass(/\bend\b/);
  await expect(tl.locator('.step.walk .walk-icon')).toHaveCount(3);
  // Tapping a stop shows its full name (kept across re-renders) and doesn't collapse the row.
  const drop = tl.locator('.step.stop').nth(1);
  await drop.click();
  await expect(drop).toHaveClass(/\bfull\b/);
  await expect(first.locator('.row-toggle')).toHaveAttribute('aria-expanded', 'true');
  await tick(page, 1500);
  await expect(tl.locator('.step.stop').nth(1)).toHaveClass(/\bfull\b/);
  await tl.locator('.step.stop').nth(1).click();
  await expect(tl.locator('.step.stop').nth(1)).not.toHaveClass(/\bfull\b/);
  await expect(first.locator('.row-foot')).toContainText('Track this trip');
  await expect(first.locator('.row-foot .chev')).toHaveText('▴');
  await first.click();
  await expect(first.locator('.timeline')).toHaveCount(0);
});

test('before stop names are known, the timeline keeps its shape with "—"', async ({ page }) => {
  await openApp(page, { time: '06:55', scenario: { ...commute(), unnamed: true } });
  const first = page.locator('.row').first();
  await first.click();
  await expect(first.locator('.timeline .step.stop .n')).toHaveText(['—', '—', '—', '—']);
  await expect(first.locator('.timeline .step.stop .t')).toHaveText(['7:08am', '7:22am', '~7:32am', '~7:47am']);
});

test('countdown goes green → amber → red → missed, and the missed row leaves after 5 min', async ({ page }) => {
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
  await expect(first.locator('.big')).toContainText('Too late · leaves in 4 min');
  await tickTo(page, '07:10');
  await expect(first.locator('.big')).toContainText('Missed · left 2 min ago');
  await tickTo(page, '07:13:30');
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

// The MBTA's real-time display guidelines: a subway leg with no predictions shows its headway,
// not scheduled times. Office to home timed on the Orange Line (every 6 min); the bus is predicted.
test('a subway leg with no predictions shows its headway and "~" times; a predicted train brings it back', async ({ page }) => {
  const config = structuredClone(CONFIG);
  config.trips[1].timingLeg = 0;
  const scenario = commute();
  for (const t of scenario.trips) t.live = t.route === '132';
  const mbta = await openApp(page, { time: '17:00', config, scenario });
  const row = page.locator('.row:not(.missed)').first();
  await expect(row.locator('.summary .badge')).toHaveText('every 6 min');
  await expect(row.locator('.summary .arrive')).toHaveText(/^arrive \d+:\d+pm$/); // from the live bus
  await row.click();
  const tl = row.locator('.timeline');
  await expect(tl.locator('.step.ride .badge')).toHaveText(['every 6 min', 'live']);
  await expect(tl.locator('.step.stop .t')).toHaveText([/^~\d+:\d+pm$/, /^~\d+:\d+pm$/, /^\d+:\d+pm$/, /^\d+:\d+pm$/]);
  await expect(tl.locator('.step.end .t')).toHaveText([/^\d+:\d+pm$/, /^\d+:\d+pm$/]); // Leave and Arrive stay plain
  // Home to office ends on the Orange Line: the arrival is "~".
  await page.locator('#toggle button').first().click();
  await expect(page.locator('.row .summary .arrive').first()).toHaveText(/^arrive ~\d+:\d+pm$/);
  // One Orange train predicted: predictions first, no headway.
  const one = scenario.trips.find(t => t.id === 'OLout-1729');
  one.live = true;
  mbta.scenario = scenario;
  await page.locator('#toggle button').nth(1).click();
  await page.locator('#refresh').click();
  await tick(page, 1000);
  await expect(page.locator('.row .summary .badge', { hasText: 'live' }).first()).toBeVisible(); // the 5:29 train
  await expect(page.locator('.badge', { hasText: 'every' })).toHaveCount(0);
  await expect(page.locator('.row .arrive', { hasText: '~' })).toHaveCount(0);
});

test('with only the next service day\'s trains left, rows keep SCHEDULED', async ({ page }) => {
  const config = structuredClone(CONFIG);
  config.trips[1].timingLeg = 0;
  const scenario = commute();
  for (const t of scenario.trips) t.live = t.route === '132';
  await openApp(page, { time: '23:58', config, scenario });
  await expect(page.locator('.row .summary .badge').first()).toHaveText('scheduled');
  await expect(page.locator('.badge', { hasText: 'every' })).toHaveCount(0);
});
