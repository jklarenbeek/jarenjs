//@ts-check
/** An operator restore must preserve data and every durable application owner together. */
import assert from 'node:assert/strict';
import { openStore, planMigration, migrate, migrationStatus } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { backendModel } from './backend-app.js';

const query = [{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }];
const quoted = value => `"${value.replaceAll('"', '""')}"`;

/** Bounded independent SQL readback, performed before opening a restored Store.
 * @param {any} pool @param {string} schema */
export async function recoverySnapshot(pool, schema) {
  const names = (await pool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname LIMIT 101`, [schema])).rows.map(row => row.relname);
  assert.ok(names.length > 0 && names.length <= 100);
  const tables = {};
  let bytes = 0, rows = 0;
  for (const name of names) {
    const values = (await pool.query(`SELECT row_to_json(t)::text AS row FROM ${quoted(schema)}.${quoted(name)} t LIMIT 1001`)).rows.map(row => row.row).sort();
    rows += values.length; bytes += values.reduce((sum, row) => sum + Buffer.byteLength(row), 0);
    assert.ok(values.length <= 1000 && rows <= 10000 && bytes <= 4194304);
    tables[name] = values;
  }
  const columns = (await pool.query(`SELECT table_name,column_name,udt_schema,udt_name,is_nullable,column_default,ordinal_position
    FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position`, [schema])).rows;
  const indexes = (await pool.query('SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname', [schema])).rows;
  const sequences = (await pool.query(`SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,last_value
    FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename`, [schema])).rows;
  return { tables, columns, indexes, sequences, rows, bytes };
}

/** A migration precedes replica initialization; no existing replica is silently rebased.
 * @param {any} driver */
export async function seedRecovery(driver) {
  let store, peer;
  const model = structuredClone(backendModel);
  model.collections.items.indexes = [{ name: 'by_label', path: '$.label' }];
  const { migration } = planMigration(backendModel, model,
    { dialect: driver.dialect, id: 'label-index', derived: 'stored', rtree: false });
  const options = { driver, replication: { replica: 'restored-owner' }, jobs: { now: () => 1000 },
    capture: { mode: 'journal', log: true } };
  try {
    store = await openStore(backendModel, { driver }); await store.close(); store = null;
    assert.deepEqual((await migrate({ driver }, [migration], { baseline: backendModel, model, shadow: false })).applied, ['label-index']);
    store = await openStore(model, options);
    peer = await openStore(model, { driver: nodeDriver(), replication: { replica: 'inbound' } });
    const incoming = { id: 'incoming', scope: 'tenant-a', label: 'remote', amount: '9007199254740993.123456', revision: 1 };
    await peer.collection('items').put(incoming);
    const envelope = (await peer.replication.page()).items[0];
    await store.replication.apply(envelope);
    const local = { id: 'local', scope: 'tenant-a', label: 'checkpointed', amount: '0.000001', revision: 1 };
    await store.transaction(async tx => {
      await tx.collection('items').put(local);
      await tx.jobs.enqueue('workflow', { id: local.id }, { id: 'recover-job' });
    });
    const lease = await store.jobs.claim({ owner: 'before-backup', kinds: ['workflow'], leaseMs: 100 });
    await store.jobs.checkpointsFor(lease).save('recover-job', 'prepared', { amount: local.amount });
    const feed = await store.changes.page({ after: 0, limit: 8, maxBytes: 65536 });
    assert.deepEqual(feed.items.map(item => item.seq), [1, 2]);
    return { model, migration, envelope, lease, feed, rows: [incoming, local] };
  }
  finally { try { await peer?.close(); } finally { await store?.close(); } }
}

/** A later committed write must not appear in an earlier backup/recovery target.
 * @param {any} driver @param {any} seed */
export async function writeAfterRecoveryTarget(driver, seed) {
  const store = await openStore(seed.model, { driver, replication: { replica: 'restored-owner' },
    jobs: true, capture: { mode: 'journal', log: true } });
  try { await store.collection('items').put({ id: 'after-target', scope: 'tenant-a', label: 'later', amount: '9', revision: 1 }); }
  finally { await store.close(); }
}

/** Public behavior must agree with the independent restore readback, twice.
 * @param {any} driver @param {any} seed */
export async function verifyRecovery(driver, seed) {
  let connection, store;
  const options = { driver, replication: { replica: 'restored-owner' }, jobs: { now: () => 2000 },
    capture: { mode: 'journal', log: true } };
  try {
    connection = await driver.open();
    assert.equal((await migrationStatus({ connection }, [seed.migration])).upToDate, true);
    await connection.close(); connection = null;
    store = await openStore(seed.model, options);
    assert.deepEqual(await store.collection('items').execute(query), seed.rows);
    assert.equal(await store.collection('items').get('after-target'), undefined);
    assert.deepEqual(await store.changes.page({ after: 0, limit: 8, maxBytes: 65536 }), seed.feed);
    assert.equal((await store.replication.apply(seed.envelope)).status, 'duplicate');
    assert.deepEqual(await store.changes.page({ after: 0, limit: 8, maxBytes: 65536 }), seed.feed);
    const job = await store.jobs.claim({ owner: 'after-restore', kinds: ['workflow'] });
    assert.equal(job.lease.generation, 2);
    const checkpoints = store.jobs.checkpointsFor(job);
    assert.deepEqual(await checkpoints.load('recover-job'), { values: { prepared: { amount: '0.000001' } } });
    await assert.rejects(async () => store.jobs.checkpointsFor(seed.lease).save('recover-job', 'late', {}), { code: 'JD2066' });
    await checkpoints.complete('recover-job', { resumed: true });
    await store.close(); store = null;
    store = await openStore(seed.model, options);
    assert.equal((await store.jobs.get('recover-job')).state, 'done');
    assert.equal(await store.jobs.checkpointsFor(job).load('recover-job'), null);
    assert.equal((await store.replication.apply(seed.envelope)).status, 'duplicate');
    assert.deepEqual(await store.collection('items').execute(query), seed.rows);
    assert.deepEqual(await store.changes.page({ after: 0, limit: 8, maxBytes: 65536 }), seed.feed);
    const outbound = (await store.replication.page()).items;
    assert.equal(outbound.length, 1); assert.equal(outbound[0].replica, 'restored-owner');
    return { data: true, migration: true, feed: true, jobs: true, checkpoint: true,
      receipt: true, noEcho: true, secondReopen: true, laterWriteExcluded: true };
  }
  finally { try { await connection?.close(); } finally { await store?.close(); } }
}
