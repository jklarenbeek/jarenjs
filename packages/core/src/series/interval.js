//@ts-check

//#region Half-open interval algebra
// Set operations over `[start, end)` spans of epoch milliseconds — the
// vocabulary a roster, a calendar, an availability view and a
// maintenance window all rebuild by hand today.
//
// **Half-open is the whole design.** An interval contains `t` when
// `start <= t && t < end`, so a day ends exactly where the next one
// begins and nothing is counted twice at a boundary. Two intervals that
// touch (`a.end === b.start`) therefore do NOT overlap: back-to-back
// bookings are not a double booking.
//
// Merging is the one place that answer is not enough, and it is why
// `mergeIntervals` joins touching spans by DEFAULT. Availability asks
// "is there continuous cover from nine to five", and 09:00-13:00 plus
// 13:00-17:00 is continuous cover; leaving a zero-width seam between
// them would report a gap no one can be scheduled into. The other
// answer is real too — a shift handover is two shifts, not one — so it
// is spelled `{ adjacent: false }` and nothing has to guess.
//
// Every operation refuses an interval that is empty, reversed or not
// finite. `[t, t)` contains no instant, so it is a defect at the point
// it was written rather than a value that quietly disappears from a
// union and quietly consumes a subtraction.
//
// A bound is read wherever it is written: every operation takes epoch
// milliseconds or an RFC 3339 string, and every result is epoch
// milliseconds. Conversion happens once, at the door.
//
// Merge, subtract, gaps and slots return bare `{ start, end }` records:
// a span welded out of three source rows belongs to none of them, and
// carrying one of their metadata forward would be a claim the data does
// not support. Source members survive normalization and the index,
// where a result IS a row.

import { toEpoch, normalizeIntervals } from './normalize.js';
import { requireSpecMembers } from './selector.js';
import { parseDuration, durationToMs } from '../dates/duration.js';

/** @typedef {import('./normalize.js').Interval} Interval */

/**
 * One interval as canonical epoch bounds, validated as `[start, end)`.
 * Both bounds go through {@link toEpoch}, so every operation here reads
 * an RFC 3339 string wherever it reads a number, and everything past
 * this point is integer arithmetic.
 * @param {any} interval
 * @param {string} role - what the argument is, for the message
 * @returns {Interval}
 */
function requireInterval(interval, role) {
  if (interval === null || typeof interval !== 'object')
    throw new TypeError(`${role} is not an interval`);
  let start;
  let end;
  try {
    start = toEpoch(interval.start);
    end = toEpoch(interval.end);
  }
  catch (error) {
    throw new TypeError(`${role} has a bound that names no instant: ${
      error instanceof Error ? error.message : String(error)}`);
  }
  if (!(start < end))
    throw new TypeError(`${role} ends at ${end}, at or before its start ${start}`);
  return { start, end };
}

/**
 * A positive fixed width in milliseconds, from a number or a fixed ISO
 * 8601 duration string.
 *
 * A calendar duration (`P1M`, `P1Y`) is refused rather than approximated:
 * a month has no width until it is told where it starts, and calling it
 * thirty days is how a schedule drifts.
 *
 * @param {number | string} spec
 * @param {string} role
 * @returns {number} milliseconds
 */
function requireWidth(spec, role) {
  let ms = spec;
  if (typeof spec === 'string') {
    const parts = parseDuration(spec);
    if (parts === null)
      throw new TypeError(`${role} '${spec}' is not an ISO 8601 duration`);
    ms = durationToMs(parts);
    if (!Number.isFinite(ms))
      throw new TypeError(`${role} '${spec}' is a calendar duration and has no fixed width`);
  }
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0)
    throw new TypeError(`${role} is a positive number of milliseconds or a fixed ISO 8601 duration`);
  return ms;
}

/**
 * Does `interval` contain the instant `at`?
 *
 * Half-open: the start is in, the end is out. An instant on a boundary
 * belongs to exactly one of two touching intervals, which is what makes
 * "which shift is this event in" answerable.
 *
 * @param {Interval} interval
 * @param {number | string} at - epoch milliseconds or RFC 3339
 * @returns {boolean}
 * @throws {TypeError} for an empty, reversed or non-finite interval
 * @example
 * containsInstant({ start: 0, end: 10 }, 0);  // true
 * containsInstant({ start: 0, end: 10 }, 10); // false
 */
export function containsInstant(interval, at) {
  const { start, end } = requireInterval(interval, 'the interval');
  const t = toEpoch(at);
  return t >= start && t < end;
}

/**
 * Do two intervals share at least one instant?
 *
 * Touching intervals do not: `[0, 10)` and `[10, 20)` have no instant
 * in common, so consecutive bookings never read as a conflict.
 *
 * @param {Interval} a
 * @param {Interval} b
 * @returns {boolean}
 * @throws {TypeError} for an empty, reversed or non-finite interval
 * @example
 * overlapsInterval({ start: 0, end: 10 }, { start: 10, end: 20 }); // false
 * overlapsInterval({ start: 0, end: 10 }, { start: 9, end: 20 });  // true
 */
export function overlapsInterval(a, b) {
  const left = requireInterval(a, 'the left interval');
  const right = requireInterval(b, 'the right interval');
  return left.start < right.end && right.start < left.end;
}

/**
 * The span two intervals share, or `null` when they share none.
 *
 * `null` rather than an empty interval, because `[t, t)` is not a value
 * this algebra has — the absence is the answer, and it cannot then be
 * fed back in as if it were a span.
 *
 * @param {Interval} a
 * @param {Interval} b
 * @returns {Interval | null} a new record
 * @throws {TypeError} for an empty, reversed or non-finite interval
 * @example
 * intersectInterval({ start: 0, end: 10 }, { start: 5, end: 20 });
 * // { start: 5, end: 10 }
 */
export function intersectInterval(a, b) {
  const left = requireInterval(a, 'the left interval');
  const right = requireInterval(b, 'the right interval');
  const start = left.start > right.start ? left.start : right.start;
  const end = left.end < right.end ? left.end : right.end;
  return start < end ? { start, end } : null;
}

/**
 * `mergeIntervals`' closed specification: whether spans that touch
 * join, which availability normally wants and a handover does not.
 */
export const MERGE_MEMBERS = Object.freeze(['adjacent']);

/**
 * The union of `intervals`, as the fewest disjoint spans that cover the
 * same instants, ascending.
 *
 * Touching spans are joined by default, because continuous cover is
 * what availability means; `{ adjacent: false }` keeps them apart, which
 * is what a handover between two shifts means. Overlapping spans always
 * join, under both settings.
 *
 * @param {Interval[]} intervals - in any order
 * @param {Object} [options]
 * @param {boolean} [options.adjacent] - join touching spans (default `true`)
 * @returns {Interval[]} new `{ start, end }` records
 * @throws {TypeError} for an empty, reversed or non-finite interval
 * @example
 * mergeIntervals([{ start: 0, end: 10 }, { start: 10, end: 20 }]);
 * // [{ start: 0, end: 20 }]
 * mergeIntervals([{ start: 0, end: 10 }, { start: 10, end: 20 }],
 *                { adjacent: false });
 * // [{ start: 0, end: 10 }, { start: 10, end: 20 }]
 */
export function mergeIntervals(intervals, options = {}) {
  requireSpecMembers(options, MERGE_MEMBERS, 'mergeIntervals',
    'a merge spec is an object with an \'adjacent\'');
  const adjacent = options.adjacent ?? true;
  const sorted = normalizeIntervals(intervals);
  /** @type {Interval[]} */
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const { start, end } = sorted[i];
    const last = out.length === 0 ? null : out[out.length - 1];
    if (last !== null && (adjacent ? start <= last.end : start < last.end)) {
      if (end > last.end)
        last.end = end;
    }
    else out.push({ start, end });
  }
  return out;
}

/**
 * The instants in `from` that `remove` does not cover, as disjoint
 * ascending spans.
 *
 * Both sides are merged first, so the result is the set difference and
 * nothing depends on the order the arguments arrived in. A cut through
 * the middle of a span **splits** it into two; a cut that covers a span
 * removes it entirely.
 *
 * @param {Interval[]} from - the spans being reduced
 * @param {Interval[]} remove - the spans taken out of them
 * @returns {Interval[]} new `{ start, end }` records
 * @throws {TypeError} for an empty, reversed or non-finite interval
 * @example
 * subtractIntervals([{ start: 0, end: 100 }], [{ start: 40, end: 60 }]);
 * // [{ start: 0, end: 40 }, { start: 60, end: 100 }]
 */
export function subtractIntervals(from, remove) {
  const base = mergeIntervals(from);
  const cuts = mergeIntervals(remove);
  /** @type {Interval[]} */
  const out = [];
  let j = 0;
  for (let i = 0; i < base.length; i++) {
    const span = base[i];
    let at = span.start;
    // cuts and base are both ascending and disjoint, so a cut that ends
    // at or before this span's start is spent for every later span too
    while (j < cuts.length && cuts[j].end <= at)
      j++;
    for (let k = j; k < cuts.length && cuts[k].start < span.end; k++) {
      if (cuts[k].start > at)
        out.push({ start: at, end: cuts[k].start });
      if (cuts[k].end > at)
        at = cuts[k].end;
      if (at >= span.end)
        break;
    }
    if (at < span.end)
      out.push({ start: at, end: span.end });
  }
  return out;
}

/**
 * The hull of `intervals` — the one span from the earliest start to the
 * latest end, or `null` when there are none.
 * @param {Interval[]} sorted - ascending on `start`
 * @returns {Interval | null}
 */
function hullOf(sorted) {
  if (sorted.length === 0)
    return null;
  let end = sorted[0].end;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > end)
      end = sorted[i].end;
  }
  return { start: sorted[0].start, end };
}

/**
 * The spans inside `within` that `intervals` leaves uncovered.
 *
 * `within` defaults to the hull of the intervals themselves — the gaps
 * *between* them — because the alternative default would be a clock,
 * and this kernel has none. Passing it explicitly is what reports a
 * missing edge: an empty morning before the first booking is only a gap
 * if the caller says the day starts at nine.
 *
 * @param {Interval[]} intervals - in any order
 * @param {Interval} [within] - the window to look inside
 * @returns {Interval[]} new `{ start, end }` records
 * @throws {TypeError} for an empty, reversed or non-finite interval
 * @example
 * gapsWithin([{ start: 0, end: 10 }, { start: 30, end: 40 }]);
 * // [{ start: 10, end: 30 }]
 * gapsWithin([{ start: 10, end: 20 }], { start: 0, end: 30 });
 * // [{ start: 0, end: 10 }, { start: 20, end: 30 }]
 */
export function gapsWithin(intervals, within) {
  const merged = mergeIntervals(intervals);
  const bounds = within === undefined ? hullOf(merged) : requireInterval(within, 'the window');
  if (bounds === null)
    return [];
  return subtractIntervals([bounds], merged);
}

/**
 * How many milliseconds `intervals` cover, counting an instant once
 * however many spans hold it.
 *
 * Restricted to `within` when given, which is what turns it into a
 * ratio: `coverageOf(shifts, day) / (day.end - day.start)` is the
 * fraction of the day that is staffed.
 *
 * @param {Interval[]} intervals - in any order
 * @param {Interval} [within] - clip to this window first
 * @returns {number} milliseconds
 * @throws {TypeError} for an empty, reversed or non-finite interval
 * @example
 * coverageOf([{ start: 0, end: 10 }, { start: 5, end: 20 }]); // 20
 */
export function coverageOf(intervals, within) {
  const merged = mergeIntervals(intervals);
  const bounds = within === undefined ? null : requireInterval(within, 'the window');
  let total = 0;
  for (let i = 0; i < merged.length; i++) {
    const start = bounds === null || merged[i].start > bounds.start ? merged[i].start : bounds.start;
    const end = bounds === null || merged[i].end < bounds.end ? merged[i].end : bounds.end;
    if (end > start)
      total += end - start;
  }
  return total;
}

/**
 * `findSlots`' closed specification: how long a slot is and how far
 * apart two of them start. Enumeration, never a constraint solver.
 */
export const SLOTS_MEMBERS = Object.freeze(['duration', 'step']);

/**
 * Every place a span of `duration` fits inside `availability`.
 *
 * Availability is merged first — two touching windows are one window,
 * so a meeting may straddle the seam — and each merged window is then
 * walked from its own start in `step` increments (default: back to
 * back), keeping every span that still ends inside the window. A window
 * exactly one duration wide yields exactly one slot.
 *
 * This is enumeration, not scheduling: it answers "where could this
 * go", and choosing among the answers, weighing preferences or
 * assigning people is a solver's job, deliberately not this one.
 *
 * `duration` and `step` are fixed widths — a number of milliseconds or
 * a fixed ISO 8601 duration (`'PT30M'`). A calendar duration is refused
 * rather than approximated, because "every month" needs a calendar and
 * a zone to say where its boundaries fall.
 *
 * @param {Interval[]} availability - in any order
 * @param {Object} spec
 * @param {number | string} spec.duration - how long the span is
 * @param {number | string} [spec.step] - the spacing between starts
 *   (default: `duration`)
 * @returns {Interval[]} new `{ start, end }` records, ascending
 * @throws {TypeError} for an empty, reversed or non-finite interval, or
 *   a duration/step that is not a positive fixed width or cannot advance
 *   a slot start at the available numeric precision
 * @example
 * findSlots([{ start: 0, end: 90 }], { duration: 60, step: 30 });
 * // [{ start: 0, end: 60 }, { start: 30, end: 90 }]
 */
export function findSlots(availability, spec) {
  requireSpecMembers(spec, SLOTS_MEMBERS, 'findSlots', 'a slot spec is an object with a duration');
  const duration = requireWidth(spec.duration, 'duration');
  const step = spec.step === undefined ? duration : requireWidth(spec.step, 'step');
  const windows = mergeIntervals(availability);
  /** @type {Interval[]} */
  const out = [];
  for (let i = 0; i < windows.length; i++) {
    const limit = windows[i].end - duration;
    for (let start = windows[i].start; start <= limit;) {
      const end = start + duration;
      if (end <= start)
        throw new TypeError('findSlots: duration must advance the slot start');
      if (end > windows[i].end)
        break;
      out.push({ start, end });
      const next = start + step;
      if (next <= start)
        throw new TypeError('findSlots: step must advance the slot start');
      start = next;
    }
  }
  return out;
}

/**
 * `concurrencyOf`'s closed specification: the staffing minimum each span
 * is read against.
 */
export const CONCURRENCY_MEMBERS = /* @__PURE__ */ Object.freeze(['atLeast']);

/**
 * How many of `intervals` cover each part of `window`: the window cut
 * into ascending spans `{ start, end, count }` that tile it exactly,
 * a span with no interval included as `count: 0`, and touching spans of
 * one count joined.
 *
 * Every interval counts, duplicates included: two people on the same
 * shift are two. An interval ending where another starts hands over
 * rather than overlapping, so the boundary instant is counted once.
 * With `atLeast`, each span also carries `meets: count >= atLeast`; the
 * spans that fall short are kept rather than filtered out, because a
 * staffing minimum asks where it is NOT met.
 *
 * @param {Interval[]} intervals - in any order
 * @param {Interval} window - the span to count over
 * @param {Object} [options]
 * @param {number} [options.atLeast] - a whole number of intervals
 * @returns {{ start: number, end: number, count: number, meets?: boolean }[]} new records
 * @throws {TypeError} for an empty, reversed or non-finite interval or
 *   window, or an `atLeast` that is not a non-negative whole number
 * @example
 * concurrencyOf([{ start: 0, end: 10 }, { start: 5, end: 20 }], { start: 0, end: 30 }, { atLeast: 1 });
 * // [{ start: 0, end: 5, count: 1, meets: true }, { start: 5, end: 10, count: 2, meets: true },
 * //  { start: 10, end: 20, count: 1, meets: true }, { start: 20, end: 30, count: 0, meets: false }]
 */
export function concurrencyOf(intervals, window, options = {}) {
  requireSpecMembers(options, CONCURRENCY_MEMBERS, 'concurrencyOf',
    'a concurrency spec is an object with an \'atLeast\'');
  const atLeast = options.atLeast;
  if (atLeast !== undefined && !(Number.isSafeInteger(atLeast) && atLeast >= 0))
    throw new TypeError('concurrencyOf: atLeast is a whole number of intervals, zero or more');
  const bounds = requireInterval(window, 'the window');
  if (!Array.isArray(intervals))
    throw new TypeError('concurrencyOf: the intervals are an array');
  /** @type {number[]} */
  const starts = [];
  /** @type {number[]} */
  const ends = [];
  for (let i = 0; i < intervals.length; i++) {
    const { start, end } = requireInterval(intervals[i], `interval ${i}`);
    if (start < bounds.end && end > bounds.start) {
      starts.push(start > bounds.start ? start : bounds.start);
      ends.push(end < bounds.end ? end : bounds.end);
    }
  }
  starts.sort((a, b) => a - b);
  ends.sort((a, b) => a - b);
  /** @type {{ start: number, end: number, count: number, meets?: boolean }[]} */
  const out = [];
  let count = 0;
  let at = bounds.start;
  let i = 0;
  let j = 0;
  while (at < bounds.end) {
    // an end and a start on one instant hand over: the end goes first
    while (j < ends.length && ends[j] <= at) {
      count--;
      j++;
    }
    while (i < starts.length && starts[i] <= at) {
      count++;
      i++;
    }
    const next = Math.min(i < starts.length ? starts[i] : bounds.end, j < ends.length ? ends[j] : bounds.end);
    const last = out.length === 0 ? null : out[out.length - 1];
    if (last !== null && last.count === count)
      last.end = next;
    else out.push(atLeast === undefined ? { start: at, end: next, count } : { start: at, end: next, count, meets: count >= atLeast });
    at = next;
  }
  return out;
}

/**
 * `shortGaps`' closed specification: the shortest gap that is not
 * reported.
 */
export const SHORT_GAPS_MEMBERS = /* @__PURE__ */ Object.freeze(['under']);

/**
 * The gaps between `intervals` that are shorter than `under`: a rest
 * rule's question, "where is the break between two shifts too short".
 *
 * The intervals are merged first, so overlapping and touching intervals
 * are one continuous span and leave no gap between them; a back-to-back
 * pair is a question for the length of the merged span, not a gap of
 * zero. Only the gaps between intervals are read: before the first and
 * after the last there is no other interval to rest between.
 *
 * @param {Interval[]} intervals - in any order
 * @param {Object} spec
 * @param {number | string} spec.under - milliseconds or a fixed ISO 8601
 *   duration; a gap exactly this long is long enough
 * @returns {Interval[]} new `{ start, end }` records, ascending
 * @throws {TypeError} for an empty, reversed or non-finite interval, or
 *   an `under` that is not a positive fixed width
 * @example
 * shortGaps([{ start: 0, end: 10 }, { start: 15, end: 20 }, { start: 40, end: 50 }], { under: 10 });
 * // [{ start: 10, end: 15 }]
 */
export function shortGaps(intervals, spec) {
  requireSpecMembers(spec, SHORT_GAPS_MEMBERS, 'shortGaps', 'a short-gap spec is an object with an \'under\'');
  const under = requireWidth(spec.under, 'under');
  const merged = mergeIntervals(intervals);
  /** @type {Interval[]} */
  const out = [];
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].start - merged[i - 1].end < under)
      out.push({ start: merged[i - 1].end, end: merged[i].start });
  }
  return out;
}

//#endregion
