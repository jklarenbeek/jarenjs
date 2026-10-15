//@ts-check
/**
 * @file A member name PostgreSQL's path text spells as an array index. `#>`
 * reads `'{s,0}'` for the member `'0'` of an object and for the element `0`
 * of an array alike, and the catalog's read-back takes such an element for
 * the index. A generated column, an index expression and an interval CHECK
 * over a name `'0'` were written without a guard where the schema declares
 * the container an object, so `introspect()` read the path back as an index
 * (`$.s[0]`, `s` an array), an interval over it did not reopen (`JD0002`),
 * and a plan from a model that reads the name under the guard to the model
 * derived from the table rebuilt the column. Such a name is now read under
 * the object guard whatever the schema declares, and reads back as the name
 * it was declared as; a table an earlier release created keeps its unguarded
 * text until `planColumnUpgrade` rebuilds it. Queries over the path still
 * read the column. SQLite spells a name and an index apart, and is unchanged.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planCollection, planColumnUpgrade, planMigration, migrate, normalizeModel, sqliteDialect } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { readIntervalCheck } from '../../packages/db/src/dialects/check-read.js';

import { PG_URL, withPostgres } from './store-core-engines.js';

const INT = { type: 'integer' };
const SPAN = { type: 'object', required: ['start', 'end'], properties: { start: INT, end: INT } };
const dialect = postgresDialect();
/** A collection whose `s` is `s`, indexed over its span `span` (and the document's own member `'0'` where `root`). @param {any} s @param {string} span @param {{ interval?: boolean, root?: boolean }} [options] */
const modelOf = (s, span, { interval = true, root = true } = {}) => ({ $model: '0.1', collections: { rows: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, s, ...(root ? { 0: { type: 'string' } } : {}) } },
  indexes: [{ name: 'a', path: `${span}.start` }, { name: 'b', path: `${span}.end` }, ...(root ? [{ name: 'z', path: "$['0']" }] : [])],
  ...(interval ? { intervals: [{ name: 'slot', path: span }] } : {}) } } });
/** The container declared an object, the name `'0'` read off it. */
const OBJECT = modelOf({ type: 'object', properties: { 0: SPAN } }, "$.s['0']");
/** The container left open: the same definitions. */
const OPEN = modelOf({ properties: { 0: SPAN } }, "$.s['0']");
/** The container declared an array, the index `0` read off it. */
const ARRAY = modelOf({ type: 'array', items: SPAN }, '$.s[0]', { root: false });
/** @param {any} model @param {any} [engine] */
const planOf = (model, engine = dialect) => planCollection('rows', normalizeModel(model).get('rows'), engine);
const GUARD_S = '(CASE WHEN jsonb_typeof(("doc" #> \'{"s"}\')) = \'object\' THEN "doc" END)';
const GUARD_ROOT = '(CASE WHEN jsonb_typeof("doc") = \'object\' THEN "doc" END)';
/** A statement of OBJECT's plan without the guard, as an earlier release created it. @param {string} sql */
const unguarded = (sql) => sql.replaceAll(GUARD_S, '"doc"').replaceAll(GUARD_ROOT, '"doc"');
const DOCS = [{ id: 'x', s: { 0: { start: 1, end: 3 } }, 0: 'k' }, { id: 'y', s: { 0: { start: 4, end: 9 } } }, { id: 'n' }];
const QUERY = { $for: { it: '$[*]' }, $where: { $ge: ["$it.s['0'].start", 2] }, $return: '$it.id' };
/** Run a plan's statements in the schema. @param {any} pool @param {string} schema @param {string[]} statements */
const create = async (pool, schema, statements) => {
  const client = await pool.connect();
  try { await client.query(`SET search_path TO "${schema}"; ${statements.join('; ')}`); }
  finally {
    await client.query('RESET search_path');
    client.release();
  }
};
/** The DDL statements a plan between two models takes. @param {any} from @param {any} to */
const ddlSteps = (from, to) => planMigration(from, to, { dialect }).migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl');

describe('a member name PostgreSQL spells as an index, over a container the schema declares an object', () => {
  it('is read under the object guard by the generated column, the index expression and the interval CHECK, and reads back as the name', () => {
    const plan = planOf(OBJECT);
    assert.deepEqual(plan.createSql, planOf(OPEN).createSql, 'the open container\'s definitions');
    assert.deepEqual(plan.generated.map((/** @type {any} */ column) => [column.name, dialect.memberPathOf(dialect.columnRead('"doc"', column))]), [
      ['gx_s_0_start', [{ name: 's' }, { name: '0' }, { name: 'start' }]],
      ['gx_s_0_end', [{ name: 's' }, { name: '0' }, { name: 'end' }]],
      ['gx_0', [{ name: '0' }]],
    ]);
    assert.ok(plan.createSql[0].includes(`"gx_0" text COLLATE "C" GENERATED ALWAYS AS (((CASE WHEN jsonb_typeof((${GUARD_ROOT} #> '{"0"}')) = 'string'`), plan.createSql[0]);
    assert.deepEqual(readIntervalCheck(plan.intervals[0].sql, dialect.intervalSpelling(true))?.span, [{ name: 's' }, { name: '0' }]);
    // the unguarded text an earlier release wrote is the declared array's, and reads back as its index
    assert.deepEqual(unguarded(planOf(modelOf({ type: 'object', properties: { 0: SPAN } }, "$.s['0']", { root: false })).createSql.join(';')), planOf(ARRAY).createSql.join(';'));
    assert.deepEqual(readIntervalCheck(unguarded(plan.intervals[0].sql), dialect.intervalSpelling(true))?.span, [{ name: 's' }, { index: 0 }]);
    const expressions = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ v) => String(v).toLowerCase(), sql: 'lower' } };
    const expression = planCollection('rows', normalizeModel({ $model: '0.1', collections: { rows: { key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, w: { type: 'object', properties: { 0: { type: 'string' } } } } },
      indexes: [{ name: 'by_x', expression: { call: 'lower', args: [{ member: "$.w['0']" }] } }] } } }, expressions).get('rows'), dialect, { expressions });
    assert.equal(expression.generated[0].expression, 'jaren_x_lower(((CASE WHEN jsonb_typeof(("doc" #> \'{"w"}\')) = \'object\' THEN "doc" END) #>> \'{"w","0"}\'))');
  });

  it('keeps every byte of an index off a declared array, of a name no index spells and of SQLite\'s spelling', () => {
    assert.ok(!planOf(ARRAY).createSql[0].includes('CASE WHEN jsonb_typeof(("doc" #> \'{"s"}\'))'), planOf(ARRAY).createSql[0]);
    for (const name of ['00', '-1', ' 1', '1e2', 'zero']) {
      const plan = planOf(modelOf({ type: 'object', properties: { [name]: SPAN } }, `$.s[${JSON.stringify(name)}]`, { root: false }));
      assert.ok(!plan.createSql[0].includes(GUARD_S), `${JSON.stringify(name)}: ${plan.createSql[0]}`);
      assert.deepEqual(dialect.memberPathOf(dialect.columnRead('"doc"', plan.generated[0])), [{ name: 's' }, { name }, { name: 'start' }]);
    }
    const sqlite = planOf(OBJECT, sqliteDialect);
    assert.ok(sqlite.generated.every((/** @type {any} */ column) => column.unpinned === undefined));
    assert.ok(!sqlite.createSql[0].includes('CASE WHEN json_type'), sqlite.createSql[0]);
  });
});

describe('a PostgreSQL table over such a name', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('reopens, introspects to the names it was declared with, and the round trip plans nothing', () => withPostgres(async ({ driver }) => {
    const store = await openStore(OBJECT, { driver: driver() });
    try { for (const doc of DOCS) await store.collection('rows').insert(doc); }
    finally { await store.close(); }
    const reopened = await openStore(OBJECT, { driver: driver() });
    let derived;
    try {
      assert.deepEqual([await reopened.collection('rows').execute(QUERY)].flat(), ['y']);
      assert.deepEqual([await reopened.collection('rows').execute(QUERY, { pushdown: false })].flat(), ['y']);
      assert.equal((await reopened.collection('rows').explain(QUERY)).mode, 'native');
      ({ model: derived } = await reopened.introspect({ keys: { rows: '/id' } }));
    }
    finally { await reopened.close(); }
    const rows = derived.collections.rows;
    assert.deepEqual(rows.indexes.map((/** @type {any} */ index) => index.path).sort(), ['$.s["0"].end', '$.s["0"].start', '$["0"]']);
    assert.deepEqual(rows.intervals.map((/** @type {any} */ interval) => interval.path), ['$.s["0"]']);
    assert.notEqual(rows.schema.properties.s.type, 'array');
    assert.notEqual(rows.schema.type, 'array');
    for (const [from, to] of [[OBJECT, derived], [OPEN, derived], [derived, OBJECT]]) assert.deepEqual(ddlSteps(from, to), []);
    const fromDerived = await openStore(derived, { driver: driver() });
    try { assert.deepEqual(await fromDerived.collection('rows').get('x'), DOCS[0]); }
    finally { await fromDerived.close(); }
  }));

  it('a table an earlier release created opens as it did, and planColumnUpgrade rebuilds it to the guarded definitions, after which it reopens and reads back the names', () => withPostgres(async ({ pool, schema, driver }) => {
    const plan = planOf(OBJECT);
    await create(pool, schema, plan.createSql.map(unguarded));
    const indexOnly = modelOf({ type: 'object', properties: { 0: SPAN } }, "$.s['0']", { interval: false });
    // its indexes open as they did; its interval CHECK, read as the index, did not and does not
    const before = await openStore(indexOnly, { driver: driver(), adopt: true }).catch((/** @type {any} */ error) => error);
    assert.equal(before?.code, undefined, String(before?.message));
    await before.close();
    await assert.rejects(async () => openStore(OBJECT, { driver: driver() }), { code: 'JD0002', message: /CHECK 'slot_interval'/ });
    const upgradeOn = async () => {
      const connection = await driver().open();
      try { return await planColumnUpgrade(connection, OBJECT); }
      finally { await connection.close(); }
    };
    const { migration, report } = await upgradeOn();
    assert.deepEqual(report.upgraded, ['rows.gx_s_0_start', 'rows.gx_s_0_end', 'rows.gx_0', 'rows.slot_interval']);
    assert.deepEqual((await migrate({ driver: driver() }, [migration], { baseline: OBJECT, model: OBJECT, shadow: false })).applied, [migration.id]);
    const store = await openStore(OBJECT, { driver: driver() });
    try {
      for (const doc of DOCS) await store.collection('rows').insert(doc);
      assert.deepEqual([await store.collection('rows').execute(QUERY)].flat(), ['y']);
      const { model: derived } = await store.introspect({ keys: { rows: '/id' } });
      assert.deepEqual(derived.collections.rows.intervals.map((/** @type {any} */ interval) => interval.path), ['$.s["0"]']);
    }
    finally { await store.close(); }
    const again = await upgradeOn();
    assert.deepEqual([again.migration.steps, again.report.upgraded], [[], []]);
  }));
});
