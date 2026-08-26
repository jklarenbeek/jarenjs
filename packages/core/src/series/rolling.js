//@ts-check

//#region Rolling windows of time
// A rolling aggregate over a *duration* rather than over a count of
// rows. The distinction is the whole reason this module exists: a
// sixty-row window over a sensor that reports every second is a minute,
// and over a sensor that dropped half its readings it is two minutes.
// One of those is a specification and the other is an accident.
//
// The window is `(at − width, at]`: exactly `width` milliseconds wide,
// holding the current instant and not the one a full width behind it.
// That is the mirror of the `[start, end)` rule the rest of this kernel
// runs on — one endpoint in, one out, so consecutive windows neither
// overlap at a boundary nor drop it — turned around because a trailing
// window is anchored at its newest point rather than its oldest.
//
// Every output is one row, in the input's order, so the result lines up
// with the series it came from. Rows sharing an instant therefore share
// a window and share an answer: a span of time is a function of the
// instant it ends at, not of which of two simultaneous readings the
// loop happened to reach first.
//
// The complexity claim is per aggregate, and it is a claim about
// structure rather than about a stopwatch:
//
//   sum, mean, count   a running total. The arriving row is added and
//                      the departing row subtracted, so the window is
//                      never re-read.
//   min, max           a monotone deque. A row that arrives smaller
//                      than the rows behind it makes them unreachable,
//                      so they leave; each row is pushed and popped at
//                      most once.
//   first, last        the window's own ends, tracked by two pointers
//                      that only ever move forward.
//
// A carried total is not a fresh sum in the last bits when the values
// are not exactly representable — that is what carrying one costs, and
// the suite's corpora use exact binary fractions so the difference is
// zero and equality is the check rather than a tolerance.

import { addToParts } from '../dates/civil.js';
import { canonicalSeries } from './normalize.js';
import { compileSpan } from './bucket.js';
import { requireSpecMembers } from './selector.js';
import { CLOCK_MEMBERS } from './zone.js';

/** @typedef {import('./normalize.js').Sample} Sample */

/** What a window's rows can be reduced to — the seven of D5. */
const AGGREGATES = Object.freeze(['sum', 'mean', 'min', 'max', 'first', 'last', 'count']);

/**
 * `rollingSeries`' closed specification: a window measured in time,
 * how much of one counts, the clock a calendar width walks, and where
 * a row keeps its instant and its reading.
 */
export const ROLLING_MEMBERS = Object.freeze([
  'width', 'aggregate', 'minPeriods', 'at', 'value', ...CLOCK_MEMBERS,
]);

/**
 * A rolling aggregate over a time-width window.
 *
 * Returns one `{ at, value, count }` per input sample, labelled at that
 * sample's own instant, where the window is the half-open span
 * `(at − width, at]`. Two samples at one instant share that window, and
 * so report the same value and count.
 *
 * `count` is the number of **source rows** in the window — duplicates
 * and measured gaps included — and the six value aggregates skip `null`
 * readings, so `value` is `null` exactly when the window had nothing to
 * measure. `aggregate: 'count'` returns that row count as the value.
 *
 * `minPeriods` is the number of source rows the window must hold before
 * a value is reported at all; below it the row is `null` with its real
 * `count`. It counts rows rather than readings, so a window full of
 * measured gaps satisfies it and still reports `null` — which is the
 * honest answer: readings were due, and none of them carried a number.
 *
 * `width` is a fixed duration (`'PT1H'`, `86400000`) or, with a clock,
 * a calendar one (`'P1M'`, and `'P1D'` on a named zone where a day may
 * be 23 or 25 hours long). A calendar window's start is computed by the
 * calendar kernel per output, which is O(1) each — it is never a scan
 * back through the window.
 *
 * @param {any[]} rows - the samples, in any order
 * @param {Object} spec
 * @param {number | string} spec.width - the window's width
 * @param {'sum'|'mean'|'min'|'max'|'first'|'last'|'count'} [spec.aggregate]
 *   default `'mean'`
 * @param {number} [spec.minPeriods] - default 1
 * @param {string} [spec.zone] - a named zone, needing `provider`
 * @param {number} [spec.offset] - minutes east of UTC
 * @param {import('./zone.js').ZoneProvider} [spec.provider]
 * @param {'reject'|'earlier'|'later'} [spec.disambiguation]
 * @param {string | ((item: any, index: number) => any)} [spec.at]
 * @param {string | ((item: any, index: number) => any)} [spec.value]
 * @returns {{ at: number, value: number | null, count: number }[]}
 * @throws {TypeError} for a width that is not one positive whole span,
 *   an unknown aggregate, a `minPeriods` that is not a positive whole
 *   number, or a row that is not a canonical sample
 * @example
 * rollingSeries(readings, { width: 'PT5M', aggregate: 'mean' });
 * rollingSeries(readings, { width: 'PT1M', minPeriods: 60 });
 */
export function rollingSeries(rows, spec) {
  requireSpecMembers(spec, ROLLING_MEMBERS, 'rollingSeries',
    'a rolling spec is an object with a \'width\'');
  const samples = canonicalSeries(rows, spec);
  const span = compileSpan(spec.width, spec);
  const aggregate = spec.aggregate ?? 'mean';
  if (typeof aggregate !== 'string' || !AGGREGATES.includes(aggregate)) {
    throw new TypeError(`aggregate is ${AGGREGATES.map((a) => `'${a}'`).join(', ')}, not ${
      JSON.stringify(aggregate)}`);
  }
  const minPeriods = spec.minPeriods ?? 1;
  if (!Number.isInteger(minPeriods) || minPeriods < 1)
    throw new TypeError(`minPeriods is a positive whole number, not ${minPeriods}`);

  const n = samples.length;
  /** @type {{ at: number, value: number | null, count: number }[]} */
  const out = new Array(n);

  // where the window holding `at` opens — exclusively, so a sample
  // exactly one width behind the current one has already left
  const opensAt = span.calendar
    ? (/** @type {number} */ at) =>
      span.clock.epochOf(addToParts(span.clock.partsAt(at), -span.amount, span.unit))
    : (/** @type {number} */ at) => at - span.width;

  const wantsExtremum = aggregate === 'min' || aggregate === 'max';
  const sign = aggregate === 'min' ? 1 : -1;
  /** The monotone deque, as indices into `samples`; `head`..`tail-1` is live. */
  const deque = wantsExtremum ? new Int32Array(n) : null;
  let head = 0;
  let tail = 0;

  let lo = 0;
  let sum = 0;
  let measured = 0;
  let firstAt = 0;
  let lastAt = -1;

  // rows are admitted a whole instant at a time. A window is a span of
  // time, so two readings in the same millisecond are both inside every
  // window that holds either of them — and the two output rows, sharing
  // an instant, therefore share an answer. Letting the loop admit one
  // and then report before admitting the other would make the aggregate
  // a function of arrival order rather than of the instant it is
  // labelled at.
  let i = 0;
  while (i < n) {
    const at = samples[i].at;
    let group = i;
    while (group + 1 < n && samples[group + 1].at === at)
      group++;

    const opens = opensAt(at);
    while (lo < i && samples[lo].at <= opens) {
      const leaving = samples[lo].value;
      if (leaving !== null) {
        sum -= leaving;
        measured--;
      }
      lo++;
    }
    for (let k = i; k <= group; k++) {
      const value = samples[k].value;
      if (value !== null) {
        sum += value;
        measured++;
        lastAt = k;
        if (deque !== null) {
          while (tail > head
            && sign * (/** @type {number} */(samples[deque[tail - 1]].value) - value) >= 0)
            tail--;
          deque[tail++] = k;
        }
      }
    }
    if (deque !== null) {
      while (tail > head && deque[head] < lo)
        head++;
    }
    if (firstAt < lo)
      firstAt = lo;
    while (firstAt <= group && samples[firstAt].value === null)
      firstAt++;

    const count = group - lo + 1;
    const value = count < minPeriods ? null
      : reduce(aggregate, count, measured, sum, samples, deque, head,
        firstAt <= group ? firstAt : -1, lastAt >= lo ? lastAt : -1);
    for (let k = i; k <= group; k++)
      out[k] = { at, count, value };
    i = group + 1;
  }
  return out;
}

/**
 * One window's rows, reduced from the state the loop already carries.
 * @param {string} aggregate
 * @param {number} count - source rows, gaps included
 * @param {number} measured - rows carrying a number
 * @param {number} sum
 * @param {Sample[]} samples
 * @param {Int32Array | null} deque
 * @param {number} head
 * @param {number} first - index of the window's first reading, or -1
 * @param {number} last - index of the window's last reading, or -1
 * @returns {number | null}
 */
function reduce(aggregate, count, measured, sum, samples, deque, head, first, last) {
  if (aggregate === 'count')
    return count;
  if (measured === 0)
    return null;
  switch (aggregate) {
    case 'sum': return sum;
    case 'mean': return sum / measured;
    case 'min':
    case 'max': return /** @type {number} */ (samples[/** @type {Int32Array} */(deque)[head]].value);
    case 'first': return first < 0 ? null : samples[first].value;
    default: return last < 0 ? null : samples[last].value;
  }
}

//#endregion
