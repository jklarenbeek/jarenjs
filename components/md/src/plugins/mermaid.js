//@ts-check
/**
 * @file Mermaid diagram support (PLUGINS.md §6.1).
 *
 * The **native** plugin from `@jarenjs/mermaid`: a self-frozen
 * `MdPlugin`-shaped object whose `render` parses the fence source and
 * emits pure-vnode SVG synchronously (SSR-safe, no injected `mermaid`
 * instance, no `innerHTML`). The dependency arrow points md → mermaid
 *, and `@jarenjs/mermaid/plugin` does not import
 * `definePlugin`, so there is no cycle. Consumers who never use it
 * tree-shake it away (`sideEffects:false`).
 */

export { mermaidPlugin, refreshMermaidFence } from '@jarenjs/mermaid/plugin';
