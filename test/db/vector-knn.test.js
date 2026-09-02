//@ts-check
/**
 * @file The k-nearest plan: `$orderby` on a `$similarity` key,
 * descending, `$empty: 'least'`, under a `$subsequence` window, over a
 * member a `derive: 'vector'` column stores. Recognized, the plan is
 * a CUT the engine finishes: the statement projects (identity,
 * column) under the pushed WHERE — no ORDER BY, no similarity call,
 * no LIMIT — the engine scores and keeps every row within the margin
 * of the `offset + limit`-th best, the winners' documents are fetched
 * by identity, and the whole document runs over them, so the order,
 * the ties, the offset and the unrankable tail are the engine's by
 * definition. Not recognized, `explain()` says why.
 *
 * Every shape here is asserted on the plan MODE and its reason, not
 * only on the answer: a k-nearest query that silently fell to the
 * whole-collection residual would answer correctly forever and never
 * say it read the whole table.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  openStore, normalizeModel, planCollection, sqliteDialect, createDialect, planQuery,
  emitPlan, assertNoSqlText, PLAN_VERSION, cutCandidates, identityBatches, KNN_MARGIN,
  IDENTITY_CHUNK, probeVector, columnScore, classifyLiveQuery,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { packVector, l2Normalize } from '@jarenjs/core/vector';

import { fullDoubleDialect } from './helpers.js';

const DIMS = 3;
const COLUMN = 'gx_embedding_v3';

const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    tag: { type: 'string' },
    embedding: { type: 'array', items: { type: 'number' } },
    at: { type: ['array', 'object'] },
  },
};
const VECTOR_INDEX = { name: 'by_vec', path: '$.embedding', derive: 'vector', dims: DIMS };
const model = (indexes) => ({
  $model: '0.1',
  collections: { rows: { schema: SCHEMA, key: null, identity: 'integer', indexes } },
});
const INDEXED = model([VECTOR_INDEX]);
const UNINDEXED = model([]);

/** The planner shape for a model, as the query engine builds it. */
function shapeOf(document) {
  const rows = normalizeModel(document).get('rows');
  const physical = planCollection('rows', rows, sqliteDialect);
  return {
    shape: { collection: 'rows', schema: rows.schema, columnByCanonical: physical.columnByCanonical,
      virtualByStem: new Map() },
    physical: { table: physical.table, keyColumn: physical.keyColumn, docColumn: physical.docColumn },
  };
}
const INDEXED_SHAPE = shapeOf(INDEXED);
const UNINDEXED_SHAPE = shapeOf(UNINDEXED);

/** The published recipe, parameterized. */
const ranked = (extra = {}, key = { $similarity: ['$r.embedding', '$q'] }, spec = {}) => ({
  $for: { r: '$[*]' },
  ...extra,
  $orderby: [{ $key: key, $dir: 'desc', $empty: 'least', ...spec }, '$r.id'],
  $return: '$r.id',
});
const topK = (k, extra = {}, key = undefined, spec = undefined) =>
  ({ $subsequence: [ranked(extra, key, spec), 0, k] });

const Q = [1, 0, 0];
/** Six rows: two exact ties, one opposite, two unrankable, one orthogonal. */
const ROWS = [
  { id: 'east', embedding: [0.9, 0.1, 0], tag: 'a' },
  { id: 'tie-b', embedding: [1, 1, 0], tag: 'b' },
  { id: 'none', tag: 'a' },
  { id: 'tie-a', embedding: [2, 2, 0], tag: 'a' },
  { id: 'narrow', embedding: [1, 0], tag: 'a' },
  { id: 'west', embedding: [-1, 0, 0], tag: 'b' },
  { id: 'north', embedding: [0, 1, 0], tag: 'a' },
];

async function storeOver(document, options = {}) {
  const store = await openStore(document, { driver: nodeDriver(), ...options });
  const rows = store.collection('rows');
  for (const row of ROWS) await rows.insert(row);
  return { store, rows };
}

const reasonsOf = (planned) => planned.reasons.map((r) => `${r.construct}: ${r.reason}`);
/** `execute` is value-or-promise (a synchronous driver throws synchronously). */
const attempt = (fn) => Promise.resolve().then(fn);

describe('recognition — the k-nearest shape, and every reason it is not one', () => {
  it('the canonical shape over the column is mode knn, carrying a rank and no order or window', () => {
    const planned = planQuery(topK(3), INDEXED_SHAPE.shape);
    assert.strictEqual(planned.mode, 'knn');
    assertNoSqlText(planned.plan);
    assert.deepStrictEqual(planned.plan, {
      planVersion: PLAN_VERSION,
      alg: 'select',
      collection: 'rows',
      filter: null,
      order: null,
      window: null,
      rank: { column: COLUMN, dims: DIMS, probe: { ext: 'q' }, offset: 0, limit: 3, margin: KNN_MARGIN },
      bucket: null,
      aggregate: null,
      project: 'document',
    });
    // the reason strict mode will name: the rank itself, first
    assert.match(planned.reasons[0].reason, /k-nearest rank is engine work/);
    assert.strictEqual(planned.reasons[0].construct, '$orderby');
    assert.deepStrictEqual(planned.prefilters, []);
  });

  it('a literal probe of the column width is a plan-time literal; the other operand order works', () => {
    const planned = planQuery(topK(2, {}, { $similarity: [[0, 1, 0], '$r.embedding'] }), INDEXED_SHAPE.shape);
    assert.strictEqual(planned.mode, 'knn');
    assert.deepStrictEqual(planned.plan.rank.probe, { lit: [0, 1, 0] });
  });

  it('the offset composes into the cut, and nested windows compose as pushed windows do', () => {
    const offset = planQuery({ $subsequence: [ranked(), 2, 3] }, INDEXED_SHAPE.shape);
    assert.strictEqual(offset.mode, 'knn');
    assert.deepStrictEqual([offset.plan.rank.offset, offset.plan.rank.limit], [2, 3]);
    const nested = planQuery({ $subsequence: [{ $subsequence: [ranked(), 2] }, 1, 3] }, INDEXED_SHAPE.shape);
    assert.strictEqual(nested.mode, 'knn');
    assert.deepStrictEqual([nested.plan.rank.offset, nested.plan.rank.limit], [3, 3]);
  });

  it('a pushed WHERE narrows the fetch; an exact spatial pre-filter rides along', () => {
    const tagged = planQuery(topK(2, { $where: { $eq: ['$r.tag', 'a'] } }), INDEXED_SHAPE.shape);
    assert.strictEqual(tagged.mode, 'knn');
    assert.strictEqual(tagged.plan.filter.p, 'cmp');
    const spatial = shapeOf(model([VECTOR_INDEX, { name: 'by_at', path: '$.at', derive: 'bbox' }]));
    const boxed = planQuery(topK(2, { $where: { '$bbox-intersects': ['$r.at', [0, 0, 1, 1]] } }), spatial.shape);
    assert.strictEqual(boxed.mode, 'knn');
    assert.deepStrictEqual(boxed.prefilters.map((p) => [p.construct, p.exact]), [['$bbox-intersects', true]]);
  });

  it('every refusal is named — the matrix', () => {
    const cases = [
      [topK(3), UNINDEXED_SHAPE.shape, /no vector column over \$\.embedding$/],
      [topK(3, {}, { $similarity: ['$r.embedding', [1, 0]] }), UNINDEXED_SHAPE.shape,
        /no vector column over \$\.embedding at width 2/],
      [topK(3, {}, { $similarity: ['$r.embedding', [1, 0]] }), INDEXED_SHAPE.shape,
        /literal probe has 2 components but the vector column over \$\.embedding is declared at 3/],
      [topK(3, {}, { $similarity: ['$r.embedding', [1, 'x', 0]] }), INDEXED_SHAPE.shape,
        /probe must be a literal vector/],
      [topK(3, {}, { $similarity: ['$r.embedding', { $div: [1, 0] }] }), INDEXED_SHAPE.shape,
        /probe must be a literal vector/],
      [topK(3, {}, { $similarity: ['$q', [1, 0, 0]] }), INDEXED_SHAPE.shape,
        /singular member path on the binding/],
      [topK(3, {}, undefined, { $dir: 'asc' }), INDEXED_SHAPE.shape, /only descending/],
      [topK(3, {}, undefined, { $empty: 'greatest' }), INDEXED_SHAPE.shape, /only under \$empty: 'least'/],
      [ranked(), INDEXED_SHAPE.shape, /needs a window with a finite limit/],
      [{ $subsequence: [ranked(), 2] }, INDEXED_SHAPE.shape, /needs a window with a finite limit/],
      [{ $count: ranked() }, INDEXED_SHAPE.shape, /needs a window with a finite limit/],
      [topK(3, { $let: { d: 1 } }), INDEXED_SHAPE.shape, /pushed whole/],
      [topK(3, { $where: { $gt: [{ $similarity: ['$r.embedding', '$q'] }, 0] } }), INDEXED_SHAPE.shape,
        /pushed whole/],
      [topK(3, { $where: { $within: ['$r.at', { type: 'Point', coordinates: [0, 0] }] } }),
        shapeOf(model([VECTOR_INDEX, { name: 'by_at', path: '$.at', derive: 'bbox' }])).shape,
        /pushed whole/],
    ];
    const report = [];
    for (const [document, shape, reason] of cases) {
      const planned = planQuery(document, shape);
      const named = planned.reasons.some((r) => reason.test(r.reason));
      report.push(`${planned.mode} ${named ? 'named' : 'MISSING ' + reason} | ${reasonsOf(planned).join(' ; ')}`);
      assert.notStrictEqual(planned.mode, 'knn', report.at(-1));
      assert.strictEqual(planned.plan?.rank ?? null, null, 'a refused shape carries no rank');
    }
    assert.deepStrictEqual(report.filter((line) => line.includes('MISSING')), [], report.join('\n'));
  });

  it('two widths over one path: a literal probe chooses, an external cannot', () => {
    const two = shapeOf(model([VECTOR_INDEX, { name: 'wide', path: '$.embedding', derive: 'vector', dims: 4 }]));
    assert.strictEqual(planQuery(topK(1, {}, { $similarity: ['$r.embedding', [1, 0, 0, 0]] }), two.shape)
      .plan.rank.column, 'gx_embedding_v4');
    const external = planQuery(topK(1), two.shape);
    assert.strictEqual(external.mode, 'set');
    assert.ok(external.reasons.some((r) => /several vector widths/.test(r.reason)), reasonsOf(external).join(';'));
  });

  it('$similarity outside the first ordering key is an ordinary residual, with the ordinary reasons', () => {
    const projected = planQuery({ $for: { r: '$[*]' }, $return: { s: { $similarity: ['$r.embedding', '$q'] } } },
      INDEXED_SHAPE.shape);
    assert.strictEqual(projected.mode, 'row');
    const secondKey = planQuery({ $subsequence: [{ $for: { r: '$[*]' },
      $orderby: ['$r.id', { $key: { $similarity: ['$r.embedding', '$q'] }, $dir: 'desc' }],
      $return: '$r.id' }, 0, 2] }, INDEXED_SHAPE.shape);
    assert.strictEqual(secondKey.mode, 'set');
    assert.ok(secondKey.reasons.some((r) => /ordering translates only over singular schema-typed paths/.test(r.reason)));
  });
});

describe('emission — the fetch statement and the by-identities fetch', () => {
  const doubled = fullDoubleDialect(createDialect);

  it('projects (identity, column) under the pushed WHERE with no ORDER BY, no LIMIT and no similarity call', () => {
    const planned = planQuery(topK(3, { $where: { $eq: ['$r.tag', 'a'] } }), INDEXED_SHAPE.shape);
    const { sql, slots } = emitPlan(planned.plan, sqliteDialect, INDEXED_SHAPE.physical);
    assert.strictEqual(sql,
      `SELECT "rowid" AS "rid", "${COLUMN}" AS "vec" FROM "rows" WHERE (json_type("doc", '$."tag"') IS NOT NULL `
      + `AND json_type("doc", '$."tag"') = 'text' AND jsonb_extract("doc", '$."tag"') = ?)`);
    assert.deepStrictEqual(slots, [{ literal: 'a' }], 'the probe never binds into SQL');
    assert.doesNotMatch(sql, /ORDER BY|LIMIT|similarity|jaren_/i);
  });

  it('the same plan renders through the double dialect in its own spelling, and so does the fetch', () => {
    const planned = planQuery(topK(3), INDEXED_SHAPE.shape);
    const viaDouble = emitPlan(planned.plan, doubled, INDEXED_SHAPE.physical).sql;
    assert.strictEqual(viaDouble, `SELECT [rid] AS [rid], [${COLUMN}] AS [vec] FROM [rows]`);
    assert.strictEqual(doubled.dml.selectByIdentities(INDEXED_SHAPE.physical, 2),
      'SELECT JTEXT([doc]) AS [doc] FROM [rows] WHERE [rid] AMONG (@p1, @p2) ORDER BY [rid]');
    assert.strictEqual(sqliteDialect.dml.selectByIdentities(INDEXED_SHAPE.physical, 2),
      'SELECT json("doc") AS "doc" FROM "rows" WHERE "rowid" IN (?, ?) ORDER BY "rowid"');
  });
});

describe('the cut — arithmetic over scores, no vectors', () => {
  const row = (identity, score) => ({ identity, score });

  it('keeps every row within the margin of the m-th best, ties at the boundary included, in identity order', () => {
    const rows = [row(5, 0.2), row(1, 0.9), row(3, 0.5), row(2, 0.5 - KNN_MARGIN / 2), row(4, null)];
    assert.deepStrictEqual(cutCandidates(rows, 2, KNN_MARGIN), { identities: [1, 2, 3], scored: 4, full: false });
    assert.deepStrictEqual(cutCandidates(rows, 1, KNN_MARGIN).identities, [1]);
    assert.deepStrictEqual(cutCandidates(rows, 4, KNN_MARGIN).identities, [1, 2, 3, 5]);
  });

  it('a window past the scored rows takes every row, unrankable ones included; an empty window takes none', () => {
    const rows = [row(2, 0.1), row(1, null), row(3, 0.3)];
    assert.deepStrictEqual(cutCandidates(rows, 3, KNN_MARGIN), { identities: [1, 2, 3], scored: 2, full: true });
    assert.deepStrictEqual(cutCandidates(rows, 2, KNN_MARGIN), { identities: [2, 3], scored: 2, full: false });
    assert.deepStrictEqual(cutCandidates(rows, 0, KNN_MARGIN), { identities: [], scored: 2, full: false });
    assert.deepStrictEqual(cutCandidates([], 1, KNN_MARGIN), { identities: [], scored: 0, full: true });
  });

  it('a boundary pair one binary32 ulp apart lands together, whichever side the rounded score puts each', () => {
    // two vectors whose exact cosines to the probe differ by less than
    // 1e-7: the column's binary32 dot may order them either way, and
    // the margin keeps both so the engine decides from the raw doubles
    const probe = probeVector([0.7564519643783569, -0.26373839378356934, 0.07680127024650574], 3);
    const a = [0.7172666788101196, -0.38058799505233765, 0.0384393185377121];
    const b = [...a.slice(0, -1), Math.fround(a[2] + 4e-9)];
    assert.notDeepStrictEqual(a, b, 'the perturbation survives binary32');
    const scoreOf = (v) => columnScore(packVector(l2Normalize(v)), 3, /** @type {any} */ (probe));
    const rows = [row(1, 0.999), row(2, scoreOf(a)), row(3, scoreOf(b)), row(4, -0.5)];
    assert.ok(Math.abs(rows[1].score - rows[2].score) < 1e-7);
    assert.deepStrictEqual(cutCandidates(rows, 2, KNN_MARGIN).identities, [1, 2, 3]);
    assert.deepStrictEqual(cutCandidates(rows, 2, 0).identities.length, 2, 'without the margin one of the pair is cut');
  });

  it('a score is null for a column that holds no vector, and the probe refuses a wrong width', () => {
    const probe = probeVector([1, 0, 0], 3);
    assert.ok(probe instanceof Float32Array);
    assert.strictEqual(columnScore(null, 3, /** @type {any} */ (probe)), null);
    assert.strictEqual(columnScore(new Uint8Array(8), 3, /** @type {any} */ (probe)), null);
    assert.strictEqual(columnScore(packVector([0, 1, 0]), 3, /** @type {any} */ (probe)), 0);
    assert.strictEqual(probeVector([1, 0], 3), null);
    assert.strictEqual(probeVector('x', 3), null);
    assert.strictEqual(probeVector([1, NaN, 0], 3), null);
  });

  it('identity batches pad to a prepared size and never exceed the chunk', () => {
    assert.deepStrictEqual(identityBatches([]), []);
    assert.deepStrictEqual(identityBatches([7]), [{ size: 1, params: [7] }]);
    assert.deepStrictEqual(identityBatches([1, 2, 3]), [{ size: 4, params: [1, 2, 3, null] }]);
    const many = identityBatches(Array.from({ length: IDENTITY_CHUNK + 3 }, (_, i) => i + 1));
    assert.deepStrictEqual(many.map((batch) => [batch.size, batch.params.filter((p) => p !== null).length]),
      [[IDENTITY_CHUNK, IDENTITY_CHUNK], [4, 3]]);
  });
});

describe('execution — the column cuts, the engine decides', () => {
  const EXPECTED = ['east', 'tie-a', 'tie-b', 'north', 'west', 'narrow', 'none'];

  it('every window agrees with the unindexed store and the engine, ties by the secondary key', async () => {
    const indexed = await storeOver(INDEXED);
    const plain = await storeOver(UNINDEXED);
    try {
      for (let k = 0; k <= 8; k++) {
        for (let offset = 0; offset <= 3; offset++) {
          const document = { $subsequence: [ranked(), offset, k] };
          const fast = await indexed.rows.execute(document, { externals: { q: Q } });
          const slow = await plain.rows.execute(document, { externals: { q: Q } });
          const want = EXPECTED.slice(offset, offset + k);
          const expected = want.length === 0 ? undefined : want.length === 1 ? want[0] : want;
          assert.deepStrictEqual(fast, expected, `indexed k=${k} offset=${offset}`);
          assert.deepStrictEqual(slow, expected, `unindexed k=${k} offset=${offset}`);
        }
      }
      const stats = indexed.rows.stats().knn;
      assert.strictEqual(stats.queries, 36);
      assert.ok(stats.candidates >= 36, 'a candidate count per query, at least the window');
      assert.ok(stats.fullFetches > 0, 'the windows past the scored rows fetched everything');
      assert.deepStrictEqual(plain.rows.stats().knn, { queries: 0, rows: 0, candidates: 0, fullFetches: 0, diverted: 0 });
    }
    finally {
      await indexed.store.close();
      await plain.store.close();
    }
  });

  it('explain() names the mode, the rank, the barrier and the pushed filter; strict refuses with the rank reason', async () => {
    const { store, rows } = await storeOver(INDEXED);
    try {
      const explained = await rows.explain(topK(2, { $where: { $eq: ['$r.tag', 'a'] } }), { externals: { q: Q } });
      assert.strictEqual(explained.mode, 'knn');
      assert.deepStrictEqual(explained.rank, {
        column: COLUMN, dims: DIMS, probe: { external: 'q' }, limit: 2, offset: 0,
        margin: KNN_MARGIN, decides: 'engine',
      });
      assert.deepStrictEqual(explained.prefilters, []);
      assert.strictEqual(explained.residual.mode, 'knn');
      assert.match(explained.residual.reasons[0].reason, /k-nearest rank is engine work/);
      assert.ok(explained.barriers.length > 0, 'a cut materializes: it is a barrier');
      assert.deepStrictEqual(explained.params, [{ literal: 'a' }]);
      assert.deepStrictEqual(explained.externals, ['q']);
      assert.doesNotMatch(explained.sql, /ORDER BY|LIMIT/);

      const literal = await rows.explain(topK(1, {}, { $similarity: ['$r.embedding', [0, 0, 1]] }));
      assert.deepStrictEqual(literal.rank.probe, { literal: [0, 0, 1] });

      await assert.rejects(attempt(() => rows.execute(topK(2), { externals: { q: Q }, strict: true })),
        (error) => error.code === 'JD0010' && /k-nearest rank is engine work/.test(error.message));

      const unindexed = await storeOver(UNINDEXED);
      try {
        const set = await unindexed.rows.explain(topK(2), { externals: { q: Q } });
        assert.strictEqual(set.mode, 'set');
        assert.strictEqual(set.rank, null);
        assert.match(set.residual.reasons[0].reason, /no vector column over \$\.embedding/);
      }
      finally {
        await unindexed.store.close();
      }
    }
    finally {
      await store.close();
    }
  });

  it('a pushed WHERE narrows the scored rows; the answer is the engine\'s over the narrowed set', async () => {
    const { store, rows } = await storeOver(INDEXED);
    try {
      const answer = await rows.execute(topK(3, { $where: { $eq: ['$r.tag', 'a'] } }), { externals: { q: Q } });
      assert.deepStrictEqual(answer, ['east', 'tie-a', 'north']);
      assert.strictEqual(rows.stats().knn.rows, 5, 'only the tagged rows were scored');
    }
    finally {
      await store.close();
    }
  });

  it('an external probe of the wrong width, or not a vector, DIVERTS and answers what the engine answers', async () => {
    const { store, rows } = await storeOver(INDEXED);
    try {
      // a 2-wide probe scores only the 2-wide row; every other key is
      // empty and the identity order decides the rest
      const narrow = await rows.execute(topK(3), { externals: { q: [1, 0] } });
      assert.deepStrictEqual(narrow, ['narrow', 'east', 'none']);
      await assert.rejects(attempt(() => rows.execute(topK(3), { externals: { q: 'word' } })),
        (error) => error.code === 'JQ2001');
      await assert.rejects(attempt(() => rows.execute(topK(3), { externals: {} })),
        (error) => error.code === 'JQ2006');
      assert.strictEqual(rows.stats().knn.queries, 0, 'a diverted call never ran the cut');
      const nonFinite = await rows.execute(topK(2), { externals: { q: [1, Infinity, 0] } });
      assert.deepStrictEqual(nonFinite, ['east', 'narrow']);
      // and every one of those calls read the whole collection, which is
      // the number a consumer needs — counted, so a probe bound at the
      // wrong width never turns a k-nearest query into a full scan with
      // nothing said
      assert.strictEqual(rows.stats().knn.diverted, 4,
        'a knn plan that diverted at bind time is counted, not silent');
      // explain(), given that probe, answers for the run: the cut never
      // runs, the whole collection is read and the engine ranks — the
      // plan's rank is still reported as the shape it would have taken
      const explained = await rows.explain(topK(3), { externals: { q: [1, 0] } });
      assert.strictEqual(explained.mode, 'set', 'the run reads the whole collection');
      assert.strictEqual(explained.rank.dims, DIMS, 'the k-nearest shape is still named');
      assert.match(explained.residual.reasons.at(-1).reason, /the external 'q' is not a value the database binds/);
      assert.strictEqual((await rows.explain(topK(3))).mode, 'knn', 'without externals: the plan as planned');
    }
    finally {
      await store.close();
    }
  });

  it('the streaming cursor materializes the cut as a barrier and yields the same items', async () => {
    const { store, rows } = await storeOver(INDEXED);
    try {
      const items = [];
      for await (const item of rows.query(topK(4), { externals: { q: Q } })) items.push(item);
      assert.deepStrictEqual(items, ['east', 'tie-a', 'tie-b', 'north']);
      assert.strictEqual(rows.stats().knn.queries, 1);
    }
    finally {
      await store.close();
    }
  });

  it('a duplicate-heavy collection is visible: the candidate count exceeds the window', async () => {
    const store = await openStore(INDEXED, { driver: nodeDriver() });
    const rows = store.collection('rows');
    try {
      for (let i = 0; i < 20; i++) await rows.insert({ id: `d${String(i).padStart(2, '0')}`, embedding: [1, 0, 0] });
      await rows.insert({ id: 'far', embedding: [0, 1, 0] });
      const answer = await rows.execute(topK(2), { externals: { q: Q } });
      assert.deepStrictEqual(answer, ['d00', 'd01']);
      assert.deepStrictEqual(rows.stats().knn, { queries: 1, rows: 21, candidates: 20, fullFetches: 0, diverted: 0 });
    }
    finally {
      await store.close();
    }
  });

  it('a collection wider than one identity batch fetches in batches and answers in order', async () => {
    const store = await openStore(INDEXED, { driver: nodeDriver() });
    const rows = store.collection('rows');
    try {
      const n = IDENTITY_CHUNK + 40;
      for (let i = 0; i < n; i++) await rows.insert({ id: String(i).padStart(4, '0'), embedding: [1, 0, 0] });
      const answer = await rows.execute({ $subsequence: [ranked(), n - 3, 3] }, { externals: { q: Q } });
      assert.deepStrictEqual(answer, [String(n - 3).padStart(4, '0'), String(n - 2).padStart(4, '0'),
        String(n - 1).padStart(4, '0')]);
      assert.strictEqual(rows.stats().knn.candidates, n);
    }
    finally {
      await store.close();
    }
  });

  it('a profile bounds the candidate scan, not the window: maxRows below the collection refuses', async () => {
    // the candidate fetch reads every narrowed row to score it, so the
    // safe profile's row bound applies to THAT count and not to `k` — a
    // consumer asking for the two nearest of seven under maxRows 3 is
    // refused whole rather than answered from a truncated candidate set,
    // which is the same rule a residual's candidate fetch obeys
    const { store, rows } = await storeOver(INDEXED);
    try {
      const drain = async (maxRows) => {
        const out = [];
        for await (const item of await rows.query(topK(2),
          { externals: { q: Q }, profile: { maxRows, externals: ['q'] } })) out.push(item);
        return out;
      };
      await assert.rejects(drain(3), (/** @type {any} */ error) => {
        assert.strictEqual(error.code, 'JD2007');
        assert.match(error.message, /maxRows bound of 3/);
        return true;
      });
      assert.deepStrictEqual(await drain(100), ['east', 'tie-a']);
    }
    finally {
      await store.close();
    }
  });

  it('a live query over the shape re-runs, and names the rank as the reason', async () => {
    const { store, rows } = await storeOver(INDEXED, { capture: true });
    try {
      const live = await rows.live([topK(2)], { externals: { q: Q } });
      assert.strictEqual(live.mode.strategy, 'rerun');
      assert.match(live.mode.reason, /k-nearest ranking re-runs/);
      const classified = classifyLiveQuery([topK(2)], INDEXED_SHAPE.shape, true);
      assert.strictEqual(classified.strategy, 'rerun');
      assert.match(classified.reason, /k-nearest ranking re-runs/);
    }
    finally {
      await store.close();
    }
  });
});
