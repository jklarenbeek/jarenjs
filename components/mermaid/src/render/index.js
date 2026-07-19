//@ts-check
/**
 * @file The render dispatcher. Turns a `DiagramDocument` (or raw source)
 * into a pure-vnode SVG, choosing the specialized layout+render closure
 * per diagram type, and **never throws** (design decision D7): a
 * parse/layout error becomes an error vnode.
 */

import { parseMermaid } from '../parser/index.js';
import { createTheme } from '../theme.js';
import { MermaidParseError } from '../errors.js';
import { layoutFlowchart } from '../layout/flowchart.js';
import { layoutSequence } from '../layout/sequence.js';
import { renderFlowchart } from './flowchart.js';
import { renderSequence } from './sequence.js';
import { renderPie, renderStructured, renderPlaceholder, structuredSections } from './misc.js';
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
    case 'sequence': return layoutSequence(doc.ast);
    default: return null;
  }
}

/**
 * Render a doc or source to a pure-vnode SVG. Error-safe.
 * @param {import('../ast.js').DiagramDocument | string} docOrSource
 * @param {{ theme?: any, [k: string]: any }} [options]
 * @returns {any} an SVG vnode
 */
export function diagramToVnode(docOrSource, options = {}) {
  let doc;
  try {
    doc = typeof docOrSource === 'string' ? parseMermaid(docOrSource, options) : docOrSource;
  }
  catch (err) {
    return toError(err, typeof docOrSource === 'string' ? docOrSource : '');
  }
  try {
    const themeArg = options.theme ?? doc.config?.theme ?? doc.config ?? 'default';
    const theme = createTheme(themeArg);
    const hash = doc.meta?.hash ?? '0';
    switch (doc.diagram) {
      case 'flowchart':
        return renderFlowchart(layoutFlowchart(doc.ast), theme, hash);
      case 'sequence':
        return renderSequence(layoutSequence(doc.ast), theme, hash);
      case 'pie':
        return renderPie(doc.ast, theme, hash);
      case 'class':
      case 'er':
      case 'state':
      case 'gantt': {
        const { title, sections } = structuredSections(doc.diagram, doc.ast);
        return renderStructured(title, sections, theme, hash);
      }
      default:
        return renderPlaceholder(doc.diagram, theme, hash);
    }
  }
  catch (err) {
    return toError(err, '');
  }
}

/**
 * @param {any} err
 * @param {string} source
 * @returns {any}
 */
function toError(err, source) {
  if (err instanceof MermaidParseError) {
    const lines = source.split(/\r\n?|\n/);
    const sourceLine = err.line > 0 && err.line <= lines.length ? lines[err.line - 1] : '';
    return errorVnode(err.message, err.line, sourceLine);
  }
  return errorVnode(err && err.message ? String(err.message) : String(err));
}
