//@ts-check
/**
 * @file Source adapters (QUERY-PEN.md §12): the cursor shape, the
 * push queue with its high-water mark, sync iterables, and the josl
 * CSV end-to-end — `iterateCsvStream` into a linq chain with the live
 * set measured flat after a forced GC (in a subprocess, per the
 * measurement discipline: raw heapUsed lies about retention).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';

import { fromAsync, createPushQueue } from '@jarenjs/linq';

describe('source adapters', () => {
  it('a cursor ({ next, return? }) adapts and closes', async () => {
    let i = 0;
    let closed = false;
    const cursor = {
      async next() {
        return i < 5 ? { done: false, value: { n: i++ } } : { done: true, value: undefined };
      },
      async return() { closed = true; return { done: true, value: undefined }; },
    };
    const out = await fromAsync(cursor).where((r) => r.n.mod(2).eq(0)).take(2)
      .select((r) => r.n).toArray();
    assert.deepStrictEqual(out, [0, 2]);
    assert.strictEqual(closed, true);
  });

  it('a sync iterable adapts', async () => {
    assert.deepStrictEqual(await fromAsync(new Set([1, 2, 3])).select((n) => n.add(1)).toArray(),
      [2, 3, 4]);
  });

  it('a useless source is JL0001 at fromAsync() time', () => {
    assert.throws(() => fromAsync(42), (e) => e.code === 'JL0001');
    assert.throws(() => fromAsync('strings are chunk sources, not char streams here'),
      (e) => e.code === 'JL0001');
  });

  it('the push queue bridges feed/end readers, with a high-water hint', async () => {
    const queue = createPushQueue({ highWaterMark: 2 });
    assert.strictEqual(queue.feed(1), true);
    assert.strictEqual(queue.feed(2), true);
    assert.strictEqual(queue.feed(3), false, 'over the mark: a pause HINT, not a stop');
    const consumed = fromAsync(queue).select((n) => n.mul(10)).toArray();
    queue.feed(4);
    queue.end();
    assert.deepStrictEqual(await consumed, [10, 20, 30, 40]);
  });

  it('the push queue propagates a failure from end(error)', async () => {
    const queue = createPushQueue();
    const consumed = fromAsync(queue).toArray();
    queue.feed(1);
    queue.end(new Error('reader failed'));
    await assert.rejects(() => consumed, /reader failed/);
  });
});

describe('the josl CSV end-to-end', () => {
  it('iterateCsvStream feeds a linq chain', async () => {
    const { iterateCsvStream } = await import('@jarenjs/josl');
    async function* chunks() {
      yield 'name,age\nada,36\nkid,8\nlin,64\n';
    }
    const adults = await fromAsync(iterateCsvStream(chunks(), { headers: true }))
      // CSV fields are strings: two digits means an adult in this fixture
      .where((r) => r.get('age').length().ge(2))
      .select((r) => r.get('name'))
      .toArray();
    assert.deepStrictEqual(adults, ['ada', 'lin']);
  });

  it('holds the live set flat over a large stream (forced GC, subprocess)', () => {
    const script = `
      import { fromAsync } from '@jarenjs/linq';
      import { iterateCsvStream } from '@jarenjs/josl';
      async function* chunks() {
        for (let block = 0; block < 200; block++) {
          let text = '';
          for (let i = 0; i < 500; i++) {
            const n = block * 500 + i;
            text += 'row' + n + ',' + n + ',' + 'x'.repeat(64) + '\\n';
          }
          yield text;
        }
      }
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      let count = 0;
      for await (const name of fromAsync(iterateCsvStream(chunks()))
        .where((r) => r.at(1).exists())
        .select((r) => r.at(0))) {
        count++;
      }
      globalThis.gc();
      const after = process.memoryUsage().heapUsed;
      console.log(JSON.stringify({ count, growthMb: (after - before) / 1048576 }));
    `;
    const out = execFileSync(process.execPath,
      ['--no-warnings=ExperimentalWarning', '--expose-gc', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: process.cwd() });
    const { count, growthMb } = JSON.parse(out.trim().split('\n').pop() ?? '{}');
    assert.strictEqual(count, 100000, 'every row streamed through');
    assert.strictEqual(growthMb < 8, true,
      `live set grew ${growthMb.toFixed(2)} MB over 100k rows — must stay flat`);
  });
});

describe('the push queue', () => {
  /** @param {AsyncIterable<any>} source */
  async function drain(source) {
    const out = [];
    for await (const value of source) out.push(value);
    return out;
  }

  it('ends once: a second end() does not erase the failure the first one carried', async () => {
    const failed = createPushQueue();
    failed.feed(1);
    failed.end(new Error('reader failed'));
    failed.end();
    await assert.rejects(() => drain(failed), /reader failed/);

    const twice = createPushQueue();
    twice.end(new Error('first'));
    twice.end(new Error('second'));
    await assert.rejects(() => drain(twice), /first/);

    const clean = createPushQueue();
    clean.feed('a');
    clean.end();
    clean.end(new Error('too late'));
    assert.deepStrictEqual(await drain(clean), ['a']);
  });

  it('two readers waiting on an empty queue are both released', async () => {
    const queue = createPushQueue();
    const first = drain(queue);
    const second = drain(queue);
    await new Promise((resolve) => setTimeout(resolve, 5));
    queue.feed(1);
    queue.feed(2);
    queue.end();
    const [a, b] = await Promise.race([
      Promise.all([first, second]),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);
    assert.notStrictEqual(a, undefined, 'a reader that waited was woken');
    assert.deepStrictEqual([...a, ...b].sort(), [1, 2], 'between them, every value exactly once');
  });

  it('a queue fed far ahead of its reader drains in linear time, in order, and reports the mark by what is unread', async () => {
    const queue = createPushQueue({ highWaterMark: 4 });
    assert.deepStrictEqual([1, 2, 3, 4, 5].map((n) => queue.feed(n)), [true, true, true, true, false]);
    const reader = queue[Symbol.asyncIterator]();
    for (let n = 1; n <= 3; n++) assert.strictEqual((await reader.next()).value, n);
    assert.strictEqual(queue.feed(6), true, 'three read: three unread, then four, within the mark');
    assert.strictEqual(queue.feed(7), true);
    assert.strictEqual(queue.feed(8), false, 'five unread exceeds a mark of four');
    await reader.return();

    /** The fastest of three drains of `count` values fed ahead of the reader. */
    const drain = async (/** @type {number} */ count) => {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const big = createPushQueue({ highWaterMark: Number.MAX_SAFE_INTEGER });
        for (let n = 0; n < count; n++) big.feed(n);
        big.end();
        const started = performance.now();
        let expected = 0;
        for await (const value of big) {
          if (value !== expected) assert.fail(`out of order at ${expected}: ${value}`);
          expected++;
        }
        assert.strictEqual(expected, count);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    // eight times the values: a linear drain takes about eight times as long, the
    // quadratic one it replaced (a shift() per value) about sixty-four times; a
    // ratio is steady on a loaded host where a wall-clock bound is not
    const small = await drain(50000);
    const large = await drain(400000);
    assert.strictEqual(large / Math.max(small, 1) < 24, true, `50000 values took ${small.toFixed(1)} ms, 400000 took ${large.toFixed(1)} ms`);
  });
});
