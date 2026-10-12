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
/** Line starts that would re-parse as a block construct: a list marker,
 * a blockquote, or a setext underline under the line before it. */
const RE_DANGEROUS_LINE = /^(?:(?:[-+=>]|\d{1,9}[.)])(?: |$)|[-=]{2,}[ \t]*$)/;
/** The ordinal of such a line, when it is an ordered-list marker. */
const RE_LEADING_DIGITS = /^\d{1,9}/;
/** The indent a footnote definition's later blocks are written at. */
const FOOTNOTE_CONTINUATION = '    ';

/**
 * Escape inline text so it re-parses as the same literal text.
 * @param {string} value
 * @returns {string}
 */
function escapeText(value) {
  const escaped = value.replace(RE_ESCAPE, '\\$&');
  // A newline inside a text VALUE is not a line break — the parser gives
  // those their own `softBreak` node — it came from `&#10;`, and printed
  // literally it would split the paragraph in two. A tab came from
  // `&#9;` too: a literal one reads back as spaces.
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
  if (!RE_DANGEROUS_LINE.test(line)) return line;
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
 * last resort (style 4) takes each node's spelling from a bit of `mask`,
 * in the order the nodes print.
 * @typedef {{ style: number, depth: number, mask: number, seen: { count: number } }} PrintContext
 */

/** The alternating spellings tried, in order, when the canonical one does not read back. */
const EMPHASIS_STYLES = 4;
/** The most delimiter nodes whose spellings are tried one by one (2^4 candidates). */
const MASK_NODES = 4;
/** The longest run (in printed characters) given that search: each candidate is a parse of it. */
const MASK_LENGTH = 600;

/** @type {PrintContext} */
const CANONICAL = { style: 0, depth: 0, mask: 0, seen: { count: 0 } };

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
 * @param {PrintContext} pc
 * @param {number} run emphasis-class siblings directly before the node
 * @returns {boolean}
 */
function underscoreFor(pc, run) {
  if (pc.style === 4) return ((pc.mask >> pc.seen.count++) & 1) === 1;
  const parity = (pc.depth + run) & 1;
  return pc.style === 1 ? parity === 1
    : pc.style === 2 ? parity === 0
      : pc.style === 3;
}

/**
 * Print a list of inline nodes.
 * @param {MdNode[]} nodes
 * @param {PrintContext} pc
 * @returns {string}
 */
function printInlines(nodes, pc) {
  let out = '';
  let run = 0;
  for (let i = 0; i < nodes.length; i++) {
    const printed = printInline(nodes[i], pc, run);
    run = isEmphasisClass(nodes[i]) ? run + 1 : 0;
    // A trailing `!` in front of a link is what makes an image, so text
    // that genuinely ends in one keeps its escape (`\\![foo]`).
    const next = nodes[i + 1];
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
  return { style: pc.style, depth: pc.depth + 1, mask: pc.mask, seen: pc.seen };
}

/** @type {Record<string, (node: MdNode, pc: PrintContext, run: number) => string>} */
const INLINE_PRINTERS = {
  text: (node) => escapeText(node.value),
  emphasis: (node, pc, run) => {
    if (pc.style !== 0) {
      const mark = underscoreFor(pc, run) ? '_' : '*';
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
      const mark = underscoreFor(pc, run) ? '__' : '**';
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
 * How many emphasis and strong nodes do these nodes hold, at any depth?
 * @param {MdNode[]} nodes
 * @returns {number}
 */
function countDelimiters(nodes) {
  let count = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (isEmphasisClass(nodes[i])) count++;
    if (Array.isArray(nodes[i].children)) count += countDelimiters(nodes[i].children);
  }
  return count;
}

/**
 * How many spellings the last-resort search tries: every combination for
 * a few delimiter nodes in a short run, none for more.
 * @param {MdNode[]} nodes
 * @param {string} printed
 * @returns {number}
 */
function maskCount(nodes, printed) {
  const count = countDelimiters(nodes);
  return count <= MASK_NODES && printed.length <= MASK_LENGTH ? 1 << count : 0;
}

/** Inline parse state for the read-back check: no definitions, no plugins. */
const READ_BACK = { defs: new Map(), inlines: new Map(), gfm: true, ctx: {} };

/**
 * Does this text read back as exactly these inline nodes?
 * @param {string} text
 * @param {MdNode[]} nodes
 * @returns {boolean}
 */
function readsAs(text, nodes) {
  return equalsJson(parseInlines(text, { ...READ_BACK, defs: new Map() }), nodes);
}

/**
 * Print the inline content of one block. A run of delimiters the
 * canonical spelling would merge (emphasis in emphasis, emphasis beside
 * strong) is checked against the parser, and the first spelling that
 * reads back as the same nodes is the one printed.
 * @param {MdNode[]} nodes
 * @returns {string}
 */
function printRun(nodes) {
  const canonical = printInlines(nodes, CANONICAL);
  if (!mayMergeDelimiters(nodes) || readsAs(canonical, nodes)) return canonical;
  for (let style = 1; style <= EMPHASIS_STYLES; style++) {
    const masks = style < EMPHASIS_STYLES ? 1 : maskCount(nodes, canonical);
    for (let mask = 0; mask < masks; mask++) {
      const text = printInlines(nodes, { style, depth: 0, mask, seen: { count: 0 } });
      if (readsAs(text, nodes)) return text;
    }
  }
  return canonical;
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

/** @type {Record<string, (node: MdNode, alt?: boolean, spare?: boolean) => string>} */
const BLOCK_PRINTERS = {
  paragraph: (node) => printFlow(node.children),

  heading: (node) => {
    const text = printRun(node.children);
    // An ATX heading is one line, so a heading whose text carries a soft
    // break has to print in its setext form or lose the break — which
    // only depths 1 and 2 have. Deeper headings cannot hold one: they
    // can only come from ATX in the first place.
    if (node.depth <= 2 && text.indexOf('\n') !== -1) {
      return printFlow(node.children) + '\n' + (node.depth === 1 ? '===' : '---');
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
      let item = marker + check + lines[0];
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
    let out = '[^' + (node.label ?? node.identifier) + ']: ' + lines[0];
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
  const parts = [];
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
    if (printed !== '') parts.push(printed);
  }
  return parts.join(tight ? '\n' : '\n\n');
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
  const body = printBlocks(ast, false);
  return body === '' ? out : out + body + '\n';
}
