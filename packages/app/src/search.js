//@ts-check
/** Private index ownership over an injected, draining worker capability. */
import { compileLexical } from '@jarenjs/core/search';
import { utf8ByteLength } from '@jarenjs/core/string';

/**
 * Own one worker and one published index. Worker request/reply envelopes carry
 * version, requestId, generation and sourceRevision; build replies carry snapshots.
 * dispose() on the injected worker must settle every request, including aborted ones.
 * @param {import('@jarenjs/core/search').LexicalDefinition} definition
 * @param {{workerFactory:()=>{request:(message:any, options:any)=>Promise<any>, dispose:()=>any},
 * maxInFlight?:number, onProgress?:(progress:any)=>void}} options
 */
export function createSearchResource(definition, options) {
  const compiled = compileLexical(definition), maxInFlight = options?.maxInFlight ?? 2;
  if (typeof options?.workerFactory !== 'function' || !Number.isSafeInteger(maxInFlight) || maxInFlight < 1)
    throw new TypeError('Invalid search worker capability');
  const fields = [...new Set(['id', ...compiled.config.fields])];
  let worker = null, index = compiled.create(), disposed = false, ticket = 0, generation = -1, teardown = null;
  const pending = new Map();
  return {
    /** @param {any[]} documents @param {{generation:number, sourceRevision:string, requestId:string}} identity @param {AbortSignal} [signal] */
    build(documents, identity, signal) {
      identity = { ...identity };
      const refuse = (state, reason) => ({ ...identity, state, reason });
      if (disposed) return Promise.resolve(refuse('error', 'disposed'));
      if (signal?.aborted) return Promise.resolve(refuse('error', 'cancelled'));
      if (!identity || !Number.isSafeInteger(identity.generation) || identity.generation < 0
        || typeof identity.sourceRevision !== 'string' || typeof identity.requestId !== 'string')
        return Promise.resolve(refuse('error', 'invalid-identity'));
      if (identity.generation <= generation) return Promise.resolve(refuse('invalidated', 'stale-generation'));
      if (pending.size >= maxInFlight) return Promise.resolve(refuse('budget-exhausted', 'in-flight'));
      if (!Array.isArray(documents)) return Promise.resolve(refuse('error', 'invalid-documents'));
      if (documents.length > compiled.config.limits.maxDocuments) return Promise.resolve(refuse('budget-exhausted', 'documents'));
      const projected = []; let bytes = 0;
      for (const document of documents) {
        const row = {};
        for (const field of fields) {
          const value = document && Object.hasOwn(document, field) ? document[field] ?? '' : '';
          if (typeof value !== 'string' || (field === 'id' && !value)) return Promise.resolve(refuse('error', 'invalid-documents'));
          if (value.length > compiled.config.limits.maxFieldBytes) return Promise.resolve(refuse('budget-exhausted', 'field-bytes'));
          const length = utf8ByteLength(value);
          if (length > compiled.config.limits.maxFieldBytes) return Promise.resolve(refuse('budget-exhausted', 'field-bytes'));
          bytes += length;
          if (bytes > compiled.config.limits.maxSourceBytes || bytes * 4 + projected.length * 128 > compiled.config.limits.maxTemporaryBytes)
            return Promise.resolve(refuse('budget-exhausted', 'source-bytes'));
          Object.defineProperty(row, field, { value, enumerable: true });
        }
        projected.push(row);
      }
      for (const controller of pending.keys()) controller.abort();
      generation = identity.generation; const mine = ++ticket, controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      let lastWork = -1;
      const run = async () => {
        try {
          worker ??= options.workerFactory();
          if (typeof worker?.request !== 'function' || typeof worker?.dispose !== 'function') throw new TypeError('Invalid search worker');
          const reply = await worker.request({ version: 1, operation: 'build', definition: compiled.config, ...identity, documents: projected }, {
            signal: controller.signal,
            onProgress(progress) {
              if (!disposed && !controller.signal.aborted && mine === ticket && progress?.version === 1
                && ['generation', 'requestId', 'sourceRevision'].every((key) => progress[key] === identity[key])
                && Number.isSafeInteger(progress.work) && progress.work >= 0 && progress.work >= lastWork) {
                lastWork = progress.work; options.onProgress?.({ ...identity, work: progress.work });
              }
            },
          });
          if (disposed) return refuse('error', 'disposed');
          if (mine !== ticket) return refuse('invalidated', 'superseded');
          if (controller.signal.aborted) return refuse('error', 'cancelled');
          if (reply?.version !== 1 || !['generation', 'requestId', 'sourceRevision'].every((key) => reply[key] === identity[key]))
            return refuse('invalidated', 'worker-identity');
          if (reply.state !== 'complete') return refuse(['error', 'budget-exhausted'].includes(reply.state) ? reply.state : 'error', reply.reason ?? 'incomplete-worker');
          const candidate = compiled.create();
          const loaded = candidate.restore(reply.snapshot, identity);
          if (loaded.state !== 'complete') { candidate.dispose(); return refuse(loaded.state, loaded.reason); }
          const old = index; index = candidate; old.dispose();
          return { ...identity, state: 'complete', documents: index.stats().documents };
        }
        catch (error) { return refuse('error', disposed ? 'disposed' : controller.signal.aborted ? 'cancelled' : String(error?.message ?? error)); }
      };
      const promise = run().finally(() => { pending.delete(controller); signal?.removeEventListener('abort', abort); });
      pending.set(controller, promise); return promise;
    },
    /** @param {string} text @param {any} [options] */
    search(text, options) { return index.search(text, options); },
    stats() { return { ...index.stats(), workers: worker ? 1 : 0, pending: pending.size }; },
    /** Stop admission, fence callbacks, terminate the worker and drain its requests. */
    dispose() {
      if (teardown) return teardown;
      disposed = true; ticket++; for (const controller of pending.keys()) controller.abort(); index.dispose();
      teardown = (async () => {
        try { await worker?.dispose(); }
        finally { await Promise.allSettled(pending.values()); worker = null; }
      })();
      return teardown;
    },
  };
}
