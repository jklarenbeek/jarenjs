//@ts-check
/**
 * @file The one decoder every SQLite binding reads a stored 64-bit integer
 * through. A binding hands an INTEGER back as a `bigint` (node:sqlite's
 * `setReadBigInts`, bun:sqlite's `safeIntegers`, the wasm build past
 * ±(2^53 - 1)), and this module turns each into the number the store reads:
 * the integer itself where a double holds it exactly — every integer the
 * store writes — and a refusal (`JD2003` once the driver error is coded)
 * where the number would round it ({@link storedIntegerNumber}).
 */

import { storedIntegerNumber } from '../errors.js';

/** A declared type whose affinity never hands an INTEGER back: TEXT turns a
 * number into text when it stores it and REAL into a double (SQLite's
 * affinity rules, in their order: `INT` first, then the text words, then the
 * real ones). */
const NO_INTEGER = /^(?!.*INT)(?:.*(?:CHAR|CLOB|TEXT|REAL|FLOA|DOUB))/i;

/**
 * The result columns that can hand back a stored 64-bit integer: every
 * column but one whose declared type has TEXT or REAL affinity — an
 * expression (no declared type), or a column of INTEGER, NUMERIC or no affinity.
 * @param {{ name: string, type?: string | null }[]} columns - the result
 *   columns, each with its declared type (`null` for an expression)
 * @returns {string[]} the names
 */
export function integerColumns(columns) {
  const names = [];
  for (const column of columns)
    if (typeof column.type !== 'string' || !NO_INTEGER.test(column.type)) names.push(column.name);
  return names;
}

/**
 * Decode, in place, each of a row's named columns a binding handed back as a
 * `bigint` ({@link storedIntegerNumber}).
 * @template T
 * @param {T} row - a row object, or `undefined` for no row
 * @param {readonly string[]} names
 * @returns {T}
 */
export function decodeIntegers(row, names) {
  if (row === undefined || row === null) return row;
  const record = /** @type {any} */ (row);
  for (let i = 0; i < names.length; i++) {
    const value = record[names[i]];
    if (typeof value === 'bigint') record[names[i]] = storedIntegerNumber(value);
  }
  return row;
}

/**
 * A write's counts as numbers: a binding reading integers as `bigint`
 * reports `changes` and `lastInsertRowid` as one too.
 * @param {any} result - `{ changes, lastInsertRowid }`
 * @returns {any}
 */
export function decodeRunResult(result) {
  if (typeof result?.changes !== 'bigint' && typeof result?.lastInsertRowid !== 'bigint') return result;
  return { ...result,
    changes: typeof result.changes === 'bigint' ? storedIntegerNumber(result.changes) : result.changes,
    lastInsertRowid: typeof result.lastInsertRowid === 'bigint'
      ? storedIntegerNumber(result.lastInsertRowid) : result.lastInsertRowid };
}

/**
 * A row iterator that decodes each row it yields, closing the one it wraps
 * when it is closed.
 * @param {Iterator<any>} iterator
 * @param {readonly string[]} names
 * @returns {IterableIterator<any>}
 */
export function decodingIterator(iterator, names) {
  return {
    next() {
      const step = iterator.next();
      if (!step.done) decodeIntegers(step.value, names);
      return step;
    },
    return(value) {
      return iterator.return?.(value) ?? { done: true, value };
    },
    [Symbol.iterator]() { return this; },
  };
}
