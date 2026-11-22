//@ts-check
/**
 * @file On PostgreSQL an ordering whose leading term places the empty key
 * where the index that term leads does not — ascending with the empty key
 * greatest (`NULLS LAST`), which an index keyed `NULLS FIRST` places first,
 * and descending with it greatest (`NULLS FIRST`), which the index read
 * backward places last — reads that index in two ordered, limited branches:
 * the rows that hold the key, then those that hold none. A window, a load's
 * `orderBy` and a keyset page are spelled so, and a page past a value whose
 * empty keys follow it reads the branch that holds the key from a leading
 * bound; a page whose empty keys lie before its value seeks that bound
 * alone. Every answer equals the query engine's (`pushdown: false`) or the
 * order the engine defines, across the boundary between the branches; a
 * member no index the store creates leads, and SQLite, keep one statement.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

import { PG_URL, withPostgres } from './store-core-engines.js';

const MODEL = { $model: '0.1',
  collections: { c: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' }, n: { type: 'number' }, u: { type: 'string' } } },
    indexes: [{ name: 'by_s', path: '$.s' }, { name: 'by_n', path: '$.n', doubleOrder: true }] } },
  entities: {
    P: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
      kids: { 'x-entity': { relation: { to: 'Item', many: true, via: 'p', onDelete: 'setNull' } } } } } },
    Item: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, s: { type: 'string' }, n: { type: 'number' },
      t: { type: 'string', 'x-entity': { index: true } }, u: { type: 'string' }, p: { type: 'string' } } },
    indexes: [{ name: 'by_s', path: '$.s' }, { name: 'by_n', path: '$.n', doubleOrder: true }] } } };

const ROWS = 60;
/** The members of row `g`: every fifth holds no `s`, `n`, `t` or `p`; the keys tie in threes. @param {number} g */
const member = (g) => (g % 5 === 0 ? { u: `u${g % 7}` }
  : { s: `s${String((g * 13) % 20).padStart(2, '0')}`, n: ((g * 17) % 20) + 0.5, t: `t${(g * 7) % 20}`, u: `u${g % 7}`, p: `p${g % 3}` });
const ids = Array.from({ length: ROWS }, (_, i) => `i${String(i + 1).padStart(2, '0')}`);

/** Rows in insertion (row identity) order, with each id. */
async function fill(/** @type {any} */ store) {
  for (const id of ['p0', 'p1', 'p2']) store.entity('P').create({ id });
  for (let g = 1; g <= ROWS; g++) {
    await store.collection('c').insert({ id: ids[g - 1], ...member(g) });
    store.entity('Item').create({ id: ids[g - 1], ...member(g) });
  }
  await store.saveChanges();
}

/**
 * The ids in the order the engine defines: by `key` (`undefined` the empty
 * key, placed least or greatest), descending where asked, ties by id (the
 * insertion order, so the row identity too).
 * @param {(g: number) => any} key @param {{ desc?: boolean, greatest?: boolean }} order
 */
const ordered = (key, { desc = false, greatest = false }) => ids.map((id, i) => ({ id, k: key(i + 1) })).sort((a, b) => {
  if (a.k === undefined || b.k === undefined) {
    if (a.k === b.k) return a.id < b.id ? -1 : 1;
    // the empty key least: first ascending, last descending; greatest the mirror
    return (a.k === undefined) === (greatest !== desc) ? 1 : -1;
  }
  if (a.k !== b.k) return (a.k < b.k) !== desc ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}).map((row) => row.id);

const G = { $key: '$it.s', $empty: 'greatest' };
const GD = { $key: '$it.s', $empty: 'greatest', $dir: 'desc' };
const D = { $key: '$it.s', $dir: 'desc' };
const window = (/** @type {string} */ root, /** @type {any} */ by, offset = 0, limit = 10) =>
  ({ $subsequence: [{ $for: { it: `$${root}[*]` }, $orderby: Array.isArray(by) ? by : [by], $return: '$it.id' }, offset, limit] });
/** The windows read apart, by name, each with the index its branches read. */
const WINDOWS = {
  'c by s, empty greatest': [(/** @type {any} */ s, /** @type {any} */ o) => s.collection('c').execute(window('', G), o), 'c_by_s'],
  'c by s descending, empty greatest': [(/** @type {any} */ s, /** @type {any} */ o) => s.collection('c').execute(window('', GD), o), 'c_by_s'],
  'c by s, empty greatest, across the boundary': [(/** @type {any} */ s, /** @type {any} */ o) => s.collection('c').execute(window('', G, 44, 8), o), 'c_by_s'],
  'c by n, empty greatest': [(/** @type {any} */ s, /** @type {any} */ o) => s.collection('c').execute(window('', { $key: '$it.n', $empty: 'greatest' }), o), 'c_by_n$double'],
  'c by s, empty greatest, then n': [(/** @type {any} */ s, /** @type {any} */ o) => s.collection('c').execute(window('', [G, '$it.n'], 40), o), 'c_by_s'],
  'c by s, empty greatest, under a condition': [(/** @type {any} */ s, /** @type {any} */ o) => s.collection('c').execute({ $subsequence: [{ $for: { it: '$[*]' },
    $where: { $ne: ['$it.u', 'u3'] }, $orderby: [G], $return: '$it.id' }, 36, 10] }, o), 'c_by_s'],
  'Item by s, empty greatest': [(/** @type {any} */ s, /** @type {any} */ o) => s.execute(window('.Item', G, 42), o), 'Item_by_s'],
  'Item by s descending, empty greatest': [(/** @type {any} */ s, /** @type {any} */ o) => s.execute(window('.Item', GD), o), 'Item_by_s'],
  'Item by t (a flag index), empty greatest': [(/** @type {any} */ s, /** @type {any} */ o) => s.execute(window('.Item', { $key: '$it.t', $empty: 'greatest' }), o), 'Item_t'],
  'Item by p (a foreign key), empty greatest': [(/** @type {any} */ s, /** @type {any} */ o) => s.execute(window('.Item', { $key: '$it.p', $empty: 'greatest' }, 0, 60), o), 'Item_p'],
  'Item by n, empty greatest': [(/** @type {any} */ s, /** @type {any} */ o) => s.execute(window('.Item', { $key: '$it.n', $empty: 'greatest' }), o), 'Item_by_n$double'],
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
  try {
    const driver = () => postgresDriver(pool, { schema: context.schema });
    const store = await openStore(MODEL, { driver: driver() });
    try {
      await fill(store);
      await context.pool.query(`ANALYZE "${context.schema}".c, "${context.schema}"."Item"`);
      await fn({ ...context, sent, store, driver });
    }
    finally { await store.close(); }
  }
  finally { await pool.end(); }
});

/** The statement a call sends last, and the plan the server chooses for it with no sequential scan or sort to fall back on.
 * @param {any} context @param {() => Promise<any>} call */
async function planOfCall({ pool, schema, sent }, call) {
  const from = sent.length;
  await call();
  const statement = sent.slice(from).filter((/** @type {any} */ s) => /^\s*(SELECT|WITH|DECLARE)/i.test(s.text) && / FROM /.test(s.text)).at(-1);
  assert.ok(statement !== undefined, 'a statement was sent');
  const text = statement.text.replace(/^DECLARE "[^"]+" NO SCROLL CURSOR FOR /, '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const setting of ['enable_seqscan', 'enable_sort']) await client.query(`SET LOCAL ${setting} = off`);
    return { text, plan: (await client.query({ text: `EXPLAIN (COSTS OFF) ${text}`, values: statement.values })).rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n') };
  }
  finally { await client.query('ROLLBACK'); client.release(); }
}

/**
 * Assert a statement reads `index` in two branches, the key's and the empty one's: a page's empty rows, ordered by
 * the key, through the key's own index or the empty rows of `index`.
 * @param {{ text: string, plan: string }} read @param {string} index @param {boolean} [page]
 */
const readsApart = ({ text, plan }, index, page = false) => {
  assert.equal(text.split(' UNION ALL ').length, 2, text);
  const name = index.includes('$') ? `"${index.replace('$', '\\$')}"` : `"?${index}"?`;
  assert.match(plan, new RegExp(`Index Scan (Backward )?using ${name} [^\\n]*\\n\\s*Index Cond: \\(.*IS NOT NULL\\)`), plan);
  assert.match(plan, new RegExp(page ? `Index Scan using ("Item_pkey" [^\\n]*\\n\\s*Filter|${name} [^\\n]*\\n\\s*Index Cond): \\(.*IS NULL\\)`
    : `Index Scan using ${name} [^\\n]*\\n\\s*Index Cond: \\(.*IS NULL\\)`), plan);
  assert.doesNotMatch(plan, /Seq Scan/, plan);
  // each branch reads its rows in the index's order: one sort at most, of the two branches' rows
  assert.ok(plan.split('\n').filter((line) => /^\s*(->\s+)?Sort$/.test(line)).length <= 1, plan);
};

/** Every page of a walk, by `orderBy` and `limit`. @param {any} entity @param {any} orderBy @param {number} limit */
async function walk(entity, orderBy, limit) {
  const pages = [];
  /** @type {any} */
  let after;
  for (;;) {
    const page = await entity.page({ orderBy }, { limit, ...(after === undefined ? {} : { after }) });
    pages.push(page.items.map((/** @type {any} */ row) => row.id));
    if (page.continuation === null || page.continuation === undefined) return pages;
    after = page.continuation;
  }
}

describe('an ordering that places the empty key where the index does not', () => {
  it('reads each window through the index in two branches, answering as the engine', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => withCapture(async (context) => {
    const { store } = context;
    for (const [name, [read, index]] of Object.entries(WINDOWS)) {
      assert.deepEqual(await read(store, undefined), await read(store, { pushdown: false }), name);
      readsApart(await planOfCall(context, () => read(store, undefined)), index);
    }
    // the window across the boundary holds rows of both branches
    const across = await WINDOWS['c by s, empty greatest, across the boundary'][0](store, undefined);
    assert.deepEqual(across, ordered((g) => member(g).s, { greatest: true }).slice(44, 52));
  }));

  it('reads a load\'s orderBy so, under its condition, take and skip', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => withCapture(async (context) => {
    const I = context.store.entity('Item').asNoTracking();
    const s = (/** @type {number} */ g) => member(g).s;
    const loads = [
      [{ orderBy: [G], take: 7 }, ordered(s, { greatest: true }).slice(0, 7)],
      [{ orderBy: [GD], take: 7 }, ordered(s, { desc: true, greatest: true }).slice(0, 7)],
      [{ orderBy: [G], take: 7, skip: 44 }, ordered(s, { greatest: true }).slice(44, 51)],
      [{ where: { $ne: ['$it.u', 'u3'] }, orderBy: [G], take: 9, skip: 36 },
        ordered(s, { greatest: true }).filter((id) => member(ids.indexOf(id) + 1).u !== 'u3').slice(36, 45)],
    ];
    for (const [spec, expected] of loads) {
      assert.deepEqual((await I.load(spec)).map((/** @type {any} */ row) => row.id), expected, JSON.stringify(spec));
      readsApart(await planOfCall(context, () => I.load(spec)), 'Item_by_s');
    }
  }));

  it('pages through both branches, a page past a value seeking its bound', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => withCapture(async (context) => {
    const I = context.store.entity('Item');
    const s = (/** @type {number} */ g) => member(g).s;
    const walks = [
      [[G], ordered(s, { greatest: true })],
      [[GD], ordered(s, { desc: true, greatest: true })],
      [[D], ordered(s, { desc: true })],
      ['$it.s', ordered(s, {})],
    ];
    for (const [orderBy, expected] of walks) {
      const pages = await walk(I, orderBy, 7);
      assert.deepEqual(pages.flat(), expected, JSON.stringify(orderBy));
      // a page holds the last rows that hold the key and the first that hold none
      assert.ok(pages.some((page) => page.some((id) => s(ids.indexOf(id) + 1) === undefined) && page.some((id) => s(ids.indexOf(id) + 1) !== undefined)));
    }
    // the first page, and a page past a value the empty keys follow, read apart; that page seeks its bound
    readsApart(await planOfCall(context, () => I.page({ orderBy: [G] }, { limit: 7 })), 'Item_by_s', true);
    const second = (/** @type {any} */ orderBy) => async () => I.page({ orderBy }, { limit: 7, after: (await I.page({ orderBy }, { limit: 7 })).continuation });
    const read = await planOfCall(context, second([G]));
    readsApart(read, 'Item_by_s', true);
    // the empty rows by the key alone, which the key's index holds in order
    assert.match(read.text, /"r"\."s" IS NULL ORDER BY "r"\."id" ASC LIMIT 8\)\) AS "r" ORDER BY/, read.text);
    assert.match(read.plan, /Index Cond: \(\(s >= '[^']+'::text\) AND \(s IS NOT NULL\)\)/, read.plan);
    // the empty keys before the value: the bound alone, one statement
    const deep = await planOfCall(context, async () => I.page({ orderBy: '$it.s' }, { limit: 7, after: (await I.page({ orderBy: '$it.s' }, { limit: 40 })).continuation }));
    assert.ok(!deep.text.includes(' UNION ALL '), deep.text);
    assert.match(deep.plan, /Index Scan using "Item_by_s" [^\n]*\n\s*Index Cond: \(s >= '[^']+'::text\)/, deep.plan);
    // descending with the empty keys last is the index read backward: one statement, as the page was
    const descending = await planOfCall(context, second([D]));
    assert.ok(!descending.text.includes(' UNION ALL ') && !descending.text.includes(' <= '), descending.text);
    assert.match(descending.plan, /Index Scan Backward using "Item_by_s"/, descending.plan);
    // a page past an empty key that sorts last stays in the empty rows: one statement
    const empty = await planOfCall(context, async () => I.page({ orderBy: [G] }, { limit: 7, after: (await I.page({ orderBy: [G] }, { limit: 50 })).continuation }));
    assert.ok(!empty.text.includes(' UNION ALL '), empty.text);
  }));

  it('keeps one statement over a member no index the store creates leads', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => withCapture(async (context) => {
    const { store } = context;
    const U = { $key: '$it.u', $empty: 'greatest' };
    for (const call of [() => store.collection('c').execute(window('', U)), () => store.execute(window('.Item', U)),
      () => store.entity('Item').asNoTracking().load({ orderBy: [U], take: 5 }), () => store.entity('Item').page({ orderBy: [U] }, { limit: 5 })]) {
      const { text } = await planOfCall(context, call);
      assert.ok(!text.includes(' UNION ALL '), text);
    }
    // nor a window with no limit
    const { text } = await planOfCall(context, () => store.collection('c').execute({ $for: { it: '$[*]' }, $orderby: [G], $return: '$it.id' }));
    assert.ok(!text.includes(' UNION ALL '), text);
  }));

  it('reads a table an earlier release created as that release did, its plain indexes serving the empty key last', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => withCapture(async (context) => {
    const { pool, schema } = context;
    await context.store.close();
    // as an earlier release created them: plain, none beside a number's
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      // filtered here, not in the query: a condition on `indexdef` would let the server deparse an
      // index of another schema another test is dropping
      const ordered = (await client.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1', [schema])).rows
        .filter((/** @type {any} */ row) => String(row.indexdef).includes('NULLS FIRST'));
      for (const { indexname, indexdef } of ordered) {
        await client.query(`DROP INDEX "${indexname}"`);
        if (!indexname.endsWith('$double')) await client.query(String(indexdef).replace(/ NULLS FIRST, rid\)$/, ')'));
      }
      await client.query('ANALYZE');
    }
    finally { client.release(); }
    const store = await openStore(MODEL, { driver: context.driver() });
    try {
      const reads = { ...context, store };
      for (const [name, [read]] of Object.entries(WINDOWS)) {
        assert.deepEqual(await read(store, undefined), await read(store, { pushdown: false }), name);
        const { text } = await planOfCall(reads, () => read(store, undefined));
        assert.ok(!text.includes(' UNION ALL ') && /NULLS (LAST|FIRST), /.test(text), `${name}: ${text}`);
      }
      // the window the plain index serves reads it, so a profile that refuses a full-table scan answers it
      const plain = await planOfCall(reads, () => WINDOWS['c by s, empty greatest'][0](store, undefined));
      assert.match(plain.plan, /Index Scan using c_by_s on c/, plain.plan);
      assert.deepEqual(await store.collection('c').execute(window('', G), { profile: { refuseFullScan: true } }),
        ordered((g) => member(g).s, { greatest: true }).slice(0, 10));
      const I = store.entity('Item');
      assert.deepEqual((await walk(I, [G], 7)).flat(), ordered((g) => member(g).s, { greatest: true }));
      assert.deepEqual((await walk(I, '$it.s', 7)).flat(), ordered((g) => member(g).s, {}));
      for (const orderBy of [[G], '$it.s']) {
        const page = await planOfCall(reads, async () => I.page({ orderBy }, { limit: 7, after: (await I.page({ orderBy }, { limit: 30 })).continuation }));
        assert.ok(!page.text.includes(' UNION ALL ') && !page.text.includes(' >= '), page.text);
      }
      const load = await planOfCall(reads, () => I.asNoTracking().load({ orderBy: [G], take: 7 }));
      assert.ok(!load.text.includes(' UNION ALL '), load.text);
    }
    finally { await store.close(); }
  }));

  it('keeps one statement on SQLite, answering alike', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      await fill(store);
      for (const [name, [read]] of Object.entries(WINDOWS)) {
        assert.deepEqual(await read(store, undefined), await read(store, { pushdown: false }), name);
      }
      assert.ok(!(await store.collection('c').explain(window('', G))).sql.includes('UNION'));
      assert.ok(!(await store.explain(window('.Item', G))).sql.includes('UNION'));
      assert.deepEqual((await walk(store.entity('Item'), [G], 7)).flat(), ordered((g) => member(g).s, { greatest: true }));
    }
    finally { await store.close(); }
  });
});
