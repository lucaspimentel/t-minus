// Commuter rail: setup picks a Haverhill Line leg from North Station; rows leave out a train that
// doesn't pick up there; the expanded row shows the train, its track, its own alert and a flag
// stop; the line-wide alerts leave the per-train one out.
import { test, expect } from '@playwright/test';
import { openApp, CR_CONFIG, crCommute } from './helpers.js';

test.beforeEach(({ page }) => { page.on('pageerror', e => { throw e; }); });

const setup = page => page.locator('#setup');
const button = (page, name) => setup(page).getByRole('button', { name, exact: true });

test('setup: from North Station, the Haverhill Line is its own group; the leg saves as "CR Haverhill"', async ({ page }) => {
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await page.locator('#open-setup').click();
  await button(page, '+ Plan a trip').click();
  await button(page, 'Build it by hand').click();
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('North Sta');
  await setup(page).locator('.item.station', { hasText: 'North Station' }).first().click();
  await expect(setup(page).locator('.section-head', { hasText: 'CR Haverhill' })).toHaveText(['CR Haverhill toward Haverhill']);
  await setup(page).locator('#picker-search').fill('Malden');
  // Malden Center is also on the Orange Line (listed first): the one in the Haverhill group.
  await setup(page).locator('.section-head:has-text("CR Haverhill") ~ .item', { hasText: 'Malden Center' }).first().click();
  await expect(setup(page)).toContainText('CR Haverhill toward Haverhill · North Station → Malden Center');
});

test('rows: no train that skips the pickup; the expanded row shows the train, track, alert and flag stop', async ({ page }) => {
  await openApp(page, { time: '17:20', config: CR_CONFIG, scenario: crCommute() });
  // 2317 (5:48pm), 2321 (6:48pm), 2323 (7:30pm); not 2319 (6:15pm: no pickup at North Station).
  const firstDeps = await page.locator('.row .strip').allInnerTexts();
  expect(firstDeps.slice(0, 3).every(t => t.includes('CR Haverhill'))).toBe(true);
  await expect(page.locator('.row .big .at').first()).toHaveText('5:37pm');
  await expect(page.locator('.row .big .at').nth(1)).toHaveText('6:37pm');
  // The line-wide list leaves the per-train alert out.
  await expect(page.locator('#alerts')).not.toContainText('Train 2317');

  await page.locator('.row .row-toggle').first().click();
  const first = page.locator('.row').first().locator('.timeline');
  await expect(first.locator('.train')).toHaveText('Train 2317 · Track 5');
  await expect(first.locator('.leg-alert')).toHaveText('Train 2317 is 5-10 minutes behind schedule');
  await expect(first.locator('.flag')).toHaveCount(0);

  await page.locator('.row .row-toggle').nth(1).click();
  const second = page.locator('.row').nth(1).locator('.timeline');
  await expect(second.locator('.train')).toHaveText('Train 2321'); // no track yet (scheduled)
  await expect(second.locator('.leg-alert')).toHaveCount(0);
  await expect(second.locator('.step.stop').last()).toContainText('Malden Center · Flag stop');
});

test('a station line tag longer than the screen wraps instead of widening the page', async ({ page }) => {
  // South Station's CR tag ("CR Fairmount/Fall River/…") made the page wider than the screen;
  // iOS then inflated every font in the picker (2026-11-02). The fixtures have no tag that long.
  await openApp(page, { time: '07:00', config: null, waitForRows: false });
  await page.locator('#open-setup').click();
  await button(page, '+ Plan a trip').click();
  await button(page, 'Build it by hand').click();
  await button(page, '+ Add transit leg').click();
  await setup(page).locator('#picker-search').fill('North Sta');
  const tag = setup(page).locator('.item.station .conn').filter({ hasText: 'CR Haverhill' }).first();
  await tag.evaluate(el => { el.lastChild.textContent = 'CR Fairmount/Fall River/New Bedford/Framingham/Worcester/Franklin/Needham/Providence/Stoughton'; });
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(width);
});
