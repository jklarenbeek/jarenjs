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

import { countIndent, isBlankLine, expandTabs, hashContent } from './utils.js';
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
  normalizeLabel,
  isSpaceCode,
} from './scanner.js';
import {
  MD_VERSION,
  thematicBreak, blockquote, list, listItem,
  code, htmlBlock, tableRow, tableCell,
  text, emphasis, strong, strikethrough, link, image, inlineCode,
  hardBreak, softBreak, textOf,
} from './ast.js';

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
  }
  tables = {
    fences, blocks, inlines, renders, hydrates, plugins,
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
    const blank = isBlankLine(line);
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
      else if (entry.type === 'listItem') {
        if (blank) { /* blank lines belong to the item */ }
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

    if (matched < stack.length) {
      const rest = line.slice(offset);
      // Lazy continuation: an open paragraph swallows plain text lines
      // even when container markers are missing.
      if (this.leaf !== null && this.leaf.kind === 'paragraph'
        && !blank && !this.interruptsParagraph(rest)
        && !this.continuesOpenList(rest)) {
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
   * Does `rest` start a new item of an already-open list (any ordinal
   * continues its own list, unlike the paragraph-interruption rule)?
   * @param {string} rest
   * @returns {boolean}
   */
  continuesOpenList(rest) {
    const indent = countIndent(rest);
    if (indent >= 4) return false;
    const marker = scanListMarker(rest, indent);
    if (marker === null || marker.contentOffset >= rest.length) return false;
    const stack = this.stack;
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i];
      if (entry.type === 'list'
        && entry.bullet === marker.bullet
        && entry.delimiter === marker.delimiter) {
        return true;
      }
    }
    return false;
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
      const para = this.leaf !== null && this.leaf.kind === 'paragraph'
        ? this.leaf : null;

      // Setext underline turns the open paragraph into a heading.
      if (para !== null && (c === 0x3D /* = */ || c === 0x2D /* - */)) {
        const depth = scanSetextUnderline(rest, indent);
        if (depth !== 0) {
          const lines = para.lines;
          this.leaf = null;
          const raw = lines.join('\n').trim();
          if (raw !== '') {
            this.add({ type: 'heading', depth, children: [], raw });
            return;
          }
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

      if (c === 0x3E /* > */) {
        this.closeLeaf();
        this.closeList();
        const node = blockquote([]);
        this.stack.push({ type: 'blockquote', node });
        rest = rest.slice(scanBlockquote(rest, indent));
        continue;
      }

      const marker = scanListMarker(rest, indent);
      if (marker !== null
        && !(para !== null && !this.interruptsParagraph(rest))) {
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
            blank: false,
          };
          this.stack.push(entry);
        }
        else if (entry.blank) {
          entry.node.tight = false;
          entry.blank = false;
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

  /** A blank line was consumed: flag open lists for looseness. */
  sawBlank() {
    const stack = this.stack;
    for (let i = 0; i < stack.length; i++) {
      if (stack[i].type === 'list' && stack[i].node.children.length + Number(hasOpenItem(stack, i)) > 0) {
        stack[i].blank = true;
      }
    }
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
        raw = raw.replace(/\s+$/, '');
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
        this.add(htmlBlock(leaf.lines.join('\n')));
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
    if (top.type === 'listItem') {
      const listEntry = stack[stack.length - 2];
      if (top.node.children.length > 0 && listEntry !== undefined
        && listEntry.type === 'list' && listEntry.blank) {
        listEntry.node.tight = false;
        listEntry.blank = false;
      }
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
 * Is the entry at `listIndex` the list containing the currently open
 * item (so an opening blank inside a first, still-empty item does not
 * count for looseness)?
 * @param {any[]} stack
 * @param {number} listIndex
 * @returns {boolean}
 */
function hasOpenItem(stack, listIndex) {
  const item = stack[listIndex + 1];
  return item !== undefined && item.type === 'listItem'
    && item.node.children.length > 0;
}

// ------------------------------------------------------------------
// Inline parser
// ------------------------------------------------------------------

/** Named character references (the pragmatic set; numeric forms cover the rest). */
const ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°',
  plusmn: '±', times: '×', divide: '÷', hellip: '…',
  mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', sect: '§', para: '¶',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
}));

const RE_ENTITY = /^&(?:#[xX][0-9a-fA-F]{1,6};|#[0-9]{1,7};|[a-zA-Z][a-zA-Z0-9]{1,31};)/;
// eslint-disable-next-line no-control-regex -- the spec excludes all control characters
const RE_AUTOLINK_URI = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\x00-\x20]*)>/;
const RE_AUTOLINK_EMAIL = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/;
const RE_INLINE_HTML = /^<(?:[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|\/[a-zA-Z][a-zA-Z0-9-]*\s*>|!--(?:[^-]|-[^-])*-->|\?[^>]*\?>|![A-Za-z][^>]*>|!\[CDATA\[[\s\S]*?\]\]>)/;

/** ASCII punctuation membership for emphasis flanking. */
const PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT[ch.charCodeAt(0)] = 1;

/** Characters the inline scanner dispatches on; the rest fast-skip. */
const INLINE_SPECIAL = new Uint8Array(128);
for (const ch of '\\`*_~[!]<&\n') INLINE_SPECIAL[ch.charCodeAt(0)] = 1;

/**
 * Decode one character reference at `pos` (`&...;`). Returns null when
 * it is not a valid reference.
 * @param {string} src
 * @param {number} pos
 * @returns {{ value: string, end: number } | null}
 */
function scanEntity(src, pos) {
  const m = RE_ENTITY.exec(pos === 0 ? src : src.slice(pos));
  if (m === null) return null;
  const body = m[0].slice(1, -1);
  if (body.charCodeAt(0) === 0x23 /* # */) {
    const cp = body.charCodeAt(1) === 0x78 || body.charCodeAt(1) === 0x58
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10FFFF) {
      return { value: '�', end: pos + m[0].length };
    }
    return { value: String.fromCodePoint(cp), end: pos + m[0].length };
  }
  const named = ENTITIES.get(body);
  return named === undefined ? null : { value: named, end: pos + m[0].length };
}

/**
 * The inline parsing context threaded through one document.
 * @typedef {{ defs: Map<string, {url: string, title: string|null}>,
 *   inlines: Map<number, any[]>, gfm: boolean, ctx: any }} InlineCtx
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
  /** Bracket entries: { index, delimIndex, image, active }. */
  /** @type {any[]} */
  const brackets = [];
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
        if (next < 128 && PUNCT[next] === 1) {
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
        const before = pos === 0 ? 0x0A : src.charCodeAt(pos - 1);
        const after = run >= src.length ? 0x0A : src.charCodeAt(run);
        const wsBefore = before === 0x20 || before === 0x0A || before === 0x09;
        const wsAfter = after === 0x20 || after === 0x0A || after === 0x09;
        const punctBefore = before < 128 && PUNCT[before] === 1;
        const punctAfter = after < 128 && PUNCT[after] === 1;
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
        flush(pos);
        const node = text('[');
        nodes.push(node);
        brackets.push({ index: nodes.length - 1, delims: delims.length, image: false, active: true });
        pos++;
        textStart = pos;
        continue;
      }
      case 0x21 /* ! */: {
        if (src.charCodeAt(pos + 1) === 0x5B) {
          flush(pos);
          nodes.push(text('!['));
          brackets.push({ index: nodes.length - 1, delims: delims.length, image: true, active: true });
          pos += 2;
          textStart = pos;
          continue;
        }
        pos++;
        continue;
      }
      case 0x5D /* ] */: {
        const closed = closeBracket(src, pos, nodes, delims, brackets, ictx, flush);
        if (closed !== -1) { pos = closed; textStart = pos; continue; }
        pos++;
        continue;
      }
      case 0x3C /* < */: {
        const rest = pos === 0 ? src : src.slice(pos);
        let m = RE_AUTOLINK_URI.exec(rest);
        if (m !== null) {
          flush(pos);
          nodes.push(link(m[1], null, [text(m[1])]));
          pos += m[0].length;
          textStart = pos;
          continue;
        }
        m = RE_AUTOLINK_EMAIL.exec(rest);
        if (m !== null) {
          flush(pos);
          nodes.push(link('mailto:' + m[1], null, [text(m[1])]));
          pos += m[0].length;
          textStart = pos;
          continue;
        }
        m = RE_INLINE_HTML.exec(rest);
        if (m !== null) {
          flush(pos);
          nodes.push({ type: 'html', value: m[0] });
          pos += m[0].length;
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
  resolveEmphasis(nodes, delims, 0);
  return mergeText(nodes);
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
 * @returns {number}
 */
function closeBracket(src, pos, nodes, delims, brackets, ictx, flush) {
  let opener = null;
  for (let i = brackets.length - 1; i >= 0; i--) {
    if (brackets[i].active) { opener = brackets[i]; break; }
    brackets.pop();
  }
  if (opener === null) return -1;

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
    if (label === null) {
      // Collapsed / shortcut: label is the bracketed text itself.
      flush(pos);
      label = textOfRange(nodes, opener.index + 1);
      if (end === -1) end = pos + 1;
    }
    const def = ictx.defs.get(normalizeLabel(label));
    if (def === undefined) {
      brackets.pop();
      return -1;
    }
    url = def.url;
    title = def.title;
  }

  flush(pos);
  const children = nodes.splice(opener.index + 1);
  nodes.pop(); // the `[` / `![` marker text node
  // Delimiters inside the label resolve within the children scope.
  const innerDelims = delims.splice(opener.delims);
  resolveEmphasis(children, innerDelims, 0);
  const node = opener.image
    ? image(/** @type {string} */ (url), title, textOf(children))
    : link(/** @type {string} */ (url), title, mergeText(children));
  nodes.push(node);
  brackets.pop();
  if (!opener.image) {
    // Links do not nest: deactivate earlier link openers.
    for (let i = 0; i < brackets.length; i++) {
      if (!brackets[i].image) brackets[i].active = false;
    }
  }
  return end;
}

/**
 * The literal text of `nodes[from..]` (for shortcut reference labels).
 * @param {MdNode[]} nodes
 * @param {number} from
 * @returns {string}
 */
function textOfRange(nodes, from) {
  let out = '';
  for (let i = from; i < nodes.length; i++) out += textOf(nodes[i]);
  return out;
}

/**
 * Resolve emphasis/strong/strikethrough delimiters over a node list
 * (the classic delimiter-stack pairing, `*`/`_` with the rule of
 * three, `~~` for strikethrough).
 * @param {MdNode[]} nodes
 * @param {any[]} delims
 * @param {number} floor
 */
function resolveEmphasis(nodes, delims, floor) {
  let ci = floor;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.canClose || closer.node.value.length === 0) {
      ci++;
      continue;
    }
    let oi = ci - 1;
    while (oi >= floor) {
      const opener = delims[oi];
      if (opener.canOpen && opener.marker === closer.marker
        && opener.node.value.length > 0) {
        // Rule of three (only for * and _).
        if (closer.marker !== 0x7E
          && (opener.canClose || closer.canOpen)
          && (opener.node.value.length + closer.node.value.length) % 3 === 0
          && (opener.node.value.length % 3 !== 0 || closer.node.value.length % 3 !== 0)) {
          oi--;
          continue;
        }
        break;
      }
      oi--;
    }
    if (oi < floor) {
      ci++;
      continue;
    }
    const opener = delims[oi];
    const use = closer.marker === 0x7E
      ? 2
      : opener.node.value.length >= 2 && closer.node.value.length >= 2 ? 2 : 1;
    const openIdx = nodes.indexOf(opener.node);
    const closeIdx = nodes.indexOf(closer.node);
    if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) {
      ci++;
      continue;
    }
    const children = mergeText(nodes.slice(openIdx + 1, closeIdx));
    const wrapper = closer.marker === 0x7E
      ? strikethrough(children)
      : use === 2 ? strong(children) : emphasis(children);
    opener.node.value = opener.node.value.slice(0, -use);
    closer.node.value = closer.node.value.slice(use);
    if (opener.node.value.length === 0) {
      nodes.splice(openIdx, closeIdx - openIdx + 1, wrapper);
    }
    else {
      nodes.splice(openIdx + 1, closeIdx - openIdx, wrapper);
    }
    if (closer.node.value.length > 0) {
      nodes.splice(nodes.indexOf(wrapper) + 1, 0, closer.node);
    }
    // Delimiters strictly between the pair can never match outward;
    // spent delimiters leave the list. The closer (when it still has
    // characters) is retried from its new position.
    delims.splice(oi + 1, ci - oi - 1);
    if (closer.node.value.length === 0) {
      const at = delims.indexOf(closer);
      if (at !== -1) delims.splice(at, 1);
    }
    if (opener.node.value.length === 0) {
      delims.splice(oi, 1);
    }
    const next = delims.indexOf(closer);
    ci = next === -1 ? oi : next;
  }
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
          node.children = parseInlines(node.raw, ictx);
          delete node.raw;
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
      const raw = ci < cells.length ? cells[ci].trim() : '';
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
  const ictx = {
    defs: parser.defs,
    inlines: tables.inlines,
    gfm: parser.gfm,
    ctx: parser.ctx,
  };
  let buffer = '';
  let hash = 0x811c9dc5;
  /** null = undecided, false = none, otherwise resolved */
  /** @type {any} */
  let fmState = detect ? null : false;
  /** @type {any} */
  let frontmatter = null;
  /** @type {'yaml'|'json'|'toml'|null} */
  let frontmatterLang = null;
  let emitted = 0;

  /** @param {string} chunk */
  const hashChunk = (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      hash ^= chunk.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
  };

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
    const fm = parseFrontmatter(buffer, options.toml !== undefined ? { toml: options.toml } : undefined);
    if (fm.lang !== null) {
      frontmatter = fm.data;
      frontmatterLang = fm.lang;
      parser.ctx.frontmatter = fm.data;
      api.frontmatter = fm.data;
      buffer = fm.body;
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
      hashChunk(chunk);
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
