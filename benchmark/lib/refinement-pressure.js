//@ts-check
/** Repeated proposals into one durable ledger; labels never participate in selection. */
import { readFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { createLedger, createRefiner } from '@jarenjs/ai';
import { applyJSONPatch } from '@jarenjs/json';
import { cosineSimilarity } from '@jarenjs/core/vector';
import { createDbStorage } from './ledger-db.js';
import { sha256 } from './relevance.js';

/** Authored evidence includes independent corroboration and case-sensitive conflicts. */
export function pressureFixture() {
  return JSON.parse(readFileSync(new URL('../fixtures/refinement-pressure.json', import.meta.url), 'utf8'));
}

/** Policy bars are checked at every wave, not just a conveniently chosen endpoint. */
export const DEDUP_BARS = Object.freeze({ recallTolerance: 0, mrrTolerance: 0, ndcgTolerance: 0,
  conflictRetention: 1, complementRetention: 1, minimumByteReduction: 0.1,
  minimumDuplicateReduction: 0.1, defaultEligible: false });

const normalized = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase();
const sameEvidence = (a, b) => a.evidence === b.evidence;
const exactEvidence = (a, b) => a.text === b.text && sameEvidence(a, b)
  && JSON.stringify([...a.tags].sort()) === JSON.stringify([...b.tags].sort());

/** A model-suggested merge must be lossless and add no invented text or citation.
 * @param {any} expected @param {any} suggested */
export function guardedMerge(expected, suggested) {
  return suggested !== null && typeof suggested === 'object'
    && Object.keys(suggested).every((key) => ['text', 'evidence', 'tags'].includes(key))
    && suggested.text === expected.text && suggested.evidence === expected.evidence
    && Array.isArray(suggested.tags)
    && JSON.stringify([...suggested.tags].sort()) === JSON.stringify([...expected.tags].sort());
}

/** Benchmark policy proposals. No scored label is read here. Merges cite source ids
 * in evidence and keep every distinct source text. Similarity-only is an unsafe control.
 * @param {string} policy @param {any[]} existing @param {any[]} proposals @param {Map<string, any>} vectors
 * @param {(expected: any) => any} [suggestMerge] */
export function pressurePatch(policy, existing, proposals, vectors, suggestMerge = (expected) => expected) {
  const next = structuredClone(existing);
  for (const proposal of proposals) {
    if (policy === 'none' || policy === 'runtime-exact-evidence') { next.push(proposal); continue; }
    if (policy === 'exact-evidence') {
      if (!next.some((record) => exactEvidence(record, proposal))) next.push(proposal);
      continue;
    }
    if (policy === 'normalized-text') {
      if (!next.some((record) => normalized(record.text) === normalized(proposal.text))) next.push(proposal);
      continue;
    }
    if (policy === 'similarity-only') {
      if (!next.some((record) => cosineSimilarity(vectors.get(record.text), vectors.get(proposal.text)) >= 0.95)) next.push(proposal);
      continue;
    }
    if (policy === 'identical-evidence-merge' || policy === 'guarded-model-merge') {
      // A scripted model proposes the same merge target. The guard requires identical
      // evidence and retains the full conflicting text; an unsafe model rewrite cannot pass.
      const target = next.find((record) => record.evidence === proposal.evidence
        || record.evidence.startsWith(proposal.evidence + '\nSource ids: '));
      if (!target) { next.push(proposal); continue; }
      if (target.text.split('\n').includes(proposal.text) && proposal.tags.every((tag) => target.tags.includes(tag))) continue;
      const expected = { text: target.text.split('\n').includes(proposal.text) ? target.text : target.text + '\n' + proposal.text,
        evidence: target.evidence + (target.id ? (target.evidence.includes('\nSource ids: ') ? ', ' : '\nSource ids: ') + target.id : ''),
        tags: [...new Set([...target.tags, ...proposal.tags])] };
      const suggested = policy === 'guarded-model-merge' ? suggestMerge(structuredClone(expected)) : expected;
      if (!guardedMerge(expected, suggested)) { next.push(proposal); continue; }
      Object.assign(target, suggested);
      // A changed text invalidates its old vector; the real ledger sweep replaces it.
      delete target.embedding;
      delete target.embeddedBy;
      continue;
    }
    throw new Error(`unknown pressure policy ${policy}`);
  }
  // Keep operations bounded by the actual change, not the total ledger size.
  const patch = [];
  for (let i = 0; i < existing.length; i++) if (JSON.stringify(existing[i]) !== JSON.stringify(next[i])) {
    const { text, evidence, tags } = next[i];
    patch.push({ op: 'replace', path: `/memories/${i}`, value: { text, evidence, tags } });
  }
  for (const value of next.slice(existing.length)) patch.push({ op: 'add', path: '/memories/-', value });
  return patch;
}

/** Score distinct evidence units: repeated copies cannot increase recall.
 * @param {any} fixture @param {any[]} records */
export function representedUnits(fixture, records) {
  return [...new Set(records.flatMap((record) => fixture.facts
    .filter((fact) => record.text.split('\n').includes(fact.text) && record.evidence.includes(fact.evidence))
    .map((fact) => fact.unit)))];
}

/** Evidence recall counts each source unit once, but duplicates still consume
 * retrieval positions. MRR uses the first relevant RECORD. Novel-evidence nDCG
 * uses linear new-unit gain and the optimal ordering of the current corpus;
 * a lossless merged record may carry more than one evidence unit.
 * @param {any[]} questions @param {string[][][]} rankings @param {string[][]} available */
export function pressureMetrics(questions, rankings, available) {
  const recall = { 1: 0, 5: 0, 10: 0 };
  let mrr = 0, ndcg10 = 0;
  const count = (mask) => { let n = 0; while (mask) { n += mask & 1; mask >>>= 1; } return n; };
  for (let i = 0; i < questions.length; i++) {
    const gold = questions[i].gold;
    if (!gold.length || gold.length > 15) throw new Error('pressure questions need between 1 and 15 evidence units');
    const mask = (units) => gold.reduce((bits, id, j) => units.includes(id) ? bits | (1 << j) : bits, 0);
    const masks = rankings[i].map(mask);
    for (const k of [1, 5, 10]) recall[k] += count(masks.slice(0, k).reduce((a, b) => a | b, 0)) / gold.length;
    const first = masks.findIndex((m) => m !== 0);
    if (first >= 0) mrr += 1 / (first + 1);
    let covered = 0, dcg = 0;
    for (let rank = 0; rank < Math.min(10, masks.length); rank++) {
      dcg += count(masks[rank] & ~covered) / Math.log2(rank + 2);
      covered |= masks[rank];
    }
    const choices = [...new Set(available.map(mask))].filter(Boolean);
    const memo = new Map();
    const ideal = (seen, rank) => {
      if (rank >= 10) return 0;
      const key = `${seen}:${rank}`;
      if (memo.has(key)) return memo.get(key);
      let best = 0;
      for (const candidate of choices) {
        const added = candidate & ~seen;
        if (added) best = Math.max(best, count(added) / Math.log2(rank + 2) + ideal(seen | candidate, rank + 1));
      }
      memo.set(key, best);
      return best;
    };
    const idcg = ideal(0, 0);
    ndcg10 += idcg ? dcg / idcg : 0;
  }
  return { recall: Object.fromEntries(Object.entries(recall).map(([k, value]) => [k, value / questions.length])),
    mrr: mrr / questions.length, ndcg10: ndcg10 / questions.length };
}

/** All unordered stored-vector pairs, with no sampling or label-based exclusions.
 * @param {any[]} records */
export function similarityBands(records) {
  const bands = { belowHalf: 0, halfToNineTenths: 0, nineTenthsToPoint95: 0, atLeastPoint95: 0 };
  for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
    const score = cosineSimilarity(records[i].embedding, records[j].embedding);
    const band = score < 0.5 ? 'belowHalf' : score < 0.9 ? 'halfToNineTenths' : score < 0.95 ? 'nineTenthsToPoint95' : 'atLeastPoint95';
    bands[band]++;
  }
  return { pairs: records.length * (records.length - 1) / 2, bands };
}

/** Replay each policy in its own persisted database; every wave reopens that same store.
 * @param {{fixture?: any, embedder: any, directory: string, policies?: string[], liveClient?: any,
 * embeddingClass?: string}} options */
export async function runPressure({ fixture = pressureFixture(), embedder, directory,
  policies = ['none', 'normalized-text', 'identical-evidence-merge', 'guarded-model-merge', 'similarity-only', 'exact-evidence', 'runtime-exact-evidence'],
  liveClient, embeddingClass = 'scripted' }) {
  const sourceTexts = [...new Set(fixture.facts.map((f) => f.text))];
  // Include all evidence-equal concatenations used by the contender, so live
  // embedding is bought once for the whole comparison, independent of its winner.
  for (const evidence of new Set(fixture.facts.map((f) => f.evidence))) {
    const seen = [];
    for (const wave of fixture.waves) for (const id of wave) {
      const fact = fixture.facts.find((f) => f.id === id);
      if (fact.evidence !== evidence || seen.includes(fact.text)) continue;
      seen.push(fact.text);
      sourceTexts.push(seen.join('\n'));
    }
  }
  const texts = [...new Set([...sourceTexts, ...fixture.questions.map((q) => q.text)])];
  const embedded = await embedder.embed(texts);
  const vectors = new Map(texts.map((text, i) => [text, embedded[i]]));
  const frozen = { model: embedder.model, dims: embedder.dims,
    embed: async (values) => values.map((text) => {
      if (!vectors.has(text)) throw new Error('unlabelled text requires separate live embedding');
      return vectors.get(text);
    }) };
  const results = [];
  const similarities = [];
  for (const fact of fixture.facts) if (fact.class !== 'valuable') {
    const base = fixture.facts.find((f) => f.class === 'valuable' && f.tags[0] === fact.tags[0]);
    similarities.push({ id: fact.id, class: fact.class,
      score: cosineSimilarity(vectors.get(fact.text), vectors.get(base.text)) });
  }
  for (const policy of policies) {
    const path = `${directory}/${policy}.sqlite`;
    let storage = await createDbStorage({ path, dims: embedder.dims });
    try {
      if ((await storage.keys()).length) throw new Error('pressure run requires an empty database; choose a new directory');
      const waves = [];
      let proposed = 0;
      for (let wave = 0; wave < fixture.waves.length; wave++) {
        const at = new Date(Date.UTC(2026, 0, 1, 0, 0, wave)).toISOString();
        const ledger = createLedger({ storage, embedder: frozen, now: () => at });
        const proposals = fixture.waves[wave].map((id) => {
          const fact = fixture.facts.find((f) => f.id === id);
          return { text: fact.text, evidence: fact.evidence, tags: fact.tags };
        });
        proposed += proposals.length;
        const before = await ledger.listMemories();
        const patch = pressurePatch(policy, before, proposals, vectors);
        const client = liveClient ?? { endpoint: { provider: 'scripted' },
          complete: async () => ({ message: { role: 'assistant', content: JSON.stringify(patch) } }) };
        const refiner = createRefiner({ ledger, client, applyPatch: applyJSONPatch,
          maxOps: 100, maxRepairs: 0, now: () => at,
          ...(policy === 'runtime-exact-evidence' ? { deduplicate: 'exact-evidence' } : {}) });
        const trajectory = proposals.map((p) => ({ role: 'tool', content: `${p.text}\n${p.evidence}` }));
        const result = await refiner.refine(trajectory);
        if (result.error) throw new Error(`pressure refiner rejected ${policy} wave ${wave}: ${result.error}`);
        // Live proposals are unlabelled and intentionally do not receive ground-truth scores.
        if (liveClient) {
          waves.push({ wave: wave + 1, proposals: proposals.length, records: (await ledger.listMemories()).length,
            labelled: false, attempts: result.attempts });
          await storage.close();
          storage = await createDbStorage({ path, dims: embedder.dims });
          continue;
        }
        const swept = await ledger.embedMissing({ batch: 64 });
        if (swept.error || swept.remaining) throw new Error('pressure embedding sweep failed');
        const records = await ledger.listMemories();
        const units = representedUnits(fixture, records);
        const appeared = new Set(fixture.waves.slice(0, wave + 1).flat().map((id) => fixture.facts.find((f) => f.id === id).unit));
        const questions = fixture.questions.map((q) => ({ ...q, gold: q.gold.filter((id) => appeared.has(id)) })).filter((q) => q.gold.length);
        const rankings = [];
        for (const q of questions) {
          const answer = await ledger.recall({ near: q.text, limit: 10 });
          if (answer.error) throw new Error('pressure recall failed');
          rankings.push(answer.memories.map((record) => representedUnits(fixture, [record])));
        }
        const metrics = pressureMetrics(questions, rankings, records.map((record) => representedUnits(fixture, [record])));
        const retained = (kind) => {
          const expected = [...new Set(fixture.facts.filter((f) => f.class === kind && appeared.has(f.unit)).map((f) => f.unit))];
          return expected.length ? expected.filter((u) => units.includes(u)).length / expected.length : 1;
        };
        const represented = records.map((record) => representedUnits(fixture, [record]));
        const duplicates = represented.reduce((sum, list) => sum + list.length, 0) - units.length;
        const keys = await storage.keys();
        const bytes = async (selected) => (await Promise.all(selected.map(async (key) => Buffer.byteLength(JSON.stringify(await storage.get(key)))))).reduce((a, b) => a + b, 0);
        waves.push({ wave: wave + 1, proposed, additions: records.length - before.length,
          records: records.length, valuableUnits: units.length, duplicates, bytes: await bytes(keys.filter((k) => k.startsWith('ai/state/'))),
          similarity: similarityBands(records),
          snapshotBytes: await bytes(keys.filter((k) => k.startsWith('ai/snap/'))),
          classCounts: Object.fromEntries(['valuable', 'duplicate', 'complement', 'conflict', 'irrelevant'].map((kind) => [kind,
            fixture.waves.slice(0, wave + 1).flat().filter((id) => fixture.facts.find((f) => f.id === id).class === kind).length])),
          conflictRetention: retained('conflict'), complementRetention: retained('complement'), ...metrics });
        // Prove reopen semantics after every successful wave.
        await storage.close();
        storage = await createDbStorage({ path, dims: embedder.dims });
      }
      results.push({ policy, waves });
    }
    finally { await storage.close(); }
  }
  const baseline = results.find((r) => r.policy === 'none');
  for (const result of results) if (baseline && !liveClient) {
    const last = result.waves.at(-1), base = baseline.waves.at(-1);
    const checks = {
      relevance: result.waves.every((row, i) => row.recall[10] >= baseline.waves[i].recall[10]
        && row.mrr >= baseline.waves[i].mrr && row.ndcg10 >= baseline.waves[i].ndcg10),
      conflict: result.waves.every((row) => row.conflictRetention === 1),
      complement: result.waves.every((row) => row.complementRetention === 1),
      bytes: last.bytes <= base.bytes * (1 - DEDUP_BARS.minimumByteReduction),
      duplicates: last.duplicates <= base.duplicates * (1 - DEDUP_BARS.minimumDuplicateReduction),
    };
    result.decision = { pass: Object.values(checks).every(Boolean), checks };
  }
  return { schemaVersion: 1, instrument: 'refinement-pressure', date: new Date().toISOString(), node: process.version,
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    dataset: { id: fixture.id, class: fixture.datasetClass, hash: sha256(JSON.stringify(fixture)), license: fixture.license },
    embedding: { model: embedder.model, dims: embedder.dims, class: embeddingClass },
    proposals: liveClient ? 'live-unlabelled' : 'scripted-labelled', bars: DEDUP_BARS,
    ...(liveClient ? { generation: { provider: liveClient.endpoint?.provider ?? 'host-injected',
      model: liveClient.endpoint?.model ?? null, maxRepairs: 0, labelled: false } } : {}),
    config: { seed: 0, waves: fixture.waves.length, ledger: 'one SQLite database per policy, reopened after each wave',
      scope: 'memories', k: 10, classCounts: 'cumulative proposed labels',
      metrics: 'distinct-evidence recall; first-record MRR; linear novel-evidence nDCG with optimal current-ledger ordering', policies },
    similarities, results };
}
