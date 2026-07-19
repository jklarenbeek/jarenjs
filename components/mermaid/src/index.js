//@ts-check
/**
 * @file `@jarenjs/mermaid` — a native, headless Mermaid clone. This is
 * the **engine** (part one): pure functions over data — text ⇄ AST ⇄
 * pure-vnode SVG — that know only the `@jarenjs/view` vnode shape. It
 * imports nothing from the component, `@jarenjs/app`, the DOM or
 * `@jarenjs/md` (the two-layer rule, design decision D1).
 *
 * The pipeline mirrors `@jarenjs/md`:
 *
 *   source ──parseMermaid──▶ DiagramDocument (geometry-free JSON AST)
 *                              │
 *            ┌─────────────────┼───────────────────┐
 *            ▼                 ▼                   ▼
 *       toMermaid()      layoutDiagram()      JSLT / query
 *       (canonical        → diagramToVnode()  (the AST is an
 *        round-trip)       (pure-vnode SVG)    ordinary document)
 */

import { renderToString, createDomRenderer } from '@jarenjs/view';
import { parseMermaid } from './parser/index.js';
import { toMermaid } from './to-mermaid.js';
import { diagramToVnode } from './render/index.js';
import { hashContent } from './utils.js';

export { parseMermaid } from './parser/index.js';
export { toMermaid } from './to-mermaid.js';
export { parseMermaidConfig } from './parser/config.js';
export { layoutDiagram, diagramToVnode } from './render/index.js';
export { createTheme, THEMES } from './theme.js';
export { sanitizeHref } from './render/svg.js';
export { MermaidParseError } from './errors.js';
export { hashContent } from './utils.js';
export {
  MERMAID_VERSION, diagramDocument, walkSequence,
  flowNode, flowEdge, sequenceAst, flowchartAst,
} from './ast.js';

/**
 * Convenience: parse → layout → render, error-safe, in one call.
 * @param {string} source
 * @param {{ theme?: any }} [options]
 * @returns {any} an SVG vnode
 */
export function renderMermaid(source, options = {}) {
  return diagramToVnode(source, options);
}

/**
 * @typedef {object} CompiledMermaid
 * @property {import('./ast.js').DiagramDocument} doc the parsed document
 * @property {() => any} toVnode cached pure-vnode SVG
 * @property {() => string} toSvgString cached standalone SVG string (SSR)
 * @property {() => string} toText canonical Mermaid text (`toMermaid`)
 * @property {(visitor: (stmt: any) => void) => void} walk walk the AST
 */

/**
 * Parse once and return a bundle of cached projections (design decision
 * D6). `toVnode`/`toSvgString`/`toText` each compute at most once; the
 * vnode is returned by reference on repeat calls, so an unchanged
 * document patches in O(1) through the view reconciler.
 *
 * @param {string} source
 * @param {{ theme?: any, [k: string]: any }} [options]
 * @returns {CompiledMermaid}
 */
export function compileMermaid(source, options = {}) {
  let doc = null;
  let parseError = null;
  try {
    doc = parseMermaid(source, options);
  }
  catch (err) {
    parseError = err;
  }
  let vnode;
  let svg;
  let text;
  return {
    doc,
    parseError,
    toVnode() {
      // Error-safe (D7): a parse failure renders the error vnode, which
      // `diagramToVnode` produces when handed the original source.
      if (vnode === undefined) vnode = diagramToVnode(doc ?? source, options);
      return vnode;
    },
    toSvgString() {
      if (svg === undefined) svg = renderToString(this.toVnode());
      return svg;
    },
    toText() {
      if (text === undefined) text = doc !== null ? toMermaid(doc) : source;
      return text;
    },
    walk(visitor) {
      if (doc !== null) walkDoc(doc, visitor);
    },
  };
}

/**
 * A host-DOM renderer (mirrors `@jarenjs/md`'s `createMdRenderer`).
 * Owns a `@jarenjs/view` DOM renderer over `container` and patches the
 * rendered SVG on each `render(docOrSource)` call. `createDomRenderer`
 * touches no DOM until it is handed a container, so importing it keeps
 * the engine host-agnostic.
 *
 * @param {{ container: any, document?: any, theme?: any, [k: string]: any }} config
 * @returns {(docOrSource: any) => void}
 */
export function createMermaidRenderer(config) {
  const render = createDomRenderer(config.container, { document: config.document });
  return (docOrSource) => {
    render(diagramToVnode(docOrSource, config));
  };
}

/**
 * Walk a document's AST statements (sequence blocks descend).
 * @param {import('./ast.js').DiagramDocument} doc
 * @param {(stmt: any) => void} visitor
 */
function walkDoc(doc, visitor) {
  const ast = doc.ast;
  if (doc.diagram === 'sequence') {
    const walk = (stmts) => {
      for (const s of stmts) {
        visitor(s);
        if (s.kind === 'block') for (const b of s.branches) walk(b.statements);
      }
    };
    walk(ast.statements);
  }
  else if (doc.diagram === 'flowchart') {
    for (const n of ast.nodes) visitor(n);
    for (const e of ast.edges) visitor(e);
  }
  else {
    visitor(ast);
  }
}

export { hashContent as contentHash };
