//@ts-check
/**
 * @file The incremental chart session: a stateful compile pipeline for
 * the streaming chart types that consumes a change-reporting source
 * (`createStreamAdapter` with `{ changes: true }`, or anything with
 * the same `takeChanges()`/`getData()` pair) and produces the next
 * vnode tree in O(changed marks) work — WHEN the frame is "still".
 *
 * The stillness test is exact, not heuristic: the session re-resolves
 * the scale domains from the updated extremes with the SAME exported
 * helpers the wholesale build uses, and compares against the AST's
 * recorded domain. Equal domains ⇒ every existing mark's position is
 * unchanged, so only touched series re-render (untouched children
 * keep their references — the view patcher skips them in O(1)).
 * Anything else — a moved domain, a new series, a reset — falls back
 * to a wholesale rebuild, which is the correct rendering of a frame
 * whose scales moved, not a failure mode. Domain-stability policies
 * (`config.domain`, `core/domain.js`) exist to make most ticks still.
 *
 * The correctness contract is byte equality: after every `tick()`,
 * serializing the session's vnode equals serializing a wholesale
 * `compileChart(config, source.getData())` of the same data —
 * property-tested, never assumed.
 */

import { path as svgPath, circle } from '@jarenjs/view/helpers';
import { hashContent } from '@jarenjs/core/string';
import { stableStringify } from '@jarenjs/core/object';
import { scaleLinear, scaleTime } from './scale.js';
import { createTheme, CATEGORICAL } from './palette.js';
import { normalizeDomainPolicy } from './domain.js';
import {
  buildLineAST, buildLineRender, scanLineExtremes, resolveLineDomains,
  lineScales, lineVertex, lineSeriesRender,
} from '../types/line.js';
import {
  buildCandlestickAST, buildCandlestickRender, scanCandleExtremes,
  resolveCandleDomains, candleUnit, candleRender,
} from '../types/candlestick.js';

const APPEND_PATH = /^\/series\/(\d+)\/points\/-$/;
const EVICT_PATH = /^\/series\/(\d+)\/points\/0$/;
const UPSERT_PATH = /^\/candles\/(\d+)$/;

/**
 * @typedef {object} ChartSessionSource
 * @property {() => {op: string, path: string, value?: any}[]} takeChanges
 * @property {() => any} getData
 */
/**
 * @typedef {object} ChartSessionResult
 * @property {any} vnode the current svg vnode (reference-stable when unchanged)
 * @property {'unchanged'|'incremental'|'rebuilt'} mode which path produced it
 */
/**
 * @typedef {object} ChartSession
 * @property {() => ChartSessionResult} tick drain the source and produce the next frame
 */

/**
 * Create an incremental session for a streaming chart. Supported
 * `config.type`: `'line'` (append/evict traffic) and `'candlestick'`
 * (keyed kline upserts). The config is treated as immutable for the
 * session's lifetime.
 * @param {{type: string, [k: string]: any}} config
 * @param {ChartSessionSource} source
 * @param {{theme?: any, palette?: readonly string[], width?: number,
 *   rootClass?: string, keyPrefix?: string}} [options]
 * @returns {ChartSession}
 * @throws {TypeError} On an unsupported chart type
 */
export function createChartSession(config, source, options = {}) {
  if (config?.type === 'line') return createLineSession(config, source, options);
  if (config?.type === 'candlestick') return createCandleSession(config, source, options);
  throw new TypeError(`createChartSession does not support type '${config?.type}'`);
}

/**
 * The line session: O(1) tail appends and O(series) head evictions
 * under a still domain.
 * @param {any} config @param {ChartSessionSource} source @param {any} options
 * @returns {ChartSession}
 */
function createLineSession(config, source, options) {
  const time = config.x === 'time';
  const log = config.log === true;
  const markers = config.markers === true;
  const policy = normalizeDomainPolicy(config.domain);
  const palette = options.palette ?? CATEGORICAL;
  const theme = createTheme(options.theme);
  const hash = hashContent(stableStringify(config) ?? '');

  /** @type {any} */ let vnode = null;
  /** @type {any} */ let ast = null;
  /** @type {{svg:any, plot:any, chromeLen:number, series:any[]}|null} */ let render = null;
  /** @type {{x0:number,x1:number,y0:number,y1:number}|null} */ let ext = null;
  /** @type {number|null} the current window low bound */ let xDrop = null;

  function rebuild(dataMaybe) {
    const data = dataMaybe ?? source.getData();
    const input = (data?.series ?? []).filter((s) => Array.isArray(s.points));
    ext = scanLineExtremes(input, policy, log);
    ast = buildLineAST(data, config);
    render = buildLineRender(ast, theme, hash, options);
    xDrop = resolveLineDomains(ext, policy, time, log).xDrop;
    vnode = render.svg;
    return { vnode, mode: /** @type {const} */ ('rebuilt') };
  }

  /** Extend the extremes with one appended sample (the scan's rules). */
  function extend(e, pt) {
    const px = pt?.x instanceof Date ? pt.x.getTime() : pt?.x;
    const py = pt?.y instanceof Date ? pt.y.getTime() : pt?.y;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    if (px < e.x0) e.x0 = px;
    if (px > e.x1) e.x1 = px;
    if (log && py <= 0) return;
    // under a window, only in-window samples may pin the y extremes
    if (xDrop !== null && px < xDrop) return;
    if (py < e.y0) e.y0 = py;
    if (py > e.y1) e.y1 = py;
  }

  function tick() {
    const ops = source.takeChanges();
    if (vnode !== null && ops.length === 0)
      return { vnode, mode: /** @type {const} */ ('unchanged') };
    if (vnode === null) return rebuild();

    // Classify: only in-place point traffic is incremental; anything
    // else (new series, reset, unknown shapes) rebuilds from truth.
    const steps = [];
    let hasEvict = false;
    for (const op of ops) {
      let m;
      if (op.op === 'add' && (m = APPEND_PATH.exec(op.path)) !== null) {
        const si = Number(m[1]);
        if (ast.series[si] === undefined) return rebuild();
        steps.push({ evict: false, si, pt: op.value });
      }
      else if (op.op === 'remove' && (m = EVICT_PATH.exec(op.path)) !== null) {
        const si = Number(m[1]);
        if (ast.series[si] === undefined) return rebuild();
        steps.push({ evict: true, si });
        hasEvict = true;
      }
      else {
        return rebuild();
      }
    }

    // The stillness test: re-resolve the domain over the updated
    // extremes; an eviction may retire an extreme, so rescan truth.
    let nextExt;
    let truth = null;
    if (hasEvict) {
      truth = source.getData();
      const input = (truth?.series ?? []).filter((s) => Array.isArray(s.points));
      nextExt = scanLineExtremes(input, policy, log);
    }
    else {
      nextExt = { ...ext };
      for (const step of steps) {
        if (!step.evict) extend(nextExt, step.pt);
      }
    }
    const domains = resolveLineDomains(nextExt, policy, time, log);
    const d = ast.domain;
    if (domains.x[0] !== d.x[0] || domains.x[1] !== d.x[1]
      || domains.y[0] !== d.y[0] || domains.y[1] !== d.y[1]) {
      return rebuild(truth);
    }

    // Still frame: apply the point traffic to the AST and the series
    // render parts; untouched series keep their vnode references.
    const { xScale, yScale } = lineScales(domains, time, log);
    const { plot } = render;
    const touched = new Set();
    const evicted = new Set();
    for (const step of steps) {
      touched.add(step.si);
      if (step.evict) {
        ast.series[step.si].points.shift();
        evicted.add(step.si);
        continue;
      }
      const vertex = lineVertex(step.pt, domains.xDrop, xScale, yScale);
      ast.series[step.si].points.push(vertex);
      if (evicted.has(step.si)) continue; // that series re-emits wholesale below
      const parts = render.series[step.si];
      if (vertex === null) {
        parts.pen = false;
        continue;
      }
      const px = round2(plot.x + vertex.u * plot.w);
      const py = round2(plot.y + (1 - vertex.v) * plot.h);
      parts.d = parts.d === '' ? `M${px} ${py}` : `${parts.d} ${parts.pen ? 'L' : 'M'}${px} ${py}`;
      parts.pen = true;
      if (markers) parts.dots.push(circle(px, py, 2.5, { fill: parts.color, class: 'chart-dot' }));
    }

    const next = vnode.slice();
    // annotateChart splices a <title> child at index 2 only for a
    // truthy title — the offset must mirror that exactly
    const offset = 2 + (ast.title ? 1 : 0) + render.chromeLen;
    for (const si of touched) {
      let parts = render.series[si];
      if (evicted.has(si)) {
        parts = lineSeriesRender(ast.series[si], si, plot, palette, markers);
      }
      else {
        const children = parts.d !== ''
          ? [svgPath(parts.d, { stroke: parts.color, 'stroke-width': 2, fill: 'none', class: 'chart-line' }), ...parts.dots]
          : [...parts.dots];
        parts = { ...parts, group: [parts.group[0], parts.group[1], ...children] };
      }
      render.series[si] = parts;
      next[offset + si] = parts.group;
    }
    ext = nextExt;
    vnode = next;
    return { vnode, mode: /** @type {const} */ ('incremental') };
  }

  return { tick };
}

/**
 * The candlestick session: a keyed kline upsert re-renders exactly its
 * own candle group when the domain holds. An upsert can retire a price
 * extreme, so the stillness test always rescans the (maxPoints-bounded)
 * truth — the vnode work, not the scan, is what O(1) buys here.
 * Appends and evictions change the candle count, and with it every
 * candle's band width — those frames rebuild by design.
 * @param {any} config @param {ChartSessionSource} source @param {any} options
 * @returns {ChartSession}
 */
function createCandleSession(config, source, options) {
  const policy = normalizeDomainPolicy(config.domain);
  const theme = createTheme(options.theme);
  const hash = hashContent(stableStringify(config) ?? '');

  /** @type {any} */ let vnode = null;
  /** @type {any} */ let ast = null;
  /** @type {{svg:any, plot:any, chromeLen:number}|null} */ let render = null;
  /** @type {Map<number, number>} candle open time → AST index */ let astIndex = new Map();

  function rebuild(dataMaybe) {
    const data = dataMaybe ?? source.getData();
    ast = buildCandlestickAST(data, config);
    render = buildCandlestickRender(ast, theme, hash, options);
    astIndex = new Map();
    for (let i = 0; i < ast.candles.length; i++)
      astIndex.set(ast.candles[i].t, i);
    vnode = render.svg;
    return { vnode, mode: /** @type {const} */ ('rebuilt') };
  }

  function tick() {
    const ops = source.takeChanges();
    if (vnode !== null && ops.length === 0)
      return { vnode, mode: /** @type {const} */ ('unchanged') };
    if (vnode === null) return rebuild();

    // Only in-place upserts are incremental: an add or evict changes
    // the candle count and with it every band width.
    const upserts = [];
    for (const op of ops) {
      if (op.op !== 'replace' || !UPSERT_PATH.test(op.path)) return rebuild();
      upserts.push(op.value);
    }

    // Stillness test over truth: a replaced candle may have carried a
    // price extreme, so extremes are rescanned, never extended.
    const truth = source.getData();
    const ext = scanCandleExtremes(truth?.candles, policy);
    const domains = resolveCandleDomains(ext, policy);
    const d = ast.domain;
    if (domains.x[0] !== d.x[0] || domains.x[1] !== d.x[1]
      || domains.y[0] !== d.y[0] || domains.y[1] !== d.y[1]) {
      return rebuild(truth);
    }

    const xScale = scaleTime(domains.x[0], domains.x[1]);
    const yScale = scaleLinear(domains.y[0], domains.y[1]);
    const { plot } = render;
    const offset = 2 + (ast.title ? 1 : 0) + render.chromeLen;
    const next = vnode.slice();
    for (const candle of upserts) {
      const t = candle?.t instanceof Date ? candle.t.getTime() : candle?.t;
      if (!Number.isFinite(t)
        || ![candle?.open, candle?.high, candle?.low, candle?.close].every(Number.isFinite)) {
        return rebuild(truth);
      }
      const at = astIndex.get(t);
      // a candle behind the window is data without pixels — nothing to patch
      if (at === undefined) continue;
      const unit = candleUnit(candle, xScale, yScale, ast.candles[at].w);
      ast.candles[at] = unit;
      next[offset + at] = candleRender(unit, plot, theme);
    }
    vnode = next;
    return { vnode, mode: /** @type {const} */ ('incremental') };
  }

  return { tick };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
