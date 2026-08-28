//@ts-check
/**
 * @file N+1 is a test, not a promise: a counting shim under the node
 * adapter records every statement EXECUTION, and the graph-load
 * assertions demand exactly one per `load` call — regardless of
 * include depth, parent count, per-relation clauses or repetition.
 * The contrast case runs the same shape as per-parent queries and
 * counts the N+1 the include machinery exists to avoid.
 *
 * The as-of join has the same failure mode and the same test. An as-of
 * answers once per LEFT row, so the naive shape is one indexed lookup
 * per probe — fast per probe and linear in probes. The batched plan
 * bounds the fetch by the probes' own span and their keys and issues
 * exactly ONE statement, whatever the probe count, which is what makes
 * "cannot degenerate to a full scan per left row" checkable rather
 * than asserted.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { from, fromAsync } from '@jarenjs/linq';
import { adaptNodeDatabase } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          name: { type: 'string' },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'authorId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true } },
          stars: { type: 'integer' },
          authorId: { type: 'string' },
          comments: { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } },
        },
      },
    },
    Comment: {
      schema: {
        type: 'object',
        required: ['cid'],
        properties: {
          cid: { type: 'integer', 'x-entity': { key: true } },
          postId: { type: 'integer' },
        },
      },
    },
  },
};

const counters = { executed: 0 };

/** Shim a DatabaseSync so every statement execution is counted. */
function countedDatabase(db) {
  return {
    exec: (sql) => {
      counters.executed++;
      return db.exec(sql);
    },
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (...params) => {
          counters.executed++;
          return statement.run(...params);
        },
        get: (...params) => {
          counters.executed++;
          return statement.get(...params);
        },
        all: (...params) => {
          counters.executed++;
          return statement.all(...params);
        },
        iterate: (...params) => {
          counters.executed++;
          return statement.iterate(...params);
        },
      };
    },
    function: (name, options, fn) => db.function(name, options, fn),
    aggregate: (name, spec) => db.aggregate(name, spec),
    createSession: (options) => db.createSession(options),
    close: () => db.close(),
  };
}

/** @type {any} */
let store = null;

before(async () => {
  const db = new DatabaseSync(':memory:');
  store = await openStore(MODEL, {
    driver: { open: () => adaptNodeDatabase(countedDatabase(db)) },
  });
  for (let i = 1; i <= 10; i++) {
    await store.entity('User').create({ id: `u${i}`, name: `n${i}` });
  }
  let cid = 0;
  for (let pid = 1; pid <= 30; pid++) {
    await store.entity('Post').create({
      pid, stars: pid % 5, authorId: `u${1 + ((pid - 1) % 10)}`,
    });
    for (let c = 0; c < 2; c++) {
      cid += 1;
      await store.entity('Comment').create({ cid, postId: pid });
    }
  }
});
after(async () => {
  if (store !== null) await store.close();
});

describe('exactly one statement per graph load', () => {
  it('two include levels over thirty children: one statement', async () => {
    counters.executed = 0;
    const graph = await store.entity('User').load({
      orderBy: '$it.id',
      include: { posts: { include: { comments: true } } },
    });
    assert.strictEqual(counters.executed, 1,
      `expected ONE statement, counted ${counters.executed}`);
    assert.strictEqual(graph.length, 10);
    assert.strictEqual(
      graph.reduce((n, u) => n + u.posts.length, 0), 30);
    assert.strictEqual(
      graph.reduce((n, u) => n + u.posts.reduce((m, p) => m + p.comments.length, 0), 0),
      60);
  });

  it('per-relation where/orderBy/take and counts stay one statement', async () => {
    counters.executed = 0;
    await store.entity('User').load({
      where: { $eq: ['$it.name', 'n3'] },
      include: { posts: {
        where: { $ge: ['$it.stars', 2] },
        orderBy: { $key: '$it.stars', $dir: 'desc' },
        take: 2,
        include: { comments: { count: true } },
      } },
    });
    assert.strictEqual(counters.executed, 1);
  });

  it('repeating the load costs one statement each time, never one per row', async () => {
    counters.executed = 0;
    await store.entity('User').load({ include: { posts: true } });
    await store.entity('User').load({ include: { posts: true } });
    assert.strictEqual(counters.executed, 2);
  });

  it('a linq join over two entity sets of one store is ONE statement on both surfaces', async () => {
    const posts = store.sync.entity('Post');
    const users = store.sync.entity('User');
    const chain = from(posts).join(from(users), (p) => p.authorId, (u) => u.id, (p) => p);
    const explained = await store.explain(chain.toDocument());
    assert.strictEqual(explained.mode, 'native');
    assert.deepStrictEqual(explained.join,
      { left: { binding: 'it', column: 'authorId' }, right: { binding: 'it2', column: 'id' } });
    counters.executed = 0;
    const rows = chain.toArray();
    assert.strictEqual(counters.executed, 1, `expected ONE statement, counted ${counters.executed}`);
    assert.strictEqual(rows.length, 30);
    counters.executed = 0;
    const streamed = await fromAsync(store.entity('Post'))
      .join(fromAsync(store.entity('User')), (p) => p.authorId, (u) => u.id, (p) => p).toArray();
    assert.strictEqual(counters.executed, 1, 'the asynchronous provider receives the same one document');
    assert.strictEqual(streamed.length, 30);
    // the contrast, declared: a PROJECTED join is the residual over both fetched roots
    counters.executed = 0;
    const projected = from(posts).join(from(users), (p) => p.authorId, (u) => u.id,
      (p, u) => ({ pid: p.pid, by: u.name })).toArray();
    assert.strictEqual(projected.length, 30);
    assert.strictEqual(counters.executed, 2,
      'the projection runs in the engine over the two fetched roots (MODEL-FORMAT §10.6)');
  });

  it('a relation hop on the chain is the residual over the fetched roots: one fetch per root, never per row', async () => {
    const posts = store.sync.entity('Post');
    const users = store.sync.entity('User');
    // the to-many hop in a projection: the engine runs it over both roots
    const commented = from(posts).select((p) => ({ pid: p.pid, n: p.comments.all().count() }));
    const explained = store.sync.explain(commented.toDocument());
    assert.strictEqual(explained.mode, 'set');
    assert.deepStrictEqual(explained.referenced, ['Post', 'Comment']);
    counters.executed = 0;
    const rows = commented.toArray();
    assert.strictEqual(rows.length, 30);
    assert.ok(rows.every((row) => row.n === 2));
    assert.strictEqual(counters.executed, 2,
      'two referenced roots, two fetches — the correlated phrase never issues a statement per row');
    // the to-many count in a filter: the same two fetches for ten parents
    counters.executed = 0;
    const prolific = from(users).where((u) => u.posts.all().count().ge(3)).select((u) => u.id).toArray();
    assert.strictEqual(prolific.length, 10);
    assert.strictEqual(counters.executed, 2);
    // and the async twin receives the same document once
    counters.executed = 0;
    assert.strictEqual((await fromAsync(store.entity('User')).where((u) => u.posts.all().exists()).count()), 10);
    assert.strictEqual(counters.executed, 2);
  });

  it('the contrast: per-parent querying is the N+1 the include avoids', async () => {
    counters.executed = 0;
    const parents = await store.entity('User').load({ orderBy: '$it.id' });
    for (const parent of parents) {
      await store.execute({
        $for: { p: '$.Post[*]' },
        $where: { $eq: ['$p.authorId', '$parent'] },
        $return: '$p',
      }, { externals: { parent: parent.id } });
    }
    assert.strictEqual(counters.executed, 1 + parents.length,
      'ten parents cost eleven statements the include path collapses to one');
  });
});


// ————— the as-of join's statement bound —————

const SAMPLES = {
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
      indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }],
    },
  },
};

const ORIGIN = 1767225600000;
/** Two series, one row a second, for two thousand seconds. */
const RIGHT = Array.from({ length: 2000 }, (_, i) =>
  ({ series: i % 2 === 0 ? 'a' : 'b', at: ORIGIN + i * 1000, value: i + 0.5 }));
/** Probes inside a narrow window, so a bounded fetch is visibly small. */
const probes = (n) => Array.from({ length: n }, (_, i) =>
  ({ series: 'a', at: ORIGIN + 1000000 + i * 137, value: i }));

describe('an as-of join costs one statement, whatever the probes number', () => {
  /** @type {any} */
  let seriesStore = null;
  /** @type {any} */
  let samples = null;

  before(async () => {
    const db = new DatabaseSync(':memory:');
    seriesStore = await openStore(SAMPLES, {
      driver: { open: () => adaptNodeDatabase(countedDatabase(db)) },
    });
    samples = seriesStore.collection('sample');
    await seriesStore.transaction(async () => {
      for (const row of RIGHT) await samples.insert(row);
    });
  });
  after(async () => {
    if (seriesStore !== null) await seriesStore.close();
  });

  for (const count of [1, 10, 200]) {
    it(`${count} probes: one statement, and the candidates are bounded`, async () => {
      counters.executed = 0;
      const left = probes(count);
      const answer = await samples.execute(
        { $asof: [{ $const: left }, '$[*]', { by: '$.series', tolerance: 2000 }] });
      assert.strictEqual(counters.executed, 1,
        'a fetch per probe is exactly the shape the bound exists to refuse');
      const items = Array.isArray(answer) ? answer : [answer];
      assert.strictEqual(items.length, count, 'every left row stays in the answer');
      const explained = await samples.explain(
        { $asof: [{ $const: left }, '$[*]', { by: '$.series', tolerance: 2000 }] });
      assert.ok(explained.series.counts.candidates < RIGHT.length / 4,
        `the fetch read ${explained.series.counts.candidates} of ${RIGHT.length} rows`);
      assert.strictEqual(explained.series.counts.statements, 1);
      assert.match(explained.scanNarrative, /USING INDEX sample_by_series_at/);
    });
  }

  it('the contrast: one indexed lookup per probe is the N+1 the batch collapses', async () => {
    counters.executed = 0;
    const left = probes(10);
    for (const probe of left) {
      await samples.execute({ $subsequence: [{
        $for: { s: '$[*]' },
        $where: { $and: [{ $eq: ['$s.series', 'a'] }, { $le: ['$s.at', probe.at] }] },
        $orderby: [{ $key: '$s.at', $dir: 'desc' }],
        $return: '$s',
      }, 0, 1] });
    }
    assert.strictEqual(counters.executed, left.length,
      'ten probes cost ten statements the batched plan answers with one');
  });
});
