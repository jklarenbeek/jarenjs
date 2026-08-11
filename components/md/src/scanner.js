//@ts-check
/**
 * @file Line-level scanners for the block parser.
 *
 * Pure, allocation-conscious functions that classify one (detabbed)
 * line at a char-code level: does a construct start here, and where
 * does its content begin? The parser in parser.js owns all state; this
 * module owns none. Every regular expression is compiled once at
 * module load — nothing in here builds a pattern per call.
 */

import { countIndent } from './utils.js';
import { decodeReferences } from './entities.js';

const CC_SPACE = 0x20;
const CC_HASH = 0x23;
const CC_STAR = 0x2A;
const CC_PLUS = 0x2B;
const CC_MINUS = 0x2D;
const CC_DOT = 0x2E;
const CC_RPAREN = 0x29;
const CC_LT = 0x3C;
const CC_GT = 0x3E;
const CC_EQ = 0x3D;
const CC_BACKTICK = 0x60;
const CC_TILDE = 0x7E;
const CC_UNDERSCORE = 0x5F;
const CC_PIPE = 0x7C;

/**
 * Thematic break: three or more `*`, `-` or `_` (same character),
 * interleaved with spaces, nothing else on the line.
 * @param {string} line
 * @param {number} start first non-space offset
 * @returns {boolean}
 */
export function scanThematicBreak(line, start) {
  const marker = line.charCodeAt(start);
  if (marker !== CC_STAR && marker !== CC_MINUS && marker !== CC_UNDERSCORE) {
    return false;
  }
  let count = 0;
  for (let i = start; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === marker) count++;
    else if (c !== CC_SPACE && c !== 0x09) return false;
  }
  return count >= 3;
}

/**
 * ATX heading: `#{1,6}` followed by space or end of line. Returns the
 * depth and the heading text (closing `#` run stripped), or null.
 * @param {string} line
 * @param {number} start first non-space offset
 * @returns {{ depth: number, text: string } | null}
 */
export function scanAtxHeading(line, start) {
  let depth = 0;
  let i = start;
  while (i < line.length && line.charCodeAt(i) === CC_HASH && depth < 7) {
    depth++;
    i++;
  }
  if (depth === 0 || depth > 6) return null;
  if (i < line.length && line.charCodeAt(i) !== CC_SPACE && line.charCodeAt(i) !== 0x09) {
    return null;
  }
  let end = line.length;
  while (end > i && isSpaceCode(line.charCodeAt(end - 1))) end--;
  // A trailing `#` run preceded by a space (or the opener) is a closer.
  let closer = end;
  while (closer > i && line.charCodeAt(closer - 1) === CC_HASH) closer--;
  if (closer < end && (closer === i || isSpaceCode(line.charCodeAt(closer - 1)))) {
    end = closer;
    while (end > i && isSpaceCode(line.charCodeAt(end - 1))) end--;
  }
  while (i < end && isSpaceCode(line.charCodeAt(i))) i++;
  return { depth, text: line.slice(i, end) };
}

/**
 * Code fence opener: three or more backticks or tildes. A backtick
 * fence's info string may not contain a backtick.
 * @param {string} line
 * @param {number} start first non-space offset
 * @returns {{ marker: number, length: number, info: string } | null}
 */
export function scanFenceOpen(line, start) {
  const marker = line.charCodeAt(start);
  if (marker !== CC_BACKTICK && marker !== CC_TILDE) return null;
  let i = start;
  while (i < line.length && line.charCodeAt(i) === marker) i++;
  const length = i - start;
  if (length < 3) return null;
  const info = line.slice(i).trim();
  if (marker === CC_BACKTICK && info.indexOf('`') !== -1) return null;
  return { marker, length, info };
}

/**
 * Does this line close a fence opened with `marker` × `length`?
 * @param {string} line
 * @param {number} marker
 * @param {number} length
 * @returns {boolean}
 */
export function scanFenceClose(line, marker, length) {
  const start = countIndent(line);
  if (start - 0 >= 4) return false;
  let i = start;
  while (i < line.length && line.charCodeAt(i) === marker) i++;
  if (i - start < length) return false;
  while (i < line.length) {
    if (!isSpaceCode(line.charCodeAt(i))) return false;
    i++;
  }
  return true;
}

/**
 * Split a fence info string into `lang` (first word) and `meta` (the
 * rest), resolving backslash escapes and character references in both.
 * @param {string} info
 * @returns {{ lang: string|null, meta: string|null }}
 */
export function splitFenceInfo(info) {
  if (info === '') return { lang: null, meta: null };
  let i = 0;
  while (i < info.length && !isSpaceCode(info.charCodeAt(i))) i++;
  // an info string carries escapes and references like a destination does
  const lang = decodeReferences(info.slice(0, i));
  const meta = decodeReferences(info.slice(i).trim());
  return { lang, meta: meta === '' ? null : meta };
}

/**
 * Blockquote marker at `offset`: `>` with an optional following space.
 * Returns the content offset, or -1.
 * @param {string} line
 * @param {number} offset first non-space offset
 * @returns {number}
 */
export function scanBlockquote(line, offset) {
  if (line.charCodeAt(offset) !== CC_GT) return -1;
  const next = line.charCodeAt(offset + 1);
  return next === CC_SPACE || next === 0x09 ? offset + 2 : offset + 1;
}

/**
 * List marker: `-`/`+`/`*` bullet or `1.`/`1)` ordered (start ≤ 9
 * digits), followed by a space or line end. Returns the marker
 * geometry the parser turns into a list container, or null.
 * @param {string} line
 * @param {number} start first non-space offset
 * @returns {{ ordered: boolean, bullet: string, start: number,
 *             delimiter: string, contentOffset: number } | null}
 */
export function scanListMarker(line, start) {
  const c = line.charCodeAt(start);
  let markerEnd;
  let ordered = false;
  let ordinal = 1;
  let bullet = '';
  let delimiter = '';
  if (c === CC_MINUS || c === CC_PLUS || c === CC_STAR) {
    bullet = line[start];
    markerEnd = start + 1;
  }
  else if (c >= 0x30 && c <= 0x39) {
    let i = start;
    while (i < line.length && line.charCodeAt(i) >= 0x30 && line.charCodeAt(i) <= 0x39) i++;
    if (i - start > 9) return null;
    const d = line.charCodeAt(i);
    if (d !== CC_DOT && d !== CC_RPAREN) return null;
    ordered = true;
    ordinal = Number(line.slice(start, i));
    delimiter = line[i];
    markerEnd = i + 1;
  }
  else {
    return null;
  }
  const after = line.charCodeAt(markerEnd);
  if (!Number.isNaN(after) && after !== CC_SPACE && after !== 0x09) return null;
  // Content begins after the marker and 1–4 following spaces; more
  // than 4 (or a blank rest) means content at marker + 1 (indented
  // code / empty item semantics).
  let content = markerEnd;
  while (content < line.length && line.charCodeAt(content) === CC_SPACE) content++;
  const gap = content - markerEnd;
  if (content >= line.length || gap > 4) content = markerEnd + 1;
  return { ordered, bullet, start: ordinal, delimiter, contentOffset: content };
}

/**
 * Setext underline under an open paragraph: `=` run (depth 1) or `-`
 * run (depth 2), possibly space-padded. Returns 0 when neither.
 * @param {string} line
 * @param {number} start first non-space offset
 * @returns {number}
 */
export function scanSetextUnderline(line, start) {
  const marker = line.charCodeAt(start);
  if (marker !== CC_EQ && marker !== CC_MINUS) return 0;
  let i = start;
  while (i < line.length && line.charCodeAt(i) === marker) i++;
  while (i < line.length) {
    if (!isSpaceCode(line.charCodeAt(i))) return 0;
    i++;
  }
  return marker === CC_EQ ? 1 : 2;
}

/**
 * GFM table delimiter row: cells of `---`, `:--`, `--:`, `:-:` split
 * by pipes. Returns the alignment array, or null.
 * @param {string} line
 * @returns {(string|null)[] | null}
 */
export function scanTableDelimiter(line) {
  const cells = splitTableRow(line);
  if (cells === null || cells.length === 0) return null;
  /** @type {(string|null)[]} */
  const align = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i].trim();
    if (cell.length === 0) return null;
    const left = cell.charCodeAt(0) === 0x3A;
    const right = cell.charCodeAt(cell.length - 1) === 0x3A;
    const dashes = cell.slice(left ? 1 : 0, right ? cell.length - 1 : cell.length);
    if (dashes.length === 0) return null;
    for (let d = 0; d < dashes.length; d++) {
      if (dashes.charCodeAt(d) !== CC_MINUS) return null;
    }
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
}

/**
 * Split a table row into raw cell strings on unescaped `|`, honoring
 * `\|` and pipes inside backtick code spans. Leading and trailing
 * empty cells from outer pipes are dropped. Returns null when the line
 * contains no pipe at all.
 * @param {string} line
 * @returns {string[] | null}
 */
export function splitTableRow(line) {
  let text = line.trim();
  if (text.indexOf('|') === -1) return null;
  /** @type {string[]} */
  const cells = [];
  let cell = '';
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x5C /* \ */ && text.charCodeAt(i + 1) === CC_PIPE) {
      cell += text.slice(start, i) + '|';
      i += 2;
      start = i;
      continue;
    }
    if (c === CC_BACKTICK) {
      // Skip the code span verbatim so pipes inside it do not split.
      let run = i;
      while (run < text.length && text.charCodeAt(run) === CC_BACKTICK) run++;
      const fence = text.slice(i, run);
      const close = text.indexOf(fence, run);
      if (close !== -1) {
        let closeEnd = close;
        while (closeEnd < text.length && text.charCodeAt(closeEnd) === CC_BACKTICK) closeEnd++;
        if (closeEnd - close === fence.length) {
          i = closeEnd;
          continue;
        }
      }
      i = run;
      continue;
    }
    if (c === CC_PIPE) {
      cells.push(cell + text.slice(start, i));
      cell = '';
      i++;
      start = i;
      continue;
    }
    i++;
  }
  cells.push(cell + text.slice(start));
  if (cells.length > 0 && cells[0].trim() === '' && text.charCodeAt(0) === CC_PIPE) {
    cells.shift();
  }
  if (cells.length > 0 && cells[cells.length - 1].trim() === ''
    && text.charCodeAt(text.length - 1) === CC_PIPE) {
    cells.pop();
  }
  return cells;
}

/** HTML block openers, CommonMark types 1–7 (compiled once). */
const RE_HTML_TYPE1 = /^<(?:script|pre|style|textarea)(?:\s|>|$)/i;
const RE_HTML_TYPE6 = /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i;
const RE_HTML_TYPE7 = /^<(?:[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|\/[a-zA-Z][a-zA-Z0-9-]*\s*>)\s*$/;

/** Closers for html block types 1–5 (type ↦ substring that ends it). */
const RE_HTML_END = [
  /$^/, // unused index 0
  /<\/(?:script|pre|style|textarea)>/i,
  /-->/,
  /\?>/,
  />/,
  /\]\]>/,
];

/**
 * Classify an HTML block opener at `start` (CommonMark types 1–7);
 * 0 means no HTML block starts here. Type 7 is only valid when no
 * paragraph is open — the caller passes `paragraphOpen`.
 * @param {string} line
 * @param {number} start first non-space offset
 * @param {boolean} paragraphOpen
 * @returns {number}
 */
export function scanHtmlBlockStart(line, start, paragraphOpen) {
  if (line.charCodeAt(start) !== CC_LT) return 0;
  const rest = start === 0 ? line : line.slice(start);
  if (RE_HTML_TYPE1.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![a-zA-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  if (RE_HTML_TYPE6.test(rest)) return 6;
  if (!paragraphOpen && RE_HTML_TYPE7.test(rest)) return 7;
  return 0;
}

/**
 * Does this line end an HTML block of `kind`? Types 6/7 end on the
 * following blank line (the parser checks that); types 1–5 end on a
 * content condition, which may sit on the opening line itself.
 * @param {number} kind
 * @param {string} line
 * @returns {boolean}
 */
export function scanHtmlBlockEnd(kind, line) {
  if (kind >= 6) return false;
  return RE_HTML_END[kind].test(line);
}

/**
 * Is this char code a space or tab?
 * @param {number} c
 * @returns {boolean}
 */
export function isSpaceCode(c) {
  return c === CC_SPACE || c === 0x09;
}

/**
 * Link reference definition at the start of a closed paragraph's text:
 * `[label]: destination "title"` (title optional, may be single-,
 * double- or paren-quoted; destination may be `<>`-wrapped). Returns
 * the definition and the offset after it, or null.
 * @param {string} text the paragraph's raw text
 * @param {number} pos
 * @returns {{ label: string, url: string, title: string|null, end: number } | null}
 */
export function scanLinkDefinition(text, pos) {
  if (text.charCodeAt(pos) !== 0x5B /* [ */) return null;
  let i = pos + 1;
  const labelStart = i;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    // A backslash escape delimits but does not RESOLVE here: labels
    // match on the text as written, so `[foo\!]` and `[foo!]` are two
    // different definitions (and the reference side reads it the same
    // way).
    if (c === 0x5C) { i += 2; continue; }
    if (c === 0x5D /* ] */) break;
    if (c === 0x5B) return null;
    i++;
  }
  const label = text.slice(labelStart, Math.min(i, text.length));
  if (i >= text.length || label.trim() === '' || label.length > 999) return null;
  if (text.charCodeAt(i + 1) !== 0x3A /* : */) return null;
  i += 2;
  while (i < text.length && (isSpaceCode(text.charCodeAt(i)) || text.charCodeAt(i) === 0x0A)) i++;
  const wrapped = text.charCodeAt(i) === 0x3C /* < */;
  const dest = scanLinkDestination(text, i);
  // `<>` names an empty destination on purpose; nothing at all does not.
  if (dest === null || (dest.url === '' && !wrapped)) return null;
  i = dest.end;
  let j = i;
  while (j < text.length && isSpaceCode(text.charCodeAt(j))) j++;
  const sawNewline = text.charCodeAt(j) === 0x0A;
  if (sawNewline) j++;
  while (j < text.length && isSpaceCode(text.charCodeAt(j))) j++;
  // The title must be separated from the destination by whitespace, so
  // `[foo]: <bar>(baz)` is not a definition at all — it is a paragraph.
  const title = j > i ? scanLinkTitle(text, j) : null;
  if (title !== null) {
    let k = title.end;
    while (k < text.length && isSpaceCode(text.charCodeAt(k))) k++;
    if (k >= text.length || text.charCodeAt(k) === 0x0A) {
      return { label: normalizeLabel(label), url: dest.url, title: title.title, end: k + 1 };
    }
  }
  // No (valid) title: the definition ends at its own line end.
  while (i < text.length && isSpaceCode(text.charCodeAt(i))) i++;
  if (i < text.length && text.charCodeAt(i) !== 0x0A) return null;
  return { label: normalizeLabel(label), url: dest.url, title: null, end: i + 1 };
}

/**
 * Scan a link destination at `pos`: `<...>` wrapped or a run of
 * non-space characters with balanced parens.
 * @param {string} text
 * @param {number} pos
 * @returns {{ url: string, end: number } | null}
 */
export function scanLinkDestination(text, pos) {
  // The raw range is decoded in ONE pass at the end (escapes and
  // character references together): unescaping while scanning would let
  // a backslash-escaped `&` start an entity in the next pass.
  if (text.charCodeAt(pos) === CC_LT) {
    let i = pos + 1;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === CC_GT) return { url: decodeReferences(text.slice(pos + 1, i)), end: i + 1 };
      if (c === CC_LT || c === 0x0A) return null;
      i += c === 0x5C && i + 1 < text.length ? 2 : 1;
    }
    return null;
  }
  let i = pos;
  let depth = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c <= 0x20) break;
    if (c === 0x5C && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (c === 0x28 /* ( */) depth++;
    if (c === CC_RPAREN) {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  if (depth !== 0) return null;
  return i === pos ? null : { url: decodeReferences(text.slice(pos, i)), end: i };
}

/**
 * Scan a link title at `pos`: `"..."`, `'...'` or `(...)`.
 * @param {string} text
 * @param {number} pos
 * @returns {{ title: string, end: number } | null}
 */
export function scanLinkTitle(text, pos) {
  const open = text.charCodeAt(pos);
  if (open !== 0x22 && open !== 0x27 && open !== 0x28) return null;
  const close = open === 0x28 ? CC_RPAREN : open;
  let i = pos + 1;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === close) return { title: decodeReferences(text.slice(pos + 1, i)), end: i + 1 };
    if (open === 0x28 && c === 0x28) return null;
    i += c === 0x5C && i + 1 < text.length ? 2 : 1;
  }
  return null;
}

// ------------------------------------------------------------------
// Character classes (the flanking rules and the autolink grammar)
// ------------------------------------------------------------------

/** ASCII punctuation membership (emphasis flanking, backslash escapes). */
export const ASCII_PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASCII_PUNCT[ch.charCodeAt(0)] = 1;

/**
 * The flanking rules — and the autolink grammar's notion of a host
 * character — are defined over UNICODE classes, not ASCII: a
 * "whitespace character" is Zs plus tab/LF/FF/CR (so a no-break space
 * ends a delimiter run), and a "punctuation character" is anything in
 * P* **or** S* (so `£` and `€` are punctuation, while a letter is not).
 * Both are consulted only for code points outside ASCII, which the table
 * above answers without allocating.
 */
const RE_UNICODE_WS = /[\p{Zs}\t\n\f\r]/u;
const RE_UNICODE_PUNCT = /[\p{P}\p{S}]/u;

/**
 * Is this code point a whitespace character in the spec's sense?
 * @param {number} point
 * @returns {boolean}
 */
export function isUnicodeWhitespace(point) {
  if (point < 128) return point === 0x20 || point === 0x0A || point === 0x09;
  return RE_UNICODE_WS.test(String.fromCodePoint(point));
}

/**
 * Is this code point a punctuation character in the spec's sense (P* or S*)?
 * @param {number} point
 * @returns {boolean}
 */
export function isUnicodePunctuation(point) {
  if (point < 128) return ASCII_PUNCT[point] === 1;
  return RE_UNICODE_PUNCT.test(String.fromCodePoint(point));
}

/**
 * The whole code point ending at `pos`, so a run preceded by an astral
 * symbol classifies on the symbol and not on a surrogate half.
 * @param {string} src @param {number} pos
 * @returns {number}
 */
export function codePointBefore(src, pos) {
  const low = src.charCodeAt(pos - 1);
  if (low >= 0xdc00 && low <= 0xdfff && pos >= 2) {
    const high = src.charCodeAt(pos - 2);
    if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + low - 0xdc00 + 0x10000;
  }
  return low;
}

/**
 * Normalize a link label for matching: trim, collapse internal
 * whitespace runs to one space, and case fold.
 *
 * The fold is lower→upper→lower, not `toLowerCase()`: the spec asks for
 * Unicode case folding, under which `ẞ` matches `SS`, while lower-casing
 * alone maps `ẞ` to `ß` and never meets `ss`. The round trip routes both
 * spellings through the same expansion (`ẞ`→`ß`→`SS`→`ss`, and `ﬁ`→`fi`),
 * which is as close to the full fold as a zero-dependency package gets
 * without shipping the table.
 * @param {string} label
 * @returns {string}
 */
export function normalizeLabel(label) {
  return label.trim().replace(/[ \t\n]+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// ------------------------------------------------------------------
// GFM footnotes
// ------------------------------------------------------------------

/**
 * A footnote label: `[^` + one or more characters that are not `]`, `[`
 * or whitespace. The no-whitespace rule is the reference
 * implementation's and it applies to BOTH sides — a definition and a
 * reference are recognized by the same grammar, so `[^my note]` is
 * neither, rather than one without the other (MD-FORMAT.md §4.6).
 * Returns the offset of the `]`, or -1.
 * @param {string} text
 * @param {number} start offset of the `[`
 * @returns {number}
 */
function scanFootnoteLabel(text, start) {
  if (text.charCodeAt(start) !== 0x5B /* [ */ || text.charCodeAt(start + 1) !== 0x5E /* ^ */) {
    return -1;
  }
  let i = start + 2;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x5D /* ] */) return i > start + 2 ? i : -1;
    if (c === 0x5B /* [ */ || c === 0x20 || c === 0x09 || c === 0x0A) return -1;
    i++;
  }
  return -1;
}

/**
 * Footnote definition opener: `[^label]:` and the spaces after it.
 * @param {string} line
 * @param {number} start first non-space offset
 * @returns {{ label: string, contentOffset: number } | null}
 */
export function scanFootnoteDefinition(line, start) {
  const close = scanFootnoteLabel(line, start);
  if (close === -1 || line.charCodeAt(close + 1) !== 0x3A /* : */) return null;
  let i = close + 2;
  while (i < line.length && isSpaceCode(line.charCodeAt(i))) i++;
  return { label: line.slice(start + 2, close), contentOffset: i };
}

/**
 * Footnote reference: `[^label]` in inline text.
 * @param {string} text
 * @param {number} start offset of the `[`
 * @returns {{ label: string, end: number } | null}
 */
export function scanFootnoteReference(text, start) {
  const close = scanFootnoteLabel(text, start);
  return close === -1 ? null : { label: text.slice(start + 2, close), end: close + 1 };
}

// ------------------------------------------------------------------
// GFM autolink literals
// ------------------------------------------------------------------

/** Is this an ASCII letter or digit? */
function isAsciiAlnum(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
}

/**
 * A character that may carry a domain: alphanumerics, `-` and `_`, plus
 * any non-ASCII character that is neither whitespace nor punctuation
 * (so an internationalized domain autolinks and an em dash after one
 * does not).
 * @param {number} c
 * @returns {boolean}
 */
function isDomainChar(c) {
  if (c < 128) return isAsciiAlnum(c) || c === 0x2D /* - */ || c === 0x5F /* _ */;
  return !isUnicodeWhitespace(c) && !isUnicodePunctuation(c);
}

/** An email local-part character: alphanumeric, `.`, `-`, `_` or `+`. */
function isEmailLocalChar(c) {
  return isAsciiAlnum(c)
    || c === 0x2E /* . */ || c === 0x2D /* - */ || c === 0x5F /* _ */ || c === 0x2B /* + */;
}

/**
 * A literal autolink may only begin at the start of the text, after
 * whitespace, or after one of `*`, `_`, `~`, `(` (GFM §Autolinks). The
 * start of a text node counts: what precedes it is a sibling node, not a
 * character, and a `www.` there is as unambiguous as one after a space.
 * @param {string} text @param {number} pos
 * @returns {boolean}
 */
function isAutolinkStart(text, pos) {
  if (pos === 0) return true;
  const c = text.charCodeAt(pos - 1);
  return c === 0x20 || c === 0x09 || c === 0x0A
    || c === 0x2A /* * */ || c === 0x5F /* _ */ || c === 0x7E /* ~ */ || c === 0x28 /* ( */;
}

/**
 * A valid domain at `pos`: segments of domain characters separated by
 * periods, at least one period, no underscore in the last two segments.
 * A trailing period is not part of the domain. Returns the end offset,
 * or -1.
 *
 * `underscores` relaxes the last-two-segments rule for the email
 * grammar, which states only that the last character may not be `-` or
 * `_` — the two grammars really do differ, and `foo@a_b.example` is a
 * link while `www.a_b.example` is not.
 * @param {string} text @param {number} pos @param {boolean} underscores
 * @returns {number}
 */
function scanAutolinkDomain(text, pos, underscores) {
  let i = pos;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 0x2E /* . */ && !isDomainChar(c)) break;
    i++;
  }
  while (i > pos && text.charCodeAt(i - 1) === 0x2E) i--;
  if (i === pos) return -1;
  const segments = text.slice(pos, i).split('.');
  if (segments.length < 2 || segments[segments.length - 1] === '') return -1;
  if (!underscores) {
    if (segments[segments.length - 1].indexOf('_') !== -1) return -1;
    if (segments[segments.length - 2].indexOf('_') !== -1) return -1;
  }
  return i;
}

/**
 * Extended autolink path validation (GFM §Autolinks): pull trailing
 * punctuation back out of the link. `?!.,:*_~` always; a `)` only while
 * the link holds more of them than `(`; a `;` only when it closes an
 * entity-shaped tail (`&copy;`), which is why the whole `&…;` goes and
 * not just the semicolon.
 * @param {string} text @param {number} start @param {number} end
 * @returns {number}
 */
function trimAutolinkEnd(text, start, end) {
  while (end > start) {
    const c = text.charCodeAt(end - 1);
    if (c === 0x3F || c === 0x21 || c === 0x2E || c === 0x2C
      || c === 0x3A || c === 0x2A || c === 0x5F || c === 0x7E) {
      end--;
      continue;
    }
    if (c === 0x3B /* ; */) {
      let j = end - 2;
      while (j > start && isAsciiAlnum(text.charCodeAt(j))) j--;
      if (j < end - 2 && text.charCodeAt(j) === 0x26 /* & */) {
        end = j;
        continue;
      }
      break;
    }
    if (c === 0x29 /* ) */) {
      let open = 0;
      let close = 0;
      for (let k = start; k < end; k++) {
        const d = text.charCodeAt(k);
        if (d === 0x28) open++;
        else if (d === 0x29) close++;
      }
      if (close <= open) break;
      end--;
      continue;
    }
    break;
  }
  return end;
}

/** The URL tail after a domain: any run of non-space, non-`<` characters. */
function scanAutolinkTail(text, pos) {
  let i = pos;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x3C /* < */) break;
    i++;
  }
  return i;
}

/**
 * The schemes that open an extended url autolink. Matching is
 * case-SENSITIVE, here and for `www.`: the reference implementation
 * compares bytes, so `WWW.EXAMPLE.COM` is not a link on GitHub either,
 * and this package's promise is that a document renders the same in
 * both places — not that it renders more.
 */
const AUTOLINK_SCHEMES = ['http://', 'https://', 'ftp://'];

/**
 * Find every extended autolink in one text value (GFM §Autolinks): bare
 * `www.…`, `http://…`, `https://…`, `ftp://…` and email addresses.
 * Returns the matches in order, or `null` when there are none — the
 * common answer, and the one that costs nothing.
 *
 * This works on a TEXT VALUE and not on the source, which is what makes
 * the entity rule meaningful: `&copy;` has already become `©` by the
 * time we look, so the only `&…;` left to exclude is one that was never
 * an entity in the first place.
 * @param {string} value
 * @returns {{ start: number, end: number, url: string }[] | null}
 */
export function scanAutolinkLiterals(value) {
  /** @type {{ start: number, end: number, url: string }[] | null} */
  let out = null;
  let i = 0;
  let floor = 0;
  while (i < value.length) {
    const c = value.charCodeAt(i);
    /** @type {{ start: number, end: number, url: string } | null} */
    let hit = null;
    if (c === 0x40 /* @ */) {
      hit = matchEmail(value, i, floor);
    }
    else if (c === 0x77 /* w */ && isAutolinkStart(value, i)) {
      hit = matchWww(value, i);
    }
    else if ((c === 0x68 /* h */ || c === 0x66 /* f */) && isAutolinkStart(value, i)) {
      hit = matchScheme(value, i);
    }
    if (hit === null) {
      i++;
      continue;
    }
    if (out === null) out = [];
    out.push(hit);
    i = hit.end;
    floor = hit.end;
  }
  return out;
}

/**
 * `www.` + a valid domain + a path tail; the scheme is inserted, so the
 * AST holds the destination a browser would follow and no consumer has
 * to re-derive it.
 * @param {string} value @param {number} pos
 */
function matchWww(value, pos) {
  if (!value.startsWith('www.', pos)) return null;
  const domain = scanAutolinkDomain(value, pos + 4, false);
  if (domain === -1) return null;
  const end = trimAutolinkEnd(value, pos, scanAutolinkTail(value, domain));
  if (end <= pos + 4) return null;
  return { start: pos, end, url: 'http://' + value.slice(pos, end) };
}

/**
 * `http://`, `https://` or `ftp://` + a valid domain + a path tail.
 * @param {string} value @param {number} pos
 */
function matchScheme(value, pos) {
  for (let s = 0; s < AUTOLINK_SCHEMES.length; s++) {
    const scheme = AUTOLINK_SCHEMES[s];
    if (!value.startsWith(scheme, pos)) continue;
    const domain = scanAutolinkDomain(value, pos + scheme.length, false);
    if (domain === -1) continue;
    const end = trimAutolinkEnd(value, pos, scanAutolinkTail(value, domain));
    if (end <= pos + scheme.length) continue;
    return { start: pos, end, url: value.slice(pos, end) };
  }
  return null;
}

/**
 * An email address around the `@` at `at`. The local part is found by
 * walking BACK — the address is the only autolink whose start is left of
 * its trigger — and never back past `floor`, the end of the previous
 * match. The path-validation trim does not apply: the grammar rejects an
 * address ending in `-` or `_` outright rather than shortening it.
 * @param {string} value @param {number} at @param {number} floor
 */
function matchEmail(value, at, floor) {
  let start = at;
  while (start > floor && isEmailLocalChar(value.charCodeAt(start - 1))) start--;
  if (start === at || !isAutolinkStart(value, start)) return null;
  const end = scanAutolinkDomain(value, at + 1, true);
  if (end === -1) return null;
  const last = value.charCodeAt(end - 1);
  if (last === 0x2D /* - */ || last === 0x5F /* _ */) return null;
  return { start, end, url: 'mailto:' + value.slice(start, end) };
}
