//@ts-check
/**
 * @file The Markdown AST vocabulary: node constructors, shape guards
 * and compiled walkers.
 *
 * Every node is a plain JSON object with a `type` discriminator;
 * container nodes hold ordered content in `children`, literal nodes in
 * `value` (normative vocabulary in docs/MD-FORMAT.md §4). The
 * constructors exist so every node of a type is born with the same
 * hidden class — the walkers and render tables then stay monomorphic.
 */

/** The document format version this package produces. */
export const MD_VERSION = '0.1';

/** Node types whose content lives in `children`. */
const CONTAINER_TYPES = new Set([
  'paragraph', 'heading', 'blockquote', 'list', 'listItem',
  'table', 'tableRow', 'tableCell', 'footnoteDefinition',
  'emphasis', 'strong', 'strikethrough', 'link',
]);

/**
 * @typedef {{ type: string, [member: string]: any }} MdNode
 */
/**
 * @typedef {{ $md: string, frontmatter: any, ast: MdNode[],
 *   meta: { sourceUrl: string|null, hash: string,
 *           frontmatterLang: 'yaml'|'json'|'toml'|null } }} MdDocument
 */

/**
 * Does this node hold its content in `children`? Plugin/custom nodes
 * count when they actually carry a children array.
 * @param {MdNode} node
 * @returns {boolean}
 */
export function isContainerNode(node) {
  return CONTAINER_TYPES.has(node.type) || Array.isArray(node.children);
}

/** @param {MdNode[]} children @returns {MdNode} */
export function paragraph(children) {
  return { type: 'paragraph', children };
}

/** @param {number} depth @param {MdNode[]} children @returns {MdNode} */
export function heading(depth, children) {
  return { type: 'heading', depth, children };
}

/** @returns {MdNode} */
export function thematicBreak() {
  return { type: 'thematicBreak' };
}

/** @param {MdNode[]} children @returns {MdNode} */
export function blockquote(children) {
  return { type: 'blockquote', children };
}

/**
 * @param {boolean} ordered
 * @param {number|null} start
 * @param {boolean} tight
 * @param {MdNode[]} children
 * @returns {MdNode}
 */
export function list(ordered, start, tight, children) {
  return { type: 'list', ordered, start, tight, children };
}

/** @param {boolean|null} checked @param {MdNode[]} children @returns {MdNode} */
export function listItem(checked, children) {
  return { type: 'listItem', checked, children };
}

/**
 * @param {string|null} lang
 * @param {string|null} meta
 * @param {string} value
 * @returns {MdNode}
 */
export function code(lang, meta, value) {
  return { type: 'code', lang, meta, value };
}

/** @param {string} value @returns {MdNode} */
export function htmlBlock(value) {
  return { type: 'html', value };
}

/**
 * @param {(string|null)[]} align
 * @param {MdNode[]} children
 * @returns {MdNode}
 */
export function table(align, children) {
  return { type: 'table', align, children };
}

/** @param {MdNode[]} children @returns {MdNode} */
export function tableRow(children) {
  return { type: 'tableRow', children };
}

/** @param {MdNode[]} children @returns {MdNode} */
export function tableCell(children) {
  return { type: 'tableCell', children };
}

/** @param {string} value @returns {MdNode} */
export function text(value) {
  return { type: 'text', value };
}

/** @param {MdNode[]} children @returns {MdNode} */
export function emphasis(children) {
  return { type: 'emphasis', children };
}

/** @param {MdNode[]} children @returns {MdNode} */
export function strong(children) {
  return { type: 'strong', children };
}

/** @param {MdNode[]} children @returns {MdNode} */
export function strikethrough(children) {
  return { type: 'strikethrough', children };
}

/**
 * @param {string} url
 * @param {string|null} title
 * @param {MdNode[]} children
 * @returns {MdNode}
 */
export function link(url, title, children) {
  return { type: 'link', url, title, children };
}

/**
 * A GFM literal autolink (`www.example.com`, `a@b.test`): a `link`, not
 * a type of its own — every consumer, plugin and schema would otherwise
 * have to learn a second spelling of the same thing. The `auto` flag is
 * carried for the ONE consumer that has to tell them apart, the
 * canonical printer, which prints it back bare (MD-FORMAT.md §4.7).
 * @param {string} url the resolved destination (scheme inserted)
 * @param {string} literal the text as the author wrote it
 * @returns {MdNode}
 */
export function autolink(url, literal) {
  return { type: 'link', url, title: null, children: [{ type: 'text', value: literal }], auto: true };
}

/**
 * A GFM footnote definition: block content collected out of the flow
 * and rendered once, at the end, if something cites it.
 * @param {string} identifier the normalized label (matching key)
 * @param {string} label the label as written
 * @param {MdNode[]} children
 * @returns {MdNode}
 */
export function footnoteDefinition(identifier, label, children) {
  return { type: 'footnoteDefinition', identifier, label, children };
}

/**
 * A GFM footnote reference: the citation mark in the text.
 * @param {string} identifier the normalized label (matching key)
 * @param {string} label the label as written
 * @returns {MdNode}
 */
export function footnoteReference(identifier, label) {
  return { type: 'footnoteReference', identifier, label };
}

/**
 * @param {string} url
 * @param {string|null} title
 * @param {string} alt
 * @returns {MdNode}
 */
export function image(url, title, alt) {
  return { type: 'image', url, title, alt };
}

/** @param {string} value @returns {MdNode} */
export function inlineCode(value) {
  return { type: 'inlineCode', value };
}

/** @returns {MdNode} */
export function hardBreak() {
  return { type: 'break' };
}

/** @returns {MdNode} */
export function softBreak() {
  return { type: 'softBreak' };
}

/**
 * The generic escape hatch for constructs without a compiled-in plugin
 * vocabulary (MD-FORMAT §4.4).
 * @param {string} name
 * @param {any} data
 * @param {MdNode[]} [children]
 * @returns {MdNode}
 */
export function custom(name, data, children = undefined) {
  return children === undefined
    ? { type: 'custom', name, data }
    : { type: 'custom', name, data, children };
}

/**
 * Walk an AST (a node or an array of nodes) in document order, calling
 * `visitor(node, parent, index)` pre-order. Returning `false` from the
 * visitor skips the node's children.
 *
 * @param {MdNode | MdNode[]} root
 * @param {(node: MdNode, parent: MdNode|null, index: number) => (boolean|void)} visitor
 */
export function walkAst(root, visitor) {
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) walkNode(root[i], null, i, visitor);
  }
  else {
    walkNode(root, null, 0, visitor);
  }
}

/**
 * @param {MdNode} node
 * @param {MdNode|null} parent
 * @param {number} index
 * @param {(node: MdNode, parent: MdNode|null, index: number) => (boolean|void)} visitor
 */
function walkNode(node, parent, index, visitor) {
  if (visitor(node, parent, index) === false) return;
  const children = node.children;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      walkNode(children[i], node, i, visitor);
    }
  }
}

/**
 * @typedef {(node: MdNode, parent: MdNode|null, index: number) => (boolean|void)} MdVisitFn
 * @typedef {MdVisitFn | { enter?: MdVisitFn, exit?: MdVisitFn }} MdVisitSpec
 */

/**
 * Compile a per-type visitor spec into a dispatch table and walk with
 * it. Handlers are keyed by node type, `'*'` matches every type; a
 * handler is a function (pre-order) or `{ enter, exit }`. An `enter`
 * returning `false` skips the children (exit still runs).
 *
 * The table is built once per call — pass the same spec object to reuse
 * the compiled form across documents (a `WeakMap` memo keeps this
 * allocation-free on repeat visits).
 *
 * @param {MdNode | MdNode[]} root
 * @param {Record<string, MdVisitSpec>} visitors
 */
export function visitAst(root, visitors) {
  const table = compileVisitorTable(visitors);
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) visitNode(root[i], null, i, table);
  }
  else {
    visitNode(root, null, 0, table);
  }
}

/** @type {WeakMap<object, { enter: Record<string, MdVisitFn>, exit: Record<string, MdVisitFn>, any: { enter: MdVisitFn|null, exit: MdVisitFn|null } }>} */
const visitorMemo = new WeakMap();

/**
 * @param {Record<string, MdVisitSpec>} visitors
 */
function compileVisitorTable(visitors) {
  let table = visitorMemo.get(visitors);
  if (table !== undefined) return table;
  /** @type {Record<string, MdVisitFn>} */
  const enter = Object.create(null);
  /** @type {Record<string, MdVisitFn>} */
  const exit = Object.create(null);
  const any = { enter: /** @type {MdVisitFn|null} */ (null), exit: /** @type {MdVisitFn|null} */ (null) };
  for (const type of Object.keys(visitors)) {
    const spec = visitors[type];
    const enterFn = typeof spec === 'function' ? spec : spec.enter ?? null;
    const exitFn = typeof spec === 'function' ? null : spec.exit ?? null;
    if (type === '*') {
      any.enter = enterFn;
      any.exit = exitFn;
    }
    else {
      if (enterFn !== null) enter[type] = enterFn;
      if (exitFn !== null) exit[type] = exitFn;
    }
  }
  table = { enter, exit, any };
  visitorMemo.set(visitors, table);
  return table;
}

/**
 * @param {MdNode} node
 * @param {MdNode|null} parent
 * @param {number} index
 * @param {{ enter: Record<string, MdVisitFn>, exit: Record<string, MdVisitFn>, any: { enter: MdVisitFn|null, exit: MdVisitFn|null } }} table
 */
function visitNode(node, parent, index, table) {
  const enterFn = table.enter[node.type] ?? table.any.enter;
  let descend = true;
  if (enterFn !== null && enterFn !== undefined) {
    descend = enterFn(node, parent, index) !== false;
  }
  if (descend && Array.isArray(node.children)) {
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      visitNode(children[i], node, i, table);
    }
  }
  const exitFn = table.exit[node.type] ?? table.any.exit;
  if (exitFn !== null && exitFn !== undefined) exitFn(node, parent, index);
}

/**
 * The plain-text content of a node subtree (alt-text derivation,
 * heading slugs, search indexing).
 * @param {MdNode | MdNode[]} root
 * @returns {string}
 */
export function textOf(root) {
  let out = '';
  walkAst(root, (node) => {
    if (node.type === 'text' || node.type === 'inlineCode') out += node.value;
    else if (node.type === 'image') out += node.alt;
    else if (node.type === 'break' || node.type === 'softBreak') out += ' ';
  });
  return out;
}
