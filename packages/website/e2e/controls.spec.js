//@ts-check
/**
 * @file A controlled text field must not be erased by a render that lands
 * while someone is typing in it.
 *
 * The renderer reasserts a control's authoritative value after every
 * settled render. A field whose value is bound to state but whose
 * keystrokes are only published on `change` (blur) is therefore rewritten
 * with the stale value mid-word — and writing `.value` clears the
 * browser's dirty-value flag, so the `change` that would have committed
 * never fires either. The edit disappears and nothing reports it.
 * `@jarenjs/studio`'s `editorTextarea` documents the failure and the fix
 * (publish each keystroke to a buffer); these are the fields that needed
 * the same treatment.
 *
 * The trigger here is deterministic rather than opportunistic: instead of
 * waiting for a live query or a debounce to fire, each case dispatches a
 * synthetic click on the theme toggle. That is a state change every page
 * carries, it re-renders the whole tree, and — unlike a real click — a
 * dispatched event moves no focus, so the caret stays in the field under
 * test. Left to timing, this class of bug shows up as an intermittent
 * failure somewhere else entirely (it was costing the OPFS reload spec a
 * third of its runs).
 *
 * One page context walks all three fields: several of these routes open a
 * wasm store or a streaming run, and a context apiece starves the specs
 * that measure them.
 */
import { test, expect } from '@playwright/test';

// This spec clicks a Load button on a freshly routed card. Under
// `no-preference` the card is still rising on its staggered reveal while
// the page glides on `scroll-behavior: smooth`, so mousedown and mouseup
// land on different elements and no click ever reaches the button — the
// field under test then never appears. `emulateMedia` is what reaches the
// page; `test.use({ reducedMotion })` does not.
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/**
 * Force one render of the whole tree without touching focus: a DISPATCHED
 * click carries no focus change, unlike a user click.
 */
async function renderWithoutTouchingFocus(page) {
  await page.evaluate(() => {
    document.querySelector('.theme-toggle')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(400);
}

test('a render mid-edit never erases what is being typed', async ({ page }) => {
  test.slow();
  await page.goto('/');

  // ——— the data studio's insert field ———
  await page.evaluate(() => { window.location.hash = '#/data'; });
  await expect(page.locator('.data-insert-title')).toBeVisible();
  // the store must be open before an insert can land
  await expect(page.locator('.data-status .data-vfs')).not.toHaveText('—', { timeout: 30_000 });

  await page.locator('.data-insert-title').focus();
  await page.keyboard.type('a note being typed');
  await renderWithoutTouchingFocus(page);
  await expect(page.locator('.data-insert-title'))
    .toHaveValue('a note being typed');

  // and the commit still works: blur inserts the row and clears the field
  await page.locator('.data-insert-title').blur();
  await expect(page.locator('.data-live-rows')).toContainText('a note being typed', { timeout: 30_000 });
  await expect(page.locator('.data-insert-title')).toHaveValue('');

  // ——— the project IDE's file-name field ———
  await page.evaluate(() => { window.location.hash = '#/project'; });
  await expect(page.locator('.js-editor-name')).toBeVisible();
  const original = await page.locator('.js-editor-name').inputValue();

  await page.locator('.js-editor-name').focus();
  await page.keyboard.type('X');
  await renderWithoutTouchingFocus(page);
  await expect(page.locator('.js-editor-name')).toHaveValue(`${original}X`);

  // the rename still commits, and the field then follows the active file
  await page.locator('.js-editor-name').blur();
  await expect(page.locator('.js-file-name').first()).toContainText(`${original}X`);

  // ——— the flow studio's dag run input ———
  await page.evaluate(() => { window.location.hash = '#/flow'; });
  await page.locator('.card', { hasText: 'Enrich & report' })
    .getByRole('button', { name: 'Load' }).click();
  await expect(page.locator('.flow-dag-input')).toBeVisible();

  await page.locator('.flow-dag-input').focus();
  await page.keyboard.type('  ');
  const typed = await page.locator('.flow-dag-input').inputValue();
  await renderWithoutTouchingFocus(page);
  await expect(page.locator('.flow-dag-input')).toHaveValue(typed);
});
