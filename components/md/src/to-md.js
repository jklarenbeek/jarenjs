//@ts-check
/**
 * @file Canonical Markdown printer: AST → text (MD-FORMAT.md §5).
 *
 * The printer is the round-trip half of the package: canonical output
 * re-parses to a deep-equal AST, short of the nodes it names to `onLossy`
 * (MD-FORMAT.md §5), and emphasis and strong whose canonical spelling does
 * not read back are spelled from the delimiter rules, or by a search where
 * that spelling does not read back either. Canonical choices:
 * ATX headings, `-` bullets, `1.`/`2.` ordered markers renumbered from
 * `start`, backtick fences, `*`/`**` emphasis, inline links, backslash hard
 * breaks and piped tables. Dispatch is one prebuilt table per node class — no
 * per-node type chains.
 */

import { equalsJson } from '@jarenjs/core/object';
import {
  RE_AUTOLINK_URI, RE_AUTOLINK_EMAIL, scanHtmlBlockStart, scanThematicBreak,
  isUnicodeWhitespace, isUnicodePunctuation, codePointBefore,
} from './scanner.js';
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
 * A printed cell whose text starts or ends with white space: the cell
 * reader trims both edges, so the outermost white space character prints
 * as a character reference and reads back as the text it is.
 * @param {string} text
 * @returns {string}
 */
function guardCellEdges(text) {
  const reference = (/** @type {string} */ ch) => (ch === '\t' ? '&#9;' : '&#32;');
  let out = text;
  if (/^[ \t]/.test(out)) out = reference(out[0]) + out.slice(1);
  if (/[ \t]$/.test(out)) out = out.slice(0, -1) + reference(out[out.length - 1]);
  return out;
}

/**
 * Escape a printed paragraph/cell line that would otherwise open a
 * block construct at line start.
 * @param {string} line
 * @returns {string}
 */
function guardLineStart(line) {
  // Leading whitespace cannot be escaped with a backslash: one to three
  // spaces are dropped by the block reader, and four (or one tab) would
  // re-parse as indented code, so the first whitespace character prints
  // as a character reference — which is how the text came in (`&#32;foo`,
  // `&#9;foo`) and how it goes back out.
  if (line.charCodeAt(0) === 0x09) return '&#9;' + line.slice(1);
  if (line.charCodeAt(0) === 0x20) return '&#32;' + line.slice(1);
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
 * do; one that no spelling reads back as spends what there is, and then
 * `GUIDED_CHARS_PER_CHAR` per printed character on a guided search of each
 * stretch that still does not read back, so the whole call costs a small
 * multiple of what printing without the search costs.
 */
const SEARCH_CHARS_PER_CHAR = 64;
const SEARCH_CHARS_FLOOR = 4000;
const GUIDED_CHARS_PER_CHAR = SEARCH_CHARS_PER_CHAR / 2;
/** What is left of the call's pool. */
const searchPool = { left: 0 };

/** @type {PrintContext} */
const CANONICAL = { style: 0, depth: 0, assign: null };

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
 * Does this node spell with a delimiter run (`*`/`_`)?
 * @param {MdNode} node
 * @returns {boolean}
 */
function isEmphasisClass(node) {
  return node.type === 'emphasis' || node.type === 'strong';
}

/**
 * Is this a link whose text prints inside brackets — a scope of its own
 * for the delimiter runs in it?
 * @param {MdNode} node
 * @returns {boolean}
 */
function isBracketed(node) {
  return node.type === 'link' && node.auto !== true && !isAutolink(node);
}

// ------------------------------------------------------------------
// Emphasis and strong spelled from the delimiter rules
// ------------------------------------------------------------------

/** The kinds of character a delimiter run tells its neighbours apart by. */
const WHITE = 0;
const PUNCT = 1;
const OTHER = 2;
/** What a delimiter run can do, as bits. */
const OPENS = 1;
const CLOSES = 2;

/**
 * The kind of a character beside a delimiter run, as the reader judges it.
 * @param {number} point
 * @returns {number}
 */
function kindOf(point) {
  return isUnicodeWhitespace(point) ? WHITE : isUnicodePunctuation(point) ? PUNCT : OTHER;
}

/**
 * What a run of `mark` between characters of kinds `before` and `after`
 * can do (CommonMark §6.2): it opens when it is left-flanking and closes
 * when it is right-flanking, and a `_` run that is both opens only after
 * punctuation and closes only before it.
 * @param {string} mark
 * @param {number} before
 * @param {number} after
 * @returns {number} OPENS, CLOSES, both or neither
 */
function runAbility(mark, before, after) {
  const left = after !== WHITE && (after !== PUNCT || before !== OTHER);
  const right = before !== WHITE && (before !== PUNCT || after !== OTHER);
  if (mark === '_') {
    return (left && (!right || before === PUNCT) ? OPENS : 0) | (right && (!left || after === PUNCT) ? CLOSES : 0);
  }
  return (left ? OPENS : 0) | (right ? CLOSES : 0);
}

/**
 * The character a node prints at one edge, by kind, and whether the text
 * may print it as a character reference instead, which a delimiter run
 * beside it reads as punctuation (`&#97;`): a text node's white space and
 * letters may.
 * @typedef {{ kind: number, encodable: boolean }} Edge
 */
/** @type {Edge} */
const PUNCT_EDGE = { kind: PUNCT, encodable: false };
/** @type {Edge} */
const WHITE_EDGE = { kind: WHITE, encodable: false };

/**
 * The edge of printed text that is not a text node's.
 * @param {string} printed
 * @param {boolean} end the last character, not the first
 * @returns {Edge}
 */
function printedEdge(printed, end) {
  if (printed === '') return WHITE_EDGE;
  const point = end ? codePointBefore(printed, printed.length) : /** @type {number} */ (printed.codePointAt(0));
  return { kind: kindOf(point), encodable: false };
}

/**
 * The edge of a text node's value: a character the printer escapes, or
 * prints as a reference (a newline, a tab), is punctuation.
 * @param {string} value
 * @param {boolean} end
 * @returns {Edge}
 */
function textEdge(value, end) {
  if (value === '') return WHITE_EDGE;
  const point = end ? codePointBefore(value, value.length) : /** @type {number} */ (value.codePointAt(0));
  const kind = point === 0x0A || point === 0x09 ? PUNCT : kindOf(point);
  return kind === PUNCT ? PUNCT_EDGE : { kind, encodable: true };
}

/**
 * The edge a node shows a delimiter run beside it, before any delimiter
 * is chosen: a delimiter-class node shows its own run, punctuation.
 * @param {MdNode} node
 * @param {boolean} end
 * @returns {Edge}
 */
function nodeEdge(node, end) {
  if (isEmphasisClass(node) || node.type === 'strikethrough' || isBracketed(node)) return PUNCT_EDGE;
  if (node.type === 'text') return textEdge(node.value, end);
  return printedEdge(printInline(node, CANONICAL, 0), end);
}

/**
 * Can a run between these edges open without being able to close?
 * Either white space before it and anything else after it, or a letter
 * after it and no letter before it — each edge printed as a character
 * reference where that is what it takes.
 * @param {Edge} before
 * @param {Edge} after
 * @returns {boolean}
 */
function opensOnly(before, after) {
  return (before.kind === WHITE && (after.kind !== WHITE || after.encodable))
    || (after.kind === OTHER && (before.kind !== OTHER || before.encodable));
}

/**
 * Does the rule of three keep a run with `left` characters unpaired from
 * a run of `length` that can both open and close (CommonMark §6.2, rule 9)?
 * @param {number} left
 * @param {number} length
 * @returns {boolean}
 */
function ruleOfThree(left, length) {
  return (left + length) % 3 === 0 && (left % 3 !== 0 || length % 3 !== 0);
}

/** The delimiters an emphasis or strong node may print with, the canonical one first. */
const MARKS = ['*', '_'];

/**
 * The runs open around some content while it prints, as the reader's
 * stack holds them: one bit per delimiter and per number of characters
 * left modulo three, which is all that a run that can also close is
 * weighed against (`pairsWithOpen`).
 * @typedef {number} OpenRuns
 */

/**
 * An opener run on the reader's stack: its delimiter, the characters of
 * it still unpaired, and the edge before it.
 * @typedef {{ mark: string, left: number, before: Edge }} OpenRun
 */

/**
 * The bit of an open run with this delimiter and this many characters
 * left; none for a strikethrough's, which no emphasis pairs with.
 * @param {string} mark
 * @param {number} left
 * @returns {number}
 */
function runBit(mark, left) {
  if (mark === '~' || left <= 0) return 0;
  return 1 << ((mark === '_' ? 3 : 0) + left % 3);
}

/**
 * Would a run of `length` characters of `mark` that can both open and
 * close pair, when the reader weighs it as a closer, with a run already
 * open? Then it cannot open a node inside those runs.
 * @param {OpenRuns} open
 * @param {string} mark
 * @param {number} length
 * @returns {boolean}
 */
function pairsWithOpen(open, mark, length) {
  const at = mark === '_' ? 3 : 0;
  for (let r = 0; r < 3; r++) {
    if ((open & (1 << (at + r))) !== 0 && !ruleOfThree(r === 0 ? 3 : r, length)) return true;
  }
  return false;
}

/**
 * Is a run of this delimiter open?
 * @param {OpenRuns} open
 * @param {string} mark
 * @returns {boolean}
 */
function isOpen(open, mark) {
  return (open & (7 << (mark === '_' ? 3 : 0))) !== 0;
}

/** What a spelling that does not read back costs: more than any spelling that does. */
const UNREAD = 100;

/**
 * What a run of `mark` between these edges costs to do what it `need`s:
 * nothing as it stands, a little when a character beside it must print as
 * a reference, `UNREAD` when it cannot.
 * @param {string} mark
 * @param {Edge} before
 * @param {Edge} after
 * @param {number} need
 * @returns {number}
 */
function ableCost(mark, before, after, need) {
  if ((runAbility(mark, before.kind, after.kind) & need) === need) return 0;
  return able(mark, before, after, need) ? 0.375 : UNREAD;
}

/**
 * Can a run of `mark` between these edges do what it `need`s, each edge
 * printed as a character reference where it may be?
 * @param {string} mark
 * @param {Edge} before
 * @param {Edge} after
 * @param {number} need
 * @returns {boolean}
 */
function able(mark, before, after, need) {
  for (let option = 0; option < 4; option++) {
    if (((option & 1) === 1 && !before.encodable) || ((option & 2) === 2 && !after.encodable)) continue;
    const can = runAbility(mark, (option & 1) === 1 ? PUNCT : before.kind, (option & 2) === 2 ? PUNCT : after.kind);
    if ((can & need) === need) return true;
  }
  return false;
}

/**
 * Can a run between these edges close without being able to open? The
 * mirror image of `opensOnly`.
 * @param {Edge} before
 * @param {Edge} after
 * @returns {boolean}
 */
function closesOnly(before, after) {
  return (after.kind === WHITE && (before.kind !== WHITE || before.encodable))
    || (before.kind === OTHER && (after.kind !== OTHER || after.encodable));
}

/**
 * Literal characters of one delimiter that a text beside a run holds at
 * the edge that touches it, which may print bare as part of the run, the
 * edge beyond them, and whether that is the parent's run (`beside`): the
 * text is all literal characters.
 * @typedef {{ count: number, edge: Edge, beside: boolean }} Literal
 */

/**
 * An emphasis, strong or strikethrough node among the touching ones of
 * a parent's content, with the edges its runs stand between where they
 * merge with no other run: `before` and `after` its opener, `last` and
 * `next` its closer; and, per delimiter, the literal characters the text
 * before its opener ends with (`lead`) and the text after its closer
 * starts with (`trail`). `row` is the touching nodes it is one of, and
 * `j` its place among them.
 * `nests` says its first child prints with a delimiter too, whose run
 * may merge with its opener, so that the opener is weighed there, and
 * `ends` the same of its last child and its closer. `head` says its first
 * child is a letter alone that the run of its second child stands beside
 * too, or that its closer does, so that whether it prints as a reference
 * is the node's to choose for both, and `tail` the same of its last child;
 * `first` says the letter before this node's opener is such a letter of
 * its parent's, and `final` the letter after its closer.
 * @typedef {{ node: MdNode, length: number, before: Edge, after: Edge, last: Edge, next: Edge,
 *   lead: Record<string, Literal>, trail: Record<string, Literal>, row: Touching[], j: number,
 *   nests: boolean, ends: boolean, head: boolean, tail: boolean, first: boolean, final: boolean }} Touching
 */

/**
 * The parent of some content, when it prints with a delimiter: its
 * opener's run, its length, the edges its closer stands between, and the
 * edge a letter alone at the content's start or end shows, as the parent
 * chose to print it (`Touching`'s `head` and `tail`).
 * `alone` says its opener can only open, which the rule of three between
 * it and its closer depends on; `pending` says the rule of three keeps
 * the parent's closer from its opener unless that opener can only open,
 * which only the content's first node settles, by merging its own opener
 * with the parent's or not.
 * `closing` is the length of the closer's run, merged with the closers
 * of the parent's parents it touches.
 * @typedef {{ run: OpenRun, length: number, closing: number, last: Edge, next: Edge, head: Edge | null, tail: Edge | null, alone: boolean, pending: boolean }} RowParent
 */

/**
 * One way to print a node of a row: its delimiter, how many literal
 * characters print bare before its opener and after its closer, and
 * whether a letter alone at the start or the end of its content prints
 * as a reference.
 * @typedef {{ mark: string, lead: number, trail: number, head: boolean, tail: boolean }} Spelling
 */

/**
 * What printing a node of a row as `spelling` costs, after the node before
 * it in the row printed as `previous`: `UNREAD` for each run that would
 * not pair where the node stands, a little for a run merged with another
 * or holding literal characters, and a little less for `_`, so that `*`
 * prints where both read back. A run that can only open, or only close,
 * pairs where it stands; one that can do both is weighed as a closer
 * first, so it must find no open run of its delimiter it would pair with,
 * and the rule of three must not keep a closer from its own opener
 * (CommonMark §6.2). The reader takes two characters from an opener and a
 * closer that both have two, leaves what is left of an opener open until
 * its parent closes, and weighs what is left of a closer again.
 * @param {Touching} touching
 * @param {Spelling} spelling
 * @param {Spelling | null} previous
 * @param {RowParent | null} parent
 * @param {boolean} atStart the row starts at the parent's opener
 * @param {boolean} atEnd the row ends at the parent's closer
 * @param {OpenRuns} open the runs open around the node, the parent's included
 * @param {OpenRuns} others the same without the parent's
 * @returns {number}
 */
function markCost(touching, spelling, previous, parent, atStart, atEnd, open, others) {
  const mark = spelling.mark;
  const t = asSpelled(touching, spelling, parent);
  const { row, j } = t;
  const intoParent = parent !== null && parent.run.mark === mark;
  let cost = 0;
  // the parent's runs that do not merge with this node's stand beside them
  if (parent !== null && !intoParent) {
    const run = parent.run;
    if (j === 0 && atStart && (!able(run.mark, run.before, PUNCT_EDGE, OPENS)
      || (run.mark !== '~' && !opensOnly(run.before, PUNCT_EDGE) && (parent.pending || pairsWithOpen(others, run.mark, run.left))))) cost += UNREAD;
    if (j === row.length - 1 && atEnd && (!able(run.mark, PUNCT_EDGE, parent.next, CLOSES)
      || (run.mark !== '~' && !(parent.alone && closesOnly(PUNCT_EDGE, parent.next)) && ruleOfThree(run.left, parent.closing)))) cost += UNREAD;
  }
  if (mark === '~') {
    // two strikethrough runs that touch are one run of four, which is none
    if ((previous !== null && previous.mark === '~') || (intoParent && ((j === 0 && atStart) || (j === row.length - 1 && atEnd)))) cost += UNREAD;
    if ((!t.nests && !able(mark, t.before, t.after, OPENS)) || (!t.ends && !able(mark, t.last, t.next, CLOSES))) cost += UNREAD;
    return cost;
  }
  // `_` costs a little, and a little more the earlier it prints in its row,
  // so that the first of two nodes that may take either takes `*`
  cost += (mark === '_' ? 0.25 + (row.length - j) / 1024 : 0) + (spelling.lead + spelling.trail > 0 ? 0.5 : 0);
  // literal characters that would touch the parent's run of the same delimiter merge with it
  if ((spelling.lead > 0 && t.lead[mark].beside && intoParent) || (spelling.trail > 0 && t.trail[mark].beside && intoParent)) cost += UNREAD;
  if (intoParent && atStart && atEnd && row.length === 1) {
    // the opener and the closer merge with the parent's: the reader takes
    // two characters from each end first, so only strong is inside
    const run = /** @type {RowParent} */ (parent).run;
    if (t.node.type !== 'strong') cost += UNREAD;
    if (!t.nests && !opensOnly(run.before, t.after) && (pairsWithOpen(others, mark, run.left + t.length) || /** @type {RowParent} */ (parent).pending)) cost += UNREAD;
    if ((!t.nests && !able(mark, run.before, t.after, OPENS)) || (!t.ends && !able(mark, t.last, /** @type {RowParent} */ (parent).next, CLOSES))) cost += UNREAD;
    return cost + 1;
  }
  let openerAlone;
  let left;
  if (j === 0 && atStart && intoParent) {
    const run = /** @type {RowParent} */ (parent).run;
    left = run.left + t.length;
    openerAlone = opensOnly(run.before, t.after);
    if (!t.nests && !openerAlone && (pairsWithOpen(others, mark, left) || /** @type {RowParent} */ (parent).pending)) cost += UNREAD;
    if (!t.nests && !able(mark, run.before, t.after, OPENS)) cost += UNREAD;
    cost += 1;
  }
  else if (j > 0 && previous !== null && previous.mark === mark) {
    // the previous node's closer and this opener are one run, which must
    // close the one and then open this one
    const before = row[j - 1];
    const held = before.length + (j === 1 ? previous.lead : 0);
    if (ruleOfThree(held, before.length + t.length) || (before.length === 1 && held >= 2)) cost += UNREAD;
    if (pairsWithOpen(open, mark, t.length)) cost += UNREAD;
    if (!able(mark, before.last, t.after, OPENS | CLOSES)) cost += UNREAD;
    left = t.length;
    openerAlone = false;
    cost += 1;
  }
  else {
    left = spelling.lead + t.length;
    const before = spelling.lead > 0 ? t.lead[mark].edge : t.before;
    openerAlone = opensOnly(before, t.after);
    if (!t.nests && !openerAlone && pairsWithOpen(open, mark, left)) cost += UNREAD;
    if (!t.nests) cost += ableCost(mark, before, t.after, OPENS);
    // what is left of the opener stays open until the parent's closer,
    // which must pass it by
    if (spelling.lead > 0 && intoParent) {
      const outer = /** @type {RowParent} */ (parent);
      if (!ruleOfThree(spelling.lead, outer.length) || (openerAlone && closesOnly(outer.last, outer.next))) cost += UNREAD;
    }
  }
  const closesIntoParent = j === row.length - 1 && atEnd && intoParent;
  const next = closesIntoParent ? /** @type {RowParent} */ (parent).next
    : spelling.trail > 0 ? t.trail[mark].edge : t.next;
  const closing = t.length + spelling.trail + (closesIntoParent ? /** @type {RowParent} */ (parent).closing : 0);
  const closerAlone = closesOnly(t.last, next);
  if (!t.ends) cost += ableCost(mark, t.last, next, CLOSES);
  if (closesIntoParent) {
    // the parent's characters of the merged closer are weighed against
    // what is left of its opener after this node's
    const outer = /** @type {RowParent} */ (parent);
    if (!able(mark, t.last, outer.next, CLOSES)
      || (!(outer.alone && closerAlone) && ruleOfThree(outer.run.left, outer.closing))) cost += UNREAD;
  }
  // emphasis between an opener and a closer of two or more reads as strong
  if (t.length === 1 && left >= 2 && closing >= 2) cost += UNREAD;
  // with a delimited last child, the closer is weighed there, and with a
  // delimited first child whether the opener can only open is settled there,
  // where that child's opener merges with this one or not (`pending`)
  if (!t.ends && ruleOfThree(left, closing) && (!closerAlone || (!t.nests && !openerAlone))) cost += UNREAD;
  if (spelling.trail > 0) {
    // what is left of the closer is weighed as a closer again: it must
    // pair with nothing, and what of it can open stays open until the
    // parent's closer
    if (spelling.lead > 0 || (closerAlone ? isOpen(open, mark) : pairsWithOpen(open, mark, spelling.trail))) cost += UNREAD;
    if (!closerAlone && intoParent && !ruleOfThree(spelling.trail, /** @type {RowParent} */ (parent).length)) cost += UNREAD;
  }
  if (closesIntoParent) cost += 1;
  return cost;
}

/**
 * The ways a node of a row may print: either delimiter, and for the
 * first node literal characters before its opener and for the last
 * literal characters after its closer, where the text there has them.
 * @param {Touching} t
 * @returns {Spelling[]}
 */
function spellingsOf(t) {
  /** @type {Spelling[]} */
  const out = [];
  const one = t.node.children.length === 1;
  for (const mark of t.node.type === 'strikethrough' ? ['~'] : MARKS) {
    const lead = t.lead[mark]?.count ?? 0;
    const trail = t.trail[mark]?.count ?? 0;
    for (const a of lead > 0 ? [0, lead] : [0]) {
      for (const b of trail > 0 ? [0, trail] : [0]) {
        for (const head of t.head ? [false, true] : [false]) {
          for (const tail of t.tail && !one ? [false, true] : [head]) out.push({ mark, lead: a, trail: b, head, tail });
        }
      }
    }
  }
  return out;
}

/**
 * Is this node printed with a delimiter run of its own?
 * @param {MdNode} node
 * @returns {boolean}
 */
function isDelimited(node) {
  return isEmphasisClass(node) || node.type === 'strikethrough';
}

/**
 * The edge a run sees past the node at `i`, or past the content's end.
 * @param {MdNode[]} nodes
 * @param {number} i
 * @param {boolean} end the edge at the node's end, before what follows it
 * @param {boolean} inside the content is a delimited node's
 * @param {Edge} scope
 * @returns {Edge}
 */
function edgeAt(nodes, i, end, inside, scope) {
  if (i < 0 || i >= nodes.length) return inside ? PUNCT_EDGE : scope;
  return nodeEdge(nodes[i], end);
}

/**
 * The literal characters of each delimiter a text holds at one edge, and
 * the edge beyond them. A text of one delimiter alone between two rows of
 * touching nodes is the trailing literal of the first row only.
 * @param {MdNode[]} nodes
 * @param {number} i the text's index, or -1 or the length when there is none
 * @param {boolean} end its last characters, before the run, not its first
 * @param {boolean} inside
 * @param {Edge} scope
 * @returns {Record<string, Literal>}
 */
function literalsAt(nodes, i, end, inside, scope) {
  /** @type {Record<string, Literal>} */
  const out = {};
  const node = nodes[i];
  for (const mark of MARKS) {
    let count = 0;
    if (node !== undefined && node.type === 'text') {
      const value = node.value;
      while (count < value.length && value.charAt(end ? value.length - 1 - count : count) === mark) count++;
      // a text of literal characters alone between two rows touches both
      const beyond = end ? i - 1 : i + 1;
      if (count === value.length && beyond >= 0 && beyond < nodes.length && isDelimited(nodes[beyond])) count = 0;
    }
    let edge = PUNCT_EDGE;
    let beside = false;
    if (count > 0) {
      const value = /** @type {MdNode} */ (node).value;
      const rest = end ? value.slice(0, value.length - count) : value.slice(count);
      edge = rest !== '' ? textEdge(rest, end) : edgeAt(nodes, end ? i - 1 : i + 1, end, inside, scope);
      beside = rest === '' && inside && (end ? i === 0 : i === nodes.length - 1);
    }
    out[mark] = { count, edge, beside };
  }
  return out;
}

/**
 * The edge of the node at `i` in a delimited node's content, which that
 * node's runs stand beside.
 * @param {MdNode[]} children
 * @param {number} i
 * @param {boolean} end
 * @returns {Edge}
 */
function innerEdge(children, i, end) {
  return sharedEdge(children, i, end, true, PUNCT_EDGE);
}

/**
 * The edge a run sees past the node at `i`; a letter alone between two
 * runs is no character reference for either, since a reference would
 * change what the other sees too.
 * @param {MdNode[]} nodes
 * @param {number} i
 * @param {boolean} end
 * @param {boolean} inside
 * @param {Edge} scope
 * @returns {Edge}
 */
function sharedEdge(nodes, i, end, inside, scope) {
  const edge = edgeAt(nodes, i, end, inside, scope);
  if (!edge.encodable || edge.kind !== OTHER || !isOneCharacter(nodes[i].value)) return edge;
  const before = i > 0 && isDelimited(nodes[i - 1]);
  const after = i < nodes.length - 1 && isDelimited(nodes[i + 1]);
  return before && after ? LETTER_EDGE : edge;
}

/**
 * Is the node at `i` a text of one letter, which a character reference
 * would make punctuation for the runs on both its sides at once?
 * @param {MdNode[]} nodes
 * @param {number} i
 * @returns {boolean}
 */
function isLetterAlone(nodes, i) {
  const node = nodes[i];
  return node !== undefined && node.type === 'text' && isOneCharacter(node.value)
    && kindOf(/** @type {number} */ (node.value.codePointAt(0))) === OTHER;
}

/** A letter that prints as itself. */
const LETTER_EDGE = { kind: OTHER, encodable: false };

/**
 * What the derivation of one block's spelling has worked out, by content:
 * each content's touching nodes, and its cheapest spellings by the runs
 * around it. Emptied after each block, so that a document changed between
 * two calls is derived afresh.
 * @type {{ touching: Map<MdNode[], (Touching | undefined)[]>, solved: Map<MdNode[], Map<string, Solution>>, runs: Map<MdNode[], boolean> }}
 */
const derived = { touching: new Map(), solved: new Map(), runs: new Map() };

/**
 * Each delimited node of some content as a `Touching`, by its index.
 * @param {MdNode[]} nodes
 * @param {boolean} inside
 * @param {Edge} scope
 * @returns {(Touching | undefined)[]}
 */
function touchingOf(nodes, inside, scope) {
  let known = derived.touching.get(nodes);
  if (known !== undefined) return known;
  /** @type {(Touching | undefined)[]} */
  const out = new Array(nodes.length);
  /** @type {Record<string, Literal>} */
  const none = { '*': { count: 0, edge: PUNCT_EDGE, beside: false }, '_': { count: 0, edge: PUNCT_EDGE, beside: false } };
  for (let i = 0; i < nodes.length;) {
    if (!isDelimited(nodes[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < nodes.length && isDelimited(nodes[end])) end++;
    /** @type {Touching[]} */
    const row = [];
    for (let k = i; k < end; k++) {
      const children = nodes[k].children;
      const t = {
        node: nodes[k],
        length: nodes[k].type === 'emphasis' ? 1 : 2,
        before: k > i ? PUNCT_EDGE : sharedEdge(nodes, k - 1, true, inside, scope),
        after: children.length > 0 ? innerEdge(children, 0, false) : WHITE_EDGE,
        last: children.length > 0 ? innerEdge(children, children.length - 1, true) : WHITE_EDGE,
        next: k < end - 1 ? PUNCT_EDGE : sharedEdge(nodes, end, false, inside, scope),
        lead: k === i ? literalsAt(nodes, i - 1, true, inside, scope) : none,
        trail: k === end - 1 ? literalsAt(nodes, end, false, inside, scope) : none,
        row,
        j: k - i,
        nests: children.length > 0 && isDelimited(children[0]),
        ends: children.length > 0 && isDelimited(children[children.length - 1]),
        head: isLetterAlone(children, 0) && (children.length === 1 || isDelimited(children[1])),
        tail: isLetterAlone(children, children.length - 1) && (children.length === 1 || isDelimited(children[children.length - 2])),
        first: inside && k === i && i === 1 && isLetterAlone(nodes, 0),
        final: inside && k === end - 1 && end === nodes.length - 1 && isLetterAlone(nodes, end),
      };
      row.push(t);
      out[k] = t;
    }
    i = end;
  }
  derived.touching.set(nodes, out);
  return out;
}

/**
 * A node of a row with the edges a letter alone beside its runs shows,
 * printed as the node or its parent chose.
 * @param {Touching} t
 * @param {Spelling} spelling
 * @param {RowParent | null} parent
 * @returns {Touching}
 */
function asSpelled(t, spelling, parent) {
  if (!t.head && !t.tail && !t.first && !t.final) return t;
  return {
    ...t,
    after: t.head ? (spelling.head ? PUNCT_EDGE : LETTER_EDGE) : t.after,
    last: t.tail ? (spelling.tail ? PUNCT_EDGE : LETTER_EDGE) : t.last,
    before: t.first && parent !== null && parent.head !== null ? parent.head : t.before,
    next: t.final && parent !== null && parent.tail !== null ? parent.tail : t.next,
  };
}

/**
 * What a node's content needs to know of the node: its run, and so on
 * (`RowParent`), for a spelling of the node; and the runs open around the
 * content, the node's own excluded.
 * @param {Touching} touching
 * @param {Spelling} spelling
 * @param {RowParent | null} parent
 * @param {boolean} atStart
 * @param {boolean} atEnd
 * @param {OpenRuns} open the runs open around the node, its parent's excluded
 * @returns {{ inner: RowParent, around: OpenRuns }}
 */
function contentOf(touching, spelling, parent, atStart, atEnd, open) {
  const mark = spelling.mark;
  const t = asSpelled(touching, spelling, parent);
  const merged = t.j === 0 && atStart && parent !== null && parent.run.mark === mark;
  // a closer with its parent's delimiter merges into its parent's closer
  const into = t.j === t.row.length - 1 && atEnd && parent !== null && parent.run.mark === mark;
  const run = merged
    ? { mark, left: /** @type {RowParent} */ (parent).run.left + t.length, before: /** @type {RowParent} */ (parent).run.before }
    : { mark, left: spelling.lead + t.length, before: spelling.lead > 0 ? t.lead[mark].edge : t.before };
  const next = into ? /** @type {RowParent} */ (parent).next : spelling.trail > 0 ? t.trail[mark].edge : t.next;
  const closing = t.length + spelling.trail + (into ? /** @type {RowParent} */ (parent).closing : 0);
  const around = merged || parent === null ? open : open | runBit(parent.run.mark, parent.run.left);
  const alone = opensOnly(run.before, t.after);
  const pending = (merged && /** @type {RowParent} */ (parent).pending)
    || (t.nests && !t.ends && ruleOfThree(run.left, closing) && closesOnly(t.last, next));
  return {
    inner: { run, length: t.length, closing, last: t.last, next, head: t.head ? t.after : null, tail: t.tail ? t.last : null, alone, pending },
    around,
  };
}

/**
 * What a node's spelling leaves open after it, until its parent closes:
 * what is left of its opener, and what is left of its closer that can open.
 * @param {Touching} touching
 * @param {Spelling} spelling
 * @param {RowParent | null} parent
 * @returns {OpenRuns}
 */
function leftOpen(touching, spelling, parent) {
  const mark = spelling.mark;
  const t = asSpelled(touching, spelling, parent);
  let bits = spelling.lead > 0 ? runBit(mark, spelling.lead) : 0;
  if (spelling.trail > 0 && !closesOnly(t.last, t.trail[mark].edge)) bits |= runBit(mark, spelling.trail);
  return bits;
}

/**
 * The cheapest spelling of some content: what it costs, and each
 * delimited node's spelling by its index.
 * @typedef {{ cost: number, picks: (Spelling | undefined)[] }} Solution
 */

/**
 * A step through a content's nodes towards its cheapest spelling: what it
 * cost so far, the runs open after it, the spelling it gave the node at
 * `index` (none past a node that is not delimited), the spelling of the
 * delimited node just before the next one, when the two touch, and the
 * step it came from.
 * @typedef {{ cost: number, open: OpenRuns, index: number, spelling: Spelling | null, touching: Spelling | null, back: Step | null }} Step
 */

/**
 * Find the cheapest spelling of some content (`markCost`), each node's
 * cost counting the cheapest spelling of its own content with the runs
 * that spelling leaves open around it. The content is taken node by node,
 * keeping, for each set of runs left open and each spelling of the last
 * node, only the cheapest way there: the runs open are one of a few dozen
 * sets, and a node has at most eight spellings, so the work grows with
 * the content and not with the ways to spell it.
 * @param {MdNode[]} nodes
 * @param {RowParent | null} parent
 * @param {Edge} scope
 * @param {OpenRuns} open the runs open around the content, the parent's excluded
 * @returns {Solution}
 */
function solveContent(nodes, parent, scope, open) {
  if (!holdsRuns(nodes)) return NOTHING_TO_SPELL;
  const key = open + (parent === null
    ? '|' + scope.kind
    : '|' + parent.run.mark + leftKey(parent.run.left) + edgeKey(parent.run.before) + edgeKey(parent.last) + edgeKey(parent.next) + parent.length
      + 'c' + leftKey(parent.closing) + (parent.head === null ? '-' : edgeKey(parent.head)) + (parent.tail === null ? '-' : edgeKey(parent.tail)) + (parent.alone ? 'a' : 'b') + (parent.pending ? 'p' : 'q'));
  let solved = derived.solved.get(nodes);
  if (solved === undefined) {
    solved = new Map();
    derived.solved.set(nodes, solved);
  }
  const known = solved.get(key);
  if (known !== undefined) return known;
  const touching = touchingOf(nodes, parent !== null, scope);
  /** @type {Step[]} */
  let steps = [{ cost: 0, open, index: -1, spelling: null, touching: null, back: null }];
  let fixed = 0;
  for (let i = 0; i < nodes.length; i++) {
    const t = touching[i];
    if (t === undefined) {
      if (isBracketed(nodes[i])) fixed += solveContent(nodes[i].children, null, PUNCT_EDGE, 0).cost;
      // a node between rows: only the runs left open carry on
      /** @type {Map<number, Step>} */
      const kept = new Map();
      for (const step of steps) {
        const seen = kept.get(step.open);
        if (seen === undefined || step.cost < seen.cost) {
          kept.set(step.open, { cost: step.cost, open: step.open, index: -1, spelling: null, touching: null, back: step });
        }
      }
      steps = [...kept.values()];
      continue;
    }
    const atStart = i - t.j === 0;
    const atEnd = i - t.j + t.row.length === nodes.length;
    const spellings = spellingsOf(t);
    /** @type {Map<string, Step>} */
    const next = new Map();
    for (const step of steps) {
      for (let a = 0; a < spellings.length; a++) {
        const spelling = spellings[a];
        const local = markCost(t, spelling, t.j > 0 ? step.touching : null, parent, atStart, atEnd,
          step.open | (parent === null ? 0 : runBit(parent.run.mark, parent.run.left)), step.open);
        const inside = contentOf(t, spelling, parent, atStart, atEnd, step.open);
        const cost = step.cost + local + solveContent(t.node.children, inside.inner, scope, inside.around).cost;
        const after = step.open | leftOpen(t, spelling, parent);
        // what the next node of the row weighs of this one: its delimiter,
        // and whether literal characters lead its opener
        const id = after + spelling.mark + (spelling.lead > 0 ? 'l' : '');
        const seen = next.get(id);
        if (seen === undefined || cost < seen.cost) next.set(id, { cost, open: after, index: i, spelling, touching: spelling, back: step });
      }
    }
    steps = [...next.values()];
  }
  let best = steps[0];
  for (const step of steps) if (step.cost < best.cost) best = step;
  /** @type {(Spelling | undefined)[]} */
  const picks = new Array(nodes.length);
  for (let step = best; step !== null; step = step.back) {
    if (step.spelling !== null) picks[step.index] = step.spelling;
  }
  const solution = { cost: best.cost + fixed, picks };
  solved.set(key, solution);
  return solution;
}

/** The solution of content with no runs of its own to spell. */
const NOTHING_TO_SPELL = { cost: 0, picks: [] };

/**
 * Does some content hold a delimited node or a link's text, which its
 * solution spells, among its own nodes?
 * @param {MdNode[]} nodes
 * @returns {boolean}
 */
function holdsRuns(nodes) {
  let known = derived.runs.get(nodes);
  if (known === undefined) {
    known = nodes.some((node) => isDelimited(node) || isBracketed(node));
    derived.runs.set(nodes, known);
  }
  return known;
}

/**
 * A short key for the characters left of a run: all that the rules weigh
 * of them is whether there are fewer than two and how many modulo three.
 * @param {number} left
 * @returns {number}
 */
function leftKey(left) {
  return left < 3 ? left : 3 + left % 3;
}

/**
 * A short key for an edge.
 * @param {Edge} edge
 * @returns {string}
 */
function edgeKey(edge) {
  return String(edge.kind * 2 + (edge.encodable ? 1 : 0));
}

/**
 * Record the spellings `solveContent` found for some content and,
 * through them, for the content of each node in it: each node's delimiter
 * and the literal characters beside it that print bare.
 * @param {MdNode[]} nodes
 * @param {RowParent | null} parent
 * @param {Edge} scope
 * @param {OpenRuns} open
 * @param {Spelled} spelled
 */
function assignMarks(nodes, parent, scope, open, spelled) {
  const { picks } = solveContent(nodes, parent, scope, open);
  const touching = touchingOf(nodes, parent !== null, scope);
  let now = open;
  for (let i = 0; i < nodes.length; i++) {
    const t = touching[i];
    if (t === undefined) {
      if (isBracketed(nodes[i])) assignMarks(nodes[i].children, null, PUNCT_EDGE, 0, spelled);
      continue;
    }
    const spelling = /** @type {Spelling} */ (picks[i]);
    if (spelling.mark !== '~') spelled.marks.set(t.node, spelling.mark);
    if (spelling.lead > 0) reserve(spelled.bare, nodes[i - 1], 'tail', spelling.lead);
    if (spelling.trail > 0) reserve(spelled.bare, nodes[i + 1], 'head', spelling.trail);
    const children = t.node.children;
    if (t.head) spelled.coded.set(children[0], spelling.head);
    if (t.tail) spelled.coded.set(children[children.length - 1], spelling.tail);
    const atStart = i - t.j === 0;
    const inside = contentOf(t, spelling, parent, atStart, i - t.j + t.row.length === nodes.length, now);
    assignMarks(t.node.children, inside.inner, scope, inside.around, spelled);
    now |= leftOpen(t, spelling, parent);
  }
}

/**
 * Print this many of a text's characters at one edge bare.
 * @param {Map<MdNode, { head: number, tail: number }>} bare
 * @param {MdNode} node
 * @param {'head' | 'tail'} edge
 * @param {number} count
 */
function reserve(bare, node, edge, count) {
  let taken = bare.get(node);
  if (taken === undefined) {
    taken = { head: 0, tail: 0 };
    bare.set(node, taken);
  }
  taken[edge] = count;
}

/**
 * One piece of a block's content in print order: a text node's value,
 * whose first and last characters may print as references; one
 * delimiter of an emphasis, strong or strikethrough node, which `need`s
 * to open or to close, or literal characters of a text printed bare
 * beside one, which need neither; or whatever else prints there, whole.
 * A letter alone whose spelling a node chose is `fixed`: printed as a
 * reference or not, whatever a run beside it would rather.
 * A text that is all of its node is `whole`.
 * @typedef {{ kind: 'text', value: string, head: boolean, tail: boolean, whole: boolean, fixed?: boolean }} TextPiece
 * @typedef {{ kind: 'mark', mark: string, length: number, need: number }} MarkPiece
 * @typedef {{ kind: 'atom', value: string, link: boolean }} AtomPiece
 * @typedef {TextPiece | MarkPiece | AtomPiece} Piece
 */

/**
 * The delimiters `assignMarks` chose, and the literal characters at each
 * edge of a text that print bare.
 * @typedef {{ marks: Map<MdNode, string>, bare: Map<MdNode, { head: number, tail: number }>, coded: Map<MdNode, boolean> }} Spelled
 */

/**
 * Lay a block's content out as pieces.
 * @param {MdNode[]} nodes
 * @param {Spelled} spelled
 * @param {Piece[]} pieces
 */
function layOut(nodes, spelled, pieces) {
  for (const node of nodes) {
    if (node.type === 'text') {
      const taken = spelled.bare.get(node);
      let value = node.value;
      if (taken !== undefined && taken.head > 0) {
        pieces.push({ kind: 'mark', mark: value.charAt(0), length: taken.head, need: 0 });
        value = value.slice(taken.head);
      }
      const tail = taken === undefined ? 0 : taken.tail;
      const fixed = spelled.coded.get(node);
      if (value.length > tail) {
        pieces.push({ kind: 'text', value: value.slice(0, value.length - tail), head: fixed === true, tail: false, whole: value.length === node.value.length && tail === 0, fixed });
      }
      if (tail > 0) pieces.push({ kind: 'mark', mark: value.charAt(value.length - 1), length: tail, need: 0 });
    }
    else if (isEmphasisClass(node) || node.type === 'strikethrough') {
      const mark = node.type === 'strikethrough' ? '~' : spelled.marks.get(node) ?? '*';
      const length = node.type === 'emphasis' ? 1 : 2;
      pieces.push({ kind: 'mark', mark, length, need: OPENS });
      layOut(node.children, spelled, pieces);
      pieces.push({ kind: 'mark', mark, length, need: CLOSES });
    }
    else if (isBracketed(node)) {
      pieces.push({ kind: 'atom', value: '[' + spellPieces(node.children, spelled, PUNCT_EDGE) + '](' + printLinkTarget(node) + ')', link: true });
    }
    else pieces.push({ kind: 'atom', value: printInline(node, CANONICAL, 0), link: node.type === 'link' });
  }
}

/**
 * The edge the piece at `i` shows a run beside it; a letter alone between
 * two runs is no reference for either (`sharedEdge`).
 * @param {Piece[]} pieces
 * @param {number} i
 * @param {boolean} end
 * @param {Edge} scope
 * @returns {Edge}
 */
function pieceEdge(pieces, i, end, scope) {
  const piece = pieces[i];
  if (piece === undefined) return scope;
  if (piece.kind === 'text') {
    if (piece.fixed !== undefined) return piece.fixed ? PUNCT_EDGE : LETTER_EDGE;
    if (end ? piece.tail : piece.head) return PUNCT_EDGE;
    const edge = textEdge(piece.value, end);
    const shared = edge.kind === OTHER && piece.whole && isOneCharacter(piece.value)
      && pieces[i - 1]?.kind === 'mark' && pieces[i + 1]?.kind === 'mark';
    return shared ? { kind: OTHER, encodable: false } : edge;
  }
  return piece.kind === 'mark' ? PUNCT_EDGE : printedEdge(piece.value, end);
}

/**
 * Is the text one character, so that its head and its tail are the same?
 * @param {string} value
 * @returns {boolean}
 */
function isOneCharacter(value) {
  return value.length === 1 || (value.length === 2 && value.codePointAt(0) !== value.charCodeAt(0));
}

/**
 * Print a block's content with each emphasis and strong node's delimiter
 * chosen by `assignMarks`, and each character beside a delimiter run that
 * keeps the run from opening or closing where it stands — white space, a
 * letter — printed as a character reference, which the run reads as
 * punctuation.
 * @param {MdNode[]} nodes
 * @param {Spelled} spelled
 * @param {Edge} scope
 * @returns {string}
 */
function spellPieces(nodes, spelled, scope) {
  /** @type {Piece[]} */
  const pieces = [];
  layOut(nodes, spelled, pieces);
  for (let start = 0; start < pieces.length;) {
    const first = pieces[start];
    if (first.kind !== 'mark') {
      start++;
      continue;
    }
    let end = start;
    let need = 0;
    for (; end < pieces.length; end++) {
      const piece = pieces[end];
      if (piece.kind !== 'mark' || piece.mark !== first.mark) break;
      need |= piece.need;
    }
    const before = pieceEdge(pieces, start - 1, true, scope);
    const after = pieceEdge(pieces, end, false, scope);
    let chosen = -1;
    let lowest = Infinity;
    for (let option = 0; option < 4; option++) {
      const codeBefore = (option & 1) === 1;
      const codeAfter = (option & 2) === 2;
      if ((codeBefore && !before.encodable) || (codeAfter && !after.encodable)) continue;
      const can = runAbility(first.mark, codeBefore ? PUNCT : before.kind, codeAfter ? PUNCT : after.kind);
      if ((can & need) !== need) continue;
      const extra = can & ~need;
      const cost = ((extra & CLOSES) !== 0 ? 4 : 0) + ((extra & OPENS) !== 0 ? 2 : 0) + (codeBefore ? 1 : 0) + (codeAfter ? 1 : 0);
      if (cost < lowest) {
        chosen = option;
        lowest = cost;
      }
    }
    if (chosen > 0) {
      if ((chosen & 1) === 1) /** @type {TextPiece} */ (pieces[start - 1]).tail = true;
      if ((chosen & 2) === 2) /** @type {TextPiece} */ (pieces[end]).head = true;
    }
    start = end;
  }
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    let printed;
    if (piece.kind === 'mark') printed = piece.mark.repeat(piece.length);
    else if (piece.kind === 'atom') printed = piece.value;
    else printed = printText(piece);
    const next = pieces[i + 1];
    out += printed.endsWith('!') && next !== undefined && next.kind === 'atom' && next.link
      ? printed.slice(0, -1) + '\\!'
      : printed;
  }
  return out;
}

/**
 * Print a text piece, its first or last character as a reference where
 * the run beside it needs that.
 * @param {TextPiece} piece
 * @returns {string}
 */
function printText(piece) {
  const value = piece.value;
  if (!piece.head && !piece.tail) return escapeText(value);
  if (isOneCharacter(value)) return '&#' + value.codePointAt(0) + ';';
  const headPoint = /** @type {number} */ (value.codePointAt(0));
  const headLength = headPoint > 0xFFFF ? 2 : 1;
  const tailPoint = codePointBefore(value, value.length);
  const tailLength = tailPoint > 0xFFFF ? 2 : 1;
  return (piece.head ? '&#' + headPoint + ';' : escapeText(value.slice(0, headLength)))
    + escapeText(value.slice(headLength, value.length - tailLength))
    + (piece.tail ? '&#' + tailPoint + ';' : escapeText(value.slice(value.length - tailLength)));
}

/** How deep runs nest before the canonical spelling is read back to be sure: well inside the reader's own bound. */
const PLAIN_DEPTH = 32;

/**
 * Does the canonical spelling of this content read back, as far as its
 * delimiter runs go, without being read back? It does when no two runs
 * touch and each run can only open or only close where it stands: the
 * reader then pairs each closer with the nearest open run of its delimiter,
 * which is its own opener, since everything nested in the node has closed,
 * and the two are as long (CommonMark §6.2).
 * @param {MdNode[]} nodes
 * @param {number} scope the kind of character beside the content's ends
 * @param {number} depth
 * @returns {boolean}
 */
function readsBackAsIs(nodes, scope, depth) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (isBracketed(node)) {
      if (!readsBackAsIs(node.children, PUNCT, depth)) return false;
      continue;
    }
    if (!isDelimited(node)) {
      if (Array.isArray(node.children)) return false;
      continue;
    }
    const children = node.children;
    const previous = nodes[i - 1];
    const next = nodes[i + 1];
    if (children.length === 0 || depth >= PLAIN_DEPTH
      || (previous !== undefined && isDelimited(previous)) || (next !== undefined && isDelimited(next))
      || isDelimited(children[0]) || isDelimited(children[children.length - 1])) return false;
    const mark = node.type === 'strikethrough' ? '~' : '*';
    const before = previous === undefined ? scope : nodeEdge(previous, true).kind;
    const after = next === undefined ? scope : nodeEdge(next, false).kind;
    if (runAbility(mark, before, nodeEdge(children[0], false).kind) !== OPENS
      || runAbility(mark, nodeEdge(children[children.length - 1], true).kind, after) !== CLOSES
      || !readsBackAsIs(children, PUNCT, depth + 1)) return false;
  }
  return true;
}

/**
 * Does any emphasis, strong or strikethrough node sit in this content,
 * outside a link's brackets or inside them?
 * @param {MdNode[]} nodes
 * @returns {boolean}
 */
function holdsDelimited(nodes) {
  for (const node of nodes) {
    if (isEmphasisClass(node) || node.type === 'strikethrough') return true;
    if (Array.isArray(node.children) && holdsDelimited(node.children)) return true;
  }
  return false;
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

// ------------------------------------------------------------------
// The search, for content the derivation does not reach
// ------------------------------------------------------------------

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
  if (text === '') return ' ';
  return String.fromCodePoint(end ? codePointBefore(text, text.length) : /** @type {number} */ (text.codePointAt(0)));
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

/** A character of each kind (`kindOf`), as a delimiter run beside it tells them apart. */
const KIND_CHARS = [' ', '.', 'x'];

/**
 * A character of the same kind as this one, as far as a delimiter run
 * beside it can tell: a space, a punctuation mark or a letter.
 * @param {string} char
 * @returns {string}
 */
function sameKind(char) {
  return KIND_CHARS[kindOf(/** @type {number} */ (char.codePointAt(0)))];
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
 * Where each stretch of a block's content ends: wherever the join of two
 * neighbours does not have a delimiter character on both sides.
 * @param {MdNode[]} nodes
 * @returns {number[]}
 */
function stretchEnds(nodes) {
  const ends = [];
  for (let i = 1; i < nodes.length; i++) {
    if (plainEdge(nodes[i - 1], true) !== null || plainEdge(nodes[i], false) !== null) ends.push(i);
  }
  ends.push(nodes.length);
  return ends;
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
  let ends = stretchEnds(nodes);
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

/** A character a printed prefix may end on: a letter, a digit or a space, none of which a delimiter run is made of. */
const RE_CUT = /[\p{L}\p{N} ]/u;

/**
 * The opening marker an emphasis, strong or strikethrough node prints with
 * in a spelling that decides each node (`style` 4).
 * @param {MdNode} node
 * @param {PrintContext} pc
 * @returns {string}
 */
function openingMark(node, pc) {
  if (node.type === 'strikethrough') return '~~';
  const mark = underscoreFor(node, pc, 0) ? '_' : '*';
  return node.type === 'strong' ? mark + mark : mark;
}

/**
 * Adjacent text nodes joined into one, as the parser joins them.
 * @param {MdNode[]} nodes
 * @returns {MdNode[]}
 */
function joinTexts(nodes) {
  /** @type {MdNode[]} */
  const out = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.type === 'text' && last !== undefined && last.type === 'text') {
      out[out.length - 1] = { type: 'text', value: last.value + node.value };
    }
    else out.push(node);
  }
  return out;
}

/**
 * Do two lists of inline nodes read the same? A text compares by its value
 * and an emphasis, strong or strikethrough node by its children, which is
 * all a prefix's nodes differ by; any other node compares whole.
 * @param {MdNode[]} a
 * @param {MdNode[]} b
 * @returns {boolean}
 */
function sameInlines(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.type !== y.type) return false;
    if (x.type === 'text' ? x.value !== y.value
      : isEmphasisClass(x) || x.type === 'strikethrough' ? !sameInlines(x.children, y.children)
        : !equalsJson(x, y)) return false;
  }
  return true;
}

/**
 * The text of a stretch up to a character of one of its text nodes, and
 * what that text reads back as when the spelling is right: the nodes that
 * close before the character as they are, and each node still open there
 * as its opening marker in literal text, since nothing closes it yet.
 * @param {MdNode[]} nodes
 * @param {number[]} path the text node's index in each list on the way down to it
 * @param {number} depth
 * @param {number} cut the index of the last character printed
 * @param {PrintContext} pc
 * @returns {{ text: string, want: MdNode[] }}
 */
function prefixOf(nodes, path, depth, cut, pc) {
  const node = nodes[path[depth]];
  const want = nodes.slice(0, path[depth]);
  let text = printInlines(want, pc, node);
  if (depth === path.length - 1) {
    const value = node.value.slice(0, cut + 1);
    text += escapeText(value, printsBare(node, pc));
    want.push({ type: 'text', value });
  }
  else {
    const mark = openingMark(node, pc);
    const inner = prefixOf(node.children, path, depth + 1, cut, pc);
    text += mark + inner.text;
    want.push({ type: 'text', value: mark }, ...inner.want);
  }
  return { text, want: joinTexts(want) };
}

/**
 * A step of the guided search, in the order the stretch prints. A site
 * decides one emphasis or strong node's delimiter or whether one text
 * node's `*` and `_` print bare: `edge` says the text starts or ends with
 * one, which it then tries bare first, and `closes` is the number of steps
 * printed before the node's
 * closing marker. A check reads back the text printed up to a character
 * of a text node, its `cut`, found by its `path`.
 * @typedef {{ node: MdNode, text: boolean, edge: boolean, closes: number }} GuidedSite
 * @typedef {{ node: null, path: number[], cut: number }} GuidedCheck
 */

/**
 * The sites of a stretch and the checks between them. A check follows each
 * text node outside a link, at its last letter, digit or space: the parser
 * matches each closing run against the runs before it, so what every run
 * before that character reads as is settled there.
 * @param {MdNode[]} nodes
 * @param {(GuidedSite | GuidedCheck)[]} [steps]
 * @param {number[]} [path]
 * @param {boolean} [inLink]
 * @returns {(GuidedSite | GuidedCheck)[]}
 */
function guidedSteps(nodes, steps = [], path = [], inLink = false) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    path.push(i);
    const delimited = isEmphasisClass(node);
    const text = node.type === 'text' && RE_DELIMITER.test(node.value);
    /** @type {GuidedSite | null} */
    const site = delimited || text
      ? { node, text, edge: text && (RE_DELIMITER.test(node.value.charAt(0)) || RE_DELIMITER.test(node.value.charAt(node.value.length - 1))), closes: 0 }
      : null;
    if (site !== null) steps.push(site);
    if (node.type === 'text' && !inLink) {
      let cut = node.value.length - 1;
      while (cut >= 0 && !RE_CUT.test(node.value.charAt(cut))) cut--;
      if (cut >= 0) steps.push({ node: null, path: path.slice(), cut });
    }
    if (Array.isArray(node.children)) {
      guidedSteps(node.children, steps, path, inLink || !(delimited || node.type === 'strikethrough'));
    }
    if (site !== null) site.closes = steps.length;
    path.pop();
  }
  return steps;
}

/**
 * What the stretch prints as in a spelling found site by site in the order
 * the sites print, a text node that starts or ends with a `*` or `_` trying
 * them bare first and any other text escaped first. The text printed so
 * far is read back at every check, and a prefix that reads back as other
 * nodes is abandoned there: the search goes back to the last site that can
 * have caused it (one printed since the check before, or a node open across
 * that check) instead of trying every spelling of the sites after it. It
 * does not try every spelling, and it is paid from the pool; null when no
 * spelling it reaches reads back.
 * @param {Stretch} stretch
 * @param {boolean} underscore emphasis and strong try `_` before `*`
 * @returns {string | null}
 */
function guidedSpelling(stretch, underscore) {
  const steps = guidedSteps(stretch.nodes);
  /** @type {Map<MdNode, boolean>} */
  const assign = new Map();
  /** @param {GuidedSite} site */
  const reset = (site) => assign.set(site.node, site.text ? site.edge : underscore);
  for (const step of steps) if (step.node !== null) reset(step);
  const pc = { style: EMPHASIS_STYLES, depth: 0, assign };
  /** @type {number[]} the last check before each step */
  const checkBefore = [];
  for (let k = 0, last = -1; k <= steps.length; k++) {
    checkBefore.push(last);
    if (k < steps.length && steps[k].node === null) last = k;
  }
  /**
   * The sites a prefix that reads back as other nodes at step `at` is blamed on.
   * @param {number} at
   * @returns {Set<number>}
   */
  const suspects = (at) => {
    const blamed = new Set();
    for (let k = 0; k < at; k++) {
      const step = steps[k];
      if (step.node === null) continue;
      if (k > checkBefore[at] || (!step.text && step.closes > checkBefore[at])) blamed.add(k);
    }
    return blamed;
  };
  /** @type {Set<number>[]} what each site's spellings tried so far were blamed on, besides itself */
  const blame = steps.map(() => new Set());
  /** @type {Uint8Array} how many spellings of each site are tried */
  const tried = new Uint8Array(steps.length);
  let k = 0;
  while (searchPool.left > 0) {
    /** @type {Set<number>} */
    let failed;
    const step = steps[k];
    if (step === undefined) {
      const body = printInlines(stretch.nodes, pc, stretch.next);
      if (readsBody(stretch, body)) return body;
      failed = suspects(k);
    }
    else if (step.node !== null) {
      tried[k++] = 1;
      continue;
    }
    else {
      const prefix = prefixOf(stretch.nodes, step.path, 0, step.cut, pc);
      const text = stretch.before + prefix.text;
      searchPool.left -= text.length;
      const want = stretch.before === '' ? prefix.want : joinTexts([{ type: 'text', value: stretch.before }, ...prefix.want]);
      if (sameInlines(readBack(text), want)) {
        k++;
        continue;
      }
      failed = suspects(k);
    }
    // back to the last site blamed with a spelling left to try; the sites
    // from `k` on are still as they started
    for (;;) {
      let to = -1;
      for (const site of failed) if (site > to) to = site;
      if (to === -1) return null;
      for (let j = to + 1; j < k; j++) {
        const later = steps[j];
        if (later.node === null) continue;
        tried[j] = 0;
        blame[j].clear();
        reset(later);
      }
      for (const site of failed) if (site !== to) blame[to].add(site);
      const node = /** @type {MdNode} */ (steps[to].node);
      if (tried[to] === 1) {
        tried[to] = 2;
        assign.set(node, !assign.get(node));
        k = to + 1;
        break;
      }
      failed = new Set(blame[to]);
    }
  }
  return null;
}

/**
 * The guided search with emphasis and strong trying `_` first, on half of
 * what is left of the pool, then trying `*` first on the rest: a spelling
 * far from the canonical one is found by the first, one near it by the
 * second.
 * @param {Stretch} stretch
 * @returns {string | null}
 */
function guidedEitherWay(stretch) {
  const half = searchPool.left / 2;
  searchPool.left -= half;
  const body = guidedSpelling(stretch, true);
  searchPool.left += half;
  return body ?? guidedSpelling(stretch, false);
}

/**
 * Print a block's content that no spelling the search found reads back as,
 * a stretch at a time: each stretch prints canonically where that reads
 * back, else in the spelling the guided search finds, and canonically only
 * where neither does — so one stretch no search spells costs the block
 * none of the others. The guided search is paid from an allowance of its
 * own, and the call's pool is left as the search before it left it.
 * @param {MdNode[]} nodes
 * @param {number} allowance
 * @returns {string}
 */
function printStretches(nodes, allowance) {
  const kept = searchPool.left;
  searchPool.left = allowance;
  const ends = stretchEnds(nodes);
  let text = '';
  for (let k = 0, start = 0; k < ends.length; start = ends[k++]) {
    const stretch = stretchOf(nodes, start, ends[k]);
    const part = printInlines(stretch.nodes, CANONICAL, stretch.next);
    text += searchPool.left > 0 && !readsBody(stretch, part) ? guidedEitherWay(stretch) ?? part : part;
  }
  searchPool.left = kept;
  return text;
}

/**
 * Print the inline content of one block. The canonical spelling is the
 * one printed where it reads back as the same nodes; where it does not,
 * emphasis and strong take the spelling `assignMarks` derives, and where
 * that does not read back either, the spelling the search finds
 * (`searchedSpelling`). Content none reads back as is printed in the
 * derived spelling and reported to `onLossy`, when the call has one.
 * @param {MdNode[]} nodes
 * @returns {string}
 */
function printRun(nodes) {
  const canonical = printInlines(nodes, CANONICAL);
  searchPool.left += SEARCH_CHARS_PER_CHAR * canonical.length;
  if (printing.reports === null && readsBackAsIs(nodes, WHITE, 0)) return canonical;
  const delimited = holdsDelimited(nodes);
  const read = readBack(canonical);
  if (equalsJson(read, nodes)) return canonical;
  if (!delimited) {
    reportLoss(nodes, read);
    return canonical;
  }
  /** @type {Spelled} */
  const spelled = { marks: new Map(), bare: new Map(), coded: new Map() };
  assignMarks(nodes, null, WHITE_EDGE, 0, spelled);
  derived.touching.clear();
  derived.solved.clear();
  derived.runs.clear();
  const text = spellPieces(nodes, spelled, WHITE_EDGE);
  const again = readBack(text);
  if (equalsJson(again, nodes) && !startsBlock(text, true)) return text;
  // no spelling reads back as a node no Markdown reads back as
  const searched = findUnreachable(nodes, []) === null ? searchedSpelling(nodes, canonical) : null;
  if (searched !== null) return searched;
  reportLoss(nodes, again);
  return text;
}

/**
 * The spelling of a block's content the search finds, when it reads back:
 * the alternating spellings, then every combination for a short run, then
 * a search a stretch at a time, and last each stretch on its own by a
 * guided search paid from an allowance in proportion to what the block
 * prints. The searches are paid from the call's pool.
 * @param {MdNode[]} nodes
 * @param {string} canonical the canonical spelling, which does not read back
 * @returns {string | null}
 */
function searchedSpelling(nodes, canonical) {
  const whole = wholeStretch(nodes);
  const text = alternatingSpelling(whole) ?? maskedSpelling(whole, canonical.length) ?? printSegments(nodes)
    ?? printStretches(nodes, GUIDED_CHARS_PER_CHAR * canonical.length);
  return readsAs(text, nodes) && !startsBlock(text, true) ? text : null;
}

/**
 * A node `toMarkdown` prints as text that reads back as other nodes.
 * `path` leads from the document's top-level blocks to the node through
 * each node's `children` (a table's rows and cells included); `code` says
 * why, and `reason` says it in words. Three codes name nodes no Markdown
 * reads back as: `'empty'`, an emphasis, strong or strikethrough node with
 * nothing in it, whose opener and closer would be one run; `'line-edge'`,
 * one whose content starts with a soft line break or ends with a line
 * break, since a run before a line ending cannot open and one after it
 * cannot close; `'touching'`, a strikethrough touching another, whose two
 * `~~` are one run of four, which is no delimiter. `'unread'` names the
 * first node of any other content no spelling the printer derives or
 * searches out reads back as. A block's inline content is weighed as the inline reader reads
 * it, not what the block reader does around it.
 * @typedef {{ code: 'empty' | 'line-edge' | 'touching' | 'unread', path: number[], reason: string }} LossReport
 */

/**
 * Where a call to `toMarkdown` is: the path to the block it is printing,
 * and the losses found so far, when the call reports them.
 * @type {{ path: number[], reports: LossReport[] | null }}
 */
const printing = { path: [], reports: null };

/**
 * A node, as a report names what it reads back as.
 * @param {MdNode | undefined} node
 * @returns {string}
 */
function describeNode(node) {
  if (node === undefined) return 'nothing';
  return node.type === 'text' ? 'the text ' + JSON.stringify(node.value) : node.type;
}

/**
 * Report the first node of a block's content that no Markdown reads back
 * as, or else the first its printed text reads back as something else.
 * @param {MdNode[]} nodes
 * @param {MdNode[]} read what the printed text reads back as
 */
function reportLoss(nodes, read) {
  if (printing.reports === null) return;
  const unreachable = findUnreachable(nodes, []);
  if (unreachable !== null) {
    printing.reports.push({ ...unreachable, path: printing.path.concat(unreachable.path) });
    return;
  }
  /** @type {number[]} */
  const path = [];
  let want = nodes;
  let got = read;
  for (;;) {
    let i = 0;
    while (i < want.length && i < got.length && equalsJson(want[i], got[i])) i++;
    const a = want[i];
    const b = got[i];
    if (a === undefined && b === undefined) {
      printing.reports.push({ code: 'unread', path: printing.path.concat(path),
        reason: 'a line of its printed text would read back as a list item or a thematic break' });
      return;
    }
    path.push(i);
    if (a !== undefined && b !== undefined && a.type === b.type && Array.isArray(a.children) && Array.isArray(b.children)) {
      want = a.children;
      got = b.children;
      continue;
    }
    printing.reports.push({ code: 'unread', path: printing.path.concat(path),
      reason: 'no spelling the printer derives or finds reads back as it: it reads back as ' + describeNode(b) + ' where the document has ' + describeNode(a) });
    return;
  }
}

/**
 * A node type with its article.
 * @param {string} type
 * @returns {string}
 */
function article(type) {
  return (type === 'emphasis' ? 'an ' : 'a ') + type;
}

/**
 * The first node, in print order, that no Markdown reads back as.
 * @param {MdNode[]} nodes
 * @param {number[]} path
 * @returns {LossReport | null}
 */
function findUnreachable(nodes, path) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const at = path.concat(i);
    if (isDelimited(node)) {
      const children = node.children;
      const first = children[0];
      const last = children[children.length - 1];
      if (children.length === 0) {
        return { code: 'empty', path: at, reason: article(node.type) + ' node with nothing in it, whose opener and closer would be one run' };
      }
      if (first.type === 'softBreak' || last.type === 'softBreak' || last.type === 'break') {
        return { code: 'line-edge', path: at, reason: article(node.type) + ' node whose content starts with a soft line break or ends with a line break' };
      }
      const next = nodes[i + 1];
      if (node.type === 'strikethrough' && ((next !== undefined && next.type === 'strikethrough')
        || first.type === 'strikethrough' || last.type === 'strikethrough')) {
        return { code: 'touching', path: at, reason: 'a strikethrough touching another, whose two `~~` are one run of four' };
      }
    }
    if (Array.isArray(node.children)) {
      const found = findUnreachable(node.children, at);
      if (found !== null) return found;
    }
  }
  return null;
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
      printing.path.push(i);
      let body = printBlocks(items[i].children, node.tight);
      let lines = body.split('\n');
      // An item that opens with nothing but markers (`- - -`, or a rule
      // after a `*`) is a thematic break, not an item: its first block
      // takes the other spelling.
      if (scanThematicBreak(marker + check + lines[0], 0)) {
        body = printBlocks(items[i].children, node.tight, true);
        lines = body.split('\n');
      }
      printing.path.pop();
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
        printing.path.push(r, c);
        line += ' ' + guardCellEdges(printRun(cells[c].children).replace(/\n/g, ' ')) + ' |';
        printing.path.length -= 2;
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
    printing.path.push(i);
    const printed = printBlock(node, first && node.type === 'list' ? !alt : alt, first);
    printing.path.pop();
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
 * exact, syntax-neutral round-trips (MD-FORMAT.md §5). `onLossy`, when
 * given, is called once per node the printed text does not read back as,
 * after the text is printed (`LossReport`); the text is the same with or
 * without it.
 *
 * @param {any} docOrAst
 * @param {{ frontmatter?: boolean, onLossy?: (report: LossReport) => void }} [options]
 * @returns {string}
 */
export function toMarkdown(docOrAst, options = {}) {
  const onLossy = options.onLossy;
  if (onLossy !== undefined && typeof onLossy !== 'function') {
    throw new TypeError('md toMarkdown: option \'onLossy\' must be a function');
  }
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
  /** @type {LossReport[]} */
  const reports = [];
  printing.reports = onLossy === undefined ? null : reports;
  printing.path.length = 0;
  searchPool.left = SEARCH_CHARS_FLOOR;
  let body;
  try {
    body = printBlocks(ast, false);
  }
  finally {
    printing.reports = null;
    printing.path.length = 0;
  }
  if (onLossy !== undefined) {
    const seen = new Set();
    for (const report of reports) {
      const key = report.path.join('/');
      if (seen.has(key)) continue;
      seen.add(key);
      onLossy(report);
    }
  }
  return body === '' ? out : out + body + '\n';
}
