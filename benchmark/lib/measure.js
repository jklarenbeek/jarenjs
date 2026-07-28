//#region benchmark measurement
// Timing loops shared by the suite runners. Warmup counts stay with the
// callers - every suite tunes its own - so each helper takes them as
// arguments instead of reading a module constant.

import { formatNs } from './fmt.js';

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
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++)
    fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / iterations;
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
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; ++i)
    fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iterations;
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
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) run(i);
    const ns = Number(process.hrtime.bigint() - start) / iterations;
    return { label, ns };
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
  let start = hrnow();
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
    start = hrnow();
    for (let i = 0; i < iterations; i++)
      await fn();
  }
  else {
    for (let i = 0; i < warmup; i++)
      fn();
    start = hrnow();
    for (let i = 0; i < iterations; i++)
      fn();
  }
  return {
    ns: Number(hrnow() - start) / iterations,
    iterations,
  };
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
