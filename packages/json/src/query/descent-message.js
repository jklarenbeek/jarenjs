//@ts-check
/**
 * The refusal of a descendant segment past its nesting bound, kept apart
 * from the query catalog (`./messages.js`) so a JSONPath-only bundle, which
 * raises it, does not carry every query message: the catalog reads its
 * entry from here, and the error carries the same `messageId`, `params` and
 * `docPath` a `queryRuntimeError` would.
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
