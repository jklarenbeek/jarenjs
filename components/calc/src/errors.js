//@ts-check
/**
 * @file The engine's parse error, carrying a 1-based `line`/`column`
 * (the `fail(message, position)` idiom from `packages/json/src/path.js`,
 * adapted to line/column like the mermaid parser). The evaluate/render
 * path catches it and never rethrows into the app loop.
 */

/**
 * An error at a character offset of `source`, with the 1-based line and
 * column that offset falls on.
 * @param {string} message
 * @param {string} source
 * @param {number} position 0-based char offset
 * @returns {CalcParseError}
 */
export function errorAt(message, source, position) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < position && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) { line++; column = 1; } else column++;
  }
  return new CalcParseError(message, line, column, position);
}

export class CalcParseError extends Error {
  /**
   * @param {string} message
   * @param {number} [line] 1-based line
   * @param {number} [column] 1-based column
   * @param {number} [position] 0-based char offset
   */
  constructor(message, line = 1, column = 1, position = 0) {
    super(message);
    this.name = 'CalcParseError';
    this.line = line;
    this.column = column;
    this.position = position;
  }
}
