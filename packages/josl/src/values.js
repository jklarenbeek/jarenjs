//#region JOSL first-class value types
// TOML distinguishes four date-time flavours; JavaScript's `Date` can only
// faithfully hold the offset one. JOSL keeps the local flavours in small
// immutable value classes that round-trip through `toString()` and behave
// under `JSON.stringify` via `toJSON()`. An offset date-time parses to a
// native `Date` (the original offset is normalized to the instant).

import { daysInMonth } from '@jarenjs/core/dates';

function pad(n, w) {
  return String(n).padStart(w, '0');
}

/**
 * A TOML/JOSL local date (no time, no offset), e.g. `1979-05-27`.
 */
export class LocalDate {
  /**
   * @param {number} year - Full year
   * @param {number} month - 1-based month
   * @param {number} day - 1-based day of month
   */
  constructor(year, month, day) {
    this.year = year;
    this.month = month;
    this.day = day;
    Object.freeze(this);
  }
  toString() {
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
  }
  toJSON() {
    return this.toString();
  }
}

/**
 * A TOML/JOSL local time (no date, no offset), e.g. `07:32:00.999`.
 * The sub-second part is kept as the literal fraction string (including
 * the leading dot, or `''`) so precision round-trips exactly.
 */
export class LocalTime {
  /**
   * @param {number} hour - 0-23
   * @param {number} minute - 0-59
   * @param {number} second - 0-60 (60 allows leap seconds)
   * @param {string} [fraction] - Literal fraction incl. leading dot, or ''
   */
  constructor(hour, minute, second, fraction = '') {
    this.hour = hour;
    this.minute = minute;
    this.second = second;
    this.fraction = fraction;
    Object.freeze(this);
  }
  toString() {
    return `${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}${this.fraction}`;
  }
  toJSON() {
    return this.toString();
  }
}

/**
 * A TOML/JOSL local date-time (no offset), e.g. `1979-05-27T07:32:00`.
 */
export class LocalDateTime {
  /**
   * @param {LocalDate} date - The date part
   * @param {LocalTime} time - The time part
   */
  constructor(date, time) {
    this.date = date;
    this.time = time;
    Object.freeze(this);
  }
  toString() {
    return `${this.date.toString()}T${this.time.toString()}`;
  }
  toJSON() {
    return this.toString();
  }
}

/**
 * Whether year/month/day form an existing calendar date. The month
 * lengths and the leap rule come from the shared calendar kernel, so
 * TOML's four date flavours and the rest of the suite cannot disagree
 * about whether a date exists.
 * @param {number} year - Full year
 * @param {number} month - 1-based month
 * @param {number} day - 1-based day
 * @returns {boolean} True when the date exists
 */
export function isValidDateParts(year, month, day) {
  if (month < 1 || month > 12 || day < 1)
    return false;
  return day <= daysInMonth(year, month);
}

/**
 * Whether hour/minute/second form a valid time-of-day (second 60 is
 * accepted for leap seconds).
 * @param {number} hour - Hours
 * @param {number} minute - Minutes
 * @param {number} second - Seconds
 * @returns {boolean} True when in range
 */
export function isValidTimeParts(hour, minute, second) {
  return hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 60;
}

//#endregion
