#!/usr/bin/env node

/**
 * Independent small write transactions through ONE Store on 1, 2, 4 and
 * 8 PostgreSQL sessions (`openStore(model, { sessions })`), beside the same
 * workload over as many separate Stores of one session each, and the cost
 * the routing adds to one transaction when nothing runs beside it.
 *
 * Eight clients write at once, each a run of one-document transactions on
 * keys of its own, so nothing conflicts and what the numbers show is how
 * many commits the store lets the server work on together. Every commit is
 * durable (fsync, synchronous_commit and full_page_writes on: published
 * figures come only from `npm run postgres:durable`), so a store on one
 * session pays each commit's flush in turn, and several sessions let the
 * server share it.
 *
 * Usage:
 *   JAREN_PG_URL=postgres://jaren:jaren@127.0.0.1:55433/jaren node benchmark/postgres-sessions.js [--write]
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { cpus } from 'node:os';

import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';

const args = process.argv.slice(2);
for (const arg of args) assert.equal(arg, '--write', 'unknown argument');
const URL = process.env.JAREN_PG_URL;
if (!URL) throw new Error('the sessions profile needs a PostgreSQL endpoint: set JAREN_PG_URL');
const sourceFiles = ['benchmark/postgres-sessions.js', 'packages/db/src/store.js', 'packages/db/src/sessions.js',
  'packages/db/src/driver.js', 'packages/db/src/drivers/postgres.js'];
const sourceHashes = Object.fromEntries(sourceFiles.map((file) => [file,
  createHash('sha256').update(readFileSync(new globalThis.URL(`../${file}`, import.meta.url))).digest('hex')]));

const MODEL = { $model: '0.1', collections: { items: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } } } } } };
const CLIENTS = 8;
const PER_CLIENT = 40;
const RUNS = 3;
const SEQUENTIAL = 200;

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const pg = (await import('pg')).default;
const admin = new pg.Client({ connectionString: URL });
await admin.connect();
const server = (await admin.query(`SELECT current_setting('server_version') AS version, current_setting('fsync') AS fsync,
  current_setting('synchronous_commit') AS synchronous_commit, current_setting('full_page_writes') AS full_page_writes`)).rows[0];
if (args.includes('--write'))
  for (const name of ['fsync', 'synchronous_commit', 'full_page_writes'])
    assert.equal(server[name], 'on', `published figures need ${name} on (npm run postgres:durable)`);
const schema = `jaren_sessions_bench_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE SCHEMA "${schema}"`);
const pool = new pg.Pool({ connectionString: URL, max: CLIENTS + 2 });
const driver = postgresDriver(pool, { schema, maxConnections: CLIENTS });
let tag = 0;

/** Eight clients at once over `stores`, client i on store i mod n: transactions per second. */
async function concurrent(stores) {
  const run = ++tag;
  const started = performance.now();
  await Promise.all(Array.from({ length: CLIENTS }, async (_, client) => {
    const store = stores[client % stores.length];
    for (let i = 0; i < PER_CLIENT; i++)
      await store.transaction(async (tx) => tx.collection('items').put({ id: `r${run}-c${client}-${i}`, n: i }));
  }));
  return (CLIENTS * PER_CLIENT) / ((performance.now() - started) / 1000);
}

/** One client, one transaction after another: nanoseconds per transaction. */
async function sequential(store) {
  const run = ++tag;
  const started = process.hrtime.bigint();
  for (let i = 0; i < SEQUENTIAL; i++)
    await store.transaction(async (tx) => tx.collection('items').put({ id: `s${run}-${i}`, n: i }));
  return Number(process.hrtime.bigint() - started) / SEQUENTIAL;
}

const rows = [];
const routing = {};
try {
  // a first store creates the collection, so every measured open verifies it
  await (await openStore(MODEL, { driver })).close();
  for (const sessions of [1, 2, 4, 8]) {
    const store = await openStore(MODEL, { driver, sessions });
    try {
      assert.equal(store.capabilities.connections, sessions);
      await concurrent([store]);
      const rates = [];
      for (let r = 0; r < RUNS; r++) rates.push(await concurrent([store]));
      rows.push({ shape: 'one store', sessions, stores: 1, txPerSecond: median(rates), runs: rates });
    }
    finally { await store.close(); }
  }
  for (const count of [1, 2, 4, 8]) {
    const stores = [];
    try {
      for (let i = 0; i < count; i++) stores.push(await openStore(MODEL, { driver }));
      await concurrent(stores);
      const rates = [];
      for (let r = 0; r < RUNS; r++) rates.push(await concurrent(stores));
      rows.push({ shape: 'separate stores', sessions: 1, stores: count, txPerSecond: median(rates), runs: rates });
    }
    finally { for (const store of stores) await store.close(); }
  }
  for (const [label, options] of [['one session', {}], ['two sessions, one client', { sessions: 2 }]]) {
    const store = await openStore(MODEL, { driver, ...options });
    try {
      await sequential(store);
      const samples = [];
      for (let r = 0; r < RUNS; r++) samples.push(await sequential(store));
      routing[label] = { nsPerTransaction: median(samples), runs: samples };
    }
    finally { await store.close(); }
  }
  assert.equal(driver.metrics().active, 0);
}
finally {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}

console.log(`\nIndependent one-document write transactions, ${CLIENTS} clients × ${PER_CLIENT}, median of ${RUNS} runs — PostgreSQL ${server.version}, fsync=${server.fsync}`);
for (const row of rows)
  console.log(`  ${`${row.shape}: ${row.stores} store(s) × ${row.sessions} session(s)`.padEnd(44)}${row.txPerSecond.toFixed(0).padStart(8)} tx/s`);
for (const [label, value] of Object.entries(routing))
  console.log(`  ${`sequential, ${label}`.padEnd(44)}${(value.nsPerTransaction / 1e6).toFixed(3).padStart(8)} ms/tx`);

if (args.includes('--write')) {
  const evidence = { format: 'jaren-postgres-sessions/1', measuredAt: new Date().toISOString(),
    runtime: { node: process.versions.node, pg: JSON.parse(readFileSync(new globalThis.URL('../node_modules/pg/package.json', import.meta.url), 'utf8')).version,
      platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, loadavg: readFileSync('/proc/loadavg', 'utf8').trim() },
    sourceHashes, postgres: server, clients: CLIENTS, perClient: PER_CLIENT, runs: RUNS, sequential: SEQUENTIAL, rows, routing,
    scope: 'One host, client and server on one machine; each client a run of one-document transactions on keys of its own (no conflicts), every commit durable. A store on one session runs them in turn; several sessions and separate stores let the server work on them together. No production throughput claim.' };
  writeFileSync(new globalThis.URL('./postgres-sessions-result.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
}
