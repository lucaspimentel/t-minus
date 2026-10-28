// "Plan a trip" with live times: the server's timed options (/api/plan?…&now=1, stubbed), their
// cards (no refresh; "See departures" and "Save trip"), and the untimed fallbacks ("Save trip"
// only). Setup's "+ Plan a trip" opens the same planner.
import { test, expect } from '@playwright/test';
import { openApp, tick, at, planOptions, optionLines, expandOption, pickOption } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', e => { throw e; });
});

const setup = page => page.locator('#setup');
const options = planOptions;
const lines = optionLines;

const leg = (route, stop, alight, stopName, alightName, direction_id = 0) => ({ route, also: [], direction_id, stop, alight, stopName, alightName });
const VIA_OAK = [{ ...leg('Orange', 'place-ogmnl', 'place-state', 'Oak Grove', 'State'), stops: 8 }];
const VIA_MALDEN = [leg('Orange', 'place-mlmnl', 'place-state', 'Malden Center', 'State')];
const option = (legs, leave, arrive, deps) => ({
  legs, transfers: [], minutes: 20, walkBefore: 0, walkAfter: 0,
  ...(leave && { leave: at(leave), arrive: at(arrive), deps: deps.map(([d, live]) => ({ dep: at(d), arr: at(arrive) - 5 * 60_000, source: live ? 'live' : 'scheduled', ...(live && { headsign: 'Forest Hills' }) })) }),
});
// Four timed candidates (the app shows 3).
const FIRST = { from: 'Oak Grove', to: 'State', timed: true, options: [
  option(VIA_OAK, '07:04', '07:35', [['07:10', true]]),
  option(VIA_MALDEN, '07:06', '07:37', [['07:12', false]]),
  option([leg('Orange', 'place-wlsta', 'place-state', 'Wellington', 'State')], '07:08', '07:40', [['07:14', false]]),
  option([leg('Orange', 'place-astao', 'place-state', 'Assembly', 'State')], '07:09', '07:45', [['07:15', false]]),
] };

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

test('Plan a trip…: timed options, best 3, not refreshed', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const calls = await stubPlan(page, [FIRST]);
  await page.getByRole('button', { name: 'Plan a trip…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  expect(calls).toEqual(['?from=place-ogmnl&to=place-state&now=1&wb=5&wa=5&slack=1']);
  await expect(options(page)).toHaveCount(3);
  // Collapsed: arrival, leave-by, the routes and the first ride's badge.
  await expect(lines(page, 0)).toHaveText(['Arrive 7:35am · ~31 min', 'Leave 7:04am (in 4 min)', /^Orange$/]);
  await expect(options(page).nth(0).locator('.summary .badge')).toHaveText(/live/i);
  await expect(lines(page, 1).nth(0)).toHaveText('Arrive 7:37am · ~31 min');
  await expect(options(page).nth(1).locator('.summary .badge')).toHaveText(/scheduled/i);
  // Expanded: the timeline like a main-list row's.
  const tl = await expandOption(page, 0);
  await expect(tl.locator('.step.end')).toHaveText([/^Leave\s*7:04am$/, /^Arrive\s*7:35am$/]);
  await expect(tl.locator('.step.stop .n')).toHaveText(['Oak Grove', 'State']);
  await expect(tl.locator('.step.stop .t')).toHaveText(['7:10am', '7:30am']);
  await expect(tl.locator('.step.ride')).toHaveText(/^Orange Line · 8 stops · 20 min\s*live\s*toward Forest Hills$/i);
  await expect(tl.locator('.step.walk')).toHaveText(['Walk 5 min · 1 min early at the stop', 'Walk 5 min']);
  await expect(options(page).nth(0).locator('.row-foot button')).toHaveText(['See departures', 'Save trip']);
  // No refresh: minutes later, the same answer (one request).
  await options(page).nth(0).locator('.row-toggle').click();
  await tick(page, 120_000);
  expect(calls.length).toBe(1);
  await expect(options(page)).toHaveCount(3);
  await expect(lines(page, 0).nth(0)).toHaveText('Arrive 7:35am · ~31 min');
  // "See departures": the one-off trip on the main list.
  await pickOption(page, 1, 'See departures');
  await expect(page.locator('#oneoff')).toBeVisible();
});

test('a closed search never redraws over a later one', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const calls = await stubPlan(page, [FIRST]);
  await page.getByRole('button', { name: 'Plan a trip…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await expect(options(page)).toHaveCount(3);
  await setup(page).getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Plan a trip…' }).click();
  await expect(setup(page).locator('#plan-from')).toHaveText('Choose a stop or station');
  await tick(page, 60_000);
  expect(calls.length).toBe(1);
  await expect(setup(page).locator('#plan-from')).toHaveText('Choose a stop or station');
  await expect(options(page)).toHaveCount(0);
});

test('nothing within 2 hours, or times failing: the untimed options under a note', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const untimed = { from: 'Oak Grove', to: 'State', options: [option(VIA_OAK)] };
  await stubPlan(page, [{ ...untimed, none: true }]);
  await page.getByRole('button', { name: 'Plan a trip…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await expect(setup(page)).toContainText('Nothing runs in the next 2 hours.');
  await expect(lines(page, 0).first()).toHaveText('~30 min');
  // Untimed: saved only.
  await expect(setup(page)).toContainText('Pick one to save it');
  await expandOption(page, 0);
  await expect(options(page).nth(0).locator('.row-foot button')).toHaveText(['Save trip']);
  await page.unroute(/\/api\/plan\?/);
  await stubPlan(page, [{ ...untimed, timedError: true }]);
  await pickStation(page, 'to', 'kendall', 'Kendall/MIT');
  await expect(setup(page)).toContainText('Times unavailable.');
});

test('setup\'s "+ Plan a trip" asks for live times too; See departures there closes setup on the one-off', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  const calls = await stubPlan(page, [FIRST]);
  await page.locator('#open-setup').click();
  await setup(page).getByRole('button', { name: '+ Plan a trip', exact: true }).click();
  await expect(setup(page).locator('.setup-head b')).toHaveText('Plan a trip');
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await expect(options(page)).toHaveCount(3);
  expect(calls).toEqual(['?from=place-ogmnl&to=place-state&now=1&wb=5&wa=5&slack=1']);
  await pickOption(page, 0, 'See departures');
  await expect(setup(page)).toBeHidden();
  await expect(page.locator('#oneoff')).toBeVisible();
});

test('Save trip from the main screen: Save shows the new trip there; Cancel goes back to it', async ({ page }) => {
  await openApp(page, { time: '07:00' });
  await stubPlan(page, [FIRST]);
  // Cancel in the editor: back to the main screen, nothing saved.
  await page.getByRole('button', { name: 'Plan a trip…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await pickOption(page, 0, 'Save trip');
  await expect(setup(page).getByLabel('Trip name')).toHaveValue('Oak Grove → State');
  await setup(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(setup(page)).toBeHidden();
  await expect(page.locator('#toggle button')).toHaveText(['Home to office', 'Office to home']);
  // Save: setup closes on the new trip.
  await page.getByRole('button', { name: 'Plan a trip…' }).click();
  await pickStation(page, 'from', 'oak gr', 'Oak Grove');
  await pickStation(page, 'to', 'state', 'State');
  await pickOption(page, 0, 'Save trip');
  await setup(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(setup(page)).toBeHidden();
  await expect(page.locator('#toggle select option:checked')).toHaveText('Oak Grove → State');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('t-minus:config')).trips.map(t => t.name)))
    .toEqual(['Home to office', 'Office to home', 'Oak Grove → State']);
});
