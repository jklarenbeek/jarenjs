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

import { utf8ByteLength } from '@jarenjs/core/string';

import { DbRuntimeError } from './errors.js';
import { chain, isThenable } from './driver.js';

/** Preserve a failure, but acknowledge source cleanup before rejecting it.
 * @param {() => any} call @param {() => any} release @param {(error:any)=>any} [wrap]
 */
function settling(call, release, wrap = (error) => error) {
  const failed = (error) => {
    const failure = wrap(error);
    let cleanup;
    try { cleanup = release(); } catch { throw failure; }
    if (isThenable(cleanup)) return cleanup.then(() => { throw failure; }, () => { throw failure; });
    throw failure;
  };
  let result;
  try { result = call(); } catch (error) { return failed(error); }
  return isThenable(result) ? result.then(undefined, failed) : result;
}

/**
 * The serialised size of a JSON text in UTF-8 bytes — the one measure
 * every byte bound in this package counts (an include per root, a page,
 * a change record): the suite's counter, re-exported under the name the
 * engines read.
 * @param {string} text
 * @returns {number}
 */
export function utf8Length(text) {
  return utf8ByteLength(text);
}

/**
 * @typedef {{ construct: string, reason: string }} CursorBarrier - what
 *   forces a cursor to buffer: the construct is the stable identifier
 *   (a planner construct such as `$orderby`, or `external`, `window`,
 *   `pushdown`), the reason the sentence for a person
 */

/**
 * How a cursor over a source the driver iterates actually behaves on
 * THIS connection: one row per pull where the binding has a lazy
 * iterator, and a buffer — declared as such, with the driver named as
 * the barrier — where the driver composed `iterate` over `all()`. The
 * capability is probed once at open; a cursor is classified at
 * construction, before any statement exists, so the fact has to be the
 * connection's. The one classification every engine and the job queue
 * read.
 * @param {any} connection
 * @returns {{ streaming: 'row' | 'buffered', barrier: CursorBarrier | null }}
 */
export function rowClassOf(connection) {
  return connection.capabilities.lazyIteration === false
    ? { streaming: 'buffered', barrier: { construct: 'driver',
      reason: 'the driver binding has no lazy iterator; the first pull materialises the whole result' } }
    : { streaming: 'row', barrier: null };
}

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
 * @property {() => number} [now] - the clock the deadline is read
 *   against — the store's runtime record's; required beside a deadline,
 *   so no cursor reads the platform clock on its own
 * @property {(error: any) => Error} [wrap] - classifies a failure raised
 *   while the source is opened, pulled or mapped — the engine's driver
 *   wrap, so no raw driver error leaves a cursor; a coded error passes
 *   through it unchanged
 * @property {(opened: boolean) => void} [onSettle] - called exactly once
 *   when the cursor settles — exhausted, released, or aborted — with
 *   whether a pull ever reached the source; what an engine finalises its
 *   run accounting on
 */

/**
 * Build an asynchronous item cursor over one source.
 * @param {CursorSpec} spec
 * @returns {any}
 */
export function createCursor(spec) {
  return itemCursor(spec, false);
}

/**
 * The same lifecycle over a synchronous source, answering values.
 * @param {CursorSpec} spec
 * @returns {any}
 */
export function createSyncCursor(spec) {
  return itemCursor(spec, true);
}

/** @param {CursorSpec} spec @param {boolean} synchronous */
function itemCursor(spec, synchronous) {
  const { streaming, signal } = spec;
  if (spec.deadline !== undefined && spec.now === undefined)
    throw new TypeError('a cursor with a deadline is built with the clock it is read against (now)');
  let buffered = [];
  let offset = 0;
  let underlying = null;
  let opening = null;
  let cleanup;
  let sourceReleased = false;
  let done = false;
  let opened = false;
  let tail = synchronous ? undefined : Promise.resolve();
  const settle = () => {
    if (done) return;
    done = true;
    buffered = [];
    signal?.removeEventListener('abort', onAbort);
    spec.onSettle?.(opened);
  };
  const releaseSource = () => {
    if (sourceReleased || underlying === null) return;
    sourceReleased = true;
    return underlying.return?.(undefined);
  };
  const release = () => {
    settle();
    if (cleanup === undefined) cleanup = chain(opening, releaseSource);
    return cleanup;
  };
  const onAbort = () => {
    // Event listeners cannot await remote acknowledgement. The public
    // return still awaits it, and a rejection is observed here as well.
    try { const pending = release(); if (isThenable(pending)) pending.catch(() => {}); }
    catch { /* the next/return boundary reports the source failure */ }
  };
  const aborted = () => new DbRuntimeError('JD2072',
    'the cursor was aborted: its statement was released at a row boundary and it pulls '
    + 'no further row', { cause: signal?.reason });
  const end = () => ({ done: true, value: undefined });
  const boundary = () => {
    if (signal?.aborted) throw aborted();
    if (done) return;
    if (spec.deadline !== undefined && spec.now() > spec.deadline)
      throw new DbRuntimeError('JD2075',
        `the deadline passed before the next row (${new Date(spec.deadline).toISOString()}); `
        + 'the statement was released at a row boundary');
  };
  const accept = (step) => {
    boundary();
    if (done) return end();
    if (step.done === true) {
      sourceReleased = true; // exhausted native iterators already reset
      settle();
      return end();
    }
    buffered = spec.items?.(step.value) ?? [];
    offset = 0;
    return null;
  };
  const rows = () => {
    for (;;) {
      boundary();
      if (done) return end();
      if (offset < buffered.length) return { done: false, value: buffered[offset++] };
      const next = underlying.next();
      if (isThenable(next)) return next.then((step) => accept(step) ?? rows());
      const result = accept(next);
      if (result !== null) return result;
    }
  };
  const pull = () => {
    boundary();
    if (done) return end();
    if (spec.materialize !== undefined) {
      if (!opened) {
        opened = true;
        return chain(spec.materialize(), (items) => {
          boundary();
          if (done) return end();
          buffered = items;
          return pull();
        });
      }
      if (offset < buffered.length) return { done: false, value: buffered[offset++] };
      settle();
      return end();
    }
    if (!opened) {
      opened = true;
      opening = chain(spec.open?.(), (iterator) => { underlying = iterator; });
      return chain(opening, () => done
        ? chain(releaseSource(), () => { boundary(); return end(); }) : rows());
    }
    return rows();
  };
  const guarded = () => settling(pull, release, spec.wrap);
  if (signal?.aborted) settle();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const next = synchronous ? guarded : () => {
    const result = tail.then(guarded);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const finish = () => chain(release(), end);
  const cursor = {
    streaming,
    barrier: spec.barrier ?? null,
    get settled() { return done; },
    next,
    return: synchronous ? finish : () => {
      try { return Promise.resolve(finish()); }
      catch (error) { return Promise.reject(error); }
    },
    ...(synchronous
      ? { [Symbol.iterator]: () => cursor, [Symbol.dispose]: finish }
      : { [Symbol.asyncIterator]: () => cursor, [Symbol.asyncDispose]: async () => { await finish(); } }),
  };
  return Object.freeze(cursor);
}

/**
 * A ROOT cursor's admission: the one decorator every store-level cursor
 * — a collection's `query()`, an entity set's `cursor()` and
 * `loadCursor()` — is handed back through, so the rule that a root read
 * cannot fall inside a transaction it is not part of (MODEL-FORMAT §5.1)
 * holds for a streaming read exactly as it holds for a finite one, at the
 * granularity a stream can afford: **per pull**. Construction holds
 * nothing. Each `next()` borrows the store gate for all the source work
 * one public item needs (opening the statement on the first pull, the
 * row steps, a row that yields no item), then releases before the
 * promise settles, so a consumer paused between pulls blocks no
 * transaction and a pull made while one is open waits for its commit
 * and reads committed state only. `return()` is admitted the same way;
 * a release the gate REFUSES (a contended `transactions: 'strict'`
 * store, a queue timeout) still runs, off-gate — a statement reset reads
 * and writes nothing, and a statement left open until the store closes
 * is the worse outcome — and answers `{ done: true }`. An abort likewise
 * resets the source at once, off-gate, through the inner cursor's own
 * listener: an abort asks for the statement to be let go, not for it to
 * be held until a stranger's transaction commits.
 *
 * Refusals keep their granularity: a pull abandoned while QUEUED is the
 * gate's `JD2064` (the source, never opened for that pull, needs no
 * release); a pull whose signal is already aborted, or aborts at a row
 * boundary, is the cursor's own `JD2072` and releases the source once; a
 * passed deadline is `JD2075`. A cursor that has settled — exhausted,
 * released, aborted — answers `{ done: true }` without borrowing the
 * gate at all. The decorator buffers no item and holds no gate between
 * two public pulls: `streaming`, `barrier` and the asynchronous-iterator
 * identity are the inner cursor's own.
 * @param {any} cursor - the engine's `QueryCursor`
 * @param {(fn: () => any, what?: string, signal?: AbortSignal) => any} admit
 *   - the store gate: runs `fn` holding the connection, value-or-promise
 * @param {AbortSignal | undefined} signal - the cursor's own signal, so an
 *   abort abandons a queued pull
 * @param {string} what - what is waiting, for the gate's timeout message
 * @returns {any} the admitted `QueryCursor`
 */
export function admitCursor(cursor, admit, signal, what) {
  /**
   * @param {'next' | 'return'} member
   * @param {string} label
   * @param {boolean} abandonable - whether an abort leaves the queue
   */
  const through = (member, label, abandonable) => () => {
    // an already-aborted cursor refuses on its own (`JD2072`, every later
    // pull) and releases its source; the gate has nothing to admit
    if (abandonable && signal?.aborted === true) return cursor[member]();
    // a settled cursor holds no source: nothing to admit, nothing to wait for
    if (cursor.settled === true) return Promise.resolve({ done: true, value: undefined });
    let admitted;
    try {
      admitted = Promise.resolve(admit(() => cursor[member](), label, abandonable ? signal : undefined));
    }
    catch (error) {
      admitted = Promise.reject(error);
    }
    if (member !== 'return') return admitted;
    // a refused release still releases: the reset lands off-gate rather
    // than leaving the statement open
    return admitted.catch(() => cursor.return());
  };
  /** @type {any} */
  const admitted = {
    streaming: cursor.streaming,
    barrier: cursor.barrier,
    next: through('next', what, true),
    return: through('return', `${what} (release)`, false),
    [Symbol.asyncIterator]: () => admitted,
  };
  return Object.freeze(admitted);
}

/** Synchronous admission per pull; cleanup is permitted even after refusal.
 * @param {any} cursor @param {(fn: () => any) => any} admit
 * @returns {any}
 */
export function admitSyncCursor(cursor, admit) {
  const wrapped = {
    streaming: cursor.streaming,
    barrier: cursor.barrier,
    next: () => admit(() => cursor.next()),
    return: () => cursor.return(),
    [Symbol.iterator]: () => wrapped,
    [Symbol.dispose]: () => { cursor.return(); },
  };
  return Object.freeze(wrapped);
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
 * `hasMore` is otherwise decided by one peek past `limit`. With
 * `lookahead: false`, a full page reports `hasMore: null` and `work`
 * records each consumed root and its serialized payload bytes, including
 * the root that stopped the page at its byte boundary. Failures preserve
 * those counters on the error; pages using the default keep their shape.
 * @param {any} cursor - a `QueryCursor`
 * @param {{ limit: number, maxBytes: number | null, after?: any, lookahead?: boolean,
 *   sizeOf: (item: any) => number, continuationOf: (item: any) => any }} options
 * @returns {any} value-or-promise, matching the cursor
 */
export function drainPage(cursor, options) {
  const { limit, maxBytes, sizeOf, continuationOf } = options;
  const after = options.after ?? null;
  const items = [];
  let bytes = 0;
  const measured = options.lookahead === false;
  const work = { rows: 0, bytes: 0 };
  let last = after;
  let hasMore = false;
  const finish = () => chain(cursor.return(), () => ({
    items, continuation: items.length > 0 ? last : (hasMore ? after : null), hasMore,
    ...(measured ? { work: { ...work } } : {}),
  }));
  const consume = (pulled) => {
    if (items.length >= limit) {
      hasMore = pulled.done !== true;
      return finish();
    }
    if (pulled.done === true) return finish();
    const item = pulled.value;
    const size = maxBytes === null && !measured ? 0 : sizeOf(item);
    if (measured) { work.rows++; work.bytes += size; }
    if (maxBytes !== null && bytes + size > maxBytes) {
      if (items.length === 0) {
        return chain(cursor.return(), () => {
          assertItemBytes(size, maxBytes, continuationOf(item));
        });
      }
      hasMore = true;
      return finish();
    }
    items.push(item);
    bytes += size;
    last = continuationOf(item);
    if (options.lookahead === false && items.length === limit) {
      hasMore = null;
      return finish();
    }
    return null;
  };
  const step = () => {
    for (;;) {
      const pulled = cursor.next();
      if (isThenable(pulled)) return pulled.then((value) => consume(value) ?? step());
      const result = consume(pulled);
      if (result !== null) return result;
    }
  };
  return settling(step, () => cursor.return(), (error) => {
    // A refused boundary row was still consumed. Preserve that evidence
    // through the owning error so a bounded caller cannot report zero work.
    if (measured && error !== null && typeof error === 'object') error.work = { ...work };
    return error;
  });
}

/** The shared refusal for an indivisible item, including a replicated transaction.
 * @param {number} size @param {number} maxBytes @param {any} [at] */
export function assertItemBytes(size, maxBytes, at) {
  if (size > maxBytes) throw new DbRuntimeError('JD2074',
    `the next item is ${size} serialised bytes, more than the page's maxBytes bound of `
    + `${maxBytes}; the continuation was not advanced — raise the bound, or bound the `
    + "item itself (an include's maxBytes, a narrower document)",
    { errors: [{ bytes: size, maxBytes, at }] });
}
