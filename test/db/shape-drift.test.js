//@ts-check
/**
 * @file "Verify, never alter" means verify EVERYTHING that decides
 * behaviour.
 *
 * A structural check that reads column names, types and index membership
 * accepts a database that has quietly lost its `PRIMARY KEY`, its
 * `NOT NULL`, its `STRICT`, a `CHECK`, a default or a generated column's
 * expression; that has changed `ON DELETE SET NULL` to
 * `ON DELETE CASCADE`; or whose composite index now reads `(b,a)` instead
 * of `(a,b)`. Every one of those leaves names and types untouched while
 * changing identity, deletion semantics or the plan the optimizer picks —
 * so each mutation below must be `JD0002` on reopen.
 *
 * The one difference that is NOT drift: physical column order. SQLite's
 * `ALTER TABLE … ADD COLUMN` can only append, so a migrated table and a
 * freshly built one legitimately disagree there, and this store never
 * reads a column positionally.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore, comparableDeclaredSql } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' } },
        required: ['id'],
      },
      key: '/id',
      indexes: [{ name: 'ab', path: ['$.a', '$.b'] }],
    },
  },
};

/**
 * Build the store once, close it, replace the physical schema with
 * `mutate`, and reopen — the reopen must refuse with `JD0002`.
 * @param {(db: DatabaseSync, sql: Map<string, string>) => void} mutate
 */
const driftRefuses = async (mutate) => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
    await store.close();

    const db = new DatabaseSync(dbPath);
    /** @type {Map<string, string>} */
    const sql = new Map();
    for (const row of db.prepare(
      'SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL').all()) {
      sql.set(String(row.name), String(row.sql));
    }
    mutate(db, sql);
    db.close();

    await assert.rejects(
      () => openStore(MODEL, { driver: nodeDriver(), path: dbPath }),
      (error) => /** @type {any} */ (error).code === 'JD0002');
  }
  finally {
    cleanup();
  }
};

/** Rebuild `notes` from a hand-written CREATE, keeping the indexes. */
const rebuildAs = (db, sql, createTable) => {
  db.exec('PRAGMA writable_schema=OFF');
  db.exec('DROP TABLE "notes"');
  db.exec(createTable);
  for (const [name, text] of sql) {
    if (name !== 'notes' && text.startsWith('CREATE INDEX')) db.exec(text);
    else if (name !== 'notes' && text.startsWith('CREATE UNIQUE INDEX')) db.exec(text);
  }
};

describe('physical drift is refused, property by property', () => {
  it('a dropped PRIMARY KEY', () => driftRefuses((db, sql) => {
    rebuildAs(db, sql,
      'CREATE TABLE "notes"("key" TEXT,"doc" BLOB NOT NULL,'
      + '"gx_a" TEXT GENERATED ALWAYS AS (json_extract("doc",\'$."a"\')) VIRTUAL,'
      + '"gx_b" TEXT GENERATED ALWAYS AS (json_extract("doc",\'$."b"\')) VIRTUAL) STRICT');
  }));

  it('a dropped NOT NULL', () => driftRefuses((db, sql) => {
    rebuildAs(db, sql,
      'CREATE TABLE "notes"("key" TEXT PRIMARY KEY,"doc" BLOB,'
      + '"gx_a" TEXT GENERATED ALWAYS AS (json_extract("doc",\'$."a"\')) VIRTUAL,'
      + '"gx_b" TEXT GENERATED ALWAYS AS (json_extract("doc",\'$."b"\')) VIRTUAL) STRICT');
  }));

  it('a dropped STRICT', () => driftRefuses((db, sql) => {
    rebuildAs(db, sql,
      'CREATE TABLE "notes"("key" TEXT PRIMARY KEY,"doc" BLOB NOT NULL,'
      + '"gx_a" TEXT GENERATED ALWAYS AS (json_extract("doc",\'$."a"\')) VIRTUAL,'
      + '"gx_b" TEXT GENERATED ALWAYS AS (json_extract("doc",\'$."b"\')) VIRTUAL)');
  }));

  it('a changed generated-column EXPRESSION', () => driftRefuses((db, sql) => {
    rebuildAs(db, sql,
      'CREATE TABLE "notes"("key" TEXT PRIMARY KEY,"doc" BLOB NOT NULL,'
      // reads `b` while still being called gx_a: same name, same type
      + '"gx_a" TEXT GENERATED ALWAYS AS (json_extract("doc",\'$."b"\')) VIRTUAL,'
      + '"gx_b" TEXT GENERATED ALWAYS AS (json_extract("doc",\'$."b"\')) VIRTUAL) STRICT');
  }));

  it('a reversed composite index', () => driftRefuses((db) => {
    db.exec('DROP INDEX "notes_ab"');
    db.exec('CREATE INDEX "notes_ab" ON "notes"("gx_b","gx_a")');
  }));

  it('an index that gained a partial predicate', () => driftRefuses((db) => {
    db.exec('DROP INDEX "notes_ab"');
    db.exec('CREATE INDEX "notes_ab" ON "notes"("gx_a","gx_b") WHERE "gx_a" IS NOT NULL');
  }));

  it('an index that became UNIQUE', () => driftRefuses((db) => {
    db.exec('DROP INDEX "notes_ab"');
    db.exec('CREATE UNIQUE INDEX "notes_ab" ON "notes"("gx_a","gx_b")');
  }));

  it('an UNDECLARED index nobody asked for', () => driftRefuses((db) => {
    db.exec('CREATE INDEX "notes_extra" ON "notes"("gx_a")');
  }));
});

describe('a relational foreign key is verified as a whole tuple', () => {
  const relational = (onDelete) => ({
    $model: '0.1',
    entities: {
      Team: {
        schema: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', 'x-entity': { key: true } } },
        },
      },
      Member: {
        schema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', 'x-entity': { key: true } },
            teamId: { type: 'string' },
            team: { 'x-entity': { relation: { to: 'Team', via: 'teamId', onDelete } } },
          },
        },
      },
    },
  });

  it("changing ON DELETE SET NULL to CASCADE is JD0002, not 'one key either way'", async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(relational('setNull'),
        { driver: nodeDriver(), path: dbPath });
      await store.close();
      // the same declaration, one action apart: the count is identical and
      // the rows a delete removes are not
      await assert.rejects(
        () => openStore(relational('cascade'), { driver: nodeDriver(), path: dbPath }),
        (error) => /** @type {any} */ (error).code === 'JD0002');
    }
    finally {
      cleanup();
    }
  });
});

describe('what is deliberately NOT drift', () => {
  it('column ORDER, because ADD COLUMN can only append', () => {
    const fresh = 'CREATE TABLE "t"("id" TEXT PRIMARY KEY,"age" INTEGER,'
      + '"doc" BLOB NOT NULL) STRICT';
    const migrated = 'CREATE TABLE "t"("id" TEXT PRIMARY KEY,"doc" BLOB NOT NULL,'
      + '"age" INTEGER) STRICT';
    assert.strictEqual(comparableDeclaredSql(fresh), comparableDeclaredSql(migrated));
  });

  it('whitespace and IF NOT EXISTS', () => {
    assert.strictEqual(
      comparableDeclaredSql('CREATE TABLE IF NOT EXISTS "t" (  "a"  TEXT )  STRICT'),
      comparableDeclaredSql('CREATE TABLE "t"("a" TEXT)STRICT'));
  });

  it('but a CHECK inside parentheses is never split apart', () => {
    const withCheck = 'CREATE TABLE "t"("a" TEXT CHECK("a" IN (\'x\',\'y\')),"b" INTEGER)';
    const swapped = 'CREATE TABLE "t"("a" TEXT CHECK("a" IN (\'y\',\'x\')),"b" INTEGER)';
    assert.notStrictEqual(comparableDeclaredSql(withCheck), comparableDeclaredSql(swapped),
      'the CHECK body is compared, not reordered');
    assert.match(comparableDeclaredSql(withCheck), /CHECK\("a" IN\('x','y'\)\)/);
  });
});
