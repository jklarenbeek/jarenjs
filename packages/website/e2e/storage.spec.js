//@ts-check
import { test, expect } from '@playwright/test';

test.describe.configure({ timeout: 120000 });
test.use({ serviceWorkers: 'block' });
const ready = { timeout: 45000 };
const denyOpfs = "if (navigator.storage) Object.defineProperty(navigator.storage, 'getDirectory', { value: () => Promise.reject(new DOMException('storage denied by host fixture', 'NotAllowedError')) });\n";
async function host(page, prefix) {
  if (prefix) await page.route('**/db-worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: prefix + await response.text(), contentType: 'text/javascript' });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
}
async function boot(page, isolated = false) {
  await page.goto(isolated ? 'http://127.0.0.1:4174/#/data' : '/#/data');
  await expect(page.locator('.data-status .data-vfs')).not.toHaveText('—', ready);
  await expect(page.locator('.data-rows')).toContainText('important', ready);
}
async function report(page, testInfo) {
  await testInfo.attach('storage-capabilities', { contentType: 'application/json', body: JSON.stringify({
    engine: testInfo.project.name,
    browserVersion: page.context().browser().version(),
    ...await page.evaluate(() => ({ isolated: crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      opfs: typeof navigator.storage?.getDirectory === 'function', indexedDB: typeof indexedDB?.open === 'function' })),
    vfs: await page.locator('.data-vfs').textContent(),
    durability: await page.locator('.data-durability').textContent(),
    fallback: await page.locator('.data-refusal').count() ? await page.locator('.data-refusal').textContent() : null,
  }) });
}

test('isolated hosting selects an observed durable rung and captures sessions', async ({ page }, testInfo) => {
  await host(page, '');
  await boot(page, true);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.locator('.data-vfs')).toHaveText(/opfs-sab|opfs-sahpool|indexeddb-snapshot/);
  await expect(page.locator('.data-status')).toContainText('session');
  await report(page, testInfo);
});

test('ordinary hosting uses the observed header-free durable rung', async ({ page }, testInfo) => {
  await host(page, '');
  await boot(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await expect(page.locator('.data-vfs')).toHaveText(/opfs-sahpool|indexeddb-snapshot/);
  await report(page, testInfo);
});

test('IndexedDB persists close/reopen and an interrupted replacement preserves the last snapshot', async ({ page }, testInfo) => {
  await host(page, denyOpfs);
  await boot(page);
  await expect(page.locator('.data-vfs')).toHaveText('indexeddb-snapshot');
  await expect(page.locator('.data-live-note')).toContainText('unavailable');
  await page.locator('.data-insert-title').fill('durable snapshot marker');
  await page.locator('.data-insert-title').blur();
  await expect(page.locator('.data-rows')).toContainText('durable snapshot marker', ready);
  const client = await page.context().newPage();
  await client.goto('/#/data');
  await expect(client.locator('.data-topology')).toHaveText('client', ready);
  await expect(client.locator('.data-vfs')).toHaveText('indexeddb-snapshot');
  await expect(client.locator('.data-rows')).toContainText('durable snapshot marker', ready);
  await expect(client.locator('.data-live-note')).toContainText('unavailable');
  await client.close();
  await page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('jaren-data-studio-snapshots', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction('snapshots', 'readwrite');
      tx.objectStore('snapshots').put({ revision: 999999, bytes: new Uint8Array([1, 2, 3]) }, '/jaren-data-studio.db');
      tx.onabort = () => { db.close(); resolve(true); };
      tx.oncomplete = () => { db.close(); reject(new Error('an interrupted snapshot committed')); };
      tx.abort();
    };
  }));
  await page.reload();
  await expect(page.locator('.data-vfs')).toHaveText('indexeddb-snapshot', ready);
  await expect(page.locator('.data-rows')).toContainText('durable snapshot marker', ready);
  await report(page, testInfo);
});

for (const refusal of ['denied', 'quota']) {
  test(`memory is visibly non-durable when persistent storage is ${refusal}`, async ({ page }, testInfo) => {
    const prefix = denyOpfs + (refusal === 'denied'
      ? "Object.defineProperty(globalThis, 'indexedDB', { value: undefined });\n"
      : "IDBObjectStore.prototype.put = function() { throw new DOMException('snapshot quota exhausted', 'QuotaExceededError'); };\n");
    await host(page, prefix);
    await boot(page);
    await expect(page.locator('.data-vfs')).toHaveText('memory');
    await expect(page.locator('.data-durability')).toContainText('non-durable');
    await expect(page.locator('.data-refusal')).toContainText('indexeddb-snapshot');
    await report(page, testInfo);
  });
}
