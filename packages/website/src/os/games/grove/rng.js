//@ts-check
/**
 * Seeded randomness for Monkey Grove that never lives in the game state.
 *
 * The state is plain JSON, so it cannot hold a generator. Instead every
 * draw that matters — a chamber's board, a problem, a chest of bananas —
 * opens its own short stream from a seed named by what it is for
 * (`seedOf(gameSeed, 'problem', chamber, step)`), and the stream is gone
 * when the draw is done. The same seed and the same story of play
 * therefore deal the same chambers on every host, which is what makes a
 * duel fair and a test exact.
 *
 * The draws are the ones the engine's generators speak — `float`, an
 * inclusive `int`, `pick`, a copying `shuffle`, `chance` — over the
 * suite's own mulberry32.
 */

import { mulberry32, randomInt, shuffle } from '@jarenjs/core/random';

/**
 * @typedef {{
 *   float: () => number,
 *   int: (min: number, max: number) => number,
 *   pick: <T>(list: readonly T[]) => T,
 *   shuffle: <T>(list: readonly T[]) => T[],
 *   chance: (p: number) => boolean,
 * }} Rng - `int` includes both bounds; `shuffle` returns a shuffled copy
 */

/**
 * FNV-1a over a string: the 32-bit seed a name stands for.
 * @param {string} text @returns {number}
 */
export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The seed of a named draw: the parts joined into one name and hashed.
 * @param {...(string | number)} parts @returns {number}
 */
export function seedOf(...parts) {
  return hashString(parts.join(':'));
}

/**
 * A stream of draws from a seed (a number, or a name hashed into one).
 * @param {number | string} seed @returns {Rng}
 */
export function createRng(seed) {
  const next = mulberry32(typeof seed === 'string' ? hashString(seed) : seed);
  return {
    float: () => next(),
    int: (min, max) => randomInt(next, min, max + 1),
    pick: (list) => list[Math.floor(next() * list.length)],
    shuffle: (list) => shuffle(next, list.slice()),
    chance: (p) => next() < p,
  };
}
