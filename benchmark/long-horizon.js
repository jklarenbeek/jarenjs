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

import { createAgent, createLedger } from '@jarenjs/ai';
import { createChatClient } from '@jarenjs/ai/client';
import { resolveEndpoint } from '@jarenjs/ai/providers';

import { readAiEnv, describeAiEnv, mapLimit, AI_ENV } from './lib/env.js';
import {
  DEFAULTS, SHAPES, makeCorpus, needleTargets, probe, ceilingFor,
  needleQuestion, pairwiseQuestion, scoreNeedle, scorePairwise,
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
    const response = await fetch(endpoint.url.replace(/\/chat\/completions$/, '/models'), {
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

  // the live tier is opt-in and never mandatory; the line below always
  // prints, so a run can never be mistaken for one that measured a model
  let live = null;
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
  }

  printTables(corpus, ceilings, live, config);

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
          + ' when that was available, so a lucky score cannot be read as a recovered one.',
      },
      tables: displayTables(corpus, ceilings, live, config),
      rows,
    };
    writeFileSync(flags.filepath, JSON.stringify(payload, null, 1));
    console.log(`\nwrote ${flags.filepath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
