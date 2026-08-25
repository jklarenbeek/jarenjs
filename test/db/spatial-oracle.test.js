//@ts-check
/**
 * @file The spatial corpus, run through SQLite (D9).
 *
 * `test/json/fixtures/spatial-corpus.json` records what the JavaScript
 * engine answers for every case. This file makes the database a second
 * executor over the SAME committed entries and asserts it answers
 * exactly the same thing — so a promotion that changes an answer fails
 * here rather than in a benchmark, and a divergence names which
 * executor moved.
 *
 * Every entry runs THREE times: against a collection that declares the
 * derived spatial indexes (where a spatial predicate is promoted onto
 * them), against one that declares the same indexes with every `bbox`
 * column set realized as an R\*Tree, and against one that declares none
 * (where nothing is promoted). All three must equal the engine's
 * recorded answer — the pre-filter narrows, it never decides, and the
 * physical mapping is not allowed to be visible in an answer.
 *
 * How an entry becomes documents, a query and a model for a store is
 * `scripts/lib/spatial-corpus.js` — shared with the site build, which
 * ships the same projection for the browser runner — so the two store
 * executors are held to the corpus through ONE adaptation. Entries
 * marked `executors: ["engine"]` are skipped by that marker, never by a
 * failed attempt, and the count of entries actually run is asserted
 * against the corpus at the end: a runner that quietly ran nothing
 * passes every per-entry assertion, and that is the failure this guards.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { deepEquals } from './oracle/harness.js';
import {
  readSpatialCorpus, isRunnable, asCollectionQuery, spatialModel, SPATIAL_INDEXES,
  SPATIAL_INDEXES_RTREE, SPATIAL_COLLECTION,
} from '../../scripts/lib/spatial-corpus.js';

/** The executor this file holds to the engine, as a divergence names it. */
const EXECUTOR = 'sqlite-node';

/** @type {Array<any>} */
const CORPUS = readSpatialCorpus();

/** Open a store over one entry's documents. */
async function storeFor(documents, indexes) {
  const store = await openStore(spatialModel(indexes), { driver: nodeDriver() });
  const collection = store.collection(SPATIAL_COLLECTION);
  for (const document of documents) await collection.insert(document);
  return { store, collection };
}

const RUNNABLE = CORPUS.filter(isRunnable);

describe('the spatial corpus through SQLite', () => {
  it('has plan-sensitive entries to run, and marks them as collections', () => {
    const planCases = CORPUS.filter((entry) => entry.collection === true);
    assert.ok(planCases.length >= 10, `only ${planCases.length} collection entries`);
    for (const entry of CORPUS) {
      assert.strictEqual(entry.collection === true, Array.isArray(entry.data),
        `${entry.name}: the collection flag and the data shape must agree`);
    }
    assert.ok(RUNNABLE.length >= 80, `only ${RUNNABLE.length} runnable entries`);
  });

  /** Entries actually executed, per mapping. */
  const ran = { indexed: 0, rtree: 0, unindexed: 0 };

  /** The indexes each mapping declares — the SAME logical model twice
   * over, once as four columns under a B-tree and once as an R*Tree. */
  const INDEXES = {
    indexed: SPATIAL_INDEXES, rtree: SPATIAL_INDEXES_RTREE, unindexed: [],
  };

  for (const mapping of /** @type {const} */ (['indexed', 'rtree', 'unindexed'])) {
    describe(`${mapping} — every entry answers what the engine answered`, () => {
      const indexes = INDEXES[mapping];
      for (const entry of RUNNABLE) {
        it(entry.name, async () => {
          const { documents, query } = asCollectionQuery(entry);
          const { store, collection } = await storeFor(documents, indexes);
          try {
            const actual = await collection.execute(query);
            ran[mapping] += 1;
            const where = `${EXECUTOR} (${mapping}) disagreed on ${entry.name}`
              + ` — query ${JSON.stringify(entry.query)}`;
            if (entry.empty === true) {
              assert.strictEqual(actual, undefined,
                `${where}: recorded the empty sequence, answered ${JSON.stringify(actual)}`);
              return;
            }
            assert.ok(deepEquals(actual, entry.expected),
              `${where}: recorded ${JSON.stringify(entry.expected)}, `
              + `answered ${JSON.stringify(actual)}`);
          }
          finally {
            await store.close();
          }
        });
      }
    });
  }

  it('ran every runnable entry under all three mappings — the count, not the absence of failures', () => {
    assert.ok(RUNNABLE.length > 0, 'nothing to run');
    assert.deepStrictEqual(ran, { indexed: RUNNABLE.length, rtree: RUNNABLE.length,
      unindexed: RUNNABLE.length },
      `${EXECUTOR} ran fewer entries than the corpus carries`);
    assert.strictEqual(RUNNABLE.length + CORPUS.filter((entry) => !isRunnable(entry)).length,
      CORPUS.length, 'every entry is either run or skipped by its marker');
  });
});

// The binding name is the document's to choose, and a hard-coded one
// once survived every test because every test bound `it`: the same
// corpus, re-anchored on a name no example uses, must answer the same.
describe('the binding name is the document\'s to choose — the spatial corpus under a second name', () => {
  const single = RUNNABLE.filter((entry) => entry.collection !== true);
  for (const entry of single) {
    it(`${entry.name} — bound as 'row'`, async () => {
      const { documents, query } = asCollectionQuery(entry, 'row');
      assert.notDeepStrictEqual(query, asCollectionQuery(entry).query, 'the rewrite must change the document');
      assert.strictEqual(Object.keys(query.$for)[0], 'row');
      const { store, collection } = await storeFor(documents, SPATIAL_INDEXES);
      try {
        const answer = await collection.execute(query);
        if (entry.empty === true) {
          assert.strictEqual(answer, undefined, `${EXECUTOR} (row) on ${entry.name}: recorded the empty sequence`);
        }
        else {
          assert.deepStrictEqual(answer, entry.expected,
            `${EXECUTOR} (row) disagreed on ${entry.name} — query ${JSON.stringify(query)}`);
        }
      }
      finally {
        await store.close();
      }
    });
  }
  it('ran every single-document entry under the second name', () => {
    assert.ok(single.length >= 70, `only ${single.length} single-document entries`);
  });
});

describe('the plan cases really are promoted (and still agree)', () => {
  const planCases = CORPUS.filter((entry) => entry.collection === true);

  for (const mapping of /** @type {const} */ (['indexed', 'rtree'])) {
    describe(mapping, () => {
      /** @type {any} */
      let opened = null;
      before(async () => {
        opened = await storeFor([],
          mapping === 'indexed' ? SPATIAL_INDEXES : SPATIAL_INDEXES_RTREE);
      });
      after(async () => { await opened.store.close(); });

      it('every plan case either pushes a spatial pre-filter or refuses on purpose', async () => {
        const report = [];
        for (const entry of planCases) {
          const explained = await opened.collection.explain(entry.query);
          report.push(`${entry.name}: ${explained.prefilters.length} prefilter(s)`
            + `${explained.prefilters.map((p) => ` ${p.construct}(exact:${p.exact})`).join('')}`);
        }
        // the two refusals are deliberate and named; everything else pushes
        const refused = report.filter((line) => line.includes('0 prefilter'));
        assert.deepStrictEqual(refused, [
          'plan/distance-across-the-antimeridian: 0 prefilter(s)',
          'plan/distance-over-a-pole: 0 prefilter(s)',
        ], report.join('\n'));
      });

      it('every box pre-filter names the mapping it ran under', async () => {
        const via = new Set();
        for (const entry of planCases) {
          for (const prefilter of (await opened.collection.explain(entry.query)).prefilters) {
            if (prefilter.construct === '$starts-with'
              || prefilter.construct === '$geohash-neighbours') continue;
            via.add(`${prefilter.construct}:${prefilter.via}:${prefilter.exact}`);
          }
        }
        assert.deepStrictEqual([...via].sort(), mapping === 'indexed'
          ? ['$bbox-intersects:columns:true', '$distance:columns:false', '$within:columns:false']
          // the one thing that changes with the shape: an R*Tree stores
          // 32-bit floats rounded outward, so the box test is a superset
          : ['$bbox-intersects:rtree:false', '$distance:rtree:false', '$within:rtree:false']);
      });
    });
  }
});
