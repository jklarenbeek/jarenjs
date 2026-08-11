//@ts-check
/**
 * @file GFM footnotes: which definitions a document actually cites, in
 * which order, and what to call them.
 *
 * Definitions stay where the author wrote them (the AST is the
 * document, not the rendering), so both emitters need the same answer to
 * the same three questions before they emit anything: which definitions
 * are cited, what number each one gets, and which identifiers the
 * reference and its back-references carry. That answer lives here once —
 * two emitters minting ids from two implementations is exactly how a
 * back-reference ends up pointing at nothing.
 */

import { walkAst } from './ast.js';

/**
 * @typedef {import('./ast.js').MdNode} MdNode
 */
/**
 * @typedef {{ defs: MdNode[],
 *   numbers: Map<string, number>,
 *   counts: Map<string, number>,
 *   refs: WeakMap<MdNode, { number: number, occurrence: number }> }} Footnotes
 */

/**
 * The default identifier prefix for footnotes — GitHub's own.
 *
 * Unlike a heading id (MD-FORMAT.md §4.5), which defaults to no prefix
 * because CommonMark asserts a bare heading and the primary consumer is
 * a document the host wrote, a footnote id is emitted by the DEFAULT
 * rendering of a feature whose whole point is a link between two places
 * on one page. No spec example asserts a bare `fn-1`, so the safe
 * default costs nothing and a host page keeps its own `#fn-1` for
 * itself. `slugPrefix`, when given, replaces it.
 */
export const FOOTNOTE_PREFIX = 'user-content-';

/** The back-reference glyph GitHub uses. */
export const BACKREF_MARK = '↩';

/** @type {WeakMap<MdNode[], Footnotes|null>} */
const collectMemo = new WeakMap();

/**
 * Collect a document's cited footnotes.
 *
 * Returns `null` when the AST holds no `footnoteDefinition` at all — the
 * overwhelmingly common case, and the one that must cost nothing: the
 * emitters compare that `null` to decide whether anything about footnote
 * rendering can differ between two emissions.
 *
 * The result is memoized on the AST array, so re-rendering one document
 * reuses it (and with it the vnode emitter's per-node memo); a
 * transformed document is a different array and correctly gets fresh
 * numbering.
 *
 * @param {MdNode[]} ast
 * @returns {Footnotes|null}
 */
export function collectFootnotes(ast) {
  const cached = collectMemo.get(ast);
  if (cached !== undefined) return cached;
  const result = collect(ast);
  collectMemo.set(ast, result);
  return result;
}

/**
 * @param {MdNode[]} ast
 * @returns {Footnotes|null}
 */
function collect(ast) {
  /** @type {Map<string, MdNode>} */
  const byId = new Map();
  walkAst(ast, (node) => {
    if (node.type === 'footnoteDefinition' && !byId.has(node.identifier)) {
      byId.set(node.identifier, node);
    }
  });
  if (byId.size === 0) return null;

  /** @type {Footnotes} */
  const found = {
    defs: [],
    numbers: new Map(),
    counts: new Map(),
    refs: new WeakMap(),
  };
  /** Definitions whose own content still has to be scanned. */
  const pending = [];

  /** @param {MdNode[]} root */
  const scan = (root) => walkAst(root, (node) => {
    // A definition is not rendered where it stands, so a reference
    // inside one only counts once something cites the definition — which
    // is what the queue below decides.
    if (node.type === 'footnoteDefinition') return false;
    if (node.type !== 'footnoteReference') return undefined;
    const def = byId.get(node.identifier);
    if (def === undefined) return undefined;
    let number = found.numbers.get(node.identifier);
    if (number === undefined) {
      number = found.numbers.size + 1;
      found.numbers.set(node.identifier, number);
      found.defs.push(def);
      pending.push(def);
    }
    const occurrence = (found.counts.get(node.identifier) ?? 0) + 1;
    found.counts.set(node.identifier, occurrence);
    if (!found.refs.has(node)) found.refs.set(node, { number, occurrence });
    return undefined;
  });

  scan(ast);
  // A footnote may cite another. The queue grows as they are reached and
  // a definition enters it at most once, so a cycle — even a footnote
  // citing itself — terminates instead of unrolling.
  for (let i = 0; i < pending.length; i++) scan(pending[i].children);
  return found;
}

/**
 * The `id` of a rendered footnote (the `<li>` in the section).
 * @param {string} prefix @param {number} number
 * @returns {string}
 */
export function footnoteId(prefix, number) {
  return prefix + 'fn-' + number;
}

/**
 * The `id` of one citation. A footnote cited more than once needs one
 * landing place per citation, or every back-reference would return the
 * reader to the first.
 * @param {string} prefix @param {number} number @param {number} occurrence
 * @returns {string}
 */
export function footnoteRefId(prefix, number, occurrence) {
  return prefix + 'fnref-' + number + (occurrence > 1 ? '-' + occurrence : '');
}

/**
 * The accessible name of a back-reference: `↩` alone names nothing, and
 * a footnote with several of them needs them told apart.
 * @param {number} number @param {number} occurrence
 * @returns {string}
 */
export function backrefLabel(number, occurrence) {
  return occurrence > 1
    ? 'Back to reference ' + number + ', occurrence ' + occurrence
    : 'Back to reference ' + number;
}
