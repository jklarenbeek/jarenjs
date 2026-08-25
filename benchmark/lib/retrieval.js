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
// The ledger under `recency` and `tag+recency` is the REAL one:
// `createLedger()` over its in-memory adapter, loaded through `addMemory`,
// answering through `recall`. That is the point of the instrument — it
// scores the shipped code path, not a model of it.

import { readFileSync } from 'node:fs';

import { createLedger } from '@jarenjs/ai';

import { mulberry32, tokens } from '../../scripts/generate-retrieval-corpus.js';
import { quantile } from './horizon.js';

/** The committed corpus. */
const CORPUS = new URL('../fixtures/retrieval-corpus.json', import.meta.url);

/** The cut-offs every row reports. */
export const KS = [1, 5, 10];

/** The seed the `random` policy draws from; published beside the table. */
export const POLICY_SEED = 1;

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
 * @param {any[]} memories
 */
export async function loadLedger(memories) {
  const ledger = createLedger({ now: () => '2025-12-31T23:59:59Z' });
  const results = await Promise.all(memories.map((m) => ledger.addMemory(m)));
  const rejected = results.find((r) => /** @type {any} */ (r).error !== undefined);
  if (rejected !== undefined)
    throw new Error(`the ledger rejected a corpus memory: ${JSON.stringify(rejected)}`);
  return ledger;
}

/**
 * The policies scored, in table order. `oracle` is the 1.0 row that
 * proves the scorer and catches a corpus whose gold ids do not exist;
 * `random` is the floor; `recency` and `tag+recency` are what
 * `recall()` does today, the second being the incumbent.
 * @param {{ ledger: any, memories: any[], tags: Set<string>, seed?: number }} config
 * @returns {Array<{ key: string, label: string, run: (question: any, k: number) => Promise<string[]> }>}
 */
export function makePolicies({ ledger, memories, tags, seed = POLICY_SEED }) {
  const ids = memories.map((m) => m.id);
  const random = mulberry32(seed);
  const asIds = (records) => (Array.isArray(records) ? records.map((r) => r.id) : []);
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
    { key: 'recency', label: 'recency',
      run: async (_question, k) => asIds(await ledger.recall({ limit: k })) },
    { key: 'tag+recency', label: 'tag+recency (today\'s recall)',
      run: async (question, k) => {
        const found = questionTags(question.text, tags);
        return asIds(await ledger.recall(found.length === 0 ? { limit: k } : { tags: found, limit: k }));
      } },
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
 * Score every policy at one corpus size and gate the scorer.
 * @param {any} corpus
 * @param {number} size
 * @param {{ seed?: number, ks?: number[] }} [options]
 */
export async function runSize(corpus, size, options = {}) {
  const ks = options.ks ?? KS;
  const at = corpusAt(corpus, size);
  const ledger = await loadLedger(at.memories);
  const policies = makePolicies({ ledger, memories: at.memories, tags: at.tags, seed: options.seed });
  const scored = [];
  for (const policy of policies) {
    const score = await scorePolicy(policy, at.questions, ks);
    scored.push({ key: policy.key, label: policy.label, ...score });
  }
  const untagged = at.questions.filter((q) => questionTags(q.text, at.tags).length === 0).length;
  const result = {
    size,
    n: at.memories.length,
    questions: at.questions,
    untagged,
    floor: Object.fromEntries(ks.map((k) => [k, randomFloor(at.questions, at.memories.length, k)])),
    policies: scored,
  };
  assertScorer(result, ks);
  return result;
}

//#endregion
