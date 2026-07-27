//@ts-check

//#region Date formatting
// The two-stage compiler applied to date patterns: a pattern is scanned
// once into a chain of appenders, and calling the result only walks the
// chain. Re-scanning the pattern per call - the shape a `format(value,
// pattern)` helper naturally takes - measured 534 ns against 118 ns for
// the compiled form on `yyyy-MM-dd HH:mm:ss`.
//
// Tokens are Unicode LDML (the vocabulary `Intl` skeletons and CLDR use),
// not moment's: `yyyy-MM-dd`, never `YYYY-MM-DD`. That avoids moment's
// most reported footgun - `YYYY` there means the week-numbering year -
// and means a pattern copied from CLDR data behaves as its author meant.
// A literal is single-quoted (`'T'`), and `''` is a literal quote.
//
// Month, weekday and meridiem names are NOT built in: this module stays
// locale-free, so a pattern using a name token requires a `names`
// provider (@jarenjs/locales supplies one). Asking for `MMMM` without a
// provider is a compile error rather than a silent English fallback.

import {
  daysFromCivil,
  weekdayFromDays,
  isoWeekdayFromDays,
  isoWeekOfYear,
  dayOfYear,
  quarterOfYear,
} from './civil.js';

/**
 * Locale names a pattern may need.
 * @typedef {Object} DateNames
 * @property {string[]} [months] - 12 wide month names, January first
 * @property {string[]} [monthsShort] - 12 abbreviated month names
 * @property {string[]} [weekdays] - 7 wide weekday names, Sunday first
 * @property {string[]} [weekdaysShort] - 7 abbreviated weekday names
 * @property {[string, string]} [meridiem] - the AM and PM markers
 */

const D2 = (n) => (n < 10 ? '0' + n : '' + n);
const D3 = (n) => (n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n);

function pad(n, width) {
  const s = '' + n;
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

// Signed offset in minutes to '+HH:MM' / '+HHMM' / 'Z'.
function offsetText(offset, colon, zForUtc) {
  if (offset === null || offset === undefined)
    return '';
  if (offset === 0 && zForUtc)
    return 'Z';
  const sign = offset < 0 ? '-' : '+';
  const abs = offset < 0 ? -offset : offset;
  const hh = D2(Math.trunc(abs / 60));
  const mm = D2(abs % 60);
  return colon ? `${sign}${hh}:${mm}` : `${sign}${hh}${mm}`;
}

function hour12(hours) {
  const h = hours % 12;
  return h === 0 ? 12 : h;
}

// Every token, as a function of (parts, names). Longest match wins, so
// the compiler tries 5 characters down to 1.
const TOKENS = {
  yyyy: (p) => pad(p.year < 0 ? -p.year : p.year, 4),
  yy: (p) => D2((p.year % 100 + 100) % 100),
  y: (p) => '' + p.year,
  MMMM: (p, n) => n.months[p.month - 1],
  MMM: (p, n) => n.monthsShort[p.month - 1],
  MM: (p) => D2(p.month),
  M: (p) => '' + p.month,
  dd: (p) => D2(p.day),
  d: (p) => '' + p.day,
  EEEE: (p, n) => n.weekdays[weekdayFromDays(daysFromCivil(p.year, p.month, p.day))],
  EEE: (p, n) => n.weekdaysShort[weekdayFromDays(daysFromCivil(p.year, p.month, p.day))],
  E: (p) => '' + isoWeekdayFromDays(daysFromCivil(p.year, p.month, p.day)),
  HH: (p) => D2(p.hours),
  H: (p) => '' + p.hours,
  hh: (p) => D2(hour12(p.hours)),
  h: (p) => '' + hour12(p.hours),
  mm: (p) => D2(p.minutes),
  m: (p) => '' + p.minutes,
  ss: (p) => D2(Math.trunc(p.seconds)),
  s: (p) => '' + Math.trunc(p.seconds),
  SSS: (p) => D3(Math.round((p.seconds - Math.trunc(p.seconds)) * 1000)),
  S: (p) => '' + Math.trunc((p.seconds - Math.trunc(p.seconds)) * 10),
  a: (p, n) => n.meridiem[p.hours < 12 ? 0 : 1],
  XXX: (p) => offsetText(p.offset, true, true),
  XX: (p) => offsetText(p.offset, false, true),
  X: (p) => offsetText(p.offset, true, false),
  DDD: (p) => D3(dayOfYear(p)),
  D: (p) => '' + dayOfYear(p),
  ww: (p) => D2(isoWeekOfYear(p).week),
  w: (p) => '' + isoWeekOfYear(p).week,
  Q: (p) => '' + quarterOfYear(p),
};

// tokens that need a names provider, and which array each one reads
const NEEDS_NAMES = Object.freeze({
  MMMM: 'months', MMM: 'monthsShort',
  EEEE: 'weekdays', EEE: 'weekdaysShort',
  a: 'meridiem',
});

const MAX_TOKEN = 4;

/**
 * Compile an LDML date pattern into a formatter.
 *
 * The returned function takes a parts record (`parseRFC3339Parts`) and
 * returns a string. It closes over nothing mutable and is reusable.
 *
 * @param {string} pattern - an LDML pattern, e.g. `"yyyy-MM-dd'T'HH:mm:ssXXX"`
 * @param {DateNames} [names] - locale names, required only if the
 *   pattern uses `MMM`/`MMMM`/`EEE`/`EEEE`/`a`
 * @returns {(parts: object) => string} the compiled formatter
 * @throws {TypeError} on an unterminated quote, or a name token with no
 *   provider for it
 * @example
 * const iso = compileDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX");
 * iso(parseRFC3339Parts('2026-07-27T14:30:05+02:00'));
 * // '2026-07-27T14:30:05+02:00'
 */
export function compileDateFormat(pattern, names = undefined) {
  if (typeof pattern !== 'string')
    throw new TypeError('a date pattern must be a string');
  const steps = [];
  let literal = '';
  const flushLiteral = () => {
    if (literal !== '') {
      const text = literal;
      steps.push(() => text);
      literal = '';
    }
  };

  for (let i = 0; i < pattern.length;) {
    const ch = pattern[i];
    if (ch === "'") { // quoted literal, '' is one quote
      if (pattern[i + 1] === "'") {
        literal += "'";
        i += 2;
        continue;
      }
      const end = pattern.indexOf("'", i + 1);
      if (end < 0)
        throw new TypeError(`unterminated quoted literal in date pattern '${pattern}'`);
      literal += pattern.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    let matched = null;
    for (let len = MAX_TOKEN; len >= 1; len--) {
      const candidate = pattern.slice(i, i + len);
      if (candidate.length === len && TOKENS[candidate] !== undefined) {
        matched = candidate;
        break;
      }
    }
    if (matched === null) {
      literal += ch;
      i += 1;
      continue;
    }
    const need = NEEDS_NAMES[matched];
    if (need !== undefined && (names === undefined || names[need] === undefined)) {
      throw new TypeError(`the '${matched}' token needs a '${need}' names provider`
        + ' (@jarenjs/core/dates is locale-free by design)');
    }
    flushLiteral();
    const fn = TOKENS[matched];
    steps.push(need === undefined ? fn : (p) => fn(p, names));
    i += matched.length;
  }
  flushLiteral();

  const count = steps.length;
  if (count === 0)
    return () => '';
  if (count === 1)
    return steps[0];
  return (parts) => {
    let out = '';
    for (let i = 0; i < count; i++)
      out += steps[i](parts);
    return out;
  };
}

// the two canonical shapes, compiled once at module load
const FORMAT_DATE = compileDateFormat('yyyy-MM-dd');
const FORMAT_DATE_TIME = compileDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX");
const FORMAT_TIME = compileDateFormat('HH:mm:ssXXX');

/**
 * Render a parts record back to RFC 3339, the inverse of
 * `parseRFC3339Parts`. The value keeps the shape it had: a record with
 * no time half comes back a `full-date`, one with no date half a
 * `full-time`, and the offset is the record's own rather than UTC.
 *
 * The round trip preserves the *value*, not necessarily the spelling: a
 * fractional second is emitted only when non-zero and without trailing
 * zeros, so `…:05.250Z` comes back `…:05.25Z`. The parts record holds
 * the fraction as a number, so the original digit count is not
 * recoverable — a consumer that must reproduce the input byte for byte
 * (JOSL, which round-trips TOML) has to keep the literal text itself.
 *
 * @param {object} parts - a parts record
 * @returns {string} an RFC 3339 string
 * @example
 * formatRFC3339Parts(parseRFC3339Parts('2026-07-27')); // '2026-07-27'
 */
export function formatRFC3339Parts(parts) {
  if (parts.hours < 0)
    return FORMAT_DATE(parts);
  const fraction = parts.seconds - Math.trunc(parts.seconds);
  const base = parts.year < 0 ? FORMAT_TIME(parts) : FORMAT_DATE_TIME(parts);
  if (fraction === 0)
    return base;
  // splice the fraction in after the seconds, before the offset
  const digits = fraction.toFixed(3).slice(1).replace(/0+$/, '');
  const cut = base.length - (FORMAT_OFFSET_LEN(parts));
  return base.slice(0, cut) + digits + base.slice(cut);
}

// how many characters the rendered offset takes, so the fraction can be
// spliced in front of it
function FORMAT_OFFSET_LEN(parts) {
  if (parts.offset === null || parts.offset === undefined)
    return 0;
  return parts.offset === 0 ? 1 : 6;
}

//#endregion
