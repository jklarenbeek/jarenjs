import { test as base } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const BASE = '/jarenjs/';
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serve the built site under `/jarenjs/` from a server this test owns, so
 * the network can really go away: `down()` closes the listener and every
 * open connection, and the next request is refused exactly as on a
 * disconnected host. `context.setOffline(true)` is not that on WebKit: the
 * Playwright WebKit emulation fails a request before the page's service
 * worker can answer it, even with a response the worker constructs itself
 * (pinned in `offline-navigation.spec.js`).
 * @returns {Promise<{ origin: string, down(): Promise<void> }>}
 */
export async function serveSite() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!path.startsWith(BASE)) { response.writeHead(404).end(); return; }
    const name = path.slice(BASE.length) || 'index.html';
    try {
      const body = await readFile(join(DIST, name));
      response.writeHead(200, { 'Content-Type': TYPES[extname(name)] ?? 'application/octet-stream' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return {
    origin: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    down: () => new Promise((resolve) => { server.close(() => resolve(undefined)); server.closeAllConnections(); }),
  };
}

/**
 * Whether a request the service worker leaves alone (no branch matches
 * `/jarenjs/never-cached`) still reaches a server: false once the outage holds.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>}
 */
export const reachesNetwork = (page) => page.evaluate(() => fetch('/jarenjs/never-cached').then(() => true, () => false));

/** Playwright's `test` with a `site` fixture: {@link serveSite}, taken down after the test. */
export const test = base.extend({
  site: async ({}, use) => { // eslint-disable-line no-empty-pattern -- Playwright reads the fixture's dependencies from this pattern
    const site = await serveSite();
    await use(site);
    await site.down();
  },
});
