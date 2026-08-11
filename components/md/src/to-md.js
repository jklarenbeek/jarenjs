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
  // literally it would split the paragraph in two.
  return escaped.indexOf('\n') === -1 ? escaped : escaped.replace(/\n/g, '&#10;');
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
 * Print a list of inline nodes.
 * @param {MdNode[]} nodes
 * @returns {string}
 */
function printInlines(nodes) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const printed = printInline(nodes[i]);
    // A trailing `!` in front of a link is what makes an image, so text
    // that genuinely ends in one keeps its escape (`\\![foo]`).
    const next = nodes[i + 1];
    out += printed.endsWith('!') && next !== undefined && next.type === 'link'
      ? printed.slice(0, -1) + '\\!'
      : printed;
  }
  return out;
}

/** @type {Record<string, (node: MdNode) => string>} */
const INLINE_PRINTERS = {
  text: (node) => escapeText(node.value),
  emphasis: (node) => {
    const inner = printInlines(node.children);
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
  strong: (node) => '**' + printInlines(node.children) + '**',
  strikethrough: (node) => '~~' + printInlines(node.children) + '~~',
  inlineCode: (node) => printCodeSpan(node.value),
  // A GFM literal autolink prints as the bare text it was written as
  // (escaped, so `*` in a query string cannot open emphasis on the way
  // back in) — the one place the `auto` flag earns its keep.
  link: (node) => (node.auto === true
    ? printInlines(node.children)
    : isAutolink(node)
      ? '<' + node.url.replace(/^mailto:/, '') + '>'
      : '[' + printInlines(node.children) + '](' + printLinkTarget(node) + ')'),
  image: (node) => '![' + escapeText(node.alt) + '](' + printLinkTarget(node) + ')',
  break: () => '\\\n',
  softBreak: () => '\n',
  html: (node) => node.value,
  footnoteReference: (node) => '[^' + (node.label ?? node.identifier) + ']',
};

/**
 * Print one inline node (unknown types degrade to their text content).
 * @param {MdNode} node
 * @returns {string}
 */
function printInline(node) {
  const printer = INLINE_PRINTERS[node.type];
  if (printer !== undefined) return printer(node);
  if (Array.isArray(node.children)) return printInlines(node.children);
  return typeof node.value === 'string' ? escapeText(node.value) : '';
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
  const shown = url.startsWith('mailto:') ? url.slice(7) : url;
  return only.value === shown && !/[\s<>]/.test(shown);
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

/**
 * Print a link/image destination (+ optional title).
 * @param {MdNode} node
 * @returns {string}
 */
function printLinkTarget(node) {
  const url = /** @type {string} */ (node.url);
  const wrapped = url === '' || /[\s()]/.test(url) ? '<' + url.replace(/[<>]/g, '\\$&') + '>' : url;
  return node.title == null
    ? wrapped
    : wrapped + ' "' + node.title.replace(/"/g, '\\"') + '"';
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
  const out = printInlines(children);
  if (out.indexOf('\n') === -1) return guardLineStart(out);
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) lines[i] = guardLineStart(lines[i]);
  return lines.join('\n');
}

/** @type {Record<string, (node: MdNode) => string>} */
const BLOCK_PRINTERS = {
  paragraph: (node) => printFlow(node.children),

  heading: (node) => {
    const text = printInlines(node.children);
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
  thematicBreak: () => '***',

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
      const body = printBlocks(items[i].children, node.tight);
      const lines = body.split('\n');
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
        line += ' ' + printInlines(cells[c].children).replace(/\n/g, ' ') + ' |';
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
  const info = lang === null ? '' : meta === null ? lang : lang + ' ' + meta;
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
  return fence + info + '\n' + body + fence;
}

/**
 * Print one block node. Unknown types with a string `value` print as a
 * fence tagged with the type (a compiled-in plugin's fence claim then
 * round-trips); container-shaped unknowns print their children.
 * @param {MdNode} node
 * @param {boolean} [alt] use the alternate list marker (see printBlocks)
 * @returns {string}
 */
function printBlock(node, alt) {
  const printer = BLOCK_PRINTERS[node.type];
  if (printer !== undefined) return printer(node, alt);
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
 * @returns {string}
 */
function printBlocks(blocks, tight) {
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
    const printed = printBlock(node, alt);
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
