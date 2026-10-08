//@ts-check
/**
 * @file The predicate term bound on a real PostgreSQL server: one statement
 * carries at most the dialect's `maxPredicateTerms` leaf predicates (128),
 * counted over the whole statement once the planner has regrouped it — the
 * document's filters, every include filter and the profile's mandatory
 * predicate. Above the bound a query document runs in the engine with the
 * named reason `predicate.termBound` (strict mode refuses it by name), and a
 * graph load or a native mutation, which have no engine path, refuse by
 * name. A chain the planner folds is one leaf however long it is. Every
 * answer equals the residual's; SQLite sets no bound (`list-membership.test.js`).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, reasonId } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { asyncLive } from '@jarenjs/db/async-live';
import { liveOracle } from './oracle/replication.js';

const url = process.env.JAREN_PG_URL;
const key = { 'x-entity': { key: true } };
const MODEL = {
  $model: '0.1',
  collections: {
    items: {
      schema: { type: 'object', properties: { id: { type: 'string' }, sku: { type: 'string' }, n: { type: 'integer' } } },
      key: '/id', indexes: [{ name: 'sku', path: '$.sku' }],
    },
  },
  entities: {
    Item: { schema: { type: 'object', properties: {
      id: { type: 'string', ...key }, sku: { type: 'string', 'x-entity': { index: true } }, n: { type: 'integer', 'x-entity': { index: true } } } } },
  },
};
/** One more row than the safe profile's `maxRows`: a residual's root fetch crosses it. */
const ROWS = 1001;
const BOUND = 128;
const IDS = Array.from({ length: 5000 }, (_, i) => `s${i * 2}`);
/** @param {any} v the engine answers one item as itself and none as `undefined` */
const sorted = (v) => [...(Array.isArray(v) ? v : v === undefined ? [] : [v])].sort();
/** @param {any} predicate */
const overItems = (predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' });
/** @param {any} predicate */
const overItem = (predicate) => ({ $for: { it: '$.Item[*]' }, $where: predicate, $orderby: ['$it.id'], $return: '$it.id' });
/**
 * `count` pairs `sku = s<2i> AND n >= i` (two leaves each, which nothing
 * regroups), plus one equality on a third member when `plusOne`.
 * @param {number} count @param {boolean} [plusOne]
 */
const chain = (count, plusOne = false) => ({ $or: [
  ...IDS.slice(0, count).map((id, i) => ({ $and: [{ $eq: ['$it.sku', id] }, { $ge: ['$it.n', i] }] })),
  ...(plusOne ? [{ $eq: ['$it.id', 'i1'] }] : []),
] });
/** The rows `chain(count, plusOne)` selects. @param {number} count @param {boolean} [plusOne] */
const expectedFor = (count, plusOne = false) =>
  sorted([...IDS.slice(0, count).map((id) => `i${id.slice(1)}`), ...(plusOne ? ['i1'] : [])]);
/** A top-level conjunction of `count` inequalities, one leaf each. @param {number} count */
const inequalities = (count) => ({ $and: Array.from({ length: count }, (_, i) => ({ $ne: ['$it.n', i] })) });
const AT_BOUND = chain(BOUND / 2);
const ABOVE = chain(BOUND / 2, true);
/** @param {any} explanation */
const reasonOf = (explanation) => reasonId(explanation.residual.reasons[0].reason);
const TERM_BOUND = /more predicate terms/;

describe('PostgreSQL: the predicate term bound', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_term_bound_${process.pid}`;

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: url, max: 1 });
    store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }),
      capture: { mode: 'journal', log: { retention: 2 } }, live: asyncLive({ pollMs: 60000 }) });
    await store.transaction(async (/** @type {any} */ tx) => {
      for (let i = 0; i < ROWS; i++) {
        await tx.collection('items').put({ id: `i${i}`, sku: `s${i}`, n: i });
        await tx.entity('Item').create({ id: `i${i}`, sku: `s${i}`, n: i });
      }
    });
    await admin.query(`ANALYZE "${schema}"."items"`);
    await admin.query(`ANALYZE "${schema}"."Item"`);
  });
  after(async () => {
    await store?.close().catch(() => {});
    await pool?.end().catch(() => {});
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  it('129 leaves run in the engine with the named reason and strict mode refuses them; 128 stay native', async () => {
    const items = store.collection('items');
    const collectionPlan = await items.explain(overItems(ABOVE));
    assert.equal(collectionPlan.mode, 'set');
    assert.equal(reasonOf(collectionPlan), 'predicate.termBound');
    assert.deepEqual(sorted(await items.execute(overItems(ABOVE))), expectedFor(BOUND / 2, true));
    assert.deepEqual(sorted(await items.execute(overItems(ABOVE), { pushdown: false })), expectedFor(BOUND / 2, true));
    await assert.rejects(async () => items.execute(overItems(ABOVE), { strict: true }),
      (/** @type {any} */ error) => error.code === 'JD0010' && TERM_BOUND.test(error.message));
    const entityPlan = await store.explain(overItem(ABOVE));
    assert.equal(entityPlan.mode, 'set');
    assert.equal(reasonOf(entityPlan), 'predicate.termBound');
    assert.deepEqual(await store.execute(overItem(ABOVE)), expectedFor(BOUND / 2, true));
    assert.deepEqual(await store.execute(overItem(ABOVE), { pushdown: false }), expectedFor(BOUND / 2, true));
    await assert.rejects(async () => store.execute(overItem(ABOVE), { strict: true }),
      (/** @type {any} */ error) => error.code === 'JD0010' && TERM_BOUND.test(error.message));
    // at the bound: native on both forms, the same answer
    assert.equal((await items.explain(overItems(AT_BOUND))).mode, 'native');
    assert.deepEqual(sorted(await items.execute(overItems(AT_BOUND), { strict: true })), expectedFor(BOUND / 2));
    assert.equal((await store.explain(overItem(AT_BOUND))).mode, 'native');
    assert.deepEqual(await store.execute(overItem(AT_BOUND), { strict: true }), expectedFor(BOUND / 2));
  });

  it('a top-level $and of 129 inequalities is residual with that reason; 128 stay native', async () => {
    const items = store.collection('items');
    const expected = (/** @type {number} */ count) =>
      sorted(Array.from({ length: ROWS - count }, (_, i) => `i${i + count}`));
    const above = inequalities(BOUND + 1);
    assert.equal(reasonOf(await items.explain(overItems(above))), 'predicate.termBound');
    assert.deepEqual(sorted(await items.execute(overItems(above))), expected(BOUND + 1));
    assert.equal(reasonOf(await store.explain(overItem(above))), 'predicate.termBound');
    assert.deepEqual(await store.execute(overItem(above)), expected(BOUND + 1));
    const within = inequalities(BOUND);
    assert.equal((await items.explain(overItems(within))).mode, 'native');
    assert.deepEqual(sorted(await items.execute(overItems(within))), expected(BOUND));
    assert.equal((await store.explain(overItem(within))).mode, 'native');
    assert.deepEqual(await store.execute(overItem(within)), expected(BOUND));
  });

  it('a graph load has no engine path: 129 leaves are refused by name, 128 load', async () => {
    const entity = store.entity('Item');
    const refused = (/** @type {any} */ error) => error.code === 'JD0032' && TERM_BOUND.test(error.message)
      && /execute\(\) answers it in the engine/.test(error.message);
    await assert.rejects(async () => entity.load({ where: ABOVE }), refused);
    await assert.rejects(async () => entity.explainLoad({ where: ABOVE }), refused);
    assert.deepEqual(sorted((await entity.load({ where: AT_BOUND })).map((/** @type {any} */ row) => row.id)), expectedFor(BOUND / 2));
    assert.equal(typeof (await entity.explainLoad({ where: AT_BOUND })).sql, 'string');
  });

  it('a native mutation has no engine path: 129 leaves are refused by name, 128 run', async () => {
    const physical = `${schema}_physical`;
    await admin.query(`CREATE SCHEMA "${physical}"; CREATE TABLE "${physical}".parts (
      id integer PRIMARY KEY, label text NOT NULL, qty integer NOT NULL);
      INSERT INTO "${physical}".parts VALUES (1, 'p0', 5), (2, 'p2', 5), (3, 'zz', 0)`);
    const physicalPool = new pg.Pool({ connectionString: url, max: 1 });
    /** @type {any} */
    let physicalStore;
    try {
      physicalStore = await openStore({ $model: '0.1', entities: { Part: {
        schema: { type: 'object', properties: { id: { type: 'integer', ...key }, label: { type: 'string' }, qty: { type: 'integer' } } },
        physical: { schema: physical, table: 'parts', columns: {
          id: { name: 'id', codec: 'integer', null: 'reject' }, label: { name: 'label', codec: 'text', null: 'reject' },
          qty: { name: 'qty', codec: 'integer', null: 'reject' } } } } } },
      { driver: postgresDriver(physicalPool, { schema: physical }), adopt: true });
      const parts = physicalStore.entity('Part');
      const where = (/** @type {number} */ count, plusOne = false) => ({ $or: [
        ...Array.from({ length: count }, (_, i) => ({ $and: [{ $eq: ['$it.label', `p${i * 2}`] }, { $ge: ['$it.qty', i] }] })),
        ...(plusOne ? [{ $eq: ['$it.id', 3] }] : []),
      ] });
      await assert.rejects(async () => parts.mutate({ op: 'update', set: { qty: 7 }, where: where(BOUND / 2, true) }),
        (/** @type {any} */ error) => error.code === 'JD0038' && TERM_BOUND.test(error.message));
      await assert.rejects(async () => parts.mutate({ op: 'insert-select', source: 'Part', conflict: ['id'], onConflict: 'nothing',
        select: { id: '$it.id', label: '$it.label', qty: '$it.qty' }, where: where(BOUND / 2, true) }),
      (/** @type {any} */ error) => error.code === 'JD0038' && TERM_BOUND.test(error.message));
      assert.equal((await parts.mutate({ op: 'update', set: { qty: 7 }, where: where(BOUND / 2) })).affected, 2);
      assert.equal((await parts.get(1)).qty, 7);
      assert.equal((await parts.get(3)).qty, 0);
    }
    finally {
      await physicalStore?.close().catch(() => {});
      await physicalPool.end().catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS "${physical}" CASCADE`);
    }
  });

  it('under a profile a demoted document is refused where its residual fetch is', async () => {
    // the safe profile bounds the residual's root fetch at `maxRows` (1,000):
    // 1,001 rows cross it; refusing full scans refuses the residual by shape
    await assert.rejects(async () => store.execute(overItem(ABOVE), { profile: 'safe' }), { code: 'JD2007' });
    await assert.rejects(async () => store.execute(overItem(ABOVE), { profile: { refuseFullScan: true } }),
      (/** @type {any} */ error) => error.code === 'JD0011' && TERM_BOUND.test(error.message));
    await assert.rejects(async () => store.explain(overItem(ABOVE), { profile: { refuseFullScan: true } }), { code: 'JD0011' });
    const items = store.collection('items');
    await assert.rejects(async () => items.execute(overItems(ABOVE), { profile: 'safe' }), { code: 'JD2007' });
    await assert.rejects(async () => items.execute(overItems(ABOVE), { profile: { refuseFullScan: true } }), { code: 'JD0011' });
    // at the bound the same profiles admit the native statement
    assert.deepEqual(await store.execute(overItem(AT_BOUND), { profile: 'safe' }), expectedFor(BOUND / 2));
    assert.deepEqual(await store.execute(overItem(AT_BOUND), { profile: { refuseFullScan: true } }), expectedFor(BOUND / 2));
    assert.deepEqual(sorted(await items.execute(overItems(AT_BOUND), { profile: 'safe' })), expectedFor(BOUND / 2));
  });

  it("the count includes the profile's mandatory predicate: 128 leaves plus a one-leaf predicate are residual", async () => {
    // a row bound above the table, so the residual's fetch answers
    const profile = { maxRows: 2000, predicates: { items: { $ge: ['$it.n', 0] }, Item: { $ge: ['$it.n', 0] } } };
    const items = store.collection('items');
    assert.equal(reasonOf(await items.explain(overItems(AT_BOUND), { profile })), 'predicate.termBound');
    assert.deepEqual(sorted(await items.execute(overItems(AT_BOUND), { profile })), expectedFor(BOUND / 2));
    assert.equal(reasonOf(await store.explain(overItem(AT_BOUND), { profile })), 'predicate.termBound');
    assert.deepEqual(await store.execute(overItem(AT_BOUND), { profile }), expectedFor(BOUND / 2));
    // one leaf fewer, and the statement carries the predicate natively
    const within = chain(BOUND / 2 - 1);
    assert.equal((await items.explain(overItems(within), { profile })).mode, 'native');
    assert.deepEqual(sorted(await items.execute(overItems(within), { profile })), expectedFor(BOUND / 2 - 1));
    assert.equal((await store.explain(overItem(within), { profile })).mode, 'native');
    assert.deepEqual(await store.execute(overItem(within), { profile }), expectedFor(BOUND / 2 - 1));
  });

  it('a chain the planner folds is one leaf: a 5,000-element $seq and a same-member 5,000-term $or stay native', async () => {
    const items = store.collection('items');
    const seq = { $eq: ['$it.sku', { $seq: IDS }] };
    const disjunction = { $or: IDS.map((id) => ({ $eq: ['$it.sku', id] })) };
    const expected = sorted(Array.from({ length: Math.ceil(ROWS / 2) }, (_, i) => `i${i * 2}`));
    for (const predicate of [seq, disjunction]) {
      assert.equal((await items.explain(overItems(predicate))).mode, 'native');
      assert.deepEqual(sorted(await items.execute(overItems(predicate), { strict: true })), expected);
      assert.equal((await store.explain(overItem(predicate))).mode, 'native');
      assert.deepEqual(await store.execute(overItem(predicate), { strict: true }), expected);
    }
  });

  it('a live registration over 129 leaves re-snapshots through execute(), where the engine answers it', async () => {
    // an asynchronous host maintains every registration by re-snapshot,
    // and a snapshot is an execute() of the document: the bound is met
    // there, not where the registration is classified
    const items = store.collection('items');
    const document = overItems(ABOVE);
    assert.equal(reasonOf(await items.explain(document)), 'predicate.termBound');
    const live = await items.live(document, { mode: 'auto' });
    try {
      assert.equal(live.mode.strategy, 'resnapshot');
      const oracle = liveOracle(live, () => items.execute([document]));
      await oracle.check();
      assert.deepEqual(sorted(live.result.rows), expectedFor(BOUND / 2, true));
      await items.put({ id: 'i2000', sku: 's2', n: 2000 });
      await live.refresh();
      await oracle.check();
      assert.deepEqual(sorted(live.result.rows), sorted([...expectedFor(BOUND / 2, true), 'i2000']));
      oracle.close();
    }
    finally { live.close(); }
  });
});
