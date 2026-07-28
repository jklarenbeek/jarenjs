//#region JOSL concrete syntax tree
// A CST keeps the *document*, where the value model keeps only the data.
// Comments, blank lines, key spelling, quote style, number formatting and
// alignment all survive a parse/print round trip, so a tool can change one
// value in a config file and leave every other byte alone — something
// `parseJosl` + `stringifyJosl` cannot do, because none of that survives
// into a plain JS value.
//
// The tree is a flat list of logical lines, because that is exactly what
// JOSL's grammar produces: every construct starts and ends on one logical
// line (a multi-line string or array is still a single logical line). Each
// node records its source span rather than a copy of the text, so printing
// an untouched document hands back the original substrings.

import { JoslMachine } from './machine.js';
import { formatValue, formatKeyPath } from './stringify.js';
import { countCharCode } from '@jarenjs/core/string';

const KIND_TRIVIA = 'trivia';
const KIND_PAIR = 'pair';

function samePath(a, b) {
  if (a.length !== b.length)
    return false;
  for (let i = 0; i < a.length; ++i)
    if (a[i] !== b[i])
      return false;
  return true;
}

/**
 * A parsed JOSL document that remembers its own text.
 *
 * Nodes are the document's logical lines in source order. Editing marks
 * individual nodes dirty; every untouched node still prints as the exact
 * bytes it was parsed from.
 */
export class JoslCstDocument {
  /**
   * @param {string} source - The original document text
   * @param {Array<object>} nodes - Logical-line nodes in source order
   * @param {*} data - The parsed value model
   * @param {object} options - Parse options, reused when re-reading edits
   */
  constructor(source, nodes, data, options, bom = '') {
    this.source = source;
    this.nodes = nodes;
    this.options = options;
    // Node spans index the BOM-less text the parser saw, but rewriting a
    // file must not silently strip its byte-order mark.
    this.bom = bom;
    this._data = data;
    this._text = bom + source;
  }

  /**
   * The document text, byte-identical to the input while unedited.
   * @returns {string} JOSL source
   */
  toString() {
    if (this._text !== null)
      return this._text;
    let out = this.bom;
    for (const node of this.nodes) {
      if (node.removed)
        continue;
      if (node.text !== null) {
        out += node.text;
        continue;
      }
      if (node.valueText === null) {
        out += this.source.slice(node.start, node.end);
        continue;
      }
      out += this.source.slice(node.start, node.valueStart)
        + node.valueText
        + this.source.slice(node.valueEnd, node.end);
    }
    this._text = out;
    return out;
  }

  /**
   * The value model for the document as it currently reads. Recomputed
   * from the text after an edit, so it can never drift from the bytes.
   * @returns {*} The root table, or root array for [[]] documents
   */
  toJSON() {
    if (this._data === null)
      this._data = new JoslMachine(this.options).parseAll(this.toString());
    return this._data;
  }

  /**
   * Read the value at a key path.
   * @param {Array<string|number>} path - Absolute path of the pair
   * @returns {*} The value, or undefined when the path holds no pair
   */
  get(path) {
    const node = this.nodes.find(
      (n) => n.kind === KIND_PAIR && !n.removed && samePath(n.path, path));
    return node === undefined ? undefined : node.value;
  }

  /**
   * Replace the value of an existing pair, or append a new pair to the
   * section its path belongs to. Only the value's own bytes change, so the
   * key's spelling, the spacing around `=` and any trailing comment stay
   * exactly as written.
   * @param {Array<string|number>} path - Absolute path of the pair
   * @param {*} value - The new value
   * @returns {this} The document, for chaining
   */
  set(path, value) {
    const rendered = formatValue(value, this.options);
    const node = this.nodes.find(
      (n) => n.kind === KIND_PAIR && !n.removed && samePath(n.path, path));
    if (node !== undefined) {
      node.valueText = rendered;
      node.value = value;
      return this.invalidate();
    }
    return this.insertPair(path, value, rendered);
  }

  /**
   * Remove a pair, taking its whole line — including a trailing comment on
   * that line — with it. Comments on their own lines are left alone.
   * @param {Array<string|number>} path - Absolute path of the pair
   * @returns {boolean} True when a pair was removed
   */
  delete(path) {
    const node = this.nodes.find(
      (n) => n.kind === KIND_PAIR && !n.removed && samePath(n.path, path));
    if (node === undefined)
      return false;
    node.removed = true;
    this.invalidate();
    return true;
  }

  invalidate() {
    this._text = null;
    this._data = null;
    return this;
  }

  // Append a pair to the end of the section that owns `path`, so a new key
  // lands under its own [table] header rather than at the end of the file
  // (where it would belong to whichever section happens to be last).
  insertPair(path, value, rendered) {
    const owner = path.slice(0, -1);
    const line = `${formatKeyPath(path.slice(-1))} = ${rendered}\n`;
    // The insertion point is the last line that belongs to the owning
    // section *itself*. Matching sub-sections too would append the key
    // after a nested [a.b] header, where it would read back as `a.b.key`.
    let at = -1;
    for (let i = 0; i < this.nodes.length; ++i) {
      const node = this.nodes[i];
      if (node.removed || node.kind === KIND_TRIVIA)
        continue;
      const scope = node.kind === KIND_PAIR ? node.path.slice(0, -1) : node.path;
      if (samePath(scope, owner))
        at = i;
    }
    if (at === -1 && owner.length !== 0)
      throw new Error(`no section for '${formatKeyPath(owner)}' to hold the new key`);
    const node = {
      kind: KIND_PAIR,
      path,
      value,
      line: 0,
      start: 0,
      end: 0,
      valueStart: 0,
      valueEnd: 0,
      valueText: null,
      text: line,
      removed: false,
    };
    // a root-level key must precede the first header, or it would be read
    // back as a member of that section
    this.nodes.splice(at === -1 ? this.firstHeaderIndex() : at + 1, 0, node);
    return this.invalidate();
  }

  firstHeaderIndex() {
    const at = this.nodes.findIndex(
      (n) => !n.removed && n.kind !== KIND_TRIVIA && n.kind !== KIND_PAIR);
    return at === -1 ? this.nodes.length : at;
  }
}

/**
 * Parse a document into a CST that preserves its exact text.
 * @param {string} text - JOSL source text
 * @param {object} [options] - Reader options
 * @param {'josl'|'toml'} [options.mode] - 'toml' rejects JOSL extensions
 * @returns {JoslCstDocument} The document
 * @throws {import('./errors.js').JoslSyntaxError} On invalid input
 */
export function parseJoslCst(text, options = undefined) {
  // the document keeps only the grammar-selecting options: re-reading its
  // own text after an edit must not re-fire the caller's event sinks
  const opts = options?.mode === undefined ? {} : { mode: options.mode };
  const userEvent = options?.onEvent ?? null;
  const nodes = [];
  const pending = [];
  let line = 1;
  const machine = new JoslMachine({
    ...opts,
    onEvent(event) {
      pending.push(event);
      if (userEvent !== null)
        userEvent(event);
    },
    onLine(start, end, valueStart, valueEnd) {
      const event = pending.length === 1 ? pending[0] : null;
      nodes.push({
        kind: event === null ? KIND_TRIVIA : event.type,
        path: event === null ? [] : event.path,
        value: event !== null && event.type === KIND_PAIR ? event.value : undefined,
        line,
        start,
        end,
        valueStart,
        valueEnd,
        valueText: null,
        text: null,
        removed: false,
      });
      pending.length = 0;
      line += countCharCode(text, 0x0A, start, end);
    },
  });
  const data = machine.parseAll(text);
  // parseAll strips a leading BOM before assigning offsets, so the spans
  // index the same string the nodes must print from
  const hasBom = text.charCodeAt(0) === 0xFEFF;
  const source = hasBom ? text.slice(1) : text;
  return new JoslCstDocument(source, nodes, data, opts, hasBom ? '﻿' : '');
}

/**
 * Parse a CST in strict TOML 1.0 mode.
 * @param {string} text - TOML source text
 * @param {object} [options] - Reader options minus `mode`
 * @returns {JoslCstDocument} The document
 */
export function parseTomlCst(text, options = undefined) {
  return parseJoslCst(text, { ...options, mode: 'toml' });
}

export { JoslSyntaxError } from './errors.js';

//#endregion
