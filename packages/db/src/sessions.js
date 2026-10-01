//@ts-check
/**
 * Several sessions behind one Store (`openStore(model, { sessions })`,
 * PostgreSQL). Each session is a whole driver connection — its own gate,
 * savepoint stack and prepared statements — and the router hands them out:
 * a root call or a root transaction checks out a free session for its extent
 * and runs in an async context of its own, so two independent transactions
 * meet only in the database, which settles what they do to each other.
 *
 * A call made inside a transaction's synchronous extent stays on the session
 * that transaction holds, exactly as a store on one session nests it; any
 * other call is a root call and checks out a session. Every use of a session
 * goes through here, one call at a time per session, so a session's own gate
 * never queues. Statements go to the session the calling context holds. A
 * session the server dropped is never handed out again.
 */
import { isThenable, chain } from '@jarenjs/core/function';
import { DbCompileError, DbRuntimeError } from './errors.js';
import { abortReason } from './driver.js';

/**
 * @param {{ sessions: any[], storage: { run: (context: any, fn: () => any) => any, getStore: () => any },
 *   newContext: () => Record<string, any> }} options - `newContext` is what a fresh root context starts with,
 *   asked each time a call checks out a session
 * @returns {any} the connection surface a store uses, with `primary`, `pinned`, `context()` and `enter()`
 */
export function createSessionRouter({ sessions, storage, newContext }) {
  const primary = sessions[0];
  // the bounds every session keeps for its own gate, kept for the set
  const queueTimeout = primary.queueTimeout;
  const queueCapacity = primary.queueCapacity;
  const busy = sessions.map(() => false);
  /** Callers waiting for a session, in arrival order: `want` is the index a
   * pinned call needs, `-1` any. @type {{ want: number, take: (index: number) => void, leave: (error: any) => void }[]} */
  const waiting = [];
  let closing = false;
  /** The session the calling context holds, or `undefined` outside any. */
  const held = () => storage.getStore()?.session;
  /** @param {number} index */
  const usable = (index) => !busy[index] && !sessions[index].lost();
  /** The session a call asking for `want` would take now, or -1. An ordinary
   * call takes the highest usable one: the first, which serves the store's
   * own unit of work, stays free while another is.
   * @param {number} want */
  const freeFor = (want) => {
    if (want >= 0) return usable(want) ? want : -1;
    for (let i = sessions.length - 1; i >= 0; i--) if (usable(i)) return i;
    return -1;
  };
  const closed = () => new DbRuntimeError('JD2063', 'the store is closed — a call after close() has no connection to run on');
  /** No session left to wait for: the ones asked for were all dropped.
   * @param {number} want */
  const gone = (want) => (want >= 0 ? sessions[want].lost() : sessions.every((session) => session.lost()))
    ? new DbRuntimeError('JD2087', want >= 0
      ? "the store's first session was lost: its own unit of work and its owner lock went with it"
      : "every one of the store's sessions was lost")
    : null;

  /** Give a session back: to the first waiter it suits, or to the free set.
   * A session that was lost is never handed out again, so a waiter it was
   * the last hope of — one pinned to it, or one for any session when every
   * session is lost — hears `JD2087` now rather than at `queueTimeout`.
   * @param {number} index */
  const release = (index) => {
    busy[index] = false;
    if (closing) return;
    if (sessions[index].lost()) {
      for (const waiter of [...waiting]) {
        const lost = gone(waiter.want);
        if (lost !== null) waiter.leave(lost);
      }
      return;
    }
    const at = waiting.findIndex((waiter) => waiter.want < 0 || waiter.want === index);
    if (at < 0) return;
    const [waiter] = waiting.splice(at, 1);
    busy[index] = true;
    waiter.take(index);
  };

  /**
   * A free session's index now — the one asked for, or any — or a promise of
   * it, bounded by `queueTimeout` (`JD0012`) and the queue's capacity
   * (`JD2091`), and abandoned by `signal`.
   * @param {number} want @param {string} what @param {AbortSignal} [signal] @returns {number | Promise<number>}
   */
  const checkout = (want, what, signal) => {
    if (closing) return Promise.reject(closed());
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    const lost = gone(want);
    if (lost !== null) return Promise.reject(lost);
    const index = freeFor(want);
    if (index >= 0) { busy[index] = true; return index; }
    if (waiting.length >= queueCapacity)
      return Promise.reject(new DbRuntimeError('JD2091', 'the connection admission queue is full'));
    return new Promise((resolve, reject) => {
      /** @type {{ want: number, take: (index: number) => void, leave: (error: any) => void }} */
      const waiter = {
        want,
        take: (at) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancelled);
          resolve(at);
        },
        leave: (error) => {
          const at = waiting.indexOf(waiter);
          if (at >= 0) waiting.splice(at, 1);
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancelled);
          reject(error);
        },
      };
      const timer = setTimeout(() => waiter.leave(new DbCompileError('JD0012',
        `${what} waited ${queueTimeout}ms for ${want < 0 ? `one of the store's ${sessions.length} sessions`
          : "the store's first session, which serves its own unit of work"}. A session runs one root call or `
        + 'transaction at a time; work that belongs INSIDE a transaction goes through the store the '
        + 'callback received (tx.collection / tx.entity / tx.transaction).')), queueTimeout);
      const cancelled = () => waiter.leave(abortReason(signal));
      signal?.addEventListener('abort', cancelled, { once: true });
      waiting.push(waiter);
    });
  };

  /** Whether the held session runs a call made now, nested: the calling
   * transaction is on its own synchronous extent there.
   * @param {number} want */
  const nests = (want) => {
    const session = held();
    return session !== undefined && !session.mustQueue && (want < 0 || session === sessions[want]);
  };

  /**
   * A session's `method` for a root call: the held session while the calling
   * transaction is still on its own synchronous extent (a nested call), or
   * one checked out for the call — `want` names it for a pinned call — whose
   * callback runs in a context of its own, whoever invokes it.
   * @param {'exclusively' | 'transaction'} method @param {number} want
   * @param {string} what @param {(args: any[]) => AbortSignal | undefined} signalOf
   */
  const routed = (method, want, what, signalOf) => (/** @type {any[]} */ ...args) => {
    if (nests(want)) return held()[method](...args);
    const signal = signalOf(args);
    return chain(checkout(want, what, signal), (index) => {
      const chosen = sessions[index];
      /** @type {Record<string, any>} */
      const context = { ...newContext(), session: chosen };
      // a call that ended holds nothing: work its body left behind (a timer,
      // an unawaited promise) takes a session the way any root call does
      const end = () => { context.session = undefined; release(index); };
      const [fn, ...rest] = args;
      let out;
      try {
        out = storage.run(context, () => chosen[method]((/** @type {any[]} */ ...inner) => storage.run(context, () => fn(...inner)), ...rest));
      }
      catch (error) {
        end();
        throw error;
      }
      if (!isThenable(out)) { end(); return out; }
      return out.then((value) => { end(); return value; },
        (error) => { end(); throw error; });
    });
  };
  /** `exclusively(fn, what, signal)`'s and `transaction(fn, signal, …)`'s signals. */
  const exclusiveSignal = (/** @type {any[]} */ args) => args[2];
  const transactionSignal = (/** @type {any[]} */ args) => args[1];

  const router = {
    primary,
    sessions,
    get synchronous() { return primary.synchronous; },
    get capabilities() { return primary.capabilities; },
    get dialect() { return primary.dialect; },
    /** The calling context, or `undefined` outside every root call. */
    context: () => storage.getStore(),
    /** Run `fn` in `context`: a cursor's pulls in the call that holds its session.
     * @param {any} context @param {() => any} fn */
    enter: (context, fn) => storage.run(context, fn),
    /** Whether the calling transaction is past its synchronous extent on the
     * session it holds — what decides nesting, as on one session. */
    get mustQueue() {
      const session = held();
      return session !== undefined ? session.mustQueue : freeFor(-1) < 0;
    },
    /** Whether a root call made now would wait for a session. */
    get wouldWait() { return !nests(-1) && freeFor(-1) < 0; },
    /** @param {string} sql */
    exec: (sql) => (held() ?? primary).exec(sql),
    /** @param {string} sql @param {any} [metadata] */
    prepare: (sql, metadata) => (held() ?? primary).prepare(sql, metadata),
    exclusively: routed('exclusively', -1, 'a store-level call', exclusiveSignal),
    transaction: routed('transaction', -1, 'a store transaction', transactionSignal),
    /** The first session for the calls that serve the store's own unit of
     * work, one at a time. */
    pinned: Object.freeze({
      get wouldWait() { return !nests(0) && freeFor(0) < 0; },
      exclusively: routed('exclusively', 0, 'a call on the store\'s own unit of work', exclusiveSignal),
      transaction: routed('transaction', 0, 'a write on the store\'s own unit of work', transactionSignal),
    }),
    shared: primary.shared,
    inShared: primary.inShared,
    session: primary.session,
    registerFunction: primary.registerFunction,
    registerAggregate: primary.registerAggregate,
    backup: primary.backup,
    /**
     * Close every session at once: a call still waiting is refused `JD2063`,
     * as one session's gate refuses its queue, and a transaction still
     * running meets its closed session. `discard` is the first session's
     * alone (it holds the owner lock); the first failure is reported.
     * @param {any} [closeOptions]
     */
    close: (closeOptions) => {
      closing = true;
      for (const waiter of waiting.splice(0)) waiter.leave(closed());
      return Promise.allSettled(sessions.map((session, i) =>
        Promise.resolve().then(() => session.close(i === 0 ? closeOptions : undefined))))
        .then((results) => {
          const failed = results.find((result) => result.status === 'rejected');
          if (failed !== undefined) throw /** @type {PromiseRejectedResult} */ (failed).reason;
        });
    },
  };
  return router;
}
