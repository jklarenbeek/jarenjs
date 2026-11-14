//@ts-check
/**
 * @file A physical mapping's number column on PostgreSQL holds a NaN another
 * writer may store where its type holds one (`numeric`, `double precision`,
 * `real`) and no validated CHECK refuses it. The open reads the guards the
 * catalog's CHECKs hold each mapped column to, one reading for every reader,
 * and refuses nothing: the mapping answers as the engine for every row that
 * holds a number. `introspect()` reports each unguarded column with the
 * statement that guards it; once a host runs it, the next open reads the
 * column as guarded and the row is gone. Statements are unchanged.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, readSchema, explainMapping } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { postgresChecks, sqliteChecks, guardsByColumn } from '../../packages/db/src/dialects/check-read.js';
import { verifyPhysical } from '../../packages/db/src/physical.js';
import { planEntity } from '../../packages/db/src/ddl.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

/** The guards one deparsed CHECK holds its column to. @param {string} expression @param {number} [validated] */
const guardsOf = (expression, validated = 1) =>
  Object.fromEntries([...guardsByColumn(postgresChecks([{ name: 'c', expression, validated }]))].map(([column, set]) => [column, [...set]]));

describe('the guards a CHECK holds a column to, as the PostgreSQL catalog deparses it', () => {
  it('reads not-nan from the store\'s numeric spelling and the float spellings, and nothing else', () => {
    assert.deepEqual(guardsOf("(a <> 'NaN'::numeric)"), { a: ['not-nan'] });
    assert.deepEqual(guardsOf("(w <> 'NaN'::double precision)"), { w: ['not-nan'] });
    assert.deepEqual(guardsOf("(r <> 'NaN'::real)"), { r: ['not-nan'] });
    assert.deepEqual(guardsOf("(\"Odd Col\" <> 'NaN'::double precision)"), { 'Odd Col': ['not-nan'] });
    // an enum of finite numbers admits no NaN
    assert.deepEqual(guardsOf('(e = ANY (ARRAY[(1)::numeric, (5)::numeric]))'), { e: ['not-nan'] });
    for (const other of ["((y <> 'NaN'::double precision) OR (y IS NULL))", "(NOT (x = 'NaN'::double precision))",
      "(z <> ('NaN'::numeric)::double precision)", "(w <> 'Infinity'::double precision)", "(w <> 'NaN'::text)",
      "((w <> 'NaN'::double precision) AND (w > (0)::double precision))", "(t = ANY (ARRAY['a'::text, 'b'::text]))"])
      assert.deepEqual(guardsOf(other), {}, other);
    // a CHECK added NOT VALID holds nothing for the rows already there
    assert.deepEqual(guardsOf("(w <> 'NaN'::double precision)", 0), {});
  });
  it('keeps notNaN the store\'s own spelling alone, which introspect() and planColumnUpgrade() read', () => {
    const own = (/** @type {string} */ expression) => postgresChecks([{ name: 'c', expression, validated: 1 }])[0].notNaN;
    assert.equal(own("(a <> 'NaN'::numeric)"), true);
    assert.equal(own("(w <> 'NaN'::double precision)"), undefined);
    assert.equal(own("(r <> 'NaN'::real)"), undefined);
  });
  it('reads a SQLite enum of numbers as not-nan, and its other CHECKs as no guard', () => {
    const read = (/** @type {string} */ sql) => [...guardsByColumn(sqliteChecks([{ sql }]))].map(([column, set]) => [column, [...set]]);
    assert.deepEqual(read('CREATE TABLE t(e REAL CHECK (e IN (1, 5)))'), [['e', ['not-nan']]]);
    assert.deepEqual(read('CREATE TABLE t(e REAL CHECK (e > 0))'), []);
  });
  it('qualifies a column as NaN-safe by its type or its guards, and refuses none', () => {
    const dialect = postgresDialect({ searchPath: 'tenant' });
    const safe = (/** @type {string} */ codec, /** @type {string} */ type, /** @type {string[] | undefined} */ guards) => {
      const column = { name: 'c', physical: 'c', codec, null: 'reject', ...(guards === undefined ? {} : { guards }) };
      dialect.qualifyPhysicalColumn(column, { type }, 'table');
      return column.nanSafe;
    };
    assert.equal(safe('number', 'double precision', undefined), false);
    assert.equal(safe('number', 'double precision', []), false);
    assert.equal(safe('number', 'double precision', ['not-nan']), true);
    assert.equal(safe('decimal', 'numeric(30,6)', []), false);
    assert.equal(safe('decimal', 'numeric', ['not-nan']), true);
    for (const type of ['integer', 'bigint', 'smallint']) assert.equal(safe('integer', type, []), true, type);
    assert.equal(safe('text', 'text', []), true);
  });
});

describe('PostgreSQL physical number columns another writer may set to NaN', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  const model = (/** @type {string} */ schema) => ({ $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, w: { type: 'number' }, amount: { type: 'string' }, n: { type: 'integer' },
    v: { type: 'number' }, u: { type: 'number' } } },
  physical: { schema, table: 'items', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
    w: { name: 'w', codec: 'number', null: 'reject' }, amount: { name: 'amount', codec: 'decimal', null: 'reject' },
    n: { name: 'n', codec: 'integer', null: 'reject' }, v: { name: 'v', codec: 'number', null: 'reject' },
    u: { name: 'u', codec: 'number', null: 'reject' } } } } } });
  /** The guards and qualification the open records on each mapped column. @param {any} driver @param {any} doc */
  const qualified = async (driver, doc) => {
    const connection = await driver.open();
    try {
      const mapping = explainMapping(doc);
      const physical = planEntity('Item', mapping.entities.Item, mapping, connection.dialect).physical;
      await verifyPhysical(connection, physical, await readSchema(connection));
      return Object.fromEntries(physical.columns.map((/** @type {any} */ column) => [column.physical, { guards: [...column.guards], nanSafe: column.nanSafe }]));
    }
    finally { await connection.close(); }
  };
  const unguarded = async (/** @type {any} */ store) => (await store.introspect()).report
    .filter((/** @type {any} */ row) => row.code === 'unguarded-number').map((/** @type {any} */ row) => [row.object, row.sql]);

  it('opens the mapping, reads its guards, reports each unguarded column, and reads it guarded once its CHECK is added', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await pool.query(`CREATE TABLE "${schema}".items (id integer PRIMARY KEY, w double precision NOT NULL, amount numeric(30,6) NOT NULL,
        n integer NOT NULL, v double precision NOT NULL CHECK (v <> 'NaN'), u double precision NOT NULL);
        ALTER TABLE "${schema}".items ADD CONSTRAINT u_not_nan CHECK (u <> 'NaN') NOT VALID;
        INSERT INTO "${schema}".items VALUES (1, 1.5, '2.000000', 1, 1, 1), (2, 2.5, '3.000000', 2, 2, 2), (3, 3.5, '4.000000', 3, 3, 3)`);
      const doc = model(schema);
      const statement = (/** @type {string} */ column) => `ALTER TABLE "${schema}"."items" ADD CHECK ("${column}" <> 'NaN')`;
      assert.deepEqual(await qualified(driver(), doc), {
        id: { guards: [], nanSafe: true }, w: { guards: [], nanSafe: false }, amount: { guards: [], nanSafe: false },
        n: { guards: [], nanSafe: true }, v: { guards: ['not-nan'], nanSafe: true }, u: { guards: [], nanSafe: false } });
      let store = await openStore(doc, { driver: driver(), adopt: true });
      try {
        assert.deepEqual(await unguarded(store), [['items.amount', statement('amount')], ['items.u', statement('u')], ['items.w', statement('w')]]);
        // the loss: a statement that compares or orders the column without
        // returning it reads PostgreSQL's NaN, where the engine refuses the row
        await pool.query(`UPDATE "${schema}".items SET w = 'NaN' WHERE id = 2`);
        const query = [{ $for: { it: '$.Item[*]' }, $where: { $gt: ['$it.w', 2] }, $return: '$it.id' }];
        assert.equal((await store.explain(query)).mode, 'native');
        assert.deepEqual(await store.execute(query), [2, 3]);
        await assert.rejects(async () => store.execute(query, { pushdown: false }), { code: 'JD2003' });
        await assert.rejects(async () => store.execute([{ $for: { it: '$.Item[*]' }, $return: '$it.w' }]), { code: 'JD2003' });
        await pool.query(`UPDATE "${schema}".items SET w = 2.5 WHERE id = 2`);
      }
      finally { await store.close(); }
      // a host runs each statement the report names, from any session, and validates the NOT VALID one
      for (const column of ['amount', 'w']) await pool.query(statement(column));
      await pool.query(`ALTER TABLE "${schema}".items VALIDATE CONSTRAINT u_not_nan`);
      assert.deepEqual(await qualified(driver(), doc), {
        id: { guards: [], nanSafe: true }, w: { guards: ['not-nan'], nanSafe: true }, amount: { guards: ['not-nan'], nanSafe: true },
        n: { guards: [], nanSafe: true }, v: { guards: ['not-nan'], nanSafe: true }, u: { guards: ['not-nan'], nanSafe: true } });
      store = await openStore(doc, { driver: driver(), adopt: true });
      try {
        assert.deepEqual(await unguarded(store), []);
        // the row adds no refusal: an entity's table is never a complete model read (document-members)
        await assert.rejects(async () => store.introspect({ strict: true }), (/** @type {any} */ error) => error.code === 'JD0002'
          && !/unguarded-number/.test(error.message) && /document-members \(items\)/.test(error.message));
        await assert.rejects(pool.query(`UPDATE "${schema}".items SET w = 'NaN' WHERE id = 2`), (/** @type {any} */ error) => error.code === '23514');
        assert.deepEqual(await store.execute([{ $for: { it: '$.Item[*]' }, $where: { $gt: ['$it.w', 2] }, $return: '$it.id' }]), [2, 3]);
      }
      finally { await store.close(); }
    });
  });

  it('reads a CHECK as the guard of the column it names, not of the column that declares it', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await pool.query(`CREATE TABLE "${schema}".items (id integer PRIMARY KEY, w double precision, x double precision CHECK (w <> 'NaN'));
        CREATE TABLE "${schema}"."order-items" (id integer PRIMARY KEY, q numeric)`);
      const connection = await driver().open();
      try {
        const { introspectModel } = await import('@jarenjs/db');
        const rows = (await introspectModel(connection)).report.filter((/** @type {any} */ row) => row.code === 'unguarded-number')
          .map((/** @type {any} */ row) => row.object);
        // the CHECK beside x names w: it guards w, and x holds a NaN; a table no
        // model names as an entity, which a physical layout may map, is read alike
        assert.deepEqual(rows, ['items.x', 'order-items.q']);
      }
      finally { await connection.close(); }
    });
  });
});
