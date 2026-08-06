//@ts-check
/**
 * @file Mobile layout evidence (375 × 812 CSS-pixel viewport, touch):
 * no page may widen the layout viewport (the Docs grid-track collapse
 * class of bug), and the package-README dialog must open as an
 * on-screen sheet with the page scroll locked behind it. These
 * assertions fail on the pre-0.17.9 build exactly as the mobile audit
 * described, and pin the fixes.
 */
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

const PAGES = ['#/', '#/docs', '#/scratch', '#/playground', '#/studio', '#/benchmarks', '#/calculator', '#/charts'];

test('no page overflows the mobile layout viewport', async ({ page }) => {
  await page.goto('/');
  for (const hash of PAGES) {
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    await expect(page.locator('main.main')).toBeVisible();
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth, `${hash} must not overflow horizontally`)
      .toBeLessThanOrEqual(innerWidth + 1);
  }
});

test('the README dialog opens on-screen as a full sheet and locks the page scroll', async ({ page }) => {
  await page.goto('/#/docs');
  await expect(page.locator('main.main')).toBeVisible();

  await page.locator('.readme-btn').first().tap();
  const dialog = page.locator('.md-dialog');
  await expect(dialog).toBeVisible();

  const { box, innerWidth, bodyOverflow } = await page.evaluate(() => {
    const rect = document.querySelector('.md-dialog').getBoundingClientRect();
    return {
      box: { x: rect.x, right: rect.right, width: rect.width },
      innerWidth: window.innerWidth,
      bodyOverflow: getComputedStyle(document.body).overflow,
    };
  });
  expect(box.x, 'the dialog starts inside the visible viewport').toBeGreaterThanOrEqual(0);
  expect(box.right, 'the dialog ends inside the visible viewport').toBeLessThanOrEqual(innerWidth + 1);
  expect(box.width, 'the sheet fills the visible width').toBeGreaterThanOrEqual(innerWidth - 1);
  expect(bodyOverflow, 'the page scroll is locked behind the dialog').toBe('hidden');

  await page.locator('.md-dialog-close').tap();
  await expect(dialog).toHaveCount(0);
  const unlocked = await page.evaluate(() => getComputedStyle(document.body).overflow);
  expect(unlocked, 'closing the dialog releases the scroll lock').not.toBe('hidden');
});

test('mobile touch targets meet the 44px class', async ({ page }) => {
  await page.goto('/');
  const toggle = page.locator('.menu-toggle');
  await expect(toggle).toBeVisible();
  const size = await toggle.boundingBox();
  expect(size.width).toBeGreaterThanOrEqual(43);
  expect(size.height).toBeGreaterThanOrEqual(43);

  await toggle.tap();
  await expect(page.locator('#site-nav')).toBeVisible();
  // Docs lives in the Learn dropdown — tap the trigger to expand it, then the link
  await page.locator('#site-nav .nav-trigger', { hasText: 'Learn' }).tap();
  await page.locator('#site-nav .nav-link', { hasText: 'Docs' }).first().tap();
  await expect(page).toHaveURL(/#\/docs$/);

  const link = page.locator('.docs-sections .docs-link').first();
  await expect(link).toBeVisible();
  const linkBox = await link.boundingBox();
  expect(linkBox.height).toBeGreaterThanOrEqual(43);
});
