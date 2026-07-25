//@ts-check
/**
 * @file The candlestick chart type: OHLC records on a time x-scale and
 * a linear y-scale. Up/down candles use the win/loss semantic pair —
 * gain and loss are exactly what the tokens mean, and the pair is
 * host-linked (`--ok`/`--fail`) like every semantic color. Data shape:
 *
 *   data   = { candles: [{t, open, high, low, close}] }
 *   config = { type:'candlestick', title?, xLabel?, yLabel?, domain? }
 *
 * Candle width comes from the band-width math: an equal share of the
 * axis per candle (klines arrive at a fixed interval, so equal bands
 * and true time positions coincide).
 *
 * `config.domain` declares a domain-stability policy (`core/domain.js`):
 * a quantized sliding `x` window (candles older than it are dropped —
 * a clamped candle would misstate its prices), pinned or
 * step-quantized `y` bounds. The AST records the resolved domain so a
 * later build — or the incremental session — can detect "unchanged".
 *
 * The extremes scan, domain resolution and per-candle mapping are
 * exported (`scanCandleExtremes` / `resolveCandleDomains` /
 * `candleUnit`) because the session must make the same decisions from
 * the same numbers. Each candle renders as one keyed
 * `<g class="chart-candle">` (wick line, then body rect) — the candle
 * is the replaceable unit a kline upsert patches; `buildCandlestickRender`
 * is the render variant that also returns that geometry.
 */

import { svgRoot, line as svgLine, coord } from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { scaleLinear, scaleTime } from '../core/scale.js';
import { axisTicksLinear, formatTickValue, formatTimeTick } from '../core/axis.js';
import { cartesianFrame, annotateChart } from '../core/cartesian.js';
import { numOf } from '../core/stream-adapter.js';
import {
  normalizeDomainPolicy, resolveWindowX, resolveStepY, resolvePinnedY,
} from '../core/domain.js';

/**
 * @typedef {object} CandleAST
 * @property {number} t open time (epoch ms — the candle's identity)
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
 * @property {{x: [number, number], y: [number, number]}} domain resolved scale bounds
 * @property {CandleAST[]} candles
 */

/**
 * Scan the candle extremes the domain resolution needs: t bounds over
 * every well-formed candle, price bounds over the candles a window
 * keeps — and the kept list itself (windowed-out candles are dropped
 * entirely; a candle clamped to the edge would misstate its prices).
 * @param {any[]} rawCandles
 * @param {import('../core/domain.js').DomainPolicy} policy
 * @returns {{t0:number, t1:number, lo:number, hi:number, kept: any[]}}
 */
export function scanCandleExtremes(rawCandles, policy) {
  const all = (rawCandles ?? []).filter((c) =>
    Number.isFinite(numOf(c?.t)) && [c?.open, c?.high, c?.low, c?.close].every(Number.isFinite));
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const c of all) {
    const t = numOf(c.t);
    if (t < t0) t0 = t;
    if (t > t1) t1 = t;
  }
  let kept = all;
  if (policy.window !== null) {
    const [wLo] = resolveWindowX(t1, policy.window, policy.slide);
    kept = all.filter((c) => numOf(c.t) >= wLo);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of kept) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  return { t0, t1, lo, hi, kept };
}

/**
 * Resolve the scale domains (and their tick values) from the scanned
 * extremes under the domain policy — the single place the candlestick
 * type decides its bounds.
 * @param {{t0:number, t1:number, lo:number, hi:number}} ext
 * @param {import('../core/domain.js').DomainPolicy} policy
 * @returns {{x: [number,number], y: [number,number],
 *   xTickValues: number[], yTickValues: number[]}}
 */
export function resolveCandleDomains(ext, policy) {
  let { t0, t1, lo, hi } = ext;
  if (policy.window !== null)
    [t0, t1] = resolveWindowX(ext.t1, policy.window, policy.slide);
  if (!Number.isFinite(t0)) { t0 = 0; t1 = 1; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }

  const xHi = t1 === t0 ? t0 + 1 : t1;
  let yTickValues;
  let yLo;
  let yHi;
  if (policy.step || policy.pin !== null) {
    [yLo, yHi] = policy.step ? resolveStepY(lo, hi) : resolvePinnedY(lo, hi, policy.pin, false);
    if (yHi === yLo) yHi = yLo + 1;
    yTickValues = axisTicksLinear(yLo, yHi, 5);
  }
  else {
    yTickValues = axisTicksLinear(lo, hi, 5);
    yLo = Math.min(lo, yTickValues[0] ?? lo);
    const extended = Math.max(hi, yTickValues[yTickValues.length - 1] ?? hi);
    yHi = extended === yLo ? yLo + 1 : extended;
  }
  return {
    x: [t0, xHi],
    y: [yLo, yHi],
    xTickValues: axisTicksLinear(t0, xHi, 4),
    yTickValues,
  };
}

/**
 * Map one OHLC record onto its unit-space candle — the per-candle half
 * of the build, shared with the session.
 * @param {any} c a well-formed `{t, open, high, low, close}` record
 * @param {(v:number)=>number} xScale @param {(v:number)=>number} yScale
 * @param {number} w candle width (0..1)
 * @returns {CandleAST}
 */
export function candleUnit(c, xScale, yScale, w) {
  const t = numOf(c.t);
  return {
    t,
    u: clamp01(xScale(t)),
    w,
    openV: clamp01(yScale(c.open)),
    closeV: clamp01(yScale(c.close)),
    highV: clamp01(yScale(c.high)),
    lowV: clamp01(yScale(c.low)),
    up: c.close >= c.open,
  };
}

/**
 * Build the geometry-free candlestick AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {CandlestickAST}
 */
export function buildCandlestickAST(data, config = {}) {
  const policy = normalizeDomainPolicy(config.domain);
  const ext = scanCandleExtremes(data?.candles, policy);
  const domains = resolveCandleDomains(ext, policy);
  const xScale = scaleTime(domains.x[0], domains.x[1]);
  const yScale = scaleLinear(domains.y[0], domains.y[1]);

  const w = ext.kept.length === 0 ? 0.1 : (1 / ext.kept.length) * 0.7;
  const candles = ext.kept.map((c) => candleUnit(c, xScale, yScale, w));

  return {
    type: 'candlestick',
    title: config.title ?? null,
    x: {
      ticks: domains.xTickValues.map((v) => ({ pos: clamp01(xScale(v)), label: formatTimeTick(v) })),
      label: config.xLabel ?? null,
    },
    y: {
      ticks: domains.yTickValues.map((v) => ({ pos: clamp01(yScale(v)), label: formatTickValue(v) })),
      label: config.yLabel ?? null,
    },
    domain: { x: domains.x, y: domains.y },
    candles,
  };
}

/**
 * Render one candle as its keyed `<g>` group: the wick line under the
 * body rect, up/down tones from the theme's win/loss pair.
 * @param {CandleAST} c
 * @param {{x:number,y:number,w:number,h:number}} plot
 * @param {{tokens: Record<string,string>}} theme
 * @returns {any}
 */
export function candleRender(c, plot, theme) {
  const color = c.up ? theme.tokens.win : theme.tokens.loss;
  const x = plot.x + c.u * plot.w;
  const halfW = Math.max(1, (c.w * plot.w) / 2);
  const yHigh = plot.y + (1 - c.highV) * plot.h;
  const yLow = plot.y + (1 - c.lowV) * plot.h;
  const yOpen = plot.y + (1 - c.openV) * plot.h;
  const yClose = plot.y + (1 - c.closeV) * plot.h;
  const bodyTop = Math.min(yOpen, yClose);
  const bodyH = Math.max(1, Math.abs(yOpen - yClose));
  return ['g', { key: `c${c.t}`, class: 'chart-candle' },
    svgLine(coord(x), coord(yHigh), coord(x), coord(yLow),
      { stroke: color, 'stroke-width': 1, class: c.up ? 'chart-candle-up' : 'chart-candle-down' }),
    ['rect', {
      x: coord(x - halfW), y: coord(bodyTop),
      width: coord(halfW * 2), height: coord(bodyH),
      fill: color, class: c.up ? 'chart-candle-up' : 'chart-candle-down',
    }],
  ];
}

/**
 * Render a candlestick AST and return the svg WITH the geometry a
 * session needs to patch it per candle.
 * @param {CandlestickAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, width?: number}} [options]
 * @returns {{svg: any, plot: {x:number,y:number,w:number,h:number}, chromeLen: number}}
 */
export function buildCandlestickRender(ast, theme, hash, options = {}) {
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
  const chromeLen = frame.children.length;
  const children = frame.children;
  for (const c of ast.candles)
    children.push(candleRender(c, plot, theme));
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-candlestick-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'candle-') + hash);
  annotateChart(svg, ast.title);
  return { svg, plot, chromeLen };
}

/**
 * Render a candlestick AST to a pure-vnode SVG.
 * @param {CandlestickAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, width?: number}} [options]
 * @returns {any}
 */
export function renderCandlestickAST(ast, theme, hash, options = {}) {
  return buildCandlestickRender(ast, theme, hash, options).svg;
}
