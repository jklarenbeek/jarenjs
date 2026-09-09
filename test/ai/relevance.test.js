//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger, createMemoryStorage } from '@jarenjs/ai';
import { loadDataset, normalizeDataset, parseJsonl, relevanceMetrics, scoreRelevance, sha256 } from '../../benchmark/lib/relevance.js';
import { createRelevanceCache, meteredFetch, verifiedVector } from '../../benchmark/lib/relevance-cache.js';

const fixture = fileURLToPath(new URL('../../benchmark/fixtures/relevance-tiny/manifest.json', import.meta.url));
const manifest = { schemaVersion: 1, id: 'tiny', datasetClass: 'authored', source: 'Jaren', license: 'MIT', version: '1' };
const corpus = [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }];
const queries = [{ id: 'q', text: 'Question' }];
const qrels = [{ queryId: 'q', corpusId: 'a', relevance: 1 }];
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'relevance-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

describe('labelled relevance and the data boundary', () => {
  it('pins graded recall, MRR, nDCG and no-answer by hand', async () => {
    const dataset = loadDataset(fixture);
    const rankings = [['b', 'c', 'a'], ['a', 'c'], []];
    const result = relevanceMetrics(dataset.questions, rankings);
    assert.equal(result.recall[1], 0.25); // half of q1, none of q2
    assert.equal(result.hitRate[1], 0.5);
    assert.equal(result.recall[5], 1);
    assert.equal(result.mrr, 0.75);
    const expected = ((1 + 3 / 2) / (3 + 1 / Math.log2(3)) + 1 / Math.log2(3)) / 2;
    assert.ok(Math.abs(result.ndcg10 - expected) < 1e-12);
    assert.deepEqual(result.noAnswer, { queries: 1, abstained: 1, falseAnswers: 0, accuracy: 1 });
    assert.equal(relevanceMetrics(dataset.questions, [['b'], [], ['a']]).noAnswer.accuracy, 0);
    const scored = await scoreRelevance({ key: 'pinned', run: (q) => rankings[dataset.questions.indexOf(q)] }, dataset.questions);
    assert.equal(scored.mrr, result.mrr);
    assert.ok(!JSON.stringify(scored).includes(dataset.questions[0].text));
    assert.equal(relevanceMetrics([dataset.questions[2]], [[]]).mrr, null);
  });
  it('normalizes ordering and keeps provenance classes in the hash', () => {
    const a = normalizeDataset(manifest, corpus, queries, qrels);
    assert.equal(normalizeDataset(manifest, [...corpus].reverse(), queries, qrels).hash, a.hash);
    for (const datasetClass of ['synthetic', 'real-language'])
      assert.notEqual(normalizeDataset({ ...manifest, datasetClass }, corpus, queries, qrels).hash, a.hash);
  });
  for (const [label, docs, qs, rels, pattern] of [
    ['duplicate corpus ids', [...corpus, corpus[0]], queries, qrels, /duplicate id/],
    ['duplicate query ids', corpus, [...queries, queries[0]], qrels, /duplicate id/],
    ['dangling document', corpus, queries, [{ ...qrels[0], corpusId: 'missing' }], /dangling/],
    ['dangling query', corpus, queries, [{ ...qrels[0], queryId: 'missing' }], /dangling/],
    ['conflicting judgments', corpus, queries, [...qrels, { ...qrels[0], relevance: 2 }], /conflicting qrel/],
    ['empty queries', corpus, [], [], /empty query/],
    ['empty corpus', [], queries, qrels, /empty corpus/],
    ['missing judgments', corpus, queries, [], /missing positive/],
    ['contradictory no-answer', corpus, [{ ...queries[0], noAnswer: true }], qrels, /conflicting noAnswer/],
    ['invalid gain', corpus, queries, [{ ...qrels[0], relevance: -1 }], /relevance/],
  ]) it(`refuses ${label}`, () => assert.throws(() => normalizeDataset(manifest, docs, qs, rels), pattern));
  it('refuses checksum tampering, escaping paths, malformed JSON and duplicate rankings', (t) => {
    const dir = temp(t);
    cpSync(new URL('../../benchmark/fixtures/relevance-tiny/', import.meta.url), dir, { recursive: true });
    writeFileSync(join(dir, 'corpus.jsonl'), '{}\n');
    assert.throws(() => loadDataset(join(dir, 'manifest.json')), /checksum/);
    const m = JSON.parse(readFileSync(fixture, 'utf8'));
    m.files.corpus.path = '../escape.jsonl';
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    assert.throws(() => loadDataset(join(dir, 'manifest.json')), /escapes/);
    assert.throws(() => parseJsonl('{secret', 'corpus'), /line 1/);
    assert.throws(() => relevanceMetrics([{ gold: ['a'] }], [['a', 'a']]), /distinct/);
    assert.throws(() => relevanceMetrics([], []), /invalid scoring/);
  });
});

describe('identity-bound embedding cache', () => {
  const identity = { datasetHash: sha256('dataset'), provider: 'scripted', model: 'fixture', dims: 2 };
  const embedder = { model: 'fixture', dims: 2, embed: async (texts) => texts.map(() => new Float32Array([1, 2])) };
  it('batches distinct texts, resumes, and verifies cached vector hashes', async (t) => {
    const directory = temp(t);
    const cache = createRelevanceCache({ directory, identity, embedder, batch: 1 });
    await assert.rejects(cache.embed('abc'), /text array/);
    assert.equal((await cache.embed(['a', 'b', 'a'])).length, 3);
    assert.equal(cache.stats.calls, 2);
    const resumed = createRelevanceCache({ directory, identity, embedder: { ...embedder, embed: () => assert.fail('must resume') } });
    assert.equal((await resumed.embed(['b', 'a'])).length, 2);
    assert.equal(resumed.stats.cacheHits, 2);
    const path = join(directory, `${sha256('a')}.json`);
    const row = JSON.parse(readFileSync(path, 'utf8'));
    row.vector[0] = 42;
    writeFileSync(path, JSON.stringify(row));
    await assert.rejects(resumed.embed(['a']), /checksum/);
  });
  it('refuses cross-provider, model, dataset, dimensions and text-policy reuse', (t) => {
    const directory = temp(t);
    createRelevanceCache({ directory, identity, embedder });
    for (const change of [{ provider: 'other' }, { model: 'other' }, { dims: 3 }, { datasetHash: sha256('other') }, { textPolicy: 'truncated' }])
      assert.throws(() => createRelevanceCache({ directory, identity: { ...identity, ...change }, embedder: { ...embedder, ...change } }), /identity mismatch/);
  });
  it('keeps failed batches, excludes secrets, and resumes paid work', async (t) => {
    const directory = temp(t);
    let call = 0;
    const failing = { ...embedder, embed: async (texts) => { if (++call === 2) throw new Error('secret-token raw-text'); return embedder.embed(texts); } };
    const cache = createRelevanceCache({ directory, identity, embedder: failing, batch: 1 });
    await assert.rejects(cache.embed(['first', 'second']), /batch failed/);
    assert.equal(cache.stats.embedded, 1);
    assert.equal(cache.stats.failures.length, 1);
    for (const file of readdirSync(directory)) assert.doesNotMatch(readFileSync(join(directory, file), 'utf8'), /secret-token|raw-text|first|second/);
    const resumed = createRelevanceCache({ directory, identity, embedder, batch: 1 });
    await resumed.embed(['first', 'second']);
    assert.equal(resumed.stats.calls, 1);
    assert.equal(resumed.history().filter((r) => r.outcome === 'failed').length, 1);
  });
  it('charges a hard request ceiling and refuses partial/invalid batches and Float32 overflow', async (t) => {
    const cache = createRelevanceCache({ directory: temp(t), identity, embedder, batch: 1, maxCalls: 1 });
    await assert.rejects(cache.embed(['a', 'b']), /ceiling/);
    assert.equal(cache.stats.embedded, 1);
    const broken = createRelevanceCache({ directory: temp(t), identity, embedder: { ...embedder, embed: async () => [[1, 2], [NaN, 2]] } });
    await assert.rejects(broken.embed(['a', 'b']), /failed/);
    assert.equal(broken.stats.embedded, 0);
    for (const v of [[1e100, 1], [0, 0], [1], ['1', 1]]) assert.throws(() => verifiedVector(v, 2), /invalid/);
  });
  it('refuses identity drift within one embedder instance', async (t) => {
    const moving = { ...embedder };
    const cache = createRelevanceCache({ directory: temp(t), identity, embedder: moving });
    moving.model = 'foreign';
    await assert.rejects(cache.embed(['a']), /identity changed/);
    moving.model = 'fixture';
    moving.embed = async (texts) => { moving.model = 'foreign'; return embedder.embed(texts); };
    await assert.rejects(cache.embed(['a']), /batch failed/);
    assert.equal(cache.stats.embedded, 0);
  });
  it('collects only reported usage, including failed requests', async () => {
    const meter = meteredFetch(async () => new Response(JSON.stringify({ usage: { total_tokens: 12, cost: 0.01 }, raw: 'private' })));
    await meter.fetch('https://example.invalid', {});
    assert.equal(meter.usage.reportedTokens, 12);
    assert.equal(meter.usage.reportedCost, 0.01);
    assert.ok(!JSON.stringify(meter.usage).includes('private'));
  });
});

describe('storage candidate trust boundary', () => {
  const prefix = 'ai/state/memory/';
  const embedder = { model: 'm', dims: 2, embed: async () => [new Float32Array([1, 0])] };
  async function setup(reply) {
    const storage = createMemoryStorage();
    const ledger = createLedger({ storage: { ...storage, rank: async () => reply }, embedder });
    for (const [id, embedding] of [['a', [1, 0]], ['b', [0, 1]]])
      await ledger.addMemory({ id, text: id, evidence: 'source', embedding, embeddedBy: { model: 'm', dims: 2 } });
    return { ledger, storage };
  }
  const valid = () => ({ hits: [{ key: prefix + 'b', score: 100 }, { key: prefix + 'a', score: -100 }], skipped: 0, identities: [{ model: 'm', dims: 2 }] });
  it('re-scores unsorted hits, normalizes old exact metadata, and reports approximation', async () => {
    const reply = valid();
    const { ledger } = await setup(reply);
    const old = await ledger.recall({ near: 'q', limit: 1 });
    assert.equal(old.memories[0].id, 'a');
    assert.deepEqual(old.scores, [1]);
    assert.deepEqual(old.ranking, { algorithm: 'legacy-exact', exhaustive: true, candidateCount: 2 });
    reply.ranking = { algorithm: 'host-ann', exhaustive: false, candidateCount: 2 };
    assert.equal((await ledger.recall({ near: 'q' })).ranking.exhaustive, false);
  });
  for (const [name, mutate] of [
    ['foreign prefix', (r) => { r.hits[0].key = 'ai/state/skill/b'; }],
    ['duplicate hit', (r) => { r.hits.push(r.hits[0]); }],
    ['invalid score', (r) => { r.hits[0].score = NaN; }],
    ['negative skipped', (r) => { r.skipped = -1; }],
    ['malformed identity', (r) => { r.identities = [null]; }],
    ['lying count', (r) => { r.ranking = { algorithm: 'ann', exhaustive: false, candidateCount: 1 }; }],
    ['null metadata', (r) => { r.ranking = null; }],
  ]) it(`refuses ${name}`, async () => {
    const reply = valid(); mutate(reply);
    const { ledger } = await setup(reply);
    assert.ok((await ledger.recall({ near: 'q' })).error);
  });
  it('verifies stored identity and vector even when the adapter lies, tolerating concurrent deletion', async () => {
    const { ledger, storage } = await setup(valid());
    const original = await storage.get(prefix + 'a');
    await storage.set(prefix + 'a', { ...original, embeddedBy: { model: 'foreign', dims: 2 } });
    assert.match((await ledger.recall({ near: 'q' })).error, /identity mismatch/);
    await storage.set(prefix + 'a', { ...original, embedding: [null, 1] });
    assert.match((await ledger.recall({ near: 'q' })).error, /vector/);
    await storage.delete(prefix + 'a');
    assert.deepEqual((await ledger.recall({ near: 'q' })).memories.map((m) => m.id), ['b']);
  });
});
