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
  let label = '';
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x5C) {
      label += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === 0x5D /* ] */) break;
    if (c === 0x5B) return null;
    label += text[i];
    i++;
  }
  if (i >= text.length || label.trim() === '' || label.length > 999) return null;
  if (text.charCodeAt(i + 1) !== 0x3A /* : */) return null;
  i += 2;
  while (i < text.length && (isSpaceCode(text.charCodeAt(i)) || text.charCodeAt(i) === 0x0A)) i++;
  const dest = scanLinkDestination(text, i);
  if (dest === null || dest.url === '') return null;
  i = dest.end;
  let j = i;
  while (j < text.length && isSpaceCode(text.charCodeAt(j))) j++;
  const sawNewline = text.charCodeAt(j) === 0x0A;
  if (sawNewline) j++;
  while (j < text.length && isSpaceCode(text.charCodeAt(j))) j++;
  const title = scanLinkTitle(text, j);
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

/**
 * Normalize a link label: trim, collapse internal whitespace, case
 * fold (Unicode-aware lowercasing suffices for matching).
 * @param {string} label
 * @returns {string}
 */
export function normalizeLabel(label) {
  return label.trim().replace(/[ \t\n]+/g, ' ').toLowerCase();
}
