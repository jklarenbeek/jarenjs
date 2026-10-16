//@ts-check
/**
 * @file A declared index over a member of several scalar kinds on
 * PostgreSQL. The member's generated column holds its first type (a
 * `numeric` column for `['number', 'string']`), so a comparison of another
 * kind reads the member out of the document at that kind. Beside the
 * declared index the store creates one index per other kind over exactly
 * that read (`c_by_q$text`), so the server seeks it; the statement is the
 * same with or without it, so a table an earlier release created, which has
 * none, answers as before until `planColumnUpgrade` adds them. Every answer
 * equals the query engine's (`pushdown: false`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, introspectModel, planCollection, planColumnUpgrade, planMigration, migrate, normalizeModel, sqliteDialect } from '@jarenjs/db';
import { postgresDialect, postgresDriver } from '@jarenjs/db/postgres';

import { PG_URL, withPostgres } from './store-core-engines.js';

const dialect = postgresDialect();
/** @param {Record<string, any>} properties @param {any[]} indexes */
const modelOf = (properties, indexes) => ({ $model: '0.1', collections: { c: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, ...properties } }, indexes } } });
const MODEL = modelOf({ q: { type: ['number', 'string'] }, r: { type: ['string', 'number', 'boolean', 'null'] } },
  [{ name: 'by_q', path: '$.q', unique: true }, { name: 'by_r', path: '$.r' }]);
/** @param {any} model @param {any} [engine] */
const planOf = (model, engine = dialect) => planCollection('c', normalizeModel(model).get('c'), engine);
const TEXT_Q = `CREATE INDEX "c_by_q$text" ON "c" (((CASE WHEN jsonb_typeof(("doc" #> '{"q"}')) = 'string' THEN "doc" #>> '{"q"}' END) COLLATE "C"))`;
const NUMBER_R = `CREATE INDEX "c_by_r$number" ON "c" ((CASE WHEN jsonb_typeof(("doc" #> '{"r"}')) = 'number' THEN (("doc" #> '{"r"}'))::numeric END))`;
const BOOLEAN_R = `CREATE INDEX "c_by_r$boolean" ON "c" ((CASE WHEN jsonb_typeof(("doc" #> '{"r"}')) = 'boolean' THEN (CASE WHEN (("doc" #> '{"r"}'))::boolean THEN 1 ELSE 0 END) END))`;
/** The statements a table an earlier release created for a model: none of the indexes beside. @param {any} model */
const earlierSql = (model) => planOf(model).createSql.filter((/** @type {string} */ sql) => !/^CREATE INDEX "[^"]*\$/.test(sql));

describe('the index beside a declared index over a member of several kinds', () => {
  it('is planned once per other kind, over the read a comparison of that kind spells, and never unique', () => {
    const plan = planOf(MODEL);
    assert.deepEqual(plan.createSql.slice(-3), [TEXT_Q, NUMBER_R, BOOLEAN_R]);
    assert.deepEqual(plan.kindIndexes.map((/** @type {any} */ index) => [index.name, index.of, index.kind]),
      [['c_by_q$text', 'c_by_q', 'text'], ['c_by_r$number', 'c_by_r', 'number'], ['c_by_r$boolean', 'c_by_r', 'boolean']]);
    // apart from the declared indexes, which key columns
    assert.deepEqual(plan.expected.indexes.map((/** @type {any} */ index) => index.name), ['c_by_q', 'c_by_r']);
  });

  it('is not planned where the read is one kind, a composite, a condition, a guarded step or an engine with untyped columns', () => {
    const none = [
      modelOf({ q: { type: ['integer', 'number', 'null'] } }, [{ name: 'by_q', path: '$.q' }]),
      modelOf({ q: { type: ['string', 'object', 'array'] } }, [{ name: 'by_q', path: '$.q' }]),
      modelOf({ q: { type: ['number', 'string'] }, k: { type: 'string' } }, [{ name: 'by_qk', path: ['$.q', '$.k'] }]),
      modelOf({ q: { type: ['number', 'string'] }, k: { type: 'string' } }, [{ name: 'by_k', path: '$.k' }, { name: 'by_q', path: '$.q', where: { $eq: ['$.k', 'x'] } }]),
      modelOf({ u: { items: { type: ['number', 'string'] } } }, [{ name: 'by_u', path: '$.u[0]' }]),
    ];
    for (const model of none) assert.deepEqual(planOf(model).kindIndexes, [], JSON.stringify(model.collections.c.indexes));
    const sqlite = planOf(MODEL, sqliteDialect);
    assert.deepEqual([sqlite.kindIndexes, sqlite.createSql.filter((/** @type {string} */ sql) => /^CREATE INDEX "[^"]*\$/.test(sql))], [[], []]);
  });

  it('takes a name no declared index or collection can, kept within the 63 bytes of an identifier', () => {
    const long = 'i'.repeat(58);
    const plan = planCollection('c', normalizeModel(modelOf({ q: { type: ['number', 'string'] } }, [{ name: long, path: '$.q' }])).get('c'), dialect);
    const [name] = plan.kindIndexes.map((/** @type {any} */ index) => index.name);
    assert.match(name, /^c_i+\$text_[0-9a-z]+$/);
    assert.ok(Buffer.byteLength(name) <= 63, name);
    assert.ok(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(planOf(MODEL).kindIndexes[0].name));
  });
});

describe('the key an index beside holds, read back', () => {
  // the server deparses one key of an index without its collation (`pg_get_indexdef(oid, 1, false)`)
  const TEXT_KEY = "(\nCASE\n    WHEN (jsonb_typeof((doc #> '{q}'::text[])) = 'string'::text) THEN (doc #>> '{q}'::text[])\n    ELSE NULL::text\nEND)";
  const planned = (/** @type {string} */ member, /** @type {string} */ kind) => dialect.jsonExtract('"doc"', dialect.jsonPathText([{ name: member }]), kind);
  it('is the planned read with its collation set aside, and nothing else', () => {
    assert.equal(dialect.readBack.indexKey(TEXT_KEY, planned('q', 'text'), true), null);
    assert.match(String(dialect.readBack.indexKey(TEXT_KEY, planned('r', 'text'), true)), /^keys /);
    assert.match(String(dialect.readBack.indexKey(TEXT_KEY, planned('q', 'number'), true)), /^keys /);
  });
});

describe('a link between two models', () => {
  const NUMBER = modelOf({ q: { type: 'number' } }, [{ name: 'by_q', path: '$.q' }]);
  const UNION = modelOf({ q: { type: ['number', 'string'] } }, [{ name: 'by_q', path: '$.q' }]);
  const BARE = modelOf({ q: { type: ['number', 'string'] } }, []);
  /** @param {any} from @param {any} to */
  const ddl = (from, to) => planMigration(from, to, { dialect }).migration.steps
    .filter((/** @type {any} */ step) => step.kind === 'ddl').map((/** @type {any} */ step) => step.sql);

  it('creates the index beside one it creates, and drops it with one it drops or where the member no longer holds the kind', () => {
    assert.deepEqual(ddl(BARE, UNION), [`ALTER TABLE "c" ADD COLUMN "gx_q" numeric GENERATED ALWAYS AS ((CASE WHEN jsonb_typeof(("doc" #> '{"q"}')) = 'number' THEN (("doc" #> '{"q"}'))::numeric END)) STORED`,
      'CREATE INDEX "c_by_q" ON "c" ("gx_q")', TEXT_Q]);
    assert.deepEqual(ddl(UNION, BARE), ['DROP INDEX "c_by_q"', 'DROP INDEX IF EXISTS "c_by_q$text"', 'ALTER TABLE "c" DROP COLUMN "gx_q"']);
    assert.deepEqual(ddl(UNION, NUMBER), ['DROP INDEX IF EXISTS "c_by_q$text"']);
  });

  it('plans nothing where the declared index stays: a table given the kind so is upgraded by planColumnUpgrade', () => {
    assert.deepEqual(ddl(NUMBER, UNION), []);
  });

  it('renames a collection with the index beside under the new name', () => {
    const renamed = { $model: '0.1', collections: { d: { ...UNION.collections.c, 'x-rename': 'c' } } };
    assert.deepEqual(ddl(UNION, renamed), ['ALTER TABLE "c" RENAME TO "d"', 'DROP INDEX "c_by_q"', 'DROP INDEX IF EXISTS "c_by_q$text"',
      'CREATE INDEX "d_by_q" ON "d" ("gx_q")', TEXT_Q.replaceAll('"c', '"d')]);
  });
});

describe('a PostgreSQL store over a member of several kinds', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  const DOCS = [{ id: 'a', q: 1, r: 'x' }, { id: 'b', q: 'b', r: 2 }, { id: 'c', q: 2.5, r: null }, { id: 'd', q: 'a', r: true },
    { id: 'e', q: '1', r: '2' }, { id: 'f' }, { id: 'g', q: 'bb', r: 2.0 }];
  /** @param {any} where */
  const query = (where) => ({ $for: { it: '$[*]' }, $where: where, $return: '$it.id' });
  const QUERIES = {
    textEq: [query({ $eq: ['$it.q', 'b'] }), 'b'],
    textGt: [query({ $gt: ['$it.q', 'a'] }), ['b', 'g']],
    textIn: [query({ $eq: ['$it.q', { $seq: ['a', '1'] }] }), ['d', 'e']],
    numberEq: [query({ $eq: ['$it.r', 2] }), ['b', 'g']],
    numberLt: [query({ $lt: ['$it.r', 5] }), ['b', 'g']],
    firstKind: [query({ $ge: ['$it.q', 1] }), ['a', 'c']],
  };
  /** Each query's native answer beside the engine's and the expected one. @param {any} store */
  const answers = async (store) => {
    const rows = store.collection('c');
    for (const [name, [q, expected]] of Object.entries(QUERIES)) {
      const native = await rows.execute(q);
      assert.deepEqual(native, await rows.execute(q, { pushdown: false }), `${name}: the native answer is the engine's`);
      assert.deepEqual(native, expected, name);
      assert.equal((await rows.explain(q)).mode, 'native', name);
    }
  };
  /** The index the server seeks for a text comparison of `q`. @param {any} context @param {any} store */
  const seeks = async ({ pool, schema }, store) => {
    const { sql } = await store.collection('c').explain(QUERIES.textEq[0]);
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query('SET enable_seqscan = off');
      const plan = (await client.query({ text: `EXPLAIN ${sql}`, values: ['b'] })).rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n');
      return /Index Scan (on|using) "c_by_q\$text"/.test(plan);
    }
    finally { client.release(); }
  };
  /** @param {any} context */
  const indexNames = async ({ pool, schema }) => (await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`, [schema])).rows
    .map((/** @type {any} */ row) => row.indexname);

  it('seeks the index beside for a comparison of another kind, reopens, and answers as the engine', () => withPostgres(async (context) => {
    let store = await openStore(MODEL, { driver: context.driver() });
    try { for (const doc of DOCS) await store.collection('c').insert(doc); }
    finally { await store.close(); }
    store = await openStore(MODEL, { driver: context.driver() });
    try {
      await answers(store);
      assert.equal(await seeks(context, store), true);
      // never unique: a second string the declared unique index does not key is stored
      await store.collection('c').insert({ id: 'h', q: 'b' });
    }
    finally { await store.close(); }
    assert.deepEqual(await indexNames(context), ['c_by_q', 'c_by_q$text', 'c_by_r', 'c_by_r$boolean', 'c_by_r$number', 'c_pkey']);
  }));

  it('opens a table an earlier release created as it was, and planColumnUpgrade adds the indexes beside, through a shadow', () => withPostgres(async (context) => {
    await (await openStore(MODEL, { driver: context.driver() })).close();
    const client = await context.pool.connect();
    try {
      await client.query(`SET search_path TO "${context.schema}"`);
      await client.query('DROP TABLE c');
      for (const sql of earlierSql(MODEL)) await client.query(sql);
    }
    finally { client.release(); }
    let store = await openStore(MODEL, { driver: context.driver() });
    try {
      for (const doc of DOCS) await store.collection('c').insert(doc);
      await answers(store);
      assert.equal(await seeks(context, store), false);
    }
    finally { await store.close(); }
    const upgradeOf = async () => {
      const connection = await context.driver().open();
      try { return await planColumnUpgrade(connection, MODEL); }
      finally { await connection.close(); }
    };
    const { migration, report } = await upgradeOf();
    assert.deepEqual(report.upgraded, ['c.c_by_q$text', 'c.c_by_r$number', 'c.c_by_r$boolean']);
    assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql), [TEXT_Q, NUMBER_R, BOOLEAN_R]);
    // replayed on a shadow first, whose baseline is built as an earlier release created it
    const shadow = `${context.schema}_shadow`;
    await context.pool.query(`CREATE SCHEMA "${shadow}"`);
    try {
      assert.deepEqual((await migrate({ driver: context.driver() }, [migration],
        { baseline: MODEL, model: MODEL, shadowDriver: postgresDriver(context.pool, { schema: shadow }) })).applied, [migration.id]);
    }
    finally { await context.pool.query(`DROP SCHEMA "${shadow}" CASCADE`); }
    const again = await upgradeOf();
    assert.deepEqual([again.migration.steps, again.report.upgraded], [[], []], 'the two-run check');
    store = await openStore(MODEL, { driver: context.driver() });
    try {
      await answers(store);
      assert.equal(await seeks(context, store), true);
    }
    finally { await store.close(); }
  }));

  it('reads the kinds back from the indexes beside, so the model read back reopens the table and plans no index', () => withPostgres(async (context) => {
    await (await openStore(MODEL, { driver: context.driver() })).close();
    const store = await openStore(MODEL, { driver: context.driver() });
    let derived, report;
    try { ({ model: derived, report } = await store.introspect({ keys: { c: '/id' } })); }
    finally { await store.close(); }
    const { properties } = derived.collections.c.schema;
    assert.deepEqual([properties.q.type, properties.r.type], [['number', 'string'], ['string', 'number', 'boolean']]);
    assert.deepEqual(derived.collections.c.indexes, [{ name: 'by_q', path: '$.q', unique: true }, { name: 'by_r', path: '$.r' }]);
    assert.deepEqual(report.filter((/** @type {any} */ row) => row.object.includes('$')), []);
    const reopened = await openStore(derived, { driver: context.driver() });
    await reopened.close();
    for (const [from, to] of [[MODEL, derived], [derived, MODEL]]) {
      assert.deepEqual(planMigration(from, to, { dialect: postgresDialect({ schema: context.schema }) }).migration.steps
        .filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
    }
  }));

  it('refuses an index under the name beside that keys another read, or is unique, and reads neither back as a kind', () => withPostgres(async (context) => {
    for (const [label, sql] of [
      ['another member', `CREATE INDEX "c_by_q$text" ON c (((CASE WHEN jsonb_typeof(("doc" #> '{"r"}')) = 'string' THEN "doc" #>> '{"r"}' END) COLLATE "C"))`],
      ['unique', TEXT_Q.replace('CREATE INDEX', 'CREATE UNIQUE INDEX')],
    ]) {
      await (await openStore(MODEL, { driver: context.driver() })).close();
      await context.pool.query(`SET search_path TO "${context.schema}"; DROP INDEX "c_by_q$text"; ${sql}`);
      const refused = await openStore(MODEL, { driver: context.driver() })
        .then(async (/** @type {any} */ store) => { await store.close(); return null; }, (/** @type {any} */ error) => error);
      assert.equal(refused?.code, 'JD0002', label);
      assert.ok(refused.message.includes("index 'c_by_q$text'"), refused.message);
      // nor is it read back as a kind of the member: it is an index the model cannot name
      const connection = await context.driver().open();
      try {
        const { model: read, report } = await introspectModel(connection, { keys: { c: '/id' } });
        assert.equal(read.collections.c.schema.properties.q.type, 'number', label);
        assert.deepEqual(report.filter((/** @type {any} */ row) => row.object === 'c.c_by_q$text').map((/** @type {any} */ row) => row.code), ['unmapped-index'], label);
      }
      finally { await connection.close(); }
      await context.pool.query(`SET search_path TO "${context.schema}"; DROP TABLE c`);
    }
  }));
});
