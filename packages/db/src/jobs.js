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
 * Every settling transition is guarded by a FENCE — the opaque token
 * one claim mints, plus a lease that is still valid — never by the
 * owner, which one worker reuses for every attempt it ever makes and
 * which therefore cannot say which attempt is speaking. Execution is
 * at-least-once; settlement is exactly-once AGAINST THE STORE, and a
 * guard that matches nothing is a coded refusal naming which of the
 * three reasons applied, never a silent `false`. `now` and `random`
 * are injectable — explicitly, or through the host's runtime record,
 * which also mints every identifier — and the platform defaults are the
 * clock and `Math.random`; every test injects.
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

import { resolveRuntime } from '@jarenjs/core/runtime';
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
  lease_generation INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
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
  generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, node_id)
);`;

/**
 * The columns a database written before the fence does not have, added
 * in place. Jobs rows are live work, so an existing queue is upgraded,
 * never rebuilt: every column carries a default that reads as "claimed
 * before the fence existed", which no token can ever match.
 */
const ADDED_COLUMNS = Object.freeze([
  { table: JOBS_TABLE, name: 'lease_generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: JOBS_TABLE, name: 'lease_token', definition: 'TEXT' },
  { table: JOB_CHECKPOINTS_TABLE, name: 'generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
]);

/** Map a raw row to the frozen public record (§2). The lease token is
 * deliberately absent: a record anyone can read must not carry the
 * capability to settle the job it describes. */
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
    leaseGeneration: Number(row.lease_generation ?? 0),
    lastError: row.last_error,
    result: row.result === null ? null : JSON.parse(row.result),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

/**
 * The capability one claim mints: the right to settle THIS attempt of
 * this job, for as long as the lease is valid.
 *
 * It is a token, never an owner (D1). One worker reuses one owner for
 * its whole life, so an owner cannot tell two attempts of one job apart
 * — which is how a corpse completed a job another attempt was still
 * running. And it is immutable (D2): `renew` answers a NEW lease, so a
 * reference someone kept can never become valid again behind their back.
 */
function leaseOf(row) {
  return Object.freeze({
    jobId: row.id,
    token: row.lease_token,
    generation: Number(row.lease_generation),
    attempt: Number(row.attempts),
    owner: row.lease_owner,
    expiresAt: Number(row.lease_until),
  });
}

/** Whether a value is a lease this engine minted, rather than the
 * `(id, owner)` pair the pre-fence surface took. */
function isLease(value) {
  return value !== null && typeof value === 'object'
    && typeof value.token === 'string' && typeof value.jobId === 'string';
}

/**
 * The queue engine over one open connection.
 * @param {{ connection: any, now?: () => number,
 *   random?: () => number,
 *   gate?: (fn: () => any, what?: string, signal?: AbortSignal) => any,
 *   defaults?: Partial<typeof JOB_DEFAULTS>,
 *   runtime?: Partial<import('@jarenjs/core/runtime').Runtime> }} options
 *   `runtime` is the host's runtime record: its `now` and `random` apply
 *   where the explicit `now` and `random` options are absent, and its
 *   `uuid` mints every job id, lease token and default worker owner.
 */
export function createJobEngine(options) {
  const { connection } = options;
  const runtime = resolveRuntime(options.runtime);
  const now = options.now ?? runtime.now;
  const random = options.random ?? runtime.random;
  const uuid = runtime.uuid;
  /**
   * The store gate a WORKER's control-plane I/O takes: a worker is a
   * root-owned long-lived component, so its claims, renewals,
   * checkpoint stores and settlements are unrelated callers that wait
   * for an open application transaction instead of joining its fate —
   * even when the worker was created through a transaction view. The
   * engine's bare operations stay ungated here: the STORE decides per
   * handle (root `store.jobs` gates them, `tx.jobs` runs as the exact
   * scope, which is the transactional outbox).
   */
  const gate = options.gate ?? ((/** @type {() => any} */ fn) => fn());
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

  /**
   * Add whatever this database is missing, in place. `CREATE TABLE IF
   * NOT EXISTS` leaves a table written before the fence exactly as it
   * was, so the columns are added one at a time behind a presence
   * check — jobs rows are live work, and a rebuild would drop a queue.
   * Forward-only: nothing is ever removed here.
   */
  const upgradeColumns = () => {
    const dialect = connection.dialect;
    const next = (i) => {
      if (i >= ADDED_COLUMNS.length) return null;
      const { table, name, definition } = ADDED_COLUMNS[i];
      return chain(connection.prepare(dialect.introspect.columns(table)), (statement) =>
        chain(statement.all([]), (rows) => {
          if (rows.some((/** @type {any} */ row) => row.name === name)) return next(i + 1);
          return chain(
            connection.exec(`ALTER TABLE "${table}" ADD COLUMN ${name} ${definition}`),
            () => next(i + 1));
        }));
    };
    return next(0);
  };

  // the tables are created here, or refused here: a read-only store
  // leaked the driver's "attempt to write a readonly database"
  const ready = attempt(() => chain(connection.exec(CREATE_JOBS), upgradeColumns),
    (error) => new DbCompileError('JD0002',
      `the job tables could not be created (${error?.message ?? String(error)}) — `
      + 'a read-only store creates nothing; open it read-write once, or without jobs',
      '/jobs', error));

  const enqueue = (kind, payload, enqueueOptions) => {
    if (typeof kind !== 'string' || kind === '') {
      throw new TypeError('enqueue: "kind" must be a non-empty string');
    }
    const id = enqueueOptions?.id ?? uuid();
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
    // the claim MINTS the fence: a fresh token for this attempt, and a
    // generation one higher than whatever ran before it. Both come back
    // through the RETURNING the claim already had, so the attempt that
    // holds them is the only one that can settle the job
    const statement = prepared(`claim:${kinds.length}`,
      `UPDATE "${JOBS_TABLE}" SET state='leased', lease_owner=?, lease_until=?,
        lease_generation = lease_generation + 1, lease_token=?,
        attempts = attempts + 1, updated_at=?
      WHERE id = (SELECT id FROM "${JOBS_TABLE}"
        WHERE (state='pending' OR state='failed'
               OR (state='leased' AND lease_until < ?))
          AND run_at <= ? AND kind IN (${placeholders})
        ORDER BY run_at, created_at, id LIMIT 1)
      RETURNING *`);
    return chain(statement.get([
      owner, at + (claimOptions.leaseMs ?? defaults.leaseMs), uuid(),
      at, at, at, ...kinds,
    ]), (row) => (row === undefined
      ? undefined
      : Object.freeze({ ...publicJob(row), lease: leaseOf(row) })));
  };

  /**
   * Why a settling call matched no row. A guard that answers zero is not
   * `false` — a caller that cannot tell "already done" from "you are
   * stale" guesses, and guesses wrong (D7). The row itself says which of
   * the three it was.
   * @param {any} lease
   * @param {string} verb
   */
  const refuseSettlement = (lease, verb) => chain(
    prepared('fenceRow', `SELECT state, lease_token, lease_until, lease_generation
      FROM "${JOBS_TABLE}" WHERE id = ?`).get([lease.jobId]),
    (row) => {
      const at = now();
      // THIS attempt already settled it — a §7 handler that completed
      // transactionally, then the worker's own completion behind it.
      // Settling twice from one attempt is idempotent, not a refusal;
      // the generation says whose settlement the row carries.
      if (row !== undefined && row.state !== 'leased'
        && Number(row.lease_generation) === lease.generation) return null;
      if (row === undefined || row.state !== 'leased') {
        return new DbRuntimeError('JD2065',
          `${verb} refused: job '${lease.jobId}' is ${row === undefined
            ? 'unknown' : `'${row.state}'`}, not leased — it was settled by someone else, `
          + 'or never existed',
          { docPath: '/jobs', collection: JOBS_TABLE, key: lease.jobId });
      }
      if (row.lease_token !== lease.token) {
        return new DbRuntimeError('JD2066',
          `${verb} refused: the lease on job '${lease.jobId}' was superseded — `
          + `this one is generation ${lease.generation}, the job is on `
          + `generation ${Number(row.lease_generation)}. Another attempt holds it now; `
          + 'stop writing on its behalf',
          { docPath: '/jobs', collection: JOBS_TABLE, key: lease.jobId });
      }
      if (Number(row.lease_until) <= at) {
        return new DbRuntimeError('JD2067',
          `${verb} refused: the lease on job '${lease.jobId}' expired `
          + `${at - Number(row.lease_until)}ms ago — renew() while a handler runs longer `
          + 'than its lease, or claim it with a longer leaseMs',
          { docPath: '/jobs', collection: JOBS_TABLE, key: lease.jobId });
      }
      // the row agrees on every guard, so the update matched nothing for
      // a reason this engine does not know: report it rather than retry
      return new DbRuntimeError('JD2065',
        `${verb} refused: job '${lease.jobId}' did not accept the settlement`,
        { docPath: '/jobs', collection: JOBS_TABLE, key: lease.jobId });
    });

  /** The guard every settling statement carries (D1): the token, and a
   * lease that is still valid. Never the owner — one worker reuses one
   * owner for every attempt it ever makes. */
  const FENCE = "state='leased' AND lease_token=? AND lease_until > ?";

  /**
   * Check the lease a settling call was given, before it is used. The
   * pre-fence `(id, owner)` spelling cannot stay a settling call — it is
   * the defect — so it is refused by name rather than silently accepted.
   * @param {any} lease
   * @param {string} verb
   */
  const requireLease = (lease, verb) => {
    if (isLease(lease)) return null;
    return new DbRuntimeError('JD2068',
      `${verb} takes the lease the claim returned (job.lease), not an id and an owner. `
      + 'An owner is reused by every attempt one worker makes, so it cannot say WHICH '
      + 'attempt is settling; the lease can.',
      { docPath: '/jobs', collection: JOBS_TABLE });
  };

  /** §4: the jittered exponential backoff. */
  const backoffOf = (attempts, workerDefaults) => {
    const base = workerDefaults?.backoffBase ?? defaults.backoffBase;
    const cap = workerDefaults?.backoffCap ?? defaults.backoffCap;
    return Math.round(Math.min(cap, base * 2 ** (attempts - 1)) * (0.5 + random() / 2));
  };

  /**
   * Renew a lease (D2): a NEW token, a later expiry, the same attempt
   * and the same generation — a renewal is not a new attempt. The lease
   * it answers replaces the one it was given, and that one then fails
   * every settling call, so a reference kept across a renewal can never
   * quietly come back to life.
   * @param {any} lease - the lease the claim (or the last renew) returned
   * @param {{ leaseMs?: number }} [renewOptions]
   */
  const renew = (lease, renewOptions) => {
    const misuse = requireLease(lease, 'renew()');
    if (misuse !== null) throw misuse;
    const at = now();
    return chain(prepared('renew', `UPDATE "${JOBS_TABLE}"
      SET lease_until=?, lease_token=?, updated_at=?
      WHERE id=? AND ${FENCE}
      RETURNING *`).get([
      at + (renewOptions?.leaseMs ?? defaults.leaseMs), uuid(),
      at, lease.jobId, lease.token, at,
      ]), (row) => (row === undefined
      ? chain(refuseSettlement(lease, 'renew()'), (error) => {
        // a settled job cannot be renewed, whoever settled it
        throw error ?? new DbRuntimeError('JD2065',
          `renew() refused: job '${lease.jobId}' is already settled`,
          { docPath: '/jobs', collection: JOBS_TABLE, key: lease.jobId });
      })
      : leaseOf(row)));
  };

  /**
   * Complete a leased job — guarded by the fence, exactly-once against
   * the store (§3). A result JSON cannot express is refused HERE, before
   * any write, so the caller can fail the attempt instead of the worker.
   * @param {any} lease
   * @param {any} result
   * @throws {TypeError} when the result is not representable
   */
  const complete = (lease, result) => {
    const misuse = requireLease(lease, 'complete()');
    if (misuse !== null) throw misuse;
    const serialized = serializeResult(result);
    if (!('text' in serialized)) throw new TypeError(serialized.reason);
    const at = now();
    return chain(
      prepared('complete', `UPDATE "${JOBS_TABLE}"
        SET state='done', result=?, lease_until=NULL, lease_token=NULL, updated_at=?
        WHERE id=? AND ${FENCE}`).run([
        serialized.text, at, lease.jobId, lease.token, at,
      ]), (out) => (Number(out.changes ?? 0) > 0
        ? true
        : chain(refuseSettlement(lease, 'complete()'), (error) => {
          if (error !== null) throw error;
          return true; // this attempt's settlement already landed
        })));
  };

  /** Fail a leased job: schedule the retry or dead-letter (§4). */
  const fail = (lease, error, workerDefaults) => {
    const misuse = requireLease(lease, 'fail()');
    if (misuse !== null) throw misuse;
    return chain(get(lease.jobId), (job) => {
      if (job === undefined) {
        return chain(refuseSettlement(lease, 'fail()'), (refusal) => {
          throw refusal ?? new DbRuntimeError('JD2065',
            `fail() refused: job '${lease.jobId}' is unknown`,
            { docPath: '/jobs', collection: JOBS_TABLE, key: lease.jobId });
        });
      }
      const terminal = job.attempts >= job.maxAttempts;
      const at = now();
      const statement = terminal
        ? prepared('dead', `UPDATE "${JOBS_TABLE}"
            SET state='dead', last_error=?, lease_until=NULL, lease_token=NULL, updated_at=?
            WHERE id=? AND ${FENCE}`)
        : prepared('retry', `UPDATE "${JOBS_TABLE}"
            SET state='failed', last_error=?, lease_until=NULL, lease_token=NULL,
              run_at=?, updated_at=?
            WHERE id=? AND ${FENCE}`);
      // host code decides what it throws; reading it must not throw back
      const message = describeValue(error);
      const params = terminal
        ? [message, at, lease.jobId, lease.token, at]
        : [message, at + backoffOf(job.attempts, workerDefaults), at,
          lease.jobId, lease.token, at];
      return chain(statement.run(params), (out) => (Number(out.changes ?? 0) > 0
        ? true
        : chain(refuseSettlement(lease, 'fail()'), (refusal) => {
          if (refusal !== null) throw refusal;
          return true; // this attempt's settlement already landed
        })));
    });
  };

  /**
   * §7: the flow checkpoint store bound to ONE claimed attempt. Every
   * row it writes is stamped with that attempt's generation, and that
   * is what keeps a corpse from erasing the living:
   *
   *  - `save` carries the same fence as any other settling call, so a
   *    superseded or expired attempt writes nothing;
   *  - `load` reads what was written up to and including this
   *    generation, so a re-claimed attempt resumes from its
   *    predecessor's work rather than from nothing;
   *  - `complete`'s prune deletes only generations at or below the
   *    settling lease's, so a stale settlement cannot take a newer
   *    attempt's checkpoints with it.
   *
   * @param {{ id: string, lease?: any, leaseOwner?: string | null }} job -
   *   a claim result, which carries its own lease
   */
  const checkpointsFor = (job) => {
    const lease = job?.lease;
    const generation = isLease(lease) ? lease.generation : 0;
    return {
      load: (runId) => chain(
        prepared('cpLoad', `SELECT node_id, value FROM "${JOB_CHECKPOINTS_TABLE}"
          WHERE run_id = ? AND generation <= ?`).all([runId, generation]),
        (rows) => (rows.length === 0
          ? null
          : {
            values: Object.fromEntries(
              rows.map((row) => [row.node_id, JSON.parse(row.value)])),
          })),
      save: (runId, nodeId, value) => connection.transaction(() => {
        const misuse = requireLease(lease, 'checkpoint save()');
        if (misuse !== null) throw misuse;
        const at = now();
        return chain(
          prepared('cpFence', `SELECT id FROM "${JOBS_TABLE}"
            WHERE id=? AND ${FENCE}`).get([runId, lease.token, at]),
          (row) => {
            if (row === undefined) {
              return chain(refuseSettlement({ ...lease, jobId: runId }, 'checkpoint save()'),
                (error) => {
                  // a checkpoint is not a settlement: writing one after the
                  // job is settled is still refused, whoever settled it
                  throw error ?? new DbRuntimeError('JD2065',
                    `checkpoint save() refused: job '${runId}' is already settled`,
                    { docPath: '/jobs', collection: JOBS_TABLE, key: runId });
                });
            }
            return prepared('cpSave', `INSERT INTO "${JOB_CHECKPOINTS_TABLE}"
              (run_id, node_id, value, generation) VALUES (?, ?, ?, ?)
              ON CONFLICT (run_id, node_id) DO UPDATE
                SET value=excluded.value, generation=excluded.generation`)
              .run([runId, nodeId, JSON.stringify(value), generation]);
          });
      }),
      complete: (runId, result) => connection.transaction(() => chain(
        complete(lease, result),
        () => prepared('cpPrune', `DELETE FROM "${JOB_CHECKPOINTS_TABLE}"
          WHERE run_id = ? AND generation <= ?`).run([runId, generation]))),
    };
  };

  /** @type {Set<any>} */
  const workers = new Set();

  /** A settling refusal, as opposed to a storage failure: the three
   * the fence raises mean this attempt no longer holds the job, and no
   * amount of retrying will change that. */
  const LOST_CODES = new Set(['JD2065', 'JD2066', 'JD2067']);
  const isLeaseLost = (error) => LOST_CODES.has(/** @type {any} */ (error)?.code);

  /**
   * §6: N claim-execute loops over one handler registry.
   * @param {{ handlers: Record<string, Function>, concurrency?: number,
   *   pollInterval?: number, leaseMs?: number, owner?: string,
   *   backoffBase?: number, backoffCap?: number, renew?: boolean,
   *   onOutcome?: (event: any) => void }} workerOptions
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
    const owner = workerOptions.owner ?? uuid();
    const concurrency = workerOptions.concurrency ?? 1;
    if (!(Number.isInteger(concurrency) && concurrency >= 1)) {
      // `Array.from({ length: 0 })` started a worker that never claimed
      throw new TypeError('createWorker: "concurrency" is a positive integer');
    }
    const pollInterval = workerOptions.pollInterval ?? defaults.pollInterval;
    const leaseMs = workerOptions.leaseMs ?? defaults.leaseMs;
    // three renewals fit inside one lease, so two may fail — to a
    // stalled event loop or a busy database — before the attempt is
    // actually at risk. A handler that must not outlive its lease says
    // `renew: false` and gets the old behaviour, deliberately.
    const renewing = workerOptions.renew !== false;
    const renewEvery = Math.max(1, Math.floor(leaseMs / 3));
    const stats = {
      claims: 0, completions: 0, failures: 0, polls: 0, wakes: 0, claimErrors: 0,
      /** Leases replaced while a handler was still running. */
      renewals: 0,
      /** Attempts whose lease was lost mid-flight: aborted, and NEVER
       * counted as a completion or a failure, because this attempt no
       * longer speaks for the job. */
      lostSettlements: 0,
    };

    /** Tell the host what became of one attempt. An observer that throws
     * must never affect the loop (the app.observe discipline). */
    const notify = (event) => {
      const observer = workerOptions.onOutcome;
      if (typeof observer !== 'function') return;
      try {
        observer(Object.freeze(event));
      }
      catch {
        // deliberately swallowed; the attempt has already settled
      }
    };

    /**
     * The attempts this worker has in flight, keyed by the FENCE TOKEN.
     * Never by owner and never by job id: one worker reuses one owner for
     * every attempt it makes, and a re-claim of the same job is a
     * different attempt that must not collide with its predecessor's
     * bookkeeping.
     * @type {Map<string, any>}
     */
    const attempts = new Map();

    /**
     * Every store operation this worker itself starts — claims,
     * renewals, its checkpoint stores, settlements — while it is in
     * flight. `stop()` waits for the set to drain after the timers are
     * disarmed, so no worker-started database operation can still be
     * running when the caller closes the store: the quiescence half of
     * shutdown, separate from (and never sharing a promise with) the
     * grace-bounded handler drain.
     * @type {Set<Promise<any>>}
     */
    const controlIo = new Set();
    /**
     * Run one worker-owned store operation through the root gate,
     * tracked for quiescence. A `signal` (the worker's shutdown) takes
     * a still-queued call off the connection's queue, so a stop never
     * waits out a stranger's transaction just to cancel a claim.
     * @param {() => any} fn
     * @param {string} what
     * @param {AbortSignal} [signal]
     * @returns {Promise<any>}
     */
    const io = (fn, what, signal) => {
      const running = Promise.resolve().then(() => gate(fn, what, signal));
      controlIo.add(running);
      const done = () => controlIo.delete(running);
      running.then(done, done);
      return running;
    };

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
     * The lease this attempt LOST, and everything that follows from it:
     * the renewal timer stops, the handler's signal aborts so it writes
     * nothing else, and the attempt is barred from settling — because
     * another attempt holds the job now, and a settlement from here
     * would discard its work.
     */
    const loseLease = (attempt, error) => {
      if (attempt.lost !== null) return;
      attempt.lost = error;
      clearTimeout(attempt.timer);
      attempt.timer = null;
      attempt.controller.abort(error);
    };

    /** Arm the next renewal. Each one REPLACES the lease (D2), so the
     * attempt's newest lease is the only one that settles anything.
     * Never re-armed once the worker is stopping: after `stop()`
     * resolves, no control path may arm a timer. */
    const armRenewal = (attempt) => {
      if (!renewing || !running || attempt.lost !== null || attempt.settled) return;
      attempt.timer = setTimeout(() => {
        if (attempt.lost !== null || attempt.settled) return;
        io(() => renew(attempt.lease, { leaseMs }), 'a lease renewal', shutdown.signal)
          .then((next) => {
            if (attempt.settled) return;
            attempts.delete(attempt.lease.token);
            attempt.lease = next;
            attempts.set(next.token, attempt);
            stats.renewals += 1;
            armRenewal(attempt);
          })
          .catch((error) => {
            // Only the fence's three codes (LOST_CODES) prove this
            // attempt no longer holds the job. Anything else — a busy
            // database, a queue refusal, the shutdown cancelling a
            // queued renewal — is a storage problem the NEXT renewal may
            // well survive: the current immutable lease stays in force,
            // the handler's signal stays live, and the next renewal is
            // armed while there is time. If the lease truly expires
            // first, the next fenced call answers JD2067 and THAT is the
            // one lost outcome; no uncoded "maybe lost" is ever minted.
            if (isLeaseLost(error)) loseLease(attempt, error);
            else armRenewal(attempt);
          });
      }, renewEvery);
      attempt.timer.unref?.();
    };

    /** Everything one in-flight attempt owns, filed under its token. */
    const beginAttempt = (job) => {
      const controller = new AbortController();
      const attempt = {
        job, lease: job.lease, controller, lost: null, settled: false, timer: null,
        // the handler winds up for either reason: the worker is stopping,
        // or the job is no longer this attempt's to finish
        signal: AbortSignal.any([shutdown.signal, controller.signal]),
      };
      // the checkpoint store follows the attempt's CURRENT lease: a
      // renewal replaced the token, and a store bound to the old one
      // would be refused by the fence it is supposed to satisfy. Its
      // operations are worker control I/O — root-gated and tracked —
      // so a checkpoint can neither join an unrelated application
      // transaction nor still be writing when stop() has resolved
      attempt.checkpoints = {
        load: (runId) => io(() =>
          checkpointsFor({ ...job, lease: attempt.lease }).load(runId), 'a checkpoint read'),
        save: (runId, nodeId, value) => io(() =>
          checkpointsFor({ ...job, lease: attempt.lease }).save(runId, nodeId, value),
        'a checkpoint save'),
        complete: (runId, result) => io(() =>
          checkpointsFor({ ...job, lease: attempt.lease }).complete(runId, result),
        'a checkpoint settlement'),
      };
      attempts.set(job.lease.token, attempt);
      armRenewal(attempt);
      return attempt;
    };

    const endAttempt = (attempt) => {
      attempt.settled = true;
      clearTimeout(attempt.timer);
      attempt.timer = null;
      attempts.delete(attempt.lease.token);
    };

    /**
     * An attempt that no longer holds its job. It is its OWN outcome:
     * counting it as a completion is what let a corpse report success
     * over work another attempt was still doing, and counting it as a
     * failure would burn a retry the job never spent.
     */
    const recordLost = (attempt, phase, error) => {
      stats.lostSettlements += 1;
      notify({
        outcome: 'lost', phase,
        jobId: attempt.job.id, kind: attempt.job.kind,
        attempt: attempt.lease.attempt, generation: attempt.lease.generation,
        code: /** @type {any} */ (error)?.code ?? null,
        reason: describeValue(error),
      });
    };

    /**
     * Record one failed attempt. Reporting a failure must never itself
     * fail the loop, so a storage error here is swallowed after the
     * attempt count has already been incremented by the claim — but a
     * FENCE refusal is not a storage error: it says this attempt does
     * not hold the job, and that is a lost settlement, not a failure.
     */
    const recordFailure = async (attempt, error) => {
      try {
        await io(() => fail(attempt.lease, error, workerOptions), 'a job settlement');
      }
      catch (refusal) {
        if (isLeaseLost(refusal)) {
          recordLost(attempt, 'failure', refusal);
          return;
        }
        // the lease will expire and the job will be re-claimed (§5);
        // a worker must not die because the failure write failed
      }
      stats.failures += 1;
      notify({
        outcome: 'failed',
        jobId: attempt.job.id, kind: attempt.job.kind,
        attempt: attempt.lease.attempt, generation: attempt.lease.generation,
        reason: describeValue(error),
      });
    };

    /** @param {{ cancelled: boolean }} loopSession */
    const runOne = async (job, loopSession) => {
      stats.claims += 1;
      inFlight += 1;
      const attempt = beginAttempt(job);
      try {
        let result;
        try {
          result = await handlers[job.kind](job.payload,
            { job, checkpoints: attempt.checkpoints, signal: attempt.signal });
        }
        catch (error) {
          // past cancellation the store is closing: leave the leased
          // row to expiry-based recovery (§5) instead of racing it
          if (loopSession.cancelled) return;
          if (attempt.lost !== null) {
            recordLost(attempt, 'failure', attempt.lost);
            return;
          }
          await recordFailure(attempt, error);
          return;
        }
        if (loopSession.cancelled) return;
        if (attempt.lost !== null) {
          // it may have produced a perfectly good result; it is simply
          // not this attempt's to record any more
          recordLost(attempt, 'completion', attempt.lost);
          return;
        }
        try {
          // a §7 handler may have completed transactionally already;
          // settling twice from ONE attempt is idempotent
          await io(() => complete(attempt.lease, result ?? null), 'a job settlement');
        }
        catch (error) {
          if (isLeaseLost(error)) {
            recordLost(attempt, 'completion', error);
            return;
          }
          // an unrepresentable result, or a storage failure at the
          // completion write: this attempt failed, the worker did not
          await recordFailure(attempt, error);
          return;
        }
        stats.completions += 1;
        notify({
          outcome: 'completed',
          jobId: job.id, kind: job.kind,
          attempt: attempt.lease.attempt, generation: attempt.lease.generation,
        });
      }
      finally {
        endAttempt(attempt);
        inFlight -= 1;
      }
    };

    /** @param {{ cancelled: boolean }} loopSession */
    const loop = async (loopSession) => {
      while (running && !loopSession.cancelled) {
        let job;
        try {
          job = await io(() => claim({ kinds, owner, leaseMs }),
            'a worker claim', shutdown.signal);
        }
        catch (error) {
          // a storage failure backs off to the poll — COUNTED, so a
          // worker on a read-only store is not silently idle forever.
          // A claim the shutdown cancelled out of the queue (JD2064) is
          // the stop working, not a storage error, and counts nothing.
          if (/** @type {any} */ (error)?.code !== 'JD2064') stats.claimErrors += 1;
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
      /** The leases this worker holds right now, newest token first. A
       * diagnostic, and the shape a test reads to prove the bookkeeping
       * is keyed by token rather than by owner. */
      leases: () => [...attempts.values()].map((attempt) => attempt.lease),
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
       *
       * Two obligations, never sharing one unresolved promise:
       *
       *  1. handler DRAIN is bounded by `graceMs` — a hostile handler is
       *     reported through `{ drained: false, inFlight }` rather than
       *     waited out;
       *  2. QUIESCENCE is unconditional — every claim, renewal,
       *     checkpoint and settlement this worker started is cancelled
       *     (a queued call leaves the connection queue on the shutdown
       *     signal) or drained before `stop()` resolves, and no timer is
       *     left armed, so the caller may close the store knowing no
       *     control path still touches it. A grace timeout may detach a
       *     handler; it may not leave a database operation behind it.
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
        else {
          session.cancelled = true; // cancel what could not be drained
          // …and bar it from settling. §6.1's whole point is that a
          // cancelled loop touches the store the caller is about to
          // close no further. The abandoned lease then expires and the
          // job recovers by re-claim (§5), which is exactly what the
          // cancellation means.
          for (const abandoned of attempts.values()) abandoned.settled = true;
        }
        // quiescence, on BOTH paths: no renewal timer stays armed (and
        // none re-arms — armRenewal refuses once `running` is false)…
        for (const attempt of attempts.values()) {
          clearTimeout(attempt.timer);
          attempt.timer = null;
        }
        // …and whatever control I/O is still in flight — a cancelled
        // queued claim, a renewal a timer fired before the stop, a
        // settlement the grace deadline raced — settles before stop()
        // does. Each is signal-cancelled or bounded by the connection's
        // own timeouts, so this wait is bounded too; the loop re-checks
        // because a settling failure may record itself with one more
        // write.
        while (controlIo.size > 0) await Promise.allSettled([...controlIo]);
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
    renew,
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
