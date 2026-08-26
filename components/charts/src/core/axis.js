//@ts-check
/**
 * @file Tick generators. The numeric 1/2/5 × 10^k ladder and the
 * calendar step ladder are the kernel's, so an axis never shows values
 * like `12.75` and a timeline that is not a chart reads the same
 * boundaries; log ticks are decade powers (the shape benchmark-ratio
 * charts need, where one axis spans two orders of magnitude); ordinal
 * ticks center on their band; and the tick *labels* are this module's.
 * Tick *positions* are the caller's job via the matching scale — these
 * functions return domain values only.
 */

import { Float64, niceStep, axisTicksLinear } from '@jarenjs/core/math';
import { partsFromEpoch, compileDateFormat, niceTimeStep, axisTicksTime } from '@jarenjs/core/dates';

// The 1/2/5 ladder and the ticks it lays down are generic numeric math, and
// the calendar step ladder is the kernel's too — a timeline that is not a
// chart wants the same tick positions, and a second copy of either would be
// a second set of answers. They are re-exported here because they are part
// of this module's tick vocabulary.
export { niceStep, axisTicksLinear, niceTimeStep, axisTicksTime };

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
  return String(Float64.roundToPrecision(x, 3));
}
