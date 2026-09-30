//@ts-check
/**
 * @file Foreign keys during a migration (MIGRATION-FORMAT §2, §10): a
 * migration's own connection enforces them on every driver, and every link
 * ends with the database's foreign-key check before its history row.
 * node:sqlite switches enforcement on by default and bun:sqlite leaves it
 * off, so the same `sql` step deleting a parent whose relation declares
 * `onDelete: 'cascade'` removed the child under Node and left an orphan
 * under Bun. Now the cascade runs on both, an insert that names a missing
 * parent is refused as a `constraint`, and a borrowed connection whose
 * caller switched enforcement off cannot commit the orphan it would leave:
 * the link refuses `JD0023` listing the violation. This file runs under
 * `bun test` as it is, and spawns Bun from Node.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openStore, migrate, migrationStatus, shapeHash } from '@jarenjs/db';
import { tempDbPath } from './helpers.js';

const driver = async () => process.versions.bun
  ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
/** @param {string} file */
const raw = async (file) => {
  if (process.versions.bun) {
    const { Database } = await import('bun:sqlite');
    return new Database(file);
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file);
};
const MODEL = { $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
    children: { 'x-entity': { relation: { to: 'Child', many: true, via: 'parentId', onDelete: 'cascade' } } } } } },
  Child: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, parentId: { type: 'string' } } } },
} };
const step = (/** @type {string} */ id, /** @type {string} */ sql) =>
  ({ $migration: '0.1', id, from: shapeHash(MODEL), to: shapeHash(MODEL), steps: [{ kind: 'sql', sql }] });
const DELETE_PARENT = step('delete-parent', `DELETE FROM "Parent" WHERE "id" = 'p1'`);
const ORPHAN = step('orphan', `INSERT INTO "Child" ("id", "parentId", "doc") VALUES ('c2', 'nobody', '{}')`);

/** A file holding one parent and its child. */
async function seeded() {
  const temp = tempDbPath();
  const store = await openStore(MODEL, { driver: await driver(), path: temp.dbPath });
  await store.entity('Parent').create({ id: 'p1' });
  await store.entity('Child').create({ id: 'c1', parentId: 'p1' });
  await store.close();
  return temp;
}
/** @param {string} file */
const facts = async (file) => {
  const db = await raw(file);
  try {
    return { children: Number(/** @type {any} */ (db.prepare('SELECT count(*) AS n FROM "Child"').get()).n),
      violations: db.prepare('PRAGMA foreign_key_check').all().length };
  }
  finally { db.close(); }
};

describe(`a migration enforces foreign keys (${process.versions.bun ? 'bun' : 'node'})`, () => {
  it("a step's delete cascades as the schema declares: no orphan is left", async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      const outcome = await migrate({ driver: await driver(), path: dbPath }, [DELETE_PARENT], { baseline: MODEL, model: MODEL });
      assert.deepEqual(/** @type {any} */ (outcome).applied, ['delete-parent']);
      assert.deepEqual(await facts(dbPath), { children: 0, violations: 0 });
    }
    finally { cleanup(); }
  });

  it('enforcement is on during every step: an insert naming a missing parent is a constraint, and nothing lands', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      await assert.rejects(migrate({ driver: await driver(), path: dbPath }, [ORPHAN], { baseline: MODEL, model: MODEL, shadow: false }),
        (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'constraint' && error.retryable === false
          && /step 0 \(sql\)/.test(error.message));
      assert.deepEqual(await facts(dbPath), { children: 1, violations: 0 });
      assert.deepEqual((await migrationStatus({ driver: await driver(), path: dbPath }, [ORPHAN], {})).applied, []);
    }
    finally { cleanup(); }
  });

  it("a borrowed connection keeps its caller's setting, and the link's check refuses the orphan it would leave", async () => {
    const { dbPath, cleanup } = await seeded();
    const connection = await (await driver()).open(dbPath, {});
    try {
      connection.exec('PRAGMA foreign_keys = OFF');
      assert.throws(() => migrate({ connection }, [DELETE_PARENT], { baseline: MODEL, shadow: false }),
        (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'constraint'
          && /leaves 1 foreign-key violation\(s\): \[\{"table":"Child"/.test(error.message));
      const row = /** @type {any} */ (connection.prepare('SELECT count(*) AS n FROM "Parent"').get([]));
      assert.equal(Number(row.n), 1, 'the link rolled back whole: the parent is still there');
    }
    finally {
      connection.close();
      cleanup();
    }
  });
});

describe('the same migration under Bun, spawned', { skip: process.versions.bun !== undefined && 'this is Bun already' }, () => {
  it("bun:sqlite's default is off, and the migration's own connection turns it on", async (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.error !== undefined || which.status !== 0) {
      t.skip('no bun binary on PATH');
      return;
    }
    const { dbPath, cleanup } = tempDbPath();
    try {
      const fixture = fileURLToPath(new URL('./fixtures/migrate-foreign-keys-bun.mjs', import.meta.url));
      const root = fileURLToPath(new URL('../..', import.meta.url));
      const run = spawnSync('bun', ['run', fixture, dbPath, JSON.stringify(MODEL)], { encoding: 'utf8', cwd: root });
      assert.equal(run.status, 0, run.stderr);
      const report = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
      assert.match(report.runtime, /^bun \d/);
      assert.deepEqual(report.applied, ['delete-parent']);
      assert.equal(report.children, 0, 'the cascade ran under Bun');
      assert.deepEqual(report.violations, []);
      assert.deepEqual(report.orphanRefused, { code: 'JD0023', class: 'constraint' });
    }
    finally { cleanup(); }
  });
});
