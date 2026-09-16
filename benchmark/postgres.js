#!/usr/bin/env node

/**
 * The portability profile: the same model, the same documents and the
 * same query documents through the SAME store on both engines it
 * supports.
 *
 * This is NOT a rival comparison, and reading it as one would be
 * reading it wrong. SQLite here is an in-process file (or memory)
 * database and PostgreSQL is a server reached over a socket: every row
 * below carries at least one network round trip that the SQLite row
 * does not, so PostgreSQL loses almost every row and the size of the
 * loss is the point. What the numbers are FOR is the shape of the cost
 * — which operations pay one round trip and which pay one per row —
 * and whether the two engines agree on the answers while they do it.
 *
 * OPT-IN: with `JAREN_PG_URL` unset this prints the SQLite column and
 * says why the other is missing. `npm run postgres:up` publishes an
 * endpoint that satisfies it.
 *
 * Usage:
 *   JAREN_PG_URL=postgres://… node benchmark/postgres.js
 *   JAREN_PG_URL=postgres://… node benchmark/postgres.js --docs 2000
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { openStore, planMigration, migrate } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

import { formatNs } from './lib/fmt.js';

const args = process.argv.slice(2);
const DOCS = args.includes('--docs')
  ? Number(args[args.indexOf('--docs') + 1]) : 1000;
const URL = process.env.JAREN_PG_URL;
assert.ok(Number.isSafeInteger(DOCS) && DOCS >= 20 && DOCS <= 10000, '--docs must be 20..10000');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--docs') i++;
  else assert.equal(args[i], '--write', 'unknown argument');
}
if (args.includes('--write') && !URL) throw new Error('--write requires an actual PostgreSQL endpoint');
const sourceFiles = ['benchmark/postgres.js', 'packages/db/src/drivers/postgres.js',
  'packages/db/src/drivers/postgres-cursor.js', 'packages/db/src/drivers/postgres-options.js',
  'packages/db/src/store.js', 'packages/db/src/query.js', 'packages/db/src/cursor.js'];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file,
  createHash('sha256').update(readFileSync(new globalThis.URL(`../${file}`, import.meta.url))).digest('hex')]));

const MODEL = {
  $model: '0.1',
  collections: {
    people: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          age: { type: 'integer' },
          city: { type: 'string' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }, { name: 'by_city', path: '$.city' }],
    },
  },
};

const CITIES = ['amsterdam', 'berlin', 'cairo', 'delhi', 'edinburgh'];
const documents = Array.from({ length: DOCS }, (_, i) => ({
  id: `p${i}`,
  name: `person ${i}`,
  age: 18 + (i % 60),
  city: CITIES[i % CITIES.length],
}));

/** One timed call, in nanoseconds. */
async function time(fn, iterations = 1) {
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn();
  return Number(process.hrtime.bigint() - started) / iterations;
}

/**
 * Every measurement for one engine, and the answers it gave — so a
 * faster engine that answered something else is caught rather than
 * published.
 */
async function measure(open, label, meter = { calls: 0, metrics: () => null }) {
  const rows = {}, queryCalls = {}, iterations = {};
  const memoryBefore = process.memoryUsage();
  const operation = async (name, fn, count = 1) => {
    const before = meter.calls;
    rows[name] = await time(fn, count);
    queryCalls[name] = (meter.calls - before) / count;
    iterations[name] = count;
  };
  let store;
  await operation('open', async () => { store = await open(); });
  try {
    const people = store.collection('people');

    await operation('insert', async () => {
      for (const document of documents) await people.insert(document);
    });
    rows.insert /= documents.length; queryCalls.insert /= documents.length; iterations.insert = documents.length;

    await operation('get', () => people.get('p10'), 50);

    const indexed = { $for: { it: '$' }, $where: { $eq: ['$it.city', 'berlin'] },
      $return: '$it.id' };
    const scanned = { $for: { it: '$' }, $where: { $eq: ['$it.name', 'person 10'] },
      $return: '$it.id' };
    const range = { $for: { it: '$' },
      $where: { $and: [{ $ge: ['$it.age', 30] }, { $lt: ['$it.age', 40] }] },
      $return: '$it.id' };

    const answers = {};
    answers.indexed = await people.execute(indexed);
    answers.scanned = await people.execute(scanned);
    answers.range = await people.execute(range);
    await operation('indexed', () => people.execute(indexed), 20);
    await operation('scanned', () => people.execute(scanned), 20);
    await operation('range', () => people.execute(range), 20);

    const beforeCursor = meter.metrics();
    const beforeCalls = meter.calls;
    const cursor = people.query({ $for: { it: '$[*]' }, $return: '$it' });
    const firstAt = performance.now();
    let firstRowMs;
    try {
      assert.deepEqual((await cursor.next()).value, documents[0]);
      firstRowMs = performance.now() - firstAt;
    }
    finally { await cursor.return(); }
    const firstRowAndCleanupMs = performance.now() - firstAt;
    const afterCursor = meter.metrics();
    const first = { firstRowMs, firstRowAndCleanupMs, queryCalls: meter.calls - beforeCalls,
      returnedRows: 1, streaming: cursor.streaming,
      fetchedRows: afterCursor ? afterCursor.fetchedRows - beforeCursor.fetchedRows : null,
      fetchedBytes: afterCursor ? afterCursor.fetchedBytes - beforeCursor.fetchedBytes : null,
      sessionPeakRows: afterCursor?.peakRows ?? null, sessionPeakBytes: afterCursor?.peakBytes ?? null };
    if (afterCursor) assert.equal(afterCursor.cursors, 0);

    await operation('transaction', () => store.transaction(async (tx) =>
      tx.collection('people').put({ id: 'p0', name: 'changed', age: 20, city: 'berlin' })), 20);

    await store.close();
    const settled = meter.metrics();
    if (settled) { assert.equal(settled.cursors, 0); assert.equal(settled.statements, 0); }
    return { label, rows, queryCalls, iterations, answers, first, settled,
      insertPerSecond: 1e9 / rows.insert, memoryBefore, memoryAfter: process.memoryUsage() };
  }
  finally { await store.close(); }
}

/**
 * The migration cost: one new index over a populated collection, on a
 * database that outlives the store that filled it.
 * @param {{ driver: any, path?: string }} target
 * @param {any} dialect
 * @param {any} [shadowDriver]
 * @param {any} [mapping]
 */
async function measureMigration(target, dialect, shadowDriver, mapping = {}) {
  const next = structuredClone(MODEL);
  next.collections.people.indexes.push({ name: 'by_name', path: '$.name' });
  const { migration } = planMigration(MODEL, next,
    { dialect, id: '0001-index-name', ...mapping });
  const store = await openStore(MODEL, { driver: target.driver, path: target.path });
  const people = store.collection('people');
  for (const document of documents) await people.insert(document);
  await store.close();
  const started = process.hrtime.bigint();
  await migrate(target, [migration],
    { baseline: MODEL, model: next, shadowDriver });
  return Number(process.hrtime.bigint() - started);
}

const ROWS = [
  ['open', 'open the store (create or verify the shape)', 1],
  ['insert', 'insert one document', 1],
  ['get', 'get one document by key', 1],
  ['indexed', `an indexed equality over ${DOCS} documents`, 1],
  ['range', `an indexed range over ${DOCS} documents`, 1],
  ['scanned', `an unindexed equality over ${DOCS} documents`, 1],
  ['transaction', 'one transaction with one write', 1],
];

const results = [];

// ————— SQLite —————
const sqlite = await measure(() => openStore(MODEL, { driver: nodeDriver() }), 'sqlite (memory)');
results.push(sqlite);
// a FILE for the migration: the run reopens the database the fill made,
// and a memory store is a new database every time it is opened
const dbPath = join(mkdtempSync(join(tmpdir(), 'jaren-bench-')), 'store.sqlite');
const sqliteMigration = await measureMigration({ driver: nodeDriver(), path: dbPath },
  (await import('@jarenjs/db')).sqliteDialect);
rmSync(dirname(dbPath), { recursive: true, force: true });

// ————— PostgreSQL —————
let postgres = null;
let postgresMigration = null;
let server = null, admission = null, poolCounts = null, driverVersion = null;
if (URL === undefined || URL === '') {
  console.log('\nJAREN_PG_URL is not set — the PostgreSQL column is missing.');
  console.log('`npm run postgres:up` publishes an endpoint that satisfies it.\n');
}
else {
  const pg = (await import('pg')).default;
  const admin = new pg.Client({ connectionString: URL });
  await admin.connect();
  // Shadow migration owns a second independent session; ordinary measurements use one.
  const pool = new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 5000 });
  const meter = { calls: 0, connection: null, metrics: () => meter.connection?.metrics() };
  pool.on('connect', client => {
    const query = client.query;
    client.query = function (...parameters) { meter.calls++; return query.apply(this, parameters); };
  });
  driverVersion = JSON.parse(readFileSync(new globalThis.URL('../node_modules/pg/package.json', import.meta.url), 'utf8')).version;
  const schemas = [];
  const prefix = `jaren_bench_${randomUUID().replaceAll('-', '')}`;
  const freshDriver = async () => {
    const schema = `${prefix}_${schemas.length}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    return postgresDriver(pool, { schema, maxConnections: 1 });
  };
  try {
    const driver = await freshDriver();
    const originalOpen = driver.open;
    const measuredDriver = { ...driver, async open(...parameters) {
      const connection = await originalOpen(...parameters); meter.connection = connection; return connection;
    } };
    server = (await admin.query(`SELECT current_setting('server_version') AS version,
      current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,
      current_setting('full_page_writes') AS full_page_writes`)).rows[0];
    postgres = await measure(() => openStore(MODEL, { driver: measuredDriver }), `postgres (${server.version})`, meter);
    admission = driver.metrics();
    poolCounts = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
    assert.equal(admission.active, 0); assert.equal(admission.queued, 0);
    assert.equal(poolCounts.total, poolCounts.idle); assert.equal(poolCounts.waiting, 0);
    results.push(postgres);
    const migrationDriver = await freshDriver();
    postgresMigration = await measureMigration({ driver: migrationDriver },
      migrationDriver.dialect, await freshDriver(), { derived: 'stored', rtree: false });
  }
  finally {
    await pool.end();
    for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

// ————— the answers must agree before the times mean anything —————
if (postgres !== null) {
  for (const name of Object.keys(sqlite.answers)) {
    const left = JSON.stringify([...sqlite.answers[name]].sort());
    const right = JSON.stringify([...postgres.answers[name]].sort());
    if (left !== right) {
      console.error(`\nThe two engines DISAGREED on '${name}':`);
      console.error(`  sqlite:   ${left.slice(0, 200)}`);
      console.error(`  postgres: ${right.slice(0, 200)}`);
      process.exitCode = 1;
    }
  }
}

if (args.includes('--write')) {
  assert.notEqual(process.exitCode, 1, 'different answers cannot become accepted measurements');
  const evidence = { format: 'jaren-postgres-portability/1', measuredAt: new Date().toISOString(),
    runtime: { node: process.versions.node, sqlite: process.versions.sqlite, pg: driverVersion,
      platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
    documents: DOCS, sourceHashes, postgres: server, answersAgree: true,
    sqlite: { ...sqlite, migrationNs: sqliteMigration },
    native: { ...postgres, migrationNs: postgresMigration, admission, poolCounts },
    scope: 'Same-process sequential samples; client.query calls are SQL submissions, not TCP packet counts. Memory samples include shared process history and exclude server RSS. First row and cleanup are measured separately. No production latency claim.' };
  writeFileSync(new globalThis.URL('./postgres-result.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
}

// ————— the table —————
const label = (one) => one.label;
const width = Math.max(44, ...results.map((one) => label(one).length + 2));
console.log(`\nThe portability profile — ${DOCS} documents, Node ${process.versions.node}`);
console.log('An in-process file database against a server over a socket: PostgreSQL pays at');
console.log('least one round trip per row below that SQLite does not, and the size of that');
console.log('difference is what this measures.');
console.log(postgres === null ? 'PostgreSQL answers were not measured.\n'
  : process.exitCode === 1 ? 'The engines disagreed; timings are unqualified.\n' : 'Both engines answered identically.\n');
console.log(`${'operation'.padEnd(46)}${results.map((one) =>
  label(one).padStart(width)).join('')}`);
for (const [key, description] of ROWS) {
  console.log(`${description.padEnd(46)}${results.map((one) =>
    formatNs(one.rows[key]).padStart(width)).join('')}`);
}
console.log(`${'apply one migration (one new index)'.padEnd(46)}${
  [formatNs(sqliteMigration),
    ...(postgresMigration === null ? [] : [formatNs(postgresMigration)])]
    .map((cell) => cell.padStart(width)).join('')}`);

if (postgres !== null) {
  console.log('\nThe ratio, PostgreSQL over SQLite (above 1 means higher latency):');
  for (const [key, description] of ROWS) {
    console.log(`  ${description.padEnd(46)}${
      (postgres.rows[key] / sqlite.rows[key]).toFixed(1).padStart(8)}x`);
  }
  console.log(`  ${'apply one migration (one new index)'.padEnd(46)}${
    (postgresMigration / sqliteMigration).toFixed(1).padStart(8)}x`);
}
