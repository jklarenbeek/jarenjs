//@ts-check
/**
 * @file The indexes the store creates on PostgreSQL in the order its
 * statements read them. A window, a load's `orderBy` and a keyset page order
 * a member ascending with an empty key first (`NULLS FIRST`), ties broken by
 * the row, which an ascending B-tree (NULL last) does not give: a non-unique
 * index the store creates keys each column `NULLS FIRST` and the row identity
 * after them, and beside one over a number (whose column holds the digits a
 * writer spelled, ordered as the double the engine holds) that declares
 * `doubleOrder` an index keys that double (`<index>$double`), which a join's
 * equality of two number columns also reads. A table an earlier release created holds its indexes plain and
 * none beside: it opens and answers as before, and `planColumnUpgrade`
 * respells them. Every answer equals the query engine's (`pushdown: false`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planCollection, planColumnUpgrade, planMigration, migrate, normalizeModel, sqliteDialect } from '@jarenjs/db';
import { postgresDialect, postgresDriver } from '@jarenjs/db/postgres';

import { PG_URL, withPostgres } from './store-core-engines.js';

const dialect = postgresDialect();
const MODEL = { $model: '0.1',
  collections: { c: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' }, n: { type: 'number' }, k: { type: 'string' } } },
    indexes: [{ name: 'by_s', path: '$.s' }, { name: 'by_n', path: '$.n', doubleOrder: true }, { name: 'by_k', path: '$.k', unique: true }] } },
  entities: {
    Item: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, s: { type: 'string' }, n: { type: 'number' },
      e: { type: 'string', 'x-entity': { unique: true } } } }, indexes: [{ name: 'by_s', path: '$.s' }, { name: 'by_n', path: '$.n', doubleOrder: true }] },
    A: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, x: { type: 'number' } } } },
    B: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, y: { type: 'number' } } }, indexes: [{ name: 'by_y', path: '$.y', doubleOrder: true }] } } };
/** @param {any} engine */
const planOf = (engine) => planCollection('c', normalizeModel(MODEL).get('c'), engine);
const DOUBLE = (/** @type {string} */ column) => dialect.doubleRead(`"${column}"`);
/** The indexes this release creates on the tables of {@link MODEL} but the primary keys, as the server spells them:
 * a number's own index, which its comparisons seek, plain beside the one over its double. */
const CREATED = [
  'CREATE INDEX "B_by_y" ON "B" (y)', 'CREATE INDEX "B_by_y$double" ON "B" (DOUBLE(y) NULLS FIRST, rid)',
  'CREATE INDEX "Item_by_n" ON "Item" (n)', 'CREATE INDEX "Item_by_n$double" ON "Item" (DOUBLE(n) NULLS FIRST, rid)',
  'CREATE INDEX "Item_by_s" ON "Item" (s NULLS FIRST, rid)', 'CREATE UNIQUE INDEX "Item_e" ON "Item" (e)',
  'CREATE UNIQUE INDEX c_by_k ON c (gx_k)', 'CREATE INDEX c_by_n ON c (gx_n)',
  'CREATE INDEX "c_by_n$double" ON c (DOUBLE(gx_n) NULLS FIRST, rid)', 'CREATE INDEX c_by_s ON c (gx_s NULLS FIRST, rid)'];
/** The same, as an earlier release created them: plain, and none beside. */
const EARLIER = CREATED.filter((sql) => !sql.includes('$double')).map((sql) => sql.replace(/ NULLS FIRST, rid\)/, ')'));

/** Documents with empty keys (every fifth), and two spellings of one double past 2^53 to pair. */
async function fill(/** @type {any} */ store) {
  for (let g = 1; g <= 60; g++) {
    await store.collection('c').insert({ id: `d${g}`, ...(g % 5 ? { s: `s${(g * 13) % 60}`, n: (g * 17) % 60 + 0.5 } : {}), k: `k${g}` });
    store.entity('Item').create({ id: `i${String(g).padStart(2, '0')}`, ...(g % 5 ? { s: `s${(g * 13) % 60}`, n: (g * 17) % 30 } : {}), e: `e${g}` });
    store.entity('B').create({ id: `b${g}`, y: g * 2 });
    if (g <= 10) store.entity('A').create({ id: `a${g}`, x: g * 3 });
  }
  store.entity('A').create({ id: 'abig', x: 9007199254740992 });
  store.entity('B').create({ id: 'bbig', y: 9007199254740992 });
  await store.saveChanges();
}
const window = (/** @type {string} */ root, /** @type {any} */ by) => ({ $subsequence: [{ $for: { it: `$${root}[*]` }, $orderby: [by], $return: '$it.id' }, 0, 10] });
const JOIN = { $for: { a: '$.A[*]', b: '$.B[*]' }, $where: { $eq: ['$a.x', '$b.y'] }, $return: ['$a.id', '$b.id'] };
/** Each ordering and the join, by name: a call over the store, given the options a query takes. */
const READS = {
  'c window by s': (/** @type {any} */ store, /** @type {any} */ o) => store.collection('c').execute(window('', '$it.s'), o),
  'c window by s descending': (/** @type {any} */ store, /** @type {any} */ o) => store.collection('c').execute(window('', { $key: '$it.s', $dir: 'desc' }), o),
  'c window by s, empty greatest': (/** @type {any} */ store, /** @type {any} */ o) => store.collection('c').execute(window('', { $key: '$it.s', $empty: 'greatest' }), o),
  'c window by n': (/** @type {any} */ store, /** @type {any} */ o) => store.collection('c').execute(window('', '$it.n'), o),
  'c window by n descending': (/** @type {any} */ store, /** @type {any} */ o) => store.collection('c').execute(window('', { $key: '$it.n', $dir: 'desc' }), o),
  'Item window by s': (/** @type {any} */ store, /** @type {any} */ o) => store.execute(window('.Item', '$it.s'), o),
  'Item window by n': (/** @type {any} */ store, /** @type {any} */ o) => store.execute(window('.Item', '$it.n'), o),
  'A join B on x = y': (/** @type {any} */ store, /** @type {any} */ o) => store.execute(JOIN, o),
};

/** A PostgreSQL schema with a pool that records each statement the store sends. @param {(context: any) => Promise<void>} fn */
const withCapture = (fn) => withPostgres(async (context) => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: PG_URL, max: 1 });
  /** @type {{ text: string, values: any[] }[]} */
  const sent = [];
  pool.on('connect', (client) => {
    const query = client.query.bind(client);
    // @ts-ignore - recording the text of each statement sent
    client.query = (/** @type {any[]} */ ...args) => {
      const [first, second] = args;
      const text = typeof first === 'string' ? first : first?.text;
      if (typeof text === 'string') sent.push({ text, values: Array.isArray(second) ? second : first?.values ?? [] });
      return query(...args);
    };
  });
  try { await fn({ ...context, sent, captured: () => postgresDriver(pool, { schema: context.schema }) }); }
  finally { await pool.end(); }
});

/** The indexes of the schema but the primary keys, as the server spells them, each double read `DOUBLE(column)`. @param {any} context */
const created = async ({ pool, schema }) => (await pool.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname NOT LIKE $2 ORDER BY indexname', [schema, '%pkey'])).rows
  .map((/** @type {any} */ row) => String(row.indexdef).split(`${schema}.`).join('').replace(' USING btree', '').replace(/\s+/g, ' ')
    .replace(/\( CASE WHEN \(\(abs\((\w+)\) < .*? END\)/g, 'DOUBLE($1)'));

/** Respell a table this release created as an earlier release created it ({@link EARLIER}). @param {any} context */
async function asEarlier({ pool, schema }) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    for (const { indexname } of (await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexdef LIKE '%NULLS FIRST%'", [schema])).rows) {
      await client.query(`DROP INDEX "${indexname}"`);
      const plain = EARLIER.find((sql) => sql.includes(` INDEX "${indexname}" `) || sql.includes(` INDEX ${indexname} `));
      if (plain !== undefined) await client.query(plain);
    }
  }
  finally { client.release(); }
}

/** The plan the server chooses for the statement a call sends last, with no sequential scan, sort or hash join to fall back on. @param {any} context @param {() => Promise<any>} call */
async function planOfCall({ pool, schema, sent }, call) {
  const from = sent.length;
  await call();
  const statement = sent.slice(from).filter((/** @type {any} */ s) => /^\s*(SELECT|WITH|DECLARE)/i.test(s.text) && / FROM /.test(s.text)).at(-1);
  assert.ok(statement !== undefined, 'a statement was sent');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const setting of ['enable_seqscan', 'enable_sort', 'enable_hashjoin', 'enable_mergejoin']) await client.query(`SET LOCAL ${setting} = off`);
    const text = statement.text.replace(/^DECLARE "[^"]+" NO SCROLL CURSOR FOR /, '');
    return (await client.query({ text: `EXPLAIN (COSTS OFF) ${text}`, values: statement.values })).rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n');
  }
  finally { await client.query('ROLLBACK'); client.release(); }
}

describe('the indexes the store creates in the order a statement reads', () => {
  it('keys a non-unique index NULLS FIRST with the row identity, and a double beside a number\'s, on PostgreSQL alone', () => {
    const plan = planOf(dialect);
    assert.deepEqual(plan.createSql.filter((/** @type {string} */ sql) => sql.startsWith('CREATE ') && sql.includes(' INDEX ')), [
      'CREATE INDEX "c_by_s" ON "c" ("gx_s" NULLS FIRST, "rid")', 'CREATE INDEX "c_by_n" ON "c" ("gx_n")',
      'CREATE UNIQUE INDEX "c_by_k" ON "c" ("gx_k")', `CREATE INDEX "c_by_n$double" ON "c" (${DOUBLE('gx_n')} NULLS FIRST, "rid")`]);
    assert.deepEqual(plan.orderIndexes.map((/** @type {any} */ index) => [index.name, index.of]), [['c_by_n$double', 'c_by_n']]);
    assert.deepEqual(plan.expected.indexes.map((/** @type {any} */ index) => [index.name, index.ordered === true]), [['c_by_k', false], ['c_by_n', false], ['c_by_s', true]]);
    // SQLite places an empty key first ascending, as a statement orders it: its plan is as it was
    const sqlite = planOf(sqliteDialect);
    const indexes = sqlite.createSql.filter((/** @type {string} */ sql) => sql.includes(' INDEX '));
    assert.deepEqual(indexes.slice(0, 2), ['CREATE INDEX "c_by_s" ON "c" ("gx_s")', 'CREATE INDEX "c_by_n" ON "c" ("gx_n")']);
    assert.ok(indexes.length === 3 && indexes[2].startsWith('CREATE UNIQUE INDEX "c_by_k" ON "c" ("gx_k", ') && !indexes[2].includes('NULLS'), indexes[2]);
    assert.deepEqual([sqlite.orderIndexes, sqlite.expected.indexes.some((/** @type {any} */ index) => index.ordered)], [[], false]);
  });

  it('creates them, reopens, reads each ordering and the join through them, and answers as the engine', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => withCapture(async (context) => {
    let store = await openStore(MODEL, { driver: context.captured() });
    try { await fill(store); }
    finally { await store.close(); }
    assert.deepEqual(await created(context), CREATED);
    store = await openStore(MODEL, { driver: context.captured() });
    try {
      for (const [name, read] of Object.entries(READS)) assert.deepEqual(await read(store, undefined), await read(store, { pushdown: false }), name);
      // the two spellings of one double past 2^53 pair, as the engine pairs them
      assert.ok((await store.execute(JOIN)).some((/** @type {any} */ pair) => pair[0] === 'abig' && pair[1] === 'bbig'));
      const I = store.entity('Item');
      const first = await I.page({ orderBy: '$it.s' }, { limit: 5 });
      const reads = {
        c_by_s: [() => READS['c window by s'](store, undefined), () => READS['c window by s descending'](store, undefined)],
        'c_by_n$double': [() => READS['c window by n'](store, undefined), () => READS['c window by n descending'](store, undefined)],
        Item_by_s: [() => READS['Item window by s'](store, undefined), () => I.asNoTracking().load({ orderBy: '$it.s', take: 5 }),
          () => I.page({ orderBy: '$it.s' }, { limit: 5, after: first.continuation })],
        'Item_by_n$double': [() => READS['Item window by n'](store, undefined), () => I.asNoTracking().load({ orderBy: '$it.n', take: 5 })],
        'B_by_y$double': [() => READS['A join B on x = y'](store, undefined)],
      };
      for (const [index, calls] of Object.entries(reads)) {
        for (const call of calls) {
          const plan = await planOfCall(context, call);
          assert.match(plan, new RegExp(`Index Scan (Backward )?using "?${index.replace('$', '\\$')}"? `), `${index}: ${plan}`);
          // read in the index's order: no sort of every row above it (a join's pairs are
          // sorted by their rows, as the engine meets them)
          if (index !== 'B_by_y$double') assert.doesNotMatch(plan, /(^|\n)\s*(->\s+)?Sort\n/, plan);
        }
      }
    }
    finally { await store.close(); }
  }));

  it('opens a table an earlier release created as it was, answering as before, and planColumnUpgrade respells it through a shadow', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => withCapture(async (context) => {
    let store = await openStore(MODEL, { driver: context.driver() });
    try { await fill(store); }
    finally { await store.close(); }
    await asEarlier(context);
    assert.deepEqual(await created(context), EARLIER);
    store = await openStore(MODEL, { driver: context.captured() });
    try {
      for (const [name, read] of Object.entries(READS)) assert.deepEqual(await read(store, undefined), await read(store, { pushdown: false }), name);
      // slower, not otherwise: the window sorts
      assert.match(await planOfCall(context, () => READS['c window by s'](store, undefined)), /Sort/);
    }
    finally { await store.close(); }
    const upgradeOf = async () => {
      const connection = await context.driver().open();
      try { return await planColumnUpgrade(connection, MODEL); }
      finally { await connection.close(); }
    };
    const { migration, report } = await upgradeOf();
    assert.deepEqual(report.upgraded, ['c.c_by_s', 'c.c_by_n$double', 'Item.Item_by_s', 'Item.Item_by_n$double', 'B.B_by_y$double']);
    assert.deepEqual(migration.steps.slice(0, 3).map((/** @type {any} */ step) => step.sql), ['DROP INDEX "c_by_s"', 'CREATE INDEX "c_by_s" ON "c" ("gx_s" NULLS FIRST, "rid")',
      `CREATE INDEX "c_by_n$double" ON "c" (${DOUBLE('gx_n')} NULLS FIRST, "rid")`]);
    const shadow = `${context.schema}_shadow`;
    await context.pool.query(`CREATE SCHEMA "${shadow}"`);
    try {
      assert.deepEqual((await migrate({ driver: context.driver() }, [migration],
        { baseline: MODEL, model: MODEL, shadowDriver: postgresDriver(context.pool, { schema: shadow }) })).applied, [migration.id]);
    }
    finally { await context.pool.query(`DROP SCHEMA "${shadow}" CASCADE`); }
    const again = await upgradeOf();
    assert.deepEqual([again.migration.steps, again.report.upgraded], [[], []], 'the two-run check');
    assert.deepEqual(await created(context), CREATED);
    store = await openStore(MODEL, { driver: context.captured() });
    try {
      for (const [name, read] of Object.entries(READS)) assert.deepEqual(await read(store, undefined), await read(store, { pushdown: false }), name);
      assert.match(await planOfCall(context, () => READS['c window by s'](store, undefined)), /Index Scan using c_by_s /);
    }
    finally { await store.close(); }
  }));

  it('reads them back as the indexes the model declares, so the model read back reopens the table', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => withPostgres(async (context) => {
    await (await openStore(MODEL, { driver: context.driver() })).close();
    const store = await openStore(MODEL, { driver: context.driver() });
    let derived;
    try { ({ model: derived } = await store.introspect()); }
    finally { await store.close(); }
    assert.deepEqual(derived.collections.c.indexes, [{ name: 'by_k', path: '$.k', unique: true }, { name: 'by_n', path: '$.n', doubleOrder: true }, { name: 'by_s', path: '$.s' }]);
    assert.deepEqual(derived.entities.Item.indexes, [{ name: 'by_n', path: '$.n', doubleOrder: true }, { name: 'by_s', path: '$.s' }]);
    await (await openStore(derived, { driver: context.driver() })).close();
  }));

  it('refuses an index beside under its name that keys another read, and an index keyed in another order', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => withPostgres(async (context) => {
    await (await openStore(MODEL, { driver: context.driver() })).close();
    const restore = `CREATE INDEX "c_by_n$double" ON c (${DOUBLE('gx_n')} NULLS FIRST, rid)`;
    for (const [drift, undo, message] of [
      ['DROP INDEX "c_by_n$double"; CREATE INDEX "c_by_n$double" ON c ((gx_n::float8) NULLS FIRST, rid)', `DROP INDEX "c_by_n$double"; ${restore}`, /index 'c_by_n\$double' keys /],
      ['DROP INDEX "c_by_n$double"; CREATE UNIQUE INDEX "c_by_n$double" ON c (' + DOUBLE('gx_n') + ' NULLS FIRST, rid)', `DROP INDEX "c_by_n$double"; ${restore}`, /index 'c_by_n\$double' is not the B-tree/],
      ['DROP INDEX "c_by_n$double"; CREATE INDEX "c_by_n$double" ON c (gx_n NULLS FIRST, rid)', `DROP INDEX "c_by_n$double"; ${restore}`, /index 'c_by_n\$double' keys \(gx_n, rid\)/],
      ['DROP INDEX c_by_s; CREATE INDEX c_by_s ON c (gx_s DESC, rid)', 'DROP INDEX c_by_s; CREATE INDEX c_by_s ON c (gx_s NULLS FIRST, rid)', /index 'c_by_s' covers \(gx_s, rid\)/],
      ['DROP INDEX c_by_s; CREATE INDEX c_by_s ON c (gx_s NULLS FIRST)', 'DROP INDEX c_by_s; CREATE INDEX c_by_s ON c (gx_s NULLS FIRST, rid)', /index 'c_by_s' is not the plain/],
      ['DROP INDEX c_by_k; CREATE UNIQUE INDEX c_by_k ON c (gx_k NULLS FIRST)', 'DROP INDEX c_by_k; CREATE UNIQUE INDEX c_by_k ON c (gx_k)', /index 'c_by_k' is not the plain/],
    ]) {
      await context.pool.query(`SET search_path TO "${context.schema}"; ${drift}`);
      // a store that opens is closed, so the schema drops
      const opened = await openStore(MODEL, { driver: context.driver() }).then(async (/** @type {any} */ store) => { await store.close(); return null; }, (/** @type {any} */ error) => error);
      assert.ok(opened !== null && opened.code === 'JD0002' && message.test(opened.message), `${drift}: ${opened?.message}`);
      await context.pool.query(`SET search_path TO "${context.schema}"; ${undo}`);
    }
    await (await openStore(MODEL, { driver: context.driver() })).close();
  }));

  it('drops the index beside with the index it stands beside, and creates it with one a migration adds', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => withPostgres(async (context) => {
    await (await openStore(MODEL, { driver: context.driver() })).close();
    const without = structuredClone(MODEL);
    without.collections.c.indexes = without.collections.c.indexes.filter((index) => index.name !== 'by_n');
    without.entities.Item.indexes = [{ name: 'by_s', path: '$.s' }];
    const down = planMigration(MODEL, without, { dialect, id: 'drop-n' }).migration;
    assert.ok(down.steps.some((/** @type {any} */ step) => step.sql === 'DROP INDEX IF EXISTS "c_by_n$double"'));
    assert.ok(down.steps.some((/** @type {any} */ step) => step.sql === 'DROP INDEX IF EXISTS "Item_by_n$double"'));
    const up = planMigration(without, MODEL, { dialect, id: 'add-n' }).migration;
    assert.ok(up.steps.some((/** @type {any} */ step) => step.sql === `CREATE INDEX "c_by_n$double" ON "c" (${DOUBLE('gx_n')} NULLS FIRST, "rid")`));
    assert.deepEqual((await migrate({ driver: context.driver() }, [down], { baseline: MODEL, model: without, shadow: false })).applied, ['drop-n']);
    await (await openStore(without, { driver: context.driver() })).close();
    assert.ok(!(await created(context)).some((sql) => sql.includes('by_n')));
    assert.deepEqual((await migrate({ driver: context.driver() }, [down, up], { baseline: MODEL, model: MODEL, shadow: false })).applied, ['add-n']);
    await (await openStore(MODEL, { driver: context.driver() })).close();
    assert.deepEqual(await created(context), CREATED);
  }));
  it('creates the index beside a number\'s only where the index declares doubleOrder, and refuses the declaration where it keys nothing', () => {
    const undeclared = structuredClone(MODEL);
    undeclared.collections.c.indexes[1] = { name: 'by_n', path: '$.n' };
    const plain = planCollection('c', normalizeModel(undeclared).get('c'), dialect);
    assert.deepEqual([plain.orderIndexes, plain.createSql.filter((/** @type {string} */ sql) => sql.includes('$double'))], [[], []]);
    assert.ok(plain.createSql.includes('CREATE INDEX "c_by_n" ON "c" ("gx_n")'));
    for (const [index, pointer, message] of [
      [{ name: 'by_s', path: '$.s', doubleOrder: true }, '/collections/c/indexes/0/doubleOrder', /holds another kind/],
      [{ name: 'by_n', path: '$.n', unique: true, doubleOrder: true }, '/collections/c/indexes/0/doubleOrder', /declares 'unique'/],
      [{ name: 'by_n', path: '$.n', where: { $eq: ['$.s', 'x'] }, doubleOrder: true }, '/collections/c/indexes/0/doubleOrder', /declares 'where'/],
      [{ name: 'by_n', path: '$.n', doubleOrder: 1 }, '/collections/c/indexes/0/doubleOrder', /true or false/],
    ]) {
      const model = { $model: '0.1', collections: { c: { ...MODEL.collections.c, indexes: [index] } } };
      assert.throws(() => planCollection('c', normalizeModel(model).get('c'), dialect),
        (/** @type {any} */ error) => error.docPath === pointer && message.test(error.message), JSON.stringify(index));
    }
    // a link that declares it on a kept index creates the index beside, and one that drops the declaration drops it
    assert.deepEqual(planMigration(undeclared, MODEL, { dialect, id: 'declare' }).migration.steps.map((/** @type {any} */ step) => step.sql),
      [`CREATE INDEX "c_by_n$double" ON "c" (${DOUBLE('gx_n')} NULLS FIRST, "rid")`]);
    assert.deepEqual(planMigration(MODEL, undeclared, { dialect, id: 'undeclare' }).migration.steps.map((/** @type {any} */ step) => step.sql),
      ['DROP INDEX IF EXISTS "c_by_n$double"']);
  });
});
