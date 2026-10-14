//@ts-check
/**
 * A compact number label picks its unit after rounding. Rounding to three
 * digits inside `k` or `M` could carry into 1000 of that unit, so
 * 999,999 read `1000k` and 999,999,999 read `1000M` where the next unit
 * was due (`1M`, `1G`) — in tick labels, tooltips and gauge readings alike.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { formatTickValue, compileChart } from '@jarenjs/charts';

describe('formatTickValue — the unit follows the rounding', function () {
  it('carries into the next unit instead of printing 1000 of this one', () => {
    assert.equal(formatTickValue(999.5), '1k');
    assert.equal(formatTickValue(999500), '1M');
    assert.equal(formatTickValue(999999), '1M');
    assert.equal(formatTickValue(999999999), '1G');
    assert.equal(formatTickValue(-999999), '-1M');
  });

  it('leaves values that do not round up to the unit alone', () => {
    const expected = [
      [0, '0'], [0.5, '0.5'], [999, '999'], [999.4, '999'], [1000, '1k'], [1234, '1.23k'], [999499, '999k'],
      [123456, '123k'], [1e6, '1M'], [2.5e6, '2.5M'], [1e9, '1G'], [1.5e12, '1500G'], [0.0004, '0.0004'], [-1234, '-1.23k'],
    ];
    for (const [value, label] of expected) assert.equal(formatTickValue(/** @type {number} */ (value)), label, String(value));
  });
});

/** @param {{ticks: {label: string}[]}} axis */
const labelsOf = (axis) => axis.ticks.map((t) => t.label);
/** @param {number[]} ys a one-series line over them */
const lineY = (ys) => labelsOf(compileChart({ type: 'line' },
  { series: [{ name: 'a', points: ys.map((y, x) => ({ x, y })) }] }).ast.y);

describe('axis tick labels — neighbours never print the same text', function () {
  it('a narrow BTC range around 81,6xx prints the precision its step needs', () => {
    // three significant digits read 81.6k 81.6k 81.6k 81.7k 81.7k here
    assert.deepEqual(lineY([81612.5, 81598.4, 81688.8]), ['81.60k', '81.62k', '81.64k', '81.66k', '81.68k']);
  });

  it('an ETH range around 2,5xx', () => {
    assert.deepEqual(lineY([2521.4, 2508.3, 2515.7]), ['2.510k', '2.512k', '2.514k', '2.516k', '2.518k', '2.520k']);
  });

  it('a step of 0.001', () => {
    assert.deepEqual(lineY([12.001, 12.0052]), ['12.001', '12.002', '12.003', '12.004', '12.005']);
  });

  it('one decimal when one is enough, the unit of the largest tick, and a lone repeated pair', () => {
    assert.deepEqual(lineY([100.1, 100.9]), ['100.2', '100.4', '100.6', '100.8']);
    // 999.6 alone reads 1k: the axis is labelled in k, the unit of its largest tick
    assert.deepEqual(lineY([999.5, 1000.5]), ['0.9996k', '0.9998k', '1.0000k', '1.0002k', '1.0004k']);
    // only the first two ticks repeat (1.01k 1.01k 1.02k)
    assert.deepEqual(lineY([1006, 1022]), ['1.010k', '1.015k', '1.020k']);
  });

  it('the left and right axes of a y2 chart', () => {
    const t0 = Date.UTC(2026, 9, 14, 12);
    const ast = compileChart({ type: 'line', x: 'time', y2: { series: ['ETH'] } }, { series: [
      { name: 'BTC', points: [81612.5, 81598.4, 81688.8].map((y, i) => ({ x: t0 + i * 2000, y })) },
      { name: 'ETH', points: [2521.4, 2508.3, 2515.7].map((y, i) => ({ x: t0 + i * 2000, y })) },
    ] }).ast;
    assert.deepEqual(labelsOf(ast.y), ['81.60k', '81.62k', '81.64k', '81.66k', '81.68k']);
    assert.deepEqual(ast.y2 && labelsOf(ast.y2), ['2.510k', '2.512k', '2.514k', '2.516k', '2.518k', '2.520k']);
  });

  it('a live-shaped candlestick under a step domain', () => {
    const candles = Array.from({ length: 30 }, (_, i) => {
      const o = 81600 + Math.round(Math.sin(i / 3) * 40);
      return { t: 1791979200000 + i * 60000, open: o, close: o + 12, high: o + 25, low: o - 20 };
    });
    assert.deepEqual(labelsOf(compileChart({ type: 'candlestick', domain: { y: 'step' } }, { candles }).ast.y),
      ['81.50k', '81.55k', '81.60k', '81.65k', '81.70k']);
  });

  it('negative ticks keep their sign and share one precision', () => {
    const ast = compileChart({ type: 'scatter', points: [{ x: 0, y: -1.0003 }, { x: 1, y: -0.9997 }] }).ast;
    assert.deepEqual(labelsOf(ast.y), ['-1.0003', '-1.0002', '-1.0001', '-1.0000', '-0.9999', '-0.9998', '-0.9997']);
  });

  it('boxplot, streamgraph, gauge, scatter and a linear line x axis label the same way', () => {
    const narrow = ['81.60k', '81.62k', '81.64k', '81.66k', '81.68k'];
    assert.deepEqual(labelsOf(compileChart({ type: 'line' }, { series: [{ name: 'a',
      points: [{ x: 81600, y: 1 }, { x: 81680, y: 2 }] }] }).ast.x), narrow);
    assert.deepEqual(labelsOf(compileChart({ type: 'boxplot', boxes: [{ label: 'a', values: [81612, 81640, 81688] }] }).ast.val),
      narrow.slice(1));
    assert.deepEqual(labelsOf(compileChart({ type: 'streamgraph', xs: [81600, 81640, 81680],
      series: [{ name: 'a', values: [1, 2, 3] }] }).ast.x), narrow);
    assert.deepEqual(compileChart({ type: 'gauge', value: 81640, min: 81600, max: 81680 }).ast.ticks.map((t) => t.label),
      narrow);
    assert.deepEqual(labelsOf(compileChart({ type: 'scatter', points: [{ x: 81612, y: 1 }, { x: 81688, y: 2 }] }).ast.x),
      narrow.slice(1));
  });

  it('labels that already differ print exactly as formatTickValue prints them', () => {
    assert.deepEqual(lineY([0.001, 0.0052]), ['0.001', '0.002', '0.003', '0.004', '0.005']);
    assert.deepEqual(lineY([0, 1000]), ['0', '200', '400', '600', '800', '1k']);
    assert.deepEqual(lineY([0, 2.5e6]), ['0', '500k', '1M', '1.5M', '2M', '2.5M']);
  });
});
