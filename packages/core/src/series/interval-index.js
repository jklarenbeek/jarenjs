//@ts-check

//#region Static interval index
// Build once, query many: which of these spans hold this instant, and
// which of them overlap this window. Asking every span is O(n) per
// query, which is what makes a calendar with ten thousand events feel
// like a calendar with ten thousand events.
//
// **Sorting by start is not enough, and the reason is worth stating.**
// A binary search finds where a query's start falls among the starts —
// but a span that began a year earlier and has not ended yet sits far
// to the LEFT of that neighbourhood and still overlaps. A conference
// week among hourly meetings is exactly that span, and an index that
// merely cuts around the query silently loses it: the answer stays
// plausible, and it is wrong.
//
// So the index carries a second array: `maxEnd[i]` is the furthest any
// of the first `i + 1` spans reaches. It is non-decreasing by
// construction, which makes it binary-searchable too — and the first
// position where it passes the query's start is the first position
// where any span can still be live. Everything left of it ended before
// the query began, whatever its start said.
//
// A query is therefore two binary cuts and a walk between them: the
// left cut from `maxEnd` and the right cut from `starts`. No pass over
// the whole array, no per-query sort, and no long span quietly missing.
//
// **Static** is deliberate, as it is for the spatial box index. The
// bounds are copied into flat typed arrays at build time, so a query
// reads no source objects at all and a later mutation of a caller's row
// cannot change what the index answers. Results are the ORIGINAL items,
// in ascending start order — an index that returned copies would make
// "which booking" unanswerable.

import { toEpoch, epochAt } from './normalize.js';
import { selectorOf, requireRow } from './selector.js';

/**
 * @typedef {Object} IntervalIndex
 * @property {number} size - how many intervals were indexed
 * @property {(at: number | string) => any[]} at - the items whose
 *   `[start, end)` contains this instant
 * @property {(start: number | string, end: number | string) => any[]}
 *   overlapping - the items sharing an instant with `[start, end)`
 */

/**
 * The first index whose value exceeds `x`, in a non-decreasing array.
 * @param {Float64Array} values
 * @param {number} x
 * @returns {number} an index in `[0, values.length]`
 */
function firstAbove(values, x) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The first index whose value reaches `x`, in a non-decreasing array.
 * @param {Float64Array} values
 * @param {number} x
 * @returns {number} an index in `[0, values.length]`
 */
function firstAtLeast(values, x) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Build a queryable index over `[start, end)` intervals.
 *
 * Both queries answer with the caller's own items, ascending by start
 * and — for items sharing a start — in the order they were given. Every
 * result is a fresh array, so a caller can sort or splice it without
 * reaching into the index.
 *
 * Bounds are read once at build time through the selectors, as epoch
 * milliseconds or RFC 3339 strings, and an interval that is empty,
 * reversed or names no instant is refused here rather than being
 * skipped: an index quietly holding fewer rows than it was given
 * answers every later question wrongly.
 *
 * @param {any[]} items - the rows, in any order
 * @param {Object} [selectors]
 * @param {string | ((item: any, index: number) => any)} [selectors.start]
 *   where the lower bound lives (default `'start'`)
 * @param {string | ((item: any, index: number) => any)} [selectors.end]
 *   where the upper bound lives (default `'end'`)
 * @returns {IntervalIndex}
 * @throws {TypeError} for a non-array, a row that is not an object, a
 *   bound that names no instant, or `end <= start`
 * @example
 * const index = createIntervalIndex(bookings, { start: 'from', end: 'to' });
 * index.at('2026-03-01T10:00:00Z');              // who is booked then
 * index.overlapping(dayStart, dayEnd);           // everything touching today
 */
export function createIntervalIndex(items, selectors = {}) {
  if (!Array.isArray(items))
    throw new TypeError('intervals are an array of rows');
  const readStart = selectorOf(selectors.start ?? 'start', 'start');
  const readEnd = selectorOf(selectors.end ?? 'end', 'end');

  const count = items.length;
  const rawStart = new Float64Array(count);
  const rawEnd = new Float64Array(count);
  const order = new Array(count);
  let ascending = true;
  for (let i = 0; i < count; i++) {
    const row = requireRow(items[i], i);
    const start = epochAt(readStart(row, i), 'start', i);
    const end = epochAt(readEnd(row, i), 'end', i);
    if (!(start < end))
      throw new TypeError(`row ${i}: an interval ends at ${end}, at or before its start ${start}`);
    rawStart[i] = start;
    rawEnd[i] = end;
    order[i] = i;
    if (i > 0 && rawStart[i - 1] > start)
      ascending = false;
  }
  // stable by construction: equal starts fall back to the input position
  if (!ascending)
    order.sort((a, b) => rawStart[a] - rawStart[b] || a - b);

  const starts = new Float64Array(count);
  const ends = new Float64Array(count);
  const maxEnd = new Float64Array(count);
  let reach = -Infinity;
  for (let i = 0; i < count; i++) {
    const at = order[i];
    starts[i] = rawStart[at];
    ends[i] = rawEnd[at];
    if (rawEnd[at] > reach)
      reach = rawEnd[at];
    maxEnd[i] = reach;
  }

  /**
   * @param {number} from - the query's lower bound
   * @param {number} until - the first index past the query's reach
   * @returns {any[]}
   */
  const collect = (from, until) => {
    const out = [];
    // everything before this ended at or before `from`, however early
    // or late it started
    for (let i = firstAbove(maxEnd, from); i < until; i++) {
      if (ends[i] > from)
        out.push(items[order[i]]);
    }
    return out;
  };

  return {
    size: count,
    at: (instant) => {
      const t = toEpoch(instant);
      return collect(t, firstAbove(starts, t));
    },
    overlapping: (start, end) => {
      const from = toEpoch(start);
      const until = toEpoch(end);
      if (!(from < until))
        throw new TypeError(`the query ends at ${until}, at or before its start ${from}`);
      return collect(from, firstAtLeast(starts, until));
    },
  };
}

//#endregion
