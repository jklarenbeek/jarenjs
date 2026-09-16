//@ts-check
/** A base backup plus archived WAL restores one named, coherent application point. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { postgresDriver } from '@jarenjs/db/postgres';
import { recoverySnapshot, seedRecovery, writeAfterRecoveryTarget, verifyRecovery } from '../test/consumer/postgres-recovery.js';

const matrix = JSON.parse(readFileSync(new URL('../docker/postgres/matrix.json', import.meta.url), 'utf8'));
const image = matrix.servers.find(server => server.major === 17).image;
const project = `jaren-recovery-${randomUUID().replaceAll('-', '')}`;
const file = fileURLToPath(new URL('../docker/postgres/compose.recovery.yaml', import.meta.url));
const sourcePort = process.env.JAREN_PG_RECOVERY_SOURCE_PORT ?? '55460';
const targetPort = process.env.JAREN_PG_RECOVERY_TARGET_PORT ?? '55461';
for (const port of [sourcePort, targetPort]) assert.ok(/^\d+$/.test(port) && Number(port) > 1024 && Number(port) <= 65535);
assert.notEqual(sourcePort, targetPort);
const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR'];
const environment = { ...Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  JAREN_PG_IMAGE: image, JAREN_PG_RECOVERY_SOURCE_PORT: sourcePort, JAREN_PG_RECOVERY_TARGET_PORT: targetPort };
const compose = args => execFileSync('docker', ['compose', '-p', project, '-f', file, ...args],
  { env: environment, encoding: 'utf8', timeout: 120000, maxBuffer: 4194304 });
const open = port => new pg.Pool({ connectionString: `postgres://jaren:jaren@127.0.0.1:${port}/jaren`,
  max: 1, connectionTimeoutMillis: 1000 });
const schema = 'jaren_recovery_tenant';
let source, restored;
const started = performance.now();
try {
  compose(['up', '-d', '--wait', 'source']);
  source = open(sourcePort);
  const version = (await source.query(`SELECT current_setting('server_version') AS version,
    current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,
    current_setting('full_page_writes') AS full_page_writes,current_setting('archive_mode') AS archive_mode`)).rows[0];
  assert.deepEqual([version.fsync, version.synchronous_commit, version.full_page_writes, version.archive_mode], ['on', 'on', 'on', 'on']);
  const basebackupVersion = compose(['exec', '-T', '-u', 'postgres', 'source', 'pg_basebackup', '--version']).trim();
  // The base image precedes every application table: replay must supply the complete history.
  compose(['exec', '-T', '-u', 'postgres', 'source', 'pg_basebackup', '-U', 'jaren', '-D', '/recovery',
    '--wal-method=stream', '--checkpoint=fast', '--no-password']);
  compose(['exec', '-T', '-u', 'postgres', 'source', 'touch', '/recovery/recovery.signal']);
  await source.query(`CREATE SCHEMA "${schema}"`);
  const driver = postgresDriver(source, { schema, maxConnections: 1 });
  const seed = await seedRecovery(driver);
  const before = await recoverySnapshot(source, schema);
  const target = (await source.query("SELECT pg_create_restore_point('jaren_checkpoint')::text AS lsn")).rows[0].lsn;
  const wal = (await source.query('SELECT pg_walfile_name($1::pg_lsn) AS name', [target])).rows[0].name;
  await writeAfterRecoveryTarget(driver, seed);
  await source.query('SELECT pg_switch_wal()');
  let archived = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = (await source.query('SELECT last_archived_wal FROM pg_stat_archiver')).rows[0];
    if (state.last_archived_wal >= wal) { archived = true; break; }
    await delay(100);
  }
  assert.equal(archived, true, 'the target WAL was not archived within the fixture deadline');
  assert.equal(driver.metrics().active, 0);
  await source.end(); source = null;
  // Only one writable owner may resume the preserved replica identity.
  compose(['stop', '-t', '5', 'source']);
  compose(['up', '-d', '--wait', 'restore']);
  restored = open(targetPort);
  let promoted = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = (await restored.query('SELECT pg_is_in_recovery() AS recovering,pg_last_wal_replay_lsn() >= $1::pg_lsn AS reached', [target])).rows[0];
    if (!state.recovering && state.reached) { promoted = true; break; }
    await delay(100);
  }
  assert.equal(promoted, true, 'recovery did not reach and promote the named target');
  const after = await recoverySnapshot(restored, schema);
  assert.equal(after.sequences.length, before.sequences.length, 'recovery changed the sequence inventory');
  // WAL can reserve sequence values ahead of rows. Logical clocks and every
  // table remain exact; physical allocation may advance but must never rewind.
  const sequenceAdvances = before.sequences.map((sequence, index) => {
    const recovered = after.sequences[index];
    assert.deepEqual({ ...recovered, last_value: sequence.last_value }, sequence);
    if (sequence.last_value === null) assert.equal(recovered.last_value, null);
    else assert.ok(BigInt(recovered.last_value) >= BigInt(sequence.last_value));
    return { name: sequence.sequencename, before: sequence.last_value, restored: recovered.last_value };
  });
  assert.deepEqual({ ...after, sequences: before.sequences }, before);
  const recoveredDriver = postgresDriver(restored, { schema, maxConnections: 1 });
  const result = await verifyRecovery(recoveredDriver, seed);
  for (const sequence of after.sequences) {
    if (sequence.last_value === null) continue;
    const next = (await restored.query('SELECT nextval($1::regclass)::text AS value',
      [`"${schema}"."${sequence.sequencename.replaceAll('"', '""')}"`])).rows[0].value;
    assert.ok(BigInt(next) > BigInt(sequence.last_value), 'recovered allocation would reuse an existing physical identifier');
  }
  assert.equal(recoveredDriver.metrics().active, 0); assert.equal(restored.waitingCount, 0);
  const evidence = { format: 'jaren-postgres-pitr/1', image, postgres: version, basebackupVersion,
    targetLsn: target, targetWal: wal, tables: Object.keys(before.tables).length, rows: before.rows,
    bytes: before.bytes, sourceStoppedBeforePromotion: true, sequenceAdvances, result,
    elapsedMs: performance.now() - started, powerLoss: false, fleetFailover: false };
  if (process.env.JAREN_PG_RECOVERY_REPORT) writeFileSync(process.env.JAREN_PG_RECOVERY_REPORT, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
finally {
  try { await Promise.all([source?.end(), restored?.end()]); }
  finally { compose(['down', '--volumes', '--timeout', '5']); }
}
