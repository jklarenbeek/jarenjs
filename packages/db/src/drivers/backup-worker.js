//@ts-check
/**
 * @file The Bun binding's page copy, hosted in a worker. Bun's
 * `node:sqlite` backup runs every step before it returns, so a copy on the
 * calling thread holds that thread from its first page to its last: no
 * timer, no I/O callback and no abort they raise runs until it ends. Here
 * the copy runs in a `node:worker_threads` worker on a dedicated read-only
 * connection of its own, and the calling thread stays free.
 *
 * The worker's module travels as a `data:` URL built from the source
 * below, so it resolves wherever this module does: inside a bundle and
 * inside a `bun build --compile` executable, where no file beside this one
 * exists. It imports only builtins.
 *
 * The worker cannot read a message while its copy runs (the copy holds its
 * thread too), so the stop travels through shared memory: the calling
 * thread sets one flag, and the worker's progress callback reads it after
 * each step and throws, which is what stops SQLite's pump. Each step's
 * report is posted to the calling thread and handed to `progress` there,
 * in order; a throw from `progress` (an abort, a passed deadline, the
 * caller's own) sets the flag, no later report is handed on, and the copy
 * settles with that throw once the worker has exited — its connection
 * closed, so nothing it holds outlives the copy or writes beside the
 * target after the caller removes it. The copy waits on no timer.
 *
 * The worker begins its read transaction while the calling thread waits for
 * it on the same shared memory (a few statements, bounded by the busy
 * timeout): no statement of the calling thread is then mid-commit on the
 * file, so a commit of its own on another connection cannot make the copy's
 * first read busy — as none could while the copy ran on that thread.
 */

import { cloneDriverError } from '../errors.js';

/** The worker: open the database read-only, begin one read transaction
 * (the snapshot every step copies from) while the calling thread waits for
 * it, back the database up onto the target and post `{ pages }` or
 * `{ error }` before it exits (the error of a copy the flag stopped is the
 * calling thread's to replace). Shared slots: 0 the stop flag, 1 the phase
 * of the snapshot handshake (1 ready, 2 begin, 3 begun or failed). Built
 * on first use, never at load: a bundle that never copies on Bun drops it. */
const workerSource = () => `import { parentPort, workerData } from 'node:worker_threads';
import { backup, DatabaseSync } from 'node:sqlite';
const cloneDriverError = ${cloneDriverError};
const { file, target, timeout, rate, reports, shared } = workerData;
const slots = new Int32Array(shared);
const options = rate === undefined ? {} : { rate };
if (reports) options.progress = ({ totalPages, remainingPages }) => {
  if (Atomics.load(slots, 0) !== 0) throw new Error('the copy was stopped');
  parentPort.postMessage({ totalPages, remainingPages });
};
let outcome;
try {
  const db = new DatabaseSync(file, { readOnly: true, timeout });
  try {
    Atomics.store(slots, 1, 1);
    parentPort.postMessage({ ready: true });
    Atomics.wait(slots, 1, 1);
    try { db.exec('BEGIN; SELECT count(*) FROM sqlite_schema'); }
    finally {
      Atomics.store(slots, 1, 3);
      Atomics.notify(slots, 1);
    }
    try { outcome = { pages: await backup(db, target, options) }; }
    finally {
      try { db.exec('COMMIT'); }
      catch { /* a read transaction that cannot end ends with its connection */ }
    }
  }
  finally { db.close(); }
}
catch (error) { outcome = { error: cloneDriverError(error) }; }
parentPort.postMessage(outcome);
`;

/** How long, past the copy's busy timeout, the calling thread waits for
 * the worker to begin its read transaction before it stops waiting: only a
 * worker that died mid-handshake outlasts the busy timeout. */
const HANDSHAKE_MARGIN_MS = 1000;

/** @type {URL | undefined} */
let workerUrl;

/**
 * Copy the SQLite database at `file` onto `target` page by page in a
 * worker, `rate` pages per step, inside one read transaction of a
 * dedicated read-only connection with busy timeout `timeout`; `progress`
 * receives `{ totalPages, remainingPages }` on the calling thread after
 * every step that leaves pages to copy, and a throw from it stops the copy
 * at the worker's next step. Resolves the page count SQLite reports;
 * rejects with SQLite's error (its classification fields kept), the
 * `progress` throw, or the worker's own failure. `target` does not exist
 * yet or is an empty file; a failed copy may leave a partial one.
 * @param {string} file
 * @param {string} target
 * @param {{ timeout: number, rate?: number, progress?: (report: { totalPages: number,
 *   remainingPages: number }) => void }} options
 * @returns {Promise<number>}
 */
export async function copyInWorker(file, target, { timeout, rate, progress }) {
  const { Worker } = await import('node:worker_threads');
  const shared = new SharedArrayBuffer(8);
  const slots = new Int32Array(shared);
  workerUrl ??= new URL(`data:text/javascript,${encodeURIComponent(workerSource())}`);
  const worker = new Worker(workerUrl,
    { workerData: { file, target, timeout, rate, reports: progress !== undefined, shared } });
  return new Promise((resolve, reject) => {
    /** @type {{ thrown: unknown } | null} */
    let refused = null;
    /** @type {any} */
    let outcome = null;
    worker.on('message', (message) => {
      if (message.ready === true) {
        // the read transaction begins while this thread waits: no
        // statement of this thread is mid-commit on the file then, so
        // none of its own commits can make that first read busy
        Atomics.store(slots, 1, 2);
        Atomics.notify(slots, 1);
        Atomics.wait(slots, 1, 2, timeout + HANDSHAKE_MARGIN_MS);
        return;
      }
      if (message.totalPages === undefined) { outcome = message; return; }
      if (refused !== null) return;
      try { progress?.({ totalPages: message.totalPages, remainingPages: message.remainingPages }); }
      catch (thrown) {
        refused = { thrown };
        Atomics.store(slots, 0, 1);
      }
    });
    // an uncaught failure (none but the thread's own, such as its memory)
    // has already ended the worker when it is reported
    worker.on('error', reject);
    worker.on('exit', (exitCode) => {
      if (refused !== null) reject(refused.thrown);
      else if (outcome?.pages !== undefined) resolve(outcome.pages);
      else if (outcome?.error !== undefined) reject(Object.assign(new Error(outcome.error.message), outcome.error));
      else reject(new Error(`the backup worker exited (${exitCode}) before its copy ended`));
    });
  });
}
