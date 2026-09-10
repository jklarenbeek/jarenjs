//@ts-check
/** Adopt application run records without adding an orchestration engine. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { compileWorkflow } from './workflow.js';

/**
 * Bind one compiled workflow to mapped run/checkpoint persistence. Leases are
 * the existing queue's capabilities; resources stay private and release only
 * after tasks drain and final cancellation/failure observation is persisted.
 * @param {any} document @param {{ store: any, schemaVersion: string, tasks?: any }} options
 */
export function createDomainRun(document, options) {
  if (!options?.store || typeof options.schemaVersion !== 'string' || !options.schemaVersion
    || ['attach', 'load', 'save', 'get', 'finish', 'requestCancel'].some((name) => typeof options.store[name] !== 'function'))
    throw new TypeError('domain run needs a mapped run store and schemaVersion');
  const { store, schemaVersion } = options;
  const workflowIdentity = canonicalizeJson(document);
  const active = new Map();
  const bound = (id) => {
    const attempt = active.get(id);
    if (!attempt) throw new TypeError('run has no active attempt');
    return attempt;
  };
  const workflow = compileWorkflow(document, { tasks: options.tasks, store: {
    load: (id) => { const attempt = bound(id); return store.load(id, attempt.identity, attempt.lease()); },
    save: (id, snapshot, expected) => store.save(id, snapshot, expected, bound(id).lease()),
  } });
  return Object.freeze({
    /** @param {string} id @param {any} input @param {{ lease: any, signal?: AbortSignal, release?: Function, event?: any, [key: string]: any }} resources */
    async run(id, input, resources) {
      if (active.has(id)) throw new TypeError('domain run is already active in this runner');
      const lease = () => typeof resources.lease === 'function' ? resources.lease() : resources.lease;
      const identity = { id, jobId: lease()?.jobId, workflow: workflowIdentity, schemaVersion };
      const controller = new AbortController();
      const signal = resources.signal ? AbortSignal.any([controller.signal, resources.signal]) : controller.signal;
      const drained = Promise.withResolvers();
      const attempt = { identity, lease, controller, drained: drained.promise };
      active.set(id, attempt);
      let attached = false;
      try {
        await store.attach(identity, lease()); attached = true;
        return await workflow.run(input, { runId: id, signal, resources, event: resources.event });
      }
      catch (error) {
        if (attached) {
          const record = await store.get(id);
          await store.finish(id, record.cancelRequested || signal.aborted ? 'cancelled' : 'failed', lease());
        }
        throw error;
      }
      finally {
        active.delete(id);
        try { await resources.release?.(); }
        finally { drained.resolve(undefined); }
      }
    },
    /** Cancellation authority is checked by the host's command. Navigation must
     * detach observation, not call this method. Remote workers see durable intent
     * at the next checkpoint; local workers abort and drain before this resolves.
     * @param {string} id @param {number} revision @param {{ actor: string, reason: string }} evidence */
    async cancel(id, revision, evidence) {
      await store.requestCancel(id, revision, evidence);
      const attempt = active.get(id);
      if (attempt) { attempt.controller.abort(); await attempt.drained; }
      return store.get(id);
    },
  });
}
