//@ts-check
/**
 * @file Mermaid diagram support (PLUGINS.md §6.1) — injection-based.
 *
 * The caller supplies the mermaid instance (dynamic import, CDN
 * global); the plugin never imports it. `render` is a deterministic
 * SSR-safe placeholder — a `div.md-mermaid` with the diagram source
 * visible in a `pre` — and `hydrate` swaps in the rendered SVG after
 * mount, cached by content hash so re-patches and repeated diagrams
 * are O(1).
 */

import { definePlugin } from './index.js';
import { hashContent } from '../utils.js';

/**
 * @param {{ mermaid?: any, theme?: string }} [config]
 * @returns {import('./index.js').MdPlugin}
 */
export function mermaidPlugin(config = {}) {
  const mermaid = config.mermaid;
  const theme = config.theme;
  /** Rendered SVG by content hash. */
  /** @type {Map<string, string>} */
  const svgCache = new Map();
  let initialized = false;

  return definePlugin({
    name: 'mermaid',
    fences: ['mermaid'],
    node: 'mermaid',

    render: (node, h) => {
      const hash = hashContent(node.value);
      return h('div', {
        class: 'md-mermaid',
        key: hash,
        'data-md-hydrate': 'mermaid',
        'data-md-hash': hash,
      }, h('pre', { class: 'md-mermaid-src' }, node.value));
    },

    hydrate: async (el, node) => {
      if (mermaid === undefined || mermaid === null) return;
      const hash = hashContent(node.value);
      let svg = svgCache.get(hash);
      if (svg === undefined) {
        if (!initialized) {
          initialized = true;
          if (typeof mermaid.initialize === 'function') {
            mermaid.initialize({ startOnLoad: false, theme });
          }
        }
        const result = await mermaid.render('md-mermaid-' + hash, node.value);
        svg = typeof result === 'string' ? result : result.svg;
        svgCache.set(hash, /** @type {string} */ (svg));
      }
      el.innerHTML = /** @type {string} */ (svg);
    },
  });
}
