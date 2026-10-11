//@ts-check
/**
 * @file Async source adapters (QUERY-PEN.md §12): everything
 * `fromAsync` accepts normalizes to "a factory of async iterators" —
 * a fresh iterator per enumeration, so the deferred re-enumeration
 * contract carries over exactly (a one-shot generator object simply
 * exhausts, the same way it does under sync `from`).
 *
 * Shipped shapes: any `AsyncIterable`, any sync iterable (wrapped), a
 * CURSOR (`{ next(): Promise<{done, value}>, return?() }` — the shape
 * the SQL provider's row iterator implements later), and a push-queue
 * for feed/end-style readers that have no pull protocol of their own.
 */

import { LinqBuildError, LinqRuntimeError } from './errors.js';
import { readOptions } from './document.js';

/**
 * Normalize an async source into an iterator factory, or throw
 * `JL0001` — at `fromAsync()` time, never at enumeration time.
 * @param {any} source
 * @returns {() => AsyncIterator<any>}
 */
export function adaptAsyncSource(source) {
  if (source != null) {
    if (typeof source[Symbol.asyncIterator] === 'function') {
      return () => source[Symbol.asyncIterator]();
    }
    // a string is refused on purpose: on this surface a string is a
    // CHUNK source (feed it through a push queue), never a character
    // stream — `from('abc')` iterates characters, and the twins differ
    // here by design (QUERY-PEN.md §12)
    if (typeof source[Symbol.iterator] === 'function' && typeof source !== 'string') {
      return () => (async function* () { yield* source; })();
    }
    if (typeof source.next === 'function') {
      // the cursor shape: already an (async) iterator
      return () => /** @type {AsyncIterator<any>} */ (source);
    }
  }
  throw new LinqBuildError('JL0001',
    'fromAsync() needs an async iterable, an iterable, a cursor ({ next, return? }) or a push queue');
}

/**
 * A push→pull adapter for feed/end readers (josl's push parsers have
 * deliberately no backpressure protocol, so the queue is the boundary
 * where one appears): `feed(value)` enqueues and returns `false` once
 * the queue holds more than `highWaterMark` items — a HINT to pause,
 * never a hard stop — and `end(error?)` closes the stream. The queue
 * itself is the async-iterable to hand to `fromAsync`. The options are a
 * closed set: a misspelt mark is `JL0005`, never the default in silence.
 * @param {{ highWaterMark?: number }} [options]
 * @returns {{ feed: (value: any) => boolean, end: (error?: unknown) => void,
 *   [Symbol.asyncIterator]: () => AsyncIterator<any> }}
 */
export function createPushQueue(options) {
  const highWaterMark = readOptions(options, ['highWaterMark'], 'createPushQueue()').highWaterMark ?? 1024;
  if (!Number.isInteger(highWaterMark) || highWaterMark < 1) {
    throw new LinqBuildError('JL0005', 'highWaterMark must be a positive integer');
  }
  /** Values fed and not yet handed out: `buffer[head]` is the next one.
   * Handing out by index keeps a drain linear — `shift()` moves the whole
   * remainder each time, so a queue fed ahead of its reader went quadratic.
   * @type {any[]} */
  const buffer = [];
  let head = 0;
  /** Every reader parked on an empty queue; one signal releases them all.
   * @type {(() => void)[]} */
  const waiting = [];
  let ended = false;
  /** @type {unknown} */
  let failure = null;

  function signal() {
    for (const wake of waiting.splice(0)) wake();
  }

  /** The next value, and the consumed prefix dropped once it is half the array. */
  function take() {
    const value = buffer[head];
    buffer[head++] = undefined;
    if (head === buffer.length) {
      buffer.length = 0;
      head = 0;
    }
    else if (head >= 1024 && head * 2 >= buffer.length) {
      buffer.splice(0, head);
      head = 0;
    }
    return value;
  }

  return {
    feed(value) {
      if (ended) {
        throw new LinqRuntimeError('JL2005',
          'feed() after end(): the push queue is closed and takes no more values');
      }
      buffer.push(value);
      signal();
      return buffer.length - head <= highWaterMark;
    },
    // the first end() is the end: a second one cannot erase its failure
    end(error) {
      if (ended) return;
      ended = true;
      failure = error;
      signal();
    },
    async* [Symbol.asyncIterator]() {
      for (;;) {
        if (head < buffer.length) {
          yield take();
          continue;
        }
        if (ended) {
          if (failure !== undefined && failure !== null) throw failure;
          return;
        }
        await new Promise((resolve) => { waiting.push(() => resolve(undefined)); });
      }
    },
  };
}
