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
 * Every entry runs TWICE: once against a collection that declares the
 * derived spatial indexes (where a spatial predicate is promoted onto
 * them) and once against one that declares none (where it is not).
 * Both must equal the engine's recorded answer — the pre-filter
 * narrows, it never decides.
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
  SPATIAL_COLLECTION,
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
  const ran = { indexed: 0, unindexed: 0 };

  for (const mapping of /** @type {const} */ (['indexed', 'unindexed'])) {
    describe(`${mapping} — every entry answers what the engine answered`, () => {
      const indexes = mapping === 'indexed' ? SPATIAL_INDEXES : [];
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

  it('ran every runnable entry under both mappings — the count, not the absence of failures', () => {
    assert.ok(RUNNABLE.length > 0, 'nothing to run');
    assert.deepStrictEqual(ran, { indexed: RUNNABLE.length, unindexed: RUNNABLE.length },
      `${EXECUTOR} ran fewer entries than the corpus carries`);
    assert.strictEqual(RUNNABLE.length + CORPUS.filter((entry) => !isRunnable(entry)).length,
      CORPUS.length, 'every entry is either run or skipped by its marker');
  });
});

describe('the plan cases really are promoted (and still agree)', () => {
  /** @type {any} */
  let opened = null;
  const planCases = CORPUS.filter((entry) => entry.collection === true);

  before(async () => { opened = await storeFor([], SPATIAL_INDEXES); });
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
});
