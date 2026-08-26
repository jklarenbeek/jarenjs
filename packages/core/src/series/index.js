//@ts-check

//#region @jarenjs/core/series
// The suite's temporal kernel: one meaning for an instant, one meaning
// for an interval, and the set algebra over them that a roster, a
// calendar, an event log, an availability view and a telemetry graph
// otherwise each rebuild by hand.
//
// As with dates and geometry, **there is no type here**. An instant is
// epoch milliseconds or an RFC 3339 string; a sample is
// `{ at, value }`; an interval is `{ start, end }` — all of them plain
// JSON already, so they survive a patch, a schema, a pointer, a stored
// document and a wire reply unchanged. A `Series` object with methods
// could do none of that.
//
//   selector.js       where a member lives in a caller's row
//   normalize.js      instants, sorted samples and intervals, and the
//                     binary bounds a sorted array is read through
//   interval.js       half-open `[start, end)` set algebra: contains,
//                     overlap, intersect, merge, subtract, gaps,
//                     coverage and fixed-width slot enumeration
//   interval-index.js build once, query many — the point and range
//                     questions, without asking every span
//
// Two rules run through all of it. **Half-open**: an interval holds its
// start and not its end, so touching spans neither overlap nor
// double-count, and a boundary instant belongs to exactly one of them.
// **Nothing reads a clock**: every bound is data, and an operation that
// needs a window and was given none derives it from its input rather
// than from "now" — which is what makes every answer here reproducible
// and cacheable.
//
// Calendar-width buckets, resampling, fill policies, rolling windows,
// as-of joins and downsampling are the layer above this one and are not
// here; neither is a named-zone database, a recurrence grammar or a
// scheduling solver. `findSlots` enumerates where a fixed span fits —
// choosing among the answers is a solver's job, deliberately not this
// kernel's.

export {
  toEpoch,
  normalizeSeries,
  normalizeIntervals,
  lowerBoundTime,
  upperBoundTime,
} from './normalize.js';

export {
  containsInstant,
  overlapsInterval,
  intersectInterval,
  mergeIntervals,
  subtractIntervals,
  gapsWithin,
  coverageOf,
  findSlots,
} from './interval.js';

export { createIntervalIndex } from './interval-index.js';

//#endregion
