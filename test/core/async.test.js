//@ts-check
/**
 * @file `@jarenjs/core/async` — the bounded ordered map, one clause of
 * its contract per test: the bound is measured (a counter records the
 * most workers ever inside at once), the order is proven with workers
 * that finish out of order, and every way the map can stop — a bad
 * limit, a rejection, an abort before or during — leaves no worker
 * running when the promise settles.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { mapConcurrent } from '@jarenjs/core/async';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A worker that records how many are inside at once; odd items take longer. */
function meter() {
  let inside = 0;
  let max = 0;
  const started = [];
  const finished = [];
  return {
    get max() { return max; },
    started,
    finished,
    /** @param {number} item @param {number} index */
    async worker(item, index) {
      started.push(index);
      inside++;
      max = Math.max(max, inside);
      await sleep(item % 2 === 1 ? 12 : 2);
      inside--;
      finished.push(index);
      return item * 10;
    },
  };
}

describe('core/async — mapConcurrent', function () {
  it('never runs more than `limit` workers at once and answers in input order', async function () {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const m = meter();
    const out = await mapConcurrent(items, 3, m.worker);
    assert.deepStrictEqual(out, items.map((i) => i * 10));
    assert.strictEqual(m.max, 3, 'the bound is reached and never exceeded');
    assert.notDeepStrictEqual(m.finished, [...m.finished].sort((a, b) => a - b),
      'the workers finished out of order (odd items are slower), so the order was restored');
  });

  it('Infinity is unbounded: every item is in flight at once', async function () {
    const items = Array.from({ length: 7 }, (_, i) => i);
    const m = meter();
    await mapConcurrent(items, Infinity, m.worker);
    assert.strictEqual(m.max, 7);
  });

  it('a limit of 1 is sequential', async function () {
    const m = meter();
    await mapConcurrent([1, 2, 3], 1, m.worker);
    assert.strictEqual(m.max, 1);
    assert.deepStrictEqual(m.finished, [0, 1, 2]);
  });

  it('refuses 0, a negative, NaN and a string limit with a TypeError — never a silent clamp', async function () {
    for (const limit of [0, -1, NaN, '2', undefined, 0.5]) {
      await assert.rejects(() => mapConcurrent([1], /** @type {any} */ (limit), async (x) => x), TypeError,
        `limit ${String(limit)}`);
    }
  });

  it('answers [] for no items without touching the worker', async function () {
    let calls = 0;
    assert.deepStrictEqual(await mapConcurrent([], 4, async () => { calls++; }), []);
    assert.strictEqual(calls, 0);
  });

  it('an already-aborted signal rejects with its reason before any worker runs', async function () {
    const controller = new AbortController();
    const reason = new Error('never started');
    controller.abort(reason);
    let calls = 0;
    await assert.rejects(
      () => mapConcurrent([1, 2], 2, async () => { calls++; }, { signal: controller.signal }),
      (err) => err === reason);
    assert.strictEqual(calls, 0);
  });

  it('an abort mid-run stops dispatch, waits for the workers in flight, then rejects with the reason', async function () {
    const controller = new AbortController();
    const reason = new Error('stop now');
    const items = Array.from({ length: 10 }, (_, i) => i);
    const started = [];
    const exited = new Set();
    const worker = async (item, index) => {
      started.push(index);
      await sleep(index === 1 ? 1 : 15);
      // aborted from INSIDE a worker after the lanes filled: nothing may
      // start after this, and the two slower workers must still finish
      if (index === 1) controller.abort(reason);
      exited.add(index);
      return item;
    };
    await assert.rejects(() => mapConcurrent(items, 3, worker, { signal: controller.signal }),
      (err) => err === reason);
    assert.deepStrictEqual(started, [0, 1, 2], 'the three lanes started their first items and nothing more');
    assert.deepStrictEqual([...exited].sort(), [0, 1, 2], 'every in-flight worker had finished when the map settled');
  });

  it('a worker rejection stops dispatch, drains the lanes, then rejects with the FIRST error', async function () {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const started = [];
    const exited = new Set();
    const first = new Error('first');
    const worker = async (item, index) => {
      started.push(index);
      await sleep(index === 1 ? 1 : 15);
      exited.add(index);
      if (index === 1) throw first;
      if (index === 2) throw new Error('second');
      return item;
    };
    await assert.rejects(() => mapConcurrent(items, 3, worker), (err) => err === first);
    assert.deepStrictEqual(started, [0, 1, 2]);
    assert.deepStrictEqual([...exited].sort(), [0, 1, 2]);
  });

  it('a synchronous throw from the worker is a rejection', async function () {
    const boom = new Error('sync');
    await assert.rejects(() => mapConcurrent([1, 2, 3], 2, () => { throw boom; }), (err) => err === boom);
  });

  it('passes the index beside the item', async function () {
    const seen = await mapConcurrent(['a', 'b'], 2, async (item, index) => `${index}:${item}`);
    assert.deepStrictEqual(seen, ['0:a', '1:b']);
  });
});
