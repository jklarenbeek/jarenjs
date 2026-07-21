//@ts-check
/**
 * @file The candlestick chart type: OHLC records on a time x-scale and
 * a linear y-scale. Up/down candles use the win/loss semantic pair —
 * gain and loss are exactly what the tokens mean, and the pair is
 * host-linked (`--ok`/`--fail`) like every semantic color. Data shape:
 *
 *   data   = { candles: [{t, open, high, low, close}] }
 *   config = { type:'candlestick', title?, xLabel?, yLabel? }
 *
 * Candle width comes from the band-width math: an equal share of the
 * axis per candle (klines arrive at a fixed interval, so equal bands
 * and true time positions coincide).
 */

import { svgRoot, line as svgLine } from '@jarenjs/view/helpers';
import { scaleLinear, scaleTime } from '../core/scale.js';
import { axisTicksLinear, formatTickValue, formatTimeTick } from '../core/axis.js';
import { cartesianFrame, annotateChart } from '../core/cartesian.js';

/**
 * @typedef {object} CandleAST
 * @property {number} u center position (0..1)
 * @property {number} w body width (0..1)
 * @property {number} openV @property {number} closeV
 * @property {number} highV @property {number} lowV
 * @property {boolean} up close >= open
 */
/**
 * @typedef {object} CandlestickAST
 * @property {'candlestick'} type
 * @property {string|null} title
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} x
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} y
 * @property {CandleAST[]} candles
 */

/**
 * Build the geometry-free candlestick AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {CandlestickAST}
 */
export function buildCandlestickAST(data, config = {}) {
  const input = (data?.candles ?? []).filter((c) =>
    Number.isFinite(numOf(c?.t)) && [c?.open, c?.high, c?.low, c?.close].every(Number.isFinite));

  let t0 = Infinity;
  let t1 = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of input) {
    const t = numOf(c.t);
    if (t < t0) t0 = t;
    if (t > t1) t1 = t;
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!Number.isFinite(t0)) { t0 = 0; t1 = 1; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }

  const xScale = scaleTime(t0, t1 === t0 ? t0 + 1 : t1);
  const yTickValues = axisTicksLinear(lo, hi, 5);
  const yLo = Math.min(lo, yTickValues[0] ?? lo);
  const yHi = Math.max(hi, yTickValues[yTickValues.length - 1] ?? hi);
  const yScale = scaleLinear(yLo, yHi === yLo ? yLo + 1 : yHi);
  const xTickValues = axisTicksLinear(t0, t1 === t0 ? t0 + 1 : t1, 4);

  const w = input.length === 0 ? 0.1 : (1 / input.length) * 0.7;
  const candles = input.map((c) => ({
    u: clamp01(xScale(numOf(c.t))),
    w,
    openV: clamp01(yScale(c.open)),
    closeV: clamp01(yScale(c.close)),
    highV: clamp01(yScale(c.high)),
    lowV: clamp01(yScale(c.low)),
    up: c.close >= c.open,
  }));

  return {
    type: 'candlestick',
    title: config.title ?? null,
    x: {
      ticks: xTickValues.map((v) => ({ pos: clamp01(xScale(v)), label: formatTimeTick(v) })),
      label: config.xLabel ?? null,
    },
    y: {
      ticks: yTickValues.map((v) => ({ pos: clamp01(yScale(v)), label: formatTickValue(v) })),
      label: config.yLabel ?? null,
    },
    candles,
  };
}

function numOf(v) {
  return v instanceof Date ? v.getTime() : v;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Render a candlestick AST to a pure-vnode SVG: `line` wicks under
 * `rect` bodies, up/down tones from the theme's win/loss pair.
 * @param {CandlestickAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, width?: number}} [options]
 * @returns {any}
 */
export function renderCandlestickAST(ast, theme, hash, options = {}) {
  const frame = cartesianFrame({
    title: ast.title,
    legend: null,
    xAxis: ast.x,
    yAxis: ast.y,
    grid: 'y',
    width: options.width,
    theme,
  });
  const { plot } = frame;
  const children = frame.children;
  for (const c of ast.candles) {
    const color = c.up ? theme.tokens.win : theme.tokens.loss;
    const x = plot.x + c.u * plot.w;
    const halfW = Math.max(1, (c.w * plot.w) / 2);
    const yHigh = plot.y + (1 - c.highV) * plot.h;
    const yLow = plot.y + (1 - c.lowV) * plot.h;
    const yOpen = plot.y + (1 - c.openV) * plot.h;
    const yClose = plot.y + (1 - c.closeV) * plot.h;
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yOpen - yClose));
    children.push(svgLine(round2(x), round2(yHigh), round2(x), round2(yLow),
      { stroke: color, 'stroke-width': 1, class: c.up ? 'chart-candle-up' : 'chart-candle-down' }));
    children.push(['rect', {
      x: round2(x - halfW), y: round2(bodyTop),
      width: round2(halfW * 2), height: round2(bodyH),
      fill: color, class: c.up ? 'chart-candle-up' : 'chart-candle-down',
    }]);
  }
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-candlestick-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'candle-') + hash);
  return annotateChart(svg, ast.title);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
