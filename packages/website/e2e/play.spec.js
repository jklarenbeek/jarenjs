//@ts-check
/**
 * @file The Play playground (`#/play`) in a real browser: the seeded
 * JSONPath example runs LIVE on the stage, editing the selector re-runs,
 * picking an example loads its source + data (the `$mean` one proves the
 * registered stats pack is threaded in), the dataset switcher swaps the
 * data against the SAME source, the Explain depth toggle reveals the deep
 * drill-down (beside the answer on desktop, a full-pane swap with ← back
 * on a phone), and a broken selector docks an error instead of crashing.
 * Plus the surface fits the viewport, light and dark.
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
  await page.goto('/#/play');
  await expect(page.locator('.jplay')).toBeVisible();
  await expect(page.locator('.jplay-rail')).toContainText('All authors');
  await expect(page.locator('.jplay-engine')).toHaveText('JSONPath');
  const result = page.locator('.jplay-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Nigel Rees'); // the seeded selector's output
  await expect(page.locator('.jplay-timing')).toContainText('compiled');
  await noOverflow(page, 'the playground');
});

test('the IDE bar saves a session that survives a reload, then loads it back', async ({ page }) => {
  await page.goto('/#/play');
  await expect(page.locator('.jplay-bar')).toBeVisible();
  await page.locator('.jplay-name').fill('e2e-run');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // the Load dropdown now offers it
  await expect(page.locator('.jplay-load')).toContainText('e2e-run');
  // a real reload: the saved session persists in localStorage and re-lists
  await page.reload();
  await expect(page.locator('.jplay-load')).toContainText('e2e-run');
  await page.locator('.jplay-load').selectOption('e2e-run');
  await expect(page.locator('.jplay-name')).toHaveValue('e2e-run');
});

test('Share reports a status; the editor|result splitter is a keyboard separator', async ({ page }) => {
  await page.goto('/#/play');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('.jplay-shared')).toBeVisible(); // "link copied" / "link ready"
  // the splitter is present as an ARIA separator and keyboard-resizes
  const split = page.locator('.jplay-split');
  await expect(split).toHaveAttribute('role', 'separator');
  const before = await split.getAttribute('aria-valuenow');
  await split.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(split).not.toHaveAttribute('aria-valuenow', before ?? '');
});

test('editing the source pane re-runs against the same data', async ({ page }) => {
  await page.goto('/#/play');
  await expect(page.locator('.jplay-result')).toContainText('Nigel Rees');
  // the JSONPath selector is a single-line input; refill it and it re-runs
  await page.locator('.jplay-editors input.editor').fill('$..price');
  await expect(page.locator('.jplay-result')).toContainText('8.95');
});

test('picking the $mean example proves the registered operators are threaded in', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'Aggregate with the registered $mean' }).click();
  await expect(page.locator('.jplay-engine')).toHaveText('$query');
  // a green result (not an error line) means $mean resolved — the pack is live
  await expect(page.locator('.jplay-result')).toBeVisible();
  await expect(page.locator('.error-line')).toHaveCount(0);
});

test('the dataset switcher swaps the data against the same source', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'One selector, three shapes' }).click();
  const result = page.locator('.jplay-result');
  await expect(result).toContainText('inner'); // the seeded 'flat' shape

  // the switcher renders three segments; pick 'array' → same selector, new shape
  await expect(page.locator('.jplay-datasets')).toBeVisible();
  await page.locator('.jplay-datasets .seg-btn', { hasText: 'array' }).click();
  await expect(result).toContainText('Ada');
});

test('a JTLT example renders its text output verbatim', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'Render a Markdown book list' }).click();
  await expect(page.locator('.jplay-engine')).toHaveText('JTLT');
  // JTLT emits text (markdown), shown as-is on the stage — not JSON-quoted
  await expect(page.locator('.jplay-result')).toContainText('# Books');
});

test('a source-only engine (JOSL) toggles its dialect live via the option select', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'First-class citizens' }).click();
  await expect(page.locator('.jplay-engine')).toHaveText('JOSL');
  await expect(page.locator('.jplay-result')).toContainText('kitchen sink'); // parsed in JOSL mode
  // flip the mode select to strict TOML → the JOSL null extension is rejected
  await page.locator('.jplay-options select').selectOption('toml');
  await expect(page.locator('.error-line')).toBeVisible();
});

test('a CSV example opens CALM; the Explain toggle reveals the deep screens beside the answer (desktop)', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'RFC 4180' }).click();
  await expect(page.locator('.jplay-engine')).toHaveText('CSV');
  // calm by default: the summary note, no tab strip, no table — just the
  // quiet Explain affordance beneath the answer
  await expect(page.locator('.jplay-note')).toBeVisible();
  await expect(page.locator('.jplay-tabs')).toHaveCount(0);
  await expect(page.locator('.jplay-table')).toHaveCount(0);
  const toggle = page.locator('.jplay-deep-toggle');
  await expect(toggle).toBeVisible();
  // the drill-down: its own tab row opens UNDER the still-visible answer
  await toggle.click();
  await expect(page.locator('.jplay-deep-tabs')).toBeVisible();
  await expect(page.locator('.jplay-table')).toBeVisible(); // the parsed rows
  await expect(page.locator('.jplay-note')).toBeVisible();  // the answer stays (desktop)
  // the round-trip deep tab → a code block (the re-emitted CSV)
  await page.locator('.jplay-deep-tabs .seg-btn', { hasText: 'CSV round-trip' }).click();
  await expect(page.locator('.jplay-result .code-block')).toBeVisible();
  await noOverflow(page, 'the CSV drill-down');
  // toggling again folds the machinery away
  await toggle.click();
  await expect(page.locator('.jplay-deep-tabs')).toHaveCount(0);
});

test('a JSONPath drill-down teaches with stat cards and the normalized paths', async ({ page }) => {
  await page.goto('/#/play');
  await expect(page.locator('.jplay-result')).toContainText('Nigel Rees');
  await page.locator('.jplay-deep-toggle').click();
  // the "How it matched" stat cards are the first deep panel
  await expect(page.locator('.jplay-cards')).toBeVisible();
  await expect(page.locator('.jplay-card').first()).toContainText('Matches');
  // the normalized paths are the second (the deep pane's own code block —
  // the simple answer keeps its code block beside it on desktop)
  await page.locator('.jplay-deep-tabs .seg-btn', { hasText: 'normalized paths' }).click();
  await expect(page.locator('.jplay-deep .code-block')).toContainText("$['store']");
});

test('a mermaid drill-down shows the geometry-free AST from the host seam', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'Flowchart' }).click();
  await expect(page.locator('.jplay-view svg')).toBeVisible();
  await page.locator('.jplay-deep-toggle').click();
  await expect(page.locator('.jplay-deep-tabs')).toBeVisible();
  await expect(page.locator('.jplay-result .code-block')).toContainText('"nodes"'); // the AST
  // the canonical round-trip re-emits mermaid text
  await page.locator('.jplay-deep-tabs .seg-btn', { hasText: 'Canonical Mermaid' }).click();
  await expect(page.locator('.jplay-result .code-block')).toContainText('flowchart');
});

test('on a phone the drill-down swaps the pane and backs out', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/play');
  // the phone flow: Examples pane → pick → play lands on the Result pane
  await page.locator('.jplay-mobilebar .seg-btn', { hasText: 'Examples' }).click();
  await page.locator('.jplay-ex', { hasText: 'RFC 4180' }).click();
  await expect(page.locator('.jplay-note')).toBeVisible();
  const toggle = page.locator('.jplay-deep-toggle');
  // ≥44px touch target for the affordance
  const box = await toggle.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  // the swap: the simple answer is hidden, the deep pane + ← back show
  await expect(page.locator('.jplay-simple')).toBeHidden();
  await expect(page.locator('.jplay-table')).toBeVisible();
  const back = page.locator('.jplay-deep-back');
  await expect(back).toBeVisible();
  const backBox = await back.boundingBox();
  expect(backBox.height).toBeGreaterThanOrEqual(44);
  await noOverflow(page, 'the mobile drill-down');
  // ← back returns to the calm answer
  await back.click();
  await expect(page.locator('.jplay-simple')).toBeVisible();
  await expect(page.locator('.jplay-note')).toBeVisible();
  await expect(page.locator('.jplay-table')).toHaveCount(0);
  // dark mode holds the swap layout together too
  await toggle.click();
  await page.locator('.theme-toggle').click();
  await expect(page.locator('.jplay-table')).toBeVisible();
  await noOverflow(page, 'the mobile drill-down · dark');
});

test('the JSON Schema engine validates on the stage (verdict note + deep errors table)', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'Invalid data' }).click();
  await expect(page.locator('.jplay-engine')).toHaveText('JSON Schema');
  await expect(page.locator('.jplay-note')).toContainText('error'); // the verdict
  // the localized errors are a deep table behind the Explain toggle
  await page.locator('.jplay-deep-toggle').click();
  await expect(page.locator('.jplay-table')).toBeVisible();
  // the Messages (locale) option is offered
  await expect(page.locator('.jplay-options select')).toBeVisible();
});

test('the validate data pane toggles to a generated form and edits re-validate', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'User' }).first().click();
  await expect(page.locator('.jplay-engine')).toHaveText('JSON Schema');
  // toggle JSON → the schema-generated form
  await page.locator('.jplay-dataview .seg-btn', { hasText: 'Form' }).click();
  await expect(page.locator('.jplay-form')).toBeVisible();
  const firstField = page.locator('.jplay-form input[type="text"]').first();
  await expect(firstField).toBeVisible();
  await firstField.fill('Zed'); // a form edit mirrors to the data + re-validates
  await expect(page.locator('.jplay-note')).toContainText('valid');
  // back to JSON: the edit is reflected in the DATA textarea's value (the last
  // editor; the schema is the first)
  await page.locator('.jplay-dataview .seg-btn', { hasText: 'JSON' }).click();
  await expect(page.locator('.jplay-editors textarea').last()).toHaveValue(/Zed/);
});

test('a visual engine (mermaid) renders an SVG diagram on the stage', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'Flowchart' }).click();
  await expect(page.locator('.jplay-engine')).toHaveText('Mermaid');
  await expect(page.locator('.jplay-view svg')).toBeVisible(); // the host renderer's SVG
});

test('a visual engine (charts) renders an SVG chart on the stage', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'Heatmap (log)' }).click();
  await expect(page.locator('.jplay-engine')).toHaveText('Charts');
  await expect(page.locator('.jplay-view svg')).toBeVisible();
});

test('the mdx engine renders markdown against the data pane, live', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'An invoice from data' }).click();
  await expect(page.locator('.jplay-engine')).toHaveText('MDX');
  const view = page.locator('.jplay-view');
  await expect(view).toContainText('Invoice INV-7'); // {$.number} interpolated
  await expect(view).toContainText('Rubber duck');   // the {#each} section
  await expect(view).toContainText('Paid — thank you!');
  // the dataset switcher re-renders the SAME template over new data
  await page.locator('.jplay-datasets .seg-btn', { hasText: 'unpaid' }).click();
  await expect(view).toContainText('Invoice INV-8');
  await expect(view).not.toContainText('Paid — thank you!');
  // the drill-down shows the resolved canonical markdown
  await page.locator('.jplay-deep-toggle').click();
  await expect(page.locator('.jplay-deep .code-block')).toContainText('Invoice INV-8');
});

test('a visual engine (markdown) renders HTML on the stage', async ({ page }) => {
  await page.goto('/#/play');
  await page.locator('.jplay-ex', { hasText: 'GFM tour' }).click();
  await expect(page.locator('.jplay-engine')).toHaveText('Markdown');
  await expect(page.locator('.jplay-view')).toContainText('Markdown, as JSON');
});

test('a broken selector docks an error instead of crashing the page', async ({ page }) => {
  await page.goto('/#/play');
  await expect(page.locator('.jplay-result')).toBeVisible();
  await page.locator('.jplay-editors input.editor').fill('$.[[[bogus');
  await expect(page.locator('.error-line')).toBeVisible();
  await expect(page.locator('.jplay')).toBeVisible(); // still on screen
});

test('the playground fits the viewport, light and dark, mobile and desktop', async ({ page }) => {
  await page.goto('/#/play');
  await expect(page.locator('.jplay')).toBeVisible();
  for (const [size, label] of [[{ width: 390, height: 844 }, 'mobile'], [{ width: 1280, height: 900 }, 'desktop']]) {
    await page.setViewportSize(size);
    await noOverflow(page, `${label} · light`);
    await page.locator('.theme-toggle').click();
    await noOverflow(page, `${label} · dark`);
    await page.locator('.theme-toggle').click(); // back to light for the next size
  }
});
