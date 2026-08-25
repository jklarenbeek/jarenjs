//@ts-check
/**
 * @file The vector corpus, run through SQLite — twice.
 *
 * `test/json/fixtures/vector-corpus.json` records what the JavaScript
 * engine answers for every case. This file makes the store a second
 * and a third executor over the SAME committed entries — `node:sqlite`
 * and the real wasm build — and asserts each answers exactly the same
 * thing, values and order and ties and errors alike, so a plan that
 * changes an answer fails here rather than in a benchmark, and a
 * divergence names which executor moved.
 *
 * Every entry runs under two mappings: a collection that declares the
 * `derive: 'vector'` column over `embedding` (where the k-nearest
 * composition is planned as a cut the engine finishes) and one that
 * declares nothing (where the engine answers alone). Both must equal
 * the engine's recorded answer — the column pre-filters, it never
 * decides, and the physical mapping is not allowed to be visible in an
 * answer.
 *
 * Answers are not enough: a k-nearest query that silently fell to the
 * whole-collection residual would agree forever and read the whole
 * table forever. So every `knn/` entry also asserts the plan MODE it
 * takes on each twin, and the reason the plan names where it refuses —
 * a table this file keeps complete against the corpus.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';

import { deepEquals } from './oracle/harness.js';
import {
  readVectorCorpus, isRunnable, asCollectionQuery, vectorMappings, VECTOR_COLLECTION,
} from '../../scripts/lib/vector-corpus.js';

const CORPUS = readVectorCorpus();
const RUNNABLE = CORPUS.entries.filter(isRunnable);
const MAPPINGS = vectorMappings(CORPUS.dims);
const EXTERNALS = CORPUS.externals;

/** `execute` is value-or-promise; a synchronous driver throws synchronously. */
const attempt = (fn) => Promise.resolve().then(fn);

/**
 * The mode every `knn/` entry takes on each twin, with the reason its
 * plan names where it refuses. Complete against the corpus: an entry
 * missing here fails, and so does a row naming an entry the corpus
 * lost.
 * @type {Record<string, { indexed: [string, RegExp?], unindexed: [string, RegExp?] }>}
 */
const NO_COLUMN = /no vector column over \$\.embedding/;
const RANK = /k-nearest rank is engine work/;
const KNN_MODES = {
  'knn/full-ordering': { indexed: ['set', /finite limit/], unindexed: ['set', NO_COLUMN] },
  'knn/top-1': { indexed: ['knn', RANK], unindexed: ['set', NO_COLUMN] },
  'knn/top-2': { indexed: ['knn', RANK], unindexed: ['set', NO_COLUMN] },
  'knn/top-3': { indexed: ['knn', RANK], unindexed: ['set', NO_COLUMN] },
  'knn/top-5': { indexed: ['knn', RANK], unindexed: ['set', NO_COLUMN] },
  'knn/k-past-the-end': { indexed: ['knn', RANK], unindexed: ['set', NO_COLUMN] },
  'knn/ties-survive-input-order': { indexed: ['set', /finite limit/], unindexed: ['set', NO_COLUMN] },
  'knn/empty-greatest-puts-the-unscorable-first':
    { indexed: ['set', /\$empty: 'least'/], unindexed: ['set', /\$empty: 'least'/] },
  'knn/ascending-is-the-worst-first':
    { indexed: ['set', /only descending/], unindexed: ['set', /only descending/] },
  'knn/offset-window': { indexed: ['knn', RANK], unindexed: ['set', NO_COLUMN] },
  'knn/near-tie-at-the-boundary': { indexed: ['knn', RANK], unindexed: ['set', NO_COLUMN] },
  'knn/external-probe-of-another-width': { indexed: ['knn', RANK], unindexed: ['set', NO_COLUMN] },
  'knn/external-probe-not-a-vector': { indexed: ['knn', RANK], unindexed: ['set', NO_COLUMN] },
  'knn/filtered-then-ranked': { indexed: ['set', /pushed whole/], unindexed: ['set', NO_COLUMN] },
};

/** The two drivers, by name; the wasm one initializes once. */
const DRIVERS = { 'sqlite-node': () => nodeDriver(), 'sqlite-wasm': () => wasmDriverInstance };
/** @type {any} */
let wasmDriverInstance = null;
before(async () => {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  wasmDriverInstance = wasmDriver(sqlite3Handle(sqlite3));
});

/** Open a store over one entry's documents. */
async function storeFor(driver, documents, mapping) {
  const store = await openStore(MAPPINGS[mapping], { driver });
  const collection = store.collection(VECTOR_COLLECTION);
  for (const document of documents) await collection.insert(document);
  return { store, collection };
}

describe('the vector corpus through SQLite', () => {
  it('has k-nearest entries to run, marks collections, and the mode table is complete', () => {
    const knn = CORPUS.entries.filter((entry) => entry.name.startsWith('knn/'));
    assert.ok(knn.length >= 10, `only ${knn.length} k-nearest entries`);
    for (const entry of CORPUS.entries) {
      assert.strictEqual(entry.collection === true, Array.isArray(entry.data),
        `${entry.name}: the collection flag and the data shape must agree`);
    }
    assert.deepStrictEqual(knn.map((entry) => entry.name).sort(), Object.keys(KNN_MODES).sort(),
      'every knn/ entry has a mode row, and every mode row names an entry');
    assert.ok(RUNNABLE.length >= 35, `only ${RUNNABLE.length} runnable entries`);
    assert.strictEqual(RUNNABLE.length, CORPUS.entries.length, 'nothing is marked engine-only');
  });

  /** Entries actually executed, per executor and mapping. */
  const ran = {};

  for (const executor of Object.keys(DRIVERS)) {
    for (const mapping of /** @type {const} */ (['indexed', 'unindexed'])) {
      ran[`${executor}/${mapping}`] = 0;
      describe(`${executor}, ${mapping} — every entry answers what the engine answered`, () => {
        for (const entry of RUNNABLE) {
          it(entry.name, async () => {
            const { documents, query } = asCollectionQuery(entry);
            const { store, collection } = await storeFor(DRIVERS[executor](), documents, mapping);
            try {
              const where = `${executor} (${mapping}) disagreed on ${entry.name}`
                + ` — query ${JSON.stringify(entry.query)}`;
              if ('error' in entry) {
                await assert.rejects(attempt(() => collection.execute(query, { externals: EXTERNALS })),
                  (error) => /** @type {any} */ (error).code === entry.error,
                  `${where}: recorded ${entry.error}`);
              }
              else {
                const actual = await collection.execute(query, { externals: EXTERNALS });
                if (entry.empty === true) {
                  assert.strictEqual(actual, undefined,
                    `${where}: recorded the empty sequence, answered ${JSON.stringify(actual)}`);
                }
                else {
                  assert.ok(deepEquals(actual, entry.expected),
                    `${where}: recorded ${JSON.stringify(entry.expected)}, `
                    + `answered ${JSON.stringify(actual)}`);
                }
              }
              ran[`${executor}/${mapping}`] += 1;

              // the mode, not just the answer (a silent residual agrees forever)
              const row = KNN_MODES[entry.name];
              if (row !== undefined) {
                const explained = await collection.explain(query, { externals: EXTERNALS });
                const [mode, reason] = row[mapping];
                assert.strictEqual(explained.mode, mode,
                  `${executor} (${mapping}) planned ${entry.name} as ${explained.mode}, not ${mode}`);
                if (reason !== undefined) {
                  assert.ok(explained.residual.reasons.some((r) => reason.test(r.reason)),
                    `${executor} (${mapping}) ${entry.name}: no reason matches ${reason} in `
                    + explained.residual.reasons.map((r) => r.reason).join(' ; '));
                }
                if (mode === 'knn') {
                  assert.strictEqual(explained.rank.decides, 'engine');
                  assert.strictEqual(explained.rank.dims, CORPUS.dims);
                  assert.doesNotMatch(explained.sql, /ORDER BY|LIMIT/);
                }
                else {
                  assert.strictEqual(explained.rank, null);
                }
              }
            }
            finally {
              await store.close();
            }
          });
        }
      });
    }
  }

  it('ran every runnable entry under both drivers and both mappings — the count, not the absence of failures', () => {
    assert.ok(RUNNABLE.length > 0, 'nothing to run');
    assert.deepStrictEqual(ran, Object.fromEntries(Object.keys(ran).map((key) => [key, RUNNABLE.length])),
      'an executor ran fewer entries than the corpus carries');
  });
});

describe('the k-past-the-end fetch and the near-tie are visible in the stats', () => {
  for (const executor of Object.keys(DRIVERS)) {
    it(`${executor}: a window wider than the scored rows fetches every row; the near-tie keeps both`, async () => {
      const past = CORPUS.entries.find((entry) => entry.name === 'knn/k-past-the-end');
      const near = CORPUS.entries.find((entry) => entry.name === 'knn/near-tie-at-the-boundary');
      for (const [entry, expected] of [[past, { fullFetches: 1 }], [near, { candidates: 3 }]]) {
        const { store, collection } = await storeFor(DRIVERS[executor](), entry.data, 'indexed');
        try {
          await collection.execute(entry.query, { externals: EXTERNALS });
          const stats = collection.stats().knn;
          assert.strictEqual(stats.queries, 1);
          assert.strictEqual(stats.rows, entry.data.length);
          for (const [key, value] of Object.entries(expected))
            assert.strictEqual(stats[key], value, `${executor} ${entry.name}: ${key} ${JSON.stringify(stats)}`);
        }
        finally {
          await store.close();
        }
      }
    });
  }
});
