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

import { circle, coord } from '@jarenjs/view/helpers';
import { hashContent } from '@jarenjs/core/string';
import { stableStringify } from '@jarenjs/core/object';
import { clamp01 } from '@jarenjs/core/math';
import { scaleLinear, scaleTime } from './scale.js';
import { createTheme, CATEGORICAL } from './palette.js';
import { normalizeDomainPolicy } from './domain.js';
import { normalizeSampling, mightSample } from './sampling.js';
import { normalizeTooltip } from './marks.js';
import { numOf } from './stream-adapter.js';
import {
  buildBarAST, buildBarRender, barMarkRender,
  scanBarExtremes, resolveBarDomains, barScale,
} from '../types/bar.js';
import {
  buildLineASTResolved, buildLineRender, scanLineExtremes, resolveLineDomains,
  lineScales, lineVertex, lineSeriesRender, lineSeriesChildren,
} from '../types/line.js';
import {
  buildCandlestickAST, buildCandlestickRender, scanCandleExtremes,
  resolveCandleDomains, candleUnit, candleRender,
} from '../types/candlestick.js';

const APPEND_PATH = /^\/series\/(\d+)\/points\/-$/;
const EVICT_PATH = /^\/series\/(\d+)\/points\/0$/;
const UPSERT_PATH = /^\/candles\/(\d+)$/;
const VALUE_PATH = /^\/series\/(\d+)\/values\/(\d+)$/;

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
 * `config.type`: `'line'` (append/evict traffic), `'bar'` (live counts
 * and sums) and `'candlestick'` (keyed kline upserts). The config is
 * treated as immutable for the session's lifetime.
 * @param {{type: string, [k: string]: any}} config
 * @param {ChartSessionSource} source
 * @param {{theme?: any, palette?: readonly string[], width?: number,
 *   rootClass?: string, keyPrefix?: string,
 *   tooltip?: import('./marks.js').ChartTooltipSpec}} [options]
 * @returns {ChartSession}
 * @throws {TypeError} On an unsupported chart type
 */
export function createChartSession(config, source, options = {}) {
  if (config?.type === 'line') return createLineSession(config, source, options);
  if (config?.type === 'bar') return createBarSession(config, source, options);
  if (config?.type === 'candlestick') return createCandleSession(config, source, options);
  throw new TypeError(`createChartSession does not support type '${config?.type}'`);
}

/**
 * The bar session: a live count or sum updates exactly its own rect
 * while the value axis holds still.
 *
 * What rebuilds, and why it has to: a NEW category re-bands every bar
 * (widths and positions both move), and a value crossing zero adds or
 * removes a rect, which shifts every later child's index. A stacked
 * chart rebuilds on any change — one series' value moves every bar
 * above it in its category — and nothing streams stacked data today, so
 * the incremental path would be untested weight.
 *
 * Unlike the line session the stillness test always rescans truth: a
 * count that *drops* can retire the tallest bar, so extremes cannot be
 * extended, only recomputed.
 * @param {any} config @param {ChartSessionSource} source @param {any} options
 * @returns {ChartSession}
 */
function createBarSession(config, source, options) {
  const stacked = config.stacked === true;
  const log = config.log === true;
  const palette = options.palette ?? CATEGORICAL;
  const tooltip = normalizeTooltip(options.tooltip);
  const theme = createTheme(options.theme);
  const hash = hashContent(stableStringify(config) ?? '');

  /** @type {any} */ let vnode = null;
  /** @type {any} */ let ast = null;
  /** @type {{svg:any, plot:any, chromeLen:number}|null} */ let render = null;
  /** @type {Map<string, number>} `series\u0000category` → AST bar index */ let barAt = new Map();

  const markKey = (series, label) => `${series}\u0000${label}`;

  function rebuild(dataMaybe) {
    const data = dataMaybe ?? source.getData();
    ast = buildBarAST(data, config);
    render = buildBarRender(ast, theme, hash, options);
    barAt = new Map();
    for (let i = 0; i < ast.bars.length; i++)
      barAt.set(markKey(ast.bars[i].series, ast.bars[i].label), i);
    vnode = render.svg;
    return { vnode, mode: /** @type {const} */ ('rebuilt') };
  }

  function tick() {
    const ops = source.takeChanges();
    if (vnode !== null && ops.length === 0)
      return { vnode, mode: /** @type {const} */ ('unchanged') };
    if (vnode === null || stacked) return rebuild();

    const steps = [];
    for (const op of ops) {
      const m = VALUE_PATH.exec(op.path);
      if (op.op !== 'replace' || m === null) return rebuild();
      steps.push({ si: Number(m[1]), ci: Number(m[2]) });
    }

    const truth = source.getData();
    const domains = resolveBarDomains(scanBarExtremes(truth, stacked, log), log);
    if (domains.domain[0] !== ast.domain[0] || domains.domain[1] !== ast.domain[1])
      return rebuild(truth);

    const scale = barScale(domains.domain, log);
    const offset = 2 + (ast.title ? 1 : 0) + render.chromeLen;
    const next = vnode.slice();
    for (const step of steps) {
      const label = String(truth?.categories?.[step.ci]);
      const at = barAt.get(markKey(step.si, label));
      const value = truth?.series?.[step.si]?.values?.[step.ci];
      // no rect yet (or none any more) means the child list changes shape
      if (at === undefined || typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return rebuild(truth);
      const bar = { ...ast.bars[at], v1: clamp01(scale(value)), value };
      ast.bars[at] = bar;
      next[offset + at] = barMarkRender(bar, ast, render.plot, theme, palette, tooltip);
    }
    vnode = next;
    return { vnode, mode: /** @type {const} */ ('incremental') };
  }

  return { tick };
}

/**
 * The line session: O(1) tail appends and O(series) head evictions
 * under a still domain.
 *
 * A SAMPLED line has no such frame. `config.sampling` lets the
 * downsampler choose which points are drawn, and one appended reading
 * can change that choice anywhere along the line — so a session over a
 * line the sampler touches rebuilds wholesale, which is the only
 * rendering byte-equal to `compileChart` of the same data. Retention
 * (`maxPoints`) is what keeps a streaming line under the threshold;
 * `sampling: false` is what keeps a long one incremental.
 * @param {any} config @param {ChartSessionSource} source @param {any} options
 * @returns {ChartSession}
 */
function createLineSession(config, source, options) {
  const time = config.x === 'time';
  const log = config.log === true;
  const markers = config.markers === true;
  const policy = normalizeDomainPolicy(config.domain);
  const sampling = normalizeSampling(config.sampling);
  const palette = options.palette ?? CATEGORICAL;
  const tooltip = normalizeTooltip(options.tooltip);
  const theme = createTheme(options.theme);
  const hash = hashContent(stableStringify(config) ?? '');

  /** @type {any} */ let vnode = null;
  /** @type {any} */ let ast = null;
  /** @type {{svg:any, plot:any, chromeLen:number, series:any[]}|null} */ let render = null;
  /** @type {{x0:number,x1:number,y0:number,y1:number}|null} */ let ext = null;
  /** @type {number|null} the current window low bound */ let xDrop = null;
  /** Filtering source series changes the indices in the compiled AST. */
  let filteredSeries = false;

  function rebuild(dataMaybe) {
    const data = dataMaybe ?? source.getData();
    const input = (data?.series ?? []).filter((s) => Array.isArray(s.points));
    filteredSeries = input.length !== (data?.series ?? []).length;
    ext = scanLineExtremes(input, policy, log);
    const domains = resolveLineDomains(ext, policy, time, log);
    ast = buildLineASTResolved(input, config, domains);
    render = buildLineRender(ast, theme, hash, options);
    xDrop = domains.xDrop;
    vnode = render.svg;
    return { vnode, mode: /** @type {const} */ ('rebuilt') };
  }

  /** Extend the extremes with one appended sample (the scan's rules). */
  function extend(e, pt) {
    const px = numOf(pt?.x);
    const py = numOf(pt?.y);
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
    if (vnode === null || filteredSeries) return rebuild();
    // a line the sampler chose the points of has no incremental frame
    if (ast.sampling !== null) return rebuild();

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

    // …and neither has one this traffic pushes over the threshold: an
    // unsampled AST's vertex count IS its source count, so the count
    // after the steps is what the wholesale build would see.
    if (sampling !== null) {
      const after = ast.series.map((s) => s.points.length);
      for (const step of steps) after[step.si] += step.evict ? -1 : 1;
      if (after.some((count) => mightSample(sampling, time, count))) return rebuild();
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
      const px = coord(plot.x + vertex.u * plot.w);
      const py = coord(plot.y + (1 - vertex.v) * plot.h);
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
        parts = lineSeriesRender(ast.series[si], si, plot, palette, markers, tooltip);
      }
      else {
        // the group's props (key, class, any tooltip binding) are
        // untouched by point traffic — only its children re-emit
        parts = {
          ...parts,
          group: [parts.group[0], parts.group[1],
            ...lineSeriesChildren(parts.name, parts.d, parts.dots, parts.color)],
        };
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
  const tooltip = normalizeTooltip(options.tooltip);
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
    // A replacement can make a formerly invalid candle drawable, or
    // replace its timestamp without moving either domain. Membership and
    // order must still match: count changes re-band every candle, and a
    // different identity cannot be patched through the old timestamp map.
    if (ext.kept.length !== ast.candles.length
      || ext.kept.some((c, i) => numOf(c.t) !== ast.candles[i].t)) {
      return rebuild(truth);
    }
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
      next[offset + at] = candleRender(unit, plot, theme, tooltip);
    }
    vnode = next;
    return { vnode, mode: /** @type {const} */ ('incremental') };
  }

  return { tick };
}
