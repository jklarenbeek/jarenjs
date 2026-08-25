//@ts-check
/**
 * The vector corpus, projected for a STORE.
 *
 * `test/json/fixtures/vector-corpus.json` is the vector oracle: every
 * entry carries the answer the JavaScript engine gives, so a second
 * executor can be held to it and a divergence names which executor
 * moved. A relational executor needs the same adaptation the spatial
 * corpus needs — the documents to store, the query to run over them,
 * the model to store them under — and it lives here, once, for the
 * consumers that hold a store to the engine's answers: the Node runner
 * over `node:sqlite`, the same runner over the wasm driver, and a
 * browser tab running the store's wasm build.
 *
 * A store runner answers under both mappings `vectorMappings` names:
 * with the `derive: 'vector'` column over `embedding` (where the
 * k-nearest composition is planned as a cut the engine finishes) and
 * without it (where nothing is promoted and the engine answers alone).
 * Both must equal the engine's recorded answer, including order — the
 * column pre-filters, it never decides.
 *
 * The projection is a pure function of the fixture: nothing here reads
 * the clock or the repository, so a rebuild of the same fixture writes
 * byte-identical output.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { asCollectionQuery, isRunnable } from './spatial-corpus.js';

export { rebase, asCollectionQuery, isRunnable } from './spatial-corpus.js';

/** The fixture's repo-relative home, as messages and artifacts name it. */
export const VECTOR_CORPUS_PATH = 'test/json/fixtures/vector-corpus.json';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The member the corpus's collection cases carry their vectors in. */
export const VECTOR_MEMBER = 'embedding';

/** The collection every entry is stored in. */
export const VECTOR_COLLECTION = 'rows';

/**
 * The schema that types the vector member as an array of numbers and
 * nothing else — the one declaration a vector column is allowed over.
 * Every other member the corpus reads stays untyped.
 */
export const VECTOR_SCHEMA = {
  type: 'object',
  properties: {
    [VECTOR_MEMBER]: { type: 'array', items: { type: 'number' } },
  },
};

/**
 * The one vector column the indexed mapping declares, at the corpus's
 * width.
 * @param {number} dims
 * @returns {any[]}
 */
export function vectorIndexes(dims) {
  return [{ name: 'by_embedding', path: `$.${VECTOR_MEMBER}`, derive: 'vector', dims }];
}

/**
 * The model one mapping stores the corpus under: one collection, keyed
 * by rowid, with the given indexes.
 * @param {any[]} indexes
 * @returns {any}
 */
export function vectorModel(indexes) {
  return {
    $model: '0.1',
    collections: {
      [VECTOR_COLLECTION]: {
        schema: VECTOR_SCHEMA, key: null, identity: 'integer', indexes,
      },
    },
  };
}

/**
 * The two mappings every store runner answers under: with the vector
 * column (where the k-nearest composition is promoted onto it) and
 * without (where it is not). Both must equal the engine's recorded
 * answer.
 * @param {number} dims - the corpus's vector width
 * @returns {{ indexed: any, unindexed: any }}
 */
export function vectorMappings(dims) {
  return Object.freeze({
    indexed: vectorModel(vectorIndexes(dims)),
    unindexed: vectorModel([]),
  });
}

/**
 * The fixture, as committed: its seed, width, externals and entries.
 * @param {string} [root] - The repository to read; this one by default.
 * @returns {{ seed: number, dims: number, externals: any, entries: any[] }}
 */
export function readVectorCorpus(root = ROOT) {
  return JSON.parse(readFileSync(join(root, VECTOR_CORPUS_PATH), 'utf8'));
}

/**
 * @typedef {Object} VectorCorpusEntry
 * @property {string} name - The fixture entry's name, as a divergence reports it.
 * @property {string} [note]
 * @property {any[]} documents - What a store runner inserts.
 * @property {any} query - What it executes over them.
 * @property {any} [expected] - What the engine recorded, when it recorded a value.
 * @property {true} [empty] - The engine recorded the empty sequence.
 * @property {string} [error] - The error code the engine recorded.
 */

/**
 * @typedef {Object} VectorCorpus
 * @property {string} source - The fixture this was projected from.
 * @property {string} collection - The collection the mappings store rows in.
 * @property {number} dims - The vector width.
 * @property {any} externals - The externals every entry binds.
 * @property {{ indexed: any, unindexed: any }} mappings - The model per mapping.
 * @property {string[]} skipped - Entries left out by their `executors` marker.
 * @property {VectorCorpusEntry[]} entries - Every runnable entry, in fixture order.
 */

/**
 * Project the fixture for a store runner.
 * @param {{ dims: number, externals: any, entries: any[] }} corpus - The
 *   fixture, as {@link readVectorCorpus} reads it.
 * @returns {VectorCorpus}
 */
export function buildVectorCorpus(corpus) {
  return {
    source: VECTOR_CORPUS_PATH,
    collection: VECTOR_COLLECTION,
    dims: corpus.dims,
    externals: corpus.externals,
    mappings: { ...vectorMappings(corpus.dims) },
    skipped: corpus.entries.filter((entry) => !isRunnable(entry)).map((entry) => entry.name),
    entries: corpus.entries.filter(isRunnable).map((entry) => {
      const { documents, query } = asCollectionQuery(entry);
      return {
        name: entry.name,
        ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
        documents,
        query,
        ...('error' in entry ? { error: entry.error }
          : entry.empty === true ? { empty: true } : { expected: entry.expected }),
      };
    }),
  };
}
