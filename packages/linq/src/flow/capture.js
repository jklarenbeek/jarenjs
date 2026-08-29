//@ts-check
/**
 * @file The one capture under every query-valued member of the flow
 * documents: a transition guard and an effect's `with` over
 * FLOW-FORMAT §3's step scope, a `query` node's document, a task's
 * `with` and an edge's `select` over §6.1's input scope.
 *
 * The scope binds NO externals — both engines evaluate these with a
 * single `$` and nothing else — so a name read off the capture's second
 * argument is `JL0104` here, where the fix can be named, rather than
 * `JQ2006` at step time, where a guard that cannot bind reads as a
 * recorded false (FLOW-FORMAT §5.2). A returned literal is spelled as
 * the format's own constructor and never folded into `$const`:
 * §2's `{ "text": "retrying" }` is what a machine document carries.
 */

import { cloneJson } from '@jarenjs/core/object';
import { captureQuery } from '../capture-root.js';
import { requireJson } from '../json-boundary.js';

/**
 * One query-valued member: a callback captured over `$`, or a query
 * document written by hand, copied.
 * @param {string} what - the method, for the message
 * @param {string} scope - what `$` is bound to, for the `JL0104` advice
 * @param {any} value - a callback `(s) => …`, or a query document
 * @returns {any} the query document (plain JSON)
 */
export function queryMember(what, scope, value) {
  if (typeof value !== 'function') return cloneJson(requireJson(value, what));
  const advice = () => ` — ${what} evaluates over ${scope}, which its argument IS`;
  return cloneJson(captureQuery(what, [], value, { advice, fold: false, noun: 'callback' }));
}
