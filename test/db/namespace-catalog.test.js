//@ts-check
/**
 * @file The one read of each catalog an open or a migration takes over the
 * tables it verifies answers, for every table and index it covers, exactly
 * the rows the dialect's per-table statement answers, in that statement's
 * order: on SQLite and on the PostgreSQL server `JAREN_PG_URL` names, over
 * tables with composite and expression and partial indexes, foreign keys,
 * CHECKs and generated columns. A table it does not cover — one it was not
 * asked for, one it did not find, one created after it read, a virtual
 * table — reads its own.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { nodeDriver } from '@jarenjs/db/node';

import { catalogRows, withNamespaceCatalog } from '../../packages/db/src/namespace-catalog.js';
import { tempDbPath } from './helpers.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const TABLE_KINDS = ['tableExists', 'columns', 'indexes', 'generated', 'checks', 'foreignKeyList', 'declaredSql'];
const INDEX_KINDS = ['indexColumns', 'indexKeyColumns'];

/**
 * Every covered answer equals the per-table one, and the shared read took
 * one statement per catalog, whatever the number of tables.
 * @param {any} connection @param {string[]} tables @param {string[]} absent - names asked for that no table holds: they do not exist
 */
async function compare(connection, tables, absent) {
  const statements = /** @type {string[]} */ ([]);
  const noted = { ...connection, prepare: (/** @type {string} */ sql, /** @type {any} */ metadata) => {
    statements.push(sql); return connection.prepare(sql, metadata);
  } };
  const reading = withNamespaceCatalog(noted, [...tables, ...absent]);
  const introspect = connection.dialect.introspect;
  let compared = 0;
  for (const table of tables) {
    for (const kind of TABLE_KINDS) {
      if (introspect[kind] === undefined) continue;
      assert.deepStrictEqual(await catalogRows(reading, kind, table), await catalogRows(connection, kind, table), `${kind} of ${table}`);
      compared++;
    }
    for (const { name } of await catalogRows(connection, 'indexes', table)) {
      for (const kind of INDEX_KINDS) {
        if (introspect[kind] === undefined) continue;
        assert.deepStrictEqual(await catalogRows(reading, kind, String(name)), await catalogRows(connection, kind, String(name)), `${kind} of ${name}`);
        compared++;
      }
    }
  }
  const shared = statements.filter((sql) => sql.includes('jaren_owner'));
  const kinds = [...TABLE_KINDS, ...INDEX_KINDS].filter((kind) => introspect.namespace?.[kind] !== undefined && introspect[kind] !== undefined);
  assert.strictEqual(shared.length, kinds.length);
  // nothing the shared read covers was read on its own
  assert.deepStrictEqual(statements.filter((sql) => !sql.includes('jaren_owner')), []);
  // a table the read did not find is probed on its own, as late as the pass asks
  for (const table of absent) assert.deepStrictEqual(await catalogRows(reading, 'tableExists', table), []);
  assert.deepStrictEqual(statements.filter((sql) => !sql.includes('jaren_owner')), absent.map(() => introspect.tableExists()));
  return compared;
}

describe('the shared catalog read on SQLite', () => {
  it('answers each table and index as its per-table statement does, one statement per catalog', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'x', n REAL CHECK (n > 0),
          doc TEXT, g TEXT GENERATED ALWAYS AS (json_extract(doc, '$.g')) VIRTUAL, UNIQUE (name, n));
        CREATE INDEX a_g ON a (g) WHERE g IS NOT NULL;
        CREATE INDEX a_expr ON a (lower(name), id DESC);
        CREATE TABLE b (x TEXT, y INTEGER, z INTEGER REFERENCES a(id) ON DELETE CASCADE,
          PRIMARY KEY (x, y), FOREIGN KEY (y, x) REFERENCES b2(q, p) ON UPDATE SET NULL) WITHOUT ROWID;
        CREATE TABLE b2 (p TEXT, q INTEGER, PRIMARY KEY (p, q));
        CREATE TABLE "odd ""name""" (k TEXT PRIMARY KEY);
        CREATE INDEX "odd idx" ON "odd ""name""" (k COLLATE NOCASE);`);
      db.close();
      const connection = await nodeDriver().open(dbPath, {});
      try {
        const compared = await compare(connection, ['a', 'b', 'b2', 'odd "name"'], ['missing']);
        assert.ok(compared > 30, `${compared} answers compared`);
      }
      finally { connection.close(); }
    }
    finally { cleanup(); }
  });

  it('a table it was not asked for, one created after it read, and a virtual table read their own', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE other (id INTEGER PRIMARY KEY); CREATE VIRTUAL TABLE v USING fts5(body);");
      db.close();
      const connection = await nodeDriver().open(dbPath, {});
      try {
        const reading = withNamespaceCatalog(connection, ['a', 'late', 'v']);
        assert.deepStrictEqual(await catalogRows(reading, 'tableExists', 'late'), []);
        connection.exec('CREATE TABLE late (id INTEGER PRIMARY KEY, extra TEXT)');
        // a table the read did not find is probed again: it exists now
        assert.deepStrictEqual((await catalogRows(reading, 'tableExists', 'late')).map((/** @type {any} */ row) => row.name), ['late']);
        // the shared read was made before `late` existed: its columns are its own read
        assert.deepStrictEqual((await catalogRows(reading, 'columns', 'late')).map((/** @type {any} */ row) => row.name), ['id', 'extra']);
        assert.deepStrictEqual((await catalogRows(reading, 'columns', 'other')).map((/** @type {any} */ row) => row.name), ['id']);
        assert.deepStrictEqual(await catalogRows(reading, 'columns', 'v'), await catalogRows(connection, 'columns', 'v'));
        assert.deepStrictEqual((await catalogRows(reading, 'tableExists', 'v')).map((/** @type {any} */ row) => row.name), ['v']);
        assert.strictEqual(withNamespaceCatalog(connection, []), connection);
      }
      finally { connection.close(); }
    }
    finally { cleanup(); }
  });
});

describe('the shared catalog read on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('answers each table and index as its per-table statement does, one statement per catalog', () => withPostgres(async ({ pool, schema, driver }) => {
    await pool.query(`SET search_path TO "${schema}";
      CREATE TABLE a (id integer PRIMARY KEY, name text NOT NULL DEFAULT 'x' COLLATE "C", n numeric CHECK (n > 0),
        doc jsonb, g text GENERATED ALWAYS AS (doc ->> 'g') STORED, k bigint GENERATED BY DEFAULT AS IDENTITY, UNIQUE NULLS NOT DISTINCT (name, n));
      ALTER TABLE a ADD CONSTRAINT a_late CHECK (id < 100) NOT VALID;
      CREATE INDEX a_g ON a (g) WHERE g IS NOT NULL;
      CREATE INDEX a_expr ON a (lower(name), id DESC) INCLUDE (n);
      CREATE TABLE b2 (p text, q integer, PRIMARY KEY (p, q));
      CREATE TABLE b (x text, y integer, z integer REFERENCES a(id) ON DELETE CASCADE,
        PRIMARY KEY (x, y), FOREIGN KEY (x, y) REFERENCES b2(p, q) ON UPDATE SET NULL);
      CREATE TABLE "odd ""name""" (k text PRIMARY KEY);
      CREATE TABLE parts (id integer, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
      CREATE TABLE parts_2026 PARTITION OF parts FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`);
    const connection = await driver().open();
    try {
      const compared = await compare(connection, ['a', 'b', 'b2', 'odd "name"', 'parts', 'parts_2026'], ['missing']);
      assert.ok(compared > 40, `${compared} answers compared`);
    }
    finally { await connection.close(); }
  }));
});
