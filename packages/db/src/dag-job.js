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
 * store; the delegate resolves per ATTEMPT, never per job, because two
 * attempts of one job are two different runs of the same workflow and
 * the older one may not write on the younger one's behalf. The engine's
 * store carries the fence: `save` is refused once the lease is lost, and
 * `complete` records the DAG result, marks the job done and prunes the
 * checkpoint rows in ONE transaction, so a failure leaves neither and a
 * crash resumes instead of restarting.
 *
 * A resumed run also has to be the SAME run. The workflow document's
 * revision and a hash of the input are persisted with the checkpoints,
 * and a resume that disagrees with either is refused by name — reusing
 * checkpoints written by a different workflow is not a resume, it is a
 * silently wrong answer.
 */

import { canonicalizeJson } from '@jarenjs/json/canonical';
import { hashContent } from '@jarenjs/core/string';

import { DbRuntimeError } from './errors.js';

/** The checkpoint row a run's identity lives in. The leading unit
 * separator keeps it out of any node-id namespace a document could
 * declare, and the DAG's seeding skips it because no node is called
 * that. It is pruned with the run it belongs to. */
export const RUN_IDENTITY_NODE = '\u001Fidentity';

/** What joins a job id to an attempt's token in the run key the DAG
 * sees. A unit separator, so no job id can carry one by accident. */
const RUN_KEY_SEPARATOR = '\u001F';

/** A stable fingerprint of any JSON value: the suite's one content hash
 * over the suite's one canonical form. */
const fingerprint = (value) => hashContent(canonicalizeJson(value ?? null));

/**
 * Build a worker whose handlers run checkpointed DAG documents.
 * @param {any} store - an open store with `{ jobs: true }`
 * @param {{ compileDag: Function,
 *   documents: Record<string, any>,
 *   tasks?: Record<string, Function>,
 *   concurrency?: number, pollInterval?: number, leaseMs?: number,
 *   owner?: string, renew?: boolean, onOutcome?: (event: any) => void,
 *   backoffBase?: number, backoffCap?: number,
 *   stopGraceMs?: number }} options
 * @returns {{ start: () => any, stop: (options?: any) => Promise<any>, stats: () => any }}
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

  /**
   * The attempts running right now, keyed by the run key the DAG was
   * given — the job id and this attempt's fence token. Never by owner,
   * and never by job id alone: a re-claim of the same job is a different
   * attempt, and a delegate that could not tell them apart would let the
   * older one write through the younger one's store.
   * @type {Map<string, any>}
   */
  const active = new Map();

  /** The run key the DAG sees, and the job id the STORE sees, are not
   * the same string: the store keys rows by job, the delegate keys
   * bindings by attempt. */
  const runKeyOf = (jobId, token) => `${jobId}${RUN_KEY_SEPARATOR}${token}`;
  const jobIdOf = (runKey) => runKey.slice(0, runKey.indexOf(RUN_KEY_SEPARATOR));

  const bound = (runKey) => {
    const context = active.get(runKey);
    if (context === undefined) {
      throw new DbRuntimeError('JD2069',
        `no attempt holds run '${jobIdOf(runKey)}' — its lease was lost, or the run `
        + 'outlived the handler that started it',
        { docPath: '/jobs' });
    }
    return context;
  };
  const checkpoint = {
    load: (runKey) => bound(runKey).checkpoints.load(jobIdOf(runKey)),
    save: (runKey, nodeId, value) =>
      bound(runKey).checkpoints.save(jobIdOf(runKey), nodeId, value),
    complete: (runKey, result) =>
      bound(runKey).checkpoints.complete(jobIdOf(runKey), result),
  };

  /** Which declared task identities moved between two version maps. */
  const describeVersionDrift = (before, after) => {
    const names = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
    const moved = [];
    for (const name of names) {
      const was = before?.[name];
      const now = after?.[name];
      if (was === now) continue;
      if (was === undefined) moved.push(`'${name}' is new at version ${now}`);
      else if (now === undefined) moved.push(`'${name}' is gone (was version ${was})`);
      else moved.push(`'${name}' moved from version ${was} to ${now}`);
    }
    return moved;
  };

  /**
   * The identity a resumed run must agree with: the workflow document,
   * the input, and the DECLARED versions of the task implementations
   * (FLOW-FORMAT §7.8). The third closes the gap the first two cannot
   * see — a handler reimplemented while its document stayed byte-equal
   * produces checkpoints that describe a computation nobody asked for
   * just as surely as an edited document does.
   */
  const requireSameRun = async (context, jobId, revision, inputHash, taskVersions) => {
    const loaded = await context.checkpoints.load(jobId);
    const stored = loaded?.values?.[RUN_IDENTITY_NODE];
    const taskVersionsHash = fingerprint(taskVersions);
    const identity = { revision, inputHash, taskVersionsHash, taskVersions };
    if (stored === undefined) {
      await context.checkpoints.save(jobId, RUN_IDENTITY_NODE, identity);
      return;
    }
    const differs = [];
    if (stored.revision !== revision) {
      differs.push(`the workflow (checkpointed under revision ${stored.revision}, `
        + `this runner compiles revision ${revision})`);
    }
    if (stored.inputHash !== inputHash) {
      differs.push(`the input (checkpointed under ${stored.inputHash}, `
        + `this attempt was given ${inputHash})`);
    }
    if (stored.taskVersionsHash === undefined) {
      // A row written before task identity was recorded. Unknown is not
      // equal: the upgrade is allowed only where nothing can be replayed
      // wrongly — when no node value has been recorded yet, so the run has
      // nothing to inherit from an implementation nobody can name.
      const recorded = Object.keys(loaded?.values ?? {})
        .filter((nodeId) => nodeId !== RUN_IDENTITY_NODE);
      if (recorded.length === 0) {
        await context.checkpoints.save(jobId, RUN_IDENTITY_NODE, identity);
      }
      else {
        differs.push(`the task versions (this run recorded ${recorded.length} node value(s) `
          + 'before task identity was persisted, so the implementation that produced them '
          + 'cannot be confirmed)');
      }
    }
    else if (stored.taskVersionsHash !== taskVersionsHash) {
      const moved = describeVersionDrift(stored.taskVersions, taskVersions);
      differs.push(`the task versions (${moved.length > 0 ? moved.join(', ')
        : `checkpointed under ${stored.taskVersionsHash}, this runner compiles `
          + `${taskVersionsHash}`})`);
    }
    if (differs.length === 0) return;
    throw new DbRuntimeError('JD2069',
      `run '${jobId}' cannot resume: ${differs.join(' and ')} changed since its `
      + 'checkpoints were written. Enqueue it under a new id, or drop the run — '
      + 'reusing them would answer for a computation nobody asked for',
      { docPath: '/jobs', collection: jobId });
  };

  /** @type {Record<string, Function>} */
  const handlers = {};
  for (const kind of Object.keys(documents)) {
    const compiled = compileDag(documents[kind],
      { tasks: options.tasks ?? {}, checkpoint });
    // one revision per compiled document, so every attempt of every run
    // of this kind compares against the same number
    const revision = fingerprint(documents[kind]);
    handlers[kind] = async (payload, context) => {
      const input = payload?.input ?? null;
      const runKey = runKeyOf(context.job.id, context.job.lease.token);
      active.set(runKey, context);
      try {
        await requireSameRun(context, context.job.id, revision, fingerprint(input),
          compiled.taskVersions);
        // the handler's signal reaches every task: a worker winding down
        // inside its grace period, or a lease this attempt has lost
        return await compiled.run(input, { runId: runKey, signal: context.signal });
      }
      finally {
        active.delete(runKey);
      }
    };
  }

  return store.jobs.createWorker({
    handlers,
    concurrency: options.concurrency,
    pollInterval: options.pollInterval,
    leaseMs: options.leaseMs,
    owner: options.owner,
    renew: options.renew,
    onOutcome: options.onOutcome,
    backoffBase: options.backoffBase,
    backoffCap: options.backoffCap,
    // the runner's declared default for `stop()` with no override; an
    // explicit `stop({ graceMs })` still wins inside the worker
    stopGraceMs: options.stopGraceMs,
  });
}
