//@ts-check
/**
 * @file Frontmatter extraction: YAML subset, JSON and TOML → plain JSON.
 *
 * Frontmatter is detected at the very top of the source only:
 *
 *  - `---`     opens a YAML-subset block, closed by `---` or `...`
 *  - `---json` opens a JSON block, closed by `---`
 *  - `{`       (as the first character) opens a JSON object closed by a
 *              line that is exactly `}`
 *  - `+++`     opens a TOML block, closed by `+++`
 *
 * Whatever the syntax, the result normalizes to one plain JSON value on
 * the document. The parsers are written from scratch and dependency-free;
 * an external TOML parser (e.g. `parseToml` from `@jarenjs/josl`) can be
 * injected through `options.toml` to replace the built-in TOML subset.
 *
 * The YAML subset (normative limits in docs/MD-FORMAT.md §3):
 * scalars (null/booleans/numbers/strings), single- and double-quoted
 * strings, block maps and sequences by indentation (`- - a` included),
 * flow arrays and maps (multi-line while brackets are open), literal `|`
 * and folded `>` block scalars with `-` chomping, and `#` comments. No
 * anchors, no aliases, no tags, no multi-document streams, no complex
 * keys. Every syntax bounds its nesting (MD-FORMAT §1.4), so any
 * frontmatter value can be walked recursively.
 */

import { setObjectMember } from '@jarenjs/core/object';
import { countIndent, isBlankLine, MAX_NESTING } from './utils.js';

/** Raised for malformed frontmatter inside a detected fence. */
export class MdFrontmatterError extends Error {
  /**
   * @param {string} message
   * @param {number} line 0-based line index inside the frontmatter block
   */
  constructor(message, line) {
    super(`md frontmatter: ${message} (line ${line + 1})`);
    this.name = 'MdFrontmatterError';
    this.line = line;
  }
}

const RE_NUMBER = /^[+-]?(?:\d+|\d*\.\d+|\d+\.\d*)(?:[eE][+-]?\d+)?$/;
const RE_TOML_NUMBER = /^[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|(?:\d[\d_]*)(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)$/;

/**
 * Split frontmatter off the top of a Markdown source.
 *
 * @param {string} source
 * @param {{ toml?: (text: string) => any }} [options]
 * @returns {{ data: any, body: string, lang: 'yaml'|'json'|'toml'|null }}
 */
export function parseFrontmatter(source, options = undefined) {
  if (source.length === 0) return { data: null, body: source, lang: null };
  const c0 = source.charCodeAt(0);
  if (c0 === 0x2D /* - */) {
    if (startsWithLine(source, '---json')) {
      const block = sliceFenced(source, '---json'.length, '---');
      if (block !== null) {
        return { data: parseJsonBlock(block.text), body: block.body, lang: 'json' };
      }
    }
    else if (startsWithLine(source, '---')) {
      const block = sliceFenced(source, 3, '---', '...');
      if (block !== null) {
        return { data: parseYamlSubset(block.text), body: block.body, lang: 'yaml' };
      }
    }
  }
  else if (c0 === 0x2B /* + */ && startsWithLine(source, '+++')) {
    const block = sliceFenced(source, 3, '+++');
    if (block !== null) {
      const data = options !== undefined && typeof options.toml === 'function'
        ? refuseDeepValue(options.toml(block.text))
        : parseTomlSubset(block.text);
      return { data, body: block.body, lang: 'toml' };
    }
  }
  else if (c0 === 0x7B /* { */) {
    const block = sliceJsonObject(source);
    if (block !== null) {
      return { data: block.data, body: block.body, lang: 'json' };
    }
  }
  return { data: null, body: source, lang: null };
}

/**
 * Does the source start with `marker` as a complete first line?
 * @param {string} source
 * @param {string} marker
 * @returns {boolean}
 */
function startsWithLine(source, marker) {
  if (!source.startsWith(marker)) return false;
  const next = source.charCodeAt(marker.length);
  return Number.isNaN(next) || next === 0x0A || next === 0x0D;
}

/**
 * Slice the text between an opening marker (already matched at position
 * 0, `openLength` chars) and the first closing marker line. Returns
 * `null` when no closing line exists — the document has no frontmatter.
 * @param {string} source
 * @param {number} openLength
 * @param {...string} closers
 * @returns {{ text: string, body: string } | null}
 */
function sliceFenced(source, openLength, ...closers) {
  let pos = source.indexOf('\n', openLength);
  if (pos === -1) return null;
  const start = pos + 1;
  while (pos !== -1) {
    const lineStart = pos + 1;
    let lineEnd = source.indexOf('\n', lineStart);
    const hardEnd = lineEnd === -1 ? source.length : lineEnd;
    const line = source.slice(lineStart, trimmedEnd(source, lineStart, hardEnd));
    if (closers.includes(line)) {
      return {
        text: source.slice(start, lineStart),
        body: lineEnd === -1 ? '' : source.slice(lineEnd + 1),
      };
    }
    pos = lineEnd;
  }
  return null;
}

/**
 * Parse the JSON frontmatter form that starts at `{` on line one and
 * closes at the first line that is exactly `}`. Returns `null` when the
 * shape does not hold (the `{` was just paragraph text).
 * @param {string} source
 * @returns {{ data: any, body: string } | null}
 */
function sliceJsonObject(source) {
  let pos = 0;
  while (pos < source.length) {
    let lineEnd = source.indexOf('\n', pos);
    const hardEnd = lineEnd === -1 ? source.length : lineEnd;
    const line = source.slice(pos, trimmedEnd(source, pos, hardEnd));
    if (line === '}') {
      const text = source.slice(0, hardEnd);
      let data;
      try {
        data = JSON.parse(text);
      }
      catch {
        return null;
      }
      refuseDeepJson(text);
      return { data, body: lineEnd === -1 ? '' : source.slice(lineEnd + 1) };
    }
    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }
  return null;
}

/**
 * Where the line `[start, end)` of `source` ends once its trailing
 * spaces, tabs and carriage returns are dropped. Scanning back from the
 * end touches only those; a `/[ \t\r]+$/` replace retried from every
 * blank inside the line, so a long run of blanks before a word cost time
 * quadratic in its length.
 * @param {string} source
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function trimmedEnd(source, start, end) {
  while (end > start) {
    const c = source.charCodeAt(end - 1);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0D) break;
    end--;
  }
  return end;
}

/**
 * Parse a `---json` block (JSON.parse with a located error).
 * @param {string} text
 * @returns {any}
 */
function parseJsonBlock(text) {
  let data;
  try {
    data = JSON.parse(text);
  }
  catch (err) {
    throw new MdFrontmatterError(
      `invalid JSON: ${/** @type {Error} */ (err).message}`, 0);
  }
  refuseDeepJson(text);
  return data;
}

/**
 * How deep JSON frontmatter, and the value an injected TOML parser
 * returns, may nest: twice `MAX_NESTING`, the deepest a YAML or TOML
 * block builds — block collections or tables `MAX_NESTING` deep holding
 * flow collections as deep again. Any frontmatter md parsed therefore
 * parses back from the `---json` block `toMarkdown` prints for it.
 */
const MAX_DATA_NESTING = 2 * MAX_NESTING;

/**
 * Refuse JSON text that nests deeper than {@link MAX_DATA_NESTING}, at
 * the line of the first opener past the bound. The text has already
 * parsed, so outside its strings every `[` and `{` opens one level and
 * every `]` and `}` closes one: a count, never a stack or a recursion,
 * however deep the text.
 * @param {string} text
 */
function refuseDeepJson(text) {
  // fewer characters than a bound's worth of openers and closers
  if (text.length <= 2 * MAX_DATA_NESTING) return;
  let depth = 0;
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22 /* " */) {
      // a string: on to its closing quote (it cannot hold a raw newline)
      for (i++; i < text.length; i++) {
        const s = text.charCodeAt(i);
        if (s === 0x5C /* \ */) i++;
        else if (s === 0x22) break;
      }
    }
    else if (c === 0x5B || c === 0x7B) {
      if (++depth > MAX_DATA_NESTING) {
        throw new MdFrontmatterError(`objects and arrays nest deeper than ${MAX_DATA_NESTING}`, line);
      }
    }
    else if (c === 0x5D || c === 0x7D) depth--;
    else if (c === 0x0A) line++;
  }
}

/**
 * The value an injected TOML parser returned, refused when it nests
 * deeper than {@link MAX_DATA_NESTING}: md cannot see the text's lines
 * through a host parser, so the walk measures the value itself — with an
 * explicit stack, stopping at the first level past the bound, so neither
 * a value too deep to recurse over nor a cyclic one escapes it.
 * @param {any} value
 * @returns {any}
 */
function refuseDeepValue(value) {
  /** @type {unknown[]} */
  const nodes = [value];
  /** @type {number[]} */
  const depths = [1];
  while (nodes.length > 0) {
    const node = nodes.pop();
    const depth = /** @type {number} */ (depths.pop());
    if (node === null || typeof node !== 'object') continue;
    if (depth > MAX_DATA_NESTING) {
      throw new MdFrontmatterError(`the TOML parser's result nests deeper than ${MAX_DATA_NESTING}`, 0);
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === 'object') {
        nodes.push(child);
        depths.push(depth + 1);
      }
    }
  }
  return value;
}

// ------------------------------------------------------------------
// YAML subset
// ------------------------------------------------------------------

/**
 * Parse the YAML subset into plain JSON.
 * @param {string} text
 * @returns {any}
 */
export function parseYamlSubset(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.endsWith('\r')) lines[i] = line.slice(0, -1);
  }
  const state = { lines, pos: 0, depth: 0 };
  skipYamlVoid(state);
  if (state.pos >= lines.length) return {};
  const value = parseYamlNode(state, countIndent(lines[state.pos]));
  skipYamlVoid(state);
  if (state.pos < lines.length) {
    throw new MdFrontmatterError('trailing content after the root value', state.pos);
  }
  return value;
}

/**
 * `depth` counts the block collections (maps and sequences) open around
 * the line at `pos`.
 * @typedef {{ lines: string[], pos: number, depth: number }} YamlState
 */

/**
 * Open one more block collection at `state.pos`. Past `MAX_NESTING` the
 * subset refuses, as it does for flow collections, before the recursive
 * descent can run out of stack; the caller closes it with
 * `state.depth--` once its collection is read.
 * @param {YamlState} state
 */
function openBlock(state) {
  if (++state.depth > MAX_NESTING) {
    throw new MdFrontmatterError(`block collections nest deeper than ${MAX_NESTING}`, state.pos);
  }
}

/**
 * Advance past blank and comment-only lines.
 * @param {YamlState} state
 */
function skipYamlVoid(state) {
  while (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    if (!isBlankLine(line) && line.charCodeAt(countIndent(line)) !== 0x23 /* # */) {
      return;
    }
    state.pos++;
  }
}

/**
 * Parse the block node whose first line sits at `indent`.
 * @param {YamlState} state
 * @param {number} indent
 * @returns {any}
 */
function parseYamlNode(state, indent) {
  const line = state.lines[state.pos];
  const content = line.slice(indent);
  return isSeqDash(content)
    ? parseYamlSeq(state, indent)
    : parseYamlMap(state, indent);
}

/**
 * Is this trimmed-left content a sequence entry (`- item` or a lone `-`)?
 * @param {string} content
 * @returns {boolean}
 */
function isSeqDash(content) {
  return content.charCodeAt(0) === 0x2D
    && (content.length === 1 || content.charCodeAt(1) === 0x20);
}

/**
 * Parse a block map at `indent`.
 * @param {YamlState} state
 * @param {number} indent
 * @returns {Record<string, any>}
 */
function parseYamlMap(state, indent) {
  openBlock(state);
  /** @type {Record<string, any>} */
  const out = {};
  while (state.pos < state.lines.length) {
    skipYamlVoid(state);
    if (state.pos >= state.lines.length) break;
    const line = state.lines[state.pos];
    const li = countIndent(line);
    if (li < indent) break;
    if (li > indent) {
      throw new MdFrontmatterError('unexpected indentation', state.pos);
    }
    if (isSeqDash(line.slice(indent))) break;
    const entry = splitYamlKey(line, indent, state.pos);
    state.pos++;
    setObjectMember(out, entry.key, parseYamlValue(state, entry.rest, indent));
  }
  state.depth--;
  return out;
}

/**
 * Parse a block sequence at `indent`. With `inline`, its first entry
 * starts on the current line at that column, after the dash of the entry
 * that holds the sequence (`- - a`): that line is indented less than
 * `indent`, so only the entries after it are matched by their indentation.
 * @param {YamlState} state
 * @param {number} indent
 * @param {boolean} [inline=false]
 * @returns {any[]}
 */
function parseYamlSeq(state, indent, inline = false) {
  openBlock(state);
  /** @type {any[]} */
  const out = [];
  for (let first = inline; state.pos < state.lines.length; first = false) {
    if (!first) {
      skipYamlVoid(state);
      if (state.pos >= state.lines.length) break;
      const line = state.lines[state.pos];
      if (countIndent(line) !== indent || !isSeqDash(line.slice(indent))) break;
    }
    const line = state.lines[state.pos];
    let restColumn = indent + 1;
    while (restColumn < line.length && line.charCodeAt(restColumn) === 0x20) restColumn++;
    const rest = line.slice(restColumn);
    if (rest === '' || rest.charCodeAt(0) === 0x23 /* # */) {
      // `-` alone: the item is the following deeper block, or null — an
      // entry at the dash's own indent is its sibling, not its value.
      state.pos++;
      out.push(parseYamlNested(state, indent, null, false));
    }
    else if (isSeqDash(rest)) {
      // `- - a`: the item is a sequence whose first entry is the second
      // dash; the entries after it sit at that dash's column.
      out.push(parseYamlSeq(state, restColumn, true));
    }
    else if (findKeyColon(rest) !== -1) {
      // `- key: value`: an inline map item; re-enter the map parser at
      // the rest's column by blanking the dash out of the current line.
      state.lines[state.pos] = ' '.repeat(restColumn) + rest;
      out.push(parseYamlMap(state, restColumn));
    }
    else {
      state.pos++;
      out.push(parseYamlInline(state, rest, indent));
    }
  }
  state.depth--;
  return out;
}

/**
 * Parse the value of a map entry: inline scalar/flow, block scalar, or
 * a nested block on the following lines.
 * @param {YamlState} state
 * @param {string} rest text after `key:` (left-trimmed)
 * @param {number} indent the map's indent
 * @returns {any}
 */
function parseYamlValue(state, rest, indent) {
  if (rest === '' || rest.charCodeAt(0) === 0x23 /* # */) {
    return parseYamlNested(state, indent, null, true);
  }
  return parseYamlInline(state, rest, indent);
}

/**
 * Parse a value that starts on the line just read, after a key or a
 * dash: a block scalar whose lines are indented deeper than `indent`, or
 * an inline flow collection or scalar.
 * @param {YamlState} state
 * @param {string} rest the value's text on its first line (left-trimmed)
 * @param {number} indent the indent of the owning key or dash
 * @returns {any}
 */
function parseYamlInline(state, rest, indent) {
  const c0 = rest.charCodeAt(0);
  if (c0 === 0x7C /* | */ || c0 === 0x3E /* > */) {
    const header = rest.split('#')[0].trim();
    if (header === '|' || header === '|-' || header === '>' || header === '>-') {
      return parseYamlBlockScalar(state, indent, header);
    }
  }
  return parseYamlFlowOrScalar(state, rest, state.pos - 1);
}

/**
 * Parse the nested block value after a key or a lone dash at `indent`: a
 * deeper block node; after a key, also a sequence at the key's own indent
 * (a sequence MAY sit at its parent key's indent); else `fallback`. After
 * a lone dash, an entry at the dash's indent is the dash's sibling.
 * @param {YamlState} state
 * @param {number} indent
 * @param {any} fallback
 * @param {boolean} afterKey whether a key, rather than a dash, owns the value
 * @returns {any}
 */
function parseYamlNested(state, indent, fallback, afterKey) {
  const mark = state.pos;
  skipYamlVoid(state);
  if (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    const li = countIndent(line);
    if (li > indent) return parseYamlNode(state, li);
    if (afterKey && li === indent && isSeqDash(line.slice(li))) return parseYamlSeq(state, li);
  }
  state.pos = mark;
  return fallback;
}

/**
 * Parse a `|`/`>` block scalar. The chomp `-` drops the final newline.
 * The first line with content sets the block's indentation: a line
 * indented less ends the block (as one no deeper than the owner does),
 * a blank line reaching past it keeps the blanks beyond it, and a blank
 * line before it may not reach past it.
 * @param {YamlState} state
 * @param {number} indent indent of the owning key or dash
 * @param {string} header `|`, `|-`, `>` or `>-`
 * @returns {string}
 */
function parseYamlBlockScalar(state, indent, header) {
  /** @type {string[]} */
  const raw = [];
  let blockIndent = -1;
  // the deepest blank line before the first line with content, and where it is
  let leadingDepth = 0;
  let leadingLine = -1;
  while (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    if (isBlankLine(line)) {
      if (blockIndent === -1 && countIndent(line) > leadingDepth) {
        leadingDepth = countIndent(line);
        leadingLine = state.pos;
      }
      raw.push(blockIndent !== -1 && line.length > blockIndent ? line.slice(blockIndent) : '');
      state.pos++;
      continue;
    }
    const li = countIndent(line);
    if (li <= indent || (blockIndent !== -1 && li < blockIndent)) break;
    if (blockIndent === -1) {
      if (leadingDepth > li) {
        throw new MdFrontmatterError('a blank line before the first line of a block scalar is indented deeper than it', leadingLine);
      }
      blockIndent = li;
    }
    raw.push(line.slice(blockIndent));
    state.pos++;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  // no content: no final line break for the chomp to keep
  if (raw.length === 0) return '';
  const text = header.charCodeAt(0) === 0x7C /* | */ ? raw.join('\n') : foldLines(raw);
  return header.length === 2 ? text : text + '\n';
}

/**
 * Fold the lines of a `>` block scalar as YAML does: a line break between
 * two lines of text becomes a space, but where empty lines come between
 * them only those remain, one line break each; a break next to a line
 * that starts with a blank — more indented than the block — is kept, and
 * so are the empty lines after it.
 * @param {string[]} lines the block's lines, its indentation removed
 * @returns {string}
 */
function foldLines(lines) {
  let text = '';
  let empty = 0;
  /** @type {string | null} */
  let previous = null;
  for (const line of lines) {
    if (line === '') {
      empty++;
      continue;
    }
    if (previous === null) text = '\n'.repeat(empty) + line;
    else if (isSpacedLine(previous) || isSpacedLine(line)) text += '\n'.repeat(empty + 1) + line;
    else text += empty === 0 ? ' ' + line : '\n'.repeat(empty) + line;
    previous = line;
    empty = 0;
  }
  return text;
}

/**
 * Does a block scalar line (its indentation removed) start with a blank?
 * @param {string} line
 * @returns {boolean}
 */
function isSpacedLine(line) {
  const c = line.charCodeAt(0);
  return c === 0x20 || c === 0x09;
}

/**
 * Split a map line into its key and the value text after the colon.
 * @param {string} line
 * @param {number} indent
 * @param {number} lineNo
 * @returns {{ key: string, rest: string, restColumn: number }}
 */
function splitYamlKey(line, indent, lineNo) {
  const content = line.slice(indent);
  const colon = findKeyColon(content);
  if (colon === -1) {
    throw new MdFrontmatterError(`expected 'key: value', got '${content.trim()}'`, lineNo);
  }
  let key = content.slice(0, colon).trim();
  if (key.length > 1) {
    const q = key.charCodeAt(0);
    if ((q === 0x22 || q === 0x27) && key.charCodeAt(key.length - 1) === q) {
      key = String(parseQuoted(key, 0, /** @type {'"'|"'"} */ (key[0]), lineNo).value);
    }
  }
  // spaces or tabs separate the value from the colon
  let restColumn = indent + colon + 1;
  while (restColumn < line.length
    && (line.charCodeAt(restColumn) === 0x20 || line.charCodeAt(restColumn) === 0x09)) restColumn++;
  return { key, rest: line.slice(restColumn), restColumn };
}

/**
 * Find the `:` that separates a key from its value: followed by a space
 * or end of line, outside quotes and flow brackets. Returns -1 when the
 * content is not a map entry.
 * @param {string} content
 * @returns {number}
 */
function findKeyColon(content) {
  let depth = 0;
  let quote = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote && !(quote === 0x22 && content.charCodeAt(i - 1) === 0x5C)) quote = 0;
      continue;
    }
    if (c === 0x22 || c === 0x27) quote = c;
    else if (c === 0x5B || c === 0x7B) depth++;
    else if (c === 0x5D || c === 0x7D) depth--;
    else if (c === 0x3A && depth === 0) {
      const next = content.charCodeAt(i + 1);
      if (Number.isNaN(next) || next === 0x20 || next === 0x09) {
        return i === 0 ? -1 : i;
      }
    }
  }
  return -1;
}

/**
 * Parse an inline value: flow collection (joining following lines while
 * brackets stay open) or scalar.
 * @param {YamlState} state
 * @param {string} rest
 * @param {number} lineNo
 * @returns {any}
 */
function parseYamlFlowOrScalar(state, rest, lineNo) {
  const c0 = rest.charCodeAt(0);
  if (c0 === 0x5B /* [ */ || c0 === 0x7B /* { */) {
    // every line, the first included, loses its comment before it joins
    const scan = flowScan(true);
    let text = rest.slice(0, scanFlowLine(scan, rest));
    let last = lineNo;
    while (scan.depth > 0 && state.pos < state.lines.length) {
      const more = ' ' + state.lines[state.pos].trim();
      text += more.slice(0, scanFlowLine(scan, more));
      last = state.pos++;
    }
    if (scan.depth !== 0) {
      throw new MdFrontmatterError('unterminated flow collection', lineNo);
    }
    const flow = parseFlowValue(text, 0, lineNo);
    if (text.slice(flow.end).trim() !== '') {
      throw new MdFrontmatterError('trailing content after a flow collection', last);
    }
    return flow.value;
  }
  const scalar = stripComment(rest);
  if (isSeqDash(scalar)) {
    // `key: - a` is no string: YAML refuses a sequence on its key's line
    // (a dash after a dash is a nested sequence, read before this)
    throw new MdFrontmatterError('a sequence entry cannot start on the line of its key', lineNo);
  }
  return parseYamlScalar(scalar, lineNo);
}

/**
 * The reading of a flow collection that spans lines: its net bracket
 * depth, brackets inside quotes ignored, and the quote it is inside,
 * which a quoted scalar may carry onto the next line.
 * @typedef {{ depth: number, quote: number, previous: number, comments: boolean }} FlowScan
 */

/**
 * Start reading a flow collection. With `comments`, a `#` outside
 * quotes that starts a line or follows a space or tab begins a YAML
 * comment, which runs to the end of its line.
 * @param {boolean} comments
 * @returns {FlowScan}
 */
function flowScan(comments) {
  return { depth: 0, quote: 0, previous: 0x20, comments };
}

/**
 * Read one more line of a flow collection into `scan`. Only the new line
 * is read: rescanning the joined text after every continuation line made
 * a long flow collection quadratic.
 * @param {FlowScan} scan
 * @param {string} segment
 * @returns {number} the length of `segment` before its comment
 */
function scanFlowLine(scan, segment) {
  let { depth, quote, previous } = scan;
  let end = segment.length;
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote && !(quote === 0x22 && previous === 0x5C)) quote = 0;
    }
    else if (c === 0x23 /* # */ && scan.comments && (previous === 0x20 || previous === 0x09)) {
      end = i;
      break;
    }
    else if (c === 0x22 || c === 0x27) quote = c;
    else if (c === 0x5B || c === 0x7B) depth++;
    else if (c === 0x5D || c === 0x7D) depth--;
    previous = c;
  }
  scan.depth = depth;
  scan.quote = quote;
  scan.previous = previous;
  return end;
}

/**
 * Strip a ` #comment` tail from a plain scalar (quote-aware).
 * @param {string} text
 * @returns {string}
 */
function stripComment(text) {
  let quote = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote && !(quote === 0x22 && text.charCodeAt(i - 1) === 0x5C)) quote = 0;
    }
    else if (c === 0x22 || c === 0x27) quote = c;
    else if (c === 0x23 && i > 0) {
      const prev = text.charCodeAt(i - 1);
      if (prev === 0x20 || prev === 0x09) return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

/**
 * Parse a scalar: quoted string, null, boolean, number, or plain string.
 * @param {string} text trimmed scalar text
 * @param {number} lineNo
 * @returns {any}
 */
function parseYamlScalar(text, lineNo) {
  if (text === '') return null;
  const c0 = text.charCodeAt(0);
  if (c0 === 0x22 || c0 === 0x27) {
    const quoted = parseQuoted(text, 0, /** @type {'"'|"'"} */ (text[0]), lineNo);
    // after the closing quote, only a comment (its `#` may follow the quote directly)
    const tail = text.slice(quoted.end).trimStart();
    if (tail !== '' && tail.charCodeAt(0) !== 0x23 /* # */) {
      throw new MdFrontmatterError('trailing content after a quoted string', lineNo);
    }
    return quoted.value;
  }
  switch (text) {
    case 'null': case 'Null': case 'NULL': case '~': return null;
    case 'true': case 'True': case 'TRUE': return true;
    case 'false': case 'False': case 'FALSE': return false;
    default: break;
  }
  if (RE_NUMBER.test(text)) return Number(text);
  return text;
}

/**
 * Parse a quoted string starting at `pos`. Double quotes take JSON-style
 * escapes; single quotes escape only `''` → `'`.
 * @param {string} text
 * @param {number} pos
 * @param {'"'|"'"} quote
 * @param {number} lineNo
 * @returns {{ value: string, end: number }}
 */
function parseQuoted(text, pos, quote, lineNo) {
  let out = '';
  let i = pos + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, end: i + 1 };
    }
    if (quote === '"' && ch === '\\') {
      const esc = text[i + 1];
      switch (esc) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case '0': out += '\0'; break;
        case 'u':
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16) || 0);
          i += 4;
          break;
        default: out += esc ?? '';
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  throw new MdFrontmatterError('unterminated quoted string', lineNo);
}

/**
 * The refusal of a flow collection nested past `MAX_NESTING`: the bound
 * the Markdown body nests by, applied before the recursive descent can
 * run out of stack.
 * @param {number} lineNo
 * @returns {MdFrontmatterError}
 */
function nestedTooDeep(lineNo) {
  return new MdFrontmatterError(`flow collections nest deeper than ${MAX_NESTING}`, lineNo);
}

/**
 * Parse a flow value (`[...]`, `{...}`, quoted or plain scalar) inside a
 * single-line flow text.
 * @param {string} text
 * @param {number} pos
 * @param {number} lineNo
 * @param {boolean} [key=false] whether a colon ends a map key
 * @param {number} [depth=0] how many flow collections enclose the value
 * @returns {{ value: any, end: number }}
 */
function parseFlowValue(text, pos, lineNo, key = false, depth = 0) {
  while (pos < text.length && text.charCodeAt(pos) === 0x20) pos++;
  const c = text.charCodeAt(pos);
  if (c === 0x5B /* [ */) return parseFlowSeq(text, pos, lineNo, depth + 1);
  if (c === 0x7B /* { */) return parseFlowMap(text, pos, lineNo, depth + 1);
  if (c === 0x22 || c === 0x27) {
    return parseQuoted(text, pos, /** @type {'"'|"'"} */ (text[pos]), lineNo);
  }
  // `-` then a blank (a line break joins as one) opens a block sequence
  // entry, which a flow collection cannot hold; `-`, `-1` and `-a` are text
  if (c === 0x2D /* - */ && (text.charCodeAt(pos + 1) === 0x20 || text.charCodeAt(pos + 1) === 0x09)) {
    throw new MdFrontmatterError('a sequence entry inside a flow collection', lineNo);
  }
  let end = pos;
  let open = 0;
  while (end < text.length) {
    const cc = text.charCodeAt(end);
    if (open === 0 && (cc === 0x2C || cc === 0x5D || cc === 0x7D)) break;
    if (open === 0 && cc === 0x3A
      && (key || end + 1 === text.length || /[\s,[\]{}]/.test(text[end + 1]))) break;
    if (cc === 0x5B || cc === 0x7B) open++;
    else if (cc === 0x5D || cc === 0x7D) open--;
    end++;
  }
  return { value: parseYamlScalar(text.slice(pos, end).trim(), lineNo), end };
}

/**
 * Parse a bracketed flow array `[a, b, ...]`; shared by the YAML flow
 * sequence and the TOML flow array, which differ only in start offset,
 * item parser and error message.
 * @param {string} text
 * @param {number} pos index of `[`
 * @param {number} lineNo
 * @param {(text: string, pos: number, lineNo: number, depth: number) => { value: any, end: number }} parseItem
 * @param {string} unterminated - error message for a missing `]`
 * @param {number} depth the array's own nesting depth (1 at the top)
 * @returns {{ value: any[], end: number }}
 */
function parseFlowArray(text, pos, lineNo, parseItem, unterminated, depth) {
  if (depth > MAX_NESTING) throw nestedTooDeep(lineNo);
  /** @type {any[]} */
  const out = [];
  let i = pos + 1;
  for (;;) {
    while (i < text.length && (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x2C)) i++;
    if (i >= text.length) throw new MdFrontmatterError(unterminated, lineNo);
    if (text.charCodeAt(i) === 0x5D /* ] */) return { value: out, end: i + 1 };
    const item = parseItem(text, i, lineNo, depth);
    if (item.end <= i) throw new MdFrontmatterError('expected a flow array item', lineNo);
    out.push(item.value);
    i = item.end;
  }
}

/**
 * One item of a flow sequence (never a map key).
 * @param {string} text @param {number} pos @param {number} lineNo
 * @param {number} depth the enclosing sequence's depth
 * @returns {{ value: any, end: number }}
 */
function parseFlowItem(text, pos, lineNo, depth) {
  return parseFlowValue(text, pos, lineNo, false, depth);
}

/**
 * Parse a flow sequence `[a, b, ...]`.
 * @param {string} text
 * @param {number} pos index of `[`
 * @param {number} lineNo
 * @param {number} depth the sequence's own nesting depth
 * @returns {{ value: any[], end: number }}
 */
function parseFlowSeq(text, pos, lineNo, depth) {
  return parseFlowArray(text, pos, lineNo, parseFlowItem, 'unterminated flow sequence', depth);
}

/**
 * Parse a flow map `{a: 1, b: 2}`.
 * @param {string} text
 * @param {number} pos index of `{`
 * @param {number} lineNo
 * @param {number} depth the map's own nesting depth
 * @returns {{ value: Record<string, any>, end: number }}
 */
function parseFlowMap(text, pos, lineNo, depth) {
  if (depth > MAX_NESTING) throw nestedTooDeep(lineNo);
  /** @type {Record<string, any>} */
  const out = {};
  let i = pos + 1;
  for (;;) {
    while (i < text.length && (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x2C)) i++;
    if (i >= text.length) throw new MdFrontmatterError('unterminated flow map', lineNo);
    if (text.charCodeAt(i) === 0x7D /* } */) return { value: out, end: i + 1 };
    const key = parseFlowValue(text, i, lineNo, true, depth);
    i = key.end;
    while (i < text.length && text.charCodeAt(i) === 0x20) i++;
    if (text.charCodeAt(i) !== 0x3A /* : */) {
      throw new MdFrontmatterError("expected ':' in flow map", lineNo);
    }
    const value = parseFlowValue(text, i + 1, lineNo, false, depth);
    setObjectMember(out, String(key.value), value.value);
    i = value.end;
  }
}

// ------------------------------------------------------------------
// TOML subset (the built-in fallback; inject @jarenjs/josl's parseToml
// through options.toml for the full language)
// ------------------------------------------------------------------

/**
 * Parse the built-in TOML subset: `[table]` and `[[array-of-tables]]`
 * headers with dotted paths, bare/quoted/dotted keys, basic and literal
 * strings, integers (decimal/hex/octal/binary, `_` separators), floats,
 * booleans, single- or multi-line flow arrays, inline tables, and `#`
 * comments. Datetimes are kept as strings; multi-line strings are not
 * supported (normative limits in docs/MD-FORMAT.md §3.3).
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseTomlSubset(text) {
  /** @type {Record<string, any>} */
  const root = {};
  let table = root;
  // how many tables (and arrays of tables) enclose `table`'s keys, the root included
  let tableDepth = 1;
  const lines = text.split('\n');
  for (let no = 0; no < lines.length; no++) {
    let line = lines[no];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    line = line.trim();
    if (line === '' || line.charCodeAt(0) === 0x23 /* # */) continue;
    if (line.charCodeAt(0) === 0x5B /* [ */) {
      const isArray = line.charCodeAt(1) === 0x5B;
      const close = line.indexOf(isArray ? ']]' : ']');
      if (close === -1) throw new MdFrontmatterError('unterminated table header', no);
      const path = parseTomlKeyPath(line.slice(isArray ? 2 : 1, close), no);
      ({ table, depth: tableDepth } = descendTomlTable(root, path, isArray, no));
      continue;
    }
    const eq = findTomlEquals(line);
    if (eq === -1) throw new MdFrontmatterError(`expected 'key = value', got '${line}'`, no);
    const path = parseTomlKeyPath(line.slice(0, eq), no);
    // every segment before the last opens (or enters) one table deeper
    if (tableDepth + path.length - 1 > MAX_NESTING) throw tablesTooDeep(no);
    let valueText = stripTomlComment(line.slice(eq + 1)).trim();
    // Comments end at each physical line, before continuation lines join.
    const scan = flowScan(false);
    scanFlowLine(scan, valueText);
    while (scan.depth > 0 && no + 1 < lines.length) {
      const more = ' ' + stripTomlComment(lines[++no]).trim();
      valueText += more;
      scanFlowLine(scan, more);
    }
    let target = table;
    for (let i = 0; i < path.length - 1; i++) {
      const step = path[i];
      if (!Object.hasOwn(target, step) || typeof target[step] !== 'object') {
        const next = {};
        setObjectMember(target, step, next);
        target = next;
      }
      else {
        target = target[step];
      }
    }
    setObjectMember(target, path[path.length - 1], parseTomlValue(valueText, no));
  }
  return root;
}

/**
 * Find the `=` of a key/value line, outside quotes.
 * @param {string} line
 * @returns {number}
 */
function findTomlEquals(line) {
  let quote = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    }
    else if (c === 0x22 || c === 0x27) quote = c;
    else if (c === 0x3D /* = */) return i;
  }
  return -1;
}

/**
 * Strip a ` # comment` tail outside quotes.
 * @param {string} text
 * @returns {string}
 */
function stripTomlComment(text) {
  let quote = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote && !(quote === 0x22 && text.charCodeAt(i - 1) === 0x5C)) quote = 0;
    }
    else if (c === 0x22 || c === 0x27) quote = c;
    else if (c === 0x23 /* # */) return text.slice(0, i);
  }
  return text;
}

/**
 * Parse a dotted key path (`a.b."c.d"`).
 * @param {string} text
 * @param {number} no
 * @returns {string[]}
 */
function parseTomlKeyPath(text, no) {
  /** @type {string[]} */
  const out = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && text.charCodeAt(i) === 0x20) i++;
    const c = text.charCodeAt(i);
    if (c === 0x22 || c === 0x27) {
      const q = parseQuoted(text, i, /** @type {'"'|"'"} */ (text[i]), no);
      out.push(q.value);
      i = q.end;
    }
    else {
      let end = i;
      while (end < text.length) {
        const cc = text.charCodeAt(end);
        if (cc === 0x2E /* . */ || cc === 0x20) break;
        end++;
      }
      if (end === i) throw new MdFrontmatterError('empty key segment', no);
      out.push(text.slice(i, end));
      i = end;
    }
    while (i < text.length && text.charCodeAt(i) === 0x20) i++;
    if (i < text.length) {
      if (text.charCodeAt(i) !== 0x2E) {
        throw new MdFrontmatterError(`unexpected '${text[i]}' in key`, no);
      }
      i++;
    }
  }
  if (out.length === 0) throw new MdFrontmatterError('empty key', no);
  return out;
}

/**
 * The refusal of tables — opened by headers, arrays of tables and dotted
 * keys — nested past `MAX_NESTING`, the root table included: the bound
 * YAML's block collections keep.
 * @param {number} lineNo
 * @returns {MdFrontmatterError}
 */
function tablesTooDeep(lineNo) {
  return new MdFrontmatterError(`tables nest deeper than ${MAX_NESTING}`, lineNo);
}

/**
 * Walk (creating) the table a `[header]` names; `[[header]]` appends a
 * fresh table to the named array. The depth counts every table and array
 * of tables from the root (1) down to the table returned.
 * @param {Record<string, any>} root
 * @param {string[]} path
 * @param {boolean} isArray
 * @param {number} no
 * @returns {{ table: Record<string, any>, depth: number }}
 */
function descendTomlTable(root, path, isArray, no) {
  let target = root;
  let depth = 1;
  for (let i = 0; i < path.length - 1; i++) {
    const step = path[i];
    let next = Object.hasOwn(target, step) ? target[step] : undefined;
    if (next === undefined) {
      next = {};
      setObjectMember(target, step, next);
    }
    else if (Array.isArray(next)) {
      next = next[next.length - 1];
      depth++;
    }
    if (typeof next !== 'object' || next === null) {
      throw new MdFrontmatterError(`'${step}' is not a table`, no);
    }
    if (++depth > MAX_NESTING) throw tablesTooDeep(no);
    target = next;
  }
  const leaf = path[path.length - 1];
  if (isArray) {
    let arr = Object.hasOwn(target, leaf) ? target[leaf] : undefined;
    if (arr === undefined) {
      arr = [];
      setObjectMember(target, leaf, arr);
    }
    if (!Array.isArray(arr)) throw new MdFrontmatterError(`'${leaf}' is not an array of tables`, no);
    if (depth + 2 > MAX_NESTING) throw tablesTooDeep(no);
    const fresh = {};
    arr.push(fresh);
    return { table: fresh, depth: depth + 2 };
  }
  let next = Object.hasOwn(target, leaf) ? target[leaf] : undefined;
  if (next === undefined) {
    next = {};
    setObjectMember(target, leaf, next);
  }
  else if (Array.isArray(next)) {
    next = next[next.length - 1];
    depth++;
  }
  if (typeof next !== 'object' || next === null) {
    throw new MdFrontmatterError(`'${leaf}' is not a table`, no);
  }
  if (++depth > MAX_NESTING) throw tablesTooDeep(no);
  return { table: next, depth };
}

/**
 * Parse a TOML value.
 * @param {string} text
 * @param {number} no
 * @returns {any}
 */
function parseTomlValue(text, no) {
  if (text === '') throw new MdFrontmatterError('missing value', no);
  const c0 = text.charCodeAt(0);
  if (c0 === 0x22 || c0 === 0x27) {
    return parseQuoted(text, 0, /** @type {'"'|"'"} */ (text[0]), no).value;
  }
  if (c0 === 0x5B /* [ */) return parseTomlArray(text, no, 1).value;
  if (c0 === 0x7B /* { */) return parseTomlInline(text, no, 1).value;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (RE_TOML_NUMBER.test(text)) {
    const plain = text.replace(/_/g, '');
    return Number(plain);
  }
  // Datetimes and anything else the subset does not model: the verbatim
  // string (the injectable @jarenjs/josl parser models them fully).
  return text;
}

/**
 * Parse a flow array `[a, b, ...]`.
 * @param {string} text
 * @param {number} no
 * @param {number} depth the array's own nesting depth
 * @returns {{ value: any[], end: number }}
 */
function parseTomlArray(text, no, depth) {
  return parseFlowArray(text, 0, no, parseTomlItem, 'unterminated array', depth);
}

/**
 * Parse an inline table `{a = 1, b = 2}`.
 * @param {string} text
 * @param {number} no
 * @param {number} depth the table's own nesting depth
 * @returns {{ value: Record<string, any>, end: number }}
 */
function parseTomlInline(text, no, depth) {
  if (depth > MAX_NESTING) throw nestedTooDeep(no);
  /** @type {Record<string, any>} */
  const out = {};
  let i = 1;
  for (;;) {
    while (i < text.length && (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x2C)) i++;
    if (i >= text.length) throw new MdFrontmatterError('unterminated inline table', no);
    if (text.charCodeAt(i) === 0x7D /* } */) return { value: out, end: i + 1 };
    let end = i;
    while (end < text.length && text.charCodeAt(end) !== 0x3D) end++;
    if (end >= text.length) throw new MdFrontmatterError("expected '=' in inline table", no);
    const path = parseTomlKeyPath(text.slice(i, end).trim(), no);
    // every segment before the last nests one more table in this one,
    // and the value sits in the last of them
    const keyDepth = depth + path.length - 1;
    if (keyDepth > MAX_NESTING) throw nestedTooDeep(no);
    const item = parseTomlItem(text, end + 1, no, keyDepth);
    let target = out;
    for (let p = 0; p < path.length - 1; p++) {
      const step = path[p];
      let next = Object.hasOwn(target, step) ? target[step] : undefined;
      if (next === undefined) {
        next = {};
        setObjectMember(target, step, next);
      }
      if (next === null || typeof next !== 'object' || Array.isArray(next))
        throw new MdFrontmatterError(`'${step}' is not a table`, no);
      target = next;
    }
    setObjectMember(target, path[path.length - 1], item.value);
    i = item.end;
  }
}

/**
 * Parse one value inside a flow array or inline table.
 * @param {string} text
 * @param {number} pos
 * @param {number} no
 * @param {number} depth the enclosing array's or table's depth
 * @returns {{ value: any, end: number }}
 */
function parseTomlItem(text, pos, no, depth) {
  while (pos < text.length && text.charCodeAt(pos) === 0x20) pos++;
  const c = text.charCodeAt(pos);
  if (c === 0x5B /* [ */) {
    const inner = parseTomlArray(text.slice(pos), no, depth + 1);
    return { value: inner.value, end: pos + inner.end };
  }
  if (c === 0x7B /* { */) {
    const inner = parseTomlInline(text.slice(pos), no, depth + 1);
    return { value: inner.value, end: pos + inner.end };
  }
  if (c === 0x22 || c === 0x27) {
    return parseQuoted(text, pos, /** @type {'"'|"'"} */ (text[pos]), no);
  }
  let end = pos;
  while (end < text.length) {
    const cc = text.charCodeAt(end);
    if (cc === 0x2C || cc === 0x5D || cc === 0x7D) break;
    end++;
  }
  return { value: parseTomlValue(text.slice(pos, end).trim(), no), end };
}
