//@ts-check
/**
 * @file The row estimate PostgreSQL's planner gives a native statement, as
 * `explain().budget.estimatedRows`: the top plan node's `Plan Rows` from
 * `EXPLAIN (FORMAT JSON)`, run as a statement of its own beside the plain
 * `EXPLAIN` whose prose is the scan narrative, with the values that
 * narrative binds, and labelled `{ rows, source: 'postgresql-planner' }` so
 * it is never read as a count. Collection `explain`, entity `explain` and
 * `explainLoad` carry it for a native plan. A plan the engine answers
 * (`pushdown: false`, a document past the term bound, a diverted external),
 * a statement some slot of which could not be bound to its real value, and
 * every SQLite store stay `'unavailable'`: no number is made up where the
 * planner priced a different statement or none.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, reasonId, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver, postgresDialect } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;
const LABEL = 'postgresql-planner';
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
const ROWS = 1000;
/** Ten skus: one membership list, whichever way it is spelled. */
const TEN = { $or: Array.from({ length: 10 }, (_, i) => ({ $eq: ['$it.sku', `s${i * 7}`] })) };
/** @param {any} predicate */
const overItems = (predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' });
/** @param {any} predicate */
const overItem = (predicate) => ({ $for: { it: '$.Item[*]' }, $where: predicate, $orderby: ['$it.id'], $return: '$it.id' });
/** 129 pairs of leaves that nothing regroups: past the dialect's term bound. */
const PAST_BOUND = { $or: Array.from({ length: 65 }, (_, i) => ({ $and: [{ $eq: ['$it.sku', `s${i * 2}`] }, { $ge: ['$it.n', i] }] })) };

describe('the PostgreSQL dialect asks for the planner estimate and reads it', () => {
  const pg = postgresDialect();

  it('spells the JSON form of EXPLAIN and leaves the plain one as it was', () => {
    assert.equal(pg.explainEstimate('SELECT 1'), 'EXPLAIN (FORMAT JSON) SELECT 1');
    assert.equal(pg.explainQuery('SELECT 1'), 'EXPLAIN SELECT 1');
    assert.equal(sqliteDialect.explainEstimate, null, 'SQLite has no statement that returns a row estimate');
    assert.equal(sqliteDialect.readEstimate, null);
  });

  it('reads the top node\'s Plan Rows from the JSON text the driver hands over, or from the parsed array', () => {
    const plan = [{ Plan: { 'Node Type': 'Sort', 'Plan Rows': 200,
      Plans: [{ 'Node Type': 'Bitmap Heap Scan', 'Plan Rows': 7 }] } }];
    const expected = { rows: 200, source: LABEL };
    assert.deepEqual(pg.readEstimate([{ 'QUERY PLAN': JSON.stringify(plan) }]), expected);
    assert.deepEqual(pg.readEstimate([{ 'QUERY PLAN': plan }]), expected);
  });

  it('answers null for anything it cannot read, never a number it made up', () => {
    for (const rows of [
      [], [{}], [{ 'QUERY PLAN': null }],
      [{ 'QUERY PLAN': 'Seq Scan on users  (cost=0.00..1.05 rows=5 width=64)' }],
      [{ 'QUERY PLAN': '[]' }], [{ 'QUERY PLAN': '[{"Plan":{}}]' }],
      [{ 'QUERY PLAN': '[{"Plan":{"Plan Rows":"7"}}]' }],
      [{ 'QUERY PLAN': '[{"Plan":{"Plan Rows":-1}}]' }],
    ]) assert.equal(pg.readEstimate(rows), null, JSON.stringify(rows));
  });
});

describe('SQLite reports no estimate and keeps explainLoad synchronous', () => {
  it('a native plan, an entity plan and a graph load are \'unavailable\', and no promise appears', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      assert.equal(store.capabilities.rowEstimates, false);
      const collection = await store.collection('items').explain(overItems(TEN));
      assert.equal(collection.mode, 'native');
      assert.equal(collection.budget.estimatedRows, 'unavailable');
      const entity = await store.entity('Item').explain(overItem(TEN));
      assert.equal(entity.mode, 'native');
      assert.equal(entity.budget.estimatedRows, 'unavailable');
      const loaded = store.entity('Item').explainLoad({ where: TEN });
      assert.ok(!(loaded instanceof Promise), 'a driver without estimates asks nothing, so the answer is a value');
      assert.equal(loaded.budget.estimatedRows, 'unavailable');
    }
    finally { await store.close(); }
  });
});

describe('PostgreSQL: the labelled row estimate', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_estimates_${process.pid}`;
  /** Every statement the driver sent to the server, in order. @type {{ text: string, values: any[] }[]} */
  const sent = [];

  /**
   * What the server's planner says for a statement the store sent: the
   * top node's `Plan Rows`, asked for beside the store.
   * @param {{ text: string, values: any[] }} statement
   */
  const plannerRows = async (statement) => {
    const result = await admin.query({ text: statement.text, values: statement.values });
    return result.rows[0]['QUERY PLAN'][0].Plan['Plan Rows'];
  };
  const jsonStatements = () => sent.filter((statement) => statement.text.startsWith('EXPLAIN (FORMAT JSON) '));
  const proseStatements = () => sent.filter((statement) => /^EXPLAIN [^(]/.test(statement.text));

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    pool = new pg.Pool({ connectionString: url, max: 1 });
    const source = {
      connect: async () => {
        const client = await pool.connect();
        if (client.recorded !== true) {
          const query = client.query.bind(client);
          client.query = (/** @type {any} */ config, /** @type {any} */ values) => {
            if (typeof config === 'string') sent.push({ text: config, values: values ?? [] });
            else if (typeof config?.text === 'string') sent.push({ text: config.text, values: config.values ?? [] });
            return query(config, values);
          };
          client.recorded = true;
        }
        return client;
      },
    };
    store = await openStore(MODEL, { driver: postgresDriver(source, { schema }) });
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

  it('the connection reports row estimates', () => {
    assert.equal(store.capabilities.rowEstimates, true);
  });

  it('a native collection plan carries the planner\'s estimate, from a statement of its own beside the narrative', async () => {
    sent.length = 0;
    const explained = await store.collection('items').explain(overItems(TEN));
    assert.equal(explained.mode, 'native');
    const estimate = explained.budget.estimatedRows;
    assert.deepEqual(Object.keys(estimate).sort(), ['rows', 'source']);
    assert.equal(estimate.source, LABEL);
    assert.ok(Number.isInteger(estimate.rows) && estimate.rows >= 1 && estimate.rows <= ROWS, String(estimate.rows));
    // two statements, the estimate's first, over the values the narrative binds
    assert.equal(jsonStatements().length, 1);
    assert.equal(proseStatements().length, 1);
    assert.equal(jsonStatements()[0].text, `EXPLAIN (FORMAT JSON) ${explained.sql}`);
    assert.equal(proseStatements()[0].text, `EXPLAIN ${explained.sql}`);
    assert.deepEqual(jsonStatements()[0].values, proseStatements()[0].values);
    assert.equal(estimate.rows, await plannerRows(jsonStatements()[0]), 'the number is the planner\'s own answer');
    assert.match(explained.scanNarrative, /\(cost=\d/, 'the narrative is still the plain EXPLAIN prose');
  });

  it('a native entity plan carries it too', async () => {
    sent.length = 0;
    const explained = await store.entity('Item').explain(overItem(TEN));
    assert.equal(explained.mode, 'native');
    const estimate = explained.budget.estimatedRows;
    assert.deepEqual(Object.keys(estimate).sort(), ['rows', 'source']);
    assert.equal(estimate.source, LABEL);
    assert.ok(Number.isInteger(estimate.rows) && estimate.rows >= 1 && estimate.rows <= ROWS, String(estimate.rows));
    assert.equal(jsonStatements().length, 1);
    assert.equal(jsonStatements()[0].text, `EXPLAIN (FORMAT JSON) ${explained.sql}`);
    assert.deepEqual(jsonStatements()[0].values, proseStatements()[0].values);
    assert.equal(estimate.rows, await plannerRows(jsonStatements()[0]));
    assert.match(explained.scanNarrative, /\(cost=\d/);
  });

  it('explainLoad asks the server, so it answers a promise, with the estimate of its one statement', async () => {
    sent.length = 0;
    const pending = store.entity('Item').explainLoad({ where: TEN });
    assert.ok(pending instanceof Promise, 'a value would have to be made up without a round trip');
    const explained = await pending;
    const estimate = explained.budget.estimatedRows;
    assert.deepEqual(Object.keys(estimate).sort(), ['rows', 'source']);
    assert.equal(estimate.source, LABEL);
    assert.ok(Number.isInteger(estimate.rows) && estimate.rows >= 1 && estimate.rows <= ROWS, String(estimate.rows));
    assert.equal(jsonStatements().length, 1);
    assert.equal(proseStatements().length, 0, 'a load has no narrative, so no plain EXPLAIN');
    assert.equal(jsonStatements()[0].text, `EXPLAIN (FORMAT JSON) ${explained.sql}`);
    assert.equal(estimate.rows, await plannerRows(jsonStatements()[0]));
  });

  it('a keyset page statement is estimated over the same slots it binds', async () => {
    const set = store.entity('Item');
    const first = await set.page({}, { limit: 3 });
    sent.length = 0;
    const explained = await set.explainLoad({ after: first.continuation });
    assert.equal(explained.pagination, 'keyset');
    assert.equal(explained.budget.estimatedRows.source, LABEL);
    assert.equal(jsonStatements().length, 1);
    assert.equal(explained.budget.estimatedRows.rows, await plannerRows(jsonStatements()[0]));
  });

  it('a plan the engine answers is \'unavailable\' and asks the server nothing more', async () => {
    const items = store.collection('items');
    const native = await items.explain(overItems(TEN));
    assert.equal(native.budget.estimatedRows.source, LABEL, 'the same document, answered natively, is priced');
    sent.length = 0;
    const residual = await items.explain(overItems(TEN), { pushdown: false });
    assert.equal(residual.mode, 'set');
    assert.equal(residual.budget.estimatedRows, 'unavailable');
    const pastBound = await items.explain(overItems(PAST_BOUND));
    assert.equal(pastBound.mode, 'set');
    assert.equal(reasonId(pastBound.residual.reasons[0].reason), 'predicate.termBound');
    assert.equal(pastBound.budget.estimatedRows, 'unavailable');
    const entity = await store.entity('Item').explain(overItem(TEN), { pushdown: false });
    assert.equal(entity.mode, 'set');
    assert.equal(entity.budget.estimatedRows, 'unavailable');
    assert.deepEqual(jsonStatements(), [], 'no estimate statement for a statement that does not answer the document');
  });

  it('an external the call does not bind leaves the slot \'unavailable\': the planner would price a NULL', async () => {
    const items = store.collection('items');
    const document = overItems({ $eq: ['$it.sku', '$wanted'] });
    sent.length = 0;
    const abstract = await items.explain(document);
    assert.equal(abstract.mode, 'native');
    assert.equal(abstract.budget.estimatedRows, 'unavailable');
    assert.deepEqual(jsonStatements(), []);
    assert.ok(proseStatements()[0].values.length > 0 && proseStatements()[0].values.every((/** @type {any} */ value) => value === null),
      'the narrative binds NULL for it, which is why no estimate is priced from those values');
    sent.length = 0;
    const bound = await items.explain(document, { externals: { wanted: 's4' } });
    assert.equal(bound.mode, 'native');
    assert.equal(bound.budget.estimatedRows.source, LABEL);
    assert.equal(jsonStatements().length, 1);
    assert.deepEqual(jsonStatements()[0].values, proseStatements()[0].values);
    assert.equal(bound.budget.estimatedRows.rows, await plannerRows(jsonStatements()[0]));
    // an entity plan binds no external at all, so it prices none
    sent.length = 0;
    const entity = await store.entity('Item').explain(overItem({ $eq: ['$it.sku', '$wanted'] }), { externals: { wanted: 's4' } });
    assert.equal(entity.mode, 'native');
    assert.equal(entity.budget.estimatedRows, 'unavailable');
    assert.deepEqual(jsonStatements(), []);
  });
});
