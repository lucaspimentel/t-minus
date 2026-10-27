// Accessibility: axe scans of each screen (both themes), the rows' expand buttons, keyboard
// focus kept across the once-a-second redraw, and the screen-reader announcements (#announce).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, tick, tickTo, at, planOptions, expandOption, pickOption } from './helpers.js';

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
    await tickTo(page, '07:12'); // the 7:08am bus has left: previous rides
    await page.getByRole('button', { name: 'Show previous rides ▾' }).click();
    expect(await violations(page)).toEqual([]);
    await page.locator('.row.prev .row-toggle').first().click(); // expanded: timeline, I got on
    expect(await violations(page)).toEqual([]);
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
    // Notifications not yet allowed: the card offers "Turn on stop alerts".
    await page.addInitScript(() => Object.defineProperty(window.Notification, 'permission', { configurable: true, get: () => 'default' }));
    await openApp(page, { time: '07:00' });
    await page.locator('#enroute').getByRole('button', { name: 'At the stop' }).click();
    await tickTo(page, '07:08:30');
    await expect(page.locator('.ride-head')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Turn on stop alerts' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.evaluate(() => localStorage.setItem('t-minus:config', JSON.stringify({ trips: [] })));
    await page.reload();
    await expect(page.locator('.empty .big-btn')).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
}

for (const scheme of ['light', 'dark']) {
  test(`axe finds nothing with the bell on and on the boarding question (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, { time: '06:55' });
    await page.locator('.row-toggle').first().click();
    await page.getByRole('button', { name: 'Track', exact: true }).click();
    await tick(page, 1000);
    await expect(page.locator('.track-btn.on')).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await tickTo(page, '07:08:30');
    await expect(page.locator('#enroute')).toContainText('Did you get on');
    expect(await violations(page)).toEqual([]);
  });
}

test('a row is a button: its name says when to leave, and Enter expands it', async ({ page }) => {
  await openApp(page, { time: '06:55' });
  const btn = page.getByRole('button', { name: 'Leave in 6 min, 7:02am, Bus 132 → Malden, Orange, scheduled, arrive ~7:57am' });
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
  await page.getByRole('button', { name: 'Track', exact: true }).focus();
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
  await expect(announced).toHaveText('Hurry · 5 min · 7:08am');
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
    await setup.getByRole('button', { name: 'Show nearby stops and stations' }).click();
    await expect(setup.getByText('Near you · within 800 m')).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await setup.locator('.list .item', { hasText: 'Bus 132' }).click();
    await expect(setup.locator('.list .item .dist').first()).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
}

for (const scheme of ['light', 'dark']) {
  test(`axe finds nothing on the auto-route planner, its picker (Places, Current location) and a one-off trip (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, { time: '07:00' });
    await page.route(/\/api\/plan\?/, route => route.fulfill({ json: { from: 'Main St @ South St', to: 'State', options: [{
      legs: [{ route: '132', also: [], direction_id: 1, stop: '25996', alight: '5991' }, { route: 'Orange', also: [], direction_id: 0, stop: 'place-ogmnl', alight: 'place-state' }],
      transfers: [{ name: 'Washington St @ Oak Grove Sta → Oak Grove', meters: 32, min: 3 }], minutes: 32,
      // Timed from now (the one-off planner's rows).
      leave: at('07:04'), arrive: at('07:55'), deps: [{ dep: at('07:10'), live: false }, { dep: at('07:33'), live: true }] }], timed: true } }));
    await page.route(/\/api\/places\?/, route => route.fulfill({ json: { places: [{ name: 'Fenway Park', detail: '4 Jersey Street, Boston', lat: 42.34646, lon: -71.0971 }] } }));
    await page.getByRole('button', { name: 'Go somewhere else…' }).click();
    expect(await violations(page)).toEqual([]);
    await page.locator('#plan-from').click();
    await expect(page.locator('#plan-here')).toBeVisible(); // Current location
    expect(await violations(page)).toEqual([]);
    await page.locator('#picker-search').fill('fenway');
    await tick(page, 400);
    await expect(page.locator('#setup .list .item.place')).toHaveCount(1); // Places
    expect(await violations(page)).toEqual([]);
    await page.locator('#picker-search').fill('132');
    expect(await violations(page)).toEqual([]);
    await page.locator('#setup .list .item', { hasText: 'Bus 132' }).first().click();
    await expect(page.locator('#setup .list .item', { hasText: 'both sides' }).first()).toBeVisible(); // paired rows
    expect(await violations(page)).toEqual([]);
    await page.locator('#setup .list .item', { hasText: 'Main St @ South St' }).first().click();
    await page.locator('#plan-to').click();
    await page.locator('#picker-search').fill('state');
    await page.locator('#setup .list .item.station', { hasText: 'State' }).click();
    await expect(planOptions(page)).toHaveCount(1);
    expect(await violations(page)).toEqual([]);
    await expect((await expandOption(page)).locator('.step.ride')).toHaveCount(2); // the option's timeline
    expect(await violations(page)).toEqual([]);
    await pickOption(page);
    await expect(page.locator('#oneoff')).toBeVisible();
    await tick(page, 1000);
    expect(await violations(page)).toEqual([]);
  });
}
