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
