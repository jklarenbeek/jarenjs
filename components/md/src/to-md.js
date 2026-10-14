//@ts-check
/**
 * @file Canonical Markdown printer: AST → text (MD-FORMAT.md §5).
 *
 * The printer is the round-trip half of the package: canonical output
 * re-parses to a deep-equal AST. Canonical choices: ATX headings, `-`
 * bullets, `1.`/`2.` ordered markers renumbered from `start`, backtick
 * fences, `*`/`**` emphasis, inline links, backslash hard breaks and
 * piped tables. Dispatch is one prebuilt table per node class — no
 * per-node type chains.
 */

import { equalsJson } from '@jarenjs/core/object';
import { RE_AUTOLINK_URI, RE_AUTOLINK_EMAIL, scanHtmlBlockStart, scanThematicBreak } from './scanner.js';
import { parseInlines } from './parser.js';

/**
 * @typedef {import('./ast.js').MdNode} MdNode
 */

/** Characters that are backslash-escaped in canonical text output. */
const RE_ESCAPE = /[\\`*_[\]<>~|#&]/g;
/** The same set without the delimiter characters: text whose literal `*` and `_` print as they are. */
const RE_ESCAPE_BARE = /[\\`[\]<>~|#&]/g;
/** A character that can open or close emphasis. */
const RE_DELIMITER = /[*_]/;
/** Line starts that would re-parse as a block construct: a list marker,
 * a blockquote, or a setext underline under the line before it. */
const RE_DANGEROUS_LINE = /^(?:(?:[-+=>]|\d{1,9}[.)])(?: |$)|[-=]{2,}[ \t]*$)/;
/** The ordinal of such a line, when it is an ordered-list marker. */
const RE_LEADING_DIGITS = /^\d{1,9}/;
/** The indent a footnote definition's later blocks are written at. */
const FOOTNOTE_CONTINUATION = '    ';

/**
 * Escape inline text so it re-parses as the same literal text. With
 * `bare` its `*` and `_` characters print unescaped: an unmatched
 * delimiter left in a run is how a source spells some nestings no
 * escaped one can.
 * @param {string} value
 * @param {boolean} [bare]
 * @returns {string}
 */
function escapeText(value, bare = false) {
  const escaped = value.replace(bare ? RE_ESCAPE_BARE : RE_ESCAPE, '\\$&');
  // A newline inside a text VALUE is not a line break — the parser gives
  // those their own `softBreak` node — it came from `&#10;`, and printed
  // literally it would split the paragraph in two. A tab prints as a
  // reference too: bare, it is indentation at a line start and dropped at
  // a line end.
  return escaped.indexOf('\n') === -1 && escaped.indexOf('\t') === -1
    ? escaped
    : escaped.replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

/**
 * Escape a printed paragraph/cell line that would otherwise open a
 * block construct at line start.
 * @param {string} line
 * @returns {string}
 */
function guardLineStart(line) {
  // Leading whitespace cannot be escaped with a backslash, and four
  // spaces (or one tab) of it would re-parse as indented code, so the
  // first whitespace character prints as a character reference — which
  // is how the text came in (`&#9;foo`) and how it goes back out.
  if (line.charCodeAt(0) === 0x09) return '&#9;' + line.slice(1);
  if (line.startsWith('    ')) return '&#32;' + line.slice(1);
  if (!RE_DANGEROUS_LINE.test(line) && !scanThematicBreak(line, 0)) return line;
  // A backslash escapes ASCII PUNCTUATION and nothing else, so an
  // ordered-list line is disarmed at its delimiter (`1\. text`): `\1.`
  // would print a literal backslash, re-parse as one, and print itself
  // again next time — the canonical form would never settle.
  const digits = RE_LEADING_DIGITS.exec(line);
  return digits === null
    ? '\\' + line
    : digits[0] + '\\' + line.slice(digits[0].length);
}

// ------------------------------------------------------------------
// Inline printing
// ------------------------------------------------------------------

/**
 * How emphasis and strong choose their delimiter. Style 0 is the
 * canonical spelling (`*`, `**`); the others alternate with `_`/`__`
 * by nesting depth and by position in a run of adjacent siblings, for
 * the shapes the canonical spelling merges into one delimiter run; the
 * last resort (style 4) takes each delimiter node's spelling from
 * `assign` (`true` is the underscore), and whether each text node
 * holding a `*` or `_` prints it bare, one entry per node a search
 * decides.
 * @typedef {{ style: number, depth: number, assign: Map<MdNode, boolean> | null }} PrintContext
 */

/** The alternating spellings tried, in order, when the canonical one does not read back. */
const EMPHASIS_STYLES = 4;

/**
 * How far the search of every combination of spellings goes in a short
 * run. The sites it decides are the delimiter nodes and then the text nodes
 * that hold a literal `*` or `_`; the first `MASK_BITS` of them take every
 * combination (2^MASK_BITS candidates, each a parse), as long as the run has
 * at most `MASK_NODES` delimiter nodes and prints in at most `MASK_LENGTH`
 * characters.
 */
const MASK_NODES = 4;
const MASK_BITS = 6;
const MASK_LENGTH = 600;

/**
 * What the search for a spelling may cost, as characters of candidate text
 * parsed. One call to `toMarkdown` has one pool of them: a few thousand to
 * start with, and for every run it prints this many more per printed
 * character. A run that needs no search leaves its share to the runs that
 * do; one that no spelling reads back as spends what there is and prints as
 * it always printed, so the whole call costs a small multiple of what
 * printing without the search costs.
 */
const SEARCH_CHARS_PER_CHAR = 64;
const SEARCH_CHARS_FLOOR = 4000;
/** What is left of the call's pool. */
const searchPool = { left: 0 };

/** @type {PrintContext} */
const CANONICAL = { style: 0, depth: 0, assign: null };

/**
 * Does this node spell with a delimiter run (`*`/`_`)?
 * @param {MdNode} node
 * @returns {boolean}
 */
function isEmphasisClass(node) {
  return node.type === 'emphasis' || node.type === 'strong';
}

/**
 * Use the underscore spelling for this node?
 * @param {MdNode} node
 * @param {PrintContext} pc
 * @param {number} run emphasis-class siblings directly before the node
 * @returns {boolean}
 */
function underscoreFor(node, pc, run) {
  if (pc.style === 4) return /** @type {Map<MdNode, boolean>} */ (pc.assign).get(node) === true;
  const parity = (pc.depth + run) & 1;
  return pc.style === 1 ? parity === 1
    : pc.style === 2 ? parity === 0
      : pc.style === 3;
}

/**
 * Does this text node print its `*` and `_` characters bare? The
 * last-resort search decides it, one bit per text node that holds one.
 * @param {MdNode} node
 * @param {PrintContext} pc
 * @returns {boolean}
 */
function printsBare(node, pc) {
  return pc.style === 4 && RE_DELIMITER.test(node.value)
    && /** @type {Map<MdNode, boolean>} */ (pc.assign).get(node) === true;
}

/**
 * Print a list of inline nodes.
 * @param {MdNode[]} nodes
 * @param {PrintContext} pc
 * @param {MdNode} [after] the sibling that follows the last node, when the list is a stretch of a longer one
 * @returns {string}
 */
function printInlines(nodes, pc, after) {
  let out = '';
  let run = 0;
  for (let i = 0; i < nodes.length; i++) {
    const printed = printInline(nodes[i], pc, run);
    run = isEmphasisClass(nodes[i]) ? run + 1 : 0;
    // A trailing `!` in front of a link is what makes an image, so text
    // that genuinely ends in one keeps its escape (`\\![foo]`).
    const next = i + 1 < nodes.length ? nodes[i + 1] : after;
    out += printed.endsWith('!') && next !== undefined && next.type === 'link'
      ? printed.slice(0, -1) + '\\!'
      : printed;
  }
  return out;
}

/**
 * The context inside an emphasis or strong node.
 * @param {PrintContext} pc
 * @returns {PrintContext}
 */
function deeper(pc) {
  return { style: pc.style, depth: pc.depth + 1, assign: pc.assign };
}

/** @type {Record<string, (node: MdNode, pc: PrintContext, run: number) => string>} */
const INLINE_PRINTERS = {
  text: (node, pc) => escapeText(node.value, printsBare(node, pc)),
  emphasis: (node, pc, run) => {
    if (pc.style !== 0) {
      const mark = underscoreFor(node, pc, run) ? '_' : '*';
      return mark + printInlines(node.children, deeper(pc)) + mark;
    }
    const inner = printInlines(node.children, deeper(pc));
    // `*x*` directly inside `*…*` runs the two markers together into
    // `**` — strong — so emphasis nested in emphasis alternates to `_`.
    // Emphasis around STRONG does not: `***x***` is unambiguous, and
    // `_` would be worse, since it does not open inside a word.
    const first = node.children[0];
    const last = node.children[node.children.length - 1];
    const alternate = (first !== undefined && first.type === 'emphasis')
      || (last !== undefined && last.type === 'emphasis');
    return alternate ? '_' + inner + '_' : '*' + inner + '*';
  },
  strong: (node, pc, run) => {
    if (pc.style !== 0) {
      const mark = underscoreFor(node, pc, run) ? '__' : '**';
      return mark + printInlines(node.children, deeper(pc)) + mark;
    }
    // `***x***` reads back as emphasis around strong, so strong around
    // an emphasis that is all of its content spells the emphasis `_`.
    const only = node.children.length === 1 && node.children[0].type === 'emphasis';
    return only
      ? '**_' + printInlines(node.children[0].children, deeper(deeper(pc))) + '_**'
      : '**' + printInlines(node.children, deeper(pc)) + '**';
  },
  strikethrough: (node, pc) => '~~' + printInlines(node.children, pc) + '~~',
  inlineCode: (node) => printCodeSpan(node.value),
  // A GFM literal autolink prints as the bare text it was written as
  // (escaped, so `*` in a query string cannot open emphasis on the way
  // back in) — the one place the `auto` flag earns its keep.
  link: (node, pc) => (node.auto === true
    ? printInlines(node.children, pc)
    : isAutolink(node)
      ? '<' + node.url.replace(/^mailto:/, '') + '>'
      : '[' + printInlines(node.children, pc) + '](' + printLinkTarget(node) + ')'),
  image: (node) => '![' + escapeText(node.alt) + '](' + printLinkTarget(node) + ')',
  break: () => '\\\n',
  softBreak: () => '\n',
  html: (node) => node.value,
  footnoteReference: (node) => '[^' + (node.label ?? node.identifier) + ']',
};

/**
 * Print one inline node (unknown types degrade to their text content).
 * @param {MdNode} node
 * @param {PrintContext} pc
 * @param {number} run
 * @returns {string}
 */
function printInline(node, pc, run) {
  const printer = INLINE_PRINTERS[node.type];
  if (printer !== undefined) return printer(node, pc, run);
  if (Array.isArray(node.children)) return printInlines(node.children, pc);
  return typeof node.value === 'string' ? escapeText(node.value) : '';
}

/**
 * Can a delimiter run of this content merge with another? True when an
 * emphasis or strong node holds another one, or two sit side by side.
 * @param {MdNode[]} nodes
 * @param {boolean} [inside] under an emphasis or strong node already
 * @returns {boolean}
 */
function mayMergeDelimiters(nodes, inside = false) {
  let previous = false;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const emphasis = isEmphasisClass(node);
    if (emphasis && (inside || previous)) return true;
    previous = emphasis;
    if (Array.isArray(node.children) && mayMergeDelimiters(node.children, inside || emphasis)) {
      return true;
    }
  }
  return false;
}

/**
 * The nodes a search spells one by one, in the order they print: first
 * the emphasis and strong nodes, then the text nodes that hold a literal
 * `*` or `_`.
 * @typedef {{ delims: MdNode[], texts: MdNode[] }} SpellingSites
 */

/**
 * Collect the nodes a search decides, at any depth.
 * @param {MdNode[]} nodes
 * @param {SpellingSites} [sites]
 * @returns {SpellingSites}
 */
function collectSites(nodes, sites = { delims: [], texts: [] }) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (isEmphasisClass(node)) sites.delims.push(node);
    else if (node.type === 'text' && RE_DELIMITER.test(node.value)) sites.texts.push(node);
    if (Array.isArray(node.children)) collectSites(node.children, sites);
  }
  return sites;
}

/** Inline parse state for the read-back check: no definitions, no plugins. */
const READ_BACK = { defs: new Map(), inlines: new Map(), gfm: true, ctx: {} };

/**
 * Parse printed text the way the read-back check does.
 * @param {string} text
 * @returns {MdNode[]}
 */
function readBack(text) {
  return parseInlines(text, { ...READ_BACK, defs: new Map() });
}

/**
 * Does this text read back as exactly these inline nodes?
 * @param {string} text
 * @param {MdNode[]} nodes
 * @returns {boolean}
 */
function readsAs(text, nodes) {
  return equalsJson(readBack(text), nodes);
}

/**
 * A stretch of a block's content to be spelled on its own: `nodes` are
 * printed, `before` and `after` are the characters of the neighbours the
 * parser needs to see beside the first and the last run (it judges a run by
 * the characters on both sides), and `want` is what the whole of it reads
 * back as, those characters included. `next` is the node that follows the
 * stretch in the block, if any; `lineStart` says the stretch starts a line
 * of the printed block; `spend` says reading it back is paid from the pool.
 * @typedef {{ nodes: MdNode[], want: MdNode[], before: string, after: string, next: MdNode | undefined, lineStart: boolean, spend: boolean }} Stretch
 */

/**
 * A stretch that is a block's whole content.
 * @param {MdNode[]} nodes
 * @returns {Stretch}
 */
function wholeStretch(nodes) {
  return { nodes, want: nodes, before: '', after: '', next: undefined, lineStart: true, spend: false };
}

/** A line the block parser would take for a list item or a rule: a bare `*` and a space, or a rule of `*` or `_`. */
const RE_BARE_ITEM = /^\*(?: |$)/;

/**
 * Does printing this text put a bare delimiter where a line opens a block?
 * Only the inline text is read back, but a line that starts `* ` or is a
 * rule of `*` or `_` would be a list or a rule, and escaping it would
 * change the delimiter into a letter.
 * @param {string} text
 * @param {boolean} lineStart the text starts a line
 * @returns {boolean}
 */
function startsBlock(text, lineStart) {
  if (text.indexOf('*') === -1 && text.indexOf('_') === -1) return false;
  const lines = text.split('\n');
  for (let i = lineStart ? 0 : 1; i < lines.length; i++) {
    const line = lines[i];
    if (RE_DELIMITER.test(line.charAt(0)) && (RE_BARE_ITEM.test(line) || scanThematicBreak(line, 0))) return true;
  }
  return false;
}

/**
 * Does the stretch read back, printed as this text? Reading it back is paid
 * from the pool when the stretch is spent from it.
 * @param {Stretch} stretch
 * @param {string} body what the stretch's nodes print as
 * @returns {boolean}
 */
function readsBody(stretch, body) {
  const text = stretch.before + body + stretch.after;
  if (stretch.spend) searchPool.left -= text.length;
  return readsAs(text, stretch.want) && !startsBlock(body, stretch.lineStart);
}

/**
 * What the stretch prints as in a spelling, when that reads back.
 * @param {Stretch} stretch
 * @param {PrintContext} pc
 * @returns {string | null}
 */
function spellStretch(stretch, pc) {
  const body = printInlines(stretch.nodes, pc, stretch.next);
  return readsBody(stretch, body) ? body : null;
}

/**
 * What the stretch prints as in the first alternating spelling in which it
 * reads back.
 * @param {Stretch} stretch
 * @returns {string | null}
 */
function alternatingSpelling(stretch) {
  for (let style = 1; style < EMPHASIS_STYLES; style++) {
    const body = spellStretch(stretch, { style, depth: 0, assign: null });
    if (body !== null) return body;
  }
  return null;
}

/**
 * What the stretch prints as with each site spelled by a mask, when it reads
 * back: bit `k` of the mask is site `k` underscored (or left bare), every
 * other site is not. The first mask in which the stretch reads back is the
 * one; none for a stretch with more delimiter nodes, characters or sites
 * than `MASK_NODES`, `MASK_LENGTH` and `MASK_BITS` allow.
 * @param {Stretch} stretch
 * @param {number} length the canonical spelling's length
 * @returns {string | null}
 */
function maskedSpelling(stretch, length) {
  const { delims, texts } = collectSites(stretch.nodes);
  if (delims.length > MASK_NODES || length > MASK_LENGTH) return null;
  const sites = delims.concat(texts);
  const bits = Math.min(sites.length, MASK_BITS);
  for (let mask = 0; mask < 1 << bits; mask++) {
    const assign = new Map();
    for (let k = 0; k < bits; k++) assign.set(sites[k], ((mask >> k) & 1) === 1);
    const body = spellStretch(stretch, { style: EMPHASIS_STYLES, depth: 0, assign });
    if (body !== null) return body;
  }
  return null;
}

/**
 * What the stretch prints as with a few of its sites spelled the other way,
 * when it reads back: one site, then every two, and so on, until it does or
 * the pool is spent. Few sites need it: the spelling that reads back is
 * nearly always the canonical one with a handful of nodes or texts changed.
 * @param {Stretch} stretch
 * @returns {string | null}
 */
function sparseSpelling(stretch) {
  const { delims, texts } = collectSites(stretch.nodes);
  const sites = delims.concat(texts);
  const assign = new Map(sites.map((site) => [site, false]));
  const pc = { style: EMPHASIS_STYLES, depth: 0, assign };
  /**
   * Set `count` more sites from `first` on, and try the result.
   * @param {number} first
   * @param {number} count
   * @returns {string | null}
   */
  const choose = (first, count) => {
    if (count === 0) return spellStretch(stretch, pc);
    for (let k = first; k <= sites.length - count && searchPool.left > 0; k++) {
      assign.set(sites[k], true);
      const body = choose(k + 1, count - 1);
      if (body !== null) return body;
      assign.set(sites[k], false);
    }
    return null;
  };
  for (let count = 1; count <= sites.length && searchPool.left > 0; count++) {
    const body = choose(0, count);
    if (body !== null) return body;
  }
  return null;
}

/** A character a delimiter run can be made of: emphasis's `*` and `_`, strikethrough's `~`. */
const RE_EDGE_DELIMITER = /[*_~]/;
/** Inline nodes whose spelling begins and ends with a character no delimiter run is made of, and the characters: a link (`[…](…)`), an image (`![…](…)`), a code span, a hard break, a soft break, a reference (`[^…]`). */
const OPAQUE_INLINES = new Map([
  ['link', ['[', ')']], ['image', ['!', ')']], ['inlineCode', ['`', '`']],
  ['break', ['\\', '\n']], ['softBreak', ['\n', '\n']], ['footnoteReference', ['[', ']']],
]);

/**
 * The character at the start or end of a text, a whole code point.
 * @param {string} text
 * @param {boolean} end the last character, not the first
 * @returns {string}
 */
function edgeChar(text, end) {
  if (!end) return String.fromCodePoint(text.codePointAt(0) ?? 0x20);
  const low = text.charCodeAt(text.length - 1);
  return low >= 0xDC00 && low <= 0xDFFF && text.length > 1
    ? text.slice(-2)
    : text.charAt(text.length - 1);
}

/**
 * The character a node prints at its start or end, when that is not a
 * character a delimiter run is made of; null when it is, or when it is not
 * known without printing the node. A text that starts or ends with a `*`
 * or `_` may print it bare, so it has no such character; a link printed as
 * the text it was written as has the edges of that text.
 * @param {MdNode} node
 * @param {boolean} end the last character, not the first
 * @returns {string | null}
 */
function plainEdge(node, end) {
  if (node.type === 'text') {
    return RE_EDGE_DELIMITER.test(edgeChar(node.value, end)) ? null : edgeChar(escapeText(node.value), end);
  }
  const edges = node.auto === true ? undefined : OPAQUE_INLINES.get(node.type);
  return edges === undefined ? null : edges[end ? 1 : 0];
}

const RE_SPACE = /^\s$/u;
const RE_PUNCTUATION = /^[\p{P}\p{S}]$/u;

/**
 * A character of the same kind as this one, as far as a delimiter run
 * beside it can tell: a space, a punctuation mark or a letter.
 * @param {string} char
 * @returns {string}
 */
function sameKind(char) {
  return RE_SPACE.test(char) ? ' ' : RE_PUNCTUATION.test(char) ? '.' : 'x';
}

/**
 * The stretch of a block's content from one node up to another: what it
 * prints, and, where a delimiter run at its edge has a neighbour that is
 * not in it, a character of the kind that neighbour prints beside the run.
 * @param {MdNode[]} nodes the block's content
 * @param {number} start
 * @param {number} end
 * @returns {Stretch}
 */
function stretchOf(nodes, start, end) {
  const own = nodes.slice(start, end);
  const left = start > 0 ? plainEdge(nodes[start - 1], true) : null;
  const right = end < nodes.length ? plainEdge(nodes[end], false) : null;
  const before = left !== null && plainEdge(own[0], false) === null ? sameKind(left) : '';
  const after = right !== null && plainEdge(own[own.length - 1], true) === null ? sameKind(right) : '';
  const want = own.slice();
  if (before !== '') {
    const first = want[0];
    if (first.type === 'text') want[0] = { ...first, value: before + first.value };
    else want.unshift({ type: 'text', value: before });
  }
  if (after !== '') {
    const last = want[want.length - 1];
    if (last.type === 'text') want[want.length - 1] = { ...last, value: last.value + after };
    else want.push({ type: 'text', value: after });
  }
  const lineStart = start === 0 || plainEdge(nodes[start - 1], true) === '\n';
  return { nodes: own, want, before, after, next: nodes[end], lineStart, spend: true };
}

/**
 * Spell a block's content a stretch at a time. The content splits wherever
 * the join of two neighbours does not have a delimiter character on both
 * sides, since a delimiter run reaches across a join only through such
 * characters, and each stretch is searched on its own with the kind of
 * character its neighbours print beside it: the cost of finding the
 * spellings grows with the longest stretch rather than with the block. The
 * result is checked as a whole; when a run reaches across a join after all,
 * neighbouring stretches are joined two by two and searched again, until the
 * text reads back or the whole block is one stretch. Null when it does not
 * read back, or when the pool of the search is spent first.
 * @param {MdNode[]} nodes
 * @returns {string | null}
 */
function printSegments(nodes) {
  /** @type {number[]} where each stretch ends */
  let ends = [];
  for (let i = 1; i < nodes.length; i++) {
    if (plainEdge(nodes[i - 1], true) !== null || plainEdge(nodes[i], false) !== null) ends.push(i);
  }
  ends.push(nodes.length);
  /** @type {Map<number, string>} */
  const spelled = new Map();
  for (;;) {
    let text = '';
    for (let k = 0, start = 0; k < ends.length; start = ends[k++]) {
      if (searchPool.left <= 0) return null;
      const key = start * (nodes.length + 1) + ends[k];
      let part = spelled.get(key);
      if (part === undefined) {
        const stretch = stretchOf(nodes, start, ends[k]);
        part = printInlines(stretch.nodes, CANONICAL, stretch.next);
        if (!readsBody(stretch, part)) {
          part = alternatingSpelling(stretch) ?? sparseSpelling(stretch) ?? part;
        }
        spelled.set(key, part);
      }
      text += part;
    }
    searchPool.left -= text.length;
    if (readsAs(text, nodes)) return text;
    if (ends.length === 1) return null;
    ends = ends.filter((end, k) => k % 2 === 1 || k === ends.length - 1);
  }
}

/**
 * Print the inline content of one block. A run of delimiters the
 * canonical spelling would merge (emphasis in emphasis, emphasis beside
 * strong) is checked against the parser, and the first spelling that
 * reads back as the same nodes is the one printed: the alternating ones,
 * then every combination for a short run, then a search a stretch at a
 * time, which has no bound on the length of the run.
 * @param {MdNode[]} nodes
 * @returns {string}
 */
function printRun(nodes) {
  const canonical = printInlines(nodes, CANONICAL);
  searchPool.left += SEARCH_CHARS_PER_CHAR * canonical.length;
  if (!mayMergeDelimiters(nodes) || readsAs(canonical, nodes)) return canonical;
  const whole = wholeStretch(nodes);
  return alternatingSpelling(whole) ?? maskedSpelling(whole, canonical.length) ?? printSegments(nodes) ?? canonical;
}

/**
 * Is this link one an autolink produced — its text IS its destination?
 * Printing such a link as `[text](url)` would escape the text but not
 * the destination, and the two spellings drift apart on the next
 * round trip; `<url>` is both shorter and stable.
 * @param {MdNode} node
 * @returns {boolean}
 */
function isAutolink(node) {
  if (node.title != null || node.children.length !== 1) return false;
  const only = node.children[0];
  if (only.type !== 'text') return false;
  const url = /** @type {string} */ (node.url);
  // `<…>` is an autolink only for an absolute URI (`scheme:…`) or an email
  // address; any other text between angle brackets (`<docs/a.md>`) parses
  // as text or raw HTML, so a relative link keeps its `[text](url)` form.
  if (url.startsWith('mailto:')) {
    const address = url.slice(7);
    return only.value === address && RE_AUTOLINK_EMAIL.exec('<' + address + '>')?.[1] === address;
  }
  return only.value === url && RE_AUTOLINK_URI.exec('<' + url + '>')?.[1] === url;
}

/**
 * Wrap a code span in a backtick run longer than any run inside it.
 * @param {string} value
 * @returns {string}
 */
function printCodeSpan(value) {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < value.length; i++) {
    run = value.charCodeAt(i) === 0x60 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const fence = '`'.repeat(longest + 1);
  const pad = value.length === 0
    || value.charCodeAt(0) === 0x60
    || value.charCodeAt(value.length - 1) === 0x60
    || (value.charCodeAt(0) === 0x20 && value.charCodeAt(value.length - 1) === 0x20
      && value.trim() !== '')
    ? ' ' : '';
  return fence + pad + value + pad + fence;
}

/** What a destination, a title or an info string reader decodes: a backslash before punctuation (or the end), a character reference, a tab, a newline. */
const RE_TARGET_ESCAPE = /\\(?=[!-/:-@[-`{-~\t\n]|$)|&(?=[#A-Za-z][#A-Za-z0-9]*;)|[\t\n]/g;
/** What ends an unwrapped destination early: whitespace, a control character, a parenthesis. */
// eslint-disable-next-line no-control-regex -- the control range is the point
const RE_BARE_BREAKER = /[\x00-\x20\x7f()]/;

/**
 * Escape a link destination, a link title or a fence info string so it reads back as the same text.
 * @param {string} value
 * @returns {string}
 */
function escapeTarget(value) {
  return value.replace(RE_TARGET_ESCAPE, (m) => (m === '\t' ? '&#9;' : m === '\n' ? '&#10;' : '\\' + m));
}

/**
 * Print a link/image destination (+ optional title).
 * @param {MdNode} node
 * @returns {string}
 */
function printLinkTarget(node) {
  const url = escapeTarget(/** @type {string} */ (node.url));
  const wrapped = url === '' || url.charCodeAt(0) === 0x3C || RE_BARE_BREAKER.test(url)
    ? '<' + url.replace(/[<>]/g, '\\$&') + '>'
    : url;
  return node.title == null
    ? wrapped
    : wrapped + ' "' + escapeTarget(node.title).replace(/"/g, '\\"') + '"';
}

// ------------------------------------------------------------------
// Block printing
// ------------------------------------------------------------------

/**
 * Print inline content and guard every printed line's start.
 * @param {MdNode[]} children
 * @returns {string}
 */
function printFlow(children) {
  const out = printRun(children);
  if (out.indexOf('\n') === -1) return guardLineStart(out);
  const lines = out.split('\n');
  lines[0] = guardLineStart(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    // Raw HTML that opens a block (a comment, a `<div>`) would cut the
    // paragraph short at a line start. Four spaces of indent keep it
    // paragraph text, and the parser drops them from a continuation line.
    const line = guardLineStart(lines[i]);
    lines[i] = scanHtmlBlockStart(line, 0, true) === 0 ? line : '    ' + line;
  }
  return lines.join('\n');
}

/**
 * A link reference definition that defines nothing a document can use.
 * A paragraph whose first line is raw HTML opening a block reads back as
 * that block; the one way to keep it a paragraph is to have it continue
 * a paragraph already open, which is how a definition's lines come to
 * hold it in the source. The definition leaves the AST when it is read.
 */
const FILLER_DEFINITION = '[-]: <>';

/**
 * Print a paragraph; one that opens with raw HTML a block would start
 * on continues a filler definition instead.
 * @param {MdNode[]} children
 * @returns {string}
 */
function printParagraph(children) {
  const text = printFlow(children);
  const lines = text.split('\n');
  if (scanHtmlBlockStart(lines[0], 0, false) === 0) return text;
  if (scanHtmlBlockStart(lines[0], 0, true) !== 0) lines[0] = '    ' + lines[0];
  return FILLER_DEFINITION + '\n' + lines.join('\n');
}

/** @type {Record<string, (node: MdNode, alt?: boolean, spare?: boolean) => string>} */
const BLOCK_PRINTERS = {
  paragraph: (node) => printParagraph(node.children),

  heading: (node) => {
    const text = printRun(node.children);
    // An ATX heading is one line, so a heading whose text carries a soft
    // break has to print in its setext form or lose the break — which
    // only depths 1 and 2 have. Deeper headings cannot hold one: they
    // can only come from ATX in the first place.
    if (node.depth <= 2 && text.indexOf('\n') !== -1) {
      return printParagraph(node.children) + '\n' + (node.depth === 1 ? '===' : '---');
    }
    return '#'.repeat(node.depth) + ' ' + text;
  },

  // `***`, not `---`: the printer's bullet is `-`, and `- ---` is a
  // thematic break in its own right rather than an item containing one.
  thematicBreak: (node, alt, spare) => (spare === true ? '___' : '***'),
  pageBreak: () => '<!-- pagebreak -->',

  blockquote: (node) => {
    const inner = printBlocks(node.children, false);
    const lines = inner.split('\n');
    for (let i = 0; i < lines.length; i++) {
      lines[i] = lines[i] === '' ? '>' : '> ' + lines[i];
    }
    return lines.join('\n');
  },

  list: (node, alt) => {
    const items = node.children;
    const parts = [];
    let ordinal = node.ordered ? (node.start ?? 1) : 0;
    for (let i = 0; i < items.length; i++) {
      // Two lists in a row are two lists only because their markers
      // differ: printed with the same marker they re-parse as one. The
      // second of an adjacent pair therefore switches (`-`→`*`, `.`→`)`).
      const marker = node.ordered
        ? `${ordinal + i}${alt === true ? ')' : '.'} `
        : (alt === true ? '* ' : '- ');
      const indent = ' '.repeat(marker.length);
      const check = items[i].checked === null || items[i].checked === undefined
        ? ''
        : items[i].checked ? '[x] ' : '[ ] ';
      let body = printBlocks(items[i].children, node.tight);
      let lines = body.split('\n');
      // An item that opens with nothing but markers (`- - -`, or a rule
      // after a `*`) is a thematic break, not an item: its first block
      // takes the other spelling.
      if (scanThematicBreak(marker + check + lines[0], 0)) {
        body = printBlocks(items[i].children, node.tight, true);
        lines = body.split('\n');
      }
      // An HTML block's own leading spaces would be read as the space
      // after the marker, so the block starts on the line below it.
      const first = check === '' && /^[ \t]/.test(lines[0]);
      let item = first ? marker.trimEnd() + '\n' + indent + lines[0] : marker + check + lines[0];
      for (let k = 1; k < lines.length; k++) {
        item += '\n' + (lines[k] === '' ? '' : indent + lines[k]);
      }
      parts.push(item);
    }
    return parts.join(node.tight ? '\n' : '\n\n');
  },

  code: (node) => printFence(node.lang, node.meta, node.value),

  html: (node) => node.value,

  // A definition prints where it stands — the AST is the document, not
  // the rendering, so moving them all to the end would change the
  // document to match one renderer's idea of it.
  footnoteDefinition: (node) => {
    const body = printBlocks(node.children, false);
    const lines = body.split('\n');
    // leading spaces on the first line would be read as the space after
    // the label, so that line starts the block below it
    let out = '[^' + (node.label ?? node.identifier) + ']:'
      + (/^[ \t]/.test(lines[0]) ? '\n' + FOOTNOTE_CONTINUATION : ' ') + lines[0];
    for (let k = 1; k < lines.length; k++) {
      out += '\n' + (lines[k] === '' ? '' : FOOTNOTE_CONTINUATION + lines[k]);
    }
    return out;
  },

  table: (node) => {
    const rows = node.children;
    const out = [];
    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r].children;
      let line = '|';
      for (let c = 0; c < cells.length; c++) {
        line += ' ' + printRun(cells[c].children).replace(/\n/g, ' ') + ' |';
      }
      out.push(line);
      if (r === 0) {
        let delim = '|';
        for (let c = 0; c < node.align.length; c++) {
          const a = node.align[c];
          delim += a === 'center' ? ' :---: |'
            : a === 'right' ? ' ---: |'
              : a === 'left' ? ' :--- |'
                : ' --- |';
        }
        out.push(delim);
      }
    }
    return out.join('\n');
  },

  custom: (node) => (Array.isArray(node.children) ? printBlocks(node.children, false) : ''),
};

/**
 * Print a code fence, growing the fence beyond any backtick run in the
 * value.
 * @param {string|null} lang
 * @param {string|null} meta
 * @param {string} value
 * @returns {string}
 */
function printFence(lang, meta, value) {
  const info = escapeTarget(lang === null ? '' : meta === null ? lang : lang + ' ' + meta);
  // A backtick info string cannot sit on a backtick fence (the spec
  // forbids it, precisely so the fence stays findable), so such a block
  // prints on a tilde fence instead.
  const marker = info.indexOf('`') === -1 ? '`' : '~';
  const code = marker.charCodeAt(0);
  let longest = 2;
  let run = 0;
  for (let i = 0; i < value.length; i++) {
    run = value.charCodeAt(i) === code ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const fence = marker.repeat(longest + 1);
  const body = value === '' ? '' : value.endsWith('\n') ? value : value + '\n';
  // An info string that starts with the fence character would lengthen
  // the fence, so it stands one space off.
  return fence + (info.charCodeAt(0) === code ? ' ' : '') + info + '\n' + body + fence;
}

/**
 * Print one block node. Unknown types with a string `value` print as a
 * fence tagged with the type (a compiled-in plugin's fence claim then
 * round-trips); container-shaped unknowns print their children.
 * @param {MdNode} node
 * @param {boolean} [alt] use the alternate list marker (see printBlocks)
 * @param {boolean} [spare] spell a leading rule or list the other way (see the list printer)
 * @returns {string}
 */
function printBlock(node, alt, spare) {
  const printer = BLOCK_PRINTERS[node.type];
  if (printer !== undefined) return printer(node, alt, spare);
  if (typeof node.value === 'string') {
    return printFence(node.type, node.meta ?? null, node.value);
  }
  if (Array.isArray(node.children)) return printBlocks(node.children, false);
  return '';
}

/** The spaces an HTML block starts with. */
const RE_LEADING_SPACES = /^ */;

/**
 * Would this block, printed straight after this one, belong to its last
 * list item? A list item takes in every line indented to where its content
 * starts, so an HTML block that begins with that many spaces (an HTML
 * block is the one block that keeps its own indentation) is no longer
 * after the list but inside it. An item with nothing on its marker line and
 * nothing below it is ended by the blank line after it.
 * @param {MdNode} previous
 * @param {MdNode} node
 * @returns {boolean}
 */
function continuesLastItem(previous, node) {
  if (previous.type !== 'list' || node.type !== 'html') return false;
  const item = previous.children[previous.children.length - 1];
  if (item.children.length === 0 && (item.checked === null || item.checked === undefined)) return false;
  const spaces = /** @type {RegExpExecArray} */ (RE_LEADING_SPACES.exec(node.value))[0].length;
  const width = previous.ordered
    ? String((previous.start ?? 1) + previous.children.length - 1).length + 2
    : 2;
  return spaces >= width;
}

/**
 * Print a block sequence. In a tight list the child paragraphs join
 * with single newlines; everywhere else blocks separate with a blank
 * line.
 * @param {MdNode[]} blocks
 * @param {boolean} tight
 * @param {boolean} [spare] spell a leading rule or list the other way
 * @returns {string}
 */
function printBlocks(blocks, tight, spare = false) {
  let out = '';
  /** @type {MdNode | null} */
  let last = null;
  let alt = false;
  for (let i = 0; i < blocks.length; i++) {
    const node = blocks[i];
    // alternate the marker across a RUN of adjacent lists of the same
    // kind; anything else between them resets it
    const previous = i > 0 ? blocks[i - 1] : null;
    alt = node.type === 'list' && previous !== null && previous.type === 'list'
      && previous.ordered === node.ordered
      ? !alt
      : false;
    const first = spare && i === 0;
    const printed = printBlock(node, first && node.type === 'list' ? !alt : alt, first);
    if (printed === '') continue;
    if (last === null) out = printed;
    // A definition that defines nothing ends the list; a blank line on
    // either side keeps it from continuing the last item's text.
    else if (continuesLastItem(last, node)) out += '\n\n' + FILLER_DEFINITION + '\n\n' + printed;
    else out += (tight ? '\n' : '\n\n') + printed;
    last = node;
  }
  return out;
}

/**
 * Print an MdDocument (or a bare AST array / single node) to canonical
 * Markdown. Frontmatter re-emits as a `---json` block by default —
 * exact, syntax-neutral round-trips (MD-FORMAT.md §5).
 *
 * @param {any} docOrAst
 * @param {{ frontmatter?: boolean }} [options]
 * @returns {string}
 */
export function toMarkdown(docOrAst, options = {}) {
  /** @type {MdNode[]} */
  let ast;
  let frontmatter = null;
  if (Array.isArray(docOrAst)) ast = docOrAst;
  else if (docOrAst !== null && typeof docOrAst === 'object' && Array.isArray(docOrAst.ast)) {
    ast = docOrAst.ast;
    frontmatter = docOrAst.frontmatter ?? null;
  }
  else ast = [docOrAst];
  let out = '';
  if (frontmatter !== null && options.frontmatter !== false) {
    out += '---json\n' + JSON.stringify(frontmatter, null, 2) + '\n---\n\n';
  }
  searchPool.left = SEARCH_CHARS_FLOOR;
  const body = printBlocks(ast, false);
  return body === '' ? out : out + body + '\n';
}
