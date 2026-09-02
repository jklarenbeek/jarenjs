//@ts-check
/**
 * @file A queue written before the fence, opened after it. Jobs rows are
 * live work: an existing database is upgraded IN PLACE — the columns are
 * added, the queued rows survive with their payloads, attempt counts and
 * schedules intact, and the first claim against the upgraded table mints
 * a fence like any other. A rebuild would have dropped the queue, which
 * is the one thing an upgrade may not do.
 *
 * The pre-fence shape is written here by hand rather than read from a
 * fixture, so this file says exactly what it is upgrading from.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore, JOBS_TABLE, JOB_CHECKPOINTS_TABLE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    x: { schema: { type: 'object', properties: { id: { type: 'string' } } },
      key: '/id', indexes: [] },
  },
};

/** The job tables exactly as 0.56.0 wrote them: no `lease_generation`,
 * no `lease_token`, and checkpoints with no `generation`. */
const PRE_FENCE_SCHEMA = `CREATE TABLE IF NOT EXISTS "${JOBS_TABLE}" (
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

/** A 0.56.0-shaped database with a queue in it. */
function seedPreFence(dbPath) {
  const raw = new DatabaseSync(dbPath);
  raw.exec(PRE_FENCE_SCHEMA);
  const insert = raw.prepare(`INSERT INTO "${JOBS_TABLE}"
    (id, kind, payload, state, run_at, attempts, max_attempts,
     lease_until, lease_owner, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('queued', 'mail', JSON.stringify({ to: 'ada' }), 'pending',
    1_000, 0, 5, null, null, 1_000, 1_000);
  insert.run('retrying', 'mail', JSON.stringify({ to: 'lin' }), 'failed',
    1_000, 2, 5, null, null, 900, 950);
  // a lease that was live when the process holding it stopped
  insert.run('abandoned', 'mail', null, 'leased',
    1_000, 1, 5, 1_500, 'a-worker-that-is-gone', 800, 800);
  raw.prepare(`INSERT INTO "${JOB_CHECKPOINTS_TABLE}" (run_id, node_id, value)
    VALUES (?, ?, ?)`).run('abandoned', 'step-1', JSON.stringify({ done: true }));
  raw.close();
}

const columnsOf = (dbPath, table) => {
  const raw = new DatabaseSync(dbPath);
  const names = raw.prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all().map((row) => row.name);
  raw.close();
  return names;
};

describe('a queue written before the fence', () => {
  it('upgrades in place: the columns are added and the queued rows survive', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      seedPreFence(dbPath);
      assert.strictEqual(columnsOf(dbPath, JOBS_TABLE).includes('lease_token'), false,
        'the fixture really is pre-fence');

      let at = 2_000;
      const clock = () => at;
      const store = await openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, jobs: { now: clock } });

      // the payloads, attempt counts and schedules are exactly as they were
      assert.deepStrictEqual((await store.jobs.get('queued')).payload, { to: 'ada' });
      assert.strictEqual((await store.jobs.get('retrying')).attempts, 2);
      assert.strictEqual((await store.jobs.get('retrying')).state, 'failed');
      assert.strictEqual((await store.jobs.get('abandoned')).leaseOwner,
        'a-worker-that-is-gone');
      assert.deepStrictEqual(await store.jobs.counts(), {
        pending: 1, leased: 1, done: 0, failed: 1, dead: 0, cancelled: 0,
        pendingKinds: { mail: 2 },
      });

      // a claim against the upgraded table mints a fence like any other
      const first = await store.jobs.claim({ kinds: ['mail'], owner: 'w' });
      assert.strictEqual(first.id, 'abandoned', 'the expired lease is claimable first');
      assert.strictEqual(typeof first.lease.token, 'string');
      assert.strictEqual(first.lease.generation, 1,
        'a row claimed before the fence existed starts at generation 0');
      assert.strictEqual(await store.jobs.complete(first.lease, { ok: 1 }), true);

      // and the checkpoint the abandoned attempt left is readable, then
      // pruned by the settlement that supersedes it
      await store.close();
      assert.deepStrictEqual(columnsOf(dbPath, JOBS_TABLE).slice(-4),
        ['created_at', 'updated_at', 'lease_generation', 'lease_token']);
      assert.strictEqual(columnsOf(dbPath, JOB_CHECKPOINTS_TABLE).includes('generation'),
        true);
    }
    finally { cleanup(); }
  });

  it('the upgrade is idempotent: a second open adds nothing and loses nothing', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      seedPreFence(dbPath);
      const first = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, jobs: true });
      await first.close();
      const columns = columnsOf(dbPath, JOBS_TABLE);

      const second = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, jobs: true });
      assert.deepStrictEqual((await second.jobs.get('queued')).payload, { to: 'ada' });
      assert.strictEqual((await second.jobs.counts()).pending, 1);
      await second.close();
      assert.deepStrictEqual(columnsOf(dbPath, JOBS_TABLE), columns,
        'the second open adds no column twice');
    }
    finally { cleanup(); }
  });

  it('a pre-fence checkpoint is inherited by the attempt that resumes the run', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      seedPreFence(dbPath);
      let at = 2_000;
      const store = await openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, jobs: { now: () => at } });
      const held = await store.jobs.claim({ kinds: ['mail'], owner: 'w' });
      assert.strictEqual(held.id, 'abandoned');
      // generation 0 is what a pre-fence row wrote under; the resuming
      // attempt is generation 1, so it reads what came before it
      assert.deepStrictEqual(store.jobs.checkpointsFor(held).load('abandoned'),
        { values: { 'step-1': { done: true } } });
      await store.close();
    }
    finally { cleanup(); }
  });
});
