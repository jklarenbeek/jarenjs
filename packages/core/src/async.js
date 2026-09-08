//@ts-check
/**
 * @file The bounded ordered asynchronous map: run a worker over a list
 * with never more than `limit` calls in flight, and answer the results
 * in the list's order. Before this file the same twelve lines lived in
 * the AI package's program runner and in the benchmark harness, and a
 * downstream consumer had written them a third time; a pool that exists
 * once is one whose edge behavior can be pinned once.
 *
 * The contract, in full:
 *
 *  - results are in INPUT order, whatever order the workers finish in;
 *  - never more than `limit` workers are in flight; `limit` must be a
 *    number of at least 1 (`Infinity` is allowed and means unbounded) —
 *    anything else is a `TypeError`, never a silent clamp, because a
 *    limit of 0 is a bug in the caller and "sequential" is spelled 1;
 *  - a worker rejection stops dispatch: no item starts after it, the
 *    workers already in flight are awaited, and only then does the map
 *    reject with that first rejection. A worker that throws
 *    synchronously is a rejection;
 *  - an abort does the same, rejecting with the signal's reason; a signal
 *    that is already aborted rejects before any worker runs;
 *  - so when the returned promise settles, NO worker is still running —
 *    the caller can close whatever the workers were using.
 *
 * The map does not retry, rate-limit, delay per origin or know anything
 * about what the worker does; those are the caller's policies around it.
 */

import { isThenable } from './function.js';

/**
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit - workers in flight at once; a number >= 1, `Infinity` for unbounded
 * @param {(item: T, index: number) => Promise<R> | R} worker
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<R[]>} the results, in input order
 * @throws {TypeError} (as a rejection) when `limit` is not a number >= 1
 */
export async function mapConcurrent(items, limit, worker, options = {}) {
  if (typeof limit !== 'number' || !(limit >= 1))
    throw new TypeError(`mapConcurrent needs a limit of at least 1, got ${String(limit)}`);
  const { signal } = options;
  if (signal?.aborted) throw signal.reason;
  const count = items.length;
  /** @type {R[]} */
  const results = new Array(count);
  if (count === 0) return results;

  let next = 0;
  // the first failure or abort, kept as a one-element list: the lanes
  // stop dispatching the moment it is set and drain what they hold
  /** @type {unknown[]} */
  const stop = [];
  /** @type {(() => void) | undefined} */
  let onAbort;
  if (signal !== undefined) {
    onAbort = () => { if (stop.length === 0) stop.push(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const lane = async () => {
    while (stop.length === 0) {
      const index = next++;
      if (index >= count) return;
      try {
        results[index] = await worker(items[index], index);
      }
      catch (error) {
        if (stop.length === 0) stop.push(error);
      }
    }
  };
  const lanes = Array.from({ length: Math.min(limit, count) }, lane);
  await Promise.all(lanes);
  if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  if (stop.length > 0) throw stop[0];
  return results;
}

/**
 * The underlying sink an awaited sink serializes: `write` answers a
 * value (the chunk is written) or a promise (the chunk is written when
 * it settles — a socket waiting for `drain`, a stream waiting for the
 * consumer's next pull); `end` and `abort` are optional and may answer
 * either way too.
 * @template T
 * @typedef {Object} SinkLike
 * @property {(chunk: T) => unknown} write
 * @property {() => unknown} [end]
 * @property {(reason: unknown) => unknown} [abort]
 */

/**
 * The serialized, awaited view of a sink.
 * @template T
 * @typedef {Object} AwaitedSink
 * @property {(chunk: T) => Promise<void> | undefined} write - queue one
 *   chunk behind every earlier write; `undefined` when the underlying
 *   write answered synchronously with nothing pending (the fast path),
 *   else a promise that settles when the underlying write did
 * @property {() => Promise<void>} end - queue the underlying `end` once
 *   after every write; repeated calls answer the same promise
 * @property {(reason?: unknown) => Promise<void>} abort - stop accepting
 *   writes, reject the writes still queued, and call the underlying
 *   `abort` once, immediately; repeated calls answer the same promise
 * @property {() => boolean} failed - whether a write rejected or an abort
 *   happened; nothing reaches the underlying sink after that
 * @property {() => boolean} closed - whether `end` or `abort` was called
 */

/**
 * Serialize a sink: every write waits for the previous one, `end` waits
 * for every write, and one failure stops everything after it. This is
 * the one place the suite decides what "the next chunk" means for a
 * sink that may answer a promise — a Node response whose `write()` said
 * `false` (wait for `drain`), a Web `ReadableStream` bridge that waits
 * for the consumer's pull, a stream runner whose carrier hooks may be
 * asynchronous — so backpressure is a property of the sink, never of
 * the code writing into it.
 *
 * The contract, in full:
 *
 *  - writes reach the underlying sink in call order and never overlap:
 *    the next underlying write begins only after the previous one
 *    settled;
 *  - a synchronous sink stays on a no-extra-promise fast path: while
 *    nothing is pending and the underlying write answers a non-thenable,
 *    `write` answers `undefined`; the first thenable answer opens the
 *    queue, and an idle queue returns to the fast path;
 *  - `end()` runs the underlying `end` once, after every write queued
 *    before it; `abort(reason)` runs the underlying `abort` once, at once
 *    (an abort is urgent — the pending underlying write is not waited
 *    for), and every write still queued rejects with the reason;
 *  - a write that throws or rejects (including a throwing `then` getter
 *    on its answer) fails the sink: its own promise
 *    rejects, every write queued behind it rejects with the same reason
 *    without reaching the underlying sink, later writes reject at once,
 *    and `end()` rejects too — the stream did not end cleanly;
 *  - `end` and `abort` are mutually terminal: the first one decides, the
 *    other one (and every repeat) answers the first one's promise; a
 *    write after either rejects;
 *  - `write` never throws — a refusal is a rejected promise, so a caller
 *    handles one shape.
 *
 * @template T
 * @param {SinkLike<T>} sink
 * @returns {AwaitedSink<T>}
 * @throws {TypeError} when `sink` has no `write` function
 */
export function createAwaitedSink(sink) {
  if (sink === null || typeof sink !== 'object' || typeof sink.write !== 'function') {
    throw new TypeError('createAwaitedSink needs a sink with a write function');
  }
  /** whether an underlying operation is in flight (it answered a thenable) */
  let running = false;
  /**
   * The operations waiting for the one in flight, in call order.
   * @type {{ op: () => unknown, resolve: () => void, reject: (reason: unknown) => void }[]}
   */
  const queued = [];
  let failed = false;
  /** @type {unknown} */
  let failure;
  let closed = false;
  /** @type {Promise<void> | null} the first end()/abort() settlement */
  let terminal = null;

  /** @param {unknown} reason */
  const fail = (reason) => {
    if (failed) return;
    failed = true;
    failure = reason;
  };

  /** Run what is queued, one at a time, until one answers a thenable. */
  const next = () => {
    while (!running && queued.length > 0) {
      const item = /** @type {NonNullable<typeof queued[0]>} */ (queued.shift());
      if (failed) {
        item.reject(failure);
        continue;
      }
      let answer;
      try {
        answer = item.op();
        if (!isThenable(answer)) {
          item.resolve();
          continue;
        }
      }
      catch (err) {
        fail(err);
        item.reject(err);
        continue;
      }
      running = true;
      Promise.resolve(answer).then(() => {
        running = false;
        item.resolve();
        next();
      }, (err) => {
        running = false;
        fail(err);
        item.reject(err);
        next();
      });
    }
  };

  /**
   * Run one operation behind the queue.
   * @param {() => unknown} op
   * @returns {Promise<void> | undefined}
   */
  const run = (op) => {
    if (running || queued.length > 0) {
      return new Promise((resolve, reject) => { queued.push({ op, resolve, reject }); });
    }
    let answer;
    try {
      answer = op();
      if (!isThenable(answer)) return undefined;
    }
    catch (err) {
      fail(err);
      return Promise.reject(err);
    }
    running = true;
    return new Promise((resolve, reject) => {
      Promise.resolve(answer).then(() => {
        running = false;
        resolve();
        next();
      }, (err) => {
        running = false;
        fail(err);
        reject(err);
        next();
      });
    });
  };

  return {
    write(chunk) {
      if (failed) return Promise.reject(failure);
      if (closed) return Promise.reject(new Error('createAwaitedSink: write after end'));
      return run(() => sink.write(chunk));
    },
    end() {
      if (terminal !== null) return terminal;
      closed = true;
      if (failed) {
        terminal = Promise.reject(failure);
        return terminal;
      }
      const answer = run(() => (typeof sink.end === 'function' ? sink.end() : undefined));
      terminal = answer === undefined ? Promise.resolve() : answer;
      return terminal;
    },
    abort(reason) {
      if (terminal !== null) return terminal;
      closed = true;
      const why = reason === undefined ? new Error('createAwaitedSink: aborted') : reason;
      fail(why);
      // what is still queued rejects now — an abort does not wait for
      // the operation in flight, whose late settlement is then ignored
      const waiting = queued.splice(0, queued.length);
      for (let i = 0; i < waiting.length; i++) waiting[i].reject(why);
      let answer;
      try {
        answer = typeof sink.abort === 'function' ? sink.abort(why) : undefined;
      }
      catch (err) {
        terminal = Promise.reject(err);
        return terminal;
      }
      terminal = Promise.resolve(answer).then(() => undefined);
      return terminal;
    },
    failed: () => failed,
    closed: () => closed,
  };
}
