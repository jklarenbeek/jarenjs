//@ts-check
/**
 * @file The JSON boundary every value entering a pen's document crosses
 * (`JL0101`): a default, a literal, an annotation, a hand-written
 * schema or query document, a mode name, a priority. One predicate for
 * every pen — the constant rule of LINQ-FORMAT §5, applied at the door:
 * null, booleans, finite numbers (never `-0`), strings, arrays and plain
 * objects, and nothing else — a function, symbol, bigint, `NaN`,
 * `±Infinity`, a class instance or a cycle is refused by name.
 *
 * Beside it, one predicate for the OTHER door a pen has: the name → value
 * map it reads its members out of (`requireNameMap`). There the hazard is
 * not a value the document cannot carry but a member that never arrived —
 * `{ __proto__: builder }` sets the object's prototype instead of adding
 * a key — and the prototype is the only trace of it left to refuse by.
 */

import { isJsonValue } from '@jarenjs/core/object';
import { LinqBuildError } from './errors.js';
import { isExpression } from './expression.js';

/**
 * `-0` is JSON-representable by text and not by value: it shares its
 * text with `0` while dividing to the opposite infinity, so a document
 * holding it cannot be keyed, stored or compared faithfully.
 * @param {any} value
 * @returns {boolean}
 */
function hasNegativeZero(value) {
  if (typeof value === 'number') return Object.is(value, -0);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasNegativeZero);
  return Object.keys(value).some((key) => hasNegativeZero(value[key]));
}

/** What a refused value is, for a message. @param {any} value */
export function describeValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (isExpression(value)) return 'an expression'; // a proxy: reading `.constructor` would record a path
  if (typeof value === 'object') return `a ${value.constructor?.name ?? 'non-plain'} instance`;
  return `a ${typeof value}`;
}

/**
 * The value, when it is JSON; `JL0101` naming what it was otherwise.
 * @template T
 * @param {T} value
 * @param {string} what - the keyword or method, for the message
 * @returns {T}
 */
export function requireJson(value, what) {
  if (isJsonValue(value) && !hasNegativeZero(value)) return value;
  throw new LinqBuildError('JL0101',
    `${what} received ${describeValue(value)}, which is not JSON — a document carries `
    + 'null, booleans, finite numbers (never -0), strings, arrays and plain objects, '
    + 'and nothing else');
}

/**
 * A name → value map a pen reads by its OWN keys — an object of
 * builders, operations, nodes, actions or modes.
 *
 * `{ __proto__: x }` in an object LITERAL sets the object's prototype
 * instead of adding a member, so that member never reaches the pen:
 * there is nothing to emit and nothing to see. The one thing that IS
 * visible is the prototype, and no plain map has one — so the map is
 * refused by it rather than emitted a member short. A computed key
 * (`{ ['__proto__']: x }`) is an ordinary own property and passes, as
 * does `Object.create(null)`.
 *
 * @template T
 * @param {T} value - a non-null, non-array object
 * @param {string} what - the method, for the message
 * @param {string} [at] - the docPath of the node being assembled
 * @returns {T}
 */
export function requireNameMap(value, what, at) {
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return value;
  throw new LinqBuildError('JL0101',
    `${what} received a map whose prototype was replaced: a '__proto__:' key in an object `
    + 'literal sets the prototype instead of adding a member, so that member is not there to '
    + "emit — spell it { ['__proto__']: … }, which is an own key", at);
}
