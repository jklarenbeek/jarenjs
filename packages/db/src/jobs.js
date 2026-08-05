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
 */

import { chain } from './driver.js';

export const JOBS_TABLE = '_jaren_jobs';
export const JOB_CHECKPOINTS_TABLE = '_jaren_job_checkpoints';

/** §4 defaults, all overridable per worker. */
export const JOB_DEFAULTS = Object.freeze({
  maxAttempts: 5,
  leaseMs: 30_000,
  pollInterval: 500,
  backoffBase: 1_000,
  backoffCap: 60_000,
});

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

  /** @type {Map<string, any>} */
  const statements = new Map();
  const prepared = (key, sql) => {
    let statement = statements.get(key);
    if (statement === undefined) {
      statement = connection.prepare(sql);
      statements.set(key, statement);
    }
    return statement;
  };

  /** Same-process wake-on-enqueue (§6). */
  const wakers = new Set();
  const wakeAll = () => {
    for (const wake of [...wakers]) wake();
  };

  const ready = connection.exec(CREATE_JOBS);

  const enqueue = (kind, payload, enqueueOptions) => {
    if (typeof kind !== 'string' || kind === '') {
      throw new TypeError('enqueue: "kind" must be a non-empty string');
    }
    const id = enqueueOptions?.id ?? crypto.randomUUID();
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

  /** Complete a leased job — guarded, exactly-once (§3). */
  const complete = (id, owner, result) => chain(
    prepared('complete', `UPDATE "${JOBS_TABLE}"
      SET state='done', result=?, lease_until=NULL, updated_at=?
      WHERE id=? AND state='leased' AND lease_owner=?`).run([
      result === undefined ? null : JSON.stringify(result), now(), id, owner,
    ]), (out) => Number(out.changes ?? 0) > 0);

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
    const message = String(error?.message ?? error);
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
    const pollInterval = workerOptions.pollInterval ?? defaults.pollInterval;
    const stats = { claims: 0, completions: 0, failures: 0, polls: 0, wakes: 0 };

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

    const runOne = async (job) => {
      stats.claims += 1;
      let result;
      try {
        result = await handlers[job.kind](job.payload, { job, checkpointsFor });
      }
      catch (error) {
        stats.failures += 1;
        await Promise.resolve(fail(job.id, owner, error, workerOptions));
        return;
      }
      // a §7 handler may have completed transactionally already; the
      // guarded update makes this a no-op then
      await Promise.resolve(complete(job.id, owner, result ?? null));
      stats.completions += 1;
    };

    const loop = async () => {
      while (running) {
        let job;
        try {
          job = await Promise.resolve(claim({
            kinds, owner, leaseMs: workerOptions.leaseMs }));
        }
        catch {
          job = undefined; // a transient storage failure: back off to the poll
        }
        if (!running) return;
        if (job === undefined) {
          await sleep();
          continue;
        }
        await runOne(job);
      }
    };

    const worker = {
      stats: () => ({ ...stats }),
      start() {
        if (running) throw new TypeError('the worker is already started');
        running = true;
        loops = Array.from({ length: concurrency }, () => loop());
        return worker;
      },
      async stop() {
        running = false;
        onWake();
        await Promise.all(loops);
        loops = [];
        wakers.delete(onWake);
        workers.delete(worker);
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
    stopAll: () => Promise.all([...workers].map((worker) => worker.stop())),
  };
}
