//@ts-check
/**
 * @file The one capture under an app document's query-valued members.
 *
 * An action is a query document evaluated with three names and no others
 * (APP-FORMAT §3.1): `$` is the whole state, `$event` the serializable
 * event slice, `$payload` the dispatch payload. So a callback receives
 * the state at its first argument and those two externals at its second,
 * and a name the loop does not bind is `JL0104` here — where the fix can
 * be named — rather than an unbound external at dispatch time.
 *
 * A subscription's dynamic members evaluate in a NARROWER scope: `when`
 * and `for` see the state alone, `withQuery` and `key` additionally see
 * `$item` and only under `for` (§5.3, "compiled closed-world"). The
 * pen mirrors that scope exactly, so a document it writes cannot be the
 * `JA0008` a free variable would be at `createApp` time.
 *
 * Every capture here folds NOTHING: a transition, a binding and an
 * effect's props are spelled as the constructors the format's own
 * examples carry (`{ "op": "replace", … }`, `{ "ms": 1000 }`), never
 * collapsed into one `$const`.
 */

import { captureQuery } from '../capture-root.js';

/** §3.1's ambient vocabulary, for a `JL0104` message. */
export const ACTION_SCOPE = 'an action document (APP-FORMAT §3.1)';

/** The externals the dispatch loop binds on every action. */
const ACTION_EXTERNALS = Object.freeze(['event', 'payload']);

/** How an unbound action name could be reached, appended to `JL0104`. */
const ACTION_ADVICE = () => ' — the whole state is the first argument; §3.1 binds $event and '
  + '$payload and nothing else, and a host value reaches an action through a binding\'s '
  + 'payload or an event-field extractor';

/**
 * Capture one action-scope callback: `(s, x) => …` over `$`, `$event`
 * and `$payload`.
 * @param {string} what - the method, for the message
 * @param {(state: any, externals: any) => any} fn
 * @returns {any} the query document (plain JSON)
 */
export function captureAction(what, fn) {
  return captureQuery(what, ACTION_EXTERNALS, fn, { advice: ACTION_ADVICE, fold: false });
}

/**
 * Capture one subscription member over §5.3's closed world.
 * @param {string} what - the member, for the message
 * @param {readonly string[]} externals - `['item']` under `for`, else none
 * @param {any} value - a callback, or a query document written by hand
 * @returns {any} the query document (plain JSON)
 */
export function captureSub(what, externals, value) {
  if (typeof value !== 'function') return JSON.parse(JSON.stringify(value));
  const advice = () => (externals.length === 0
    ? ` — a subscription's ${what} is compiled closed-world against the state alone; $item `
      + 'exists only under a "for" declaration (APP-FORMAT §5.3)'
    : ` — a subscription's ${what} under "for" sees the state and $item, nothing else `
      + '(APP-FORMAT §5.3)');
  return captureQuery(`sub() ${what}`, externals, value, { advice, fold: false });
}
