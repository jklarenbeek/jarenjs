//@ts-check
/**
 * @file Online backup with atomic publication. `backupTo(targetPath)`
 * copies a live store through the driver's backup primitive and
 * publishes the copy by rename, so the target path never holds a
 * partial file: the copy is written to a temporary sibling in the same
 * directory (one file system, so the rename is atomic), renamed onto
 * the target only once the platform reported the copy complete, and
 * removed — with every side file the copy left beside it — on every
 * other outcome: a cancellation, a copy failure, a refused or failed
 * rename, a store closed mid-copy. An incomplete backup is never
 * something a later process could mistake for a good one. The rename is
 * refused while a non-empty write-ahead log or journal sits beside the
 * target, which SQLite would replay into the published file; the
 * target's own files are never deleted.
 *
 * Where the copy runs is the binding's. Node copies on the store's own
 * connection, on the platform's thread pool: the copy starts under the
 * store gate, so its first step never meets a write the store's own
 * transaction holds, and leaves the gate at its first progress report —
 * writers then proceed, and SQLite carries this connection's writes into
 * the copy. A binding that declares `snapshot` (Bun) copies on a
 * connection of its own and holds the gate for the whole copy: the
 * store's calls wait, and the copy is the store as it stood when it
 * began. Either way the copy starts a microtask after its admission,
 * outside the gate's synchronous extent, so a store call made from
 * `onProgress` queues behind the copy instead of running inside it — a
 * copy that runs every step synchronously would otherwise spin on that
 * call's held write forever.
 *
 * Progress: `onProgress` receives `{ totalPages, remainingPages }` after
 * a step that leaves pages to copy — never after the final step, never
 * synthesized — and an event equal to the last one delivered is not
 * delivered again (a step that met a busy source is reported again with
 * the same pair). Completion is the resolved copy, which answers the page
 * total; a copy of one step reports nothing.
 *
 * Cancellation is honoured BETWEEN steps (`rate` pages each): the
 * platform takes no signal, so the signal and the deadline — read on the
 * store's clock — are checked before the copy, in every progress callback
 * the platform makes (a throw there is what stops the pump), and again
 * before publication; an abort while the backup waits for the store gate
 * takes it out of the queue. On Bun the platform runs every step before it
 * returns, so only an abort raised inside `onProgress` or a passed
 * deadline stops a copy mid-way; an abort raised by a timer or an I/O
 * callback that came due during the copy lands after the copy and before
 * publication, and one raised later than that may come too late.
 *
 * This module imports no runtime builtin: the copy, the rename and the
 * removal are the driver's primitives (`connection.backup`).
 */

import { DbRuntimeError, wrapDriverError } from './errors.js';
import { chain, attempt, toPromise, isThenable } from './driver.js';
import { refuseCancelled } from './cancellation.js';
import { isAbortSignal, isPlainOptions, refuseUnknownMembers } from './options.js';
import { CHECKPOINT_MODES } from './maintenance.js';

/**
 * The temporary sibling of a target path: same directory, a marker a
 * sweep can recognise, and a suffix from the store's injected
 * randomness.
 * @param {string} targetPath
 * @param {() => number} random
 * @returns {string}
 */
export function temporaryPathFor(targetPath, random) {
  const word = () => Math.floor(random() * 0x100000000).toString(16).padStart(8, '0');
  return `${targetPath}.jaren-tmp-${word()}${word()}`;
}

/**
 * Refuse, with a `TypeError`, a target that is not a file path SQLite
 * reads as written: not a non-empty string; holding a NUL byte (SQLite
 * reads a name only up to it); beginning `file:`, a URI, which can name
 * another file than the one written or published; or `:memory:`, a memory
 * database. The one rule for every SQLite file this package writes
 * (`backupTo`'s target, `snapshotDatabase`'s). Lives here because this
 * module imports no builtin, so the store's client bundle can carry it.
 * @param {unknown} path
 * @param {string} what - the argument's name, for the message
 * @returns {asserts path is string}
 */
export function checkSqliteTargetPath(path, what) {
  if (typeof path !== 'string' || path === '') throw new TypeError(`${what} is a non-empty file path`);
  if (path.includes('\0'))
    throw new TypeError(`${what} is a file path without NUL bytes: SQLite would read it only up to the first`);
  if (path.startsWith('file:') || path === ':memory:') {
    throw new TypeError(`${what} is a file path, and SQLite reads '${path}' as `
      + `${path === ':memory:' ? 'a memory database' : 'a URI'} (write './${path}' for that relative path)`);
  }
}

/** The options `backupTo` reads, a closed set. */
const BACKUP_OPTIONS = Object.freeze(['rate', 'onProgress', 'signal', 'deadline', 'checkpoint']);

/** The largest `rate` the platform's backup takes: a 32-bit signed count. */
const RATE_MAX = 0x7fffffff;

/**
 * Refuse a malformed or unknown `backupTo` option before the backup waits
 * for anything or writes anything: a `TypeError` coded `JD0013`, as every
 * store operation codes a refused option, naming the member (and, for an
 * unknown one, the member most plausibly meant).
 * @param {unknown} options
 */
function readBackupOptions(options) {
  if (options === undefined) return;
  const refuse = (/** @type {string} */ reason) => Object.assign(new TypeError(`backupTo: ${reason}`), { code: 'JD0013' });
  if (!isPlainOptions(options)) throw refuse('options must be a plain object');
  refuseUnknownMembers(options, BACKUP_OPTIONS, (key, hint) => refuse(`option '${key}' is not one it reads${hint}`));
  const { rate, onProgress, signal, deadline, checkpoint } = /** @type {Record<string, any>} */ (options);
  if (rate !== undefined && (!Number.isSafeInteger(rate) || rate < 1 || rate > RATE_MAX))
    throw refuse(`option 'rate' is a whole number of pages per step from 1 to ${RATE_MAX}, got ${JSON.stringify(rate)}`);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw refuse("option 'onProgress' must be a function");
  if (signal !== undefined && !isAbortSignal(signal)) throw refuse("option 'signal' must be an AbortSignal");
  if (deadline !== undefined && (typeof deadline !== 'number' || !Number.isFinite(deadline)))
    throw refuse("option 'deadline' must be a finite epoch-millisecond timestamp");
  if (checkpoint !== undefined && checkpoint !== false && !CHECKPOINT_MODES.includes(checkpoint)) {
    throw refuse(`option 'checkpoint' is false or one of ${CHECKPOINT_MODES.map((mode) => `'${mode}'`).join(', ')}, `
      + `got ${JSON.stringify(checkpoint)}`);
  }
}

/**
 * Build `backupTo` over a connection.
 * @param {{ connection: any, readOnly: boolean,
 *   gated: (fn: () => any, what: string) => any,
 *   checkpoint: (options?: { mode?: string }) => any,
 *   random: () => number, now: () => number }} context - `checkpoint`
 *   is the maintenance surface's own (ungated; the gate is taken here
 *   around it); `now` is the clock a deadline is read against
 * @returns {{ capability: boolean,
 *   backupTo: (targetPath: string, options?: any) => any }}
 */
export function createBackup({ connection, readOnly, gated, checkpoint, random, now }) {
  const capability = connection.capabilities.backup === true && connection.backup !== null;

  /** The driver's own failure, classed and wrapped under the backup's
   * lifecycle code; a coded error is the error. A file-system failure
   * (a refused rename, a missing directory the platform reports as
   * `unable to open`) rides the same wrap. */
  const failed = (error) => wrapDriverError(error, { code: 'JD2078', reason: 'the backup failed', always: true });

  /** @param {AbortSignal} signal */
  const cancelled = (signal) => new DbRuntimeError('JD2079',
    'the backup was cancelled between pages; the temporary file was removed and the '
    + 'target path was not written', { cause: signal.reason });
  /** The check before the copy starts and between its pages: an abort
   * is the backup's own lifecycle code, a passed deadline the one
   * deadline code, both with the file consequences named. */
  const callable = (options, ran) => refuseCancelled(options, now,
    { abortCode: 'JD2079', aborted: 'the copy started', passed: 'the next page', ran });

  return {
    capability,
    /**
     * Copy the store to a temporary sibling of `targetPath` and publish
     * it there by rename, under the contract of this module's comment.
     * @param {string} targetPath
     * @param {{ rate?: number, onProgress?: (progress: { totalPages: number,
     *   remainingPages: number }) => void, signal?: AbortSignal,
     *   deadline?: number, checkpoint?: string | false }} [options] -
     *   `rate` pages per step (the platform's 100 by default); an abort
     *   is `JD2079`, a passed deadline `JD2075`, a throw from
     *   `onProgress` `JD2078` with the throw as its `cause`
     * @returns {any} value-or-promise of `{ path, pages, checkpoint }`
     */
    backupTo(targetPath, options = undefined) {
      checkSqliteTargetPath(targetPath, 'backupTo: targetPath');
      readBackupOptions(options);
      const rate = options?.rate;
      const onProgress = options?.onProgress;
      const signal = options?.signal;
      if (!capability) {
        throw new DbRuntimeError('JD2077',
          "the maintenance operation 'backupTo' is unavailable on this store: the driver's binding "
          + 'declares no backup primitive');
      }
      // the snapshot boundary: the checkpoint mode, `false` to skip it,
      // and skipped by default on a read-only store, where a checkpoint
      // is not an operation this store may run
      const advisory = options?.checkpoint === undefined;
      const mode = advisory ? (readOnly ? false : 'passive') : options.checkpoint;
      callable(options, 'no file was written');
      /** The signal leaves the gate's queue as well: a wait it abandoned
       * (`JD2064`) is the backup's own cancellation before any file. */
      const admitted = (error) => {
        if (error?.code !== 'JD2064' || signal?.aborted !== true) return error;
        try { callable(options, 'no file was written'); }
        catch (refusal) { return refusal; }
        return error;
      };

      // the default boundary is advisory: the copy reads committed log
      // frames either way, so a checkpoint the connection cannot run now (a
      // statement in progress on it, another connection's lock) is skipped
      // and reported `null`; a mode the caller asked for still fails
      const boundaryFailed = (/** @type {any} */ error) => {
        if (advisory && error?.code === 'JD2078' && error?.class === 'busy') return null;
        throw admitted(error);
      };
      const boundary = mode === false ? null : (() => {
        try {
          const out = gated(() => checkpoint({ mode }), 'a backup checkpoint', signal);
          return isThenable(out) ? toPromise(out).then(undefined, boundaryFailed) : out;
        }
        catch (error) { return boundaryFailed(error); }
      })();
      return chain(boundary, (checkpointed) => {
        callable(options, 'no file was written');
        const tmpPath = temporaryPathFor(targetPath, random);
        const files = connection.backup;
        /** Remove the temporary file, then settle with `error`; a
         * removal that itself fails rides along rather than replacing
         * the reason the backup failed. */
        const discard = (error) => chain(
          attempt(() => files.remove(tmpPath), (removal) => {
            error.cleanupError = removal;
            return error;
          }),
          () => { throw error; });
        let aborted = null;
        /** The last event delivered: only a changed pair is news. */
        let delivered = null;
        const progress = (report) => {
          if (signal?.aborted === true) {
            aborted = cancelled(signal);
            throw aborted;
          }
          // a passed deadline stops the pump between pages exactly as an
          // abort does, under its own code
          callable(options, 'the temporary file was removed and the target path was not written');
          const { totalPages, remainingPages } = report;
          if (delivered?.totalPages === totalPages && delivered.remainingPages === remainingPages) return;
          delivered = { totalPages, remainingPages };
          onProgress?.({ totalPages, remainingPages });
        };
        /** Start the copy a microtask after its admission (see the module
         * comment), checking again what the wait for the gate outlived. */
        const copy = (report) => Promise.resolve().then(() => {
          callable(options, 'no file was written');
          return files.copy(tmpPath, rate === undefined ? { progress: report } : { rate, progress: report });
        });
        let copied;
        try {
          if (files.snapshot === true) copied = gated(() => copy(progress), 'a snapshot backup', signal);
          else {
            // the gate is held until the first progress report or the
            // copy's settlement, whichever comes first
            let copying;
            const started = gated(() => new Promise((firstStep) => {
              copying = copy((report) => { firstStep(); progress(report); });
              copying.then(firstStep, firstStep);
            }), 'a backup start', signal);
            copied = toPromise(started).then(() => copying);
          }
        }
        catch (error) {
          return discard(aborted ?? admitted(failed(error)));
        }
        // publication: the platform's resolved copy is its completion
        // signal (it answers the page total); only then is the
        // temporary file renamed onto the target. The file primitives
        // are asynchronous on every host that has them, so this leg is
        // a promise on purpose
        const publish = (pages) => chain(
          attempt(() => files.rename(tmpPath, targetPath), failed),
          () => Object.freeze({ path: targetPath, pages: Number(pages), checkpoint: checkpointed ?? null }));
        return toPromise(copied)
          .then((pages) => {
            if (signal?.aborted === true) { aborted = cancelled(signal); throw aborted; }
            callable(options, 'the temporary file was removed and the target path was not written');
            return toPromise(publish(pages));
          })
          .catch((error) => discard(aborted ?? admitted(failed(error))));
      });
    },
  };
}
