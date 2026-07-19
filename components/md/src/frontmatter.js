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
 * strings, block maps and sequences by indentation, flow arrays and
 * maps (multi-line while brackets are open), literal `|` and folded `>`
 * block scalars with `-` chomping, and `#` comments. No anchors, no
 * aliases, no tags, no multi-document streams, no complex keys.
 */

import { countIndent, isBlankLine } from './utils.js';

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
      const toml = options !== undefined && typeof options.toml === 'function'
        ? options.toml
        : parseTomlSubset;
      return { data: toml(block.text), body: block.body, lang: 'toml' };
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
    const line = source.slice(lineStart, hardEnd).replace(/[ \t\r]+$/, '');
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
    const line = source.slice(pos, hardEnd).replace(/[ \t\r]+$/, '');
    if (line === '}') {
      try {
        return {
          data: JSON.parse(source.slice(0, hardEnd)),
          body: lineEnd === -1 ? '' : source.slice(lineEnd + 1),
        };
      }
      catch {
        return null;
      }
    }
    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }
  return null;
}

/**
 * Parse a `---json` block (JSON.parse with a located error).
 * @param {string} text
 * @returns {any}
 */
function parseJsonBlock(text) {
  try {
    return JSON.parse(text);
  }
  catch (err) {
    throw new MdFrontmatterError(
      `invalid JSON: ${/** @type {Error} */ (err).message}`, 0);
  }
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
  const state = { lines, pos: 0 };
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
 * @typedef {{ lines: string[], pos: number }} YamlState
 */

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
    setMember(out, entry.key, parseYamlValue(state, entry.rest, indent));
  }
  return out;
}

/**
 * Parse a block sequence at `indent`.
 * @param {YamlState} state
 * @param {number} indent
 * @returns {any[]}
 */
function parseYamlSeq(state, indent) {
  /** @type {any[]} */
  const out = [];
  while (state.pos < state.lines.length) {
    skipYamlVoid(state);
    if (state.pos >= state.lines.length) break;
    const line = state.lines[state.pos];
    const li = countIndent(line);
    if (li < indent) break;
    const content = line.slice(indent);
    if (li > indent || !isSeqDash(content)) break;
    let restColumn = indent + 1;
    while (restColumn < line.length && line.charCodeAt(restColumn) === 0x20) restColumn++;
    const rest = line.slice(restColumn);
    if (rest === '' || rest.charCodeAt(0) === 0x23 /* # */) {
      // `-` alone: the item is the following deeper block (or null).
      state.pos++;
      out.push(parseYamlNested(state, indent, null));
    }
    else if (findKeyColon(rest) !== -1) {
      // `- key: value`: an inline map item; re-enter the map parser at
      // the rest's column by blanking the dash out of the current line.
      state.lines[state.pos] = ' '.repeat(restColumn) + rest;
      out.push(parseYamlMap(state, restColumn));
    }
    else {
      state.pos++;
      out.push(parseYamlFlowOrScalar(state, rest, state.pos - 1));
    }
  }
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
    return parseYamlNested(state, indent, null);
  }
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
 * Parse the nested block value after a key (or lone dash) at `indent`:
 * a deeper block node, a sequence at the same indent, or `fallback`.
 * @param {YamlState} state
 * @param {number} indent
 * @param {any} fallback
 * @returns {any}
 */
function parseYamlNested(state, indent, fallback) {
  const mark = state.pos;
  skipYamlVoid(state);
  if (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    const li = countIndent(line);
    if (li > indent) return parseYamlNode(state, li);
    if (li === indent && isSeqDash(line.slice(li))) return parseYamlSeq(state, li);
  }
  state.pos = mark;
  return fallback;
}

/**
 * Parse a `|`/`>` block scalar. The chomp `-` drops the final newline.
 * @param {YamlState} state
 * @param {number} indent indent of the owning key
 * @param {string} header `|`, `|-`, `>` or `>-`
 * @returns {string}
 */
function parseYamlBlockScalar(state, indent, header) {
  /** @type {string[]} */
  const raw = [];
  let blockIndent = -1;
  while (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    if (isBlankLine(line)) {
      raw.push('');
      state.pos++;
      continue;
    }
    const li = countIndent(line);
    if (li <= indent) break;
    if (blockIndent === -1) blockIndent = li;
    raw.push(line.slice(Math.min(li, blockIndent)));
    state.pos++;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  let text;
  if (header.charCodeAt(0) === 0x7C /* | */) {
    text = raw.join('\n');
  }
  else {
    text = '';
    for (let i = 0; i < raw.length; i++) {
      if (i === 0) text = raw[0];
      else if (raw[i] === '' || raw[i - 1] === '') text += '\n' + raw[i];
      else text += ' ' + raw[i];
    }
  }
  return header.length === 2 ? text : text + '\n';
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
      key = String(parseQuoted(key, 0, /** @type {'"'|"'"} */ (key[0])).value);
    }
  }
  let restColumn = indent + colon + 1;
  while (restColumn < line.length && line.charCodeAt(restColumn) === 0x20) restColumn++;
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
    let text = rest;
    while (flowDepth(text) > 0 && state.pos < state.lines.length) {
      text += ' ' + state.lines[state.pos].trim();
      state.pos++;
    }
    if (flowDepth(text) !== 0) {
      throw new MdFrontmatterError('unterminated flow collection', lineNo);
    }
    const flow = parseFlowValue(text, 0, lineNo);
    return flow.value;
  }
  return parseYamlScalar(stripComment(rest));
}

/**
 * Net bracket depth of a line, ignoring brackets inside quotes.
 * @param {string} text
 * @returns {number}
 */
function flowDepth(text) {
  let depth = 0;
  let quote = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote && !(quote === 0x22 && text.charCodeAt(i - 1) === 0x5C)) quote = 0;
    }
    else if (c === 0x22 || c === 0x27) quote = c;
    else if (c === 0x5B || c === 0x7B) depth++;
    else if (c === 0x5D || c === 0x7D) depth--;
  }
  return depth;
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
 * @returns {any}
 */
function parseYamlScalar(text) {
  if (text === '') return null;
  const c0 = text.charCodeAt(0);
  if (c0 === 0x22 || c0 === 0x27) {
    return parseQuoted(text, 0, /** @type {'"'|"'"} */ (text[0])).value;
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
 * @returns {{ value: string, end: number }}
 */
function parseQuoted(text, pos, quote) {
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
  return { value: out, end: i };
}

/**
 * Parse a flow value (`[...]`, `{...}`, quoted or plain scalar) inside a
 * single-line flow text.
 * @param {string} text
 * @param {number} pos
 * @param {number} lineNo
 * @returns {{ value: any, end: number }}
 */
function parseFlowValue(text, pos, lineNo) {
  while (pos < text.length && text.charCodeAt(pos) === 0x20) pos++;
  const c = text.charCodeAt(pos);
  if (c === 0x5B /* [ */) return parseFlowSeq(text, pos, lineNo);
  if (c === 0x7B /* { */) return parseFlowMap(text, pos, lineNo);
  if (c === 0x22 || c === 0x27) {
    return parseQuoted(text, pos, /** @type {'"'|"'"} */ (text[pos]));
  }
  let end = pos;
  let depth = 0;
  while (end < text.length) {
    const cc = text.charCodeAt(end);
    if (depth === 0 && (cc === 0x2C || cc === 0x5D || cc === 0x7D || cc === 0x3A)) break;
    if (cc === 0x5B || cc === 0x7B) depth++;
    else if (cc === 0x5D || cc === 0x7D) depth--;
    end++;
  }
  return { value: parseYamlScalar(text.slice(pos, end).trim()), end };
}

/**
 * Parse a flow sequence `[a, b, ...]`.
 * @param {string} text
 * @param {number} pos index of `[`
 * @param {number} lineNo
 * @returns {{ value: any[], end: number }}
 */
function parseFlowSeq(text, pos, lineNo) {
  /** @type {any[]} */
  const out = [];
  let i = pos + 1;
  for (;;) {
    while (i < text.length && (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x2C)) i++;
    if (i >= text.length) throw new MdFrontmatterError('unterminated flow sequence', lineNo);
    if (text.charCodeAt(i) === 0x5D /* ] */) return { value: out, end: i + 1 };
    const item = parseFlowValue(text, i, lineNo);
    out.push(item.value);
    i = item.end;
  }
}

/**
 * Parse a flow map `{a: 1, b: 2}`.
 * @param {string} text
 * @param {number} pos index of `{`
 * @param {number} lineNo
 * @returns {{ value: Record<string, any>, end: number }}
 */
function parseFlowMap(text, pos, lineNo) {
  /** @type {Record<string, any>} */
  const out = {};
  let i = pos + 1;
  for (;;) {
    while (i < text.length && (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x2C)) i++;
    if (i >= text.length) throw new MdFrontmatterError('unterminated flow map', lineNo);
    if (text.charCodeAt(i) === 0x7D /* } */) return { value: out, end: i + 1 };
    const key = parseFlowValue(text, i, lineNo);
    i = key.end;
    while (i < text.length && text.charCodeAt(i) === 0x20) i++;
    if (text.charCodeAt(i) !== 0x3A /* : */) {
      throw new MdFrontmatterError("expected ':' in flow map", lineNo);
    }
    const value = parseFlowValue(text, i + 1, lineNo);
    setMember(out, String(key.value), value.value);
    i = value.end;
  }
}

/**
 * Assign a member without falling into the `__proto__` setter trap.
 * @param {Record<string, any>} out
 * @param {string} key
 * @param {any} value
 */
function setMember(out, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(out, key, {
      value, writable: true, enumerable: true, configurable: true,
    });
  }
  else {
    out[key] = value;
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
      table = descendTomlTable(root, path, isArray, no);
      continue;
    }
    const eq = findTomlEquals(line);
    if (eq === -1) throw new MdFrontmatterError(`expected 'key = value', got '${line}'`, no);
    const path = parseTomlKeyPath(line.slice(0, eq), no);
    let valueText = line.slice(eq + 1).trim();
    // Multi-line flow arrays / inline tables: join lines while open.
    while (flowDepth(stripTomlComment(valueText)) > 0 && no + 1 < lines.length) {
      valueText += ' ' + lines[++no].trim();
    }
    valueText = stripTomlComment(valueText).trim();
    let target = table;
    for (let i = 0; i < path.length - 1; i++) {
      const step = path[i];
      if (!(step in target) || typeof target[step] !== 'object') {
        const next = {};
        setMember(target, step, next);
        target = next;
      }
      else {
        target = target[step];
      }
    }
    setMember(target, path[path.length - 1], parseTomlValue(valueText, no));
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
      const q = parseQuoted(text, i, /** @type {'"'|"'"} */ (text[i]));
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
 * Walk (creating) the table a `[header]` names; `[[header]]` appends a
 * fresh table to the named array.
 * @param {Record<string, any>} root
 * @param {string[]} path
 * @param {boolean} isArray
 * @param {number} no
 * @returns {Record<string, any>}
 */
function descendTomlTable(root, path, isArray, no) {
  let target = root;
  for (let i = 0; i < path.length - 1; i++) {
    const step = path[i];
    let next = target[step];
    if (next === undefined) {
      next = {};
      setMember(target, step, next);
    }
    else if (Array.isArray(next)) {
      next = next[next.length - 1];
    }
    if (typeof next !== 'object' || next === null) {
      throw new MdFrontmatterError(`'${step}' is not a table`, no);
    }
    target = next;
  }
  const leaf = path[path.length - 1];
  if (isArray) {
    let arr = target[leaf];
    if (arr === undefined) {
      arr = [];
      setMember(target, leaf, arr);
    }
    if (!Array.isArray(arr)) throw new MdFrontmatterError(`'${leaf}' is not an array of tables`, no);
    const fresh = {};
    arr.push(fresh);
    return fresh;
  }
  let next = target[leaf];
  if (next === undefined) {
    next = {};
    setMember(target, leaf, next);
  }
  else if (Array.isArray(next)) {
    next = next[next.length - 1];
  }
  if (typeof next !== 'object' || next === null) {
    throw new MdFrontmatterError(`'${leaf}' is not a table`, no);
  }
  return next;
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
    return parseQuoted(text, 0, /** @type {'"'|"'"} */ (text[0])).value;
  }
  if (c0 === 0x5B /* [ */) return parseTomlArray(text, no).value;
  if (c0 === 0x7B /* { */) return parseTomlInline(text, no).value;
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
 * @returns {{ value: any[], end: number }}
 */
function parseTomlArray(text, no) {
  /** @type {any[]} */
  const out = [];
  let i = 1;
  for (;;) {
    while (i < text.length && (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x2C)) i++;
    if (i >= text.length) throw new MdFrontmatterError('unterminated array', no);
    if (text.charCodeAt(i) === 0x5D /* ] */) return { value: out, end: i + 1 };
    const item = parseTomlItem(text, i, no);
    out.push(item.value);
    i = item.end;
  }
}

/**
 * Parse an inline table `{a = 1, b = 2}`.
 * @param {string} text
 * @param {number} no
 * @returns {{ value: Record<string, any>, end: number }}
 */
function parseTomlInline(text, no) {
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
    const item = parseTomlItem(text, end + 1, no);
    let target = out;
    for (let p = 0; p < path.length - 1; p++) {
      const next = {};
      setMember(target, path[p], next);
      target = next;
    }
    setMember(target, path[path.length - 1], item.value);
    i = item.end;
  }
}

/**
 * Parse one value inside a flow array or inline table.
 * @param {string} text
 * @param {number} pos
 * @param {number} no
 * @returns {{ value: any, end: number }}
 */
function parseTomlItem(text, pos, no) {
  while (pos < text.length && text.charCodeAt(pos) === 0x20) pos++;
  const c = text.charCodeAt(pos);
  if (c === 0x5B /* [ */) {
    const inner = parseTomlArray(text.slice(pos), no);
    return { value: inner.value, end: pos + inner.end };
  }
  if (c === 0x7B /* { */) {
    const inner = parseTomlInline(text.slice(pos), no);
    return { value: inner.value, end: pos + inner.end };
  }
  if (c === 0x22 || c === 0x27) {
    return parseQuoted(text, pos, /** @type {'"'|"'"} */ (text[pos]));
  }
  let end = pos;
  while (end < text.length) {
    const cc = text.charCodeAt(end);
    if (cc === 0x2C || cc === 0x5D || cc === 0x7D) break;
    end++;
  }
  return { value: parseTomlValue(text.slice(pos, end).trim(), no), end };
}
