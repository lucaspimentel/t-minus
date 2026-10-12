// "Go somewhere else…" with live times: the server's timed options (/api/plan?…&now=1, stubbed),
// their rows, the 60 s refresh that keeps the order, and the fallbacks. Setup's planner stays
// untimed.
import { test, expect } from '@playwright/test';
import { openApp, tick, at } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const setup = page => page.locator('#setup');
const options = page => setup(page).locator('#plan-options .item');
const lines = (page, i) => options(page).nth(i).locator(':scope > *');

const leg = (route, stop, alight, stopName, alightName, direction_id = 0) => ({ route, also: [], direction_id, stop, alight, stopName, alightName });
const VIA_OAK = [leg('Orange', 'place-ogmnl', 'place-state', 'Oak Grove', 'State')];
const VIA_MALDEN = [leg('Orange', 'place-mlmnl', 'place-state', 'Malden Center', 'State')];
const option = (legs, leave, arrive, deps) => ({
  legs, transfers: [], minutes: 20, walkBefore: 0, walkAfter: 0,
  ...(leave && { leave: at(leave), arrive: at(arrive), deps: deps.map(([d, live]) => ({ dep: at(d), live })) }),
});
// Four timed candidates (the app shows 3); a refresh changes times and drops one.
const FIRST = { from: 'Oak Grove', to: 'State', timed: true, options: [
  option(VIA_OAK, '07:04', '07:35', [['07:10', true]]),
  option(VIA_MALDEN, '07:06', '07:37', [['07:12', false]]),
  option([leg('Orange', 'place-wlsta', 'place-state', 'Wellington', 'State')], '07:08', '07:40', [['07:14', false]]),
  option([leg('Orange', 'place-astao', 'place-state', 'Assembly', 'State')], '07:09', '07:45', [['07:15', false]]),
] };
const LATER = { ...FIRST, options: [FIRST.options[1], option(VIA_OAK, '07:08', '07:39', [['07:14', true]])] };

async function stubPlan(page, answers) {
  const calls = [];
  await page.route(/\/api\/plan\?/, route => {
    calls.push(new URL(route.request().url()).search);
    return route.fulfill({ json: answers[Math.min(calls.length, answers.length) - 1] });
  });
  return calls;
}

async function pickStation(page, field, query, name) {
  await setup(page).locator(`#plan-${field}`).click();
  await setup(page).locator('#picker-search').fill(query);
  await setup(page).locator('.list .item.station', { hasText: name }).first().click();
}

test('Go somewhere else…: timed options, best 3, refreshed every minute in the same order', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const calls = await stubPlan(page, [FIRST, LATER]);
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  expect(calls).toEqual(['?from=place-ogmnl&to=place-state&now=1&wb=5&wa=5&slack=1']);
  await expect(options(page)).toHaveCount(3);
  await expect(lines(page, 0)).toHaveText(['Arrive 7:35am · ~31 min', 'Leave 7:04am (in 4 min)', 'Walk 5 min to Oak Grove', 'Orange 7:10am to State', 'Walk 5 min to State']);
  await expect(lines(page, 1).nth(0)).toHaveText('Arrive 7:37am · ~31 min');
  // A minute later: new times, the same order; Wellington (gone from the answer) drops.
  await tick(page, 60_000);
  expect(calls.length).toBe(2);
  await expect(options(page)).toHaveCount(2);
  await expect(lines(page, 0).nth(0)).toHaveText('Arrive 7:39am · ~31 min');
  await expect(lines(page, 0).nth(1)).toHaveText('Leave 7:08am (in 7 min)');
  await expect(lines(page, 1).nth(0)).toHaveText('Arrive 7:37am · ~31 min');
});

test('nothing within 2 hours, or times failing: the untimed options under a note', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const untimed = { from: 'Oak Grove', to: 'State', options: [option(VIA_OAK)] };
  await stubPlan(page, [{ ...untimed, none: true }]);
  await page.getByRole('button', { name: 'Go somewhere else…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await expect(setup(page)).toContainText('Nothing runs in the next 2 hours.');
  await expect(lines(page, 0).first()).toHaveText('~30 min');
  await page.unroute(/\/api\/plan\?/);
  await stubPlan(page, [{ ...untimed, timedError: true }]);
  await pickStation(page, 'to', 'kendall', 'Kendall/MIT');
  await expect(setup(page)).toContainText('Times unavailable.');
});

test('setup\'s auto-route stays untimed', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const calls = await stubPlan(page, [{ from: 'Oak Grove', to: 'State', options: [option(VIA_OAK)] }]);
  await page.locator('#open-setup').click();
  await setup(page).getByRole('button', { name: '+ Add trip (auto-route)', exact: true }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await expect(options(page)).toHaveCount(1);
  expect(calls).toEqual(['?from=place-ogmnl&to=place-state']);
  await tick(page, 60_000);
  expect(calls.length).toBe(1);
});
