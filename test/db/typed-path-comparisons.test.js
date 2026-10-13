//@ts-check
/**
 * @file Comparisons between two member paths the schema types as scalars,
 * across JSON type families, and a literal `$get` over the binding or an
 * object member. They plan native on every host — with no user function
 * on `node:sqlite`, whose function hatch used to answer them, and on
 * `bun:sqlite` and PostgreSQL, which have no such hatch and ran the
 * document in the engine — and answer as the engine does: two present
 * values are equal when they are of one family and equal there, differ
 * otherwise, and order only as two numbers or two strings; an absent
 * member answers false for every operator. The corpus group holds the 81
 * pairs of values two union-typed members take (and the pairs a SQLite
 * boolean-as-1 would blur), six operators, indexed and not. What the
 * schema does not type as a scalar stays with the engine under a named
 * reason, and an entity query's path comparison is the plain one it was.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileJsonQuery } from '@jarenjs/json/query';
import {
  planQuery, emitPlan, normalizeModel, planCollection, sqliteDialect, reasonId,
} from '@jarenjs/db';
import { postgresDriver, postgresDialect } from '@jarenjs/db/postgres';

import { storeForGroup, storeForEntityGroup, runEntityCase } from './oracle/harness.js';
import { typedPathsGroup, checkTypedPaths, openNullPolicy, checkNullPolicy } from './oracle/typed-paths.js';
import { predicateTerms, boundPredicateTerms } from '../../packages/db/src/plan.js';

const PG_URL = process.env.JAREN_PG_URL;

describe('the corpus group on node:sqlite', () => {
  for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
    it(`${side}: every shape plans as the table says and answers as the engine does`, async () => {
      const group = typedPathsGroup();
      const { store, collection } = await storeForGroup(group, undefined, side);
      try {
        assert.deepEqual(await checkTypedPaths(collection, group, 'node', side), []);
      }
      finally {
        await store.close();
      }
    });
  }
});

describe('the corpus group on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */ let pg;
  /** @type {any} */ let admin;
  /** @type {any} */ let pool;
  const schemas = /** @type {string[]} */ ([]);
  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
  });
  after(async () => {
    await pool?.end().catch(() => {});
    if (admin) {
      try { for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
    it(`${side}: every shape plans as the table says and answers as the engine does`, async () => {
      const group = typedPathsGroup();
      const schema = `jaren_typed_paths_${process.pid}_${side}`;
      schemas.push(schema);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const { store, collection } = await storeForGroup(group, postgresDriver(pool, { schema }), side);
      try {
        assert.deepEqual(await checkTypedPaths(collection, group, 'pg', side), []);
      }
      finally {
        await store.close();
      }
    });
  }
});

const MODEL = {
  $model: '0.1',
  collections: {
    rows: {
      key: '/id',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, n: { type: 'integer' }, f: { type: 'number' }, s: { type: 'string' },
          b: { type: 'boolean' }, ns: { type: ['string', 'null'] }, bb: { type: ['boolean', 'null'] },
          nz: { type: 'null' },
          x: { type: ['string', 'number', 'boolean', 'null'] }, y: { type: ['string', 'number', 'boolean', 'null'] },
          u: {}, o: { type: 'object', properties: { k: { type: 'integer' } } },
        },
      },
      indexes: [{ name: 'by_ns', path: '$.ns' }, { name: 'by_x', path: '$.x' }],
    },
  },
};
const ROWS = normalizeModel(MODEL).get('rows');
const PHYSICAL = { table: 'rows', keyColumn: 'key', docColumn: 'doc' };
const PG = postgresDialect();
const shapeFor = (/** @type {any} */ dialect) => ({
  collection: 'rows', schema: ROWS.schema,
  columnByCanonical: planCollection('rows', ROWS, dialect).columnByCanonical,
});
const SHAPE = shapeFor(sqliteDialect);
const where = (/** @type {any} */ predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' });
const filterOf = (/** @type {any} */ predicate) => planQuery(where(predicate), SHAPE).plan.filter;
const whereClause = (/** @type {any} */ predicate, /** @type {any} */ dialect) => {
  const planned = planQuery(where(predicate), shapeFor(dialect));
  assert.equal(planned.mode, 'native');
  const { sql } = emitPlan(planned.plan, dialect, PHYSICAL);
  return sql.slice(sql.indexOf('WHERE'));
};
const refOf = (/** @type {string} */ name, /** @type {string} */ type, /** @type {any} */ extra) =>
  ({ segments: [{ name }], type, column: null, ...extra });

describe('the plan of a comparison between two member paths', () => {
  it('two members of one family that hold nothing else keep the plain comparison', () => {
    assert.deepEqual(filterOf({ $lt: ['$it.n', '$it.f'] }), { p: 'refCmp', op: 'lt',
      left: refOf('n', 'integer', { families: ['number'] }), right: refOf('f', 'number', { families: ['number'] }) });
  });

  it('a member that admits null, or holds a boolean, or several kinds, is compared by family', () => {
    assert.deepEqual(filterOf({ $eq: ['$it.s', '$it.ns'] }), { p: 'refCmp', op: 'eq',
      left: refOf('s', 'string', { families: ['text'] }),
      right: { ...refOf('ns', 'string', { families: ['text', 'null'] }), column: 'gx_ns' } });
    assert.deepEqual(filterOf({ $ne: ['$it.b', '$it.bb'] }), { p: 'refCmp', op: 'ne',
      left: refOf('b', 'boolean', { families: ['boolean'] }), right: refOf('bb', 'boolean', { families: ['boolean', 'null'] }) });
    const union = filterOf({ $le: ['$it.x', '$it.y'] });
    assert.deepEqual(union.left, { segments: [{ name: 'x' }], type: 'string', column: 'gx_x', mixed: true,
      families: ['number', 'text', 'boolean', 'null'] });
    assert.deepEqual(union.right.families, ['number', 'text', 'boolean', 'null']);
    assert.equal(union.right.column, null);
  });

  it('members that share no family stay one comparison, which the emitter answers family by family', () => {
    // an equality or an ordering of two members of different families, and an ordering of booleans
    // or nulls, is false for every row; a difference holds wherever both are present
    for (const predicate of [{ $eq: ['$it.n', '$it.s'] }, { $gt: ['$it.n', '$it.s'] }, { $lt: ['$it.b', '$it.bb'] },
      { $ge: ['$it.nz', '$it.bb'] }, { $ne: ['$it.n', '$it.s'] }]) {
      const filter = filterOf(predicate);
      assert.equal(filter.p, 'refCmp', JSON.stringify(predicate));
      assert.ok(filter.left.families.length > 0 && filter.right.families.length > 0, JSON.stringify(predicate));
    }
    const differs = filterOf({ $ne: ['$it.n', '$it.s'] });
    assert.deepEqual([differs.left.families, differs.right.families], [['number'], ['text']]);
  });

  it('an operand the schema does not type as a scalar stays with the engine under one named reason', () => {
    for (const operands of [['$it.u', '$it.n'], ['$it.o', '$it.n'], ['$it.n', '$it.u'], ['$it.o', '$it.o']]) {
      const planned = planQuery(where({ $eq: operands }), SHAPE);
      assert.equal(planned.mode, 'set', operands.join(' '));
      assert.equal(reasonId(planned.reasons[0].reason), 'predicate.joinTerritory', operands.join(' '));
    }
  });

  it('a comparison decided one family at a time costs a term for each family the two share', () => {
    assert.equal(predicateTerms(filterOf({ $lt: ['$it.n', '$it.f'] })), 1);
    assert.equal(predicateTerms(filterOf({ $eq: ['$it.s', '$it.ns'] })), 1);
    assert.equal(predicateTerms(filterOf({ $eq: ['$it.x', '$it.y'] })), 4);
    assert.equal(predicateTerms(filterOf({ $ne: ['$it.n', '$it.s'] })), 1);
    const planned = (/** @type {number} */ count) => planQuery(where({ $and: Array.from({ length: count },
      (_, i) => ({ [['$eq', '$ne', '$le'][i % 3]]: ['$it.x', '$it.y'] })) }), SHAPE);
    assert.equal(boundPredicateTerms(planned(32), 128).mode, 'native');
    const demoted = boundPredicateTerms(planned(33), 128);
    assert.equal(demoted.mode, 'set');
    assert.equal(reasonId(demoted.reasons[0].reason), 'predicate.termBound');
  });
});

describe('the plan of a literal $get', () => {
  const get = (/** @type {any} */ target, /** @type {any} */ key) => ({ $get: [target, key] });

  it('over the binding or an object-typed member it is the member path', () => {
    assert.deepEqual(filterOf({ $eq: [get('$it', 's'), 'a'] }), filterOf({ $eq: ['$it.s', 'a'] }));
    assert.deepEqual(filterOf({ $eq: [get('$it.o', 'k'), 3] }), filterOf({ $eq: ['$it.o.k', 3] }));
    assert.deepEqual(filterOf({ $exists: get('$it', 'nope') }), filterOf({ $exists: '$it.nope' }));
    assert.deepEqual(filterOf({ $empty: get('$it.o', 'k') }), filterOf({ $empty: '$it.o.k' }));
    assert.deepEqual(filterOf({ $eq: [get('$it', 's'), get('$it', 'ns')] }), filterOf({ $eq: ['$it.s', '$it.ns'] }));
    assert.deepEqual(filterOf({ '$starts-with': [get('$it', 's'), 'a'] }), filterOf({ '$starts-with': ['$it.s', 'a'] }));
  });

  it('under any other target, or with a key that is no literal string, it keeps its plan', () => {
    for (const [operands, id] of /** @type {[any[], string][]} */ ([
      [[get('$it.u', 'k'), 3], 'predicate.operands'],
      [[get('$it.n', 'k'), 3], 'predicate.operands'],
      [[get('$it.o', '$name'), 3], 'predicate.operands'],
      [[get('$it', 0), 3], 'predicate.operands'],
    ])) {
      const planned = planQuery(where({ $eq: operands }), SHAPE);
      assert.equal(planned.mode, 'set', JSON.stringify(operands));
      assert.equal(reasonId(planned.reasons[0].reason), id, JSON.stringify(operands));
    }
    assert.equal(reasonId(planQuery(where({ $exists: get('$it.u', 'k') }), SHAPE).reasons[0].reason), 'predicate.existence');
  });
});

describe('the SQL of a comparison between two member paths', () => {
  const pair = (/** @type {string} */ op, /** @type {string} */ left, /** @type {string} */ right) => ({ [op]: [`$it.${left}`, `$it.${right}`] });

  it('SQLite: the plain comparison, then the dispatch by family, reading a column only as its own kind', () => {
    assert.equal(whereClause(pair('$lt', 'n', 'f'), sqliteDialect),
      'WHERE (json_type("doc", \'$."n"\') IS NOT NULL AND json_type("doc", \'$."f"\') IS NOT NULL '
      + 'AND jsonb_extract("doc", \'$."n"\') < jsonb_extract("doc", \'$."f"\')) ORDER BY "rowid"');
    assert.equal(whereClause(pair('$eq', 's', 'ns'), sqliteDialect),
      'WHERE (json_type("doc", \'$."s"\') IS NOT NULL AND json_type("doc", \'$."ns"\') IS NOT NULL '
      + 'AND (json_type("doc", \'$."ns"\') = \'text\' AND jsonb_extract("doc", \'$."s"\') = "gx_ns")) ORDER BY "rowid"');
    assert.equal(whereClause(pair('$ne', 'b', 'bb'), sqliteDialect),
      'WHERE (json_type("doc", \'$."b"\') IS NOT NULL AND json_type("doc", \'$."bb"\') IS NOT NULL '
      + 'AND NOT ((json_type("doc", \'$."bb"\') IN (\'true\', \'false\') '
      + 'AND jsonb_extract("doc", \'$."b"\') = jsonb_extract("doc", \'$."bb"\')))) ORDER BY "rowid"');
    assert.equal(whereClause(pair('$ne', 'n', 's'), sqliteDialect),
      'WHERE (json_type("doc", \'$."n"\') IS NOT NULL AND json_type("doc", \'$."s"\') IS NOT NULL) ORDER BY "rowid"');
    assert.equal(whereClause(pair('$eq', 'n', 's'), sqliteDialect),
      'WHERE (json_type("doc", \'$."n"\') IS NOT NULL AND json_type("doc", \'$."s"\') IS NOT NULL AND 0) ORDER BY "rowid"');
    assert.equal(whereClause(pair('$lt', 'b', 'bb'), sqliteDialect),
      'WHERE (json_type("doc", \'$."b"\') IS NOT NULL AND json_type("doc", \'$."bb"\') IS NOT NULL AND 0) ORDER BY "rowid"');
    // the union member x is indexed as text: its column answers the text term alone, the number term reads the document
    assert.equal(whereClause(pair('$le', 'x', 'y'), sqliteDialect),
      'WHERE (json_type("doc", \'$."x"\') IS NOT NULL AND json_type("doc", \'$."y"\') IS NOT NULL '
      + 'AND ((json_type("doc", \'$."x"\') IN (\'integer\', \'real\') AND json_type("doc", \'$."y"\') IN (\'integer\', \'real\') '
      + 'AND jsonb_extract("doc", \'$."x"\') <= jsonb_extract("doc", \'$."y"\')) '
      + 'OR (json_type("doc", \'$."x"\') = \'text\' AND json_type("doc", \'$."y"\') = \'text\' '
      + 'AND "gx_x" <= jsonb_extract("doc", \'$."y"\')))) ORDER BY "rowid"');
  });

  it('PostgreSQL: two members of one family keep the statement they always had, byte for byte', () => {
    assert.equal(whereClause(pair('$lt', 'n', 'f'), PG),
      'WHERE ((CASE WHEN jsonb_typeof(("doc" #> \'{"n"}\')) = \'string\' THEN \'text\' WHEN jsonb_typeof(("doc" #> \'{"n"}\')) = \'boolean\' THEN (CASE WHEN (("doc" #> \'{"n"}\'))::boolean THEN \'true\' ELSE \'false\' END) ELSE jsonb_typeof(("doc" #> \'{"n"}\')) END) IS NOT NULL AND (CASE WHEN jsonb_typeof(("doc" #> \'{"f"}\')) = \'string\' THEN \'text\' WHEN jsonb_typeof(("doc" #> \'{"f"}\')) = \'boolean\' THEN (CASE WHEN (("doc" #> \'{"f"}\'))::boolean THEN \'true\' ELSE \'false\' END) ELSE jsonb_typeof(("doc" #> \'{"f"}\')) END) IS NOT NULL AND (CASE WHEN jsonb_typeof(("doc" #> \'{"n"}\')) = \'number\' THEN (("doc" #> \'{"n"}\'))::numeric END) < (CASE WHEN jsonb_typeof(("doc" #> \'{"f"}\')) = \'number\' THEN (("doc" #> \'{"f"}\'))::numeric END)) ORDER BY "rid"');
  });

  it('PostgreSQL: each family term is true or false, never NULL, so a negation composes', () => {
    assert.equal(whereClause(pair('$ne', 'b', 'bb'), PG),
      'WHERE (("doc" #> \'{"b"}\') IS NOT NULL AND ("doc" #> \'{"bb"}\') IS NOT NULL AND NOT ('
      + '((CASE WHEN jsonb_typeof(("doc" #> \'{"b"}\')) = \'boolean\' THEN (CASE WHEN (("doc" #> \'{"b"}\'))::boolean THEN 1 ELSE 0 END) END) IS NOT NULL '
      + 'AND (CASE WHEN jsonb_typeof(("doc" #> \'{"bb"}\')) = \'boolean\' THEN (CASE WHEN (("doc" #> \'{"bb"}\'))::boolean THEN 1 ELSE 0 END) END) IS NOT NULL '
      + 'AND (CASE WHEN jsonb_typeof(("doc" #> \'{"b"}\')) = \'boolean\' THEN (CASE WHEN (("doc" #> \'{"b"}\'))::boolean THEN 1 ELSE 0 END) END) '
      + '= (CASE WHEN jsonb_typeof(("doc" #> \'{"bb"}\')) = \'boolean\' THEN (CASE WHEN (("doc" #> \'{"bb"}\'))::boolean THEN 1 ELSE 0 END) END)))) ORDER BY "rid"');
    assert.equal(whereClause(pair('$eq', 'nz', 'bb'), PG),
      'WHERE (("doc" #> \'{"nz"}\') IS NOT NULL AND ("doc" #> \'{"bb"}\') IS NOT NULL '
      + 'AND (jsonb_typeof(("doc" #> \'{"nz"}\')) = \'null\' AND jsonb_typeof(("doc" #> \'{"bb"}\')) = \'null\')) ORDER BY "rid"');
    assert.equal(whereClause(pair('$eq', 'n', 's'), PG),
      'WHERE (("doc" #> \'{"n"}\') IS NOT NULL AND ("doc" #> \'{"s"}\') IS NOT NULL AND FALSE) ORDER BY "rid"');
  });
});

describe('an entity query compares the plain family it always did', () => {
  const key = { 'x-entity': { key: true } };
  const group = {
    group: 'entity path comparisons',
    model: { $model: '0.1', entities: { Item: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...key }, a: { type: 'string' }, n: { type: 'integer' }, m: { type: 'number' },
      nn: { type: ['number', 'null'] }, b: { type: 'boolean' }, c: { type: 'boolean' } } } } } },
    documents: { Item: [
      { id: 'i1', a: '1', n: 1, m: 1, nn: 1, b: true, c: true },
      { id: 'i2', a: 'b', n: 2, m: 2.5, nn: 2, b: false, c: true },
      { id: 'i3', a: '3', n: 3, m: 3, b: true },
      { id: 'i4' },
    ] },
    cases: /** @type {any[]} */ ([]),
  };
  const query = (/** @type {any} */ predicate) => ({ $for: { it: '$.Item[*]' }, $where: predicate, $return: '$it.id' });
  const SHAPES = /** @type {[string, any, string | null][]} */ ([
    ['two numeric members', { $eq: ['$it.n', '$it.m'] }, null],
    ['two numeric members ordered', { $lt: ['$it.n', '$it.m'] }, null],
    ['a string against a number', { $ne: ['$it.a', '$it.n'] }, 'predicate.joinTerritory'],
    ['a member that admits null', { $eq: ['$it.nn', '$it.n'] }, 'predicate.joinTerritory'],
    ['two booleans', { $eq: ['$it.b', '$it.c'] }, 'predicate.joinTerritory'],
    // members of different families answer false or true by their families, and an entity query leaves that to the engine
    ['a string and a number, an equality', { $eq: ['$it.a', '$it.n'] }, 'predicate.joinTerritory'],
    ['a string and a number, an order', { $lt: ['$it.a', '$it.n'] }, 'predicate.joinTerritory'],
    ['two booleans, an order', { $ge: ['$it.c', '$it.b'] }, 'predicate.joinTerritory'],
    // a literal $get inside a connective is no path to an entity query
    ['a $get beside a path under an $or', { $or: [{ $eq: ['$it.a', 'x'] }, { $eq: [{ $get: ['$it', 'n'] }, 2] }] }, 'predicate.operands'],
    // an entity query assigns each conjunct to a binding by the paths it reads, and a $get reads none
    ['a $get over the binding', { $eq: [{ $get: ['$it', 'n'] }, 2] }, 'entity.conjunctBinding'],
    ['a $get over the binding, tested for existence', { $exists: { $get: ['$it', 'nn'] } }, 'entity.conjunctBinding'],
  ]);

  /** @param {any} driver @param {string} label */
  const check = async (driver, label) => {
    const { store } = await storeForEntityGroup(group, driver);
    try {
      for (const [name, predicate, reason] of SHAPES) {
        const explained = await store.explain(query(predicate));
        assert.equal(explained.mode, reason === null ? 'native' : 'set', `${label}: ${name}`);
        if (reason !== null) assert.equal(reasonId(explained.residual.reasons[0].reason), reason, `${label}: ${name}`);
        const kase = { query: query(predicate) };
        for (const mode of /** @type {const} */ (['native', 'residual'])) {
          assert.equal(await runEntityCase(store, group.documents, kase, mode), null, `${label}: ${name} ${mode}`);
        }
      }
    }
    finally {
      await store.close();
    }
  };

  it('node:sqlite: the same shapes stay native or stay with the engine, and answer as it does', async () => {
    await check(undefined, 'sqlite');
  });

  it('PostgreSQL: the same', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: PG_URL });
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    const schema = `jaren_typed_paths_entity_${process.pid}`;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await check(postgresDriver(pool, { schema }), 'postgres');
    }
    finally {
      await pool.end().catch(() => {});
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
});

describe('a member of several kinds is held by an untyped column that every comparison reads', () => {
  const group = {
    group: 'union column',
    schema: { type: 'object', properties: { id: { type: 'string' }, x: { type: ['string', 'number', 'boolean', 'null'] } } },
    indexes: [{ name: 'by_x', path: '$.x' }],
    documents: [{ id: 'n2', x: 2 }, { id: 's2', x: '2' }, { id: 'f35', x: 3.5 }, { id: 'sb', x: 'b' }, { id: 't', x: true },
      { id: 'n10', x: 10 }, { id: 's10', x: '10' }, { id: 'nul', x: null }, { id: 'none' }],
    cases: /** @type {any[]} */ ([]),
  };

  it('a number is compared as a number, and the column the index covers answers it', async () => {
    const { store, collection } = await storeForGroup(group);
    try {
      for (const [predicate, externals] of /** @type {[any, any][]} */ ([
        [{ $eq: ['$it.x', 2] }], [{ $gt: ['$it.x', 2] }], [{ $ne: ['$it.x', 2] }], [{ $le: ['$it.x', 3.5] }],
        [{ $eq: ['$it.x', '$v'] }, { v: 2 }], [{ $lt: ['$it.x', '$v'] }, { v: 10 }],
      ])) {
        const options = externals === undefined ? undefined : { externals };
        assert.deepEqual(await collection.execute(where(predicate), options),
          compileJsonQuery(where(predicate))(structuredClone(group.documents), externals), JSON.stringify(predicate));
      }
      // a number and a string both seek the column
      assert.ok((await collection.explain(where({ $eq: ['$it.x', 2] }))).sql.includes('"gx_x" = ?'));
      assert.ok((await collection.explain(where({ $eq: ['$it.x', 'b'] }))).sql.includes('"gx_x" = ?'));
    }
    finally {
      await store.close();
    }
  });
});

describe('a physical column whose NULL policy reads a NULL as a present null', () => {
  it('node:sqlite: a comparison across families stays with the engine, which equates the nulls', async () => {
    const { nodeDriver } = await import('@jarenjs/db/node');
    const opened = await openNullPolicy({ kind: 'sqlite', driver: nodeDriver() });
    try {
      assert.deepEqual(await checkNullPolicy(opened.store), []);
    }
    finally {
      await opened.close();
    }
  });

  it('PostgreSQL: the same', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: PG_URL });
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    const schema = `jaren_null_policy_${process.pid}`;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const opened = await openNullPolicy({ kind: 'postgres', admin, pool, schema });
      try {
        assert.deepEqual(await checkNullPolicy(opened.store), []);
      }
      finally {
        await opened.close();
      }
    }
    finally {
      await pool.end().catch(() => {});
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
});
