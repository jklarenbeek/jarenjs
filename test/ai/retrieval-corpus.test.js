//@ts-check
/**
 * @file The retrieval instrument's corpus and scorer, tested.
 *
 * `benchmark/retrieval.js` publishes the number every retrieval change
 * is measured against, and both halves of it can rot silently: the
 * committed corpus can drift from its generator, and a scorer that
 * mis-reads a rank still prints a plausible table. So the generator is
 * proven byte-identical run to run and against the committed fixture,
 * the corpus invariants the scorer relies on are asserted, and the
 * scorer is run through its own gate — the oracle row must be 1.000
 * everywhere and the random row must sit on its analytic floor — plus a
 * kill-check that the gate refuses a broken oracle.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORPUS_SEED, SIZES, generateRetrievalCorpus, serializeCorpus,
} from '../../scripts/generate-retrieval-corpus.js';
import {
  KS, assertScorer, corpusAt, loadCorpus, loadLedger, questionTags, randomBand, randomFloor, runSize,
} from '../../benchmark/lib/retrieval.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GENERATOR = path.join(ROOT, 'scripts/generate-retrieval-corpus.js');
const FIXTURE = path.join(ROOT, 'benchmark/fixtures/retrieval-corpus.json');

describe('the retrieval corpus generator', () => {
  it('is deterministic: two runs into a temp dir are byte-identical, and so is the committed fixture', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'retrieval-corpus-'));
    try {
      const run = (name) => {
        const out = path.join(dir, name);
        const result = spawnSync(process.execPath, [GENERATOR, '--write', '--out', out],
          { cwd: ROOT, encoding: 'utf8' });
        assert.strictEqual(result.status, 0, result.stderr);
        return readFileSync(out);
      };
      const first = run('a.json');
      const second = run('b.json');
      assert.ok(first.equals(second), 'the second run differs from the first');
      assert.ok(first.equals(readFileSync(FIXTURE)),
        'the committed fixture differs from the generator — run node scripts/generate-retrieval-corpus.js --write and read the diff');
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers the same in-process as through its CLI, from the published seed', () => {
    assert.strictEqual(serializeCorpus(generateRetrievalCorpus(CORPUS_SEED)), readFileSync(FIXTURE, 'utf8'));
  });

  it('checks the committed fixture without --write, and exits 1 when it drifts', () => {
    const clean = spawnSync(process.execPath, [GENERATOR], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /the committed fixture agrees/);
    const dir = mkdtempSync(path.join(tmpdir(), 'retrieval-corpus-'));
    try {
      const drifted = spawnSync(process.execPath, [GENERATOR, '--out', path.join(dir, 'missing.json')],
        { cwd: ROOT, encoding: 'utf8' });
      assert.strictEqual(drifted.status, 1);
      assert.match(drifted.stderr, /does not match/);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the committed corpus', () => {
  const corpus = loadCorpus();
  const byId = new Map(corpus.memories.map((m) => [m.id, m]));

  it('carries the sizes it claims, as a prefix design with every gold memory inside the smallest', () => {
    assert.deepStrictEqual(corpus.sizes, SIZES);
    assert.strictEqual(corpus.memories.length, SIZES[SIZES.length - 1]);
    for (const size of corpus.sizes) assert.doesNotThrow(() => corpusAt(corpus, size));
    assert.throws(() => corpusAt(corpus, corpus.memories.length + 1), /not/);
  });

  it('has unique ids, unique statements, and one gold memory per fact stating exactly that fact', () => {
    assert.strictEqual(byId.size, corpus.memories.length, 'duplicate memory ids');
    assert.strictEqual(new Set(corpus.memories.map((m) => m.text)).size, corpus.memories.length,
      'two memories state the same thing, so a distractor is indistinguishable from its gold');
    assert.strictEqual(corpus.facts.length, 240);
    for (const fact of corpus.facts) {
      const memory = byId.get(fact.memory);
      assert.ok(memory !== undefined, `${fact.id} names a memory that does not exist`);
      assert.strictEqual(memory.text, fact.text);
      assert.strictEqual(memory.tags[0], fact.topic, 'a gold memory carries its topic as its first tag');
    }
  });

  it('asks every fact exactly once, with one, two or three gold memories per question', () => {
    assert.strictEqual(corpus.questions.length, 160);
    const asked = corpus.questions.flatMap((q) => q.facts);
    assert.deepStrictEqual([...asked].sort(), corpus.facts.map((f) => f.id).sort());
    const counts = corpus.questions.map((q) => q.gold.length);
    for (const count of [1, 2, 3]) assert.ok(counts.includes(count), `no question with ${count} gold memories`);
    assert.ok(counts.every((c) => c >= 1 && c <= 3));
    for (const question of corpus.questions) {
      assert.strictEqual(question.gold.length, question.facts.length);
      assert.strictEqual(new Set(question.gold).size, question.gold.length, `${question.id} repeats a gold id`);
      for (const id of question.gold) assert.ok(byId.has(id), `${question.id} names ${id}, which does not exist`);
      // the subjects a multi-gold question names are distinct — the
      // question "about X and X" would be one subject with two answers
      const subjects = question.facts.map((f) => corpus.facts.find((x) => x.id === f).text.split(' ').slice(0, 3).join(' '));
      assert.strictEqual(new Set(subjects).size, subjects.length, `${question.id} repeats a subject`);
    }
  });

  it('spreads `at` over one synthetic year and every record passes the ledger schema', async () => {
    const years = new Set(corpus.memories.map((m) => m.at.slice(0, 4)));
    assert.deepStrictEqual([...years], ['2025']);
    const months = new Set(corpus.memories.map((m) => m.at.slice(5, 7)));
    assert.strictEqual(months.size, 12, 'every month of the year is represented');
    const ledger = await loadLedger(corpusAt(corpus, SIZES[0]).memories);
    assert.strictEqual((await ledger.listMemories()).length, SIZES[0]);
  });

  it('names a tag in most questions and no tag in a quarter of them, and no phrase carries a tag word', () => {
    const tags = new Set(corpus.tags);
    const untagged = corpus.questions.filter((q) => questionTags(q.text, tags).length === 0).length;
    assert.ok(untagged >= corpus.questions.length * 0.1 && untagged <= corpus.questions.length * 0.4,
      `${untagged} of ${corpus.questions.length} questions name no tag`);
    // a tagless question is tagless because its SUBJECT carries no tag
    // word — the generator's own assertion, checked from the outside
    for (const question of corpus.questions) {
      const found = questionTags(question.text, tags);
      if (question.text.startsWith('About ') || question.text.startsWith('Which '))
        assert.strictEqual(found[0], question.topic, `${question.id} names its topic first`);
      else
        assert.deepStrictEqual(found, [], `${question.id} was meant to be tagless`);
    }
    assert.deepStrictEqual(questionTags('About deploy and tests: what did we learn about the tag push?', tags),
      ['deploy', 'tests']);
    assert.deepStrictEqual(questionTags('What did we learn about the tag push?', tags), []);
  });
});

describe('the retrieval scorer', () => {
  it('scores the oracle at 1.000 everywhere and the random draw on its analytic floor, at 1 000 memories', async () => {
    const corpus = loadCorpus();
    // runSize runs the gate itself; a throw here is the finding
    const result = await runSize(corpus, SIZES[0]);
    const at = (key) => result.policies.find((p) => p.key === key);
    for (const k of KS) assert.strictEqual(at('oracle').recall[k], 1);
    assert.strictEqual(at('oracle').mrr, 1);
    for (const k of KS) {
      const band = randomBand(result.questions, result.n, k);
      assert.ok(at('random').recall[k] >= band.low && at('random').recall[k] <= band.high);
      assert.ok(Math.abs(band.floor - randomFloor(result.questions, result.n, k)) < 1e-12);
    }
    // the incumbent finds more than chance — the number itself is the
    // benchmark's to publish, so only the direction is pinned here
    assert.ok(at('tag+recency').recall[10] > 2 * result.floor[10],
      'tag match should beat a random draw at k=10');
    for (const policy of result.policies) {
      assert.ok(policy.recall[1] <= policy.recall[5] && policy.recall[5] <= policy.recall[10],
        `${policy.key}: recall must not fall as k grows`);
      assert.ok(policy.mrr <= policy.recall[10] + 1e-12, `${policy.key}: MRR is bounded by recall@10`);
      assert.ok(policy.latencyMs >= 0 && policy.latencyP95Ms >= policy.latencyMs);
    }
  });

  it('refuses a broken oracle and an off-floor random row, naming the row', () => {
    const questions = Array.from({ length: 50 }, (_, i) => ({ gold: [`m${i}`] }));
    const ok = (recall) => ({ recall: Object.fromEntries(KS.map((k) => [k, recall])), mrr: recall });
    const result = (oracle, random) => ({ n: 1000, questions,
      policies: [{ key: 'oracle', ...oracle }, { key: 'random', ...random }] });
    assert.doesNotThrow(() => assertScorer(result(ok(1), ok(0))));
    assert.throws(() => assertScorer(result({ ...ok(1), recall: { 1: 1, 5: 0.98, 10: 1 } }, ok(0))),
      /oracle recall@5 is 0.98/);
    assert.throws(() => assertScorer(result({ ...ok(1), mrr: 0.99 }, ok(0))), /oracle MRR is 0.99/);
    assert.throws(() => assertScorer(result(ok(1), ok(0.5))), /random recall@1 is 0.5000 at n=1000, outside/);
    assert.throws(() => assertScorer({ n: 1000, questions, policies: [{ key: 'oracle', ...ok(1) }] }),
      /both must run/);
  });
});
