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
  // Home + the three dropdown groups' 9 links = 10 nav-links, behind 3 triggers
  await expect(page.locator('#site-nav .nav-link')).toHaveCount(10);
  await expect(page.locator('#site-nav .nav-trigger')).toHaveCount(3);

  const toggle = page.locator('button[aria-controls="site-nav"]');
  await expect(toggle).toHaveAttribute('aria-label', 'Toggle navigation');

  expect(errors).toEqual([]);
});

test('client-side navigation mounts and unmounts views without a reload or a page error', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/');
  // a marker that survives only when navigation stays client-side
  await page.evaluate(() => { window.__jarenE2eMarker = 42; });

  // each destination lives behind its dropdown group (Home stands alone);
  // open the group, click the link, and the group's trigger reflects the route
  const NAV = [
    ['Play', 'Engines'], ['Charts', 'Engines'],
    ['Studio', 'Studios'], ['Flow', 'Studios'], ['Game', 'Studios'], ['Calculator', 'Studios'],
    ['Docs', 'Learn'], ['Benchmarks', 'Learn'], ['Home', null],
  ];
  for (const [label, group] of NAV) {
    const link = page.locator('#site-nav .nav-link', { hasText: label }).first();
    // Reveal the owning group only when the link is not already shown. A
    // blind trigger click would TOGGLE an already-open group shut: the async
    // route/set that closes the menu on the previous navigation may not have
    // landed yet, and consecutive same-group pages (Playground → Play →
    // Charts) leave the trigger looking identical, so the end-of-iteration
    // assertions cannot tell "closed" from "still closing". Opening only when
    // needed mirrors what a real user does and is immune to that timing.
    if (group && !(await link.isVisible())) {
      await page.locator('.nav-trigger', { hasText: group }).click();
      await expect(link).toBeVisible();
    }
    await link.click();
    await expect(page.locator('main.main')).toBeVisible();
    if (group) await expect(page.locator('#site-nav .nav-trigger.active')).toContainText(group);
    else await expect(page.locator('#site-nav .nav-link.active')).toHaveText('Home');
  }

  expect(await page.evaluate(() => window.__jarenE2eMarker)).toBe(42);
  expect(errors).toEqual([]);
});

test('keyboard activation drives the router: focused link + Enter navigates', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/');

  await page.locator('.nav-trigger', { hasText: 'Engines' }).click(); // open the group first
  const playLink = page.locator('#site-nav .nav-link', { hasText: 'Play' }).first();
  await playLink.focus();
  await expect(playLink).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/#\/play$/);
  await expect(page.locator('#site-nav .nav-trigger.active')).toContainText('Engines');
  expect(errors).toEqual([]);
});

test('the nav dropdown groups open, navigate, and close on Escape or an outside click', async ({ page }) => {
  await page.goto('/');
  const studios = page.locator('.nav-trigger', { hasText: 'Studios' });
  const menu = page.locator('.nav-menu', { hasText: 'Calculator' }); // the Studios panel
  await expect(menu).toBeHidden();

  await studios.click();
  await expect(menu).toBeVisible();
  await expect(studios).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await studios.click();
  await expect(menu).toBeVisible();
  await page.locator('h1').first().click(); // an outside click closes it
  await expect(menu).toBeHidden();

  await studios.click();
  await page.locator('#site-nav .nav-link', { hasText: 'Flow' }).click(); // navigating closes it
  await expect(page).toHaveURL(/#\/flow$/);
  await expect(menu).toBeHidden();
});

test('rapid route churn exercises repeated widget/view teardown cleanly', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/');

  // charts and calculator mount real widgets; churn them repeatedly so
  // mount/update/unmount runs under genuine browser scheduling
  for (let round = 0; round < 3; round++) {
    for (const hash of ['#/charts', '#/calculator', '#/play', '#/']) {
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
  await page.locator('.nav-trigger', { hasText: 'Learn' }).click(); // open the group holding Docs
  await page.locator('#site-nav .nav-link', { hasText: 'Docs' }).first().click();
  await expect(page).toHaveURL(/#\/docs$/);

  await page.goBack();
  await expect(page).toHaveURL(/(\/|#\/)$/);
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
