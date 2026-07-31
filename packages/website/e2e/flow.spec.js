//@ts-check
/**
 * @file The Flow studio, driven the way a person uses it: build a
 * machine by clicking, name its event in the generated inspector, run
 * it as a real nested app and watch the highlight move; then run the
 * dataflow seed and watch the nodes settle. Every gesture lands as an
 * RFC 6902 patch on one document — these tests prove the panes cannot
 * disagree by editing in one and asserting in another.
 */
import { test, expect } from '@playwright/test';

test('build a machine by clicking, name the event, run it live', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.evaluate(() => { window.location.hash = '#/flow'; });

  // start from the blank seed
  await page.locator('article', { hasText: 'Blank machine' }).locator('button').click();
  await page.waitForSelector('.flow-canvas svg.mm-state');

  // add a second state and connect start → s2 (click-click, no drag)
  await page.getByRole('button', { name: 'Add state' }).click();
  await expect(page.locator('[data-id="s2"]')).toHaveCount(1);
  await page.locator('[data-id="start"]').click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('[data-id="s2"]').click();

  // the new transition is selected; name its event in the generated form
  await expect(page.locator('.flow-inspector')).toContainText('transition #0');
  const eventField = page.locator('.flow-inspector input').nth(1);
  await eventField.fill('go');
  await eventField.blur();

  // the text pane is the SAME document (pane-coherence, no edit here)
  await page.getByRole('button', { name: 'Text' }).click();
  await expect(page.locator('.flow-text')).toHaveValue(/start --> s2 : go/);
  await page.getByRole('button', { name: 'Diagram' }).click();

  // run it: the nested app boots, the highlight follows the event
  await page.getByRole('button', { name: 'Run machine' }).click();
  await expect(page.locator('.flow-run-mount')).toContainText('current: start');
  await expect(page.locator('[data-id="start"]')).toHaveClass(/mm-active/);
  await page.locator('.flow-run-buttons button', { hasText: 'go' }).click();
  await expect(page.locator('[data-id="s2"]')).toHaveClass(/mm-active/);
  await expect(page.locator('.flow-log-line').first()).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('.flow-run-mount')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('the dataflow seed runs: nodes settle, the output appears, abort works', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.evaluate(() => { window.location.hash = '#/flow'; });

  await page.locator('article', { hasText: 'Enrich & report' }).locator('button').click();
  await page.waitForSelector('.flow-canvas svg:not(.mm-state)');

  await page.getByRole('button', { name: 'Run graph' }).click();
  await expect(page.locator('[data-id="stamp"]')).toHaveClass(/mm-run-ok/, { timeout: 5000 });
  await expect(page.locator('.flow-output')).toContainText('ada');

  // a fresh run aborted mid-flight fails closed with the abort code
  await page.getByRole('button', { name: 'Run graph' }).click();
  await page.getByRole('button', { name: 'Abort' }).click();
  await expect(page.locator('.flow-run .error-line')).toContainText('JF2007');

  expect(errors).toEqual([]);
});

test('the ported Libero Coke machine loads as a graph and drives live', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.evaluate(() => { window.location.hash = '#/flow'; });

  await page.locator('article', { hasText: 'Coke machine' }).locator('button').click();
  await page.waitForSelector('.flow-canvas svg.mm-state');
  await expect(page.locator('[data-id="should-be-gently-humming"]')).toHaveCount(1);
  await expect(page.locator('[data-id="cooperate"]')).toHaveCount(1);

  // run it and walk Ok → Clink → Ok → Coke back to something-happened
  await page.getByRole('button', { name: 'Run machine' }).click();
  await expect(page.locator('[data-id="should-be-gently-humming"]')).toHaveClass(/mm-active/);
  for (const ev of ['Ok', 'Clink', 'Ok', 'Coke']) {
    await page.locator('.flow-run-buttons button', { hasText: new RegExp(`^${ev}$`) }).first().click();
  }
  await expect(page.locator('[data-id="something-happened"]')).toHaveClass(/mm-active/);
  // a Libero action reached the run log
  await expect(page.locator('.flow-log')).toContainText('accept-punters-cash');
  await expect(page.locator('.flow-log')).toContainText('eject-appropriate-can');

  expect(errors).toEqual([]);
});
