//@ts-check
/**
 * @file `sub()` — one subscription entry (APP-FORMAT §5.3):
 * `{ run, with?, when?, withQuery?, key?, for? }`, in the member order
 * the format writes them.
 *
 * The distinction the format makes its whole restart rule out of is the
 * one the pen makes at the door: `with` is VERBATIM data and never
 * evaluated — a static entry never restarts — while `withQuery`, `key`
 * and `for` are callbacks captured as queries, which is what makes an
 * entry dynamic. A member that is sometimes data and sometimes
 * executable is how a document becomes accidentally executable, so the
 * pen refuses a callback under `with` before the runtime would pass it
 * to a handler as props.
 *
 * The combinations §5.3 calls `JA0008` — `with` beside `withQuery`,
 * `with` beside `for`, `key` without either — are refused here, naming
 * the same reason, because the pen can see all three members at once.
 */

import { LinqBuildError } from '../errors.js';
import { describeValue, requireJson } from '../json-boundary.js';
import { captureSub } from './capture.js';

/** The subscription brand: how `defineApp` tells one apart. */
export const SUB = Symbol.for('@jarenjs/linq/app-sub');

/** The members `sub()` takes beside its `run` name. */
const SUB_MEMBERS = Object.freeze(['with', 'when', 'withQuery', 'key', 'for']);

/** The order §5.3 writes an entry's members in. */
const ENTRY_ORDER = Object.freeze(['run', 'with', 'when', 'withQuery', 'key', 'for']);

/**
 * One subscription entry (§5.3). `run` names a registered handler
 * (`options.subs[run]`); `when` decides liveness by effective boolean
 * value after boot and after every state change.
 *
 * @param {string} run - the registered handler name
 * @param {{ with?: any, when?: any, withQuery?: any, key?: any, for?: any }} [options]
 * @returns {any} the subscription declaration
 * @throws {LinqBuildError} `JL0101` an empty `run`, a member the pen does
 *   not know, or a callback under `with`; `JL0102` a combination §5.3
 *   refuses; `JL0104` a name the closed world does not bind
 * @example
 * sub('interval', { with: { ms: 1000, tick: 'tick' }, when: (s) => s.running });
 * sub('room', { for: (s) => s.rooms.all(), withQuery: (s, x) => ({ id: x.item.id }) });
 */
export function sub(run, options = undefined) {
  if (typeof run !== 'string' || run === '') {
    throw new LinqBuildError('JL0101',
      `sub() takes the handler name as a non-empty string, got ${describeValue(run)}`, '/run');
  }
  const entry = { run };
  if (options !== undefined) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new LinqBuildError('JL0101',
        `sub() options are { with?, when?, withQuery?, key?, for? }, got ${describeValue(options)}`);
    }
    for (const key of Object.keys(options)) {
      if (!SUB_MEMBERS.includes(key)) {
        throw new LinqBuildError('JL0101',
          `sub() does not take '${key}' — it takes ${SUB_MEMBERS.join(', ')} (APP-FORMAT §5.3)`,
          `/${key}`);
      }
    }
    if (options.with !== undefined && options.withQuery !== undefined) {
      throw new LinqBuildError('JL0102',
        "sub() carries both 'with' and 'withQuery' — one entry, one props source: 'with' is "
        + "verbatim data and never restarts, 'withQuery' derives the props from the state "
        + 'and makes the entry dynamic (APP-FORMAT §5.3, the runtime\'s JA0008)');
    }
    if (options.with !== undefined && options.for !== undefined) {
      throw new LinqBuildError('JL0102',
        "sub() carries 'with' beside 'for' — a fan-out's props come from 'withQuery', or "
        + 'default to the item itself (APP-FORMAT §5.3, the runtime\'s JA0008)');
    }
    if (options.key !== undefined && options.withQuery === undefined && options.for === undefined) {
      throw new LinqBuildError('JL0102',
        "sub() carries 'key' without 'withQuery' or 'for' — a static subscription never "
        + 'restarts, so it has no restart key (APP-FORMAT §5.3, the runtime\'s JA0008)',
        '/key');
    }
    if (options.with !== undefined) {
      if (typeof options.with === 'function') {
        throw new LinqBuildError('JL0101',
          "sub() 'with' is VERBATIM data handed to the handler, never evaluated — for props "
          + "derived from the state write 'withQuery' instead (APP-FORMAT §5.3)", '/with');
      }
      entry.with = JSON.parse(JSON.stringify(requireJson(options.with, "sub() 'with'")));
    }
    if (options.when !== undefined) entry.when = captureSub('when', [], options.when);
    const instance = options.for !== undefined ? Object.freeze(['item']) : Object.freeze([]);
    if (options.withQuery !== undefined) {
      entry.withQuery = captureSub('withQuery', instance, options.withQuery);
    }
    if (options.key !== undefined) entry.key = captureSub('key', instance, options.key);
    if (options.for !== undefined) entry.for = captureSub('for', [], options.for);
  }
  const out = {};
  for (const member of ENTRY_ORDER) {
    if (entry[member] !== undefined) out[member] = entry[member];
  }
  Object.defineProperty(out, SUB, { value: true, enumerable: false });
  return Object.freeze(out);
}
