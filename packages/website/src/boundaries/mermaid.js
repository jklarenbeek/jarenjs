//@ts-check
/**
 * One shared Mermaid visual component (`@jarenjs/mermaid/component`) for
 * the whole site. The playground's Mermaid tab derives its rendered SVG
 * through `mermaid.view(source)`, memoized per source string — the same
 * O(change) contract as the Markdown component.
 */

import { createMermaidComponent } from '@jarenjs/mermaid/component';

export const mermaid = createMermaidComponent();
