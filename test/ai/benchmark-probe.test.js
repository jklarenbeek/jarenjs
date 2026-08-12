//@ts-check
/**
 * @file The long-horizon benchmark's measuring instrument, tested.
 *
 * `benchmark/long-horizon.js` publishes the number a whole campaign is
 * judged against, and its probe is model-free — which means nothing about
 * a wrong answer looks wrong. Two probe bugs were hit while taking the
 * baseline and BOTH read as findings rather than as faults:
 *
 *   - searching `JSON.stringify(messages)` for `"value":123` finds nothing,
 *     because a tool result is a JSON string inside its message and the
 *     stringified transcript double-escapes it;
 *   - a proximity regex (`ID[^]{0,40}value:N`) finds nothing either, once
 *     the fact sits behind ~400 characters of padding.
 *
 * Each reads 0/40 on every row INCLUDING the uncapped control, which is
 * exactly what a working probe can never do. So the control is the
 * self-test: with no history budget at all, every fact must be found, in
 * both payload shapes. A silently broken probe would let any later change
 * claim any number it liked.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULTS, makeCorpus, probe, retention, ceilingFor, needleTargets, pairSurvived,
  needleQuestion, pairwiseQuestion, scoreNeedle, scorePairwise,
} from '../../benchmark/lib/horizon.js';
import { readAiEnv, describeAiEnv, mapLimit, AI_ENV } from '../../benchmark/lib/env.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHAPES = /** @type {const} */ (['front', 'late']);

describe('ai benchmark — the corpus', function () {
  it('is deterministic, globally unique and uniformly sized', async function () {
    const corpus = makeCorpus({});
    const twin = makeCorpus({});
    assert.deepStrictEqual(corpus.values, twin.values, 'the seed decides the corpus');
    assert.strictEqual(new Set(corpus.values).size, corpus.n,
      'values must be globally unique — presence is tested without a proximity window');
    assert.strictEqual(new Set(corpus.ids).size, corpus.n);
    for (const value of corpus.values) {
      // six digits, so a record serializes to the same byte length whatever
      // the seed: compaction cuts at byte-counted boundaries, and a corpus
      // whose sizes moved with the seed would make two runs incomparable
      assert.ok(value >= 100000 && value <= 999999, `${value} is not a six-digit value`);
    }
  });

  it('has exactly one closest pair, so the pairwise question has one answer', function () {
    const corpus = makeCorpus({});
    const { a, b, gap } = corpus.pair;
    assert.strictEqual(Math.abs(corpus.values[a] - corpus.values[b]), gap);
    let achieved = 0;
    for (let i = 0; i < corpus.n; i++) {
      for (let j = i + 1; j < corpus.n; j++) {
        const distance = Math.abs(corpus.values[i] - corpus.values[j]);
        assert.ok(distance >= gap, 'a closer pair exists than the one recorded');
        if (distance === gap) achieved++;
      }
    }
    assert.strictEqual(achieved, 1, 'a tied closest pair would have two right answers');
  });

  it('samples needle targets uniformly and without replacement', function () {
    const corpus = makeCorpus({});
    const targets = needleTargets(corpus, 5, 6000);
    assert.strictEqual(targets.length, 5);
    assert.strictEqual(new Set(targets).size, 5);
    assert.deepStrictEqual(targets, needleTargets(corpus, 5, 6000), 'seeded, so reproducible');
    assert.notDeepStrictEqual(targets, needleTargets(corpus, 5, 2000),
      'each row draws independently');
  });
});

describe('ai benchmark — the probe self-test', function () {
  it('the uncapped control reads 40/40 values in BOTH payload shapes', async function () {
    const corpus = makeCorpus({});
    for (const shape of SHAPES) {
      const result = await probe({ corpus, budget: undefined, shape });
      assert.strictEqual(result.valuePresent, corpus.n,
        `${shape}: the uncapped control lost a value — the probe is broken, not the agent`);
      assert.strictEqual(result.idPresent, corpus.n, `${shape}: the uncapped control lost an id`);
      assert.strictEqual(result.compacted, false, 'nothing may be dropped with no budget');
    }
  });

  it('the same control also reads 40/40 at a budget larger than the transcript', async function () {
    const corpus = makeCorpus({});
    for (const shape of SHAPES) {
      const result = await probe({ corpus, budget: 40000, shape });
      assert.strictEqual(result.valuePresent, corpus.n);
      assert.strictEqual(result.compacted, false);
    }
  });

  it('a dropped round reads ABSENT — the probe can report a loss', async function () {
    const corpus = makeCorpus({});
    for (const shape of SHAPES) {
      const result = await probe({ corpus, budget: 6000, shape });
      assert.ok(result.compacted, 'budget 6000 must compact 40 rounds');
      assert.ok(result.valuePresent < corpus.n,
        `${shape}: a probe that reports no loss under compaction is not measuring`);
      // the first round is the oldest, so it is the first to be cut: its
      // tool reply is gone from the request whatever the payload shape
      assert.ok(!result.messages.some((m) => m.tool_call_id === 'c0'),
        `${shape}: the oldest round survived a cut that dropped it`);
    }
  });

  it('measures the payload shape as the ~2x difference it is', async function () {
    // The synopsis excerpts the FIRST 60 CHARACTERS of a dropped result.
    // With the fact at the front it rides out inside that excerpt; behind
    // the padding it does not. Reporting only the front shape would
    // flatter the package, so the benchmark runs both and names `late`
    // the realistic one.
    const corpus = makeCorpus({});
    const front = await probe({ corpus, budget: 6000, shape: 'front' });
    const late = await probe({ corpus, budget: 6000, shape: 'late' });
    const has = (result, i) => result.messages
      .map((m) => String(m.content ?? '')).join('\n')
      .includes(`"value":${corpus.values[i]}`);

    assert.ok(has(front, 0), 'the front shape keeps the oldest value inside its 60-char excerpt');
    assert.ok(!has(late, 0), 'behind the padding, the same excerpt carries no value at all');
    assert.ok(front.valuePresent > late.valuePresent,
      `the shapes must differ (front ${front.valuePresent}, late ${late.valuePresent})`);
    // both shapes keep the same TAIL — the whole difference is what the
    // synopsis managed to carry out of the dropped middle
    assert.strictEqual(front.messageCount, late.messageCount);
  });

  it('names the two bugs that read as findings, and fails them on the control', async function () {
    const corpus = makeCorpus({});
    const result = await probe({ corpus, budget: undefined, shape: 'late' });

    // BUG 1 — search the stringified transcript: a tool result is a JSON
    // string inside its message, so the quotes are escaped and nothing
    // matches, on every row including this one
    const stringified = JSON.stringify(result.messages);
    let found = 0;
    for (const value of corpus.values) if (stringified.includes(`"value":${value}`)) found++;
    assert.strictEqual(found, 0,
      'the double-escaping bug no longer reproduces — re-derive what the probe must avoid');

    // BUG 2 — a proximity window: the id and its value are separated by
    // ~400 characters of padding in the realistic shape
    const text = result.messages.map((m) => String(m.content ?? '')).join('\n');
    let windowed = 0;
    for (let i = 0; i < corpus.n; i++) {
      if (new RegExp(`${corpus.ids[i]}[^]{0,40}value":${corpus.values[i]}`).test(text)) windowed++;
    }
    assert.strictEqual(windowed, 0, 'the proximity-window bug no longer reproduces');

    // and the probe as written reads every one of them
    assert.strictEqual(retention(result.messages, corpus).valuePresent, corpus.n);
  });
});

describe('ai benchmark — the two ceilings', function () {
  it('the needle ceiling is the fraction of values that survived', function () {
    assert.strictEqual(ceilingFor('needle', { valuePresent: 7, n: 40 }), 0.175);
    assert.strictEqual(ceilingFor('needle', { valuePresent: 40, n: 40 }), 1);
  });

  it('the pairwise ceiling is 0% at EVERY compacting budget, in both shapes', async function () {
    // the campaign's headline starting number: a question over all N
    // records is unanswerable the instant one round is cut, at any budget
    // below the full transcript. No synopsis writer changes this.
    const corpus = makeCorpus({});
    for (const shape of SHAPES) {
      for (const budget of DEFAULTS.budgets) {
        const result = await probe({ corpus, budget, shape });
        const pairwise = ceilingFor('pairwise', { valuePresent: result.valuePresent, n: corpus.n });
        if (result.compacted) {
          assert.strictEqual(pairwise, 0,
            `${shape} @ ${budget}: a compacting budget scored a non-zero pairwise ceiling`);
        }
        else {
          assert.strictEqual(pairwise, 1,
            `${shape} @ ${budget}: the uncompacted transcript must answer the pairwise task`);
        }
      }
    }
  });

  it('reports whether the closest pair survived, so a lucky answer is legible', async function () {
    // The pairwise ceiling is DETERMINACY, not a hard bound on the score:
    // a model can name the true closest pair out of a subset that happens
    // to contain it. This column is what tells luck from retrieval, and
    // without it a pairwise actual above its own ceiling would look like a
    // broken benchmark instead of the stated thing it is.
    const corpus = makeCorpus({});
    const uncapped = await probe({ corpus, budget: undefined, shape: 'late' });
    assert.strictEqual(uncapped.pairSurvived, true,
      'with nothing dropped the closest pair is always present');
    assert.strictEqual(pairSurvived(uncapped.messages, corpus), true);

    // and it is a genuine measurement, not a constant: at a budget that
    // drops most of the corpus in the realistic shape, the pair is gone
    const tight = await probe({ corpus, budget: 2000, shape: 'late' });
    assert.strictEqual(tight.pairSurvived, false);
    assert.strictEqual(ceilingFor('pairwise',
      { valuePresent: tight.valuePresent, n: corpus.n }), 0);
  });

  it('keeps the ids-versus-values gap that scopes the defect', async function () {
    // compaction preserves that something happened and destroys what it
    // found: the synopsis remembers "called fetch_record" and loses the record
    const corpus = makeCorpus({});
    const result = await probe({ corpus, budget: 6000, shape: 'late' });
    assert.ok(result.idPresent > result.valuePresent,
      'the realistic shape must show more surviving ids than surviving values');
  });
});

describe('ai benchmark — answer scoring', function () {
  const corpus = makeCorpus({});

  it('scores a needle answer that names one value, and only that value', function () {
    assert.ok(scoreNeedle(`The value is ${corpus.values[3]}.`, corpus, 3));
    assert.ok(!scoreNeedle(`The value is ${corpus.values[4]}.`, corpus, 3));
    assert.ok(!scoreNeedle('I do not have that record.', corpus, 3));
    // a reply that dumps the corpus has not answered the question
    assert.ok(!scoreNeedle(corpus.values.join(', '), corpus, 3));
  });

  it('does not match a value inside a longer number', function () {
    assert.ok(!scoreNeedle(`ref ${corpus.values[3]}7`, corpus, 3));
  });

  it('scores a pairwise answer that names exactly the closest pair', function () {
    const { a, b } = corpus.pair;
    assert.ok(scorePairwise(`${corpus.ids[a]} and ${corpus.ids[b]}`, corpus));
    assert.ok(scorePairwise(`${corpus.ids[b]}, ${corpus.ids[a]}`, corpus), 'order does not matter');
    assert.ok(!scorePairwise(`${corpus.ids[a]} alone`, corpus));
    assert.ok(!scorePairwise(corpus.ids.join(' '), corpus));
  });

  it('asks a question that names the record and the relation', function () {
    assert.match(needleQuestion(corpus, 3), new RegExp(corpus.ids[3]));
    assert.match(pairwiseQuestion(), /every pair/);
  });
});

describe('ai benchmark — the live-tier environment seam', function () {
  it('skips with a stated reason when no key is present', function () {
    const config = readAiEnv({});
    assert.strictEqual(config.live, false);
    assert.match(/** @type {string} */ (config.reason), /no key/);
    assert.match(/** @type {string} */ (config.reason), new RegExp(AI_ENV.keys[0]));
  });

  it('goes live on a key plus a model, and on a local runtime with neither', function () {
    const cloud = readAiEnv({ OPENROUTER_AI_KEY: 'sk-test', JAREN_AI_MODEL: 'a/b' });
    assert.strictEqual(cloud.live, true);
    assert.strictEqual(cloud.keySource, 'OPENROUTER_AI_KEY');
    assert.strictEqual(cloud.provider, 'openrouter', 'openrouter is the default provider');
    // the router names OR_KEY; the repository's own .env.example and the
    // website e2e both use OPENROUTER_AI_KEY, so the short name is an alias
    const alias = readAiEnv({ OR_KEY: 'sk-test', JAREN_AI_MODEL: 'a/b' });
    assert.strictEqual(alias.live, true);
    assert.strictEqual(alias.keySource, 'OR_KEY');
    const local = readAiEnv({ JAREN_AI_PROVIDER: 'ollama', JAREN_AI_MODEL: 'qwen' });
    assert.strictEqual(local.live, true, 'a local runtime needs no key');
  });

  it('will not go live without a model, however good the key', function () {
    const config = readAiEnv({ OPENROUTER_AI_KEY: 'sk-test' });
    assert.strictEqual(config.live, false);
    assert.match(/** @type {string} */ (config.reason), /no model/);
  });

  it('reads the spend guards as hard numbers, with defaults and typo tolerance', function () {
    const defaults = readAiEnv({});
    assert.strictEqual(defaults.maxCalls, 200);
    assert.strictEqual(defaults.maxConcurrency, 4);
    assert.strictEqual(defaults.trials, 3);
    const set = readAiEnv({ JAREN_AI_MAX_CALLS: '12', JAREN_AI_TRIALS: 'oops' });
    assert.strictEqual(set.maxCalls, 12);
    assert.strictEqual(set.trials, 3, 'a typo in .env must not take the ceiling tier down');
  });

  it('never puts the key in the line a run may log', function () {
    const line = describeAiEnv(readAiEnv({ OPENROUTER_AI_KEY: 'sk-secret-xyz', JAREN_AI_MODEL: 'a/b' }));
    assert.ok(!line.includes('sk-secret-xyz'), 'the key must never reach a log line');
    assert.match(line, /key from OPENROUTER_AI_KEY/);
  });

  it('honours the concurrency ceiling and preserves order', async function () {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 2, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return item * 2;
    });
    assert.deepStrictEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 2, `concurrency guard exceeded: ${peak} in flight`);
  });
});

describe('ai benchmark — the entry point with no key and no .env', function () {
  it('prints both ceiling tables and an explicit skip, and exits 0', function () {
    // CI runs this benchmark keyless. `--env-file-if-exists` pointed at a
    // file that does not exist is the npm script's own shape: the plain
    // `--env-file` form would fail the run here, which is exactly the
    // accident this test exists to prevent.
    const scrubbed = { PATH: process.env.PATH, HOME: process.env.HOME };
    const run = spawnSync(process.execPath, [
      `--env-file-if-exists=${path.join(ROOT, 'no-such-file.env')}`,
      path.join(ROOT, 'benchmark', 'long-horizon.js'),
    ], { cwd: ROOT, env: scrubbed, encoding: 'utf8', timeout: 120000 });

    assert.strictEqual(run.status, 0, `keyless run failed:\n${run.stderr}`);
    assert.match(run.stdout, /live tier skipped: no key/,
      'a keyless run must say the live tier was skipped, and why');
    assert.match(run.stdout, /fact at the FRONT/);
    assert.match(run.stdout, /fact BEHIND the padding/);
    assert.match(run.stdout, /pairwise ceiling/, 'the pairwise column may not be dropped');
    // the model-free tier ran in full: the uncapped control row is present
    assert.match(run.stdout, /40000 \(uncapped\) \| 83 \| 26841 \| 40\/40 \| 40\/40 \| 100\.0%/);
  });
});
