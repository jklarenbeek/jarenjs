//@ts-check
/**
 * @file The Markdown plugin — the md→mermaid dependency arrow (design
 * decision D9). `mermaidPlugin()` returns a **plain, self-frozen object**
 * shaped exactly like `@jarenjs/md`'s `MdPlugin` typedef, but it does
 * **not** import `definePlugin` from `@jarenjs/md` — so there is no
 * import cycle. `@jarenjs/md` re-exports this and adds `@jarenjs/mermaid`
 * to its dependencies; consumers who never use it tree-shake it away
 * (`sideEffects:false`).
 *
 * `render` is pure, synchronous and error-safe (D2/D7): a `mermaid`
 * fence becomes inline SVG with no injected instance and no `innerHTML`,
 * so a Markdown document renders to a full SVG string through SSR with
 * no browser — a capability the old injection wrapper lacked. There is
 * no `hydrate`: the render is already complete.
 */

import { diagramToVnode } from './render/index.js';
import { toMermaid } from './to-mermaid.js';
import { hashContent } from './utils.js';

/**
 * @param {{ theme?: any, [k: string]: any }} [options]
 * @returns {Readonly<{ name: string, fences: string[], node: string, render: (node: any, h: any, ctx: any) => any }>}
 */
export function mermaidPlugin(options = {}) {
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
      return ['div', { class: 'md-mermaid mermaid-block', key: hash }, svg];
    },
  });
}

/**
 * Refresh a `mermaid` fence node's source after a JSLT transform so the
 * generic Markdown fence printer re-emits the new diagram (D12). Because
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
