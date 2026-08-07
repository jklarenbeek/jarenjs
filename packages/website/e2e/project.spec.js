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

test('a render landing mid-edit does not swallow the keystrokes (real dirty-value flag)', async ({ page }) => {
  await page.goto('/#/project');
  const editor = page.locator('.js-editor-input');
  await expect(editor).toBeVisible();

  // Opening a template schedules a DEBOUNCED commit. Typing straight after
  // it — as a user does — puts a render squarely inside the window between
  // the keystroke and the blur. The render must not steal focus, or the
  // blur would commit first and hide the defect, so this cannot be faked
  // with a click on some other control.
  await page.locator('.js-template', { hasText: 'Welcome' }).click();
  const doc = await editorDoc(page);
  doc.state.title = 'SURVIVES A RENDER';
  await editor.fill(JSON.stringify(doc, null, 2));
  await page.waitForTimeout(700); // the debounced commit lands mid-edit

  // the reassert used to rewrite the box here, which also clears the
  // browser's dirty-value flag — so the blur below fired no `change` at
  // all and the typing vanished without a trace
  await expect(editor).toHaveValue(/SURVIVES A RENDER/);

  await editor.blur();
  await expect(page.locator('.js-stage-mount h1')).toHaveText('SURVIVES A RENDER');
});

test('a query file runs live against its data file — the shared transform runners, folded in', async ({ page }) => {
  await page.goto('/#/project');
  // the starter is a multi-file project: switch to the query in the rail
  await page.locator('.js-file', { hasText: 'stats.query' }).click();
  const result = page.locator('.js-stage-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Result');
  await expect(result).toContainText('3.875'); // $mean of the data — a registered operator, run live
});

test('a schema file validates its data file on the stage (the validate tab, folded in)', async ({ page }) => {
  await page.goto('/#/project');
  await page.locator('.js-template', { hasText: 'Schema + data' }).click();
  const result = page.locator('.js-stage-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('✓'); // good data validates

  // break the data file, then return to the schema → the report flips
  await page.locator('.js-file', { hasText: 'user.data' }).click();
  const editor = page.locator('.js-editor-input');
  await editor.fill('{"age":-1}');
  await editor.blur();
  await page.locator('.js-file', { hasText: 'user.schema' }).click();
  await expect(page.locator('.js-stage-result')).toContainText('Invalid');
});

test('file management: open a template, add a file, rename it, delete it', async ({ page }) => {
  await page.goto('/#/project');

  // open a template from the gallery — the project is replaced
  await page.locator('.js-template', { hasText: 'JSLT + data' }).click();
  await expect(page.locator('.js-rail')).toContainText('shape.jslt');

  // add a fresh file of a kind — it becomes active
  await page.locator('.js-addfile').selectOption('data');
  await expect(page.locator('.js-rail')).toContainText('data-1.data');
  const nameField = page.locator('.js-editor-name');
  await expect(nameField).toHaveValue('data-1.data');

  // rename the active file
  await nameField.fill('extra.data');
  await nameField.blur();
  await expect(page.locator('.js-rail')).toContainText('extra.data');

  // delete it via the row's ×
  await page.locator('.js-file-row', { hasText: 'extra.data' }).locator('.js-file-del').click();
  await expect(page.locator('.js-rail')).not.toContainText('extra.data');
});

test('the splitter drags to commit a new ratio and keyboard-resizes as a separator', async ({ page }) => {
  await page.goto('/#/project');
  const splitter = page.locator('.js-split');
  await expect(splitter).toHaveAttribute('role', 'separator');
  await expect(splitter).toHaveAttribute('aria-valuenow', '50');

  // drag it rightward: the left (editor) pane grows → the ratio goes up,
  // and it commits on pointer-up (the widget reflects it in aria-valuenow)
  const box = await splitter.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const afterDrag = Number(await splitter.getAttribute('aria-valuenow'));
  expect(afterDrag, 'the drag committed a larger left-pane ratio').toBeGreaterThan(50);

  // keyboard: focus the separator and nudge it 5% narrower
  await splitter.focus();
  const before = Number(await splitter.getAttribute('aria-valuenow'));
  await splitter.press('ArrowLeft');
  expect(Number(await splitter.getAttribute('aria-valuenow')),
    'ArrowLeft shrinks the left pane by 5%').toBe(before - 5);
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
