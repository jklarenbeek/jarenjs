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
 * @param {string} [msgid] the message's id in `calcMessagesEn`
 * @param {Record<string, unknown>} [params] its parameters
 * @returns {CalcParseError}
 */
export function errorAt(message, source, position, msgid, params) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < position && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) { line++; column = 1; } else column++;
  }
  return new CalcParseError(message, line, column, position, msgid, params);
}

export class CalcParseError extends Error {
  /**
   * @param {string} message
   * @param {number} [line] 1-based line
   * @param {number} [column] 1-based column
   * @param {number} [position] 0-based char offset
   * @param {string} [msgid] the message's id in `calcMessagesEn`, which a
   *   reader's catalog translates (`message` is its English)
   * @param {Record<string, unknown>} [params] the message's parameters
   */
  constructor(message, line = 1, column = 1, position = 0, msgid = undefined, params = {}) {
    super(message);
    this.name = 'CalcParseError';
    this.line = line;
    this.column = column;
    this.position = position;
    /** @type {string | undefined} */
    this.msgid = msgid;
    /** @type {Record<string, unknown>} */
    this.params = params;
  }
}
