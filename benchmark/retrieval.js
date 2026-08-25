#!/usr/bin/env node
//@ts-check
/**
 * Retrieval benchmark — did the right memory reach the prompt?
 *
 * `@jarenjs/ai`'s `recall()` is tag match and recency, and its README
 * says so: there is no ranker because no measurement says one is needed.
 * This is that measurement. Over a seeded ledger corpus with gold labels
 * (`benchmark/fixtures/retrieval-corpus.json`, from
 * `scripts/generate-retrieval-corpus.js`) it scores, per policy, whether
 * the right memory reached the prompt:
 *
 *   recall@k — the fraction of questions with at least one gold memory in
 *              the policy's top k, for k = 1, 5, 10;
 *   MRR      — the mean reciprocal rank of the best-ranked gold memory;
 *   latency  — the median and p95 of one retrieval call.
 *
 * Four rows, at two corpus sizes (1 000 and 10 000 memories, one question
 * set): `oracle` (the gold ids first — the 1.000 row that proves the
 * scorer and catches a corpus whose gold ids do not exist), `random` (a
 * seeded draw — the floor, checked against its analytic value), `recency`
 * (the newest k) and `tag+recency` — the incumbent: the question's words
 * that are corpus tags, fed to the REAL `ledger.recall({ tags, limit })`
 * over a real ledger loaded through `addMemory`. Nothing is simulated;
 * the table scores the shipped code path.
 *
 * The scorer is gated before any number prints: the oracle row must be
 * exactly 1.000 at every k, and the random row must sit inside its
 * analytic band. A run that fails either exits 1 with the row named —
 * the same equivalence-before-timing rule the engine head-to-heads use.
 *
 * Read the published note before the numbers: the corpus is SYNTHETIC.
 * Statements are composed from twenty topic vocabularies, and the
 * distractors are built to defeat one cheap signal each — the same tag
 * with a different fact, and the same words with a different fact. The
 * numbers therefore measure whether a POLICY can find the right record
 * among distractors — a mechanism — and say nothing about whether any
 * model understands language.
 *
 *   node benchmark/retrieval.js                           # both sizes
 *   node benchmark/retrieval.js --sizes 1000              # one size
 *   node benchmark/retrieval.js --output json --filepath out.json
 *   node --env-file-if-exists=.env benchmark/retrieval.js --live
 *
 * `--live` is RESERVED, and its contract is fixed now so a ranked policy
 * extends it rather than inventing a flag: when a policy exists that
 * ranks by an embedding, `--live` scores it through the provider that
 * `lib/env.js` resolves (`readAiEnv`), prints the model id beside its
 * row, and leaves the deterministic rows exactly as they are. No such
 * policy exists yet, so today the flag is accepted, the run says it did
 * nothing with it, and the deterministic table is the whole run. It is
 * never a test dependency, and a missing key is never a failure.
 */

import { writeFileSync } from 'node:fs';

import { formatNs } from './lib/fmt.js';
import { KS, POLICY_SEED, loadCorpus, runSize } from './lib/retrieval.js';

//#region flags

function parseArgs(argv) {
  const options = {
    live: false,
    verbose: false,
    sizes: null,
    seed: POLICY_SEED,
    output: 'console',
    filepath: null,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--live': options.live = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--sizes': options.sizes = argv[++i].split(',').map((s) => parseInt(s.trim(), 10)); break;
      case '--seed': options.seed = parseInt(argv[++i], 10); break;
      case '--output': case '-o': options.output = argv[++i]; break;
      case '--filepath': case '-f': options.filepath = argv[++i]; break;
      case '--help': case '-h':
        console.log('Usage: node benchmark/retrieval.js [options]\n');
        console.log('  --sizes a,b         corpus sizes to score (default: every size the corpus carries)');
        console.log(`  --seed N            the random policy's seed (default ${POLICY_SEED})`);
        console.log('  --live              reserved: scores a ranked policy through the live provider once one exists');
        console.log('  --verbose, -v       print every question the incumbent missed at the largest k');
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

//#region display

const fmt3 = (x) => x.toFixed(3);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const ms = (x) => formatNs(x * 1e6);
const thousands = (n) => n.toLocaleString('en-US');

const HEAD = ['policy', ...KS.map((k) => `recall@${k}`), 'MRR', 'median', 'p95'];

/** The console table for one size. */
function printSize(result) {
  console.log(`\nretrieval — ${thousands(result.n)} memories, ${result.questions.length} questions`
    + ` (${result.untagged} name no tag), one top-${Math.max(...KS)} call per question`);
  const width = 30;
  console.log(`  ${HEAD[0].padEnd(width)} ${HEAD.slice(1).map((h) => h.padStart(9)).join(' ')}`);
  for (const policy of result.policies) {
    console.log(`  ${policy.label.padEnd(width)} ${[
      ...KS.map((k) => fmt3(policy.recall[k])), fmt3(policy.mrr), ms(policy.latencyMs), ms(policy.latencyP95Ms),
    ].map((c) => c.padStart(9)).join(' ')}`);
  }
  console.log(`  ${'random floor (analytic)'.padEnd(width)} ${KS.map((k) => fmt3(result.floor[k]).padStart(9)).join(' ')}`);
}

/** The published table for one size, in the shape the benchmarks page renders. */
function tableFor(result) {
  const rows = result.policies.map((policy) => ({
    cells: [policy.label, ...KS.map((k) => fmt3(policy.recall[k])), fmt3(policy.mrr),
      ms(policy.latencyMs), ms(policy.latencyP95Ms)],
    strong: policy.key === 'tag+recency',
  }));
  rows.push({ cells: ['random floor (analytic)', ...KS.map((k) => fmt3(result.floor[k])), '—', '—', '—'], strong: false });
  return {
    title: `${thousands(result.n)} memories, ${result.questions.length} questions`,
    head: HEAD,
    rows,
    note: `recall@k is the fraction of questions with a gold memory in the top k; MRR is the mean`
      + ` reciprocal rank of the best-ranked gold memory; latency is one recall call over the real ledger.`
      + ` ${result.untagged} of the ${result.questions.length} questions never name a tag, and for those`
      + ' tag+recency IS recency. The oracle row is the scorer\'s proof; the analytic floor is what a'
      + ' uniform draw expects.',
  };
}

/** One flat published row per policy (plus the floor) per size. */
function rowsFor(result) {
  const rows = result.policies.map((policy) => ({
    size: result.n,
    policy: policy.key,
    label: policy.label,
    questions: policy.questions,
    recallAt1: policy.recall[1],
    recallAt5: policy.recall[5],
    recallAt10: policy.recall[10],
    mrr: policy.mrr,
    latencyMs: policy.latencyMs,
    latencyP95Ms: policy.latencyP95Ms,
  }));
  rows.push({
    size: result.n,
    policy: 'floor',
    label: 'random floor (analytic)',
    questions: result.questions.length,
    recallAt1: result.floor[1],
    recallAt5: result.floor[5],
    recallAt10: result.floor[10],
    mrr: null,
    latencyMs: null,
    latencyP95Ms: null,
  });
  return rows;
}

/** The questions the incumbent missed at the largest k, for `--verbose`. */
function printMisses(result) {
  const incumbent = result.policies.find((p) => p.key === 'tag+recency');
  if (incumbent === undefined) return;
  console.log(`\n  tag+recency missed ${incumbent.misses.length} of ${result.questions.length} at`
    + ` k=${Math.max(...KS)} over ${thousands(result.n)} memories:`);
  for (const text of incumbent.misses) console.log(`    ${text}`);
}

//#endregion

const NOTE = 'The corpus is synthetic: statements composed from twenty topic vocabularies, with'
  + ' distractors built to defeat one cheap signal each — the same tag with a different fact, and the'
  + ' same words with a different fact. These numbers measure whether a retrieval POLICY can find the'
  + ' right record among distractors, which is a mechanism; they say nothing about whether any model'
  + ' understands language, and no row here involves one.';

async function main() {
  const corpus = loadCorpus();
  const sizes = flags.sizes ?? corpus.sizes;

  // the reserved tier: the line always prints, so a run can never be
  // mistaken for one that scored a ranked policy
  const liveSkipped = flags.live
    ? 'not applicable: no ranked policy exists yet — --live is reserved for scoring one through the'
      + ' live embedding provider (lib/env.js) beside these deterministic rows'
    : '--live not requested (and not applicable: no ranked policy exists yet)';

  // every size is scored and gated BEFORE anything prints: a scorer that
  // failed its own oracle would otherwise have already published a table
  const results = [];
  for (const size of sizes) {
    const result = await runSize(corpus, size, { seed: flags.seed });
    results.push(result);
  }

  for (const result of results) {
    printSize(result);
    if (flags.verbose) printMisses(result);
  }
  console.log(`\nscorer gate: oracle 1.000 at every k, random inside its analytic band, at every size`);
  console.log(`corpus seed ${corpus.seed}, policy seed ${flags.seed}; ${corpus.facts.length} facts over`
    + ` ${corpus.topics.length} topics, ${corpus.questions.length} questions`);
  console.log(`live tier skipped: ${liveSkipped}`);
  console.log(`\n# ${NOTE}`);

  if (flags.output === 'json' && flags.filepath !== null) {
    const largest = results[results.length - 1];
    const smallest = results[0];
    const at = (result, key) => result.policies.find((p) => p.key === key);
    const top = Math.max(...KS);
    const incumbent = at(largest, 'tag+recency');
    const recency = at(largest, 'recency');
    const random = at(largest, 'random');
    // this IS the published document — `benchmark/website-data.js` passes
    // it through untouched, so the file shape is defined here and nowhere
    // else
    const payload = {
      meta: {
        suite: 'retrieval',
        title: 'Retrieval — did the right memory reach the prompt',
        description: 'Whether the ledger\'s recall puts the right memory in the prompt: recall@k, MRR'
          + ' and latency for the policies that exist today — random, recency and tag match plus'
          + ' recency — against an oracle ceiling, over a seeded synthetic corpus at two sizes.',
        date: new Date().toISOString(),
        node: process.version,
        seed: corpus.seed,
        policySeed: flags.seed,
        sizes: results.map((r) => r.n),
        ks: [...KS],
        topics: corpus.topics.length,
        facts: corpus.facts.length,
        questions: corpus.questions.length,
        untagged: largest.untagged,
        liveSkipped,
        note: NOTE,
      },
      headline: {
        title: 'Tag match and recency, scored — the number a ranker would have to beat',
        text: `Over ${thousands(largest.n)} memories and ${corpus.questions.length} questions, today's recall`
          + ` — tag match, then recency — puts a gold memory in the top ${top} for`
          + ` ${pct(incumbent.recall[top])} of questions and in first place for ${pct(incumbent.recall[1])}`
          + ` (MRR ${fmt3(incumbent.mrr)}). Recency alone manages ${pct(recency.recall[top])} and a seeded`
          + ` random draw ${pct(random.recall[top])}, against an analytic floor of`
          + ` ${pct(largest.floor[top])}; the oracle row is 1.000 everywhere, which is what proves the`
          + ` scorer. At ${thousands(smallest.n)} memories the same policy reaches`
          + ` ${pct(at(smallest, 'tag+recency').recall[top])} — the drop to ${thousands(largest.n)} is`
          + ' the size at which the question becomes hard, and the reason the number is published'
          + ` at both. ${largest.untagged} of the ${corpus.questions.length} questions never name a`
          + ' tag, and for those the incumbent IS recency. No ranker exists yet; when one does, its'
          + ' row goes beside these, whichever way it falls. The corpus is synthetic — statements'
          + ` composed from ${corpus.topics.length} topic vocabularies, with same-tag and same-words`
          + ' distractors — so read every row as a mechanism: whether a policy can find the right'
          + ' record among distractors, not whether a model understands language.',
      },
      tables: results.map(tableFor),
      rows: results.flatMap(rowsFor),
    };
    writeFileSync(flags.filepath, JSON.stringify(payload, null, 1));
    console.log(`\nwrote ${flags.filepath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
