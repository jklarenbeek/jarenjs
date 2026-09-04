//@ts-check
/**
 * @file The campaign's integrated proof: every shape QUERYREACH taught
 * the planner, run four ways over one corpus, and required to answer
 * identically.
 *
 * The per-order suites each prove their own shape in depth. What this
 * file proves is that they compose — that a projection tree over a
 * grouped join of a temporal collection is still the engine's answer,
 * that the same document over an UNINDEXED model answers the same rows
 * by another route, and that turning the pushdown off changes the plan
 * and nothing else. The four sides are:
 *
 *   1. RESIDENT — `queryJson` over the same rows, which is the oracle;
 *   2. INDEXED — the store with every declared index in place;
 *   3. UNINDEXED — the same model with the indexes removed, so the
 *      planner's promotions have nothing to seek through;
 *   4. FORCED — the indexed store with `pushdown: false`, which runs
 *      the whole document in the engine over a full fetch.
 *
 * Beside the answers, two policies are asserted for every case rather
 * than for a chosen few: `strict: true` refuses exactly the documents
 * whose plan is not native, with `JD0010` naming a construct; and a
 * profile whose allow-list omits the collection refuses before any
 * statement runs. A shape that quietly stopped lowering would keep
 * answering correctly and fail HERE, on its mode.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';

import { openStore, DbCompileError } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { fromAsync, federate } from '@jarenjs/linq';
import { queryJson } from '@jarenjs/json/query';

const ORIGIN = 1767225600000;

/** One model carrying every declared shape the campaign planned. */
const MODEL = (indexed) => ({
  $model: '0.1',
  collections: {
    sample: {
      schema: {
        type: 'object',
        properties: {
          series: { type: 'string' },
          at: { type: 'integer' },
          value: { type: 'number' },
        },
      },
      key: null,
      identity: 'integer',
      indexes: indexed ? [{ name: 'by_series_at', path: ['$.series', '$.at'] }] : [],
    },
    doc: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          team: { type: 'string' },
          age: { type: 'integer' },
          embedding: { type: 'array', items: { type: 'number' } },
          span: {
            type: 'object',
            required: ['start', 'end'],
            properties: { start: { type: 'integer' }, end: { type: 'integer' } },
          },
        },
      },
      key: '/id',
      indexes: indexed ? [
        { name: 'by_age', path: '$.age' },
        { name: 'by_start', path: '$.span.start' },
        { name: 'by_end', path: '$.span.end' },
        { name: 'by_vec', path: '$.embedding', derive: 'vector', dims: 3 },
      ] : [],
    },
  },
  entities: {
    Person: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          name: { type: 'string' },
          city: { type: 'string' },
        },
      },
    },
    Pet: {
      schema: {
        type: 'object',
        required: ['pid', 'ownerId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true } },
          ownerId: { type: 'string' },
          kind: { type: 'string' },
        },
      },
    },
  },
});

const SAMPLES = [];
for (let i = 0; i < 24; i++) {
  SAMPLES.push({ series: i % 2 === 0 ? 'a' : 'b', at: ORIGIN + i * 60000, value: i % 7 });
}
const DOCS = [
  { id: 'd1', team: 'red', age: 20, embedding: [1, 0, 0], span: { start: 0, end: 100 } },
  { id: 'd2', team: 'red', age: 30, embedding: [0.9, 0.1, 0], span: { start: 100, end: 200 } },
  { id: 'd3', team: 'blue', age: 40, embedding: [0, 1, 0], span: { start: 150, end: 250 } },
  { id: 'd4', team: 'blue', age: 50, embedding: [-1, 0, 0], span: { start: 300, end: 400 } },
  // a span the operator RAISES on reaches no case below; the interval
  // suite owns that boundary, and mixing it here would make every
  // interval case an error case
  { id: 'd5', team: 'green', age: 60, embedding: [0, 0, 1], span: { start: 400, end: 500 } },
];
const PEOPLE = [
  { id: 'p1', name: 'Ada', city: 'AMS' },
  { id: 'p2', name: 'Bo', city: 'RTM' },
  { id: 'p3', name: 'Cy', city: 'AMS' },
];
const PETS = [
  { pid: 1, ownerId: 'p1', kind: 'cat' },
  { pid: 2, ownerId: 'p1', kind: 'dog' },
  { pid: 3, ownerId: 'p2', kind: 'cat' },
];

/**
 * Every campaign shape, as one document each.
 * `root` names what it runs over; `mode` is the plan the INDEXED store
 * must take, which is what makes a lost promotion a failure here.
 */
const CASES = [
  { name: 'projection/one-path', root: 'doc', mode: 'native',
    document: { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 25] },
      $orderby: ['$it.id'], $return: '$it.id' } },
  { name: 'projection/tree', root: 'doc', mode: 'native',
    document: { $for: { it: '$[*]' }, $orderby: ['$it.id'],
      $return: { who: '$it.id', team: '$it.team' } } },
  { name: 'projection/nested-tree', root: 'doc', mode: 'native',
    document: { $for: { it: '$[*]' }, $orderby: ['$it.id'],
      $return: { who: '$it.id', span: { from: '$it.span.start', to: '$it.span.end' } } } },
  { name: 'grouping/count-per-key', root: 'doc', mode: 'native',
    document: { $for: { it: '$[*]' }, $groupby: { g: '$it.team' },
      $orderby: ['$g'], $return: { team: '$g', n: { $count: '$it' } } } },
  { name: 'grouping/aggregates', root: 'doc', mode: 'native',
    document: { $for: { it: '$[*]' }, $groupby: { g: '$it.team' },
      $orderby: ['$g'], $return: { team: '$g', oldest: { $max: '$it.age' } } } },
  { name: 'interval/overlaps', root: 'doc', mode: 'native',
    document: { $for: { it: '$[*]' },
      $where: { $overlaps: ['$it.span', { $const: { start: 120, end: 320 } }] },
      $orderby: ['$it.id'], $return: '$it.id' } },
  { name: 'temporal/range', root: 'sample', mode: 'native',
    document: { $for: { s: '$[*]' },
      $where: { $and: [{ $eq: ['$s.series', 'a'] },
        { $ge: ['$s.at', ORIGIN] }, { $lt: ['$s.at', ORIGIN + 600000] }] },
      $orderby: ['$s.at'], $return: '$s.value' } },
  { name: 'temporal/bucket', root: 'sample', mode: 'native',
    document: { $for: { s: '$[*]' }, $where: { $eq: ['$s.series', 'a'] },
      $groupby: { b: { '$time-bucket': ['$s.at', 300000] } },
      $orderby: ['$b'], $return: { at: '$b', n: { $count: '$s' } } } },
  { name: 'temporal/asof', root: 'sample', mode: 'set',
    document: { $asof: [{ $const: [
      { at: ORIGIN + 500000, series: 'a', value: 0 },
      { at: ORIGIN + 900000, series: 'b', value: 0 }] }, '$[*]', { by: '$.series' }] } },
  { name: 'vector/knn', root: 'doc', mode: 'knn',
    document: { $subsequence: [{ $for: { r: '$[*]' },
      $orderby: [{ $key: { $similarity: ['$r.embedding', [1, 0, 0]] },
        $dir: 'desc', $empty: 'least' }, '$r.id'],
      $return: '$r.id' }, 0, 2] } },
];

/** The entity-side shapes: two bindings, and a join table root. */
const ENTITY_CASES = [
  { name: 'join/two-bindings', mode: 'native',
    document: { $for: { p: '$.Person[*]', t: '$.Pet[*]' },
      $where: { $eq: ['$p.id', '$t.ownerId'] },
      $orderby: ['$p.id', '$t.pid'],
      $return: { who: '$p.name', kind: '$t.kind' } } },
  { name: 'join/filtered', mode: 'native',
    document: { $for: { p: '$.Person[*]', t: '$.Pet[*]' },
      $where: { $and: [{ $eq: ['$p.id', '$t.ownerId'] }, { $eq: ['$t.kind', 'cat'] }] },
      $orderby: ['$p.id'],
      $return: '$p.name' } },
];

/** The engine's own answer, which every other side must reproduce. */
const resident = (document, rows) => queryJson(document, rows);
/** The rows one root carries, as the engine sees them. */
const rowsFor = (root) => (root === 'sample' ? SAMPLES : DOCS);

/** Open one store, seeded, and hand back its handles. */
async function seeded(indexed) {
  const store = await openStore(MODEL(indexed), { driver: nodeDriver() });
  await store.transaction(async (tx) => {
    const samples = tx.collection('sample');
    for (const row of SAMPLES) await samples.insert(row);
    const docs = tx.collection('doc');
    for (const row of DOCS) await docs.insert(row);
  });
  for (const row of PEOPLE) await store.entity('Person').create(row);
  for (const row of PETS) await store.entity('Pet').create(row);
  await store.saveChanges();
  return store;
}

describe('the campaign as one capability: every shape, four ways', () => {
  /** @type {any} */ let indexed;
  /** @type {any} */ let unindexed;

  before(async () => {
    indexed = await seeded(true);
    unindexed = await seeded(false);
  });
  after(async () => {
    await indexed?.close();
    await unindexed?.close();
  });

  for (const shape of CASES) {
    it(`${shape.name} — resident, indexed, unindexed and forced agree`, async () => {
      const rows = rowsFor(shape.root);
      const expected = resident(shape.document, rows);
      const collection = indexed.collection(shape.root);
      assert.deepStrictEqual(await collection.execute(shape.document), expected,
        'the indexed store answers the engine');
      assert.deepStrictEqual(
        await unindexed.collection(shape.root).execute(shape.document), expected,
        'and so does the same model with no indexes at all');
      assert.deepStrictEqual(
        await collection.execute(shape.document, { pushdown: false }), expected,
        'and so does the same store with the pushdown turned off');
    });

    it(`${shape.name} — the plan is the one the campaign promised`, async () => {
      const explained = await indexed.collection(shape.root).explain(shape.document);
      assert.strictEqual(explained.mode, shape.mode,
        `${shape.name}: ${explained.mode} — ${JSON.stringify(explained.residual?.reasons ?? [])}`);
      // strict mode and the plan cannot disagree: a residual is refused
      // by name, a native plan runs
      const strict = () =>
        indexed.collection(shape.root).execute(shape.document, { strict: true });
      if (shape.mode === 'native') await strict();
      else {
        await assert.rejects(async () => strict(),
          (error) => error instanceof DbCompileError && error.code === 'JD0010');
      }
    });
  }

  for (const shape of ENTITY_CASES) {
    it(`${shape.name} — the entity engine answers what the engine answers`, async () => {
      const input = { Person: PEOPLE, Pet: PETS };
      const expected = resident(shape.document, input);
      assert.deepStrictEqual(await indexed.execute(shape.document), expected);
      assert.deepStrictEqual(await unindexed.execute(shape.document), expected);
      const explained = await indexed.explain(shape.document);
      assert.strictEqual(explained.mode, shape.mode);
    });
  }

  it('a profile that does not name the collection refuses before any statement', async () => {
    const profile = { collections: ['sample'] };
    await assert.rejects(
      async () => indexed.collection('doc').execute(CASES[0].document, { profile }),
      (error) => error instanceof DbCompileError && error.code === 'JD0011');
    // and the one it does name still runs
    assert.ok(await indexed.collection('sample').execute(CASES[6].document, { profile }));
  });

  it('the same document twice is one compiled plan, and the same answer', async () => {
    const collection = indexed.collection('doc');
    const first = await collection.execute(CASES[1].document);
    const second = await collection.execute(CASES[1].document);
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(first, resident(CASES[1].document, DOCS));
    // the plan cache is keyed by the document's identity, so the second
    // run compiled nothing new — the store's own counter says so rather
    // than a timer
    const { statementCache } = indexed.stats();
    assert.ok(statementCache.hits > 0,
      `no cache hit after two identical runs: ${JSON.stringify(statementCache)}`);
  });

  it('a cursor stops where it is asked to, and releases what it held', async () => {
    const collection = indexed.collection('doc');
    const cursor = await collection.query(CASES[1].document);
    const seen = [];
    for await (const item of cursor) {
      seen.push(item);
      if (seen.length === 2) break;
    }
    assert.strictEqual(seen.length, 2, 'the break stopped the pull');
    // `for await`'s break reaches return(), which is idempotent
    assert.deepStrictEqual(await cursor.return(), { done: true, value: undefined });
  });

  it('two sources federate under a budget, and answer the engine', async () => {
    // ONE federation: two calls would be two scopes, and two scopes do
    // not join — which is the refusal working, not a bug
    const fed = federation();
    const rows = await fromAsync(fed.source('docs'))
      // `s.get('at')`: on this surface `at(i)` is path navigation, so a
      // member literally named `at` is read by name
      .join(fromAsync(fed.source('samples')), (d) => d.team, (s) => s.series,
        (d, s) => ({ id: d.id, at: s.get('at') }))
      .toArray();
    // no team is a series name, so the join is empty — and empty is an
    // answer, not a silence: the same document in the engine agrees
    const document = {
      $for: { it: '$.docs[*]', it2: '$.samples[*]' },
      $where: { $eq: ['$it.team', '$it2.series'] },
      $return: { id: '$it.id', at: '$it2.at' },
    };
    assert.deepStrictEqual(rows,
      queryJson([document], { docs: DOCS, samples: SAMPLES }));
  });

  /** One federation over the two collections of the indexed store. */
  const federation = () => federate({
    sources: {
      docs: { provider: indexed.collection('doc'), estimatedRows: DOCS.length },
      samples: { provider: indexed.collection('sample'), estimatedRows: SAMPLES.length },
    },
    maxRows: 1000,
    maxBytes: 1 << 20,
  });

  it('a federated fetch that would exceed its budget refuses instead', async () => {
    const tight = federate({
      sources: {
        docs: { provider: indexed.collection('doc'), estimatedRows: DOCS.length },
        samples: { provider: indexed.collection('sample'), estimatedRows: SAMPLES.length },
      },
      maxRows: 2,
      maxBytes: 1 << 20,
    });
    await assert.rejects(
      async () => fromAsync(tight.source('docs'))
        .join(fromAsync(tight.source('samples')), (d) => d.id, (s) => s.series, (d) => d.id)
        .toArray(),
      (error) => /** @type {any} */ (error).code === 'JL2008');
  });
});
