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
/** Line starts that would re-parse as a block construct. */
const RE_DANGEROUS_LINE = /^(?:[-+=>]|\d{1,9}[.)])(?: |$)/;

/**
 * Escape inline text so it re-parses as the same literal text.
 * @param {string} value
 * @returns {string}
 */
function escapeText(value) {
  return value.replace(RE_ESCAPE, '\\$&');
}

/**
 * Escape a printed paragraph/cell line that would otherwise open a
 * block construct at line start.
 * @param {string} line
 * @returns {string}
 */
function guardLineStart(line) {
  return RE_DANGEROUS_LINE.test(line) ? '\\' + line : line;
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
  for (let i = 0; i < nodes.length; i++) out += printInline(nodes[i]);
  return out;
}

/** @type {Record<string, (node: MdNode) => string>} */
const INLINE_PRINTERS = {
  text: (node) => escapeText(node.value),
  emphasis: (node) => '*' + printInlines(node.children) + '*',
  strong: (node) => '**' + printInlines(node.children) + '**',
  strikethrough: (node) => '~~' + printInlines(node.children) + '~~',
  inlineCode: (node) => printCodeSpan(node.value),
  link: (node) => '[' + printInlines(node.children) + '](' + printLinkTarget(node) + ')',
  image: (node) => '![' + escapeText(node.alt) + '](' + printLinkTarget(node) + ')',
  break: () => '\\\n',
  softBreak: () => '\n',
  html: (node) => node.value,
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

  heading: (node) => '#'.repeat(node.depth) + ' ' + printInlines(node.children),

  thematicBreak: () => '---',

  blockquote: (node) => {
    const inner = printBlocks(node.children, false);
    const lines = inner.split('\n');
    for (let i = 0; i < lines.length; i++) {
      lines[i] = lines[i] === '' ? '>' : '> ' + lines[i];
    }
    return lines.join('\n');
  },

  list: (node) => {
    const items = node.children;
    const parts = [];
    let ordinal = node.ordered ? (node.start ?? 1) : 0;
    for (let i = 0; i < items.length; i++) {
      const marker = node.ordered ? `${ordinal + i}. ` : '- ';
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
  let longest = 2;
  let run = 0;
  for (let i = 0; i < value.length; i++) {
    run = value.charCodeAt(i) === 0x60 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const fence = '`'.repeat(longest + 1);
  const info = lang === null ? '' : meta === null ? lang : lang + ' ' + meta;
  const body = value === '' ? '' : value.endsWith('\n') ? value : value + '\n';
  return fence + info + '\n' + body + fence;
}

/**
 * Print one block node. Unknown types with a string `value` print as a
 * fence tagged with the type (a compiled-in plugin's fence claim then
 * round-trips); container-shaped unknowns print their children.
 * @param {MdNode} node
 * @returns {string}
 */
function printBlock(node) {
  const printer = BLOCK_PRINTERS[node.type];
  if (printer !== undefined) return printer(node);
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
  for (let i = 0; i < blocks.length; i++) {
    const printed = printBlock(blocks[i]);
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
