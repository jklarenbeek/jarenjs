//#region Jaren JSON Query sequence runtime
// The tagged sequence representation of the query engine (QUERY-FORMAT.md
// section 2.1). Items are JSON values, and JSON arrays ARE items, so a
// sequence needs a representation that can never be confused with a value:
//
//   - the empty sequence is the exported `EMPTY` singleton symbol;
//   - a singleton sequence is the raw item itself (no wrapper, no
//     allocation - "singleton = item", spec section 2.1 rule 5);
//   - a sequence of two or more items is a `Seq` instance.
//
// Seqs are always flat: a Seq never contains another Seq, EMPTY, or fewer
// than two items. All constructors go through `seqOf`/`appendItem`, which
// maintain the invariant; `assertSeqInvariant` checks it in tests.

import { JsonQueryRuntimeError } from './errors.js';

/**
 * The empty sequence `()` (same singleton-sentinel pattern as
 * `JSONPATH_NOTHING`).
 */
export const EMPTY = Symbol('JsonQuery.Empty');

/**
 * A sequence of two or more items. Never constructed directly by
 * operator code - use `seqOf` so the flatness invariant holds.
 */
export class Seq {
  constructor(items) {
    this.items = items;
  }
}

/**
 * Build a sequence value from a flat accumulator array of items.
 * Returns EMPTY for zero items, the raw item for one, a Seq otherwise.
 * The array is adopted, not copied; callers hand over ownership.
 * @param {any[]} items - flat array of items (no Seq, no EMPTY inside)
 * @returns {any} EMPTY, a single item, or a Seq
 */
export function seqOf(items) {
  const len = items.length;
  if (len === 0)
    return EMPTY;
  if (len === 1)
    return items[0];
  return new Seq(items);
}

/**
 * Append a sequence value's items to a plain accumulator array
 * (the shared flattening step of array constructors and `$seq`).
 * @param {any[]} list - accumulator array of items
 * @param {any} v - a sequence value (EMPTY, item, or Seq)
 */
export function appendItem(list, v) {
  if (v === EMPTY)
    return;
  if (v instanceof Seq) {
    const items = v.items;
    for (let i = 0; i < items.length; i++)
      list.push(items[i]);
    return;
  }
  list.push(v);
}

/**
 * Invoke `fn(item)` for each item of a sequence value, in order.
 * @param {any} v - a sequence value (EMPTY, item, or Seq)
 * @param {(item: any) => void} fn
 */
export function forEachItem(v, fn) {
  if (v === EMPTY)
    return;
  if (v instanceof Seq) {
    const items = v.items;
    for (let i = 0; i < items.length; i++)
      fn(items[i]);
    return;
  }
  fn(v);
}

/**
 * Number of items in a sequence value.
 * @param {any} v - a sequence value (EMPTY, item, or Seq)
 * @returns {number}
 */
export function itemCount(v) {
  if (v === EMPTY)
    return 0;
  if (v instanceof Seq)
    return v.items.length;
  return 1;
}

/**
 * First item of a sequence value, or EMPTY for the empty sequence.
 * @param {any} v - a sequence value (EMPTY, item, or Seq)
 * @returns {any}
 */
export function firstItem(v) {
  if (v instanceof Seq)
    return v.items[0];
  return v;
}

/**
 * Effective boolean value of a sequence value per the EBV table of
 * QUERY-FORMAT.md section 2.2 (D3: singleton array/object is true).
 * @param {any} v - a sequence value (EMPTY, item, or Seq)
 * @param {string} docPath - RFC 6901 pointer for the JQ2003 error
 * @returns {boolean}
 * @throws {JsonQueryRuntimeError} JQ2003 on a sequence of two or more items
 */
export function ebv(v, docPath) {
  if (v === EMPTY)
    return false;
  switch (typeof v) {
    case 'boolean':
      return v;
    case 'number':
      return v === v && v !== 0; // false for 0, -0, NaN
    case 'string':
      return v.length !== 0;
    default:
      if (v === null)
        return false;
      if (v instanceof Seq)
        throw new JsonQueryRuntimeError('JQ2003',
          'the effective boolean value of a sequence of two or more items is undefined', docPath);
      return true; // array or object (D3)
  }
}

/**
 * Deterministic serialization of one JSON item, for `$groupby` keys
 * (QUERY-FORMAT.md section 6.5) — **engine-internal**, not an interchange
 * format (related to the roadmap's canonical-JSON item). It exists solely
 * so that deep-equal items (D2) map to the same string:
 *
 *   - object members serialize sorted by key (code-unit order), so key
 *     order never matters;
 *   - `-0` normalizes to `0` (D2: `-0` equals `0`);
 *   - strings serialize via `JSON.stringify` (its escape discipline means
 *     no raw control character ever appears in the output, so a control
 *     character is safe as a composite-key separator);
 *   - numbers serialize bare via `String(n)` — `NaN` and `±Infinity`
 *     (reachable through `$div`) serialize as `NaN`/`Infinity`, which
 *     cannot collide with quoted strings. Note this makes `NaN` group
 *     with `NaN`, the XQuery grouping rule, even though `NaN` never
 *     equals itself under `$eq`.
 *
 * @param {any} value - a JSON item (not EMPTY, not a Seq)
 * @returns {string} a deterministic serialization for grouping
 */
export function stableKeyString(value) {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return value === 0 ? '0' : String(value); // normalizes -0
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      break;
  }
  if (value === null)
    return 'null';
  if (Array.isArray(value)) {
    let s = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0)
        s += ',';
      s += stableKeyString(value[i]);
    }
    return s + ']';
  }
  const keys = Object.keys(value).sort();
  let s = '{';
  for (let i = 0; i < keys.length; i++) {
    if (i > 0)
      s += ',';
    s += JSON.stringify(keys[i]) + ':' + stableKeyString(value[keys[i]]);
  }
  return s + '}';
}

/**
 * Debug-only invariant check: asserts a sequence value is well-formed
 * (a Seq holds 2+ items and contains no nested Seq or EMPTY). Used by
 * tests; never called on hot paths.
 * @param {any} v - a sequence value to check
 * @returns {any} v itself when well-formed
 * @throws {Error} when the flatness invariant is violated
 */
export function assertSeqInvariant(v) {
  if (v instanceof Seq) {
    if (v.items.length < 2)
      throw new Error(`Seq invariant violated: ${v.items.length} item(s) in a Seq`);
    for (let i = 0; i < v.items.length; i++) {
      const item = v.items[i];
      if (item instanceof Seq)
        throw new Error(`Seq invariant violated: nested Seq at index ${i}`);
      if (item === EMPTY)
        throw new Error(`Seq invariant violated: EMPTY inside a Seq at index ${i}`);
      if (item === undefined)
        throw new Error(`Seq invariant violated: undefined inside a Seq at index ${i}`);
    }
  }
  return v;
}

//#endregion
