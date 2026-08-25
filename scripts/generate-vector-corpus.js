#!/usr/bin/env node
//@ts-check
/**
 * The vector corpus: one committed list of `{ name, data, query }` cases
 * with the answer the JavaScript engine gives, written into
 * `test/json/fixtures/vector-corpus.json`.
 *
 * Why generated rather than typed: the fixture's job is to be an ORACLE.
 * A second executor — the same k-nearest document planned against a
 * store, the same query in a browser tab — asserts it returns exactly
 * what this file records, so a divergence names which executor moved.
 * Hand-typing the answers would make the file a second engine to
 * maintain, and the first typo would be indistinguishable from a bug.
 *
 * The runner (`test/json/query/vector-corpus.test.js`) re-runs every
 * entry in `npm test` and fails on any disagreement, so regenerating is
 * a deliberate act with a visible diff, never a silent refresh.
 *
 *   node scripts/generate-vector-corpus.js           # check, exit 1 on drift
 *   node scripts/generate-vector-corpus.js --write   # rewrite the fixture
 *
 * An entry carries `expected`, `empty: true` OR `error` — JSON cannot
 * spell the empty sequence, `null` is a legitimate answer that must stay
 * distinguishable from "no answer", and a refused operand is a third
 * outcome a second executor has to reproduce as a refusal rather than as
 * a value.
 *
 * An entry whose `data` is a LIST carries `collection: true`: its data
 * IS a collection of documents and its query a phrase over `$[*]`, so a
 * relational executor stores the rows and runs the query as written
 * rather than wrapping one document. Those are the cases only a QUERY
 * PLAN can get wrong — a tie at identical similarity, a row with no
 * vector at all, a row whose vector is the wrong width, a window that
 * cuts through a tie — and they read a member named `embedding`, which
 * is the member a store declares its vector columns over.
 *
 * Every component is `Math.fround`-rounded, so the same numbers survive
 * a packed little-endian binary32 round trip unchanged and a later
 * executor's answers can be compared to these without a tolerance.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { queryJson } from '@jarenjs/json/query';

const OUT = fileURLToPath(new URL('../test/json/fixtures/vector-corpus.json', import.meta.url));

/** The seed every generated vector in this corpus comes from. */
export const CORPUS_SEED = 20260825;

/** The width of the generated vectors — small enough to read in a diff. */
export const DIMS = 8;

/**
 * A small deterministic PRNG (mulberry32) — the same generator the other
 * seeded corpora in this repository use.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

//#region the generated vectors

const random = mulberry32(CORPUS_SEED);

/**
 * One vector of `DIMS` components in [-1, 1), each rounded to its
 * nearest binary32 so the packed form round-trips it exactly.
 * @returns {number[]}
 */
function vector() {
  const out = [];
  for (let i = 0; i < DIMS; i++)
    out.push(Math.fround(random() * 2 - 1));
  return out;
}

/** The query vector every ranking case below is asked about. */
const QUERY = vector();
/**
 * The same direction at a different magnitude: cosine must not care.
 * Four is a power of two, so every component scales exactly in binary32
 * and any difference from 1 is the cosine's own float arithmetic.
 */
const SCALED = QUERY.map((x) => Math.fround(x * 4));
/** The opposite direction: the bottom of every ranking. */
const OPPOSITE = QUERY.map((x) => Math.fround(-x));
/** The query perturbed — close, and not the same direction. */
const NEAR = QUERY.map((x) => Math.fround(x + (random() - 0.5) * 0.5));
/** An unrelated direction, wherever the seed puts it. */
const OTHER = vector();
/** A vector of the wrong width — never padded, never truncated. */
const NARROW = [Math.fround(0.5), Math.fround(-0.25)];

/**
 * The binary32 one step away from `x`, away from zero: the smallest
 * change a packed column can hold.
 * @param {number} x
 * @returns {number}
 */
function nextBinary32(x) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, x);
  view.setUint32(0, view.getUint32(0) + 1);
  return view.getFloat32(0);
}

/**
 * `NEAR` with its last component moved by one binary32 ulp: a pair
 * whose true cosines to the query differ by far less than 1e-7 — the
 * near-tie a plan that cuts by a rounded score must not decide alone.
 */
const NEAR_ULP = [...NEAR.slice(0, -1), nextBinary32(NEAR[NEAR.length - 1])];

/**
 * The ranked collection: five rows a plan can get wrong. `tie-a` and
 * `tie-b` carry the SAME vector, so only an explicit tie-break decides
 * their order; `no-vector` has no member at all and `wrong-width` has
 * one of another model's width — both must sort last and never score.
 */
const ROWS = [
  { id: 'scaled', embedding: SCALED },
  { id: 'tie-b', embedding: NEAR },
  { id: 'no-vector' },
  { id: 'tie-a', embedding: NEAR },
  { id: 'wrong-width', embedding: NARROW },
  { id: 'opposite', embedding: OPPOSITE },
  { id: 'other', embedding: OTHER },
];

//#endregion

/**
 * The near-tie rows: the query's own direction on top, then the two
 * near-identical vectors, then the rest — so a window of two cuts
 * exactly between the near-tie, and the recorded answer is whichever
 * of the two the exact cosine puts first.
 */
const NEAR_TIE_ROWS = [
  { id: 'near-a', embedding: NEAR },
  { id: 'scaled', embedding: SCALED },
  { id: 'near-b', embedding: NEAR_ULP },
  { id: 'other', embedding: OTHER },
];

//#region the query shapes

/** NaN and Infinity are not JSON numbers, so a non-finite one is COMPUTED. */
const NAN = { $div: [0, 0] };
const INF = { $div: [1, 0] };

/** The published k-nearest recipe: order descending, tie by identity. */
const rankedIds = {
  $for: { r: '$[*]' },
  $orderby: [
    { $key: { $similarity: ['$r.embedding', '$query'] }, $dir: 'desc', $empty: 'least' },
    '$r.id',
  ],
  $return: '$r.id',
};

/** The same ordering, windowed to the first `k`. @param {number} k */
const topK = (k) => ({ $subsequence: [rankedIds, 0, k] });

//#endregion

/** @type {Array<any>} */
const ENTRIES = [
  // -- the value, exactly ---------------------------------------------
  { name: 'value/identical-is-one', data: {}, query: { $similarity: [[1, 0], [1, 0]] },
    note: 'the same direction is 1, the top of the range' },
  { name: 'value/orthogonal-is-zero', data: {}, query: { $similarity: [[1, 0], [0, 1]] },
    note: 'unrelated is 0 — a real score, which is why an uncomputable one must not be 0' },
  { name: 'value/opposite-is-minus-one', data: {}, query: { $similarity: [[1, 0], [-1, 0]] },
    note: '' },
  { name: 'value/integer-ratio', data: {}, query: { $similarity: [[3, 4], [4, 3]] },
    note: '24/25 — a ratio of small integers, exact in binary64 and in binary32' },
  { name: 'value/magnitude-is-not-direction', data: { a: QUERY, b: SCALED },
    query: { $similarity: ['$.a', '$.b'] },
    note: 'four times the length is the same direction: the answer is 1 to within one float ulp, and the ulp is pinned rather than rounded away' },
  { name: 'value/from-the-document', data: { a: NEAR, b: OTHER },
    query: { $similarity: ['$.a', '$.b'] }, note: '' },
  { name: 'value/self-similarity', data: { a: NEAR }, query: { $similarity: ['$.a', '$.a'] },
    note: 'a vector is maximally similar to itself, whatever it holds' },
  { name: 'value/zero-vector-scores-zero', data: {}, query: { $similarity: [[0, 0, 0], [1, 0, 0]] },
    note: 'the one degenerate pair the shape guard does not catch: a vector pointing nowhere is 0 against everything, the kernel\'s documented answer' },

  // -- the type-level refusal ------------------------------------------
  { name: 'refuse/string-operand', data: { s: 'not a vector' },
    query: { $similarity: ['$.s', [1, 0]] },
    note: 'a value with no components has no similarity to anything, and empty would hide a wrong column instead of naming it' },
  { name: 'refuse/object-operand', data: { o: { x: 1 } },
    query: { $similarity: ['$.o', [1, 0]] }, note: '' },
  { name: 'refuse/number-operand', data: { n: 3 }, query: { $similarity: ['$.n', [1, 0]] },
    note: '' },
  { name: 'refuse/null-operand', data: { z: null }, query: { $similarity: ['$.z', [1, 0]] },
    note: '' },
  { name: 'refuse/mixed-array', data: { m: [1, 'x'] }, query: { $similarity: ['$.m', [1, 0]] },
    note: 'shaped like a vector and not one — the case that matters' },
  { name: 'refuse/array-of-arrays', data: { m: [[1], [0]] },
    query: { $similarity: ['$.m', [1, 0]] }, note: '' },
  { name: 'refuse/second-operand', data: { s: 'not a vector' },
    query: { $similarity: [[1, 0], '$.s'] },
    note: 'both positions are checked, and the refusal names the one that failed' },

  // -- the data-level empty --------------------------------------------
  { name: 'empty/width-mismatch', data: {}, query: { $similarity: [[3], [3, 4]] },
    note: 'two widths are not a near miss, they are unrelated — nothing is padded or truncated' },
  { name: 'empty/width-mismatch-reversed', data: {}, query: { $similarity: [[3, 4], [3]] },
    note: '' },
  { name: 'empty/empty-vectors', data: {}, query: { $similarity: [[], []] },
    note: 'an empty array is not a zero vector: there is no direction to compare' },
  { name: 'empty/non-finite-component', data: {}, query: { $similarity: [[NAN, 1], [1, 0]] },
    note: 'the kernel scores a malformed pair 0 so a sweep survives it; the language answers empty so a document never carries a score nobody computed' },
  { name: 'empty/infinite-component', data: {}, query: { $similarity: [[1, 0], [INF, 1]] },
    note: '' },
  { name: 'empty/missing-operand', data: {}, query: { $similarity: ['$.nope', [1, 0]] },
    note: 'the empty sequence propagates, as everywhere else' },
  { name: 'empty/in-array-constructor', data: {}, query: [{ $similarity: [[3], [3, 4]] }],
    note: 'the cardinality declaration from the outside: an empty result builds an empty array, never a one-item one' },
  { name: 'empty/in-member-constructor', data: { id: 'a' },
    query: { id: '$.id', score: { $similarity: [[3], [3, 4]] } },
    note: 'a document with no score is honest; one carrying 0 for a comparison that never happened is not' },

  // -- thresholds ------------------------------------------------------
  { name: 'threshold/above', collection: true, data: ROWS,
    query: { $for: { r: '$[*]' },
      $where: { $gt: [{ $similarity: ['$r.embedding', '$query'] }, 0.5] },
      $return: '$r.id' },
    note: 'a comparison against an empty key is false, so the rows that cannot be scored drop out for free' },
  { name: 'threshold/below', collection: true, data: ROWS,
    query: { $for: { r: '$[*]' },
      $where: { $lt: [{ $similarity: ['$r.embedding', '$query'] }, 0] },
      $return: '$r.id' },
    note: 'and the same holds on the other side of the range — an unscored row is in neither half' },
  { name: 'threshold/scores-projected', collection: true, data: ROWS,
    query: { $for: { r: '$[*]' },
      $where: { $gt: [{ $similarity: ['$r.embedding', '$query'] }, 0.5] },
      $return: { id: '$r.id', score: { $similarity: ['$r.embedding', '$query'] } } },
    note: 'the score as a projected member, which is the value a second executor has to reproduce to the last bit' },

  // -- the k-nearest composition ---------------------------------------
  { name: 'knn/full-ordering', collection: true, data: ROWS, query: rankedIds,
    note: 'the whole ordering: the scored rows by similarity, then the unscorable ones, and the tie broken by identity' },
  { name: 'knn/top-1', collection: true, data: ROWS, query: topK(1), note: '' },
  { name: 'knn/top-2', collection: true, data: ROWS, query: topK(2), note: '' },
  { name: 'knn/top-3', collection: true, data: ROWS, query: topK(3),
    note: 'k = 3 cuts exactly through the tie, which is the case a plan that reorders ties answers differently every run' },
  { name: 'knn/top-5', collection: true, data: ROWS, query: topK(5), note: '' },
  { name: 'knn/k-past-the-end', collection: true, data: ROWS, query: topK(99),
    note: 'a window wider than the collection is the whole ordering, not an error' },
  { name: 'knn/ties-survive-input-order', collection: true, data: [...ROWS].reverse(),
    query: rankedIds,
    note: 'the same rows fed in reverse answer in the same order: stability is only about the input, so the identity key is what makes the answer reproducible' },
  { name: 'knn/empty-greatest-puts-the-unscorable-first', collection: true, data: ROWS,
    query: { $for: { r: '$[*]' },
      $orderby: [
        { $key: { $similarity: ['$r.embedding', '$query'] }, $dir: 'desc', $empty: 'greatest' },
        '$r.id',
      ],
      $return: '$r.id' },
    note: 'the other half of $empty, pinned so the default is a choice rather than an accident' },
  { name: 'knn/ascending-is-the-worst-first', collection: true, data: ROWS,
    query: { $for: { r: '$[*]' },
      $orderby: [
        { $key: { $similarity: ['$r.embedding', '$query'] }, $dir: 'asc', $empty: 'least' },
        '$r.id',
      ],
      $return: '$r.id' },
    note: 'higher-is-better means ascending is the least similar first, and least-empty then puts the unscorable rows FIRST' },
  { name: 'knn/offset-window', collection: true, data: ROWS,
    query: { $subsequence: [rankedIds, 2, 2] },
    note: 'a window that starts past the top: the offset composes with the limit, and the rows before it are skipped, not returned' },
  { name: 'knn/near-tie-at-the-boundary', collection: true, data: NEAR_TIE_ROWS,
    query: topK(2),
    note: 'two vectors one binary32 ulp apart sit either side of the cut; their true cosines differ by less than 1e-7 and the exact one decides, so an executor that ranks by a rounded score alone can pick the wrong second row' },
  { name: 'knn/external-probe-of-another-width', collection: true, data: ROWS,
    query: { $subsequence: [{
      $for: { r: '$[*]' },
      $orderby: [
        { $key: { $similarity: ['$r.embedding', '$narrow'] }, $dir: 'desc', $empty: 'least' },
        '$r.id',
      ],
      $return: '$r.id' }, 0, 3] },
    note: 'a probe of another width scores nothing of that width — except the one row whose vector is that narrow, which ranks first while every other key is empty and the identity order decides the rest' },
  { name: 'knn/external-probe-not-a-vector', collection: true, data: ROWS,
    query: { $subsequence: [{
      $for: { r: '$[*]' },
      $orderby: [
        { $key: { $similarity: ['$r.embedding', '$word'] }, $dir: 'desc', $empty: 'least' },
        '$r.id',
      ],
      $return: '$r.id' }, 0, 3] },
    note: 'a probe that is not an array is the type-level refusal, from every executor' },
  { name: 'knn/filtered-then-ranked', collection: true, data: ROWS,
    query: { $subsequence: [{
      $for: { r: '$[*]' },
      $where: { $gt: [{ $similarity: ['$r.embedding', '$query'] }, 0] },
      $orderby: [
        { $key: { $similarity: ['$r.embedding', '$query'] }, $dir: 'desc', $empty: 'least' },
        '$r.id',
      ],
      $return: '$r.id' }, 0, 3] },
    note: 'a narrowing predicate and a ranking in one phrase — the shape a store has to answer with a filter and a rank, not one or the other' },
];

/**
 * The cosine of two vectors as the engine computes it, for the
 * construction check below.
 * @param {number[]} a @param {number[]} b
 */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function generateVectorCorpus() {
  // the near-tie is constructed, and checked: the two cosines must
  // differ, and by less than 1e-7, or the entry does not test what it
  // says it tests
  const gap = Math.abs(cosine(NEAR, QUERY) - cosine(NEAR_ULP, QUERY));
  if (!(gap > 0 && gap < 1e-7))
    throw new Error(`the near-tie is not a near-tie: the cosines differ by ${gap}`);
  const seen = new Set();
  return ENTRIES.map((entry) => {
    if (seen.has(entry.name))
      throw new Error(`duplicate corpus entry name '${entry.name}'`);
    seen.add(entry.name);
    /** @type {any} */
    const out = { name: entry.name, note: entry.note, data: entry.data, query: entry.query };
    if (entry.collection === true)
      out.collection = true;
    let answer;
    try {
      answer = queryJson(entry.query, entry.data, EXTERNALS);
    }
    catch (e) {
      out.error = /** @type {any} */ (e).code;
      return out;
    }
    if (answer === undefined)
      out.empty = true;
    else
      out.expected = answer;
    return out;
  });
}

/**
 * The externals every entry is run with: the query vector every ranking
 * case is asked about, a probe of another width, and one that is not a
 * vector at all — the same three a second executor must bind.
 */
export const EXTERNALS = { query: QUERY, narrow: NARROW, word: 'not a vector' };

/** @param {any[]} corpus */
export function serializeCorpus(corpus) {
  return `${JSON.stringify({ seed: CORPUS_SEED, dims: DIMS, externals: EXTERNALS, entries: corpus }, null, 2)}\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? resolve(argv[outIndex + 1]) : OUT;
  const corpus = generateVectorCorpus();
  const text = serializeCorpus(corpus);
  if (argv.includes('--write')) {
    writeFileSync(out, text);
    console.log(`vector corpus: ${corpus.length} entries written to ${out}`);
  }
  else {
    let current = null;
    try {
      current = readFileSync(out, 'utf8');
    }
    catch {
      current = null;
    }
    if (current === text) {
      console.log(`vector corpus: ${corpus.length} entries, the committed fixture agrees.`);
    }
    else {
      console.error('vector corpus: the committed fixture does not match what the engine answers now.');
      console.error('Run `node scripts/generate-vector-corpus.js --write` and read the diff before keeping it.');
      process.exitCode = 1;
    }
  }
}
