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
 * Error thrown when JSONX source text violates the grammar.
 */
export class JsonxSyntaxError extends LineColumnSyntaxError {
  /**
   * @param {string} message - What is wrong
   * @param {number} line - 1-based physical line number
   * @param {number} column - 1-based column number
   * @param {string} [hint] - Repair suggestion for machine-repair loops
   */
  constructor(message, line, column, hint = undefined) {
    super('JsonxSyntaxError', message, line, column, hint);
  }
}

//#endregion
