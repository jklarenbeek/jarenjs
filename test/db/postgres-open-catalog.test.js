//@ts-check
/**
 * @file An open of physical entities on PostgreSQL reads its namespace's
 * catalog once for all of them, and each mapped table's own catalog rows
 * once: its statements grow with the entities, not with entities × tables.
 * Runs against the server `JAREN_PG_URL` names, in a schema of its own.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';

import { PG_URL, withPostgres } from './store-core-engines.js';

/** A model mapping `count` physical entities over `t0…`. @param {number} count */
const physicalModel = (count) => ({ $model: '0.1', entities: Object.fromEntries(Array.from({ length: count }, (_, i) => [`E${i}`, {
  schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, name: { type: 'string' }, ref: { type: ['integer', 'null'] } } },
  physical: { table: `t${i}`, columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, name: { name: 'name', codec: 'text', null: 'reject' },
    ref: { name: 'ref', codec: 'integer', null: 'null' } },
  indexes: [{ name: `t${i}_name`, terms: [{ by: { $sql: 'column', name: 'name' } }] }] } }])) });

describe('a PostgreSQL open reads the catalog once for its physical entities', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  /** The catalog statements an open of `entities` physical entities over `tables` tables runs. @param {number} entities @param {number} tables */
  const reads = (entities, tables) => withPostgres(async ({ pool, schema, driver }) => {
    let ddl = '';
    for (let i = 0; i < tables; i++) {
      ddl += `CREATE TABLE "${schema}".t${i} (id integer PRIMARY KEY, name text NOT NULL, ref integer${i > 0 ? ` REFERENCES "${schema}".t${i - 1}(id)` : ''});`
        + `CREATE INDEX t${i}_name ON "${schema}".t${i} (name); INSERT INTO "${schema}".t${i} VALUES (1, 'a', ${i > 0 ? 1 : 'NULL'});`;
    }
    await pool.query(ddl);
    const statements = /** @type {string[]} */ ([]);
    let dialect = /** @type {any} */ (null);
    const base = driver();
    const counting = { ...base, open: async (/** @type {any[]} */ ...args) => {
      const connection = await base.open(...args);
      dialect = connection.dialect;
      return { ...connection,
        exec: (/** @type {string} */ sql) => { statements.push(sql); return connection.exec(sql); },
        prepare: (/** @type {string} */ sql, /** @type {any} */ metadata) => { statements.push(sql); return connection.prepare(sql, metadata); } };
    } };
    const store = await openStore(physicalModel(entities), { driver: counting });
    try {
      const opened = statements.length;
      for (let i = 0; i < entities; i++) assert.strictEqual((await store.entity(`E${i}`).get(1))?.name, 'a');
      const columns = new Set(Array.from({ length: tables }, (_, i) => dialect.introspect.columns(`t${i}`)));
      const indexes = new Set(Array.from({ length: tables }, (_, i) => dialect.introspect.indexes(`t${i}`)));
      const during = statements.slice(0, opened);
      return {
        tableLists: during.filter((sql) => sql === dialect.introspect.tables()).length,
        columnReads: during.filter((sql) => columns.has(sql)).length,
        indexLists: during.filter((sql) => indexes.has(sql)).length,
        total: opened,
      };
    }
    finally { await store.close(); }
  });

  it('3 physical entities over 12 tables: one table list, each mapped table read once, as many statements as over 3 tables', async () => {
    const wide = await reads(3, 12);
    const narrow = await reads(3, 3);
    assert.deepStrictEqual({ ...wide, total: wide.total - narrow.total }, { tableLists: 1, columnReads: 3, indexLists: 3, total: 0 });
  });

  it('a mapped table a rival commits after the open read the catalog is verified by a read of its own, and opens', () =>
    withPostgres(async ({ pool, schema, driver }) => {
      await pool.query(`CREATE TABLE "${schema}".t0 (id integer PRIMARY KEY, name text NOT NULL, ref integer);`
        + `CREATE INDEX t0_name ON "${schema}".t0 (name); INSERT INTO "${schema}".t0 VALUES (1, 'a', NULL)`);
      const rival = `CREATE TABLE "${schema}".t1 (id integer PRIMARY KEY, name text NOT NULL, ref integer REFERENCES "${schema}".t0(id));`
        + `CREATE INDEX t1_name ON "${schema}".t1 (name); INSERT INTO "${schema}".t1 VALUES (1, 'b', 1)`;
      let raced = 0;
      const base = driver();
      // the rival commits t1 once the open's read of the namespace catalog has its rows
      const racing = { ...base, open: async (/** @type {any[]} */ ...args) => {
        const connection = await base.open(...args);
        const whole = connection.dialect.introspect.catalog();
        return { ...connection, prepare: async (/** @type {string} */ sql, /** @type {any} */ metadata) => {
          const statement = await connection.prepare(sql, metadata);
          if (sql !== whole || raced > 0) return statement;
          return { ...statement, all: async (/** @type {any[]} */ params) => {
            const rows = await statement.all(params);
            raced++;
            await pool.query(rival);
            return rows;
          } };
        } };
      } };
      const store = await openStore(physicalModel(2), { driver: racing });
      try {
        assert.deepStrictEqual([raced, (await store.entity('E1').get(1))?.name], [1, 'b']);
      }
      finally { await store.close(); }
    }));
});
