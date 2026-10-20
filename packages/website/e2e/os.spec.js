//@ts-check
/**
 * Radiant OS in real engines, against the built app at /jarenjs/os/: it
 * boots and dances, the human decides a council session, the gallery
 * keeps an artwork in the OS's own database and puts it back, and once
 * its worker is installed the whole OS boots again with the server gone.
 * The headless suites (`test/website/os-*.test.js`) prove the logic;
 * this proves the browser half — the canvas, the database worker, the
 * service worker — that no stub can.
 */
import { expect } from '@playwright/test';
import { test, reachesNetwork } from './outage.js';

/** Collect every page error, and every console error unless the test
 * itself provokes some (a refused request logs one).
 * @param {import('@playwright/test').Page} page @param {{ console?: boolean }} [options] */
function watchErrors(page, options = {}) {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (options.console !== false) page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

/** The tick the status bar shows. @param {import('@playwright/test').Page} page */
const tickOf = async (page) => Number(await page.locator('.os-pill', { hasText: 'tick' }).locator('.os-pill-value').textContent());

test('boots, dances, and gives the human the verdict', async ({ page, site }) => {
  const errors = watchErrors(page);
  await page.goto(`${site.origin}/jarenjs/os/`);
  const os = page.locator('.os');
  await expect(os).toHaveAttribute('data-phase', 'idle');
  await expect(page.locator('.os-stage canvas')).toBeAttached();
  await expect(page.locator('.os-stage')).toHaveAttribute('role', 'img');
  await expect.poll(() => tickOf(page)).toBeGreaterThan(5);

  await page.getByRole('button', { name: 'Convene now' }).click();
  await expect(os).toHaveAttribute('data-phase', 'veto', { timeout: 20_000 });
  await expect(page.getByRole('region', { name: 'Your verdict' })).toBeVisible();
  await page.getByRole('button', { name: 'Veto', exact: true }).click();
  await expect(page.locator('.os-amendment.is-vetoed')).toHaveCount(1);
  await expect(os).toHaveAttribute('data-phase', 'idle');

  await page.getByRole('button', { name: 'Convene now' }).click();
  await expect(os).toHaveAttribute('data-phase', 'veto', { timeout: 20_000 });
  await page.keyboard.press('a');
  await expect(page.locator('.os-amendment.is-enacted')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('keeps an artwork in its own database and puts it back', async ({ page, site }) => {
  const errors = watchErrors(page);
  await page.goto(`${site.origin}/jarenjs/os/`);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await expect(page.locator('.os-gallery')).toContainText(/Storage: (sqlite on OPFS|memory)\./);
  await page.getByLabel('Title').fill('First light');
  await page.getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(page.locator('.os-artwork-title')).toHaveText(['First light']);
  await expect.poll(() => tickOf(page)).toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Put back', exact: true }).click();
  await expect(page.locator('.os-notice')).toContainText('Back on the floor: First light');
  expect(errors).toEqual([]);
});

test('holds still under reduced motion, and still draws', async ({ page, site }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${site.origin}/jarenjs/os/`);
  await expect(page.locator('.os')).toHaveAttribute('data-motion', 'reduce');
  await expect(page.locator('.os-stage canvas')).toBeAttached();
  await expect.poll(() => tickOf(page)).toBeGreaterThan(2);
});

test('once installed, boots with the server gone', async ({ page, site }) => {
  const errors = watchErrors(page, { console: false });
  await page.goto(`${site.origin}/jarenjs/os/`);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // the worker precached everything the build emitted at install
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open('radiant-os-v2');
    return (await cache.keys()).filter((request) => request.url.includes('/assets/')).length;
  })).toBeGreaterThan(3);
  await site.down();
  expect(await reachesNetwork(page)).toBe(false);
  await page.reload();
  await expect(page.locator('.os')).toHaveAttribute('data-phase', 'idle');
  await expect.poll(() => tickOf(page)).toBeGreaterThan(3);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await expect(page.locator('.os-gallery')).toContainText(/Storage: (sqlite on OPFS|memory)\./);
  expect(errors).toEqual([]);
});
