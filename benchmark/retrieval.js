#!/usr/bin/env node
//@ts-check
/**
 * Retrieval benchmark — did the right memory reach the prompt?
 *
 * `@jarenjs/ai`'s `recall()` is tag match and recency by default, and
 * ranks by meaning only through an injected embedder (`recall({ near })`,
 * refused without the seam). This is the measurement both stand on.
 * Over a seeded ledger corpus with gold labels
 * (`benchmark/fixtures/retrieval-corpus.json`, from
 * `scripts/generate-retrieval-corpus.js`) it scores, per policy, whether
 * the right memory reached the prompt:
 *
 *   recall@k — the fraction of questions with at least one gold memory in
 *              the policy's top k, for k = 1, 5, 10;
 *   MRR      — the mean reciprocal rank of the best-ranked gold memory;
 *   latency  — the median and p95 of one retrieval call.
 *
 * Five rows, at two corpus sizes (1 000 and 10 000 memories, one question
 * set): `oracle` (the gold ids first — the 1.000 row that proves the
 * scorer and catches a corpus whose gold ids do not exist), `random` (a
 * seeded draw — the floor, checked against its analytic value), `recency`
 * (the newest k), `tag+recency` — the default: the question's words that
 * are corpus tags, fed to the REAL `ledger.recall({ tags, limit })` over a
 * real ledger loaded through `addMemory` — and `near`: the ranked path,
 * `ledger.recall({ near: question, limit })` over the SAME ledger swept
 * through `embedMissing()` with the deterministic reference embedder
 * (`createHashEmbedder`, hashed character trigrams, 64 dims). Nothing is
 * simulated; every row scores the shipped code path.
 *
 * Read the `near` row for what it is. The reference embedder is LEXICAL
 * — two texts score high when they share letters, not meaning — so its
 * row says whether the ranked MECHANISM (sweep, identity check, cosine
 * rank, tie-break, limit) finds the right record among distractors, and
 * nothing about what an embedding model would do. Embedding quality
 * belongs to a real model behind the same seam, which is what `--live`
 * measures. Whichever way the deterministic row falls against
 * `tag+recency`, it is published; on this corpus a lexical ranker is
 * exactly the kind of signal the same-words distractors are built to
 * defeat.
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
 * `--live` scores a SECOND ranked row, `near-live`, through the provider
 * `lib/env.js` resolves (`readAiEnv`) and the `/embeddings` model in
 * `JAREN_AI_EMBED_MODEL`: the corpus is loaded into a second ledger
 * (one ledger holds one vector identity — a mixture is refused), swept
 * through `createEmbeddingClient` in batches of 128, and every question
 * is embedded once. The model id prints beside the row and lands in
 * `meta.live`; the deterministic rows are exactly what they are without
 * the flag. The spend guard `JAREN_AI_MAX_CALLS` is honoured up front —
 * a size that would need more embedding calls than the ceiling allows is
 * skipped with that reason, not half-spent — and a missing key or model
 * is a stated skip, never a failure. It is never a test dependency, and
 * the tracked `retrieval.json` is always generated without it.
 *
 * Live smoke recipe (any OpenAI-compatible provider; ~30 calls at 1 000):
 *
 *   JAREN_AI_PROVIDER=ollama JAREN_AI_EMBED_MODEL=nomic-embed-text \
 *     node --env-file-if-exists=.env benchmark/retrieval.js --live --sizes 1000
 *
 * or OpenRouter with `OPENROUTER_AI_KEY` set and
 * `JAREN_AI_EMBED_MODEL=openai/text-embedding-3-small` (then
 * `JAREN_AI_MAX_CALLS=400` covers 10 000 memories: 79 sweep batches plus
 * 160 questions).
 */

import { writeFileSync } from 'node:fs';

import { createEmbeddingClient, probeEmbeddings } from '@jarenjs/ai';

import { readAiEnv, describeAiEnv } from './lib/env.js';
import { formatNs } from './lib/fmt.js';
import { KS, LIVE_BATCH, POLICY_SEED, loadCorpus, runSize } from './lib/retrieval.js';
import { createDbStorage } from './lib/ledger-db.js';
import { REPLAY_CACHE_DIR, createFileReplayCache } from './lib/replay-cache.js';

//#region flags

function parseArgs(argv) {
  const options = {
    live: false,
    fresh: false,
    store: null,
    verbose: false,
    sizes: null,
    seed: POLICY_SEED,
    output: 'console',
    filepath: null,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--store=')) {
      options.store = argv[i].slice('--store='.length);
      if (options.store !== 'db') {
        console.error(`Unknown store '${options.store}': the only durable one is 'db' (@jarenjs/db).`);
        process.exit(2);
      }
      continue;
    }
    switch (argv[i]) {
      case '--live': options.live = true; break;
      case '--fresh': options.fresh = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--sizes': options.sizes = argv[++i].split(',').map((s) => parseInt(s.trim(), 10)); break;
      case '--seed': options.seed = parseInt(argv[++i], 10); break;
      case '--output': case '-o': options.output = argv[++i]; break;
      case '--filepath': case '-f': options.filepath = argv[++i]; break;
      case '--help': case '-h':
        console.log('Usage: node benchmark/retrieval.js [options]\n');
        console.log('  --sizes a,b         corpus sizes to score (default: every size the corpus carries)');
        console.log(`  --seed N            the random policy's seed (default ${POLICY_SEED})`);
        console.log('  --live              add the near-live row: rank through the live /embeddings provider (lib/env.js, JAREN_AI_EMBED_MODEL)');
        console.log(`  --fresh             live tier: ignore the replay store under ${REPLAY_CACHE_DIR} (what is bought is still remembered)`);
        console.log('  --store=db          add the durable rows: the same corpus through a @jarenjs/db adapter, ranked by its vector column and by the sweep');
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

const labelled = process.argv.some((arg) => arg === '--dataset' || arg.startsWith('--dataset='));
const flags = labelled ? null : parseArgs(process.argv);

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
    + ` (${result.untagged} name no tag), one top-${Math.max(...KS)} call per question;`
    + ` swept ${thousands(result.ranked.embedded)} memories through ${result.ranked.model} in ${ms(result.ranked.sweepMs)}`
    + (result.live === null ? '' : ` and through ${result.live.model} (${result.live.dims} dims) in ${ms(result.live.sweepMs)}`));
  const width = Math.max(30, ...result.policies.map((policy) => policy.label.length + 1));
  console.log(`  ${HEAD[0].padEnd(width)} ${HEAD.slice(1).map((h) => h.padStart(9)).join(' ')}`);
  for (const policy of result.policies) {
    console.log(`  ${policy.label.padEnd(width)} ${[
      ...KS.map((k) => fmt3(policy.recall[k])), fmt3(policy.mrr), ms(policy.latencyMs), ms(policy.latencyP95Ms),
    ].map((c) => c.padStart(9)).join(' ')}`);
  }
  console.log(`  ${'random floor (analytic)'.padEnd(width)} ${KS.map((k) => fmt3(result.floor[k]).padStart(9)).join(' ')}`);
  if (result.durable !== null && result.durable !== undefined) {
    console.log(`  durable store: ${thousands(result.n)} memories written through the adapter in`
      + ` ${ms(result.durable.loadMs)}, swept in ${ms(result.durable.sweepMs)};`
      + ` the ranked rows agree with the in-memory ones column for column, which is the gate`);
  }
}

/** The published table for one size, in the shape the benchmarks page renders. */
function tableFor(result) {
  const rows = result.policies.map((policy) => ({
    datasetClass: 'synthetic',
    embeddingClass: policy.key === 'near-live' ? 'live' : policy.key.startsWith('near') ? 'hash' : 'none',
    cells: [policy.label, ...KS.map((k) => fmt3(policy.recall[k])), fmt3(policy.mrr),
      ms(policy.latencyMs), ms(policy.latencyP95Ms)],
    // the two policies a consumer chooses between: the default, and
    // the seam-gated ranked path
    strong: policy.key === 'tag+recency' || policy.key === 'near',
  }));
  rows.push({ cells: ['random floor (analytic)', ...KS.map((k) => fmt3(result.floor[k])), '—', '—', '—'], strong: false });
  return {
    title: `${thousands(result.n)} memories, ${result.questions.length} questions`,
    head: HEAD,
    rows,
    note: `recall@k is the fraction of questions with a gold memory in the top k; MRR is the mean`
      + ` reciprocal rank of the best-ranked gold memory; latency is one recall call over the real ledger.`
      + ` ${result.untagged} of the ${result.questions.length} questions never name a tag, and for those`
      + ' tag+recency IS recency. The near row ranks by cosine through the seam over the same ledger,'
      + ` swept with the deterministic ${result.ranked.model} reference embedder (lexical, not semantic —`
      + ' a mechanism score, not a model-quality claim).'
      + (result.live === null ? '' : ` The near-live row embeds through ${result.live.model} (${result.live.dims} dims).`)
      + (result.durable == null ? ''
        : ' The durable rows run the same corpus through a @jarenjs/db storage adapter: the'
          + ' near-db row is answered by the store\'s k-nearest plan over a packed vector column,'
          + ' near-db-sweep by the ledger reading every record back. Their quality columns are'
          + ' asserted equal to the in-memory rows\', so only the latency column moves.')
      + ' The oracle row is the scorer\'s proof; the analytic floor is what a uniform draw expects.',
  };
}

/** One flat published row per policy (plus the floor) per size. */
function rowsFor(result) {
  const rows = result.policies.map((policy) => ({
    datasetClass: 'synthetic',
    embeddingClass: policy.key === 'near-live' ? 'live' : policy.key.startsWith('near') ? 'hash' : 'none',
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
    datasetClass: 'synthetic',
    embeddingClass: 'none',
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
  + ' understands language. The near row ranks through the deterministic hashed-trigram reference'
  + ' embedder, which is lexical, not semantic; only a near-live row (--live) involves a model, and its'
  + ' quality is the provider\'s, not this suite\'s.';

/**
 * The live tier's embedder, or the reason there is none. Probes the
 * wire once (one attempt, five seconds) so a wrong key, URL or model
 * is one stated skip rather than a retried failure inside the sweep.
 * @param {boolean} fresh - ignore the replay store (still remember what is bought)
 * @returns {Promise<{ embedder: any, provider: string, maxCalls: number, reason: null }
 *   | { embedder: null, reason: string }>}
 */
async function liveEmbedder(fresh) {
  const env = readAiEnv();
  if (!env.live) return { embedder: null, reason: env.reason ?? 'no live configuration' };
  if (env.embedModel === '') return { embedder: null, reason: 'no embedding model — set JAREN_AI_EMBED_MODEL in .env (see .env.example)' };
  const options = { provider: env.provider, baseUrl: env.baseUrl, apiKey: env.apiKey, model: env.embedModel };
  const probe = await probeEmbeddings(options);
  if (!probe.ok) return { embedder: null, reason: `the /embeddings probe failed for ${env.provider} · ${env.embedModel}: ${probe.error}` };
  console.log(`live tier: ${describeAiEnv(env)}; embeddings via ${env.embedModel} (${probe.dims} dims)`);
  // every vector the tier buys is remembered under benchmark/cache/, so a
  // second run over the same corpus and model makes no embedding call
  const cache = createFileReplayCache(REPLAY_CACHE_DIR, { fresh });
  return { embedder: createEmbeddingClient({ ...options, dims: probe.dims, cache }), provider: env.provider, maxCalls: env.maxCalls, reason: null };
}

async function main() {
  const corpus = loadCorpus();
  const sizes = flags.sizes ?? corpus.sizes;

  // the live tier: a line always prints, so a run can never be mistaken
  // for one that scored a live model when it did not
  const live = flags.live ? await liveEmbedder(flags.fresh) : { embedder: null, reason: '--live not requested' };
  /** @type {string[]} */
  const liveNotes = [];

  // every size is scored and gated BEFORE anything prints: a scorer that
  // failed its own oracle would otherwise have already published a table
  const results = [];
  for (const size of sizes) {
    /** @type {{ embedder: any, label: string } | null} */
    let liveAt = null;
    if (live.embedder !== null) {
      // the spend guard, honoured up front: a size whose sweep plus
      // questions would exceed the ceiling is skipped whole, never half-spent
      const calls = Math.ceil(size / LIVE_BATCH) + corpus.questions.length;
      if (calls > live.maxCalls) {
        liveNotes.push(`${thousands(size)} memories skipped: ${calls} embedding calls exceed JAREN_AI_MAX_CALLS=${live.maxCalls}`);
      }
      else liveAt = { embedder: live.embedder, label: `near-live (${live.embedder.model}, ${live.provider})` };
    }
    const result = await runSize(corpus, size, { seed: flags.seed, live: liveAt,
      store: flags.store === 'db' ? (dims) => createDbStorage({ dims }) : null });
    results.push(result);
  }
  const liveRan = results.filter((r) => r.live !== null);
  const liveSkipped = live.embedder === null
    ? live.reason
    : liveRan.length === 0
      ? liveNotes.join('; ')
      : `not skipped — near-live scored through ${live.provider} · ${live.embedder.model} at`
        + ` ${liveRan.map((r) => thousands(r.n)).join(' and ')} memories`
        + (liveNotes.length === 0 ? '' : `; ${liveNotes.join('; ')}`);

  for (const result of results) {
    printSize(result);
    if (flags.verbose) printMisses(result);
  }
  console.log(`\nscorer gate: oracle 1.000 at every k, random inside its analytic band, at every size`);
  console.log(`corpus seed ${corpus.seed}, policy seed ${flags.seed}; ${corpus.facts.length} facts over`
    + ` ${corpus.topics.length} topics, ${corpus.questions.length} questions`);
  console.log(`durable store: ${flags.store === null
    ? '--store not requested; every row is over the ledger\'s in-memory adapter'
    : `the ${flags.store} rows ran, and their quality columns are asserted equal to the in-memory ones`}`);
  console.log(`live tier: ${liveSkipped}`);
  console.log(`\n# ${NOTE}`);

  if (flags.output === 'json' && flags.filepath !== null) {
    const largest = results[results.length - 1];
    const smallest = results[0];
    const at = (result, key) => result.policies.find((p) => p.key === key);
    const top = Math.max(...KS);
    const incumbent = at(largest, 'tag+recency');
    const near = at(largest, 'near');
    const nearSmall = at(smallest, 'near');
    const recency = at(largest, 'recency');
    const random = at(largest, 'random');
    const liveMeta = liveRan.length === 0 ? {} : {
      live: {
        provider: live.provider,
        model: /** @type {any} */ (live.embedder).model,
        dims: liveRan[0].live.dims,
        sizes: liveRan.map((r) => r.n),
      },
    };
    // the comparison, derived — whichever way it fell
    const ahead = near.recall[top] > incumbent.recall[top];
    const tied = near.recall[top] === incumbent.recall[top];
    // this IS the published document — `benchmark/website-data.js` passes
    // it through untouched, so the file shape is defined here and nowhere
    // else
    const payload = {
      meta: {
        suite: 'retrieval',
        datasetClass: 'synthetic',
        metricDefinition: 'legacy recall@k is hit rate, not fractional labelled recall',
        title: 'Retrieval — did the right memory reach the prompt',
        description: 'Whether the ledger\'s recall puts the right memory in the prompt: recall@k, MRR'
          + ' and latency for random, recency, tag match plus recency (the default) and the'
          + ' seam-gated ranked path (near, through the deterministic reference embedder) — against'
          + ' an oracle ceiling, over a seeded synthetic corpus at two sizes.',
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
        ranked: { model: largest.ranked.model, dims: largest.ranked.dims },
        ...liveMeta,
        liveSkipped,
        note: NOTE,
      },
      headline: {
        title: 'Tag match and recency, and the ranked path beside it — both scored, whichever way they fell',
        text: `Over ${thousands(largest.n)} memories and ${corpus.questions.length} questions, the default`
          + ` recall — tag match, then recency — puts a gold memory in the top ${top} for`
          + ` ${pct(incumbent.recall[top])} of questions and in first place for ${pct(incumbent.recall[1])}`
          + ` (MRR ${fmt3(incumbent.mrr)}). The ranked path — recall({ near }) through the seam, over the`
          + ` same ledger swept with the deterministic ${largest.ranked.model} reference embedder — reaches`
          + ` ${pct(near.recall[top])} in the top ${top} and ${pct(near.recall[1])} in first place`
          + ` (MRR ${fmt3(near.mrr)}), ${tied ? 'level with' : ahead ? 'ahead of' : 'behind'} the default`
          + ` at this size; at ${thousands(smallest.n)} memories the two read`
          + ` ${pct(at(smallest, 'tag+recency').recall[top])} and ${pct(nearSmall.recall[top])}.`
          + ' That reference embedder is lexical — hashed character trigrams, no model — so its row is a'
          + ' mechanism score: the sweep, the identity check, the cosine rank and the tie-break work end to'
          + ' end over the shipped code path, and the same-words distractors are exactly what a lexical'
          + ' signal cannot tell apart. Embedding quality belongs to a real model behind the same seam,'
          + ' which is what the --live tier measures and which is never published as this suite\'s own.'
          + ` Recency alone manages ${pct(recency.recall[top])} and a seeded random draw`
          + ` ${pct(random.recall[top])}, against an analytic floor of ${pct(largest.floor[top])}; the`
          + ` oracle row is 1.000 everywhere, which is what proves the scorer. ${largest.untagged} of the`
          + ` ${corpus.questions.length} questions never name a tag, and for those the default IS recency.`
          + ` The corpus is synthetic — statements composed from ${corpus.topics.length} topic`
          + ' vocabularies, with same-tag and same-words distractors — so read every row as a mechanism:'
          + ' whether a policy can find the right record among distractors, not whether a model'
          + ' understands language.',
      },
      tables: results.map(tableFor),
      rows: results.flatMap(rowsFor),
    };
    writeFileSync(flags.filepath, JSON.stringify(payload, null, 1));
    console.log(`\nwrote ${flags.filepath}`);
  }
}

(labelled ? import('./recall-quality.js').then((runner) => runner.main()) : main()).catch((error) => {
  console.error(error);
  process.exit(1);
});
