//@ts-check
/**
 * One shared Mermaid visual component (`@jarenjs/mermaid/component`) for
 * the whole site. The playground's Mermaid tab derives its rendered SVG
 * through `mermaid.view(source)`, memoized per source string — the same
 * O(change) contract as the Markdown component.
 */

import { mermaidPieRenderer } from '@jarenjs/charts/transforms/mermaid-adapter';
import { createMermaidComponent } from '@jarenjs/mermaid/component';

// theme 'host': diagram cssVars reference the site tokens, so memoized
// SVGs follow light/dark live (docs/DESIGN.md §7). A pie is drawn by
// charts' renderer, handed in: mermaid imports no other component.
export const mermaid = createMermaidComponent({ theme: 'host', renderers: { pie: mermaidPieRenderer } });

/**
 * One component per reader catalog (each memoizes per source string).
 * @type {WeakMap<object, ReturnType<typeof createMermaidComponent>>}
 */
const BY_CATALOG = new WeakMap();

/**
 * The shared component in the reader's language: the error card, a parse
 * diagnostic and the words the render adds go through `messages` (a
 * compiled `@jarenjs/locales` pack, as `catalogFor(lang)` answers it); no
 * catalog is the English {@link mermaid} itself.
 * @param {Readonly<Record<string, unknown>> | null | undefined} messages
 * @returns {ReturnType<typeof createMermaidComponent>}
 */
export function mermaidFor(messages) {
  if (messages == null) return mermaid;
  let component = BY_CATALOG.get(messages);
  if (component === undefined) {
    component = createMermaidComponent({ theme: 'host', renderers: { pie: mermaidPieRenderer }, messages });
    BY_CATALOG.set(messages, component);
  }
  return component;
}
