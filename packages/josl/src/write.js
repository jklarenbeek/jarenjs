//#region JOSL streaming writer
// The write-side mirror of the streaming reader: an event API that emits
// JOSL/TOML text chunk by chunk, so a document can be streamed onward
// (over HTTP, into an LLM prompt, to disk) while it is still being
// produced. Serialization is shared with stringify.js, so a value round-
// trips identically whether it went through `stringifyJosl` or a writer.
//
// The writer validates lightly - enough to prevent emitting a document
// the reader would reject (duplicate keys in a section, duplicate
// headers, root table/array mixing, mode downleveling) - but it does not
// re-simulate the full table machinery; it trusts the caller's ordering.

import { JoslStringifyError } from './errors.js';
import {
  formatKey,
  formatKeyPath,
  formatValue,
  formatSection,
  isPlainTable,
} from './stringify.js';

class JoslStreamWriter {
  constructor(options = {}) {
    this.options = {
      mode: options.mode === 'toml' ? 'toml' : 'josl',
      onNull: options.onNull,
      onRegExp: options.onRegExp,
    };
    this.onChunk = options.onChunk ?? null;
    this.chunks = [];
    this.ended = false;
    this.rootIsArray = false;
    this.rootHasPairs = false;
    this.sawSection = false;
    this.sectionKeys = new Set(); // first-level keys of the current section
    this.headers = new Set(); // emitted header paths (scoped per root item)
    this.headerScope = 0; // root items reset header/key tracking
  }

  emit(chunk) {
    this.chunks.push(chunk);
    if (this.onChunk !== null)
      this.onChunk(chunk);
  }

  guard() {
    if (this.ended)
      throw new JoslStringifyError('cannot write after end()');
  }

  blank() {
    if (this.chunks.length !== 0)
      this.emit('\n');
  }

  toPath(path) {
    const keys = typeof path === 'string' ? [path] : path;
    if (!Array.isArray(keys) || keys.length === 0
      || keys.some((k) => typeof k !== 'string'))
      throw new JoslStringifyError('a path must be a key or a non-empty array of keys');
    return keys;
  }

  openSection(keys, wrap) {
    this.guard();
    if (this.rootIsArray && this.headerScope === 0)
      throw new JoslStringifyError('expected rootItem() before sections in a root array');
    const header = formatKeyPath(keys);
    const id = `${this.headerScope}:${wrap}${header}`;
    if (this.headers.has(id))
      throw new JoslStringifyError(`section [${header}] was already emitted`);
    if (wrap === '[')
      this.headers.add(id);
    this.sawSection = true;
    this.blank();
    this.emit(wrap === '[' ? `[${header}]\n` : `[[${header}]]\n`);
    this.sectionKeys = new Set();
  }

  /**
   * Emit a key-value pair into the current section.
   * @param {string|string[]} key - A key, or key segments for dotted keys
   * @param {*} value - The value
   * @returns {this} The writer, for chaining
   */
  pair(key, value) {
    this.guard();
    const keys = this.toPath(key);
    if (this.rootIsArray && this.headerScope === 0)
      throw new JoslStringifyError('expected rootItem() before pairs in a root array');
    if (this.sectionKeys.has(keys[0]))
      throw new JoslStringifyError(`duplicate key '${keys[0]}' in this section`);
    this.sectionKeys.add(keys[0]);
    if (!this.rootIsArray && !this.sawSection)
      this.rootHasPairs = true;
    this.emit(`${formatKeyPath(keys)} = ${formatValue(value, this.options, keys)}\n`);
    return this;
  }

  /**
   * Open a `[table]` section.
   * @param {string|string[]} path - Header path
   * @returns {this} The writer, for chaining
   */
  table(path) {
    this.openSection(this.toPath(path), '[');
    return this;
  }

  /**
   * Append a `[[table-array]]` element.
   * @param {string|string[]} path - Header path
   * @returns {this} The writer, for chaining
   */
  tableArray(path) {
    this.openSection(this.toPath(path), '[[');
    return this;
  }

  /**
   * Start a `[[]]` root-array element (JOSL mode only). With a record
   * argument the whole table body is emitted at once - the natural
   * unit for streaming one record per completed result.
   * @param {object} [record] - Optional complete record to emit
   * @returns {this} The writer, for chaining
   */
  rootItem(record = undefined) {
    this.guard();
    if (this.options.mode === 'toml')
      throw new JoslStringifyError('root arrays ([[]]) are a JOSL extension');
    if (this.rootHasPairs || (!this.rootIsArray && this.sawSection))
      throw new JoslStringifyError('cannot mix a root table and a root array');
    this.rootIsArray = true;
    this.headerScope++;
    this.sectionKeys = new Set();
    this.blank();
    this.emit('[[]]\n');
    if (record !== undefined) {
      if (!isPlainTable(record))
        throw new JoslStringifyError('a root array element must be a table');
      const body = formatSection(record, this.options);
      if (body.length !== 0)
        this.emit(body);
      for (const k of Object.keys(record))
        this.sectionKeys.add(k);
    }
    return this;
  }

  /**
   * Emit a comment line (multi-line text becomes multiple comments).
   * @param {string} text - Comment text
   * @returns {this} The writer, for chaining
   */
  comment(text) {
    this.guard();
    for (const line of String(text).split('\n'))
      this.emit(`# ${line}\n`);
    return this;
  }

  /**
   * The document text emitted so far.
   * @returns {string} Concatenated chunks
   */
  text() {
    return this.chunks.join('');
  }

  /**
   * Finish the document.
   * @returns {string} The complete document text
   */
  end() {
    this.ended = true;
    return this.text();
  }
}

/**
 * Create a streaming JOSL/TOML writer - the write-side mirror of
 * `createStreamReader`. Chunks are delivered through `onChunk` as they
 * are produced and also accumulate for `text()` / `end()`.
 * @param {object} [options] - Writer options
 * @param {'josl'|'toml'} [options.mode] - 'toml' emits strict TOML 1.0
 * @param {'error'|'omit'} [options.onNull] - See `stringifyJosl`
 * @param {'error'|'string'} [options.onRegExp] - See `stringifyJosl`
 * @param {(chunk: string) => void} [options.onChunk] - Chunk sink
 * @returns {JoslStreamWriter} The writer
 */
export function createStreamWriter(options = undefined) {
  return new JoslStreamWriter(options ?? {});
}

/**
 * Serialize a value as an iterable of text chunks: one chunk per record
 * for a root array, a single chunk for a table root. Useful for piping
 * record streams onward without building the full string.
 * @param {object|Array} value - Same roots as `stringifyJosl`
 * @param {object} [options] - Writer options; see `stringifyJosl`
 * @yields {string} Document chunks, in order
 */
export function* stringifyJoslChunks(value, options = {}) {
  if (Array.isArray(value)) {
    if (options.mode === 'toml')
      throw new JoslStringifyError('a TOML root must be a table; root arrays are a JOSL extension');
    for (let i = 0; i < value.length; ++i) {
      if (!isPlainTable(value[i]))
        throw new JoslStringifyError('root array elements must be tables', [i]);
      const body = formatSection(value[i], options);
      // keep byte-identical with stringifyJosl: a body that opens with a
      // section header gets a blank line after the [[]] header
      yield (i === 0 ? '' : '\n') + '[[]]\n'
        + (body.startsWith('[') ? '\n' : '') + body;
    }
    return;
  }
  if (!isPlainTable(value))
    throw new JoslStringifyError('a JOSL root must be a table or an array of tables');
  const text = formatSection(value, options);
  if (text.length !== 0)
    yield text;
}

export { JoslStringifyError } from './errors.js';

//#endregion
