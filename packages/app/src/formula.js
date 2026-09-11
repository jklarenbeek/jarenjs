//@ts-check
/** Own terminating formula workers; generation fences prevent stale publication. */
import { cloneJson, deepFreeze } from '@jarenjs/core/object';
import { canonicalizeJson } from '@jarenjs/json/canonical';

/**
 * A host supplies actual worker/isolate termination. terminate() MUST stop execution
 * and settle request(), including on cancellation. No same-thread deadline is offered.
 * @param {{workerFactory:()=>{request:(message:any)=>Promise<any>,terminate:()=>Promise<any>},timeoutMs?:number,maxInFlight?:number}} options
 */
export function createFormulaResource(options) {
  const timeoutMs = options?.timeoutMs ?? 1000;
  const maxInFlight = options?.maxInFlight ?? 2;
  if (typeof options?.workerFactory !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
    || !Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new TypeError('Invalid terminating formula worker capability');
  let generation = 0, disposed = false, teardown = null;
  const pending = new Set();
  return {
    /** Run one bounded batch in an isolate; replies must echo version/generation/revision. */
    run(payload, { revision = '', signal = undefined } = {}) {
      if (disposed || signal?.aborted) return Promise.resolve({ state: 'error', reason: disposed ? 'disposed' : 'cancelled' });
      if (pending.size >= maxInFlight) return Promise.resolve({ state: 'error', reason: 'in-flight' });
      canonicalizeJson(payload);
      if (typeof revision !== 'string') throw new TypeError('revision must be a string');
      const message = deepFreeze(cloneJson({ version: 1, generation: ++generation, revision, payload }));
      for (const active of pending) active.stop('superseded');
      let worker, request, termination, reason = null, timer;
      let stopped;
      const stopPromise = new Promise((resolve) => { stopped = resolve; });
      const terminate = () => termination ??= Promise.resolve().then(() => worker?.terminate());
      const entry = { promise: null, stop(why) { reason ??= why; stopped(); } };
      const abort = () => entry.stop('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      pending.add(entry);
      entry.promise = (async () => {
        try {
          worker = options.workerFactory();
          if (typeof worker?.request !== 'function' || typeof worker?.terminate !== 'function') throw new TypeError('Invalid formula worker');
          request = Promise.resolve().then(() => worker.request(message));
          timer = setTimeout(() => entry.stop('deadline'), timeoutMs);
          const reply = await Promise.race([request, stopPromise]);
          if (reason !== null) return { state: 'error', reason, generation: message.generation, revision };
          if (disposed || generation !== message.generation) return { state: 'invalidated', reason: 'superseded', generation: message.generation, revision };
          if (reply?.version !== 1 || reply.generation !== message.generation || reply.revision !== revision)
            return { state: 'invalidated', reason: 'worker-identity', generation: message.generation, revision };
          canonicalizeJson(reply.result);
          return deepFreeze(cloneJson({ state: 'complete', generation: message.generation, revision, result: reply.result }));
        }
        catch { return { state: 'error', reason: reason ?? 'worker-failed', generation: message.generation, revision }; }
        finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          try { await terminate(); }
          finally { await Promise.allSettled([request]); pending.delete(entry); }
        }
      })();
      return entry.promise;
    },
    /** All admitted work, including terminating requests, counts until drained. */
    stats() { return { pending: pending.size, generation, disposed }; },
    /** Stop admission, terminate every worker and await settlement. Idempotent. */
    dispose() {
      if (teardown) return teardown;
      disposed = true; generation++;
      for (const entry of pending) entry.stop('disposed');
      teardown = Promise.allSettled([...pending].map((entry) => entry.promise)).then(() => undefined);
      return teardown;
    },
  };
}
