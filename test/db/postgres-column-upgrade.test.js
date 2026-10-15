//@ts-check
/**
 * @file `planColumnUpgrade` on PostgreSQL: a table an earlier release
 * created, or one whose model later stopped declaring a container, holds the
 * generated columns, index expression and interval CHECK of a path that
 * leaves a container open without the guard a fresh table reads them under,
 * so a conforming document of the other container kind collides in a unique
 * index or is read as a span by the CHECK (`JD2005`). A plan between two
 * models accepts either spelling and plans nothing; the upgrade reads the
 * catalog, rebuilds exactly the definitions that differ from what a fresh
 * store creates, keeps every row and answer, and plans nothing after.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planColumnUpgrade, planMigration, migrate, planCollection, normalizeModel } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { readIntervalGuards } from '../../packages/db/src/dialects/check-read.js';
import { columnExpression } from '../../packages/db/src/ddl.js';

import { PG_URL, withPostgres } from './store-core-engines.js';

const INT = { type: 'integer' };
const SPAN = { type: 'object', required: ['start', 'end'], properties: { start: INT, end: INT } };
const expressions = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ v) => String(v).toLowerCase(), sql: 'lower' } };
/** @param {any} u @param {any} s */
const modelOf = (u, s) => ({ $model: '0.1', collections: { rows: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, u, s, w: { items: { type: 'string' } } } },
  indexes: [{ name: 'by_u0', path: '$.u[0]', unique: true }, { name: 'a', path: '$.s[0].start' }, { name: 'b', path: '$.s[0].end' },
    { name: 'by_x', unique: true, expression: { call: 'lower', args: [{ member: '$.w[0]' }] } }],
  intervals: [{ name: 'slot', path: '$.s[0]' }] } } });
const OPEN = modelOf({ items: INT, properties: { 0: INT } }, { items: SPAN, properties: { 0: SPAN } });
const DECLARED = modelOf({ type: 'array', items: INT }, { type: 'array', items: SPAN });

/** A number read off the document unguarded, as an earlier release wrote it. @param {string} path */
const number = (path) => `(CASE WHEN jsonb_typeof(("doc" #> '${path}')) = 'number' THEN (("doc" #> '${path}'))::numeric END)`;
const BOUNDS = '"gx_s_0_start" IS NOT NULL AND "gx_s_0_end" IS NOT NULL AND "gx_s_0_start" = trunc("gx_s_0_start") AND "gx_s_0_end" = trunc("gx_s_0_end") '
  + 'AND "gx_s_0_start" BETWEEN -9007199254740991 AND 9007199254740991 AND "gx_s_0_end" BETWEEN -9007199254740991 AND 9007199254740991 '
  + 'AND "gx_s_0_start" < "gx_s_0_end"';
/** The table an earlier release created for OPEN (and still creates for DECLARED, but for its expression index). */
const EARLIER = [
  'CREATE TABLE "rows" ("key" text COLLATE "C" PRIMARY KEY, "doc" jsonb NOT NULL, "rid" bigserial, '
  + `"gx_u_0" numeric GENERATED ALWAYS AS (${number('{"u","0"}')}) STORED, `
  + `"gx_s_0_start" numeric GENERATED ALWAYS AS (${number('{"s","0","start"}')}) STORED, `
  + `"gx_s_0_end" numeric GENERATED ALWAYS AS (${number('{"s","0","end"}')}) STORED, `
  + '"gx_lower_w_0_x" text COLLATE "C" GENERATED ALWAYS AS (lower(("doc" #>> \'{"w","0"}\'))) STORED, '
  + `CONSTRAINT "slot_interval" CHECK (jsonb_typeof(("doc" #> '{"s","0"}')) IS NULL OR (jsonb_typeof(("doc" #> '{"s","0"}')) = 'object' AND ${BOUNDS})))`,
  'CREATE UNIQUE INDEX "rows_by_u0" ON "rows" ("gx_u_0")',
  'CREATE INDEX "rows_a" ON "rows" ("gx_s_0_start")',
  'CREATE INDEX "rows_b" ON "rows" ("gx_s_0_end")',
  'CREATE UNIQUE INDEX "rows_by_x" ON "rows" ("gx_lower_w_0_x")',
];
const DOCS = [{ id: 'a', u: [1], s: [{ start: 1, end: 2 }], w: ['X'] }, { id: 'b', u: [2], s: [{ start: 3, end: 5 }], w: ['y'] }, { id: 'c' }];
const where = (/** @type {any} */ predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' });
const PREDICATES = [{ $eq: ['$it.u[0]', 1] }, { $ge: ['$it.s[0].start', 2] }, { $exists: '$it.w[0]' }];
/** The documents of the other container kind that conform to OPEN beside DOCS. */
const OTHER_KIND = [{ id: 'o', s: { 0: { start: 9, end: 3 } } }, { id: 'k', u: { 0: 1 } }, { id: 'e', w: { 0: 'x' } }];

describe('the guard an interval CHECK reads its span under', () => {
  const dialect = postgresDialect();
  /** @param {any} model */
  const intervalOf = (model) => planCollection('rows', normalizeModel(model, expressions).get('rows'), dialect, { expressions }).intervals[0];
  const spelling = dialect.intervalSpelling(true);
  it('reads guarded, unguarded, both and neither', () => {
    const open = intervalOf(OPEN);
    assert.deepEqual(readIntervalGuards(open.sql, spelling), new Set([true]));
    assert.deepEqual(readIntervalGuards(open.alternate, spelling), new Set([false]));
    assert.deepEqual(readIntervalGuards(intervalOf(DECLARED).sql, spelling), new Set([false]));
    // one conjunct guarded, the other not: still the declaration, under both flags
    const at = open.sql.indexOf(' OR ');
    assert.deepEqual(readIntervalGuards(open.alternate.slice(0, open.alternate.indexOf(' OR ')) + open.sql.slice(at), spelling), new Set([false, true]));
    assert.equal(readIntervalGuards('"gx_s_0_start" > 0', spelling), null);
  });
});

describe('planColumnUpgrade on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  /** The generated columns' expressions and the CHECKs of the table, as the server deparses them. @param {any} pool @param {string} schema */
  const definitions = async (pool, schema) => ({
    columns: (await pool.query('SELECT a.attname AS name, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS expression FROM pg_catalog.pg_attrdef d '
      + 'JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum JOIN pg_catalog.pg_class t ON t.oid = d.adrelid '
      + "JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = 'rows' AND a.attname LIKE 'gx\\_%' ORDER BY 1",
    [schema])).rows,
    checks: (await pool.query('SELECT c.conname AS name, pg_catalog.pg_get_constraintdef(c.oid) AS definition FROM pg_catalog.pg_constraint c '
      + "JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND c.contype = 'c' ORDER BY 1", [schema])).rows,
  });
  /** @param {{ pool: any, schema: string, driver: () => any }} context @param {any} model */
  const upgradeOf = async ({ driver }, model) => {
    const connection = await driver().open();
    try { return await planColumnUpgrade(connection, model, { expressions }); }
    finally { await connection.close(); }
  };
  /** Each predicate's answer, and every document. @param {{ driver: () => any }} context @param {any} model */
  const answers = async ({ driver }, model) => {
    const store = await openStore(model, { driver: driver(), expressions });
    try {
      const rows = store.collection('rows');
      const out = [];
      for (const predicate of PREDICATES) out.push(await rows.execute(where(predicate)));
      return [...out, await rows.execute({ $for: { it: '$[*]' }, $return: '$it' })];
    }
    finally { await store.close(); }
  };
  /** What each document of the other kind answers on insert. @param {{ driver: () => any }} context @param {any} model */
  const otherKind = async ({ driver }, model) => {
    const store = await openStore(model, { driver: driver(), expressions });
    try {
      const out = [];
      for (const doc of OTHER_KIND) out.push(await store.collection('rows').insert(doc).then(() => 'stored', (error) => error.code));
      return out;
    }
    finally { await store.close(); }
  };
  /** Open `model` once (the expression's function, the metadata), then put DOCS in. @param {any} context @param {any} model */
  const created = async ({ driver }, model) => {
    const store = await openStore(model, { driver: driver(), expressions });
    try { for (const doc of DOCS) await store.collection('rows').insert(doc); }
    finally { await store.close(); }
  };
  /** The table an earlier release created for OPEN, holding DOCS. @param {any} context */
  const earlier = async (context) => {
    await (await openStore(OPEN, { driver: context.driver(), expressions })).close();
    const client = await context.pool.connect();
    try {
      await client.query(`SET search_path TO "${context.schema}"`);
      await client.query('DROP TABLE rows');
      for (const sql of EARLIER) await client.query(sql);
    }
    finally { client.release(); }
    const store = await openStore(OPEN, { driver: context.driver(), expressions });
    try { for (const doc of DOCS) await store.collection('rows').insert(doc); }
    finally { await store.close(); }
  };
  /** Plan, apply and re-plan the upgrade of the table in `context` under `model`. @param {any} context @param {any} model */
  const upgrade = async (context, model) => {
    const { migration, report } = await upgradeOf(context, model);
    assert.deepEqual((await migrate({ driver: context.driver() }, [migration], { baseline: model, model, shadow: false, expressions })).applied, [migration.id]);
    const again = await upgradeOf(context, model);
    assert.deepEqual([again.migration.steps, again.report.upgraded], [[], []], 'the two-run check');
    return { migration, report };
  };

  it('rebuilds every unguarded definition of an earlier table, keeps every row and answer, and then stores the other kind', async () => {
    // what a fresh store creates, read first: one pool at a time
    const fresh = await withPostgres(async (other) => { await created(other, OPEN); return definitions(other.pool, other.schema); });
    await withPostgres(async (context) => {
      await earlier(context);
      assert.deepEqual(await otherKind(context, OPEN), ['JD2005', 'JD2005', 'JD2005']);
      assert.deepEqual(planMigration(OPEN, OPEN, { dialect: postgresDialect({ schema: context.schema }), expressions }).migration.steps, []);
      const before = await answers(context, OPEN);
      const { migration, report } = await upgrade(context, OPEN);
      assert.deepEqual(report.upgraded, ['rows.gx_u_0', 'rows.gx_s_0_start', 'rows.gx_s_0_end', 'rows.gx_lower_w_0_x', 'rows.slot_interval']);
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.note), [
        "drop the CHECK 'slot_interval' of interval 'slot' on 'rows'",
        "drop index 'rows_a' on 'rows'", "drop index 'rows_b' on 'rows'", "drop index 'rows_by_u0' on 'rows'", "drop index 'rows_by_x' on 'rows'",
        ...['gx_u_0', 'gx_s_0_start', 'gx_s_0_end', 'gx_lower_w_0_x'].map((column) => `drop generated column '${column}' on 'rows'`),
        ...['gx_u_0', 'gx_s_0_start', 'gx_s_0_end', 'gx_lower_w_0_x'].map((column) => `add generated column '${column}' on 'rows'`),
        "create index 'rows_a' on 'rows'", "create index 'rows_b' on 'rows'", "create index 'rows_by_u0' on 'rows'", "create index 'rows_by_x' on 'rows'",
        "add the CHECK 'slot_interval' of interval 'slot' on 'rows'",
      ]);
      // the definitions a fresh store creates, every row and answer kept
      assert.deepEqual(await definitions(context.pool, context.schema), fresh);
      assert.deepEqual(await answers(context, OPEN), before);
      assert.deepEqual(await otherKind(context, OPEN), ['stored', 'stored', 'stored']);
    });
  });

  it('rebuilds the plain columns a table keeps after its model stops declaring a container', async () => {
    await withPostgres(async (context) => {
      await created(context, DECLARED);
      // a plan between the two models accepts the plain columns, and the table refuses the other kind
      assert.deepEqual(planMigration(DECLARED, OPEN, { dialect: postgresDialect({ schema: context.schema }), expressions })
        .migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
      assert.deepEqual(await otherKind(context, OPEN), ['JD2005', 'JD2005', 'stored']);
      const before = await answers(context, OPEN);
      const { report } = await upgrade(context, OPEN);
      assert.deepEqual(report.upgraded, ['rows.gx_u_0', 'rows.gx_s_0_start', 'rows.gx_s_0_end', 'rows.slot_interval']);
      assert.deepEqual((await answers(context, OPEN)).slice(0, -1), before.slice(0, -1));
      // the third document of the other kind was stored before the upgrade, and its key is taken
      assert.deepEqual(await otherKind(context, OPEN), ['stored', 'stored', 'JD2001']);
    });
  });

  it('rebuilds an earlier table under a model that declares its containers only where the path stays open', async () => {
    await withPostgres(async (context) => {
      await earlier(context);
      const before = await answers(context, DECLARED);
      const { report } = await upgrade(context, DECLARED);
      assert.deepEqual(report.upgraded, ['rows.gx_lower_w_0_x']);
      assert.deepEqual(await answers(context, DECLARED), before);
    });
  });

  it('rebuilds a CHECK held unguarded over guarded bound columns, and nothing else', async () => {
    await withPostgres(async (context) => {
      await created(context, OPEN);
      const dialect = postgresDialect({ schema: context.schema });
      const [interval] = planCollection('rows', normalizeModel(OPEN, expressions).get('rows'), dialect, { expressions }).intervals;
      await context.pool.query(`ALTER TABLE "${context.schema}".rows DROP CONSTRAINT slot_interval`);
      await context.pool.query(`ALTER TABLE "${context.schema}".rows ADD CONSTRAINT slot_interval CHECK (${interval.alternate})`);
      assert.deepEqual((await otherKind(context, OPEN))[0], 'JD2005');
      const { migration, report } = await upgrade(context, OPEN);
      assert.deepEqual(report.upgraded, ['rows.slot_interval']);
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.note), [
        "drop the CHECK 'slot_interval' of interval 'slot' on 'rows'", "add the CHECK 'slot_interval' of interval 'slot' on 'rows'"]);
      assert.deepEqual((await otherKind(context, OPEN))[0], 'stored');
    });
  });

  it('fails the link with nothing changed where a stored document of the other kind collides in the rebuilt index', async () => {
    await withPostgres(async (context) => {
      await created(context, OPEN);
      // written while the container was open; the model then declares it, and the plain column reads both as 1
      const store = await openStore(OPEN, { driver: context.driver(), expressions });
      try { await store.collection('rows').insert({ id: 'k', u: { 0: 1 } }); }
      finally { await store.close(); }
      const held = await definitions(context.pool, context.schema);
      const { migration, report } = await upgradeOf(context, DECLARED);
      assert.deepEqual(report.upgraded, ['rows.gx_u_0', 'rows.gx_s_0_start', 'rows.gx_s_0_end', 'rows.slot_interval']);
      await assert.rejects(migrate({ driver: context.driver() }, [migration], { baseline: DECLARED, model: DECLARED, shadow: false, expressions }),
        { code: 'JD0023' });
      assert.deepEqual(await definitions(context.pool, context.schema), held);
      assert.deepEqual((await upgradeOf(context, DECLARED)).report.upgraded, report.upgraded);
    });
  });

  it('leaves a definition that is neither spelling to the open, which refuses it', async () => {
    await withPostgres(async (context) => {
      await earlier(context);
      const client = await context.pool.connect();
      try {
        await client.query(`SET search_path TO "${context.schema}"`);
        await client.query('DROP INDEX rows_by_u0');
        await client.query('ALTER TABLE rows DROP COLUMN gx_u_0');
        await client.query(`ALTER TABLE rows ADD COLUMN gx_u_0 numeric GENERATED ALWAYS AS (${number('{"u","1"}')}) STORED`);
        await client.query('CREATE UNIQUE INDEX rows_by_u0 ON rows (gx_u_0)');
      }
      finally { client.release(); }
      const { report } = await upgradeOf(context, OPEN);
      assert.deepEqual(report.upgraded, ['rows.gx_s_0_start', 'rows.gx_s_0_end', 'rows.gx_lower_w_0_x', 'rows.slot_interval']);
      await assert.rejects(openStore(OPEN, { driver: context.driver(), expressions }), { code: 'JD0002' });
    });
  });

  for (const [label, model] of /** @type {[string, any][]} */ ([['open', OPEN], ['declared', DECLARED]])) {
    it(`plans nothing for a table this release creates, its containers ${label}`, async () => {
      await withPostgres(async (context) => {
        await created(context, model);
        const { migration, report } = await upgradeOf(context, model);
        assert.deepEqual([migration.steps, report.upgraded], [[], []]);
      });
    });
  }

  it('rebuilds what a link an earlier release planned created, where planning the link again creates it guarded', async () => {
    await withPostgres(async (context) => {
      const bare = { $model: '0.1', collections: { rows: { key: '/id', schema: OPEN.collections.rows.schema } } };
      await created(context, bare);
      const dialect = postgresDialect({ schema: context.schema });
      const { migration: link } = planMigration(bare, OPEN, { dialect, id: 'index', expressions });
      // the link as an earlier release planned it: every definition this one guards, unguarded
      const plan = planCollection('rows', normalizeModel(OPEN, expressions).get('rows'), dialect, { expressions, registered: false });
      const guarded = [...plan.generated.map((/** @type {any} */ column) => [columnExpression(dialect, column), column.alternate]),
        ...plan.intervals.map((/** @type {any} */ interval) => [interval.sql, interval.alternate])];
      const unguarded = (/** @type {string} */ sql) => guarded.reduce((text, [from, to]) => text.replace(from, to), sql);
      const earlierLink = { ...link, steps: link.steps.map((/** @type {any} */ step) => (step.sql === undefined ? step : { ...step, sql: unguarded(step.sql) })) };
      assert.notDeepEqual(earlierLink.steps, link.steps);
      await migrate({ driver: context.driver() }, [earlierLink], { baseline: bare, model: OPEN, shadow: false, expressions });
      assert.deepEqual(await otherKind(context, OPEN), ['JD2005', 'JD2005', 'JD2005']);
      const { migration, report } = await upgradeOf(context, OPEN);
      assert.deepEqual(report.upgraded, ['rows.gx_u_0', 'rows.gx_s_0_start', 'rows.gx_s_0_end', 'rows.gx_lower_w_0_x', 'rows.slot_interval']);
      await migrate({ driver: context.driver() }, [earlierLink, migration], { baseline: bare, model: OPEN, shadow: false, expressions });
      assert.deepEqual((await upgradeOf(context, OPEN)).migration.steps, []);
      assert.deepEqual(await otherKind(context, OPEN), ['stored', 'stored', 'stored']);
    });
  });
});
