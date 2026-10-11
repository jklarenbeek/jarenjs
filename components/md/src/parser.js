//@ts-check
/**
 * @file The Markdown parser: block structure + inline parsing → AST.
 *
 * One pass over the source builds the block tree (a container stack of
 * blockquotes/lists/items plus one open leaf), buffering each leaf's
 * raw text; inline parsing runs once per leaf when it closes. Plugin
 * extension points — fence claims, block rules, inline rules — are
 * prebuilt tables consulted by indexed lookup in the hot loop
 * (docs/PLUGINS.md); with no plugins the tables are shared empty maps.
 *
 * The same machinery runs batch (`parseMarkdown`) and incrementally
 * (`createIncrementalParser`): blocks land in the output only when
 * closed, so the incremental parser can hand out completed top-level
 * blocks while later chunks are still arriving (docs/LOADER.md §4).
 */

import { countIndent, expandTabs, hashContent, fnv1a, FNV1A_OFFSET_BASIS, MAX_NESTING } from './utils.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  scanThematicBreak,
  scanAtxHeading,
  scanFenceOpen,
  scanFenceClose,
  splitFenceInfo,
  scanBlockquote,
  scanListMarker,
  scanSetextUnderline,
  scanTableDelimiter,
  splitTableRow,
  scanHtmlBlockStart,
  scanHtmlBlockEnd,
  scanLinkDefinition,
  scanLinkDestination,
  scanLinkTitle,
  scanFootnoteDefinition,
  scanFootnoteReference,
  scanAutolinkLiterals,
  RE_AUTOLINK_URI,
  RE_AUTOLINK_EMAIL,
  normalizeLabel,
  isSpaceCode,
  ASCII_PUNCT,
  isUnicodeWhitespace,
  isUnicodePunctuation,
  codePointBefore,
} from './scanner.js';
import { scanEntity } from './entities.js';
import {
  MD_VERSION,
  thematicBreak, pageBreak, blockquote, list, listItem,
  code, htmlBlock, tableRow, tableCell,
  text, emphasis, strong, strikethrough, link, image, inlineCode,
  hardBreak, softBreak, textOf,
  autolink, footnoteDefinition, footnoteReference,
} from './ast.js';

/** A one-line layout marker, with ordinary block indentation. */
const RE_PAGE_BREAK = /^ {0,3}<!--[ \t]*pagebreak[ \t]*-->[ \t]*$/;

/**
 * @typedef {import('./ast.js').MdNode} MdNode
 * @typedef {import('./ast.js').MdDocument} MdDocument
 */
/**
 * @typedef {object} MdParseOptions
 * @property {any[]} [plugins] compiled-in plugins (docs/PLUGINS.md)
 * @property {boolean} [gfm] GFM tables/strikethrough/task lists (default true)
 * @property {boolean} [frontmatter] detect frontmatter (default true)
 * @property {(text: string) => any} [toml] injectable TOML frontmatter parser
 * @property {string|null} [sourceUrl] recorded in `meta.sourceUrl`
 */

// ------------------------------------------------------------------
// Plugin tables (built once per plugin set, memoized by array identity)
// ------------------------------------------------------------------

/** @type {Map<any, any>} */
const EMPTY_MAP = new Map();
const NO_TABLES = Object.freeze({
  fences: EMPTY_MAP,
  blocks: EMPTY_MAP,
  inlines: EMPTY_MAP,
  renders: EMPTY_MAP,
  htmls: EMPTY_MAP,
  hydrates: EMPTY_MAP,
  plugins: Object.freeze([]),
  vnodeMemo: new WeakMap(),
  hydrateMemo: new WeakMap(),
});

/** @type {WeakMap<any[], any>} */
const tableMemo = new WeakMap();

/**
 * Merge a plugin array into the four dispatch tables (first plugin
 * wins on every collision). Memoized by array identity so module-level
 * plugin arrays compile exactly once.
 * @param {any[] | undefined} plugins
 */
export function buildPluginTables(plugins) {
  if (plugins === undefined || plugins.length === 0) return NO_TABLES;
  let tables = tableMemo.get(plugins);
  if (tables !== undefined) return tables;
  /** @type {Map<string, any>} */
  const fences = new Map();
  /** @type {Map<number, any[]>} */
  const blocks = new Map();
  /** @type {Map<number, any[]>} */
  const inlines = new Map();
  /** @type {Map<string, any>} */
  const renders = new Map();
  /** @type {Map<string, any>} */
  const htmls = new Map();
  /** @type {Map<string, any>} */
  const hydrates = new Map();
  for (const plugin of plugins) {
    if (Array.isArray(plugin.fences)) {
      for (const word of plugin.fences) {
        if (!fences.has(word)) fences.set(word, plugin);
      }
    }
    if (Array.isArray(plugin.blocks)) {
      for (const rule of plugin.blocks) {
        for (const ch of rule.chars) {
          const cc = ch.charCodeAt(0);
          const bucket = blocks.get(cc);
          if (bucket === undefined) blocks.set(cc, [rule]);
          else bucket.push(rule);
        }
      }
    }
    if (Array.isArray(plugin.inlines)) {
      for (const rule of plugin.inlines) {
        const cc = rule.char.charCodeAt(0);
        const bucket = inlines.get(cc);
        if (bucket === undefined) inlines.set(cc, [rule]);
        else bucket.push(rule);
      }
    }
    if (typeof plugin.render === 'function') {
      const type = plugin.node ?? plugin.name;
      if (!renders.has(type)) renders.set(type, plugin);
      if (typeof plugin.hydrate === 'function') hydrates.set(type, plugin);
    }
    // the string emitter's table: a plugin may serve one emitter, the
    // other, or both, so this is registered independently of `render`
    if (typeof plugin.toHtml === 'function') {
      const type = plugin.node ?? plugin.name;
      if (!htmls.has(type)) htmls.set(type, plugin);
    }
  }
  tables = {
    fences, blocks, inlines, renders, htmls, hydrates, plugins,
    vnodeMemo: new WeakMap(),
    hydrateMemo: new WeakMap(),
  };
  tableMemo.set(plugins, tables);
  return tables;
}

// ------------------------------------------------------------------
// Block parser
// ------------------------------------------------------------------

/**
 * The content indent of a footnote definition's continuation lines.
 * Fixed at four columns, unlike a list item's, whose marker decides it:
 * `[^label]:` has no width a reader can count, so the reference
 * implementation picked a constant and every document written for
 * GitHub is indented to it.
 */
const FOOTNOTE_INDENT = 4;

/**
 * The block parser state. Not exported — reach it through
 * `parseMarkdown` or `createIncrementalParser`.
 */
class BlockParser {
  /**
   * @param {MdParseOptions} options
   * @param {any} tables
   */
  constructor(options, tables) {
    this.options = options;
    this.tables = tables;
    this.gfm = options.gfm !== false;
    /** Completed top-level blocks (raw; inline text not yet parsed). */
    /** @type {MdNode[]} */
    this.blocks = [];
    /** Open containers: blockquote / list / listItem entries. */
    /** @type {any[]} */
    this.stack = [];
    /** The open leaf, or null. */
    /** @type {any} */
    this.leaf = null;
    /** Link reference definitions seen so far. */
    /** @type {Map<string, { url: string, title: string|null }>} */
    this.defs = new Map();
    /**
     * Footnote definitions seen so far, by normalized identifier (first
     * definition wins, as for link references). The inline phase
     * consults it: `[^x]` with nothing to point at stays literal text,
     * which is what GitHub does and what keeps a bracketed `^` in prose
     * from becoming a dangling superscript.
     * @type {Map<string, MdNode>}
     */
    this.footnotes = new Map();
    /**
     * Blocks whose last line was blank. List tightness is decided from
     * this at list close (§Lists, "a list is loose if any of its
     * constituent list items are separated by blank lines, or if any of
     * its constituent list items directly contain two block-level
     * elements with a blank line between them") — a rule about a list's
     * OWN items, which is why it cannot be a flag on the open list: a
     * blank line inside a sublist or a blockquote belongs to that
     * container, not to the list around it.
     * @type {WeakSet<any>}
     */
    this.blankEnd = new WeakSet();
    /** Plugin rule context. */
    this.ctx = { frontmatter: /** @type {any} */ (null), options };
  }

  /**
   * Process one detabbed line.
   * @param {string} line
   */
  line(line) {
    // 1. Match the open containers' prefixes.
    let offset = 0;
    let matched = 0;
    const stack = this.stack;
    while (matched < stack.length) {
      const entry = stack[matched];
      if (entry.type === 'blockquote') {
        let i = offset;
        let spaces = 0;
        while (spaces < 3 && line.charCodeAt(i) === 0x20) { i++; spaces++; }
        const content = scanBlockquote(line, i);
        if (content === -1) break;
        offset = content;
      }
      else if (entry.type === 'listItem' || entry.type === 'footnoteDefinition') {
        // A footnote definition continues exactly as a list item does —
        // indented content, lazy continuation, one leading blank at most
        // — so the two share this branch and differ only in where their
        // content indent comes from (a marker's width, or a fixed 4).
        //
        // Blankness is a property of what is LEFT of the line, not of the
        // whole line: inside `>>`, the item sees a blank line even though
        // the line is not.
        if (isBlankFrom(line, offset)) {
          // An item may begin with at most one blank line, so a blank
          // line does not continue an item that is still empty — it ends
          // it (and the list with it).
          if (this.isItemEmpty(entry, matched)) break;
        }
        else {
          let i = offset;
          let spaces = 0;
          while (spaces < entry.contentIndent && line.charCodeAt(i) === 0x20) { i++; spaces++; }
          if (spaces < entry.contentIndent) break;
          offset = i;
        }
      }
      // 'list' entries consume nothing.
      matched++;
    }

    const blank = isBlankFrom(line, offset);

    if (matched < stack.length) {
      const rest = line.slice(offset);
      // Lazy continuation: an open paragraph swallows a line that would
      // not start a block of its own. The paragraph-INTERRUPTION rules
      // (no empty list item, no ordered list starting elsewhere than 1)
      // deliberately do not apply here: they govern a paragraph that is
      // the innermost matched container, and this paragraph is not —
      // its own containers just failed to match. `1. a\n2. b\n3) c`
      // starts a second list for exactly that reason.
      if (this.leaf !== null && this.leaf.kind === 'paragraph'
        && !blank && !this.startsBlock(rest)) {
        this.leaf.lines.push(stripIndent(rest));
        return;
      }
      this.closeTo(matched);
    }

    const rest = offset === 0 ? line : line.slice(offset);

    // 2. Raw leaves consume the line before any block-start scan.
    const leaf = this.leaf;
    if (leaf !== null) {
      if (leaf.kind === 'fence') {
        if (!blank && scanFenceClose(rest, leaf.marker, leaf.length)) {
          this.closeLeaf();
          return;
        }
        const strip = Math.min(leaf.indent, countIndent(rest));
        leaf.lines.push(strip === 0 ? rest : rest.slice(strip));
        return;
      }
      if (leaf.kind === 'html') {
        if (leaf.htmlKind >= 6) {
          if (blank) {
            this.closeLeaf();
            this.sawBlank();
            return;
          }
          leaf.lines.push(rest);
          return;
        }
        leaf.lines.push(rest);
        if (scanHtmlBlockEnd(leaf.htmlKind, rest)) this.closeLeaf();
        return;
      }
      if (leaf.kind === 'plugin') {
        const verdict = leaf.rule.continue(leaf.node, rest, this.ctx);
        if (verdict === true) return;
        this.closeLeaf();
        if (verdict === 'end') return; // the closing line is consumed
        if (blank) { this.sawBlank(); return; }
        // The rejecting line is reprocessed as a fresh block start.
        this.open(rest);
        return;
      }
      if (leaf.kind === 'table') {
        if (blank || this.interruptsParagraph(rest)) {
          this.closeLeaf();
          if (blank) { this.sawBlank(); return; }
          this.open(rest);
          return;
        }
        leaf.rows.push(rest);
        return;
      }
    }

    // 3. Try to open new blocks (containers loop within the line).
    this.open(rest);
  }

  /**
   * Would this text start a construct that interrupts a paragraph?
   * (Also the lazy-continuation test and the GFM table row breaker.)
   * @param {string} rest
   * @returns {boolean}
   */
  interruptsParagraph(rest) {
    const indent = countIndent(rest);
    if (indent >= 4) return false;
    const c = rest.charCodeAt(indent);
    if (c === 0x3E /* > */) return true;
    if (c === 0x23 /* # */) return scanAtxHeading(rest, indent) !== null;
    if (scanThematicBreak(rest, indent)) return true;
    if (scanFenceOpen(rest, indent) !== null) return true;
    if (c === 0x3C /* < */) {
      const kind = scanHtmlBlockStart(rest, indent, true);
      return kind !== 0 && kind !== 7;
    }
    if (c === 0x5B /* [ */ && this.gfm && scanFootnoteDefinition(rest, indent) !== null) {
      return true;
    }
    const marker = scanListMarker(rest, indent);
    if (marker !== null) {
      // Only non-empty items — and ordered lists starting at 1 —
      // interrupt a paragraph.
      if (marker.contentOffset >= rest.length) return false;
      return !marker.ordered || marker.start === 1;
    }
    return false;
  }

  /**
   * Would this text open ANY block, with no paragraph in the way? The
   * lazy-continuation test: a line that starts a block is not paragraph
   * text, whatever the paragraph would have preferred.
   *
   * Indented code and setext underlines are absent on purpose — both
   * need the paragraph to be the innermost matched container, which is
   * exactly the case this method is not asked about.
   * @param {string} rest
   * @returns {boolean}
   */
  startsBlock(rest) {
    const indent = countIndent(rest);
    if (indent >= 4 || indent >= rest.length) return false;
    const c = rest.charCodeAt(indent);
    if (c === 0x3E /* > */) return true;
    if (c === 0x23 /* # */ && scanAtxHeading(rest, indent) !== null) return true;
    if (scanThematicBreak(rest, indent)) return true;
    if (scanFenceOpen(rest, indent) !== null) return true;
    if (c === 0x3C /* < */ && scanHtmlBlockStart(rest, indent, false) !== 0) return true;
    if (c === 0x5B /* [ */ && this.gfm && scanFootnoteDefinition(rest, indent) !== null) return true;
    if (scanListMarker(rest, indent) !== null) return true;
    const rules = this.tables.blocks.get(c);
    if (rules !== undefined) {
      const trimmed = rest.slice(indent);
      for (let i = 0; i < rules.length; i++) {
        if (rules[i].start(trimmed, this.ctx) != null) return true;
      }
    }
    return false;
  }

  /**
   * Is the list item at stack depth `index` still empty — nothing
   * closed into it, no open leaf and no deeper container? Only the
   * innermost entry can own the open leaf, which is what makes this a
   * cheap check rather than a walk.
   * @param {any} entry @param {number} index
   * @returns {boolean}
   */
  isItemEmpty(entry, index) {
    return entry.node.children.length === 0
      && index === this.stack.length - 1
      && this.leaf === null;
  }

  /**
   * May `entries` more containers open here without nesting past
   * `MAX_NESTING`? A list on top of the stack is closed (or continued)
   * before anything opens, so it does not count against the room.
   * @param {number} entries
   * @returns {boolean}
   */
  hasRoom(entries) {
    const stack = this.stack;
    const top = stack[stack.length - 1];
    const base = top !== undefined && top.type === 'list' ? stack.length - 1 : stack.length;
    return base + entries <= MAX_NESTING;
  }

  /**
   * Open new blocks in `rest` (recursing through fresh containers).
   * @param {string} rest
   */
  open(rest) {
    for (;;) {
      const indent = countIndent(rest);

      if (indent >= rest.length) {
        // Blank: paragraphs, tables and type-6/7 html close; indented
        // code buffers the blank; fences got it earlier.
        const leaf = this.leaf;
        if (leaf !== null && leaf.kind === 'indented') leaf.lines.push('');
        else this.closeLeaf();
        this.sawBlank();
        return;
      }

      // Indented code (only when no paragraph is open to continue).
      if (indent >= 4) {
        const leaf = this.leaf;
        if (leaf !== null && leaf.kind === 'paragraph') {
          leaf.lines.push(rest.slice(indent));
          return;
        }
        if (leaf !== null && leaf.kind === 'indented') {
          leaf.lines.push(rest.slice(4));
          return;
        }
        this.closeList();
        this.leaf = { kind: 'indented', lines: [rest.slice(4)] };
        return;
      }

      const c = rest.charCodeAt(indent);
      let para = this.leaf !== null && this.leaf.kind === 'paragraph'
        ? this.leaf : null;

      // Setext underline turns the open paragraph into a heading.
      if (para !== null && (c === 0x3D /* = */ || c === 0x2D /* - */)) {
        const depth = scanSetextUnderline(rest, indent);
        if (depth !== 0) {
          const lines = para.lines;
          this.leaf = null;
          // Link reference definitions are shed BEFORE the underline is
          // applied: they are not heading text. A paragraph that was
          // nothing but definitions leaves no content to underline, so
          // the `=` line falls through and starts a paragraph of its own.
          const raw = this.extractDefinitions(lines.join('\n')).trim();
          if (raw !== '') {
            this.add({ type: 'heading', depth, children: [], raw });
            return;
          }
          // nothing left to underline: this line is ordinary content, and
          // the paragraph it would have continued no longer exists
          para = null;
        }
      }

      // GFM table: the open one-pipe paragraph line + a delimiter row.
      if (this.gfm && para !== null && para.lines.length > 0) {
        const align = scanTableDelimiter(rest);
        if (align !== null) {
          const header = para.lines[para.lines.length - 1];
          const cells = splitTableRow(header);
          if (cells !== null && cells.length === align.length) {
            para.lines.pop();
            this.closeLeaf();
            this.leaf = { kind: 'table', align, rows: [header] };
            return;
          }
        }
      }

      const fence = scanFenceOpen(rest, indent);
      if (fence !== null) {
        this.closeLeaf();
        this.closeList();
        this.leaf = {
          kind: 'fence',
          marker: fence.marker,
          length: fence.length,
          indent,
          info: fence.info,
          lines: [],
        };
        return;
      }

      if (c === 0x23 /* # */) {
        const atx = scanAtxHeading(rest, indent);
        if (atx !== null) {
          this.closeLeaf();
          this.closeList();
          this.add({ type: 'heading', depth: atx.depth, children: [], raw: atx.text });
          return;
        }
      }

      if (scanThematicBreak(rest, indent)) {
        this.closeLeaf();
        this.closeList();
        this.add(thematicBreak());
        return;
      }

      // A container marker past the nesting bound opens nothing; it falls
      // through to be read as paragraph text.
      if (c === 0x3E /* > */ && this.hasRoom(1)) {
        this.closeLeaf();
        this.closeList();
        const node = blockquote([]);
        this.stack.push({ type: 'blockquote', node });
        rest = rest.slice(scanBlockquote(rest, indent));
        continue;
      }

      const marker = scanListMarker(rest, indent);
      if (marker !== null
        && !(para !== null && !this.interruptsParagraph(rest))
        && this.hasRoom(2)) {
        this.closeLeaf();
        const top = this.stack[this.stack.length - 1];
        let entry = top !== undefined && top.type === 'list' ? top : null;
        if (entry !== null
          && (entry.bullet !== marker.bullet || entry.delimiter !== marker.delimiter)) {
          this.closeList();
          entry = null;
        }
        if (entry === null) {
          const node = list(marker.ordered, marker.ordered ? marker.start : null, true, []);
          entry = {
            type: 'list', node,
            bullet: marker.bullet, delimiter: marker.delimiter,
          };
          this.stack.push(entry);
        }
        const item = listItem(null, []);
        this.stack.push({ type: 'listItem', node: item, contentIndent: marker.contentOffset });
        rest = rest.slice(Math.min(marker.contentOffset, rest.length));
        continue;
      }

      if (c === 0x3C /* < */) {
        const kind = scanHtmlBlockStart(rest, indent, para !== null);
        if (kind !== 0) {
          this.closeLeaf();
          this.closeList();
          this.leaf = { kind: 'html', htmlKind: kind, lines: [rest] };
          if (scanHtmlBlockEnd(kind, rest)) this.closeLeaf();
          return;
        }
      }

      // GFM footnote definition. A block, not a paragraph-leading
      // definition like `[foo]:` — so it interrupts, and it is tried
      // BEFORE the paragraph closes, which is what keeps `[^1]: x` from
      // reaching `extractDefinitions` and becoming a link reference
      // named `^1`.
      if (this.gfm && c === 0x5B /* [ */ && this.hasRoom(1)) {
        const note = scanFootnoteDefinition(rest, indent);
        if (note !== null) {
          this.closeLeaf();
          this.closeList();
          const node = footnoteDefinition(normalizeLabel(note.label), note.label, []);
          if (!this.footnotes.has(node.identifier)) this.footnotes.set(node.identifier, node);
          this.stack.push({
            type: 'footnoteDefinition', node, contentIndent: FOOTNOTE_INDENT,
          });
          rest = rest.slice(Math.min(note.contentOffset, rest.length));
          continue;
        }
      }

      // Plugin block rules, dispatched on the first non-space char.
      const rules = this.tables.blocks.get(c);
      if (rules !== undefined) {
        const trimmed = rest.slice(indent);
        for (let i = 0; i < rules.length; i++) {
          const node = rules[i].start(trimmed, this.ctx);
          if (node !== null && node !== undefined) {
            this.closeLeaf();
            this.closeList();
            this.leaf = { kind: 'plugin', rule: rules[i], node };
            return;
          }
        }
      }

      // Paragraph text.
      if (para !== null) {
        para.lines.push(rest.slice(indent));
      }
      else {
        this.closeLeaf();
        this.closeList();
        this.leaf = { kind: 'paragraph', lines: [rest.slice(indent)] };
      }
      return;
    }
  }

  /**
   * A blank line was consumed: remember which block it ended, so the
   * enclosing list can decide its own tightness when it closes.
   *
   * The blank belongs to the innermost open block — the last child of
   * the innermost container, the leaf having just been closed into it.
   * Two exclusions carry the spec's meaning: a blockquote absorbs the
   * blank (`* a\n  > b\n  >\n* c` is a TIGHT list), and an item that has
   * nothing in it yet is not "ending with a blank line" — its own
   * opening blank must not make its list loose.
   */
  sawBlank() {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined || top.type === 'blockquote') return;
    const children = top.node.children;
    if (children.length > 0) this.blankEnd.add(children[children.length - 1]);
  }

  /**
   * Does this block end with a blank line? A list or item answers for
   * its last child, which is how a blank at the end of a sublist
   * reaches the item that contains it.
   * @param {MdNode} node
   * @returns {boolean}
   */
  endsWithBlankLine(node) {
    if (this.blankEnd.has(node)) return true;
    if (node.type !== 'list' && node.type !== 'listItem') return false;
    const children = node.children;
    return children.length > 0 && this.endsWithBlankLine(children[children.length - 1]);
  }

  /**
   * Decide a finished list's tightness (§Lists): loose if a non-final
   * item ends with a blank line, or if an item directly contains two
   * block-level children with a blank line between them.
   * @param {MdNode} node
   */
  finalizeList(node) {
    const items = node.children;
    for (let i = 0; i < items.length; i++) {
      if (i < items.length - 1 && this.endsWithBlankLine(items[i])) {
        node.tight = false;
        return;
      }
      const blocks = items[i].children;
      for (let k = 0; k < blocks.length; k++) {
        if ((i < items.length - 1 || k < blocks.length - 1)
          && this.endsWithBlankLine(blocks[k])) {
          node.tight = false;
          return;
        }
      }
    }
    node.tight = true;
  }

  /** Close a directly enclosing list when non-list content arrives. */
  closeList() {
    const top = this.stack[this.stack.length - 1];
    if (top !== undefined && top.type === 'list') {
      this.closeTo(this.stack.length - 1);
    }
  }

  /**
   * Close the open leaf, appending its finished node.
   */
  closeLeaf() {
    const leaf = this.leaf;
    if (leaf === null) return;
    this.leaf = null;
    switch (leaf.kind) {
      case 'paragraph': {
        let raw = leaf.lines.join('\n');
        raw = this.extractDefinitions(raw);
        raw = trimEnd(raw);
        if (raw !== '') this.add({ type: 'paragraph', children: [], raw });
        break;
      }
      case 'fence': {
        const { lang, meta } = splitFenceInfo(leaf.info);
        const value = leaf.lines.length === 0 ? '' : leaf.lines.join('\n') + '\n';
        const plugin = lang !== null ? this.tables.fences.get(lang) : undefined;
        if (plugin !== undefined) {
          this.add({ type: plugin.node, value, meta });
        }
        else {
          this.add(code(lang, meta, value));
        }
        break;
      }
      case 'indented': {
        const lines = leaf.lines;
        while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        this.add(code(null, null, lines.join('\n') + '\n'));
        break;
      }
      case 'html':
        // Only a complete standalone comment has layout semantics;
        // inline comments, code and larger HTML blocks remain opaque.
        this.add(leaf.lines.length === 1 && RE_PAGE_BREAK.test(leaf.lines[0])
          ? pageBreak() : htmlBlock(leaf.lines.join('\n')));
        break;
      case 'table':
        this.add({ type: 'table', align: leaf.align, children: [], raw: leaf.rows });
        break;
      case 'plugin':
        if (leaf.rule.close !== undefined) leaf.rule.close(leaf.node, this.ctx);
        this.add(leaf.node);
        break;
      default:
        break;
    }
  }

  /**
   * Strip leading link reference definitions from a closed paragraph's
   * raw text into the definition map.
   * @param {string} raw
   * @returns {string}
   */
  extractDefinitions(raw) {
    let pos = 0;
    while (pos < raw.length && raw.charCodeAt(pos) === 0x5B /* [ */) {
      const def = scanLinkDefinition(raw, pos);
      if (def === null) break;
      if (!this.defs.has(def.label)) {
        this.defs.set(def.label, { url: def.url, title: def.title });
      }
      pos = Math.min(def.end, raw.length);
      while (pos < raw.length && raw.charCodeAt(pos) === 0x0A) pos++;
    }
    return pos === 0 ? raw : raw.slice(pos);
  }

  /**
   * Close containers down to stack depth `depth` (leaf first).
   * @param {number} depth
   */
  closeTo(depth) {
    this.closeLeaf();
    while (this.stack.length > depth) {
      const entry = /** @type {any} */ (this.stack.pop());
      if (entry.type === 'list') this.finalizeList(entry.node);
      this.add(entry.node);
    }
  }

  /**
   * Append a finished node to the innermost open container (or the
   * document).
   * @param {MdNode} node
   */
  add(node) {
    const stack = this.stack;
    const top = stack[stack.length - 1];
    if (top === undefined) {
      this.blocks.push(node);
      return;
    }
    top.node.children.push(node);
  }

  /** Close everything (end of input). */
  finish() {
    this.closeTo(0);
  }
}

/**
 * Strip leading spaces without a regex (hot path).
 * @param {string} text
 * @returns {string}
 */
function stripIndent(text) {
  const indent = countIndent(text);
  return indent === 0 ? text : text.slice(indent);
}

/**
 * Is the rest of the line, from `from`, blank? Blankness is relative to
 * what a container has already consumed.
 * @param {string} line @param {number} from
 * @returns {boolean}
 */
function isBlankFrom(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09) return false;
  }
  return true;
}

// ------------------------------------------------------------------
// Inline parser
// ------------------------------------------------------------------

/** An inline open or closing tag (the inline raw-HTML forms that begin with a letter or `/`). */
const RE_INLINE_TAG = /^<(?:[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|\/[a-zA-Z][a-zA-Z0-9-]*\s*>)/;

/**
 * A search for the first occurrence of `needle` at or after `from`,
 * remembered per needle. The inline phase asks it from every `<` in turn,
 * always further right, so a search that found nothing — or found an
 * occurrence further on — answers each later question up to that point
 * without scanning again: the scans of one source add up to one pass.
 * @param {string} src
 * @returns {(needle: string, from: number) => number}
 */
function createFinder(src) {
  /** @type {Map<string, [number, number]>} */
  const seen = new Map();
  return (needle, from) => {
    const last = seen.get(needle);
    if (last !== undefined && from >= last[0] && (last[1] === -1 || last[1] >= from)) return last[1];
    const at = src.indexOf(needle, from);
    seen.set(needle, [from, at]);
    return at;
  };
}

/**
 * The end of the inline raw HTML at `pos` (a `<`), or -1. Tags go through
 * {@link RE_INLINE_TAG}; the four forms that run to a terminator — a
 * comment to `-->`, a processing instruction to `?>`, a declaration to
 * `>`, a CDATA section to `]]>` — are matched by finding that terminator,
 * so an unterminated one costs one remembered search instead of a scan to
 * the end of the paragraph from every `<`.
 * @param {string} src @param {number} pos @param {string} rest `src` from `pos`
 * @param {InlineRun} inline the run's state, which keeps the search
 * @returns {number}
 */
function inlineHtmlEnd(src, pos, rest, inline) {
  const next = src.charCodeAt(pos + 1);
  if (next !== 0x21 /* ! */ && next !== 0x3F /* ? */) {
    const m = RE_INLINE_TAG.exec(rest);
    return m === null ? -1 : pos + m[0].length;
  }
  if (inline.find === null) inline.find = createFinder(src);
  const find = inline.find;
  if (next === 0x21) {
    // `<!-->` and `<!--->` are complete comments, so the terminator may
    // overlap the opener
    if (src.startsWith('<!--', pos)) {
      const close = find('-->', pos + 2);
      return close === -1 ? -1 : close + 3;
    }
    if (src.startsWith('<![CDATA[', pos)) {
      const close = find(']]>', pos + 9);
      return close === -1 ? -1 : close + 3;
    }
    const letter = src.charCodeAt(pos + 2) | 0x20;
    if (letter >= 0x61 && letter <= 0x7A) {
      const close = find('>', pos + 3);
      return close === -1 ? -1 : close + 1;
    }
    return -1;
  }
  // a processing instruction ends at the first `>`, and only if a `?` of
  // its own (not the opener's) stands right before it
  const close = find('>', pos + 2);
  return close !== -1 && close - 1 >= pos + 2 && src.charCodeAt(close - 1) === 0x3F ? close + 1 : -1;
}

/** Characters the inline scanner dispatches on; the rest fast-skip. */
const INLINE_SPECIAL = new Uint8Array(128);
for (const ch of '\\`*_~[!]<&\n') INLINE_SPECIAL[ch.charCodeAt(0)] = 1;


/**
 * The inline parsing context threaded through one document.
 * @typedef {{ defs: Map<string, {url: string, title: string|null}>,
 *   footnotes?: Map<string, MdNode>,
 *   inlines: Map<number, any[]>, gfm: boolean, ctx: any,
 *   unresolved?: boolean, deferred?: {node: any, raw: string}[] }} InlineCtx
 */

/**
 * How many inline containers each container node holds at its deepest,
 * counting itself — recorded when the parser builds one, so the nesting
 * bound is checked without walking a subtree. A node with no entry
 * (text, code, raw HTML) holds none.
 * @type {WeakMap<MdNode, number>}
 */
const INLINE_DEPTH = new WeakMap();

/** @param {MdNode} node @returns {number} */
function inlineDepth(node) {
  return INLINE_DEPTH.get(node) ?? 0;
}

/**
 * The state of one inline run that the bracket closer shares:
 * `links` counts the links formed so far — an opener is inactive once one
 * formed after it, because links do not nest — and `find` is the run's
 * remembered terminator search, built on the first raw HTML that needs it.
 * @typedef {{ links: number, find: ((needle: string, from: number) => number) | null }} InlineRun
 */

/**
 * Parse inline Markdown text into inline AST nodes.
 * @param {string} src
 * @param {InlineCtx} ictx
 * @returns {MdNode[]}
 */
export function parseInlines(src, ictx) {
  /** @type {MdNode[]} */
  const nodes = [];
  /** Emphasis delimiter entries: { node, marker, canOpen, canClose }. */
  /** @type {any[]} */
  const delims = [];
  /**
   * Bracket entries: { index, delims, image, links, bracketAfter, start } —
   * `links` is the run's link count when the bracket opened, and
   * `bracketAfter` is set once another bracket opens after it.
   * @type {any[]}
   */
  const brackets = [];
  /** @type {InlineRun} */
  const inline = { links: 0, find: null };
  let pos = 0;
  let textStart = 0;
  const hasPluginInlines = ictx.inlines.size > 0;

  /** @param {number} end */
  const flush = (end) => {
    if (end > textStart) nodes.push(text(src.slice(textStart, end)));
    if (end > textStart) textStart = end;
  };

  while (pos < src.length) {
    const c = src.charCodeAt(pos);

    // Plain text fast path: skip to the next dispatchable character.
    if (c < 128 && INLINE_SPECIAL[c] === 0 && (!hasPluginInlines || !ictx.inlines.has(c))) {
      pos++;
      while (pos < src.length) {
        const d = src.charCodeAt(pos);
        if (d < 128 && INLINE_SPECIAL[d] === 1) break;
        if (hasPluginInlines && ictx.inlines.has(d)) break;
        pos++;
      }
      continue;
    }
    if (c >= 128 && !(hasPluginInlines && ictx.inlines.has(c))) {
      pos++;
      continue;
    }

    // Plugin inline rules first — their char, their call.
    const rules = hasPluginInlines ? ictx.inlines.get(c) : undefined;
    if (rules !== undefined) {
      let claimed = false;
      for (let i = 0; i < rules.length; i++) {
        const hit = rules[i].scan(src, pos, ictx.ctx);
        if (hit !== null && hit !== undefined) {
          flush(pos);
          nodes.push(hit.node);
          pos = hit.end;
          textStart = pos;
          claimed = true;
          break;
        }
      }
      if (claimed) continue;
    }

    switch (c) {
      case 0x5C /* \ */: {
        const next = src.charCodeAt(pos + 1);
        if (next === 0x0A) {
          flush(pos);
          nodes.push(hardBreak());
          pos += 2;
          textStart = pos;
          continue;
        }
        if (next < 128 && ASCII_PUNCT[next] === 1) {
          flush(pos);
          nodes.push(text(src[pos + 1]));
          pos += 2;
          textStart = pos;
          continue;
        }
        pos++;
        continue;
      }
      case 0x60 /* ` */: {
        let run = pos;
        while (run < src.length && src.charCodeAt(run) === 0x60) run++;
        const n = run - pos;
        let close = run;
        let closeEnd = -1;
        while (close < src.length) {
          if (src.charCodeAt(close) === 0x60) {
            let e = close;
            while (e < src.length && src.charCodeAt(e) === 0x60) e++;
            if (e - close === n) { closeEnd = e; break; }
            close = e;
          }
          else close++;
        }
        if (closeEnd === -1) { pos = run; continue; }
        flush(pos);
        let content = src.slice(run, close).replace(/\n/g, ' ');
        if (content.length > 2
          && content.charCodeAt(0) === 0x20
          && content.charCodeAt(content.length - 1) === 0x20
          && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        nodes.push(inlineCode(content));
        pos = closeEnd;
        textStart = pos;
        continue;
      }
      case 0x2A /* * */:
      case 0x5F /* _ */:
      case 0x7E /* ~ */: {
        if (c === 0x7E && !ictx.gfm) { pos++; continue; }
        let run = pos;
        while (run < src.length && src.charCodeAt(run) === c) run++;
        const count = run - pos;
        if (c === 0x7E && count !== 2) { pos = run; continue; }
        const before = pos === 0 ? 0x0A : codePointBefore(src, pos);
        const after = run >= src.length ? 0x0A : /** @type {number} */ (src.codePointAt(run));
        const wsBefore = isUnicodeWhitespace(before);
        const wsAfter = isUnicodeWhitespace(after);
        const punctBefore = isUnicodePunctuation(before);
        const punctAfter = isUnicodePunctuation(after);
        const leftFlank = !wsAfter && (!punctAfter || wsBefore || punctBefore);
        const rightFlank = !wsBefore && (!punctBefore || wsAfter || punctAfter);
        let canOpen = leftFlank;
        let canClose = rightFlank;
        if (c === 0x5F /* _ */) {
          canOpen = leftFlank && (!rightFlank || punctBefore);
          canClose = rightFlank && (!leftFlank || punctAfter);
        }
        flush(pos);
        const node = text(src.slice(pos, run));
        nodes.push(node);
        if (canOpen || canClose) {
          delims.push({ node, marker: c, canOpen, canClose });
        }
        pos = run;
        textStart = pos;
        continue;
      }
      case 0x5B /* [ */: {
        // GFM footnote reference. A defined `[^x]` is a citation; an
        // undefined one is not a bracket to close either, so it falls
        // through and stays literal text.
        if (ictx.gfm && src.charCodeAt(pos + 1) === 0x5E /* ^ */) {
          const ref = scanFootnoteReference(src, pos);
          if (ref !== null) {
            const identifier = normalizeLabel(ref.label);
            if (ictx.footnotes !== undefined && ictx.footnotes.has(identifier)) {
              flush(pos);
              nodes.push(footnoteReference(identifier, ref.label));
              pos = ref.end;
              textStart = pos;
              continue;
            }
            // a definition may still arrive further down a stream
            ictx.unresolved = true;
          }
        }
        flush(pos);
        const node = text('[');
        nodes.push(node);
        openBracket(brackets, { index: nodes.length - 1, delims: delims.length, image: false,
          links: inline.links, bracketAfter: false, start: pos + 1 });
        pos++;
        textStart = pos;
        continue;
      }
      case 0x21 /* ! */: {
        if (src.charCodeAt(pos + 1) === 0x5B) {
          flush(pos);
          nodes.push(text('!['));
          openBracket(brackets, { index: nodes.length - 1, delims: delims.length, image: true,
            links: inline.links, bracketAfter: false, start: pos + 2 });
          pos += 2;
          textStart = pos;
          continue;
        }
        pos++;
        continue;
      }
      case 0x5D /* ] */: {
        const closed = closeBracket(src, pos, nodes, delims, brackets, ictx, flush, inline);
        if (closed !== -1) { pos = closed; textStart = pos; continue; }
        pos++;
        continue;
      }
      case 0x3C /* < */: {
        const rest = pos === 0 ? src : src.slice(pos);
        let m = RE_AUTOLINK_URI.exec(rest);
        if (m !== null) {
          flush(pos);
          nodes.push(depthOne(link(m[1], null, [text(m[1])])));
          pos += m[0].length;
          textStart = pos;
          continue;
        }
        m = RE_AUTOLINK_EMAIL.exec(rest);
        if (m !== null) {
          flush(pos);
          nodes.push(depthOne(link('mailto:' + m[1], null, [text(m[1])])));
          pos += m[0].length;
          textStart = pos;
          continue;
        }
        const end = inlineHtmlEnd(src, pos, rest, inline);
        if (end !== -1) {
          flush(pos);
          nodes.push({ type: 'html', value: src.slice(pos, end) });
          pos = end;
          textStart = pos;
          continue;
        }
        pos++;
        continue;
      }
      case 0x26 /* & */: {
        const entity = scanEntity(src, pos);
        if (entity !== null) {
          flush(pos);
          nodes.push(text(entity.value));
          pos = entity.end;
          textStart = pos;
          continue;
        }
        pos++;
        continue;
      }
      case 0x0A /* \n */: {
        let end = pos;
        while (end > textStart && src.charCodeAt(end - 1) === 0x20) end--;
        const hard = pos - end >= 2;
        flush(end);
        nodes.push(hard ? hardBreak() : softBreak());
        pos++;
        while (pos < src.length && src.charCodeAt(pos) === 0x20) pos++;
        textStart = pos;
        continue;
      }
      default:
        pos++;
        continue;
    }
  }
  flush(src.length);
  resolveEmphasis(nodes, delims, MAX_NESTING);
  const out = mergeText(nodes);
  return ictx.gfm && mayAutolink(src) ? linkifyLiterals(out, 0) : out;
}

/**
 * Push a bracket opener, marking the one below it: a label that holds
 * another bracket can name no definition.
 * @param {any[]} brackets @param {any} entry
 */
function openBracket(brackets, entry) {
  if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
  brackets.push(entry);
}

/**
 * Record a link around plain text as one inline level deep.
 * @param {MdNode} node
 * @returns {MdNode}
 */
function depthOne(node) {
  INLINE_DEPTH.set(node, 1);
  return node;
}

/**
 * Could this leaf hold a literal autolink at all?
 *
 * Every match contains `@`, `www.` or `://`, and a character reference
 * could spell any of them, so a leaf with none of the four cannot
 * produce one — and skipping the pass skips the WALK, which is where its
 * cost turned out to be rather than in the scan. Four vectorized
 * substring searches per leaf replace a recursive visit of every inline
 * node in it.
 * @param {string} src
 * @returns {boolean}
 */
function mayAutolink(src) {
  return src.indexOf('@') !== -1 || src.indexOf('www.') !== -1
    || src.indexOf('://') !== -1 || src.indexOf('&') !== -1;
}

/**
 * Turn bare URLs and email addresses in an inline run into links (GFM
 * §Autolinks).
 *
 * This runs AFTER the inline phase rather than inside its dispatch
 * switch, which is the reference implementation's shape and the right
 * one for three reasons: the trigger characters (`w`, `h`, `f`, `@`) are
 * ordinary letters, and putting them in the hot table would break the
 * plain-text fast path on roughly every tenth character of English
 * prose; an email address begins to the LEFT of its trigger, which a
 * forward scanner cannot see; and the entity rule (`&copy;`) is only
 * meaningful once references have been resolved, because a real entity
 * is no longer spelled `&…;` by the time we look.
 *
 * Link subtrees are skipped — links do not nest — and only `text` nodes
 * are examined, so code spans and raw HTML are untouched by
 * construction. Text already `MAX_NESTING` inline containers deep stays
 * text: a link there would nest one level past the bound.
 * @param {MdNode[]} nodes
 * @param {number} depth how many inline containers hold `nodes`
 * @returns {MdNode[]}
 */
function linkifyLiterals(nodes, depth) {
  /** @type {MdNode[] | null} */
  let out = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === 'text') {
      const hits = depth < MAX_NESTING ? scanAutolinkLiterals(node.value) : null;
      if (hits === null) {
        if (out !== null) out.push(node);
        continue;
      }
      if (out === null) out = nodes.slice(0, i);
      const value = node.value;
      let at = 0;
      for (let k = 0; k < hits.length; k++) {
        const hit = hits[k];
        if (hit.start > at) out.push(text(value.slice(at, hit.start)));
        out.push(autolink(hit.url, value.slice(hit.start, hit.end)));
        at = hit.end;
      }
      if (at < value.length) out.push(text(value.slice(at)));
      continue;
    }
    if (node.type !== 'link' && Array.isArray(node.children)) {
      node.children = linkifyLiterals(node.children, depth + 1);
    }
    if (out !== null) out.push(node);
  }
  return out === null ? nodes : out;
}

/**
 * Try to close the most recent active bracket at `]` (position `pos`).
 * Returns the position after the whole link/image, or -1.
 * @param {string} src
 * @param {number} pos
 * @param {MdNode[]} nodes
 * @param {any[]} delims
 * @param {any[]} brackets
 * @param {InlineCtx} ictx
 * @param {(end: number) => void} flush
 * @param {InlineRun} inline
 * @returns {number}
 */
function closeBracket(src, pos, nodes, delims, brackets, ictx, flush, inline) {
  // Only the MOST RECENT opener may close here. An inactive one — a link
  // opener with a link formed after it, because links do not nest — is
  // discarded and the `]` stays literal: walking outward to an older
  // active opener would let `![[[a](u1)](u2)](u3)` close the image on the
  // wrong bracket.
  const opener = brackets[brackets.length - 1];
  if (opener === undefined) return -1;
  if (!opener.image && opener.links !== inline.links) {
    brackets.pop();
    return -1;
  }

  let url = null;
  let title = null;
  let end = -1;

  if (src.charCodeAt(pos + 1) === 0x28 /* ( */) {
    // Inline form:](dest "title")
    let i = pos + 2;
    while (i < src.length && (isSpaceCode(src.charCodeAt(i)) || src.charCodeAt(i) === 0x0A)) i++;
    const dest = src.charCodeAt(i) === 0x29
      ? { url: '', end: i }
      : scanLinkDestination(src, i);
    if (dest !== null) {
      i = dest.end;
      while (i < src.length && (isSpaceCode(src.charCodeAt(i)) || src.charCodeAt(i) === 0x0A)) i++;
      const t = scanLinkTitle(src, i);
      if (t !== null) {
        i = t.end;
        while (i < src.length && (isSpaceCode(src.charCodeAt(i)) || src.charCodeAt(i) === 0x0A)) i++;
      }
      if (src.charCodeAt(i) === 0x29 /* ) */) {
        url = dest.url;
        title = t !== null ? t.title : null;
        end = i + 1;
      }
    }
  }

  if (end === -1) {
    // Reference forms: ][label], ][] and shortcut ].
    let label = null;
    if (src.charCodeAt(pos + 1) === 0x5B /* [ */) {
      const close = src.indexOf(']', pos + 2);
      if (close !== -1 && close - pos - 2 <= 999) {
        const explicit = src.slice(pos + 2, close);
        label = explicit === '' ? null : explicit;
        if (label !== null || close === pos + 2) {
          end = close + 1;
        }
      }
    }
    // Collapsed / shortcut: the label is the bracketed text, taken from
    // the SOURCE — a definition matches on what the author wrote, so
    // `[foo\!]` and `[foo!]` are different labels even though they render
    // the same. Bracketed text that holds another bracket names no
    // definition (a definition's label cannot hold an unescaped one), so
    // it is not normalized at all: nested brackets would otherwise
    // normalize a label per level, each longer than the last.
    let unnamed = false;
    if (label === null) {
      flush(pos);
      label = src.slice(opener.start, pos);
      unnamed = opener.bracketAfter === true;
      if (end === -1) end = pos + 1;
    }
    const def = unnamed ? undefined : ictx.defs.get(normalizeLabel(label));
    if (def === undefined) {
      // A definition may still arrive: the incremental parser notes the
      // miss so it can re-resolve this block once the stream ends.
      ictx.unresolved = true;
      brackets.pop();
      return -1;
    }
    url = def.url;
    title = def.title;
  }

  flush(pos);
  const children = nodes.splice(opener.index + 1);
  nodes.pop(); // the `[` / `![` marker text node
  // Delimiters inside the label resolve within the children scope, one
  // level short of the bound: the link itself is a level.
  const innerDelims = delims.splice(opener.delims);
  resolveEmphasis(children, innerDelims, MAX_NESTING - 1);
  let node;
  if (opener.image) {
    node = image(/** @type {string} */ (url), title, textOf(children));
  }
  else {
    const content = mergeText(children);
    node = link(/** @type {string} */ (url), title, content);
    let deepest = 0;
    for (let i = 0; i < content.length; i++) deepest = Math.max(deepest, inlineDepth(content[i]));
    INLINE_DEPTH.set(node, deepest + 1);
    // links do not nest: every opener still waiting is now inactive
    inline.links++;
  }
  nodes.push(node);
  brackets.pop();
  return end;
}

/**
 * The closer kinds the opener search keeps a floor for: the marker, and
 * for `*`/`_` whether the closer can also open and its length modulo 3 —
 * exactly the facts the rule of three reads.
 * @param {any} closer
 * @returns {number} 0..12
 */
function closerKind(closer) {
  if (closer.marker === 0x7E) return 12;
  return (closer.marker === 0x5F ? 6 : 0) + (closer.canOpen ? 3 : 0) + closer.node.value.length % 3;
}

/**
 * Resolve emphasis/strong/strikethrough delimiters over a node list
 * (the classic delimiter-stack pairing, `*`/`_` with the rule of
 * three, `~~` for strikethrough) in time linear in the run.
 *
 * Closers are taken in order, each pairing with the nearest opener below
 * it that the rules allow; a closer with characters left is retried, and
 * an opener left over once its closer is spent is retried as a closer.
 * Two structures keep that linear. The run is a doubly linked list while
 * delimiters pair, so wrapping a span relinks two cells instead of
 * splicing — and searching — an array. And the opener search has a floor
 * per closer kind ({@link closerKind}): once a closer of one kind finds no
 * opener, a later closer of that kind does not look below the same point
 * again, so a paragraph of closers that never pair stays linear.
 *
 * A pairing that would nest its wrapper deeper than `limit` inline
 * containers is not made; those delimiters stay literal text.
 * @param {MdNode[]} nodes the run, rewritten in place
 * @param {any[]} delims its delimiters, in node order
 * @param {number} limit the deepest a wrapper may nest
 */
function resolveEmphasis(nodes, delims, limit) {
  if (delims.length === 0) return;
  /**
   * The list, built on the first pairing — a run whose delimiters never
   * pair allocates none of it: cell `i` holds `cell[i]` (wrappers are
   * appended as cells), and `cellOf[d]` is delimiter `d`'s cell.
   * @type {MdNode[] | null}
   */
  let cell = null;
  /** @type {number[]} */
  const prev = [];
  /** @type {number[]} */
  const next = [];
  /** @type {number[]} */
  const cellOf = [];
  let head = -1;
  const build = () => {
    const count = nodes.length;
    cell = nodes.slice();
    for (let i = 0; i < count; i++) {
      prev.push(i - 1);
      next.push(i + 1 < count ? i + 1 : -1);
    }
    head = count > 0 ? 0 : -1;
    // one walk maps every delimiter: both lists are in node order
    for (let d = 0; d < delims.length; d++) cellOf.push(-1);
    for (let i = 0, d = 0; i < count && d < delims.length; i++) {
      if (cell[i] === delims[d].node) cellOf[d++] = i;
    }
  };
  /** @param {number} c */
  const unlink = (c) => {
    const p = prev[c];
    const q = next[c];
    if (p === -1) head = q;
    else next[p] = q;
    if (q !== -1) prev[q] = p;
  };
  /** Per closer kind, the opener-stack height below which none pairs. */
  const floors = new Array(13).fill(0);
  /** Delimiters that may still open, by index, nearest last. */
  const openers = [];
  let following = 0;
  let retry = -1;
  for (;;) {
    let ci;
    if (retry !== -1) {
      ci = retry;
      retry = -1;
    }
    else if (following < delims.length) ci = following++;
    else break;
    const closer = delims[ci];
    const closeLength = closer.node.value.length;
    if (closeLength === 0) continue;
    if (!closer.canClose) {
      if (closer.canOpen) openers.push(ci);
      continue;
    }
    const kind = closerKind(closer);
    let k = openers.length - 1;
    for (; k >= floors[kind]; k--) {
      const opener = delims[openers[k]];
      if (opener.marker !== closer.marker) continue;
      const openLength = opener.node.value.length;
      // the rule of three (only for * and _)
      if (closer.marker !== 0x7E && (opener.canClose || closer.canOpen)
        && (openLength + closeLength) % 3 === 0
        && (openLength % 3 !== 0 || closeLength % 3 !== 0)) continue;
      break;
    }
    /** @type {MdNode[]} */
    const children = [];
    let deepest = 0;
    let paired = k >= floors[kind];
    if (paired) {
      if (cell === null) build();
      const openCell = cellOf[openers[k]];
      const closeCell = cellOf[ci];
      // every delimiter maps to a cell; one that did not could not pair
      paired = openCell !== -1 && closeCell !== -1;
      for (let c = paired ? next[openCell] : closeCell; c !== closeCell; c = next[c]) {
        const child = /** @type {MdNode[]} */ (cell)[c];
        children.push(child);
        deepest = Math.max(deepest, inlineDepth(child));
      }
    }
    if (!paired || deepest + 1 > limit) {
      // no opener for this kind at or above the floor — or only one whose
      // wrapper would nest too deep, and every opener below it would wrap
      // more — so the floor rises to here
      floors[kind] = openers.length;
      if (closer.canOpen) openers.push(ci);
      continue;
    }
    const cells = /** @type {MdNode[]} */ (cell);
    const oi = openers[k];
    const opener = delims[oi];
    const openCell = cellOf[oi];
    const closeCell = cellOf[ci];
    // the opener's length is about to change: no floor stays above it
    for (let f = 0; f < floors.length; f++) {
      if (floors[f] > k) floors[f] = k;
    }
    const use = closer.marker === 0x7E
      ? 2
      : opener.node.value.length >= 2 && closeLength >= 2 ? 2 : 1;
    const merged = mergeText(children);
    const wrapper = closer.marker === 0x7E
      ? strikethrough(merged)
      : use === 2 ? strong(merged) : emphasis(merged);
    INLINE_DEPTH.set(wrapper, deepest + 1);
    opener.node.value = opener.node.value.slice(0, -use);
    closer.node.value = closer.node.value.slice(use);
    // opener · wrapper · closer: the span between is now the wrapper's
    const w = cells.length;
    cells.push(wrapper);
    prev.push(openCell);
    next.push(closeCell);
    next[openCell] = w;
    prev[closeCell] = w;
    // delimiters between the pair can never pair outward
    openers.length = k + 1;
    const openerSpent = opener.node.value.length === 0;
    if (openerSpent) {
      unlink(openCell);
      openers.length = k;
    }
    if (closer.node.value.length > 0) {
      retry = ci;
    }
    else {
      unlink(closeCell);
      if (!openerSpent) {
        // what is left of the opener is tried as a closer in turn
        openers.length = k;
        retry = oi;
      }
    }
  }
  // nothing paired, nothing moved
  if (cell === null) return;
  const cells = /** @type {MdNode[]} */ (cell);
  nodes.length = 0;
  for (let c = head; c !== -1; c = next[c]) nodes.push(cells[c]);
}

/**
 * Merge adjacent text nodes and drop empties (post-emphasis cleanup).
 * @param {MdNode[]} nodes
 * @returns {MdNode[]}
 */
function mergeText(nodes) {
  /** @type {MdNode[]} */
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === 'text') {
      if (node.value === '') continue;
      const prev = out[out.length - 1];
      if (prev !== undefined && prev.type === 'text') {
        prev.value += node.value;
        continue;
      }
    }
    out.push(node);
  }
  return out;
}

// ------------------------------------------------------------------
// Finishing: raw block text → inline children
// ------------------------------------------------------------------

const RE_TASK = /^\[([ xX])\] +/;
const RE_ESCAPED_PIPE = /\\\|/g;

/**
 * Resolve the buffered raw text of finished blocks into inline
 * children (paragraphs, headings, table cells, task-list markers).
 * Runs once per block, after which the `raw` buffers are gone.
 * @param {MdNode[]} blocks
 * @param {InlineCtx} ictx
 */
export function finishBlocks(blocks, ictx) {
  for (let i = 0; i < blocks.length; i++) {
    const node = blocks[i];
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        if (node.raw !== undefined) {
          const raw = node.raw;
          ictx.unresolved = false;
          node.children = parseInlines(raw, ictx);
          delete node.raw;
          if (ictx.unresolved === true && ictx.deferred !== undefined)
            ictx.deferred.push({ node, raw });
        }
        break;
      case 'table':
        if (node.raw !== undefined) {
          finishTable(node, ictx);
        }
        break;
      case 'blockquote':
        finishBlocks(node.children, ictx);
        break;
      case 'list': {
        const items = node.children;
        for (let k = 0; k < items.length; k++) {
          finishListItem(items[k], ictx);
        }
        break;
      }
      default:
        if (Array.isArray(node.children)) finishBlocks(node.children, ictx);
        break;
    }
  }
}

/**
 * @param {MdNode} item
 * @param {InlineCtx} ictx
 */
function finishListItem(item, ictx) {
  const first = item.children[0];
  if (ictx.gfm && first !== undefined && first.type === 'paragraph'
    && first.raw !== undefined) {
    const m = RE_TASK.exec(first.raw);
    if (m !== null) {
      item.checked = m[1] !== ' ';
      first.raw = first.raw.slice(m[0].length);
    }
  }
  finishBlocks(item.children, ictx);
}

/**
 * @param {MdNode} node
 * @param {InlineCtx} ictx
 */
function finishTable(node, ictx) {
  const rawRows = node.raw;
  delete node.raw;
  const width = node.align.length;
  /** @type {MdNode[]} */
  const rows = [];
  for (let r = 0; r < rawRows.length; r++) {
    const cells = splitTableRow(rawRows[r]) ?? [rawRows[r].trim()];
    /** @type {MdNode[]} */
    const rowCells = [];
    for (let ci = 0; ci < width; ci++) {
      // `\|` puts a pipe in a cell "including inside other inline spans"
      // (GFM §Tables), so the escape has to be spent before the inline
      // phase — a code span would otherwise keep the backslash it was
      // never meant to show. Splitting already spent the ones between
      // spans; these are the ones it stepped over.
      const raw = ci < cells.length ? cells[ci].trim().replace(RE_ESCAPED_PIPE, '|') : '';
      rowCells.push(tableCell(raw === '' ? [] : parseInlines(raw, ictx)));
    }
    rows.push(tableRow(rowCells));
  }
  node.children = rows;
}

// ------------------------------------------------------------------
// Entry points
// ------------------------------------------------------------------

/**
 * Parse Markdown source into an MdDocument (frontmatter + AST).
 *
 * @example
 * parseMarkdown('# Hi').ast
 * // [{ type: 'heading', depth: 1, children: [{ type: 'text', value: 'Hi' }] }]
 *
 * @param {string} source
 * @param {MdParseOptions} [options]
 * @returns {MdDocument}
 */
export function parseMarkdown(source, options = {}) {
  const tables = buildPluginTables(options.plugins);
  const fm = options.frontmatter !== false
    ? parseFrontmatter(source, options.toml !== undefined ? { toml: options.toml } : undefined)
    : { data: null, body: source, lang: null };
  const parser = new BlockParser(options, tables);
  parser.ctx.frontmatter = fm.data;
  feedLines(parser, fm.body, true);
  parser.finish();
  const ictx = {
    defs: parser.defs,
    footnotes: parser.footnotes,
    inlines: tables.inlines,
    gfm: parser.gfm,
    ctx: parser.ctx,
  };
  finishBlocks(parser.blocks, ictx);
  return {
    $md: MD_VERSION,
    frontmatter: fm.data,
    ast: parser.blocks,
    meta: {
      sourceUrl: options.sourceUrl ?? null,
      hash: hashContent(source),
      frontmatterLang: fm.lang,
    },
  };
}

/**
 * Feed a text segment to the block parser line by line. When `final`,
 * the trailing partial line (no newline) is processed too; otherwise
 * it is returned to buffer.
 * @param {BlockParser} parser
 * @param {string} textChunk
 * @param {boolean} final
 * @returns {string} the unprocessed tail
 */
function feedLines(parser, textChunk, final) {
  let pos = 0;
  for (;;) {
    const nl = textChunk.indexOf('\n', pos);
    if (nl === -1) break;
    let line = textChunk.slice(pos, nl);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    parser.line(expandTabs(line));
    pos = nl + 1;
  }
  const tail = pos === 0 ? textChunk : textChunk.slice(pos);
  if (final) {
    if (tail !== '') parser.line(expandTabs(tail.endsWith('\r') ? tail.slice(0, -1) : tail));
    return '';
  }
  return tail;
}

/**
 * Drop trailing whitespace. A hand-rolled scan rather than
 * `replace(/\s+$/, '')`: that pattern re-scans the string from every
 * position it can start at, and closing a paragraph is one of the
 * hottest points in the parse.
 * @param {string} text
 * @returns {string}
 */
function trimEnd(text) {
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D
      && code !== 0x0B && code !== 0x0C) break;
    end--;
  }
  return end === text.length ? text : text.slice(0, end);
}

/**
 * The incremental parsing core behind `streamMarkdown` (docs/LOADER.md
 * §4): feed chunks, collect completed top-level blocks per feed, and
 * flush the tail with `end()`.
 *
 * Frontmatter resolves as soon as its closing fence arrives; reference
 * definitions apply to blocks completed after them (the documented
 * streaming limitation).
 *
 * @param {MdParseOptions} [options]
 * @returns {{
 *   feed: (chunk: string) => MdNode[],
 *   end: () => MdDocument,
 *   frontmatter: any,
 * }}
 */
export function createIncrementalParser(options = {}) {
  const tables = buildPluginTables(options.plugins);
  const parser = new BlockParser(options, tables);
  const detect = options.frontmatter !== false;
  /**
   * Blocks emitted with a reference link whose definition had not
   * arrived YET, kept with the source text they came from. A streamed
   * document may define `[ref]` after the paragraph that uses it, and a
   * parser that hands blocks out as they close has already emitted that
   * paragraph — so those blocks are re-resolved at `end()`, when the
   * whole document is known, and land exactly where batch parsing puts
   * them.
   * @type {{node: any, raw: string}[]}
   */
  const deferred = [];
  const ictx = {
    defs: parser.defs,
    footnotes: parser.footnotes,
    inlines: tables.inlines,
    gfm: parser.gfm,
    ctx: parser.ctx,
    unresolved: false,
    deferred,
  };
  let buffer = '';
  let hash = FNV1A_OFFSET_BASIS;
  /** null = undecided, false = none, otherwise resolved */
  /** @type {any} */
  let fmState = detect ? null : false;
  /** @type {any} */
  let frontmatter = null;
  /** @type {'yaml'|'json'|'toml'|null} */
  let frontmatterLang = null;
  let emitted = 0;

  /**
   * Try to resolve frontmatter from the buffered head. Returns true
   * once decided (either way).
   * @param {boolean} final
   */
  const resolveFrontmatter = (final) => {
    if (fmState !== null) return true;
    if (buffer.length === 0) return final;
    const c0 = buffer.charCodeAt(0);
    if (c0 !== 0x2D && c0 !== 0x2B && c0 !== 0x7B) {
      fmState = false;
      return true;
    }
    // A fence only closes frontmatter once its line is complete: `---` at
    // the end of a chunk may still become `----` or `--- text`, which the
    // whole document reads as body. So until the stream ends the head is
    // cut at the last line break, and the partial line waits.
    const head = final ? buffer : buffer.slice(0, buffer.lastIndexOf('\n') + 1);
    const fm = parseFrontmatter(head, options.toml !== undefined ? { toml: options.toml } : undefined);
    if (fm.lang !== null) {
      frontmatter = fm.data;
      frontmatterLang = fm.lang;
      parser.ctx.frontmatter = fm.data;
      api.frontmatter = fm.data;
      buffer = fm.body + buffer.slice(head.length);
      fmState = true;
      return true;
    }
    // No closing fence in the buffer yet: wait for more input unless
    // the stream ended or the head is clearly not frontmatter anymore
    // (backstop against buffering a whole fence-less document).
    if (!final && buffer.length <= 65536) return false;
    fmState = false;
    return true;
  };

  /**
   * Re-parse the blocks that referenced a definition they had not seen.
   * The nodes are patched IN PLACE: a consumer of `feed()` already holds
   * them, and handing back a copy would leave that consumer with the
   * unresolved version forever. Blocks whose reference is still unknown
   * at this point simply keep their literal text, which is what the
   * batch parser produces for them too.
   */
  const resolveDeferred = () => {
    if (deferred.length === 0) return;
    const pending = deferred.splice(0);
    for (const { node, raw } of pending) {
      node.children = parseInlines(raw, ictx);
    }
  };

  /** @returns {MdNode[]} */
  const drain = () => {
    const fresh = parser.blocks.slice(emitted);
    if (fresh.length > 0) {
      finishBlocks(fresh, ictx);
      emitted = parser.blocks.length;
    }
    return fresh;
  };

  const api = {
    frontmatter: /** @type {any} */ (null),

    /**
     * @param {string} chunk
     * @returns {MdNode[]}
     */
    feed(chunk) {
      // fold the chunk into the running hash: seeding fnv1a with the
      // accumulator makes the streamed hash equal the whole-source one
      hash = fnv1a(chunk, hash);
      buffer += chunk;
      if (!resolveFrontmatter(false)) return [];
      buffer = feedLines(parser, buffer, false);
      return drain();
    },

    /** @returns {MdDocument} */
    end() {
      resolveFrontmatter(true);
      feedLines(parser, buffer, true);
      buffer = '';
      parser.finish();
      drain();
      resolveDeferred();
      return {
        $md: MD_VERSION,
        frontmatter,
        ast: parser.blocks,
        meta: {
          sourceUrl: options.sourceUrl ?? null,
          hash: hash.toString(36),
          frontmatterLang,
        },
      };
    },
  };
  return api;
}
