//@ts-check

import {
  isStringType,
  isObjectOfClass,
} from '../index.js';
// the calendar rules live in civil.js, which owns the day tables
import { isLeapYear, daysInMonth } from './civil.js';

export { isLeapYear };

//#region Dates Constants
export const CONST_TICKS_SECOND = 1000;
export const CONST_TICKS_HOUR = CONST_TICKS_SECOND * 60 * 60;
export const CONST_TICKS_DAY = CONST_TICKS_HOUR * 24;

export const CONST_TIME_INSERTDATE = '1970-01-01T';
export const CONST_DATE_APPENDTIME = 'T00:00:00Z';

export const CONST_RFC3339_DAYS = Object.freeze(
  [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
);

//#endregion

//#region Dates Compare
export function isDateType(data) {
  return isObjectOfClass(data, Date);
}

export function isDateishType(data) {
  return isDateType(data)
    || !Number.isNaN(Date.parse(data));
}

export function isDateOnlyInRange(year = 0, month = 0, day = 0) {
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month);
}

/**
 * Reads two ASCII digits at index i as a number, or -1 when either
 * character is not an ASCII digit (out-of-range indexes read as NaN and
 * also yield -1).
 * @param {string} str - The string to read from
 * @param {number} i - The index of the first digit
 * @returns {number} The two-digit value, or -1
 */
function getTwoDigits(str, i) {
  const a = str.charCodeAt(i) - 48;
  const b = str.charCodeAt(i + 1) - 48;
  return (a >= 0 && a <= 9 && b >= 0 && b <= 9)
    ? a * 10 + b
    : -1;
}

/**
 * Validates the region [from, to) of str as an RFC 3339 full-date
 * (YYYY-MM-DD, with an optional trailing z/Z) without allocating.
 * @param {string} str - The string containing the date
 * @param {number} from - Start of the region (inclusive)
 * @param {number} to - End of the region (exclusive)
 * @returns {boolean} True when the region is a valid full-date
 */
function isDateOnlyRegion(str, from, to) {
  let end = to;
  const zc = str.charCodeAt(end - 1);
  if (zc === 122 || zc === 90) end--; // optional trailing z/Z
  if (end - from !== 10) return false;

  const y1 = getTwoDigits(str, from);
  const y2 = getTwoDigits(str, from + 2);
  if (y1 < 0 || y2 < 0) return false;
  if (str.charCodeAt(from + 4) !== 45) return false; // '-'
  const m = getTwoDigits(str, from + 5);
  if (m < 0) return false;
  if (str.charCodeAt(from + 7) !== 45) return false; // '-'
  const d = getTwoDigits(str, from + 8);
  if (d < 0) return false;
  return isDateOnlyInRange(y1 * 100 + y2, m, d);
}

export function isDateOnlyRFC3339(str) {
  return isStringType(str)
    && isDateOnlyRegion(str, 0, str.length);
}

export function isTimeOnlyInRange(hrs = 0, min = 0, sec = 0, tzh = 0, tzm = 0, tzSign = 1) {
  // Validate timezone offset range
  if (tzh < 0 || tzh > 23 || tzm < 0 || tzm > 59)
    return false;
  
  // For leap seconds (sec === 60), we need to check if the corresponding UTC time
  // is 23:59:60. A leap second is only valid at the very end of a UTC day.
  if (sec === 60) {
    // Calculate what the UTC time would be
    // UTC = local - offset (if offset is positive, local is ahead of UTC)
    // So: UTC = local + (tzSign * tzh) hours + (tzSign * tzm) minutes
    let utcHrs = hrs - (tzSign * tzh);
    let utcMin = min - (tzSign * tzm);
    
    // Handle wrap-around
    while (utcMin < 0) {
      utcMin += 60;
      utcHrs -= 1;
    }
    while (utcMin >= 60) {
      utcMin -= 60;
      utcHrs += 1;
    }
    while (utcHrs < 0) {
      utcHrs += 24;
    }
    utcHrs = utcHrs % 24;
    
    // Leap second is only valid at 23:59:60 UTC
    return utcHrs === 23 && utcMin === 59 && sec === 60;
  }
  
  // Normal time validation (sec 0-59)
  return hrs >= 0 && hrs <= 23
    && min >= 0 && min <= 59
    && sec >= 0 && sec <= 59;
}

/**
 * Validates the tail of str starting at index from as an RFC 3339
 * full-time (HH:MM:SS with an optional 1-6 digit fraction and a required
 * z/Z or +HH:MM/-HH:MM offset) without allocating.
 * @param {string} str - The string containing the time
 * @param {number} from - Start of the time (inclusive; runs to the end)
 * @returns {boolean} True when the tail is a valid full-time
 */
function isTimeOnlyRegion(str, from) {
  const len = str.length;
  const h = getTwoDigits(str, from);
  if (h < 0 || str.charCodeAt(from + 2) !== 58) return false; // ':'
  const m = getTwoDigits(str, from + 3);
  if (m < 0 || str.charCodeAt(from + 5) !== 58) return false; // ':'
  const s = getTwoDigits(str, from + 6);
  if (s < 0) return false;

  let i = from + 8;
  if (str.charCodeAt(i) === 46) { // '.' starts a 1-6 digit fraction
    const start = ++i;
    while (i < len) {
      const c = str.charCodeAt(i);
      if (c >= 48 && c <= 57) i++;
      else break;
    }
    const digits = i - start;
    if (digits < 1 || digits > 6) return false;
  }

  const c = str.charCodeAt(i);
  if (c === 122 || c === 90) { // z/Z: UTC, must end the string
    return i + 1 === len
      && isTimeOnlyInRange(h, m, s, 0, 0, 1);
  }

  if (c !== 43 && c !== 45) return false; // '+'/'-'
  if (i + 6 !== len) return false;
  const th = getTwoDigits(str, i + 1);
  if (th < 0 || str.charCodeAt(i + 3) !== 58) return false; // ':'
  const tm = getTwoDigits(str, i + 4);
  if (tm < 0) return false;
  // + means local time is ahead of UTC, so we subtract to get UTC
  // - means local time is behind UTC, so we add to get UTC
  return isTimeOnlyInRange(h, m, s, th, tm, c === 45 ? -1 : 1);
}

export function isTimeOnlyRFC3339(str) {
  return isStringType(str)
    && isTimeOnlyRegion(str, 0);
}

/**
 * Whether the character code separates the date and time parts of a
 * date-time: 't'/'T' or whitespace (the set matched by the \s class).
 * @param {number} c - The character code
 * @returns {boolean} True for a date/time separator
 */
function isDateTimeSeparator(c) {
  if (c === 116 || c === 84 || c === 32) return true; // t T space
  if (c >= 9 && c <= 13) return true; // \t \n \v \f \r
  return c === 0x00A0 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200A)
    || c === 0x2028 || c === 0x2029 || c === 0x202F
    || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}

export function isDateTimeRFC3339(str) {
  // http://tools.ietf.org/html/rfc3339#section-5.6
  if (!isStringType(str)) return false;
  // Exactly one separator splits the full-date from the full-time.
  const len = str.length;
  let sep = -1;
  for (let i = 0; i < len; ++i) {
    if (isDateTimeSeparator(str.charCodeAt(i))) {
      if (sep !== -1) return false;
      sep = i;
    }
  }
  return sep !== -1
    && isDateOnlyRegion(str, 0, sep)
    && isTimeOnlyRegion(str, sep + 1);
}

//#endregion

//#region Dates Getters
export function getDateTypeOfDateOnlyRFC3339(str, def = undefined) {
  return isDateOnlyRFC3339(str)
    ? new Date(Date.parse(str))
    : def;
}

export function getDateTypeOfTimeOnlyRFC3339(str, def = undefined) {
  return isTimeOnlyRFC3339(str)
    ? new Date(Date.parse(CONST_TIME_INSERTDATE + str))
    : def;
}

export function getDateTypeOfDateTimeRFC3339(str, def = undefined) {
  return isDateTimeRFC3339(str)
    ? new Date(Date.parse(str))
    : def;
}

/**
 * Reads the full-date at index from as {year, month, day}. The region
 * must already have passed isDateOnlyRegion.
 * @param {string} str - The string containing the date
 * @param {number} from - Index of the first digit
 * @returns {{ year: number, month: number, day: number }}
 */
function readDateParts(str, from) {
  return {
    year: getTwoDigits(str, from) * 100 + getTwoDigits(str, from + 2),
    month: getTwoDigits(str, from + 5),
    day: getTwoDigits(str, from + 8),
  };
}

/**
 * Reads the full-time at index from as {hours, minutes, seconds, offset}.
 * `seconds` carries the fraction, `offset` is minutes east of UTC. The
 * region must already have passed isTimeOnlyRegion.
 * @param {string} str - The string containing the time
 * @param {number} from - Index of the first digit
 * @returns {{ hours: number, minutes: number, seconds: number, offset: number }}
 */
function readTimeParts(str, from) {
  const hours = getTwoDigits(str, from);
  const minutes = getTwoDigits(str, from + 3);
  let seconds = getTwoDigits(str, from + 6);
  let i = from + 8;
  if (str.charCodeAt(i) === 46) { // '.' fraction
    const start = ++i;
    while (i < str.length) {
      const c = str.charCodeAt(i);
      if (c < 48 || c > 57) break;
      i++;
    }
    seconds += Number(str.slice(start - 1, i)); // '.ddd' as a fraction
  }
  const c = str.charCodeAt(i);
  let offset = 0;
  if (c === 43 || c === 45) { // '+' | '-'
    const magnitude = getTwoDigits(str, i + 1) * 60 + getTwoDigits(str, i + 4);
    offset = c === 45 ? -magnitude : magnitude;
  }
  return { hours, minutes, seconds, offset };
}

/**
 * Decompose an RFC 3339 date, time, or date-time string into its lexical
 * components, without allocating a `Date` and without shifting anything
 * to UTC — the components are the ones the string spells out, which is
 * what a query grouping by year or month asks for.
 *
 * A missing half reads as -1: a full-date has no `hours`, a full-time no
 * `year`. `offset` is minutes east of UTC, `null` only for a bare
 * full-date (which RFC 3339 leaves offset-less).
 *
 * @param {any} str - The value to decompose
 * @returns {{ year: number, month: number, day: number, hours: number,
 *   minutes: number, seconds: number, offset: number | null } | null}
 *   the components, or null when str is not an RFC 3339 value
 * @example
 * parseRFC3339Parts('2026-07-27T14:30:05.5+02:00');
 * // { year: 2026, month: 7, day: 27, hours: 14, minutes: 30,
 * //   seconds: 5.5, offset: 120 }
 */
export function parseRFC3339Parts(str) {
  if (!isStringType(str))
    return null;
  if (isDateTimeRFC3339(str)) {
    let sep = -1;
    for (let i = 0; i < str.length; ++i) {
      if (isDateTimeSeparator(str.charCodeAt(i))) {
        sep = i;
        break;
      }
    }
    return { ...readDateParts(str, 0), ...readTimeParts(str, sep + 1) };
  }
  if (isDateOnlyRFC3339(str)) {
    const zc = str.charCodeAt(str.length - 1);
    const zulu = zc === 122 || zc === 90;
    return {
      ...readDateParts(str, 0),
      hours: -1, minutes: -1, seconds: -1,
      offset: zulu ? 0 : null,
    };
  }
  if (isTimeOnlyRFC3339(str)) {
    return { year: -1, month: -1, day: -1, ...readTimeParts(str, 0) };
  }
  return null;
}

/**
 * Milliseconds since 1970-01-01T00:00:00Z for RFC 3339 components that
 * carry a date. Components without a date (a full-time) return NaN, as
 * do out-of-range instants.
 *
 * A bare full-date has no offset and is read as UTC midnight. Note JS
 * has no leap seconds: a `:60` second rolls into the following minute.
 *
 * @param {{ year: number, month: number, day: number, hours: number,
 *   minutes: number, seconds: number, offset: number | null }} parts -
 *   components from {@link parseRFC3339Parts}
 * @returns {number} milliseconds since the epoch, or NaN
 */
export function epochOfRFC3339Parts(parts) {
  if (parts.year < 0)
    return NaN;
  const seconds = parts.seconds < 0 ? 0 : parts.seconds;
  const whole = Math.floor(seconds);
  const ms = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hours < 0 ? 0 : parts.hours,
    parts.minutes < 0 ? 0 : parts.minutes,
    whole, Math.round((seconds - whole) * 1000));
  if (ms !== ms)
    return NaN;
  // Date.UTC maps years 0-99 into the 1900s; restore the real year
  const utc = new Date(ms);
  if (parts.year >= 0 && parts.year < 100)
    utc.setUTCFullYear(parts.year);
  return utc.getTime() - (parts.offset === null ? 0 : parts.offset) * 60000;
}
//#endregion

//#region Duration Validation (RFC 3339)
// Duration format: P[n]Y[n]M[n]DT[n]H[n]M[n]S or P[n]W
// Examples: P1Y2M3DT4H5M6S, P1W, PT1H, P1Y
// https://tools.ietf.org/html/rfc3339#appendix-A

/**
 * Validates a duration string per RFC 3339.
 * Duration format: P[n]Y[n]M[n]DT[n]H[n]M[n]S or P[n]W
 * 
 * @param {string} str - The duration string to validate
 * @returns {boolean} - True if the string is a valid duration
 * @example
 * isValidDuration('P1Y2M3DT4H5M6S'); // true (1 year, 2 months, 3 days, 4 hours, 5 minutes, 6 seconds)
 * isValidDuration('P1W'); // true (1 week)
 * isValidDuration('PT1H'); // true (1 hour)
 * isValidDuration('P1Y'); // true (1 year)
 * isValidDuration('P'); // false (empty duration)
 * isValidDuration('1Y'); // false (missing P)
 */
export function isValidDuration(str) {
  if (!isStringType(str))
    return false;

  // Must start with P
  if (!str.startsWith('P'))
    return false;

  // Cannot be just "P"
  if (str.length < 2)
    return false;

  // Parse and validate components
  // Remove the 'P' prefix
  const rest = str.slice(1);

  // Check for week format: P[n]W (cannot be combined with other components)
  if (rest.endsWith('W')) {
    const weekPart = rest.slice(0, -1);
    return weekPart.length > 0 && /^\d+$/.test(weekPart);
  }

  // Split into date and time parts
  const tIndex = rest.indexOf('T');
  const datePart = tIndex >= 0 ? rest.slice(0, tIndex) : rest;
  const timePart = tIndex >= 0 ? rest.slice(tIndex + 1) : '';

  // Must have at least one component
  if (!datePart && !timePart)
    return false;

  // If there's a T, there must be at least one time component
  if (tIndex >= 0 && !timePart)
    return false;

  // Validate date part components (Y, M, D)
  if (datePart) {
    // Must match pattern: optional number+Y, optional number+M, optional number+D
    // in that order, at least one must be present
    const dateRegex = /^(\d+Y)?(\d+M)?(\d+D)?$/;
    if (!dateRegex.test(datePart))
      return false;
    // Must have at least one component
    if (!/\d+[YMD]/.test(datePart))
      return false;
  }

  // Validate time part components (H, M, S)
  if (timePart) {
    const timeRegex = /^(\d+H)?(\d+M)?(\d+(?:\.\d+)?S)?$/;
    if (!timeRegex.test(timePart))
      return false;
    // Must have at least one component
    if (!/\d+[HMS]/.test(timePart))
      return false;
  }

  return true;
}
//#endregion

//#region ISO Date-Time and ISO Time (with optional timezone)
// ISO 8601 date-time with optional timezone (like 2024-01-15T12:30:00)
// ISO 8601 time with optional timezone (like 12:30:00)

// Regex for iso-date-time: allows with or without timezone
const CONST_ISO_REGEX_DATETIME = /^(\d{4})-([0-1]\d)-([0-3]\d)[T\s](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/i;

// Regex for iso-time: allows with or without timezone  
const CONST_ISO_REGEX_TIME = /^(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/i;

/**
 * Validates an ISO 8601 date-time string with optional timezone.
 * Unlike RFC 3339, the timezone is optional.
 * 
 * @param {string} str - The date-time string to validate
 * @returns {boolean} - True if the string is a valid ISO date-time
 * @example
 * isValidISODateTime('2024-01-15T12:30:00Z'); // true
 * isValidISODateTime('2024-01-15T12:30:00+01:00'); // true
 * isValidISODateTime('2024-01-15T12:30:00'); // true (no timezone)
 * isValidISODateTime('2024-01-15 12:30:00'); // true (space separator)
 * isValidISODateTime('2024-13-15T12:30:00'); // false (invalid month)
 */
export function isValidISODateTime(str) {
  if (!isStringType(str))
    return false;

  const r = str.match(CONST_ISO_REGEX_DATETIME);
  if (r == null)
    return false;

  const y = parseInt(r[1], 10) | 0;
  const m = parseInt(r[2], 10) | 0;
  const d = parseInt(r[3], 10) | 0;
  const h = parseInt(r[4], 10) | 0;
  const min = parseInt(r[5], 10) | 0;
  const s = parseInt(r[6], 10) | 0;

  // Validate date portion
  if (!isDateOnlyInRange(y, m, d))
    return false;

  // Validate time portion (no leap seconds for ISO date-time without explicit timezone)
  if (h < 0 || h > 23 || min < 0 || min > 59 || s < 0 || s > 59)
    return false;

  // Validate timezone if present
  if (r[9] != null) {
    const tzh = parseInt(r[10], 10) | 0;
    const tzm = parseInt(r[11], 10) | 0;
    if (tzh < 0 || tzh > 23 || tzm < 0 || tzm > 59)
      return false;
  }

  return true;
}

/**
 * Validates an ISO 8601 time string with optional timezone.
 * Unlike RFC 3339, the timezone is optional.
 * 
 * @param {string} str - The time string to validate
 * @returns {boolean} - True if the string is a valid ISO time
 * @example
 * isValidISOTime('12:30:00Z'); // true
 * isValidISOTime('12:30:00+01:00'); // true
 * isValidISOTime('12:30:00'); // true (no timezone)
 * isValidISOTime('25:00:00'); // false (invalid hour)
 */
export function isValidISOTime(str) {
  if (!isStringType(str))
    return false;

  const r = str.match(CONST_ISO_REGEX_TIME);
  if (r == null)
    return false;

  const h = parseInt(r[1], 10) | 0;
  const m = parseInt(r[2], 10) | 0;
  const s = parseInt(r[3], 10) | 0;

  // Validate time portion (no leap seconds for ISO time without explicit timezone)
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59)
    return false;

  // Validate timezone if present
  if (r[7] != null) {
    const tzh = parseInt(r[8], 10) | 0;
    const tzm = parseInt(r[9], 10) | 0;
    if (tzh < 0 || tzh > 23 || tzm < 0 || tzm > 59)
      return false;
  }

  return true;
}

/**
 * Parses an ISO 8601 date-time string with optional timezone.
 * Returns a Date object if valid, otherwise undefined.
 * 
 * @param {string} str - The date-time string to parse
 * @param {any} [def=undefined] - Default value to return if invalid
 * @returns {Date|undefined} - The parsed Date or default value
 */
export function getDateTypeOfISODateTime(str, def = undefined) {
  if (!isValidISODateTime(str))
    return def;

  // If no timezone specified, treat as local time by appending Z
  // (ISO 8601 without timezone is local time, but for consistency we treat as UTC)
  if (!/[Z+-]\d{2}:\d{2}$/i.test(str) && !str.endsWith('Z')) {
    // Try parsing as-is (Date.parse handles both formats)
    const date = new Date(Date.parse(str.replace(' ', 'T')));
    return isNaN(date.getTime()) ? def : date;
  }

  return new Date(Date.parse(str));
}

/**
 * Parses an ISO 8601 time string with optional timezone.
 * Returns a Date object (with 1970-01-01 as date) if valid, otherwise undefined.
 * 
 * @param {string} str - The time string to parse
 * @param {any} [def=undefined] - Default value to return if invalid
 * @returns {Date|undefined} - The parsed Date or default value
 */
export function getDateTypeOfISOTime(str, def = undefined) {
  if (!isValidISOTime(str))
    return def;

  // Prepend a dummy date for parsing
  const dateTimeStr = CONST_TIME_INSERTDATE + str;
  const date = new Date(Date.parse(dateTimeStr));
  return isNaN(date.getTime()) ? def : date;
}
//#endregion
