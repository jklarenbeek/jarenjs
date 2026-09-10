//@ts-check
/** External effects orchestrate existing workflows, provider admission and fenced storage. */
import { deepFreeze } from '@jarenjs/core/object';
import { compileWorkflow } from './workflow.js';

/**
 * The provider executor is single-attempt for this composition. Its dispatch
 * hook persists intent after scheduling/authority checks and before transport.
 * Every ambiguous result stays unresolved; read-back/operator reconciliation is
 * explicit. A new worker may inspect the record but cannot blindly resend it.
 * @param {{ store: any, executor: any, authorize: Function, classify: Function }} options
 */
export function createExternalEffects(options) {
  if (!options || typeof options.executor?.execute !== 'function' || typeof options.authorize !== 'function'
    || typeof options.classify !== 'function' || ['get', 'begin', 'settle', 'recover'].some((name) => typeof options.store?.[name] !== 'function'))
    throw new TypeError('external effects need a fenced store, provider executor, authorization and evidence classifier');
  const { store, executor, authorize, classify } = options;
  const workflow = compileWorkflow({ $workflow: '0.2', revision: 'external-effects/1', initial: 'send', states: {
    send: { work: { task: 'send', version: '1' }, then: 'done' }, done: { final: true },
  } }, { tasks: { send: { version: '1', run: async ({ input }, signal, resources) => {
    const lease = () => typeof resources.lease === 'function' ? resources.lease() : resources.lease;
    let record = await store.get(input.id);
    if (await authorize(deepFreeze(record.plan), 'resume', resources) !== true) return { state: 'refused', reason: 'unauthorized' };
    record = (await store.recover(record.id, record.revision, lease())).record;
    deepFreeze(record.plan);
    for (const planned of record.plan.legs) {
      const leg = record.legs.find((value) => value.id === planned.id);
      if (leg.state === 'confirmed' || leg.state === 'rejected') continue;
      if (signal.aborted) return { state: 'cancelled', revision: record.revision };
      if (leg.state === 'unresolved') return { state: 'unresolved', revision: record.revision, leg: leg.id };
      let started = false, used = 0;
      const budget = { safety: planned.request.safety, get used() { return used; }, get remaining() { return 1 - used; }, take: () => used++ === 0 };
      let response;
      try {
        response = await executor.execute(planned.request, { signal, budget, beforeDispatch: async () => {
          if (started || await authorize(deepFreeze(record.plan), 'dispatch', resources) !== true) return false;
          const intent = await store.begin(record.id, planned.id, record.revision, lease());
          if (intent.state !== 'sending' || intent.writes !== 1) return false;
          record = intent.record;
          started = true;
          return true;
        } });
      }
      catch { response = { state: 'unresolved' }; }
      if (!started) return { state: 'refused', reason: 'not-admitted', revision: record.revision };
      let outcome = { state: 'unresolved', evidence: { reason: 'unconfirmed' } };
      if (!signal.aborted && response.state === 'ok') {
        try {
          const observed = await classify(response, planned);
          if (observed && ['confirmed', 'rejected'].includes(observed.state) && Object.hasOwn(observed, 'evidence')) outcome = observed;
        }
        catch { /* malformed or unvalidated remote evidence remains unresolved */ }
      }
      record = (await store.settle(record.id, planned.id, record.revision, lease(), outcome)).record;
      if (outcome.state === 'unresolved') return { state: 'unresolved', revision: record.revision, leg: planned.id };
    }
    return { state: 'complete', revision: record.revision, legs: record.legs.map(({ id, state }) => ({ id, state })) };
  } } } });
  /** @param {string} id @param {{ lease: any, signal?: AbortSignal }} resources */
  async function run(id, resources) {
    const result = await workflow.run({ id }, { runId: id, resources, signal: resources.signal });
    return result.result;
  }
  return Object.freeze({
    run,
    /** Existing queue worker binding. Unresolved/refused operations pause in the
     * queue's cancelled state, which can be explicitly requeued for reconciliation.
     * They must not become completed jobs whose identity cannot be claimed again.
     * @param {{ operationId: string }} payload @param {any} context */
    async handler(payload, context) {
      if (typeof context?.pause !== 'function') throw new TypeError('external handler needs a job worker pause capability');
      const result = await run(payload.operationId, context);
      if (result.state !== 'complete') await context.pause();
      return result;
    },
  });
}
