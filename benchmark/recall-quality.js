#!/usr/bin/env node
//@ts-check
/** Labelled retrieval and optional ANN scorecard; network is explicitly opt-in. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cpus, platform, arch } from 'node:os';
import { createHashEmbedder } from '@jarenjs/ai';
import { quantile } from '@jarenjs/core/stats';
import { loadDataset, scoreRelevance, sha256 } from './lib/relevance.js';
import { configureLiveEmbeddings } from './lib/relevance-live.js';
import { createRankStorage, createProjectionIndex, ANN_BARS, annDecision, annMetrics } from './lib/relevance-ann.js';
import { loadLedger, recencyPolicy, tagPolicy, rankedPolicy } from './lib/retrieval.js';
import { tokens } from '../scripts/generate-retrieval-corpus.js';

/** Deterministic nested subsets keep every labelled answer; full-size is the reference.
 * @param {any} dataset @param {number} size @param {number} seed */
export function relevanceSubset(dataset, size, seed) {
  const gold = new Set(dataset.questions.flatMap((q) => q.gold));
  if (!Number.isSafeInteger(size) || size < gold.size || size > dataset.documents.length)
    throw new Error(`size must cover ${gold.size} judged documents and be <= ${dataset.documents.length}`);
  const byHash = (a, b) => sha256(`${seed}:${a.id}`).localeCompare(sha256(`${seed}:${b.id}`));
  const selected = [...dataset.documents.filter((d) => gold.has(d.id)).sort(byHash),
    ...dataset.documents.filter((d) => !gold.has(d.id)).sort(byHash)].slice(0, size);
  return selected.sort((a, b) => a.id < b.id ? -1 : 1);
}

/** Update/delete probes operate through real ledger writes and rank reads, then restore.
 * @param {any} ledger @param {any[]} memories @param {any[]} questions @param {any} embedder */
async function lifecycle(ledger, memories, questions, embedder) {
  const times = [];
  const target = memories[0];
  const [probe] = await embedder.embed([questions[0].text]);
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const result = await ledger.addMemory({ ...target, text: target.text + ' ', embedding: Array.from(probe) });
    if (result.error) throw new Error('index update rejected');
    times.push(performance.now() - start);
  }
  const updated = await ledger.recall({ near: questions[0].text, limit: 10 });
  const position = updated.error ? -1 : updated.memories.findIndex((m) => m.id === target.id);
  const updatedPresent = position >= 0 && updated.scores[position] > 0.999999;
  const start = performance.now();
  await ledger.deleteMemory(target.id);
  const deleteMs = performance.now() - start;
  const deleted = await ledger.recall({ near: questions[0].text, limit: memories.length });
  const deletedAbsent = !deleted.error && !deleted.memories.some((m) => m.id === target.id);
  const restored = await ledger.addMemory(target);
  if (restored.error) throw new Error('index restore rejected');
  return { updateP95Ms: quantile(times, 0.95, { method: 'nearest-rank' }), deleteMs, deletedAbsent, updatedPresent };
}

/** One scorecard on verified, precomputed vectors; all retrieval uses the real ledger.
 * @param {any} dataset @param {any} embedder @param {{sizes?: number[], seed?: number, ann?: boolean, embeddingClass?: string}} [options] */
export async function runRelevance(dataset, embedder, options = {}) {
  const seed = options.seed ?? 17;
  const sizes = options.sizes ?? [dataset.documents.length];
  const texts = [...dataset.documents, ...dataset.questions].map((d) => d.text);
  const vectors = await embedder.embed(texts);
  const byText = new Map(texts.map((text, i) => [text, vectors[i]]));
  const frozen = { model: embedder.model, dims: embedder.dims, embed: async (requested) => requested.map((text) => {
    const vector = byText.get(text);
    if (!vector) throw new Error('query not in verified vector set');
    return vector;
  }) };
  const identity = { model: embedder.model, dims: embedder.dims };
  const rows = [];
  for (const size of sizes) {
    const selected = relevanceSubset(dataset, size, seed);
    // A neutral reproducible tag baseline: first three distinct words of length >= 5.
    const memories = selected.map((d) => ({ id: d.id, text: d.text, evidence: `dataset:${dataset.hash}:${d.id}`,
      tags: [...new Set(tokens(d.text).filter((word) => word.length >= 5))].slice(0, 3), at: '2026-01-01T00:00:00.000Z' }));
    const tags = new Set(memories.flatMap((m) => m.tags));
    // Recency/tag do not need embedded documents; their baseline avoids parsing unused vectors.
    const plain = await loadLedger(memories);
    const annotate = (row) => ({ ...row, size, datasetId: dataset.manifest.id,
      datasetClass: dataset.manifest.datasetClass, embeddingClass: options.embeddingClass ?? 'scripted',
      model: identity.model, dims: identity.dims });
    for (const policy of [recencyPolicy(plain, 'recency', 'recency'), tagPolicy(plain, tags, 'tag+recency', 'tag+recency')])
      rows.push(annotate(await scoreRelevance(policy, dataset.questions)));
    const embedded = memories.map((m) => ({ ...m, embedding: Array.from(byText.get(m.text)), embeddedBy: identity }));
    let exact;
    for (const fraction of [null, ...(options.ann ? [0.1, 0.5] : [])]) {
      const start = performance.now();
      const storage = createRankStorage({ ...identity, ...(fraction === null ? {} : {
        indexFactory: ({ dims }) => createProjectionIndex({ dims, seed, projections: 32, fraction }),
      }) });
      const ledger = await loadLedger(embedded, { embedder: frozen, storage });
      const buildMs = performance.now() - start;
      const policy = fraction === null ? 'exact' : `projection-${fraction}`;
      const measured = await scoreRelevance(rankedPolicy(ledger, policy, policy, 'adapter'), dataset.questions);
      const row = annotate({ ...measured, buildMs, storage: storage.stats(), config: storage.indexConfig,
        lifecycle: await lifecycle(ledger, embedded, dataset.questions, frozen) });
      if (fraction === null) exact = row;
      else {
        row.oracle = annMetrics(exact.rankings.map((r) => r.ids), row.rankings.map((r) => r.ids));
        row.decision = annDecision(row, exact);
      }
      rows.push(row);
    }
  }
  return { schemaVersion: 1, instrument: 'recall-quality', date: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    dataset: { ...dataset.manifest, hash: dataset.hash, documents: dataset.documents.length, queries: dataset.questions.length },
    config: { seed, sizes, ks: [1, 5, 10], ann: options.ann ?? false, scope: 'memories',
      subset: 'all positive-qrel documents, then seeded hash distractors; full size is reference',
      tags: 'first three distinct tokens with length >= 5', timestamp: 'equal; ties lexicographic id',
      latency: 'one warm-vector real-ledger recall per question; embedding measured separately' },
    embedding: { ...identity, class: options.embeddingClass ?? 'scripted',
      vectorHashes: texts.map((text, i) => ({ textHash: sha256(text), vectorHash: sha256(JSON.stringify(Array.from(vectors[i]))) })) },
    bars: ANN_BARS, rows,
    annDecision: options.ann ? (rows.some((r) => r.decision?.pass) ? 'eligible; review lifecycle before promotion' : 'retain exact; no contender cleared all bars') : 'not evaluated' };
}

/** CLI shared by the standalone runner and retrieval.js --dataset. @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const { values: flags } = parseArgs({ args: argv, options: {
    dataset: { type: 'string' }, live: { type: 'boolean', default: false }, ann: { type: 'boolean', default: false },
    'embed-only': { type: 'boolean', default: false }, cache: { type: 'string', default: 'benchmark/cache/recall-quality/vectors' },
    filepath: { type: 'string' }, output: { type: 'string', default: 'json' },
    sizes: { type: 'string' }, seed: { type: 'string', default: '17' }, dims: { type: 'string' },
    batch: { type: 'string', default: '64' }, help: { type: 'boolean', default: false },
  } });
  if (flags.help) {
    console.log('node benchmark/recall-quality.js --dataset MANIFEST [--live --dims N --cache DIR] [--ann] [--sizes 500,2000,5183] [--filepath FILE]');
    return;
  }
  if (!flags.dataset) throw new Error('--dataset is required; no synthetic fallback');
  if (flags.output !== 'json') throw new Error('labelled scorecards support --output json');
  const dataset = loadDataset(flags.dataset);
  const seed = Number(flags.seed), batch = Number(flags.batch);
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(batch) || batch < 1) throw new Error('invalid seed or batch');
  const sizes = flags.sizes?.split(',').map(Number);
  for (const size of sizes ?? [dataset.documents.length]) relevanceSubset(dataset, size, seed);
  const live = flags.live ? configureLiveEmbeddings({ datasetHash: dataset.hash,
    directory: flags.cache, dims: Number(flags.dims), batch }) : null;
  const embedder = live?.embedder ?? createHashEmbedder({ dims: Number(flags.dims ?? 64) });
  let result;
  try {
    if (flags['embed-only']) {
      await embedder.embed([...dataset.documents, ...dataset.questions].map((d) => d.text));
      result = { schemaVersion: 1, instrument: 'recall-quality-embedding', date: new Date().toISOString(),
        datasetHash: dataset.hash, model: embedder.model, dims: embedder.dims };
    }
    else result = await runRelevance(dataset, embedder, { sizes, seed, ann: flags.ann, embeddingClass: flags.live ? 'live' : 'hash' });
  }
  catch (error) {
    result = { schemaVersion: 1, instrument: 'recall-quality', date: new Date().toISOString(),
      datasetHash: dataset.hash, status: 'failed', error: live ? 'embedding or scoring failed; inspect verified cache and batch status' : 'scoring failed' };
    if (live) result.live = live.report();
    if (flags.filepath) writeFileSync(flags.filepath, JSON.stringify(result, null, 2) + '\n');
    throw error;
  }
  if (live) result.live = live.report();
  if (flags.filepath) writeFileSync(flags.filepath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ instrument: result.instrument, rows: result.rows?.length ?? 0,
    model: embedder.model, dims: embedder.dims, calls: live?.embedder.stats.calls ?? 0, annDecision: result.annDecision }));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
