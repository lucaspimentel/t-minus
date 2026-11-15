// The simulator (DESIGN.md "Simulator"): Setup › Developer › Simulator, the SIM bar.
import { test, expect } from '@playwright/test';
import { openApp, tick, riding, planOptions } from './helpers.js';

const bar = page => page.locator('#sim-bar');
const card = page => page.locator('.row.ride');
const head = page => page.locator('.ride-head');
const toast = page => page.locator('#toast');
const enRoute = page => page.locator('#enroute');
const simClock = page => bar(page).locator('.sim-clock');

// Starts a test preset from setup; the page reloads into the simulator.
async function startPreset(page, name = 'On time') {
  await page.locator('#open-setup').click();
  const setup = page.locator('#setup');
  await setup.getByRole('button', { name: 'Simulator', exact: true }).click();
  await setup.getByRole('button', { name: 'Test preset' }).click();
  await setup.getByLabel('Preset').selectOption({ label: name });
  await Promise.all([page.waitForEvent('load'), setup.getByRole('button', { name: 'Start simulator' }).click()]);
  await expect(bar(page)).toBeVisible();
  await page.locator('.row').first().waitFor();
}
async function openBar(page) {
  const b = bar(page).getByRole('button', { name: 'Simulator controls' });
  if (await b.getAttribute('aria-expanded') !== 'true') await b.click();
}
async function jump(page, label) {
  await openBar(page);
  await bar(page).getByRole('button', { name: new RegExp(`^Jump to ${label},`) }).click();
  await tick(page, 1000);
}
async function atTheStop(page) {
  await enRoute(page).getByRole('button', { name: 'At the stop' }).click();
  await tick(page, 1000);
}
// Records the toasts' texts as they come (each shows for 5 s): window.toasts.
const recordToasts = page => page.evaluate(() => {
  window.toasts = [];
  new MutationObserver(() => { const t = document.querySelector('#toast span').textContent; if (t) window.toasts.push(t); })
    .observe(document.querySelector('#toast span'), { childList: true, characterData: true, subtree: true });
});
const toasts = page => page.evaluate(() => window.toasts);
// A rewind reloads the page.
async function reloading(page, action) {
  await Promise.all([page.waitForEvent('load'), action()]);
  await page.locator('.row').first().waitFor();
  await tick(page, 500);
}

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

test('a preset starts the simulator: its own trip and clock, the fake data, the real state untouched', async ({ page }) => {
  const mbta = await openApp(page);
  const realConfig = await page.evaluate(() => localStorage.getItem('t-minus:config'));
  await startPreset(page);
  await expect(simClock(page)).toHaveText(/^Mon 7:00:\d\dam · playing · 1×$/);
  const since = mbta.hits.length;
  await tick(page, 61_000); // a poll
  // The time-dependent requests are answered in the page; only static lists may reach the MBTA.
  expect(mbta.hits.slice(since).map(h => h.path).filter(p => ['/schedules', '/predictions', '/vehicles', '/alerts'].includes(p))).toEqual([]);
  await expect(page.locator('.row.catch .big')).toHaveText(/^Leave in <1 min\s*7:02am$/); // the 7:08am bus
  expect(await page.evaluate(() => localStorage.getItem('t-minus:config'))).toBe(realConfig);
  expect(await page.evaluate(() => !!localStorage.getItem('t-minus-sim:config'))).toBe(true);
});

test('jumps follow the ride: the departure boards it, the transfer, the arrival', async ({ page }) => {
  await openApp(page);
  await startPreset(page);
  await atTheStop(page);
  await jump(page, 'Bus 132');
  await expect(head(page)).toHaveText(riding('Bus 132'));
  // The jumps now follow the ride (no leave-by while riding).
  await expect(bar(page).getByRole('button', { name: /^Jump to Leave-by/ })).toHaveCount(0);
  await jump(page, 'Transfer');
  await expect(card(page).locator('.big')).toHaveText(/^Orange in (\d+|<1) min/);
  await jump(page, 'Arrive');
  await expect(head(page)).toHaveText(/^Arrived/);
});

test('+2 min late on the bus makes the connection tight; a rewind restores the list', async ({ page }) => {
  await openApp(page);
  await startPreset(page);
  await atTheStop(page);
  await jump(page, 'Bus 132');
  await expect(head(page)).toHaveText(riding('Bus 132'));
  const outlook = card(page).locator('.ride-outlook');
  await expect(outlook).toContainText('5 min to spare');
  for (let i = 0; i < 2; i++) {
    await bar(page).getByRole('button', { name: /^Bus 132 .*: \+2 min late$/ }).click();
    await tick(page, 11_000);
  }
  await expect(outlook).toHaveText('Then Orange Line toward Forest Hills at 7:32am · tight'); // 1 min to spare
  // Back before the departure: the snapshot before the jump, the list again.
  await reloading(page, () => bar(page).getByRole('button', { name: /back 5 minutes$/ }).click());
  await expect(bar(page)).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(enRoute(page)).toContainText('At the stop since 7:00am');
  await expect(simClock(page)).toHaveText(/^Mon 7:0\d:\d\dam/);
});

test('the server\'s pushes show as SIM toasts and in the bar\'s list', async ({ page }) => {
  await openApp(page);
  await startPreset(page);
  await recordToasts(page);
  await page.locator('.row.catch .row-toggle').click();
  await page.locator('.row.catch').getByRole('button', { name: /Track/ }).click();
  await tick(page, 1000);
  // The 7:08am bus: leave by 7:02am. "Leave now" comes from the in-page server's poll.
  await bar(page).getByRole('button', { name: /forward 1 minute$/ }).click();
  for (let i = 0; i < 8 && !(await page.evaluate(() => window.toasts.some(t => t.startsWith('SIM push · ')))); i++) await tick(page, 15_000);
  expect(await page.evaluate(() => window.toasts.find(t => t.startsWith('SIM push · ')))).toMatch(/^SIM push · Leave/);
  await openBar(page);
  await bar(page).getByRole('button', { name: /^Pushes \([1-9]/ }).click();
  await expect(bar(page).locator('.sim-pushes li').first()).toContainText('Leave');
});

test('fake location: Home, then Stop marks the arrival at the stop (GPS)', async ({ page }) => {
  await openApp(page);
  await startPreset(page);
  await enRoute(page).getByRole('button', { name: 'Leaving now' }).click();
  await tick(page, 1000);
  await openBar(page);
  await bar(page).getByRole('button', { name: 'Home', exact: true }).click();
  await tick(page, 12_000);
  await bar(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await tick(page, 30_000);
  await expect(toast(page)).toContainText('At the stop (location)');
  await expect(enRoute(page)).toContainText('At the stop since');
});

test('✕ ends it: the real list, Undo brings the simulator back paused', async ({ page }) => {
  await openApp(page);
  await startPreset(page);
  await bar(page).getByRole('button', { name: /forward 5 minutes$/ }).click();
  await tick(page, 500);
  await reloading(page, () => bar(page).getByRole('button', { name: 'End simulator' }).click());
  await expect(bar(page)).toBeHidden();
  await expect(toast(page)).toContainText('Simulator ended');
  await reloading(page, () => toast(page).getByRole('button', { name: 'Undo' }).click());
  await expect(bar(page)).toBeVisible();
  await expect(simClock(page)).toHaveText(/^Mon 7:05:\d\dam · paused/);
  // Ended again and the Undo let go: its data is gone.
  await reloading(page, () => bar(page).getByRole('button', { name: 'End simulator' }).click());
  await page.waitForTimeout(6500);
  await tick(page, 7000);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('t-minus-sim')))).toEqual([]);
});

test('a saved trip\'s ride replayed from that day\'s schedules', async ({ page }) => {
  await openApp(page);
  await page.locator('#open-setup').click();
  const setup = page.locator('#setup');
  await setup.getByRole('button', { name: 'Simulator', exact: true }).click();
  await expect(setup.getByRole('button', { name: 'Saved trip' })).toHaveAttribute('aria-pressed', 'true');
  await expect(setup.getByLabel('Date')).toHaveValue('2026-10-05');
  const ride = setup.getByLabel('Ride (that day’s schedules)');
  await expect(ride.locator('option').first()).toHaveText(/^5:44am Bus 132 → \d+:\d\dam Orange · arrive \d+:\d\dam$/);
  await ride.selectOption({ label: (await ride.locator('option', { hasText: '7:36am Bus 132' }).textContent()).trim() });
  await setup.getByRole('button', { name: 'At leave-by' }).click();
  await Promise.all([page.waitForEvent('load'), setup.getByRole('button', { name: 'Start simulator' }).click()]);
  await page.locator('.row').first().waitFor();
  await expect(simClock(page)).toHaveText(/^Mon 7:30:\d\dam · playing/); // the 7:36am bus: leave by 7:30am
  await expect(page.locator('.row.catch .big')).toHaveText(/^Departs in 5 min\s*7:36am$/); // past the leave-by: amber
  await expect(page.locator('.row.catch')).toContainText(/live/i); // within 60 min of its departure
  await atTheStop(page);
  await jump(page, 'Bus 132');
  await expect(head(page)).toHaveText(riding('Bus 132'));
});

test('on the vehicle: matched from the fake location; got off before the drop-off ends the ride', async ({ page }) => {
  await openApp(page);
  await startPreset(page);
  await atTheStop(page);
  await openBar(page);
  await bar(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await jump(page, 'Bus 132');
  await expect(head(page)).toHaveText(riding('Bus 132'));
  await bar(page).getByRole('button', { name: 'On vehicle', exact: true }).click();
  for (let i = 0; i < 12; i++) await tick(page, 10_000); // two minutes on board
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus-sim:boarding-session'))?.matched ?? {});
  expect(Object.keys(log).length).toBeGreaterThan(0);
  await bar(page).getByRole('button', { name: /forward 5 minutes$/ }).click(); // 7:15: between stops
  await tick(page, 10_000);
  await recordToasts(page);
  await bar(page).getByRole('button', { name: 'Got off', exact: true }).click();
  for (let i = 0; i < 9; i++) await tick(page, 10_000);
  expect((await toasts(page)).join('\n')).toContain('Got off · ride ended');
  await expect(card(page)).toHaveCount(0);
});

test('the planner in the simulator: the in-page server times the options', async ({ page }) => {
  await openApp(page);
  let real = 0;
  await page.route(/\/api\/plan\?/, route => { real++; return route.abort(); });
  await startPreset(page);
  await page.locator('#open-setup').click();
  const setup = page.locator('#setup');
  await expect(setup.locator('.sim-card')).toContainText('Running'); // the card, open while it runs
  await setup.getByRole('button', { name: '+ Plan a trip', exact: true }).click();
  for (const [field, query, name] of [['from', 'Oak Grove', 'Oak Grove'], ['to', 'State', 'State']]) {
    await setup.locator(`#plan-${field}`).click();
    await setup.locator('#picker-search').fill(query);
    await setup.locator('.list .item.station', { hasText: name }).first().click();
  }
  await expect(planOptions(page).first()).toBeVisible({ timeout: 20_000 });
  await expect(planOptions(page).first()).toContainText('Orange');
  expect(real).toBe(0);
});
