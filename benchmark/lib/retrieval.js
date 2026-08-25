//#region retrieval instrument
// The measuring instrument behind `benchmark/retrieval.js`: the corpus
// loader, the retrieval policies, the scorer and the checks that gate
// the scorer before any number is printed. Kept apart from the runner
// so `test/ai/retrieval-corpus.test.js` can drive the same functions
// the published table comes from — a scorer tested through a different
// code path than the one that publishes would be two scorers.
//
// What a policy IS here: `(question, k) → Promise<string[]>`, an ordered
// top-k of memory ids. What "the right memory reached the prompt" means:
// recall@k is the fraction of questions with at least one gold id in the
// top k, and MRR is the mean of 1/rank of the best-ranked gold id (0 when
// none is in the top k). One call at the largest k per question feeds
// every smaller k — the policies order deterministically and `limit`
// slices, so the top-1 is the head of the top-10.
//
// The ledger under `recency`, `tag+recency` and `near` is the REAL one:
// `createLedger()` over its in-memory adapter, loaded through `addMemory`,
// swept through `embedMissing()`, answering through `recall`. That is the
// point of the instrument — it scores the shipped code path, not a model
// of it. The ranked row embeds through the deterministic reference
// embedder (`createHashEmbedder`, hashed character trigrams — LEXICAL,
// not semantic), so the row is reproducible on every host with no
// network and says what the ranked MECHANISM does over this corpus, not
// what an embedding model understands; a live embedder joins as a second
// ranked row only when the runner asks for it.

import { readFileSync } from 'node:fs';

import { createLedger, createHashEmbedder } from '@jarenjs/ai';

import { mulberry32, tokens } from '../../scripts/generate-retrieval-corpus.js';
import { quantile } from './horizon.js';

/** The committed corpus. */
const CORPUS = new URL('../fixtures/retrieval-corpus.json', import.meta.url);

/** The cut-offs every row reports. */
export const KS = [1, 5, 10];

/** The seed the `random` policy draws from; published beside the table. */
export const POLICY_SEED = 1;

/** The width of the deterministic reference embedder behind the `near` row. */
export const HASH_DIMS = 64;

/** How many texts one `embedMissing` batch hands a live embedder — a wire
 * request of this many inputs is well inside every provider's cap. */
export const LIVE_BATCH = 128;

/**
 * Read the committed corpus.
 * @returns {any}
 */
export function loadCorpus() {
  return JSON.parse(readFileSync(CORPUS, 'utf8'));
}

/**
 * The corpus at one of its sizes: the memory prefix of that length and
 * the whole question set. Refuses a size the prefix design cannot
 * answer — every gold id must be inside the prefix, or a question would
 * be scored against a corpus that does not contain its answer.
 * @param {any} corpus
 * @param {number} size
 * @returns {{ size: number, memories: any[], questions: any[], tags: Set<string> }}
 */
export function corpusAt(corpus, size) {
  if (size > corpus.memories.length)
    throw new Error(`the corpus holds ${corpus.memories.length} memories, not ${size}`);
  const memories = corpus.memories.slice(0, size);
  const present = new Set(memories.map((m) => m.id));
  for (const question of corpus.questions) {
    for (const id of question.gold) {
      if (!present.has(id))
        throw new Error(`${question.id} names gold memory ${id}, which is outside the first ${size} memories`);
    }
  }
  return { size, memories, questions: corpus.questions, tags: new Set(corpus.tags) };
}

/**
 * The incumbent's question→tags step: the question's words that are
 * tags of the corpus, in question order, each once. Committed here so
 * the `tag+recency` row is reproducible — a different extraction is a
 * different policy, and would be scored as one.
 * @param {string} text
 * @param {Set<string>} tagSet
 * @returns {string[]}
 */
export function questionTags(text, tagSet) {
  const out = [];
  for (const token of tokens(text)) {
    if (tagSet.has(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * A ledger holding the memories, loaded through the real write path.
 * Every record carries its own id and `at`, so nothing is minted; the
 * batch is a `Promise.all`, which the ledger's write queue serializes.
 * A rejected write is a broken corpus and stops the run.
 *
 * An `embedder` is wired into the ledger (auto-embedding on write stays
 * at its default, off); `sweepLedger` is the separate, explicit step.
 * `storage` is the durable adapter when there is one — absent, the
 * ledger's in-memory default answers, which is what every row scored
 * before `--store` existed.
 * @param {any[]} memories
 * @param {{ embedder?: import('@jarenjs/ai').Embedder, storage?: any }} [options]
 */
export async function loadLedger(memories, options = {}) {
  const ledger = createLedger({ now: () => '2025-12-31T23:59:59Z',
    embedder: options.embedder, storage: options.storage });
  const results = await Promise.all(memories.map((m) => ledger.addMemory(m)));
  const rejected = results.find((r) => /** @type {any} */ (r).error !== undefined);
  if (rejected !== undefined)
    throw new Error(`the ledger rejected a corpus memory: ${JSON.stringify(rejected)}`);
  return ledger;
}

/**
 * The same adapter with only the storage contract's four methods, so a
 * ledger over it reads and ranks for itself. The pair — one store, two
 * ledgers — is what makes the optional `rank` capability's cost and its
 * answer separately measurable.
 * @param {any} adapter
 */
export const fourMethods = (adapter) => ({
  get: adapter.get, set: adapter.set, delete: adapter.delete, keys: adapter.keys,
});

/**
 * Sweep a loaded ledger through `embedMissing()` — the explicit path a
 * host runs once over an existing ledger — and answer the sweep's cost.
 * A sweep that leaves anything un-embedded is a broken run and stops it:
 * a ranked row over a partly-swept ledger would be scoring the sweep,
 * not the policy.
 * @param {any} ledger
 * @param {number} count - how many records the sweep must embed
 * @param {number} [batch] - texts per seam call (the ledger's default when absent)
 * @returns {Promise<{ embedded: number, ms: number }>}
 */
export async function sweepLedger(ledger, count, batch) {
  const start = process.hrtime.bigint();
  const swept = await ledger.embedMissing({ batch });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (swept.error !== undefined || swept.remaining !== 0 || swept.embedded !== count)
    throw new Error(`the sweep embedded ${swept.embedded} of ${count} and left ${swept.remaining}: ${swept.error ?? 'no error given'}`);
  return { embedded: swept.embedded, ms };
}

/**
 * The ranked policy over a swept ledger: `recall({ near: question, limit })`
 * through the ledger's embedder, ids in ranked order. A refusal or a
 * skipped record here is a broken run, not a score — the corpus was
 * swept whole, so the ledger must answer.
 *
 * `via` is asserted when given: a row that claims to measure the store's
 * k-nearest plan and silently swept instead would publish the wrong
 * latency under the right name.
 * @param {any} ledger
 * @param {string} key
 * @param {string} label
 * @param {'sweep' | 'adapter'} [via] - the path this row must have taken
 * @returns {{ key: string, label: string, run: (question: any, k: number) => Promise<string[]> }}
 */
export function rankedPolicy(ledger, key, label, via) {
  return { key, label,
    run: async (question, k) => {
      const result = await ledger.recall({ near: question.text, limit: k });
      if (result.error !== undefined) throw new Error(`${key}: ${result.error}`);
      if (result.skipped !== 0) throw new Error(`${key}: ${result.skipped} memories carried no vector`);
      if (via !== undefined && result.via !== via)
        throw new Error(`${key}: recall answered via '${result.via}', not '${via}'`);
      return result.memories.map((/** @type {any} */ m) => m.id);
    } };
}

/** The default recall, capped — recency, and nothing else. */
export function recencyPolicy(ledger, key, label) {
  return { key, label,
    run: async (_question, k) => {
      const records = await ledger.recall({ limit: k });
      return Array.isArray(records) ? records.map((/** @type {any} */ r) => r.id) : [];
    } };
}

/** The incumbent: the question's words that are tags, then recency. */
export function tagPolicy(ledger, tags, key, label) {
  return { key, label,
    run: async (question, k) => {
      const found = questionTags(question.text, tags);
      const records = await ledger.recall(found.length === 0 ? { limit: k } : { tags: found, limit: k });
      return Array.isArray(records) ? records.map((/** @type {any} */ r) => r.id) : [];
    } };
}

/**
 * The policies scored, in table order. `oracle` is the 1.0 row that
 * proves the scorer and catches a corpus whose gold ids do not exist;
 * `random` is the floor; `recency` and `tag+recency` are what
 * `recall()` does by default, the second being the incumbent; `near`
 * is the seam-gated ranked path over the same ledger, swept by the
 * reference embedder — present only when the ledger was built with one.
 * @param {{ ledger: any, memories: any[], tags: Set<string>, seed?: number,
 *   embedder?: import('@jarenjs/ai').Embedder }} config
 * @returns {Array<{ key: string, label: string, run: (question: any, k: number) => Promise<string[]> }>}
 */
export function makePolicies({ ledger, memories, tags, seed = POLICY_SEED, embedder }) {
  const ids = memories.map((m) => m.id);
  const random = mulberry32(seed);
  return [
    { key: 'oracle', label: 'oracle (gold first)',
      run: async (question) => [...question.gold] },
    { key: 'random', label: 'random',
      run: async (_question, k) => {
        // k distinct draws without replacement; the partial Fisher–Yates
        // over a fresh index list keeps the stream independent of n
        const pool = ids.map((_, i) => i);
        const out = [];
        for (let i = 0; i < k && i < pool.length; i++) {
          const j = i + Math.floor(random() * (pool.length - i));
          [pool[i], pool[j]] = [pool[j], pool[i]];
          out.push(ids[pool[i]]);
        }
        return out;
      } },
    recencyPolicy(ledger, 'recency', 'recency'),
    tagPolicy(ledger, tags, 'tag+recency', 'tag+recency (today\'s recall)'),
    ...(embedder === undefined ? []
      : [rankedPolicy(ledger, 'near', `near (${embedder.model}, ranked)`, 'sweep')]),
  ];
}

/**
 * Score one policy over the question set: one call at the largest k per
 * question, timed, then recall at every k and MRR from that one list.
 * @param {{ run: (question: any, k: number) => Promise<string[]> }} policy
 * @param {any[]} questions
 * @param {number[]} [ks]
 * @returns {Promise<{ recall: Record<number, number>, mrr: number, latencyMs: number, latencyP95Ms: number,
 *   questions: number, misses: string[] }>} `misses` names the questions with no gold id in the top k
 */
export async function scorePolicy(policy, questions, ks = KS) {
  const top = Math.max(...ks);
  const hits = Object.fromEntries(ks.map((k) => [k, 0]));
  let reciprocal = 0;
  const latencies = [];
  const misses = [];
  for (const question of questions) {
    const gold = new Set(question.gold);
    const start = process.hrtime.bigint();
    const ranked = await policy.run(question, top);
    latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
    const rank = ranked.findIndex((id) => gold.has(id));
    if (rank < 0) {
      misses.push(`${question.id} ${question.text}`);
      continue;
    }
    for (const k of ks) {
      if (rank < k) hits[k] += 1;
    }
    reciprocal += 1 / (rank + 1);
  }
  const n = questions.length;
  return {
    recall: Object.fromEntries(ks.map((k) => [k, hits[k] / n])),
    mrr: reciprocal / n,
    latencyMs: quantile(latencies, 0.5),
    latencyP95Ms: quantile(latencies, 0.95),
    questions: n,
    misses,
  };
}

/**
 * The analytic recall@k of a uniformly random top-k over n memories,
 * averaged over the questions: for a question with g gold ids the miss
 * probability of k draws without replacement is Π (n-g-i)/(n-i).
 * @param {any[]} questions
 * @param {number} n
 * @param {number} k
 */
export function randomFloor(questions, n, k) {
  let sum = 0;
  for (const question of questions) {
    const g = question.gold.length;
    let miss = 1;
    for (let i = 0; i < k; i++) miss *= (n - g - i) / (n - i);
    sum += 1 - miss;
  }
  return sum / questions.length;
}

/**
 * The band a seeded random policy must land in: the analytic floor plus
 * or minus four standard errors of the question-level Bernoulli sum,
 * widened by one question's worth so a corpus of a few dozen questions
 * cannot fail on rounding. A random row outside it means the scorer or
 * the draw is broken, not that the seed was unlucky.
 * @param {any[]} questions
 * @param {number} n
 * @param {number} k
 * @returns {{ floor: number, low: number, high: number }}
 */
export function randomBand(questions, n, k) {
  const floor = randomFloor(questions, n, k);
  let variance = 0;
  for (const question of questions) {
    const g = question.gold.length;
    let miss = 1;
    for (let i = 0; i < k; i++) miss *= (n - g - i) / (n - i);
    variance += miss * (1 - miss);
  }
  const sigma = Math.sqrt(variance) / questions.length;
  const slack = 4 * sigma + 1 / questions.length;
  return { floor, low: Math.max(0, floor - slack), high: Math.min(1, floor + slack) };
}

/**
 * The scorer's own gate, run before any table is printed: the oracle
 * row is exactly 1 at every k and in MRR, and the random row sits in its
 * analytic band. Throws naming the row that failed.
 * @param {{ n: number, questions: any[], policies: Array<{ key: string, recall: Record<number, number>, mrr: number }> }} result
 * @param {number[]} [ks]
 */
export function assertScorer(result, ks = KS) {
  const oracle = result.policies.find((p) => p.key === 'oracle');
  const random = result.policies.find((p) => p.key === 'random');
  if (oracle === undefined || random === undefined)
    throw new Error('the oracle and random rows are the scorer\'s gate and both must run');
  for (const k of ks) {
    if (oracle.recall[k] !== 1)
      throw new Error(`oracle recall@${k} is ${oracle.recall[k]} at n=${result.n}, not 1: the scorer or the corpus is broken`);
  }
  if (oracle.mrr !== 1)
    throw new Error(`oracle MRR is ${oracle.mrr} at n=${result.n}, not 1`);
  for (const k of ks) {
    const band = randomBand(result.questions, result.n, k);
    if (random.recall[k] < band.low || random.recall[k] > band.high) {
      throw new Error(`random recall@${k} is ${random.recall[k].toFixed(4)} at n=${result.n}, outside its`
        + ` analytic band [${band.low.toFixed(4)}, ${band.high.toFixed(4)}] around ${band.floor.toFixed(4)}`);
    }
  }
}

/**
 * The durable rows: the SAME corpus loaded through an injected storage
 * adapter, scored by the same policies, plus the two ranked paths that
 * store can take — its own `rank` capability (the k-nearest plan over a
 * vector column) and the ledger's sweep over the same records.
 *
 * Three executors of one ordering, which is why `assertDurable` holds
 * their quality columns to the in-memory rows exactly: a durable path
 * that answered differently would be a different retrieval policy
 * wearing the same name, and only the LATENCY column is allowed to move.
 * @param {{ memories: any[], tags: Set<string> }} at
 * @param {import('@jarenjs/ai').Embedder} embedder
 * @param {(dims: number) => Promise<any>} open - the adapter factory
 */
export async function durablePolicies(at, embedder, open) {
  const adapter = await open(/** @type {number} */ (embedder.dims));
  const start = process.hrtime.bigint();
  const ledger = await loadLedger(at.memories, { embedder, storage: adapter });
  const loadMs = Number(process.hrtime.bigint() - start) / 1e6;
  const sweep = await sweepLedger(ledger, at.memories.length);
  // one store, two ledgers: the second sees only the four methods
  const swept = createLedger({ now: () => '2025-12-31T23:59:59Z',
    embedder, storage: fourMethods(adapter) });
  return {
    adapter,
    durable: { loadMs, sweepMs: sweep.ms, embedded: sweep.embedded, ranked: typeof adapter.rank === 'function' },
    policies: [
      recencyPolicy(ledger, 'recency-db', 'recency (durable store)'),
      tagPolicy(ledger, at.tags, 'tag+recency-db', 'tag+recency (durable store)'),
      rankedPolicy(ledger, 'near-db', 'near (durable store, via adapter)', 'adapter'),
      rankedPolicy(swept, 'near-db-sweep', 'near (durable store, via sweep)', 'sweep'),
    ],
  };
}

/** Which durable row must equal which in-memory row, column for column. */
const DURABLE_TWINS = [
  ['recency-db', 'recency'], ['tag+recency-db', 'tag+recency'],
  ['near-db', 'near'], ['near-db-sweep', 'near'],
];

/**
 * The durable gate: every durable row's quality columns equal its
 * in-memory twin's, exactly. Throws naming the pair that disagreed.
 * @param {{ n: number, policies: Array<{ key: string, recall: Record<number, number>, mrr: number }> }} result
 * @param {number[]} [ks]
 */
export function assertDurable(result, ks = KS) {
  const at = (key) => result.policies.find((p) => p.key === key);
  for (const [durable, memoryRow] of DURABLE_TWINS) {
    const a = at(durable);
    const b = at(memoryRow);
    if (a === undefined || b === undefined) continue;
    for (const k of ks) {
      if (a.recall[k] !== b.recall[k]) {
        throw new Error(`${durable} recall@${k} is ${a.recall[k]} at n=${result.n} and ${memoryRow} is`
          + ` ${b.recall[k]}: two executors of one ordering must agree on every question`);
      }
    }
    if (a.mrr !== b.mrr)
      throw new Error(`${durable} MRR is ${a.mrr} at n=${result.n} and ${memoryRow} is ${b.mrr}`);
  }
}

/**
 * Score every policy at one corpus size and gate the scorer. The
 * deterministic ledger is swept by the reference embedder, so the table
 * carries the `near` row beside the incumbents on every host; a `live`
 * embedder, when given, sweeps a SECOND ledger (one ledger, one
 * identity — the ledger refuses a mixture) and adds a `near-live` row;
 * a `store` factory, when given, adds the durable rows beside them and
 * holds their quality columns to the in-memory ones.
 * @param {any} corpus
 * @param {number} size
 * @param {{ seed?: number, ks?: number[],
 *   live?: { embedder: import('@jarenjs/ai').Embedder, label: string } | null,
 *   store?: ((dims: number) => Promise<any>) | null }} [options]
 */
export async function runSize(corpus, size, options = {}) {
  const ks = options.ks ?? KS;
  const at = corpusAt(corpus, size);
  const embedder = createHashEmbedder({ dims: HASH_DIMS });
  const ledger = await loadLedger(at.memories, { embedder });
  const sweep = await sweepLedger(ledger, at.memories.length);
  const policies = makePolicies({ ledger, memories: at.memories, tags: at.tags, seed: options.seed, embedder });
  /** @type {{ model: string, dims: number, embedded: number, sweepMs: number } | null} */
  let live = null;
  if (options.live != null) {
    const second = await loadLedger(at.memories, { embedder: options.live.embedder });
    const secondSweep = await sweepLedger(second, at.memories.length, LIVE_BATCH);
    policies.push(rankedPolicy(second, 'near-live', options.live.label));
    live = { model: options.live.embedder.model, dims: /** @type {number} */ (options.live.embedder.dims),
      embedded: secondSweep.embedded, sweepMs: secondSweep.ms };
  }
  let durable = null;
  let adapter = null;
  if (options.store != null) {
    const built = await durablePolicies(at, embedder, options.store);
    durable = built.durable;
    adapter = built.adapter;
    policies.push(...built.policies);
  }
  const scored = [];
  for (const policy of policies) {
    const score = await scorePolicy(policy, at.questions, ks);
    scored.push({ key: policy.key, label: policy.label, ...score });
  }
  if (adapter !== null) await adapter.close();
  const untagged = at.questions.filter((q) => questionTags(q.text, at.tags).length === 0).length;
  const result = {
    size,
    n: at.memories.length,
    questions: at.questions,
    untagged,
    floor: Object.fromEntries(ks.map((k) => [k, randomFloor(at.questions, at.memories.length, k)])),
    policies: scored,
    ranked: { model: embedder.model, dims: embedder.dims, embedded: sweep.embedded, sweepMs: sweep.ms },
    live,
    durable,
  };
  assertScorer(result, ks);
  if (durable !== null) assertDurable(result, ks);
  return result;
}

//#endregion
