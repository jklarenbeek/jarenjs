//#region JOSL errors
// All parse errors carry a 1-based line and column plus an optional `hint`
// aimed at machine-repair loops: an LLM that produced almost-valid JOSL can
// be re-prompted with `message` + `hint` to fix its own output, mirroring
// the suggestion style of the other jaren error classes.

/**
 * Error thrown when JOSL / TOML source text violates the grammar or the
 * table redefinition rules.
 */
export class JoslSyntaxError extends SyntaxError {
  /**
   * @param {string} message - What is wrong
   * @param {number} line - 1-based physical line number
   * @param {number} column - 1-based column number
   * @param {string} [hint] - Repair suggestion for machine-repair loops
   */
  constructor(message, line, column, hint = undefined) {
    super(`${message} at line ${line}, column ${column}${hint ? ` (${hint})` : ''}`);
    this.name = 'JoslSyntaxError';
    this.line = line;
    this.column = column;
    this.hint = hint;
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
 * Error thrown when JSONX source text violates the grammar.
 */
export class JsonxSyntaxError extends SyntaxError {
  /**
   * @param {string} message - What is wrong
   * @param {number} line - 1-based physical line number
   * @param {number} column - 1-based column number
   * @param {string} [hint] - Repair suggestion for machine-repair loops
   */
  constructor(message, line, column, hint = undefined) {
    super(`${message} at line ${line}, column ${column}${hint ? ` (${hint})` : ''}`);
    this.name = 'JsonxSyntaxError';
    this.line = line;
    this.column = column;
    this.hint = hint;
  }
}

//#endregion
