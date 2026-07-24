//@ts-check
/**
 * @file Real-browser lifecycle evidence: the built website (the
 * repository's production `createApp` consumer) boots, navigates,
 * mounts and unmounts views, and answers the keyboard in real
 * Chromium, Firefox and WebKit — with zero page errors under real
 * engine scheduling. Every test also asserts the error channel: an
 * uncaught exception or unhandled rejection in the page fails the
 * test, so "it rendered" can never hide a broken lifecycle.
 */
import { test, expect } from '@playwright/test';

/** Collect page errors for the whole test; assert empty at the end. */
function trackPageErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

test('the app boots with landmark semantics intact', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/');

  await expect(page.locator('nav#site-nav')).toBeVisible();
  await expect(page.locator('main.main')).toBeVisible();
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.locator('#site-nav .nav-link')).toHaveCount(8);

  const toggle = page.locator('button[aria-controls="site-nav"]');
  await expect(toggle).toHaveAttribute('aria-label', 'Toggle navigation');

  expect(errors).toEqual([]);
});

test('client-side navigation mounts and unmounts views without a reload or a page error', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/');
  // a marker that survives only when navigation stays client-side
  await page.evaluate(() => { window.__jarenE2eMarker = 42; });

  for (const label of ['Playground', 'Studio', 'Benchmarks', 'Charts', 'Docs', 'Examples', 'Calculator', 'Home']) {
    await page.locator('#site-nav .nav-link', { hasText: label }).first().click();
    await expect(page.locator('main.main')).toBeVisible();
    await expect(page.locator('#site-nav .nav-link.active')).toHaveText(label);
  }

  expect(await page.evaluate(() => window.__jarenE2eMarker)).toBe(42);
  expect(errors).toEqual([]);
});

test('keyboard activation drives the router: focused link + Enter navigates', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/');

  const playground = page.locator('#site-nav .nav-link', { hasText: 'Playground' }).first();
  await playground.focus();
  await expect(playground).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/#\/playground$/);
  await expect(page.locator('#site-nav .nav-link.active')).toHaveText('Playground');
  expect(errors).toEqual([]);
});

test('rapid route churn exercises repeated widget/view teardown cleanly', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/');

  // charts and calculator mount real widgets; churn them repeatedly so
  // mount/update/unmount runs under genuine browser scheduling
  for (let round = 0; round < 3; round++) {
    for (const hash of ['#/charts', '#/calculator', '#/playground', '#/']) {
      await page.evaluate((h) => { window.location.hash = h; }, hash);
      await expect(page.locator('main.main')).toBeVisible();
    }
  }
  await expect(page.locator('#site-nav .nav-link.active')).toHaveText('Home');
  expect(errors).toEqual([]);
});

test('the browser back button restores the previous view', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/');
  await page.locator('#site-nav .nav-link', { hasText: 'Docs' }).first().click();
  await expect(page.locator('#site-nav .nav-link.active')).toHaveText('Docs');

  await page.goBack();
  await expect(page.locator('#site-nav .nav-link.active')).toHaveText('Home');
  expect(errors).toEqual([]);
});
