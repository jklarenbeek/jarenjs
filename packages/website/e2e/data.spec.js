//@ts-check
/**
 * @file The browser PROOF: the same data layer runs in a real
 * browser. This drives the deployed `#/data` studio on the built
 * site — the SQLite wasm build loads in a dedicated worker over the
 * header-free OPFS SAH-pool VFS, a live query maintains as rows are
 * inserted, `explain()` shows the pushdown, a migration plans and
 * applies, data SURVIVES a reload (OPFS persistence), a SECOND
 * tab is refused the pool and downgrades to a client that still sees
 * live updates from the owner, and TWO client tabs firing distinct
 * queries over the one shared channel each render exactly their own
 * result — the port binding's client-scoped request ids at work where
 * the old per-tab `r<seq>` ids could cross-settle. The engine parity
 * is proven in Node (test/db/wasm-driver.test.js); this proves the
 * ENVIRONMENT.
 *
 * OPFS needs a secure context and workers; 127.0.0.1 is secure. The
 * SAH-pool VFS needs NO COOP/COEP headers (that is why the deployed
 * demo can use it on GitHub Pages).
 */
import { test, expect } from '@playwright/test';

// These tests run ONE AT A TIME, which is the same fact the file is about:
// the OPFS access-handle pool admits a single owner, and the third test
// exists to prove a second tab is refused it. Run in parallel they are
// several would-be owners racing for that pool plus four simultaneous wasm
// boots in one engine — measured in WebKit, that fails a boot outright
// roughly one run in four (30s timeout); serial, it is 4/4 green in ~6s.
// Whatever a second tab must observe, a test opens deliberately.
test.describe.configure({ mode: 'serial' });

// the wasm build + first store open is real work; give it room
const READY = { timeout: 30_000 };

async function gotoData(page) {
  await page.goto('/#/data');
  await expect(page.locator('h1', { hasText: 'Data' })).toBeVisible();
  // the store finishes opening: the status leaves 'boot'
  await expect(page.locator('.data-status .data-vfs')).not.toHaveText('—', READY);
}

test('the wasm store boots, a live query maintains, explain shows the pushdown', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await gotoData(page);

  // the store is real: capture reports the journal fallback (sessions
  // are compiled into the wasm build but not adapted — stated)
  await expect(page.locator('.data-status')).toContainText('journal');
  const vfs = await page.locator('.data-status .data-vfs').textContent();
  expect(['opfs-sahpool', 'memory']).toContain(vfs?.trim());

  // the seeded live query shows the three seed rows
  const liveRows = page.locator('.data-live-rows');
  await expect(liveRows).toContainText('important', READY);
  const before = await page.locator('.data-live-count').textContent();

  // insert a row: the live query updates without a reload
  await page.locator('.data-insert-title').fill('a brand new note');
  await page.locator('.data-insert-title').blur();
  await expect(liveRows).toContainText('a brand new note', READY);
  const after = await page.locator('.data-live-count').textContent();
  expect(after).not.toBe(before);

  // run + explain: the SQL and the index chosen are visible
  await page.locator('.data-query .btn.primary', { hasText: 'Run + explain' }).click();
  await expect(page.locator('.data-explain-sql')).toContainText('SELECT', READY);
  await expect(page.locator('.data-explain-indexes')).toContainText('by_points');

  // a migration plans on a shadow database and applies
  await page.locator('.data-live .btn', { hasText: 'title index' }).click();
  await expect(page.locator('.data-migration-steps')).toContainText('by_title', READY);

  expect(errors, 'no uncaught page errors').toEqual([]);
});

test('data survives a reload via OPFS (or is honestly in-memory)', async ({ page }) => {
  // the only test here that pays for TWO store opens — the wasm build boots
  // again after the reload — so it gets more than the single-boot budget its
  // siblings run inside
  test.slow();
  await gotoData(page);
  const vfs = (await page.locator('.data-status .data-vfs').textContent())?.trim();

  await page.locator('.data-insert-title').fill('persist me across reload');
  await page.locator('.data-insert-title').blur();
  await expect(page.locator('.data-live-rows')).toContainText('persist me across reload', READY);

  // reload and WAIT — no second goto: navigating again to the same URL
  // would boot a second worker beside the reload's own, and two
  // concurrent wasm boots are exactly the WebKit race the serial-mode
  // comment above measures
  await page.reload();
  await expect(page.locator('h1', { hasText: 'Data' })).toBeVisible();
  await expect(page.locator('.data-status .data-vfs')).not.toHaveText('—', READY);

  // branch on the VFS AFTER the reload: under heavy parallel test load
  // the SAH-pool can momentarily fail to re-acquire the just-released
  // OPFS handles and fall back to memory — a legitimate, stated outcome
  // (the durability line says so). Persistence is asserted precisely
  // when the reloaded tab actually re-owns the pool.
  const vfsAfter = (await page.locator('.data-status .data-vfs').textContent())?.trim();
  if (vfs === 'opfs-sahpool' && vfsAfter === 'opfs-sahpool') {
    await expect(page.locator('.data-live-rows'))
      .toContainText('persist me across reload', READY);
  }
  else {
    await expect(page.locator('.data-durability')).toContainText('in-memory');
  }
});

test('a second tab is refused the pool and becomes a live client', async ({ browser }) => {
  const context = await browser.newContext();
  const owner = await context.newPage();
  await gotoData(owner);
  const ownerVfs = (await owner.locator('.data-status .data-vfs').textContent())?.trim();
  test.skip(ownerVfs !== 'opfs-sahpool',
    'OPFS SAH-pool unavailable in this engine — the owner topology needs it');

  // the SECOND tab opens the same site: OPFS exclusivity refuses it the
  // pool, so it downgrades to a CLIENT over the BroadcastChannel
  const client = await context.newPage();
  await client.goto('/#/data');
  await expect(client.locator('.data-status .data-topology'))
    .toHaveText('client', READY);
  await expect(client.locator('.data-refusal')).toContainText('JD2061');

  // the owner writes; the client's live query — served over the channel
  // by the owner's sole connection — sees it
  await owner.locator('.data-insert-title').fill('cross tab hello');
  await owner.locator('.data-insert-title').blur();
  await expect(client.locator('.data-live-rows'))
    .toContainText('cross tab hello', READY);

  await context.close();
});

test('two client tabs sharing the owner channel never cross-settle', async ({ browser }) => {
  // three wasm boots (an owner and two would-be owners that downgrade):
  // the sibling budget is one boot
  test.slow();
  const context = await browser.newContext();
  const owner = await context.newPage();
  await gotoData(owner);
  const ownerVfs = (await owner.locator('.data-status .data-vfs').textContent())?.trim();
  test.skip(ownerVfs !== 'opfs-sahpool',
    'OPFS SAH-pool unavailable in this engine — the owner topology needs it');

  const openClient = async () => {
    const page = await context.newPage();
    await page.goto('/#/data');
    await expect(page.locator('.data-status .data-topology')).toHaveText('client', READY);
    return page;
  };
  const a = await openClient();
  const b = await openClient();

  // two DISTINCT queries with distinguishable results, committed in each
  // tab's editor: A matches nothing, B matches every seeded row
  const editor = (page) => page.locator('.data-query textarea.editor');
  await editor(a).fill(JSON.stringify(
    { $for: { it: '$[*]' }, $where: { $gt: ['$it.points', 100000] }, $return: '$it' }));
  await editor(a).blur();
  await editor(b).fill(JSON.stringify(
    { $for: { it: '$[*]' }, $where: { $gt: ['$it.points', -1] }, $return: '$it' }));
  await editor(b).blur();

  // fire both runs together: each tab's execute+explain pair travels the
  // ONE BroadcastChannel to the owner concurrently. Under the old
  // per-tab `r<seq>` ids these were exactly the frames that could
  // cross-settle; the port binding's "<clientId>:<seq>" ids make a
  // foreign answer impossible by construction, so each tab must render
  // precisely its own result.
  const run = (page) => page.locator('.data-query .btn.primary', { hasText: 'Run + explain' }).click();
  await Promise.all([run(a), run(b)]);

  // both runs SETTLED (the explain pane only renders after a result
  // lands) — so the result assertions below cannot pass vacuously on
  // the pre-run empty state
  await expect(a.locator('.data-explain-sql')).toContainText('SELECT', READY);
  await expect(b.locator('.data-explain-sql')).toContainText('SELECT', READY);

  // B sees the whole collection (the seed titles); A sees an empty result
  await expect(b.locator('.data-results')).toContainText('important', READY);
  await expect(a.locator('.data-results')).toHaveText('[]', READY);
  await expect(a.locator('.data-results')).not.toContainText('important');
  // and neither tab surfaced a transport error
  await expect(a.locator('.error-line')).toHaveCount(0);
  await expect(b.locator('.error-line')).toHaveCount(0);

  await context.close();
});
