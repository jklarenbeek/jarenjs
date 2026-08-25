//@ts-check
/**
 * The spatial corpus, projected for a STORE.
 *
 * `test/json/fixtures/spatial-corpus.json` is the spatial oracle: every
 * entry carries the answer the JavaScript engine gives, so a second
 * executor can be held to it and a divergence names which executor
 * moved. A relational executor cannot run an entry as written — a
 * corpus query is rooted at ONE document while a collection query is
 * rooted at the collection — so every such executor needs the same
 * adaptation: the documents to store, the query to run over them, and
 * the model (the schema that types the geography, the derived spatial
 * indexes) to store them under. That adaptation lives here, once, for
 * the two consumers that hold a store to the engine's answers: the Node
 * runner over `node:sqlite`, and the site's built `site/spatial-corpus.json`,
 * which a browser tab posts to the data studio's worker entry by entry
 * so that SQLite compiled to wasm is the third executor.
 *
 * The projection is a pure function of the fixture: nothing here reads
 * the clock or the repository, so a rebuild of the same fixture writes
 * byte-identical output. Entries marked `executors: ["engine"]` are left
 * out BY THEIR MARKER and named in `skipped`, so a runner that ran zero
 * of them ran them on purpose.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** The fixture's repo-relative home, as messages and artifacts name it. */
export const SPATIAL_CORPUS_PATH = 'test/json/fixtures/spatial-corpus.json';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The members the corpus carries geography in. */
export const GEO_MEMBERS = ['at', 'g', 'a', 'b', 'region', 'line', 'here', 'there'];

/** The precision the corpus's plan cases index `at` at. */
export const CELL_PRECISION = 6;

/** The collection every entry is stored in. */
export const SPATIAL_COLLECTION = 'rows';

/**
 * The schema that types every geography member as an array or an
 * object — a spatial predicate is only promoted onto a member typed so.
 */
export const SPATIAL_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(
    GEO_MEMBERS.map((member) => [member, { type: ['array', 'object'] }])),
};

/** Both derive kinds over `$.at`, plus a box over every other member. */
export const SPATIAL_INDEXES = [
  { name: 'by_at_box', path: '$.at', derive: 'bbox' },
  { name: 'by_at_cell', path: '$.at', derive: 'geohash', precision: CELL_PRECISION },
  ...GEO_MEMBERS.filter((member) => member !== 'at').map((member) => ({
    name: `by_${member}_box`, path: `$.${member}`, derive: 'bbox',
  })),
];

/**
 * The model one mapping stores the corpus under: one collection, keyed
 * by rowid, with the given indexes.
 * @param {any[]} indexes
 * @returns {any}
 */
export function spatialModel(indexes) {
  return {
    $model: '0.1',
    collections: {
      [SPATIAL_COLLECTION]: {
        schema: SPATIAL_SCHEMA, key: null, identity: 'integer', indexes,
      },
    },
  };
}

/**
 * The two mappings every store runner answers under: with the derived
 * spatial indexes (where a spatial predicate is promoted onto them) and
 * without (where it is not). Both must equal the engine's recorded
 * answer — the pre-filter narrows, it never decides.
 */
export const SPATIAL_MAPPINGS = Object.freeze({
  indexed: spatialModel(SPATIAL_INDEXES),
  unindexed: spatialModel([]),
});

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
export function rebase(node, binding) {
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

/**
 * The documents and the query one entry runs as, against a store.
 *
 * - `collection: true` — the data IS a list of documents and the query
 *   a FLWOR over them, so the rows are stored and the query runs as
 *   written. These are the plan-sensitive cases.
 * - everything else — one document and a query rooted at it. It is
 *   stored as the collection's single row and the query is re-anchored
 *   on the binding.
 * @param {any} entry
 * @returns {{ documents: any[], query: any }}
 */
export function asCollectionQuery(entry) {
  if (entry.collection === true) return { documents: entry.data, query: entry.query };
  return {
    documents: [entry.data],
    query: { $for: { doc: '$[*]' }, $return: rebase(entry.query, 'doc') },
  };
}

/**
 * Whether a second executor is asked to answer an entry: only the
 * marker decides, never a failed attempt.
 * @param {any} entry
 * @returns {boolean}
 */
export const isRunnable = (entry) => entry.executors === undefined;

/**
 * The fixture, as committed.
 * @param {string} [root] - The repository to read; this one by default.
 * @returns {any[]}
 */
export function readSpatialCorpus(root = ROOT) {
  return JSON.parse(readFileSync(join(root, SPATIAL_CORPUS_PATH), 'utf8'));
}

/**
 * @typedef {Object} SpatialCorpusEntry
 * @property {string} name - The fixture entry's name, as a divergence reports it.
 * @property {string} [note]
 * @property {any[]} documents - What a store runner inserts.
 * @property {any} query - What it executes over them.
 * @property {any} [expected] - What the engine recorded, when it recorded a value.
 * @property {true} [empty] - The engine recorded the empty sequence.
 */

/**
 * @typedef {Object} SpatialCorpus
 * @property {string} source - The fixture this was projected from.
 * @property {string} collection - The collection the mappings store rows in.
 * @property {{ indexed: any, unindexed: any }} mappings - The model per mapping.
 * @property {string[]} skipped - Entries left out by their `executors` marker.
 * @property {SpatialCorpusEntry[]} entries - Every runnable entry, in fixture order.
 */

/**
 * Project the fixture for a store runner.
 * @param {any[]} corpus - The fixture, as {@link readSpatialCorpus} reads it.
 * @returns {SpatialCorpus}
 */
export function buildSpatialCorpus(corpus) {
  return {
    source: SPATIAL_CORPUS_PATH,
    collection: SPATIAL_COLLECTION,
    mappings: { indexed: SPATIAL_MAPPINGS.indexed, unindexed: SPATIAL_MAPPINGS.unindexed },
    skipped: corpus.filter((entry) => !isRunnable(entry)).map((entry) => entry.name),
    entries: corpus.filter(isRunnable).map((entry) => {
      const { documents, query } = asCollectionQuery(entry);
      return {
        name: entry.name,
        ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
        documents,
        query,
        ...(entry.empty === true ? { empty: true } : { expected: entry.expected }),
      };
    }),
  };
}
