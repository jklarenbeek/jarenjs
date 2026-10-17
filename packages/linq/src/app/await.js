//@ts-check
/**
 * @file `awaiting()` — an awaiting action (APP-FORMAT §3.3) by code: the
 * start, the effect it awaits, and the continuation on its result or its
 * failure, as one `{ "$await": … }` action.
 *
 * Each member is its own query with its own closed scope, and the pen
 * captures each in exactly that scope, so a name the runtime does not
 * bind there is `JL0104` here rather than the `JA0004` the app would
 * raise when it compiles: `start` and `with` see `$event` and `$payload`,
 * `then` adds `$result` and `catch` adds `$error`. `start`, `then` and
 * `catch` are transitions (a `when()` may guard them); `with` is a value.
 */

import { isJsonObject } from '@jarenjs/core/object';
import { LinqBuildError } from '../errors.js';
import { closedTo, describeValue, requireOwnJson } from '../json-boundary.js';
import { captureQuery } from '../capture-root.js';
import { declareAction, readActionOptions } from './action.js';

/** The members `awaiting()` takes: §3.3's own, a closed set. */
const AWAIT_MEMBERS = Object.freeze(['start', 'run', 'with', 'slot', 'then', 'catch']);

/** The externals each member's query binds (§3.3). */
const SCOPES = Object.freeze({
  start: ['event', 'payload'],
  with: ['event', 'payload'],
  then: ['event', 'payload', 'result'],
  catch: ['event', 'payload', 'error'],
});

/**
 * Capture one member over its own scope.
 * @param {'start' | 'with' | 'then' | 'catch'} member
 * @param {any} value - a callback, or (for `with`) a query document written by hand
 * @returns {any} the query document (plain JSON)
 */
function captureMember(member, value) {
  const what = `awaiting() ${member}`;
  if (typeof value !== 'function') {
    if (member === 'with') return requireOwnJson(value, what);
    throw new LinqBuildError('JL0101',
      `${what} is a callback (s, x) => transition(…), got ${describeValue(value)}`, `/${member}`);
  }
  const bound = SCOPES[member];
  const advice = () => ` — APP-FORMAT §3.3 binds ${bound.map((name) => `$${name}`).join(', ')} `
    + `in ${member} and nothing else`
    + (member === 'then' ? '; a failure reaches catch, as $error' : '')
    + (member === 'catch' ? '; a result reaches then, as $result' : '');
  return captureQuery(what, bound, value,
    { advice, fold: false, kind: member === 'with' ? undefined : 'action' });
}

/**
 * One awaiting action (APP-FORMAT §3.3): commit `start`, await the
 * registered effect `run` with the props `with` reads from the state the
 * start produced, and continue with `then` over `$result` — or `catch`
 * over `$error`, `{ code, message }` — in a transaction of its own. A
 * newer await on the same `slot` (the action's name when absent)
 * supersedes the one in flight.
 * @param {{ run: string, start?: Function, with?: any, slot?: string, then?: Function, catch?: Function }} spec
 * @param {{ payload?: any, event?: readonly string[] }} [options] - types
 *   only, as `action()` takes them
 * @returns {any} the action declaration
 * @throws {LinqBuildError} `JL0101` a member §3.3 does not list, an empty
 *   `run` or `slot`, or a member that is not a callback; `JL0104` a name
 *   the member's scope does not bind
 * @example
 * awaiting({
 *   start: (s, x) => transition({ patch: [replace((st) => st.status, 'loading')] }),
 *   run: 'fetchJson',
 *   with: (s) => ({ url: s.query }),
 *   then: (s, x) => transition({ patch: [replace((st) => st.users, x.result)] }),
 *   catch: (s, x) => transition({ patch: [replace((st) => st.error, x.error)] }),
 * });
 */
export function awaiting(spec, options = undefined) {
  if (!isJsonObject(spec)) {
    throw new LinqBuildError('JL0101',
      `awaiting() takes { run, start?, with?, slot?, then?, catch? }, got ${describeValue(spec)}`);
  }
  closedTo(spec, AWAIT_MEMBERS, 'awaiting()');
  readActionOptions(options, 'awaiting()');
  for (const member of ['run', 'slot']) {
    if (member === 'slot' && spec.slot === undefined) continue;
    if (typeof spec[member] !== 'string' || spec[member] === '') {
      throw new LinqBuildError('JL0101',
        `awaiting() ${member} is ${member === 'run' ? 'the registered effect\'s name' : 'the await\'s identity'} `
        + `as a non-empty string, got ${describeValue(spec[member])}`, `/${member}`);
    }
  }
  /** @type {Record<string, any>} */
  const body = {};
  for (const member of AWAIT_MEMBERS) {
    if (spec[member] === undefined) continue;
    body[member] = member === 'run' || member === 'slot'
      ? spec[member]
      : captureMember(/** @type {'start' | 'with' | 'then' | 'catch'} */ (member), spec[member]);
  }
  return declareAction({ $await: body });
}
