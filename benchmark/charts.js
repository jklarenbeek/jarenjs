#!/usr/bin/env node

/**
 * JarenJS charts performance benchmark
 *
 * The number that matters is the streaming budget: the line chart is
 * re-compiled and re-rendered per live snapshot, so `compile + toVnode`
 * for 100 points × 5 series must stay comfortably under 2 ms — the
 * charts program's acceptance bar. Bar and pie are measured alongside
 * for regression tracking; `toSvgString` adds the SSR serializer cost.
 * The two session sections measure the O(change) path against the
 * wholesale render it replaces: appended points for `line`, live
 * counts for `bar`.
 *
 * Usage:
 *   node benchmark/charts.js
 *   node benchmark/charts.js --points 500 --iterations 2000
 */

import { writeFileSync } from 'node:fs';

import { compileChart, createChartSession, buildLineAST } from '@jarenjs/charts';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';

import { formatNs as fmt } from './lib/fmt.js';
import { makeMeasure, printTable as printRows } from './lib/measure.js';

//#region options

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const POINTS = opt('points', 100);
const SERIES = opt('series', 5);
const ITERATIONS = opt('iterations', 1000);
const WARMUP = Math.max(10, Math.floor(ITERATIONS / 10));
const OUTPUT = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
const FILEPATH = args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null;

//#endregion

//#region fixtures

const lineData = {
  series: Array.from({ length: SERIES }, (_, s) => ({
    name: `series-${s}`,
    points: Array.from({ length: POINTS }, (_, i) => ({
      x: 1_721_556_000_000 + i * 1000,
      y: 100 + Math.sin(i / 9 + s) * 40 + s * 10,
    })),
  })),
};
const lineConfig = { type: 'line', title: 'Live feed', x: 'time' };

const barData = {
  categories: Array.from({ length: 20 }, (_, i) => `cat-${i}`),
  series: Array.from({ length: 4 }, (_, s) => ({
    name: `engine-${s}`,
    values: Array.from({ length: 20 }, (_, i) => (i + 1) * (s + 1) * 12.5),
  })),
};
const barConfig = { type: 'bar', title: '20 × 4 grouped', log: true };

const pieConfig = {
  type: 'pie', title: 'Slices',
  slices: Array.from({ length: 8 }, (_, i) => ({ label: `slice-${i}`, value: i + 1 })),
};

//#endregion

//#region timing

const measure = makeMeasure(WARMUP, ITERATIONS);

const printTable = (title, rows) => printRows(title, rows, { width: 40, ratios: false });

//#endregion

console.log(`line: ${POINTS} pts × ${SERIES} series, iterations: ${ITERATIONS} (+${WARMUP} warmup), node ${process.version}`);

const rows = [
  measure(`line ${POINTS}×${SERIES} compile+toVnode`, () => compileChart(lineConfig, { series: lineData.series }).toVnode()),
  measure(`line ${POINTS}×${SERIES} compile+toSvgString`, () => compileChart(lineConfig, { series: lineData.series }).toSvgString()),
  measure('bar 20×4 (log) compile+toVnode', () => compileChart(barConfig, barData).toVnode()),
  measure('pie 8 slices compile+toVnode', () => compileChart(pieConfig).toVnode()),
];
printTable('charts', rows);

const budgetNs = 2e6;
const lineNs = rows[0].ns;
if (POINTS === 100 && SERIES === 5 && lineNs >= budgetNs) {
  console.error(`\nBUDGET EXCEEDED: line 100×5 compile+toVnode = ${fmt(lineNs)} (budget 2 ms)`);
  process.exit(1);
}
console.log(`\nstreaming budget: line ${POINTS}×${SERIES} compile+toVnode = ${fmt(lineNs)} (target < 2 ms at 100×5)`);

//#region incremental session

/**
 * The session claim: one appended point costs O(1), independent of how
 * many points are already on screen. The domain policy (pinned y, a
 * window whose slide quantum the run never crosses) keeps every
 * measured tick on the incremental path — the printed mode counters
 * prove it; the wholesale row beside it is what the identity-memo
 * component pays for the same tick.
 */
function sessionBench(points, sampling) {
  const config = {
    type: 'line', title: 'Live', x: 'time', sampling,
    domain: { y: { min: 0, max: 200 }, x: { window: 1e15, slide: 1e15 } },
  };
  const adapter = createStreamAdapter('line', {
    recordBoundary: 'document', xField: 'x', yField: 'y', seriesField: 's',
    maxPoints: points + ITERATIONS + WARMUP + 16, changes: true,
  });
  let x = 1_721_556_000_000;
  const feed = (s, y) => {
    adapter.onEvent({ type: 'pair', path: ['x'], key: 'x', value: x });
    adapter.onEvent({ type: 'pair', path: ['s'], key: 's', value: s });
    adapter.onEvent({ type: 'pair', path: ['y'], key: 'y', value: y });
    adapter.endDocument();
  };
  for (let i = 0; i < points; i++) {
    for (let s = 0; s < SERIES; s++) feed(`s${s}`, 100 + (i % 50));
    x += 1000;
  }
  const session = createChartSession(config, adapter);
  session.tick();
  const modes = { unchanged: 0, incremental: 0, rebuilt: 0 };
  const label = sampling === false ? '' : ' sampled';
  const tickRow = measure(`line session tick @ ${points}×${SERIES}${label} (1 append)`, (i) => {
    feed('s0', 100 + (i % 50));
    x += 1000;
    modes[session.tick().mode]++;
  });
  const wholesaleRow = measure(`line wholesale tick @ ${points}×${SERIES}${label}`,
    () => compileChart(config, adapter.getData()).toVnode());
  return { tickRow, wholesaleRow, modes };
}

// The last row is the SAME corpus with sampling left at its default.
// Above two thousand points the sampler chooses which vertices are
// drawn, and one append can change that choice anywhere on the line —
// so the frame is not still and the session rebuilds. That is the
// price of the default, printed rather than avoided: a consumer who
// wants a flat tick at ten thousand points declares `sampling: false`,
// which is what the three rows above it are.
const sessionRows = [];
const sessionResults = [];
for (const [points, sampling] of [[100, false], [1000, false], [10000, false], [10000, undefined]]) {
  const result = sessionBench(points, sampling);
  sessionResults.push({ points, sampled: sampling !== false, ...result });
  sessionRows.push(result.tickRow, result.wholesaleRow);
}
printTable('incremental session (adapter feed + tick)', sessionRows);
for (const r of sessionResults) {
  console.log(`  @ ${String(r.points).padEnd(5)}${r.sampled ? ' sampled' : '        '} modes: ${r.modes.incremental} incremental / ${r.modes.rebuilt} rebuilt`);
}
const flat = sessionResults[2].tickRow.ns / sessionResults[0].tickRow.ns;
console.log(`\nsession flatness: tick @10000 ÷ tick @100 = ${flat.toFixed(2)}× `
  + `(wholesale grows ${(sessionResults[2].wholesaleRow.ns / sessionResults[0].wholesaleRow.ns).toFixed(1)}×)`);

//#endregion

//#region line sampling

/**
 * What a big static time line costs, and what it draws.
 *
 * Each size is built twice — every point mapped (`sampling: false`) and
 * the default policy, which above two thousand points hands the series
 * to `@jarenjs/core/series`'s downsampler and maps what comes back —
 * and each pair is measured twice: the AST alone, and the whole way to
 * an SVG string. Source and rendered counts are printed beside the
 * times, because a render that is faster only because it drew less of
 * the data is not faster until you say so.
 *
 * The two rows disagree, and that disagreement is the result. Choosing
 * the points costs about what mapping them costs — the sampler reads
 * every reading either way — so the AST row shows sampling as a small
 * LOSS. What it buys is the render: a path string and a vnode tree
 * over five hundred vertices instead of a hundred thousand.
 *
 * The INVARIANTS are checked before anything is timed, and a failure
 * exits non-zero: the sampled line has to start and end where the data
 * does, keep every run of gaps as a gap, and carry no vertex that is
 * not a source reading. A sampler that is quick and lies is a
 * regression, and a stopwatch cannot see it.
 */
const samplingSeries = (n) => Array.from({ length: n }, (_, i) => ({
  x: 1_721_556_000_000 + i * 1000,
  // a gap run in the middle, so the gap invariant has something to hold
  y: (i > n * 0.4 && i < n * 0.4 + 12) ? null
    : Math.round(4096 * Math.sin(i / 31)) / 4096 + (i % 7),
}));

const samplingResults = [];
const samplingRows = [];
for (const points of [2000, 20000, 100000]) {
  const data = { series: [{ name: 'readings', points: samplingSeries(points) }] };
  const config = { type: 'line', title: 'Readings', x: 'time' };
  const whole = buildLineAST(data, { ...config, sampling: false });
  const sampled = buildLineAST(data, config);
  const vertices = (ast) => ast.series[0].points;

  const expectSampled = points > 2000;
  const seen = new Set(vertices(whole).map((p) => (p === null ? 'gap' : `${p.u}|${p.v}`)));
  const drawn = vertices(sampled);
  const fabricated = drawn.filter((p) => p !== null && !seen.has(`${p.u}|${p.v}`)).length;
  const gaps = drawn.filter((p) => p === null).length;
  const sourceGaps = vertices(whole).filter((p) => p === null).length;
  const ends = JSON.stringify([drawn[0], drawn[drawn.length - 1]])
    === JSON.stringify([vertices(whole)[0], vertices(whole)[vertices(whole).length - 1]]);
  const failures = [
    fabricated !== 0 && `${fabricated} vertices were not source readings`,
    gaps !== (expectSampled ? 1 : sourceGaps)
      && `the one gap run left ${gaps} markers, not ${expectSampled ? 1 : sourceGaps}`,
    !ends && 'the drawn line does not start and end where the data does',
    expectSampled !== (sampled.sampling !== null)
      && `sampling was ${sampled.sampling === null ? 'not ' : ''}applied at ${points} points`,
    sampled.sampling !== null && sampled.sampling.renderedCount > sampled.sampling.target
      && 'more points were drawn than the target allows',
  ].filter(Boolean);
  if (failures.length !== 0) {
    console.error(`\nSAMPLING INVARIANT FAILED at ${points} points: ${failures.join('; ')}`);
    process.exit(1);
  }

  // fewer iterations here: a hundred thousand points is not a 1000-run
  const runs = makeMeasure(3, Math.max(5, Math.round(ITERATIONS / 40)));
  const wholeRow = runs(`line ${points} whole → AST`,
    () => buildLineAST(data, { ...config, sampling: false }));
  const sampledRow = runs(`line ${points} sampled → AST`, () => buildLineAST(data, config));
  const wholeSvg = runs(`line ${points} whole → svg`,
    () => compileChart({ ...config, sampling: false }, data).toSvgString());
  const sampledSvg = runs(`line ${points} sampled → svg`,
    () => compileChart(config, data).toSvgString());
  samplingRows.push(wholeRow, sampledRow, wholeSvg, sampledSvg);
  samplingResults.push({
    points, wholeRow, sampledRow, wholeSvg, sampledSvg,
    sourceCount: points,
    renderedCount: drawn.length,
    method: sampled.sampling === null ? 'none' : sampled.sampling.method,
  });
}
printTable('static line: source → AST → svg', samplingRows);
for (const r of samplingResults) {
  const ast = r.wholeRow.ns / r.sampledRow.ns;
  const svg = r.wholeSvg.ns / r.sampledSvg.ns;
  console.log(`  @ ${String(r.points).padEnd(6)} ${r.method.padEnd(5)} `
    + `${r.sourceCount} source → ${r.renderedCount} rendered, `
    + `AST ${ast.toFixed(2)}× · svg ${svg.toFixed(2)}×`);
}

//#endregion

//#region bar session

/**
 * The bar session's claim is narrower than the line's, and this run is
 * what keeps it narrow. Only the *vnode* work is O(1) — one rect
 * re-emitted instead of all of them. The stillness test still rescans
 * every category (a count that drops can retire the tallest bar, so
 * extremes cannot be extended) and the adapter rebuilds its snapshot
 * arrays, both O(categories), so the tick does grow with the category
 * count — just far more slowly than the wholesale render beside it.
 *
 * The steady state being measured is a still value axis — the counted
 * categories sit far below a leader that owns the axis top, which is
 * what a long-running counter looks like once it has warmed up. The
 * printed mode counters say how many ticks actually took the
 * incremental path; a count that raises the nice-number top rebuilds
 * by design, and the run would show it here.
 */
function barSessionBench(categories) {
  const config = { type: 'bar', title: 'Live counts', valLabel: 'events' };
  const adapter = createStreamAdapter('bar', {
    recordBoundary: 'document', xField: 'bucket', changes: true,
  });
  const feed = (bucket) => {
    adapter.onEvent({ type: 'pair', path: ['bucket'], key: 'bucket', value: bucket });
    adapter.endDocument();
  };
  // one leader owns the axis top; the rest are the live tail
  for (let i = 0; i < 5 * (ITERATIONS + WARMUP); i++) feed('bucket-0');
  for (let c = 1; c < categories; c++) {
    for (let i = 0; i < 10; i++) feed(`bucket-${c}`);
  }
  const session = createChartSession(config, adapter);
  session.tick();
  const modes = { unchanged: 0, incremental: 0, rebuilt: 0 };
  const tickRow = measure(`bar session tick @ ${categories} categories (1 count)`, (i) => {
    feed(`bucket-${1 + (i % Math.max(1, categories - 1))}`);
    modes[session.tick().mode]++;
  });
  const wholesaleRow = measure(`bar wholesale tick @ ${categories} categories`,
    () => compileChart(config, adapter.getData()).toVnode());
  return { tickRow, wholesaleRow, modes };
}

const barRows = [];
const barResults = [];
for (const categories of [20, 200]) {
  const result = barSessionBench(categories);
  barResults.push({ categories, ...result });
  barRows.push(result.tickRow, result.wholesaleRow);
}
printTable('bar session (live counts)', barRows);
for (const r of barResults) {
  console.log(`  @ ${String(r.categories).padEnd(5)} modes: ${r.modes.incremental} incremental / ${r.modes.rebuilt} rebuilt`);
}

//#endregion

if (OUTPUT === 'json') {
  // The website-data shape (benchmark/website-data.js → charts.json):
  // per-type compile costs, and the session-vs-wholesale scaling rows
  // that carry the O(change) story.
  const data = {
    date: new Date().toISOString(),
    node: process.version,
    points: POINTS,
    series: SERIES,
    iterations: ITERATIONS,
    types: rows.map((r) => ({ label: r.label, ns: r.ns })),
    sampling: samplingResults.map((r) => ({
      points: r.points,
      wholeNs: r.wholeRow.ns,
      sampledNs: r.sampledRow.ns,
      wholeSvgNs: r.wholeSvg.ns,
      sampledSvgNs: r.sampledSvg.ns,
      sourceCount: r.sourceCount,
      renderedCount: r.renderedCount,
      method: r.method,
    })),
    scaling: sessionResults.map((r) => ({
      points: r.points,
      series: SERIES,
      sampled: r.sampled,
      sessionNs: r.tickRow.ns,
      wholesaleNs: r.wholesaleRow.ns,
      incremental: r.modes.incremental,
      rebuilt: r.modes.rebuilt,
    })),
    barScaling: barResults.map((r) => ({
      categories: r.categories,
      sessionNs: r.tickRow.ns,
      wholesaleNs: r.wholesaleRow.ns,
      incremental: r.modes.incremental,
      rebuilt: r.modes.rebuilt,
    })),
  };
  const json = JSON.stringify(data, null, 2);
  if (FILEPATH !== null) {
    writeFileSync(FILEPATH, json);
    console.log(`\nwrote ${FILEPATH}`);
  }
  else {
    console.log(json);
  }
}
