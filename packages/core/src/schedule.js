//@ts-check
/** Bounded fair admission, with per-scope spacing and drained shutdown. */
import { sleep as defaultSleep } from './retry.js';

/**
 * @typedef {Object} ScheduleOptions
 * @property {number} [concurrency]
 * @property {number} [maxQueue]
 * @property {number} [spacingMs]
 * @property {number} [maxScopes]
 * @property {() => number} [now]
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 */

/**
 * Round-robin admission among ready scopes; FIFO inside each scope. Closing
 * stops admission immediately and waits for admitted work, including workers
 * which ignore cancellation. A host must keep resources until close settles.
 * @param {ScheduleOptions} [options]
 */
export function createScheduler(options = {}) {
  const { concurrency = 4, maxQueue = 64, maxScopes = 256, spacingMs = 0, now = Date.now, sleep = defaultSleep } = options;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1
    || !Number.isSafeInteger(maxQueue) || maxQueue < 1
    || !Number.isSafeInteger(maxScopes) || maxScopes < 1
    || !Number.isFinite(spacingMs) || spacingMs < 0
    || typeof now !== 'function' || typeof sleep !== 'function')
    throw new TypeError('scheduler needs finite concurrency, queue and spacing bounds and clock/sleep functions');
  /** @type {any[]} */
  const queue = [];
  /** @type {Map<string, number>} */
  const ready = new Map();
  const turns = new Map();
  let turn = 0;
  let lastScope = '';
  let active = 0;
  let closed = false;
  let scheduled = false;
  /** @type {AbortController | null} */
  let wake = null;
  /** @type {Array<() => void>} */
  const drained = [];

  function kick() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(pump);
  }

  function pump() {
    scheduled = false;
    wake?.abort();
    wake = null;
    let at = now();
    function prune() {
      at = now();
      for (let i = queue.length - 1; i >= 0; i--) {
        const item = queue[i];
        const reason = closed ? 'closed' : item.signal?.aborted ? 'cancelled' : item.deadline <= at ? 'deadline' : null;
        if (reason !== null) {
          queue.splice(i, 1);
          item.cleanup();
          item.reject(new Error(reason));
        }
      }
    }
    prune();
    while (active < concurrency && queue.length) {
      prune();
      let index = -1;
      let oldest = Infinity;
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        const served = turns.get(item.scope) ?? (item.scope === lastScope ? turn : 0);
        if ((ready.get(item.scope) ?? 0) <= at && served < oldest) { index = i; oldest = served; }
      }
      if (index < 0) break;
      const [item] = queue.splice(index, 1);
      item.cleanup();
      lastScope = item.scope;
      turns.set(item.scope, ++turn);
      ready.set(item.scope, at + spacingMs);
      active++;
      // Invoke in this turn, so no cancellation microtask can slip between
      // admission and the worker's own dispatch/authority check.
      let answer;
      try { answer = item.worker(); }
      catch (error) { answer = Promise.reject(error); }
      Promise.resolve(answer).then(item.resolve, item.reject).finally(() => {
        active--;
        kick();
      });
    }
    // Spacing state for inactive scopes expires, bounding retention by the
    // rate window and active/queued scopes rather than the lifetime of a host.
    for (const [scope, time] of ready) if (time <= at && !queue.some((item) => item.scope === scope)) ready.delete(scope);
    for (const scope of turns.keys()) if (!queue.some((item) => item.scope === scope)) turns.delete(scope);
    if (queue.length) {
      let next = Math.min(...queue.map((item) => item.deadline));
      if (active < concurrency) next = Math.min(next, ...queue.map((item) => ready.get(item.scope) ?? at));
      if (Number.isFinite(next)) {
        const controller = new AbortController();
        wake = controller;
        Promise.resolve().then(() => sleep(Math.max(0, next - now()), controller.signal)).then(() => {
          if (!controller.signal.aborted) kick();
        }, (error) => {
          if (controller.signal.aborted) return;
          closed = true;
          for (const item of queue.splice(0)) { item.cleanup(); item.reject(error); }
          kick();
        });
      }
    }
    if (!active && !queue.length) for (const resolve of drained.splice(0)) resolve();
  }

  return Object.freeze({
    /** @template T @param {() => T | Promise<T>} worker
     * @param {{ scope?: string, signal?: AbortSignal, deadline?: number }} [context]
     * @returns {Promise<T>} */
    run(worker, { scope = '', signal, deadline = Infinity } = {}) {
      if (typeof worker !== 'function' || typeof scope !== 'string' || typeof deadline !== 'number' || Number.isNaN(deadline))
        return Promise.reject(new TypeError('scheduler needs a worker, scope and deadline'));
      const reason = closed ? 'closed' : signal?.aborted ? 'cancelled' : deadline <= now() ? 'deadline'
        : queue.length >= maxQueue ? 'queue-full' : null;
      if (reason !== null) return Promise.reject(new Error(reason));
      for (const [name, time] of ready) if (time <= now()) ready.delete(name);
      const scopes = new Set([...ready.keys(), ...queue.map((item) => item.scope)]);
      if (!scopes.has(scope) && scopes.size >= maxScopes) return Promise.reject(new Error('scope-limit'));
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', kick, { once: true });
        queue.push({ worker, scope, signal, deadline, resolve, reject,
          cleanup: () => signal?.removeEventListener('abort', kick) });
        kick();
      });
    },
    /** A server observation delays all following work in its scope.
     * @param {string} scope @param {number} delayMs */
    observe(scope, delayMs) {
      if (typeof scope !== 'string' || !Number.isFinite(delayMs) || delayMs < 0)
        throw new TypeError('rate observation needs a scope and a nonnegative delay');
      if (closed) return;
      for (const [name, time] of ready) if (time <= now()) ready.delete(name);
      if (!ready.has(scope) && ready.size >= maxScopes) throw new Error('scope-limit');
      ready.set(scope, Math.max(ready.get(scope) ?? 0, now() + delayMs));
      kick();
    },
    /** @returns {Promise<void>} */
    close() {
      closed = true;
      kick();
      return new Promise((resolve) => { drained.push(resolve); });
    },
    stats: () => ({ active, queued: queue.length, closed }),
  });
}
