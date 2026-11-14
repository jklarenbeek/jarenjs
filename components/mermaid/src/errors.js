//@ts-check
/**
 * @file The engine's one error type. Parsers raise it with a 1-based
 * `line`/`column`; the render path (`diagramToVnode`/`renderMermaid`)
 * catches it and emits a clear error vnode instead of throwing, so
 * rendering is always total.
 */

import { mermaidEnglish } from './messages.js';

export class MermaidParseError extends Error {
  /**
   * @param {string} message - the English text
   * @param {number} [line] 1-based line number
   * @param {number} [column] 1-based column number
   * @param {string} [msgid] the diagnostic's id in `mermaidMessagesEn`,
   *   which a reader's catalog translates (`mermaidErrorText`)
   * @param {Record<string, unknown>} [params] the diagnostic's parameters
   */
  constructor(message, line = 0, column = 0, msgid = undefined, params = {}) {
    super(message);
    this.name = 'MermaidParseError';
    /** @type {number} */
    this.line = line;
    /** @type {number} */
    this.column = column;
    /** @type {string | undefined} */
    this.msgid = msgid;
    /** @type {Record<string, unknown>} */
    this.params = params;
  }
}

/**
 * Raise the diagnostic `id` (a `mermaidMessagesEn` id) — the
 * `fail(message, position)` idiom from `packages/json/src/path.js`, adapted
 * to line/column and to a message id: its English is the error's `message`,
 * and the id and parameters ride along so the error card can speak the
 * reader's language (`mermaidErrorText`). Throws; never returns.
 * @param {string} id
 * @param {Record<string, unknown>} params
 * @param {number} line
 * @param {number} [column]
 * @returns {never}
 */
export function failWith(id, params, line, column = 0) {
  throw new MermaidParseError(mermaidEnglish(id, params), line, column, id, params);
}

/**
 * Raise the refusal an adapter answered (`{ value: null, error, msgid, params }`).
 * @param {{ error: string | null, msgid?: string, params?: Record<string, unknown> }} refusal
 * @param {number} line
 * @returns {never}
 */
export function failFrom(refusal, line) {
  return failWith(String(refusal.msgid), refusal.params ?? {}, line);
}
