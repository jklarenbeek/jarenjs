//@ts-check
/**
 * @file The Project IDE (`#/project`) in a real browser: the starter app
 * boots LIVE on the stage, and the two hard problems hold with a real DOM
 * — a structural edit reboots, a state-only edit HOT-updates (the running
 * app keeps an uncontrolled input the user typed into), and an invalid
 * edit keeps the last good frame while docking the coded error. Plus the
 * three layout modes render without widening the viewport, light and dark.
 */
import { test, expect } from '@playwright/test';

const noOverflow = async (page, label) => {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `${label}: no horizontal overflow`).toBeLessThanOrEqual(innerWidth + 1);
};

/** The current editor document, parsed (specs run in Node). */
const editorDoc = async (page) => JSON.parse(await page.locator('.js-editor-input').inputValue());
const commitEditor = async (page, doc) => {
  const editor = page.locator('.js-editor-input');
  await editor.fill(JSON.stringify(doc, null, 2));
  await editor.blur();
};

test('the starter project boots live on the stage', async ({ page }) => {
  await page.goto('/#/project');
  await expect(page.locator('.jstudio')).toBeVisible();
  await expect(page.locator('.js-rail')).toContainText('app.json');
  await expect(page.locator('.js-editor-input')).toBeVisible();
  const mount = page.locator('.js-stage-mount');
  await expect(mount).toBeVisible();
  await expect(mount.locator('h1')).toHaveText('Hello from the studio');
  await noOverflow(page, 'the booted IDE');
});

test('a state-only edit HOT-updates: the running app keeps an uncontrolled input', async ({ page }) => {
  await page.goto('/#/project');
  const mount = page.locator('.js-stage-mount');
  await expect(mount.locator('h1')).toHaveText('Hello from the studio');

  // the user types into the nested app's UNCONTROLLED scratch input
  await mount.locator('input').fill('KEEP ME');

  // edit ONLY the state block in the IDE editor
  const doc = await editorDoc(page);
  doc.state.title = 'HOT TITLE';
  await commitEditor(page, doc);

  // the state shows live AND the scratch input survived — no reboot
  await expect(mount.locator('h1')).toHaveText('HOT TITLE');
  await expect(mount.locator('input')).toHaveValue('KEEP ME');
});

test('a structural edit reboots the stage (a fresh mount)', async ({ page }) => {
  await page.goto('/#/project');
  const mount = page.locator('.js-stage-mount');
  await mount.locator('input').fill('WILL BE LOST');

  const doc = await editorDoc(page);
  doc.view[0].body.push(['p', { class: 'brandnew' }, 'BRAND NEW VIEW']);
  await commitEditor(page, doc);

  await expect(mount).toContainText('BRAND NEW VIEW');
  // a reboot remounts the nested app: the uncontrolled input is fresh
  await expect(mount.locator('input')).toHaveValue('');
});

test('an invalid edit keeps the last good frame and docks the coded error', async ({ page }) => {
  await page.goto('/#/project');
  const mount = page.locator('.js-stage-mount');
  await expect(mount.locator('h1')).toHaveText('Hello from the studio');

  const editor = page.locator('.js-editor-input');
  await editor.fill('{ this is not valid json');
  await editor.blur();

  // the parse error docks, and the last good render stays on the stage
  await expect(page.locator('.js-errorstrip')).toBeVisible();
  await expect(mount.locator('h1')).toHaveText('Hello from the studio');
});

test('the three layout modes render without widening the viewport, light and dark', async ({ page }) => {
  await page.goto('/#/project');
  const shell = page.locator('.jstudio');

  for (const [size, label] of [[{ width: 390, height: 844 }, 'mobile'], [{ width: 1280, height: 900 }, 'desktop']]) {
    await page.setViewportSize(size);
    for (const mode of [['Side', 'classic'], ['Swap', 'right'], ['Stack', 'top']]) {
      await page.locator('.js-layout button', { hasText: mode[0] }).click();
      await expect(shell).toHaveAttribute('data-mode', mode[1]);
      await noOverflow(page, `${label} · ${mode[1]} · light`);
    }
    // dark theme, same sweep
    await page.locator('.theme-toggle').click();
    for (const mode of [['Side', 'classic'], ['Stack', 'top']]) {
      await page.locator('.js-layout button', { hasText: mode[0] }).click();
      await noOverflow(page, `${label} · ${mode[1]} · dark`);
    }
    await page.locator('.theme-toggle').click(); // back to light for the next size
  }
});
