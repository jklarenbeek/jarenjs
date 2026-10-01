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
 * never queues. Statements go to the session the calling context holds.
 */
import { isThenable, chain } from '@jarenjs/core/function';
import { DbCompileError } from './errors.js';
import { abortReason } from './driver.js';

/**
 * @param {{ sessions: any[], storage: { run: (context: any, fn: () => any) => any, getStore: () => any },
 *   queueTimeout: number }} options
 * @returns {any} the connection surface a store uses, with `primary`, `pinned`, `context()` and `newContext`
 */
export function createSessionRouter({ sessions, storage, queueTimeout }) {
  const primary = sessions[0];
  const busy = sessions.map(() => false);
  /** Callers waiting for a session, in arrival order: `want` is the index a
   * pinned call needs, `-1` any. @type {{ want: number, take: (index: number) => void }[]} */
  const waiting = [];
  /** The session the calling context holds, or `undefined` outside any. */
  const held = () => storage.getStore()?.session;

  /** Give a session back: to the first waiter it suits, or to the free set.
   * @param {number} index */
  const release = (index) => {
    const at = waiting.findIndex((waiter) => waiter.want < 0 || waiter.want === index);
    if (at < 0) { busy[index] = false; return; }
    const [waiter] = waiting.splice(at, 1);
    waiter.take(index);
  };

  /**
   * A free session's index now — the one asked for, or any — or a promise of
   * it, bounded by `queueTimeout` (`JD0012`) and abandoned by `signal`.
   * @param {number} want @param {string} what @param {AbortSignal} [signal] @returns {number | Promise<number>}
   */
  const checkout = (want, what, signal) => {
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    // an ordinary call takes the highest free session: the first, which
    // serves the store's own unit of work, stays free while another is
    const index = want < 0 ? busy.lastIndexOf(false) : busy[want] ? -1 : want;
    if (index >= 0) { busy[index] = true; return index; }
    return new Promise((resolve, reject) => {
      /** @type {{ want: number, take: (index: number) => void }} */
      const waiter = { want, take: (at) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelled);
        resolve(at);
      } };
      const leave = (/** @type {any} */ error) => {
        const at = waiting.indexOf(waiter);
        if (at >= 0) waiting.splice(at, 1);
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelled);
        reject(error);
      };
      const timer = setTimeout(() => leave(new DbCompileError('JD0012',
        `${what} waited ${queueTimeout}ms for ${want < 0 ? `one of the store's ${sessions.length} sessions`
          : "the store's first session, which serves its own unit of work"}. A session runs one root call or `
        + 'transaction at a time; work that belongs INSIDE a transaction goes through the store the '
        + 'callback received (tx.collection / tx.entity / tx.transaction).')), queueTimeout);
      const cancelled = () => leave(abortReason(signal));
      signal?.addEventListener('abort', cancelled, { once: true });
      waiting.push(waiter);
    });
  };

  /**
   * A session's `method` for a root call: the held session while the calling
   * transaction is still on its own synchronous extent (a nested call), or
   * one checked out for the call — `want` names it for a pinned call — whose
   * callback runs in a context of its own.
   * @param {'exclusively' | 'transaction'} method @param {number} want
   * @param {string} what @param {(args: any[]) => AbortSignal | undefined} signalOf
   */
  const routed = (method, want, what, signalOf) => (/** @type {any[]} */ ...args) => {
    // a pinned call nests only on the session it is pinned to
    const session = held();
    if (session !== undefined && !session.mustQueue && (want < 0 || session === sessions[want])) return session[method](...args);
    const signal = signalOf(args);
    return chain(checkout(want, what, signal), (index) => {
      const chosen = sessions[index];
      /** @type {Record<string, any>} */
      const context = { ...router.newContext(), session: chosen };
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
    /** What a fresh root context starts with; the store sets it before any call.
     * @type {() => Record<string, any>} */
    newContext: () => ({}),
    /** The calling context, or `undefined` outside every root call. */
    context: () => storage.getStore(),
    /** Whether a root call made now would wait: the calling transaction is
     * past its synchronous extent, or every session is held. */
    get mustQueue() {
      const session = held();
      return session !== undefined ? session.mustQueue : !busy.includes(false);
    },
    /** @param {string} sql */
    exec: (sql) => (held() ?? primary).exec(sql),
    /** @param {string} sql @param {any} [metadata] */
    prepare: (sql, metadata) => (held() ?? primary).prepare(sql, metadata),
    exclusively: routed('exclusively', -1, 'a store-level call', exclusiveSignal),
    transaction: routed('transaction', -1, 'a store transaction', transactionSignal),
    /** The first session for the calls that serve the store's own unit of
     * work, one at a time. */
    pinned: Object.freeze({
      get mustQueue() {
        const session = held();
        return session !== undefined ? session.mustQueue : busy[0];
      },
      exclusively: routed('exclusively', 0, 'a call on the store\'s own unit of work', exclusiveSignal),
      transaction: routed('transaction', 0, 'a write on the store\'s own unit of work', transactionSignal),
    }),
    shared: primary.shared,
    inShared: primary.inShared,
    session: primary.session,
    registerFunction: primary.registerFunction,
    registerAggregate: primary.registerAggregate,
    backup: primary.backup,
    /** Close every session, the primary last: it holds the owner lease.
     * @param {any} [closeOptions] */
    close: (closeOptions) => {
      const rest = sessions.slice(1);
      const closeAt = (/** @type {number} */ i) => (i >= rest.length ? primary.close(closeOptions)
        : Promise.resolve().then(() => rest[i].close(closeOptions)).catch(() => undefined).then(() => closeAt(i + 1)));
      return closeAt(0);
    },
  };
  return router;
}
