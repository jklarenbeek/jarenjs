//@ts-check
/**
 * @file Recall by meaning: a ledger record carries an embedding with its
 * identity, `recall({ near })` ranks through the injected embedder seam,
 * refuses without it, refuses a mixture of identities, and reports what
 * it skipped; `embedMissing()` is the explicit sweep, and auto-embedding
 * on write is off unless asked for.
 *
 * The refusals get as much attention as the ranking. A fabricated score
 * for an un-embedded record poisons a ranking, a silent subset over mixed
 * models is plausible garbage, and a write that quietly acquires a
 * network dependency is a surprise bill — each of those is a test here,
 * seen red before the code that prevents it existed.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { createLedger, createHashEmbedder, sameIdentity, describeIdentity, AiError } from '@jarenjs/ai';
import { sameIdentity as sameIdentitySubpath } from '@jarenjs/ai/ledger';
import { MEMORY_SCHEMA, SKILL_SCHEMA } from '@jarenjs/ai/schemas/ledger';
import { compileJsonQuery } from '@jarenjs/json/query';

/** A deterministic clock: every record's `at` is decided by the test. */
function clock(start = 0) {
  let tick = start;
  return () => new Date(Date.UTC(2026, 7, 25, 0, 0, tick++)).toISOString();
}

/** The reference embedder at a small width — identity `hash-trigram-16`. */
const hash16 = () => createHashEmbedder({ dims: 16 });

/** A record's embedding as the ledger stores it, from the seam's Float32Array. */
async function embeddingOf(embedder, text) {
  const [vector] = await embedder.embed([text]);
  return { embedding: Array.from(vector), embeddedBy: { model: embedder.model, dims: vector.length } };
}

/**
 * An embedder that counts its calls and remembers every text it was
 * handed, over the reference embedder — so a test can assert "the seam
 * was not called" rather than infer it.
 */
function counting(inner = hash16()) {
  /** @type {string[][]} */
  const batches = [];
  return {
    model: inner.model,
    dims: inner.dims,
    batches,
    embed: (texts, options) => {
      batches.push([...texts]);
      return inner.embed(texts, options);
    },
  };
}

/** A host embedder that throws SYNCHRONOUSLY — the seam contract says reject, a host may not know. */
const syncThrower = () => ({
  model: 'thrower', dims: 4,
  embed: () => { throw new Error('sync boom'); },
});

/** A host embedder that rejects. */
const rejecter = () => ({
  model: 'rejecter', dims: 4,
  embed: async () => { throw new Error('async boom'); },
});

/** A complete memory input — `at` given, so `validate()` over the input and the write agree. */
const memory = (id, text, extra = {}) => ({ id, text, evidence: 'a source', tags: [], at: '2026-08-25T00:00:00.000Z', ...extra });

describe('ai ledger — a record carries its embedding with its identity', function () {
  it('a memory and a skill with embedding + embeddedBy round-trip as plain arrays', async function () {
    const ledger = createLedger({ now: clock() });
    const embedder = hash16();
    const stored = await ledger.addMemory(memory('m1', 'the deploy needs a checkpoint',
      await embeddingOf(embedder, 'the deploy needs a checkpoint')));
    assert.strictEqual(stored.id, 'm1');
    assert.ok(Array.isArray(stored.embedding) && stored.embedding.length === 16, 'stored as number[]');
    assert.deepStrictEqual(stored.embeddedBy, { model: 'hash-trigram-16', dims: 16 });
    assert.deepStrictEqual(await ledger.getMemory('m1'), stored, 'what was returned is what was stored');

    const skill = await ledger.addSkill({ id: 's1', name: 'checkpoint', when: 'before a deploy',
      instructions: 'run one', ...(await embeddingOf(embedder, 'checkpoint')) });
    assert.strictEqual(skill.id, 's1');
    assert.deepStrictEqual(skill.embeddedBy, { model: 'hash-trigram-16', dims: 16 });
    assert.deepStrictEqual(await ledger.getSkill('s1'), skill);

    // an un-embedded record stays exactly as valid as before
    const plain = await ledger.addMemory(memory('m2', 'plain'));
    assert.strictEqual(plain.id, 'm2');
    assert.strictEqual(plain.embedding, undefined);
  });

  it('refuses one of the pair without the other, in the standard shape', async function () {
    const ledger = createLedger({ now: clock() });
    const lone = memory('m-lone', 'a fact', { embedding: [0.1, 0.2] });
    const rejected = await ledger.addMemory(lone);
    assert.match(rejected.error, /invalid input for memory/);
    assert.ok(Array.isArray(rejected.errors) && rejected.errors.length > 0);
    assert.strictEqual(rejected.inputSchema, MEMORY_SCHEMA);
    assert.deepStrictEqual(rejected, ledger.validate('memory', lone), 'the write answers what the gate answers');
    assert.strictEqual(await ledger.getMemory('m-lone'), null, 'nothing was stored');

    const identityOnly = await ledger.addMemory(memory('m-id', 'a fact', { embeddedBy: { model: 'x', dims: 2 } }));
    assert.match(identityOnly.error, /invalid input for memory/);
    assert.strictEqual(await ledger.getMemory('m-id'), null);

    const skill = await ledger.addSkill({ id: 's-lone', name: 'n', when: 'w', instructions: 'i', embedding: [1] });
    assert.match(skill.error, /invalid input for skill/);
    assert.strictEqual(skill.inputSchema, SKILL_SCHEMA);
    assert.strictEqual(await ledger.getSkill('s-lone'), null);
  });

  it('refuses a vector that disagrees with its identity, or is not a vector at all', async function () {
    const ledger = createLedger({ now: clock() });
    const cases = [
      ['wrong dims', { embedding: [0.1, 0.2, 0.3], embeddedBy: { model: 'm', dims: 2 } }],
      ['non-finite component', { embedding: [0.1, NaN], embeddedBy: { model: 'm', dims: 2 } }],
      ['empty vector', { embedding: [], embeddedBy: { model: 'm', dims: 0 } }],
      ['a typed array is not the stored form', { embedding: new Float32Array([0.1, 0.2]), embeddedBy: { model: 'm', dims: 2 } }],
      ['a string component', { embedding: [0.1, 'x'], embeddedBy: { model: 'm', dims: 2 } }],
      ['dims that is not an integer', { embedding: [0.1, 0.2], embeddedBy: { model: 'm', dims: 2.5 } }],
      ['an empty model name', { embedding: [0.1, 0.2], embeddedBy: { model: '', dims: 2 } }],
      ['an identity with an extra member', { embedding: [0.1, 0.2], embeddedBy: { model: 'm', dims: 2, extra: 1 } }],
    ];
    for (const [label, extra] of cases) {
      const input = memory(`m-${label}`, 'a fact', extra);
      const rejected = await ledger.addMemory(input);
      assert.match(rejected.error ?? '', /invalid input for memory/, `${label} must be refused`);
      assert.ok(Array.isArray(rejected.errors) && rejected.errors.length > 0, `${label} says why`);
      for (const error of rejected.errors) {
        assert.strictEqual(typeof error.instancePath, 'string');
        assert.strictEqual(typeof error.keyword, 'string');
        assert.strictEqual(typeof error.message, 'string');
      }
      assert.deepStrictEqual(rejected, ledger.validate('memory', input), `${label}: gate and write agree`);
      assert.strictEqual(await ledger.getMemory(`m-${label}`), null, `${label}: nothing stored`);
    }
  });

  it('keeps the vector arithmetic out of ledger.js', function () {
    // D2: one home for every dot, cosine and norm — the ledger ranks by
    // calling the kernel, never by computing one
    const source = readFileSync(new URL('../../packages/ai/src/ledger.js', import.meta.url), 'utf8');
    assert.match(source, /from '@jarenjs\/core\/vector'/, 'the ledger imports the kernels');
    assert.doesNotMatch(source, /Math\.(sqrt|hypot)/, 'no norm is computed here');
    assert.doesNotMatch(source, /\[i\]\s*\*\s*\w+\[i\]/, 'no dot product is computed here');
  });
});

describe('ai ledger — recall({ near }) refuses before it ranks', function () {
  it('without the seam it names the seam, and plain recall still works', async function () {
    const ledger = createLedger({ now: clock() });
    await ledger.addMemory(memory('m1', 'a fact', { tags: ['t'] }));
    const refused = await ledger.recall({ near: 'a fact' });
    assert.match(refused.error, /^recall: near needs the embedder seam/);
    assert.match(refused.error, /createEmbeddingClient/, 'and says what to inject');
    assert.match(refused.error, /\{ embed, model, dims \}/, 'or any host implementation of it');
    assert.deepStrictEqual((await ledger.recall({ tags: ['t'] })).map((m) => m.id), ['m1'],
      'the tag path is untouched by the missing seam');
    const skills = await ledger.recallSkills({ near: 'anything' });
    assert.match(skills.error, /near needs the embedder seam/);
  });

  it('refuses a `near` that is not a non-empty string', async function () {
    const ledger = createLedger({ now: clock(), embedder: hash16() });
    for (const near of ['', 42, null, ['a']]) {
      const refused = await ledger.recall({ near });
      assert.match(refused.error, /^recall: near must be a non-empty string/, JSON.stringify(near));
    }
  });

  it('refuses a mixture of identities naming the models found, never ranking a subset', async function () {
    const ledger = createLedger({ now: clock(), embedder: hash16() });
    const wide = createHashEmbedder({ dims: 32 });
    await ledger.addMemory(memory('narrow', 'alpha beta', await embeddingOf(hash16(), 'alpha beta')));
    await ledger.addMemory(memory('wide', 'alpha beta', await embeddingOf(wide, 'alpha beta')));
    const mixed = await ledger.recall({ near: 'alpha beta' });
    assert.match(mixed.error, /^recall: near cannot rank across embedders/);
    assert.match(mixed.error, /hash-trigram-16/, 'names the first identity');
    assert.match(mixed.error, /hash-trigram-32/, 'names the second identity');
    assert.strictEqual(mixed.memories, undefined, 'and answers no subset');

    // a clean ledger under one identity, queried through another, is
    // the same refusal: the query embedder disagrees with the store
    const clean = createLedger({ now: clock(), embedder: hash16() });
    await clean.addMemory(memory('wide', 'alpha beta', await embeddingOf(wide, 'alpha beta')));
    const disagree = await clean.recall({ near: 'alpha beta' });
    assert.match(disagree.error, /cannot rank across embedders/);
    assert.match(disagree.error, /hash-trigram-32/);
    assert.match(disagree.error, /hash-trigram-16/, 'the query embedder is named too');

    // a filter that excludes the foreign record makes the rest rankable
    const narrowed = await ledger.recall({ near: 'alpha beta', tags: ['none'] });
    assert.deepStrictEqual(narrowed, { memories: [], scores: [], skipped: 0, via: 'sweep',
      ranking: { algorithm: 'exact-cosine', exhaustive: true, candidateCount: 0 } },
      'nothing passes the filter, so nothing mixes');
  });

  it('a `where` predicate still needs the compileQuery seam, with or without near', async function () {
    const ledger = createLedger({ now: clock(), embedder: hash16() });
    await ledger.addMemory(memory('m1', 'a fact', await embeddingOf(hash16(), 'a fact')));
    const refused = await ledger.recall({ near: 'a fact', where: { $contains: ['$it.text', 'fact'] } });
    assert.match(refused.error, /compileQuery seam/);
    const wired = createLedger({ now: clock(), embedder: hash16(), compileQuery: compileJsonQuery });
    await wired.addMemory(memory('m1', 'a fact', await embeddingOf(hash16(), 'a fact')));
    await wired.addMemory(memory('m2', 'another', await embeddingOf(hash16(), 'another')));
    const hits = await wired.recall({ near: 'a fact', where: { $contains: ['$it.text', 'fact'] } });
    assert.deepStrictEqual(hits.memories.map((m) => m.id), ['m1'], 'the predicate narrows the candidates');
  });

  it('a seam that throws or rejects at query time is content, never a crash', async function () {
    for (const embedder of [syncThrower(), rejecter()]) {
      const ledger = createLedger({ now: clock(), embedder });
      await ledger.addMemory(memory('m1', 'a fact'));
      const failed = await ledger.recall({ near: 'a fact' });
      assert.match(failed.error, /^recall: the embedder seam failed — .*boom/, embedder.model);
    }
    // a host seam that answers something other than one vector per input
    const liar = { model: 'liar', dims: 2, embed: async () => [] };
    const ledger = createLedger({ now: clock(), embedder: liar });
    const failed = await ledger.recall({ near: 'a fact' });
    assert.match(failed.error, /^recall: the embedder seam failed/);
  });
});

describe('ai ledger — recall({ near }) ranks, breaks ties, and reports what it skipped', function () {
  /** Five memories: three embedded, two not; two carry the tag. */
  async function seeded(extra = {}) {
    const embedder = hash16();
    const ledger = createLedger({ now: clock(), embedder, ...extra });
    const texts = {
      exact: 'alpha beta gamma delta',
      close: 'alpha beta gamma zeta',
      far: 'quarterly revenue by region',
    };
    await ledger.addMemory(memory('far', texts.far, { tags: ['money'], ...(await embeddingOf(embedder, texts.far)) }));
    await ledger.addMemory(memory('close', texts.close, { tags: ['greek'], ...(await embeddingOf(embedder, texts.close)) }));
    await ledger.addMemory(memory('exact', texts.exact, { tags: ['greek'], ...(await embeddingOf(embedder, texts.exact)) }));
    await ledger.addMemory(memory('bare-1', 'alpha beta gamma delta', { tags: ['greek'] }));
    await ledger.addMemory(memory('bare-2', 'no vector here'));
    return ledger;
  }

  it('ranks by cosine similarity, descending, and counts the un-embedded as skipped', async function () {
    const ledger = await seeded();
    const result = await ledger.recall({ near: 'alpha beta gamma delta' });
    assert.deepStrictEqual(result.memories.map((m) => m.id), ['exact', 'close', 'far']);
    assert.strictEqual(result.scores.length, 3, 'one score per memory, in the same order');
    assert.ok(result.scores[0] > 0.999 && result.scores[0] <= 1, `the exact text scores 1: ${result.scores[0]}`);
    assert.ok(result.scores[0] >= result.scores[1] && result.scores[1] >= result.scores[2], 'descending');
    assert.strictEqual(result.skipped, 2, 'bare-1 and bare-2 passed the filter and carry no vector');
    // the records are the stored records, embedding included
    assert.ok(Array.isArray(result.memories[0].embedding));
  });

  it('composes with the tag filter, and `skipped` counts only what passed the filter', async function () {
    const ledger = await seeded();
    const result = await ledger.recall({ near: 'alpha beta gamma delta', tags: ['greek'] });
    assert.deepStrictEqual(result.memories.map((m) => m.id), ['exact', 'close']);
    assert.strictEqual(result.skipped, 1, 'bare-1 is tagged greek and un-embedded; bare-2 never passed the filter');
    const none = await ledger.recall({ near: 'anything', tags: ['absent'] });
    assert.deepStrictEqual(none, { memories: [], scores: [], skipped: 0, via: 'sweep',
      ranking: { algorithm: 'exact-cosine', exhaustive: true, candidateCount: 0 } });
  });

  it('`limit` caps after ranking and `minScore` filters after ranking', async function () {
    const ledger = await seeded();
    const top = await ledger.recall({ near: 'alpha beta gamma delta', limit: 1 });
    assert.deepStrictEqual(top.memories.map((m) => m.id), ['exact']);
    assert.strictEqual(top.scores.length, 1);
    assert.strictEqual(top.skipped, 2, 'the limit does not change what was skipped');

    const all = await ledger.recall({ near: 'alpha beta gamma delta' });
    const threshold = all.scores[1]; // keep the top two exactly
    const kept = await ledger.recall({ near: 'alpha beta gamma delta', minScore: threshold });
    assert.deepStrictEqual(kept.memories.map((m) => m.id), ['exact', 'close']);
    const nothing = await ledger.recall({ near: 'alpha beta gamma delta', minScore: 1.01 });
    assert.deepStrictEqual(nothing.memories, []);
    assert.strictEqual(nothing.skipped, 2);
    // limit applies to what survives minScore
    const one = await ledger.recall({ near: 'alpha beta gamma delta', minScore: threshold, limit: 1 });
    assert.deepStrictEqual(one.memories.map((m) => m.id), ['exact']);
  });

  it('breaks a tie by recency, then by id — deterministically', async function () {
    const embedder = hash16();
    const ledger = createLedger({ now: clock(), embedder });
    const same = await embeddingOf(embedder, 'identical text');
    const at = (tick) => new Date(Date.UTC(2026, 7, 25, 0, 0, tick)).toISOString();
    await ledger.addMemory(memory('z-old', 'identical text', { at: at(1), ...same }));
    await ledger.addMemory(memory('a-old', 'identical text', { at: at(1), ...same }));
    await ledger.addMemory(memory('m-new', 'identical text', { at: at(2), ...same }));
    const first = await ledger.recall({ near: 'identical text' });
    assert.deepStrictEqual(first.memories.map((m) => m.id), ['m-new', 'a-old', 'z-old'],
      'equal scores: newest first, then id ascending');
    assert.ok(first.scores.every((s) => s === first.scores[0]), 'the scores really are equal');
    const second = await ledger.recall({ near: 'identical text' });
    assert.deepStrictEqual(second.memories.map((m) => m.id), first.memories.map((m) => m.id));
  });

  it('recallSkills ranks the same way over skills', async function () {
    const embedder = hash16();
    const ledger = createLedger({ now: clock(), embedder });
    const skill = async (id, name, when, instructions) => ledger.addSkill({
      id, name, when, instructions, ...(await embeddingOf(embedder, `${name}\n${when}\n${instructions}`)),
    });
    await skill('deploy', 'checkpoint', 'before a deploy', 'run a WAL checkpoint');
    await skill('measure', 'measure', 'before a claim', 'run the benchmark');
    await ledger.addSkill({ id: 'bare', name: 'bare', when: 'w', instructions: 'i' });
    const result = await ledger.recallSkills({ near: 'checkpoint\nbefore a deploy\nrun a WAL checkpoint' });
    assert.deepStrictEqual(result.skills.map((s) => s.id), ['deploy', 'measure']);
    assert.strictEqual(result.scores.length, 2);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.memories, undefined, 'skills answer as skills');
  });

  it('without `near` the answer is the array it always was', async function () {
    const ledger = await seeded();
    const plain = await ledger.recall({ tags: ['greek'] });
    assert.ok(Array.isArray(plain));
    assert.deepStrictEqual(plain.map((m) => m.id), ['bare-1', 'close', 'exact'],
      'recency, then id — the seed shares one timestamp, so by id, as before');
  });
});

describe('ai ledger — embedMissing is the explicit sweep', function () {
  async function unembedded(ledger, n = 5) {
    for (let i = 1; i <= n; i++) await ledger.addMemory(memory(`m${i}`, `fact number ${i}`));
    await ledger.addSkill({ id: 's1', name: 'first', when: 'w1', instructions: 'i1' });
    await ledger.addSkill({ id: 's2', name: 'second', when: 'w2', instructions: 'i2' });
  }

  it('embeds every un-embedded memory and skill, and a second run embeds zero', async function () {
    const embedder = counting();
    const ledger = createLedger({ now: clock(), embedder });
    await unembedded(ledger);
    await ledger.addMemory(memory('already', 'already embedded', await embeddingOf(hash16(), 'already embedded')));

    const first = await ledger.embedMissing();
    assert.deepStrictEqual(first, { embedded: 7, remaining: 0 });
    const calls = embedder.batches.length;
    assert.ok(calls >= 1, 'the seam was called');
    for (const id of ['m1', 'm3', 'm5']) {
      const record = await ledger.getMemory(id);
      assert.ok(Array.isArray(record.embedding) && record.embedding.length === 16, `${id} carries a plain number[]`);
      assert.deepStrictEqual(record.embeddedBy, { model: 'hash-trigram-16', dims: 16 });
      assert.strictEqual(record.text, `fact number ${id.slice(1)}`, 'and is otherwise untouched');
    }
    const skill = await ledger.getSkill('s2');
    assert.deepStrictEqual(skill.embeddedBy, { model: 'hash-trigram-16', dims: 16 });
    // the skill's text is name, when and instructions — what "near" a
    // skill means — and the stored vector is exactly the seam's answer
    const [expected] = await hash16().embed(['second\nw2\ni2']);
    assert.deepStrictEqual(skill.embedding, Array.from(expected));

    // the two-run check: nothing left, and the seam is not even asked
    const second = await ledger.embedMissing();
    assert.deepStrictEqual(second, { embedded: 0, remaining: 0 });
    assert.strictEqual(embedder.batches.length, calls, 'a second run makes no seam call');
    // and ranked recall now skips nothing
    const ranked = await ledger.recall({ near: 'fact number 3' });
    assert.strictEqual(ranked.skipped, 0);
    assert.strictEqual(ranked.memories[0].id, 'm3');
  });

  it('batches through embed(texts[]) and honours `limit`', async function () {
    const embedder = counting();
    const ledger = createLedger({ now: clock(), embedder });
    await unembedded(ledger); // 5 memories + 2 skills
    const capped = await ledger.embedMissing({ limit: 3, batch: 2 });
    assert.deepStrictEqual(capped, { embedded: 3, remaining: 4 });
    assert.deepStrictEqual(embedder.batches.map((b) => b.length), [2, 1], 'two batches for three records');
    const rest = await ledger.embedMissing({ batch: 3 });
    assert.deepStrictEqual(rest, { embedded: 4, remaining: 0 });
    assert.deepStrictEqual(embedder.batches.map((b) => b.length), [2, 1, 3, 1]);
  });

  it('floors a positive fractional batch to at least one and makes no calls on the second sweep', async function () {
    const embedder = counting({
      model: 'fractional-batch', dims: 2,
      embed: async (texts) => {
        assert.ok(texts.length > 0, 'a batch must make progress');
        return texts.map(() => new Float32Array([1, 0]));
      },
    });
    const ledger = createLedger({ now: clock(), embedder });
    await ledger.addMemory(memory('m1', 'first fact'));
    await ledger.addMemory(memory('m2', 'second fact'));
    assert.deepStrictEqual(await ledger.embedMissing({ batch: 0.5 }), { embedded: 2, remaining: 0 });
    assert.deepStrictEqual(embedder.batches, [['first fact'], ['second fact']]);
    assert.deepStrictEqual((await ledger.getMemory('m1')).embedding, [1, 0]);
    assert.deepStrictEqual((await ledger.getMemory('m2')).embedding, [1, 0]);
    assert.deepStrictEqual(await ledger.embedMissing({ batch: 0.5 }), { embedded: 0, remaining: 0 });
    assert.strictEqual(embedder.batches.length, 2);
  });

  it('a failing batch leaves its records un-embedded, counted in `remaining`, with the error surfaced once', async function () {
    const inner = hash16();
    let calls = 0;
    const flaky = {
      model: inner.model, dims: inner.dims,
      embed: async (texts) => {
        calls += 1;
        if (calls === 2) throw new AiError('AI0002', 'HTTP 503 from the provider');
        return inner.embed(texts);
      },
    };
    const ledger = createLedger({ now: clock(), embedder: flaky });
    await unembedded(ledger);
    const result = await ledger.embedMissing({ batch: 2 });
    assert.strictEqual(result.embedded, 2, 'the first batch was written');
    assert.strictEqual(result.remaining, 5, 'the failed batch and everything after it stay un-embedded');
    assert.match(result.error, /HTTP 503/);
    assert.ok(Array.isArray((await ledger.getMemory('m1')).embedding));
    assert.strictEqual((await ledger.getMemory('m3')).embedding, undefined);
    assert.strictEqual((await ledger.getMemory('m5')).embedding, undefined);
    // the next run picks up where the failure left off
    const again = await ledger.embedMissing({ batch: 10 });
    assert.deepStrictEqual(again, { embedded: 5, remaining: 0 });
  });

  it('a seam that throws synchronously loses nothing either', async function () {
    const ledger = createLedger({ now: clock(), embedder: syncThrower() });
    await unembedded(ledger, 2);
    const result = await ledger.embedMissing();
    assert.strictEqual(result.embedded, 0);
    assert.strictEqual(result.remaining, 4);
    assert.match(result.error, /sync boom/);
    assert.strictEqual((await ledger.listMemories()).length, 2, 'every record is still there');
  });

  it('refuses to create a mixture of identities', async function () {
    const ledger = createLedger({ now: clock(), embedder: hash16() });
    const wide = createHashEmbedder({ dims: 32 });
    await ledger.addMemory(memory('wide', 'embedded elsewhere', await embeddingOf(wide, 'embedded elsewhere')));
    await unembedded(ledger, 2);
    const result = await ledger.embedMissing();
    assert.strictEqual(result.embedded, 0);
    assert.strictEqual(result.remaining, 4);
    assert.match(result.error, /^embedMissing: .*hash-trigram-32/, 'names what the ledger already holds');
    assert.match(result.error, /hash-trigram-16/, 'and the embedder that would have mixed with it');
    assert.strictEqual((await ledger.getMemory('m1')).embedding, undefined, 'nothing was written');
  });

  it('without the seam it refuses the same way recall does', async function () {
    const ledger = createLedger({ now: clock() });
    await unembedded(ledger, 1);
    const result = await ledger.embedMissing();
    assert.match(result.error, /^embedMissing: .*needs the embedder seam/);
    assert.deepStrictEqual([result.embedded, result.remaining], [0, 3]);
  });
});

describe('ai ledger — auto-embedding on write is opt-in', function () {
  it('is off by default: a write with a seam and no flag stays un-embedded and succeeds', async function () {
    const embedder = counting();
    const ledger = createLedger({ now: clock(), embedder });
    const stored = await ledger.addMemory(memory('m1', 'a fact'));
    assert.strictEqual(stored.id, 'm1');
    assert.strictEqual(stored.embedding, undefined);
    assert.strictEqual(embedder.batches.length, 0, 'the seam was not called by a write');
    const ranked = await ledger.recall({ near: 'a fact' });
    assert.deepStrictEqual(ranked, { memories: [], scores: [], skipped: 1, via: 'sweep',
      ranking: { algorithm: 'exact-cosine', exhaustive: true, candidateCount: 0 } },
      'and ranked recall says so — over an adapter with no rank capability, by sweeping');
  });

  it('on, a write acquires its embedding inside the write, and keeps one it was handed', async function () {
    const embedder = counting();
    const ledger = createLedger({ now: clock(), embedder, embedOnWrite: true });
    const stored = await ledger.addMemory(memory('m1', 'a fact'));
    assert.ok(Array.isArray(stored.embedding) && stored.embedding.length === 16);
    assert.deepStrictEqual(stored.embeddedBy, { model: 'hash-trigram-16', dims: 16 });
    assert.deepStrictEqual(await ledger.getMemory('m1'), stored);
    assert.deepStrictEqual(embedder.batches, [['a fact']]);

    const skill = await ledger.addSkill({ id: 's1', name: 'n', when: 'w', instructions: 'i' });
    assert.deepStrictEqual(skill.embeddedBy, { model: 'hash-trigram-16', dims: 16 });
    assert.deepStrictEqual(embedder.batches[1], ['n\nw\ni']);

    const own = await embeddingOf(hash16(), 'something else');
    const handed = await ledger.addMemory(memory('m2', 'a fact', own));
    assert.deepStrictEqual(handed.embedding, own.embedding, 'a vector the caller supplied is kept');
    assert.strictEqual(embedder.batches.length, 2, 'and the seam is not asked again');

    // a rejected write never reaches the seam
    const rejected = await ledger.addMemory({ text: 'no evidence' });
    assert.match(rejected.error, /invalid input/);
    assert.strictEqual(embedder.batches.length, 2);
  });

  it('on, a seam failure stores the record un-embedded and says so — never a lost write', async function () {
    for (const embedder of [rejecter(), syncThrower()]) {
      const ledger = createLedger({ now: clock(), embedder, embedOnWrite: true });
      const stored = await ledger.addMemory(memory('m1', 'a fact'));
      assert.strictEqual(stored.id, 'm1', 'the write succeeded');
      assert.strictEqual(stored.error, undefined, 'and is not a rejection');
      assert.match(stored.embedError, /boom/, 'the seam failure is reported on the result');
      const read = await ledger.getMemory('m1');
      assert.strictEqual(read.embedding, undefined, 'stored un-embedded');
      assert.strictEqual(read.embedError, undefined, 'the report is not part of the record');
      const { embedError: _reported, ...record } = stored;
      assert.deepStrictEqual(read, record, 'everything else is exactly what was returned');
      // the sweep closes the gap later, once the seam is back
      const ranked = await ledger.recall({ near: 'a fact' });
      assert.match(ranked.error, /embedder seam failed/);
    }
  });

  it('refuses a contradictory or malformed configuration at construction', function () {
    assert.throws(() => createLedger({ embedOnWrite: true }), (err) =>
      err instanceof AiError && err.code === 'AI0001' && /embedOnWrite needs the embedder seam/.test(err.message));
    assert.throws(() => createLedger({ embedder: { model: 'x' } }), (err) =>
      err instanceof AiError && err.code === 'AI0001' && /embedder/.test(err.message));
    assert.throws(() => createLedger({ embedder: { embed: async () => [] } }), (err) =>
      err instanceof AiError && err.code === 'AI0001' && /model/.test(err.message));
  });
});

describe('ai ledger — the identity rule is published, not private', function () {
  // a rank adapter selects the records whose embeddedBy is the query's,
  // and a host with its own vector store refuses the same mixtures — so
  // the predicate the ledger applies has to be reachable, or each of
  // them re-derives it and one of them gets an edge wrong
  it('is one space only when the model and the width both agree', function () {
    assert.strictEqual(sameIdentity({ model: 'm', dims: 4 }, { model: 'm', dims: 4 }), true);
    assert.strictEqual(sameIdentity({ model: 'm', dims: 4 }, { model: 'm', dims: 8 }), false,
      'a re-embed at another width is another space');
    assert.strictEqual(sameIdentity({ model: 'a', dims: 4 }, { model: 'b', dims: 4 }), false,
      'one width, two models — arithmetic without meaning');
  });

  it('refuses to call two absent identities the same', function () {
    // the edge a re-derivation misses: an un-embedded record has no
    // space to share, so "unknown" must not rank against "unknown"
    assert.strictEqual(sameIdentity(undefined, undefined), false);
    assert.strictEqual(sameIdentity(null, null), false);
    assert.strictEqual(sameIdentity(undefined, { model: 'm', dims: 4 }), false);
    assert.strictEqual(sameIdentity({ model: 'm', dims: 4 }, undefined), false);
  });

  it('names an identity the way a refusal does', async function () {
    assert.strictEqual(describeIdentity({ model: 'hash-trigram-16', dims: 16 }),
      'hash-trigram-16 (16 dims)');

    // the same string the ledger puts in front of a reader, so a host
    // reporting the mixture reports it in the ledger's words
    const ledger = createLedger({ now: clock(), embedder: hash16() });
    const wide = createHashEmbedder({ dims: 32 });
    await ledger.addMemory(memory('narrow', 'alpha beta', await embeddingOf(hash16(), 'alpha beta')));
    await ledger.addMemory(memory('wide', 'alpha beta', await embeddingOf(wide, 'alpha beta')));
    const mixed = await ledger.recall({ near: 'alpha beta' });
    assert.ok(mixed.error.includes(describeIdentity({ model: 'hash-trigram-32', dims: 32 })));
  });

  it('reaches a consumer through the package and the subpath alike', function () {
    assert.strictEqual(sameIdentitySubpath, sameIdentity);
  });
});
