//@ts-check
/**
 * @file `@jarenjs/core/async` — the bounded ordered map, one clause of
 * its contract per test: the bound is measured (a counter records the
 * most workers ever inside at once), the order is proven with workers
 * that finish out of order, and every way the map can stop — a bad
 * limit, a rejection, an abort before or during — leaves no worker
 * running when the promise settles. Then the awaited sink, one clause
 * per test too: the fast path answers no promise, an asynchronous
 * underlying write is never overlapped, a failure stops what is queued
 * behind it, and end/abort are exactly-once and mutually terminal.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { mapConcurrent, createAwaitedSink } from '@jarenjs/core/async';

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

/** A deferred: a promise with its settlers in hand. */
function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every settled microtask run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('core/async — createAwaitedSink', function () {
  it('refuses a value without a write function', function () {
    for (const bad of [null, undefined, {}, { write: 'x' }, 5]) {
      assert.throws(() => createAwaitedSink(/** @type {any} */ (bad)), TypeError, String(bad));
    }
  });

  it('a synchronous sink stays on the fast path: write answers undefined, order is kept, end runs once after every write', async function () {
    const seen = [];
    let ended = 0;
    const sink = createAwaitedSink({ write: (c) => { seen.push(c); }, end: () => { ended++; } });
    assert.strictEqual(sink.write('a'), undefined);
    assert.strictEqual(sink.write('b'), undefined);
    const end = sink.end();
    assert.ok(end instanceof Promise);
    assert.strictEqual(ended, 1, 'end ran synchronously behind synchronous writes');
    await end;
    assert.deepStrictEqual(seen, ['a', 'b']);
    assert.strictEqual(sink.end(), end, 'a repeated end answers the same promise');
    assert.strictEqual(ended, 1);
    assert.strictEqual(sink.closed(), true);
    assert.strictEqual(sink.failed(), false);
    await assert.rejects(/** @type {Promise<void>} */ (sink.write('c')), /write after end/);
    assert.deepStrictEqual(seen, ['a', 'b'], 'nothing reaches the sink after end');
  });

  it('an asynchronous sink is serialized: the next underlying write begins only after the previous one settled', async function () {
    const started = [];
    const gates = [];
    const sink = createAwaitedSink({
      write: (c) => {
        started.push(c);
        const d = deferred();
        gates.push(d);
        return d.promise;
      },
    });
    const first = sink.write('a');
    const second = sink.write('b');
    const third = sink.write('c');
    assert.ok(first instanceof Promise && second instanceof Promise && third instanceof Promise);
    await tick();
    assert.deepStrictEqual(started, ['a'], 'b waits for a');
    gates[0].resolve();
    await first;
    await tick();
    assert.deepStrictEqual(started, ['a', 'b'], 'b started once a settled; c still waits');
    gates[1].resolve();
    await second;
    await tick();
    assert.deepStrictEqual(started, ['a', 'b', 'c']);
    gates[2].resolve();
    await third;
    // the queue is idle again: a synchronous answer returns to the fast path
    const sync = createAwaitedSink({ write: () => undefined });
    assert.strictEqual(sync.write('x'), undefined);
  });

  it('an idle queue returns to the fast path after its promise settled', async function () {
    let async = true;
    const sink = createAwaitedSink({ write: () => (async ? Promise.resolve() : undefined) });
    const p = sink.write('a');
    assert.ok(p instanceof Promise);
    await p;
    async = false;
    assert.strictEqual(sink.write('b'), undefined, 'nothing pending and a synchronous answer: no promise');
  });

  it('a rejected write fails the sink: the queued writes reject with the same reason and never reach the sink, later writes reject at once, end rejects', async function () {
    const reached = [];
    const boom = new Error('socket gone');
    const gate = deferred();
    const sink = createAwaitedSink({
      write: (c) => {
        reached.push(c);
        return c === 'a' ? gate.promise : undefined;
      },
      end: () => { reached.push('end'); },
    });
    const a = sink.write('a');
    const b = sink.write('b');
    const end = sink.end();
    gate.reject(boom);
    await assert.rejects(/** @type {Promise<void>} */ (a), (e) => e === boom);
    await assert.rejects(/** @type {Promise<void>} */ (b), (e) => e === boom);
    await assert.rejects(end, (e) => e === boom);
    await assert.rejects(/** @type {Promise<void>} */ (sink.write('c')), (e) => e === boom);
    assert.deepStrictEqual(reached, ['a'], 'neither b, c nor end reached the sink');
    assert.strictEqual(sink.failed(), true);
  });

  it('a synchronous throw from the sink is a rejection of that write and fails the sink', async function () {
    const boom = new Error('sync');
    const sink = createAwaitedSink({ write: () => { throw boom; } });
    await assert.rejects(/** @type {Promise<void>} */ (sink.write('a')), (e) => e === boom);
    await assert.rejects(/** @type {Promise<void>} */ (sink.write('b')), (e) => e === boom);
    await assert.rejects(sink.end(), (e) => e === boom);
  });

  it('a throwing then getter rejects an idle write and fails later writes and end', async function () {
    const boom = new Error('then getter');
    const reached = [];
    const sink = createAwaitedSink({ write: (chunk) => {
      reached.push(chunk);
      return { get then() { throw boom; } };
    } });
    const first = sink.write('a');
    assert.ok(first instanceof Promise, 'write must not throw synchronously');
    await assert.rejects(first, (err) => err === boom);
    assert.strictEqual(sink.failed(), true);
    await assert.rejects(/** @type {Promise<void>} */ (sink.write('b')), (err) => err === boom);
    await assert.rejects(sink.end(), (err) => err === boom);
    assert.deepStrictEqual(reached, ['a']);
  });

  it('a throwing then getter in a queued write settles the whole queue with the same failure', async function () {
    const gate = deferred();
    const boom = new Error('queued then getter');
    const reached = [];
    const sink = createAwaitedSink({
      write: (chunk) => {
        reached.push(chunk);
        return chunk === 'a' ? gate.promise : { get then() { throw boom; } };
      },
      end: () => { reached.push('end'); },
    });
    const results = Promise.allSettled([sink.write('a'), sink.write('b'), sink.write('c'), sink.end()]);
    gate.resolve();
    assert.deepStrictEqual(await results, [
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: boom },
      { status: 'rejected', reason: boom },
      { status: 'rejected', reason: boom },
    ]);
    assert.strictEqual(sink.failed(), true);
    assert.deepStrictEqual(reached, ['a', 'b']);
  });

  it('a throwing then getter from end rejects its repeatable terminal promise', async function () {
    const boom = new Error('end then getter');
    const sink = createAwaitedSink({ write: () => undefined, end: () => ({ get then() { throw boom; } }) });
    const end = sink.end();
    await assert.rejects(end, (err) => err === boom);
    assert.strictEqual(sink.end(), end);
    assert.strictEqual(sink.failed(), true);
  });

  it('abort runs the underlying abort once, at once, rejects the queued writes with the reason, and is terminal with end', async function () {
    const reached = [];
    const aborts = [];
    const gate = deferred();
    const sink = createAwaitedSink({
      write: (c) => {
        reached.push(c);
        return gate.promise;
      },
      end: () => { reached.push('end'); },
      abort: (reason) => { aborts.push(reason); },
    });
    const a = sink.write('a');
    const b = sink.write('b');
    const why = new Error('cancelled');
    const aborted = sink.abort(why);
    assert.deepStrictEqual(aborts, [why], 'the underlying abort ran immediately, not behind the pending write');
    assert.strictEqual(sink.abort(why), aborted, 'a repeated abort answers the same promise');
    assert.strictEqual(sink.end(), aborted, 'end after abort answers the abort');
    await aborted;
    await assert.rejects(/** @type {Promise<void>} */ (b), (e) => e === why, 'the queued write rejects with the reason');
    await assert.rejects(/** @type {Promise<void>} */ (sink.write('c')), (e) => e === why);
    gate.resolve();
    await a;
    assert.deepStrictEqual(reached, ['a'], 'b, c and end never reached the sink');
    assert.deepStrictEqual(aborts, [why], 'exactly one underlying abort');
    assert.strictEqual(sink.closed(), true);
    assert.strictEqual(sink.failed(), true);
  });

  it('abort without a reason rejects with an Error; abort after end answers the end', async function () {
    const sink = createAwaitedSink({ write: () => Promise.resolve() });
    const p = sink.write('a');
    const q = sink.write('b');
    sink.abort();
    await p;
    await assert.rejects(/** @type {Promise<void>} */ (q), (e) => e instanceof Error && /aborted/.test(e.message));
    const other = createAwaitedSink({ write: () => undefined, abort: () => { throw new Error('never'); } });
    const end = other.end();
    assert.strictEqual(other.abort(new Error('late')), end, 'abort after end answers the end promise and never runs the underlying abort');
    await end;
  });

  it('a throwing or rejecting underlying abort rejects the abort promise, once', async function () {
    const boom = new Error('abort failed');
    const sink = createAwaitedSink({ write: () => undefined, abort: () => { throw boom; } });
    const first = sink.abort(new Error('x'));
    await assert.rejects(first, (e) => e === boom);
    assert.strictEqual(sink.abort(new Error('y')), first);
    const rejecting = createAwaitedSink({ write: () => undefined, abort: () => Promise.reject(boom) });
    await assert.rejects(rejecting.abort(new Error('z')), (e) => e === boom);
  });

  it('end waits for the pending write, and a rejecting end rejects the end promise', async function () {
    const gate = deferred();
    const order = [];
    const sink = createAwaitedSink({ write: () => gate.promise, end: () => { order.push('end'); } });
    sink.write('a');
    const end = sink.end();
    await tick();
    assert.deepStrictEqual(order, [], 'end waits for the write');
    gate.resolve();
    await end;
    assert.deepStrictEqual(order, ['end']);
    const failing = createAwaitedSink({ write: () => undefined, end: () => Promise.reject(new Error('end failed')) });
    await assert.rejects(failing.end(), /end failed/);
  });
});
