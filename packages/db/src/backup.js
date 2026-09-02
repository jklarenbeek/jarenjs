//@ts-check
/**
 * @file Online backup with atomic publication. `backupTo(targetPath)`
 * copies a live store through the driver's backup primitive and
 * publishes the copy by rename, so the target path never holds a
 * partial file: the copy is written to a temporary sibling in the same
 * directory (one file system, so the rename is atomic), renamed onto
 * the target only once the platform reported the copy complete, and
 * deleted on every other outcome — a cancellation, a copy failure, a
 * rename failure. An incomplete backup is never something a later
 * process could mistake for a good one.
 *
 * The copy runs OFF the store gate: an online backup's whole point is
 * that writers proceed. SQLite updates the copy in place when this
 * connection writes during it and restarts the copy when another
 * connection does; only the checkpoint that fixes the snapshot boundary
 * takes the gate, exactly as the other maintenance operations do.
 *
 * Cancellation is honoured BETWEEN pages, at the granularity the
 * platform reports progress (`rate` pages per step): the platform
 * itself takes no signal, so the signal is checked in the progress
 * callback and a throw there is what stops the pump. There is no
 * progress event with a zero remainder — the platform's completion
 * signal is the resolved copy, which answers the page total — so
 * progress events are handed on verbatim and completion is the promise.
 *
 * This module imports no runtime builtin: the copy, the rename and the
 * removal are the driver's primitives (`connection.backup`), present on
 * the Node binding and declared absent elsewhere.
 */

import { DbRuntimeError, wrapDriverError } from './errors.js';
import { chain, attempt, toPromise } from './driver.js';
import { refuseCancelled } from './cancellation.js';

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
     * @param {string} targetPath
     * @param {{ rate?: number, onProgress?: (progress: { totalPages: number,
     *   remainingPages: number }) => void, signal?: AbortSignal,
     *   deadline?: number, checkpoint?: string | false }} [options]
     * @returns {any} value-or-promise of `{ path, pages, checkpoint }`
     */
    backupTo(targetPath, options = undefined) {
      if (typeof targetPath !== 'string' || targetPath.length === 0)
        throw new TypeError('backupTo: targetPath is a non-empty string');
      const rate = options?.rate;
      if (rate !== undefined && (!Number.isSafeInteger(rate) || rate < 1))
        throw new TypeError(`backupTo: rate is a positive integer (pages per step), got ${JSON.stringify(rate)}`);
      const onProgress = options?.onProgress;
      if (onProgress !== undefined && typeof onProgress !== 'function')
        throw new TypeError('backupTo: onProgress is a function');
      const signal = options?.signal;
      if (!capability) {
        throw new DbRuntimeError('JD2077',
          "the maintenance operation 'backupTo' is unavailable on this store: the driver's binding "
          + 'declares no backup primitive');
      }
      // the snapshot boundary: the checkpoint mode, `false` to skip it,
      // and skipped by default on a read-only store, where a checkpoint
      // is not an operation this store may run
      const mode = options?.checkpoint === undefined
        ? (readOnly ? false : 'passive')
        : options.checkpoint;
      if (mode !== false && (typeof mode !== 'string'))
        throw new TypeError("backupTo: checkpoint is a wal_checkpoint mode or false");
      callable(options, 'no file was written');

      const boundary = mode === false
        ? null
        : gated(() => checkpoint({ mode }), 'a backup checkpoint');
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
        const progress = (report) => {
          if (signal?.aborted === true) {
            aborted = cancelled(signal);
            throw aborted;
          }
          // a passed deadline stops the pump between pages exactly as an
          // abort does, under its own code
          callable(options, 'the temporary file was removed and the target path was not written');
          onProgress?.({ totalPages: report.totalPages, remainingPages: report.remainingPages });
        };
        let copying;
        try {
          copying = files.copy(tmpPath, rate === undefined ? { progress } : { rate, progress });
        }
        catch (error) {
          return discard(aborted ?? failed(error));
        }
        // publication: the platform's resolved copy is its completion
        // signal (it answers the page total); only then is the
        // temporary file renamed onto the target. The file primitives
        // are asynchronous on every host that has them, so this leg is
        // a promise on purpose
        const publish = (pages) => chain(
          attempt(() => files.rename(tmpPath, targetPath), failed),
          () => Object.freeze({ path: targetPath, pages: Number(pages), checkpoint: checkpointed ?? null }));
        return toPromise(copying)
          .then((pages) => toPromise(publish(pages)))
          .catch((error) => discard(aborted ?? failed(error)));
      });
    },
  };
}
