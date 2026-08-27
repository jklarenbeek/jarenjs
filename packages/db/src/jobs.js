//@ts-check
/**
 * @file The durable job queue (JOBS-FORMAT): enqueue, the
 * single-statement guarded claim (§3 — one statement is one
 * transaction, so no double-claim without any distributed lock),
 * retry with exponential backoff and jitter (§4), recovery as
 * re-claim of expired leases (§5), polling workers with same-process
 * wake-on-enqueue (§6), and the per-job flow checkpoint store the DAG
 * composition binds (§7) — completion marks the job done and records
 * the result in ONE guarded transaction.
 *
 * Every worker transition is guarded by `state='leased' AND
 * lease_owner=?`: execution is at-least-once, completion is
 * exactly-once. `now` and `random` are injectable — the runtime
 * defaults are the clock and `Math.random`; every test injects.
 *
 * The worker LIFECYCLE holds two invariants that a long-running process
 * depends on, and neither is a detail:
 *
 *  - **No handler value can break the loop.** A handler is host code and
 *    may resolve with something JSON cannot express, or reject with a
 *    value whose own `message` throws when read. Both are normalized
 *    totally, and `runOne` is isolated inside the loop, so the worst a
 *    single job can do is fail its own attempt. A rejected claim-execute
 *    loop would stop draining the queue silently.
 *  - **Shutdown is bounded.** Handlers receive an `AbortSignal` and
 *    `stop()` takes a deadline, so a handler that never settles cannot
 *    hold `stop()` — and therefore `store.close()`, and therefore the
 *    database file — open forever. A loop the deadline could not drain
 *    is CANCELLED, not merely left behind: when its handler finally
 *    settles it exits without another claim, store write or poll
 *    timer, and its abandoned job recovers by lease expiry (§5).
 */

import { chain, attempt } from './driver.js';
import { DbCompileError, DbRuntimeError } from './errors.js';

export const JOBS_TABLE = '_jaren_jobs';
export const JOB_CHECKPOINTS_TABLE = '_jaren_job_checkpoints';

/** §4 defaults, all overridable per worker. */
export const JOB_DEFAULTS = Object.freeze({
  maxAttempts: 5,
  leaseMs: 30_000,
  pollInterval: 500,
  backoffBase: 1_000,
  backoffCap: 60_000,
  /** How long `stop()` waits for in-flight handlers after signalling
   * abort, before it stops waiting and reports what is still running.
   * Bounded on purpose: an unbounded wait makes one stuck handler
   * indistinguishable from a hung process. */
  stopGraceMs: 5_000,
});

/**
 * A diagnostic string for ANY value, including ones that fight back — a
 * getter that throws, a null-prototype object, a revoked proxy, a
 * symbol. Total by construction: an error report is never the thing that
 * fails.
 * @param {any} value
 * @returns {string}
 */
export function describeValue(value) {
  try {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'symbol') return value.toString();
    if (typeof value !== 'object') return String(value);
    const message = /** @type {any} */ (value).message;
    if (typeof message === 'string') return message;
    return String(value);
  }
  catch {
    return '[unreportable value]';
  }
}

/**
 * JSON text for a job result, or `null` when the value cannot be
 * expressed — a BigInt, a cycle, a `toJSON` that throws. The caller
 * treats that as a failed attempt, never as a broken worker.
 * @param {any} value
 * @returns {{ text: string | null } | { reason: string }}
 */
export function serializeResult(value) {
  if (value === undefined || value === null) return { text: null };
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return { reason: 'the result is not representable as JSON' };
    return { text };
  }
  catch (error) {
    return { reason: `the result could not be serialized: ${describeValue(error)}` };
  }
}

const CREATE_JOBS = `CREATE TABLE IF NOT EXISTS "${JOBS_TABLE}" (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  lease_until INTEGER,
  lease_owner TEXT,
  last_error TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "${JOBS_TABLE}_claim"
  ON "${JOBS_TABLE}" (state, run_at);
CREATE TABLE IF NOT EXISTS "${JOB_CHECKPOINTS_TABLE}" (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id)
);`;

/** Map a raw row to the frozen public record (§2). */
function publicJob(row) {
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    payload: row.payload === null ? null : JSON.parse(row.payload),
    state: row.state,
    runAt: Number(row.run_at),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
    leaseOwner: row.lease_owner,
    lastError: row.last_error,
    result: row.result === null ? null : JSON.parse(row.result),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

/**
 * The queue engine over one open connection.
 * @param {{ connection: any, now?: () => number,
 *   random?: () => number,
 *   defaults?: Partial<typeof JOB_DEFAULTS> }} options
 */
export function createJobEngine(options) {
  const { connection } = options;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const defaults = { ...JOB_DEFAULTS, ...options.defaults };

  /** Every queue statement failure rides the store's own wrap (§9):
   * a read-only file, a locked database, a constraint — never the
   * driver's raw error. */
  const wrapJobs = (error) => (typeof error?.code === 'string' && error.code.startsWith('JD')
    ? error
    : new DbRuntimeError('JD2005',
      `the database rejected the operation: ${error?.message ?? String(error)}`,
      { docPath: '/jobs', collection: JOBS_TABLE, cause: error }));
  /** @type {Map<string, any>} */
  const statements = new Map();
  const prepared = (key, sql) => {
    let statement = statements.get(key);
    if (statement === undefined) {
      const raw = connection.prepare(sql);
      statement = {
        run: (params) => attempt(() => raw.run(params), wrapJobs),
        get: (params) => attempt(() => raw.get(params), wrapJobs),
        all: (params) => attempt(() => raw.all(params), wrapJobs),
      };
      statements.set(key, statement);
    }
    return statement;
  };

  /** Same-process wake-on-enqueue (§6). */
  const wakers = new Set();
  const wakeAll = () => {
    for (const wake of [...wakers]) wake();
  };

  // the tables are created here, or refused here: a read-only store
  // leaked the driver's "attempt to write a readonly database"
  const ready = attempt(() => connection.exec(CREATE_JOBS), (error) => new DbCompileError('JD0002',
    `the job tables could not be created (${error?.message ?? String(error)}) — `
    + 'a read-only store creates nothing; open it read-write once, or without jobs',
    '/jobs', error));

  const enqueue = (kind, payload, enqueueOptions) => {
    if (typeof kind !== 'string' || kind === '') {
      throw new TypeError('enqueue: "kind" must be a non-empty string');
    }
    const id = enqueueOptions?.id ?? crypto.randomUUID();
    // a `runAt` that is not a number stored as NaN and left the job
    // pending forever; a Date could not even be bound
    if (enqueueOptions?.runAt !== undefined && !Number.isFinite(enqueueOptions.runAt)) {
      throw new TypeError('enqueue: "runAt" is an epoch in milliseconds (a finite number)');
    }
    if (enqueueOptions?.maxAttempts !== undefined
      && !(Number.isInteger(enqueueOptions.maxAttempts) && enqueueOptions.maxAttempts >= 1)) {
      throw new TypeError('enqueue: "maxAttempts" is a positive integer');
    }
    const at = now();
    return chain(prepared('enqueue', `INSERT INTO "${JOBS_TABLE}"
      (id, kind, payload, state, run_at, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`).run([
      id, kind,
      payload === undefined || payload === null ? null : JSON.stringify(payload),
      enqueueOptions?.runAt ?? at,
      enqueueOptions?.maxAttempts ?? defaults.maxAttempts,
      at, at,
    ]), () => {
      wakeAll();
      return id;
    });
  };

  const get = (id) => chain(
    prepared('get', `SELECT * FROM "${JOBS_TABLE}" WHERE id = ?`).get([id]),
    (row) => (row === undefined ? undefined : publicJob(row)));

  const counts = () => chain(
    prepared('counts', `SELECT state, COUNT(*) AS n FROM "${JOBS_TABLE}" GROUP BY state`).all([]),
    (states) => chain(
      prepared('pendingKinds', `SELECT kind, COUNT(*) AS n FROM "${JOBS_TABLE}"
        WHERE state IN ('pending', 'failed') GROUP BY kind`).all([]),
      (kinds) => {
        const out = {
          pending: 0, leased: 0, done: 0, failed: 0, dead: 0,
          /** @type {Record<string, number>} */
          pendingKinds: {},
        };
        for (const row of states) out[row.state] = Number(row.n);
        for (const row of kinds) out.pendingKinds[row.kind] = Number(row.n);
        return out;
      }));

  /**
   * §3: the single guarded claim; expired leases are claimable — the
   * next claim IS crash recovery.
   * @param {{ kinds: string[], owner: string, leaseMs?: number }} claimOptions
   */
  const claim = (claimOptions) => {
    const { kinds, owner } = claimOptions;
    if (!Array.isArray(kinds) || kinds.length === 0
      || typeof owner !== 'string' || owner === '') {
      throw new TypeError('claim: needs a non-empty "kinds" array and an "owner"');
    }
    const at = now();
    const placeholders = kinds.map(() => '?').join(', ');
    const statement = prepared(`claim:${kinds.length}`,
      `UPDATE "${JOBS_TABLE}" SET state='leased', lease_owner=?, lease_until=?,
        attempts = attempts + 1, updated_at=?
      WHERE id = (SELECT id FROM "${JOBS_TABLE}"
        WHERE (state='pending' OR state='failed'
               OR (state='leased' AND lease_until < ?))
          AND run_at <= ? AND kind IN (${placeholders})
        ORDER BY run_at, created_at, id LIMIT 1)
      RETURNING *`);
    return chain(statement.get([
      owner, at + (claimOptions.leaseMs ?? defaults.leaseMs), at, at, at, ...kinds,
    ]), (row) => (row === undefined ? undefined : publicJob(row)));
  };

  /** §4: the jittered exponential backoff. */
  const backoffOf = (attempts, workerDefaults) => {
    const base = workerDefaults?.backoffBase ?? defaults.backoffBase;
    const cap = workerDefaults?.backoffCap ?? defaults.backoffCap;
    return Math.round(Math.min(cap, base * 2 ** (attempts - 1)) * (0.5 + random() / 2));
  };

  /**
   * Complete a leased job — guarded, exactly-once (§3). A result JSON
   * cannot express is refused HERE, before any write, so the caller can
   * fail the attempt instead of the worker.
   * @throws {TypeError} when the result is not representable
   */
  const complete = (id, owner, result) => {
    const serialized = serializeResult(result);
    if (!('text' in serialized)) throw new TypeError(serialized.reason);
    return chain(
      prepared('complete', `UPDATE "${JOBS_TABLE}"
        SET state='done', result=?, lease_until=NULL, updated_at=?
        WHERE id=? AND state='leased' AND lease_owner=?`).run([
        serialized.text, now(), id, owner,
      ]), (out) => Number(out.changes ?? 0) > 0);
  };

  /** Fail a leased job: schedule the retry or dead-letter (§4). */
  const fail = (id, owner, error, workerDefaults) => chain(get(id), (job) => {
    if (job === undefined) return false;
    const terminal = job.attempts >= job.maxAttempts;
    const at = now();
    const statement = terminal
      ? prepared('dead', `UPDATE "${JOBS_TABLE}"
          SET state='dead', last_error=?, lease_until=NULL, updated_at=?
          WHERE id=? AND state='leased' AND lease_owner=?`)
      : prepared('retry', `UPDATE "${JOBS_TABLE}"
          SET state='failed', last_error=?, lease_until=NULL, run_at=?, updated_at=?
          WHERE id=? AND state='leased' AND lease_owner=?`);
    // host code decides what it throws; reading it must not throw back
    const message = describeValue(error);
    const params = terminal
      ? [message, at, id, owner]
      : [message, at + backoffOf(job.attempts, workerDefaults), at, id, owner];
    return chain(statement.run(params), (out) => Number(out.changes ?? 0) > 0);
  });

  /**
   * §7: the flow checkpoint store bound to ONE claimed job. `save`
   * refuses once the lease is lost (the stale run aborts fast);
   * `complete` records the result, marks the job done and prunes the
   * checkpoint rows in ONE guarded transaction — a failure leaves
   * neither.
   * @param {{ id: string, leaseOwner: string | null }} job
   */
  const checkpointsFor = (job) => ({
    load: (runId) => chain(
      prepared('cpLoad', `SELECT node_id, value FROM "${JOB_CHECKPOINTS_TABLE}"
        WHERE run_id = ?`).all([runId]),
      (rows) => (rows.length === 0
        ? null
        : {
          values: Object.fromEntries(
            rows.map((row) => [row.node_id, JSON.parse(row.value)])),
        })),
    save: (runId, nodeId, value) => connection.transaction(() => chain(
      prepared('cpOwner', `SELECT lease_owner FROM "${JOBS_TABLE}"
        WHERE id=? AND state='leased'`).get([runId]),
      (row) => {
        if (row === undefined || row.lease_owner !== job.leaseOwner) {
          throw new Error(
            `the lease on job '${runId}' was lost; the checkpoint is refused`);
        }
        return prepared('cpSave', `INSERT INTO "${JOB_CHECKPOINTS_TABLE}"
          (run_id, node_id, value) VALUES (?, ?, ?)
          ON CONFLICT (run_id, node_id) DO UPDATE SET value=excluded.value`)
          .run([runId, nodeId, JSON.stringify(value)]);
      })),
    complete: (runId, result) => connection.transaction(() => chain(
      complete(runId, /** @type {string} */ (job.leaseOwner), result),
      (completed) => {
        if (!completed) {
          throw new Error(
            `the lease on job '${runId}' was lost; the completion is refused`);
        }
        return prepared('cpPrune',
          `DELETE FROM "${JOB_CHECKPOINTS_TABLE}" WHERE run_id = ?`).run([runId]);
      })),
  });

  /** @type {Set<any>} */
  const workers = new Set();

  /**
   * §6: N claim-execute loops over one handler registry.
   * @param {{ handlers: Record<string, Function>, concurrency?: number,
   *   pollInterval?: number, leaseMs?: number, owner?: string,
   *   backoffBase?: number, backoffCap?: number }} workerOptions
   */
  const createWorker = (workerOptions) => {
    const handlers = workerOptions?.handlers;
    if (handlers === null || typeof handlers !== 'object'
      || Object.keys(handlers).length === 0
      || Object.values(handlers).some((handler) => typeof handler !== 'function')) {
      throw new TypeError(
        'createWorker: "handlers" must be a non-empty object of functions');
    }
    const kinds = Object.keys(handlers);
    const owner = workerOptions.owner ?? crypto.randomUUID();
    const concurrency = workerOptions.concurrency ?? 1;
    if (!(Number.isInteger(concurrency) && concurrency >= 1)) {
      // `Array.from({ length: 0 })` started a worker that never claimed
      throw new TypeError('createWorker: "concurrency" is a positive integer');
    }
    const pollInterval = workerOptions.pollInterval ?? defaults.pollInterval;
    const stats = { claims: 0, completions: 0, failures: 0, polls: 0, wakes: 0, claimErrors: 0 };

    let running = false;
    /** @type {Promise<void>[]} */
    let loops = [];
    /** @type {Set<{ timer: any, wake: () => void }>} */
    const sleepers = new Set();

    const sleep = () => new Promise((resolve) => {
      /** @type {{ timer: any, wake: () => void }} */
      const sleeper = {
        timer: setTimeout(() => {
          sleepers.delete(sleeper);
          stats.polls += 1;
          resolve(undefined);
        }, pollInterval),
        wake: () => {
          clearTimeout(sleeper.timer);
          sleepers.delete(sleeper);
          stats.wakes += 1;
          resolve(undefined);
        },
      };
      sleepers.add(sleeper);
    });
    const onWake = () => {
      for (const sleeper of [...sleepers]) sleeper.wake();
    };

    /** Aborted when `stop()` is called: the handler's cue to wind up. */
    let shutdown = new AbortController();
    /**
     * The per-`start()` loop session. When a `stop()` grace deadline
     * expires the session is cancelled: a loop that could not be
     * drained must abandon its job — no completion or failure write,
     * no further claim, no re-armed poll timer — because the store it
     * would touch is the one the caller is about to close. The
     * abandoned lease expires and the next claim re-runs the job (§5).
     * A later `start()` opens a NEW session, so a cancelled loop can
     * never be revived.
     */
    let session = { cancelled: false };
    /** In-flight handler count, so `stop()` can report what it left. */
    let inFlight = 0;

    /**
     * Record one failed attempt. Reporting a failure must never itself
     * fail the loop, so a storage error here is swallowed after the
     * attempt count has already been incremented by the claim.
     */
    const recordFailure = async (job, error) => {
      stats.failures += 1;
      try {
        await Promise.resolve(fail(job.id, owner, error, workerOptions));
      }
      catch {
        // the lease will expire and the job will be re-claimed (§5);
        // a worker must not die because the failure write failed
      }
    };

    /** @param {{ cancelled: boolean }} loopSession */
    const runOne = async (job, loopSession) => {
      stats.claims += 1;
      inFlight += 1;
      try {
        let result;
        try {
          result = await handlers[job.kind](job.payload,
            { job, checkpointsFor, signal: shutdown.signal });
        }
        catch (error) {
          // past cancellation the store is closing: leave the leased
          // row to expiry-based recovery (§5) instead of racing it
          if (loopSession.cancelled) return;
          await recordFailure(job, error);
          return;
        }
        if (loopSession.cancelled) return;
        try {
          // a §7 handler may have completed transactionally already; the
          // guarded update makes this a no-op then
          await Promise.resolve(complete(job.id, owner, result ?? null));
        }
        catch (error) {
          // an unrepresentable result, or a storage failure at the
          // completion write: this attempt failed, the worker did not
          await recordFailure(job, error);
          return;
        }
        stats.completions += 1;
      }
      finally {
        inFlight -= 1;
      }
    };

    /** @param {{ cancelled: boolean }} loopSession */
    const loop = async (loopSession) => {
      while (running && !loopSession.cancelled) {
        let job;
        try {
          job = await Promise.resolve(claim({
            kinds, owner, leaseMs: workerOptions.leaseMs }));
        }
        catch {
          // a storage failure backs off to the poll — COUNTED, so a
          // worker on a read-only store is not silently idle forever
          stats.claimErrors += 1;
          job = undefined;
        }
        if (!running || loopSession.cancelled) return;
        if (job === undefined) {
          await sleep();
          continue;
        }
        try {
          await runOne(job, loopSession);
        }
        catch {
          // `runOne` normalizes every handler outcome, so reaching here
          // means the normalization itself broke. The loop still must not
          // die: a stopped claim-execute loop drains nothing, silently.
          stats.failures += 1;
        }
      }
    };

    const worker = {
      stats: () => ({ ...stats, inFlight }),
      start() {
        if (running) throw new TypeError('the worker is already started');
        running = true;
        shutdown = new AbortController();
        session = { cancelled: false };
        loops = Array.from({ length: concurrency }, () => loop(session));
        // a restart re-registers what stop() removed: the
        // wake-on-enqueue hook and the stopAll membership
        wakers.add(onWake);
        workers.add(worker);
        return worker;
      },
      /**
       * Stop claiming, signal in-flight handlers to abort, and wait for
       * the loops — but only up to `graceMs`. A handler that ignores its
       * signal cannot hold the process open; the resolved record says so
       * instead, and the lease expiry (§5) lets another worker re-claim.
       * A loop the grace period could not drain is cancelled outright:
       * when its handler finally settles it exits without another
       * claim, store write or poll timer.
       * @param {{ graceMs?: number }} [stopOptions]
       * @returns {Promise<{ drained: boolean, inFlight: number }>}
       */
      async stop(stopOptions) {
        running = false;
        shutdown.abort();
        onWake();
        const graceMs = stopOptions?.graceMs
          ?? workerOptions.stopGraceMs ?? defaults.stopGraceMs;
        /** @type {any} */
        let timer;
        const drained = await Promise.race([
          Promise.all(loops).then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), graceMs); }),
        ]);
        clearTimeout(timer);
        if (drained) loops = [];
        else session.cancelled = true; // cancel what could not be drained
        wakers.delete(onWake);
        workers.delete(worker);
        return { drained: drained === true, inFlight };
      },
    };
    wakers.add(onWake);
    workers.add(worker);
    return worker;
  };

  return {
    ready,
    enqueue,
    get,
    counts,
    claim,
    complete,
    fail,
    checkpointsFor,
    createWorker,
    /** Stop every worker, bounded. Resolves to the per-worker outcome so
     * `close()` can report a handler it could not wait out rather than
     * hanging on it. */
    stopAll: (stopOptions) =>
      Promise.all([...workers].map((worker) => worker.stop(stopOptions))),
  };
}
