//@ts-check

//#region Canonical instants, samples and intervals
// The one door every temporal kernel enters through. A consumer's rows
// arrive as whatever their source spells — an RFC 3339 string out of a
// document, epoch milliseconds out of a column, a member named `on` or
// `timestamp` rather than `at` — and everything downstream wants sorted
// numbers. Converting here, once, is what lets the algebra and the
// index stay integer arithmetic over a sorted array.
//
// Three rules make that conversion safe to build on:
//
//   **A row is never dropped.** A member that cannot become a finite
//   instant is a TypeError naming the row, not a silently shorter
//   result. Quietly discarding the one malformed sample in ten thousand
//   is how an aggregate becomes wrong without anything looking wrong.
//
//   **Sorting is stable.** Two samples at the same instant come out in
//   the order they went in, and both participate in an aggregate. A
//   duplicate instant is real data — two readings in the same
//   millisecond — not a key collision to resolve.
//
//   **A value may be absent, but only explicitly.** `null` is a
//   measured gap and survives; `undefined`, a string or a NaN is a
//   defect and is refused.
//
// There is no clock here and no zone here. A full-date reads as UTC
// midnight because RFC 3339 gives it no offset; a full-time has no
// instant at all and is refused rather than being invented a day.

import { parseRFC3339Parts, epochOfRFC3339Parts } from '../dates/rfc3339.js';
import { selectorOf, requireRow } from './selector.js';

/**
 * @typedef {Object} Sample
 * @property {number} at - Unix epoch milliseconds
 * @property {number | null} value - the reading, or `null` for a
 *   measured gap
 */

/**
 * @typedef {Object} Interval
 * @property {number} start - inclusive lower bound, epoch milliseconds
 * @property {number} end - exclusive upper bound, epoch milliseconds
 */

/**
 * The instant `value` names, in Unix epoch milliseconds.
 *
 * Accepts the two forms a date has in this suite: a finite **number**
 * (already epoch milliseconds, returned unchanged) and a valid **RFC
 * 3339 string**. A full-date reads as UTC midnight, an offset shifts to
 * the instant it names, and `Z` is UTC.
 *
 * Refused, all as `TypeError`: a full-time (`'09:30:00Z'` names no day,
 * and inventing one would be a hidden clock), a date-time without an
 * offset (`'2026-01-01T09:30:00'` names no instant without a zone),
 * `NaN`/`Infinity`, a `Date` object (dates are strings or numbers here,
 * never a wrapper), and anything else.
 *
 * @param {number | string} value
 * @returns {number} epoch milliseconds
 * @throws {TypeError} when `value` names no instant
 * @example
 * toEpoch(0);                      // 0
 * toEpoch('1970-01-01');           // 0
 * toEpoch('1970-01-01T01:00:00+01:00'); // 0
 */
export function toEpoch(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`${value} is not an instant`);
    return value;
  }
  if (typeof value === 'string') {
    const parts = parseRFC3339Parts(value);
    const ms = parts === null ? NaN : epochOfRFC3339Parts(parts);
    if (!Number.isFinite(ms))
      throw new TypeError(`'${value}' is not an RFC 3339 instant`);
    return ms;
  }
  throw new TypeError('an instant is epoch milliseconds or an RFC 3339 string');
}

/**
 * One instant read out of a row, with the row named when it is not one.
 * "not an RFC 3339 instant" is a puzzle when ten thousand rows were
 * handed in; "row 4172, at: …" is a defect someone can go and look at.
 *
 * @param {any} value - the raw member
 * @param {string} role - the member's name, for the message
 * @param {number} index - the row's position
 * @returns {number} epoch milliseconds
 * @throws {TypeError} when `value` names no instant
 */
export function epochAt(value, role, index) {
  try {
    return toEpoch(value);
  }
  catch (error) {
    throw new TypeError(`row ${index}, ${role}: ${
      error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Is this array already ascending on `key`? An input that arrives
 * sorted — a column read back in order, a stream appended in time — is
 * the common case, and O(n) to confirm.
 * @param {any[]} rows
 * @param {string} key
 * @returns {boolean}
 */
function isAscending(rows, key) {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1][key] > rows[i][key])
      return false;
  }
  return true;
}

/**
 * Sorted canonical samples: every row's instant converted once, its
 * value checked, its other members kept, and the whole ascending by
 * instant.
 *
 * The sort is **stable**, so rows sharing an instant come out in input
 * order — and both are present, because a duplicate instant is two
 * readings, not one row written twice.
 *
 * Each result is a shallow copy of its source row with canonical `at`
 * and `value` members written over it, so a source that spelled its
 * instant `on` keeps `on` too and nothing a caller attached is lost.
 *
 * @param {any[]} rows - the source rows
 * @param {Object} [options]
 * @param {string | ((item: any, index: number) => any)} [options.at]
 *   where the instant lives (default `'at'`)
 * @param {string | ((item: any, index: number) => any)} [options.value]
 *   where the reading lives (default `'value'`)
 * @returns {(Sample & Record<string, any>)[]} a new array of new records
 * @throws {TypeError} for a non-array, a row that is not an object, an
 *   instant that names none, or a value that is neither a finite number
 *   nor `null`
 * @example
 * normalizeSeries([{ on: '2026-01-01T00:00:01Z', v: 2 },
 *                  { on: '2026-01-01T00:00:00Z', v: 1 }],
 *                 { at: 'on', value: 'v' });
 * // [{ on: '…:00Z', v: 1, at: 1767225600000, value: 1 },
 * //  { on: '…:01Z', v: 2, at: 1767225601000, value: 2 }]
 */
export function normalizeSeries(rows, options = {}) {
  if (!Array.isArray(rows))
    throw new TypeError('a series is an array of rows');
  const readAt = selectorOf(options.at ?? 'at', 'at');
  const readValue = selectorOf(options.value ?? 'value', 'value');
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = requireRow(rows[i], i);
    const at = epochAt(readAt(row, i), 'at', i);
    const value = readValue(row, i);
    if (value !== null && !(typeof value === 'number' && Number.isFinite(value)))
      throw new TypeError(`row ${i}, value: neither a finite number nor null`);
    out[i] = { ...row, at, value };
  }
  if (!isAscending(out, 'at'))
    out.sort(compareAt);
  return out;
}

/** @param {Sample} a @param {Sample} b @returns {number} */
function compareAt(a, b) {
  return a.at - b.at;
}

/**
 * Sorted canonical intervals: every bound converted once, the direction
 * checked, other members kept, and the whole ascending by start.
 *
 * Half-open `[start, end)` with `start < end` is the contract the whole
 * algebra rests on, so an empty (`start === end`), reversed or
 * non-finite interval is refused here rather than producing an answer
 * later that no reader could predict. Duplicates survive — two bookings
 * of the same slot are two bookings — and rows sharing a start keep
 * their input order.
 *
 * @param {any[]} rows - the source rows
 * @param {Object} [options]
 * @param {string | ((item: any, index: number) => any)} [options.start]
 *   where the lower bound lives (default `'start'`)
 * @param {string | ((item: any, index: number) => any)} [options.end]
 *   where the upper bound lives (default `'end'`)
 * @returns {(Interval & Record<string, any>)[]} a new array of new records
 * @throws {TypeError} for a non-array, a row that is not an object, a
 *   bound that names no instant, or `end <= start`
 * @example
 * normalizeIntervals([{ start: '2026-01-01', end: '2026-01-02' }]);
 * // [{ start: 1767225600000, end: 1767312000000 }]
 */
export function normalizeIntervals(rows, options = {}) {
  if (!Array.isArray(rows))
    throw new TypeError('intervals are an array of rows');
  const readStart = selectorOf(options.start ?? 'start', 'start');
  const readEnd = selectorOf(options.end ?? 'end', 'end');
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = requireRow(rows[i], i);
    const start = epochAt(readStart(row, i), 'start', i);
    const end = epochAt(readEnd(row, i), 'end', i);
    if (!(start < end))
      throw new TypeError(`row ${i}: an interval ends at ${end}, at or before its start ${start}`);
    out[i] = { ...row, start, end };
  }
  if (!isAscending(out, 'start'))
    out.sort(compareStart);
  return out;
}

/** @param {Interval} a @param {Interval} b @returns {number} */
function compareStart(a, b) {
  return a.start - b.start;
}

/**
 * The index of the first row at or after `at` — the lower end of a
 * half-open cut. `rows` must already be ascending on `key`.
 *
 * This is the whole reason a series is normalized once: a range over a
 * sorted array is two binary searches and a slice, not a pass over
 * everything.
 *
 * @param {any[]} rows - ascending on `key`
 * @param {number} at - epoch milliseconds
 * @param {string} [key] - the member holding the instant (default `'at'`)
 * @returns {number} an index in `[0, rows.length]`
 * @example
 * const lo = lowerBoundTime(samples, start);
 * const hi = lowerBoundTime(samples, end);
 * samples.slice(lo, hi); // every sample in [start, end)
 */
export function lowerBoundTime(rows, at, key = 'at') {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid][key] < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The index of the first row strictly after `at`. `rows` must already
 * be ascending on `key`.
 *
 * The twin of {@link lowerBoundTime}: together they bracket the rows AT
 * an instant (`[lowerBoundTime(rows, t), upperBoundTime(rows, t))`),
 * which is what a duplicate-tolerant as-of has to read.
 *
 * @param {any[]} rows - ascending on `key`
 * @param {number} at - epoch milliseconds
 * @param {string} [key] - the member holding the instant (default `'at'`)
 * @returns {number} an index in `[0, rows.length]`
 */
export function upperBoundTime(rows, at, key = 'at') {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid][key] <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

//#endregion
