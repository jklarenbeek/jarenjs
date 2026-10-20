//@ts-check
/**
 * The council's tastes, measured. Every member judges the tape by one
 * number in [0, 1], and the shared objective — harmony — is their
 * geometric mean, so an amendment that delights one taste by starving
 * another scores lower than one that lifts them together. That is the
 * "mutual benefit" rule in arithmetic: the mean collapses toward zero
 * when any single member is left with nothing.
 *
 * Pure functions over the world's flat tape; nothing here reads a
 * clock or a random source, so a simulated vote is reproducible.
 */

import { SYMBOLS } from './program.js';

/**
 * Painter — colour balance: the Shannon entropy of the symbol histogram,
 * normalized by its maximum. A tape of one colour scores 0, a tape using
 * every ink equally scores 1.
 * @param {readonly number[]} tape @param {number} [symbols]
 */
export function balance(tape, symbols = SYMBOLS) {
  const counts = new Array(symbols).fill(0);
  for (const s of tape) counts[s]++;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / tape.length;
    h -= p * Math.log(p);
  }
  return h / Math.log(symbols);
}

/**
 * Architect — symmetry: the best agreement of the inked cells with their
 * image under one of three folds (left↔right, top↔bottom, a half turn).
 * Only pairs where at least one side carries ink count, so blank paper
 * is not mistaken for a perfectly symmetric design.
 * @param {readonly number[]} tape @param {number} width @param {number} height
 */
export function symmetry(tape, width, height) {
  /** @param {(x: number, y: number) => number} image */
  const score = (image) => {
    let inked = 0;
    let agree = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = tape[y * width + x];
        const b = tape[image(x, y)];
        if (a === 0 && b === 0) continue;
        inked++;
        if (a === b) agree++;
      }
    }
    return inked === 0 ? 0 : agree / inked;
  };
  return Math.max(
    score((x, y) => y * width + (width - 1 - x)),
    score((x, y) => (height - 1 - y) * width + x),
    score((x, y) => (height - 1 - y) * width + (width - 1 - x)),
  );
}

/** The edge density the critic considers well-built. */
const STRUCTURE_TARGET = 0.35;

/**
 * Critic — structure: how close the share of neighbouring cells that
 * differ is to a drawn-not-scribbled target. Blank paper (no edges) and
 * noise (edges everywhere) both lose; regions with outlines win.
 * @param {readonly number[]} tape @param {number} width @param {number} height
 */
export function structure(tape, width, height) {
  let pairs = 0;
  let edges = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = tape[y * width + x];
      if (x + 1 < width) { pairs++; if (a !== tape[y * width + x + 1]) edges++; }
      if (y + 1 < height) { pairs++; if (a !== tape[(y + 1) * width + x]) edges++; }
    }
  }
  const density = pairs === 0 ? 0 : edges / pairs;
  return Math.max(0, 1 - Math.abs(density - STRUCTURE_TARGET) / (1 - STRUCTURE_TARGET));
}

/** The share of the floor the dancer likes to see danced on. */
const MOTION_TARGET = 0.6;

/** The share of cells rewritten over a window that counts as fully alive. */
const LIVELY = 0.08;

/**
 * Dancer — motion: how close the inked share of the floor is to a
 * well-trodden target, scaled by how much of it is still changing. An
 * untouched floor and a floor buried in ink both bore the dancer, and
 * so does a machine caught in a loop that rewrites what it just wrote:
 * a turmite on a folded tape falls into such cycles, and the dancer is
 * the member whose taste notices, so the council is moved to break them.
 *
 * `past` is the tape some steps earlier; without one only coverage is
 * judged.
 * @param {readonly number[]} tape
 * @param {readonly number[]} [past]
 */
export function motion(tape, past) {
  let inked = 0;
  let changed = 0;
  for (let i = 0; i < tape.length; i++) {
    if (tape[i] !== 0) inked++;
    if (past !== undefined && past[i] !== tape[i]) changed++;
  }
  const coverage = Math.max(0, 1 - Math.abs(inked / tape.length - MOTION_TARGET) / MOTION_TARGET);
  if (past === undefined) return coverage;
  const lively = Math.min(1, changed / tape.length / LIVELY);
  return coverage * (0.35 + 0.65 * lively);
}

/** Below this a taste counts as starved; keeps the geometric mean finite. */
const FLOOR = 0.02;

/**
 * Every taste plus harmony, for one world. `past` — the tape some steps
 * earlier — lets the dancer judge liveliness (see {@link motion}).
 * @param {{ tape: readonly number[], width: number, height: number }} world
 * @param {readonly number[]} [past]
 * @returns {{ balance: number, symmetry: number, structure: number, motion: number, harmony: number }}
 */
export function measure(world, past) {
  const tastes = {
    balance: balance(world.tape),
    symmetry: symmetry(world.tape, world.width, world.height),
    structure: structure(world.tape, world.width, world.height),
    motion: motion(world.tape, past),
  };
  const values = Object.values(tastes);
  const harmony = Math.exp(values.reduce((sum, v) => sum + Math.log(Math.max(FLOOR, v)), 0) / values.length);
  return { ...tastes, harmony };
}

/** Round a measurement for the screen and for stored records (four
 * decimals: the votes compare deltas, not the fifteenth digit).
 * @template {Record<string, number>} T @param {T} m @returns {T} */
export function roundMeasure(m) {
  /** @type {any} */
  const out = {};
  for (const [k, v] of Object.entries(m)) out[k] = Math.round(v * 10000) / 10000;
  return out;
}
