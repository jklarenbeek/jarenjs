//@ts-check
/**
 * @file Schema-derived path typing: the collection's JSON Schema is the
 * planner's type source (there is no engine-side inference in this
 * phase — the store's own contract carries the types). Where the
 * schema says nothing, the answer is `'unknown'` and the planner emits
 * the defensive form; the guards in the truth table make `'unknown'`
 * safe, so typing here only ever IMPROVES a plan (column choice), it
 * never weakens one.
 */

import { schemaNodeAt, schemaTypeAt } from './ddl.js';
import { SCALAR_TYPES } from './scalar-types.js';

/**
 * The planner-facing type of a member path. A member declared with more
 * than one type is typed by the first (the type its column takes its
 * storage from), except that one declared `integer` and also `number` is a
 * number: it may hold a fraction, and the planner reads `integer` as
 * "every value is whole" — the claim an exact sum rests on.
 * @param {any} schema - The collection's document schema
 * @param {({ name: string } | { index: number })[]} segments
 * @returns {'string' | 'integer' | 'number' | 'boolean' | 'unknown'}
 */
export function typeOfPath(schema, segments) {
  const declared = schemaTypeAt(schema, segments);
  if (declared === undefined || !SCALAR_TYPES.has(declared)) return 'unknown';
  if (declared === 'integer') {
    const union = schemaNodeAt(schema, segments)?.type;
    if (Array.isArray(union) && union.includes('number')) return 'number';
  }
  return /** @type {any} */ (declared);
}

/**
 * Whether a planner type is numeric (SQL comparison family).
 * @param {string} type
 * @returns {boolean}
 */
export function isNumericType(type) {
  return type === 'integer' || type === 'number';
}
