//@ts-check
/**
 * @file The bounded ordered asynchronous map: run a worker over a list
 * with never more than `limit` calls in flight, and answer the results
 * in the list's order. Before this file the same twelve lines lived in
 * the AI package's program runner and in the benchmark harness, and a
 * downstream consumer had written them a third time; a pool that exists
 * once is one whose edge behavior can be pinned once.
 *
 * The contract, in full:
 *
 *  - results are in INPUT order, whatever order the workers finish in;
 *  - never more than `limit` workers are in flight; `limit` must be a
 *    number of at least 1 (`Infinity` is allowed and means unbounded) —
 *    anything else is a `TypeError`, never a silent clamp, because a
 *    limit of 0 is a bug in the caller and "sequential" is spelled 1;
 *  - a worker rejection stops dispatch: no item starts after it, the
 *    workers already in flight are awaited, and only then does the map
 *    reject with that first rejection. A worker that throws
 *    synchronously is a rejection;
 *  - an abort does the same, rejecting with the signal's reason; a signal
 *    that is already aborted rejects before any worker runs;
 *  - so when the returned promise settles, NO worker is still running —
 *    the caller can close whatever the workers were using.
 *
 * The map does not retry, rate-limit, delay per origin or know anything
 * about what the worker does; those are the caller's policies around it.
 */

/**
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit - workers in flight at once; a number >= 1, `Infinity` for unbounded
 * @param {(item: T, index: number) => Promise<R> | R} worker
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<R[]>} the results, in input order
 * @throws {TypeError} (as a rejection) when `limit` is not a number >= 1
 */
export async function mapConcurrent(items, limit, worker, options = {}) {
  if (typeof limit !== 'number' || !(limit >= 1))
    throw new TypeError(`mapConcurrent needs a limit of at least 1, got ${String(limit)}`);
  const { signal } = options;
  if (signal?.aborted) throw signal.reason;
  const count = items.length;
  /** @type {R[]} */
  const results = new Array(count);
  if (count === 0) return results;

  let next = 0;
  // the first failure or abort, kept as a one-element list: the lanes
  // stop dispatching the moment it is set and drain what they hold
  /** @type {unknown[]} */
  const stop = [];
  /** @type {(() => void) | undefined} */
  let onAbort;
  if (signal !== undefined) {
    onAbort = () => { if (stop.length === 0) stop.push(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const lane = async () => {
    while (stop.length === 0) {
      const index = next++;
      if (index >= count) return;
      try {
        results[index] = await worker(items[index], index);
      }
      catch (error) {
        if (stop.length === 0) stop.push(error);
      }
    }
  };
  const lanes = Array.from({ length: Math.min(limit, count) }, lane);
  await Promise.all(lanes);
  if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  if (stop.length > 0) throw stop[0];
  return results;
}
