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
 * Two shapes of entry:
 *
 * - `collection: true` — the data IS a list of documents and the query
 *   a FLWOR over them, so the rows are stored and the query runs as
 *   written. These are the plan-sensitive cases.
 * - everything else — one document and a query rooted at it. It is
 *   stored as the collection's single row and the query is re-anchored
 *   on the binding, because a collection query is rooted at the
 *   collection and a corpus query is rooted at the document.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { deepEquals } from './oracle/harness.js';

/** @type {Array<any>} */
const CORPUS = JSON.parse(readFileSync(
  new URL('../json/fixtures/spatial-corpus.json', import.meta.url), 'utf8'));

/** The members the corpus carries geography in. */
const GEO_MEMBERS = ['at', 'g', 'a', 'b', 'region', 'line', 'here', 'there'];

/** The precision the corpus's plan cases index `at` at. */
const CELL_PRECISION = 6;

const SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(
    GEO_MEMBERS.map((member) => [member, { type: ['array', 'object'] }])),
};

/** Both derive kinds over `$.at`, plus a box over every other member. */
const SPATIAL_INDEXES = [
  { name: 'by_at_box', path: '$.at', derive: 'bbox' },
  { name: 'by_at_cell', path: '$.at', derive: 'geohash', precision: CELL_PRECISION },
  ...GEO_MEMBERS.filter((member) => member !== 'at').map((member) => ({
    name: `by_${member}_box`, path: `$.${member}`, derive: 'bbox',
  })),
];

/**
 * Re-anchor a document-rooted query on a collection binding: `$` and
 * `$.member` become `$<binding>` and `$<binding>.member`. Anything
 * else — an inner binding like `$c.at`, a literal string — is left
 * alone, because only a root-anchored path changes meaning when the
 * same query runs over a collection.
 * @param {any} node
 * @param {string} binding
 * @returns {any}
 */
function rebase(node, binding) {
  if (typeof node === 'string') {
    if (node === '$') return `$${binding}`;
    return node.startsWith('$.') ? `$${binding}${node.slice(1)}` : node;
  }
  if (Array.isArray(node)) return node.map((item) => rebase(item, binding));
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, rebase(value, binding)]));
  }
  return node;
}

/** The documents and the query one entry runs as, against a store. */
function asCollectionQuery(entry) {
  if (entry.collection === true) return { documents: entry.data, query: entry.query };
  return {
    documents: [entry.data],
    query: { $for: { doc: '$[*]' }, $return: rebase(entry.query, 'doc') },
  };
}

/** Open a store over one entry's documents. */
async function storeFor(documents, indexes) {
  const store = await openStore({
    $model: '0.1',
    collections: {
      rows: { schema: SCHEMA, key: null, identity: 'integer', indexes },
    },
  }, { driver: nodeDriver() });
  const collection = store.collection('rows');
  for (const document of documents) await collection.insert(document);
  return { store, collection };
}

const RUNNABLE = CORPUS.filter((entry) => entry.executors === undefined);

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

  for (const mapping of /** @type {const} */ (['indexed', 'unindexed'])) {
    describe(`${mapping} — every entry answers what the engine answered`, () => {
      const indexes = mapping === 'indexed' ? SPATIAL_INDEXES : [];
      for (const entry of RUNNABLE) {
        it(entry.name, async () => {
          const { documents, query } = asCollectionQuery(entry);
          const { store, collection } = await storeFor(documents, indexes);
          try {
            const actual = await collection.execute(query);
            if (entry.empty === true) {
              assert.strictEqual(actual, undefined,
                `recorded the empty sequence, answered ${JSON.stringify(actual)}`);
              return;
            }
            assert.ok(deepEquals(actual, entry.expected),
              `recorded ${JSON.stringify(entry.expected)}, `
              + `answered ${JSON.stringify(actual)}`);
          }
          finally {
            await store.close();
          }
        });
      }
    });
  }
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
