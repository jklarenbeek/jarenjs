//@ts-check

//#region Temporal values
// Five kinds of calendar time, as plain frozen JSON, so a value survives
// storage and transport without losing what it was:
//
//   date        a civil day, no time and no zone ('2026-03-29')
//   floating    a wall clock with no zone yet (a shop opens at 09:00
//               wherever it is)
//   utc         one instant, spelled with Z
//   zoned       a wall clock in a named zone (09:00 in Europe/Amsterdam)
//   date-range  civil days, start inclusive and end exclusive
//
// No kind is ever collapsed into another to make an operation easier: a
// floating time stays floating until a caller binds it to a zone. Every
// refusal names one fault with its own code, and nothing is rounded,
// truncated or rolled over - a leap second, a sub-millisecond fraction or
// 24:00 at a start is a refusal the caller sees, not a quiet repair.

import { civilFromDays, daysFromCivil, daysInMonth } from '../dates/civil.js';
import { CalendarError } from './errors.js';
import { assertZone } from './zones.js';
import { admitZoneName, providerOf } from './resolve.js';

const DAY = 86400000;
/** The first and last civil day a value may name: 0000-01-01 and 9999-12-31. */
export const FIRST_DAY = daysFromCivil(0, 1, 1);
export const LAST_DAY = daysFromCivil(9999, 12, 31);

const DATE_FORM = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_FORM = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|z|[+-]\d{2}:\d{2})?$/;
const INSTANT_FORM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

/** @typedef {{ readonly kind: 'date', readonly date: string }} DateValue */
/** @typedef {{ readonly kind: 'floating', readonly date: string, readonly time: string }} FloatingValue */
/** @typedef {{ readonly kind: 'utc', readonly instant: string }} UtcValue */
/** @typedef {{ readonly kind: 'zoned', readonly date: string, readonly time: string, readonly zone: string }} ZonedValue */
/**
 * Civil days from `start` up to but not including `end`.
 * @typedef {{ readonly kind: 'date-range', readonly start: string, readonly end: string }} DateRangeValue
 */
/** @typedef {DateValue | FloatingValue | UtcValue | ZonedValue | DateRangeValue} TemporalValue */

/**
 * Where a value stands: a `start` (and any value standing alone) or an
 * `end` bound, the one place `24:00` - the end of a day - is admitted.
 * @typedef {{ bound?: 'start' | 'end' }} BoundOption
 */

/**
 * A wall-clock time read from its text: `hours` is 24 only for the end
 * of a day.
 * @typedef {{ hours: number, minutes: number, seconds: number, endOfDay: boolean }} WallTime
 */

/**
 * What {@link admitValue} learned reading a value: the frozen value
 * itself and the numbers the operations need.
 * @typedef {Object} AdmittedValue
 * @property {TemporalValue} value
 * @property {number} [days] - the civil day number of `date` / `start`
 * @property {number} [endDays] - a date range's exclusive end day
 * @property {WallTime} [time]
 * @property {number} [epoch] - a utc value's instant, epoch milliseconds
 */

/** @param {number} n @param {number} [width] @returns {string} */
const pad = (n, width = 2) => String(n).padStart(width, '0');

/** @param {unknown} value @returns {string} */
const shown = (value) => (typeof value === 'string' ? `'${value}'` : String(value));

/**
 * A civil day number as `YYYY-MM-DD`, refusing a day outside 0000-9999.
 * @param {number} days - days since 1970-01-01
 * @param {string} path - the argument a refusal names
 * @returns {string}
 */
export function formatDate(days, path) {
  if (!(days >= FIRST_DAY && days <= LAST_DAY))
    throw new CalendarError('JY0012', 'the date falls outside 0000-01-01 to 9999-12-31', path);
  const { year, month, day } = civilFromDays(days);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/**
 * Read a civil date, refusing a form that is not `YYYY-MM-DD` and a day
 * the calendar does not have.
 * @param {unknown} text
 * @param {string} path
 * @returns {number} the civil day number
 */
function readDate(text, path) {
  const form = typeof text === 'string' ? DATE_FORM.exec(text) : null;
  if (form === null)
    throw new CalendarError('JY0013', `a date is spelled YYYY-MM-DD, not ${shown(text)}`, path);
  return civilDay(Number(form[1]), Number(form[2]), Number(form[3]), /** @type {string} */ (text), path);
}

/**
 * The day number of a year, month and day the calendar has.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {string} text - what the caller wrote, for the message
 * @param {string} path
 * @returns {number}
 */
function civilDay(year, month, day, text, path) {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
    throw new CalendarError('JY0012', `${text} names no day the calendar has`, path);
  return daysFromCivil(year, month, day);
}

/**
 * Read a wall-clock time `HH:MM[:SS[.fff]]`. The faults are checked in
 * one order, each with its own code: an offset or Z, a fraction past the
 * millisecond, a leap second, then the clock's range, and last `24:00`
 * where the value is not an end bound.
 * @param {unknown} text
 * @param {'start' | 'end'} bound
 * @param {string} path
 * @returns {WallTime}
 */
function readTime(text, bound, path) {
  const form = typeof text === 'string' ? TIME_FORM.exec(text) : null;
  if (form === null)
    throw new CalendarError('JY0013', `a time is spelled HH:MM[:SS[.fff]], not ${shown(text)}`, path);
  if (form[5] !== undefined) {
    throw new CalendarError('JY0011',
      `${shown(text)} carries the offset ${form[5]}; a floating time has none and a zoned time takes its zone's`, path);
  }
  const fraction = form[4] ?? '';
  if (fraction.length > 3)
    throw new CalendarError('JY0010', `${shown(text)} carries a fraction past the millisecond; it is refused, not truncated`, path);
  if (form[3] === '60')
    throw new CalendarError('JY0009', `${shown(text)} names a leap second, which this layer does not admit`, path);
  const hours = Number(form[1]);
  const minutes = Number(form[2]);
  const seconds = form[3] === undefined ? 0 : Number(form[3]);
  const millis = fraction === '' ? 0 : Number(fraction.padEnd(3, '0'));
  if (hours === 24 && minutes === 0 && seconds === 0 && millis === 0) {
    if (bound !== 'end') {
      throw new CalendarError('JY0008',
        `${shown(text)} names the end of a day; it is admitted only on an end bound ({ bound: 'end' })`, path);
    }
    return { hours, minutes, seconds, endOfDay: true };
  }
  if (hours > 23 || minutes > 59 || seconds > 59)
    throw new CalendarError('JY0013', `${shown(text)} is not a time of day from 00:00 to 23:59:59.999`, path);
  return { hours, minutes, seconds: seconds + millis / 1000, endOfDay: false };
}

/**
 * Read a utc instant `YYYY-MM-DDTHH:MM:SS[.fff]Z` to epoch milliseconds.
 * @param {unknown} text
 * @param {string} path
 * @returns {number}
 */
function readInstant(text, path) {
  const form = typeof text === 'string' ? INSTANT_FORM.exec(text) : null;
  if (form === null)
    throw new CalendarError('JY0013', `a utc instant is spelled YYYY-MM-DDTHH:MM:SS[.fff]Z, with Z, not ${shown(text)}`, path);
  const fraction = form[7] ?? '';
  if (fraction.length > 3)
    throw new CalendarError('JY0010', `${shown(text)} carries a fraction past the millisecond; it is refused, not truncated`, path);
  if (form[6] === '60')
    throw new CalendarError('JY0009', `${shown(text)} names a leap second, which this layer does not admit`, path);
  const days = civilDay(Number(form[1]), Number(form[2]), Number(form[3]), /** @type {string} */ (text), path);
  const hours = Number(form[4]);
  const minutes = Number(form[5]);
  const seconds = Number(form[6]);
  const millis = fraction === '' ? 0 : Number(fraction.padEnd(3, '0'));
  if (hours === 24 && minutes === 0 && seconds === 0 && millis === 0)
    throw new CalendarError('JY0008', `${shown(text)} names the end of a day; a utc instant is spelled as the next day's 00:00`, path);
  if (hours > 23 || minutes > 59 || seconds > 59)
    throw new CalendarError('JY0013', `${shown(text)} is not a time of day from 00:00 to 23:59:59.999`, path);
  return days * DAY + ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/**
 * An epoch millisecond count as the utc spelling `YYYY-MM-DDTHH:MM:SS.sssZ`.
 * @param {number} epoch
 * @param {string} path
 * @returns {string}
 */
function formatInstant(epoch, path) {
  const days = Math.floor(epoch / DAY);
  let rest = epoch - days * DAY;
  const hours = Math.floor(rest / 3600000);
  rest -= hours * 3600000;
  const minutes = Math.floor(rest / 60000);
  rest -= minutes * 60000;
  const seconds = Math.floor(rest / 1000);
  return `${formatDate(days, path)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(rest - seconds * 1000, 3)}Z`;
}

/**
 * Read the `bound` option.
 * @param {unknown} options
 * @returns {'start' | 'end'}
 */
export function admitBound(options) {
  const bound = /** @type {any} */ (options)?.bound;
  if (bound === undefined || bound === 'start' || bound === 'end')
    return bound ?? 'start';
  throw new CalendarError('JY0014', `bound is 'start' or 'end', not ${shown(bound)}`, '/options/bound');
}

/** The members each kind carries, in their order. */
const MEMBERS = Object.freeze({
  'date': ['kind', 'date'],
  'floating': ['kind', 'date', 'time'],
  'utc': ['kind', 'instant'],
  'zoned': ['kind', 'date', 'time', 'zone'],
  'date-range': ['kind', 'start', 'end'],
});

/**
 * Read any temporal value - one a constructor built or one that came
 * back from storage - and return it frozen with what the operations
 * need. A value standing alone is read as a start unless `bound` is
 * `'end'`.
 * @param {unknown} json
 * @param {'start' | 'end'} bound
 * @param {string} base - the path of the value in the call (`''` or `/value`)
 * @param {unknown} [provider] - when given, a zoned value's zone must be one it knows
 * @returns {AdmittedValue}
 */
export function admitValue(json, bound, base, provider = undefined) {
  if (json === null || typeof json !== 'object' || Array.isArray(json))
    throw new CalendarError('JY0013', 'a temporal value is an object { kind, ... }', base || '/');
  const value = /** @type {Record<string, unknown>} */ (json);
  const kind = value.kind;
  const members = typeof kind === 'string' && Object.hasOwn(MEMBERS, kind) ? MEMBERS[/** @type {keyof MEMBERS} */ (kind)] : null;
  if (members === null)
    throw new CalendarError('JY0013', `kind is one of ${Object.keys(MEMBERS).join(', ')}, not ${shown(kind)}`, `${base}/kind`);
  for (const key of Object.keys(value)) {
    if (!members.includes(key))
      throw new CalendarError('JY0013', `a ${kind} value carries ${members.slice(1).join(', ')}, not '${key}'`, `${base}/${key}`);
  }
  for (const key of members) {
    if (!Object.hasOwn(value, key))
      throw new CalendarError('JY0013', `a ${kind} value carries ${key}`, `${base}/${key}`);
  }
  switch (kind) {
    case 'date': {
      const days = readDate(value.date, `${base}/date`);
      return { value: Object.freeze({ kind, date: /** @type {string} */ (value.date) }), days };
    }
    case 'floating': {
      const days = readDate(value.date, `${base}/date`);
      const time = readTime(value.time, bound, `${base}/time`);
      return { value: Object.freeze({ kind, date: /** @type {string} */ (value.date), time: /** @type {string} */ (value.time) }), days, time };
    }
    case 'zoned': {
      const days = readDate(value.date, `${base}/date`);
      const time = readTime(value.time, bound, `${base}/time`);
      const zone = admitZoneName(value.zone);
      if (provider !== undefined)
        assertZone(zone, /** @type {any} */ (provider));
      return {
        value: Object.freeze({ kind, date: /** @type {string} */ (value.date), time: /** @type {string} */ (value.time), zone }),
        days, time,
      };
    }
    case 'utc': {
      const epoch = readInstant(value.instant, `${base}/instant`);
      return { value: Object.freeze({ kind, instant: /** @type {string} */ (value.instant) }), epoch };
    }
    default: {
      const days = readDate(value.start, `${base}/start`);
      const endDays = readDate(value.end, `${base}/end`);
      if (!(endDays > days))
        throw new CalendarError('JY0013', `a date range ends after it starts; ${shown(value.end)} is not after ${shown(value.start)}`, `${base}/end`);
      return {
        value: Object.freeze({ kind: 'date-range', start: /** @type {string} */ (value.start), end: /** @type {string} */ (value.end) }),
        days, endDays,
      };
    }
  }
}

/**
 * A civil day with no time and no zone.
 * @param {string} date - `YYYY-MM-DD`
 * @returns {DateValue}
 * @throws {CalendarError} `JY0013` for another spelling, `JY0012` for a
 *   day the calendar does not have (`'2026-02-30'`)
 * @example
 * dateValue('2026-03-29'); // { kind: 'date', date: '2026-03-29' }
 */
export function dateValue(date) {
  return /** @type {DateValue} */ (admitValue({ kind: 'date', date }, 'start', '').value);
}

/**
 * A wall clock with no zone: what a caller means by "09:00" before it
 * knows where. It stays zone-less until {@link bindFloating} is given a
 * zone.
 * @param {string} date - `YYYY-MM-DD`
 * @param {string} time - `HH:MM[:SS[.fff]]`; `24:00` only with `{ bound: 'end' }`
 * @param {BoundOption} [options]
 * @returns {FloatingValue}
 * @throws {CalendarError} `JY0011` for an offset or Z, `JY0010` for a
 *   fraction past the millisecond, `JY0009` for a leap second, `JY0008`
 *   for `24:00` at a start, `JY0012` / `JY0013` for the date or form
 * @example
 * floatingValue('2026-03-29', '09:00');                  // a shop opens
 * floatingValue('2026-03-29', '24:00', { bound: 'end' }); // and closes at the day's end
 */
export function floatingValue(date, time, options = undefined) {
  return /** @type {FloatingValue} */ (admitValue({ kind: 'floating', date, time }, admitBound(options), '').value);
}

/**
 * One instant. A string is kept as written once it reads as
 * `YYYY-MM-DDTHH:MM:SS[.fff]Z`; a number of epoch milliseconds is spelled
 * that way with three fraction digits.
 * @param {string | number} instant
 * @returns {UtcValue}
 * @throws {CalendarError} `JY0013` for another spelling (an offset other
 *   than Z), `JY0010` for a fraction past the millisecond (a string's
 *   fourth digit, or a number that is not whole), `JY0009` for a leap
 *   second, `JY0008` for `T24:00`, `JY0012` for a day outside 0000-9999
 * @example
 * utcValue('2026-03-29T01:30:00Z'); // { kind: 'utc', instant: '2026-03-29T01:30:00Z' }
 * utcValue(0);                      // { kind: 'utc', instant: '1970-01-01T00:00:00.000Z' }
 */
export function utcValue(instant) {
  if (typeof instant === 'number') {
    if (!Number.isFinite(instant))
      throw new CalendarError('JY0013', `a utc instant is a finite number of epoch milliseconds, not ${instant}`, '/instant');
    if (!Number.isInteger(instant))
      throw new CalendarError('JY0010', `${instant} carries a fraction past the millisecond; it is refused, not truncated`, '/instant');
    return Object.freeze({ kind: 'utc', instant: formatInstant(instant, '/instant') });
  }
  return /** @type {UtcValue} */ (admitValue({ kind: 'utc', instant }, 'start', '').value);
}

/**
 * A wall clock in a named zone. The zone is checked against `provider`
 * when one is passed; otherwise it must be a non-empty name, and whether
 * a provider knows it is learned when the value is resolved.
 * @param {string} date - `YYYY-MM-DD`
 * @param {string} time - `HH:MM[:SS[.fff]]`; `24:00` only with `{ bound: 'end' }`
 * @param {string} zone - a zone name, never an offset spelled into `time`
 * @param {BoundOption & import('./resolve.js').ZoneProviderOptions} [options]
 * @returns {ZonedValue}
 * @throws {CalendarError} `JY0001` for an empty zone or one the provider
 *   does not know, and what {@link floatingValue} throws
 * @example
 * zonedValue('2026-10-25', '02:30', 'Europe/Amsterdam'); // an appointment in the repeated hour
 */
export function zonedValue(date, time, zone, options = undefined) {
  return /** @type {ZonedValue} */ (admitValue({ kind: 'zoned', date, time, zone }, admitBound(options), '', providerOf(options)).value);
}

/**
 * Civil days written the way people write them, first and last day
 * inclusive, stored half-open: `end` is the day after `endInclusive`, so
 * no caller writes the +1.
 * @param {string} start - the first day, `YYYY-MM-DD`
 * @param {string} endInclusive - the last day, `YYYY-MM-DD`, not before `start`
 * @returns {DateRangeValue}
 * @throws {CalendarError} `JY0013` for a last day before the first,
 *   `JY0012` for a day the calendar does not have
 * @example
 * dateRangeValue('2026-07-01', '2026-07-14'); // { kind: 'date-range', start: '2026-07-01', end: '2026-07-15' }
 */
export function dateRangeValue(start, endInclusive) {
  const first = readDate(start, '/start');
  const last = readDate(endInclusive, '/endInclusive');
  if (last < first)
    throw new CalendarError('JY0013', `the last day ${shown(endInclusive)} is before the first ${shown(start)}`, '/endInclusive');
  return Object.freeze({ kind: 'date-range', start, end: formatDate(last + 1, '/endInclusive') });
}

/**
 * A temporal value from its JSON form - an object, or its JSON text -
 * checked exactly as the constructor of its kind checks it, with no
 * member beyond the kind's own. The answer is a new frozen value.
 * @param {unknown} json
 * @param {BoundOption & import('./resolve.js').ZoneProviderOptions} [options]
 * @returns {TemporalValue}
 * @throws {CalendarError} `JY0013` for text that is not JSON, an unknown
 *   kind, a missing or extra member, a date range that does not end after
 *   it starts, and what the constructors throw
 * @example
 * parseTemporal('{"kind":"floating","date":"2026-03-29","time":"09:00"}');
 */
export function parseTemporal(json, options = undefined) {
  const bound = admitBound(options);
  let input = json;
  if (typeof json === 'string') {
    try {
      input = JSON.parse(json);
    }
    catch (error) {
      throw new CalendarError('JY0013', 'the text is not JSON', '/', error);
    }
  }
  return admitValue(input, bound, '', providerOf(options)).value;
}
//#endregion
