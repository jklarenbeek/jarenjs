//@ts-check

//#region time-axis ticks
// The locale-free planner behind a time axis: which calendar step a
// domain should be read in, and where that step's boundaries fall. It
// lives beside the calendar arithmetic rather than in a renderer
// because a chart axis, a timeline and a bucketed series all want the
// same answer, and a second copy of this ladder would be a second set
// of tick positions.
//
// Positions only: these functions return domain values in epoch
// milliseconds. Turning one into a coordinate is the caller's scale,
// and turning one into a label is `compileDateFormat` (format.js).

import { niceStep, axisTicksLinear } from '../math/float64.js';
import { partsFromEpoch, startOfParts, addToParts } from './civil.js';
import { epochOfRFC3339Parts } from './rfc3339.js';

// The steps a clock and a calendar actually have. The 1/2/5 ladder is
// right for quantities and wrong for time: it puts ticks 50 seconds or
// 8.64 days apart, which no reader converts back into a date. Each
// entry is [unit, amount]; the unit names are the calendar's.
const TIME_STEPS = Object.freeze([
  ['second', 1], ['second', 5], ['second', 15], ['second', 30],
  ['minute', 1], ['minute', 5], ['minute', 15], ['minute', 30],
  ['hour', 1], ['hour', 3], ['hour', 6], ['hour', 12],
  ['day', 1], ['day', 2], ['week', 1], ['week', 2],
  ['month', 1], ['month', 3], ['month', 6],
  ['year', 1],
]);

/**
 * The first instant the parts contract can spell, `0000-01-01T00:00:00Z`.
 * A negative year is that contract's "no date half" sentinel
 * (rfc3339.js), so an older domain has no calendar boundary to land on
 * and this planner has no ticks to offer it.
 */
const CALENDAR_MIN_MS = -62167219200000;

// approximate widths, used only to pick a step near the target count
const STEP_MS = Object.freeze({
  second: 1000, minute: 60000, hour: 3600000, day: 86400000,
  week: 604800000, month: 2629800000, year: 31557600000,
});

/**
 * Choose the calendar step closest to covering `span` in `count` ticks.
 *
 * A year is the coarsest unit a calendar has, so above one year the
 * ladder continues as whole years on the same 1/2/5×10^k steps — 2, 5,
 * 10, 50, 1000 years. Without that continuation a millennial domain
 * asks for one tick per year and runs out of axis long before it runs
 * out of domain.
 *
 * @param {number} span - Domain width in milliseconds
 * @param {number} count - Desired tick count
 * @returns {[string, number]} a [unit, amount] pair
 */
export function niceTimeStep(span, count) {
  const target = span / Math.max(1, count);
  if (target > STEP_MS.year)
    return ['year', Math.max(1, niceStep(target / STEP_MS.year))];
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
  return /** @type {[string, number]} */ (best);
}

/**
 * Time ticks on calendar boundaries: the first tick is the start of a
 * `[unit, amount]` step at or after `min`, and each following one is a
 * whole step later. A multi-unit step lands on a multiple of its own
 * amount — months on 1, 4, 7, 10 and years on 1900, 1950, 2000 — so an
 * axis reads as a calendar rather than as offsets from wherever the
 * data happened to start.
 *
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
  if (min < CALENDAR_MIN_MS)
    return [];
  const [unit, amount] = niceTimeStep(span, count);
  // snap to the step's own boundary, then advance whole steps
  let parts = startOfParts(partsFromEpoch(min), unit);
  if (amount > 1 && unit === 'month') {
    // quarters and half-years start on month 1, 4, 7, 10 (or 1, 7)
    parts = { ...parts, month: Math.floor((parts.month - 1) / amount) * amount + 1 };
  }
  else if (amount > 1 && unit === 'year') {
    parts = { ...parts, year: Math.floor(parts.year / amount) * amount };
  }
  const ticks = [];
  let ms = epochOfRFC3339Parts(parts);
  while (ms < min) {
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

//#endregion
