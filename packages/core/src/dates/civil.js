//@ts-check

//#region Civil calendar arithmetic
// Proleptic Gregorian calendar math over plain integers. Nothing here
// allocates, and nothing here constructs a `Date`: going through `Date`
// to add a day costs ~181 ns against ~1.1 ns for the day-number
// conversions below, because every `Date` operation allocates and runs
// the timezone-aware setter machinery to answer a question that is pure
// integer arithmetic.
//
// The representation is the parts record of `parseRFC3339Parts`
// (rfc3339.js) - `{year, month, day, hours, minutes, seconds, offset}`,
// with -1 for a half the value does not carry and `offset` in minutes
// east of UTC. Functions here take and return parts, so a date never
// becomes an object with methods: it stays two JSON-representable forms,
// an RFC 3339 string and an epoch number.

/** Days per month, 1-based; February is the common-year length. */
const DAYS_IN_MONTH = Object.freeze([0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

/** Day number of 1970-01-01, the shift between the era epoch and the Unix epoch. */
const EPOCH_SHIFT = 719468;

/** Days in a 400-year Gregorian era. */
const ERA_DAYS = 146097;

/**
 * Whether a proleptic Gregorian year is a leap year.
 * @param {number} year
 * @returns {boolean}
 */
export function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Length of a month in days.
 * @param {number} year
 * @param {number} month - 1-12
 * @returns {number}
 */
export function daysInMonth(year, month) {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month];
}

/**
 * Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
 * Exact for every proleptic Gregorian date; no `Date`, no allocation.
 * @param {number} y - year
 * @param {number} m - month 1-12
 * @param {number} d - day 1-31
 * @returns {number} day number, negative before 1970
 */
export function daysFromCivil(y, m, d) {
  const shifted = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(shifted / 400);
  const yoe = shifted - era * 400; // [0, 399]
  const doy = Math.trunc((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy; // [0, 146096]
  return era * ERA_DAYS + doe - EPOCH_SHIFT;
}

/**
 * The inverse of {@link daysFromCivil}: a civil date from a day number.
 * @param {number} z - days since 1970-01-01
 * @returns {{ year: number, month: number, day: number }}
 */
export function civilFromDays(z) {
  const shifted = z + EPOCH_SHIFT;
  const era = Math.floor(shifted / ERA_DAYS);
  const doe = shifted - era * ERA_DAYS; // [0, 146096]
  const yoe = Math.trunc((doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36524)
    - Math.trunc(doe / 146096)) / 365); // [0, 399]
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100)); // [0, 365]
  const mp = Math.trunc((5 * doy + 2) / 153); // [0, 11]
  const day = doy - Math.trunc((153 * mp + 2) / 5) + 1; // [1, 31]
  const month = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/**
 * Day of the week for a day number: 0 = Sunday … 6 = Saturday, matching
 * `Date.prototype.getUTCDay`.
 * @param {number} z - days since 1970-01-01
 * @returns {number} 0-6
 */
export function weekdayFromDays(z) {
  // 1970-01-01 was a Thursday (4); the modulo is written to stay
  // non-negative for dates before the epoch
  return (((z + 4) % 7) + 7) % 7;
}

/**
 * ISO 8601 weekday: 1 = Monday … 7 = Sunday.
 * @param {number} z - days since 1970-01-01
 * @returns {number} 1-7
 */
export function isoWeekdayFromDays(z) {
  const w = weekdayFromDays(z);
  return w === 0 ? 7 : w;
}

/**
 * Day of the year, 1-based (1-366).
 * @param {{ year: number, month: number, day: number }} parts
 * @returns {number}
 */
export function dayOfYear(parts) {
  return daysFromCivil(parts.year, parts.month, parts.day)
    - daysFromCivil(parts.year, 1, 1) + 1;
}

/**
 * Calendar quarter, 1-4.
 * @param {{ month: number }} parts
 * @returns {number}
 */
export function quarterOfYear(parts) {
  return Math.trunc((parts.month - 1) / 3) + 1;
}

/**
 * ISO 8601 week-numbering week and its year. The ISO year is not always
 * the calendar year: 2027-01-01 is a Friday and belongs to week 53 of
 * 2026, so the pair has to be returned together.
 * @param {{ year: number, month: number, day: number }} parts
 * @returns {{ year: number, week: number }}
 */
export function isoWeekOfYear(parts) {
  const z = daysFromCivil(parts.year, parts.month, parts.day);
  // the Thursday of this week decides which year the week belongs to
  const thursday = z + (4 - isoWeekdayFromDays(z));
  const year = civilFromDays(thursday).year;
  const jan1 = daysFromCivil(year, 1, 1);
  return { year, week: Math.trunc((thursday - jan1) / 7) + 1 };
}

/**
 * The parts record of an instant, the inverse of
 * `epochOfRFC3339Parts` (rfc3339.js).
 *
 * `offset` selects the wall clock the fields are read on: 0 (the
 * default) gives UTC, 120 gives the clock in `+02:00`. The returned
 * record carries that offset, so rendering it back with
 * `formatRFC3339Parts` yields the same instant spelled in that zone.
 *
 * @param {number} ms - milliseconds since 1970-01-01T00:00:00Z
 * @param {number} [offset] - minutes east of UTC to read the clock in
 * @returns {object} a parts record, always with a time half
 */
export function partsFromEpoch(ms, offset = 0) {
  const local = ms + offset * 60000;
  const z = Math.floor(local / 86400000);
  let rest = local - z * 86400000;
  const hours = Math.floor(rest / 3600000);
  rest -= hours * 3600000;
  const minutes = Math.floor(rest / 60000);
  rest -= minutes * 60000;
  return { ...civilFromDays(z), hours, minutes, seconds: rest / 1000, offset };
}

//#endregion

//#region units

/**
 * The calendar units every unit-taking function in this module accepts.
 * Ordered coarse to fine, which is the order `startOfParts` truncates in.
 */
export const DATE_UNITS = Object.freeze([
  'year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond',
]);

const UNIT_SET = new Set(DATE_UNITS);

/**
 * Whether a string names a calendar unit.
 * @param {any} unit
 * @returns {boolean}
 */
export function isDateUnit(unit) {
  return typeof unit === 'string' && UNIT_SET.has(unit);
}

// fixed-width units in milliseconds; months, quarters and years are
// absent on purpose - they have no fixed width without a calendar anchor
const FIXED_MS = Object.freeze({
  millisecond: 1,
  second: 1000,
  minute: 60000,
  hour: 3600000,
  day: 86400000,
  week: 604800000,
});

/**
 * Milliseconds in a fixed-width unit, or 0 for the calendar units
 * (`month`, `quarter`, `year`) that do not have one.
 * @param {string} unit
 * @returns {number}
 */
export function fixedUnitMs(unit) {
  return FIXED_MS[unit] ?? 0;
}

//#endregion

//#region lexical precision

// A parts record spells one of three lexical families (rfc3339.js): a
// full-date with no clock, a full-time with no calendar, or both. An
// operation that reads a half the value has not got has no answer, and
// the alternative to refusing is to guess one - which is how `end-of`
// hour on a full-date used to answer the day BEFORE it, and how adding
// a day to a full-time used to be a silent no-op.
//
// Which half an operation reads follows from its unit:
//
//   year, quarter, month     the calendar; a full-time has none
//   week, day                the calendar, plus the clock when the
//                            amount carries a fraction of a day
//   hour .. millisecond      the clock; a full-date has none
//
// `day` and coarser truncate to a boundary a calendar has, so
// `start-of` day of a full-time is midnight and needs no date. A
// sub-day truncation names a boundary INSIDE a day, which a value with
// no clock does not have.

// A parts record with no time half reads -1 for hours/minutes/seconds;
// arithmetic treats that as midnight but must not *introduce* a time, so
// every function here records whether the input carried one.
function hasTime(parts) {
  return parts.hours >= 0;
}

/** Whether a parts record carries a calendar half. */
function hasDate(parts) {
  return parts.year >= 0;
}

function requireDate(parts, unit) {
  if (!hasDate(parts))
    throw new TypeError(`'${unit}' needs a date half, and this value has none`);
}

function requireTime(parts, unit) {
  if (!hasTime(parts))
    throw new TypeError(`'${unit}' needs a time half, and this value has none`);
}

/**
 * Split a millisecond offset into a day into clock fields. `seconds`
 * carries the fraction, as everywhere else in this module.
 * @param {number} rest - milliseconds since midnight, [0, 86400000)
 * @returns {{ hours: number, minutes: number, seconds: number }}
 */
function clockFromDayMs(rest) {
  const hours = Math.floor(rest / 3600000);
  rest -= hours * 3600000;
  const minutes = Math.floor(rest / 60000);
  rest -= minutes * 60000;
  return { hours, minutes, seconds: rest / 1000 };
}

/** Milliseconds since midnight for a parts record that carries a clock. */
function dayMsOf(parts) {
  return parts.hours * 3600000 + parts.minutes * 60000 + Math.round(parts.seconds * 1000);
}

//#endregion

//#region arithmetic over parts

// how many months each calendar unit is worth; a fraction of one of
// these is only a quantity when it converts to a whole month
const CALENDAR_MONTHS = Object.freeze({ year: 12, quarter: 3, month: 1 });

function withTime(out, parts, hours, minutes, seconds) {
  if (hasTime(parts)) {
    out.hours = hours;
    out.minutes = minutes;
    out.seconds = seconds;
    out.offset = parts.offset;
  }
  else {
    out.hours = -1;
    out.minutes = -1;
    out.seconds = -1;
    out.offset = parts.offset;
  }
  return out;
}

/**
 * Add a signed amount of calendar units to a parts record, returning a
 * new one. The input is never mutated and its lexical shape is kept: a
 * full-date stays a full-date, a full-time stays a full-time, and a
 * value keeps its own UTC offset rather than being normalized.
 *
 * Month and year arithmetic **clamps** to the end of the target month —
 * 2026-01-31 plus one month is 2026-02-28 — which is the rule every
 * mainstream date library uses, because the alternative (overflowing
 * into March) makes `add(1, 'month')` non-monotonic.
 *
 * A fraction is a quantity only where the unit has an exact conversion.
 * A fixed-width fraction becomes whole milliseconds, so `1.5 day` is
 * thirty-six hours; a calendar fraction is refused unless it lands on a
 * whole month, because half of January is not a length. The clock those
 * milliseconds land on has to exist: a full-date can be moved by whole
 * days but not by half of one.
 *
 * @param {object} parts - a parts record from `parseRFC3339Parts`
 * @param {number} amount - signed count, fractional only where the unit
 *   converts exactly and the value has the half to carry it
 * @param {string} unit - a {@link DATE_UNITS} member
 * @returns {object} a new parts record
 * @throws {TypeError} for an unknown unit, a fraction with no exact
 *   conversion, or a value missing a half the operation reads
 */
export function addToParts(parts, amount, unit) {
  if (amount === 0)
    return { ...parts };
  const perMonth = CALENDAR_MONTHS[unit];
  if (perMonth !== undefined) {
    const months = amount * perMonth;
    if (!Number.isInteger(months))
      throw new TypeError(`a fraction of a '${unit}' has no exact calendar length`);
    requireDate(parts, unit);
    const total = (parts.year * 12 + (parts.month - 1)) + months;
    const year = Math.floor(total / 12);
    const month = total - year * 12 + 1;
    const day = Math.min(parts.day, daysInMonth(year, month)); // clamp
    return withTime({ year, month, day }, parts, parts.hours, parts.minutes, parts.seconds);
  }
  const width = FIXED_MS[unit];
  if (width === undefined)
    throw new TypeError(`'${unit}' is not a calendar unit`);
  if (unit === 'day' || unit === 'week') {
    requireDate(parts, unit);
    if (Number.isInteger(amount)) {
      // whole days move the day number rather than a span of
      // milliseconds: that keeps a full-date a full-date, and stays
      // exact past the range milliseconds can count
      const z = daysFromCivil(parts.year, parts.month, parts.day)
        + amount * (unit === 'week' ? 7 : 1);
      return withTime(civilFromDays(z), parts, parts.hours, parts.minutes, parts.seconds);
    }
  }
  // a span of milliseconds: the sub-day units, and the fraction of a day
  // or week that only a clock can hold
  requireTime(parts, unit);
  const ms = Math.round(amount * width);
  if (!hasDate(parts)) {
    // no calendar to carry into, so the clock wraps inside its own day
    const dayMs = ((dayMsOf(parts) + ms) % 86400000 + 86400000) % 86400000;
    return { year: -1, month: -1, day: -1, ...clockFromDayMs(dayMs), offset: parts.offset };
  }
  // carry through the day number, so a time crossing midnight moves the
  // date with it
  const moved = daysFromCivil(parts.year, parts.month, parts.day) * 86400000
    + dayMsOf(parts) + ms;
  const dz = Math.floor(moved / 86400000);
  return {
    ...civilFromDays(dz), ...clockFromDayMs(moved - dz * 86400000), offset: parts.offset,
  };
}

/**
 * Truncate a parts record to the start of a calendar unit, returning a
 * new one. `week` starts on Monday (ISO 8601).
 *
 * `day` and coarser name a boundary the calendar has, so the start of
 * the day of a full-time is midnight. A sub-day unit names a boundary
 * inside a day, which a value with no clock does not have, and is
 * refused rather than answered from a clock that is not there.
 *
 * @param {object} parts - a parts record
 * @param {string} unit - a {@link DATE_UNITS} member
 * @returns {object} a new parts record
 * @throws {TypeError} for an unknown unit, or a value missing a half
 *   the truncation reads
 */
export function startOfParts(parts, unit) {
  let { year, month, day } = parts;
  let hours = parts.hours;
  let minutes = parts.minutes;
  let seconds = parts.seconds;
  switch (unit) {
    case 'year':
      requireDate(parts, unit); month = 1; day = 1; break;
    case 'quarter':
      requireDate(parts, unit);
      month = (quarterOfYear(parts) - 1) * 3 + 1; day = 1; break;
    case 'month':
      requireDate(parts, unit); day = 1; break;
    case 'week': {
      requireDate(parts, unit);
      const z = daysFromCivil(year, month, day);
      ({ year, month, day } = civilFromDays(z - (isoWeekdayFromDays(z) - 1)));
      break;
    }
    case 'day':
      break;
    case 'hour':
      requireTime(parts, unit); minutes = 0; seconds = 0; break;
    case 'minute':
      requireTime(parts, unit); seconds = 0; break;
    case 'second':
      requireTime(parts, unit); seconds = Math.trunc(seconds); break;
    case 'millisecond':
      requireTime(parts, unit);
      return { ...parts };
    default:
      throw new TypeError(`'${unit}' is not a calendar unit`);
  }
  if (unit === 'year' || unit === 'quarter' || unit === 'month'
    || unit === 'week' || unit === 'day') {
    hours = hasTime(parts) ? 0 : -1;
    minutes = hours;
    seconds = hours;
  }
  return { year, month, day, hours, minutes, seconds, offset: parts.offset };
}

/**
 * The last representable instant inside a calendar unit: the start of
 * the next unit less one millisecond. A value with no time half is
 * truncated to the unit's last *day* instead, so a full-date stays a
 * full-date, and it refuses the same sub-day units `startOfParts` does.
 * @param {object} parts - a parts record
 * @param {string} unit - a {@link DATE_UNITS} member
 * @returns {object} a new parts record
 * @throws {TypeError} for an unknown unit, or a value missing a half
 *   the truncation reads
 */
export function endOfParts(parts, unit) {
  const start = startOfParts(parts, unit);
  if (unit === 'millisecond')
    return start;
  if (!hasDate(parts)) {
    // a clock has no next day to step back from, so the end is the
    // unit's own width less a millisecond, inside the day it lives in
    const rest = dayMsOf(start) + FIXED_MS[unit] - 1;
    return { year: -1, month: -1, day: -1, ...clockFromDayMs(rest), offset: parts.offset };
  }
  const next = addToParts(start, 1, unit);
  if (!hasTime(parts)) {
    // date-only: step back one whole day rather than one millisecond
    const z = daysFromCivil(next.year, next.month, next.day) - 1;
    return { ...civilFromDays(z), hours: -1, minutes: -1, seconds: -1, offset: parts.offset };
  }
  return addToParts(next, -1, 'millisecond');
}

//#endregion
