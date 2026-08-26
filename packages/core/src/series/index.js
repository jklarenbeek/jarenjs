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
//   zone.js           the injected wall clock: UTC and fixed offsets
//                     work alone, a named zone needs the caller's
//                     provider, and an hour that happened twice is a
//                     refusal rather than a guess
//   bucket.js         the boundary ladder, resampling and the five
//                     fill policies — bucketing is arithmetic, filling
//                     is a policy, and they are kept apart
//   rolling.js        aggregates over a window measured in time rather
//                     than in rows
//   asof.js           the value that was current when this happened,
//                     as one forward walk over both sides
//   downsample.js     a hundred thousand points onto eight hundred
//                     pixels, with the gaps and the ends still there
//
// Two rules run through all of it. **Half-open**: an interval holds its
// start and not its end, so touching spans neither overlap nor
// double-count, and a boundary instant belongs to exactly one of them.
// **Nothing reads a clock**: every bound is data, and an operation that
// needs a window and was given none derives it from its input rather
// than from "now" — which is what makes every answer here reproducible
// and cacheable.
//
// A named-zone database, a recurrence grammar and a scheduling solver
// are all deliberately absent. `findSlots` enumerates where a fixed
// span fits — choosing among the answers is a solver's job — and a zone
// name is answered by a provider the caller injects, because a tzdb
// that ships in a library is a tzdb that goes stale in a library.

export {
  toEpoch,
  normalizeSeries,
  canonicalSeries,
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

export { resolveClock } from './zone.js';

export { compileBuckets, resampleSeries } from './bucket.js';

export { rollingSeries } from './rolling.js';

export { asOfJoin } from './asof.js';

export { downsampleSeries } from './downsample.js';

//#endregion
