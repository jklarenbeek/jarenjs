//@ts-check
/**
 * @file The bounded change reader (LIVE-FORMAT §5): `changes.bounds()`
 * answers the log's two watermarks, and `changes.page()` never exceeds
 * its `limit` or `maxBytes`, reports `hasMore` exactly, and — the
 * dangerous case — answers a cursor below the retention floor with
 * `resetRequired: true`, no items and no `next`, where `changesSince`
 * would have answered a misleading suffix. A record larger than
 * `maxBytes` is the one `item_too_large` implementation every page
 * shares; cancellation reads no further record; the transaction view
 * pins the reader to its scope.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { openStore, PAGE_LIMIT_DEFAULT } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { statementCountingDriver } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } },
      key: '/id',
    },
  },
};

const codeIs = (code, pattern = undefined) => (error) =>
  error.code === code && (pattern === undefined || pattern.test(error.message));

/** A logged store with `count` inserts of widely varying body size. */
async function logged(count, options = {}, driver = nodeDriver()) {
  const store = await openStore(MODEL, { driver, capture: { log: { retention: 1000, ...options } } });
  const sizes = [8, 3000, 40, 900, 1600, 16];
  for (let i = 1; i <= count; i++) {
    await store.collection('notes').insert({ id: `n${i}`, body: 'b'.repeat(sizes[(i - 1) % sizes.length]) });
  }
  return store;
}

const bytesOf = (record) => Buffer.byteLength(JSON.stringify(record.patch), 'utf8');

/** Every page from `after` until the log says there is no more. */
async function drain(store, after, options) {
  const pages = [];
  let cursor = after;
  for (;;) {
    const page = await store.changes.page({ ...options, after: cursor });
    pages.push(page);
    if (!page.hasMore) return pages;
    cursor = page.next;
  }
}

describe('no change page exceeds limit or maxBytes', () => {
  it('over records of widely varying patch size, every page is within both bounds and the union is the whole log', async () => {
    const store = await logged(14);
    const whole = await store.changesSince(0);
    assert.strictEqual(whole.length, 14);
    for (const options of [{ limit: 4 }, { limit: 4, maxBytes: 4000 }, { limit: 1 }, { limit: 50, maxBytes: 3200 }]) {
      const pages = await drain(store, 0, options);
      const seqs = [];
      for (const page of pages) {
        assert.ok(page.items.length <= options.limit, `limit ${options.limit}`);
        if (options.maxBytes !== undefined) {
          const bytes = page.items.reduce((sum, record) => sum + bytesOf(record), 0);
          assert.ok(bytes <= options.maxBytes, `maxBytes ${options.maxBytes}: ${bytes}`);
        }
        assert.strictEqual(page.resetRequired, false);
        assert.strictEqual(page.next, page.items.length > 0 ? page.items.at(-1).seq : 0);
        seqs.push(...page.items.map((record) => record.seq));
      }
      assert.deepStrictEqual(seqs, whole.map((record) => record.seq), JSON.stringify(options));
      assert.deepStrictEqual(pages.map((page) => page.items).flat(), whole);
    }
    // the default limit is the shared constant
    const defaulted = await store.changes.page({ after: 0 });
    assert.strictEqual(defaulted.items.length, 14);
    assert.strictEqual(PAGE_LIMIT_DEFAULT, 100);
    await store.close();
  });

  it('hasMore is true exactly when records remain above next, and bounds agree with a concurrent bounds() call', async () => {
    const store = await logged(7);
    const pages = await drain(store, 0, { limit: 3 });
    assert.deepStrictEqual(pages.map((page) => [page.items.map((r) => r.seq), page.next, page.hasMore]),
      [[[1, 2, 3], 3, true], [[4, 5, 6], 6, true], [[7], 7, false]]);
    const bounds = await store.changes.bounds();
    assert.deepStrictEqual(bounds, { earliestAvailable: 1, highWatermark: 7 });
    for (const page of pages) {
      assert.strictEqual(page.earliestAvailable, bounds.earliestAvailable);
      assert.strictEqual(page.highWatermark, bounds.highWatermark);
    }
    // caught up: nothing delivered, next stays where it was, no reset
    const tail = await store.changes.page({ after: 7, limit: 3 });
    assert.deepStrictEqual(tail, { items: [], next: 7, earliestAvailable: 1, highWatermark: 7, hasMore: false, resetRequired: false });
    await store.close();
  });
});

describe('a cursor before the retention floor returns reset metadata and no partial continuation', () => {
  it('with the floor raised above the requested after: resetRequired, items empty, no next — where changesSince answers a suffix', async () => {
    const store = await logged(5, { retention: 3 });
    assert.deepStrictEqual(await store.changes.bounds(), { earliestAvailable: 3, highWatermark: 5 });
    // the record after `after` is gone: 1 and 2 were pruned
    for (const after of [0, 1]) {
      const page = await store.changes.page({ after, limit: 10 });
      assert.deepStrictEqual(page, { items: [], earliestAvailable: 3, highWatermark: 5, hasMore: false, resetRequired: true });
      assert.strictEqual('next' in page, false, 'no continuation at all');
    }
    // the misleading suffix the unbounded read still answers
    assert.deepStrictEqual((await store.changesSince(0)).map((r) => r.seq), [3, 4, 5]);
    // the record after `after` survives: a continuation, not a reset
    const usable = await store.changes.page({ after: 2, limit: 10 });
    assert.deepStrictEqual(usable.items.map((r) => r.seq), [3, 4, 5]);
    assert.deepStrictEqual([usable.next, usable.hasMore, usable.resetRequired], [5, false, false]);
    // the recovery procedure: re-seed, resume at the high watermark
    const resumed = await store.changes.page({ after: usable.highWatermark, limit: 10 });
    assert.deepStrictEqual([resumed.items, resumed.next, resumed.resetRequired], [[], 5, false]);
    await store.close();
  });

  it('nothing prunes the log but retention itself: a generous retention never resets', async () => {
    const store = await logged(6, { retention: 1000 });
    const page = await store.changes.page({ after: 0, limit: 100 });
    assert.strictEqual(page.resetRequired, false);
    assert.strictEqual(page.items.length, 6);
    await store.close();
  });
});

describe('item_too_large', () => {
  it('a single record larger than maxBytes is JD2074 without advancing next, and does not loop', async () => {
    const store = await logged(4);
    const first = await store.changes.page({ after: 0, limit: 10, maxBytes: 600 });
    assert.deepStrictEqual(first.items.map((r) => r.seq), [1], 'the page ended before the record that did not fit');
    assert.deepStrictEqual([first.next, first.hasMore], [1, true]);
    const tooLarge = codeIs('JD2074', /the next item is \d+ serialised bytes, more than the page's maxBytes bound of 600/);
    await assert.rejects(() => store.changes.page({ after: first.next, limit: 10, maxBytes: 600 }), tooLarge);
    await assert.rejects(() => store.changes.page({ after: first.next, limit: 10, maxBytes: 600 }), (error) => {
      assert.strictEqual(error.errors[0].at, 2, 'the refusal names the record that did not fit');
      return tooLarge(error);
    });
    const raised = await store.changes.page({ after: first.next, limit: 10, maxBytes: 8000 });
    assert.deepStrictEqual(raised.items.map((r) => r.seq), [2, 3, 4]);
    await store.close();
  });

  it('one implementation: the change page drains the shared cursor and raises no JD2074 of its own', () => {
    const capture = fs.readFileSync('packages/db/src/capture.js', 'utf8');
    assert.match(capture, /drainPage\(cursor, \{/);
    assert.doesNotMatch(capture, /'JD2074'/);
    assert.match(capture, /createCursor\(\{ streaming: 'row'/, 'the log is read through the one cursor');
    assert.doesNotMatch(capture.slice(capture.indexOf('function readPage')), /\.all\(/,
      'the bounded read pulls one record per row');
  });
});

describe('cancellation and the wrong arguments', () => {
  it('an aborted signal reads no further record', async () => {
    const counters = { iterate: 0, next: 0, return: 0, all: 0 };
    const store = await logged(6, {}, statementCountingDriver(counters));
    counters.next = 0;
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(() => store.changes.page({ after: 0, limit: 5, signal: aborted.signal }), codeIs('JD2072'));
    assert.strictEqual(counters.next, 0, 'no record was read');
    const midway = new AbortController();
    const started = store.changes.page({ after: 0, limit: 5, signal: midway.signal });
    queueMicrotask(() => midway.abort());
    await assert.rejects(() => started, codeIs('JD2072'));
    assert.ok(counters.next <= 2, `the abort stopped the drain at a record boundary (${counters.next} pulls)`);
    assert.strictEqual(counters.return, 1, 'the statement was released once');
    await store.close();
  });

  it('no log is JD2051; a missing after, a bad limit or a bad byte bound are API misuse', async () => {
    const plain = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    assert.strictEqual(plain.changes, undefined, 'the reader exists exactly when the log does');
    await plain.close();
    const store = await logged(2);
    await assert.rejects(() => store.changes.page(/** @type {any} */ ({})), TypeError);
    await assert.rejects(() => store.changes.page({ after: 0, limit: 0 }), TypeError);
    await assert.rejects(() => store.changes.page({ after: 0, maxBytes: -1 }), TypeError);
    await store.close();
  });

  it('a transaction view reads the log inside its scope and refuses after it', async () => {
    const store = await logged(3);
    /** @type {any} */
    let reader = null;
    await store.transaction(async (tx) => {
      await tx.collection('notes').insert({ id: 'inside', body: 'x' });
      const page = await tx.changes.page({ after: 0, limit: 10 });
      assert.strictEqual(page.items.length, 3, 'a record persists with its commit, so the open write is not logged yet');
      reader = tx.changes;
    });
    await assert.rejects(() => reader.bounds(), codeIs('JD2070'));
    await assert.rejects(() => reader.page({ after: 0 }), codeIs('JD2070'));
    assert.deepStrictEqual(await store.changes.bounds(), { earliestAvailable: 1, highWatermark: 4 });
    await store.close();
  });
});
