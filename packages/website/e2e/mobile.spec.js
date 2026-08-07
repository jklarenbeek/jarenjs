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

const PAGES = ['#/', '#/docs', '#/play', '#/playground', '#/studio', '#/benchmarks', '#/calculator', '#/charts'];

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

// ——— the keyboard-viewport contract (the §MOBILE oracle, 390×844) ———
// A phone user must never lose the focused field: the play surface shows
// ONE pane at a time behind a segmented switcher, a focused editor sits
// fully inside the visual viewport (not behind the sticky header), and
// the visualViewport seam reserves the keyboard inset as bottom padding.
// Playwright cannot raise a real on-screen keyboard, so the inset test
// drives the seam directly: shadow visualViewport.height, dispatch its
// resize, and assert the layout responds.
test.describe('the keyboard-viewport contract', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  const paneVisibility = (page) => page.evaluate(() => {
    const visible = (sel) => {
      const el = document.querySelector(sel);
      return el !== null && getComputedStyle(el).display !== 'none';
    };
    return { rail: visible('.jplay-rail'), editors: visible('.jplay-editors'), stage: visible('.jplay-stage') };
  });

  test('play shows exactly one pane behind the segmented switcher', async ({ page }) => {
    await page.goto('/#/play');
    const bar = page.locator('.jplay-mobilebar');
    await expect(bar).toBeVisible();
    // finger-sized segments
    for (const label of ['Examples', 'Editor', 'Result']) {
      const seg = bar.locator('.seg-btn', { hasText: label });
      const box = await seg.boundingBox();
      expect(box.height, `${label} segment ≥ 44px`).toBeGreaterThanOrEqual(44);
    }
    // the default pane is the editor — and ONLY the editor
    expect(await paneVisibility(page)).toEqual({ rail: false, editors: true, stage: false });
    await bar.locator('.seg-btn', { hasText: 'Examples' }).tap();
    expect(await paneVisibility(page)).toEqual({ rail: true, editors: false, stage: false });
    // an example row is a finger-sized target too
    const row = await page.locator('.jplay-ex').first().boundingBox();
    expect(row.height).toBeGreaterThanOrEqual(44);
    await bar.locator('.seg-btn', { hasText: 'Result' }).tap();
    expect(await paneVisibility(page)).toEqual({ rail: false, editors: false, stage: true });
    await expect(page.locator('.jplay-result')).toBeVisible();
    // no horizontal overflow, light and dark
    for (const theme of ['light', 'dark']) {
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
      }));
      expect(scrollWidth, `one-pane play (${theme}) must not overflow`).toBeLessThanOrEqual(innerWidth + 1);
      await page.locator('.theme-toggle').tap();
    }
  });

  test('every play editor, focused, sits inside the visual viewport (not behind header or keyboard line)', async ({ page }) => {
    await page.goto('/#/play');
    await expect(page.locator('.jplay-editors')).toBeVisible();
    const editors = page.locator('.jplay-editors .editor');
    const count = await editors.count();
    expect(count).toBeGreaterThanOrEqual(2); // the selector input + the data textarea
    for (let i = 0; i < count; i++) {
      const editor = editors.nth(i);
      await editor.focus();
      // the focusin seam centered it; the whole box must be visible
      const { box, vv, headerPosition } = await page.evaluate(() => {
        const el = document.activeElement;
        const rect = el.getBoundingClientRect();
        return {
          box: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
          vv: { height: window.visualViewport.height, width: window.visualViewport.width },
          headerPosition: getComputedStyle(document.querySelector('.header')).position,
        };
      });
      expect(box.top, `editor ${i} clears the top`).toBeGreaterThanOrEqual(0);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.bottom, `editor ${i} sits above the keyboard line`).toBeLessThanOrEqual(vv.height + 1);
      expect(box.right).toBeLessThanOrEqual(vv.width + 1);
      // while editing, the sticky header un-sticks so it can never cover the field
      expect(headerPosition).toBe('static');
    }
  });

  test('the visualViewport seam publishes --kb-inset and the editor pane reserves it', async ({ page }) => {
    await page.goto('/#/play');
    await page.locator('.jplay-editors .editor').first().focus();
    // simulate the keyboard: shadow visualViewport.height and fire its resize
    const padded = await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { value: 500, configurable: true });
      window.visualViewport.dispatchEvent(new Event('resize'));
      return {
        inset: document.documentElement.style.getPropertyValue('--kb-inset'),
        padding: getComputedStyle(document.querySelector('.jplay-editors')).paddingBottom,
      };
    });
    expect(padded.inset).toBe('344px'); // 844 layout − 500 visual
    expect(padded.padding, 'the editor pane reserves the inset').toBe('344px');
    // the keyboard closes: the inset collapses back to zero
    const released = await page.evaluate(() => {
      delete window.visualViewport.height; // drop the shadow, restore the real getter
      window.visualViewport.dispatchEvent(new Event('resize'));
      return {
        inset: document.documentElement.style.getPropertyValue('--kb-inset'),
        padding: getComputedStyle(document.querySelector('.jplay-editors')).paddingBottom,
      };
    });
    expect(released.inset).toBe('0px');
    expect(released.padding).toBe('0px');
  });

  test('a studio editor, focused, stays inside the visual viewport (the seam is shared)', async ({ page }) => {
    await page.goto('/#/studio');
    await page.locator('.example-card', { hasText: 'Dashboard' }).locator('.btn').tap();
    const editor = page.locator('.studio-editor .editor');
    await expect(editor).toBeVisible();
    await editor.focus();
    const { box, vv } = await page.evaluate(() => {
      const rect = document.activeElement.getBoundingClientRect();
      return {
        box: { top: rect.top, bottom: rect.bottom },
        vv: { height: window.visualViewport.height },
      };
    });
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(vv.height + 1);
  });
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
