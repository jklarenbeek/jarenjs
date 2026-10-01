//@ts-check
/**
 * @file The render dispatcher. Turns a `DiagramDocument` (or raw source)
 * into a pure-vnode SVG, choosing the specialized layout+render closure
 * per diagram type, and **never throws**: a
 * parse/layout error becomes an error vnode.
 */

import { parseMermaid } from '../parser/index.js';
import { createTheme } from '../theme.js';
import { MermaidParseError } from '../errors.js';
import { layoutFlowchart } from '../layout/flowchart.js';
import { layoutState } from '../layout/state.js';
import { layoutSequence } from '../layout/sequence.js';
import { layoutGantt } from '../layout/gantt.js';
import { renderFlowchart } from './flowchart.js';
import { renderSequence } from './sequence.js';
import { renderGantt } from './gantt.js';
import { renderStructured, renderPlaceholder, structuredSections } from './misc.js';
import { errorVnode } from './error.js';

/**
 * Compute the pure `PositionedDiagram` scene for a document (no vnode).
 * Returns `null` for types without a geometric layout (structured/raw).
 * @param {import('../ast.js').DiagramDocument} doc
 * @returns {any}
 */
export function layoutDiagram(doc) {
  switch (doc.diagram) {
    case 'flowchart': return layoutFlowchart(doc.ast);
    case 'state': return layoutState(doc.ast);
    case 'sequence': return layoutSequence(doc.ast);
    case 'gantt': return layoutGantt(doc.ast);
    default: return null;
  }
}

/**
 * A renderer a host injects for a diagram type this engine does not draw
 * itself: called with the type's AST, the resolved theme and the
 * document hash, it answers the SVG vnode.
 * @callback DiagramRenderer
 * @param {any} ast
 * @param {any} theme
 * @param {string} hash
 * @returns {any}
 */

/**
 * Render a doc or source to a pure-vnode SVG. Error-safe.
 *
 * A pie is drawn by `options.renderers.pie` — charts' ready one is
 * `mermaidPieRenderer` from `@jarenjs/charts/transforms/mermaid-adapter`
 * — and without one renders the placeholder (MERMAID-FORMAT §4.5): the
 * pie engine lives in charts, and mermaid imports no other component.
 * @param {import('../ast.js').DiagramDocument | string} docOrSource
 * @param {{ theme?: any, renderers?: { pie?: DiagramRenderer }, [k: string]: any }} [options]
 * @returns {any} an SVG vnode
 */
export function diagramToVnode(docOrSource, options = {}) {
  let doc;
  try {
    doc = typeof docOrSource === 'string' ? parseMermaid(docOrSource, options) : docOrSource;
  }
  catch (err) {
    // a parse failure has no document, so only the caller's theme is known
    return toError(err, typeof docOrSource === 'string' ? docOrSource : '', createTheme(options.theme ?? 'default'));
  }
  try {
    const themeArg = options.theme ?? doc.config?.theme ?? doc.config ?? 'default';
    const theme = createTheme(themeArg);
    const hash = doc.meta?.hash ?? '0';
    switch (doc.diagram) {
      case 'flowchart':
        return renderFlowchart(layoutFlowchart(doc.ast), theme, hash);
      case 'state':
        // a state diagram IS a graph: the state adapter feeds the same
        // layout and renderer as flowcharts (MERMAID-FORMAT §6)
        return renderFlowchart(layoutState(doc.ast), theme, hash, 'mermaid mm-svg mm-state');
      case 'sequence':
        return renderSequence(layoutSequence(doc.ast), theme, hash);
      case 'pie': {
        const pie = options.renderers?.pie;
        return typeof pie === 'function' ? pie(doc.ast, theme, hash)
          : renderPlaceholder('pie', theme, hash, 'parsed — no pie renderer was injected');
      }
      case 'gantt':
        return renderGantt(layoutGantt(doc.ast, options), theme, hash);
      case 'class':
      case 'er': {
        const { title, sections } = structuredSections(doc.diagram, doc.ast);
        return renderStructured(title, sections, theme, hash);
      }
      default:
        return renderPlaceholder(doc.diagram, theme, hash);
    }
  }
  catch (err) {
    return toError(err, '', createTheme(options.theme ?? 'default'));
  }
}

/**
 * @param {any} err
 * @param {string} source
 * @param {ReturnType<typeof createTheme>} theme
 * @returns {any}
 */
function toError(err, source, theme) {
  if (err instanceof MermaidParseError) {
    const lines = source.split(/\r\n?|\n/);
    const sourceLine = err.line > 0 && err.line <= lines.length ? lines[err.line - 1] : '';
    return errorVnode(err.message, err.line, sourceLine, theme);
  }
  return errorVnode(err && err.message ? String(err.message) : String(err), 0, '', theme);
}
