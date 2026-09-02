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

/**
 * The label patterns a time axis compiles, keyed by the granularity of
 * the step the ticks were laid on. Every default is numeric, so an axis
 * with no `dateNames` record needs none; a caller overrides a member
 * through `timeFormats` on the chart definition.
 * @type {Readonly<Record<'second'|'minute'|'day'|'month'|'year', string>>}
 */
export const TIME_TICK_FORMATS = Object.freeze({
  second: 'HH:mm:ss',
  minute: 'HH:mm',
  day: 'yyyy-MM-dd',
  month: 'yyyy-MM',
  year: 'yyyy',
});

/**
 * @typedef {object} TimeTickFormatOptions
 * @property {import('@jarenjs/core/dates').DateNames} [dateNames] - the
 *  month, weekday and meridiem names a name token (`MMMM`, `EEE`, `a`)
 *  reads; exactly the `names` member `compileDateLocale(pack)` returns
 * @property {Partial<Record<'second'|'minute'|'day'|'month'|'year', string>>} [timeFormats]
 *  - LDML patterns replacing the defaults in `TIME_TICK_FORMATS`, per
 *  step granularity
 */

/**
 * Compile the five patterns once against a names record — the compile
 * step of a two-stage labeller, so the per-label work is one walk of a
 * compiled chain and never a pattern scan. A pattern that asks for a
 * locale name with no record to answer it is refused here, at compile
 * time, in the same terms the Mermaid Gantt refuses one: this engine
 * ships no month or weekday names of its own.
 * @param {TimeTickFormatOptions} options
 * @returns {Record<'second'|'minute'|'day'|'month'|'year', (parts: object) => string>}
 */
function compileTickSet(options) {
  const names = options.dateNames ?? undefined;
  const patterns = options.timeFormats ?? undefined;
  const set = /** @type {any} */ ({});
  for (const key of /** @type {const} */ (['second', 'minute', 'day', 'month', 'year'])) {
    const pattern = patterns?.[key] ?? TIME_TICK_FORMATS[key];
    try {
      set[key] = compileDateFormat(pattern, names);
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (names === undefined && message.includes('names provider')) {
        throw new TypeError(`timeFormats.${key} '${pattern}' asks for a locale name, so it needs a`
          + " 'dateNames' record (a 'dateNames' member on the chart definition);"
          + ' this engine ships no month or weekday names of its own');
      }
      throw new TypeError(`timeFormats.${key} '${pattern}' cannot be compiled: ${message}`);
    }
  }
  return set;
}

/**
 * The label for one tick out of a compiled set — see `formatTimeTick`
 * for the step and no-step rules.
 * @param {Record<string, (parts: object) => string>} set
 * @param {number|Date} v
 * @param {[string, number]|undefined} step
 * @returns {string}
 */
function labelTimeTick(set, v, step) {
  const ms = typeof v === 'number' ? v : v.getTime();
  const parts = partsFromEpoch(ms);
  if (step === undefined) {
    return parts.hours === 0 && parts.minutes === 0 && parts.seconds === 0
      ? set.day(parts)
      : set.second(parts);
  }
  const unit = step[0];
  if (unit === 'second')
    return set.second(parts);
  if (unit === 'minute' || unit === 'hour')
    return set.minute(parts);
  if (unit === 'day' || unit === 'week')
    return set.day(parts);
  return unit === 'month' ? set.month(parts) : set.year(parts);
}

/**
 * Build a time-axis labeller: the five step patterns compiled once,
 * against the `dateNames` record the chart definition carries, so a
 * render compiles per build and never per label. The result has the
 * signature and rules of `formatTimeTick`. With neither member given it
 * labels exactly as `formatTimeTick` does.
 *
 * A pattern with a name token (`MMMM`, `MMM`, `EEEE`, `EEE`, `a`) and no
 * `dateNames` is a refusal — a `TypeError` — not a silent English
 * fallback; the numeric defaults need no record.
 *
 * @param {TimeTickFormatOptions} [options]
 * @returns {(v: number|Date, step?: [string, number]) => string}
 * @throws {TypeError} on a name token with no `dateNames`, or a pattern
 *   that does not compile
 * @example
 * const label = compileTimeTickFormat({
 *   dateNames: compileDateLocale(nl).names,
 *   timeFormats: { day: 'EEEE d MMMM' },
 * });
 * label(Date.UTC(2026, 6, 27), ['day', 1]); // 'maandag 27 juli'
 */
export function compileTimeTickFormat(options = {}) {
  // nothing to compile against: the shared record-free labeller, so a
  // definition with neither member costs no compilation per build
  if (options.dateNames === undefined && options.timeFormats === undefined)
    return formatTimeTick;
  const set = compileTickSet(options);
  return (v, step = undefined) => labelTimeTick(set, v, step);
}

// The record-free set behind `formatTimeTick`: compiled on first use and
// kept, so a render with no `dateNames` compiles nothing at all.
/** @type {Record<string, (parts: object) => string>|null} */
let DEFAULT_SET = null;

/**
 * A time-axis tick label in UTC (deterministic across machines).
 *
 * With a `step` the label matches the step's granularity — clock time
 * for intraday ticks, a date for daily ones, a month or year above that
 * — so an axis never repeats the same string on every tick. Without one
 * it keeps the historical behaviour: `HH:MM:SS`, or the date when the
 * value sits exactly on a day boundary.
 *
 * The patterns are the numeric defaults in `TIME_TICK_FORMATS`; a
 * localized axis compiles its own labeller with `compileTimeTickFormat`.
 *
 * @param {number|Date} v - Epoch milliseconds or a Date
 * @param {[string, number]} [step] - The [unit, amount] the axis stepped by
 * @returns {string}
 */
export function formatTimeTick(v, step = undefined) {
  if (DEFAULT_SET === null)
    DEFAULT_SET = compileTickSet({});
  return labelTimeTick(DEFAULT_SET, v, step);
}

function trim(x) {
  return String(Float64.roundToPrecision(x, 3));
}
