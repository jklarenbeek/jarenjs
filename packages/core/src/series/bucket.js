//@ts-check

//#region Buckets, resampling and fill
// Two questions that are always asked together and are not the same
// question. **Bucketing** is "which span does this instant fall in",
// and it is arithmetic. **Filling** is "what does a span with no
// readings say", and it is a policy — five of them, none of which is a
// default worth guessing at.
//
// Keeping them apart is the lesson every gapfill implementation
// eventually learns: an average over an empty hour is not zero, and it
// is not yesterday's average, and it is not nothing. It is whichever of
// those the caller asked for, and the aggregate had no opinion.
//
// The boundaries themselves come in two flavours, and the difference is
// physical rather than stylistic:
//
//   **fixed** `PT15M`, `PT1H`, `P1D`, or a number of milliseconds. The
//   boundary is `origin + k × width`, integer arithmetic all the way
//   down, correct over negative epochs because the division floors.
//
//   **calendar** `P1M`, `P1Y`, and a whole number of days on a named
//   zone. A month has no width, so the boundary is computed by the
//   calendar kernel from an anchor, and on a named zone it is computed
//   through the caller's provider — which is where a spring-forward
//   midnight that never happened becomes a refusal instead of an hour
//   nobody notices.
//
// Nothing here reads a clock: with no explicit `start`/`end` the window
// is the data's own first and last bucket.

import { addToParts } from '../dates/civil.js';
import { parseDuration, durationToMs } from '../dates/duration.js';
import { toEpoch, canonicalSeries, lowerBoundTime } from './normalize.js';
import { requireSpecMembers } from './selector.js';
import { resolveClock, CLOCK_MEMBERS } from './zone.js';

/** @typedef {import('./normalize.js').Sample} Sample */
/** @typedef {import('./zone.js').Clock} Clock */

const MS_PER_DAY = 86400000;

/** What a bucket's rows can be reduced to. */
const AGGREGATES = Object.freeze(['sum', 'mean', 'min', 'max', 'first', 'last', 'count']);

/** What an empty bucket says. */
const FILLS = Object.freeze(['omit', 'null', 'zero', 'locf', 'linear']);

/**
 * A compiled bucket ladder: the boundary arithmetic for one `every`,
 * one `origin` and one clock, validated once so a resample never
 * re-reads its own specification.
 * @typedef {Object} CompiledBuckets
 * @property {number | string} every - the width as it was written
 * @property {boolean} calendar - whether boundaries need the calendar
 * @property {string} unit - `'millisecond'`, `'day'` or `'month'`
 * @property {number} amount - the count of that unit
 * @property {number} width - fixed width in milliseconds, or 0 when
 *   the ladder is a calendar one
 * @property {string} zone - the clock the boundaries fall on
 * @property {number} origin - the anchor, in epoch milliseconds
 * @property {(index: number) => number} startOf - the boundary at a
 *   ladder position; position 0 is `origin`
 * @property {(at: number) => number} indexOf - the ladder position
 *   holding an instant
 * @property {(at: number) => number} floor - the boundary of the bucket
 *   holding an instant
 */

//#endregion

//#region the ladder

/**
 * The width, taken apart once: which family it belongs to, and how much
 * of that family's unit it is.
 * @param {any} every
 * @param {boolean} zoned - whether the clock is a named zone, where a
 *   day is a calendar unit rather than 86,400,000 milliseconds
 * @returns {{ calendar: boolean, unit: string, amount: number, width: number }}
 */
function requireEvery(every, zoned) {
  if (typeof every === 'number') {
    requirePositiveInteger(every, 'a bucket width in milliseconds');
    return dayOrMillisecond(every, zoned);
  }
  if (typeof every !== 'string')
    throw new TypeError('\'every\' is a positive number of milliseconds or an ISO 8601 duration');
  const parts = parseDuration(every);
  if (parts === null || parts.negative)
    throw new TypeError(`'every' — '${every}' is not a positive ISO 8601 duration`);
  if (parts.years !== 0 || parts.months !== 0) {
    if (parts.weeks !== 0 || parts.days !== 0 || parts.hours !== 0
      || parts.minutes !== 0 || parts.seconds !== 0) {
      throw new TypeError(`'every' — '${every}' mixes calendar and fixed units; a bucket ladder`
        + ' is one family, because a month and an hour do not share a boundary');
    }
    const months = parts.years * 12 + parts.months;
    requirePositiveInteger(months, `'every' — '${every}' in months`);
    return { calendar: true, unit: 'month', amount: months, width: 0 };
  }
  const ms = durationToMs(parts);
  requirePositiveInteger(ms, `'every' — '${every}' in milliseconds`);
  return dayOrMillisecond(ms, zoned);
}

/**
 * A fixed span is milliseconds — except on a named zone, where a whole
 * number of days is a calendar span: a day the clock changed on is 23
 * or 25 hours long, and a ladder that called it 24 would drift a bucket
 * boundary off local midnight for the rest of the year.
 * @param {number} ms
 * @param {boolean} zoned
 * @returns {{ calendar: boolean, unit: string, amount: number, width: number }}
 */
function dayOrMillisecond(ms, zoned) {
  if (zoned && ms % MS_PER_DAY === 0)
    return { calendar: true, unit: 'day', amount: ms / MS_PER_DAY, width: 0 };
  return { calendar: false, unit: 'millisecond', amount: ms, width: ms };
}

/** @param {number} value @param {string} role @returns {void} */
function requirePositiveInteger(value, role) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
    throw new TypeError(`${role} is a positive whole number, not ${value}`);
}

/**
 * A duration taken apart on a clock: which family it belongs to, how
 * much of that family's unit it is, and the clock itself.
 *
 * The seam between the two kernels that need the same answer. A bucket
 * ladder and a rolling window both have to know whether `P1M` is
 * arithmetic or a calendar question, and whether `P1D` is 86,400,000
 * milliseconds (it is, on UTC and on a fixed offset) or a day that might
 * be 23 hours long (it is, on a named zone).
 *
 * @param {number | string} every
 * @param {Object} [options] - the clock, as {@link resolveClock} takes it
 * @param {string} [options.zone]
 * @param {number} [options.offset]
 * @param {import('./zone.js').ZoneProvider} [options.provider]
 * @param {'reject' | 'earlier' | 'later'} [options.disambiguation]
 * @returns {{ calendar: boolean, unit: string, amount: number, width: number, clock: Clock }}
 * @throws {TypeError} for a span that is not one positive whole family,
 *   or a named zone with no provider
 */
export function compileSpan(every, options = {}) {
  const clock = resolveClock(options);
  const zoned = options.zone !== undefined && options.zone !== 'UTC';
  return { ...requireEvery(every, zoned), clock };
}

/**
 * The bucket ladder for a specification, validated once and returned as
 * the four boundary operations everything downstream needs.
 *
 * `spec` may be the width alone (`compileBuckets('PT15M')`) or a record
 * with `every` and an optional `origin`. `options` carries the clock —
 * nothing, `{ offset }`, or `{ zone, provider }` — and defaults to UTC.
 *
 * The default `origin` is local `1970-01-01T00:00:00` on that clock, so
 * a daily bucket in `+02:00` falls on local midnight rather than on
 * UTC's, and a monthly bucket falls on the first of the month.
 *
 * @param {number | string | { every: number | string, origin?: number | string }} spec
 * @param {Object} [options] - the clock, as {@link resolveClock} takes it
 * @param {string} [options.zone]
 * @param {number} [options.offset]
 * @param {import('./zone.js').ZoneProvider} [options.provider]
 * @param {'reject' | 'earlier' | 'later'} [options.disambiguation]
 * @returns {CompiledBuckets}
 * @throws {TypeError} for a width that is not a positive whole span, a
 *   width mixing calendar and fixed units, an origin naming no instant,
 *   or a named zone with no provider
 * @example
 * const b = compileBuckets('PT15M');
 * b.floor(Date.UTC(2026, 0, 1, 9, 7));  // 09:00
 * b.startOf(b.indexOf(0) + 1);          // the boundary after the epoch
 */
export function compileBuckets(spec, options = {}) {
  const record = (typeof spec === 'number' || typeof spec === 'string') ? { every: spec } : spec;
  if (record === null || typeof record !== 'object')
    throw new TypeError('a bucket spec is a width, or a record with an \'every\'');
  const shape = compileSpan(record.every, options);
  const { clock } = shape;
  const origin = record.origin === undefined
    ? clock.epochOf({ year: 1970, month: 1, day: 1, hours: 0, minutes: 0, seconds: 0 })
    : toEpoch(record.origin);
  return shape.calendar
    ? calendarLadder(record.every, shape, origin, clock)
    : fixedLadder(record.every, shape, origin, clock.zone);
}

/**
 * The integer ladder. `Math.floor` rather than a truncating division is
 * the whole of it: before 1970 a truncated quotient rounds towards zero
 * and puts an instant in the bucket after its own.
 * @param {number | string} every
 * @param {{ unit: string, amount: number, width: number }} shape
 * @param {number} origin
 * @param {string} zone
 * @returns {CompiledBuckets}
 */
function fixedLadder(every, shape, origin, zone) {
  const { width } = shape;
  const startOf = (index) => origin + index * width;
  const indexOf = (at) => Math.floor((at - origin) / width);
  return {
    every, calendar: false, unit: shape.unit, amount: shape.amount, width, zone, origin,
    startOf, indexOf, floor: (at) => origin + Math.floor((at - origin) / width) * width,
  };
}

/**
 * The calendar ladder. A boundary is the anchor moved `index × amount`
 * units by the calendar kernel and read back on the clock, so month
 * lengths, leap days and — on a named zone — the days that are not 24
 * hours long are all the provider's problem rather than a multiplier.
 *
 * `indexOf` estimates from the raw span and then corrects against the
 * boundaries themselves. The estimate is never more than one position
 * out (a month is 28-31 days; a day is 23-25 hours), so the correction
 * is a couple of comparisons rather than a search — but it is a loop
 * with a bound rather than an assumption, because the provider is the
 * caller's code.
 * @param {number | string} every
 * @param {{ unit: string, amount: number }} shape
 * @param {number} origin
 * @param {Clock} clock
 * @returns {CompiledBuckets}
 */
function calendarLadder(every, shape, origin, clock) {
  const { unit, amount } = shape;
  const anchor = clock.partsAt(origin);
  /** One boundary, memoized: a resample walks the same two repeatedly. */
  let lastIndex = 0;
  let lastStart = origin;
  const startOf = (index) => {
    if (index === lastIndex)
      return lastStart;
    const at = index === 0 ? origin : clock.epochOf(addToParts(anchor, index * amount, unit));
    lastIndex = index;
    lastStart = at;
    return at;
  };
  const estimate = unit === 'month'
    ? (/** @type {number} */ at) => {
      const parts = clock.partsAt(at);
      return Math.floor(((parts.year - anchor.year) * 12 + (parts.month - anchor.month)) / amount);
    }
    : (/** @type {number} */ at) => Math.floor(Math.floor((at - origin) / MS_PER_DAY) / amount);
  const indexOf = (at) => {
    let index = estimate(at);
    for (let guard = 0; startOf(index) > at; guard++) {
      if (guard > 4)
        throw new RangeError(`the '${every}' ladder could not be walked back to ${at}`);
      index--;
    }
    for (let guard = 0; startOf(index + 1) <= at; guard++) {
      if (guard > 4)
        throw new RangeError(`the '${every}' ladder could not be walked forward to ${at}`);
      index++;
    }
    return index;
  };
  return {
    every, calendar: true, unit, amount, width: 0, zone: clock.zone, origin,
    startOf, indexOf, floor: (at) => startOf(indexOf(at)),
  };
}

//#endregion

//#region resample

/**
 * @param {any} name
 * @param {readonly string[]} allowed
 * @param {string} role
 * @returns {string}
 */
function requireMember(name, allowed, role) {
  if (typeof name !== 'string' || !allowed.includes(name))
    throw new TypeError(`${role} is ${allowed.map((a) => `'${a}'`).join(', ')}, not ${JSON.stringify(name)}`);
  return name;
}

/**
 * `resampleSeries`' closed specification: the D5 bucket contract, the
 * clock it reads and where a row keeps its instant and its reading.
 */
export const RESAMPLE_MEMBERS = Object.freeze([
  'every', 'origin', 'start', 'end', 'aggregate', 'fill', 'at', 'value',
  ...CLOCK_MEMBERS,
]);

/**
 * Bucket a series, reduce each bucket to one number, and say what the
 * empty ones mean.
 *
 * The result is ascending `{ at, value, count }` records labelled at
 * their bucket's **start**, which is the only label that is a boundary
 * rather than a summary of where the rows happened to land.
 *
 * `count` is the number of **source rows** the bucket held — duplicates
 * and measured gaps included — so it is the honest denominator of what
 * was seen, not of what could be added up. The six value aggregates
 * (`sum`, `mean`, `min`, `max`, `first`, `last`) all skip `null`
 * readings, so `value` is `null` exactly when the bucket had nothing to
 * measure, and `count` tells you whether that was because nobody
 * reported or because everybody reported a gap. `aggregate: 'count'`
 * returns that same row count as the value.
 *
 * The window, when `start`/`end` are not given, is the data's own: the
 * bucket holding the first sample through the bucket holding the last.
 * Pass them when an empty edge matters — an empty Monday is only a
 * missing Monday once the caller says the week starts then.
 *
 * The five fill policies decide what an **empty** bucket says, and
 * nothing else — a bucket that held rows and no numbers reports `null`
 * because that is a measurement:
 *
 * | fill | an empty bucket |
 * |---|---|
 * | `omit` | is not emitted (the default: a gap is not a row) |
 * | `null` | is emitted as `null` |
 * | `zero` | is emitted as `0` |
 * | `locf` | repeats the last value before it |
 * | `linear` | is interpolated between its two neighbours |
 *
 * Neither `locf` nor `linear` invents a value at the leading edge, and
 * `linear` needs a value on **both** sides: with no anchor to carry or
 * to interpolate from, the bucket stays `null`. To seed one, widen the
 * window until the earlier reading falls inside it — the seed is then a
 * bucket with data, which is the only kind of anchor this function will
 * extrapolate from. (With `aggregate: 'count'` an empty bucket is `0` by
 * definition, so fill only decides whether it appears at all.)
 *
 * @param {any[]} rows - the samples, in any order
 * @param {Object} spec
 * @param {number | string} spec.every - the bucket width
 * @param {number | string} [spec.origin] - where a boundary falls
 *   (default: local `1970-01-01T00:00:00` on the clock)
 * @param {number | string} [spec.start] - the half-open window's start
 * @param {number | string} [spec.end] - the half-open window's end
 * @param {'sum'|'mean'|'min'|'max'|'first'|'last'|'count'} [spec.aggregate]
 *   default `'mean'`
 * @param {'omit'|'null'|'zero'|'locf'|'linear'} [spec.fill] default `'omit'`
 * @param {string} [spec.zone] - a named zone, needing `provider`
 * @param {number} [spec.offset] - minutes east of UTC
 * @param {import('./zone.js').ZoneProvider} [spec.provider]
 * @param {'reject'|'earlier'|'later'} [spec.disambiguation]
 * @param {string | ((item: any, index: number) => any)} [spec.at] - where
 *   the instant lives in a source row (default `'at'`)
 * @param {string | ((item: any, index: number) => any)} [spec.value]
 *   where the reading lives (default `'value'`)
 * @returns {{ at: number, value: number | null, count: number }[]}
 * @throws {TypeError} for a bad width, origin, window, aggregate or fill,
 *   or a row that is not a canonical sample
 * @example
 * resampleSeries(readings, { every: 'PT1H', aggregate: 'mean', fill: 'linear' });
 * resampleSeries(readings, { every: 'P1M', zone: 'Europe/Amsterdam', provider });
 */
export function resampleSeries(rows, spec) {
  requireSpecMembers(spec, RESAMPLE_MEMBERS, 'resampleSeries',
    'a resample spec is an object with an \'every\'');
  const samples = canonicalSeries(rows, spec);
  const buckets = compileBuckets(spec, spec);
  const aggregate = requireMember(spec.aggregate ?? 'mean', AGGREGATES, 'aggregate');
  const fill = requireMember(spec.fill ?? 'omit', FILLS, 'fill');

  const lo = spec.start === undefined ? null : toEpoch(spec.start);
  const hi = spec.end === undefined ? null : toEpoch(spec.end);
  if (lo !== null && hi !== null && !(lo < hi))
    throw new TypeError(`the window ends at ${hi}, at or before its start ${lo}`);

  const from = lo === null ? 0 : lowerBoundTime(samples, lo);
  const to = hi === null ? samples.length : lowerBoundTime(samples, hi);
  // with no window of its own and no data, there is nothing to enumerate
  // between — and "now" is not an answer this module is allowed to give
  if (from >= to && (lo === null || hi === null))
    return [];

  const firstAt = lo === null ? samples[from].at : lo;
  // the last instant a bucket may still be emitted for: the explicit end
  // is exclusive, the derived one is the final sample and is inside
  const limit = hi === null ? samples[to - 1].at + 1 : hi;

  /** @type {{ at: number, value: number | null, count: number }[]} */
  const out = [];
  /** Which emitted rows had no source rows at all — the fill's business. */
  const empties = [];
  let index = buckets.indexOf(firstAt);
  let start = buckets.startOf(index);
  let i = from;
  while (start < limit) {
    const end = buckets.calendar ? buckets.startOf(index + 1) : start + buckets.width;
    let count = 0;
    let n = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let first = null;
    let last = null;
    while (i < to && samples[i].at < end) {
      const value = samples[i].value;
      count++;
      if (value !== null) {
        n++;
        sum += value;
        if (value < min) min = value;
        if (value > max) max = value;
        if (first === null) first = value;
        last = value;
      }
      i++;
    }
    if (count === 0) {
      if (fill !== 'omit') {
        empties.push(out.length);
        out.push({ at: start, value: aggregate === 'count' ? 0 : emptyValue(fill), count: 0 });
      }
    }
    else {
      out.push({ at: start, count, value: reduce(aggregate, count, n, sum, min, max, first, last) });
    }
    index++;
    start = end;
  }
  if (empties.length !== 0 && aggregate !== 'count') {
    if (fill === 'locf') carryForward(out, empties);
    else if (fill === 'linear') interpolate(out, empties);
  }
  return out;
}

/** @param {string} fill @returns {number | null} */
function emptyValue(fill) {
  return fill === 'zero' ? 0 : null;
}

/**
 * One bucket's rows, reduced. `null` is the answer whenever nothing in
 * the bucket carried a number, which the six value aggregates agree on.
 * @param {string} aggregate
 * @param {number} count - source rows, gaps included
 * @param {number} n - rows carrying a number
 * @param {number} sum
 * @param {number} min
 * @param {number} max
 * @param {number | null} first
 * @param {number | null} last
 * @returns {number | null}
 */
function reduce(aggregate, count, n, sum, min, max, first, last) {
  if (aggregate === 'count')
    return count;
  if (n === 0)
    return null;
  switch (aggregate) {
    case 'sum': return sum;
    case 'mean': return sum / n;
    case 'min': return min;
    case 'max': return max;
    case 'first': return first;
    default: return last;
  }
}

/**
 * `locf` — the last value observed before the gap, repeated across it.
 * A gap before the first value stays `null`: carrying a value backwards
 * is inventing one, and this module does not.
 * @param {{ at: number, value: number | null, count: number }[]} out
 * @param {number[]} empties
 * @returns {void}
 */
function carryForward(out, empties) {
  let carried = null;
  let next = 0;
  for (let i = 0; i < out.length; i++) {
    if (next < empties.length && empties[next] === i) {
      out[i].value = carried;
      next++;
    }
    else if (out[i].value !== null)
      carried = out[i].value;
  }
}

/**
 * `linear` — a straight line between the values on either side of the
 * gap, read at each empty bucket's own start. A run with no value on
 * one side has no line to be on and stays `null`.
 * @param {{ at: number, value: number | null, count: number }[]} out
 * @param {number[]} empties
 * @returns {void}
 */
function interpolate(out, empties) {
  const isEmpty = new Uint8Array(out.length);
  for (const i of empties) isEmpty[i] = 1;
  for (let i = 0; i < empties.length;) {
    // the maximal run of empty buckets this one starts
    let last = empties[i];
    let j = i + 1;
    while (j < empties.length && empties[j] === last + 1) {
      last = empties[j];
      j++;
    }
    const before = anchor(out, isEmpty, empties[i] - 1, -1);
    const after = anchor(out, isEmpty, last + 1, 1);
    if (before >= 0 && after < out.length) {
      const a = out[before];
      const b = out[after];
      const slope = (/** @type {number} */(b.value) - /** @type {number} */(a.value)) / (b.at - a.at);
      for (let k = empties[i]; k <= last; k++)
        out[k].value = /** @type {number} */(a.value) + slope * (out[k].at - a.at);
    }
    i = j;
  }
}

/**
 * The nearest bucket in one direction that actually measured something.
 * A bucket that held rows and no numbers is not an anchor: it is the
 * report that there was nothing to measure.
 * @param {{ value: number | null }[]} out
 * @param {Uint8Array} isEmpty
 * @param {number} from
 * @param {number} step
 * @returns {number} an index, or one past the end of the search
 */
function anchor(out, isEmpty, from, step) {
  for (let i = from; i >= 0 && i < out.length; i += step) {
    if (isEmpty[i] === 0 && out[i].value !== null)
      return i;
  }
  return step < 0 ? -1 : out.length;
}

//#endregion
