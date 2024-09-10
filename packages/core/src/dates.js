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

export function isTimeOnlyInRange(hrs = 0, min = 0, sec = 0, tzh = 0, tzm = 0) {
  return ((hrs === 23 && min === 59 && sec === 60)
    || (hrs >= 0 && hrs <= 23
      && min >= 0 && min <= 59
      && sec >= 0 && sec <= 59))
    && (tzh >= 0 && tzh <= 23
      && tzm >= 0 && tzm <= 59);
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
  return isTimeOnlyInRange(h, m, s, th, tm);
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
