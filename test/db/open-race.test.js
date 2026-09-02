//@ts-check
/**
 * @file The fresh-file open race: two processes released together on a
 * path that does not exist yet, each opening the store, inserting one
 * document and closing — twelve rounds on twelve fresh paths. Before
 * the fix the loser failed at the journal-mode write or the shape
 * CREATE with a raw `database is locked`: the deferred savepoint's
 * read→write upgrade is the one SQLITE_BUSY the busy handler cannot
 * retry, and the open path let the driver's error escape. Shape
 * creation now takes the write lock up front (`BEGIN IMMEDIATE`), the
 * DDL is idempotent (`CREATE … IF NOT EXISTS`), and an open-path
 * failure classed busy is retried once inside the busy window before
 * the classed `JD0002` propagates.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { recordingDriver, tempDbPath } from './helpers.js';

const ROUNDS = 12;
const CHILDREN = 2;

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, by: { type: 'string' } } },
      key: '/id',
      indexes: [{ name: 'by_by', path: '$.by' }],
    },
  },
};

/** One child: open the store on `dbPath`, insert one document, close. */
const CHILD = `
  import { openStore } from '@jarenjs/db';
  import { nodeDriver } from '@jarenjs/db/node';
  const [dbPath, who] = process.argv.slice(1);
  const store = await openStore(${JSON.stringify(MODEL)}, { driver: nodeDriver(), path: dbPath, busyTimeout: 5000 });
  await store.collection('notes').insert({ id: who, by: who });
  await store.close();
  console.log('ok ' + who);
`;

/**
 * Release `CHILDREN` processes on one fresh path at once and collect
 * every outcome.
 * @param {string} dbPath
 * @returns {Promise<{ status: number | null, stderr: string, stdout: string }[]>}
 */
function race(dbPath) {
  const children = Array.from({ length: CHILDREN }, (_, i) => spawn(process.execPath,
    ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', CHILD, dbPath, `p${i}`],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }));
  return Promise.all(children.map((child) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  })));
}

describe('two processes opening one fresh file', () => {
  it(`${ROUNDS} rounds × ${CHILDREN} processes: zero failures, zero raw "database is locked"`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-race-'));
    const failures = [];
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const dbPath = path.join(dir, `round-${round}.db`);
        const outcomes = await race(dbPath);
        for (const [i, outcome] of outcomes.entries()) {
          if (outcome.status !== 0 || !outcome.stdout.includes(`ok p${i}`)) {
            failures.push({ round, child: i, status: outcome.status, stderr: outcome.stderr.slice(0, 400) });
          }
          assert.doesNotMatch(outcome.stderr, /database is locked/,
            `round ${round} child ${i}: a raw driver error escaped`);
        }
      }
      assert.deepStrictEqual(failures, []);
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('the mechanism', () => {
  it('shape creation runs under BEGIN IMMEDIATE and its DDL is idempotent', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const { driver, executed } = recordingDriver(nodeDriver());
      const store = await openStore(MODEL, { driver, path: dbPath });
      await store.close();
      const begin = executed.indexOf('BEGIN IMMEDIATE');
      const create = executed.findIndex((sql) => /^CREATE TABLE/.test(sql));
      const commit = executed.indexOf('COMMIT');
      assert.ok(begin >= 0 && create > begin && commit > create,
        `expected BEGIN IMMEDIATE < CREATE < COMMIT in ${JSON.stringify(executed)}`);
      assert.ok(executed.filter((sql) => /^CREATE (TABLE|UNIQUE INDEX|INDEX)/.test(sql))
        .every((sql) => sql.includes('IF NOT EXISTS')), 'every shape statement is idempotent');
      assert.ok(!executed.some((sql) => /^SAVEPOINT/.test(sql) && executed.indexOf(sql) < commit),
        'the shape work is not a deferred savepoint');
      // the second open verifies and creates nothing
      const again = recordingDriver(nodeDriver());
      const reopened = await openStore(MODEL, { driver: again.driver, path: dbPath });
      await reopened.close();
      assert.deepStrictEqual(again.executed.filter((sql) => /^CREATE/.test(sql)), []);
    }
    finally {
      cleanup();
    }
  });

  it('an open that fails classed busy is retried once, then rejects JD0002 with class busy', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const seed = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      await seed.close();
      const holder = new DatabaseSync(dbPath);
      holder.exec('BEGIN EXCLUSIVE');
      const { driver, executed } = recordingDriver(nodeDriver());
      await assert.rejects(openStore(MODEL, { driver, path: dbPath, busyTimeout: 40 }),
        (error) => error.code === 'JD0002' && error.class === 'busy' && error.retryable === true);
      // the pragma chain ran twice: one retry, no more
      assert.strictEqual(executed.filter((sql) => sql === 'PRAGMA busy_timeout = 40').length, 2);
      holder.exec('ROLLBACK');
      holder.close();
      const recovered = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      await recovered.close();
    }
    finally {
      cleanup();
    }
  });
});
