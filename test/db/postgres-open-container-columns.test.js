//@ts-check
/**
 * @file A path whose container the schema leaves open, in what the database
 * itself stores. `#>` has one spelling for the array element `0` and the
 * object key `0`, so a generated column, an index expression and an
 * interval's CHECK over `$.u[0]` read the key `"0"` of an object where the
 * engine's path and SQLite read nothing: a conforming document whose open
 * container is an object keyed `"0"` collided in a unique index with the
 * array that holds the same element, and was read as a span by the CHECK
 * and by the store. The definition now reads such a path off the document
 * under the dialect's guard (an index step only off an array, a name that
 * reads as an index only off an object); a path whose containers the schema
 * declares keeps every byte unless it names a member the path text spells as
 * an index (postgres-digit-names.test.js), and a table an earlier release
 * created, which holds the unguarded definitions, opens as it did. The store's own read of
 * a span (`memberAt`) selects the same members on every engine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planCollection, planModelMigration, planMigration, migrate, normalizeModel, sqliteDialect, memberAt, expressionSql } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { readIntervalCheck } from '../../packages/db/src/dialects/check-read.js';

import { ENGINES, PG_URL, skipFor, withPostgres, withStore } from './store-core-engines.js';

const INT = { type: 'integer' };
const SPAN = { type: 'object', required: ['start', 'end'], properties: { start: INT, end: INT } };
const dialect = postgresDialect();

/** A collection with the given `u` schema, indexed by the given paths. @param {any} u @param {any[]} indexes */
const withU = (u, indexes) => ({ $model: '0.1', collections: { rows: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, u } }, indexes } } });
const U_INDEXES = [{ name: 'by_u0', path: '$.u[0]' }, { name: 'by_un', path: "$.u['0']" }];
/** The container `u` leaves open: an array's items and an object's member `0` are both integers. */
const OPEN_U = { items: INT, properties: { 0: INT } };
/** @param {any} model @param {any} [options] */
const planOf = (model, options = undefined, engine = dialect) => planCollection('rows', normalizeModel(model, options?.expressions).get('rows'), engine, options);

/** The guard an index step reads its parent under, and the one a name that reads as an index does. @param {'array' | 'object'} kind */
const guarded = (kind) => `(CASE WHEN jsonb_typeof(("doc" #> '{"u"}')) = '${kind}' THEN "doc" END)`;

describe('a generated column over a path that leaves a container open', () => {
  it('reads an index step off an array and a name that reads as an index off an object', () => {
    const plan = planOf(withU(OPEN_U, U_INDEXES));
    const read = (/** @type {'array' | 'object'} */ kind) => `${guarded(kind)} #> '{"u","0"}'`;
    assert.deepEqual(plan.createSql, [
      'CREATE TABLE "rows" ("key" text COLLATE "C" PRIMARY KEY, "doc" jsonb NOT NULL, "rid" bigserial, '
      + `"gx_u_0" numeric GENERATED ALWAYS AS ((CASE WHEN jsonb_typeof((${read('array')})) = 'number' THEN ((${read('array')}))::numeric END)) STORED, `
      + `"gx_u_0_2" numeric GENERATED ALWAYS AS ((CASE WHEN jsonb_typeof((${read('object')})) = 'number' THEN ((${read('object')}))::numeric END)) STORED)`,
      'CREATE INDEX "rows_by_u0" ON "rows" ("gx_u_0")',
      'CREATE INDEX "rows_by_un" ON "rows" ("gx_u_0_2")',
    ]);
    assert.deepEqual(plan.generated.map((column) => column.unpinned),
      [[{ name: 'u' }, { index: 0 }], [{ name: 'u' }, { name: '0' }]]);
  });

  it('keeps every byte of an index off a declared array, or where the dialect guards no step', () => {
    const declared = planOf(withU({ type: 'array', items: INT }, [U_INDEXES[0]]));
    assert.equal(declared.createSql[0],
      'CREATE TABLE "rows" ("key" text COLLATE "C" PRIMARY KEY, "doc" jsonb NOT NULL, "rid" bigserial, '
      + '"gx_u_0" numeric GENERATED ALWAYS AS ((CASE WHEN jsonb_typeof(("doc" #> \'{"u","0"}\')) = \'number\' '
      + 'THEN (("doc" #> \'{"u","0"}\'))::numeric END)) STORED)');
    assert.equal(declared.generated[0].unpinned, undefined);
    // a name the path text spells as an index is read off a declared object under the guard too, or it would read back as the index
    const named = planOf(withU({ type: 'object', properties: { 0: INT } }, [U_INDEXES[1]]));
    assert.deepEqual(named.generated[0].unpinned, [{ name: 'u' }, { name: '0' }]);
    // SQLite's path text tells a name from an index: its plan carries no guard at all
    const sqlite = planOf(withU(OPEN_U, U_INDEXES), undefined, sqliteDialect);
    assert.ok(sqlite.generated.every((/** @type {any} */ column) => column.unpinned === undefined));
    assert.ok(!sqlite.createSql[0].includes('CASE'));
  });

  it('is read back to the member path it is of, in this dialect\'s spelling and the server\'s', () => {
    const [array, object] = planOf(withU(OPEN_U, U_INDEXES)).generated;
    assert.deepEqual(dialect.memberPathOf(dialect.columnRead('"doc"', array)), [{ name: 'u' }, { index: 0 }]);
    // the guard says which kind of container a step is made in: an object's key is a name, however it spells
    assert.deepEqual(dialect.memberPathOf(dialect.columnRead('"doc"', object)), [{ name: 'u' }, { name: '0' }]);
    const deparsedName = "(\nCASE\n    WHEN (jsonb_typeof((doc #> '{u}'::text[])) = 'object'::text) THEN doc\n    ELSE NULL::jsonb\nEND #> '{u,0}'::text[])";
    assert.deepEqual(dialect.memberPathOf(deparsedName), [{ name: 'u' }, { name: '0' }]);
    // an unguarded digit stays an index, as it was written
    assert.deepEqual(dialect.memberPathOf(dialect.jsonExtract('"doc"', '{"u","0"}')), [{ name: 'u' }, { index: 0 }]);
    // the server's deparse of the typed column, guard and all
    const deparsed = "\nCASE\n    WHEN (jsonb_typeof((\n    CASE\n        WHEN (jsonb_typeof((doc #> '{s}'::text[])) = 'array'::text) THEN doc\n"
      + "        ELSE NULL::jsonb\n    END #> '{s,0,start}'::text[])) = 'number'::text) THEN ((\n    CASE\n        WHEN (jsonb_typeof((doc #> '{s}'::text[])) = 'array'::text) THEN doc\n"
      + "        ELSE NULL::jsonb\n    END #> '{s,0,start}'::text[]))::numeric\n    ELSE NULL::numeric\nEND";
    assert.deepEqual(dialect.memberPathOf(deparsed), [{ name: 's' }, { index: 0 }, { name: 'start' }]);
    // the guard is told from every other CASE this dialect writes, in both spellings
    assert.equal(dialect.memberGuarded(dialect.columnRead('"doc"', array)), true);
    assert.equal(dialect.memberGuarded(dialect.columnRead('"doc"', object)), true);
    assert.equal(dialect.memberGuarded(deparsed), true);
    const plain = planOf(withU({ type: 'array', items: INT }, [U_INDEXES[0]])).generated[0];
    assert.equal(dialect.memberGuarded(dialect.columnRead('"doc"', plain)), false);
    assert.equal(dialect.memberGuarded(dialect.jsonExtract('"doc"', '{"u","0"}', 'scalar')), false);
    assert.equal(dialect.memberGuarded('CASE WHEN (x = 1) THEN true ELSE false END'), false);
    assert.equal(dialect.memberGuarded('(CASE WHEN a THEN NULL END)'), false);
    assert.equal(dialect.memberGuarded(dialect.jsonExtract('"doc"', '{"u","0"}', 'text')), false);
    assert.equal(dialect.memberGuarded(dialect.jsonExtract('"doc"', '{"u","0"}')), false);
    assert.equal(dialect.memberGuarded("\nCASE\n    WHEN (jsonb_typeof((doc #> '{u,0}'::text[])) = 'number'::text) THEN ((doc #> '{u,0}'::text[]))::numeric\n    ELSE NULL::numeric\nEND"), false);
    // a guard that names a path of its own is not the member
    assert.deepEqual(dialect.memberPathOf(`${guarded('array')} #> '{"u","0","v"}'`), [{ name: 'u' }, { index: 0 }, { name: 'v' }]);
  });
});

describe('the expression compiler', () => {
  it('reads a member unguarded for a caller whose context names no guard', () => {
    const context = { docColumnSql: '"doc"', declarations: {}, registered: true, docPath: '/x',
      segmentsOf: () => [{ name: 'u' }, { index: 0 }] };
    assert.equal(expressionSql({ member: '$.u[0]' }, dialect, context), '("doc" #>> \'{"u","0"}\')');
    assert.equal(expressionSql({ member: '$.u[0]' }, dialect, { ...context, unpinnedOf: (/** @type {any} */ segments) => segments }),
      `(${guarded('array')} #>> '{"u","0"}')`);
  });
});

describe('an interval over a path that leaves a container open', () => {
  const model = (/** @type {any} */ s, span = '$.s[0]') => ({ $model: '0.1', collections: { rows: { key: '/id',
    schema: { type: 'object', properties: { id: { type: 'string' }, s } },
    indexes: [{ name: 'a', path: `${span}.start` }, { name: 'b', path: `${span}.end` }],
    intervals: [{ name: 'slot', path: span }] } } });
  const OPEN_S = { items: SPAN, properties: { 0: SPAN } };
  const spelling = dialect.intervalSpelling(true);
  const GUARD = "(CASE WHEN jsonb_typeof((\"doc\" #> '{\"s\"}')) = 'array' THEN \"doc\" END)";
  /** The server's deparse of the type test over the guarded span. */
  const DEPARSED = "jsonb_typeof((\nCASE\n    WHEN (jsonb_typeof((doc #> '{s}'::text[])) = 'array'::text) THEN doc\n    ELSE NULL::jsonb\nEND #> '{s,0}'::text[]))";

  it('reads the span off the guarded document, and the bounds off columns read the same way', () => {
    const plan = planOf(model(OPEN_S));
    const [interval] = plan.intervals;
    assert.deepEqual(interval.span.unpinned, [{ name: 's' }, { index: 0 }]);
    assert.ok(interval.sql.startsWith(`jsonb_typeof((${GUARD} #> '{"s","0"}')) IS NULL OR (jsonb_typeof((${GUARD} #> '{"s","0"}')) = 'object' AND `), interval.sql);
    assert.ok(plan.generated.every((/** @type {any} */ column) => column.unpinned !== undefined));
    // a declared container keeps the CHECK it always had
    const declared = planOf(model({ type: 'array', items: SPAN })).intervals[0];
    assert.ok(declared.sql.startsWith('jsonb_typeof(("doc" #> \'{"s","0"}\')) IS NULL OR (jsonb_typeof(("doc" #> \'{"s","0"}\')) = \'object\' AND '), declared.sql);
    assert.equal(declared.span.unpinned, undefined);
  });

  it('reads back as the declaration in every spelling it can be stored in, and as nothing else', () => {
    const [interval] = planOf(model(OPEN_S)).intervals;
    const unguarded = planOf(model({ type: 'array', items: SPAN })).intervals[0].sql;
    const read = (/** @type {string} */ sql) => readIntervalCheck(sql, spelling);
    const expected = { column: 'doc', span: [{ name: 's' }, { index: 0 }], start: 'gx_s_0_start', end: 'gx_s_0_end', maxDuration: null };
    assert.deepEqual(read(interval.sql), expected);
    // the server's deparse, and the unguarded text a table an earlier release made keeps
    assert.deepEqual(read(interval.sql.replaceAll(`(${GUARD} #> '{"s","0"}')`, DEPARSED.slice('jsonb_typeof('.length, -1))), expected);
    assert.deepEqual(read(unguarded), expected);
    // a guard other than the one the path calls for is not this CHECK
    // the other container is another path: a name step, which is not the declared index step
    assert.deepEqual(read(interval.sql.replaceAll("= 'array' THEN", "= 'object' THEN"))?.span, [{ name: 's' }, { name: '0' }]);
    assert.equal(read(interval.sql.replaceAll('{"s"}', '{"t"}')), null, 'another parent');
    assert.equal(read(interval.sql.replaceAll("= 'array' THEN", "= 'array' AND jsonb_typeof((\"doc\" #> '{\"s\"}')) = 'array' THEN")), null, 'a conjunct more');
    assert.equal(read(interval.sql.replaceAll("THEN \"doc\" END", 'THEN "doc" ELSE "doc" END')), null, 'a branch other than NULL');
  });

  it('reads a name that reads as an index off an object, and tells it from an index', () => {
    const [interval] = planOf(model({ properties: { 0: SPAN } }, "$.s['0']")).intervals;
    assert.deepEqual(interval.span.unpinned, [{ name: 's' }, { name: '0' }]);
    assert.ok(interval.sql.includes("= 'object' THEN"), interval.sql);
    const read = readIntervalCheck(interval.sql, dialect.intervalSpelling(true));
    assert.deepEqual(read?.span, [{ name: 's' }, { name: '0' }]);
  });
});

describe('the span the store reads from a document (memberAt)', () => {
  it('selects an index off an array and a name off an object, as the engine\'s path does', () => {
    const doc = { a: [{ k: 1 }], o: { 0: { k: 2 }, length: 3 }, s: 'text' };
    assert.deepEqual(memberAt(doc, [{ name: 'a' }, { index: 0 }, { name: 'k' }]), 1);
    assert.equal(memberAt(doc, [{ name: 'o' }, { index: 0 }]), undefined, 'an index is no object key');
    assert.deepEqual(memberAt(doc, [{ name: 'o' }, { name: '0' }]), { k: 2 });
    assert.equal(memberAt(doc, [{ name: 'a' }, { name: '0' }]), undefined, 'a name is no array element');
    assert.equal(memberAt(doc, [{ name: 'a' }, { name: 'length' }]), undefined, 'an array\'s length is no member');
    assert.equal(memberAt(doc, [{ name: 'o' }, { name: 'constructor' }]), undefined, 'an inherited name is no member');
    assert.equal(memberAt(doc, [{ name: 'o' }, { name: 'length' }]), 3);
    assert.equal(memberAt(doc, [{ name: 's' }, { index: 0 }]), undefined);
    assert.equal(memberAt(doc, []), doc);
  });

  for (const engine of ENGINES) {
    it(`${engine}: a document whose open container is an object keyed 0 holds no span there`, { skip: skipFor(engine) }, async () => {
      const model = { $model: '0.1', collections: { rows: { key: '/id',
        schema: { type: 'object', properties: { id: { type: 'string' }, s: { items: SPAN, properties: { 0: SPAN } } } },
        indexes: [{ name: 'a', path: '$.s[0].start' }, { name: 'b', path: '$.s[0].end' }],
        intervals: [{ name: 'slot', path: '$.s[0]' }] } } };
      await withStore(engine, model, async (store) => {
        const rows = store.collection('rows');
        // read as a span by the store and the CHECK before: [9, 3) is no half-open span
        await rows.insert({ id: 'object', s: { 0: { start: 9, end: 3 } } });
        await rows.insert({ id: 'array', s: [{ start: 1, end: 3 }] });
        await assert.rejects(rows.insert({ id: 'bad', s: [{ start: 9, end: 3 }] }), { code: 'JD2003' });
        assert.deepEqual((await rows.get('object'))?.s, { 0: { start: 9, end: 3 } });
      });
    });
  }
});

describe('a PostgreSQL table over paths that leave a container open', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  const expressions = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ v) => String(v).toLowerCase(), sql: 'lower' } };
  const model = { $model: '0.1', collections: { rows: { key: '/id',
    schema: { type: 'object', properties: { id: { type: 'string' }, u: OPEN_U, s: { items: SPAN, properties: { 0: SPAN } } } },
    indexes: [{ name: 'by_u0', path: '$.u[0]', unique: true }, { name: 'by_un', path: "$.u['0']", unique: true },
      { name: 'a', path: '$.s[0].start' }, { name: 'b', path: '$.s[0].end' },
      { name: 'by_x', unique: true, expression: { call: 'lower', args: [{ member: '$.u[0]' }] } }],
    intervals: [{ name: 'slot', path: '$.s[0]' }] } } };

  it('stores a conforming document under the index of the other container, and refuses what is the same member', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(model, { driver: driver(), expressions });
      try {
        const rows = store.collection('rows');
        await rows.insert({ id: 'array', u: [7] });
        // the same number under the key "0" of an object: no element 0, so no collision
        await rows.insert({ id: 'object', u: { 0: 7 } });
        await assert.rejects(rows.insert({ id: 'again', u: [7] }), { code: 'JD2005' });
        await assert.rejects(rows.insert({ id: 'named', u: { 0: 7 } }), { code: 'JD2005' });
        const { rows: columns } = await pool.query(`SELECT key, gx_u_0, gx_u_0_2 FROM "${schema}".rows ORDER BY rid`);
        assert.deepEqual(columns, [{ key: 'array', gx_u_0: '7', gx_u_0_2: null }, { key: 'object', gx_u_0: null, gx_u_0_2: '7' }]);
        // the expression index reads the same member
        await rows.insert({ id: 'e1', u: ['X'] });
        await rows.insert({ id: 'e2', u: { 0: 'x' } });
        await assert.rejects(rows.insert({ id: 'e3', u: ['x'] }), { code: 'JD2005' });
      }
      finally { await store.close(); }
    });
  });

  it('reopens clean, and reads back to the model it was declared by', async () => {
    await withPostgres(async ({ driver }) => {
      await (await openStore(model, { driver: driver(), expressions })).close();
      const store = await openStore(model, { driver: driver(), expressions });
      try {
        const { model: derived } = await store.introspect({ keys: { rows: '/id' }, expressions });
        assert.deepEqual(derived.collections.rows.indexes.map((/** @type {any} */ index) => index.name).sort(),
          ['a', 'b', 'by_u0', 'by_un', 'by_x']);
        assert.deepEqual(derived.collections.rows.indexes.find((/** @type {any} */ index) => index.name === 'by_x').expression,
          { call: 'lower', args: [{ member: '$.u[0]' }] });
        assert.deepEqual(derived.collections.rows.intervals, [{ name: 'slot', path: '$.s[0]' }]);
      }
      finally { await store.close(); }
    });
  });

  it('holds the CHECK to the spans an array holds and to none an object keyed 0 holds', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(model, { driver: driver(), expressions })).close();
      const put = (/** @type {string} */ key, /** @type {any} */ doc) =>
        pool.query(`INSERT INTO "${schema}".rows (key, doc) VALUES ($1, $2)`, [key, JSON.stringify(doc)]);
      // written around the store, so it is the table's CHECK that answers
      await put('object', { id: 'object', s: { 0: { start: 9, end: 3 } } });
      await put('array', { id: 'array', s: [{ start: 1, end: 3 }] });
      await assert.rejects(put('bad', { id: 'bad', s: [{ start: 9, end: 3 }] }), { code: '23514' });
      await assert.rejects(put('half', { id: 'half', s: [{ start: 1 }] }), { code: '23514' });
    });
  });

  /**
   * Replace the table a first open made by the one an earlier release wrote for the same model: every
   * member read off the document unguarded, and the interval's CHECK over the unguarded span.
   * @param {{ pool: any, schema: string, driver: () => any }} context
   * @param {any} [of] - the model, `model` unless given
   * @returns {Promise<{ check: string }>}
   */
  async function earlierTable({ pool, schema, driver }, of = model) {
    const plan = planOf(of, { expressions, registered: false });
    const q = dialect.quoteIdentifier;
    const earlier = plan.generated.map((/** @type {any} */ column) => `${q(column.name)} ${column.type}${column.type === 'text' ? ' COLLATE "C"' : ''} `
      + `GENERATED ALWAYS AS (${dialect.memberGuarded(column.expression ?? dialect.columnRead(q('doc'), column)) ? column.alternate : column.expression ?? dialect.columnRead(q('doc'), column)}) STORED`);
    const [interval] = plan.intervals;
    const check = interval === undefined ? '' : dialect.ddl.intervalCheck({ docColumn: 'doc', span: interval.span.pathText, bounds: interval.span.bounds,
      start: q(interval.start), end: q(interval.end), maxDuration: null });
    const create = `CREATE TABLE "rows" ("key" text COLLATE "C" PRIMARY KEY, "doc" jsonb NOT NULL, "rid" bigserial, ${earlier.join(', ')}`
      + `${interval === undefined ? '' : `, CONSTRAINT "slot_interval" CHECK (${check})`})`;
    assert.ok(earlier.every((text) => !text.includes('CASE WHEN jsonb_typeof(("doc" #> \'{"u"}\'))')) && !check.includes("= 'array' THEN"));
    // a first open creates the expression's function; the table it made is then replaced by the earlier one
    await (await openStore(of, { driver: driver(), expressions })).close();
    // the store's own connection reads the schema it is given; so does this one
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query('DROP TABLE rows');
      await client.query(create);
      for (const index of plan.createSql.slice(1)) await client.query(index);
    }
    finally { client.release(); }
    return { check };
  }

  it('opens a table an earlier release created with the definitions it wrote, and still refuses another', async () => {
    await withPostgres(async (context) => {
      const { pool, schema, driver } = context;
      const { check } = await earlierTable(context);
      const store = await openStore(model, { driver: driver(), expressions });
      try {
        const rows = store.collection('rows');
        await rows.insert({ id: 'a', u: [1], s: [{ start: 1, end: 2 }] });
        assert.deepEqual((await rows.get('a'))?.u, [1]);
      }
      finally { await store.close(); }
      // drift the guard does not excuse: another path, or another container's guard, is still drift
      await pool.query(`ALTER TABLE "${schema}".rows DROP CONSTRAINT slot_interval`);
      await pool.query(`ALTER TABLE "${schema}".rows ADD CONSTRAINT slot_interval CHECK (${check.replaceAll('{"s","0"}', '{"s","1"}')})`);
      await assert.rejects(openStore(model, { driver: driver(), expressions }), { code: 'JD0002' });
    });
  });

  it('plans from the model read off an earlier release\'s table what that release planned: no change to the columns', async () => {
    await withPostgres(async (context) => {
      // without the name over `0`, which a table that was never guarded reads back as an index (as it always did)
      const indexed = { ...model, collections: { rows: { ...model.collections.rows,
        indexes: model.collections.rows.indexes.filter((/** @type {any} */ index) => index.name !== 'by_un') } } };
      await earlierTable(context, indexed);
      const store = await openStore(indexed, { driver: context.driver(), expressions });
      let derived;
      try { derived = (await store.introspect({ keys: { rows: '/id' }, expressions })).model; }
      finally { await store.close(); }
      // the earlier table declares its containers (nothing in it is guarded), the model leaves them open
      assert.equal(derived.collections.rows.schema.properties.u.type, 'array');
      for (const [from, to] of [[derived, indexed], [indexed, derived]]) {
        const { migration } = planMigration(from, to, { dialect: postgresDialect(), expressions });
        assert.deepEqual(migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
      }
      await (await openStore(derived, { driver: context.driver(), expressions })).close();
    });
  });

  /** The columns a table holds in a schema: name and expression. @param {any} pool @param {string} schema */
  const columnsOf = async (pool, schema) => (await pool.query(
    'SELECT a.attname AS name, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS expression FROM pg_catalog.pg_attrdef d '
    + 'JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum '
    + "JOIN pg_catalog.pg_class t ON t.oid = d.adrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = 'rows' AND a.attname LIKE 'gx\\_%'",
    [schema])).rows;

  for (const [label, from, to] of /** @type {[string, any, any][]} */ ([
    ['a schema declares the container', withU(OPEN_U, [U_INDEXES[0]]), withU({ type: 'array', items: INT }, [U_INDEXES[0]])],
    ['a schema stops declaring it', withU({ type: 'array', items: INT }, [U_INDEXES[0]]), withU(OPEN_U, [U_INDEXES[0]])],
  ])) {
    it(`plans no column change when ${label}: the table is read either way and the store opens on it`, async () => {
      await withPostgres(async ({ pool, schema, driver }) => {
        const first = await openStore(from, { driver: driver() });
        try { await first.collection('rows').insert({ id: 'a', u: [5] }); }
        finally { await first.close(); }
        const { migration } = planMigration(from, to, { dialect: postgresDialect({ schema }) });
        assert.deepEqual(migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
        const held = await columnsOf(pool, schema);
        const store = await openStore(to, { driver: driver() });
        try {
          assert.deepEqual(await store.collection('rows').get('a'), { id: 'a', u: [5] });
          assert.deepEqual(await columnsOf(pool, schema), held);
          assert.deepEqual((await pool.query(`SELECT gx_u_0 FROM "${schema}".rows`)).rows, [{ gx_u_0: '5' }]);
        }
        finally { await store.close(); }
      });
    });
  }

  it('reads a lone index over a name that reads as an index back to the model that opens its table', async () => {
    const lone = withU(OPEN_U, [U_INDEXES[1]]);
    await withPostgres(async ({ driver }) => {
      await (await openStore(lone, { driver: driver() })).close();
      const source = await openStore(lone, { driver: driver() });
      let derived;
      try { derived = (await source.introspect({ keys: { rows: '/id' } })).model; }
      finally { await source.close(); }
      assert.deepEqual(derived.collections.rows.indexes, [{ name: 'by_un', path: '$.u["0"]' }]);
      assert.equal(derived.collections.rows.schema.properties.u.type, undefined);
      await (await openStore(derived, { driver: driver() })).close();
      const { migration } = planMigration(lone, derived, { dialect: postgresDialect() });
      assert.deepEqual(migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
    });
  });

  describe('the model read back from the catalog', () => {
    const STR = { type: 'string' };
    /** One path of each kind a guard can cover, over containers the schema leaves open or declares. @param {boolean} declared */
    const rtModel = (declared) => ({ $model: '0.1', collections: { rows: { key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' },
        u: declared ? { type: 'array', items: STR } : { items: STR },
        s: declared ? { type: 'array', items: SPAN } : { items: SPAN } } },
      indexes: [{ name: 'by_u0', path: '$.u[0]' }, { name: 'a', path: '$.s[0].start' }, { name: 'b', path: '$.s[0].end' },
        { name: 'by_x', expression: { call: 'lower', args: [{ member: '$.u[0]' }] } }],
      intervals: [{ name: 'slot', path: '$.s[0]' }] } } });

    for (const declared of [false, true]) {
      it(`${declared ? 'declares' : 'leaves open'} the containers it was declared with: the derived model opens the table and plans nothing`, async () => {
        const original = rtModel(declared);
        await withPostgres(async ({ driver }) => {
          await (await openStore(original, { driver: driver(), expressions })).close();
          const source = await openStore(original, { driver: driver(), expressions });
          let derived;
          try { derived = (await source.introspect({ keys: { rows: '/id' }, expressions })).model; }
          finally { await source.close(); }
          // the derived model opens the table it was read from, and plans no structural change to the original
          await (await openStore(derived, { driver: driver(), expressions })).close();
          const { migration } = planMigration(derived, original, { dialect: postgresDialect(), expressions });
          assert.deepEqual(migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
          // the containers it types are the ones the table was declared by
          const u = derived.collections.rows.schema.properties.u;
          assert.equal(u.type, declared ? 'array' : undefined);
        });
      });
    }
  });

  it('reopens a table whose interval is over a name that reads as an index, under an open container', async () => {
    const named = { $model: '0.1', collections: { rows: { key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, s: { properties: { 0: SPAN } } } },
      indexes: [{ name: 'a', path: "$.s['0'].start" }, { name: 'b', path: "$.s['0'].end" }],
      intervals: [{ name: 'slot', path: "$.s['0']" }] } } };
    await withPostgres(async ({ driver }) => {
      await (await openStore(named, { driver: driver() })).close();
      const store = await openStore(named, { driver: driver() });
      try {
        const rows = store.collection('rows');
        // an array holds no member named 0: no span there; an object does
        await rows.insert({ id: 'array', s: [{ start: 9, end: 3 }] });
        await assert.rejects(rows.insert({ id: 'bad', s: { 0: { start: 9, end: 3 } } }), { code: 'JD2003' });
        await rows.insert({ id: 'good', s: { 0: { start: 1, end: 3 } } });
      }
      finally { await store.close(); }
    });
  });

  describe('a model edit that moves a path between an index step and a name', () => {
    const unique = (/** @type {string} */ path, name = 'ix') => ({ name, path, unique: true });
    const OBJECT_U = { type: 'object', properties: { 0: INT } };
    /**
     * Create the table `from` declares, migrate it to `to` and open `to`. Resolves with the ddl steps the plan held and
     * what the migrated table answers for an array and for an object keyed 0 under the same number.
     * @param {any} from @param {any} to @param {boolean} [arrays] - whether the model admits an array under `u`
     */
    const moved = (from, to, arrays = true) => withPostgres(async ({ driver, schema }) => {
      await (await openStore(from, { driver: driver() })).close();
      const planned = planModelMigration(from, to, { dialect: postgresDialect({ schema }), id: 'move' });
      planned.migration.steps = planned.migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
      const steps = planned.migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl').length;
      assert.deepEqual((await migrate({ driver: driver() }, [planned.migration], { baseline: from, model: to, shadow: false })).applied, ['move']);
      const store = await openStore(to, { driver: driver() });
      try {
        const rows = store.collection('rows');
        const outcome = async (/** @type {string} */ id, /** @type {any} */ u) => {
          try { await rows.insert({ id, u }); return 'ok'; }
          catch (error) { return /** @type {any} */ (error).code; }
        };
        return { steps, array: arrays ? [await outcome('a1', [7]), await outcome('a2', [7])] : [], object: [await outcome('o1', { 0: 7 }), await outcome('o2', { 0: 7 })] };
      }
      finally { await store.close(); }
    });
    const INDEX_STEP = [unique('$.u[0]')];
    const NAME_STEP = [unique("$.u['0']")];

    it('rebuilds the column for the step the model now has: an index step reads arrays alone', async () => {
      const answer = await moved(withU(OPEN_U, NAME_STEP), withU(OPEN_U, INDEX_STEP));
      assert.ok(answer.steps > 0);
      assert.deepEqual([answer.array, answer.object], [['ok', 'JD2005'], ['ok', 'ok']]);
    });

    it('rebuilds the column for the step the model now has: a name reads objects alone', async () => {
      const answer = await moved(withU(OPEN_U, INDEX_STEP), withU(OPEN_U, NAME_STEP));
      assert.ok(answer.steps > 0);
      assert.deepEqual([answer.array, answer.object], [['ok', 'ok'], ['ok', 'JD2005']]);
    });

    it('rebuilds a column read for an array into the one a declared object reads', async () => {
      const answer = await moved(withU(OPEN_U, INDEX_STEP), withU(OBJECT_U, NAME_STEP), false);
      assert.ok(answer.steps > 0);
      assert.deepEqual(answer.object, ['ok', 'JD2005']);
    });

    for (const [label, keep, dropped] of /** @type {[string, any, any][]} */ ([
      ['the index over an index step', unique("$.u['0']", 'by_un'), unique('$.u[0]', 'by_u0')],
      ['the index over a name', unique('$.u[0]', 'by_u0'), unique("$.u['0']", 'by_un')],
    ])) {
      it(`keeps the index that stays readable when a model drops ${label} of the two`, async () => {
        const answer = await moved(withU(OPEN_U, [dropped, keep]), withU(OPEN_U, [keep]));
        const readsObjects = keep.name === 'by_un';
        assert.deepEqual(readsObjects ? answer.object : answer.array, ['ok', 'JD2005']);
        assert.deepEqual(readsObjects ? answer.array : answer.object, ['ok', 'ok']);
      });
    }

    it('moves the bound columns and the CHECK of an interval with its span', async () => {
      const span = (/** @type {string} */ path) => ({ $model: '0.1', collections: { rows: { key: '/id',
        schema: { type: 'object', properties: { id: { type: 'string' }, u: { items: SPAN, properties: { 0: SPAN } } } },
        indexes: [{ name: 'a', path: `${path}.start` }, { name: 'b', path: `${path}.end` }],
        intervals: [{ name: 'slot', path }] } } });
      await withPostgres(async ({ driver, schema }) => {
        const from = span('$.u[0]');
        const to = span("$.u['0']");
        const first = await openStore(from, { driver: driver() });
        try { await first.collection('rows').insert({ id: 'a', u: [{ start: 1, end: 2 }] }); }
        finally { await first.close(); }
        const planned = planModelMigration(from, to, { dialect: postgresDialect({ schema }), id: 'move' });
        planned.migration.steps = planned.migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
        assert.deepEqual((await migrate({ driver: driver() }, [planned.migration], { baseline: from, model: to, shadow: false })).applied, ['move']);
        const store = await openStore(to, { driver: driver() });
        try {
          const rows = store.collection('rows');
          await rows.insert({ id: 'o', u: { 0: { start: 1, end: 2 } } });
          await assert.rejects(rows.insert({ id: 'bad', u: { 0: { start: 9, end: 3 } } }), { code: 'JD2003' });
          // an array holds no member named 0: no span there
          await rows.insert({ id: 'arr', u: [{ start: 9, end: 3 }] });
        }
        finally { await store.close(); }
      });
    });
  });

  describe('the model read back from a table an earlier release created, over a name that reads as an index', () => {
    const named = (/** @type {any} */ u) => ({ $model: '0.1', collections: { rows: { key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, u } },
      indexes: [{ name: 'ix', expression: { call: 'lower', args: [{ member: "$.u['0']" }] } }] } } });
    for (const [label, u] of /** @type {[string, any][]} */ ([['open', {}], ['array', { type: 'array' }]])) {
      it(`plans what that release planned from an expression index (${label} container)`, async () => {
        const of = named(u);
        await withPostgres(async (context) => {
          await earlierTable(context, of);
          const store = await openStore(of, { driver: context.driver(), expressions });
          let derived;
          try { derived = (await store.introspect({ keys: { rows: '/id' }, expressions })).model; }
          finally { await store.close(); }
          const { migration } = planMigration(derived, of, { dialect: postgresDialect(), expressions });
          assert.deepEqual(migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
        });
      });
    }
  });

  describe('a declared interval arriving through a migration', () => {
    const OPEN_S = { items: SPAN, properties: { 0: SPAN } };
    const base = (/** @type {any[]} */ intervals) => ({ $model: '0.1', collections: { rows: { key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, s: OPEN_S } },
      indexes: [{ name: 'a', path: '$.s[0].start' }, { name: 'b', path: '$.s[0].end' }], intervals } } });
    /** @param {any} doc @returns {Promise<{ applied?: string[], code?: string }>} */
    const arrive = (doc) => withPostgres(async ({ schema, driver }) => {
      const from = base([]);
      const to = base([{ name: 'slot', path: '$.s[0]' }]);
      const first = await openStore(from, { driver: driver() });
      try { await first.collection('rows').insert(doc); }
      finally { await first.close(); }
      const planned = planModelMigration(from, to, { dialect: postgresDialect({ schema }), id: 'slot' });
      planned.migration.steps = planned.migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
      try { return { applied: (await migrate({ driver: driver() }, [planned.migration], { baseline: from, model: to, shadow: false })).applied }; }
      catch (error) { return { code: /** @type {any} */ (error).code }; }
    });

    it('counts the spans an array holds, and none an object keyed 0 holds', async () => {
      assert.deepEqual(await arrive({ id: 'object', s: { 0: { start: 9, end: 3 } } }), { applied: ['slot'] });
      assert.deepEqual(await arrive({ id: 'array', s: [{ start: 9, end: 3 }] }), { code: 'JD0021' });
    });
  });
});
