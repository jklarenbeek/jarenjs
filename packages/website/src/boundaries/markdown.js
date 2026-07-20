//@ts-check
/**
 * One shared Markdown visual component (`@jarenjs/md/component`) for the
 * whole site. The playground's Markdown tab and the docs-page README
 * dialog both derive their vnodes through `md.view(...)`, so they share
 * one memo cache: the same source string renders to the same
 * reference-equal vnode, which the DOM patcher skips in O(1).
 *
 * The mermaid plugin is compiled in so fenced ```mermaid diagrams in
 * fetched READMEs render to inline SVG through @jarenjs/mermaid (the
 * engine dogfooding itself on the live site).
 */

import { createMdComponent } from '@jarenjs/md/component';
import { highlightPlugin } from '@jarenjs/md/plugins';
import { mermaidPlugin } from '@jarenjs/mermaid/plugin';

// theme 'host': diagram cssVars reference the site tokens, so memoized
// SVGs follow light/dark live (DESIGN.md §7)
export const md = createMdComponent({ plugins: [highlightPlugin(), mermaidPlugin({ theme: 'host' })] });
