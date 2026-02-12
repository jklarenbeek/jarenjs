//@ts-check

import {
  isStringType,
  isObjectOfClass,
} from './index.js';

//#region Dates Constants
export const CONST_TICKS_SECOND = 1000;
export const CONST_TICKS_HOUR = CONST_TICKS_SECOND * 60 * 60;
export const CONST_TICKS_DAY = CONST_TICKS_HOUR * 24;

export const CONST_TIME_INSERTDATE = '1970-01-01T';
export const CONST_DATE_APPENDTIME = 'T00:00:00Z';

export const CONST_RFC3339_DAYS = Object.freeze(
  [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
);

// full-date from http://tools.ietf.org/html/rfc3339#section-5.6
export const CONST_RFC3339_REGEX_ISDATE = /^(\d\d\d\d)-([0-1]\d)-([0-3]\d)z?$/i;

// full-date from http://tools.ietf.org/html/rfc3339#section-5.6
export const CONST_RFC3339_REGEX_ISTIME = /^(\d\d):(\d\d):(\d\d)(\.\d{1,6})?(z|(([+-])(\d\d):(\d\d)))$/i;

//#endregion

//#region Dates Compare
export function isDateType(data) {
  return isObjectOfClass(data, Date);
}

export function isDateishType(data) {
  return isDateType(data)
    || !Number.isNaN(Date.parse(data));
}

export function isLeapYear(year) {
  // https://tools.ietf.org/html/rfc3339#appendix-C
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isDateOnlyInRange(year = 0, month = 0, day = 0) {
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= (month === 2 && isLeapYear(year)
      ? 29
      : CONST_RFC3339_DAYS[month]);
}

export function isDateOnlyRFC3339(str) {
  if (!isStringType(str))
    return false;

  const r = str.match(CONST_RFC3339_REGEX_ISDATE);
  if (r == null)
    return false;

  const y = parseInt(r[1], 10) | 0;
  const m = parseInt(r[2], 10) | 0;
  const d = parseInt(r[3], 10) | 0;
  return isDateOnlyInRange(y, m, d);
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

export function isTimeOnlyRFC3339(str) {
  if (!isStringType(str))
    return false;

  const r = str.match(CONST_RFC3339_REGEX_ISTIME);
  if (r == null)
    return false;

  const h = parseInt(r[1], 10) | 0;
  const m = parseInt(r[2], 10) | 0;
  const s = parseInt(r[3], 10) | 0;
  const th = parseInt(r[8], 10) | 0;
  const tm = parseInt(r[9], 10) | 0;
  // r[7] is the timezone sign (+ or -)
  // + means local time is ahead of UTC, so we subtract to get UTC
  // - means local time is behind UTC, so we add to get UTC
  const tzSign = r[7] === '-' ? -1 : 1;
  return isTimeOnlyInRange(h, m, s, th, tm, tzSign);
}

export function isDateTimeRFC3339(str) {
  // http://tools.ietf.org/html/rfc3339#section-5.6
  if (!isStringType(str)) return false;
  const dateTime = str.split(/t|\s/i);
  return dateTime.length === 2
    && isDateOnlyRFC3339(dateTime[0])
    && isTimeOnlyRFC3339(dateTime[1]);
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
