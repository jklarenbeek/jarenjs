//@ts-check
/**
 * @file `planColumnUpgrade` on SQLite: a table an earlier release created
 * holds the generated column of an indexed member of several types in one of
 * those types (`REAL` for `['number', 'string']`), refuses a conforming
 * document of another kind and reads the document for a comparison of that
 * kind. A plan between two models compares the models alone and plans
 * nothing for it; the upgrade reads the catalog and rebuilds exactly the
 * columns that differ from what a fresh store creates, keeping every row and
 * answer, and plans nothing once the table is current.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { compileJsonQuery } from '@jarenjs/json/query';
import { openStore, planColumnUpgrade, planMigration, migrate, sqliteDialect, planCollection, normalizeModel } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { tempDbPath } from './helpers.js';

const MODEL = { $model: '0.1', collections: { c: { key: '/id',
  schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' },
    q: { type: ['number', 'string'] }, r: { type: ['string', 'number', 'null'] }, n: { type: ['integer', 'string'] }, k: { type: 'string' } } },
  indexes: [{ name: 'by_q', path: '$.q' }, { name: 'by_r', path: '$.r' }, { name: 'by_nk', path: ['$.n', '$.k'], unique: true }] } } };

/** The table an earlier release created for MODEL: each union member's column in its first type. */
const EARLIER = [
  'CREATE TABLE "c" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL, '
  + '"gx_q" REAL GENERATED ALWAYS AS (jsonb_extract("doc", \'$."q"\')) VIRTUAL, '
  + '"gx_r" TEXT GENERATED ALWAYS AS (jsonb_extract("doc", \'$."r"\')) VIRTUAL, '
  + '"gx_n" INTEGER GENERATED ALWAYS AS (jsonb_extract("doc", \'$."n"\')) VIRTUAL, '
  + '"gx_k" TEXT GENERATED ALWAYS AS (jsonb_extract("doc", \'$."k"\')) VIRTUAL) STRICT',
  'CREATE UNIQUE INDEX "c_by_nk" ON "c" ("gx_n", "gx_k")',
  'CREATE INDEX "c_by_q" ON "c" ("gx_q")',
  'CREATE INDEX "c_by_r" ON "c" ("gx_r")',
];
const DOCS = [{ id: 'a', q: 2, r: 'x', n: 1, k: 'a' }, { id: 'b', q: 3.5, r: 'y', n: 2, k: 'a' }, { id: 'c', k: 'b' }];
const where = (/** @type {any} */ predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' });
const PREDICATES = [{ $eq: ['$it.q', 2] }, { $gt: ['$it.q', 2] }, { $eq: ['$it.q', 'b'] }, { $lt: ['$it.r', 'z'] },
  { $eq: ['$it.r', 3] }, { $ge: ['$it.n', 1] }, { $eq: ['$it.n', 'z'] }];

/** @param {string} file */
const seed = (file) => {
  const raw = new DatabaseSync(file);
  for (const sql of EARLIER) raw.exec(sql);
  for (const doc of DOCS) raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run(doc.id, JSON.stringify(doc));
  raw.close();
};
/** The declared type of each generated column. @param {string} file */
const columnTypes = (file) => {
  const raw = new DatabaseSync(file);
  try {
    return Object.fromEntries(raw.prepare("SELECT name, type FROM pragma_table_xinfo('c') WHERE name LIKE 'gx\\_%' ESCAPE '\\' ORDER BY name").all()
      .map((row) => [row.name, row.type]));
  }
  finally { raw.close(); }
};
/** @param {string} file @param {any} [model] */
const upgradeOf = async (file, model = MODEL) => {
  const connection = await nodeDriver().open(file, {});
  try { return await planColumnUpgrade(connection, model); }
  finally { await connection.close(); }
};
/** Every predicate's answer and the indexes its statement names. @param {string} file */
const answers = async (file) => {
  const store = await openStore(MODEL, { driver: nodeDriver(), path: file });
  try {
    const docs = store.collection('c');
    const out = [];
    for (const predicate of PREDICATES) {
      out.push({ ids: [await docs.execute(where(predicate))].flat().filter((id) => id !== undefined),
        indexes: (await docs.explain(where(predicate))).indexes });
    }
    return out;
  }
  finally { await store.close(); }
};
const engine = (/** @type {any} */ predicate) => [compileJsonQuery(where(predicate))(structuredClone(DOCS))].flat().filter((id) => id !== undefined);

describe('planColumnUpgrade on SQLite', () => {
  it('rebuilds each union column an earlier release typed, keeps every row and answer, and plans nothing after', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      seed(dbPath);
      // the table as it was: the conforming document of another kind is refused, the text comparison reads the document
      const before = await answers(dbPath);
      assert.deepStrictEqual(before.map((answer) => answer.ids), PREDICATES.map(engine));
      assert.deepStrictEqual(before.map((answer) => answer.indexes), [['c_by_q'], ['c_by_q'], [], ['c_by_r'], [], ['c_by_nk'], []]);
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try { await assert.rejects(store.collection('c').insert({ id: 'd', q: 'text', k: 'c' }), { code: 'JD2005' }); }
      finally { await store.close(); }
      // the models alone plan nothing for it
      assert.deepStrictEqual(planMigration(MODEL, MODEL, { dialect: sqliteDialect }).migration.steps, []);

      const { migration, report } = await upgradeOf(dbPath);
      // and the column the unique index keys a container of the untyped member by, and the index over it
      assert.deepStrictEqual(report.upgraded, ['c.gx_q', 'c.gx_r', 'c.gx_n', 'c.kx_n', 'c.c_by_nk$container']);
      assert.strictEqual(migration.from, migration.to);
      const triggers = planCollection('c', normalizeModel(MODEL).get('c'), sqliteDialect).createSql
        .filter((/** @type {string} */ sql) => sql.startsWith('CREATE TRIGGER'));
      assert.strictEqual(triggers.length, 2);
      const fill = migration.steps.find((/** @type {any} */ step) => step.sql.startsWith('UPDATE "c" SET "kx_n" = (CASE WHEN json_type("doc", \'$."n"\') IN (\'object\', \'array\')'))?.sql;
      assert.match(migration.id, /^upgrade-/);
      assert.deepStrictEqual(migration.steps.map((/** @type {any} */ step) => step.sql), [
        'DROP INDEX "c_by_nk"', 'DROP INDEX "c_by_q"', 'DROP INDEX "c_by_r"',
        'ALTER TABLE "c" DROP COLUMN "gx_q"', 'ALTER TABLE "c" DROP COLUMN "gx_r"', 'ALTER TABLE "c" DROP COLUMN "gx_n"',
        'ALTER TABLE "c" ADD COLUMN "gx_q" ANY GENERATED ALWAYS AS ((CASE WHEN json_type("doc", \'$."q"\') IN (\'integer\', \'real\') '
        + 'THEN CAST(jsonb_extract("doc", \'$."q"\') AS REAL) ELSE jsonb_extract("doc", \'$."q"\') END)) VIRTUAL',
        'ALTER TABLE "c" ADD COLUMN "gx_r" ANY GENERATED ALWAYS AS (jsonb_extract("doc", \'$."r"\')) VIRTUAL',
        'ALTER TABLE "c" ADD COLUMN "gx_n" ANY GENERATED ALWAYS AS (jsonb_extract("doc", \'$."n"\')) VIRTUAL',
        'ALTER TABLE "c" ADD COLUMN "kx_n" TEXT', ...triggers, fill,
        // the unique index keys whether its untyped member is a boolean after its columns
        'CREATE UNIQUE INDEX "c_by_nk" ON "c" ("gx_n", "gx_k", (json_type("doc", \'$."n"\') IN (\'true\', \'false\')))',
        'CREATE INDEX "c_by_q" ON "c" ("gx_q")', 'CREATE INDEX "c_by_r" ON "c" ("gx_r")',
        'CREATE UNIQUE INDEX "c_by_nk$container" ON "c" ("kx_n", "gx_k") WHERE "kx_n" IS NOT NULL',
      ]);
      assert.deepStrictEqual((await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: MODEL, model: MODEL })).applied, [migration.id]);
      assert.deepStrictEqual(columnTypes(dbPath), { gx_k: 'TEXT', gx_n: 'ANY', gx_q: 'ANY', gx_r: 'ANY' });

      // every row and answer kept; a comparison of the other kind now seeks
      const after = await answers(dbPath);
      assert.deepStrictEqual(after.map((answer) => answer.ids), before.map((answer) => answer.ids));
      assert.deepStrictEqual(after.map((answer) => answer.indexes), [['c_by_q'], ['c_by_q'], ['c_by_q'], ['c_by_r'], ['c_by_r'], ['c_by_nk'], ['c_by_nk']]);
      const upgraded = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try {
        await upgraded.collection('c').insert({ id: 'd', q: 'text', r: 4, n: 'z', k: 'c' });
        assert.deepStrictEqual(await upgraded.collection('c').execute({ $for: { it: '$[*]' }, $return: '$it' }),
          [...DOCS, { id: 'd', q: 'text', r: 4, n: 'z', k: 'c' }]);
      }
      finally { await upgraded.close(); }
      // the two-run check: the table is current
      const again = await upgradeOf(dbPath);
      assert.deepStrictEqual([again.migration.steps, again.report.upgraded], [[], []]);
    }
    finally { cleanup(); }
  });

  it('plans nothing for a table this release creates', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try { for (const doc of DOCS) await store.collection('c').insert(doc); }
      finally { await store.close(); }
      const { migration, report } = await upgradeOf(dbPath);
      assert.deepStrictEqual([migration.steps, report.upgraded], [[], []]);
    }
    finally { cleanup(); }
  });

  it('takes its link name, and refuses an empty one', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      seed(dbPath);
      const connection = await nodeDriver().open(dbPath, {});
      try {
        assert.strictEqual((await planColumnUpgrade(connection, MODEL, { id: 'retype-unions' })).migration.id, 'retype-unions');
        assert.throws(() => planColumnUpgrade(connection, MODEL, { id: '' }), { code: 'JD0013' });
      }
      finally { await connection.close(); }
    }
    finally { cleanup(); }
  });
});
