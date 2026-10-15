import { expect } from '@playwright/test';
import { createServer } from 'node:http';
import { test, reachesNetwork } from './outage.js';

test('with the server gone, a reload is answered by the service worker', async ({ page, site }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${site.origin}/jarenjs/#/docs`);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.reload();
  // Everything the controlled load fetched through a caching branch is in the cache before the outage.
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open((await caches.keys())[0]);
    const held = new Set((await cache.keys()).map((request) => request.url));
    return performance.getEntriesByType('resource').map((entry) => entry.name)
      .filter((url) => /\/(assets|fonts|benchmarks|site)\/|\/build\.json$/.test(new URL(url).pathname) && !held.has(url));
  })).toEqual([]);
  await site.down();
  expect(await reachesNetwork(page)).toBe(false);
  await page.reload();
  await expect(page.locator('#site-nav')).toBeAttached();
  await expect(page.getByRole('main')).not.toBeEmpty();
  expect(errors).toEqual([]);
});

// The limit the outage above works around, reduced: a worker that answers
// every request with a Response it constructs, no cache and no network.
// Under context.setOffline(true) Chromium and Firefox take that answer;
// Playwright's WebKit fails the fetch and the reload before the worker is
// asked. When this starts answering on WebKit, the emulation can be used there.
test('setOffline lets a worker-constructed response through, except on WebKit', async ({ page, context, browserName }) => {
  const worker = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (!new URL(event.request.url).pathname.endsWith('/sw.js')) event.respondWith(new Response('<title>worker</title>', { headers: { 'Content-Type': 'text/html' } }));
});`;
  const server = createServer((request, response) => {
    if (request.url === '/r/sw.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(worker);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>page</title><script>navigator.serviceWorker.register("/r/sw.js", { scope: "/r/" })</script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  try {
    await page.goto(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}/r/`);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    const fetched = await page.evaluate(() => fetch('/r/any').then((response) => response.text(), (error) => `refused: ${error.message}`));
    const reloaded = await page.reload().then(() => page.title(), (error) => `refused: ${error.message.split('\n')[0]}`);
    if (browserName === 'webkit') {
      expect(fetched).toBe('refused: Load failed');
      expect(reloaded).toBe('refused: page.reload: WebKit encountered an internal error');
    } else {
      expect(fetched).toBe('<title>worker</title>');
      expect(reloaded).toBe('worker');
    }
  } finally { await context.setOffline(false); server.closeAllConnections(); server.close(); }
});
