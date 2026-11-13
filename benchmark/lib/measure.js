//#region benchmark measurement
// Timing loops shared by the suite runners. Warmup counts stay with the
// callers - every suite tunes its own - so each helper takes them as
// arguments instead of reading a module constant.

import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { GCProfiler } from 'node:v8';

import { formatNs } from './fmt.js';

// Every helper below times a row by the clock (see "settled rows"). Its
// iteration count is a floor on the calls in its rounds and its warmup
// count a floor on its warm-up. BENCH_ROUNDS_LOG names a file each row's
// per-round ns/op and how it settled are appended to as one JSON line.
const ROUNDS_LOG = process.env.BENCH_ROUNDS_LOG || null;
let rowSeq = 0;
/** The logged row's round start and end times on the `performance` clock, while the log is on. */
let spans = null;

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

//#region settled rows
// A row is warmed for at least `warmMinMs` and until two blocks in a row
// agree; its rounds are sized so each lasts at least `minRoundMs` and holds
// at least `collectionsPerRound` of the collections its own garbage causes
// (counted while it warms); and a row whose median round is more than
// `settle` times its fastest is timed again with rounds twice as long, at
// most `retries` times, and logged as unsettled if it still disagrees.

// BENCH_SCALE multiplies every clock budget below (1 by default); 0 times
// a row's iteration floor in its rounds with no warm-up and no retry, for
// a run that checks the wiring rather than the figures.
const SCALE = scaleFromEnv();
const SETTLED = Object.freeze({
  rounds: 7,
  blockMs: 10 * SCALE,
  warmMinMs: 50 * SCALE,
  warmMaxMs: 2000 * SCALE,
  agree: 1.05,
  minRoundMs: 10 * SCALE,
  maxRoundMs: 400 * SCALE,
  collectionsPerRound: SCALE === 0 ? 0 : 2,
  settle: 1.15,
  retries: SCALE === 0 ? 0 : 2,
});

function scaleFromEnv() {
  const raw = process.env.BENCH_SCALE;
  if (raw === undefined || raw === '')
    return 1;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale < 0)
    throw new Error(`BENCH_SCALE must be a number of at least 0, got ${JSON.stringify(raw)}`);
  return scale;
}
const MS = 1e6;
// a row on fresh state: untimed passes that warm the code it drives, then
// timed ones, enough of them that the median is not decided by which
// short pass caught a collection of the garbage the rebuild left
const SESSIONS = Object.freeze(SCALE === 0 ? { warm: 0, rounds: 1 } : { warm: 2, rounds: 21 });

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
  const collectionsPerCall = warmCalls === 0 ? 0 : collections / warmCalls;
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
    method: 'settled', sessions: passes, warmSessions: SESSIONS.warm, warmCalls: warmup, roundCalls: iterations,
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
export function refuseThenable(value, label) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function')
    throw new Error(`${label === null ? 'a sync row' : `row '${label}'`} returned a promise: time it with the awaited helpers`);
}

/**
 * One settled row of a sync `fn`; the loop index runs on across every block.
 * @returns {{ ns: number, calls: number }}
 */
function settledRow(fn, iterations, warmup, label, passIndex) {
  const plan = settledPlan(iterations, warmup);
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
  return settledRow(fn, iterations, warmup, null, false).ns;
}

/**
 * Milliseconds per call over `iterations` runs, after two unmeasured
 * warmup calls (the corpus-parsing suites' shape).
 * @param {() => void} fn
 * @param {number} iterations
 * @returns {number} ms/op
 */
export function timeIt(fn, iterations) {
  return settledRow(fn, iterations, 2, null, false).ns / 1e6;
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
  return (await settledRowAsync(fn, iterations, warmup, null)).ns;
}

/**
 * Milliseconds per awaited call over `iterations` runs, after two
 * unmeasured awaited calls.
 * @param {() => unknown} fn
 * @param {number} iterations
 * @returns {Promise<number>} ms/op
 */
export async function timeItAsync(fn, iterations) {
  return (await settledRowAsync(fn, iterations, 2, null)).ns / 1e6;
}

/**
 * Build the labeled-row measurer of the table-style runners: it times
 * `run` (the loop index is passed through) with `warmup` and `iterations`
 * as floors and returns a `{ label, ns }` row for `printTable`. A row
 * measured with `{ fresh }` drives state sized to exactly `warmup` +
 * `iterations` calls (a session fed one point per call, say): it makes
 * those calls once per round, `fresh` rebuilding the state untimed before
 * every pass after the first.
 * @param {number} warmup
 * @param {number} iterations
 * @returns {(label: string, run: (i: number) => void, options?: { fresh?: (() => void) | null }) => { label: string, ns: number }}
 */
export function makeMeasure(warmup, iterations) {
  return function measure(label, run, { fresh = null } = {}) {
    if (fresh !== null)
      return { label, ns: sessionRow(run, iterations, warmup, label, fresh) };
    return { label, ns: settledRow(run, iterations, warmup, label, true).ns };
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

/**
 * One cell of the engine-matrix runners (jslt, jsonquery), timed sync or
 * awaited as the engine is.
 * @param {{ isAsync?: boolean }} engine
 * @param {() => any} fn
 * @returns {Promise<{ ns: number, iterations: number }>}
 */
export async function measureCell(engine, fn) {
  const row = engine.isAsync
    ? await settledRowAsync(fn, 1, 1, null)
    : settledRow(fn, 1, 1, null, false);
  return { ns: row.ns, iterations: row.calls };
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
