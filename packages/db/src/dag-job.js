//@ts-check
/**
 * @file The composition (JOBS-FORMAT §7): a persisted `@jarenjs/flow`
 * DAG run wired to a queue job. THE FLOW ENGINE IS INJECTED, NEVER
 * IMPORTED — the shared invariant forbids `@jarenjs/db` importing
 * `@jarenjs/flow`, so `compileDag` arrives as a capability (the D10
 * shape applied to flow) and a test asserts the manifest and import
 * graph name flow nowhere.
 *
 * Each kind's document compiles ONCE against a delegating checkpoint
 * store; per claimed job, the delegate binds the engine's guarded
 * per-job store (`checkpointsFor`) — `save` refuses once the lease is
 * lost and `complete` records the DAG result, marks the job done and
 * prunes the checkpoint rows in ONE transaction, so a failure leaves
 * neither and a crash resumes instead of restarting.
 */

/**
 * Build a worker whose handlers run checkpointed DAG documents.
 * @param {any} store - an open store with `{ jobs: true }`
 * @param {{ compileDag: Function,
 *   documents: Record<string, any>,
 *   tasks?: Record<string, Function>,
 *   concurrency?: number, pollInterval?: number, leaseMs?: number,
 *   owner?: string, backoffBase?: number, backoffCap?: number }} options
 * @returns {{ start: () => any, stop: () => Promise<void>, stats: () => any }}
 */
export function createDagJobRunner(store, options) {
  if (store?.jobs === undefined) {
    throw new TypeError(
      'createDagJobRunner: the store was opened without { jobs } — nothing to compose');
  }
  const { compileDag, documents } = options ?? {};
  if (typeof compileDag !== 'function') {
    throw new TypeError(
      'createDagJobRunner: "compileDag" must be injected from @jarenjs/flow — '
      + 'this package deliberately does not import it');
  }
  if (documents === null || typeof documents !== 'object'
    || Object.keys(documents).length === 0) {
    throw new TypeError(
      'createDagJobRunner: "documents" must map job kinds to dag documents');
  }

  /** The active claim contexts, keyed by run id (= job id): the
   * delegate resolves the CURRENT lease binding per store call. */
  const active = new Map();
  const boundStore = (runId) => {
    const context = active.get(runId);
    if (context === undefined) {
      throw new Error(`no active job holds run '${runId}'`);
    }
    return context.checkpointsFor(context.job);
  };
  const checkpoint = {
    load: (runId) => boundStore(runId).load(runId),
    save: (runId, nodeId, value) => boundStore(runId).save(runId, nodeId, value),
    complete: (runId, result) => boundStore(runId).complete(runId, result),
  };

  /** @type {Record<string, Function>} */
  const handlers = {};
  for (const kind of Object.keys(documents)) {
    const compiled = compileDag(documents[kind],
      { tasks: options.tasks ?? {}, checkpoint });
    handlers[kind] = async (payload, context) => {
      active.set(context.job.id, context);
      try {
        return await compiled.run(payload?.input ?? null, { runId: context.job.id });
      }
      finally {
        active.delete(context.job.id);
      }
    };
  }

  return store.jobs.createWorker({
    handlers,
    concurrency: options.concurrency,
    pollInterval: options.pollInterval,
    leaseMs: options.leaseMs,
    owner: options.owner,
    backoffBase: options.backoffBase,
    backoffCap: options.backoffCap,
  });
}
