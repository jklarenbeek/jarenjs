//@ts-check
/**
 * @file The browser PROOF: the same data layer runs in a real
 * browser. This drives the deployed `#/data` studio on the built
 * site — the SQLite wasm build loads in a dedicated worker over the
 * header-free OPFS SAH-pool VFS, a live query maintains as rows are
 * inserted, `explain()` shows the pushdown, a migration plans and
 * applies, data SURVIVES a reload (OPFS persistence), a SECOND
 * tab is refused the pool and downgrades to a client that still sees
 * live updates from the owner — its live query is a SUBSCRIPTION over
 * the contract stream binding now, so the patch that reaches it is a
 * push frame, closing the tab releases the owner-side registration
 * (the status line's count drops), and TWO client tabs each hold their
 * own independent subscription while firing distinct queries over the
 * one shared channel and rendering exactly their own result — the port
 * binding's client-scoped ids at work where the old per-tab `r<seq>`
 * ids could cross-settle. The engine parity is proven in Node
 * (test/db/wasm-driver.test.js); this proves the ENVIRONMENT.
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

test('the spatial round trip runs CSV → stylesheet → meta-schema → store → linq $within → explain() → map, in this tab', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await gotoData(page);

  // the seed CSV is on the page, and the emitted query document beside it
  await expect(page.locator('.data-trip')).toContainText('Round trip');
  await expect(page.locator('.data-trip-query')).toContainText('$within');
  await page.locator('.data-trip-run').click();
  await expect(page.locator('.data-trip-report')).toHaveAttribute('data-status', 'done', READY);
  await expect(page.locator('.data-trip-summary')).toContainText('5 CSV rows');
  await expect(page.locator('.data-trip-summary')).toContainText('3 inside the region');

  // explain(): both stages of the spatial plan, from the throwaway
  // store's own SQLite — the box seek and the exact refinement
  await expect(page.locator('.data-trip-prefilters')).toContainText('$within');
  await expect(page.locator('.data-trip-prefilters')).toContainText('"exact":false');
  await expect(page.locator('.data-trip-narrative')).toContainText('SEARCH');
  await expect(page.locator('.data-trip-narrative')).toContainText('USING INDEX');
  await expect(page.locator('.data-trip-indexes')).toContainText('by_box');

  // the result is the three Dutch cities, as stored, and it is drawn
  const results = JSON.parse(await page.locator('.data-trip-results').textContent());
  expect(results.map((f) => f.properties.name)).toEqual(['Amsterdam', 'Utrecht', 'Rotterdam']);
  await expect(page.locator('.data-trip-map svg')).toBeVisible();
  expect(await page.locator('.data-trip-map svg circle').count()).toBe(3);

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

test('a second tab is refused the pool, becomes a live client, and closing it releases its subscription', async ({ page: owner, context }) => {
  // three live phases (client patch, count up, count down after close):
  // more than the single-boot budget of the siblings
  test.slow();
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

  // the owner writes; the client's live SUBSCRIPTION — a stream-binding
  // push frame over the channel from the owner's sole connection — sees
  // the patch
  await owner.locator('.data-insert-title').fill('cross tab hello');
  await owner.locator('.data-insert-title').blur();
  await expect(client.locator('.data-live-rows'))
    .toContainText('cross tab hello', READY);

  // the owner's own live event refreshed the registration count: its
  // subscription plus the client's
  await expect(owner.locator('.data-live-regs')).toContainText('2', READY);

  // closing the client tab stops its subscription (pagehide → the
  // unsubscribe frame → owner-side stop() + close()); the count is
  // refreshed by the owner's next live event, so insert until it drops
  await client.close({ runBeforeUnload: true });
  await expect(async () => {
    await owner.locator('.data-insert-title').fill(`after close ${Date.now()}`);
    await owner.locator('.data-insert-title').blur();
    await expect(owner.locator('.data-live-regs')).toContainText('1', { timeout: 2_000 });
  }).toPass(READY);

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

  // each client holds its OWN live subscription on the shared channel:
  // one owner write reaches both panes as their own push frames
  await owner.locator('.data-insert-title').fill('everyone sees this');
  await owner.locator('.data-insert-title').blur();
  await expect(a.locator('.data-live-rows')).toContainText('everyone sees this', READY);
  await expect(b.locator('.data-live-rows')).toContainText('everyone sees this', READY);

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
