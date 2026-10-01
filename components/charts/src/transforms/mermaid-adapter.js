//@ts-check
/**
 * @file Mermaid interop, owned by charts: map a mermaid pie AST
 * (`{title, showData, slices}`) onto a chart definition + data pair, and
 * the ready pie renderer a host injects into mermaid
 * (`diagramToVnode(doc, { renderers: { pie: mermaidPieRenderer } })`).
 * Charts is the pie engine's one home; mermaid draws a pie only through
 * the renderer it is handed, so neither component imports the other —
 * nothing here touches mermaid code, it reads mermaid's AST and theme as
 * data.
 */

import { CATEGORICAL } from '../core/palette.js';
import { buildPieAST, renderPieAST } from '../types/pie.js';

/**
 * Convert a mermaid pie AST to `compileChart`-shaped inputs.
 * @param {{title?: string|null, showData?: boolean, slices: {label: string, value: number}[]}} ast
 * @returns {{config: {type: 'pie', title: string|null}, data: {slices: {label: string, value: number}[]}}}
 */
export function mermaidPieToChartAST(ast) {
  return {
    config: { type: 'pie', title: ast.title ?? null },
    data: { slices: ast.slices },
  };
}

/**
 * Render a mermaid pie with charts' own pie: the renderer mermaid's
 * dispatcher calls for a `pie` document. The options carry mermaid's
 * class names, palette and theme, so the SVG is the one mermaid has
 * always drawn.
 * @param {{title?: string|null, showData?: boolean, slices: {label: string, value: number}[]}} ast - the pie AST
 * @param {any} theme - mermaid's resolved theme (`createTheme`)
 * @param {string} hash - the document hash, the SVG's key
 * @returns {any} an SVG vnode
 * @example
 * import { diagramToVnode } from '@jarenjs/mermaid';
 * import { mermaidPieRenderer } from '@jarenjs/charts/transforms/mermaid-adapter';
 * diagramToVnode('pie\n "a" : 1\n "b" : 2', { renderers: { pie: mermaidPieRenderer } });
 */
export function mermaidPieRenderer(ast, theme, hash) {
  const { config, data } = mermaidPieToChartAST(ast);
  return renderPieAST(buildPieAST(data, config), theme, hash, {
    rootClass: 'mermaid mm-svg',
    keyPrefix: 'mmpie-',
    sliceClass: 'mm-pie-slice',
    legendClass: 'mm-pie-legend',
    palette: CATEGORICAL,
    textColor: theme.tokens.nodeText,
    sliceStroke: '#fff',
    // A mermaid diagram's SVG is a byte-stable contract; the per-slice
    // hover text charts adds for its own pies would break it.
    titles: false,
  });
}
