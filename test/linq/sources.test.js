//@ts-check
/**
 * @file Source adapters (LINQ-FORMAT.md §12): the cursor shape, the
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
