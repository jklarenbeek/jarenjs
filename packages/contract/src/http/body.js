//@ts-check
/**
 * @file Byte bodies of the HTTP binding, carrier-neutral: the one
 * normalizer that turns whatever an adapter or a handler hands over (a
 * string, bytes, an async iterable of chunks, a Web `ReadableStream`)
 * into the shape the pipeline reads; the bounded collector a JSON
 * operation drains its source through (a JSON body must be parsed and
 * validated whole, so it materializes — under the operation's limit
 * and never past it); and the counting source an opaque handler
 * receives, which never yields a byte past the limit and cancels its
 * upstream exactly once. Nothing here keeps a chunk it has handed on:
 * the opaque path holds one chunk at a time, and the JSON path holds
 * at most `maxBodyBytes`.
 */

/**
 * A body as the pipeline reads it: text, bytes, a pull source of byte
 * chunks, or none.
 * @typedef {string | Uint8Array | AsyncIterable<Uint8Array> | null} Body
 */

/**
 * The limit crossing a counting source raises to whoever is pulling
 * it: recognized by class, so a handler that lets it propagate answers
 * `JC2003` rather than a host fault, and a handler that catches it
 * decides for itself.
 */
export class BodyLimitError extends Error {
  /** @param {number} limit */
  constructor(limit) {
    super(`the request body exceeds its ${limit}-byte limit`);
    this.name = 'BodyLimitError';
    /** @type {number} */
    this.limit = limit;
  }
}

/**
 * Whether a value is an async iterable — the pull shape of a byte source.
 * @param {unknown} value
 * @returns {value is AsyncIterable<Uint8Array>}
 */
export function isAsyncByteSource(value) {
  return value !== null && typeof value === 'object' && typeof (/** @type {any} */ (value))[Symbol.asyncIterator] === 'function';
}

/**
 * Whether a value is a Web `ReadableStream` (by its reader, the one
 * member every platform's stream has).
 * @param {unknown} value
 * @returns {value is ReadableStream<Uint8Array>}
 */
export function isReadableStream(value) {
  return value !== null && typeof value === 'object' && typeof (/** @type {any} */ (value)).getReader === 'function';
}

/**
 * An async iterable over a Web stream's reader. `return()` cancels the
 * stream once; a completed read releases the lock.
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncIterable<Uint8Array>}
 */
function readerSource(stream) {
  return {
    [Symbol.asyncIterator]() {
      const reader = stream.getReader();
      let done = false;
      return {
        async next() {
          if (done) return { done: true, value: undefined };
          let r;
          try {
            r = await reader.read();
          }
          catch (err) {
            done = true;
            throw err;
          }
          if (r.done) {
            done = true;
            reader.releaseLock();
            return { done: true, value: undefined };
          }
          return { done: false, value: r.value };
        },
        async return(value) {
          if (!done) {
            done = true;
            try {
              await reader.cancel();
            }
            catch {
              // a stream that refuses the cancel is already gone
            }
          }
          return { done: true, value };
        },
      };
    },
  };
}

/**
 * Normalize a body: `undefined`/`null` → `null`; a string or bytes
 * pass; a Web stream becomes an async iterable over its reader; an
 * async iterable passes. Anything else answers `undefined` — not a
 * body, for the caller to refuse.
 * @param {unknown} body
 * @returns {Body | undefined}
 */
export function normalizeBody(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  if (isReadableStream(body)) return readerSource(body);
  if (isAsyncByteSource(body)) return body;
  return undefined;
}

/**
 * Concatenate collected chunks into one Uint8Array.
 * @param {Uint8Array[]} chunks
 * @param {number} total
 * @returns {Uint8Array}
 */
function concat(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].byteLength;
  }
  return out;
}

/**
 * Cancel an iterator once, swallowing what the cancel throws.
 * @param {AsyncIterator<Uint8Array>} iterator
 */
async function cancelIterator(iterator) {
  if (typeof iterator.return !== 'function') return;
  try {
    await iterator.return();
  }
  catch {
    // an upstream that refuses its cancel is already gone
  }
}

/**
 * What the collector answers: the whole body, or why it stopped —
 * `limit` (the read crossed `limit`; the crossing chunk was never
 * retained), `aborted` (the signal fired between pulls), `error` (the
 * source threw, or yielded a non-byte chunk). In every failed case the
 * upstream iterator's `return()` ran exactly once.
 * @typedef {{ ok: true, bytes: Uint8Array }
 *   | { ok: false, kind: 'limit' | 'aborted' }
 *   | { ok: false, kind: 'error', cause: unknown }} Collected
 */

/**
 * Drain a byte source into one `Uint8Array` under a limit: at most
 * `limit` bytes are ever held; the chunk that would cross it is not
 * retained, the upstream is cancelled once, and the crossing is
 * reported.
 * @param {AsyncIterable<Uint8Array>} source
 * @param {number} limit - inclusive
 * @param {AbortSignal | null} signal - checked between pulls
 * @returns {Promise<Collected>}
 */
export async function collectBytes(source, limit, signal) {
  const iterator = source[Symbol.asyncIterator]();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    if (signal !== null && signal.aborted) {
      await cancelIterator(iterator);
      return { ok: false, kind: 'aborted' };
    }
    let r;
    try {
      r = await iterator.next();
    }
    catch (err) {
      await cancelIterator(iterator);
      return { ok: false, kind: 'error', cause: err };
    }
    if (r.done) break;
    const chunk = r.value;
    if (!(chunk instanceof Uint8Array)) {
      await cancelIterator(iterator);
      return { ok: false, kind: 'error', cause: new TypeError('a body source must yield Uint8Array chunks') };
    }
    total += chunk.byteLength;
    if (total > limit) {
      await cancelIterator(iterator);
      return { ok: false, kind: 'limit' };
    }
    chunks.push(chunk);
  }
  return { ok: true, bytes: total === 0 ? new Uint8Array(0) : concat(chunks, total) };
}

/**
 * The state of a counting source, readable by the binding that made it.
 * @typedef {Object} SourceState
 * @property {boolean} started - a chunk was pulled
 * @property {boolean} finished - EOF was reached, or the source was cancelled
 * @property {boolean} cancelled - `return()` ran (a crossing, a consumer's return, the binding's cancel)
 * @property {boolean} crossed - the limit was crossed
 * @property {number} bytes - the bytes yielded so far
 */

/**
 * A counting source over an upstream: what an opaque handler receives.
 * @typedef {AsyncIterable<Uint8Array> & { cancel: () => Promise<void>, state: SourceState }} CountingSource
 */

/**
 * Wrap an upstream source so it never yields a byte past `limit`: the
 * chunk that would cross it is not yielded — the upstream is cancelled
 * once and a `BodyLimitError` is thrown to the puller. `return()` (a
 * consumer that stops early) and `cancel()` (the binding, when a
 * response goes out with the request unread) both cancel the upstream
 * exactly once; `state` says what happened.
 * @param {AsyncIterable<Uint8Array>} upstream
 * @param {number} limit
 * @returns {CountingSource}
 */
export function countingSource(upstream, limit) {
  /** @type {SourceState} */
  const state = { started: false, finished: false, cancelled: false, crossed: false, bytes: 0 };
  /** @type {AsyncIterator<Uint8Array> | null} */
  let iterator = null;
  const cancel = async () => {
    if (state.finished) return;
    state.finished = true;
    state.cancelled = true;
    if (iterator === null) iterator = upstream[Symbol.asyncIterator]();
    await cancelIterator(iterator);
  };
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (state.finished) return { done: true, value: undefined };
          state.started = true;
          if (iterator === null) iterator = upstream[Symbol.asyncIterator]();
          let r;
          try {
            r = await iterator.next();
          }
          catch (err) {
            state.finished = true;
            throw err;
          }
          if (state.finished) return { done: true, value: undefined };
          if (r.done) {
            state.finished = true;
            return { done: true, value: undefined };
          }
          const chunk = r.value;
          if (!(chunk instanceof Uint8Array)) {
            await cancel();
            throw new TypeError('a body source must yield Uint8Array chunks');
          }
          state.bytes += chunk.byteLength;
          if (state.bytes > limit) {
            state.crossed = true;
            await cancel();
            throw new BodyLimitError(limit);
          }
          return { done: false, value: chunk };
        },
        async return(value) {
          await cancel();
          return { done: true, value };
        },
      };
    },
    cancel,
    state,
  };
}

/**
 * Run `after` once when a response source completes, throws or is
 * cancelled by its consumer — the hook a binding uses to release what
 * the response held (an unread request source). A throw from the
 * source reaches the consumer after the hook; the hook's own answer
 * is awaited but never replaces the source's outcome.
 * @param {AsyncIterable<Uint8Array>} source
 * @param {(cause: unknown) => unknown} after - `cause` is the throw, or `undefined` on EOF/return
 * @returns {AsyncIterable<Uint8Array>}
 */
export function onSettled(source, after) {
  let settled = false;
  /** @param {unknown} cause */
  const settle = async (cause) => {
    if (settled) return;
    settled = true;
    try {
      await after(cause);
    }
    catch {
      // the hook's failure is not the stream's
    }
  };
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        async next() {
          if (settled) return { done: true, value: undefined };
          let r;
          try {
            r = await iterator.next();
          }
          catch (err) {
            await settle(err);
            throw err;
          }
          if (r.done) await settle(undefined);
          return r;
        },
        async return(value) {
          if (!settled) {
            await cancelIterator(iterator);
            await settle(undefined);
          }
          return { done: true, value };
        },
      };
    },
  };
}
