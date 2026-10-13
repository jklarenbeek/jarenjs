//@ts-check
/**
 * @file A rebuild that folds columns into the document writes the document
 * expression once per fold: the copy statement grows linearly with the
 * number of columns it folds, and a row's document comes out exactly as it
 * did when the fold repeated the expression in both branches of a `CASE`.
 * A `NULL` column leaves the document untouched (a member the document
 * already holds stays; none is added), every other column writes its JSON
 * value under its own name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { planModelMigration, migrate, openStore, sqliteDialect, createDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { MEMBER_WHEN } from '../../packages/db/src/dialect.js';
import { tempDbPath, fullDoubleDialect } from './helpers.js';

/**
 * An entity whose `count` integer columns either sit in typed columns or
 * (`json`) stay in the document, beside one text property a retype turns
 * into a number, which makes every change between the two a rebuild.
 * @param {number} count @param {boolean} json
 */
function model(count, json) {
  /** @type {Record<string, any>} */
  const properties = { id: { type: 'string', 'x-entity': { key: true } } };
  for (let i = 0; i < count; i++) {
    properties[`c${i}`] = json ? { type: 'integer', 'x-entity': { column: 'json' } } : { type: 'integer' };
  }
  properties.r = { type: json ? 'string' : 'integer' };
  return { $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties } } } };
}

/** The statement the rebuild copies with. @param {number} count */
function copyOf(count) {
  const plan = planModelMigration(model(count, false), model(count, true), { dialect: sqliteDialect, id: 'fold' });
  const rebuild = plan.migration.steps.find((/** @type {any} */ step) => step.kind === 'rebuild');
  assert.ok(rebuild, 'the change is a rebuild');
  return /** @type {string} */ (rebuild.copy);
}

describe('the copy statement of a rebuild that folds columns', () => {
  it('grows linearly with the columns it folds', () => {
    const small = copyOf(8), large = copyOf(16);
    // doubling the columns doubled the statement, not squared it
    assert.ok(large.length < 3 * small.length, `${small.length} -> ${large.length}`);
    assert.ok(large.length < 20000, `${large.length}`);
  });

  it('names the document once however many columns it folds', () => {
    for (const count of [1, 8, 16]) {
      const selected = copyOf(count).split(' SELECT ')[1];
      assert.equal(selected.split('"doc"').length - 1, 1, `${count} columns`);
    }
  });
});

describe('the document a fold rebuild writes', () => {
  /** @param {number} id @param {Record<string, any>} values */
  const row = (id, values) => ({ id: String(id), ...values });

  it('folds each non-NULL column under its name and leaves a NULL one alone', async () => {
    const from = {
      $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } },
        i: { type: 'integer' }, n: { type: 'number' }, s: { type: 'string' }, b: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } }, r: { type: 'integer' },
      } } } },
    };
    const to = structuredClone(from);
    for (const name of ['i', 'n', 's', 'b']) /** @type {any} */ (to).entities.T.schema.properties[name]['x-entity'] = { column: 'json' };
    /** @type {any} */ (to).entities.T.schema.properties.r = { type: 'string' };
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(from, { driver: nodeDriver(), path: dbPath });
      await store.entity('T').create(row(1, { i: 1, n: 81.125, s: 'a"b', b: true, tags: ['x'], r: 5 }));
      await store.entity('T').create(row(2, { b: false, r: 6 }));
      await store.entity('T').create(row(3, {}));
      await store.entity('T').create(row(4, { s: '', tags: [], r: 7 }));
      await store.entity('T').create(row(5, { n: 0, i: -3, b: true, r: 8 }));
      await store.close();
      // a document that already holds a member of a column that is NULL keeps it
      const raw = new DatabaseSync(dbPath);
      raw.exec(`UPDATE "T" SET "doc" = jsonb_set("doc", '$.n', 99) WHERE "id" = '3'`);
      raw.close();
      const { migration } = planModelMigration(from, to, { dialect: sqliteDialect, id: 'fold-values' });
      migration.steps = migration.steps.filter((/** @type {any} */ step) => !(step.kind === 'jslt' && step.draft));
      assert.ok(migration.steps.some((/** @type {any} */ step) => step.kind === 'rebuild'));
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: from, model: to });
      const migrated = new DatabaseSync(dbPath);
      // the document's own text, so the order of its members is pinned too
      const docs = migrated.prepare(`SELECT "id", json("doc") AS doc FROM "T" ORDER BY "id"`).all()
        .map((/** @type {any} */ found) => [found.id, found.doc]);
      migrated.close();
      assert.deepEqual(docs, [
        ['1', '{"tags":["x"],"i":1,"n":81.125,"s":"a\\"b","b":true}'],
        ['2', '{"b":false}'],
        ['3', '{"n":99}'],
        ['4', '{"tags":[],"s":""}'],
        ['5', '{"i":-3,"n":0.0,"b":true}'],
      ]);
    } finally { cleanup(); }
  });
});

describe('a member whose name holds a double quote', () => {
  it('folds into the document where SQLite can spell no path to it', async () => {
    const name = 'q"x';
    const at = (/** @type {boolean} */ json) => ({
      $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } },
        [name]: json ? { type: 'integer', 'x-entity': { column: 'json' } } : { type: 'integer' },
        r: { type: json ? 'string' : 'integer' },
      } } } },
    });
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(at(false), { driver: nodeDriver(), path: dbPath });
      await store.entity('T').create({ id: '1', [name]: 7, r: 1 });
      await store.entity('T').create({ id: '2', r: 2 });
      await store.close();
      const { migration } = planModelMigration(at(false), at(true), { dialect: sqliteDialect, id: 'quoted' });
      migration.steps = migration.steps.filter((/** @type {any} */ step) => !(step.kind === 'jslt' && step.draft));
      assert.ok(migration.steps.some((/** @type {any} */ step) => step.kind === 'rebuild'));
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: at(false), model: at(true) });
      const migrated = new DatabaseSync(dbPath);
      const docs = migrated.prepare(`SELECT "id", json("doc") AS doc FROM "T" ORDER BY "id"`).all()
        .map((/** @type {any} */ found) => [found.id, found.doc]);
      migrated.close();
      assert.deepEqual(docs, [['1', '{"q\\"x":7}'], ['2', '{}']]);
    } finally { cleanup(); }
  });
});

describe('the conditional member write each built-in dialect keeps to itself', () => {
  const when = ['"doc"', 'a', "jsonb('1')", '"a" IS NOT NULL'];

  it('names the document once on SQLite', () => {
    assert.equal(sqliteDialect[MEMBER_WHEN](...when),
      `jsonb_patch("doc", CASE WHEN "a" IS NOT NULL `
      + `THEN json_object('a', jsonb('1')) ELSE '{}' END)`);
  });

  it('names the document once on PostgreSQL', () => {
    assert.equal(postgresDialect({ schema: 's' })[MEMBER_WHEN](...when),
      `("doc" || CASE WHEN "a" IS NOT NULL `
      + `THEN jsonb_build_object('a', jsonb('1')) ELSE '{}'::jsonb END)`);
  });

  it('is on no dialect built from a spec, and not on the package\'s public surface', async () => {
    assert.equal(fullDoubleDialect(createDialect)[MEMBER_WHEN], undefined);
    const surface = await import('@jarenjs/db');
    assert.ok(!Object.values(surface).includes(MEMBER_WHEN));
    assert.ok(!('jsonSetMemberWhen' in sqliteDialect));
    assert.deepEqual(Object.getOwnPropertySymbols(sqliteDialect), [MEMBER_WHEN]);
  });

  it('is replaced by the document in both branches of a CASE where a dialect has none', () => {
    const without = Object.create(sqliteDialect, { [MEMBER_WHEN]: { value: undefined } });
    const plan = planModelMigration(model(8, false), model(8, true), { dialect: without, id: 'fold' });
    const copy = plan.migration.steps.find((/** @type {any} */ step) => step.kind === 'rebuild').copy;
    assert.match(copy, /CASE WHEN "c7" IS NULL THEN CASE WHEN "c6" IS NULL THEN /);
    assert.ok(!copy.includes('jsonb_patch'));
    assert.ok(copy.includes('jsonb_set("doc", \'$."c0"\', "c0")'));
  });
});
