#!/usr/bin/env node

/**
 * JarenJS charts performance benchmark
 *
 * The number that matters is the streaming budget: the line chart is
 * re-compiled and re-rendered per live snapshot, so `compile + toVnode`
 * for 100 points × 5 series must stay comfortably under 2 ms — the
 * charts program's acceptance bar. Bar and pie are measured alongside
 * for regression tracking; `toSvgString` adds the SSR serializer cost.
 *
 * Usage:
 *   node benchmark/charts.js
 *   node benchmark/charts.js --points 500 --iterations 2000
 */

/* eslint-disable no-console */

import { writeFileSync } from 'node:fs';

import { compileChart, createChartSession } from '@jarenjs/charts';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';

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

function measure(label, run) {
  for (let i = 0; i < WARMUP; i++) run(i);
  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) run(i);
  const ns = Number(process.hrtime.bigint() - start) / ITERATIONS;
  return { label, ns };
}

function fmt(ns) {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1e6) return `${(ns / 1000).toFixed(1)} µs`;
  return `${(ns / 1e6).toFixed(2)} ms`;
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  for (const row of rows)
    console.log(`  ${row.label.padEnd(40)} ${fmt(row.ns).padStart(10)}`);
}

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
