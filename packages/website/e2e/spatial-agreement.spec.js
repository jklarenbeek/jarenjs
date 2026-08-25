//@ts-check
/**
 * @file The THIRD runner of the spatial corpus: SQLite compiled to wasm,
 * in a real browser tab, in Chromium, Firefox and WebKit.
 *
 * `test/json/fixtures/spatial-corpus.json` records what the JavaScript
 * engine answers for every entry; `test/db/spatial-oracle.test.js`
 * holds SQLite through the Node driver to it. This spec holds the
 * browser to it: the data studio's Store pane runs the corpus the site
 * built from the same fixture through the tab's wasm store — one
 * throwaway in-memory store per entry, under the model with the
 * derived spatial indexes, the one that realizes every box column set
 * as an R\*Tree, and the one with no derived index at all — and
 * publishes every answer. The assertions are made HERE, against the fixture read from
 * disk, so the page's own verdict is checked and not trusted.
 *
 * The leg needs execution, not persistence: an entry seeds its own
 * store, so it runs in every engine, including one whose Playwright
 * build has no OPFS at all (this harness's WebKit). It never touches
 * the OPFS pool, never needs the owner topology, never uses the
 * BroadcastChannel path — which is why it must NOT skip anywhere. A
 * skipped leg would make the "one document, three executors" claim
 * false, so a refusal here is a failure that names the engine.
 *
 * Entries marked `executors: ["engine"]` are left out by their marker
 * (the site's projection names them); a runner that ran zero entries
 * would pass every per-entry assertion, so the count is asserted too.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** The fixture, read from disk — the one source the site's artifact was projected from. */
const CORPUS = JSON.parse(readFileSync(
  new URL('../../../test/json/fixtures/spatial-corpus.json', import.meta.url), 'utf8'));
const RUNNABLE = CORPUS.filter((entry) => entry.executors === undefined);
const MARKED = CORPUS.filter((entry) => entry.executors !== undefined).map((entry) => entry.name);
const MAPPINGS = ['indexed', 'rtree', 'unindexed'];
const EXECUTOR = 'sqlite-wasm';

// the wasm build + the first store open is real work; the corpus is
// nearly three hundred throwaway stores on top of it
const READY = { timeout: 30_000 };
const RAN = { timeout: 120_000 };

test.beforeEach(async ({ page }) => {
  // a freshly routed card glides under `scroll-behavior: smooth`, and a
  // click that lands mid-glide can be lost in Firefox
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test(`the spatial corpus agrees with the engine through ${EXECUTOR}, in this engine`, async ({ page }) => {
  test.slow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto('/#/data');
  await expect(page.locator('h1', { hasText: 'Data' })).toBeVisible();
  // the store finishes opening: the status leaves 'boot'. Whichever VFS
  // it settled on is fine — the oracle's stores are throwaway either way
  await expect(page.locator('.data-status .data-vfs')).not.toHaveText('—', READY);
  const vfs = (await page.locator('.data-status .data-vfs').textContent())?.trim();
  expect(['opfs-sahpool', 'memory']).toContain(vfs);

  await page.locator('.data-oracle > summary').click();
  await page.locator('.data-oracle-run').click();
  await expect(page.locator('.data-oracle-report')).toHaveAttribute('data-status', 'done', RAN);

  // every answer, as the page published it
  const report = JSON.parse(/** @type {string} */ (await page.locator('.data-oracle-results').textContent()));
  expect(report.executor).toBe(EXECUTOR);
  expect(report.vfs).toBe(vfs);

  // every runnable entry, under every mapping, answered what the engine
  // recorded — asserted from the fixture, with a message that names the
  // executor, the mapping, the entry and the query
  for (const mapping of MAPPINGS) {
    for (const entry of RUNNABLE) {
      const where = `${EXECUTOR} (${mapping}) on ${entry.name} — query ${JSON.stringify(entry.query)}`;
      const result = report.results.find((r) => r.mapping === mapping && r.name === entry.name);
      expect(result, `${where}: the browser runner never ran it`).toBeDefined();
      expect(result.error, `${where}: the store refused it`).toBeUndefined();
      if (entry.empty === true) {
        expect(result.empty, `${EXECUTOR} disagreed on ${entry.name} (${mapping}): recorded the empty sequence,`
          + ` answered ${JSON.stringify(result.answer)} — query ${JSON.stringify(entry.query)}`).toBe(true);
        continue;
      }
      expect(result.empty, `${EXECUTOR} disagreed on ${entry.name} (${mapping}): recorded`
        + ` ${JSON.stringify(entry.expected)}, answered the empty sequence — query ${JSON.stringify(entry.query)}`)
        .toBe(false);
      expect(result.answer, `${EXECUTOR} disagreed on ${entry.name} (${mapping}): recorded`
        + ` ${JSON.stringify(entry.expected)}, answered ${JSON.stringify(result.answer)}`
        + ` — query ${JSON.stringify(entry.query)}`).toStrictEqual(entry.expected);
    }
  }

  // the count, not the absence of failures
  expect(RUNNABLE.length, 'the corpus has entries to run').toBeGreaterThan(0);
  expect(report.results.length, `${EXECUTOR} ran every runnable entry under every mapping`)
    .toBe(RUNNABLE.length * MAPPINGS.length);
  expect(report.ran).toBe(RUNNABLE.length * MAPPINGS.length);
  expect(report.agreed).toBe(report.ran);
  // and what it did not run, it did not run BY THE MARKER
  expect([...report.skipped].sort()).toEqual([...MARKED].sort());

  // the page's own verdict says the same, where a reader looks
  await expect(page.locator('.data-oracle-summary'))
    .toContainText(`${EXECUTOR} agreed with the engine on every entry: ${report.ran} / ${report.ran}`);
  await expect(page.locator('.data-oracle-disagreements')).toHaveCount(0);

  expect(errors, 'no uncaught page errors').toEqual([]);
});
