//@ts-check
/**
 * @file Mermaid interop: map a mermaid pie AST (`{title, showData,
 * slices}`) onto a chart definition + data pair. Lives in charts so the
 * dependency arrow stays one-way — `@jarenjs/mermaid` imports this,
 * never the reverse; nothing here touches mermaid code.
 */

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
