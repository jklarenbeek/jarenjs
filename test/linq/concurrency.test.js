//@ts-check
/**
 * @file `mapAsync` (QUERY-PEN.md §11): the bound is enforced (a
 * counting callback proves the window), the bound is REQUIRED, the four
 * modes behave per the `createTaskEffect` vocabulary, ordering is a
 * choice, abort threads through, and failure is fail-closed.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { fromAsync } from '@jarenjs/linq';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('mapAsync', () => {
  it('never exceeds its concurrency limit (counting callback)', async () => {
    let inflight = 0;
    let peak = 0;
    const out = await fromAsync([1, 2, 3, 4, 5, 6, 7, 8])
      .mapAsync(async (n) => {
        inflight++;
        peak = Math.max(peak, inflight);
        await tick();
        inflight--;
        return n * 2;
      }, { concurrency: 3 })
      .toArray();
    assert.deepStrictEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
    assert.strictEqual(peak <= 3, true, `peak in-flight was ${peak}`);
    assert.strictEqual(peak > 1, true, 'it actually ran concurrently');
  });

  it('a missing or invalid limit is JL0005 at build time', () => {
    assert.throws(() => fromAsync([]).mapAsync(async (n) => n, /** @type {any} */ (undefined)),
      (e) => e.code === 'JL0005');
    assert.throws(() => fromAsync([]).mapAsync(async (n) => n, { concurrency: 0 }),
      (e) => e.code === 'JL0005');
    assert.throws(() => fromAsync([]).mapAsync(async (n) => n,
      /** @type {any} */ ({ concurrency: 2, mode: 'yolo' })),
    (e) => e.code === 'JL0005');
  });

  it('ordered (default) preserves source order even when later items finish first', async () => {
    const out = await fromAsync([30, 1, 20, 2])
      .mapAsync(async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return ms;
      }, { concurrency: 4 })
      .toArray();
    assert.deepStrictEqual(out, [30, 1, 20, 2]);
  });

  it('unordered yields on completion', async () => {
    const out = await fromAsync([30, 1, 20, 2])
      .mapAsync(async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return ms;
      }, { concurrency: 4, ordered: false })
      .toArray();
    assert.deepStrictEqual([...out].sort((a, b) => a - b), [1, 2, 20, 30]);
    assert.notDeepStrictEqual(out, [30, 1, 20, 2], 'completion order, not source order');
  });

  it('concat runs strictly sequentially', async () => {
    let inflight = 0;
    let peak = 0;
    await fromAsync([1, 2, 3])
      .mapAsync(async (n) => {
        inflight++;
        peak = Math.max(peak, inflight);
        await tick();
        inflight--;
        return n;
      }, { concurrency: 8, mode: 'concat' })
      .toArray();
    assert.strictEqual(peak, 1);
  });

  it('exhaust drops items that arrive while one is in flight', async () => {
    const out = await fromAsync([1, 2, 3, 4])
      .mapAsync(async (n) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return n;
      }, { concurrency: 1, mode: 'exhaust' })
      .toArray();
    assert.strictEqual(out[0], 1, 'the first item always runs');
    assert.strictEqual(out.length < 4, true, `later items dropped while busy (got ${out.length})`);
  });

  it('switch supersedes the in-flight task and aborts it', async () => {
    const aborted = [];
    const out = await fromAsync([1, 2, 3])
      .mapAsync(async (n, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (signal.aborted) aborted.push(n);
        return n;
      }, { concurrency: 1, mode: 'switch' })
      .toArray();
    assert.strictEqual(out[out.length - 1], 3, 'the latest item wins');
    assert.strictEqual(aborted.length >= 1, true, 'superseded tasks saw their abort');
  });

  it('the first rejection fails closed: in-flight work aborts, the source closes', async () => {
    const signals = [];
    let closed = false;
    const source = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() { return i < 8 ? { done: false, value: i++ } : { done: true, value: undefined }; },
          async return() { closed = true; return { done: true, value: undefined }; },
        };
      },
    };
    await assert.rejects(() => fromAsync(source)
      .mapAsync(async (n, signal) => {
        signals.push(signal);
        if (n === 2) throw new Error('boom');
        await new Promise((resolve) => setTimeout(resolve, 20));
        return n;
      }, { concurrency: 4 })
      .toArray(), /boom/);
    assert.strictEqual(closed, true, 'the source was closed');
    assert.strictEqual(signals.some((s) => s.aborted), true, 'in-flight callbacks were aborted');
  });

  it('early termination downstream aborts the boundary', async () => {
    const signals = [];
    const out = await fromAsync([1, 2, 3, 4, 5, 6])
      .mapAsync(async (n, signal) => {
        signals.push(signal);
        await tick();
        return n;
      }, { concurrency: 3 })
      .take(2)
      .toArray();
    assert.deepStrictEqual(out, [1, 2]);
    await tick();
    assert.strictEqual(signals.some((s) => s.aborted), true,
      'the abandoned in-flight callbacks saw the abort');
  });
});
