//@ts-check
/** Coherent logical backup/restore on an explicitly selected disposable Docker server. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { postgresDriver } from '@jarenjs/db/postgres';
import { recoverySnapshot, seedRecovery, writeAfterRecoveryTarget, verifyRecovery } from '../test/consumer/postgres-recovery.js';

const address = process.env.JAREN_PG_URL && new URL(process.env.JAREN_PG_URL);
const container = process.env.JAREN_PG_CONTAINER;
if (!address || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || !container)
  throw new Error('Select a disposable loopback JAREN_PG_URL and its JAREN_PG_CONTAINER');
const admin = new pg.Pool({ connectionString: address.href, max: 1, connectionTimeoutMillis: 5000 });
const names = ['source', 'restore'].map(name => `jaren_backup_${randomUUID().replaceAll('-', '')}_${name}`);
const pools = [], created = [];
const schema = 'jaren_recovery_tenant';
const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR'];
const environment = { ...Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  PGPASSWORD: decodeURIComponent(address.password) };
const command = (program, args, input) => execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD', container, program,
  ...(args[0] === '--version' ? [] : ['-h', '127.0.0.1', '-p', '5432', '-U', decodeURIComponent(address.username)]), ...args],
{ env: environment, input, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
const started = performance.now();
try {
  const identity = (await admin.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier;
  const inside = command('psql', ['-d', decodeURIComponent(address.pathname.slice(1)), '-Atc', 'SELECT system_identifier::text FROM pg_control_system()']).toString().trim();
  assert.equal(inside, identity, 'Docker tools and the injected client address different servers');
  const settings = (await admin.query(`SELECT current_setting('server_version') AS version,
    current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,
    current_setting('full_page_writes') AS full_page_writes`)).rows[0];
  assert.deepEqual([settings.fsync, settings.synchronous_commit, settings.full_page_writes], ['on', 'on', 'on']);
  const toolVersions = Object.fromEntries(['pg_dump', 'pg_restore'].map(program =>
    [program, command(program, ['--version']).toString().trim()]));
  for (const name of names) {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created.push(name);
    const url = new URL(address); url.pathname = `/${name}`;
    pools.push(new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 }));
  }
  await pools[0].query(`CREATE SCHEMA "${schema}"`);
  const drivers = pools.map(pool => postgresDriver(pool, { schema, maxConnections: 1 }));
  const seed = await seedRecovery(drivers[0]);
  const before = await recoverySnapshot(pools[0], schema);
  const archive = command('pg_dump', ['-d', names[0], '--format=custom', '--no-owner', '--no-privileges']);
  await writeAfterRecoveryTarget(drivers[0], seed);
  assert.notDeepEqual(await recoverySnapshot(pools[0], schema), before);
  command('pg_restore', ['-d', names[1], '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges'], archive);
  assert.deepEqual(await recoverySnapshot(pools[1], schema), before, 'restore changed or omitted durable state');
  let metadataOmissionCases = 0;
  const client = await pools[1].connect();
  try {
    for (const [table, rows] of Object.entries(before.tables)) {
      if (table === 'items' || rows.length === 0) continue;
      await client.query('BEGIN');
      try {
        await client.query(`DELETE FROM "${schema}"."${table.replaceAll('"', '""')}"`);
        const incomplete = await recoverySnapshot(client, schema);
        assert.deepEqual(incomplete.tables.items, before.tables.items, 'business rows alone still appear restored');
        assert.notDeepEqual(incomplete, before, `the oracle ignored omitted ${table} state`);
        metadataOmissionCases++;
      }
      finally { await client.query('ROLLBACK'); }
    }
  }
  finally { client.release(); }
  const result = await verifyRecovery(drivers[1], seed);
  for (const driver of drivers) { assert.equal(driver.metrics().active, 0); assert.equal(driver.metrics().queued, 0); }
  for (const pool of pools) { assert.equal(pool.waitingCount, 0); assert.equal(pool.idleCount, pool.totalCount); }
  const evidence = { format: 'jaren-postgres-backup/1', postgres: settings, toolVersions, metadataOmissionCases,
    archiveBytes: archive.byteLength, archiveSha256: createHash('sha256').update(archive).digest('hex'),
    tables: Object.keys(before.tables).length, rows: before.rows, bytes: before.bytes,
    elapsedMs: performance.now() - started, result, roleAndAclRestore: false, powerLoss: false };
  if (process.env.JAREN_PG_OPERATION_REPORT) writeFileSync(process.env.JAREN_PG_OPERATION_REPORT, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
finally {
  try {
    await Promise.all(pools.map(pool => pool.end()));
    for (const name of created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  }
  finally { await admin.end(); }
}
