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

import { compileChart, createChartSession } from '@jarenjs/charts';
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
function sessionBench(points) {
  const config = {
    type: 'line', title: 'Live', x: 'time',
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
  const tickRow = measure(`line session tick @ ${points}×${SERIES} (1 append)`, (i) => {
    feed('s0', 100 + (i % 50));
    x += 1000;
    modes[session.tick().mode]++;
  });
  const wholesaleRow = measure(`line wholesale tick @ ${points}×${SERIES}`,
    () => compileChart(config, adapter.getData()).toVnode());
  return { tickRow, wholesaleRow, modes };
}

const sessionRows = [];
const sessionResults = [];
for (const points of [100, 1000, 10000]) {
  const result = sessionBench(points);
  sessionResults.push({ points, ...result });
  sessionRows.push(result.tickRow, result.wholesaleRow);
}
printTable('incremental session (adapter feed + tick)', sessionRows);
for (const r of sessionResults) {
  console.log(`  @ ${String(r.points).padEnd(5)} modes: ${r.modes.incremental} incremental / ${r.modes.rebuilt} rebuilt`);
}
const flat = sessionResults[2].tickRow.ns / sessionResults[0].tickRow.ns;
console.log(`\nsession flatness: tick @10000 ÷ tick @100 = ${flat.toFixed(2)}× `
  + `(wholesale grows ${(sessionResults[2].wholesaleRow.ns / sessionResults[0].wholesaleRow.ns).toFixed(1)}×)`);

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
    scaling: sessionResults.map((r) => ({
      points: r.points,
      series: SERIES,
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
