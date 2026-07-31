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
  await expect(page.locator('#site-nav .nav-link')).toHaveCount(9);

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

test.describe('the README dialog over stubbed documents', () => {
  // The site's service worker would fetch the README itself, invisibly
  // to page.route (WebKit routes never see SW-originated requests) —
  // block it so the stubbed documents are what the dialog receives.
  test.use({ serviceWorkers: 'block' });

  test('README-relative links navigate the dialog in place, with a working trail', async ({ page }) => {
    const errors = trackPageErrors(page);
    // deterministic offline READMEs: the dialog fetches raw.githubusercontent
    const RAW = 'https://raw.githubusercontent.com/jklarenbeek/jarenjs/refs/heads/main';
    const DOCS = {
      // the .md link sits in the FIRST item of a FIRST-block list on
      // purpose: fragment-shaped vnodes once skipped exactly that spot
      [`${RAW}/packages/core/README.md`]:
        '- Read [DATES](./docs/DATES.md)\n\nOr [the benchmarks](https://jklarenbeek.github.io/jarenjs/#/benchmarks?suite=geo).\n',
      [`${RAW}/packages/core/docs/DATES.md`]: '# the dates kernel\n\nplain text body\n',
    };
    await page.route('https://raw.githubusercontent.com/**', (route) => {
      const body = DOCS[route.request().url()];
      if (body === undefined) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: 'text/plain', body });
    });

    await page.goto('/#/docs');
    await page.locator('.readme-btn', { hasText: '@jarenjs/core' }).click();
    const dialog = page.locator('.md-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('article.md')).toContainText('Read DATES');

    // the rewritten link stays inside the dialog instead of leaving the site
    const before = page.url();
    await dialog.locator('article.md a', { hasText: 'DATES' }).click();
    await expect(dialog.locator('.md-dialog-title')).toHaveText('packages/core/docs/DATES.md');
    await expect(dialog.locator('article.md')).toContainText('the dates kernel');
    expect(page.url(), 'the page itself did not navigate').toBe(before);

    // the trail replays both ways
    await dialog.locator('button[aria-label="Back"]').click();
    await expect(dialog.locator('.md-dialog-title')).toHaveText('@jarenjs/core');
    await dialog.locator('button[aria-label="Forward"]').click();
    await expect(dialog.locator('.md-dialog-title')).toHaveText('packages/core/docs/DATES.md');
    await expect(dialog.locator('button[aria-label="Forward"]')).toBeDisabled();

    // a link to the site itself closes the dialog and routes in-app
    await dialog.locator('button[aria-label="Back"]').click();
    await dialog.locator('article.md a', { hasText: 'the benchmarks' }).click();
    await expect(dialog).toHaveCount(0);
    expect(page.url()).toContain('#/benchmarks?suite=geo');
    await expect(page.locator('main.main')).toBeVisible();

    expect(errors).toEqual([]);
  });
});
