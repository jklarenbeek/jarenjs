//@ts-check
/**
 * The refusals of a descendant segment, past its nesting bound or over a
 * cycle, kept apart from the query catalog (`./messages.js`) so a
 * JSONPath-only bundle, which raises them, does not carry every query
 * message: the catalog reads their entries from here, and each error
 * carries the same `messageId`, `params` and `docPath` a
 * `queryRuntimeError` would.
 */

import { JsonQueryRuntimeError } from './errors.js';

/** The message id of the descent refusal. */
export const DESCENT_LIMIT_ID = 'query/descent-limit';

/** Its English template, the query catalog's entry for {@link DESCENT_LIMIT_ID}. */
export const DESCENT_LIMIT_TEMPLATE = 'a descendant segment reaches a value nested deeper than {limit} levels';

/**
 * The `JQ2009` a descendant segment raises when it reaches a value nested
 * deeper than its bound.
 * @param {number} limit - The bound, in levels of nesting
 * @param {string} docPath - The query location that refused
 * @returns {JsonQueryRuntimeError}
 */
export function descentLimitError(limit, docPath) {
  // `limit` is a positive integer, which the catalog's template renderer
  // writes with String() too: the reason is the catalog's English rendering.
  return new JsonQueryRuntimeError('JQ2009', DESCENT_LIMIT_TEMPLATE.replace('{limit}', String(limit)), docPath,
    { messageId: DESCENT_LIMIT_ID, params: { limit } });
}

/** The message id of the cycle refusal. */
export const DESCENT_CYCLE_ID = 'query/descent-cycle';

/** Its English template, the query catalog's entry for {@link DESCENT_CYCLE_ID}. */
export const DESCENT_CYCLE_TEMPLATE = 'a descendant segment reaches a circular reference closed by data member {member}';

/**
 * The `JQ2016` a descendant segment raises when the value it walks holds
 * a cycle, which no bound on its nesting could answer.
 * @param {string} member - The JSON Pointer of the data member that closes the cycle
 * @param {string} docPath - The query location that refused
 * @returns {JsonQueryRuntimeError}
 */
export function descentCycleError(member, docPath) {
  // a replacer function, so a `$` in a member name is written as it is
  return new JsonQueryRuntimeError('JQ2016', DESCENT_CYCLE_TEMPLATE.replace('{member}', () => member), docPath,
    { messageId: DESCENT_CYCLE_ID, params: { member } });
}
