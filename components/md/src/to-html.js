//@ts-check
/**
 * @file AST → HTML string, directly.
 *
 * The package's second emitter, and deliberately not a wrapper around
 * the first (ARCHITECTURE.md "Two emitters"). `mdToVnode` builds a
 * PATCHABLE TREE — keyed, memoized, reference-stable — whose safety is
 * structural: a vnode has no slot for unescaped author markup, which is
 * why a lone `</div>` cannot survive it. `toHtml` builds BYTES, and a
 * string can hold half an element, so the raw-HTML corner of CommonMark
 * is reachable here and only here.
 *
 * What the two share is factored, not copied: the escapers are
 * `@jarenjs/view`'s (the same ones its SSR renderer uses, which is what
 * makes the two outputs byte-identical for markup a vnode can express),
 * the URL policy is `@jarenjs/view/helpers`, heading slugs come from
 * `@jarenjs/core/string` through `utils.js`, and plugin dispatch is the
 * parser's own table.
 *
 * Escaping is the default and `html: 'raw'` is per-call: the default
 * cannot emit unescaped author content, and no jaren surface passes
 * `'raw'`.
 */

import { escapeText, escapeAttribute } from '@jarenjs/view';
import { sanitizeUrl as defaultSanitizeUrl, encodeUrlAttribute } from '@jarenjs/view/helpers';

import { headingId, permalinkLabel } from './utils.js';
import { textOf } from './ast.js';
import { buildPluginTables } from './parser.js';
import {
  collectFootnotes, footnoteId, footnoteRefId, backrefLabel,
  FOOTNOTE_PREFIX, BACKREF_MARK,
} from './footnotes.js';

/**
 * @typedef {import('./ast.js').MdNode} MdNode
 */
/**
 * @typedef {object} MdHtmlOptions
 * @property {'escape'|'skip'|'raw'} [html] raw-HTML policy (default
 *   `'escape'`): show the markup as literal text, drop it (the vnode
 *   path's default), or pass it through verbatim. **`'raw'` emits author
 *   content as live markup and is for trusted input only** — a document
 *   from a user, a fetch or a model must never be rendered with it.
 * @property {(url: string) => (string|null)} [sanitizeUrl] link/image URL
 *   filter, replacing the default deny-list; return the URL to emit or
 *   `null` to drop the attribute. It applies in EVERY `html` mode,
 *   `'raw'` included: `'raw'` is a statement about HTML blocks, not a
 *   blanket trust, so a markdown `[x](javascript:…)` is still filtered.
 * @property {any[]} [plugins] plugin set (must match the parse set for
 *   claimed nodes); a plugin contributes `toHtml(node, ctx)` here the
 *   way it contributes `render` to the vnode path.
 * @property {boolean} [headingIds] GitHub-compatible `id` per heading
 *   (default `false`; see MD-FORMAT.md §4.5 for why it is opt-in).
 * @property {string} [slugPrefix] prepended to every heading id and
 *   anchor href (default `''`); set it for markdown you did not author.
 * @property {boolean} [headingAnchors] append a `#` permalink to each
 *   heading (default `false`). Requires `headingIds`.
 * @property {string} [footnotesLabel] the accessible name of the
 *   appended footnotes section (default `'Footnotes'`); a localized page
 *   sets it, since it is the one string the emitter writes that a reader
 *   can hear.
 * @property {string} [wrap] wrapping element, written as it appears in
 *   the start tag (`'article class="md"'`). Default `null`: bare
 *   fragment HTML, which is what a consumer concatenating into a
 *   template wants.
 */
/**
 * The emission context, built once per call and threaded through.
 * @typedef {{ tables: any, html: 'escape'|'skip'|'raw',
 *   sanitizeUrl: (url: string) => (string|null),
 *   headingIds: boolean, slugPrefix: string, headingAnchors: boolean,
 *   slugs: Map<string, number>, options: MdHtmlOptions,
 *   footnotes: import('./footnotes.js').Footnotes|null,
 *   footnotePrefix: string, footnotesLabel: string }} HtmlCtx
 */

/**
 * One raw-HTML node under the policy in force. `'escape'` shows the
 * markup instead of dropping it: a string can display what a vnode tree
 * cannot hold, and losing the content silently would be the worse
 * default.
 * @param {MdNode} node @param {HtmlCtx} ctx
 * @returns {string}
 */
function rawHtml(node, ctx) {
  if (ctx.html === 'skip') return '';
  return ctx.html === 'raw' ? node.value : escapeText(node.value);
}

/**
 * One attribute, or nothing when the value is absent. Attribute values
 * are escaped exactly as `@jarenjs/view`'s SSR renderer escapes them.
 * @param {string} name @param {string|null|undefined} value
 * @returns {string}
 */
function attr(name, value) {
  return value === null || value === undefined
    ? ''
    : ' ' + name + '="' + escapeAttribute(String(value)) + '"';
}

// ------------------------------------------------------------------
// Inline emission
// ------------------------------------------------------------------

/** @type {Record<string, (node: MdNode, ctx: HtmlCtx) => string>} */
const INLINE_HTML = {
  text: (node) => escapeText(node.value),
  emphasis: (node, ctx) => '<em>' + inlineChildren(node.children, ctx) + '</em>',
  strong: (node, ctx) => '<strong>' + inlineChildren(node.children, ctx) + '</strong>',
  strikethrough: (node, ctx) => '<del>' + inlineChildren(node.children, ctx) + '</del>',
  inlineCode: (node) => '<code>' + escapeText(node.value) + '</code>',

  link: (node, ctx) => {
    // A rejected destination drops the attribute and keeps the element,
    // so the link text stays readable; what survives is percent-encoded
    // for the attribute, as CommonMark's rendering rule requires.
    const href = ctx.sanitizeUrl(node.url);
    return '<a' + (href === null ? '' : attr('href', encodeUrlAttribute(href)))
      + attr('title', node.title) + '>' + inlineChildren(node.children, ctx) + '</a>';
  },

  image: (node, ctx) => {
    const src = ctx.sanitizeUrl(node.url);
    return '<img' + (src === null ? '' : attr('src', encodeUrlAttribute(src)))
      + attr('alt', node.alt) + attr('title', node.title) + '>';
  },

  break: () => '<br>',
  softBreak: () => '\n',
  html: (node, ctx) => rawHtml(node, ctx),

  footnoteReference: (node, ctx) => {
    const cite = ctx.footnotes?.refs.get(node);
    // A reference with nothing to point at is the literal text it was
    // written as, not a link to a missing anchor. The parser only makes
    // this node when a definition exists, so this is the transformed-AST
    // path — but a broken `href` is the one outcome worth ruling out.
    if (cite === undefined) return escapeText('[^' + (node.label ?? node.identifier) + ']');
    const prefix = ctx.footnotePrefix;
    return '<sup>'
      + '<a' + attr('href', '#' + footnoteId(prefix, cite.number))
      + attr('id', footnoteRefId(prefix, cite.number, cite.occurrence))
      + '>' + cite.number + '</a></sup>';
  },
};

/**
 * Emit a run of inline nodes.
 * @param {MdNode[]} nodes @param {HtmlCtx} ctx
 * @returns {string}
 */
function inlineChildren(nodes, ctx) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) out += inlineHtml(nodes[i], ctx);
  return out;
}

/**
 * Emit one inline node (a plugin's `toHtml` shadows the core table).
 * @param {MdNode} node @param {HtmlCtx} ctx
 * @returns {string}
 */
function inlineHtml(node, ctx) {
  const plugin = ctx.tables.htmls.get(node.type);
  if (plugin !== undefined) return String(plugin.toHtml(node, ctx) ?? '');
  const renderer = INLINE_HTML[node.type];
  if (renderer !== undefined) return renderer(node, ctx);
  if (ctx.tables.renders.has(node.type)) return unsupportedNode(node.type);
  return fallbackHtml(node, ctx, true);
}

// ------------------------------------------------------------------
// Block emission
// ------------------------------------------------------------------

/** @type {Record<string, (node: MdNode, ctx: HtmlCtx) => string>} */
const BLOCK_HTML = {
  paragraph: (node, ctx) => '<p>' + inlineChildren(node.children, ctx) + '</p>',

  heading: (node, ctx) => {
    const tag = 'h' + node.depth;
    if (ctx.headingIds !== true) {
      return '<' + tag + '>' + inlineChildren(node.children, ctx) + '</' + tag + '>';
    }
    const id = headingId(textOf(node), ctx.slugs, ctx.slugPrefix);
    let out = '<' + tag + attr('id', id) + '>' + inlineChildren(node.children, ctx);
    if (ctx.headingAnchors === true) {
      out += '<a class="md-anchor"' + attr('href', '#' + id)
        + attr('aria-label', permalinkLabel(textOf(node))) + '>#</a>';
    }
    return out + '</' + tag + '>';
  },

  thematicBreak: () => '<hr>',

  blockquote: (node, ctx) => '<blockquote>' + blockChildren(node.children, ctx) + '</blockquote>',

  list: (node, ctx) => {
    const tag = node.ordered ? 'ol' : 'ul';
    let out = '<' + tag
      + (node.ordered && node.start !== null && node.start !== 1 ? attr('start', node.start) : '')
      + '>';
    for (let i = 0; i < node.children.length; i++) {
      out += listItemHtml(node.children[i], ctx, node.tight);
    }
    return out + '</' + tag + '>';
  },

  code: (node) => '<pre><code'
    + (node.lang === null ? '' : attr('class', 'language-' + node.lang))
    + '>' + escapeText(node.value) + '</code></pre>',

  html: (node, ctx) => rawHtml(node, ctx),

  table: (node, ctx) => {
    const rows = node.children;
    if (rows.length === 0) return '<table></table>';
    const align = node.align;
    let out = '<table><thead><tr>' + cellsHtml(rows[0].children, align, 'th', ctx) + '</tr></thead>';
    if (rows.length > 1) {
      out += '<tbody>';
      for (let r = 1; r < rows.length; r++) {
        out += '<tr>' + cellsHtml(rows[r].children, align, 'td', ctx) + '</tr>';
      }
      out += '</tbody>';
    }
    return out + '</table>';
  },

  // Collected, not rendered in place (MD-FORMAT.md §4.6): the section
  // at the end of the document is where a footnote's content appears,
  // and an uncited definition appears nowhere at all.
  footnoteDefinition: () => '',

  custom: (node, ctx) => fallbackHtml(node, ctx, false),
};

/**
 * The `<section class="footnotes">` appended after the last block: one
 * `<li>` per cited definition, in first-citation order, each ending in a
 * back-reference per citation.
 * @param {HtmlCtx} ctx
 * @returns {string}
 */
function footnotesHtml(ctx) {
  const notes = ctx.footnotes;
  if (notes === null || notes.defs.length === 0) return '';
  const prefix = ctx.footnotePrefix;
  let out = '<section class="footnotes"' + attr('aria-label', ctx.footnotesLabel) + '><ol>';
  for (let i = 0; i < notes.defs.length; i++) {
    const def = notes.defs[i];
    const number = /** @type {number} */ (notes.numbers.get(def.identifier));
    let back = '';
    const times = notes.counts.get(def.identifier) ?? 1;
    for (let k = 1; k <= times; k++) {
      back += ' <a class="footnote-backref"'
        + attr('href', '#' + footnoteRefId(prefix, number, k))
        + attr('aria-label', backrefLabel(number, k))
        + '>' + BACKREF_MARK + (k > 1 ? '<sup>' + k + '</sup>' : '') + '</a>';
    }
    out += '<li' + attr('id', footnoteId(prefix, number)) + '>';
    const blocks = def.children;
    const last = blocks.length - 1;
    for (let b = 0; b < blocks.length; b++) {
      // The back-references ride along inside the closing paragraph, so
      // they read as part of the note rather than as a block of their own.
      out += b === last && blocks[b].type === 'paragraph'
        ? '<p>' + inlineChildren(blocks[b].children, ctx) + back + '</p>'
        : blockHtml(blocks[b], ctx);
    }
    if (blocks.length === 0 || blocks[last].type !== 'paragraph') out += '<p>' + back + '</p>';
    out += '</li>';
  }
  return out + '</ol></section>';
}

/**
 * @param {MdNode[]} cells @param {(string|null)[]} align
 * @param {string} tag @param {HtmlCtx} ctx
 * @returns {string}
 */
function cellsHtml(cells, align, tag, ctx) {
  let out = '';
  for (let c = 0; c < cells.length; c++) {
    const a = align[c] ?? null;
    out += '<' + tag + (a === null ? '' : attr('style', 'text-align:' + a)) + '>'
      + inlineChildren(cells[c].children, ctx) + '</' + tag + '>';
  }
  return out;
}

/**
 * @param {MdNode} item @param {HtmlCtx} ctx
 * @param {boolean} tight tight lists unwrap their paragraphs
 * @returns {string}
 */
function listItemHtml(item, ctx, tight) {
  let out = '<li>';
  if (item.checked !== null && item.checked !== undefined) {
    out += '<input type="checkbox"' + (item.checked ? ' checked' : '') + ' disabled> ';
  }
  const children = item.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // see the vnode emitter: a tight item's unwrapped blocks need the
    // newline that their absent element boundary would have provided
    if (i > 0) out += '\n';
    out += tight && child.type === 'paragraph'
      ? inlineChildren(child.children, ctx)
      : blockHtml(child, ctx);
  }
  return out + '</li>';
}

/**
 * Unknown node types degrade honestly, exactly as the vnode emitter
 * degrades them: a literal node shows its value as preformatted text, a
 * container shows its children.
 * @param {MdNode} node @param {HtmlCtx} ctx @param {boolean} inline
 * @returns {string}
 */
function fallbackHtml(node, ctx, inline) {
  if (typeof node.value === 'string') {
    const tag = inline ? 'code' : 'pre';
    return '<' + tag + attr('class', 'md-' + node.type) + '>'
      + escapeText(node.value) + '</' + tag + '>';
  }
  if (Array.isArray(node.children)) {
    const tag = inline ? 'span' : 'div';
    return '<' + tag + attr('class', 'md-' + node.type) + '>'
      + (inline ? inlineChildren(node.children, ctx) : blockChildren(node.children, ctx))
      + '</' + tag + '>';
  }
  return '';
}

/**
 * A plugin that renders to vnodes but not to a string: the gap is
 * SHOWN rather than silently dropped, so a consumer can see what it is
 * missing. The type is reduced to identifier characters, because a
 * comment must not be able to close itself.
 * @param {string} type
 * @returns {string}
 */
function unsupportedNode(type) {
  const name = String(type).replace(/[^A-Za-z0-9_-]/g, '').replace(/-{2,}/g, '-');
  return '<!-- unsupported plugin node: ' + name + ' -->';
}

/**
 * Emit a sequence of block nodes. Blocks are NOT separated: the output
 * is markup, not a pretty-printed document, and the separator a reader
 * expects is the block element itself.
 * @param {MdNode[]} blocks @param {HtmlCtx} ctx
 * @returns {string}
 */
function blockChildren(blocks, ctx) {
  let out = '';
  for (let i = 0; i < blocks.length; i++) out += blockHtml(blocks[i], ctx);
  return out;
}

/**
 * Emit one block node. A plugin's `toHtml` shadows the core table; a
 * plugin that only renders vnodes falls back to the CORE emitter when
 * the node type has one (the highlight plugin claims `code`, so a code
 * block still prints, just unhighlighted) and is reported as
 * unsupported only when nothing else can print it.
 * @param {MdNode} node @param {HtmlCtx} ctx
 * @returns {string}
 */
function blockHtml(node, ctx) {
  const plugin = ctx.tables.htmls.get(node.type);
  if (plugin !== undefined) return String(plugin.toHtml(node, ctx) ?? '');
  const renderer = BLOCK_HTML[node.type];
  if (renderer !== undefined) return renderer(node, ctx);
  if (ctx.tables.renders.has(node.type)) return unsupportedNode(node.type);
  return fallbackHtml(node, ctx, false);
}

/**
 * Render an MdDocument (or a CompiledMd, an AST array, a single node)
 * to an HTML string.
 *
 * @example
 * toHtml(parseMarkdown('# Hi'));                    // '<h1>Hi</h1>'
 * toHtml(parseMarkdown('<b>x</b>'));                // '&lt;b&gt;x&lt;/b&gt;'
 * toHtml(doc, { html: 'raw' });                     // trusted input only
 * toHtml(doc, { wrap: 'article class="md"' });      // wrapped
 *
 * @param {any} docOrAst MdDocument, CompiledMd, MdNode[] or MdNode
 * @param {MdHtmlOptions} [options]
 * @returns {string}
 */
export function toHtml(docOrAst, options = {}) {
  const ast = Array.isArray(docOrAst)
    ? docOrAst
    : (docOrAst !== null && typeof docOrAst === 'object' && Array.isArray(docOrAst.ast))
      ? docOrAst.ast
      : [docOrAst];
  /** @type {HtmlCtx} */
  const ctx = {
    tables: docOrAst?.tables ?? buildPluginTables(options.plugins),
    html: options.html === 'raw' || options.html === 'skip' ? options.html : 'escape',
    sanitizeUrl: typeof options.sanitizeUrl === 'function'
      ? options.sanitizeUrl
      : defaultSanitizeUrl,
    headingIds: options.headingIds === true,
    slugPrefix: typeof options.slugPrefix === 'string' ? options.slugPrefix : '',
    headingAnchors: options.headingIds === true && options.headingAnchors === true,
    slugs: new Map(),
    options,
    footnotes: collectFootnotes(ast),
    footnotePrefix: typeof options.slugPrefix === 'string' ? options.slugPrefix : FOOTNOTE_PREFIX,
    footnotesLabel: typeof options.footnotesLabel === 'string' ? options.footnotesLabel : 'Footnotes',
  };
  const body = blockChildren(ast, ctx) + footnotesHtml(ctx);
  const wrap = options.wrap;
  if (typeof wrap !== 'string' || wrap === '') return body;
  const space = wrap.indexOf(' ');
  return '<' + wrap + '>' + body + '</' + (space === -1 ? wrap : wrap.slice(0, space)) + '>';
}
