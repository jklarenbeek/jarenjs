//@ts-check
/**
 * `introspect()` reads a collection's conditional index back as the
 * entity's is read: its condition into the query grammar over the members
 * a condition may read, held by the index exactly as the open compares it,
 * with the indexes beside it (another kind of a member on PostgreSQL, a
 * container key on SQLite). The oracle is a reopen of the model read back
 * over the same database, on both engines; a condition it cannot read back
 * exactly stays an `unmapped-index` row.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openStore, introspectModel, planMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';

import { PG_URL, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const INDEXES = [
  { name: 'a_eq', path: ['$.a', '$.n'], where: { $eq: ['$.s', 'x'] } },
  { name: 'by_s', path: '$.s' },
  { name: 'c_one', path: '$.c', unique: true, where: { $exists: '$.s' } },
  { name: 'n_pos', path: '$.n', where: { $gt: ['$.n', 3] } },
  { name: 'one_a', path: '$.a', unique: true, where: { $exists: '$.s' } },
  { name: 'u_one', path: '$.u', unique: true, where: { $eq: ['$.s', 'x'] } },
];
const MODEL = { $model: '0.1', collections: { docs: { key: null, identity: 'integer',
  schema: { type: 'object', properties: { a: { type: 'string' }, s: { type: 'string' }, n: { type: 'number' },
    u: { type: ['string', 'integer'] }, c: { type: ['object', 'string'] } } }, indexes: INDEXES } } };

/** The losses of a report, by code and object. @param {any[]} report */
const lossesOf = (report) => report.map((row) => `${row.code}:${row.object}`).sort();
/** @param {any} from @param {any} to @param {any} dialect */
const ddlOf = (from, to, dialect) => planMigration(from, to, { dialect }).migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl');

/**
 * The model read back opens the database it was read from and enforces each
 * condition: a duplicate under it is refused, one outside it is kept.
 * @param {any} store
 */
async function enforcesConditions(store) {
  const docs = store.collection('docs');
  await docs.insert({ a: 'k', s: 'y', u: 1, c: { p: 1 } });
  await assert.rejects(docs.insert({ a: 'k', s: 'z' }), (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint');
  await docs.insert({ a: 'k' });
  await docs.insert({ a: 'k' });
  await assert.rejects(docs.insert({ s: 'w', c: { p: 1 } }), (/** @type {any} */ error) => error.code === 'JD2005');
  await docs.insert({ c: { p: 1 } });
  await docs.insert({ s: 'x', u: 1 });
  await assert.rejects(docs.insert({ s: 'x', u: 1 }), (/** @type {any} */ error) => error.code === 'JD2005');
  await docs.insert({ s: 'x', u: '1' });
  assert.equal((await docs.all()).length, 6);
}

describe('introspect() of a collection conditional index on SQLite', () => {
  it('reads each condition back exactly, with the container keys beside a unique one, and the model read back reopens the table', async () => {
    const { dbPath: path, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path });
      const { model: derived, report } = await store.introspect();
      await store.close();
      assert.deepEqual(derived.collections.docs.indexes, INDEXES);
      assert.deepEqual(lossesOf(report).filter((row) => row.startsWith('unmapped-index')), []);
      // the union member reads back untyped (its `unmapped-type` row), which plans its own column back;
      // the model read back plans no index of the authored model's anew
      assert.deepEqual(ddlOf(derived, MODEL, sqliteDialect), []);
      const reopened = await openStore(derived, { driver: nodeDriver(), path });
      try { await enforcesConditions(reopened); }
      finally { await reopened.close(); }
    }
    finally { cleanup(); }
  });

  it('keeps a condition it does not read back exactly an unmapped-index row, never a condition the index does not hold', async () => {
    const { dbPath: path, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path });
      await store.close();
      const db = new DatabaseSync(path);
      try {
        db.exec('DROP INDEX "docs_n_pos"; CREATE INDEX "docs_n_pos" ON "docs" ("gx_n") WHERE "gx_n" > 3.0');
        db.exec('DROP INDEX "docs_a_eq"; CREATE INDEX "docs_a_eq" ON "docs" ("gx_a", "gx_n") WHERE "gx_s" = \'x\' COLLATE NOCASE');
        db.exec('CREATE INDEX "docs_by_u" ON "docs" ("gx_s") WHERE "gx_u" = \'x\'');
      }
      finally { db.close(); }
      const connection = await nodeDriver().open(path);
      try {
        const { model: derived, report } = await introspectModel(connection);
        assert.deepEqual(derived.collections.docs.indexes.map((/** @type {any} */ index) => index.name), ['by_s', 'c_one', 'one_a', 'u_one']);
        assert.deepEqual(lossesOf(report).filter((row) => row.startsWith('unmapped-index')),
          ['unmapped-index:docs.docs_a_eq', 'unmapped-index:docs.docs_by_u', 'unmapped-index:docs.docs_n_pos']);
      }
      finally { await connection.close(); }
    }
    finally { cleanup(); }
  });
});

describe('introspect() of a collection conditional index on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('reads each condition back exactly, with the indexes beside a unique one, and the model read back reopens the table', () => withPostgres(async (context) => {
    const store = await openStore(MODEL, { driver: context.driver() });
    const { model: derived, report } = await store.introspect();
    await store.close();
    assert.deepEqual(derived.collections.docs.indexes, INDEXES);
    assert.deepEqual(lossesOf(report).filter((row) => row.startsWith('unmapped-index')), []);
    const dialect = postgresDialect();
    assert.deepEqual([ddlOf(MODEL, derived, dialect), ddlOf(derived, MODEL, dialect)], [[], []]);
    const reopened = await openStore(derived, { driver: context.driver() });
    try { await enforcesConditions(reopened); }
    finally { await reopened.close(); }
  }));

  it('keeps a condition it does not read back an unmapped-index row', () => withPostgres(async (context) => {
    const store = await openStore(MODEL, { driver: context.driver() });
    await store.close();
    await context.pool.query(`SET search_path TO "${context.schema}"`);
    await context.pool.query('DROP INDEX "docs_n_pos"');
    await context.pool.query('CREATE INDEX "docs_n_pos" ON "docs" ("gx_n") WHERE ("gx_s" || \'a\') = \'xa\'');
    await context.pool.query('CREATE INDEX "docs_by_u" ON "docs" ("gx_s") WHERE "gx_u" = \'x\'');
    const connection = await context.driver().open();
    try {
      const { model: derived, report } = await introspectModel(connection);
      assert.deepEqual(derived.collections.docs.indexes.map((/** @type {any} */ index) => index.name), ['a_eq', 'by_s', 'c_one', 'one_a', 'u_one']);
      assert.deepEqual(lossesOf(report).filter((row) => row.startsWith('unmapped-index')),
        ['unmapped-index:docs.docs_by_u', 'unmapped-index:docs.docs_n_pos']);
    }
    finally { await connection.close(); }
  }));
});
