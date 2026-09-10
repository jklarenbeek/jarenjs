//@ts-check
/** Resumable bounded observation as an app subscription, independent of run cancellation. */
import { isJsonValue } from '@jarenjs/core/object';

/**
 * The injected readPage may invoke a public contract operation. One page is in
 * flight at a time; only current summary/cursor enters app state. No event log
 * or worker resources accumulate here. `wake` can wait for a notification or a
 * bounded poll; after a lost notification the next page resumes the durable cursor.
 * @param {{ readPage: (input: any, context: { signal: AbortSignal }) => any,
 * wake: (signal: AbortSignal) => any, pageSize?: number, maxBytes?: number }} options
 */
export function createRunObservation(options) {
  if (!options || typeof options.readPage !== 'function' || typeof options.wake !== 'function') throw new TypeError('run observation needs readPage and wake capabilities');
  const { readPage, wake, pageSize = 128, maxBytes = 262144 } = options;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('observation limits must be positive finite integers');
  /** @type {Set<AbortController>} */
  const observers = new Set();
  let disposed = false;
  /** @param {{ runId: string, id: number, cursor?: number, update: string, error: string }} props @param {(name: string, payload: any) => void} dispatch */
  function observe(props, dispatch) {
    if (!props || typeof props.runId !== 'string' || !props.runId || typeof props.update !== 'string' || typeof props.error !== 'string'
      || !Number.isSafeInteger(props.cursor ?? 0) || (props.cursor ?? 0) < 0) throw new TypeError('run observation needs runId, revision cursor and update/error actions');
    const controller = new AbortController();
    const { signal } = controller;
    if (disposed) { controller.abort(); return () => {}; }
    observers.add(controller);
    let cursor = props.cursor ?? 0;
    const stop = () => { controller.abort(); observers.delete(controller); };
    const poll = async () => {
      try {
        while (!signal.aborted) {
          const page = await readPage({ id: props.runId, after: cursor, limit: pageSize }, { signal });
          if (signal.aborted) return;
          if (!isJsonValue(page) || new TextEncoder().encode(JSON.stringify(page)).byteLength > maxBytes
            || typeof page.status !== 'string' || !Object.hasOwn(page, 'summary')
            || !['page', 'reset-required'].includes(page.state) || !Array.isArray(page.events) || page.events.length > pageSize
            || !Number.isSafeInteger(page.cursor) || page.cursor < cursor || !Number.isSafeInteger(page.revision) || page.revision < page.cursor
            || (page.more === true && page.cursor === cursor)) throw new TypeError('invalid run observation page');
          let seen = cursor;
          for (const event of page.events) {
            if (event.runId !== props.runId || !Number.isSafeInteger(event.revision) || event.revision <= seen || event.revision > page.cursor)
              throw new TypeError('invalid run event revision');
            seen = event.revision;
          }
          cursor = page.cursor;
          dispatch(props.update, { id: props.id, runId: props.runId, cursor, revision: page.revision,
            status: page.status, summary: page.summary, reset: page.state === 'reset-required' });
          if (page.more !== true) await wake(signal);
        }
      }
      catch {
        if (!signal.aborted) dispatch(props.error, { id: props.id, runId: props.runId, cursor, error: { code: 'run-observation-failed' } });
      }
      finally { observers.delete(controller); }
    };
    void poll();
    return stop;
  }
  /** Detach every observer; this never calls a run's cancel operation. */
  observe.dispose = () => { disposed = true; for (const observer of observers) observer.abort(); observers.clear(); };
  return observe;
}
