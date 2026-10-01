//@ts-check
/**
 * @file Plugin registry helpers and the reference plugins: `definePlugin`
 * and the syntax highlighter. Diagrams are not here — a host that wants
 * them passes `mermaidPlugin` from `@jarenjs/mermaid/plugin`, so the
 * Markdown engine imports no other component (CONVENTIONS §1).
 */

/** @typedef {import('./define.js').MdPlugin} MdPlugin */

export { definePlugin } from './define.js';
export { highlightPlugin, tokenizeCode, GRAMMAR_NAMES } from './highlight.js';
