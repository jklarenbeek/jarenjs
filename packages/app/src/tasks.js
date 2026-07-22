//@ts-check
/**
 * @file The host half of the async-task convention (docs/TASKS.md).
 *
 * The convention has two halves and this module is deliberately only one
 * of them: **correctness lives in state** — a task slot's monotonic `id`
 * and the completion action's guard reject stale responses — while
 * **cancellation and concurrency live here**, as an optimization that
 * stops wasting the wire. An aborted fetch may already have resolved and
 * its dispatch may already be queued, so a host that only aborts is
 * still wrong; the state-side guard is the guarantee.
 *
 * No timers, no state beyond the per-slot records, no dependencies
 * (`AbortController` is platform).
 */

import { toError, isErrorSafely, safeErrorMessage } from './errors.js';

/**
 * Read a rejection value's `name` without trusting it: `typeof` is
 * untrappable, the property read is guarded — a revoked proxy or a
 * throwing accessor classifies as "not an AbortError".
 * @param {unknown} err
 * @returns {string | null}
 */
function safeName(err) {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return null;
  try {
    const name = /** @type {any} */ (err).name;
    return typeof name === 'string' ? name : null;
  }
  catch {
    return null;
  }
}

/**
 * The `{ id, error }` payload string for a rejection, TOTAL for every
 * value: primitives stringify verbatim (the established payload
 * contract); Errors project their message through the safe accessor;
 * objects, functions and symbols go through the normalizer — no host
 * `toString`/`Symbol.toPrimitive` is ever invoked.
 * @param {unknown} err
 * @returns {string}
 */
function rejectionText(err) {
  if (isErrorSafely(err)) return safeErrorMessage(err);
  if (err === null
    || (typeof err !== 'object' && typeof err !== 'function' && typeof err !== 'symbol')) {
    return String(err);
  }
  return toError(err).message;
}

/**
 * The host's task function, typically wrapping `fetch`. A synchronous
 * return is allowed — the effect settles every result through one
 * uniform promise boundary either way.
 * @callback TaskRun
 * @param {any} props - The effect's `with` value, verbatim.
 * @param {AbortSignal} signal - Aborted when the slot's concurrency mode
 *   supersedes this task, when the host cancels the slot, or when the
 *   effect is disposed; pass it to `fetch` (or ignore it — the
 *   state-side id guard stays correct either way).
 * @returns {any | PromiseLike<any>} The JSON result, or a promise of it.
 */

/**
 * Per-slot concurrency modes (APP-FORMAT §9.2):
 *
 *  - `"switch"`   (default) — starting a task aborts the slot's
 *    in-flight predecessor; the newest request wins.
 *  - `"exhaust"`  — while the slot has an in-flight task, new starts are
 *    ignored entirely (nothing dispatched) — the mode for a
 *    non-idempotent commit where a double-click must not double-run.
 *  - `"concat"`   — new starts queue and run one after another, in
 *    order — only for deliberately ordered commands.
 *  - `"parallel"` — every start runs concurrently; the consumer owns
 *    the merge rule.
 *
 * Whatever the mode, correctness stays visible in JSON state: the task
 * slot's monotonic `id` and the completion action's guard remain the
 * authority on which response may land.
 * @typedef {'switch' | 'exhaust' | 'concat' | 'parallel'} TaskMode
 */

/**
 * @typedef {Object} TaskEffectOptions
 * @property {TaskMode} [mode] - The per-slot concurrency mode
 *   (default `"switch"`).
 */

/**
 * The effect handler returned by {@link createTaskEffect}, with its
 * host-side controls.
 * @typedef {((props: any, dispatch: (name: string, payload?: any) => void) => void) & {
 *   cancel: (slot?: string) => void,
 *   cancelAll: () => void,
 *   dispose: () => void,
 * }} TaskEffect
 */

/**
 * Package `run` as a registered effect handler implementing the
 * async-task convention. The effect's `with` props (all JSON):
 *
 *  - `id`   (REQUIRED) — the task identity, echoed back verbatim in the
 *    completion payload for the state-side guard;
 *  - `done` (REQUIRED) — the action dispatched on settle;
 *  - `fail` (OPTIONAL, string) — the action for rejections; absent,
 *    rejections dispatch `done` with `{ id, error }` instead of
 *    `{ id, result }` — one completion action guarding on
 *    `$payload.error` is the query-friendliest shape;
 *  - `slot` (OPTIONAL, string) — the concurrency key, default `""`;
 *    what a new start does to the slot's in-flight task is the
 *    effect's `mode` (see {@link TaskMode});
 *  - anything else `run` needs (a URL, a query, ...).
 *
 * Settlement, exactly: `run` is invoked through a uniform promise
 * boundary, so a synchronous throw and a non-promise return settle
 * through the same path as a rejection/resolution. A resolution
 * dispatches `done` with `{ id, result }`; an abort rejection
 * (`err.name === "AbortError"`) dispatches **nothing** — a superseded
 * task is dead by design, its successor's dispatch carries the story;
 * any other rejection dispatches `fail ?? done` with `{ id, error }`
 * where `error` is a string, never an Error object — JSON only crosses
 * the boundary. After `dispose()` no settlement dispatches anything.
 * A malformed `id`/`done`/`fail`/`slot` is a host programming error:
 * the handler throws a `TypeError`, which the loop reports as `JA2007`.
 * Settlement is TOTAL for every rejection value (hostile accessors,
 * revoked proxies included) and never creates an unhandled rejection
 * from framework code; a settlement dispatch that itself throws (a
 * rethrowing error sink surfacing at the dispatch boundary) is
 * re-raised on its own microtask so the host's global error handling
 * observes it.
 *
 * Host-side controls on the returned handler:
 *
 *  - `cancel(slot)` — abort the slot's in-flight task(s) and discard
 *    its queued (`concat`) starts;
 *  - `cancelAll()`  — `cancel` for every slot;
 *  - `dispose()`    — terminal: `cancelAll()` plus a permanent guard —
 *    late settlements can no longer dispatch, and new starts are
 *    ignored. Idempotent. `app.destroy()` calls it automatically for
 *    every registered handler exposing it.
 *
 * @example
 * createApp(doc, {
 *   effects: {
 *     http: createTaskEffect((props, signal) =>
 *       fetch(props.url, { signal }).then((r) => r.json())),
 *   },
 * });
 *
 * @param {TaskRun} run
 * @param {TaskEffectOptions} [options]
 * @returns {TaskEffect}
 */
export function createTaskEffect(run, options = {}) {
  const mode = options.mode ?? 'switch';
  if (mode !== 'switch' && mode !== 'exhaust' && mode !== 'concat' && mode !== 'parallel') {
    throw new TypeError(`createTaskEffect: unknown mode '${String(mode)}'`);
  }

  /**
   * Per-slot bookkeeping: the in-flight controllers and, for `concat`,
   * the pending starts.
   * @type {Map<string, { active: Set<AbortController>, queue: Array<[any, (name: string, payload?: any) => void]> }>}
   */
  const slots = new Map();
  let disposed = false;

  /** @param {string} slot */
  function slotRecord(slot) {
    let record = slots.get(slot);
    if (record === undefined) {
      record = { active: new Set(), queue: [] };
      slots.set(slot, record);
    }
    return record;
  }

  /**
   * Launch one task on a slot through the uniform promise boundary.
   * @param {{ active: Set<AbortController>, queue: Array<[any, (name: string, payload?: any) => void]> }} record
   * @param {any} props
   * @param {(name: string, payload?: any) => void} dispatch
   */
  function launch(record, props, dispatch) {
    const controller = new AbortController();
    record.active.add(controller);

    /** Release this task's controller and, for `concat`, start the next. */
    const settle = () => {
      record.active.delete(controller);
      if (mode === 'concat' && !disposed && record.active.size === 0 && record.queue.length > 0) {
        const next = /** @type {[any, (name: string, payload?: any) => void]} */ (record.queue.shift());
        launch(record, next[0], next[1]);
      }
    };

    // the uniform boundary: a synchronous throw from `run` and a
    // non-promise return settle exactly like a rejection/resolution
    new Promise((resolve) => { resolve(run(props, controller.signal)); }).then(
      (result) => {
        settle();
        if (disposed) return;
        try {
          dispatch(props.done, { id: props.id, result });
        }
        catch (thrown) {
          queueMicrotask(() => { throw thrown; });
        }
      },
      (err) => {
        settle();
        if (disposed) return;
        // abort classification is TOTAL and classifies the REJECTION
        // VALUE only (`safeName` guards the read): the signal state
        // must not suppress — a superseded task's non-abort failure
        // still dispatches by contract, and only the state-side id
        // guard rejects it. A hostile value never breaks settlement.
        if (safeName(err) === 'AbortError') return;
        const error = rejectionText(err);
        // a settlement dispatch that itself throws (a rethrowing error
        // sink surfacing at the dispatch boundary) must not become an
        // unobservable promise rejection: it is re-raised on its own
        // microtask so the host's global error handling observes it
        try {
          dispatch(props.fail ?? props.done, { id: props.id, error });
        }
        catch (thrown) {
          queueMicrotask(() => { throw thrown; });
        }
      });
  }

  /** @type {any} */
  const taskEffect = function taskEffect(props, dispatch) {
    if (props === null || typeof props !== 'object'
      || props.id === undefined || typeof props.done !== 'string') {
      throw new TypeError(
        'createTaskEffect: the effect props must carry an "id" and a "done" action name');
    }
    if (props.fail !== undefined && typeof props.fail !== 'string') {
      throw new TypeError('createTaskEffect: "fail" must be an action name');
    }
    if (props.slot !== undefined && typeof props.slot !== 'string') {
      throw new TypeError('createTaskEffect: "slot" must be a string');
    }
    if (disposed) return;
    const record = slotRecord(props.slot ?? '');

    if (record.active.size > 0) {
      if (mode === 'exhaust') return;
      if (mode === 'concat') {
        record.queue.push([props, dispatch]);
        return;
      }
      if (mode === 'switch') {
        for (const controller of record.active) controller.abort();
        record.active.clear();
      }
      // parallel: fall through, the new task joins the slot
    }
    launch(record, props, dispatch);
  };

  /**
   * Abort a slot's in-flight task(s) and discard its queued starts.
   * Aborted settlements dispatch nothing (the AbortError rule).
   * @param {string} [slot]
   */
  taskEffect.cancel = function cancel(slot = '') {
    const record = slots.get(slot);
    if (record === undefined) return;
    record.queue.length = 0;
    for (const controller of record.active) controller.abort();
    record.active.clear();
  };

  /** `cancel` every slot. */
  taskEffect.cancelAll = function cancelAll() {
    for (const slot of slots.keys()) taskEffect.cancel(slot);
  };

  /**
   * Terminal: cancel everything and permanently prevent both new starts
   * and late-settlement dispatches. Idempotent.
   */
  taskEffect.dispose = function dispose() {
    if (disposed) return;
    disposed = true;
    taskEffect.cancelAll();
    slots.clear();
  };

  return taskEffect;
}
