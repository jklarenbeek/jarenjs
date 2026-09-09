//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHashEmbedder, createLedger, createRefiner } from '@jarenjs/ai';
import { applyJSONPatch } from '@jarenjs/json';
import { createProjectionIndex, createRankStorage, annDecision, annMetrics } from '../../benchmark/lib/relevance-ann.js';
import { pressureFixture, runPressure, pressurePatch, representedUnits, pressureMetrics, guardedMerge, similarityBands } from '../../benchmark/lib/refinement-pressure.js';
import { loadDataset } from '../../benchmark/lib/relevance.js';
import { runRelevance, relevanceSubset } from '../../benchmark/recall-quality.js';

const temp = (t) => { const path = mkdtempSync(join(tmpdir(), 'pressure-')); t.after(() => rmSync(path, { force: true, recursive: true })); return path; };

describe('optional ANN instrument', () => {
  it('compares every cutoff to the corresponding exact top-k', () => {
    const result = annMetrics([['a', 'b', 'c']], [['b', 'a', 'c']], [1, 2, 3]);
    assert.deepEqual(result.recall, { 1: 0, 2: 1, 3: 1 });
    assert.equal(result.mrrAt[1], 0);
    assert.equal(result.mrrAt[2], 1);
  });
  it('has a deterministic update/delete lifecycle and bounded candidate set', () => {
    const a = createProjectionIndex({ dims: 3, seed: 2, fraction: 0.5 });
    const b = createProjectionIndex({ dims: 3, seed: 2, fraction: 0.5 });
    for (const [id, vector] of [['a', [1, 0, 0]], ['b', [0, 1, 0]], ['c', [0, 0, 1]]]) {
      a.upsert(id, vector); b.upsert(id, vector);
    }
    assert.deepEqual(a.candidates([1, 0, 0], 1), b.candidates([1, 0, 0], 1));
    const bytes = a.bytes();
    a.delete('a');
    assert.ok(a.candidates([1, 0, 0], 3).every((r) => r.key !== 'a'));
    assert.ok(a.bytes() < bytes);
    a.upsert('b', [1, 0, 0]);
    assert.equal(a.candidates([1, 0, 0], 1)[0].key, 'b');
    assert.throws(() => a.upsert('bad', [1, 2]), /invalid/);
    assert.throws(() => createProjectionIndex({ dims: 0 }), /invalid/);
  });
  it('exact adapter agrees with the four-method sweep after vector updates and deletion', async () => {
    const embedder = createHashEmbedder({ dims: 8 });
    const storage = createRankStorage({ model: embedder.model, dims: 8 });
    const ledger = createLedger({ storage, embedder, embedOnWrite: true });
    const { rank: _rank, ...four } = storage;
    const sweep = createLedger({ storage: four, embedder });
    for (const id of ['a', 'b', 'c']) await ledger.addMemory({ id, text: `record ${id}`, evidence: 'fixture', at: '2026-01-01T00:00:00Z' });
    for (const text of ['record a', 'record c']) {
      const expected = await sweep.recall({ near: text });
      const actual = await ledger.recall({ near: text });
      assert.deepEqual(actual.memories, expected.memories);
      assert.deepEqual(actual.scores, expected.scores);
    }
    await ledger.addMemory({ id: 'a', text: 'updated record a', evidence: 'revision', at: '2026-01-01T00:00:00Z' });
    await ledger.deleteMemory('b');
    assert.deepEqual((await ledger.recall({ near: 'updated record a' })).memories,
      (await sweep.recall({ near: 'updated record a' })).memories);
    await assert.rejects(storage.rank({ prefix: 'wrong', vector: [1], model: 'm', dims: 1 }), /mismatch/);
  });
  it('scores every size and contender without losing judgments or mislabelling a hash model', async () => {
    const dataset = loadDataset('benchmark/fixtures/relevance-tiny/manifest.json');
    assert.throws(() => relevanceSubset(dataset, 2, 1), /must cover/);
    const result = await runRelevance(dataset, createHashEmbedder(), { ann: true, embeddingClass: 'hash' });
    assert.equal(result.rows.length, 5);
    assert.ok(result.rows.every((row) => row.datasetClass === 'authored' && row.embeddingClass === 'hash'));
    assert.equal(result.rows.filter((row) => row.oracle).length, 2);
    assert.ok(result.rows.filter((row) => row.lifecycle).every((row) => row.lifecycle.deletedAbsent && row.lifecycle.updatedPresent));
    assert.match(result.annDecision, /retain exact/);
    const good = { oracle: { recall: { 10: 1 } }, recall: { 10: 1 }, mrr: 1, ndcg10: 1,
      latencyMs: { p95: 1 }, storage: { indexBytes: 1, vectorBytes: 10 }, buildMs: 1,
      lifecycle: { updateP95Ms: 1, deletedAbsent: true, updatedPresent: true } };
    const exact = { ...good, latencyMs: { p95: 100 } };
    assert.equal(annDecision(good, exact).pass, true);
    assert.equal(annDecision({ ...good, oracle: { recall: { 10: 0.9 } } }, exact).pass, false);
  });
});

describe('repeated refinement quality', () => {
  it('counts every similarity pair in exactly one band', () => {
    const result = similarityBands([[1, 0], [1, 0], [0, 1]].map((embedding) => ({ embedding })));
    assert.equal(result.pairs, 3);
    assert.equal(result.bands.atLeastPoint95, 1);
    assert.equal(result.bands.belowHalf, 2);
  });
  it('charges duplicate retrieval positions and scores all evidence in a merged record', () => {
    const questions = [{ gold: ['a', 'b'] }];
    const result = pressureMetrics(questions, [[['a'], ['a'], ['b']]], [['a'], ['b']]);
    assert.equal(result.recall[1], 0.5);
    assert.equal(result.recall[10], 1);
    assert.equal(result.mrr, 1);
    assert.equal(result.ndcg10, 1.5 / (1 + 1 / Math.log2(3)));
    assert.equal(pressureMetrics(questions, [[['a', 'b']]], [['a', 'b']]).ndcg10, 1);
    assert.equal(pressureMetrics(questions, [[[], ['b']]], [['a'], ['b']]).mrr, 0.5);
  });
  it('distinguishes duplicates from equally similar independent and contradictory evidence', () => {
    const fixture = pressureFixture();
    const base = fixture.facts.find((f) => f.id === 'amber-base');
    const corroboration = fixture.facts.find((f) => f.id === 'amber-confirm');
    assert.equal(base.text, corroboration.text);
    assert.notEqual(base.evidence, corroboration.evidence);
    assert.deepEqual(representedUnits(fixture, [base]), ['amber-base']);
    assert.deepEqual(representedUnits(fixture, [corroboration]), ['amber-confirm']);
    const record = ({ text, evidence, tags }) => ({ text, evidence, tags });
    assert.equal(pressurePatch('normalized-text', [record(base)], [record(corroboration)], new Map()).length, 0);
    assert.equal(pressurePatch('exact-evidence', [record(base)], [record(corroboration)], new Map()).length, 1);
    assert.throws(() => pressurePatch('unknown', [], [record(base)], new Map()), /unknown/);
    const conflict = fixture.facts.find((f) => f.id === 'amber-conflict');
    const unsafe = pressurePatch('guarded-model-merge', [{ ...record(base), id: 'stored' }], [record(conflict)],
      new Map(), (expected) => ({ ...expected, text: base.text }));
    assert.equal(unsafe.length, 1);
    assert.equal(unsafe[0].op, 'add', 'unsafe suggestion retains both records');
    assert.equal(guardedMerge(record(base), { ...record(base), evidence: 'invented' }), false);
  });
  it('replays through real refiner validation, persists/reopens, and rejects similarity-only loss', async (t) => {
    const fixture = pressureFixture();
    fixture.waves = fixture.waves.slice(0, 4);
    const result = await runPressure({ fixture, embedder: createHashEmbedder(), directory: temp(t), embeddingClass: 'hash' });
    assert.equal(result.results.length, 7);
    const none = result.results.find((r) => r.policy === 'none');
    assert.equal(none.waves.at(-1).records, fixture.waves.flat().length);
    assert.ok(none.waves.at(-1).snapshotBytes > 0);
    const cosine = result.results.find((r) => r.policy === 'similarity-only');
    assert.equal(cosine.decision.pass, false);
    assert.ok(cosine.waves.at(-1).complementRetention < 1);
    const exact = result.results.find((r) => r.policy === 'exact-evidence');
    assert.equal(exact.waves.at(-1).complementRetention, 1);
    assert.equal(exact.waves.at(-1).conflictRetention, 1);
    assert.ok(exact.waves.at(-1).duplicates < none.waves.at(-1).duplicates);
    assert.deepEqual(result.results.find((r) => r.policy === 'runtime-exact-evidence').waves, exact.waves);
  });
  it('keeps injected generation unlabelled and names its model without inventing quality scores', async (t) => {
    const fixture = pressureFixture(); fixture.waves = fixture.waves.slice(0, 2);
    const result = await runPressure({ fixture, embedder: createHashEmbedder(), directory: temp(t), policies: ['none'],
      liveClient: { endpoint: { provider: 'scripted-wire', model: 'proposal-fixture' },
        complete: async () => ({ message: { content: '[]' } }) } });
    assert.equal(result.proposals, 'live-unlabelled');
    assert.equal(result.generation.model, 'proposal-fixture');
    assert.equal(result.results[0].waves.length, 2);
    assert.ok(result.results[0].waves.every((row) => row.labelled === false && row.recall === undefined));
    assert.equal(result.results[0].decision, undefined);
  });
  it('a lossless merge cites replaced ids, retains conflicts and rolls back on validation refusal', async () => {
    const fixture = pressureFixture(), ledger = createLedger();
    const facts = ['amber-base', 'amber-conflict'].map((id) => fixture.facts.find((f) => f.id === id));
    const proposal = ({ text, evidence, tags }) => ({ text, evidence, tags });
    const original = await ledger.addMemory(proposal(facts[0]));
    const patch = pressurePatch('identical-evidence-merge', [original], [proposal(facts[1])], new Map());
    const refiner = createRefiner({ ledger, client: {}, applyPatch: applyJSONPatch });
    const committed = await refiner.commit(patch);
    assert.equal(committed.ok, true);
    const records = await ledger.listMemories();
    assert.equal(records.length, 1);
    assert.ok(records[0].evidence.includes(original.id));
    assert.deepEqual(representedUnits(fixture, records).sort(), ['amber-base', 'amber-conflict']);
    assert.notEqual(records[0].id, original.id);
    const bad = structuredClone(patch); bad[0].value.evidence = '';
    assert.ok((await refiner.commit(bad)).error);
    assert.deepEqual(await ledger.listMemories(), records);
    await ledger.rollback(committed.snapshot);
    assert.deepEqual(await ledger.listMemories(), [original]);
  });
});
