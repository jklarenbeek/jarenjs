//@ts-check
/**
 * One shared Mermaid visual component (`@jarenjs/mermaid/component`) for
 * the whole site. The playground's Mermaid tab derives its rendered SVG
 * through `mermaid.view(source)`, memoized per source string — the same
 * O(change) contract as the Markdown component.
 */

import { createMermaidComponent } from '@jarenjs/mermaid/component';

// theme 'host': diagram cssVars reference the site tokens, so memoized
// SVGs follow light/dark live (DESIGN.md §7)
export const mermaid = createMermaidComponent({ theme: 'host' });
