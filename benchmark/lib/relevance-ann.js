//@ts-check
/** Optional benchmark-only sparse random projection candidate selector.
 * Exact cosine remains the oracle; projection scores never escape as ledger scores. */
import { cosineSimilarity } from '@jarenjs/core/vector';
import { mulberry32 } from '@jarenjs/core/random';
import { verifiedVector } from './relevance-cache.js';
import { relevanceMetrics } from './relevance.js';

const compare = (a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** An injectable index with explicit build/update/delete lifecycle.
 * @param {{dims: number, projections?: number, seed?: number, fraction?: number}} config */
export function createProjectionIndex({ dims, projections = 32, seed = 17, fraction = 0.1 }) {
  if (!Number.isSafeInteger(dims) || dims < 1 || !Number.isSafeInteger(projections) || projections < 1
    || !(fraction > 0 && fraction <= 1)) throw new Error('invalid projection index configuration');
  const random = mulberry32(seed);
  // Sparse signs avoid a dense matrix; each input component joins one bucket.
  const buckets = Uint32Array.from({ length: dims }, () => Math.floor(random() * projections));
  const signs = Int8Array.from({ length: dims }, () => random() < 0.5 ? -1 : 1);
  const vectors = new Map();
  const project = (vector) => {
    const out = new Float32Array(projections);
    for (let i = 0; i < dims; i++) out[buckets[i]] += vector[i] * signs[i];
    return out;
  };
  return {
    config: { algorithm: 'sparse-projection-v1', dims, projections, seed, fraction },
    upsert: (key, vector) => { vectors.set(key, project(verifiedVector(vector, dims))); },
    delete: (key) => { vectors.delete(key); },
    candidates: (vector, k) => {
      const probe = project(verifiedVector(vector, dims));
      return [...vectors].map(([key, value]) => ({ key, score: cosineSimilarity(probe, value) }))
        .sort(compare).slice(0, Math.max(k, Math.ceil(vectors.size * fraction)));
    },
    // Serialized resident numeric/key payload, excluding JS object/Map overhead.
    bytes: () => buckets.byteLength + signs.byteLength
      + [...vectors].reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + value.byteLength, 0),
  };
}

/** Benchmark storage with cached vector materialization. Mutations are copied;
 * records read by the ledger are copies. Exact and ANN share the same storage.
 * @param {{model: string, dims: number, indexFactory?: (config: any) => any}} config */
export function createRankStorage({ model, dims, indexFactory }) {
  const records = new Map(), vectors = new Map();
  const index = indexFactory?.({ dims });
  const prefix = 'ai/state/memory/';
  return {
    get: async (key) => structuredClone(records.get(key)),
    set: async (key, value) => {
      const copy = structuredClone(value);
      if (key.startsWith(prefix) && value.embedding !== undefined) {
        const vector = new Float32Array(verifiedVector(value.embedding, dims));
        index?.upsert(key, vector);
        vectors.set(key, vector);
      }
      else { index?.delete(key); vectors.delete(key); }
      records.set(key, copy);
    },
    delete: async (key) => { records.delete(key); vectors.delete(key); index?.delete(key); },
    keys: async (wanted = '') => [...records.keys()].filter((key) => key.startsWith(wanted)).sort(),
    rank: async ({ prefix: wanted, vector, model: queryModel, dims: queryDims, limit = vectors.size }) => {
      if (wanted !== prefix || queryModel !== model || queryDims !== dims) throw new Error('rank storage identity/prefix mismatch');
      const identities = new Map();
      let skipped = 0;
      for (const [key, value] of records) if (key.startsWith(prefix)) {
        if (!value.embedding) skipped++;
        else identities.set(JSON.stringify(value.embeddedBy), value.embeddedBy);
      }
      const hits = index ? index.candidates(vector, limit)
        : [...vectors].map(([key, value]) => ({ key, score: cosineSimilarity(vector, value) })).sort(compare).slice(0, limit);
      return { hits, skipped, identities: [...identities.values()], ranking: {
        algorithm: index?.config.algorithm ?? 'exact-cosine', exhaustive: !index, candidateCount: hits.length } };
    },
    stats: () => ({ records: records.size,
      vectorBytes: [...vectors.values()].reduce((sum, vector) => sum + vector.byteLength, 0),
      indexBytes: index?.bytes() ?? 0,
      documentBytes: [...records].reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)), 0),
      byteScope: 'serialized documents plus resident numeric/key payload; excludes JS object overhead' }),
    indexConfig: index?.config ?? { algorithm: 'exact-cosine', dims },
  };
}

/** Predeclared acceptance bars: a fast answer must also be useful and maintainable. */
export const ANN_BARS = Object.freeze({ exactRecall10: 0.95, relevanceTolerance: 0,
  p95Speedup: 2, minimumExactP95Ms: 100, maxIndexToVectorBytes: 1,
  maxBuildMs: 30000, maxUpdateP95Ms: 10 });

/** Each ANN cutoff compares against the matching exact cutoff, not exact top-10.
 * @param {string[][]} exact @param {string[][]} approximate @param {number[]} [ks] */
export function annMetrics(exact, approximate, ks = [1, 5, 10]) {
  const byK = ks.map((k) => relevanceMetrics(exact.map((ids) => ({ gold: ids.slice(0, k) })),
    approximate.map((ids) => ids.slice(0, k)), [k]));
  return { recall: Object.fromEntries(ks.map((k, i) => [k, byK[i].recall[k]])),
    mrr: byK[ks.indexOf(Math.max(...ks))].mrr,
    mrrAt: Object.fromEntries(ks.map((k, i) => [k, byK[i].mrr])) };
}

/** Freeze pass/fail from published measurements, never from a chosen algorithm name.
 * @param {any} row @param {any} exact */
export function annDecision(row, exact) {
  const checks = {
    oracleRecall: row.oracle.recall[10] >= ANN_BARS.exactRecall10,
    relevance: [row.recall[10], exact.recall[10], row.mrr, exact.mrr, row.ndcg10, exact.ndcg10].every(Number.isFinite)
      && row.recall[10] >= exact.recall[10] && row.mrr >= exact.mrr && row.ndcg10 >= exact.ndcg10,
    p95Speedup: exact.latencyMs.p95 / row.latencyMs.p95 >= ANN_BARS.p95Speedup,
    ceilingMeasured: exact.latencyMs.p95 >= ANN_BARS.minimumExactP95Ms,
    bytes: row.storage.indexBytes <= row.storage.vectorBytes * ANN_BARS.maxIndexToVectorBytes,
    build: row.buildMs <= ANN_BARS.maxBuildMs,
    updates: row.lifecycle.updateP95Ms <= ANN_BARS.maxUpdateP95Ms && row.lifecycle.deletedAbsent && row.lifecycle.updatedPresent,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
