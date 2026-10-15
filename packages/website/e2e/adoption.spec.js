import { expect } from '@playwright/test';
import { test, reachesNetwork } from './outage.js';

test('offline catalog preserves original data, reviews pages and recovers remote success after reload', async ({ page, context, site }, testInfo) => {
  test.setTimeout(120000);
  // Offline is the site's server really gone, on every engine, plus the browser's offline
  // emulation where that emulation still lets the service worker answer: Playwright's
  // WebKit fails a request before the worker sees it (offline-navigation.spec.js).
  const goOffline = async () => {
    await site.down();
    if (testInfo.project.name !== 'webkit') await context.setOffline(true);
    expect(await reachesNetwork(page)).toBe(false);
  };
  await page.goto(`${site.origin}/jarenjs/#/collection?mode=adoption`);
  await expect(page.locator('[data-journey-qualification]')).toContainText('native OS input methods remain pending');
  const status = page.locator('[data-journey-status]');
  await expect(status).toContainText('64 matches', { timeout: 30000 });
  const draft = page.getByRole('textbox', { name: 'Rule document' });
  const rule = JSON.parse(await draft.inputValue());
  rule.revision = '2'; rule.targets[0].formula.revision = '2';
  rule.targets[0].formula.expression = { $add: [rule.targets[0].formula.expression, 1] };
  await draft.fill(JSON.stringify(rule, null, 2));
  await page.getByRole('button', { name: 'Save formula', exact: true }).click();
  await expect(status).toContainText('1 writes');
  await page.getByRole('button', { name: 'Save formula', exact: true }).click();
  await expect(status).toContainText('0 writes');
  await page.getByRole('button', { name: 'Preview rules', exact: true }).click();
  await expect(page.locator('[data-rule-status]')).toContainText('128 proposed');
  // The application owns manual-fact protection; choose two automatic rows on different pages.
  const pages = page.getByRole('navigation', { name: 'Preview pages' });
  const selectAutomatic = async () => {
    const choice = page.locator('[data-rule-change]').nth(1);
    const id = await choice.getAttribute('data-rule-change');
    // Settle the input's geometry before pointer activation beside the sticky header.
    await choice.evaluate((node) => node.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await choice.check();
    await expect(choice).toBeChecked();
    return id;
  };
  await expect(pages).toContainText('Page 1 of 13');
  const firstChoice = await selectAutomatic();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(pages).toContainText('Page 2 of 13');
  expect(await selectAutomatic()).not.toBe(firstChoice);
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(pages).toContainText('Page 1 of 13');
  await expect(page.locator('[data-rule-change]').nth(1)).toHaveAttribute('data-rule-change', firstChoice);
  await expect(page.locator('[data-rule-change]').nth(1)).toBeChecked();
  await page.getByRole('button', { name: 'Commit selected (2)' }).click();
  await expect(page.locator('[data-rule-status]')).toContainText('Selected changes committed.');
  await page.getByRole('button', { name: 'Commit selected (2)' }).click();
  await expect(page.locator('[data-rule-status]')).toContainText('Selected changes committed.');
  await page.getByRole('button', { name: 'Ingest snapshot' }).click(); await expect(status).toContainText('256 changes');
  await page.getByRole('button', { name: 'Ingest snapshot' }).click(); await expect(status).toContainText('0 changes');
  await page.getByRole('grid', { name: 'Journey catalog' }).evaluate((node) => { node.scrollTop = 700; node.dispatchEvent(new Event('scroll')); });
  expect(await page.locator('[data-journey-collection] .jc-cell').count()).toBeLessThanOrEqual(504);
  await page.getByRole('button', { name: 'Reopen database' }).click(); await expect(status).toContainText('later writes preserved');
  // The site's existing service worker supplies the built app and SQLite wasm offline.
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.reload(); await expect(status).toContainText('64 matches', { timeout: 30000 });
  await goOffline();
  await page.getByRole('button', { name: 'Reopen database' }).click(); await expect(status).toContainText('later writes preserved');
  await page.getByRole('button', { name: 'Ingest snapshot' }).click(); await expect(status).toContainText('0 changes');
  await page.getByRole('button', { name: 'Send and simulate interruption' }).click();
  await expect(status).toContainText('Interrupted send retained', { timeout: 30000 });
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('adoption-remote')).length)).toBe(2);
  await page.getByRole('button', { name: 'Reconcile and recover' }).click();
  await expect(status).toContainText('No remote resend');
  await page.reload(); await expect(status).toContainText('Recovered run complete', { timeout: 30000 });
  expect(JSON.parse(await draft.inputValue()).revision).toBe('2');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('adoption-remote')).length)).toBe(2);
  await page.getByRole('button', { name: 'Ingest snapshot' }).click(); await expect(status).toContainText('0 changes');
  await page.screenshot({ path: testInfo.outputPath('adoption.png'), fullPage: true });
  await page.goto(`${site.origin}/jarenjs/#/docs`); await expect(page.locator('[data-journey-editor]')).toHaveCount(0);
});
