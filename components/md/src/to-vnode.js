//@ts-check
/**
 * @file AST → @jarenjs/view vnodes, and the hydrating renderer.
 *
 * The emitter is a prebuilt dispatch table keyed on node type; plugin
 * `render` entries shadow the core entries (that is how the highlight
 * plugin takes over `code` nodes). Two identity guarantees feed the
 * view patcher's O(1) fast paths (VIEW-FORMAT.md §5.1):
 *
 *  - per-node memo: the same AST node reference emits the same vnode
 *    reference, so unchanged subtrees of a JSLT-transformed document
 *    patch in O(1);
 *  - content-hash keys: block vnodes are keyed by a hash of their
 *    content, so moved blocks reorder instead of rebuilding.
 *
 * Raw HTML nodes are dropped by default; `options.html: 'text'` shows
 * them literally, and `'vnode'` PARSES them through an allow-list
 * (`parseHtmlFragment`, or an injected `parseHtml`). The vnode format
 * has no unescaped output in any of the three, which is what makes
 * dropping the safe default for untrusted Markdown. Link and image URLs are
 * filtered on the same principle: a destination whose scheme can execute
 * (`javascript:`, `vbscript:`) or stand in for a document
 * (`data:text/html`, `file:`) loses its attribute rather than reaching
 * the page. The AST keeps the URL verbatim, so `toMarkdown` still
 * round-trips what the author wrote — only the vnode is filtered.
 */

import { h, createDomRenderer } from '@jarenjs/view';
import { sanitizeUrl as defaultSanitizeUrl, encodeUrlAttribute } from '@jarenjs/view/helpers';
import { hashContent, fnv1a, FNV1A_OFFSET_BASIS } from './utils.js';
import { parseHtmlFragment, parseHtmlTag } from './html.js';
import { walkAst } from './ast.js';
import { buildPluginTables } from './parser.js';

/**
 * @typedef {import('./ast.js').MdNode} MdNode
 * @typedef {import('./ast.js').MdDocument} MdDocument
 */
/**
 * @typedef {object} MdVnodeOptions
 * @property {any[]} [plugins] plugin set (must match the parse set for claimed nodes)
 * @property {'skip'|'text'|'vnode'} [html] raw HTML handling (default
 *   'skip'): drop it, show it as literal text, or parse it to vnodes
 * @property {(html: string) => any} [parseHtml] the parser `html: 'vnode'`
 *   uses (default `parseHtmlFragment` from `@jarenjs/md/html`) — the
 *   injection point for a host's own sanitizer. It returns a LIST of
 *   vnodes (empty or null when nothing survived); an array is always
 *   read as a list, because a vnode is an array too and the two would
 *   otherwise be indistinguishable.
 * @property {(url: string) => (string|null)} [sanitizeUrl] link/image URL
 *   filter, replacing the default deny-list; return the URL to emit, or
 *   `null` to drop the attribute. Supply one only to widen the policy for
 *   trusted content (a custom scheme, say) — it is the whole guard.
 */

/**
 * One raw-HTML node, under whichever policy is in force.
 *
 * `'vnode'` parses; what the parser returns may be several nodes, so a
 * BLOCK wraps them in a `<div>` (a block-level html node stands where a
 * block does) while an INLINE one returns the array for the caller to
 * splice. Nothing surviving the parse renders nothing at all, which is
 * the same outcome as `'skip'` — an allow-list that rejected everything
 * must not leave an empty wrapper behind.
 * @param {any} node @param {any} rctx
 * @param {string|null} blockClass class for the block form, null = inline
 * @returns {any}
 */
function htmlNodeVnode(node, rctx, blockClass) {
  if (rctx.html === 'skip') return null;
  if (rctx.html === 'text') {
    return blockClass === null ? node.value : ['pre', { class: blockClass }, node.value];
  }
  const parsed = rctx.parseHtml(node.value);
  const children = parsed === null || parsed === undefined
    ? []
    : Array.isArray(parsed) ? parsed : [parsed];
  if (children.length === 0) return null;
  if (blockClass === null) return children;
  return children.length === 1 && Array.isArray(children[0])
    ? children[0]
    : ['div', { class: blockClass }, ...children];
}

/**
 * The render context threaded through one emission.
 * @typedef {{ tables: any, html: 'skip'|'text'|'vnode', options: MdVnodeOptions,
 *   parseHtml: (html: string) => any,
 *   sanitizeUrl: (url: string) => (string|null),
 *   hash: (str: string) => string, counts: Map<string, number> }} RenderCtx
 */

// ------------------------------------------------------------------
// Inline emission
// ------------------------------------------------------------------

/**
 * Emit the children of an inline container.
 * @param {MdNode[]} nodes
 * @param {RenderCtx} rctx
 * @returns {any[]}
 */
function inlineChildren(nodes, rctx) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    out.push(inlineVnode(nodes[i], rctx));
  }
  return out;
}

/**
 * Append inline children directly onto a vnode under construction
 * (saves the intermediate array + spread on the hot path).
 * @param {any[]} vnode
 * @param {MdNode[]} nodes
 * @param {RenderCtx} rctx
 * @returns {any[]}
 */
function intoVnode(vnode, nodes, rctx) {
  if (rctx.html === 'vnode' && hasInlineHtml(nodes)) {
    vnode.push(...pairInlineHtml(nodes, rctx));
    return vnode;
  }
  for (let i = 0; i < nodes.length; i++) {
    vnode.push(inlineVnode(nodes[i], rctx));
  }
  return vnode;
}

/** Does this inline run contain a raw-HTML node at all? */
function hasInlineHtml(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].type === 'html') return true;
  }
  return false;
}

/**
 * Assemble an inline run whose raw HTML comes one TAG at a time.
 *
 * CommonMark's inline phase emits `<b>bold</b>` as three siblings — an
 * html node, a text node, an html node — because at that level a tag is
 * not an element. Parsing each html node on its own would produce an
 * empty `<b></b>` followed by loose text, so the run is re-paired here:
 * an opening tag opens a frame, the matching closing tag closes it, and
 * everything between becomes its children. A tag left open at the end of
 * the run closes there, as it does inside a fragment.
 *
 * Only the default parser can be asked to classify a lone tag; an
 * injected `parseHtml` keeps the simple path (parse each node on its
 * own), because a host's parser answers a different question.
 * @param {MdNode[]} nodes @param {RenderCtx} rctx
 * @returns {any[]}
 */
function pairInlineHtml(nodes, rctx) {
  const stack = [{ tag: null, props: null, children: /** @type {any[]} */ ([]) }];
  const top = () => stack[stack.length - 1].children;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type !== 'html') {
      top().push(inlineVnode(node, rctx));
      continue;
    }
    const tag = rctx.parseHtml === parseHtmlFragment ? parseHtmlTag(node.value) : null;
    if (tag === null) {
      // not one plain tag (a comment, a whole element, an injected
      // parser): whatever the parser makes of it stands on its own
      const parsed = rctx.parseHtml(node.value);
      if (Array.isArray(parsed)) top().push(...parsed);
      else if (parsed !== null && parsed !== undefined) top().push(parsed);
      continue;
    }
    if (tag.closing) {
      // close the nearest frame this end tag matches; an unmatched one
      // is dropped, like a stray `</div>` in a fragment
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].tag !== tag.name) continue;
        while (stack.length > depth) closeInlineFrame(stack);
        break;
      }
      continue;
    }
    if (tag.complete) {
      if (tag.props !== null) top().push([tag.name, tag.props]);
      continue;
    }
    stack.push({ tag: tag.name, props: tag.props, drop: tag.drop, children: [] });
  }
  while (stack.length > 1) closeInlineFrame(stack);
  return stack[0].children;
}

/**
 * Pop one inline frame into its parent: a known element keeps its props
 * and children, an unknown one keeps only its children, and one whose
 * content is not prose (`<script>`) keeps neither.
 */
function closeInlineFrame(stack) {
  const frame = stack.pop();
  const parent = stack[stack.length - 1].children;
  if (frame.drop === true) return;
  if (frame.props !== null) parent.push([frame.tag, frame.props, ...frame.children]);
  else parent.push(...frame.children);
}

/** @type {Record<string, (node: MdNode, rctx: RenderCtx) => any>} */
const INLINE_RENDERERS = {
  text: (node) => node.value,
  emphasis: (node, rctx) => intoVnode(['em', {}], node.children, rctx),
  strong: (node, rctx) => intoVnode(['strong', {}], node.children, rctx),
  strikethrough: (node, rctx) => intoVnode(['del', {}], node.children, rctx),
  inlineCode: (node) => ['code', {}, node.value],
  link: (node, rctx) => {
    // A rejected destination drops the attribute and keeps the element:
    // the link text stays readable, it just is not clickable. What
    // survives is percent-encoded: the AST holds the destination the
    // author wrote, an attribute needs a URL a browser resolves the same
    // way (CommonMark's rendering rule).
    const href = rctx.sanitizeUrl(node.url);
    const props = href === null ? {} : { href: encodeUrlAttribute(href) };
    if (node.title != null) props.title = node.title;
    return intoVnode(['a', props], node.children, rctx);
  },
  image: (node, rctx) => {
    const src = rctx.sanitizeUrl(node.url);
    const props = src === null
      ? { alt: node.alt }
      : { src: encodeUrlAttribute(src), alt: node.alt };
    if (node.title != null) props.title = node.title;
    return ['img', props];
  },
  break: () => ['br', {}],
  softBreak: () => '\n',
  html: (node, rctx) => htmlNodeVnode(node, rctx, null),
};

/**
 * Emit one inline node (plugin renders shadow the core table).
 * @param {MdNode} node
 * @param {RenderCtx} rctx
 * @returns {any}
 */
function inlineVnode(node, rctx) {
  const plugin = rctx.tables.renders.get(node.type);
  if (plugin !== undefined) return plugin.render(node, h, rctx);
  const renderer = INLINE_RENDERERS[node.type];
  if (renderer !== undefined) return renderer(node, rctx);
  return fallbackVnode(node, rctx, true);
}

// ------------------------------------------------------------------
// Block emission
// ------------------------------------------------------------------

/** @type {Record<string, (node: MdNode, rctx: RenderCtx) => any>} */
const BLOCK_RENDERERS = {
  paragraph: (node, rctx) => intoVnode(['p', {}], node.children, rctx),

  heading: (node, rctx) =>
    intoVnode(['h' + node.depth, {}], node.children, rctx),

  thematicBreak: () => ['hr', {}],

  blockquote: (node, rctx) => ['blockquote', {}, ...blockChildren(node.children, rctx, false)],

  list: (node, rctx) => {
    const items = [];
    for (let i = 0; i < node.children.length; i++) {
      items.push(listItemVnode(node.children[i], rctx, node.tight));
    }
    return node.ordered
      ? (node.start !== null && node.start !== 1
        ? ['ol', { start: node.start }, items]
        : ['ol', {}, items])
      : ['ul', {}, items];
  },

  code: (node) => {
    const props = node.lang === null ? {} : { class: 'language-' + node.lang };
    return ['pre', {}, ['code', props, node.value]];
  },

  html: (node, rctx) => htmlNodeVnode(node, rctx, 'md-html'),

  table: (node, rctx) => {
    const rows = node.children;
    if (rows.length === 0) return ['table', {}];
    const align = node.align;
    const head = ['tr', {}, ...cellVnodes(rows[0].children, align, 'th', rctx)];
    const body = [];
    for (let r = 1; r < rows.length; r++) {
      body.push(['tr', {}, ...cellVnodes(rows[r].children, align, 'td', rctx)]);
    }
    return ['table', {},
      ['thead', {}, head],
      body.length === 0 ? null : ['tbody', {}, body]];
  },

  custom: (node, rctx) => fallbackVnode(node, rctx, false),
};

/**
 * @param {MdNode[]} cells
 * @param {(string|null)[]} align
 * @param {string} tag
 * @param {RenderCtx} rctx
 * @returns {any[]}
 */
function cellVnodes(cells, align, tag, rctx) {
  const out = [];
  for (let c = 0; c < cells.length; c++) {
    const a = align[c] ?? null;
    const props = a === null ? {} : { style: 'text-align:' + a };
    out.push(intoVnode([tag, props], cells[c].children, rctx));
  }
  return out;
}

/**
 * @param {MdNode} item
 * @param {RenderCtx} rctx
 * @param {boolean} tight
 * @returns {any}
 */
function listItemVnode(item, rctx, tight) {
  /** @type {any[]} */
  const content = [];
  if (item.checked !== null && item.checked !== undefined) {
    content.push(['input', { type: 'checkbox', checked: item.checked, disabled: true }]);
    content.push(' ');
  }
  const children = item.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // Tight lists unwrap their paragraphs (standard HTML rendering).
    if (tight && child.type === 'paragraph') {
      content.push(...inlineChildren(child.children, rctx));
    }
    else {
      content.push(blockVnode(child, rctx, false));
    }
  }
  return ['li', {}, ...content];
}

/**
 * Unknown node types degrade honestly: literal nodes render their
 * value as preformatted text, containers render their children.
 * @param {MdNode} node
 * @param {RenderCtx} rctx
 * @param {boolean} inline
 * @returns {any}
 */
function fallbackVnode(node, rctx, inline) {
  if (typeof node.value === 'string') {
    return inline
      ? ['code', { class: 'md-' + node.type }, node.value]
      : ['pre', { class: 'md-' + node.type }, node.value];
  }
  if (Array.isArray(node.children)) {
    return inline
      ? ['span', { class: 'md-' + node.type }, ...inlineChildren(node.children, rctx)]
      : ['div', { class: 'md-' + node.type }, ...blockChildren(node.children, rctx, false)];
  }
  return null;
}

/**
 * @param {MdNode[]} blocks
 * @param {RenderCtx} rctx
 * @param {boolean} keyed content-hash keys on each block (top level only)
 * @returns {any[]}
 */
function blockChildren(blocks, rctx, keyed) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    out.push(blockVnode(blocks[i], rctx, keyed));
  }
  return out;
}

/**
 * Emit one block node through the per-node memo.
 * @param {MdNode} node
 * @param {RenderCtx} rctx
 * @param {boolean} keyed
 * @returns {any}
 */
function blockVnode(node, rctx, keyed) {
  /** @type {WeakMap<MdNode, any>} */
  const memo = rctx.tables.vnodeMemo;
  const cached = memo.get(node);
  // The memo outlives one emission (a CompiledMd carries it), so every
  // option that changes the output has to be part of the cache identity.
  if (cached !== undefined && cached.keyed === keyed && cached.html === rctx.html
    && cached.sanitizeUrl === rctx.sanitizeUrl) {
    return cached.vnode;
  }
  const plugin = rctx.tables.renders.get(node.type);
  let vnode = plugin !== undefined
    ? plugin.render(node, h, rctx)
    : (BLOCK_RENDERERS[node.type] ?? ((n, ctx) => fallbackVnode(n, ctx, false)))(node, rctx);
  if (keyed && Array.isArray(vnode) && typeof vnode[0] === 'string') {
    vnode = withKey(vnode, blockKey(node, rctx));
  }
  memo.set(node, { vnode, keyed, html: rctx.html, sanitizeUrl: rctx.sanitizeUrl });
  return vnode;
}

/**
 * Content-hash key for a block, with an occurrence counter so equal
 * blocks stay distinct among siblings. The hash walks the node
 * structurally (FNV-1a over keys and values) — no JSON string is ever
 * built, so keying is O(content) with a small constant.
 * @param {MdNode} node
 * @param {RenderCtx} rctx
 * @returns {string}
 */
function blockKey(node, rctx) {
  const base = (hashValue(FNV1A_OFFSET_BASIS, node) >>> 0).toString(36);
  const seen = rctx.counts.get(base) ?? 0;
  rctx.counts.set(base, seen + 1);
  return seen === 0 ? base : base + ':' + seen;
}

/**
 * FNV-1a over a JSON value's structure (deterministic member order —
 * the AST constructors build every node of a type with the same key
 * order). The walk is md-specific — type tags are folded in with a
 * `* 31` step so `{a: 1}` and `['a', 1]` differ — but every string is
 * mixed through the suite's single `fnv1a` step, seeded with the hash
 * so far.
 * @param {number} h running unsigned 32-bit hash
 * @param {any} value
 * @returns {number}
 */
function hashValue(h, value) {
  switch (typeof value) {
    case 'string':
      return fnv1a(value, (h * 31 + 1) >>> 0);
    case 'number':
      return fnv1a(String(value), (h * 31 + 2) >>> 0);
    case 'boolean':
      return ((h * 31 + (value ? 3 : 4)) * 0x01000193) >>> 0;
    default:
      break;
  }
  if (value === null || value === undefined) {
    return ((h * 31 + 5) * 0x01000193) >>> 0;
  }
  if (Array.isArray(value)) {
    h = (h * 31 + 6) >>> 0;
    for (let i = 0; i < value.length; i++) h = hashValue(h, value[i]);
    return h;
  }
  h = (h * 31 + 7) >>> 0;
  for (const key of Object.keys(value)) {
    h = fnv1a(key, h);
    h = hashValue(h, value[key]);
  }
  return h;
}

/**
 * Return a copy of an element vnode with `key` set (never mutates the
 * possibly-shared original).
 * @param {any[]} vnode
 * @param {string} key
 * @returns {any[]}
 */
function withKey(vnode, key) {
  const out = vnode.slice();
  const props = out.length > 1 && out[1] !== null && typeof out[1] === 'object' && !Array.isArray(out[1])
    ? out[1] : null;
  if (props === null) out.splice(1, 0, { key });
  else if (props.key === undefined) out[1] = { ...props, key };
  return out;
}

/**
 * Emit a whole document (or AST array) as one `article.md` vnode with
 * content-hash-keyed block children.
 *
 * @example
 * mdToVnode(parseMarkdown('# Hi'))
 * // ['article', { class: 'md' }, [['h1', { key: '…' }, 'Hi']]]
 *
 * @param {any} docOrCompiled MdDocument, CompiledMd or MdNode[]
 * @param {MdVnodeOptions} [options]
 * @returns {any}
 */
export function mdToVnode(docOrCompiled, options = {}) {
  const ast = Array.isArray(docOrCompiled)
    ? docOrCompiled
    : Array.isArray(docOrCompiled.ast) ? docOrCompiled.ast : [docOrCompiled];
  const tables = docOrCompiled.tables ?? buildPluginTables(options.plugins);
  /** @type {RenderCtx} */
  const rctx = {
    tables,
    html: options.html === 'text' || options.html === 'vnode' ? options.html : 'skip',
    parseHtml: typeof options.parseHtml === 'function' ? options.parseHtml : parseHtmlFragment,
    sanitizeUrl: typeof options.sanitizeUrl === 'function'
      ? options.sanitizeUrl
      : defaultSanitizeUrl,
    options,
    hash: hashContent,
    counts: new Map(),
  };
  return ['article', { class: 'md' }, blockChildren(ast, rctx, true)];
}

// ------------------------------------------------------------------
// The hydrating renderer
// ------------------------------------------------------------------

/**
 * Create a renderer over `@jarenjs/view`'s DOM patcher that also runs
 * plugin `hydrate` hooks after mount (PLUGINS.md §5). Returns a
 * `render(docOrCompiled)` function.
 *
 * @param {{
 *   container: any,
 *   plugins?: any[],
 *   html?: 'skip'|'text',
 *   document?: any,
 *   onEvent?: (binding: any, event: any) => void,
 *   onHydrateError?: (err: any) => void,
 * }} options
 * @returns {(docOrCompiled: any) => void}
 */
export function createMdRenderer(options) {
  // Loaded lazily so SSR-only consumers never touch the DOM module.
  /** @type {any} */
  let domRender = null;
  const tables = buildPluginTables(options.plugins);
  const onHydrateError = options.onHydrateError
    // eslint-disable-next-line no-console -- the documented default sink
    ?? ((err) => console.error('md hydrate:', err));
  /** @type {WeakMap<any, string>} */
  const hydrated = new WeakMap();

  return function render(docOrCompiled) {
    if (domRender === null) {
      domRender = createDomRenderer(options.container, {
        document: options.document,
        onEvent: options.onEvent,
      });
    }
    const vnode = typeof docOrCompiled.toVnode === 'function'
      ? docOrCompiled.toVnode()
      : mdToVnode(docOrCompiled, {
        plugins: options.plugins,
        html: options.html,
        sanitizeUrl: options.sanitizeUrl,
      });
    domRender(vnode);
    if (tables.hydrates.size === 0) return;
    const index = hydrateIndex(docOrCompiled, tables);
    queueMicrotask(() => {
      const marked = options.container.querySelectorAll('[data-md-hydrate]');
      for (const el of marked) {
        const name = el.getAttribute('data-md-hydrate');
        const hash = el.getAttribute('data-md-hash') ?? '';
        if (hydrated.get(el) === hash) continue;
        const entry = index.get(hash);
        const plugin = entry !== undefined ? tables.hydrates.get(entry.type) : undefined;
        if (plugin === undefined || plugin.name !== name) continue;
        hydrated.set(el, hash);
        try {
          const result = plugin.hydrate(el, entry, { options, hash: hashContent });
          if (result !== undefined && result !== null && typeof result.catch === 'function') {
            result.catch(onHydrateError);
          }
        }
        catch (err) {
          onHydrateError(err);
        }
      }
    });
  };
}

/**
 * Build (and memoize on the tables) the content-hash → node index for
 * hydratable node types.
 * @param {any} docOrCompiled
 * @param {any} tables
 * @returns {Map<string, MdNode>}
 */
function hydrateIndex(docOrCompiled, tables) {
  const ast = Array.isArray(docOrCompiled) ? docOrCompiled : docOrCompiled.ast;
  /** @type {WeakMap<any, Map<string, MdNode>>} */
  const memo = tables.hydrateMemo;
  let index = memo.get(ast);
  if (index !== undefined) return index;
  index = new Map();
  walkAst(ast, (node) => {
    if (tables.hydrates.has(node.type) && typeof node.value === 'string') {
      /** @type {Map<string, MdNode>} */ (index).set(hashContent(node.value), node);
    }
  });
  memo.set(ast, index);
  return index;
}

