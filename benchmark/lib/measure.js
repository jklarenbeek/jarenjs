//#region benchmark measurement
// Timing loops shared by the suite runners. Warmup counts stay with the
// callers - every suite tunes its own - so each helper takes them as
// arguments instead of reading a module constant.

import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { GCProfiler } from 'node:v8';

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
/** The logged row's round start and end times on the `performance` clock, while the log is on. */
let spans = null;

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

/** The middle value, or the mean of the middle two. */
function medianOf(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A row's figure from its rounds' ns/op: the median round. The fastest
 * round would drop the collections a row's own garbage causes, which is a
 * cost the row has; the median keeps them once rounds are long enough to
 * hold several, and drops a lone pause a round happened to catch.
 * @param {string | null} label
 * @param {number[]} perRound
 * @param {number} calls - the row's timed calls over all its rounds
 * @param {object} [quality] - how a settled row was warmed and sized
 * @returns {number}
 */
function settle(label, perRound, calls, quality = undefined) {
  if (ROUNDS_LOG !== null) {
    appendFileSync(ROUNDS_LOG, `${JSON.stringify({
      suite: basename(process.argv[1] ?? ''), seq: rowSeq, label, calls, rounds: perRound, spans, ...quality,
    })}\n`);
  }
  rowSeq += 1;
  return medianOf(perRound);
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
  spans = ROUNDS_LOG === null ? null : [];
  let first = 0;
  for (const count of roundSizes(iterations)) {
    const end = first + count;
    spans?.push(performance.now());
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
    spans?.push(performance.now());
    first = end;
  }
  return settle(label, perRound, iterations);
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
  spans = ROUNDS_LOG === null ? null : [];
  for (const count of roundSizes(iterations)) {
    spans?.push(performance.now());
    const start = process.hrtime.bigint();
    for (let i = 0; i < count; i++)
      await fn();
    perRound.push(Number(process.hrtime.bigint() - start) / count);
    spans?.push(performance.now());
  }
  return settle(label, perRound, iterations);
}

//#region settled rows
// BENCH_METHOD=settled times a row by the clock instead of by its call
// count. The row is warmed for at least `warmMinMs` and until two blocks in
// a row agree; its rounds are sized so each lasts at least `minRoundMs` and
// holds at least `collectionsPerRound` of the collections its own garbage
// causes (counted while it warms); and a row whose median round is more
// than `settle` times its fastest is timed again with rounds twice as long,
// at most `retries` times, and logged as unsettled if it still disagrees.
// The caller's iteration count stays a floor on the calls in its rounds and
// its warmup count a floor on the warm-up. BENCH_METHOD=block (the default)
// is the one-block method the published figures were measured with.

const METHOD = methodFromEnv();
const SETTLED = Object.freeze({
  rounds: 7,
  blockMs: 10,
  warmMinMs: 50,
  warmMaxMs: 2000,
  agree: 1.05,
  minRoundMs: 10,
  maxRoundMs: 400,
  collectionsPerRound: 2,
  settle: 1.15,
  retries: 2,
});
const MS = 1e6;
// a row on fresh state: untimed passes that warm the code it drives, then
// timed ones, enough of them that the median is not decided by which
// short pass caught a collection of the garbage the rebuild left
const SESSIONS = Object.freeze({ warm: 2, rounds: 21 });

function methodFromEnv() {
  const raw = process.env.BENCH_METHOD;
  if (raw === undefined || raw === '' || raw === 'block')
    return 'block';
  if (raw === 'settled')
    return 'settled';
  throw new Error(`BENCH_METHOD must be 'block' or 'settled', got ${JSON.stringify(raw)}`);
}

/**
 * The plan of one settled row: yields the call count of each block it
 * wants run and receives that block's ns, and returns the row's rounds.
 * @param {number} iterations - floor on the calls in its rounds
 * @param {number} warmup - floor on its warm-up calls
 * @returns {Generator<number, { perRound: number[], calls: number, quality: object }, number>}
 */
function* settledPlan(iterations, warmup) {
  if (warmup > 0)
    yield warmup;
  // grow a block until it lasts blockMs, then warm in blocks of that length
  let size = 1;
  let ns = yield size;
  while (ns < SETTLED.blockMs * MS && size < 2 ** 30) {
    size *= 2;
    ns = yield size;
  }
  let perCall = ns / size;
  size = Math.max(1, Math.round(SETTLED.blockMs * MS / perCall));
  // a row that throws while warming abandons this plan, and the finally
  // stops the profiler: one left running records every later collection
  const profiler = new GCProfiler();
  profiler.start();
  let warmNs = 0;
  let warmCalls = 0;
  let stable = false;
  let collections;
  try {
    while (warmNs < SETTLED.warmMaxMs * MS) {
      const t = yield size;
      warmNs += t;
      warmCalls += size;
      const per = t / size;
      const agree = Math.max(per, perCall) / Math.min(per, perCall) <= SETTLED.agree;
      perCall = per;
      if (agree && warmNs >= SETTLED.warmMinMs * MS) {
        stable = true;
        break;
      }
    }
  }
  finally {
    collections = profiler.stop().statistics.length;
  }
  const collectionsPerCall = collections / warmCalls;
  // the profiler slows a collecting row, so its rounds are sized from a block run without it
  perCall = (yield size) / size;
  const floor = Math.ceil(iterations / SETTLED.rounds);
  let roundCalls = Math.max(floor, Math.ceil(SETTLED.minRoundMs * MS / perCall));
  if (collectionsPerCall > 0)
    roundCalls = Math.max(roundCalls, Math.ceil(SETTLED.collectionsPerRound / collectionsPerCall));
  roundCalls = Math.max(1, Math.min(roundCalls, Math.max(floor, Math.floor(SETTLED.maxRoundMs * MS / perCall))));
  let perRound;
  let spread;
  let attempt = 0;
  for (;;) {
    perRound = [];
    spans = ROUNDS_LOG === null ? null : [];
    for (let r = 0; r < SETTLED.rounds; r++) {
      spans?.push(performance.now());
      perRound.push((yield roundCalls) / roundCalls);
      spans?.push(performance.now());
    }
    spread = medianOf(perRound) / Math.min(...perRound);
    if (spread <= SETTLED.settle || attempt === SETTLED.retries)
      break;
    attempt += 1;
    roundCalls *= 2;
  }
  return {
    perRound,
    calls: roundCalls * SETTLED.rounds,
    quality: {
      method: 'settled', warmCalls, warmMs: warmNs / MS, warmStable: stable, collectionsPerCall,
      roundCalls, roundMs: medianOf(perRound) * roundCalls / MS, attempts: attempt + 1,
      spread, settled: spread <= SETTLED.settle,
    },
  };
}

/**
 * The plan of a settled row whose calls must stay exactly the caller's,
 * because the state they drive is sized for that many (a session fed one
 * point per call, say): its warmup, then its iterations in near-equal
 * rounds, reported like any settled row.
 * @param {number} iterations
 * @param {number} warmup
 * @returns {Generator<number, { perRound: number[], calls: number, quality: object }, number>}
 */
function* fixedPlan(iterations, warmup) {
  if (warmup > 0)
    yield warmup;
  const perRound = [];
  spans = ROUNDS_LOG === null ? null : [];
  const rounds = Math.max(1, Math.min(SETTLED.rounds, iterations));
  const base = Math.floor(iterations / rounds);
  for (let r = 0; r < rounds; r++) {
    const count = base + (r < iterations - base * rounds ? 1 : 0);
    spans?.push(performance.now());
    perRound.push((yield count) / count);
    spans?.push(performance.now());
  }
  const spread = medianOf(perRound) / Math.min(...perRound);
  return {
    perRound,
    calls: iterations,
    quality: {
      method: 'settled', fixedCalls: true, warmCalls: warmup, roundCalls: base,
      roundMs: medianOf(perRound) * base / MS, attempts: 1, spread, settled: spread <= SETTLED.settle,
    },
  };
}

/**
 * A settled row whose state lasts one pass of the caller's calls (a
 * session fed one point per call, say): passes on state `fresh` rebuilds
 * untimed (the first on the state the caller built), each running its
 * warmup and then its iterations, the indices as one block has; the
 * first SESSIONS.warm passes are untimed and every later one is a round.
 * @returns {number} ns/op
 */
function sessionRow(fn, iterations, warmup, label, fresh) {
  const perRound = [];
  spans = ROUNDS_LOG === null ? null : [];
  const passes = SESSIONS.warm + SESSIONS.rounds;
  for (let pass = 0; pass < passes; pass++) {
    if (pass > 0)
      fresh();
    for (let i = 0; i < warmup; i++)
      fn(i);
    const timed = pass >= SESSIONS.warm;
    if (timed)
      spans?.push(performance.now());
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++)
      fn(i);
    if (timed) {
      perRound.push(Number(process.hrtime.bigint() - start) / iterations);
      spans?.push(performance.now());
    }
  }
  const spread = medianOf(perRound) / Math.min(...perRound);
  return settle(label, perRound, iterations * SESSIONS.rounds, {
    method: 'settled', fixedCalls: true, sessions: passes, warmSessions: SESSIONS.warm, warmCalls: warmup, roundCalls: iterations,
    roundMs: medianOf(perRound) * iterations / MS, attempts: 1, spread, settled: spread <= SETTLED.settle,
  });
}

/**
 * A sync row's first result must not be a promise: the loop would time
 * only its start, and keep every call's pending work alive until it
 * yields, which a row the clock sizes into millions of calls cannot hold.
 * @param {unknown} value
 * @param {string | null} label
 */
function refuseThenable(value, label) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function')
    throw new Error(`${label === null ? 'a sync row' : `row '${label}'`} returned a promise: time it with the awaited helpers`);
}

/**
 * One settled row of a sync `fn`; the loop index runs on across every block.
 * @returns {{ ns: number, calls: number }}
 */
function settledRow(fn, iterations, warmup, label, passIndex, plan = settledPlan(iterations, warmup)) {
  let next = 0;
  let step = plan.next();
  try {
    while (!step.done) {
      const count = step.value;
      const end = next + count;
      const start = process.hrtime.bigint();
      if (next === 0) {
        refuseThenable(passIndex ? fn(0) : fn(), label);
        next = 1;
      }
      if (passIndex) {
        for (let i = next; i < end; i++)
          fn(i);
      }
      else {
        for (let i = next; i < end; i++)
          fn();
      }
      const ns = Number(process.hrtime.bigint() - start);
      next = end;
      step = plan.next(ns);
    }
  }
  finally {
    if (!step.done) plan.return(undefined);
  }
  const { perRound, calls, quality } = step.value;
  return { ns: settle(label, perRound, calls, quality), calls };
}

/**
 * One settled row of an awaited `fn`.
 * @returns {Promise<{ ns: number, calls: number }>}
 */
async function settledRowAsync(fn, iterations, warmup, label) {
  const plan = settledPlan(iterations, warmup);
  let step = plan.next();
  try {
    while (!step.done) {
      const count = step.value;
      const start = process.hrtime.bigint();
      for (let i = 0; i < count; i++)
        await fn();
      step = plan.next(Number(process.hrtime.bigint() - start));
    }
  }
  finally {
    if (!step.done) plan.return(undefined);
  }
  const { perRound, calls, quality } = step.value;
  return { ns: settle(label, perRound, calls, quality), calls };
}

//#endregion

/**
 * Nanoseconds per call over `iterations` runs, after `warmup` unmeasured
 * runs.
 * @param {() => void} fn
 * @param {number} iterations
 * @param {number} warmup
 * @returns {number} ns/op
 */
export function measureNsPerOp(fn, iterations, warmup) {
  if (METHOD === 'settled')
    return settledRow(fn, iterations, warmup, null, false).ns;
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
  if (METHOD === 'settled')
    return settledRow(fn, iterations, 2, null, false).ns / 1e6;
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
  if (METHOD === 'settled')
    return (await settledRowAsync(fn, iterations, warmup, null)).ns;
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
  if (METHOD === 'settled')
    return (await settledRowAsync(fn, iterations, 2, null)).ns / 1e6;
  await fn();
  await fn();
  return (await timeRoundsAsync(fn, iterations, null)) / 1e6;
}

/**
 * Build the labeled-row measurer of the table-style runners: it runs
 * `warmup` then `iterations` calls (the index is passed through to the
 * run callback) and returns a `{ label, ns }` row for `printTable`. A row
 * measured with `{ fixedCalls: true }` makes exactly those calls under
 * the settled method too, for state sized to them; one measured with
 * `{ fresh }` makes them once per settled round, `fresh` rebuilding the
 * state untimed before every round after the first.
 * @param {number} warmup
 * @param {number} iterations
 * @returns {(label: string, run: (i: number) => void, options?: { fixedCalls?: boolean, fresh?: (() => void) | null }) => { label: string, ns: number }}
 */
export function makeMeasure(warmup, iterations) {
  return function measure(label, run, { fixedCalls = false, fresh = null } = {}) {
    if (METHOD === 'settled' && fresh !== null)
      return { label, ns: sessionRow(run, iterations, warmup, label, fresh) };
    if (METHOD === 'settled') {
      const plan = fixedCalls ? fixedPlan(iterations, warmup) : settledPlan(iterations, warmup);
      return { label, ns: settledRow(run, iterations, warmup, label, true, plan).ns };
    }
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
  if (METHOD === 'settled') {
    const row = engine.isAsync
      ? await settledRowAsync(fn, 1, 1, null)
      : settledRow(fn, 1, 1, null, false);
    return { ns: row.ns, iterations: row.calls };
  }
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
