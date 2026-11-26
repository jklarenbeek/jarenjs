//@ts-check
/**
 * @file The queue's read-then-write transactions on SQLite wait out
 * another connection's write lock for `busyTimeout`, as every other write
 * does. `schedule()` reads the schedule before it writes it, a due
 * `tick()` reads the due rows before it advances them, and a checkpoint
 * `save()` reads the lease fence before it inserts: a deferred
 * transaction upgraded from read to write while another connection holds
 * the write lock meets the `SQLITE_BUSY` no busy handler is asked to wait
 * out, which would refuse `JD2005` at once however long `busyTimeout` is,
 * so each takes the write lock with its first statement. The other
 * connection is a worker thread holding `BEGIN IMMEDIATE` and an
 * uncommitted write: it releases on a timer of its own while this
 * thread's synchronous driver waits, and the shared flag it sets says
 * whether this thread's call returned before or after that release.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileRecurrence, floatingValue } from '@jarenjs/core/calendar';
import { model, scenarioClock } from './schedules-scenario.js';
import { tempDbPath } from './helpers.js';

const series = compileRecurrence({ dtstart: floatingValue('2026-03-01', '09:00'), rrule: 'FREQ=DAILY' });
const daily = (/** @type {string} */ id) => ({ id, kind: 'digest', missed: /** @type {const} */ ('skip'), zone: 'Europe/Amsterdam', series });

/** The other connection: it takes the write lock, says so, and releases it
 * `release` ms after this thread starts its call, or when told to. */
const HOLDER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
const flags = workerData.flags;
db.exec('BEGIN IMMEDIATE');
db.exec("UPDATE _jaren_job_schedules SET updated_at = updated_at WHERE id = 'seed'");
let open = true;
const release = () => {
  if (!open) return;
  open = false;
  // set before the COMMIT: the other thread cannot take the lock before it is set
  Atomics.store(flags, 1, 1);
  db.exec('COMMIT');
  db.close();
  parentPort.postMessage('released');
};
parentPort.on('message', release);
parentPort.postMessage('locked');
Atomics.wait(flags, 0, 0);
if (workerData.release !== null) setTimeout(release, workerData.release);
`;

/**
 * A store file holding one schedule and one leased job, a second store on
 * it, and the other connection holding the write lock; `call` runs once
 * the lock is held.
 * @param {{ busyTimeout: number, release: number | null }} lock
 * @param {(store: any, context: { clock: { at: number }, claimed: any }) => any} call
 */
async function underWriteLock(lock, call) {
  const file = tempDbPath();
  const { clock, options } = scenarioClock();
  /** @type {any} */
  let claimed;
  const seed = await openStore(model, { driver: nodeDriver(), path: file.dbPath, ...options() });
  try {
    await seed.jobs.schedule(daily('seed'));
    await seed.jobs.enqueue('work', {}, { id: 'run' });
    claimed = await seed.jobs.claim({ kinds: ['work'], owner: 'seed', leaseMs: 3_600_000 });
  }
  finally {
    await seed.close();
  }
  const store = await openStore(model, { driver: nodeDriver(), path: file.dbPath, busyTimeout: lock.busyTimeout, ...options() });
  const flags = new Int32Array(new SharedArrayBuffer(8));
  const holder = new Worker(HOLDER, { eval: true, workerData: { file: file.dbPath, flags, release: lock.release } });
  const released = once(holder, 'exit');
  try {
    const [first] = await once(holder, 'message');
    assert.equal(first, 'locked');
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0);
    /** @type {{ value?: any, error?: any }} */
    let outcome;
    try {
      outcome = { value: await call(store, { clock, claimed }) };
    }
    catch (error) {
      outcome = { error };
    }
    const releasedFirst = Atomics.load(flags, 1) === 1;
    holder.postMessage('release');
    if (Atomics.load(flags, 1) === 0) await once(holder, 'message');
    return { ...outcome, releasedFirst };
  }
  finally {
    await holder.terminate();
    await released;
    await store.close();
    file.cleanup();
  }
}

/** Generous against the holder's release, which comes first by far. */
const WAITS = { busyTimeout: 30_000, release: 100 };

describe('the queue\'s read-then-write transactions wait out another connection\'s write lock on SQLite', () => {
  it('schedule() waits for the lock and then writes the schedule', async () => {
    const out = await underWriteLock(WAITS, (store) => store.jobs.schedule(daily('daily')));
    assert.equal(out.error, undefined);
    assert.equal(out.releasedFirst, true);
    assert.equal(out.value.id, 'daily');
    assert.equal(out.value.state, 'active');
  });

  it('a due tick() waits for the lock and then fires the occurrence', async () => {
    const out = await underWriteLock(WAITS, (store, { clock }) => {
      clock.at = Date.UTC(2026, 2, 21, 9);
      return store.jobs.tick();
    });
    assert.equal(out.error, undefined);
    assert.equal(out.releasedFirst, true);
    assert.deepEqual({ ...out.value, fired: [...out.value.fired] },
      { fired: ['seed@2026-03-21T09:00:00'], skipped: 0, advanced: 1, more: false });
  });

  it('a checkpoint save() waits for the lock and then saves under the lease', async () => {
    const out = await underWriteLock(WAITS, async (store, { claimed }) => {
      const checkpoints = store.jobs.checkpointsFor(claimed);
      await checkpoints.save('run', 'step', { done: 1 });
      return checkpoints.load('run');
    });
    assert.equal(out.error, undefined);
    assert.equal(out.releasedFirst, true);
    assert.deepEqual(out.value, { values: { step: { done: 1 } } });
  });

  it('an idle tick() takes no lock: it answers while the other connection still holds it', async () => {
    const out = await underWriteLock({ busyTimeout: 30_000, release: null }, (store) => store.jobs.tick());
    assert.equal(out.error, undefined);
    assert.equal(out.releasedFirst, false);
    assert.deepEqual({ ...out.value, fired: [...out.value.fired] }, { fired: [], skipped: 0, advanced: 0, more: false });
  });

  it('a lock held past busyTimeout is the store\'s busy failure, not the driver\'s raw error', async () => {
    for (const call of [
      (/** @type {any} */ store) => store.jobs.schedule(daily('daily')),
      (/** @type {any} */ store, /** @type {any} */ { clock }) => { clock.at = Date.UTC(2026, 2, 21, 9); return store.jobs.tick(); },
      (/** @type {any} */ store, /** @type {any} */ { claimed }) => store.jobs.checkpointsFor(claimed).save('run', 'step', 1),
    ]) {
      const out = await underWriteLock({ busyTimeout: 20, release: null }, call);
      assert.equal(out.releasedFirst, false);
      assert.equal(out.error?.code, 'JD2005');
      assert.equal(out.error.class, 'busy');
      assert.equal(out.error.retryable, true);
      assert.equal(out.error.docPath, '/jobs');
    }
  });
});
