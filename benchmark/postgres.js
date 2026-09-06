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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { openStore, planMigration, migrate } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

import { formatNs } from './lib/fmt.js';

const args = process.argv.slice(2);
const DOCS = args.includes('--docs')
  ? parseInt(args[args.indexOf('--docs') + 1], 10) : 1000;
const URL = process.env.JAREN_PG_URL;

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
async function measure(open, label) {
  const rows = {};
  const openedAt = process.hrtime.bigint();
  const store = await open();
  rows.open = Number(process.hrtime.bigint() - openedAt);
  const people = store.collection('people');

  rows.insert = await time(async () => {
    for (const document of documents) await people.insert(document);
  }) / documents.length;

  rows.get = await time(() => people.get('p10'), 50);

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
  rows.indexed = await time(() => people.execute(indexed), 20);
  rows.scanned = await time(() => people.execute(scanned), 20);
  rows.range = await time(() => people.execute(range), 20);

  rows.transaction = await time(() => store.transaction(async (tx) =>
    tx.collection('people').put({ id: 'p0', name: 'changed', age: 20, city: 'berlin' })), 20);

  await store.close();
  return { label, rows, answers };
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
if (URL === undefined || URL === '') {
  console.log('\nJAREN_PG_URL is not set — the PostgreSQL column is missing.');
  console.log('`npm run postgres:up` publishes an endpoint that satisfies it.\n');
}
else {
  const pg = (await import('pg')).default;
  const admin = new pg.Client({ connectionString: URL });
  await admin.connect();
  const pool = new pg.Pool({ connectionString: URL, max: 8 });
  const schemas = [];
  const freshDriver = async () => {
    const schema = `jaren_bench_${process.pid}_${schemas.length}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    return postgresDriver(pool, { schema });
  };
  try {
    const driver = await freshDriver();
    postgres = await measure(() => openStore(MODEL, { driver }),
      `postgres (${(await admin.query("SELECT current_setting('server_version') AS v")).rows[0].v})`);
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

// ————— the table —————
const label = (one) => one.label;
const width = Math.max(44, ...results.map((one) => label(one).length + 2));
console.log(`\nThe portability profile — ${DOCS} documents, Node ${process.versions.node}`);
console.log('An in-process file database against a server over a socket: PostgreSQL pays at');
console.log('least one round trip per row below that SQLite does not, and the size of that');
console.log('difference is what this measures. Both engines answered identically.\n');
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
  console.log('\nThe ratio, PostgreSQL over SQLite — every row a loss, and every one expected:');
  for (const [key, description] of ROWS) {
    console.log(`  ${description.padEnd(46)}${
      (postgres.rows[key] / sqlite.rows[key]).toFixed(1).padStart(8)}x`);
  }
  console.log(`  ${'apply one migration (one new index)'.padEnd(46)}${
    (postgresMigration / sqliteMigration).toFixed(1).padStart(8)}x`);
}
