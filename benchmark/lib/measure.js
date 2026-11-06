//#region benchmark measurement
// Timing loops shared by the suite runners. Warmup counts stay with the
// callers - every suite tunes its own - so each helper takes them as
// arguments instead of reading a module constant.

import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

import { formatNs } from './fmt.js';

// Rounds. Every helper below splits its iteration count into ROUNDS timed
// blocks after one warmup, the loop index running on across them, so a row
// does the same calls as one block would. BENCH_ROUNDS overrides the count
// (1 is one block of every iteration). BENCH_ROUNDS_LOG names a file each
// row's per-round ns/op is appended to as one JSON line.
const DEFAULT_ROUNDS = 1;
const ROUNDS = roundsFromEnv();
const ROUNDS_LOG = process.env.BENCH_ROUNDS_LOG || null;
let rowSeq = 0;

function roundsFromEnv() {
  const raw = process.env.BENCH_ROUNDS;
  if (raw === undefined || raw === '')
    return DEFAULT_ROUNDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`BENCH_ROUNDS must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * The iteration count of each round: ROUNDS near-equal parts of
 * `iterations`, never an empty one.
 * @param {number} iterations
 * @returns {number[]}
 */
function roundSizes(iterations) {
  const rounds = Math.max(1, Math.min(ROUNDS, iterations));
  const base = Math.floor(iterations / rounds);
  const extra = iterations - base * rounds;
  return Array.from({ length: rounds }, (_, r) => base + (r < extra ? 1 : 0));
}

/**
 * A row's figure from its rounds' ns/op: the median round. The fastest
 * round would drop the collections a row's own garbage causes, which is a
 * cost the row has; the median keeps them once rounds are long enough to
 * hold several, and drops a lone pause a round happened to catch.
 * @param {string | null} label
 * @param {number[]} perRound
 * @returns {number}
 */
function settle(label, perRound) {
  if (ROUNDS_LOG !== null) {
    appendFileSync(ROUNDS_LOG, `${JSON.stringify({
      suite: basename(process.argv[1] ?? ''), seq: rowSeq, label, rounds: perRound,
    })}\n`);
  }
  rowSeq += 1;
  const sorted = perRound.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Time `iterations` calls of `fn` in rounds; ns/op of the row. With
 * `passIndex` each call gets the loop index, which runs on across rounds;
 * without it `fn` is called with no argument, as the helpers always did.
 * @param {(i: number) => unknown} fn
 * @param {number} iterations
 * @param {string | null} label
 * @param {boolean} passIndex
 * @returns {number}
 */
function timeRounds(fn, iterations, label, passIndex) {
  const perRound = [];
  let first = 0;
  for (const count of roundSizes(iterations)) {
    const end = first + count;
    const start = process.hrtime.bigint();
    if (passIndex) {
      for (let i = first; i < end; i++)
        fn(i);
    }
    else {
      for (let i = first; i < end; i++)
        fn();
    }
    perRound.push(Number(process.hrtime.bigint() - start) / count);
    first = end;
  }
  return settle(label, perRound);
}

/**
 * The awaited twin of `timeRounds`: `iterations` awaited calls of `fn`
 * in rounds; ns/op of the row.
 * @param {() => unknown} fn
 * @param {number} iterations
 * @param {string | null} label
 * @returns {Promise<number>}
 */
async function timeRoundsAsync(fn, iterations, label) {
  const perRound = [];
  for (const count of roundSizes(iterations)) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < count; i++)
      await fn();
    perRound.push(Number(process.hrtime.bigint() - start) / count);
  }
  return settle(label, perRound);
}

/**
 * Nanoseconds per call over `iterations` runs, after `warmup` unmeasured
 * runs.
 * @param {() => void} fn
 * @param {number} iterations
 * @param {number} warmup
 * @returns {number} ns/op
 */
export function measureNsPerOp(fn, iterations, warmup) {
  for (let i = 0; i < warmup; i++)
    fn();
  return timeRounds(fn, iterations, null, false);
}

/**
 * Milliseconds per call over `iterations` runs, after two unmeasured
 * warmup calls (the corpus-parsing suites' shape).
 * @param {() => void} fn
 * @param {number} iterations
 * @returns {number} ms/op
 */
export function timeIt(fn, iterations) {
  fn();
  fn();
  return timeRounds(fn, iterations, null, false) / 1e6;
}

/**
 * Nanoseconds per awaited call over `iterations` runs, after `warmup`
 * unmeasured awaited runs.
 * @param {() => unknown} fn
 * @param {number} iterations
 * @param {number} warmup
 * @returns {Promise<number>} ns/op
 */
export async function measureNsPerOpAsync(fn, iterations, warmup) {
  for (let i = 0; i < warmup; i++)
    await fn();
  return timeRoundsAsync(fn, iterations, null);
}

/**
 * Milliseconds per awaited call over `iterations` runs, after two
 * unmeasured awaited calls.
 * @param {() => unknown} fn
 * @param {number} iterations
 * @returns {Promise<number>} ms/op
 */
export async function timeItAsync(fn, iterations) {
  await fn();
  await fn();
  return (await timeRoundsAsync(fn, iterations, null)) / 1e6;
}

/**
 * Build the labeled-row measurer of the table-style runners: it runs
 * `warmup` then `iterations` calls (the index is passed through to the
 * run callback) and returns a `{ label, ns }` row for `printTable`.
 * @param {number} warmup
 * @param {number} iterations
 * @returns {(label: string, run: (i: number) => void) => { label: string, ns: number }}
 */
export function makeMeasure(warmup, iterations) {
  return function measure(label, run) {
    for (let i = 0; i < warmup; i++) run(i);
    return { label, ns: timeRounds(run, iterations, label, true) };
  };
}

/**
 * Print a table of `{ label, ns }` rows. With `ratios` (the default)
 * every row after the first is annotated relative to the first row.
 * @param {string} title
 * @param {{ label: string, ns: number }[]} rows
 * @param {{ width?: number, ratios?: boolean }} [options]
 */
export function printTable(title, rows, { width = 28, ratios = true } = {}) {
  console.log(`\n${title}`);
  const base = rows[0].ns;
  for (const row of rows) {
    let suffix = '';
    if (ratios && row !== rows[0]) {
      const ratio = row.ns / base;
      suffix = `  (${ratio >= 1 ? ratio.toFixed(1) + 'x slower' : (1 / ratio).toFixed(1) + 'x faster'} than ${rows[0].label})`;
    }
    console.log(`  ${row.label.padEnd(width)} ${formatNs(row.ns).padStart(10)}${suffix}`);
  }
}

const hrnow = () => process.hrtime.bigint();

/**
 * Adaptive cell measurement of the engine-matrix runners (jslt,
 * jsonquery): pilot one call, rescale the requested iterations into the
 * time budget (or up to the floor, so fast cells still get a stable
 * window), then time sync or async depending on the engine.
 * @param {{ isAsync?: boolean }} engine
 * @param {() => any} fn
 * @param {number} requestedIterations
 * @param {number} budgetNs - Ceiling for a cell's measured time
 * @param {number} floorNs - Fast cells run extra iterations up to this
 * @param {number} warmupCap - Warmup runs, capped at the iteration count
 * @returns {Promise<{ ns: number, iterations: number }>}
 */
export async function measureCell(engine, fn, requestedIterations, budgetNs, floorNs, warmupCap) {
  const start = hrnow();
  await Promise.resolve(fn());
  const pilotNs = Math.max(1, Number(hrnow() - start));

  let iterations = requestedIterations;
  if (pilotNs * iterations > budgetNs)
    iterations = Math.max(1, Math.floor(budgetNs / pilotNs));
  else if (pilotNs * iterations < floorNs)
    iterations = Math.ceil(floorNs / pilotNs);

  const warmup = Math.min(warmupCap, iterations);
  if (engine.isAsync) {
    for (let i = 0; i < warmup; i++)
      await fn();
    return { ns: await timeRoundsAsync(fn, iterations, null), iterations };
  }
  for (let i = 0; i < warmup; i++)
    fn();
  return { ns: timeRounds(fn, iterations, null, false), iterations };
}

/**
 * Split a corpus into fixed-size chunks for the streaming feeders.
 * @param {string} text
 * @param {number} size
 * @returns {string[]}
 */
export function chunksOf(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size)
    out.push(text.slice(i, i + size));
  return out;
}

//#endregion
