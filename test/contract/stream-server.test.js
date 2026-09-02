//@ts-check
/**
 * @file The carrier-neutral stream runner on its own, with a recording
 * carrier that answers frames and whose writes the test settles by
 * hand: frames are written in source order and never overlapped, no
 * frame follows a terminal one, a write that rejects releases silently,
 * an asynchronous source `stop()`/`close()` is awaited in that order
 * before `done`, a silent stop ignores a late settlement, a reasoned
 * stop delivers its `end` frame behind the pending write; then replay
 * as pages — one page, many pages, the first page's watermark as the
 * target, live overlap deduplicated, an empty log with a durable
 * watermark, a malformed page, a rejecting page, a null page as the
 * refusal — the total reset with its folded snapshot id, the one
 * bounded queue at its count and byte bounds with `JC2096` past them,
 * and cancellation during a page load and during a blocked write.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { runSubscription, resolveStreamLimits, STREAM_LIMITS_DEFAULT } from '@jarenjs/contract/stream';

const CONTRACT = compileContract({
  $contract: '0.1',
  operations: {
    feed: {
      kind: 'subscribe',
      output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
      policy: { stream: { resume: 'replay' } },
    },
  },
});

/** The pipeline-route subset the runner reads. */
const ROUTE = /** @type {any} */ ({ op: CONTRACT.operations.feed, validateOutput: CONTRACT.operations.feed.output.validate });

/** A deferred: a promise with its settlers in hand. */
function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let settled microtasks and a macrotask run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A LIVE-shaped source whose stop/close may be asynchronous, with a
 * paged replay when given, counters and an event log.
 * @param {any} initial
 * @param {{ asyncStop?: boolean, asyncClose?: boolean, rejectStop?: boolean, rejectClose?: boolean, replay?: (after: number, options: any) => any }} [shape]
 */
function makeSource(initial, shape = {}) {
  /** @type {Set<(emission: any) => void>} */
  const cbs = new Set();
  const counts = { stops: 0, closes: 0 };
  /** @type {string[]} */
  const log = [];
  const sub = /** @type {any} */ ({
    result: initial,
    subscribe(/** @type {(emission: any) => void} */ cb) {
      cbs.add(cb);
      return () => {
        counts.stops += 1;
        cbs.delete(cb);
        if (shape.rejectStop) return Promise.reject(new Error('stop failed'));
        if (!shape.asyncStop) {
          log.push('stop');
          return undefined;
        }
        return new Promise((resolve) => setTimeout(() => { log.push('stop'); resolve(undefined); }, 5));
      };
    },
    close() {
      counts.closes += 1;
      if (shape.rejectClose) return Promise.reject(new Error('close failed'));
      if (!shape.asyncClose) {
        log.push('close');
        return undefined;
      }
      return new Promise((resolve) => setTimeout(() => { log.push('close'); resolve(undefined); }, 5));
    },
    ...(shape.replay === undefined ? {} : { replay: shape.replay }),
  });
  return {
    sub,
    counts,
    log,
    set: (/** @type {any} */ value) => { sub.result = value; },
    emit: (/** @type {any} */ emission) => { for (const cb of [...cbs]) cb(emission); },
  };
}

/**
 * A recording carrier on frames: every event hook answers a frame
 * `{ event, seq, data }`, `size` is its JSON length, `write` logs the
 * frame and answers a deferred the test settles (or nothing, when
 * `sync`), and `done` logs its reason.
 * @param {{ sync?: boolean }} [shape]
 */
function makeCarrier(shape = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {any[]} */
  const frames = [];
  /** @type {ReturnType<typeof deferred>[]} */
  const gates = [];
  /** @type {any[]} */
  const dones = [];
  const hooks = {
    snapshot: (/** @type {number} */ seq, /** @type {any} */ data) => ({ event: 'snapshot', seq, data }),
    patch: (/** @type {number} */ seq, /** @type {any} */ emission) => ({ event: 'patch', seq, data: emission }),
    error: (/** @type {string} */ intent, /** @type {unknown} */ cause, /** @type {number} */ lastSeq, /** @type {unknown} */ declared) => ({ event: 'error', seq: lastSeq, data: { intent, cause, declared } }),
    end: (/** @type {string} */ reason, /** @type {number} */ lastSeq) => ({ event: 'end', seq: lastSeq, data: { reason } }),
    size: (/** @type {any} */ frame) => JSON.stringify(frame).length,
    write: (/** @type {any} */ frame) => {
      log.push(`${frame.event}:${frame.seq}`);
      frames.push(frame);
      if (shape.sync) return undefined;
      const d = deferred();
      gates.push(d);
      return d.promise;
    },
    done: (/** @type {unknown} */ reason) => { log.push('done'); dones.push(reason); },
  };
  return { hooks, log, frames, gates, dones };
}

/** One page in the changes.page() shape. */
function pageOf(/** @type {any[]} */ items, /** @type {Partial<any>} */ extra = {}) {
  const last = items.length === 0 ? undefined : items[items.length - 1].seq;
  return { items, next: last, earliestAvailable: 1, highWatermark: last ?? 0, hasMore: false, resetRequired: false, ...extra };
}
const patchAt = (/** @type {number} */ seq) => ({ patch: [{ op: 'add', path: '/rows/-', value: seq }], seq });

describe('stream runner — ordered, awaited frames', () => {
  it('frames are written in source order and never overlap: the next starts only after the previous settled', async () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier();
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    assert.deepStrictEqual(carrier.log, ['snapshot:0'], 'the snapshot frame was written synchronously');
    assert.deepStrictEqual(carrier.frames[0].data, { value: { rows: [] }, resumed: false, reset: false, earliestAvailable: null, highWatermark: null });
    source.emit(patchAt(1));
    source.emit(patchAt(2));
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0'], 'both patches wait behind the pending snapshot');
    carrier.gates[0].resolve();
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'patch:1'], 'one at a time');
    carrier.gates[1].resolve();
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'patch:1', 'patch:2']);
    carrier.gates[2].resolve();
    runner.stop(null);
    await runner.done;
    assert.deepStrictEqual(carrier.log.slice(3), ['done']);
    assert.deepStrictEqual(carrier.dones, [null]);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
  });

  it('no frame follows a terminal error: the error frame is queued behind the pending writes, then nothing', async () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier();
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    source.emit(patchAt(1));
    source.emit({ error: new Error('source died') });
    source.emit(patchAt(2));
    carrier.gates[0].resolve();
    await tick();
    carrier.gates[1].resolve();
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'patch:1', 'error:1'], 'the patch after the error never rendered');
    assert.strictEqual(carrier.frames[2].data.intent, 'source');
    carrier.gates[2].resolve();
    await runner.done;
    assert.deepStrictEqual(carrier.log.slice(3), ['done']);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
  });

  it('a write that rejects releases the subscription silently: no error frame, stop and close once, done settles', async () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier();
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    source.emit(patchAt(1));
    carrier.gates[0].reject(new Error('the peer is gone'));
    await runner.done;
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'done'], 'neither the queued patch nor an error frame rendered');
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
    source.emit(patchAt(2));
    runner.stop('server-shutdown');
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'done'], 'a finished runner ignores emissions and stops');
  });

  it('an asynchronous stop and close run once, in that order, and done settles only after both', async () => {
    const source = makeSource({ rows: [] }, { asyncStop: true, asyncClose: true });
    const carrier = makeCarrier();
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    carrier.gates[0].resolve();
    let settled = false;
    runner.done.then(() => { settled = true; });
    runner.stop(null);
    runner.stop(null);
    runner.stop('again');
    await tick();
    assert.strictEqual(settled, false, 'done waits for the asynchronous stop');
    await runner.done;
    assert.deepStrictEqual(source.log, ['stop', 'close'], 'stop settled before close began');
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'done']);
  });

  it('a stop or close that rejects never blocks termination', async () => {
    const source = makeSource({ rows: [] }, { rejectStop: true, rejectClose: true });
    const carrier = makeCarrier();
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    carrier.gates[0].resolve();
    runner.stop(null);
    await runner.done;
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'done']);
  });

  it('a silent stop does not wait for a pending write; its late settlement is ignored', async () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier();
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    source.emit(patchAt(1));
    runner.stop(null);
    await runner.done;
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'done'], 'done ran while the snapshot write was still pending');
    carrier.gates[0].resolve();
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'done']);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
  });

  it('a reasoned stop queues its end frame behind the pending write and done waits for it', async () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier();
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    let settled = false;
    runner.done.then(() => { settled = true; });
    runner.stop('server-shutdown');
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0'], 'the end frame waits for the snapshot write');
    carrier.gates[0].resolve();
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'end:0']);
    assert.strictEqual(settled, false, 'done waits for the end write too');
    carrier.gates[1].resolve();
    await runner.done;
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'end:0', 'done']);
  });

  it('a synchronous carrier keeps the synchronous path: every frame is written before the emitter returns', () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier({ sync: true });
    runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    assert.deepStrictEqual(carrier.log, ['snapshot:0']);
    source.emit(patchAt(3));
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'patch:3'], 'rendered synchronously, as the port carrier relies on');
  });
});

describe('stream runner — paged replay', () => {
  it('one page: its items become patches after the cursor, no snapshot, then live continues', async () => {
    /** @type {any[]} */
    const asked = [];
    const source = makeSource({ rows: [] }, { replay: (after, options) => { asked.push({ after, options }); return pageOf([patchAt(11), patchAt(12)]); } });
    const carrier = makeCarrier({ sync: true });
    runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: 10, validate: true });
    assert.deepStrictEqual(carrier.log, ['patch:11', 'patch:12']);
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].after, 10);
    assert.deepStrictEqual([asked[0].options.limit, asked[0].options.maxBytes], [STREAM_LIMITS_DEFAULT.replay.limit, STREAM_LIMITS_DEFAULT.replay.maxBytes]);
    assert.ok(asked[0].options.signal instanceof AbortSignal);
    source.emit(patchAt(13));
    assert.deepStrictEqual(carrier.log, ['patch:11', 'patch:12', 'patch:13']);
  });

  it('many pages: the first page\'s high watermark is the target, later watermarks cannot extend the chase, every seq once in order', async () => {
    let calls = 0;
    const source = makeSource({ rows: [] }, {
      replay: async (after) => {
        calls++;
        // a busy writer: the watermark rises on every call
        if (after === 10) return pageOf([patchAt(11), patchAt(12)], { hasMore: true, highWatermark: 14 });
        if (after === 12) return pageOf([patchAt(13), patchAt(14)], { hasMore: true, highWatermark: 20 });
        if (after === 14) return pageOf([patchAt(15), patchAt(16)], { hasMore: true, highWatermark: 30 });
        throw new Error(`unexpected page after ${after}`);
      },
    });
    const carrier = makeCarrier({ sync: true });
    runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: 10, validate: true, limits: resolveStreamLimits({ replay: { limit: 2 } }, (r) => new Error(r)) });
    // live emissions arrive while the pages load: an overlap and a fresh one
    source.emit(patchAt(13));
    source.emit(patchAt(15));
    await tick();
    await tick();
    await tick();
    assert.strictEqual(calls, 2, 'paging stopped at the first page\'s watermark (14), not the rising ones');
    assert.deepStrictEqual(carrier.log, ['patch:11', 'patch:12', 'patch:13', 'patch:14', 'patch:15'],
      'the overlap (13) came from the page once, and the live 15 followed');
  });

  it('an empty log with a durable high watermark resumes with no patches and no snapshot', async () => {
    const source = makeSource({ rows: [] }, { replay: () => ({ items: [], earliestAvailable: null, highWatermark: 10, hasMore: false, resetRequired: false }) });
    const carrier = makeCarrier({ sync: true });
    runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: 10, validate: true });
    assert.deepStrictEqual(carrier.log, []);
    source.emit(patchAt(11));
    assert.deepStrictEqual(carrier.log, ['patch:11']);
  });

  it('a malformed page, an array, a rejecting page and a bound-breaking page are source faults that end the stream', async () => {
    const cases = [
      { name: 'array', replay: () => [patchAt(1)] },
      { name: 'not an object', replay: () => 5 },
      { name: 'too many items', replay: () => pageOf([patchAt(1), patchAt(2), patchAt(3)]) },
      { name: 'out of order', replay: () => pageOf([patchAt(2), patchAt(1)]) },
      { name: 'reset with items', replay: () => pageOf([patchAt(1)], { resetRequired: true }) },
      { name: 'rejects', replay: () => Promise.reject(new Error('log unavailable')) },
      { name: 'throws', replay: () => { throw new Error('boom'); } },
    ];
    for (const c of cases) {
      const source = makeSource({ rows: [] }, { replay: c.replay });
      const carrier = makeCarrier({ sync: true });
      const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: 0, validate: true, limits: resolveStreamLimits({ replay: { limit: 2 } }, (r) => new Error(r)) });
      await runner.done;
      assert.deepStrictEqual(carrier.log, ['error:0', 'done'], c.name);
      assert.strictEqual(carrier.frames[0].data.intent, 'source', c.name);
      assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 }, c.name);
    }
  });

  it('a null page is the refusal: a fresh snapshot with resumed false and no watermarks', () => {
    const source = makeSource({ rows: ['fresh'] }, { replay: () => null });
    const carrier = makeCarrier({ sync: true });
    runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: 10, validate: true });
    assert.deepStrictEqual(carrier.log, ['snapshot:0']);
    assert.deepStrictEqual(carrier.frames[0].data, { value: { rows: ['fresh'] }, resumed: false, reset: false, earliestAvailable: null, highWatermark: null });
  });
});

describe('stream runner — the total reset', () => {
  it('resetRequired delivers no suffix: one snapshot with reset true, both watermarks, and an id no lower than a live emission already held', async () => {
    const page = deferred();
    const source = makeSource({ rows: [] }, { replay: () => page.promise });
    const carrier = makeCarrier({ sync: true });
    runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: 5, validate: true });
    // live emissions land while the page loads; the snapshot read below
    // already reflects them (the source contract), so their seqs are
    // folded into the snapshot's id and they are never delivered twice
    source.emit(patchAt(41));
    source.emit(patchAt(42));
    source.set({ rows: [41, 42] });
    page.resolve({ items: [], earliestAvailable: 30, highWatermark: 40, hasMore: false, resetRequired: true });
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:42'], 'the id is max(highWatermark 40, held 42); no patch replayed');
    assert.deepStrictEqual(carrier.frames[0].data, { value: { rows: [41, 42] }, resumed: false, reset: true, earliestAvailable: 30, highWatermark: 42 });
    source.emit(patchAt(42));
    source.emit(patchAt(43));
    assert.deepStrictEqual(carrier.log, ['snapshot:42', 'patch:43'], 'only live events above the snapshot id follow');
  });

  it('a reset with nothing held uses the page\'s watermark as the id', () => {
    const source = makeSource({ rows: ['x'] }, { replay: () => ({ items: [], earliestAvailable: 30, highWatermark: 40, hasMore: false, resetRequired: true }) });
    const carrier = makeCarrier({ sync: true });
    runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: 5, validate: true });
    assert.deepStrictEqual(carrier.log, ['snapshot:40']);
    assert.deepStrictEqual(carrier.frames[0].data, { value: { rows: ['x'] }, resumed: false, reset: true, earliestAvailable: 30, highWatermark: 40 });
  });
});

describe('stream runner — the bounded queue', () => {
  it('at the count bound delivery continues; one past it ends with the slow-consumer intent, releases once, and done carries the reason', async () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier();
    const limits = resolveStreamLimits({ queue: { events: 3 } }, (r) => new Error(r));
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true, limits });
    // the snapshot write is blocked; two more fit, the fourth does not
    source.emit(patchAt(1));
    source.emit(patchAt(2));
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0'], 'three charged, nothing lost');
    source.emit(patchAt(3));
    await runner.done;
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 }, 'released once');
    assert.deepStrictEqual(carrier.dones, ['slow-consumer']);
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'done'], 'the blocked write still blocks; nothing else was written');
    // the terminal frame was queued past the bound; when the blocked write settles it is the next (and last) thing written
    carrier.gates[0].resolve();
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'done'], 'a silent release discarded what was queued behind the stall');
  });

  it('at the byte bound delivery continues; one byte past it ends with the slow-consumer intent, the budget charged until each write settled', async () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier();
    const snapshotBytes = carrier.hooks.size(carrier.hooks.snapshot(0, { value: { rows: [] }, resumed: false, reset: false, earliestAvailable: null, highWatermark: null }));
    const patchBytes = carrier.hooks.size(carrier.hooks.patch(1, patchAt(1)));
    const limits = resolveStreamLimits({ queue: { bytes: snapshotBytes + patchBytes } }, (r) => new Error(r));
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true, limits });
    source.emit(patchAt(1));
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0'], 'the patch fits exactly beside the pending snapshot and waits');
    let settled = false;
    runner.done.then(() => { settled = true; });
    await tick();
    assert.strictEqual(settled, false, 'at the bound the stream goes on');
    // one more patch while the snapshot is still pending is a byte past the bound
    source.emit(patchAt(2));
    await runner.done;
    assert.deepStrictEqual(carrier.dones, ['slow-consumer']);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
    // the same two patches with the snapshot settled in between fit: the
    // budget is released when a write settles
    const again = makeSource({ rows: [] });
    const flowing = makeCarrier();
    runSubscription(ROUTE, again.sub, flowing.hooks, { lastSeq: null, validate: true, limits });
    flowing.gates[0].resolve();
    await tick();
    again.emit(patchAt(1));
    flowing.gates[1].resolve();
    await tick();
    again.emit(patchAt(2));
    await tick();
    assert.deepStrictEqual(flowing.log, ['snapshot:0', 'patch:1', 'patch:2']);
    assert.deepStrictEqual(flowing.dones, []);
  });

  it('a synchronous carrier receives the JC2096 frame: emissions held during a page load past the bound end the stream with it', async () => {
    const page = deferred();
    const source = makeSource({ rows: [] }, { replay: () => page.promise });
    const carrier = makeCarrier({ sync: true });
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: 3, validate: true, limits: resolveStreamLimits({ queue: { events: 2 } }, (r) => new Error(r)) });
    source.emit(patchAt(4));
    source.emit(patchAt(5));
    assert.deepStrictEqual(carrier.log, [], 'two held while the page loads');
    source.emit(patchAt(6));
    await runner.done;
    assert.deepStrictEqual(carrier.log, ['error:0', 'done'], 'the third crossed the bound: the terminal frame went out on the synchronous path');
    assert.strictEqual(carrier.frames[0].data.intent, 'slow-consumer');
    assert.deepStrictEqual(carrier.dones, ['slow-consumer']);
    page.resolve(pageOf([patchAt(4)]));
    await tick();
    assert.deepStrictEqual(carrier.log, ['error:0', 'done'], 'the late page rendered nothing');
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
  });

  it('a synchronous carrier never accumulates: a thousand emissions under a small bound all deliver', () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier({ sync: true });
    runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true, limits: resolveStreamLimits({ queue: { events: 2 } }, (r) => new Error(r)) });
    for (let i = 1; i <= 1000; i++) source.emit(patchAt(i));
    assert.strictEqual(carrier.log.length, 1001);
    assert.deepStrictEqual(carrier.dones, []);
  });

  it('resolveStreamLimits refuses a non-integer, zero or negative bound and keeps the defaults elsewhere', () => {
    assert.strictEqual(resolveStreamLimits(undefined, (r) => new Error(r)), STREAM_LIMITS_DEFAULT);
    assert.deepStrictEqual(resolveStreamLimits({ queue: { events: 5 } }, (r) => new Error(r)), {
      replay: { limit: 256, maxBytes: 1048576 }, queue: { events: 5, bytes: 1048576 },
    });
    assert.deepStrictEqual(resolveStreamLimits({ replay: { maxBytes: Infinity } }, (r) => new Error(r)).replay, { limit: 256, maxBytes: Infinity });
    for (const bad of [{ queue: { events: 0 } }, { queue: { bytes: -1 } }, { replay: { limit: 1.5 } }, { replay: 'x' }, 5]) {
      assert.throws(() => resolveStreamLimits(bad, (r) => new Error(r)), Error, JSON.stringify(bad));
    }
  });
});

describe('stream runner — cancellation', () => {
  it('a stop while a page is loading aborts the page signal, ignores the late page and releases once', async () => {
    const page = deferred();
    /** @type {AbortSignal | null} */
    let signal = null;
    const source = makeSource({ rows: [] }, { replay: (after, options) => { signal = options.signal; return page.promise; } });
    const carrier = makeCarrier({ sync: true });
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: 3, validate: true });
    assert.ok(signal !== null && !(/** @type {AbortSignal} */ (signal)).aborted);
    runner.stop(null);
    await runner.done;
    assert.strictEqual(/** @type {AbortSignal} */ (signal).aborted, true, 'the page load was told to stop');
    page.resolve(pageOf([patchAt(4)]));
    await tick();
    assert.deepStrictEqual(carrier.log, ['done'], 'the late page rendered nothing');
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
  });

  it('a stop while a write is blocked releases once and the write\'s late settlement renders nothing', async () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier();
    const runner = runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    source.emit(patchAt(1));
    runner.stop(null);
    await runner.done;
    carrier.gates[0].resolve();
    await tick();
    assert.deepStrictEqual(carrier.log, ['snapshot:0', 'done']);
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
  });
});

describe('stream runner — a source error the operation declares', () => {
  const DECLARING = compileContract({
    $contract: '0.1',
    operations: {
      feed: {
        kind: 'subscribe',
        output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
        errors: { gone: { status: 410 }, overflow: { status: 507 } },
      },
    },
  });
  /** The pipeline-route members the classification reads: the declared errors and the retry set. */
  const DECLARED_ROUTE = /** @type {any} */ ({
    op: DECLARING.operations.feed,
    validateOutput: DECLARING.operations.feed.output.validate,
    errors: DECLARING.operations.feed.errors,
    retryOn: new Set(['gone']),
  });

  /** Run one emission through a synchronous carrier; answer the terminal error frame's data. */
  async function endWith(/** @type {unknown} */ error) {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier({ sync: true });
    runSubscription(DECLARED_ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    source.emit({ error });
    await tick(); // the release (stop, close, done) settles behind the frame
    const last = carrier.frames[carrier.frames.length - 1];
    assert.strictEqual(last.event, 'error');
    assert.strictEqual(carrier.log[carrier.log.length - 1], 'done');
    assert.deepStrictEqual(source.counts, { stops: 1, closes: 1 });
    return last.data;
  }

  it('a declared code crosses as the declared intent: code, JSON-safe details, its own retryable', async () => {
    const data = await endWith({ code: 'gone', details: { at: 1 }, retryable: false });
    assert.strictEqual(data.intent, 'declared');
    assert.deepStrictEqual(data.declared, { code: 'gone', details: { at: 1 }, retryable: false });
  });

  it('retryable without an own boolean is the retry set\'s verdict', async () => {
    assert.strictEqual((await endWith({ code: 'gone' })).declared.retryable, true);
    assert.strictEqual((await endWith({ code: 'overflow' })).declared.retryable, false);
  });

  it('details that are not JSON — a function, a cycle — do not cross', async () => {
    assert.strictEqual((await endWith({ code: 'gone', details: () => 1 })).declared.details, undefined);
    const cyclic = /** @type {any} */ ({});
    cyclic.self = cyclic;
    assert.strictEqual((await endWith({ code: 'gone', details: cyclic })).declared.details, undefined);
  });

  it('an undeclared code, a non-string code, a plain Error and a hostile error are the source intent, the cause kept', async () => {
    for (const error of [{ code: 'JD2060' }, { code: 42 }, new Error('boom'), { get code() { throw new Error('hostile'); } }]) {
      const data = await endWith(error);
      assert.strictEqual(data.intent, 'source');
      assert.strictEqual(data.declared, null);
      assert.strictEqual(data.cause, error);
    }
  });

  it('a route without declared errors classifies nothing as declared', () => {
    const source = makeSource({ rows: [] });
    const carrier = makeCarrier({ sync: true });
    runSubscription(ROUTE, source.sub, carrier.hooks, { lastSeq: null, validate: true });
    source.emit({ error: { code: 'gone' } });
    assert.strictEqual(carrier.frames[carrier.frames.length - 1].data.intent, 'source');
  });
});
