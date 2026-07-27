//@ts-check

//#region Durations
// `isValidDuration` (rfc3339.js) recognizes an ISO 8601 duration but
// never takes one apart, so a duration in a document is a string nothing
// can do arithmetic with. This module decomposes it.
//
// The design constraint is the one that makes durations awkward
// everywhere: **a duration is not a number of milliseconds**. `P1M` is
// 28, 29, 30 or 31 days depending on where you stand, and `P1Y` is 365
// or 366. So a duration decomposes into two groups - the calendar part
// (years, months) and the fixed part (weeks down to seconds) - and only
// the fixed part converts to milliseconds without an anchor. Anything
// that needs the calendar part applies it to a date, through
// `addToParts`, where the anchor exists.

import { addToParts, daysFromCivil } from './civil.js';

/**
 * A decomposed ISO 8601 duration. Every field is a non-negative number;
 * `negative` carries the sign, so the parts describe a magnitude.
 * @typedef {Object} DurationParts
 * @property {boolean} negative
 * @property {number} years
 * @property {number} months
 * @property {number} weeks
 * @property {number} days
 * @property {number} hours
 * @property {number} minutes
 * @property {number} seconds - may be fractional
 */

const ZERO = Object.freeze({
  negative: false, years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0,
});

// Designators, split at 'T'. The same letter means months before the
// 'T' and minutes after it, which is the whole reason a duration cannot
// be scanned with one table. The number is the designator's rank: they
// MUST appear coarse-to-fine, so 'PT1S1H' is not a duration.
const DATE_FIELDS = { Y: ['years', 0], M: ['months', 1], W: ['weeks', 2], D: ['days', 3] };
const TIME_FIELDS = { H: ['hours', 0], M: ['minutes', 1], S: ['seconds', 2] };

/**
 * Decompose an ISO 8601 / RFC 3339 duration string into its parts.
 *
 * This is a deliberate **superset** of `isValidDuration` (rfc3339.js),
 * which stays strict because it backs the JSON Schema `duration` format
 * and must reject what the RFC rejects. This parser additionally accepts
 * a leading `-` and a fractional component (`PT1.5H`), both of which ISO
 * 8601 allows. So `parseDuration(s) !== null` does not imply
 * `isValidDuration(s)`, and a consumer that needs RFC strictness must
 * ask the validator, not this.
 *
 * Designators must appear coarse-to-fine within each half (`P1Y2M`, not
 * `P2M1Y`), each at most once, and `W` does not mix with `Y`/`M`/`D`.
 * Returns null for anything it cannot read, so callers branch rather
 * than catch.
 *
 * @param {any} str - the duration string, e.g. `'P1Y2M3DT4H5M6S'`
 * @returns {DurationParts | null}
 * @example
 * parseDuration('P1Y2M3DT4H5M6S');
 * // { negative: false, years: 1, months: 2, weeks: 0, days: 3,
 * //   hours: 4, minutes: 5, seconds: 6 }
 */
export function parseDuration(str) {
  if (typeof str !== 'string' || str.length < 3)
    return null;
  let i = 0;
  const negative = str.charCodeAt(0) === 0x2D; // '-'
  if (negative)
    i++;
  if (str.charCodeAt(i) !== 0x50) // 'P'
    return null;
  i++;

  const out = { ...ZERO, negative };
  let fields = DATE_FIELDS;
  let seenAny = false;
  let seenTime = false;
  let lastRank = -1;

  while (i < str.length) {
    if (str.charCodeAt(i) === 0x54) { // 'T'
      if (seenTime)
        return null;
      seenTime = true;
      fields = TIME_FIELDS;
      lastRank = -1;
      i++;
      // 'T' must be followed by at least one component
      if (i >= str.length)
        return null;
      continue;
    }
    // a number: digits, optionally one fraction
    const start = i;
    while (i < str.length) {
      const c = str.charCodeAt(i);
      if (c < 0x30 || c > 0x39)
        break;
      i++;
    }
    if (i === start)
      return null; // a designator with no number
    if (i < str.length && (str.charCodeAt(i) === 0x2E || str.charCodeAt(i) === 0x2C)) {
      i++; // '.' or ',' - ISO 8601 allows both as the decimal sign
      const fracStart = i;
      while (i < str.length) {
        const c = str.charCodeAt(i);
        if (c < 0x30 || c > 0x39)
          break;
        i++;
      }
      if (i === fracStart)
        return null;
    }
    if (i >= str.length)
      return null; // a number with no designator
    const entry = fields[str[i]];
    if (entry === undefined)
      return null; // wrong designator for this side of the 'T'
    if (entry[1] <= lastRank)
      return null; // out of order, or the same designator twice
    lastRank = entry[1];
    // '.' and ',' both spell the decimal point; Number wants '.'
    out[entry[0]] = Number(str.slice(start, i).replace(',', '.'));
    i++;
    seenAny = true;
  }
  if (!seenAny)
    return null; // bare 'P' or 'PT'
  // 'W' does not combine with the other date designators (RFC 3339 App. A)
  if (out.weeks !== 0 && (out.years !== 0 || out.months !== 0 || out.days !== 0))
    return null;
  return out;
}

/**
 * The fixed-width span of a duration in milliseconds — weeks, days,
 * hours, minutes and seconds only.
 *
 * Returns NaN when the duration carries years or months, because those
 * have no width without a date to stand on. That is a deliberate refusal
 * rather than an approximation: silently calling a month 30 days is how
 * "in 1 month" lands on the wrong day.
 *
 * @param {DurationParts} parts
 * @returns {number} signed milliseconds, or NaN if not fixed-width
 */
export function durationToMs(parts) {
  if (parts.years !== 0 || parts.months !== 0)
    return NaN;
  const ms = parts.weeks * 604800000
    + parts.days * 86400000
    + parts.hours * 3600000
    + parts.minutes * 60000
    + parts.seconds * 1000;
  return parts.negative ? -ms : ms;
}

/**
 * Whether a duration has a width independent of where it is applied.
 * @param {DurationParts} parts
 * @returns {boolean}
 */
export function isFixedDuration(parts) {
  return parts.years === 0 && parts.months === 0;
}

/**
 * Apply a duration to a parts record, the operation that gives the
 * calendar fields their meaning. Coarse units apply first, so
 * `2026-01-31` plus `P1M1D` is February's clamped 28th plus a day, not
 * March 1st plus a month.
 *
 * @param {object} dateParts - a parts record from `parseRFC3339Parts`
 * @param {DurationParts} duration
 * @param {number} [sign] - 1 to add (default), -1 to subtract
 * @returns {object} a new parts record
 */
export function addDuration(dateParts, duration, sign = 1) {
  const s = (duration.negative ? -1 : 1) * (sign < 0 ? -1 : 1);
  let out = dateParts;
  if (duration.years !== 0) out = addToParts(out, s * duration.years, 'year');
  if (duration.months !== 0) out = addToParts(out, s * duration.months, 'month');
  if (duration.weeks !== 0) out = addToParts(out, s * duration.weeks, 'week');
  if (duration.days !== 0) out = addToParts(out, s * duration.days, 'day');
  if (duration.hours !== 0) out = addToParts(out, s * duration.hours, 'hour');
  if (duration.minutes !== 0) out = addToParts(out, s * duration.minutes, 'minute');
  if (duration.seconds !== 0) out = addToParts(out, s * duration.seconds, 'second');
  return out === dateParts ? { ...dateParts } : out;
}

/**
 * Whole calendar months between two dates, ignoring the time of day —
 * the building block `diff` needs for the units that are not fixed-width.
 *
 * "Whole" is defined by `addToParts`, so that adding the result back to
 * `from` never overshoots `to`. That makes 2026-01-31 → 2026-02-28 **one**
 * month, not zero, because the clamping rule already says Jan 31 plus a
 * month IS Feb 28. Keeping the two operations inverse is worth more than
 * matching moment here, which reports zero for the same pair.
 *
 * @param {object} from - a parts record
 * @param {object} to - a parts record
 * @returns {number} signed month count
 */
export function monthsBetween(from, to) {
  let months = (to.year - from.year) * 12 + (to.month - from.month);
  if (months === 0)
    return 0;
  // step back if the day of month has not been reached yet
  const advanced = addToParts(from, months, 'month');
  const advancedDay = daysFromCivil(advanced.year, advanced.month, advanced.day);
  const toDay = daysFromCivil(to.year, to.month, to.day);
  if (months > 0 && advancedDay > toDay)
    months -= 1;
  else if (months < 0 && advancedDay < toDay)
    months += 1;
  return months;
}

//#endregion
