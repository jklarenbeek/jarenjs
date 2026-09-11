import { test, expect } from '@playwright/test';

test('reviewed rules preserve draft/caret and selection across pages, then commit once', async ({ page }, testInfo) => {
  await page.goto('/jarenjs/#/collection?mode=rules');
  const draft = page.getByRole('textbox', { name: 'Rule document' });
  await expect(draft).toBeVisible();
  await draft.focus(); await draft.evaluate((node) => node.setSelectionRange(5, 9));
  await page.getByRole('button', { name: 'Preview rules' }).click();
  await expect(page.locator('[data-rule-status]')).toContainText('64 proposed changes');
  expect(await draft.evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([5, 9]);
  if (process.env.FORMULA_SCREENSHOT === '1') await page.screenshot({ path: `/tmp/formulas-desktop-${testInfo.project.name}.png`, fullPage: true });
  await page.locator('[data-rule-change]').first().check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.locator('[data-rule-change]').first().check();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.locator('[data-rule-change]').first()).toBeChecked();
  await expect(page.getByRole('button', { name: 'Commit selected (2)' })).toBeEnabled();
  await page.getByRole('button', { name: 'Commit selected (2)' }).click();
  await expect(page.locator('[data-rule-status]')).toContainText('Selected changes committed.');
  await page.getByRole('button', { name: 'Commit selected (2)' }).click();
  await expect(page.locator('[data-rule-status]')).toContainText('Selected changes committed.');
  await expect(page.getByRole('grid', { name: 'Current inventory' })).toContainText('Revision: 1');
  await page.getByRole('button', { name: 'Preview rules' }).click();
  await expect(page.locator('[data-rule-status]')).toContainText('62 proposed changes');
  expect(await page.locator('[data-rule-change]').count()).toBeLessThanOrEqual(10);
  await page.goto('/jarenjs/#/docs'); await expect(page.locator('[data-rule-draft]')).toHaveCount(0);
});

test('rule editor remains usable on mobile and changed drafts cannot commit an old plan', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/jarenjs/#/collection?mode=rules');
  const draft = page.getByRole('textbox', { name: 'Rule document' }); await expect(draft).toBeVisible();
  await page.getByRole('button', { name: 'Preview rules' }).click();
  await expect(page.locator('[data-rule-change]').first()).toBeVisible(); await page.locator('[data-rule-change]').first().check();
  await draft.fill('{ invalid');
  await expect(page.getByRole('button', { name: 'Commit selected (0)' })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview rules' }).click(); await expect(page.locator('[data-rule-status]')).toContainText('Preview failed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  if (process.env.FORMULA_SCREENSHOT === '1') await page.screenshot({ path: `/tmp/formulas-${testInfo.project.name}.png`, fullPage: true });
});
