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

import { openStore, migrate, migrationStatus, planModelMigration, shapeHash, sqliteDialect } from '@jarenjs/db';
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

/** The model with the child entity renamed to `Kid`, and the one with the parent renamed to `Folk`. */
const KID = { $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
    children: { 'x-entity': { relation: { to: 'Kid', many: true, via: 'parentId', onDelete: 'cascade' } } } } } },
  Kid: { 'x-rename': 'Child', ...MODEL.entities.Child },
} };
const FOLK = { $model: '0.1', entities: {
  Folk: { 'x-rename': 'Parent', ...MODEL.entities.Parent },
  Child: MODEL.entities.Child,
} };

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

describe(`the check is the link's own (${process.versions.bun ? 'bun' : 'node'})`, () => {
  it("an orphan an earlier, unenforced write left is not the link's doing; one the link adds still refuses it", async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      // written while enforcement was off, long before this migration
      const db = await raw(dbPath);
      try {
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec(`INSERT INTO "Child" ("id", "parentId", "doc") VALUES ('stale', 'gone', jsonb('{}'))`);
      }
      finally { db.close(); }
      assert.deepEqual(await facts(dbPath), { children: 2, violations: 1 });
      const touch = step('touch', `UPDATE "Child" SET "doc" = jsonb('{}') WHERE "id" = 'c1'`);
      const outcome = await migrate({ driver: await driver(), path: dbPath }, [touch], { baseline: MODEL, model: MODEL, shadow: false });
      assert.deepEqual(/** @type {any} */ (outcome).applied, ['touch'], 'the old orphan does not refuse the link');
      const connection = await (await driver()).open(dbPath, {});
      try {
        connection.exec('PRAGMA foreign_keys = OFF');
        // the one violation the link adds is named — the old one is not
        assert.throws(() => migrate({ connection }, [touch, DELETE_PARENT], { baseline: MODEL, shadow: false }),
          (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'constraint'
            && /leaves 1 foreign-key violation\(s\): \[\{"table":"Child","rowid":"1","parent":"Parent"/.test(error.message));
      }
      finally { connection.close(); }
    }
    finally { cleanup(); }
  });

  /** A seeded file whose child table already holds an orphan (rowid 2), written while enforcement was off. */
  async function withOldOrphan() {
    const temp = await seeded();
    const db = await raw(temp.dbPath);
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`INSERT INTO "Child" ("id", "parentId", "doc") VALUES ('stale', 'gone', jsonb('{}'))`);
    }
    finally { db.close(); }
    return temp;
  }
  /** @param {string} file */
  const violations = async (file) => {
    const db = await raw(file);
    try { return db.prepare('PRAGMA foreign_key_check').all().map((/** @type {any} */ row) => ({ ...row, rowid: Number(row.rowid) })); }
    finally { db.close(); }
  };
  /** @param {any} migration @param {string} sql */
  const adding = (migration, sql) => ({ ...migration, steps: [...migration.steps, { kind: 'sql', sql }] });

  it("a renamed child table keeps its old orphan as no violation of the link's; one the link adds still refuses it", async () => {
    const { dbPath, cleanup } = await withOldOrphan();
    try {
      const rename = planModelMigration(MODEL, KID, { dialect: sqliteDialect, id: 'rename-child' }).migration;
      assert.ok(rename.steps.some((/** @type {any} */ s) => s.sql === 'ALTER TABLE "Child" RENAME TO "Kid"'));
      const connection = await (await driver()).open(dbPath, {});
      try {
        connection.exec('PRAGMA foreign_keys = OFF');
        const added = adding(rename, `INSERT INTO "Kid" ("id", "parentId", "doc") VALUES ('fresh', 'nobody', jsonb('{}'))`);
        assert.throws(() => migrate({ connection }, [added], { baseline: MODEL, shadow: false }),
          (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'constraint'
            && error.message.includes('leaves 1 foreign-key violation(s): [{"table":"Kid","rowid":"3","parent":"Parent","fkid":0}]'));
      }
      finally { connection.close(); }
      const outcome = await migrate({ driver: await driver(), path: dbPath }, [rename], { baseline: MODEL, model: KID, shadow: false });
      assert.deepEqual(/** @type {any} */ (outcome).applied, ['rename-child']);
      assert.deepEqual(await violations(dbPath), [{ table: 'Kid', rowid: 2, parent: 'Parent', fkid: 0 }]);
    }
    finally { cleanup(); }
  });

  it("a renamed parent table keeps the old orphan as no violation of the link's, through the child's rebuild; one the link adds still refuses it", async () => {
    const { dbPath, cleanup } = await withOldOrphan();
    try {
      const rename = planModelMigration(MODEL, FOLK, { dialect: sqliteDialect, id: 'rename-parent' }).migration;
      assert.deepEqual(rename.steps.map((/** @type {any} */ s) => s.kind), ['ddl', 'rebuild']);
      // a link that rebuilds runs with enforcement off, so the orphan lands and only the link's check can refuse it
      const added = adding(rename, `INSERT INTO "Child" ("id", "parentId", "doc") VALUES ('fresh', 'nobody', jsonb('{}'))`);
      await assert.rejects(migrate({ driver: await driver(), path: dbPath }, [added], { baseline: MODEL, shadow: false }),
        (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'constraint'
          && error.message.includes('leaves 1 foreign-key violation(s): [{"table":"Child","rowid":"3","parent":"Folk","fkid":0}]'));
      const outcome = await migrate({ driver: await driver(), path: dbPath }, [rename], { baseline: MODEL, model: FOLK, shadow: false });
      assert.deepEqual(/** @type {any} */ (outcome).applied, ['rename-parent']);
      assert.deepEqual(await violations(dbPath), [{ table: 'Child', rowid: 2, parent: 'Folk', fkid: 0 }]);
    }
    finally { cleanup(); }
  });

  it('a hand-written rename counts however it is spelled; a column renamed without COLUMN renames no table', async () => {
    const { dbPath, cleanup } = await withOldOrphan();
    try {
      const rename = { $migration: '0.1', id: 'rename-by-hand', from: shapeHash(MODEL), to: shapeHash(MODEL), steps: [
        { kind: 'ddl', sql: 'alter table main.child rename to Kid;' },
        { kind: 'ddl', sql: 'ALTER TABLE "Kid" RENAME "parentId" TO "parentKey"' },
      ] };
      const outcome = await migrate({ driver: await driver(), path: dbPath }, [rename], { baseline: MODEL, shadow: false });
      assert.deepEqual(/** @type {any} */ (outcome).applied, ['rename-by-hand']);
      assert.deepEqual(await violations(dbPath), [{ table: 'Kid', rowid: 2, parent: 'Parent', fkid: 0 }]);
    }
    finally { cleanup(); }
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
