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
 * stable, so navigation is free), with an inner map keyed on the
 * stable-stringified config hash.
 */

import { hashContent } from '@jarenjs/core/string';
import { stableStringify } from '@jarenjs/core/object';
import { compileChart } from '../core/chart.js';

/**
 * @typedef {object} ChartComponentOptions
 * @property {any} [theme] theme name or override object
 */
/**
 * @typedef {object} ChartComponent
 * @property {(config: any, data?: any) => import('../core/chart.js').CompiledChart} compile
 * @property {(config: any, data?: any) => any} view memoized vnode projection
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
  const compileOptions = { theme: options.theme };

  /** Data-identity memo; inner maps key on the config hash. */
  /** @type {WeakMap<object, Map<string, any>>} */
  const byData = new WeakMap();

  const compile = (config, data = config) => compileChart(config, data, compileOptions);

  return {
    compile,

    view(config, data = config) {
      if (config === null || config === undefined) return null;
      if (data === null || typeof data !== 'object') {
        return compile(config, data).toVnode();
      }
      let byConfig = byData.get(data);
      if (byConfig === undefined) {
        byConfig = new Map();
        byData.set(data, byConfig);
      }
      const key = hashContent(stableStringify(config) ?? '');
      let vnode = byConfig.get(key);
      if (vnode === undefined) {
        vnode = compile(config, data).toVnode();
        byConfig.set(key, vnode);
      }
      return vnode;
    },

    // No app effects yet: rendering is synchronous and pure. Streaming
    // wiring (timers, sockets) belongs to the host boundary, not here.
    effects: {},
  };
}
