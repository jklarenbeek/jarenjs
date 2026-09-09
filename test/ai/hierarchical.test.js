//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hierarchicalCorpus, hierarchicalScorecard, hierarchyProbe, scoreHierarchy } from '../../benchmark/lib/hierarchical.js';

describe('hierarchical depth frontier', () => {
  it('has original deterministic leaf provenance, neutral expected totals and distractors', () => {
    const corpus = hierarchicalCorpus();
    assert.deepEqual(corpus, hierarchicalCorpus());
    assert.equal(corpus.sections.length, 6);
    assert.equal(corpus.expected.evidence.length, 24);
    assert.equal(new Set(corpus.expected.evidence).size, 24);
    assert.ok(corpus.sections.every((section) => section.leaves.length === 4));
    assert.equal(scoreHierarchy({ ok: true, answer: { text: JSON.stringify({ value: corpus.expected }) } }, corpus).correct, true);
    assert.equal(scoreHierarchy({ ok: true, answer: { text: JSON.stringify({ value: { ...corpus.expected, evidence: [] } }) } }, corpus).correct, false);
  });
  it('runs the same corpus at every depth, charges the full tree and reproduces byte for byte', async () => {
    const a = await hierarchicalScorecard();
    assert.deepEqual(a, await hierarchicalScorecard());
    assert.equal(a.rows.length, 8);
    assert.ok(a.rows.every((row) => row.correct && row.evidenceRecall === 1));
    const first = a.rows.slice(0, 4);
    assert.equal(new Set(first.map((row) => row.corpusHash)).size, 1);
    assert.deepEqual(first.map((row) => row.authorCalls + row.subcalls), [3, 8, 22, 51]);
    assert.deepEqual(first.map((row) => row.tokens), [150, 400, 1100, 2550]);
  });
  it('records exhausted budgets without granting correctness to partial evidence', async () => {
    const row = await hierarchyProbe({ depth: 3, maxCalls: 2 });
    assert.equal(row.budgetExhausted, true);
    assert.equal(row.correct, false);
    assert.equal(row.authorCalls + row.subcalls, 2);
  });
});
