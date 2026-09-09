//@ts-check
import { utf8ByteLength } from '@jarenjs/core/string';

/** Count a string stream without charging split surrogate pairs as two replacements.
 * @param {{ byteTail?: number }} state @param {string} text @returns {number} */
export function chunkByteLength(state, text) {
  if (text.length === 0) return 0;
  const first = text.charCodeAt(0);
  const joined = state.byteTail >= 0xD800 && state.byteTail <= 0xDBFF
    && first >= 0xDC00 && first <= 0xDFFF;
  state.byteTail = text.charCodeAt(text.length - 1);
  return utf8ByteLength(text) - (joined ? 2 : 0);
}

/** Let a cutter inspect bounded additions, including the first incomplete token.
 * @param {string} chunk @param {number} limit @param {(part: string) => void} consume */
export function feedBounded(chunk, limit, consume) {
  if (limit === Infinity || chunk.length === 0) { consume(chunk); return; }
  const size = Math.max(1, Math.min(16384, limit));
  for (let offset = 0; offset < chunk.length; offset += size) consume(chunk.slice(offset, offset + size));
}

//#region hostile-input limits
// The three readers and the CSV machine take the same shape of guard:
// a limit that defaults to Infinity — nothing in this package refuses a
// document by size unless a caller asks — and, once asked, is checked
// while the offending text is still in cutter, token or container
// state. Limited streams inspect bounded additions before accepting another;
// complete spans are checked before decoding or linking values. Every limit
// counts UTF-8 bytes, never JavaScript code units: a limit stated in
// bytes is the one an HTTP body limit, a disk quota or a proxy speaks.
//
// A crossing is a `JoslLimitError` with a stable code — `CSV2xxx`,
// `JOSL2xxx`, `JSONX2xxx` — and the limit that was crossed. It is never
// a repair: repair mode heals damaged syntax, and a document that is
// too large is not damaged, it is refused.

/**
 * The CSV limits, by option name.
 * @type {Readonly<Record<'CSV2001' | 'CSV2002' | 'CSV2003' | 'CSV2004', string>>}
 */
export const CSV_LIMIT_CODES = Object.freeze({
  CSV2001: 'the document exceeds maxTotalBytes',
  CSV2002: 'a record exceeds maxRecordBytes',
  CSV2003: 'a field exceeds maxFieldBytes',
  CSV2004: 'a record has more than maxColumns fields',
});

/**
 * The JOSL/TOML limits, by option name. A "record" is one logical line —
 * the unit the reader buffers before it parses anything.
 * @type {Readonly<Record<'JOSL2001' | 'JOSL2002' | 'JOSL2003' | 'JOSL2004' | 'JOSL2005', string>>}
 */
export const JOSL_LIMIT_CODES = Object.freeze({
  JOSL2001: 'the document exceeds maxTotalBytes',
  JOSL2002: 'a logical line exceeds maxRecordBytes',
  JOSL2003: 'a token exceeds maxTokenBytes',
  JOSL2004: 'the document nests deeper than maxDepth',
  JOSL2005: 'the root retains more than maxRetainedValues values',
});

/**
 * The JSONX/JSON limits, by option name.
 * @type {Readonly<Record<'JSONX2001' | 'JSONX2002' | 'JSONX2003' | 'JSONX2004', string>>}
 */
export const JSONX_LIMIT_CODES = Object.freeze({
  JSONX2001: 'the document exceeds maxTotalBytes',
  JSONX2002: 'a token exceeds maxTokenBytes',
  JSONX2003: 'the document nests deeper than maxDepth',
  JSONX2004: 'the root retains more than maxRetainedValues values',
});

/** The option name each code guards. */
const OPTION_OF = Object.freeze({
  CSV2001: 'maxTotalBytes', CSV2002: 'maxRecordBytes', CSV2003: 'maxFieldBytes', CSV2004: 'maxColumns',
  JOSL2001: 'maxTotalBytes', JOSL2002: 'maxRecordBytes', JOSL2003: 'maxTokenBytes', JOSL2004: 'maxDepth', JOSL2005: 'maxRetainedValues',
  JSONX2001: 'maxTotalBytes', JSONX2002: 'maxTokenBytes', JSONX2003: 'maxDepth', JSONX2004: 'maxRetainedValues',
});

/**
 * Error thrown when a document crosses a limit a caller set. Never a
 * repair, never healed: the text is refused where it stands.
 */
export class JoslLimitError extends Error {
  /**
   * @param {string} code - The stable `CSV2xxx` / `JOSL2xxx` / `JSONX2xxx` code
   * @param {string} message - What was crossed
   * @param {number} limit - The limit the option set
   * @param {number} [line] - 1-based physical line where the crossing was met, when known
   */
  constructor(code, message, limit, line = undefined) {
    super(`${code}: ${message} (${OPTION_OF[code]} ${limit})${line === undefined ? '' : ` at line ${line}`}`);
    this.name = 'JoslLimitError';
    this.code = code;
    this.limit = limit;
    this.line = line;
  }
}

/**
 * Read one limit option: absent is `Infinity`; anything but a positive
 * integer or `Infinity` is a `TypeError` — a limit of zero refuses every
 * document, and a fraction or a string is a caller's mistake.
 * @param {object} options - The reader/writer options
 * @param {string} name - The option name
 * @returns {number} The limit, `Infinity` when unset
 */
export function limitOption(options, name) {
  const value = options[name];
  if (value === undefined || value === null)
    return Infinity;
  if (value === Infinity)
    return Infinity;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new TypeError(`options.${name} must be a positive integer or Infinity`);
  return value;
}

//#endregion
