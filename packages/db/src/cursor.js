//@ts-check
/**
 * @file The ONE item cursor. `next()` / `return()` / `[Symbol.asyncIterator]`
 * over a source that is either a ROW ITERATOR pulled one row at a time
 * or a MATERIALISED item array (a barrier). Every engine — the
 * collection engine's `query()`, the entity engine's, the graph
 * loader's — builds its cursor here, so the release-at-a-row-boundary
 * rule exists in one place:
 *
 *  - a row source is opened on the first pull and released exactly
 *    once — on `return()`, on an error raised while a row is mapped or
 *    pulled, and on abort — through the driver iterator's own
 *    `return()`; a source pulled to exhaustion has already reset its
 *    statement and is released without a second call;
 *  - a buffered source materialises on the first pull and SAYS SO:
 *    `streaming: 'buffered'` beside the `barrier` that forced it, a
 *    `{ construct, reason }` pair whose construct is a stable
 *    identifier a test can assert and `explain()` can repeat;
 *  - `signal` cancels at a row boundary: an aborted cursor releases its
 *    statement and every later pull is `JD2072`, so an abandoned
 *    request neither keeps a statement open nor pulls another row.
 *
 * The source never materialises on its own: this module knows neither
 * `.all()` nor `toArray()` — a gate holds it to that — and an engine
 * that must buffer hands the buffered items in as `materialize`, named.
 */

import { DbRuntimeError } from './errors.js';
import { chain, attempt } from './driver.js';

/**
 * The serialised size of a JSON text in UTF-8 bytes — the one measure
 * every byte bound in this package counts (an include per root, a page,
 * a change record), computed without encoding a copy.
 * @param {string} text
 * @returns {number}
 */
export function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // a surrogate pair is one four-byte code point
      bytes += 4;
      i++;
    }
    else bytes += 3;
  }
  return bytes;
}

/**
 * @typedef {{ construct: string, reason: string }} CursorBarrier - what
 *   forces a cursor to buffer: the construct is the stable identifier
 *   (a planner construct such as `$orderby`, or `external`, `window`,
 *   `pushdown`), the reason the sentence for a person
 */

/**
 * @typedef {object} CursorSpec
 * @property {'row' | 'buffered'} streaming - whether items arrive one
 *   database row per pull or from a buffer the first pull filled
 * @property {CursorBarrier | null} [barrier] - what forces buffering;
 *   `null` when the cursor streams
 * @property {AbortSignal} [signal] - cancellation, honoured at a row boundary
 * @property {() => any} [materialize] - a buffered source: value-or-promise
 *   of the whole item array, called once on the first pull
 * @property {() => any} [open] - a row source: value-or-promise of the
 *   driver iterator, called once on the first pull
 * @property {(row: any) => any[]} [items] - a row source: the items one
 *   row yields (none, one, or several); a throw releases the source
 * @property {number} [deadline] - an epoch-millisecond deadline checked at
 *   every pull: past it, the cursor releases its source and refuses
 *   `JD2075` — a row-boundary check, never a statement interrupt
 * @property {(opened: boolean) => void} [onSettle] - called exactly once
 *   when the cursor settles — exhausted, released, or aborted — with
 *   whether a pull ever reached the source; what an engine finalises its
 *   run accounting on
 */

/**
 * Build the cursor over one source.
 * @param {CursorSpec} spec
 * @returns {any} the `QueryCursor`
 */
export function createCursor(spec) {
  const { streaming, signal } = spec;
  const barrier = spec.barrier ?? null;
  /** @type {any[]} */
  let buffered = [];
  let bufferedAt = 0;
  /** @type {any} */
  let underlying = null;
  /** @type {Promise<void> | null} */
  let materialized = null;
  let done = false;
  let released = false;
  /** @type {(() => void) | null} */
  let onAbort = null;

  let opened = false;
  /** Forget the abort listener and mark the source released. */
  const settle = () => {
    done = true;
    if (released) return;
    released = true;
    if (onAbort !== null && signal !== undefined) {
      signal.removeEventListener('abort', onAbort);
      onAbort = null;
    }
    spec.onSettle?.(opened);
  };
  /** Release the source exactly once, at the row boundary we are on. */
  const release = () => {
    if (released) {
      done = true;
      return;
    }
    settle();
    if (underlying !== null && typeof underlying.return === 'function')
      underlying.return(undefined);
  };
  const abortRefusal = () => new DbRuntimeError('JD2072',
    'the cursor was aborted: its statement was released at a row boundary and it pulls '
    + 'no further row', { cause: signal?.reason });
  if (signal !== undefined) {
    if (signal.aborted) settle();
    else {
      onAbort = () => release();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const fromBuffer = () => ({ done: false, value: buffered[bufferedAt++] });
  const exhausted = () => {
    settle();
    return { done: true, value: undefined };
  };
  /** @param {() => any} call */
  const guarded = (call) => attempt(call, (error) => {
    release();
    return error;
  });

  const pull = () => {
    if (signal?.aborted) {
      release();
      return Promise.reject(abortRefusal());
    }
    if (spec.deadline !== undefined && Date.now() > spec.deadline) {
      release();
      return Promise.reject(new DbRuntimeError('JD2075',
        `the deadline passed before the next row (${new Date(spec.deadline).toISOString()}); `
        + 'the statement was released at a row boundary'));
    }
    if (done) return Promise.resolve({ done: true, value: undefined });
    if (bufferedAt < buffered.length) return Promise.resolve(fromBuffer());
    opened = true;
    if (spec.materialize !== undefined) {
      if (materialized === null) {
        materialized = Promise.resolve(guarded(() => chain(spec.materialize(), (items) => {
          buffered = items;
          bufferedAt = 0;
        })));
      }
      return materialized.then(() => {
        if (signal?.aborted) throw abortRefusal();
        return bufferedAt < buffered.length ? fromBuffer() : exhausted();
      });
    }
    const source = underlying === null
      ? guarded(() => chain(spec.open?.(), (iterator) => {
        underlying = iterator;
        return iterator;
      }))
      : underlying;
    return Promise.resolve(chain(source, (iterator) =>
      chain(guarded(() => iterator.next()), (step) => {
        if (signal?.aborted) {
          release();
          throw abortRefusal();
        }
        if (step.done === true) return exhausted();
        buffered = guarded(() => spec.items?.(step.value) ?? []);
        bufferedAt = 0;
        return bufferedAt < buffered.length ? fromBuffer() : pull();
      })));
  };

  /** @type {any} */
  const cursor = {
    streaming,
    barrier,
    next: () => pull(),
    return: () => {
      release();
      return Promise.resolve({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]: () => cursor,
  };
  return Object.freeze(cursor);
}

/** The page size a page takes when none is given. */
export const PAGE_LIMIT_DEFAULT = 100;

/**
 * Drain a cursor into ONE page: at most `limit` items, at most `maxBytes`
 * serialised bytes (`null` for no byte bound), stopping at an item
 * boundary and releasing the cursor. The one implementation every page
 * in this package is — an entity page, a change page — so the
 * `item_too_large` rule exists once: an item that alone exceeds
 * `maxBytes` when nothing has been delivered yet is the refusal
 * `JD2074`, raised WITHOUT advancing the continuation, so a caller that
 * retries meets the same refusal instead of a loop or a silent breach.
 * An item that does not fit beside earlier ones ends the page before
 * it: `hasMore` is true and the continuation is the last delivered
 * item's, so the next page starts at the item that did not fit.
 * `hasMore` is otherwise decided by one peek past `limit`.
 * @param {any} cursor - a `QueryCursor`
 * @param {{ limit: number, maxBytes: number | null, after?: any,
 *   sizeOf: (item: any) => number, continuationOf: (item: any) => any }} options
 * @returns {Promise<{ items: any[], continuation: any, hasMore: boolean }>}
 */
export function drainPage(cursor, options) {
  const { limit, maxBytes, sizeOf, continuationOf } = options;
  const after = options.after ?? null;
  /** @type {any[]} */
  const items = [];
  let bytes = 0;
  let last = after;
  let hasMore = false;
  const finish = () => Promise.resolve(cursor.return()).then(() => ({
    items,
    continuation: items.length > 0 ? last : (hasMore ? after : null),
    hasMore,
  }));
  const step = () => {
    if (items.length >= limit) {
      return cursor.next().then((peek) => {
        hasMore = peek.done !== true;
        return finish();
      });
    }
    return cursor.next().then((pulled) => {
      if (pulled.done === true) return finish();
      const item = pulled.value;
      const size = maxBytes === null ? 0 : sizeOf(item);
      if (maxBytes !== null && bytes + size > maxBytes) {
        if (items.length === 0) {
          return Promise.resolve(cursor.return()).then(() => {
            throw new DbRuntimeError('JD2074',
              `the next item is ${size} serialised bytes, more than the page's maxBytes bound of `
              + `${maxBytes}; the continuation was not advanced — raise the bound, or bound the `
              + "item itself (an include's maxBytes, a narrower document)",
              { errors: [{ bytes: size, maxBytes, at: continuationOf(item) }] });
          });
        }
        hasMore = true;
        return finish();
      }
      items.push(item);
      bytes += size;
      last = continuationOf(item);
      return step();
    });
  };
  return step();
}
