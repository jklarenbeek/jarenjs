import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const example = readFileSync(new URL('../../../test/collection/fixtures/drag-grid.js', import.meta.url), 'utf8');
const bundle = await build({ stdin: { contents: example, resolveDir: process.env.JAREN_PACKED_ROOT ?? root },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'DragExample' });

async function setup(page, options = {}) {
  await page.setContent('<button id="before">Before</button><main id="host" style="display:flex;gap:32px"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((options) => { window.demo = window.DragExample.mountDragGrid(document.getElementById('host'), options); }, options);
}
const source = (page) => page.locator('[data-jc-drag="item-a"]');
const cell = (page, row = 'row-4', column = 2, container = 1) => page.locator('.jc-viewport').nth(container).locator(`[data-key="${row}"] [data-column="${column}"]`);
async function pointerStart(page) {
  await page.evaluate(() => window.addEventListener('pointerdown', (event) => { window.testPointerId = event.pointerId; }, { once: true }));
  await source(page).focus(); const box = await source(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
  await expect(page.locator('[data-jc-overlay]')).toHaveCount(1);
}

test('public virtual grid moves and copies stable identities with pointer and keyboard', async ({ page }) => {
  await setup(page);
  await pointerStart(page);
  await page.keyboard.down('Alt'); await expect(page.locator('[data-jc-overlay]')).toContainText('Copy');
  await page.keyboard.up('Alt'); await expect(page.locator('[data-jc-overlay]')).toContainText('Move');
  const box = await cell(page).boundingBox(); await page.mouse.move(box.x + 25, box.y + 20); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.demo.commands.length)).toBe(1);
  expect(await page.evaluate(() => window.demo.commands[0])).toEqual({ source: { key: 'item-a', revision: 1 },
    target: { container: 'right', key: 'row-4', column: 'day-c' }, mode: 'move' });
  await expect(source(page)).toBeFocused(); await expect(page.locator('[data-jc-overlay]')).toHaveCount(0);
  await page.locator('#before').click(); await expect(page.locator('#before')).toBeFocused();
  await source(page).press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Alt'); await page.keyboard.press('Enter'); await page.keyboard.up('Alt');
  await expect.poll(() => page.evaluate(() => window.demo.commands.length)).toBe(2);
  expect(await page.evaluate(() => window.demo.commands[1].mode)).toBe('copy');
  expect(await page.evaluate(() => window.demo.commands[1].target)).toEqual({ container: 'left', key: 'row-3', column: 'day-b' });
  const counts = await page.evaluate(() => window.demo.stats());
  expect(counts.collections.every((c) => c.rows < 14 && c.cells < 70)).toBe(true);
  expect(counts.visits).toBeLessThan(2000);
  await page.evaluate(() => { window.demo.dispose(); window.demo.dispose(); });
  const final = await page.evaluate(() => window.demo.stats());
  expect(final.listeners + final.subscriptions + final.frames + final.overlays + final.statusNodes).toBe(0);
  await test.info().attach('resource-counts', { body: JSON.stringify({ fixture: 'public-drag-grid', browser: test.info().project.name,
    logicalRows: 10000, visits: counts.visits, collections: counts.collections.map((c) => ({ rows: c.rows, cells: c.cells })),
    listeners: counts.listeners, subscriptions: counts.subscriptions,
    disposed: { listeners: final.listeners, subscriptions: final.subscriptions, frames: final.frames,
      overlays: final.overlays, statusNodes: final.statusNodes, pending: final.pending } }), contentType: 'application/json' });
});

test('zoomed nested containers, pinned headers and reordering retain measured drop coordinates', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { const host = document.getElementById('host'); host.style.zoom = '0.8'; host.style.transform = 'translate(20px, 30px)'; });
  await pointerStart(page);
  await page.evaluate(() => window.demo.reorder());
  const box = await cell(page, 'row-2', 2).boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.demo.commands.length)).toBe(1);
  expect(await page.evaluate(() => window.demo.commands[0].target.key)).toBe('row-2');
  await page.evaluate(() => window.demo.dispose());
});

test('auto-scroll stays bounded and stops on cancellation', async ({ page }) => {
  await setup(page); await pointerStart(page);
  const grid = await page.locator('.jc-viewport').nth(1).boundingBox();
  await page.mouse.move(grid.x + 180, grid.y + grid.height - 5);
  await expect.poll(() => page.evaluate(() => window.demo.containers[1].mounted.element.scrollTop)).toBeGreaterThan(50);
  expect(await page.evaluate(() => window.demo.containers[1].mounted.stats().rows)).toBeLessThan(14);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('[data-jc-overlay]')).toHaveCount(0);
  const top = await page.evaluate(() => window.demo.containers[1].mounted.element.scrollTop);
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => window.demo.containers[1].mounted.element.scrollTop)).toBe(top);
  expect(await page.evaluate(() => window.demo.drag.stats().frames)).toBe(0);
  await page.evaluate(() => window.demo.dispose());
});

test('rejected or stale async permission never dispatches a command or keeps an overlay', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.demo.setPermission('pending'));
  await source(page).press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.demo.drag.interaction.state().phase)).toBe('validating');
  await page.evaluate(() => { window.demo.reset(); window.demo.resolvePermission(true); });
  await expect(page.locator('[data-jc-overlay]')).toHaveCount(0);
  expect(await page.evaluate(() => window.demo.commands.length)).toBe(0);
  await page.evaluate(() => { window.demo.setPermission(true); window.demo.setCommandResult(false); });
  await source(page).press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('command-rejected');
  expect(await page.evaluate(() => window.demo.commands.length)).toBe(0);
  await page.evaluate(() => window.demo.dispose());
});

test('capture loss, pointer cancellation, blur, reset and destroy clean every owned resource', async ({ page }) => {
  for (const reason of ['capture', 'pointer', 'blur', 'source', 'destroy']) {
    await setup(page); await pointerStart(page);
    await page.evaluate((reason) => {
      const handle = document.querySelector('[data-jc-drag]');
      if (reason === 'capture') handle.releasePointerCapture(window.testPointerId);
      if (reason === 'pointer') handle.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: window.testPointerId }));
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      if (reason === 'source') window.demo.removeSource();
      if (reason === 'destroy') window.demo.containers[0].mounted.dispose();
    }, reason);
    await page.mouse.up(); await expect(page.locator('[data-jc-overlay]')).toHaveCount(0);
    expect(await page.evaluate(() => window.demo.commands.length)).toBe(0);
    await page.evaluate(() => window.demo.dispose());
    expect(await page.evaluate(() => window.demo.drag.stats().listeners)).toBe(0);
  }
});

test('editing and synthetic touch have explicit activation and cancellation boundaries', async ({ page }) => {
  await setup(page);
  const input = page.getByRole('textbox', { name: 'Editable note' }).first();
  await input.focus(); await input.press('ArrowLeft'); await input.press('Space');
  expect(await page.evaluate(() => window.demo.drag.interaction.state().phase)).toBe('idle');
  await source(page).evaluate((handle) => {
    // Synthetic events qualify activation rules, not physical touch or OS IME fidelity.
    handle.setPointerCapture = () => {}; handle.hasPointerCapture = () => false;
    const rect = handle.getBoundingClientRect();
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, pointerType: 'touch', isPrimary: true,
      button: 0, clientX: rect.left + 3, clientY: rect.top + 3 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 9, pointerType: 'touch', isPrimary: true,
      clientX: rect.left + 20, clientY: rect.top + 3 }));
  });
  await expect(page.locator('[data-jc-overlay]')).toHaveCount(1);
  await page.keyboard.press('Escape'); await expect(page.locator('[data-jc-overlay]')).toHaveCount(0);
  await page.evaluate(() => window.demo.dispose());
});

test('failed activation releases capture, overlay and source retention before the next gesture', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await page.evaluate(() => window.demo.drag.update({ onChange: (state) => {
    if (state.phase === 'dragging') throw new Error('activation observer failed');
  } }));
  await source(page).press('Space');
  await expect.poll(() => errors.length).toBe(1);
  expect(errors[0]).toContain('activation observer failed');
  const failed = await page.evaluate(() => window.demo.stats());
  expect(failed.frames + failed.overlays + failed.collections[0].retainers).toBe(0);
  expect(await page.evaluate(() => window.demo.drag.interaction.state().phase)).toBe('cancelled');
  await page.evaluate(() => window.demo.drag.update({ onChange: undefined }));
  await source(page).press('Space'); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.demo.commands.length)).toBe(1);
  await page.evaluate(() => window.demo.dispose());
});

test('public WidgetDef updates authority and repeatedly unmounts without retained owners', async ({ page }) => {
  await page.setContent('<main id="host" style="width:420px"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => { window.widget = window.DragExample.mountDragWidget(document.getElementById('host')); });
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.widget.show());
    await source(page).press('Space'); await page.keyboard.press('ArrowDown');
    await page.evaluate(() => window.widget.show({ disabled: true }));
    await expect(page.getByRole('status')).toContainText('target-unavailable');
    expect(await page.evaluate(() => window.widget.commands.length)).toBe(0);
    await page.evaluate(() => window.widget.hide());
    await expect(page.locator('.jc-viewport,[data-jc-overlay],[role="status"]')).toHaveCount(0);
    const counts = await page.evaluate(() => window.widget.stats());
    expect(Object.values(counts.drag).reduce((sum, value) => sum + value, 0)).toBe(0);
    expect(counts.collection.frames + counts.collection.listeners + counts.collection.subscribers + counts.collection.retainers).toBe(0);
  }
  await page.evaluate(() => window.widget.dispose());
});
