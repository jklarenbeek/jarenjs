//@ts-check
/**
 * @file The host half of the async-task convention (docs/TASKS.md).
 *
 * The convention has two halves and this module is deliberately only one
 * of them: **correctness lives in state** — a task slot's monotonic `id`
 * and the completion action's guard reject stale responses — while
 * **cancellation lives here**, as an optimization that stops wasting the
 * wire. An aborted fetch may already have resolved and its dispatch may
 * already be queued, so a host that only aborts is still wrong; the
 * state-side guard is the guarantee.
 *
 * No timers, no state beyond the per-slot controller map, no
 * dependencies (`AbortController` is platform).
 */

/**
 * The host's asynchronous function, typically wrapping `fetch`.
 * @callback TaskRun
 * @param {any} props - The effect's `with` value, verbatim.
 * @param {AbortSignal} signal - Aborted when a newer task claims the
 *   same slot; pass it to `fetch` (or ignore it — the state-side id
 *   guard stays correct either way).
 * @returns {Promise<any>} Resolves to a JSON result.
 */

/**
 * Package `run` as a registered effect handler implementing the
 * async-task convention. The effect's `with` props (all JSON):
 *
 *  - `id`   (REQUIRED) — the task identity, echoed back verbatim in the
 *    completion payload for the state-side guard;
 *  - `done` (REQUIRED) — the action dispatched on settle;
 *  - `fail` (OPTIONAL) — the action for rejections; absent, rejections
 *    dispatch `done` with `{ id, error }` instead of `{ id, result }` —
 *    one completion action guarding on `$payload.error` is the
 *    query-friendliest shape;
 *  - `slot` (OPTIONAL) — the concurrency key, default `""`; starting a
 *    task aborts the slot's in-flight predecessor;
 *  - anything else `run` needs (a URL, a query, ...).
 *
 * Settlement, exactly: a resolution dispatches
 * `done` with `{ id, result }`; an abort rejection (`err.name ===
 * "AbortError"`) dispatches **nothing** — a superseded task is dead by
 * design, its successor's dispatch carries the story; any other
 * rejection dispatches `fail ?? done` with `{ id, error }` where
 * `error` is a string, never an Error object — JSON only crosses the
 * boundary. Missing `id`/`done` is a host programming error: the
 * handler throws a `TypeError`, which the loop reports as `JA2007`.
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
 * @returns {(props: any, dispatch: (name: string, payload?: any) => void) => void}
 */
export function createTaskEffect(run) {
  /** In-flight controller per slot — the whole host-side state. */
  const controllers = new Map();

  return function taskEffect(props, dispatch) {
    if (props === null || typeof props !== 'object'
      || props.id === undefined || typeof props.done !== 'string') {
      throw new TypeError(
        'createTaskEffect: the effect props must carry an "id" and a "done" action name');
    }
    const slot = typeof props.slot === 'string' ? props.slot : '';
    const previous = controllers.get(slot);
    if (previous !== undefined) previous.abort();
    const controller = new AbortController();
    controllers.set(slot, controller);

    /** Drop the stored controller when it is still the current one. */
    const settle = () => {
      if (controllers.get(slot) === controller) controllers.delete(slot);
    };

    run(props, controller.signal).then(
      (result) => {
        settle();
        dispatch(props.done, { id: props.id, result });
      },
      (err) => {
        settle();
        if (err !== null && typeof err === 'object' && err.name === 'AbortError') return;
        const error = err instanceof Error ? err.message : String(err);
        dispatch(props.fail ?? props.done, { id: props.id, error });
      });
  };
}
