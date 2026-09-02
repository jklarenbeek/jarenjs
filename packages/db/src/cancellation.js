//@ts-check
/**
 * @file The ONE cancellation check every unit of work in this package
 * runs before it starts: an aborted signal is a coded refusal naming
 * what was cancelled, a deadline is validated and read against the
 * clock the caller was given — the store's runtime record's, never the
 * platform's — and a passed one is `JD2075`, the one deadline code,
 * whatever the unit (a statement, a row, a step, a batch, a page).
 *
 * The check runs BETWEEN units, never inside one: the shipped SQLite
 * drivers expose no interrupt, so a statement that has started runs to
 * its end, and the capability report says so (`cancellation.midStatement`
 * is `false`). Each caller names the abort code its lifecycle owns —
 * `JD2072` for a query, `JD2080` for a migration, `JD2081` for a
 * maintenance operation, `JD2079` for a backup — and the unit it was
 * about to start, so the refusal says exactly where the work stopped.
 */

import { DbRuntimeError } from './errors.js';

/**
 * Refuse to start the next unit of work when the caller's signal has
 * aborted or its deadline has passed.
 * @param {{ signal?: AbortSignal, deadline?: number } | undefined} options
 * @param {() => number} now - the clock the deadline is read against
 * @param {{ abortCode: string, aborted: string, passed: string, ran?: string }} what -
 *   the abort code this lifecycle owns, the unit an abort was caught
 *   before ("the call was aborted before <aborted>"), the unit a passed
 *   deadline was caught before ("the deadline passed before <passed>"),
 *   and what has NOT happened as a result (default: "no statement was
 *   issued")
 */
export function refuseCancelled(options, now, what) {
  const ran = what.ran ?? 'no statement was issued';
  const signal = options?.signal;
  if (signal?.aborted === true) {
    throw new DbRuntimeError(what.abortCode,
      `the call was aborted before ${what.aborted}: ${ran}`, { cause: signal.reason });
  }
  const deadline = options?.deadline;
  if (deadline === undefined) return;
  if (typeof deadline !== 'number' || !Number.isFinite(deadline))
    throw new TypeError('deadline is an epoch-millisecond number');
  if (now() > deadline) {
    throw new DbRuntimeError('JD2075',
      `the deadline passed before ${what.passed} (${new Date(deadline).toISOString()}); ${ran}`);
  }
}
