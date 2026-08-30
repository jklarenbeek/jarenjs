//@ts-check
/**
 * @file The suite's one seeded generator, and the three draws built on
 * it. Every seeded corpus, oracle and property test in this repository
 * needs the same thing: a stream of numbers that is identical on every
 * host for a given seed, so that a benchmark can state a delta and a
 * failing property test can be replayed. Before this file that stream
 * was written ten times; a generator that exists once is one whose
 * sequence can be pinned once.
 *
 * The algorithm is mulberry32 — a 32-bit state, one multiply-xorshift
 * round per draw, a period of 2^32. It is named by its algorithm rather
 * than by its role because the SEQUENCE is the contract: a corpus
 * generated from seed 20260825 must regenerate byte-for-byte, and a
 * "better" generator under the same name would silently change every
 * fixture that trusts it. A second algorithm gets a second name.
 *
 * Nothing here is cryptographic, and nothing here reads `Math.random`.
 */

/**
 * A seeded generator: uniform in `[0, 1)`, identical on every host for
 * the same seed.
 *
 * The seed is taken as an unsigned 32-bit integer (`seed >>> 0`, the
 * ToUint32 conversion): `1.5` seeds as `1`, `-1` as `4294967295`,
 * `2^32 + 5` as `5`, and `NaN` as `0`. Two seeds that agree modulo 2^32
 * are one stream — say so wherever a seed is published.
 * @param {number} seed
 * @returns {() => number} the stream; each call is the next draw
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} value
 * @param {string} what
 */
function assertInteger(value, what) {
  if (!Number.isInteger(value))
    throw new RangeError(`${what} must be an integer, got ${String(value)}`);
}

/**
 * One integer draw over the half-open range `[min, max)`: `min +
 * floor(random() * (max - min))`.
 *
 * This is the floor draw and deliberately so. Every committed corpus in
 * the suite was generated with exactly this arithmetic, and a generator
 * whose integer draw changed would regenerate every one of them
 * differently. It is uniform up to a bias bounded by `(max - min) /
 * 2^32` — under one part in a million for a span of four thousand, and
 * far below anything a benchmark row can resolve. A draw that rejects
 * to remove even that bias would be a different function under a
 * different name, not a change to this one.
 * @param {() => number} random - the stream, from {@link mulberry32}
 * @param {number} min - inclusive integer lower bound
 * @param {number} max - exclusive integer upper bound; must exceed `min`
 * @returns {number} an integer in `[min, max)`
 * @throws {RangeError} when a bound is not an integer or `max <= min`
 */
export function randomInt(random, min, max) {
  assertInteger(min, 'min');
  assertInteger(max, 'max');
  if (max <= min) throw new RangeError(`randomInt needs max > min, got [${min}, ${max})`);
  return min + Math.floor(random() * (max - min));
}

/**
 * Fisher–Yates, in place, from the given stream: for `i` from the last
 * index down to 1, swap `i` with a uniform `j` in `[0, i]`. Returns the
 * same array. An empty or one-element list draws nothing.
 *
 * The descending form is the one the seeded corpora were generated
 * with; the ascending form is a different permutation of the same
 * stream and must not be substituted.
 * @template T
 * @param {() => number} random - the stream, from {@link mulberry32}
 * @param {T[]} list - reordered in place
 * @returns {T[]} `list`
 */
export function shuffle(random, list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * `k` distinct indices from `[0, n)`, uniformly, as a partial forward
 * Fisher–Yates over a fresh index pool: the first `k` positions of a
 * shuffle, without paying for the rest. Asked for more than `n` it
 * answers `n` — a draw cannot invent a member the population does not
 * hold; asked for nothing, or from nothing, it answers `[]`.
 *
 * The stream is the caller's, so one stream can serve many draws
 * (a policy that draws per question from one seeded closure stays
 * reproducible across the whole run).
 * @param {() => number} random - the stream, from {@link mulberry32}
 * @param {number} n - the population size (a non-negative integer)
 * @param {number} k - how many to draw (a non-negative integer)
 * @returns {number[]} `min(k, n)` distinct indices, in draw order
 * @throws {RangeError} when `n` or `k` is not a non-negative integer
 */
export function drawDistinct(random, n, k) {
  assertInteger(n, 'n');
  assertInteger(k, 'k');
  if (n < 0 || k < 0) throw new RangeError(`drawDistinct needs n >= 0 and k >= 0, got n=${n} k=${k}`);
  const count = Math.min(k, n);
  if (count === 0) return [];
  const pool = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}
