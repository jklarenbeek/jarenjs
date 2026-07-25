//@ts-check
/**
 * @file The engine's one error type. Parsers raise it with a 1-based
 * `line`/`column`; the render path (`diagramToVnode`/`renderMermaid`)
 * catches it and emits a clear error vnode instead of throwing, so
 * rendering is always total.
 */

export class MermaidParseError extends Error {
  /**
   * @param {string} message
   * @param {number} [line] 1-based line number
   * @param {number} [column] 1-based column number
   */
  constructor(message, line = 0, column = 0) {
    super(message);
    this.name = 'MermaidParseError';
    /** @type {number} */
    this.line = line;
    /** @type {number} */
    this.column = column;
  }
}

/**
 * The `fail(message, position)` idiom from `packages/json/src/path.js`,
 * adapted to line/column. Throws; never returns.
 * @param {string} message
 * @param {number} line
 * @param {number} [column]
 * @returns {never}
 */
export function fail(message, line, column = 0) {
  throw new MermaidParseError(message, line, column);
}
