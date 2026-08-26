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
 *   a duration/step that is not a positive fixed width
 * @example
 * findSlots([{ start: 0, end: 90 }], { duration: 60, step: 30 });
 * // [{ start: 0, end: 60 }, { start: 30, end: 90 }]
 */
export function findSlots(availability, spec) {
  if (spec === null || typeof spec !== 'object')
    throw new TypeError('a slot spec is an object with a duration');
  const duration = requireWidth(spec.duration, 'duration');
  const step = spec.step === undefined ? duration : requireWidth(spec.step, 'step');
  const windows = mergeIntervals(availability);
  /** @type {Interval[]} */
  const out = [];
  for (let i = 0; i < windows.length; i++) {
    const limit = windows[i].end - duration;
    for (let start = windows[i].start; start <= limit; start += step)
      out.push({ start, end: start + duration });
  }
  return out;
}

//#endregion
