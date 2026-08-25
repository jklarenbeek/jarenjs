#!/usr/bin/env node
//@ts-check
/**
 * Long-horizon benchmark — what survives `@jarenjs/ai`'s history
 * compaction, and what a real model can then do with it.
 *
 * Two tasks over one generated corpus, because they scale differently:
 *
 *   needle   (linear)    — the question asks for ONE record's value.
 *                          Answerable if that one round survives; degrades
 *                          gracefully with the budget. This is the task
 *                          compaction is designed for.
 *   pairwise (quadratic) — the question is a relation over EVERY pair
 *                          ("which two records have the closest values").
 *                          Needs all N facts at once. This is the
 *                          OOLONG-Pairs shape.
 *
 * Two numbers for each, and both are published:
 *
 *   ceiling — model-free and deterministic: is the fact needed to answer
 *             present in the request the client receives at all? No key,
 *             no cost, no flake, which makes it the tier CI runs and the
 *             right way to state a structural claim.
 *   actual  — what a real model scores against the same corpus. The GAP is
 *             the interesting quantity: a large gap means the information
 *             was there and the model failed to use it, which is a prompt
 *             problem rather than a context problem. Publishing only one of
 *             the two would let a later change claim a win it did not earn.
 *
 * Read the two ceilings precisely, because they are not the same kind of
 * number and pretending otherwise would be the dishonest shortcut here:
 *
 *   - the NEEDLE ceiling is a hard upper bound. A value that is not in the
 *     context cannot be read out of it. (The measured actual is a
 *     `trials`-sample estimate of a quantity bounded by it, so at three
 *     trials it carries a wide error bar and can land above the bound by
 *     sampling alone — the count is printed beside every percentage.)
 *   - the PAIRWISE ceiling is DETERMINACY: does the context determine the
 *     answer? A model can still name the true closest pair from a subset
 *     that happens to contain it, so a pairwise actual may legitimately
 *     exceed its ceiling. That is luck of the corpus rather than
 *     retrieval, and the model-free `pair survived` column reports exactly
 *     when it was available — the run says so out loud rather than
 *     publishing a score nobody can interpret.
 *
 * And two payload shapes, because the shape changes the answer: the
 * built-in synopsis excerpts the FIRST 60 CHARACTERS of a tool result, so
 * a fact at the front usually survives a cut and a fact behind the padding
 * usually does not. Reporting only the front shape would flatter the
 * package. Both run; `late` is the realistic one.
 *
 * The live tier replays the gathering deterministically (the same stub
 * client the ceiling probe uses) and then asks the real model ONE question
 * over exactly the context the ceiling measured. That is deliberate: it
 * isolates the quantity the ceiling bounds — given this context, can the
 * model answer? — and it costs one call per trial instead of forty.
 *
 *   node benchmark/long-horizon.js                        # ceilings only
 *   node --env-file-if-exists=.env benchmark/long-horizon.js --live
 *   node benchmark/long-horizon.js --output json --filepath out.json
 *
 * No key is not a failure: the ceiling tables always run, and the live
 * tier prints why it was skipped. `--env-file-if-exists` is the required
 * form — plain `--env-file` fails the run when no `.env` exists, which
 * would break a keyless CI.
 */

import { writeFileSync } from 'node:fs';

import {
  createAgent, createLedger, createEnvironment, createProgramAuthor, createProgramRunner,
  createStructuredOutput, createLongHorizonAgent,
} from '@jarenjs/ai';
import { createChatClient } from '@jarenjs/ai/client';
import { resolveEndpoint } from '@jarenjs/ai/providers';
import { compileJsonQuery } from '@jarenjs/json/query';
import querySchema from '@jarenjs/json/schemas/jaren-query.llm-profile.schema.json' with { type: 'json' };

import { readAiEnv, describeAiEnv, mapLimit, AI_ENV } from './lib/env.js';
import {
  DEFAULTS, SHAPES, makeCorpus, needleTargets, probe, ceilingFor,
  needleQuestion, pairwiseQuestion, scoreNeedle, scorePairwise,
  pairwiseProgram, needleProgram, programProbe, extractingClient, corpusText,
  recursionProbe, quantile,
} from './lib/horizon.js';

//#region flags

function parseArgs(argv) {
  const options = {
    live: false,
    quick: false,
    verbose: false,
    rounds: DEFAULTS.rounds,
    padding: DEFAULTS.padding,
    seed: DEFAULTS.seed,
    budgets: DEFAULTS.budgets,
    trials: null,
    model: null,
    output: 'console',
    filepath: null,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--live': options.live = true; break;
      case '--quick': options.quick = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--rounds': options.rounds = parseInt(argv[++i], 10); break;
      case '--padding': options.padding = parseInt(argv[++i], 10); break;
      case '--seed': options.seed = parseInt(argv[++i], 10); break;
      case '--trials': options.trials = parseInt(argv[++i], 10); break;
      case '--model': options.model = argv[++i]; break;
      case '--budgets': options.budgets = argv[++i].split(',').map((s) => parseInt(s.trim(), 10)); break;
      case '--output': case '-o': options.output = argv[++i]; break;
      case '--filepath': case '-f': options.filepath = argv[++i]; break;
      case '--help': case '-h':
        console.log('Usage: node [--env-file-if-exists=.env] benchmark/long-horizon.js [options]\n');
        console.log('  --live              also score a real model over the same corpora');
        console.log(`  --quick             live tier: one trial per row (default $${AI_ENV.trials})`);
        console.log('  --rounds N          tool rounds gathered (default 40)');
        console.log('  --padding N         padding characters per tool result (default 400)');
        console.log('  --seed N            corpus seed (default 20260812)');
        console.log('  --budgets a,b,c     history budgets in characters');
        console.log('  --trials N          live trials per row');
        console.log('  --model ID          live model id (default $JAREN_AI_MODEL)');
        console.log('  --verbose, -v       print every live reply');
        console.log('  --output json --filepath PATH');
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(2);
    }
  }
  return options;
}

const flags = parseArgs(process.argv);

//#endregion

//#region measurement

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const SHAPE_KEYS = /** @type {const} */ (['front', 'late']);
const TASK_KEYS = /** @type {const} */ (['needle', 'pairwise']);
/** Per-call deadline for the live tier. */
const CALL_TIMEOUT_MS = 300000;
/** How many tool rounds a live recall run may spend before it answers. */
const RECALL_ROUNDS = 3;
/** Needle targets the model-free program tier samples. Free (no model),
 * so it is sampled wider than the live tier's `trials`. */
const NEEDLE_SAMPLES = 8;
/** The synthetic per-sub-call latency the scheduling comparison uses. */
const SCHEDULING_DELAY_MS = 20;
/** The fan-out the scheduling comparison measures against sequential. */
const SCHEDULING_CONCURRENCY = 4;
/** The depths the recursion tier measures. 3 is the cap; 0–2 is where
 * the research says the interesting part of the curve is. */
const DEPTHS = [0, 1, 2];
/** Tasks per depth, so median and p95 are over a distribution. */
const DEPTH_TASKS = 8;

/**
 * The two compaction settings measured side by side, and what each one
 * means. Every row is run twice — same corpus, same budget, same shape —
 * so the delta between them is attributable to the ledger and to nothing
 * else.
 */
const VARIANTS = {
  synopsis: 'lossy synopsis (no ledger): a dropped round leaves a 60-char excerpt and nothing else',
  ledger: 'ledger + recall: a dropped round is archived first and its address travels in the synopsis',
};
const VARIANT_KEYS = /** @type {const} */ (['synopsis', 'ledger']);

/**
 * The model-free tier: one probe per variant, shape and budget, from
 * which the task ceilings are derived.
 *
 * A ledger row keeps its ledger, because the live tier has to hand the
 * model a `recall` over exactly the slots the ceiling counted — a
 * measurement of recoverability against a different archive would be a
 * measurement of nothing.
 * @param {any} corpus
 * @returns {Promise<any[]>} one entry per variant+shape+budget
 */
async function runCeilings(corpus) {
  const out = [];
  for (const shape of SHAPE_KEYS) {
    for (const budget of flags.budgets) {
      for (const variant of VARIANT_KEYS) {
        const ledger = variant === 'ledger' ? createLedger() : undefined;
        const result = await probe({ corpus, padding: flags.padding, budget, shape, ledger });
        out.push({
          shape,
          budget,
          variant,
          ledger: ledger ?? null,
          ...result,
          ceilings: {
            // in-context: the fact is readable where the model already is
            needle: ceilingFor('needle', { valuePresent: result.valuePresent, n: corpus.n }),
            // reachable: the fact is one `recall` away, which the model
            // has to actually spend a call on — a different quantity, and
            // published as a different column rather than folded in
            needleRecall: ceilingFor('needle',
              { valuePresent: result.valueRecoverable, n: corpus.n }),
            // deliberately VERBATIM, for both variants. Pairwise needs
            // every fact at once; recalling forty rounds one at a time
            // does not fit the budget they were cut to fit, so counting a
            // recoverable fact here would claim a win the ledger has not
            // won. Phase B is what moves this number.
            pairwise: ceilingFor('pairwise', { valuePresent: result.valuePresent, n: corpus.n }),
          },
        });
      }
    }
  }
  return out;
}

/**
 * The program tier: the same two questions, asked of an environment
 * instead of a transcript.
 *
 * Nothing about the corpus changes — same records, same padding, same
 * payload shape — so the only difference between these rows and the ones
 * above is the MECHANISM. Compaction is asked what survived being cut;
 * a program is asked what it visited, and it visits by address.
 *
 * The sub-call here is deterministic (`extractingClient`), which is what
 * makes this a ceiling in the same sense as every other ceiling in this
 * file: the model's competence is held at perfect and what remains is
 * whether the harness puts the answer within reach. `--live` then swaps
 * in a real model and the gap between the two is the tier's.
 * @param {any} corpus
 */
async function runPrograms(corpus) {
  const out = [];
  for (const shape of SHAPE_KEYS) {
    const pairwise = await programProbe({
      corpus, padding: flags.padding, shape, program: pairwiseProgram(),
    });

    // the needle is scored over the same uniform draw the compaction
    // tiers sample, so the two columns mean the same thing
    const targets = needleTargets(corpus, flags.quick ? 3 : NEEDLE_SAMPLES, 11);
    let correct = 0;
    let subcalls = 0;
    let reached = 0;
    for (const index of targets) {
      const row = await programProbe({
        corpus, padding: flags.padding, shape, program: needleProgram(corpus, index),
      });
      subcalls += row.subcalls;
      reached += row.valuesReached > 0 ? 1 : 0;
      if (scoreNeedle(row.answerText, corpus, index)) correct += 1;
    }

    out.push({
      shape,
      pairwise: {
        ok: pairwise.ok,
        valuesReached: pairwise.valuesReached,
        ceiling: ceilingFor('pairwise', { valuePresent: pairwise.valuesReached, n: corpus.n }),
        scored: scorePairwise(pairwise.answerText, corpus),
        // did the closest pair itself reach the reduce? With every value
        // reached this is implied, but a run that loses sub-calls can
        // still answer correctly, and only this column says whether that
        // was determinacy or luck
        pairReached: pairwise.pairReached,
        subcalls: pairwise.subcalls,
        failed: pairwise.failed,
        rootChars: pairwise.rootChars,
        corpusChars: pairwise.corpusChars,
        answer: pairwise.answerText,
      },
      needle: {
        trials: targets.length,
        correct,
        // "was the record reached at all", which is the needle's ceiling
        // in the same determinacy sense: a grep that found the piece puts
        // the value within one sub-call
        ceiling: reached / targets.length,
        subcalls,
      },
    });
  }
  return out;
}

/**
 * Parallel against sequential, over the same program and the same
 * number of sub-calls.
 *
 * The latency is synthetic and stated as such: a benchmark that made
 * eighty real model calls to time its own scheduler would be measuring
 * the provider's queue, not the harness. What is measured here is
 * exactly what the harness controls — how many sub-calls are allowed to
 * be waiting at once — with the per-call wait held fixed.
 * @param {any} corpus
 */
async function runScheduling(corpus) {
  const rows = {};
  for (const sequential of [false, true]) {
    const client = extractingClient({ delayMs: SCHEDULING_DELAY_MS });
    const result = await programProbe({
      corpus, padding: flags.padding, program: pairwiseProgram(), client, sequential,
      maxConcurrentSubcalls: SCHEDULING_CONCURRENCY,
    });
    rows[sequential ? 'sequential' : 'parallel'] = {
      ms: result.ms,
      subcalls: result.subcalls,
      concurrency: result.concurrency,
      peak: client.state.peak,
    };
  }
  return { ...rows, delayMs: SCHEDULING_DELAY_MS };
}

/**
 * One live question over one measured context. The context is the exact
 * message array the ceiling probe scored; the question is appended as a
 * final user turn, so the live tier can never see a fact the ceiling did
 * not count.
 *
 * With a `ledger`, the question is put through the real `createAgent`
 * with the real `recall` tool bound to the slots this row archived — the
 * package's own loop, not a re-implementation of it, because what is
 * being measured is whether that loop lets a model get a dropped fact
 * back. `temperature` rides in through a one-line client wrapper so both
 * tiers are asked under identical conditions.
 * @param {any} client
 * @param {any[]} context
 * @param {string} question
 * @param {any} [ledger]
 */
async function ask(client, context, question, ledger) {
  const usage = { prompt: 0, completion: 0, total: 0 };
  // counted, because one question is no longer one call: a ledger row
  // that recalls twice costs three. A summary that printed the number of
  // QUESTIONS and called them calls would under-report this benchmark's
  // own spend, which is the one number a benchmark may never fudge.
  let calls = 0;
  const add = (u) => {
    calls += 1;
    if (u === null || u === undefined) return;
    usage.prompt += u.prompt_tokens ?? 0;
    usage.completion += u.completion_tokens ?? 0;
    usage.total += u.total_tokens ?? 0;
  };
  const request = {
    // STREAMED, and measured rather than assumed: with `stream: false` this
    // benchmark lost 13 of 72 calls to the deadline, all of them on the
    // tightest budgets, which reads like a model thinking harder about a
    // compacted context. It is not. The identical request — same messages,
    // same model — answered in 2.9 s streamed after hanging past 300 s
    // unstreamed. Non-streaming is what fails here, so the live tier
    // streams and the deadline below is only a backstop.
    stream: true,
    temperature: 0,
  };

  if (ledger === undefined || ledger === null) {
    const completion = await client.complete({
      ...request,
      messages: [...context, { role: 'user', content: question }],
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    add(completion.usage);
    return { text: completion.message?.content ?? '', usage, calls, recalls: 0 };
  }

  const agent = createAgent({
    client: {
      complete: (call) => client.complete({ ...request, ...call }).then((completion) => {
        add(completion.usage);
        return completion;
      }),
    },
    // no `historyBudget`: this context was already compacted by the
    // probe, and the agent registers `recall` because it has a ledger —
    // the shipped registration path, not a hand-built one
    ledger,
    maxToolRounds: RECALL_ROUNDS,
  });
  const result = await agent.send([...context, { role: 'user', content: question }],
    { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  return {
    text: result.message?.content ?? '',
    usage,
    calls,
    recalls: result.steps.length,
  };
}

/**
 * The live tier. Every row is `trials` independent single-call questions;
 * the needle rows draw their target uniformly at random (seeded), because
 * the needle ceiling is the ceiling for a uniformly random record and an
 * actual measured on a fixed target would not be comparable to it.
 * @returns {Promise<{ rows: Map<string, any>, calls: number, errors: string[],
 *   usage: { prompt: number, completion: number, total: number },
 *   bounded: string | null }>}
 */
async function runLive(corpus, ceilings, config) {
  const client = createChatClient({
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });

  // every call this run will make, laid out first so the spend guard is
  // applied to the whole plan rather than discovered halfway through
  const plan = [];
  for (const row of ceilings) {
    for (const task of TASK_KEYS) {
      const key = `${task}|${row.variant}|${row.shape}|${row.budget}`;
      const salt = row.budget + (row.shape === 'late' ? 1 : 0);
      const targets = task === 'needle'
        ? needleTargets(corpus, config.trials, salt)
        : new Array(config.trials).fill(-1);
      for (const target of targets) plan.push({ key, task, row, target });
    }
  }

  let bounded = null;
  let work = plan;
  if (plan.length > config.maxCalls) {
    work = plan.slice(0, config.maxCalls);
    bounded = `${AI_ENV.maxCalls}=${config.maxCalls} reached: ${work.length} of ${plan.length}`
      + ' planned calls made, the rest of the rows keep a null actual';
  }

  /** @type {string[]} */
  const errors = [];
  // counted in full, listed in part: a run that printed `errors.length`
  // would UNDER-report its own failures the moment there were more than
  // the few it keeps, and a benchmark may not do that
  let failed = 0;
  const usage = { prompt: 0, completion: 0, total: 0 };
  // questions asked is `work.length`; CALLS is what was actually spent,
  // and `recalled` is how often a model walked through the door this
  // order opened — a ledger row that scores with zero recalls scored on
  // what was still in front of it, not on the mechanism
  let made = 0;
  let recalled = 0;
  const results = await mapLimit(work, config.maxConcurrency, async (item) => {
    const question = item.task === 'needle'
      ? needleQuestion(corpus, item.target)
      : pairwiseQuestion();
    try {
      const answer = await ask(client, item.row.messages, question, item.row.ledger);
      usage.prompt += answer.usage.prompt;
      usage.completion += answer.usage.completion;
      usage.total += answer.usage.total;
      made += answer.calls;
      recalled += answer.recalls;
      const correct = item.task === 'needle'
        ? scoreNeedle(answer.text, corpus, item.target)
        : scorePairwise(answer.text, corpus);
      if (flags.verbose) {
        console.log(`  ${item.key} target=${item.target} ${correct ? 'OK ' : 'MISS'} `
          + `${answer.recalls} recall(s) ${answer.text.replace(/\s+/g, ' ').slice(0, 100)}`);
      }
      return { key: item.key, correct, ok: true, recalls: answer.recalls };
    }
    catch (error) {
      const message = /** @type {Error} */ (error).message;
      failed += 1;
      if (errors.length < 5) errors.push(`${item.key}: ${message}`);
      return { key: item.key, correct: false, ok: false, recalls: 0 };
    }
  });

  /** @type {Map<string, any>} */
  const rows = new Map();
  for (const result of results) {
    const slot = rows.get(result.key) ?? { correct: 0, trials: 0, failed: 0, recalls: 0 };
    slot.trials += result.ok ? 1 : 0;
    slot.failed += result.ok ? 0 : 1;
    slot.correct += result.correct ? 1 : 0;
    // whether the model actually used the door it was given: a ledger row
    // that scores well with zero recalls scored on the tail, not on the
    // mechanism this order added
    slot.recalls += result.recalls;
    rows.set(result.key, slot);
  }
  return { rows, asked: work.length, calls: made, recalls: recalled, failed, errors, usage, bounded };
}

/**
 * The provider's published per-token price for this model, fetched at run
 * time from the OpenAI-compatible `/models` listing. Derived, never
 * hard-coded: a price table in the repository would rot silently and a
 * cost estimate nobody can recompute is worth nothing. Returns null when
 * the provider publishes no pricing (every local runtime, for one).
 */
async function fetchPricing(config) {
  try {
    const endpoint = resolveEndpoint({
      provider: config.provider, baseUrl: config.baseUrl, apiKey: config.apiKey,
    });
    const response = await fetch(`${endpoint.base}/models`, {
      headers: endpoint.headers, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const entry = (payload?.data ?? []).find((m) => m?.id === config.model);
    const prompt = Number(entry?.pricing?.prompt);
    const completion = Number(entry?.pricing?.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
    return { prompt, completion };
  }
  catch {
    return null;
  }
}

//#endregion

//#region output

/**
 * The recursion tier: the same corpus, worked at depth 0, 1 and 2.
 *
 * What this publishes is a COST curve beside a quality one, because the
 * research this follows is explicit that depth helps at depth 1 and
 * mostly buys expense after — and a benchmark that reported only the
 * quality would make depth 3 look free. Median and p95 rather than a
 * mean (§5): the distribution's tail is the thing a caller provisions
 * for, and averaging it away is the one dishonest summary available
 * here.
 * @param {any} corpus
 */
async function runDepths(corpus) {
  const factories = {
    createLedger,
    createEnvironment,
    createLongHorizonAgent,
    createProgramAuthor,
    createProgramRunner,
    createStructuredOutput,
    compileQuery: compileJsonQuery,
  };
  const rows = [];
  for (const depth of DEPTHS) {
    // one task per sampled needle target, so median and p95 are over a
    // real distribution rather than over one run repeated
    const targets = needleTargets(corpus, flags.quick ? 3 : DEPTH_TASKS, 23);
    const runs = [];
    for (const index of targets) {
      runs.push(await recursionProbe({
        corpus,
        padding: flags.padding,
        shape: 'late',
        depth,
        question: needleQuestion(corpus, index),
        program: needleProgram(corpus, index),
        factories,
      }));
    }
    const calls = runs.map((r) => r.calls);
    const tokens = runs.map((r) => r.tokens);
    rows.push({
      depth,
      tasks: runs.length,
      ok: runs.filter((r) => r.ok).length,
      correct: runs.filter((r, i) => scoreNeedle(r.answer, corpus, targets[i])).length,
      callsMedian: quantile(calls, 0.5),
      callsP95: quantile(calls, 0.95),
      tokensMedian: quantile(tokens, 0.5),
      tokensP95: quantile(tokens, 0.95),
      msMedian: quantile(runs.map((r) => r.ms), 0.5),
      deepest: Math.max(...runs.flatMap((r) => r.depths)),
    });
  }
  return rows;
}

/**
 * The recursion tier, live: can the cheap tier author a plan at depth,
 * and does the tree still answer?
 *
 * Deliberately small — depth 1 and 2, `trials` tasks each — because the
 * point is the per-depth compile-gate pass rate and whether recursion
 * survives a real model, not a wide sample. The pass rate is derived
 * from the trajectory rather than counted separately, so it cannot drift
 * from what actually happened.
 * @param {any} corpus
 * @param {any} config
 * @param {any} client - the counting wrapper the program tier built
 */
async function runLiveDepths(corpus, config, client) {
  const rows = [];
  for (const depth of [1, 2]) {
    const targets = needleTargets(corpus, Math.min(config.trials, 2), 29 + depth);
    const authored = { total: 0, compiled: 0 };
    let correct = 0;
    let calls = 0;
    const errors = [];
    for (const index of targets) {
      const ledger = createLedger();
      const environment = createEnvironment({ ledger, compileQuery: compileJsonQuery });
      await environment.put('corpus', corpusText(corpus, flags.padding, 'late'),
        { kind: 'text', count: corpus.n });
      const agent = createLongHorizonAgent({
        client,
        environment,
        compileQuery: compileJsonQuery,
        createStructuredOutput,
        createProgramAuthor,
        createProgramRunner,
        createEnvironment,
        querySchema,
        depth,
        maxSubcalls: 12,
        // a hard stop per task, so a depth that misbehaves cannot eat
        // the whole guard before the other depth is measured
        budget: { turns: 12 },
      });
      try {
        const result = await agent.run(needleQuestion(corpus, index));
        for (const entry of result.trajectory) {
          if (entry.kind !== 'author') continue;
          authored.total += 1;
          if (entry.ok === true) authored.compiled += 1;
        }
        calls += result.spent.turns;
        if (scoreNeedle(result.answer?.text ?? '', corpus, index)) correct += 1;
        if (result.stopReason !== null) errors.push(`depth ${depth}: ${result.stopReason}`);
      }
      catch (err) {
        errors.push(`depth ${depth}: ${/** @type {Error} */ (err).message}`.slice(0, 160));
      }
    }
    rows.push({ depth, tasks: targets.length, correct, calls, authored, errors });
  }
  return rows;
}

/**
 * The live program tier — the D8 measurement, in two halves that are
 * reported separately because they can fail independently.
 *
 * **Authoring**: can the cheap tier write a plan that COMPILES? The
 * paper reports its own weak model making template mistakes 13–16% of
 * the time writing Python; the counter-hypothesis this campaign is
 * testing is that a schema-constrained document with a compile gate is
 * easier for the same class of model. The number that settles it is the
 * pass rate, and it is published whichever way it falls.
 *
 * **Piece work**: can it do one sub-call correctly? Every piece is one
 * record and one question, which is the easiest thing this campaign asks
 * of a model — and if the cheap tier cannot do that, the fan-out is a
 * fast way to be wrong forty times, which is also worth knowing.
 *
 * The two are measured over ONE canonical program so a failure is
 * attributable: an authored program that compiles is still scored on
 * whether it compiles, not run, because running forty sub-calls per
 * authored candidate would spend the whole guard on variance.
 * @param {any} corpus
 * @param {any} config
 */
async function runLivePrograms(corpus, config) {
  const client = createChatClient({
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });

  const usage = { prompt: 0, completion: 0, total: 0 };
  let calls = 0;
  const counting = {
    endpoint: client.endpoint,
    complete: async (request) => {
      calls += 1;
      const result = await client.complete({
        ...request,
        // streaming is FORCED, not defaulted, and this is the one place
        // it matters most: `createStructuredOutput` sets `stream: false`
        // explicitly, which is exactly the request shape this benchmark
        // measured hanging past a 300 s deadline and answering in 2.9 s
        // streamed. A `?? true` here would honour the caller and inherit
        // the hang.
        stream: true,
        temperature: 0,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const u = result.usage;
      usage.prompt += u?.prompt_tokens ?? 0;
      usage.completion += u?.completion_tokens ?? 0;
      usage.total += u?.total_tokens ?? 0;
      return result;
    },
  };

  // authoring first: it is cheap, and if the tier cannot author at all
  // that is the headline rather than a footnote
  const authored = { trials: 0, compiled: 0, attempts: 0, errors: [] };
  const environment = createEnvironment();
  await environment.put('corpus', corpusText(corpus, flags.padding, 'late'),
    { kind: 'text', count: corpus.n });
  const author = createProgramAuthor({
    client: counting,
    environment,
    compileQuery: compileJsonQuery,
    createStructuredOutput,
    querySchema,
  });

  for (let trial = 0; trial < config.trials; trial++) {
    if (calls >= config.maxCalls) break;
    authored.trials += 1;
    try {
      const result = await author.author(pairwiseQuestion());
      authored.attempts += result.attempts ?? 0;
      if (result.value !== undefined) authored.compiled += 1;
      else authored.errors.push(JSON.stringify(result.errors?.[0] ?? null).slice(0, 200));
    }
    catch (err) {
      authored.errors.push(`authoring failed: ${/** @type {Error} */ (err).message}`);
    }
  }

  // piece work: the canonical program, with the real model answering
  // every sub-call. One shape only — the realistic one — because forty
  // calls is the whole spend guard and running both would buy a number
  // nobody would read differently.
  let executed = null;
  if (calls + corpus.n <= config.maxCalls) {
    const result = await programProbe({
      corpus,
      padding: flags.padding,
      shape: 'late',
      program: pairwiseProgram(),
      client: counting,
      maxConcurrentSubcalls: config.maxConcurrency,
    });
    executed = {
      ok: result.ok,
      subcalls: result.subcalls,
      failed: result.failed,
      valuesReached: result.valuesReached,
      scored: scorePairwise(result.answerText, corpus),
      answer: String(result.answerText).slice(0, 200),
      ms: result.ms,
    };
  }

  // the recursion tier reuses this same counting client, so one guard
  // covers the whole live run rather than each tier having its own
  const depths = calls + 24 <= config.maxCalls ? await runLiveDepths(corpus, config, counting) : null;

  return {
    authored,
    executed,
    depths,
    calls,
    usage,
    bounded: calls >= config.maxCalls
      ? `stopped at ${config.maxCalls} calls (${AI_ENV.maxCalls})`
      : null,
  };
}

/** The console tables — the same columns as the campaign's baseline. */
function printTables(corpus, ceilings, live, config) {
  console.log(`# long-horizon — what survives createAgent's historyBudget compaction`);
  console.log(`# ${corpus.n} tool rounds, ~${flags.padding}B padding per result, `
    + `seed ${corpus.seed}, node ${process.version}`);
  console.log('# ceiling = model-free: needle = fraction of values present (a hard bound);');
  console.log('#           pairwise = does the context DETERMINE the answer at all?');
  console.log(live === null
    ? '# actual  = not measured (see the live-tier line below)'
    : `# actual  = ${config.model}, ${config.trials} trial(s) per row`);
  console.log('');

  // the two variants keep SEPARATE tables, with the ledger-free one
  // first and its columns exactly as they were: this benchmark's baseline
  // rows are quoted in the campaign's own record, and a column inserted
  // into the middle of them would silently re-shape the thing later
  // orders diff against
  for (const shape of SHAPE_KEYS) {
    for (const variant of VARIANT_KEYS) {
      const ledgered = variant === 'ledger';
      console.log(ledgered
        ? `### the same rows with a ledger — ${VARIANTS.ledger}\n`
        : `## ${SHAPES[shape]}\n`);
      console.log('| budget (chars) | messages sent | chars sent | ids present | values present '
        + (ledgered ? '| values recoverable ' : '')
        + '| needle ceiling '
        + (ledgered ? '| needle ceiling (+recall) ' : '')
        + '| needle actual | pairwise ceiling | pairwise actual | pair survived |');
      console.log(`|${'---|'.repeat(ledgered ? 12 : 10)}`);
      for (const row of ceilings.filter((r) => r.shape === shape && r.variant === variant)) {
        const actual = (task) => {
          const slot = live?.rows.get(`${task}|${variant}|${shape}|${row.budget}`);
          return slot === undefined || slot.trials === 0
            ? '—'
            : `${pct(slot.correct / slot.trials)} (${slot.correct}/${slot.trials})`;
        };
        console.log(`| ${row.budget}${row.compacted ? '' : ' (uncapped)'} | ${row.messageCount} `
          + `| ${row.sent} | ${row.idPresent}/${corpus.n} | ${row.valuePresent}/${corpus.n} `
          + (ledgered ? `| ${row.valueRecoverable}/${corpus.n} ` : '')
          + `| ${pct(row.ceilings.needle)} `
          + (ledgered ? `| ${pct(row.ceilings.needleRecall)} ` : '')
          + `| ${actual('needle')} `
          + `| ${pct(row.ceilings.pairwise)} | ${actual('pairwise')} `
          + `| ${row.pairSurvived ? 'yes' : 'no'} |`);
      }
      console.log('');
    }
  }

  // the campaign's claim is that the pairwise ceiling stays 0% until an
  // external environment exists; a compacting row where it does not has
  // to be visible and explained rather than left for a reader to spot
  const determined = ceilings.filter((row) => row.compacted && row.ceilings.pairwise === 1);
  if (determined.length > 0) {
    console.log('# compacting rows whose context still DETERMINES the pairwise answer — the whole');
    console.log('#   corpus happened to fit, which is the payload shape being generous rather than');
    console.log('#   a relation being recovered (recall cannot fetch 40 rounds into this budget):');
    for (const row of determined) {
      console.log(`#   ${row.variant}/${row.shape}@${row.budget}: `
        + `${row.valuePresent}/${corpus.n} values present verbatim`);
    }
    console.log('');
  }

  // an actual above its own ceiling is not a bug and not a win — say what
  // it is, at the point a reader would otherwise have to guess
  const above = live === null ? [] : ceilings.flatMap((row) => TASK_KEYS.flatMap((task) => {
    const slot = live.rows.get(`${task}|${row.variant}|${row.shape}|${row.budget}`);
    if (slot === undefined || slot.trials === 0) return [];
    const score = slot.correct / slot.trials;
    // a ledger row is measured against the ceiling that includes what it
    // can reach, because reaching it is the thing being measured
    const ceiling = task === 'needle' && row.variant === 'ledger'
      ? row.ceilings.needleRecall
      : row.ceilings[task];
    return score > ceiling + 1e-9
      ? [`${task}/${row.variant}/${row.shape}@${row.budget}: ${pct(score)} scored against a `
        + `${pct(ceiling)} ceiling `
        + `(closest pair ${row.pairSurvived ? 'survived the cut' : 'did NOT survive'})`]
      : [];
  }));
  if (above.length > 0) {
    console.log('# rows where the model scored above the ceiling — read them as stated:');
    console.log('#   pairwise: the ceiling is DETERMINACY, so naming the right pair out of a');
    console.log('#     surviving subset is luck of the corpus rather than a bound being broken;');
    console.log(`#   needle: the actual is a ${config.trials}-trial estimate, so it carries a wide`);
    console.log('#     error bar. Raise JAREN_AI_TRIALS to tighten it.');
    for (const line of above) console.log(`#   ${line}`);
    console.log('');
  }
}

/**
 * The program tier's console section: the same two tasks, the same
 * corpus, answered by a plan over an environment.
 * @param {any} corpus
 * @param {any[]} programs
 * @param {any} scheduling
 * @param {any} livePrograms
 */
function printPrograms(corpus, programs, scheduling, livePrograms) {
  console.log('## the same questions, asked of an environment instead of a transcript\n');
  console.log('| payload shape | needle ceiling | needle sub-calls | pairwise ceiling '
    + '| pairwise answered | values reached | sub-calls | root chars | corpus chars |');
  console.log(`|${'---|'.repeat(9)}`);
  for (const row of programs) {
    console.log(`| ${row.shape} | ${pct(row.needle.ceiling)} `
      + `| ${row.needle.subcalls} over ${row.needle.trials} question(s) `
      + `| ${pct(row.pairwise.ceiling)} | ${row.pairwise.scored ? 'yes' : 'no'} `
      + `| ${row.pairwise.valuesReached}/${corpus.n} | ${row.pairwise.subcalls} `
      + `| ${row.pairwise.rootChars} | ${row.pairwise.corpusChars} |`);
  }
  console.log('');
  console.log('# the root carried a plan and a step report; the corpus never entered the request.');
  console.log('# a needle costs ONE sub-call because grep narrows first; the pairwise question');
  console.log(`#   costs ${corpus.n} because a relation over every pair needs every record.`);
  console.log('');

  console.log(`# fan-out, ${scheduling.delayMs}ms synthetic latency per sub-call `
    + `(measuring the scheduler, not a provider's queue):`);
  console.log(`#   sequential  ${scheduling.sequential.ms}ms `
    + `(${scheduling.sequential.subcalls} sub-calls, peak ${scheduling.sequential.peak})`);
  console.log(`#   parallel    ${scheduling.parallel.ms}ms `
    + `(concurrency ${scheduling.parallel.concurrency}, peak ${scheduling.parallel.peak})`);
  console.log(`#   => ${(scheduling.sequential.ms / scheduling.parallel.ms).toFixed(2)}x, `
    + 'the paper\'s stated "RLMs without asynchronous LM calls are slow" limitation removed.');
  console.log('');

  if (livePrograms === null) return;
  const { authored, executed } = livePrograms;
  console.log('# the cheap tier, authoring and doing the piece work (D8):');
  console.log(`#   authored ${authored.compiled}/${authored.trials} programs that COMPILE`
    + `${authored.trials === 0 ? '' : ` (${authored.attempts} generation(s) including repairs)`}`);
  for (const error of authored.errors.slice(0, 3)) console.log(`#     ${error}`);
  console.log(executed === null
    ? '#   piece work not run — the spend guard would have been exceeded'
    : `#   piece work: ${executed.subcalls} live sub-calls, ${executed.failed} failed, `
      + `${executed.valuesReached}/${corpus.n} values reached, `
      + `answer ${executed.scored ? 'CORRECT' : 'wrong'} (${executed.answer})`);
  if (livePrograms.depths === null) {
    console.log('#   recursion not run live — the spend guard would have been exceeded');
  }
  else {
    for (const row of livePrograms.depths) {
      console.log(`#   depth ${row.depth}: ${row.authored.compiled}/${row.authored.total} authored`
        + ` programs compiled, ${row.correct}/${row.tasks} answered, ${row.calls} calls`
        + (row.errors.length === 0 ? '' : ` — ${row.errors[0]}`));
    }
  }
  console.log('');
}

/**
 * The recursion tier's console section: what each depth answered and
 * what it cost.
 * @param {any[]} depths
 */
function printDepths(depths) {
  console.log('## depth — the same question, recursed\n');
  console.log('| depth | tasks | answered | deepest level | calls (median) | calls (p95) '
    + '| tokens (median) | tokens (p95) |');
  console.log(`|${'---|'.repeat(8)}`);
  for (const row of depths) {
    console.log(`| ${row.depth} | ${row.tasks} | ${row.correct}/${row.tasks} | ${row.deepest} `
      + `| ${row.callsMedian} | ${row.callsP95} | ${row.tokensMedian} | ${row.tokensP95} |`);
  }
  console.log('');
  console.log('# median AND p95, never the mean: the research this follows reports quality at');
  console.log('#   comparable cost with a few outlier trajectories inflating the average, so a');
  console.log('#   mean is the one summary that would hide what a caller has to provision for.');
  const base = depths.find((r) => r.depth === 0);
  const deeper = depths.filter((r) => r.depth > 0 && r.callsMedian > 0);
  for (const row of deeper) {
    console.log(`#   depth ${row.depth} costs ${(row.callsMedian / Math.max(1, base.callsMedian)).toFixed(1)}x`
      + ` the calls of depth 0 and answered ${row.correct}/${row.tasks} against`
      + ` ${base.correct}/${base.tasks}.`);
  }
  console.log('#   Depth defaults to 1 for exactly this reason: it is the depth that pays on the');
  console.log('#   tasks the research measured, and every deeper level multiplies the bill.');
  console.log('');
}

/** The rows the output contract names, plus what a later order needs to diff. */
function jsonRows(corpus, ceilings, live, config) {
  const rows = [];
  for (const row of ceilings) {
    for (const task of TASK_KEYS) {
      const slot = live?.rows.get(`${task}|${row.variant}|${row.shape}|${row.budget}`);
      rows.push({
        config: {
          historyBudget: row.budget,
          maxToolRounds: corpus.n + 1,
          compaction: row.variant === 'ledger'
            ? 'ledger + recall (60-char preview, addressed)'
            : 'built-in synopsis (60-char result excerpt)',
        },
        task,
        variant: row.variant,
        shape: row.shape,
        budget: row.budget,
        ceiling: row.ceilings[task],
        // present only where it means something: what the row can reach
        // through the addresses it names, at one `recall` per fact
        ceilingRecall: row.variant === 'ledger' && task === 'needle'
          ? row.ceilings.needleRecall
          : null,
        actual: slot === undefined || slot.trials === 0 ? null : slot.correct / slot.trials,
        recalls: slot?.recalls ?? 0,
        model: live === null ? null : config.model,
        n: corpus.n,
        trials: slot === undefined ? 0 : slot.trials,
        compacted: row.compacted,
        // model-free, and the reason a pairwise actual can exceed its own
        // ceiling: the closest pair was still visible in this context
        pairSurvived: row.pairSurvived,
        idPresent: row.idPresent,
        valuePresent: row.valuePresent,
        valueRecoverable: row.variant === 'ledger' ? row.valueRecoverable : null,
        slotsArchived: row.slots.length,
        messagesSent: row.messageCount,
        charsSent: row.sent,
        charsFull: row.full,
      });
    }
  }
  return rows;
}

/**
 * The program tier as rows in the same contract. `historyBudget` is null
 * because there is no budget to exceed: the corpus is not in the request
 * at any size, which is the whole difference these rows report.
 * @param {any} corpus
 * @param {any[]} programs
 * @param {any} livePrograms
 * @param {any} config
 */
function programRows(corpus, programs, livePrograms, config) {
  const rows = [];
  for (const row of programs) {
    for (const task of TASK_KEYS) {
      const live = task === 'pairwise' && row.shape === 'late' ? livePrograms?.executed : null;
      rows.push({
        config: {
          historyBudget: null,
          maxToolRounds: null,
          compaction: 'none — the corpus is an environment the program addresses',
        },
        task,
        variant: 'program',
        shape: row.shape,
        budget: null,
        ceiling: task === 'needle' ? row.needle.ceiling : row.pairwise.ceiling,
        ceilingRecall: null,
        actual: live === null || live === undefined ? null : (live.scored ? 1 : 0),
        recalls: 0,
        model: livePrograms === null ? null : config.model,
        n: corpus.n,
        trials: task === 'needle' ? row.needle.trials : 1,
        compacted: false,
        // model-free, and a boolean on every row like every other row in
        // this file: did both records of the closest pair reach the
        // computation? A needle program greps to one piece, so it
        // legitimately reads false — and a pairwise row that answered
        // correctly with this false answered from luck, not determinacy.
        pairSurvived: task === 'pairwise' ? row.pairwise.pairReached : false,
        idsReached: task === 'pairwise' ? row.pairwise.valuesReached : null,
        valuePresent: task === 'pairwise' ? row.pairwise.valuesReached : null,
        valueRecoverable: null,
        subcalls: task === 'needle' ? row.needle.subcalls : row.pairwise.subcalls,
        slotsArchived: 0,
        messagesSent: null,
        // what the ROOT carried: the plan plus the step report plus the
        // answer, which is the quantity a budget would have bounded
        charsSent: task === 'pairwise' ? row.pairwise.rootChars : null,
        charsFull: task === 'pairwise' ? row.pairwise.corpusChars : null,
      });
    }
  }
  return rows;
}

/** Display-ready tables: cells are strings, so the benchmarks page needs
 * no derivation of its own beyond rendering them. */
function displayTables(corpus, ceilings, live, config) {
  const liveNote = live === null
    ? ' The actual columns are empty because the live tier was skipped on the machine that'
      + ' generated this file.'
    : ` Actual is ${config.model} answering one question over exactly these contexts,`
      + ` ${config.trials} trial(s) per row — a small sample with a correspondingly wide`
      + ' error bar.';
  return SHAPE_KEYS.flatMap((shape) => VARIANT_KEYS.map((variant) => {
    const ledgered = variant === 'ledger';
    return {
      title: `Fact ${shape === 'front' ? 'at the FRONT of the tool result (flattering)'
        : 'BEHIND the padding (realistic)'}${ledgered ? ' — with a ledger' : ''}`,
      head: ['Budget (chars)', 'Messages sent', 'Chars sent', 'Ids present', 'Values present',
        ...(ledgered ? ['Values recoverable'] : []),
        'Needle ceiling', ...(ledgered ? ['Needle ceiling (+recall)'] : []),
        'Needle actual', 'Pairwise ceiling', 'Pairwise actual', 'Closest pair survived'],
      rows: ceilings.filter((r) => r.shape === shape && r.variant === variant).map((row) => {
        const actual = (task) => {
          const slot = live?.rows.get(`${task}|${variant}|${shape}|${row.budget}`);
          return slot === undefined || slot.trials === 0
            ? '—' : `${pct(slot.correct / slot.trials)}`;
        };
        return {
          cells: [
            `${row.budget}${row.compacted ? '' : ' (uncapped)'}`,
            String(row.messageCount), String(row.sent),
            `${row.idPresent}/${corpus.n}`, `${row.valuePresent}/${corpus.n}`,
            ...(ledgered ? [`${row.valueRecoverable}/${corpus.n}`] : []),
            pct(row.ceilings.needle), ...(ledgered ? [pct(row.ceilings.needleRecall)] : []),
            actual('needle'),
            pct(row.ceilings.pairwise), actual('pairwise'),
            row.pairSurvived ? 'yes' : 'no',
          ],
          strong: !row.compacted,
        };
      }),
      note: (ledgered
        ? 'The same corpus, the same budgets, the same payload shape — with a ledger under the'
          + ' agent, so every dropped round is archived to an addressed slot before the synopsis'
          + ' is written. Values recoverable counts what the request can still reach through the'
          + ' addresses it names; the +recall ceiling is that count as a fraction, and it is kept'
          + ' in its own column because it is a DIFFERENT quantity from the one beside it: the'
          + ' fact is not in the context, it is one `recall` call away. What that costs is'
          + ' visible in the values-present column, which the addresses push down a little at the'
          + ' tightest budgets. The pairwise ceiling stays on what is present VERBATIM, because a'
          + ' relation over every pair needs every fact at once and forty rounds fetched one at a'
          + ' time do not fit the budget they were cut to fit — that number is the environment\'s'
          + ' to move, not the ledger\'s.'
        : 'The needle ceiling is a hard bound: the fraction of record values still present in the'
          + ' request the client receives, and a value that is not there cannot be read out. The'
          + ' pairwise ceiling is DETERMINACY — whether the context determines the answer at all —'
          + ' so a model can still name the right pair out of a surviving subset, which the last'
          + ' column reports model-free.') + liveNote,
    };
  }));
}

/**
 * The program tier as a display table, in the same shape the benchmarks
 * page renders every other one.
 * @param {any} corpus
 * @param {any[]} programs
 * @param {any} scheduling
 * @param {any} livePrograms
 */
function programTable(corpus, programs, scheduling, livePrograms) {
  const speedup = (scheduling.sequential.ms / scheduling.parallel.ms).toFixed(1);
  return {
    title: 'The same questions, asked of an environment (no history budget)',
    head: ['Payload shape', 'Needle ceiling', 'Needle sub-calls', 'Pairwise ceiling',
      'Pairwise answered', 'Values reached', 'Pairwise sub-calls', 'Root chars', 'Corpus chars'],
    rows: programs.map((row) => ({
      cells: [
        row.shape === 'front' ? 'front (flattering)' : 'late (realistic)',
        pct(row.needle.ceiling),
        `${row.needle.subcalls} over ${row.needle.trials}`,
        pct(row.pairwise.ceiling),
        row.pairwise.scored ? 'yes' : 'no',
        `${row.pairwise.valuesReached}/${corpus.n}`,
        String(row.pairwise.subcalls),
        String(row.pairwise.rootChars),
        String(row.pairwise.corpusChars),
      ],
      strong: row.shape === 'late',
    })),
    note: 'The corpus is held OUTSIDE the context as addressable slots, and the model authors a'
      + ' compile-gated program over it: chunk the corpus, map one sub-call per piece, reduce the'
      + ' results with a query, read the answer from the slot it wrote. The root request carries'
      + ' the plan and a step report — never a record — which is why there is no budget column'
      + ' here and why these numbers do not move when the corpus grows. The pairwise ceiling is'
      + ' the same determinacy measure as the tables above: every record reached the reduce, so'
      + ' the relation over every pair is determined. Note what the needle row costs by'
      + ' comparison: grep narrows to the one piece that mentions the record, so a linear question'
      + ` is one sub-call and the quadratic one is ${corpus.n}. Fan-out is concurrent —`
      + ` ${speedup}x against the same program run sequentially at`
      + ` ${scheduling.delayMs}ms of synthetic per-call latency, which measures the scheduler`
      + ' rather than a provider\'s queue.'
      + (livePrograms === null
        ? ' The live columns are absent because the live tier was skipped on the machine that'
          + ' generated this file.'
        : ` The cheap tier authored ${livePrograms.authored.compiled}/${livePrograms.authored.trials}`
          + ' programs that compile'
          + (livePrograms.executed === null
            ? ', and the piece work was not run within the spend guard.'
            : `, and answering ${livePrograms.executed.subcalls} sub-calls itself it reached`
              + ` ${livePrograms.executed.valuesReached}/${corpus.n} values and got the pair`
              + ` ${livePrograms.executed.scored ? 'right' : 'wrong'}.`)),
  };
}

//#endregion

async function main() {
  const env = readAiEnv();
  const config = {
    ...env,
    model: flags.model ?? env.model,
    trials: flags.quick ? 1 : (flags.trials ?? env.trials),
  };

  const corpus = makeCorpus({ n: flags.rounds, seed: flags.seed });
  const ceilings = await runCeilings(corpus);
  const programs = await runPrograms(corpus);
  const scheduling = await runScheduling(corpus);
  const depths = await runDepths(corpus);

  // the live tier is opt-in and never mandatory; the line below always
  // prints, so a run can never be mistaken for one that measured a model
  let live = null;
  let livePrograms = null;
  let skipped = null;
  if (!flags.live) {
    skipped = env.live
      ? '--live not requested (the model-free ceilings above are the whole run)'
      : `${env.reason}, and --live not requested`;
  }
  else if (!env.live) {
    skipped = env.reason;
  }
  else if (config.model === '') {
    skipped = `no model — set ${AI_ENV.model} or pass --model`;
  }
  else {
    live = await runLive(corpus, ceilings, config);
    livePrograms = await runLivePrograms(corpus, config);
  }

  printTables(corpus, ceilings, live, config);
  printPrograms(corpus, programs, scheduling, livePrograms);
  printDepths(depths);

  if (live === null) {
    console.log(`live tier skipped: ${skipped}`);
  }
  else {
    console.log(`live tier: ${describeAiEnv(config)}`);
    console.log(`  ${live.asked} questions asked, ${live.calls} model calls, `
      + `${live.usage.prompt} prompt + ${live.usage.completion} completion tokens`);
    // the number that says whether the ledger rows were answered THROUGH
    // the mechanism or merely in its presence. Zero is a finding, not an
    // omission, and it is printed either way.
    console.log(`  ${live.recalls} recall tool call(s) across the ledger rows`
      + (live.recalls === 0
        ? ' — every ledger answer above was read off what was still in the request,'
          + ' so this tier did not exercise the recovery path'
        : ''));
    const pricing = await fetchPricing(config);
    console.log(pricing === null
      ? '  cost estimate: unavailable (this provider publishes no per-token price for the model)'
      : `  cost estimate: $${(live.usage.prompt * pricing.prompt
        + live.usage.completion * pricing.completion).toFixed(4)}`
        + ' (usage x the provider\'s published price, fetched at run time)');
    if (live.bounded !== null) console.log(`  spend guard: ${live.bounded}`);
    if (live.failed > 0) {
      console.log(`  ${live.failed} of ${live.asked} question(s) failed`
        + ` (first ${Math.min(live.errors.length, live.failed)} shown); a row whose trials all`
        + ' failed keeps a null actual rather than a guessed one:');
      for (const error of live.errors) console.log(`    ${error}`);
    }
  }

  // the synopsis-fidelity line: how lossy one cut actually is
  const perRound = JSON.stringify({
    id: corpus.ids[0], value: corpus.values[0], notes: 'x'.repeat(flags.padding),
  }).length;
  console.log(`\n# a dropped tool round enters at ~${perRound} chars and leaves as one line whose`);
  console.log(`# result excerpt is hard-capped at 60 => ~${(60 / perRound * 100).toFixed(1)}%`
    + ' of the result text survives a cut.');

  if (flags.output === 'json' && flags.filepath !== null) {
    const rows = jsonRows(corpus, ceilings, live, config);
    // the row where the defect is most visible, derived rather than
    // hand-picked: the widest gap between ids kept and values kept
    const worst = ceilings
      .filter((r) => r.shape === 'late' && r.compacted && r.variant === 'synopsis')
      .reduce((a, b) => (a === null
        || b.idPresent - b.valuePresent > a.idPresent - a.valuePresent ? b : a), null);
    // the same row with a ledger under it — the pair a reader compares
    const paired = worst === null ? null : ceilings.find((r) => r.variant === 'ledger'
      && r.shape === worst.shape && r.budget === worst.budget);
    // compacting rows whose context still DETERMINES the pairwise answer.
    // Derived, and named in the headline rather than smoothed over: the
    // campaign's claim is that this stays empty until an environment
    // exists, so a row that lands in it has to be visible and explained.
    const determined = ceilings.filter((r) => r.compacted && r.ceilings.pairwise === 1)
      .map((r) => `${r.variant}/${r.shape}@${r.budget}`);
    // this IS the published document — `benchmark/website-data.js` passes
    // it through untouched, so the file shape is defined here and nowhere
    // else
    const payload = {
      meta: {
        suite: 'long-horizon',
        title: 'Long-horizon context retention',
        description: 'What the agent\'s history compaction keeps and what it destroys:'
          + ' a needle question over one record and a pairwise question over every pair,'
          + ' each as a model-free ceiling and as a live model\'s score.',
        date: new Date().toISOString(),
        node: process.version,
        n: corpus.n,
        seed: corpus.seed,
        padding: flags.padding,
        budgets: flags.budgets,
        model: live === null ? null : config.model,
        trials: live === null ? 0 : config.trials,
        liveSkipped: skipped,
        asked: live?.asked ?? 0,
        calls: live?.calls ?? 0,
        recalls: live?.recalls ?? 0,
        failed: live?.failed ?? 0,
        usage: live?.usage ?? null,
        errors: live?.errors ?? [],
        bounded: live?.bounded ?? null,
        // the program tier's two model-free facts that are not rows: how
        // much concurrency bought, and — the D8 number — whether the
        // cheap tier can author a plan that COMPILES. Both live in meta
        // because a fact quoting them must not have to parse a table's
        // prose to find them.
        scheduling,
        // the cost curve depth buys, as an order statistic rather than a
        // mean (D7 / HORIZON_08 §5)
        depths,
        authoring: livePrograms === null ? null : {
          trials: livePrograms.authored.trials,
          compiled: livePrograms.authored.compiled,
          generations: livePrograms.authored.attempts,
          errors: livePrograms.authored.errors,
          subcalls: livePrograms.executed?.subcalls ?? 0,
          subcallsFailed: livePrograms.executed?.failed ?? 0,
          valuesReached: livePrograms.executed?.valuesReached ?? null,
          scored: livePrograms.executed?.scored ?? null,
          calls: livePrograms.calls,
          usage: livePrograms.usage,
          bounded: livePrograms.bounded,
          // per-depth: the D8 number HORIZON_08 is judged on
          depths: livePrograms.depths,
        },
      },
      headline: {
        title: 'Compaction that moves instead of destroying — and the one number it does not fix',
        text: `Driving the real createAgent through ${corpus.n} tool rounds of ~${perRound}-character`
          + ' results, and asking what reached the model.'
          + (worst === null ? '' : ` At budget ${worst.budget} the realistic payload shape keeps`
            + ` ${worst.idPresent}/${corpus.n} record ids but only ${worst.valuePresent}/${corpus.n}`
            + ' of their values — the synopsis remembers that a tool was called and loses what it'
            + ' returned. The gap between those two columns is the defect.')
          + (paired === null ? '' : ` Given a ledger, the same run at the same budget archives every`
            + ' dropped round to an addressed slot before writing the synopsis, and'
            + ` ${paired.valueRecoverable}/${corpus.n} of the values come back — verbatim where they`
            + ' still fit, and one `recall` call away where they do not. What it costs is a little'
            + ` of what fits verbatim (${paired.valuePresent}/${corpus.n} against`
            + ` ${worst.valuePresent}/${corpus.n}): the addresses are paid for out of the same`
            + ' budget.')
          + ' The pairwise task, a relation over every pair, stops being DETERMINED the instant one'
          + ' round is cut, and the ledger does not change that: forty rounds fetched one at a time'
          + ' do not fit the budget they were cut to fit, so recall is the wrong shape of answer'
          + ' for it and an external environment is what will move it.'
          + (determined.length === 0
            ? ' Its ceiling is 0% at every budget that compacts anything, with a ledger or without.'
            : ` Its ceiling is 0% at every budget that compacts anything except ${determined.join(', ')}`
              + ' — rows where the whole corpus happened to still fit, which is the payload shape'
              + ' being generous rather than a relation being recovered.')
          + ' A model may still name the right pair out of whatever survived — the last column says'
          + ' when that was available, so a lucky score cannot be read as a recovered one.'
          + ` And it moves: given the same corpus as an ENVIRONMENT, a compiled program visits`
          + ` every record by address and answers the pairwise question at`
          + ` ${pct(programs[0].pairwise.ceiling)} while the root carries`
          + ` ${programs[0].pairwise.rootChars} characters against a corpus of`
          + ` ${programs[0].pairwise.corpusChars} — the bottom table.`,
      },
      tables: [
        ...displayTables(corpus, ceilings, live, config),
        programTable(corpus, programs, scheduling, livePrograms),
      ],
      rows: [...rows, ...programRows(corpus, programs, livePrograms, config)],
    };
    writeFileSync(flags.filepath, JSON.stringify(payload, null, 1));
    console.log(`\nwrote ${flags.filepath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
