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

import { schemaTypeAt } from './ddl.js';

const KNOWN = new Set(['string', 'integer', 'number', 'boolean']);

/**
 * The planner-facing type of a member path.
 * @param {any} schema - The collection's document schema
 * @param {({ name: string } | { index: number })[]} segments
 * @returns {'string' | 'integer' | 'number' | 'boolean' | 'unknown'}
 */
export function typeOfPath(schema, segments) {
  const declared = schemaTypeAt(schema, segments);
  return declared !== undefined && KNOWN.has(declared)
    ? /** @type {any} */ (declared)
    : 'unknown';
}

/**
 * Whether a planner type is numeric (SQL comparison family).
 * @param {string} type
 * @returns {boolean}
 */
export function isNumericType(type) {
  return type === 'integer' || type === 'number';
}
