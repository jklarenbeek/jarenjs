//#region JOSL errors
// All parse errors carry a 1-based line and column plus an optional `hint`
// aimed at machine-repair loops: an LLM that produced almost-valid JOSL can
// be re-prompted with `message` + `hint` to fix its own output, mirroring
// the suggestion style of the other jaren error classes.

/**
 * Shared constructor body for the line/column syntax errors. The `name`
 * is passed as a string literal because the bundle is minified and a
 * mangled class name must not leak into `error.name`.
 */
class LineColumnSyntaxError extends SyntaxError {
  /**
   * @param {string} name - The public class name for `error.name`
   * @param {string} message - What is wrong
   * @param {number} line - 1-based physical line number
   * @param {number} column - 1-based column number
   * @param {string} [hint] - Repair suggestion for machine-repair loops
   */
  constructor(name, message, line, column, hint = undefined) {
    super(`${message} at line ${line}, column ${column}${hint ? ` (${hint})` : ''}`);
    this.name = name;
    this.line = line;
    this.column = column;
    this.hint = hint;
  }
}

/**
 * Error thrown when JOSL / TOML source text violates the grammar or the
 * table redefinition rules.
 */
export class JoslSyntaxError extends LineColumnSyntaxError {
  /**
   * @param {string} message - What is wrong
   * @param {number} line - 1-based physical line number
   * @param {number} column - 1-based column number
   * @param {string} [hint] - Repair suggestion for machine-repair loops
   */
  constructor(message, line, column, hint = undefined) {
    super('JoslSyntaxError', message, line, column, hint);
  }
}

/**
 * Error thrown when a value cannot be represented in the requested output
 * mode (e.g. `null` or a RegExp in strict TOML mode, a scalar root).
 */
export class JoslStringifyError extends Error {
  /**
   * @param {string} message - What is wrong
   * @param {(string|number)[]} [path] - Path of the offending value
   */
  constructor(message, path = []) {
    super(path.length ? `${message} at /${path.join('/')}` : message);
    this.name = 'JoslStringifyError';
    this.path = path;
  }
}

/**
 * Error thrown when CSV source text violates RFC 4180 in strict mode.
 *
 * Every condition this reports is also a *repairable* one: `repair: true`
 * turns each into a logged repair instead of a throw, so the same `code`
 * appears either as `error.code` here or as an entry in the reader's
 * repair log. Carrying the code both ways is what lets a caller move
 * between the two modes without re-learning the diagnosis.
 */
export class CsvSyntaxError extends SyntaxError {
  /**
   * @param {string} code - Stable `CSV1xxx` diagnosis code
   * @param {string} message - What is wrong
   * @param {number} line - 1-based physical line number
   * @param {number} column - 1-based column number
   * @param {string} [hint] - Repair suggestion for machine-repair loops
   */
  constructor(code, message, line, column, hint = undefined) {
    super(`${code}: ${message} at line ${line}, column ${column}${hint ? ` (${hint})` : ''}`);
    this.name = 'CsvSyntaxError';
    this.code = code;
    this.line = line;
    this.column = column;
    this.hint = hint;
  }
}

/**
 * The conditions the JSONX readers refuse as syntax, one code each. Both
 * readers (`parseJsonx` and the stream reader) report the same code at the
 * same place; `JSONX1018` is raised only under `duplicateKeys: 'error'`.
 * @type {Readonly<Record<'JSONX1001' | 'JSONX1002' | 'JSONX1003' | 'JSONX1004' | 'JSONX1005'
 *   | 'JSONX1006' | 'JSONX1007' | 'JSONX1008' | 'JSONX1009' | 'JSONX1010' | 'JSONX1011'
 *   | 'JSONX1012' | 'JSONX1013' | 'JSONX1014' | 'JSONX1015' | 'JSONX1016' | 'JSONX1017'
 *   | 'JSONX1018', string>>}
 */
export const JSONX_CODES = Object.freeze({
  JSONX1001: 'the text ends before its value is complete',
  JSONX1002: 'text follows the complete value',
  JSONX1003: 'an object member does not start with a string key',
  JSONX1004: "a key is not followed by ':'",
  JSONX1005: "a member is not followed by ',' or the container's closing bracket",
  JSONX1006: 'an object or array is never closed',
  JSONX1007: 'no value starts here',
  JSONX1008: 'a value is followed by a character that cannot end it',
  JSONX1009: 'a string is never closed',
  JSONX1010: 'an invalid escape sequence in a string',
  JSONX1011: 'an unescaped control character in a string',
  JSONX1012: 'an invalid number',
  JSONX1013: 'a bigint literal with a fraction or an exponent',
  JSONX1014: 'a date or time that does not exist',
  JSONX1015: 'a regexp literal is never closed',
  JSONX1016: 'a regexp literal the platform cannot compile',
  JSONX1017: "a regexp literal, a leading '+' or a non-finite word in strict JSON mode",
  JSONX1018: 'an object names the same member twice',
});

/**
 * Error thrown when JSONX source text violates the grammar. `code` is one
 * of {@link JSONX_CODES}; `offset` is the 0-based position in the text in
 * UTF-16 code units, the position `line` and `column` name.
 */
export class JsonxSyntaxError extends LineColumnSyntaxError {
  /**
   * @param {string} message - What is wrong
   * @param {number} line - 1-based physical line number
   * @param {number} column - 1-based column number
   * @param {string} [hint] - Repair suggestion for machine-repair loops
   * @param {string} [code] - Stable `JSONX1xxx` diagnosis code
   * @param {number} [offset] - 0-based offset in the text
   */
  constructor(message, line, column, hint = undefined, code = undefined, offset = undefined) {
    super('JsonxSyntaxError', message, line, column, hint);
    this.code = code;
    this.offset = offset;
  }
}

//#endregion
