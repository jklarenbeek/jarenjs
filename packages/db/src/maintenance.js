//@ts-check
/**
 * @file The maintenance surface: the four operations an operator runs
 * on a production SQLite database — a WAL checkpoint, an integrity
 * check, a foreign-key check and `PRAGMA optimize` — as typed store
 * operations. Each runs under the store gate (so it never interleaves
 * an in-flight write), returns SQLite's own answer as typed data, and
 * is refused by code (`JD2077`) exactly where the capability report
 * says it is unavailable: a driver whose binding does not declare it,
 * or — for the two that write — a read-only store, on which the engine
 * would otherwise answer a checkpoint with a silent no-op.
 *
 * Nothing here interprets the engine's numbers. A checkpoint answers
 * the row `PRAGMA wal_checkpoint` returns, so a store that is not in
 * WAL mode reports `-1` frames as the engine does; a second passive
 * checkpoint reports the same frame counts as the first (the frames
 * stay in the log until a writer restarts it) and a second `truncate`
 * reports zeros; an integrity check answers `ok: true` for the single
 * `ok` row and the engine's problem rows verbatim otherwise — corruption
 * is the RESULT, never a throw. Only a driver failure throws (`JD2078`).
 */

import { DbRuntimeError, wrapDriverError } from './errors.js';
import { chain, attempt } from './driver.js';
import { refuseCancelled } from './cancellation.js';

/** The checkpoint modes `PRAGMA wal_checkpoint` accepts, closed. */
export const CHECKPOINT_MODES = Object.freeze(['passive', 'full', 'restart', 'truncate']);

/** The operations, in the order the capability report lists them. */
export const MAINTENANCE_OPERATIONS = Object.freeze(
  ['checkpoint', 'integrityCheck', 'foreignKeyCheck', 'optimize']);

/** The two operations that write, refused on a read-only store. */
const WRITES = new Set(['checkpoint', 'optimize']);

/**
 * The driver failure wrap: an error that already carries a code is the
 * error; the driver's own failure becomes `JD2078` with the original as
 * `cause`.
 * @param {string} operation
 * @returns {(error: any) => Error}
 */
const failed = (operation) => (error) => wrapDriverError(error,
  { code: 'JD2078', reason: `the maintenance operation '${operation}' failed`, always: true });

/**
 * The per-operation capability booleans of one store: the binding's
 * declaration, and for the writing operations the store's read-only
 * flag as well — the report says `false` exactly where a call is
 * refused.
 * @param {Readonly<Record<string, boolean>> | undefined} declared - the
 *   connection's `capabilities.maintenance`
 * @param {boolean} readOnly
 * @returns {Readonly<Record<string, boolean>>}
 */
export function maintenanceCapabilities(declared, readOnly) {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const operation of MAINTENANCE_OPERATIONS) {
    out[operation] = declared?.[operation] === true && !(readOnly && WRITES.has(operation));
  }
  return Object.freeze(out);
}

/**
 * Build the maintenance operations over a connection. The caller owns
 * the gate: every operation here is value-or-promise and issues its
 * statements wherever the connection routes them.
 * Every operation takes `{ signal, deadline }` and checks them once,
 * before the one statement it issues — the granularity the driver has
 * (`JD2081` for an abort, `JD2075` for a passed deadline, on the clock
 * the store was opened with).
 * @param {{ connection: any, readOnly: boolean, now: () => number }} context
 * @returns {{ capabilities: Readonly<Record<string, boolean>>,
 *   checkpoint: (options?: { mode?: string, signal?: AbortSignal, deadline?: number }) => any,
 *   integrityCheck: (options?: { limit?: number, signal?: AbortSignal, deadline?: number }) => any,
 *   foreignKeyCheck: (options?: { signal?: AbortSignal, deadline?: number }) => any,
 *   optimize: (options?: { signal?: AbortSignal, deadline?: number }) => any }}
 */
export function createMaintenance({ connection, readOnly, now }) {
  const dialect = connection.dialect;
  const capabilities = maintenanceCapabilities(connection.capabilities.maintenance, readOnly);

  /** The cancellation check before an operation's statement.
   * @param {any} options @param {string} operation */
  const callable = (options, operation) => refuseCancelled(options, now,
    { abortCode: 'JD2081', aborted: `'${operation}' ran`, passed: `'${operation}' ran` });

  /** @param {string} operation */
  const require = (operation) => {
    if (capabilities[operation] === true) return;
    throw new DbRuntimeError('JD2077',
      readOnly && WRITES.has(operation) && connection.capabilities.maintenance?.[operation] === true
        ? `the maintenance operation '${operation}' is unavailable on a read-only store: it writes`
        : `the maintenance operation '${operation}' is unavailable on this store: the driver's `
          + 'binding does not declare it');
  };

  /** Run one pragma statement and answer its rows, driver failures wrapped.
   * @param {string} operation @param {string} sql */
  const rows = (operation, sql) => attempt(
    () => chain(connection.prepare(sql), (statement) => statement.all([])),
    failed(operation));

  return {
    capabilities,
    /**
     * `PRAGMA wal_checkpoint(<mode>)`: the engine's row, typed. `busy`
     * is whether the checkpoint could not complete because a reader or
     * writer held it; the frame counts are the engine's (`-1` when the
     * database is not in WAL mode).
     * @param {{ mode?: string, signal?: AbortSignal, deadline?: number }} [options]
     */
    checkpoint(options = undefined) {
      const mode = options?.mode ?? 'passive';
      if (typeof mode !== 'string' || !CHECKPOINT_MODES.includes(mode)) {
        throw new TypeError(`checkpoint: mode is one of ${
          CHECKPOINT_MODES.map((m) => `'${m}'`).join(', ')}, got ${JSON.stringify(mode)}`);
      }
      callable(options, 'checkpoint');
      require('checkpoint');
      return chain(rows('checkpoint', dialect.pragma.walCheckpoint(mode)), (answer) => {
        const row = answer[0] ?? {};
        return {
          busy: Number(row.busy) === 1,
          logFrames: Number(row.log ?? -1),
          checkpointedFrames: Number(row.checkpointed ?? -1),
        };
      });
    },
    /**
     * `PRAGMA integrity_check(<limit>)`: `ok` for the single `ok` row,
     * otherwise the engine's problem rows verbatim. Corruption is the
     * result, not a throw.
     * @param {{ limit?: number, signal?: AbortSignal, deadline?: number }} [options]
     */
    integrityCheck(options = undefined) {
      const limit = options?.limit;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new TypeError(`integrityCheck: limit is a positive integer, got ${JSON.stringify(limit)}`);
      }
      callable(options, 'integrityCheck');
      require('integrityCheck');
      return chain(rows('integrityCheck', dialect.pragma.integrityCheck(limit)), (answer) => {
        const problems = answer.map((row) => String(Object.values(row)[0]));
        const ok = problems.length === 1 && problems[0] === 'ok';
        return { ok, problems: ok ? [] : problems };
      });
    },
    /** `PRAGMA foreign_key_check`: every violating row, typed.
     * @param {{ signal?: AbortSignal, deadline?: number }} [options] */
    foreignKeyCheck(options = undefined) {
      callable(options, 'foreignKeyCheck');
      require('foreignKeyCheck');
      return chain(rows('foreignKeyCheck', dialect.pragma.foreignKeyCheck()), (answer) => ({
        ok: answer.length === 0,
        violations: answer.map((row) => ({
          table: String(row.table),
          rowId: row.rowid === null || row.rowid === undefined ? null : Number(row.rowid),
          parent: String(row.parent),
          fkid: Number(row.fkid),
        })),
      }));
    },
    /** `PRAGMA optimize`: the engine answers no rows, so the honest
     * result is that it ran — no invented statistics.
     * @param {{ signal?: AbortSignal, deadline?: number }} [options] */
    optimize(options = undefined) {
      callable(options, 'optimize');
      require('optimize');
      return chain(rows('optimize', dialect.pragma.optimize()), () => ({ ran: true }));
    },
  };
}
