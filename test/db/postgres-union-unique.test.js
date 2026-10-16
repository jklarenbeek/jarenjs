//@ts-check
/**
 * @file A unique index over a member of several scalar kinds on
 * PostgreSQL. The member's generated column holds its first type and reads
 * every other kind as NULL, so the declared unique index refuses duplicates
 * of that kind alone; each index beside it keys another kind (one per
 * combination of the kinds its members hold), unique as the declared index
 * is, under its condition, so a duplicate of any kind is refused `JD2005`
 * as SQLite refuses it, and a value of one kind never meets one of another
 * (`1` and `'1'` are two keys on both engines). A table an earlier release
 * created has no index beside; `planColumnUpgrade` adds them, and refuses
 * `JD0023` before any step where the table already holds such duplicates.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, introspectModel, planCollection, planColumnUpgrade, planMigration, migrate, normalizeModel } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';

import { PG_URL, withPostgres, withStore } from './store-core-engines.js';

const dialect = postgresDialect();
/** @param {Record<string, any>} properties @param {any[]} indexes */
const modelOf = (properties, indexes) => ({ $model: '0.1', collections: { c: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, ...properties } }, indexes } } });
const UNION = { type: ['number', 'string'] };
const SHAPES = {
  single: modelOf({ q: UNION, k: { type: 'string' } }, [{ name: 'by_q', path: '$.q', unique: true }]),
  composite: modelOf({ q: UNION, k: { type: 'string' } }, [{ name: 'by_qk', path: ['$.q', '$.k'], unique: true }]),
  conditional: modelOf({ q: UNION, k: { type: 'string' } },
    [{ name: 'by_k', path: '$.k' }, { name: 'by_q', path: '$.q', unique: true, where: { $eq: ['$.k', 'x'] } }]),
};
const GUARDED = modelOf({ u: { items: UNION } }, [{ name: 'by_u', path: '$.u[0]', unique: true }]);
const TWO = modelOf({ q: UNION, r: { type: ['string', 'boolean'] } }, [{ name: 'by_qr', path: ['$.q', '$.r'], unique: true }]);
/** @param {any} model */
const planOf = (model) => planCollection('c', normalizeModel(model).get('c'), dialect);
/** @param {any} model */
const besides = (model) => planOf(model).createSql.filter((/** @type {string} */ sql) => /^CREATE (UNIQUE )?INDEX "[^"]*\$/.test(sql));
const TEXT = (/** @type {string} */ member) => `((CASE WHEN jsonb_typeof(("doc" #> '{"${member}"}')) = 'string' THEN "doc" #>> '{"${member}"}' END) COLLATE "C")`;
const BOOLEAN_R = `(CASE WHEN jsonb_typeof(("doc" #> '{"r"}')) = 'boolean' THEN (CASE WHEN (("doc" #> '{"r"}'))::boolean THEN 1 ELSE 0 END) END)`;
const GUARD = `(CASE WHEN jsonb_typeof(("doc" #> '{"u"}')) = 'array' THEN "doc" END)`;

describe('the indexes beside a unique index over a member of several kinds', () => {
  it('key every other kind of every shape, unique, under the declared condition', () => {
    assert.deepEqual(besides(SHAPES.single), [`CREATE UNIQUE INDEX "c_by_q$text" ON "c" (${TEXT('q')})`]);
    assert.deepEqual(besides(SHAPES.composite), [`CREATE UNIQUE INDEX "c_by_qk$text" ON "c" (${TEXT('q')}, "gx_k")`]);
    assert.deepEqual(besides(SHAPES.conditional), [`CREATE UNIQUE INDEX "c_by_q$text" ON "c" (${TEXT('q')}) WHERE "gx_k" = 'x'`]);
    assert.deepEqual(besides(GUARDED), [`CREATE UNIQUE INDEX "c_by_u$text" ON "c" (((CASE WHEN jsonb_typeof((${GUARD} #> '{"u","0"}')) = 'string' `
      + `THEN ${GUARD} #>> '{"u","0"}' END) COLLATE "C"))`]);
    // every combination of the two members' kinds but their first kinds together
    assert.deepEqual(besides(TWO), [`CREATE UNIQUE INDEX "c_by_qr$number$boolean" ON "c" ("gx_q", ${BOOLEAN_R})`,
      `CREATE UNIQUE INDEX "c_by_qr$text$text" ON "c" (${TEXT('q')}, "gx_r")`,
      `CREATE UNIQUE INDEX "c_by_qr$text$boolean" ON "c" (${TEXT('q')}, ${BOOLEAN_R})`]);
  });

  it('key a member whose union lists a container first by its column, which holds every kind', () => {
    const model = modelOf({ o: { type: ['object', 'string'] }, q: UNION }, [{ name: 'by_oq', path: ['$.o', '$.q'], unique: true }]);
    assert.deepEqual(besides(model), [`CREATE UNIQUE INDEX "c_by_oq$text" ON "c" ("gx_o", ${TEXT('q')})`]);
  });

  it('arrive with a link that gives a kept unique index\'s member another kind, or makes the index unique', () => {
    const number = modelOf({ q: { type: 'number' } }, [{ name: 'by_q', path: '$.q', unique: true }]);
    /** @param {any} from @param {any} to */
    const ddl = (from, to) => planMigration(from, to, { dialect }).migration.steps
      .filter((/** @type {any} */ step) => step.kind === 'ddl').map((/** @type {any} */ step) => step.sql);
    assert.deepEqual(ddl(number, SHAPES.single), [`CREATE UNIQUE INDEX "c_by_q$text" ON "c" (${TEXT('q')})`]);
    const plain = modelOf({ q: UNION, k: { type: 'string' } }, [{ name: 'by_q', path: '$.q' }]);
    assert.deepEqual(ddl(plain, SHAPES.single), ['DROP INDEX "c_by_q"', 'DROP INDEX IF EXISTS "c_by_q$text"',
      'CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q")', `CREATE UNIQUE INDEX "c_by_q$text" ON "c" (${TEXT('q')})`]);
    assert.deepEqual(ddl(SHAPES.single, SHAPES.single), []);
  });
});

describe('a unique index over a member of several kinds, on both engines', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  // [first, second, whether the second is refused]: SQLite's answer, which PostgreSQL now gives
  const PAIRS = /** @type {const} */ ([['b', 'b', true], [1, 1, true], [1, '1', false], ['1', 1, false], [1, 1.5, false],
    ['a', 'A', false], [null, null, false], [1e21, 1e21, true]]);

  for (const [shape, model] of Object.entries(SHAPES)) {
    it(`refuses a duplicate of either kind (${shape}) as SQLite does, and reopens`, async () => {
      for (const engine of ['sqlite', 'postgres']) {
        const verdicts = [];
        for (const [first, second] of PAIRS) {
          await withStore(engine, modelOf({ ...model.collections.c.schema.properties, q: { type: ['number', 'string', 'null'] } },
            model.collections.c.indexes), async (store) => {
            const rows = store.collection('c');
            await rows.insert({ id: '1', q: first, k: 'x' });
            verdicts.push(await rows.insert({ id: '2', q: second, k: 'x' }).then(() => false,
              (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint'));
            // outside the condition no two documents meet
            if (shape === 'conditional') assert.equal(await rows.insert({ id: '3', q: first, k: 'y' }).then(() => 'stored'), 'stored');
          });
        }
        assert.deepEqual(verdicts, PAIRS.map(([, , refused]) => refused), `${engine} ${shape}`);
      }
      await withPostgres(async ({ driver }) => {
        await (await openStore(model, { driver: driver() })).close();
        const store = await openStore(model, { driver: driver() });
        try {
          await store.collection('c').insert({ id: '1', q: 'b', k: 'x' });
          // a write that makes a second document a duplicate is refused as an insert is
          await store.collection('c').insert({ id: '2', q: 'c', k: 'x' });
          await assert.rejects(store.collection('c').put({ id: '2', q: 'b', k: 'x' }), { code: 'JD2005' });
          assert.deepEqual(await store.collection('c').execute({ $for: { it: '$[*]' }, $where: { $eq: ['$it.q', 'b'] }, $return: '$it.id' }), '1');
        }
        finally { await store.close(); }
      });
    });
  }

  it('compares a boolean with booleans alone, as the query engine does', () => withPostgres(async ({ driver }) => {
    const model = modelOf({ q: { type: ['number', 'boolean'] } }, [{ name: 'by_q', path: '$.q', unique: true }]);
    const store = await openStore(model, { driver: driver() });
    try {
      const rows = store.collection('c');
      await rows.insert({ id: '1', q: 1 });
      await rows.insert({ id: '2', q: true });
      await assert.rejects(rows.insert({ id: '3', q: true }), { code: 'JD2005' });
      await rows.insert({ id: '4', q: 0 });
      await rows.insert({ id: '5', q: false });
      const query = { $for: { it: '$[*]' }, $where: { $eq: ['$it.q', true] }, $return: '$it.id' };
      assert.deepEqual([await rows.execute(query), await rows.execute(query, { pushdown: false })], ['2', '2']);
    }
    finally { await store.close(); }
  }));

  it('refuses a duplicate under a guarded path, and under two members of several kinds, and reopens', async () => {
    for (const [model, docs, refused] of /** @type {const} */ ([
      [GUARDED, [{ id: '1', u: ['b'] }, { id: '2', u: { 0: 'b' } }], { id: '3', u: ['b', 1] }],
      [TWO, [{ id: '1', q: 'b', r: true }, { id: '2', q: 'b', r: 'true' }, { id: '3', q: 1, r: true }], { id: '4', q: 'b', r: true }],
    ])) {
      await withPostgres(async ({ driver }) => {
        const store = await openStore(model, { driver: driver() });
        try {
          for (const doc of docs) await store.collection('c').insert(doc);
          await assert.rejects(store.collection('c').insert(refused), { code: 'JD2005' });
        }
        finally { await store.close(); }
        await (await openStore(model, { driver: driver() })).close();
      });
    }
  });
});

describe('a table an earlier release created under a unique index over a member of several kinds', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  /** Create the table as an earlier release did: no index beside. @param {any} context @param {any} model */
  const earlier = async (context, model) => {
    await context.pool.query(`SET search_path TO "${context.schema}"`);
    for (const sql of planOf(model).createSql.filter((/** @type {string} */ sql) => !/^CREATE (UNIQUE )?INDEX "[^"]*\$/.test(sql)))
      await context.pool.query(sql);
  };
  /** @param {any} context @param {any} model */
  const upgradeOf = async (context, model) => {
    const connection = await context.driver().open();
    try { return await planColumnUpgrade(connection, model); }
    finally { await connection.close(); }
  };
  /** @param {any} context */
  const indexNames = async (context) => (await context.pool.query(
    'SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname', [context.schema])).rows.map((/** @type {any} */ row) => row.indexname);

  for (const [shape, model] of Object.entries(SHAPES)) {
    it(`opens and stores its duplicates (${shape}); planColumnUpgrade refuses them JD0023 before any step, then adds the index`, () => withPostgres(async (context) => {
      await earlier(context, model);
      const store = await openStore(model, { driver: context.driver() });
      try {
        for (const doc of [{ id: 'a', q: 'b', k: 'x' }, { id: 'b', q: 'b', k: 'x' }, { id: 'c', q: 'c', k: 'x' }, { id: 'd', q: 'c', k: 'x' },
          { id: 'e', q: 'e', k: 'x' }, { id: 'f', q: 1, k: 'x' },
          // outside a condition two documents never meet, and a member a document lacks keys nothing
          ...(shape === 'conditional' ? [{ id: 'h', q: 'z', k: 'y' }, { id: 'i', q: 'z', k: 'y' }] : []),
          { id: 'j', k: 'x' }, { id: 'l', k: 'x' }]) await store.collection('c').insert(doc);
      }
      finally { await store.close(); }
      const before = await indexNames(context);
      const declared = model.collections.c.indexes.at(-1).name;
      await assert.rejects(upgradeOf(context, model), (/** @type {any} */ error) => {
        assert.deepEqual([error.code, error.class, error.retryable, error.collection, error.index, error.duplicates],
          ['JD0023', 'constraint', false, 'c', declared, [['a', 'b'], ['c', 'd']]]);
        assert.equal(error.message, `JD0023: the unique index '${declared}' of collection 'c' refuses a duplicate of any kind its members hold, `
          + 'but the table holds documents that duplicate one another at a kind the index\'s column did not key, which an earlier release '
          + 'stored: "a" and "b"; "c" and "d" — change or remove all but one of each, then plan the upgrade again');
        return true;
      });
      assert.deepEqual(await indexNames(context), before, 'nothing changed');
      const repaired = await openStore(model, { driver: context.driver() });
      try { for (const id of ['b', 'd']) await repaired.collection('c').delete(id); }
      finally { await repaired.close(); }
      const { migration, report } = await upgradeOf(context, model);
      const name = `c_${declared}$text`;
      assert.deepEqual([report.upgraded, migration.steps.map((/** @type {any} */ step) => step.sql)], [[`c.${name}`], besides(model)]);
      assert.deepEqual((await migrate({ driver: context.driver() }, [migration], { baseline: model, model, shadow: false })).applied, [migration.id]);
      const again = await upgradeOf(context, model);
      assert.deepEqual([again.migration.steps, again.report.upgraded], [[], []], 'the two-run check');
      const upgraded = await openStore(model, { driver: context.driver() });
      try { await assert.rejects(upgraded.collection('c').insert({ id: 'g', q: 'e', k: 'x' }), { code: 'JD2005' }); }
      finally { await upgraded.close(); }
    }));
  }

  it('applies the upgrade through a shadow, and fails JD0023 there too where duplicates arrive after the plan', () => withPostgres(async (context) => {
    const model = SHAPES.single;
    await earlier(context, model);
    const { migration } = await upgradeOf(context, model);
    const store = await openStore(model, { driver: context.driver() });
    try { for (const id of ['a', 'b']) await store.collection('c').insert({ id, q: 'b' }); }
    finally { await store.close(); }
    const shadow = `${context.schema}_shadow`;
    await context.pool.query(`CREATE SCHEMA "${shadow}"`);
    try {
      const { postgresDriver } = await import('@jarenjs/db/postgres');
      await assert.rejects(migrate({ driver: context.driver() }, [migration], { baseline: model, model, shadowDriver: postgresDriver(context.pool, { schema: shadow }) }),
        (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'constraint');
    }
    finally { await context.pool.query(`DROP SCHEMA "${shadow}" CASCADE`); }
    assert.deepEqual(await indexNames(context), ['c_by_q', 'c_pkey']);
  }));

  it('refuses at open an index beside under another condition', () => withPostgres(async (context) => {
    await (await openStore(SHAPES.conditional, { driver: context.driver() })).close();
    await context.pool.query(`SET search_path TO "${context.schema}"; DROP INDEX "c_by_q$text"; `
      + `CREATE UNIQUE INDEX "c_by_q$text" ON "c" (${TEXT('q')}) WHERE "gx_k" = 'y'`);
    const refused = await openStore(SHAPES.conditional, { driver: context.driver() })
      .then(async (/** @type {any} */ store) => { await store.close(); return null; }, (/** @type {any} */ error) => error);
    assert.equal(refused?.code, 'JD0002');
    assert.ok(refused.message.includes("index 'c_by_q$text' has the condition"), refused.message);
  }));

  it('refuses at open, and reads back as no kind, an index beside that keys another column or takes another name', async () => {
    for (const [label, sql, named] of [
      ['another column', `DROP INDEX "c_by_qk$text"; CREATE UNIQUE INDEX "c_by_qk$text" ON "c" (${TEXT('q')}, "gx_q")`, 'c_by_qk$text'],
      ['another name', 'ALTER INDEX "c_by_qk$text" RENAME TO "c_by_qk$number"', 'c_by_qk$number'],
    ]) {
      await withPostgres(async (context) => {
        await (await openStore(SHAPES.composite, { driver: context.driver() })).close();
        await context.pool.query(`SET search_path TO "${context.schema}"; ${sql}`);
        const refused = await openStore(SHAPES.composite, { driver: context.driver() })
          .then(async (/** @type {any} */ store) => { await store.close(); return null; }, (/** @type {any} */ error) => error);
        assert.equal(refused?.code, 'JD0002', label);
        assert.ok(refused.message.includes(named), refused.message);
        const connection = await context.driver().open();
        try {
          const { model: read, report } = await introspectModel(connection, { keys: { c: '/id' } });
          assert.equal(read.collections.c.schema.properties.q.type, 'number', label);
          assert.deepEqual(report.filter((/** @type {any} */ row) => row.object === `c.${named}`).map((/** @type {any} */ row) => row.code), ['unmapped-index'], label);
        }
        finally { await connection.close(); }
      });
    }
  });

  it('reads the kinds of every shape back, so the model read back reopens and plans no index', async () => {
    for (const model of [SHAPES.single, SHAPES.composite, TWO, GUARDED]) {
      await withPostgres(async (context) => {
        await (await openStore(model, { driver: context.driver() })).close();
        const store = await openStore(model, { driver: context.driver() });
        let derived, report;
        try { ({ model: derived, report } = await store.introspect({ keys: { c: '/id' } })); }
        finally { await store.close(); }
        assert.deepEqual(report.filter((/** @type {any} */ row) => row.code === 'unmapped-index'), []);
        assert.deepEqual(derived.collections.c.indexes, model.collections.c.indexes);
        await (await openStore(derived, { driver: context.driver() })).close();
        for (const [from, to] of [[model, derived], [derived, model]]) {
          assert.deepEqual(planMigration(from, to, { dialect: postgresDialect({ schema: context.schema }) }).migration.steps
            .filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
        }
      });
    }
  });
});
