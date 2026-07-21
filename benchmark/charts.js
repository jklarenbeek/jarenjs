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

import { compileChart } from '@jarenjs/charts';

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
