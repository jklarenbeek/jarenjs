//@ts-check
/**
 * @file The Scratch playground (`#/scratch`) in a real browser: the seeded
 * JSONPath example runs LIVE on the stage, editing the selector re-runs,
 * picking an example loads its source + data (the `$mean` one proves the
 * registered stats pack is threaded in), the dataset switcher swaps the
 * data against the SAME source, and a broken selector docks an error
 * instead of crashing. Plus the surface fits the viewport, light and dark.
 */
import { test, expect } from '@playwright/test';

const noOverflow = async (page, label) => {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `${label}: no horizontal overflow`).toBeLessThanOrEqual(innerWidth + 1);
};

test('the seeded example runs live on the stage', async ({ page }) => {
  await page.goto('/#/scratch');
  await expect(page.locator('.jscratch')).toBeVisible();
  await expect(page.locator('.jscratch-rail')).toContainText('All authors');
  await expect(page.locator('.jscratch-engine')).toHaveText('JSONPath');
  const result = page.locator('.jscratch-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Nigel Rees'); // the seeded selector's output
  await expect(page.locator('.jscratch-timing')).toContainText('compiled');
  await noOverflow(page, 'the scratchpad');
});

test('editing the source pane re-runs against the same data', async ({ page }) => {
  await page.goto('/#/scratch');
  await expect(page.locator('.jscratch-result')).toContainText('Nigel Rees');
  // the JSONPath selector is a single-line input; refill it and it re-runs
  await page.locator('.jscratch-editors input.editor').fill('$..price');
  await expect(page.locator('.jscratch-result')).toContainText('8.95');
});

test('picking the $mean example proves the registered operators are threaded in', async ({ page }) => {
  await page.goto('/#/scratch');
  await page.locator('.jscratch-ex', { hasText: 'Aggregate with the registered $mean' }).click();
  await expect(page.locator('.jscratch-engine')).toHaveText('$query');
  // a green result (not an error line) means $mean resolved — the pack is live
  await expect(page.locator('.jscratch-result')).toBeVisible();
  await expect(page.locator('.error-line')).toHaveCount(0);
});

test('the dataset switcher swaps the data against the same source', async ({ page }) => {
  await page.goto('/#/scratch');
  await page.locator('.jscratch-ex', { hasText: 'One selector, three shapes' }).click();
  const result = page.locator('.jscratch-result');
  await expect(result).toContainText('inner'); // the seeded 'flat' shape

  // the switcher renders three segments; pick 'array' → same selector, new shape
  await expect(page.locator('.jscratch-datasets')).toBeVisible();
  await page.locator('.jscratch-datasets .seg-btn', { hasText: 'array' }).click();
  await expect(result).toContainText('Ada');
});

test('a JTLT example renders its text output verbatim', async ({ page }) => {
  await page.goto('/#/scratch');
  await page.locator('.jscratch-ex', { hasText: 'Render a Markdown book list' }).click();
  await expect(page.locator('.jscratch-engine')).toHaveText('JTLT');
  // JTLT emits text (markdown), shown as-is on the stage — not JSON-quoted
  await expect(page.locator('.jscratch-result')).toContainText('# Books');
});

test('a source-only engine (JOSL) toggles its dialect live via the option select', async ({ page }) => {
  await page.goto('/#/scratch');
  await page.locator('.jscratch-ex', { hasText: 'First-class citizens' }).click();
  await expect(page.locator('.jscratch-engine')).toHaveText('JOSL');
  await expect(page.locator('.jscratch-result')).toContainText('kitchen sink'); // parsed in JOSL mode
  // flip the mode select to strict TOML → the JOSL null extension is rejected
  await page.locator('.jscratch-options select').selectOption('toml');
  await expect(page.locator('.error-line')).toBeVisible();
});

test('a visual engine (mermaid) renders an SVG diagram on the stage', async ({ page }) => {
  await page.goto('/#/scratch');
  await page.locator('.jscratch-ex', { hasText: 'Flowchart' }).click();
  await expect(page.locator('.jscratch-engine')).toHaveText('Mermaid');
  await expect(page.locator('.jscratch-view svg')).toBeVisible(); // the host renderer's SVG
});

test('a visual engine (charts) renders an SVG chart on the stage', async ({ page }) => {
  await page.goto('/#/scratch');
  await page.locator('.jscratch-ex', { hasText: 'Heatmap (log)' }).click();
  await expect(page.locator('.jscratch-engine')).toHaveText('Charts');
  await expect(page.locator('.jscratch-view svg')).toBeVisible();
});

test('a visual engine (markdown) renders HTML on the stage', async ({ page }) => {
  await page.goto('/#/scratch');
  await page.locator('.jscratch-ex', { hasText: 'GFM tour' }).click();
  await expect(page.locator('.jscratch-engine')).toHaveText('Markdown');
  await expect(page.locator('.jscratch-view')).toContainText('Markdown, as JSON');
});

test('a broken selector docks an error instead of crashing the page', async ({ page }) => {
  await page.goto('/#/scratch');
  await expect(page.locator('.jscratch-result')).toBeVisible();
  await page.locator('.jscratch-editors input.editor').fill('$.[[[bogus');
  await expect(page.locator('.error-line')).toBeVisible();
  await expect(page.locator('.jscratch')).toBeVisible(); // still on screen
});

test('the scratchpad fits the viewport, light and dark, mobile and desktop', async ({ page }) => {
  await page.goto('/#/scratch');
  await expect(page.locator('.jscratch')).toBeVisible();
  for (const [size, label] of [[{ width: 390, height: 844 }, 'mobile'], [{ width: 1280, height: 900 }, 'desktop']]) {
    await page.setViewportSize(size);
    await noOverflow(page, `${label} · light`);
    await page.locator('.theme-toggle').click();
    await noOverflow(page, `${label} · dark`);
    await page.locator('.theme-toggle').click(); // back to light for the next size
  }
});
