//@ts-check
/**
 * @file Wide tables must SCROLL on a phone, not cram.
 *
 * The page-overflow assertions in mobile.spec.js cannot catch this class of
 * bug: a table crammed into the viewport does not widen the page, so those
 * tests stay green while the table is unreadable. The evidence that
 * distinguishes "scrolls" from "crams" is internal — the scroll container's
 * scrollWidth must exceed its clientWidth — plus a per-column floor, because
 * a table can technically overflow by a few pixels and still be a column of
 * single characters.
 */
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

/** Columns narrower than this on a phone are the cramming failure mode. */
const MIN_COLUMN_PX = 44;

test('wide benchmark tables scroll horizontally instead of cramming', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { window.location.hash = '#/benchmarks'; });
  await expect(page.locator('.table-scroll table').first()).toBeVisible();
  // The JSON Schema suite is the widest (a six-column per-test table).
  await page.waitForFunction(
    () => document.querySelectorAll('.table-scroll').length > 0,
    null, { timeout: 15_000 });

  const report = await page.evaluate((minCol) => {
    const wide = [];
    for (const wrap of document.querySelectorAll('.table-scroll')) {
      const table = wrap.querySelector('table');
      if (table === null) continue;
      const columns = table.querySelectorAll('thead th').length;
      if (columns < 4) continue;   // narrow tables legitimately fit
      const cells = [...table.querySelectorAll('thead th')]
        .map((th) => Math.round(th.getBoundingClientRect().width));
      wide.push({
        columns,
        scrolls: wrap.scrollWidth > wrap.clientWidth + 1,
        narrowest: Math.min(...cells),
        ok: wrap.scrollWidth > wrap.clientWidth + 1 && Math.min(...cells) >= minCol,
      });
    }
    return wide;
  }, MIN_COLUMN_PX);

  expect(report.length, 'expected at least one four-column table to inspect')
    .toBeGreaterThan(0);
  for (const t of report) {
    expect(t.scrolls, `a ${t.columns}-column table must overflow its scroll container`)
      .toBe(true);
    expect(t.narrowest, `a ${t.columns}-column table's narrowest header was ${t.narrowest}px`)
      .toBeGreaterThanOrEqual(MIN_COLUMN_PX);
  }
});

test('a scrolling table still does not widen the page', async ({ page }) => {
  // The fix must not trade cramming for a horizontally scrolling document.
  await page.goto('/');
  await page.evaluate(() => { window.location.hash = '#/benchmarks'; });
  await expect(page.locator('.table-scroll table').first()).toBeVisible();
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
});
