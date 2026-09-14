import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// An installed qualification supplies the bundle built from extracted tarballs.
const code = process.env.JAREN_DIALOG_BUNDLE ? readFileSync(process.env.JAREN_DIALOG_BUNDLE, 'utf8')
  : (await build({ stdin: { contents: readFileSync(`${root}/test/consumer/dialog.js`, 'utf8'), resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'DialogConsumer' })).outputFiles[0].text;
test.beforeEach(async ({ page }) => {
  await page.setContent('<aside inert id="already-inert">Keep inert</aside><div id="host"></div>');
  await page.addScriptTag({ content: code });
  await page.evaluate(() => { window.app = window.DialogConsumer.createDialogConsumer(document.querySelector('#host')); });
});

test('visible naming, initial focus, both Tab directions, close intent and restoration', async ({ page }) => {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'More settings', exact: true })).toBeFocused();
  await page.evaluate(() => { for (let i = 0; i < 10; i++) window.app.dispatch('bump'); });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.app.getState().closes)).toBe(1);
  await expect(page.locator('#already-inert')).toHaveAttribute('inert', '');
});

test('only the topmost modal consumes Escape and background focus stays inert', async ({ page }) => {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'More settings', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Detail' })).toBeFocused();
  await page.evaluate(() => document.querySelector('[data-ref=fallback]').focus());
  await expect(page.getByRole('textbox', { name: 'Detail' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'More settings', exact: true })).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'More settings', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.app.getState())).toMatchObject({ open: false, inner: false, closes: 1 });
});

test('empty dynamic content, disconnected opener fallback and nested destruction', async ({ page }) => {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.evaluate(() => { window.app.dispatch('empty'); window.app.dispatch('removeOpener'); });
  const close = page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab'); await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Continue here' })).toBeFocused();
  await page.evaluate(() => {
    window.app.destroy();
    window.app = window.DialogConsumer.createDialogConsumer(document.querySelector('#host'));
  });
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'More settings', exact: true }).click();
  await page.evaluate(() => { window.app.destroy(); window.app.destroy(); });
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('#host')).toBeEmpty();
  await expect(page.locator('#already-inert')).toHaveAttribute('inert', '');
  expect(await page.evaluate(() => document.querySelectorAll(':modal').length)).toBe(0);
});

test('native form closure is reported once and an old close event cannot close a reopened owner', async ({ page }) => {
  await page.evaluate(() => {
    window.app.destroy(); window.reasons = [];
    window.formProps = { id: 'form-dialog', title: 'Apply settings', open: true,
      content: ['form', { method: 'dialog' }, ['button', { type: 'submit' }, 'Apply']] };
    window.modal = window.DialogConsumer.createDialog(document.querySelector('#host'), window.formProps,
      { onClose: reason => window.reasons.push(reason) });
  });
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.reasons)).toEqual(['native']);
  await page.evaluate(() => {
    window.modal.update(window.formProps);
    window.modal.update({ ...window.formProps, open: false });
    window.modal.update(window.formProps);
  });
  await expect(page.getByRole('dialog', { name: 'Apply settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.reasons)).toEqual(['native', 'native']);
  await page.evaluate(() => window.modal.dispose());
  await expect(page.locator('#host')).toBeEmpty();
});
