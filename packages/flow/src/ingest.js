//@ts-check
/** Resumable complete ingestion over injected provider and transaction stores. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { compileWorkflow } from './workflow.js';

/**
 * @typedef {{ source: string, version: string, generation: string,
 * partitions: string[], input: any, policyRevision: string,
 * consistency: 'snapshot' | 'revision' }} IngestionPlan
 */

/**
 * Compose the existing workflow engine with bounded provider pages and atomic
 * staging. source(plan, phase) proves either a stable source snapshot or a
 * monotonic source revision. Local generation numbers are never that proof.
 * @param {{ provider: { pages: (input: any, context: any) => AsyncIterable<any> },
 * store: { begin: Function, stage: Function, invalidate: Function, publish: Function },
 * source: (plan: IngestionPlan, phase: string) => any,
 * maxPartitions?: number, maxPages?: number, maxRows?: number, maxBytes?: number }} options
 */
export function createIngestion(options) {
  if (!options || typeof options.provider?.pages !== 'function' || typeof options.source !== 'function'
    || ['begin', 'stage', 'invalidate', 'publish'].some((name) => typeof options.store?.[name] !== 'function'))
    throw new TypeError('ingestion needs provider pages, source evidence and an atomic staging store');
  const { provider, store, source, maxPartitions = 64, maxPages = 64, maxRows = 65536, maxBytes = 16777216 } = options;
  for (const value of [maxPartitions, maxPages, maxRows, maxBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('ingestion limits must be positive finite integers');
  const workflow = compileWorkflow({ $workflow: '0.2', revision: 'ingestion/1', initial: 'pull', states: {
    pull: { work: { task: 'ingest', version: '1' }, then: 'done' }, done: { final: true },
  } }, { tasks: { ingest: { version: '1', run: async ({ input: plan }, signal, resources) => {
    const incomplete = (reason) => ({ state: 'incomplete', reason, changes: 0, writes: 0, revisions: 0 });
    const proof = async (phase) => {
      const evidence = await source(plan, phase);
      return !signal.aborted && evidence?.version === plan.version && evidence.consistency === plan.consistency
        ? { version: evidence.version, consistency: evidence.consistency } : null;
    };
    let evidence = await proof('start');
    if (!evidence) return incomplete('source-changed');
    if (resources.authority && !await resources.authority.check()) return incomplete('authority-changed');
    const begun = await store.begin(plan);
    if (begun.state !== 'staging') return begun;
    let checkpoint = begun.checkpoint;
    for (const partition of plan.partitions) {
      const saved = checkpoint.partitions.find((part) => part.id === partition);
      if (saved.complete) continue;
      let complete = false;
      const pages = provider.pages(plan.input, { executor: resources.executor, signal, partition,
        sourceVersion: plan.version, cursor: saved.cursor, deadline: resources.deadline });
      try {
        for await (const page of pages) {
          if (signal.aborted) return incomplete('cancelled');
          if (page.state !== 'page') {
            if (page.state !== 'complete') return incomplete(page.reason);
            complete = true;
            continue;
          }
          // Network has settled before entering stage's transaction. The exact
          // raw wire text remains beside compiled observations in that commit.
          evidence = await proof('page');
          if (!evidence || page.version !== plan.version) {
            if (checkpoint.pages + 1 <= maxPages && checkpoint.rows + page.rows.length <= maxRows && checkpoint.bytes + page.bytes <= maxBytes)
              await store.stage(plan, partition, { ...page, complete: false, reason: 'source-changed' });
            await store.invalidate(plan, 'source-changed');
            return incomplete('source-changed');
          }
          if (checkpoint.pages + 1 > maxPages || checkpoint.rows + page.rows.length > maxRows || checkpoint.bytes + page.bytes > maxBytes)
            return incomplete('ingestion-limit');
          if (resources.authority && !await resources.authority.check()) return incomplete('authority-changed');
          const staged = await store.stage(plan, partition, page);
          if (staged.state !== 'staged') return incomplete(staged.reason);
          checkpoint = staged.checkpoint;
          if (page.reason !== null) return incomplete(page.reason);
        }
      }
      catch {
        if (signal.aborted) return incomplete('cancelled');
        return incomplete('interrupted');
      }
      if (!complete) return incomplete('missing-completion');
    }
    evidence = await proof('publish');
    if (!evidence) { await store.invalidate(plan, 'source-changed'); return incomplete('source-changed'); }
    if (signal.aborted) return incomplete('cancelled');
    return resources.authority
      ? resources.authority.publish(evidence, (proof) => store.publish(plan, proof, { signal }))
      : store.publish(plan, evidence, { signal });
  } } } });
  return Object.freeze({
    /** @param {IngestionPlan} plan
     * @param {{ executor: any, authority?: any, signal?: AbortSignal, deadline?: number }} resources */
    async run(plan, resources) {
      if (!plan || ['source', 'version', 'generation', 'policyRevision'].some((name) => typeof plan[name] !== 'string' || !plan[name])
        || !['snapshot', 'revision'].includes(plan.consistency) || !Array.isArray(plan.partitions)
        || !plan.partitions.length || plan.partitions.length > maxPartitions
        || plan.partitions.some((partition) => typeof partition !== 'string' || !partition)
        || new Set(plan.partitions).size !== plan.partitions.length || !Object.hasOwn(plan, 'input')
        || Object.keys(plan).some((name) => !['source', 'version', 'generation', 'partitions', 'input', 'policyRevision', 'consistency'].includes(name)))
        throw new TypeError('ingestion plan needs source/version/generation, unique bounded partitions, input, policyRevision and consistency');
      const input = JSON.parse(canonicalizeJson(plan));
      const result = await workflow.run(input, { runId: canonicalizeJson([plan.source, plan.generation]), resources,
        signal: resources.signal });
      return result.result;
    },
  });
}
