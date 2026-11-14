//@ts-check
/**
 * @file `introspect()` of a PostgreSQL member whose union lists a container
 * first. Its `jsonb` column holds every kind, and beside an index over that
 * member alone stands one index per scalar kind the union lists
 * (`c_by_q$text`), each over the read of the member at that kind. Those
 * indexes are read back as the member's kinds: the member is typed
 * `['object', 'array', ...the scalar kinds, 'null']`, since which container
 * comes first and whether the union lists `null` leave no trace in the
 * catalog, and that union plans the same column and indexes, so the model
 * read back reopens the table, on a table this release creates and on one an
 * earlier release created alike. A path read unguarded through the member
 * by an index says its container is an array: `object` is then left out. A
 * member that a composite keys has no index beside for its kinds and is read
 * back untyped, as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, introspectModel, planCollection, planMigration, normalizeModel } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';

import { PG_URL, withPostgres } from './store-core-engines.js';

const dialect = postgresDialect();
/** @param {Record<string, any>} properties @param {any[]} indexes */
const modelOf = (properties, indexes) => ({ $model: '0.1', collections: { c: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, k: { type: 'string' }, ...properties } }, indexes } } });
/** Each declared union, and the union read back from its table. */
const UNIONS = /** @type {[string[], string[]][]} */ ([
  [['object', 'string'], ['object', 'array', 'string', 'null']],
  [['object', 'string', 'null'], ['object', 'array', 'string', 'null']],
  [['array', 'number'], ['object', 'array', 'number', 'null']],
  [['object', 'string', 'number'], ['object', 'array', 'string', 'number', 'null']],
  [['null', 'array', 'boolean', 'integer'], ['object', 'array', 'number', 'boolean', 'null']],
]);
const SHAPES = {
  unique: [{ name: 'by_q', path: '$.q', unique: true }],
  plain: [{ name: 'by_q', path: '$.q' }],
  two: [{ name: 'by_q', path: '$.q', unique: true }, { name: 'by_q2', path: '$.q' }],
};
/** @param {any} model */
const planOf = (model) => planCollection('c', normalizeModel(model).get('c'), dialect);
/** The read of `q`, and the column over it: a JSON `null` as SQL NULL, and as an earlier release kept it. */
const AT = `("doc" #> '{"q"}')`;
const NULL_FREE = `(CASE WHEN jsonb_typeof(${AT}) <> 'null' THEN ${AT} END)`;
/** The statements a table is created with: this release's, or an earlier release's. @param {any} model @param {boolean} earlier */
const tableSql = (model, earlier) => planOf(model).createSql.map((/** @type {string} */ sql) => (earlier ? sql.replaceAll(NULL_FREE, AT) : sql));
/** @param {any} from @param {any} to */
const ddlOf = (from, to) => planMigration(from, to, { dialect }).migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl');
/** @param {any} context @param {string[]} statements */
const create = async (context, statements) => {
  await context.pool.query(`SET search_path TO "${context.schema}"`);
  for (const sql of statements) await context.pool.query(sql);
};
/** @param {any} context */
const introspected = async (context) => {
  const connection = await context.driver().open();
  try { return await introspectModel(connection, { keys: { c: '/id' } }); }
  finally { await connection.close(); }
};
/** @param {any} report */
const lossesOf = (report) => report.map((/** @type {any} */ row) => `${row.code}:${row.object}`);
/** One document per kind a union admits. @param {string[]} union */
const documentsOf = (union) => [{ id: 'a', k: 'x', q: 's' }, { id: 'b', k: 'x', q: 2 }, { id: 'c', k: 'x', q: true }, { id: 'd', k: 'x', q: { a: 1 } },
  { id: 'e', k: 'x', q: [1] }, { id: 'f', k: 'x', q: null }, { id: 'g', k: 'x' }].filter(({ q }) => q === undefined
  || union.includes(q === null ? 'null' : Array.isArray(q) ? 'array' : typeof q === 'number' ? 'number' : typeof q)
  || typeof q === 'number' && union.includes('integer'));

describe('a member whose union lists a container first, read back', () => {
  it('is typed with both containers, its scalar kinds and null, which plans the same column and indexes as the union it stands for', () => {
    for (const [declared, read] of UNIONS) {
      for (const indexes of Object.values(SHAPES)) {
        const statements = (/** @type {any} */ type) => [...planOf(modelOf({ q: { type } }, indexes)).createSql].sort();
        assert.deepEqual(statements(read), statements(declared), JSON.stringify(declared));
      }
    }
  });
});

describe('introspect() of a PostgreSQL member whose union lists a container first', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  for (const [declared, read] of UNIONS) {
    for (const [shape, indexes] of Object.entries(SHAPES)) {
      for (const earlier of [false, true]) {
        it(`reads the kinds of the indexes beside back, so the model read back reopens the table (${JSON.stringify(declared)}, ${shape}${earlier ? ', a table an earlier release created' : ''})`, () => withPostgres(async (context) => {
          const model = modelOf({ q: { type: declared } }, indexes);
          await create(context, tableSql(model, earlier));
          const documents = documentsOf(declared);
          const store = await openStore(model, { driver: context.driver() });
          try { for (const document of documents) await store.collection('c').insert(document); }
          finally { await store.close(); }
          const { model: derived, report } = await introspected(context);
          assert.deepEqual(derived.collections.c.schema.properties.q, { type: read });
          assert.deepEqual(derived.collections.c.indexes, indexes);
          assert.deepEqual(lossesOf(report), ['document-members:c', 'unmapped-type:c.gx_q']);
          // the model read back opens the table, rewrites every document it holds, and plans no index
          const reopened = await openStore(derived, { driver: context.driver() });
          try {
            for (const document of documents) await reopened.collection('c').put(document);
            assert.deepEqual((await reopened.collection('c').all()).map((/** @type {any} */ document) => document.id), documents.map(({ id }) => id));
          }
          finally { await reopened.close(); }
          assert.deepEqual([ddlOf(model, derived), ddlOf(derived, model)], [[], []]);
        }));
      }
    }
  }

  it('says in its loss row which kinds it read and that the container and null are not recorded', () => withPostgres(async (context) => {
    await create(context, tableSql(modelOf({ q: { type: ['object', 'string', 'number'] } }, SHAPES.unique), false));
    const { report } = await introspected(context);
    assert.deepEqual(report.find((/** @type {any} */ row) => row.code === 'unmapped-type')?.detail, 'the column type \'jsonb\' maps back to no schema type, '
      + 'and the indexes beside its index key the member\'s ["string","number"] as those of a union that lists a container first, '
      + 'whose container and whether it lists null are not recorded, so the member is typed ["object","array","string","number","null"]');
  }));

  it('reads a member under a guarded path step back so', () => withPostgres(async (context) => {
    const model = modelOf({ u: { prefixItems: [{ type: ['object', 'string'] }] } }, [{ name: 'by_u', path: '$.u[0]', unique: true }]);
    await create(context, tableSql(model, false));
    const { model: derived, report } = await introspected(context);
    assert.deepEqual(derived.collections.c.schema.properties.u, { prefixItems: [{ type: ['object', 'array', 'string', 'null'] }] });
    assert.deepEqual(lossesOf(report), ['document-members:c', 'unmapped-type:c.gx_u_0']);
    await (await openStore(derived, { driver: context.driver() })).close();
    assert.deepEqual(ddlOf(derived, model), []);
  }));

  it('lists no object where a path read unguarded steps into the member by an index, and both containers beside a guarded one or a name step', () => withPostgres(async (context) => {
    for (const [q, sub, read, detail, losses = []] of /** @type {[any, any, string[], string, string[]?][]} */ ([
      [{ type: ['array', 'number'], prefixItems: [{ type: 'string' }] }, { name: 'by_q0', path: '$.q[0]' }, ['array', 'number', 'null'],
        'an array, as a path read unguarded through it by an index says, and whether it lists null is not recorded'],
      [{ type: ['object', 'string'], properties: { a: { type: 'string' } } }, { name: 'by_qa', path: '$.q.a' }, ['object', 'array', 'string', 'null'],
        'whose container and whether it lists null are not recorded'],
      // an index step into a union that lists `object` reads under the guard; the element it
      // reads is read back untyped
      [{ type: ['object', 'string'], prefixItems: [{}] }, { name: 'by_q0', path: '$.q[0]' }, ['object', 'array', 'string', 'null'],
        'whose container and whether it lists null are not recorded', ['unmapped-type:c.gx_q_0']],
    ])) {
      const model = modelOf({ q }, [...SHAPES.unique, sub]);
      await create(context, tableSql(model, false));
      const { model: derived, report } = await introspected(context);
      const { type: _declared, ...rest } = q;
      assert.deepEqual(derived.collections.c.schema.properties.q, { type: read, ...rest });
      assert.ok(report.find((/** @type {any} */ row) => row.object === 'c.gx_q')?.detail.includes(`a container first, ${detail}, so the member is typed`));
      assert.deepEqual(lossesOf(report), ['document-members:c', 'unmapped-type:c.gx_q', ...losses]);
      assert.deepEqual([...planOf(derived).createSql].sort(), [...planOf(model).createSql].sort());
      await (await openStore(derived, { driver: context.driver() })).close();
      await context.pool.query(`SET search_path TO "${context.schema}"; DROP TABLE c`);
    }
  }));

  it('leaves a member a composite keys untyped, as before, and reopens', () => withPostgres(async (context) => {
    for (const k of [{ type: 'string' }, { type: ['string', 'number'] }]) {
      const model = modelOf({ q: { type: ['object', 'string'] }, k }, [{ name: 'by_qk', path: ['$.q', '$.k'], unique: true }]);
      await create(context, tableSql(model, false));
      const { model: derived, report } = await introspected(context);
      assert.deepEqual([derived.collections.c.schema.properties.q, derived.collections.c.schema.properties.k], [{}, k]);
      assert.deepEqual(report.find((/** @type {any} */ row) => row.code === 'unmapped-type')?.detail,
        'the column type \'jsonb\' maps back to no schema type, so the member is left untyped');
      assert.deepEqual(lossesOf(report).filter((row) => row.includes('$')), []);
      await (await openStore(derived, { driver: context.driver() })).close();
      await context.pool.query(`SET search_path TO "${context.schema}"; DROP TABLE c`);
    }
  }));

  it('reads no container kind beside an untyped member, nor a kind of an untyped member a composite keys, and reports either index', () => withPostgres(async (context) => {
    for (const [indexes, sql] of /** @type {[any[], string][]} */ ([
      [SHAPES.unique, `CREATE UNIQUE INDEX "c_by_q$object" ON c ((CASE WHEN jsonb_typeof(${AT}) = 'object' THEN ${AT} END))`],
      [[{ name: 'by_qk', path: ['$.q', '$.k'], unique: true }],
        `CREATE UNIQUE INDEX "c_by_qk$text" ON c (((CASE WHEN jsonb_typeof(${AT}) = 'string' THEN "doc" #>> '{"q"}' END) COLLATE "C"), gx_k)`],
    ])) {
      await create(context, [...tableSql(modelOf({ q: {} }, indexes), false), sql]);
      const { model: derived, report } = await introspected(context);
      assert.deepEqual(derived.collections.c.schema.properties.q, {});
      assert.deepEqual(lossesOf(report).filter((row) => row.includes('$')), [`unmapped-index:c.${/** @type {string[]} */ (sql.match(/"(c_[^"]*)"/))[1]}`]);
      await context.pool.query(`SET search_path TO "${context.schema}"; DROP TABLE c`);
    }
  }));

  it('reads no kind beside a column of another type no schema type maps back from', () => withPostgres(async (context) => {
    const statements = tableSql(modelOf({ q: { type: ['object', 'string'] } }, SHAPES.unique), false);
    const column = `"gx_q" jsonb GENERATED ALWAYS AS (${NULL_FREE}) STORED`;
    assert.ok(statements[0].includes(column));
    await create(context, [statements[0].replace(column, `"gx_q" name GENERATED ALWAYS AS (("doc" #>> '{"q"}')::name) STORED`), ...statements.slice(1)]);
    const { model: derived, report } = await introspected(context);
    assert.deepEqual(derived.collections.c.schema.properties.q, {});
    assert.deepEqual(lossesOf(report).filter((row) => row.includes('$')), ['unmapped-index:c.c_by_q$text']);
  }));
});
