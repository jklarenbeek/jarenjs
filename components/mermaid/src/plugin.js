//@ts-check
/**
 * @file The Markdown plugin. `mermaidPlugin()` returns a **plain,
 * self-frozen object** shaped exactly like `@jarenjs/md`'s `MdPlugin`
 * typedef, without importing anything of `@jarenjs/md`: a host that wants
 * diagrams in its Markdown imports this module and passes the plugin in,
 * so neither component imports the other (CONVENTIONS §1). Its options
 * reach the renderer — a pie is drawn by `renderers.pie`.
 *
 * `render` is pure, synchronous and error-safe: a `mermaid`
 * fence becomes inline SVG with no injected instance and no `innerHTML`,
 * so a Markdown document renders to a full SVG string through SSR with
 * no browser — a capability the old injection wrapper lacked.
 *
 * `hydrate` exists only when a consumer asks for `interactive: true` (pan,
 * zoom, touch) or `tooltips: true` (a tooltip on each node and edge any
 * diagram type draws), alone or together. The render is complete without it: hydration
 * enhances an already finished SVG, so server output is byte-identical either
 * way and a page that does not opt in never loads either module.
 */

import { diagramToVnode } from './render/index.js';
import { toMermaid } from './to-mermaid.js';
import { hashContent } from './utils.js';

/**
 * @param {{ theme?: any, interactive?: boolean, tooltips?: boolean, renderers?: { pie?: import('./render/index.js').DiagramRenderer },
 *   [k: string]: any }} [options] - `renderers.pie` draws a pie fence (charts'
 *   `mermaidPieRenderer`); without it a pie renders the placeholder
 * @returns {Readonly<{ name: string, fences: string[], node: string, render: (node: any, h: any, ctx: any) => any }>}
 */
export function mermaidPlugin(options = {}) {
  const hydrates = options.interactive === true || options.tooltips === true;
  return Object.freeze({
    name: 'mermaid',
    fences: Object.freeze(['mermaid', 'mmd']),
    node: 'mermaid',
    /**
     * @param {{ value: string, meta?: any }} node
     */
    render: (node) => {
      const hash = hashContent(node.value);
      const svg = diagramToVnode(node.value, options);
      const props = { class: 'md-mermaid mermaid-block', key: hash };
      // The hydrate marker is what the md component looks for; emitting it
      // only when a hydrate exists keeps every other output unchanged.
      if (hydrates) {
        props['data-md-hydrate'] = 'mermaid';
        props['data-md-hash'] = hash;
      }
      return ['div', props, svg];
    },
    ...(hydrates
      ? {
        /**
         * @param {any} el the rendered block element
         */
        hydrate: async (el) => {
          if (options.interactive === true) {
            const { attachInteractiveDiagram } = await import('./interactive.js');
            attachInteractiveDiagram(el);
          }
          if (options.tooltips === true) {
            const { attachDiagramTooltips } = await import('./tooltips.js');
            attachDiagramTooltips(el);
          }
        },
      }
      : {}),
  });
}

/**
 * Refresh a `mermaid` fence node's source after a JSLT transform so the
 * generic Markdown fence printer re-emits the new diagram. Because
 * there is no per-plugin `toMarkdown` hook, this is the primitive that
 * makes a transformed diagram round-trip through `toMarkdown`.
 *
 * @param {{ value: string, [k: string]: any }} node the fence node (mutated copy is caller's job)
 * @param {import('./ast.js').DiagramDocument} newDoc the transformed document
 * @returns {{ type: string, value: string, meta: any }} a fresh fence node
 */
export function refreshMermaidFence(node, newDoc) {
  return { type: 'mermaid', value: toMermaid(newDoc), meta: node.meta ?? null };
}
