import { test, expect } from '@playwright/test';

test('lexical search keeps complete counts, bounded cells and valid focus across query and sort changes', async ({ page }, testInfo) => {
  await page.goto('/jarenjs/#/collection?mode=lexical');
  const grid = page.getByRole('grid', { name: 'Search results' });
  const status = page.locator('[data-search-status]');
  await expect(grid).toBeVisible(); await expect(status).toContainText('250 matches');
  await expect(grid).toHaveAttribute('aria-rowcount', '250');
  await grid.focus(); await page.keyboard.press('ArrowDown');
  const validFocus = () => page.evaluate(() => {
    const grid = document.querySelector('.jc-viewport'), id = grid.getAttribute('aria-activedescendant');
    return id === null || document.getElementById(id) !== null;
  });
  expect(await validFocus()).toBe(true);
  await page.getByLabel('Organic only').check(); await expect(status).toContainText('84 matches');
  await expect(grid).toHaveAttribute('aria-rowcount', '84');
  await page.getByLabel('Search sort').selectOption('sku');
  await expect(page.locator('.jc-row').first()).toHaveAttribute('data-key', 'item-0000');
  await grid.focus(); await page.keyboard.press('Control+End'); expect(await validFocus()).toBe(true);
  expect(await page.locator('.jc-cell').count()).toBeLessThanOrEqual(120);
  await page.getByLabel('Search catalog').fill('抹茶'); await expect(status).toContainText('83 matches');
  expect(await validFocus()).toBe(true);
  await page.getByLabel('Search catalog').fill('no-match'); await expect(status).toContainText('0 matches');
  await expect(page.locator('.jc-row')).toHaveCount(0);
  await page.getByLabel('Search catalog').fill('gren tea');
  await expect(status).toContainText('84 matches');
  await page.evaluate(() => window.scrollTo(0, 0));
  if (process.env.LEXICAL_SCREENSHOT === '1') await page.screenshot({ path: `/tmp/lexical-${testInfo.project.name}.png`, fullPage: true });
  await page.goto('/jarenjs/#/docs'); await expect(page.locator('.jc-viewport')).toHaveCount(0);
});
