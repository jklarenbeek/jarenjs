//@ts-check
/** JSON snapshots and diagnostics shared by formula, migration and review compilers. */
import { cloneJson, deepFreeze, isJsonObject } from '@jarenjs/core/object';
import { canonicalizeJson } from '../canonical.js';
import { CodedDocPathError } from '../errors.js';
import { messageRef, renderMessageId } from '../message-ref.js';
import { formulaMessagesEn } from './messages.js';

/**
 * A formula diagnosis includes the saved identity and the document location.
 * Its reason is a message of `formulaMessagesEn`, referenced as `{ messageId,
 * params }` (`formulaMessage`), which names it as a query error names its
 * own: `messageId`, and `params` with the formula's id and the English
 * (`params.reason`) a catalog without the formula's messages renders. A
 * reason given as text (a host's, another module's) is `query/reason`.
 */
export class FormulaError extends CodedDocPathError {
  /**
   * @param {string} code
   * @param {string | { messageId: string, params: Record<string, any> }} reason
   * @param {string} formulaId
   * @param {string} [docPath]
   * @param {unknown} [cause]
   */
  constructor(code, reason, formulaId, docPath = '', cause = undefined) {
    const named = typeof reason === 'string' ? null : formulaDiagnostic(reason, formulaId, cause);
    super('FormulaError', code, named === null ? `${formulaId}: ${reason}` : named.message, docPath, cause);
    this.formulaId = formulaId;
    this.messageId = named === null ? 'query/reason' : named.messageId;
    this.params = named === null ? { reason: this.reason } : named.params;
  }
}

/**
 * A formula message as the fields a diagnostic record carries: its English
 * (`message`), its `messageId`, and its `params` with the formula's id and
 * that English (`reason`), as a FormulaError carries them. A query error's
 * own message nested in it renders in English as that error already did
 * (its `reason`), so a formula's messages never carry the query engine's
 * catalog.
 * @param {{ messageId: string, params: Record<string, any> }} reference @param {string} formulaId
 * @param {any} [cause] - the error the message wraps, if any
 */
export function formulaDiagnostic(reference, formulaId, cause = undefined) {
  const params = { formulaId, ...reference.params };
  const english = (/** @type {string} */ messageId) =>
    (typeof cause?.messageId === 'string' && messageId === cause.messageId ? String(cause.reason) : undefined);
  const message = renderMessageId(reference.messageId, params, formulaMessagesEn, english);
  return { message, messageId: reference.messageId, params: { ...params, reason: message } };
}

/**
 * A formula message as a reference: an id of `formulaMessagesEn` and its params.
 * @param {string} messageId @param {Record<string, any>} [params]
 */
export const formulaMessage = (messageId, params = {}) => messageRef(messageId, params);

/**
 * What a cause of a formula error says: a query error's own message (its id
 * and params), or another component's text as a detail.
 * @param {any} cause
 */
export function causeMessage(cause) {
  return typeof cause?.messageId === 'string' && isJsonObject(cause.params)
    ? formulaMessage('query/formula/query', { message: messageRef(cause.messageId, cause.params) })
    : formulaMessage('query/formula/detail', { detail: String(cause?.reason ?? cause?.message ?? cause) });
}

/** Validate before copying: no dropped undefined, host objects or non-finite numbers. */
export function snapshot(value) {
  canonicalizeJson(value);
  return deepFreeze(cloneJson(value));
}

/** Positive finite work credit, never a promise of a same-thread deadline. */
export function credit(value, fallback, name) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}
