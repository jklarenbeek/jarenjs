//@ts-check
/**
 * @file Diagrams hydrate into interactive figures, without stealing the page.
 *
 * The render is complete on its own, so the thing worth proving in a real
 * browser is the hydration layer: that it attaches, that the keyboard path
 * works for people who do not pinch, and — most importantly — that a figure
 * at rest still lets the page scroll. The last one is what separates a
 * zoomable diagram from a scroll trap on a phone.
 */
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

/** Render a mermaid fence through the markdown playground. */
async function renderDiagram(page) {
  await page.goto('/');
  await page.evaluate(() => { window.location.hash = '#/playground?engine=markdown'; });
  await page.locator('textarea').first().fill(
    '# t\n\n```mermaid\nflowchart LR\n  A["a"] --> B["b"]\n```\n');
  await page.waitForSelector('.md-mermaid svg');
  await expect(page.locator('.md-mermaid.mm-interactive')).toHaveCount(1);
}

test('a rendered diagram gains controls, focus and a keyboard', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await renderDiagram(page);

  const before = await page.evaluate(() => {
    const el = document.querySelector('.md-mermaid');
    return {
      controls: el.querySelectorAll('.mm-control').length,
      tabindex: el.getAttribute('tabindex'),
      label: el.getAttribute('aria-label'),
      viewBox: el.querySelector('svg').getAttribute('viewBox'),
    };
  });
  expect(before.controls).toBe(3);
  expect(before.tabindex).toBe('0');
  expect(before.label).toMatch(/zoom/i);

  await page.locator('.md-mermaid').first().focus();
  await page.keyboard.press('+');
  const zoomed = await page.evaluate(() => {
    const el = document.querySelector('.md-mermaid');
    return { viewBox: el.querySelector('svg').getAttribute('viewBox'),
      zoom: Number(el.getAttribute('data-mm-zoom')) };
  });
  expect(zoomed.viewBox).not.toBe(before.viewBox);
  expect(zoomed.zoom).toBeGreaterThan(1);

  await page.keyboard.press('0');
  const reset = await page.evaluate(() =>
    document.querySelector('.md-mermaid svg').getAttribute('viewBox'));
  expect(reset).toBe(before.viewBox);
  expect(errors).toEqual([]);
});

test('a figure at rest lets the page scroll, and only claims the gesture once zoomed', async ({ page }) => {
  // The failure this guards against is a diagram that swallows every swipe on
  // a phone, leaving the reader unable to scroll past it.
  await renderDiagram(page);
  const atRest = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.md-mermaid')).touchAction);
  expect(atRest).toBe('pan-y');

  await page.locator('.md-mermaid').first().focus();
  await page.keyboard.press('+');
  const whenZoomed = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.md-mermaid')).touchAction);
  expect(whenZoomed).toBe('none');
});

test('the page still does not overflow horizontally with a diagram on it', async ({ page }) => {
  await renderDiagram(page);
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
});

test('a wide diagram scrolls at full size instead of shrinking its text', async ({ page }) => {
  // The same failure the tables had: the figure has `overflow-x: auto`, but if
  // the SVG is capped at `max-width: 100%` it scales to fit and the scroll
  // never engages — so the label font shrinks with everything else. On a
  // phone that took a 14px label to roughly 11px.
  await page.goto('/');
  await page.evaluate(() => { window.location.hash = '#/playground?engine=markdown'; });
  await page.locator('textarea').first().fill(
    '```mermaid\nflowchart LR\n  A["aaaaaaaaaaaaaaaa"] --> B["bbbbbbbbbbbbbbbb"] --> C["cccccccccccccccc"]\n```\n');
  await page.waitForSelector('.md-mermaid svg');

  const m = await page.evaluate(() => {
    const el = document.querySelector('.md-mermaid');
    const svg = el.querySelector('svg');
    const text = svg.querySelector('text');
    return {
      natural: parseFloat(svg.getAttribute('width')),
      rendered: svg.getBoundingClientRect().width,
      container: el.clientWidth,
      textHeight: text.getBoundingClientRect().height,
      scrolls: el.scrollWidth > el.clientWidth + 1,
    };
  });

  expect(m.natural, 'the fixture must be wider than a phone for this to test anything')
    .toBeGreaterThan(m.container);
  expect(m.rendered, 'the diagram must render at its natural size, not scaled down')
    .toBeGreaterThanOrEqual(m.natural - 1);
  expect(m.scrolls, 'the figure must scroll instead').toBe(true);
  expect(m.textHeight, 'the label must stay at a legible size').toBeGreaterThanOrEqual(14);
});

test('a wide diagram still does not widen the page', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { window.location.hash = '#/playground?engine=markdown'; });
  await page.locator('textarea').first().fill(
    '```mermaid\nflowchart LR\n  A["aaaaaaaaaaaaaaaa"] --> B["bbbbbbbbbbbbbbbb"] --> C["cccccccccccccccc"]\n```\n');
  await page.waitForSelector('.md-mermaid svg');
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
});
