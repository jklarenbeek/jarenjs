//@ts-check
/**
 * @file A digit in a path on PostgreSQL. `#>` has one spelling for the
 * array element `0` and the object key `0` (it also takes `-1`, `+1` and
 * ` 1` for array indexes), so a name selector `['0']` also matched an
 * array and an index selector `[0]` also matched an object, where the
 * engine and SQLite match one each. A query now reads such a path from a
 * document guarded so each step meets the container it means; a path with
 * no such step is read as before, and so are the generated columns,
 * migrations and drift read-back of every path whose containers the schema
 * declares and that names no member `0`, which keep every byte of theirs (a
 * path whose container the schema leaves open is guarded in them too: see
 * postgres-open-container-columns.test.js; and so is a member name the path
 * text spells as an index, which the catalog would otherwise read back as
 * one: see postgres-digit-names.test.js).
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';

import { normalizeModel, planCollection, planQuery, emitPlan, reasonId } from '@jarenjs/db';
import { postgresDriver, postgresDialect } from '@jarenjs/db/postgres';

import { loadGroups, storeForGroup, runCase } from './oracle/harness.js';

const PG_URL = process.env.JAREN_PG_URL;
const group = () => /** @type {any} */ (loadGroups().find((entry) => entry.group === 'digit member names'));
const kase = (/** @type {string} */ name) => group().cases.find((/** @type {any} */ entry) => entry.name === name);
/** The answers the engine gives, written out: a name `0` is an object's, an index `0` an array's. */
const ANSWERS = /** @type {[string, any][]} */ ([
  ['a name 0 exists only on an object', ['b', 'h']],
  ['an index 0 exists only on an array', ['a', 'e', 'g', 'm', 'o']],
  ['a name 0 against a number', 'b'],
  ['an index 0 against a number', ['a', 'e']],
  ['an index 1 against a number', 'e'],
  ['a name 1 against a number', 'f'],
  ['a name that reads as a negative index', 'f'],
  ['a name that reads as a signed index', 'f'],
  ['a name that reads as a padded index', 'f'],
  ['a name that reads as a zero-padded index', 'f'],
  ['a name 0 on the binding', 'd'],
  ['a name 0 under a typed object', 'l'],
  ['a nested index then a name', 'g'],
  ['a nested name then an index', 'h'],
  ['a name led by a vertical tab reads as no index', 'n'],
  ['a name led by a form feed reads as no index', 'n'],
  ['a name led by a carriage return reads as no index', 'n'],
  ['a name led by a tab reads as no index', 'n'],
  ['a name led by a newline reads as no index', 'n'],
]);

/** Four documents: an array under `u`, an object keyed 0, a string, and a member named 0 on the binding. */
const FOUR = {
  group: 'four documents',
  schema: { type: 'object', properties: { id: { type: 'string' } } },
  indexes: [],
  documents: [{ id: 'a', u: [7] }, { id: 'b', u: { 0: 7 } }, { id: 'c', u: 'x' }, { id: 'd', 0: 1 }],
};
const FOUR_QUERIES = /** @type {[string, any, string][]} */ ([
  ["a name selector '0' on u matches the object only", { $exists: "$it.u['0']" }, 'b'],
  ['an index selector [0] on u matches the array only', { $exists: '$it.u[0]' }, 'a'],
]);
/** @param {any} driver @param {'indexed' | 'unindexed'} side */
async function answersOfFour(driver, side) {
  const { store, collection } = await storeForGroup(FOUR, driver, side);
  try {
    /** @type {Record<string, any>} */
    const answers = {};
    for (const [name, predicate] of FOUR_QUERIES) {
      const query = { $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' };
      answers[name] = await collection.execute(query);
      assert.equal((await collection.explain(query)).mode, 'native', name);
    }
    return answers;
  }
  finally {
    await store.close();
  }
}

describe('the dialect text a digit in a path writes', () => {
  const dialect = postgresDialect();
  const MODEL = { $model: '0.1', collections: { spans: { key: '/id', schema: { type: 'object', properties: {
    id: { type: 'string' },
    spans: { type: 'array', items: { type: 'object', properties: { start: { type: 'integer' } } } },
    0: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
  indexes: [{ name: 'by_start', path: '$.spans[0].start' }, { name: 'by_zero', path: "$['0']" },
    { name: 'by_tag', path: '$.tags[1]' }] } } };

  it('the generated columns, whose definitions the store compares to the catalog, keep every byte but the document\'s own member 0, read under the object guard', () => {
    const plan = planCollection('spans', normalizeModel(MODEL).get('spans'), dialect);
    assert.deepEqual(plan.createSql, [
      'CREATE TABLE "spans" ("key" text COLLATE "C" PRIMARY KEY, "doc" jsonb NOT NULL, "rid" bigserial, '
      + '"gx_spans_0_start" numeric GENERATED ALWAYS AS ((CASE WHEN jsonb_typeof(("doc" #> \'{"spans","0","start"}\')) = \'number\' '
      + 'THEN (("doc" #> \'{"spans","0","start"}\'))::numeric END)) STORED, '
      + '"gx_0" text COLLATE "C" GENERATED ALWAYS AS (((CASE WHEN jsonb_typeof(((CASE WHEN jsonb_typeof("doc") = \'object\' THEN "doc" END) #> \'{"0"}\')) = \'string\' '
      + 'THEN (CASE WHEN jsonb_typeof("doc") = \'object\' THEN "doc" END) #>> \'{"0"}\' END) COLLATE "C")) STORED, '
      + '"gx_tags_1" text COLLATE "C" GENERATED ALWAYS AS (((CASE WHEN jsonb_typeof(("doc" #> \'{"tags","1"}\')) = \'string\' '
      + 'THEN "doc" #>> \'{"tags","1"}\' END) COLLATE "C")) STORED)',
      'CREATE INDEX "spans_by_start" ON "spans" ("gx_spans_0_start")',
      'CREATE INDEX "spans_by_zero" ON "spans" ("gx_0")',
      'CREATE INDEX "spans_by_tag" ON "spans" ("gx_tags_1")',
    ]);
  });

  it('the shared path writers are unchanged: a name 0 and an index 0 are the one element text', () => {
    assert.equal(dialect.jsonPathText([{ name: 'u' }, { name: '0' }]), '{"u","0"}');
    assert.equal(dialect.jsonPathText([{ name: 'u' }, { index: 0 }]), '{"u","0"}');
    assert.equal(dialect.jsonExtract('"doc"', '{"u","0"}', 'scalar'), '("doc" #>> \'{"u","0"}\')');
    assert.equal(dialect.jsonExtract('"doc"', '{"u","0"}'), '("doc" #> \'{"u","0"}\')');
  });

  it('a step an array or an object would read as the other kind is guarded on its parent', () => {
    const doc = '"doc"';
    // no step to confuse: the document as it is
    for (const segments of [[{ name: 'u' }], [{ name: 'u' }, { name: 'k' }], [{ name: 'a1' }, { name: 'x1' }], [{ name: '1a' }], [{ name: '0 ' }], [{ name: '1e2' }], [{ name: '' }], [{ name: ' ' }], [{ name: '+' }]])
      assert.equal(dialect.queryDocument(doc, segments), doc, JSON.stringify(segments));
    // an index: the parent must be an array; a name an array would take for one: an object
    assert.equal(dialect.queryDocument(doc, [{ name: 'u' }, { index: 0 }]),
      '(CASE WHEN jsonb_typeof(("doc" #> \'{"u"}\')) = \'array\' THEN "doc" END)');
    for (const name of ['0', '00', '7', '-1', '+1', ' 1', '\t2', '\n3', '-0', '\u000b1', '\f1', '\r1']) {
      assert.equal(dialect.queryDocument(doc, [{ name: 'u' }, { name }]),
        '(CASE WHEN jsonb_typeof(("doc" #> \'{"u"}\')) = \'object\' THEN "doc" END)', JSON.stringify(name));
    }
    assert.equal(dialect.queryDocument(doc, [{ name: '0' }]),
      '(CASE WHEN jsonb_typeof("doc") = \'object\' THEN "doc" END)');
    // each step is guarded by the container it means, from the document down
    assert.equal(dialect.queryDocument(doc, [{ name: 'u' }, { index: 0 }, { name: '0' }, { index: 1 }]),
      '(CASE WHEN jsonb_typeof(("doc" #> \'{"u"}\')) = \'array\' '
      + 'AND jsonb_typeof(("doc" #> \'{"u","0"}\')) = \'object\' '
      + 'AND jsonb_typeof(("doc" #> \'{"u","0","0"}\')) = \'array\' THEN "doc" END)');
    // a path the dialect cannot spell is left for the emitter to refuse by name
    assert.equal(dialect.queryDocument(doc, [{ name: 'u' }, { index: -1 }]), doc);
  });

  it('a statement reads a path with no such step exactly as before', () => {
    const rows = normalizeModel(MODEL).get('spans');
    const shape = { collection: 'spans', schema: rows.schema, columnByCanonical: new Map() };
    const sqlOf = (/** @type {any} */ predicate) => emitPlan(planQuery({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' }, shape).plan,
      dialect, { table: 'spans', keyColumn: 'key', docColumn: 'doc' }).sql;
    assert.ok(!sqlOf({ $exists: '$it.u.k' }).includes('CASE WHEN jsonb_typeof(("doc" #> \'{"u"}\'))'));
    assert.ok(sqlOf({ $exists: '$it.u[0]' }).includes('(CASE WHEN jsonb_typeof(("doc" #> \'{"u"}\')) = \'array\' THEN "doc" END)'));
    assert.ok(sqlOf({ $exists: "$it.u['0']" }).includes('(CASE WHEN jsonb_typeof(("doc" #> \'{"u"}\')) = \'object\' THEN "doc" END)'));
  });
});

describe('four documents, a name selector and an index selector, on node:sqlite', () => {
  it('the name selector answers b and the index selector a', async () => {
    for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
      assert.deepEqual(await answersOfFour(undefined, side), Object.fromEntries(FOUR_QUERIES.map(([name, , answer]) => [name, answer])), side);
    }
  });
});

describe('the digit-name corpus group, on node:sqlite', () => {
  for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
    it(`${side}: the engine's answers, written out`, async () => {
      const { store, collection } = await storeForGroup(group(), undefined, side);
      try {
        for (const [name, expected] of ANSWERS) {
          assert.deepEqual(await collection.execute(kase(name).query), expected, name);
        }
        for (const entry of group().cases) assert.equal(await runCase(collection, group().documents, entry, 'native'), null, entry.name);
      }
      finally {
        await store.close();
      }
    });
  }
});

describe('a digit in a path on a PostgreSQL server', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */ let admin;
  /** @type {any} */ let pool;
  const schemas = /** @type {string[]} */ ([]);
  before(async () => {
    const pg = (await import('pg')).default;
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

  it('the name selector answers b and the index selector a', async () => {
    for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
      const schema = `jaren_path_four_${process.pid}_${side}`;
      schemas.push(schema);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      assert.deepEqual(await answersOfFour(postgresDriver(pool, { schema }), side),
        Object.fromEntries(FOUR_QUERIES.map(([name, , answer]) => [name, answer])), side);
    }
  });

  for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
    it(`${side}: a name 0 matches an object and an index 0 an array, as the engine and SQLite have them`, async () => {
      const schema = `jaren_path_names_${process.pid}_${side}`;
      schemas.push(schema);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const { store, collection } = await storeForGroup(group(), postgresDriver(pool, { schema }), side);
      try {
        for (const [name, expected] of ANSWERS) {
          assert.deepEqual(await collection.execute(kase(name).query), expected, name);
        }
        for (const entry of group().cases) assert.equal(await runCase(collection, group().documents, entry, 'native'), null, entry.name);
        // the statement stays native: the guard is part of the read, not a reason to leave it
        for (const [name] of ANSWERS) assert.equal((await collection.explain(kase(name).query)).mode, 'native', name);
      }
      finally {
        await store.close();
      }
    });
  }
});

const UNDER = 'typed members under untyped containers';
const under = () => /** @type {any} */ (loadGroups().find((entry) => entry.group === UNDER));

describe('a path whose container the schema does not declare', () => {
  const SCHEMA = (/** @type {any} */ container) => ({ type: 'object', properties: { id: { type: 'string' }, c: container } });
  const refOf = (/** @type {any} */ container, /** @type {string} */ path) => {
    const rows = normalizeModel({ $model: '0.1', collections: { rows: { key: '/id', schema: SCHEMA(container) } } }).get('rows');
    const shape = { collection: 'rows', schema: rows.schema, columnByCanonical: new Map() };
    const planned = planQuery({ $for: { it: '$[*]' }, $where: { $exists: path }, $return: '$it.id' }, shape);
    return planned.plan.filter.ref;
  };
  const LEAF = { type: 'integer' };

  it('is marked when a step a path engine may read off the other kind meets a container with no declared type', () => {
    assert.equal(refOf({ items: LEAF }, '$it.c[0]').unpinned, true);
    assert.equal(refOf({ properties: { 0: LEAF } }, "$it.c['0']").unpinned, true);
    assert.equal(refOf({ type: ['object', 'array'], items: LEAF }, '$it.c[0]').unpinned, true);
    assert.equal(refOf({ type: ['array', 'object'], properties: { 0: LEAF } }, "$it.c['0']").unpinned, true);
  });

  it('is not marked when the declared type excludes the kind the step would be read off', () => {
    assert.equal(refOf({ type: 'array', items: LEAF }, '$it.c[0]').unpinned, undefined);
    assert.equal(refOf({ type: ['array', 'null'], items: LEAF }, '$it.c[0]').unpinned, undefined);
    assert.equal(refOf({ type: 'object', properties: { 0: LEAF } }, "$it.c['0']").unpinned, undefined);
    assert.equal(refOf({ type: ['object', 'null'], properties: { 0: LEAF } }, "$it.c['0']").unpinned, undefined);
  });

  it('is not marked when no step is one a path engine may read off the other kind', () => {
    assert.equal(refOf({ properties: { k: LEAF } }, '$it.c.k').unpinned, undefined);
    assert.equal(refOf({ properties: { k1: LEAF } }, '$it.c.k1').unpinned, undefined);
    assert.equal(refOf({ properties: { ' ': LEAF } }, "$it.c[' ']").unpinned, undefined);
  });

  it('is judged step by step: a declared array under an untyped member keeps its index step', () => {
    const container = { properties: { items: { type: 'array', items: LEAF } } };
    assert.equal(refOf(container, '$it.c.items[0]').unpinned, undefined);
  });
});

describe('the untyped-container corpus group, on node:sqlite', () => {
  for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
    it(`${side}: every case answers as the engine does`, async () => {
      const { store, collection } = await storeForGroup(under(), undefined, side);
      try {
        for (const entry of under().cases) assert.equal(await runCase(collection, under().documents, entry, 'native'), null, entry.name);
      }
      finally {
        await store.close();
      }
    });
  }
});

describe('a declared interval over an index step', () => {
  const SPAN = { type: 'object', required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } };
  const DOCS = [{ id: 'arr', spans: [{ start: 0, end: 5 }] }, { id: 'obj', spans: { 0: { start: 0, end: 5 } } }, { id: 'none' }];
  const PROBE = { $const: { start: 1, end: 2 } };
  const overlaps = (/** @type {string} */ path) => ({ $for: { it: '$[*]' }, $where: { $overlaps: [path, PROBE] }, $return: '$it.id' });
  /** A container that declares neither array nor object admits both; a declared array admits the first alone. */
  const CONTAINERS = /** @type {const} */ ({
    untyped: { schema: { items: SPAN, properties: { 0: SPAN } }, intervals: [{ name: 'first', path: '$.spans[0]' }, { name: 'named', path: "$.spans['0']" }],
      paths: [['$it.spans[0]', 'arr'], ["$it.spans['0']", 'obj']] },
    declared: { schema: { type: 'array', items: SPAN }, intervals: [{ name: 'first', path: '$.spans[0]' }], paths: [['$it.spans[0]', 'arr']] },
  });
  const modelOf = (/** @type {'untyped' | 'declared'} */ kind) => ({ $model: '0.1', collections: { rows: { key: '/id',
    schema: { type: 'object', properties: { id: { type: 'string' }, spans: CONTAINERS[kind].schema } },
    indexes: [{ name: 's0', path: '$.spans[0].start' }, { name: 'e0', path: '$.spans[0].end' },
      ...(kind === 'untyped' ? [{ name: 's1', path: "$.spans['0'].start" }, { name: 'e1', path: "$.spans['0'].end" }] : [])],
    intervals: CONTAINERS[kind].intervals } } });

  /** @param {any} driver @param {'untyped' | 'declared'} kind @param {boolean} postgres */
  async function check(driver, kind, postgres) {
    const { openStore } = await import('@jarenjs/db');
    const store = await openStore(modelOf(kind), { driver });
    try {
      const collection = store.collection('rows');
      for (const document of kind === 'declared' ? DOCS.filter((entry) => entry.id !== 'obj') : DOCS) await collection.put(document);
      for (const [path, expected] of CONTAINERS[kind].paths) {
        const query = overlaps(path);
        assert.equal(await collection.execute(query), expected, `${kind} ${path}`);
        assert.equal(await collection.execute(query, { pushdown: false }), expected, `${kind} ${path} in the engine`);
        const explained = await collection.explain(query);
        assert.equal(explained.mode, 'native', `${kind} ${path} stays the exact plan`);
        assert.deepEqual(explained.prefilters, [], `${kind} ${path} refines nothing`);
        const where = explained.sql.slice(explained.sql.indexOf('WHERE'));
        const guarded = where.includes('jsonb_typeof(("doc" #> \'{"spans"}\'))');
        // the document is read beside the bound columns only where the schema leaves the container open
        assert.equal(guarded, postgres && kind === 'untyped', `${kind} ${path}: ${where}`);
      }
    }
    finally {
      await store.close();
    }
  }

  for (const kind of /** @type {const} */ (['untyped', 'declared'])) {
    it(`node:sqlite, ${kind} container: the exact plan answers as the engine does`, async () => {
      const { nodeDriver } = await import('@jarenjs/db/node');
      await check(nodeDriver(), kind, false);
    });
  }

  describe('on a PostgreSQL server', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
    /** @type {any} */ let admin;
    /** @type {any} */ let pool;
    const schemas = /** @type {string[]} */ ([]);
    before(async () => {
      const pg = (await import('pg')).default;
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

    for (const kind of /** @type {const} */ (['untyped', 'declared'])) {
      it(`${kind} container: the exact plan answers as the engine does`, async () => {
        const schema = `jaren_path_interval_${process.pid}_${kind}`;
        schemas.push(schema);
        await admin.query(`CREATE SCHEMA "${schema}"`);
        await check(postgresDriver(pool, { schema }), kind, true);
      });
    }

    for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
      it(`${side}: the untyped-container corpus group answers as the engine does`, async () => {
        const schema = `jaren_path_under_${process.pid}_${side}`;
        schemas.push(schema);
        await admin.query(`CREATE SCHEMA "${schema}"`);
        const { store, collection } = await storeForGroup(under(), postgresDriver(pool, { schema }), side);
        try {
          for (const entry of under().cases) assert.equal(await runCase(collection, under().documents, entry, 'native'), null, entry.name);
          // an indexed path under a container the schema declares keeps its column; one under a container it leaves open reads the document
          const sql = async (/** @type {string} */ name) => (await collection.explain(under().cases.find((/** @type {any} */ entry) => entry.name === name).query)).sql;
          const reads = side === 'indexed';
          assert.equal((await sql('a name 0 under a declared object')).includes('"gx_w_0"'), reads);
          assert.equal((await sql('an index 0 under a declared array')).includes('"gx_a_0"'), reads);
          assert.equal((await sql('a name 0 against a number')).includes('"gx_n_0"'), false);
          assert.equal((await sql('an index 0 against a number')).includes('"gx_v_0"'), false);
        }
        finally {
          await store.close();
        }
      });
    }
  });
});

describe('a literal $get that feeds a string operator', () => {
  const rows = normalizeModel({ $model: '0.1', collections: { rows: { key: '/id', schema: { type: 'object', properties: {
    id: { type: 'string' }, s: { type: 'string' }, ns: { type: ['string', 'null'] }, m: { type: ['string', 'number'] } } } } } }).get('rows');
  const shape = { collection: 'rows', schema: rows.schema, columnByCanonical: new Map() };
  const planned = (/** @type {any} */ predicate) => planQuery({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' }, shape);

  it('is the member path over a member typed string alone, and stays with the engine over any member that can hold another kind', () => {
    const get = (/** @type {string} */ name) => ({ $get: ['$it', name] });
    assert.deepEqual(planned({ '$ends-with': [get('s'), 'a'] }).plan.filter, planned({ '$ends-with': ['$it.s', 'a'] }).plan.filter);
    for (const name of ['ns', 'm']) {
      const outcome = planned({ '$ends-with': [get(name), 'a'] });
      assert.equal(outcome.mode, 'set', name);
      assert.equal(reasonId(outcome.reasons[0].reason), 'predicate.stringSubject', name);
    }
  });

  const MIXED = { group: 'a union member', schema: { type: 'object', properties: { id: { type: 'string' }, m: { type: ['string', 'number'] } } },
    indexes: [], documents: [{ id: 'a', m: 'abc' }, { id: 'b', m: 5 }, { id: 'c', m: 'zzz' }, { id: 'd' }] };
  /** The engine raises on a subject that is no string, so the store raises as it does (and does not answer `a`, `c`). */
  const raises = async (/** @type {any} */ driver) => {
    const { store, collection } = await storeForGroup(MIXED, driver);
    try {
      const query = { $for: { it: '$[*]' }, $where: { '$ends-with': [{ $get: ['$it', 'm'] }, 'c'] }, $return: '$it.id' };
      await assert.rejects(async () => collection.execute(query, { pushdown: false }), (error) => /** @type {any} */ (error).code === 'JQ2001');
      await assert.rejects(async () => collection.execute(query), (error) => /** @type {any} */ (error).code === 'JQ2001');
    }
    finally {
      await store.close();
    }
  };

  it('node:sqlite: raises as the engine does', async () => {
    const { nodeDriver } = await import('@jarenjs/db/node');
    await raises(nodeDriver());
  });

  it('PostgreSQL: raises as the engine does', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: PG_URL });
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    const schema = `jaren_path_get_${process.pid}`;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await raises(postgresDriver(pool, { schema }));
    }
    finally {
      await pool.end().catch(() => {});
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
});
