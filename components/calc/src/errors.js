//@ts-check
/**
 * @file The engine's parse error, carrying a 1-based `line`/`column`
 * (the `fail(message, position)` idiom from `packages/json/src/path.js`,
 * adapted to line/column like the mermaid parser). The evaluate/render
 * path catches it and never rethrows into the app loop (D2).
 */

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
