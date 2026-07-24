//@ts-check
/**
 * @file The Studio in a real mobile viewport (375 × 812, touch): the
 * template picker loads a seed document, the nested app boots and
 * renders on-screen, its bindings dispatch into the DOCUMENT's own
 * actions (not the site's), an editor commit re-validates before
 * swapping, and no state of the page widens the layout viewport (the
 * `minmax(0, 1fr)` grid discipline).
 */
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

const noOverflow = async (page, label) => {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `${label}: no horizontal overflow`).toBeLessThanOrEqual(innerWidth + 1);
};

test('a seed template loads, boots and renders on-screen without widening the viewport', async ({ page }) => {
  await page.goto('/#/studio');
  await expect(page.locator('h1')).toHaveText('Studio');
  await expect(page.locator('.example-card')).toHaveCount(3);
  await noOverflow(page, 'the picker');

  // load the dashboard: charts render as inline SVG inside the mount
  await page.locator('.example-card', { hasText: 'Dashboard' }).locator('.btn').tap();
  const mount = page.locator('.studio-mount');
  await expect(mount).toBeVisible();
  await expect(mount.locator('svg').first()).toBeVisible();
  await expect(mount).toContainText('Revenue — Europe');

  // the select drives the DOCUMENT's own action; both panels switch
  await mount.locator('select').selectOption('us');
  await expect(mount).toContainText('Revenue — Americas');
  await expect(mount).toContainText('Channel share — Americas');
  await noOverflow(page, 'the dashboard document');

  const box = await mount.boundingBox();
  expect(box.x, 'the mount starts inside the viewport').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'the mount ends inside the viewport').toBeLessThanOrEqual(376);
});

test('the mini-site routes internally and an editor commit re-validates before swapping', async ({ page }) => {
  await page.goto('/#/studio');
  await page.locator('.example-card', { hasText: 'Mini-site' }).locator('.btn').tap();
  const mount = page.locator('.studio-mount');
  await expect(mount).toContainText('Wavelength Coffee');

  // the document's own nav: two routed markdown pages, mermaid inline
  await mount.locator('.studio-app-link', { hasText: 'About' }).tap();
  await expect(mount).toContainText('How an order flows');
  await expect(mount.locator('svg').first()).toBeVisible();
  await noOverflow(page, 'the mini-site document');

  // an invalid editor commit reports meta-schema errors and keeps the
  // old document live — the swap is atomic (the details editor ships
  // open, so the textarea is already on-screen)
  const editor = page.locator('.studio-editor textarea.editor');
  await editor.fill('{ "$app": "0.2", "view": [] }');
  await editor.blur();
  await expect(page.locator('.studio-errors .error-card').first()).toBeVisible();
  await expect(mount).toContainText('How an order flows');
  await noOverflow(page, 'the error report');

  // leaving the route tears the document down; returning reboots it
  // FRESH from the document's initial state (state lives in the doc)
  await page.evaluate(() => { window.location.hash = '#/'; });
  await expect(page.locator('.studio-mount')).toHaveCount(0);
  await page.evaluate(() => { window.location.hash = '#/studio'; });
  await expect(page.locator('.studio-mount')).toContainText('Wavelength Coffee');
});
