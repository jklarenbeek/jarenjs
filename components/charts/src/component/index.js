//@ts-check
/**
 * @file The charts VISUAL COMPONENT — the only app-aware file in the
 * package (the two-layer rule the mermaid component established). The
 * engine neither knows nor needs any of it.
 *
 * `createChartComponent()` returns a memoized `view()` projection for
 * `@jarenjs/app` viewModels: the same `(config, data)` pair yields a
 * reference-equal vnode, so an unchanged chart patches in O(1). The
 * memo is a WeakMap keyed on the DATA object's identity (streaming
 * snapshots are fresh objects, so every tick re-renders; static data is
 * stable, so navigation is free), with an inner cache keyed on the
 * config's structural identity. That identity is the whole serialized
 * config, not a fingerprint of it: the memo hands back the vnode, so a
 * hash collision would draw one chart's config under another's.
 */

import { createSemanticCache } from '@jarenjs/core/cache';
import { compileChart } from '../core/chart.js';
import { createChartSession } from '../core/session.js';

/** Distinct configs memoized per data object before the oldest is
 * dropped — one chart is redrawn from a handful of configs at most, so
 * the bound only stops an unbounded churn of generated configs. */
const CONFIG_MEMO_LIMIT = 64;

/**
 * @typedef {object} ChartComponentOptions
 * @property {any} [theme] theme name or override object
 * @property {import('../core/marks.js').ChartTooltipSpec} [tooltip] pointer
 *  bindings emitted from every value mark, for a floating-tooltip host
 *  (see {@link tooltipView}); absent leaves charts on their native
 *  `<title>` hover only
 */
/**
 * @typedef {object} ChartComponent
 * @property {(config: any, data?: any) => import('../core/chart.js').CompiledChart} compile
 * @property {(config: any, data?: any) => any} view memoized vnode projection
 * @property {(config: any, source: import('../core/session.js').ChartSessionSource)
 *   => import('../core/session.js').ChartSession} createSession incremental
 *   session bound to this component's theme
 * @property {Record<string, (props: any, dispatch: any) => any>} effects
 */

/**
 * Create the charts component.
 *
 * @example
 * const charts = createChartComponent({ theme: 'host' });
 * createApp(appDoc, {
 *   viewModel: (state) => ({ ...state, chart: charts.view(state.config, state.data) }),
 * });
 *
 * @param {ChartComponentOptions} [options]
 * @returns {ChartComponent}
 */
export function createChartComponent(options = {}) {
  const compileOptions = { theme: options.theme, tooltip: options.tooltip };

  /** Data-identity memo; inner caches key on the config's identity. */
  /** @type {WeakMap<object, import('@jarenjs/core/cache').SemanticCache<any>>} */
  const byData = new WeakMap();

  const compile = (config, data = config) => compileChart(config, data, compileOptions);

  return {
    compile,

    createSession(config, source) {
      return createChartSession(config, source, compileOptions);
    },

    view(config, data = config) {
      if (config === null || config === undefined) return null;
      if (data === null || typeof data !== 'object') {
        return compile(config, data).toVnode();
      }
      let byConfig = byData.get(data);
      if (byConfig === undefined) {
        byConfig = createSemanticCache(CONFIG_MEMO_LIMIT);
        byData.set(data, byConfig);
      }
      // structural identity, not a fingerprint: this memo RETURNS the
      // vnode, so a collision would draw one chart's config as another
      return byConfig.getOrCreate(config, () => compile(config, data).toVnode());
    },

    // No app effects yet: rendering is synchronous and pure. Streaming
    // wiring (timers, sockets) belongs to the host boundary, not here.
    effects: {},
  };
}

/**
 * The floating-tooltip host: the vnode for the box a `tooltip` binding
 * asks for. The mark dispatches `{ text, … }` plus the pointer's
 * `clientX`/`clientY`; an action stores that slice in the state and the
 * viewModel projects it through here.
 *
 * Positioned `fixed` at the viewport coordinates the event carried, so
 * it needs no measurement and no layout read — the stylesheet's
 * `translate` lifts it clear of the pointer. `null` (the leave action's
 * state) renders nothing.
 *
 * @example
 * // viewModel: (state) => ({ ...state, tip: tooltipView(state.tip) })
 * // action:    { "tip": { "text": "$payload.text",
 * //                       "x": "$event.clientX", "y": "$event.clientY" } }
 *
 * @param {{text?: string, x?: number, y?: number}|null|undefined} tip
 * @returns {any} a `<div class="chart-tooltip">` vnode, or null
 */
export function tooltipView(tip) {
  if (tip === null || typeof tip !== 'object') return null;
  const text = tip.text;
  if (typeof text !== 'string' || text === '') return null;
  return ['div', {
    class: 'chart-tooltip',
    role: 'status',
    style: {
      left: `${Number.isFinite(tip.x) ? tip.x : 0}px`,
      top: `${Number.isFinite(tip.y) ? tip.y : 0}px`,
    },
  }, text];
}
