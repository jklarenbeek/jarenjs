//@ts-check
/**
 * @file Tick generators. Linear ticks snap to a nice-number step
 * (1/2/5 × 10^k) so an axis never shows values like `12.75`; log ticks
 * are decade powers (the shape benchmark-ratio charts need, where one
 * axis spans two orders of magnitude); ordinal ticks center on their
 * band. Tick *positions* are the caller's job via the matching scale —
 * these functions return domain values only.
 */

import { niceStep } from '@jarenjs/core/math';
import {
  partsFromEpoch,
  epochOfRFC3339Parts,
  startOfParts,
  addToParts,
  compileDateFormat,
} from '@jarenjs/core/dates';

// The 1/2/5 ladder is generic numeric math, so it lives in the kernel; it is
// re-exported here because it is part of this module's tick vocabulary.
export { niceStep };

/**
 * Linear ticks: multiples of a nice step inside `[min, max]`.
 * Degenerate domains yield a single tick.
 * @param {number} min - Domain minimum
 * @param {number} max - Domain maximum
 * @param {number} [count] - Desired tick count (approximate)
 * @returns {number[]}
 */
export function axisTicksLinear(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max))
    return [];
  if (min === max)
    return [min];
  if (min > max)
    return axisTicksLinear(max, min, count);
  const step = niceStep(max - min, count);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks = [];
  const first = Math.ceil(min / step);
  const last = Math.floor(max / step);
  for (let i = first; i <= last; ++i)
    ticks.push(Number((i * step).toFixed(decimals)));
  return ticks;
}

/**
 * Log ticks: the decade powers (… 0.1, 1, 10, 100 …) inside
 * `[min, max]`. When the domain sits within a single decade the
 * endpoints are returned so the axis is never empty.
 * @param {number} min - Domain minimum (> 0)
 * @param {number} max - Domain maximum (> 0)
 * @returns {number[]}
 */
export function axisTicksLog(min, max) {
  if (!(min > 0) || !(max > 0))
    throw new RangeError(`axisTicksLog domain must be positive, got [${min}, ${max}]`);
  if (min > max)
    return axisTicksLog(max, min);
  const ticks = [];
  const first = Math.ceil(Math.log10(min) - 1e-12);
  const last = Math.floor(Math.log10(max) + 1e-12);
  for (let k = first; k <= last; ++k)
    ticks.push(Math.pow(10, k));
  return ticks.length !== 0 ? ticks : [min, max];
}

/**
 * Ordinal ticks: every category, centered on its band.
 * @param {readonly string[]} categories - Domain, in display order
 * @returns {{label: string, pos: number}[]} positions in [0,1]
 */
export function axisTicksOrdinal(categories) {
  const n = categories.length;
  return categories.map((label, i) => ({ label, pos: (i + 0.5) / n }));
}

/**
 * A compact tick label: `1.5k`, `2M`, `1G` for large magnitudes,
 * 3-significant-digit decimals otherwise.
 * @param {number} v - Tick value
 * @returns {string}
 */
export function formatTickValue(v) {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e9) return trim(v / 1e9) + 'G';
  if (abs >= 1e6) return trim(v / 1e6) + 'M';
  if (abs >= 1e3) return trim(v / 1e3) + 'k';
  return trim(v);
}

// The steps a clock and a calendar actually have. The 1/2/5 ladder is
// right for quantities and wrong for time: it puts ticks 50 seconds or
// 8.64 days apart, which no reader converts back into a date. Each entry
// is [unit, amount]; the unit names are the kernel's.
const TIME_STEPS = Object.freeze([
  ['second', 1], ['second', 5], ['second', 15], ['second', 30],
  ['minute', 1], ['minute', 5], ['minute', 15], ['minute', 30],
  ['hour', 1], ['hour', 3], ['hour', 6], ['hour', 12],
  ['day', 1], ['day', 2], ['week', 1], ['week', 2],
  ['month', 1], ['month', 3], ['month', 6],
  ['year', 1],
]);

// approximate widths, used only to pick a step near the target count
const STEP_MS = Object.freeze({
  second: 1000, minute: 60000, hour: 3600000, day: 86400000,
  week: 604800000, month: 2629800000, year: 31557600000,
});

/**
 * Choose the calendar step closest to covering `span` in `count` ticks.
 * @param {number} span - Domain width in milliseconds
 * @param {number} count - Desired tick count
 * @returns {[string, number]} a [unit, amount] pair
 */
export function niceTimeStep(span, count) {
  const target = span / Math.max(1, count);
  let best = TIME_STEPS[0];
  let bestErr = Infinity;
  for (let i = 0; i < TIME_STEPS.length; i++) {
    const [unit, amount] = TIME_STEPS[i];
    const err = Math.abs(Math.log(STEP_MS[unit] * amount / target));
    if (err < bestErr) {
      bestErr = err;
      best = TIME_STEPS[i];
    }
  }
  return best;
}

/**
 * Time ticks on calendar boundaries: the first tick is the start of a
 * `[unit, amount]` step at or after `min`, and each following one is a
 * whole step later. Month and year steps land on the first of the
 * month, so a multi-year axis reads `2024 2025 2026` rather than
 * arbitrary instants.
 * @param {number} min - Domain minimum, epoch milliseconds
 * @param {number} max - Domain maximum, epoch milliseconds
 * @param {number} [count] - Desired tick count (approximate)
 * @returns {number[]} tick values in epoch milliseconds
 */
export function axisTicksTime(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max))
    return [];
  if (min === max)
    return [min];
  if (min > max)
    return axisTicksTime(max, min, count);
  const span = max - min;
  // below a second the calendar has nothing to say; the numeric ladder does
  if (span < 1000 * count)
    return axisTicksLinear(min, max, count);
  const [unit, amount] = niceTimeStep(span, count);
  // snap to the step's own boundary, then advance whole steps
  let parts = startOfParts(partsFromEpoch(min), unit === 'week' ? 'week' : unit);
  if (unit === 'month' && amount > 1) {
    // quarters and half-years start on month 1, 4, 7, 10 (or 1, 7)
    const aligned = Math.floor((parts.month - 1) / amount) * amount + 1;
    parts = { ...parts, month: aligned };
  }
  const ticks = [];
  let ms = epochOfRFC3339Parts(parts);
  if (ms < min) {
    parts = addToParts(parts, amount, unit);
    ms = epochOfRFC3339Parts(parts);
  }
  // the step is never zero, so this terminates; the cap is a guard
  // against a pathological domain rather than an expected path
  for (let i = 0; ms <= max && i < 1000; i++) {
    ticks.push(ms);
    parts = addToParts(parts, amount, unit);
    ms = epochOfRFC3339Parts(parts);
  }
  return ticks;
}

// label patterns by how coarse the step is, compiled once
const LABEL_SECOND = compileDateFormat('HH:mm:ss');
const LABEL_MINUTE = compileDateFormat('HH:mm');
const LABEL_DAY = compileDateFormat('yyyy-MM-dd');
const LABEL_MONTH = compileDateFormat('yyyy-MM');
const LABEL_YEAR = compileDateFormat('yyyy');

/**
 * A time-axis tick label in UTC (deterministic across machines).
 *
 * With a `step` the label matches the step's granularity — clock time
 * for intraday ticks, a date for daily ones, a month or year above that
 * — so an axis never repeats the same string on every tick. Without one
 * it keeps the historical behaviour: `HH:MM:SS`, or the date when the
 * value sits exactly on a day boundary.
 *
 * @param {number|Date} v - Epoch milliseconds or a Date
 * @param {[string, number]} [step] - The [unit, amount] the axis stepped by
 * @returns {string}
 */
export function formatTimeTick(v, step = undefined) {
  const ms = typeof v === 'number' ? v : v.getTime();
  const parts = partsFromEpoch(ms);
  if (step === undefined) {
    return parts.hours === 0 && parts.minutes === 0 && parts.seconds === 0
      ? LABEL_DAY(parts)
      : LABEL_SECOND(parts);
  }
  const unit = step[0];
  if (unit === 'second')
    return LABEL_SECOND(parts);
  if (unit === 'minute' || unit === 'hour')
    return LABEL_MINUTE(parts);
  if (unit === 'day' || unit === 'week')
    return LABEL_DAY(parts);
  return unit === 'month' ? LABEL_MONTH(parts) : LABEL_YEAR(parts);
}

function trim(x) {
  return String(Number(x.toPrecision(3)));
}
