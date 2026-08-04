//@ts-check
/**
 * @file `mapAsync` — the ONE explicit bounded-concurrency boundary
 * (LINQ-FORMAT.md §11). Element-wise asynchronous work (an HTTP call, a
 * model call, a file read per row) happens here and nowhere else: there
 * is no parallel universe of `selectAwait`-shaped operators, and a
 * per-element async *predicate* is `mapAsync` then `where`, by design.
 *
 * `concurrency` is REQUIRED — the unbounded default is how libraries
 * like this take down a downstream service. `mode` reuses the
 * `createTaskEffect` vocabulary (`parallel`/`concat`/`switch`/
 * `exhaust`) so a reader who knows one knows the other. Failure is
 * fail-closed: the first rejection aborts every in-flight callback and
 * the source, the `compileDag` discipline.
 */

import { LinqBuildError } from './errors.js';

const MODES = new Set(['parallel', 'concat', 'switch', 'exhaust']);

/**
 * Validate a mapAsync options bag at BUILD time.
 * @param {any} options
 * @returns {{ concurrency: number, mode: string, ordered: boolean }}
 */
export function normalizeMapAsyncOptions(options) {
  if (options === null || typeof options !== 'object'
    || !Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new LinqBuildError('JL0005',
      'mapAsync requires { concurrency: <positive integer> } — an unbounded default is a denial of service waiting for a slow downstream');
  }
  const mode = options.mode ?? 'parallel';
  if (!MODES.has(mode)) {
    throw new LinqBuildError('JL0005',
      `mapAsync mode must be one of parallel|concat|switch|exhaust, got '${mode}'`);
  }
  return { concurrency: options.concurrency, mode, ordered: options.ordered !== false };
}

/**
 * Apply one mapAsync stage over an async item stream. The returned
 * generator owns an AbortController: early termination (a downstream
 * `break`/`return`) and the first rejection both abort every in-flight
 * callback; the rejection then rethrows (fail closed, first failure
 * wins).
 * @param {AsyncIterator<any>} items
 * @param {(item: any, signal: AbortSignal) => any} fn
 * @param {{ concurrency: number, mode: string, ordered: boolean }} opts
 * @returns {AsyncGenerator<any>}
 */
export async function* applyMapAsync(items, fn, opts) {
  const controller = new AbortController();
  const { signal } = controller;

  try {
    if (opts.mode === 'concat' || (opts.mode === 'parallel' && opts.concurrency === 1)) {
      // strictly sequential; `concat` ignores the window by definition,
      // and parallel-of-one degenerates to it — but `switch`/`exhaust`
      // keep their racing semantics even at one in-flight task
      for (;;) {
        const step = await items.next();
        if (step.done) return;
        yield await fn(step.value, signal);
        if (signal.aborted) return;
      }
    }

    if (opts.mode === 'switch' || opts.mode === 'exhaust') {
      // one in-flight task, with the source pulled EAGERLY: the next
      // item races the running work. `switch` supersedes the task when
      // a newer item wins the race (the task's own signal aborts and
      // its result is discarded); `exhaust` drops the newer item.
      const PULL = Symbol('pull');
      let pending = items.next().then((step) => ({ [PULL]: step }));
      let task = null; // { promise, abort }
      let exhausted = false;
      while (!exhausted || task !== null) {
        const race = task === null
          ? [pending]
          : [pending, task.promise.then((value) => ({ value }))];
        const won = await Promise.race(exhausted && task !== null ? [race[1]] : race);
        if (won !== undefined && PULL in won) {
          const step = won[PULL];
          if (step.done) {
            exhausted = true;
            pending = new Promise(() => {}); // never resolves again
            continue;
          }
          pending = items.next().then((s) => ({ [PULL]: s }));
          if (task !== null) {
            if (opts.mode === 'exhaust') continue; // drop while busy
            task.abort.abort(); // switch: supersede, discard
            task.promise.catch(() => {}); // superseded rejections are moot
            task = null;
          }
          const abort = new AbortController();
          const onOuter = () => abort.abort();
          signal.addEventListener('abort', onOuter, { once: true });
          const current = {
            abort,
            promise: Promise.resolve(fn(step.value, abort.signal))
              .finally(() => signal.removeEventListener('abort', onOuter)),
          };
          task = current;
          continue;
        }
        // the task settled while still current
        const { value } = /** @type {{ value: any }} */ (won);
        task = null;
        yield value;
      }
      return;
    }

    // parallel: a sliding window of `concurrency` in-flight tasks
    const window = [];
    let sourceDone = false;
    const pull = async () => {
      const step = await items.next();
      if (step.done) { sourceDone = true; return null; }
      const promise = Promise.resolve(fn(step.value, signal));
      // a rejection must wait its turn in the ordered window without
      // firing unhandledRejection while an earlier task is in flight
      promise.catch(() => {});
      return { promise };
    };
    if (opts.ordered) {
      // completion order = source order; the window buffers at most
      // `concurrency` results (the documented buffering cost)
      while (!sourceDone && window.length < opts.concurrency) {
        const task = await pull();
        if (task !== null) window.push(task.promise);
      }
      while (window.length > 0) {
        const value = await window.shift();
        if (!sourceDone) {
          const task = await pull();
          if (task !== null) window.push(task.promise);
        }
        yield value;
      }
      return;
    }
    // unordered: yield on completion
    let nextId = 0;
    const inflight = new Map();
    const start = async () => {
      const step = await items.next();
      if (step.done) { sourceDone = true; return; }
      const id = nextId++;
      inflight.set(id, Promise.resolve(fn(step.value, signal)).then(
        (value) => ({ id, value }),
        (error) => { throw Object.assign(error ?? new Error('mapAsync failed'), { __mapAsyncId: id }); }));
    };
    while (!sourceDone && inflight.size < opts.concurrency) await start();
    while (inflight.size > 0) {
      let settled;
      try {
        settled = await Promise.race(inflight.values());
      }
      catch (err) {
        inflight.delete(/** @type {any} */ (err).__mapAsyncId);
        throw err;
      }
      inflight.delete(settled.id);
      if (!sourceDone) await start();
      yield settled.value;
    }
  }
  catch (err) {
    controller.abort();
    throw err;
  }
  finally {
    controller.abort(); // early termination aborts in-flight work
    if (typeof items.return === 'function') await items.return(undefined);
  }
}
