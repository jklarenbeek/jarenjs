//@ts-check
/**
 * @file The job tables', the change log's and the replication tables'
 * first-open bracket is taken only to create or upgrade one: a re-open
 * whose tables, indexes, columns and state row are all there verifies them
 * holding no write lock, so it
 * opens beside another process's live writer. Where the bracket is needed
 * and its lock cannot be taken, the open fails as the store's busy failure
 * (`JD2005`, `class: 'busy'`, retryable), not as a model it cannot open
 * (`JD0002`). On SQLite (a file) and on the PostgreSQL server
 * `JAREN_PG_URL` names, in a schema of its own.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { POSTGRES_LOCK_CLASSES, transactionLock } from '../../packages/db/src/dialects/postgres-locks.js';
import { tempDbPath } from './helpers.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const MODEL = { $model: '0.1', collections: { docs: { identity: 'integer', schema: { type: 'object' } } } };
const FIRST_OPEN = /** @type {const} */ ({ jobs: { jobs: true }, capture: { capture: { mode: 'journal', log: true } },
  replication: { capture: { mode: 'journal' }, replication: { replica: 'r' } } });

/**
 * A second process that holds a write lock until it is released: on SQLite
 * `BEGIN IMMEDIATE` on `target` (a file), on PostgreSQL a transaction in
 * `schema` that runs `hold`.
 * @param {string} script - the module body, which prints `held` once it holds the lock
 * @returns {Promise<{ release: () => Promise<void> }>}
 */
const holder = (script) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `${script}\nprocess.stdin.resume(); await new Promise((done) => process.stdin.on('end', done)); await release();`],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, FORCE_COLOR: '0' } });
  child.once('error', reject);
  child.once('exit', (code) => reject(new Error(`the holder exited (${code}) before it held the lock`)));
  child.stdout.once('data', (data) => {
    if (!String(data).includes('held')) return reject(new Error(String(data)));
    resolve({ release: () => new Promise((done) => { child.removeAllListeners('exit'); child.once('exit', () => done()); child.stdin.end(); }) });
  });
});

/** @param {string} file */
const sqliteWriter = (file) => holder(`import { DatabaseSync } from 'node:sqlite';
  const db = new DatabaseSync(${JSON.stringify(file)}); db.exec('BEGIN IMMEDIATE'); console.log('held');
  const release = () => { db.exec('ROLLBACK'); db.close(); };`);

/** @param {string} schema @param {string} hold - the statement the transaction runs */
const postgresWriter = (schema, hold) => holder(`import pg from 'pg';
  const client = new pg.Client({ connectionString: ${JSON.stringify(PG_URL)} }); await client.connect();
  await client.query('SET search_path TO "${schema}"'); await client.query('BEGIN'); await client.query(${JSON.stringify(hold)});
  console.log('held');
  const release = async () => { await client.query('ROLLBACK'); await client.end(); };`);

/** A node driver that hands every statement its connections run to `note`. @param {(sql: string) => void} note */
const noting = (note) => {
  const base = nodeDriver();
  return { ...base, open: async (/** @type {any[]} */ ...args) => {
    const connection = await base.open(...args);
    return { ...connection,
      exec: (/** @type {string} */ sql) => { note(sql); return connection.exec(sql); },
      prepare: (/** @type {string} */ sql, /** @type {any} */ metadata) => { note(sql); return connection.prepare(sql, metadata); } };
  } };
};

/** What an open answered: `opened`, or the failure's code, class and verdict. @param {Promise<any>} opening */
const outcome = (opening) => opening.then(async (store) => { await store.close(); return 'opened'; },
  (error) => ({ code: error?.code, class: error?.class, retryable: error?.retryable }));

const BUSY = { code: 'JD2005', class: 'busy', retryable: true };

describe('the first-open bracket on SQLite', () => {
  for (const [label, options] of Object.entries(FIRST_OPEN)) {
    it(`${label}: a re-open takes no write lock, and opens while another process holds BEGIN IMMEDIATE`, async () => {
      const { dbPath, cleanup } = tempDbPath();
      try {
        await (await openStore(MODEL, { driver: nodeDriver(), path: dbPath, ...options })).close();
        const statements = /** @type {string[]} */ ([]);
        await (await openStore(MODEL, { driver: noting((sql) => statements.push(sql)), path: dbPath, ...options })).close();
        assert.deepStrictEqual(statements.filter((sql) => /^\s*BEGIN\b/.test(sql)), ['BEGIN']);
        const writer = await sqliteWriter(dbPath);
        try {
          assert.strictEqual(await outcome(openStore(MODEL, { driver: nodeDriver(), path: dbPath, busyTimeout: 200, ...options })), 'opened');
        }
        finally { await writer.release(); }
      }
      finally { cleanup(); }
    });

    it(`${label}: an open that must create its tables while another process holds the lock fails busy and retryable, then opens`, async () => {
      const { dbPath, cleanup } = tempDbPath();
      try {
        await (await openStore(MODEL, { driver: nodeDriver(), path: dbPath })).close();
        const writer = await sqliteWriter(dbPath);
        try {
          assert.deepStrictEqual(await outcome(openStore(MODEL, { driver: nodeDriver(), path: dbPath, busyTimeout: 200, ...options })), BUSY);
        }
        finally { await writer.release(); }
        assert.strictEqual(await outcome(openStore(MODEL, { driver: nodeDriver(), path: dbPath, ...options })), 'opened');
      }
      finally { cleanup(); }
    });

    if (label === 'jobs') it('jobs: an adopted queue is verified holding no write lock, and opens while another process holds BEGIN IMMEDIATE', async () => {
      const { dbPath, cleanup } = tempDbPath();
      try {
        await (await openStore(MODEL, { driver: nodeDriver(), path: dbPath, ...options })).close();
        const writer = await sqliteWriter(dbPath);
        try {
          assert.strictEqual(await outcome(openStore(MODEL, { driver: nodeDriver(), path: dbPath, busyTimeout: 200, adopt: true, ...options })), 'opened');
        }
        finally { await writer.release(); }
      }
      finally { cleanup(); }
    });

    // replication refuses a read-only store before any table is read
    if (label !== 'replication') it(`${label}: a read-only open of a file without its tables still refuses JD0002`, async () => {
      const { dbPath, cleanup } = tempDbPath();
      try {
        await (await openStore(MODEL, { driver: nodeDriver(), path: dbPath })).close();
        const answer = await outcome(openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true, ...options }));
        assert.strictEqual(/** @type {any} */ (answer).code, 'JD0002');
      }
      finally { cleanup(); }
    });
  }
});

describe('the first-open bracket on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('jobs: a re-open opens while another process holds a write to the job table', () => withPostgres(async ({ schema, driver }) => {
    await (await openStore(MODEL, { driver: driver(), ...FIRST_OPEN.jobs })).close();
    const writer = await postgresWriter(schema, 'LOCK TABLE "_jaren_jobs" IN ROW EXCLUSIVE MODE');
    try {
      assert.strictEqual(await outcome(openStore(MODEL, { driver: driver({ lockTimeoutMs: 300 }), ...FIRST_OPEN.jobs })), 'opened');
    }
    finally { await writer.release(); }
  }));

  it('capture: a re-open opens while another process holds a write to the change log', () => withPostgres(async ({ schema, driver }) => {
    await (await openStore(MODEL, { driver: driver(), ...FIRST_OPEN.capture })).close();
    const writer = await postgresWriter(schema, 'LOCK TABLE "_jaren_changes", "_jaren_changes_state" IN ROW EXCLUSIVE MODE');
    try {
      assert.strictEqual(await outcome(openStore(MODEL, { driver: driver({ lockTimeoutMs: 300 }), ...FIRST_OPEN.capture })), 'opened');
    }
    finally { await writer.release(); }
  }));

  it('replication: a re-open opens while another process holds the journal write lock', () => withPostgres(async ({ schema, driver }) => {
    await (await openStore(MODEL, { driver: driver(), ...FIRST_OPEN.replication })).close();
    const writer = await postgresWriter(schema, transactionLock(POSTGRES_LOCK_CLASSES.capture));
    try {
      assert.strictEqual(await outcome(openStore(MODEL, { driver: driver({ lockTimeoutMs: 300 }), ...FIRST_OPEN.replication })), 'opened');
    }
    finally { await writer.release(); }
  }));

  it('replication: an open that must create its tables past the lock timeout on a live write fails busy and retryable, then opens', () => withPostgres(async ({ schema, driver }) => {
    await (await openStore(MODEL, { driver: driver() })).close();
    const writer = await postgresWriter(schema, transactionLock(POSTGRES_LOCK_CLASSES.capture));
    try {
      assert.deepStrictEqual(await outcome(openStore(MODEL, { driver: driver({ lockTimeoutMs: 300 }), ...FIRST_OPEN.replication })), BUSY);
    }
    finally { await writer.release(); }
    assert.strictEqual(await outcome(openStore(MODEL, { driver: driver(), ...FIRST_OPEN.replication })), 'opened');
  }));

  it('jobs: an upgrade that waits past the lock timeout on a live write fails busy and retryable, then opens', () => withPostgres(async ({ pool, schema, driver }) => {
    await (await openStore(MODEL, { driver: driver(), ...FIRST_OPEN.jobs })).close();
    // a queue an earlier release created, without a column the upgrade adds
    await pool.query(`ALTER TABLE "${schema}"."_jaren_job_checkpoints" DROP COLUMN "generation"`);
    const writer = await postgresWriter(schema, 'LOCK TABLE "_jaren_jobs" IN ROW EXCLUSIVE MODE');
    try {
      assert.deepStrictEqual(await outcome(openStore(MODEL, { driver: driver({ lockTimeoutMs: 300 }), ...FIRST_OPEN.jobs })), BUSY);
    }
    finally { await writer.release(); }
    assert.strictEqual(await outcome(openStore(MODEL, { driver: driver(), ...FIRST_OPEN.jobs })), 'opened');
  }));
});
