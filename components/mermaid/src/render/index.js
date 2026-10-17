//@ts-check
/**
 * @file The render dispatcher. Turns a `DiagramDocument` (or raw source)
 * into a pure-vnode SVG, choosing the specialized layout+render closure
 * per diagram type, and **never throws**: a
 * parse/layout error becomes an error vnode.
 */

import { parseMermaid } from '../parser/index.js';
import { createTheme, THEMES } from '../theme.js';
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
import { clickTooltips } from './marks.js';

/**
 * Compute the pure `PositionedDiagram` scene for a document (no vnode):
 * the geometry {@link diagramToVnode} draws with the same options.
 * Returns `null` for types without a geometric layout (structured/raw).
 * @param {import('../ast.js').DiagramDocument} doc
 * @param {{ htmlLabels?: boolean, safe?: boolean, [k: string]: any }} [options] the render
 *   options: `htmlLabels` and `safe` decide the label layout as they do the
 *   drawing, and a Gantt reads its `dateNames`
 * @returns {any}
 */
export function layoutDiagram(doc, options = {}) {
  switch (doc.diagram) {
    case 'flowchart': return layoutFlowchart(doc.ast, labelLayout(doc.config, options));
    case 'state': return layoutState(doc.ast, labelLayout(doc.config, options));
    case 'sequence': return layoutSequence(doc.ast);
    case 'gantt': return layoutGantt(doc.ast, { ...options, config: doc.config });
    default: return null;
  }
}

/**
 * How a flowchart or state diagram draws its labels. HTML labels are the
 * HOST's to enable (`htmlLabels: true` in the render options), never the
 * diagram's alone: a host that renders through the view safe policy, which
 * drops `foreignObject` and the labels in it, must not have every label
 * blanked by an author's `%%{init}%%`. Enabled, the diagram's own config can
 * still turn them off, as Mermaid's directive overrides its site config: the
 * root `htmlLabels` wins over the older `flowchart.htmlLabels`, read as
 * Mermaid reads it (`false`, `"false"`, `"null"` and `"0"` are false).
 * `safe: true` keeps SVG text whatever either says.
 * @param {Record<string, any> | undefined} config
 * @param {{ safe?: boolean, htmlLabels?: boolean }} options
 * @returns {import('../layout/flowchart.js').FlowchartLayoutOptions}
 */
function labelLayout(config, options) {
  if (options.safe === true || options.htmlLabels !== true) return {};
  const flowchart = (config === undefined || config === null ? {} : config.flowchart) ?? {};
  const asked = config?.htmlLabels ?? flowchart.htmlLabels;
  if (asked != null && ['false', 'null', '0'].includes(String(asked).trim().toLowerCase())) return {};
  const width = flowchart.wrappingWidth;
  return typeof width === 'number' && Number.isFinite(width) && width > 0
    ? { htmlLabels: true, wrappingWidth: width } : { htmlLabels: true };
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
 *
 * Flowchart and state labels are HTML inside `foreignObject` when the host
 * passes `htmlLabels: true` (MERMAID-FORMAT §7) and neither the diagram's
 * config turns them off nor `safe` is set.
 * @param {import('../ast.js').DiagramDocument | string} docOrSource
 * @param {{ theme?: any, htmlLabels?: boolean, safe?: boolean, renderers?: { pie?: DiagramRenderer },
 *   [k: string]: any }} [options]
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
    const theme = createTheme(options.theme ?? authoredTheme(doc.config));
    const hash = doc.meta?.hash ?? '0';
    switch (doc.diagram) {
      case 'flowchart':
        return renderFlowchart(layoutFlowchart(doc.ast, labelLayout(doc.config, options)), theme, hash,
          undefined, clickTooltips(doc.ast.clicks));
      case 'state':
        // a state diagram IS a graph: the state adapter feeds the same
        // layout and renderer as flowcharts (MERMAID-FORMAT §6)
        return renderFlowchart(layoutState(doc.ast, labelLayout(doc.config, options)), theme, hash,
          'mermaid mm-svg mm-state');
      case 'sequence':
        return renderSequence(layoutSequence(doc.ast), theme, hash);
      case 'pie': {
        const pie = options.renderers?.pie;
        return typeof pie === 'function' ? pie(doc.ast, theme, hash)
          : renderPlaceholder('pie', theme, hash, 'parsed — no pie renderer was injected');
      }
      case 'gantt':
        return renderGantt(layoutGantt(doc.ast, { ...options, config: doc.config }), theme, hash);
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
 * A `url()` that is not a same-document `url(#id)`: a reference to a
 * resource outside the document, which `styles.js` refuses as the paint of a
 * `style` statement.
 */
const RE_REMOTE_URL = /url\((?!#[\w-]+\))/i;

/**
 * The theme a diagram's own config names: its `theme` when that is a name,
 * otherwise only the config members that are theme tokens (`nodeFill`, …),
 * less any token holding a remote `url()` (the rule the `style` statement
 * path keeps, so neither way of styling a diagram makes the page fetch
 * something). The whole config used to be the override object, so every
 * key — a `flowchart` block, a `htmlLabels` flag, any string an author
 * wrote — was stamped onto the root's style as a `--mm-*` property.
 * @param {Record<string, any> | undefined} config
 * @returns {string | Record<string, any>}
 */
function authoredTheme(config) {
  if (config === undefined || config === null || typeof config !== 'object') return 'default';
  if (typeof config.theme === 'string') return config.theme;
  /** @type {Record<string, any>} */
  const tokens = {};
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (!Object.hasOwn(THEMES.default, key) || (typeof value === 'string' && RE_REMOTE_URL.test(value))) continue;
    tokens[key] = value;
  }
  return tokens;
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
