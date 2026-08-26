//@ts-check
/**
 * @file The three Gantt token grammars, adapted to the core date
 * kernel. Mermaid's Gantt header speaks **three different pattern
 * languages** and none of them is Unicode LDML:
 *
 * - `dateFormat` is dayjs' `customParseFormat` vocabulary (moment's
 *   spelling): `YYYY-MM-DD`, where `YYYY` is the calendar year;
 * - `axisFormat` is d3-time-format's strftime vocabulary: `%Y-%m-%d`;
 * - `tickInterval` and a task's duration are two small regular
 *   grammars of their own (`1week`, `3d`).
 *
 * Each gets its own tokenizer here, and each token is mapped
 * individually onto the LDML token `compileDateFormat`/`compileDateParser`
 * understand. Handing `YYYY` straight to the core compiler would be a
 * silent lie — LDML's `YYYY` is the *week-numbering* year, which is
 * moment's most reported footgun and the reason `@jarenjs/core/dates`
 * refuses that spelling in the first place.
 *
 * Every function here returns `{ value, error }` rather than throwing:
 * the caller owns the source line, and a `JM` error without one is not
 * worth much.
 *
 * The vendored conformance table for all of this — which tokens the
 * shipped Mermaid version documents, which of them this engine
 * implements and why the rest are refused — is
 * `test/mermaid/fixtures/gantt-grammar.json`, pinned against this file
 * by `test/mermaid/gantt.test.js`.
 */

/** Mermaid's own default when a diagram declares no `dateFormat`. */
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';

/** Mermaid's own default when a diagram declares no `axisFormat`. */
export const DEFAULT_AXIS_FORMAT = '%Y-%m-%d';

/** dayjs token → the LDML token that reads and writes the same field. */
const MOMENT_TO_LDML = Object.freeze({
  YYYY: 'yyyy', YY: 'yy', Y: 'y',
  MMMM: 'MMMM', MMM: 'MMM', MM: 'MM', M: 'M',
  DD: 'dd', D: 'd',
  HH: 'HH', H: 'H', hh: 'hh', h: 'h',
  mm: 'mm', m: 'm', ss: 'ss', s: 's',
  SSS: 'SSS', S: 'S',
  A: 'a', a: 'a',
  ZZ: 'XX', Z: 'XXX',
});

/** Documented dayjs tokens this engine will not read, and why. */
const MOMENT_REFUSED = Object.freeze({
  SS: 'the fraction tokens are tenths (S) and milliseconds (SSS); there is no hundredths field',
  Q: 'a quarter is derived from a month, not a field of a date',
  Do: 'the ordinal suffix is locale text and this engine ships no ordinal data',
  DDDD: 'the day of the year is derived from a date, not a field of one',
  DDD: 'the day of the year is derived from a date, not a field of one',
  X: 'an epoch second is a whole value, not a calendar field',
  x: 'an epoch millisecond is a whole value, not a calendar field',
  ww: 'the ISO week number is derived from a date, not a field of one',
  w: 'the ISO week number is derived from a date, not a field of one',
});

/** strftime specifier → the LDML fragment that writes the same field. */
const STRFTIME_TO_LDML = Object.freeze({
  Y: 'yyyy', y: 'yy', m: 'MM', d: 'dd',
  H: 'HH', I: 'hh', M: 'mm', S: 'ss', L: 'SSS', j: 'DDD',
  a: 'EEE', A: 'EEEE', b: 'MMM', B: 'MMMM', p: 'a',
  Z: 'XX',
  x: "MM'/'dd'/'yyyy", X: "HH':'mm':'ss",
  '%': "'%'",
});

/** Documented strftime specifiers this engine will not write, and why. */
const STRFTIME_REFUSED = Object.freeze({
  e: 'a space-padded day is a token the formatter does not have',
  c: 'it expands to %e, which is unsupported',
  U: 'd3 counts weeks from the first Sunday; the core week number is ISO, so the two disagree',
  W: 'd3 counts weeks from the first Monday; the core week number is ISO, so the two disagree',
  w: 'd3 numbers Sunday 0; the core weekday number is ISO, where 1 is Monday',
  f: 'microseconds are below the millisecond this suite measures time in',
  g: 'the week-based year is a second year field, and the core parts record has one',
  G: 'the week-based year is a second year field, and the core parts record has one',
  q: 'a quarter on a time axis is a label, not a tick this engine plans',
  Q: 'an epoch is a whole value, not a calendar field',
  s: 'an epoch is a whole value, not a calendar field',
  u: 'the ISO weekday number is a tick label this engine does not plan',
  V: 'the ISO week number is a tick label this engine does not plan',
});

/** The LDML tokens that need a `names` provider before they compile. */
const NEEDS_NAMES = new Set(['MMM', 'MMMM', 'EEE', 'EEEE', 'a']);

const MAX_MOMENT_TOKEN = 4;

/**
 * @typedef {{ value: any, error: string | null }} Adapted
 */

/** @param {string} message @returns {Adapted} */
function bad(message) {
  return { value: null, error: message };
}

/** @param {any} value @returns {Adapted} */
function ok(value) {
  return { value, error: null };
}

/**
 * Quote a run of literal text so `compileDateFormat` cannot read a
 * letter inside it as a token.
 * @param {string} text
 * @returns {string}
 */
function quoted(text) {
  return text === '' ? '' : `'${text.replace(/'/g, "''")}'`;
}

/**
 * Adapt a Mermaid `dateFormat` to an LDML pattern.
 * @param {string} pattern - a dayjs `customParseFormat` pattern
 * @returns {Adapted} `value` is the LDML pattern
 */
export function momentToLdml(pattern) {
  let out = '';
  let literal = '';
  for (let i = 0; i < pattern.length;) {
    const ch = pattern[i];
    if (ch === '[') { // dayjs' bracket escape
      const end = pattern.indexOf(']', i + 1);
      if (end < 0)
        return bad(`unterminated '[' escape in dateFormat '${pattern}'`);
      literal += pattern.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    let matched = null;
    for (let len = MAX_MOMENT_TOKEN; len >= 1; len--) {
      const candidate = pattern.slice(i, i + len);
      if (candidate.length !== len) continue;
      if (MOMENT_TO_LDML[candidate] !== undefined || MOMENT_REFUSED[candidate] !== undefined) {
        matched = candidate;
        break;
      }
    }
    if (matched === null) {
      literal += ch;
      i += 1;
      continue;
    }
    if (MOMENT_REFUSED[matched] !== undefined) {
      return bad(`dateFormat token '${matched}' is not supported: ${MOMENT_REFUSED[matched]}`);
    }
    out += quoted(literal);
    literal = '';
    out += MOMENT_TO_LDML[matched];
    i += matched.length;
  }
  out += quoted(literal);
  return ok(out);
}

/**
 * Adapt a Mermaid `axisFormat` to an LDML pattern. This is a separate
 * grammar from `dateFormat` on purpose: `%m` is a month and `m` is a
 * minute, so one table serving both would silently mis-read half of
 * every axis.
 * @param {string} pattern - a d3-time-format (strftime) pattern
 * @returns {Adapted} `value` is the LDML pattern
 */
export function strftimeToLdml(pattern) {
  let out = '';
  let literal = '';
  for (let i = 0; i < pattern.length;) {
    if (pattern[i] !== '%') {
      literal += pattern[i];
      i += 1;
      continue;
    }
    const spec = pattern[i + 1];
    if (spec === undefined)
      return bad(`axisFormat '${pattern}' ends in a bare '%'`);
    if (STRFTIME_REFUSED[spec] !== undefined)
      return bad(`axisFormat specifier '%${spec}' is not supported: ${STRFTIME_REFUSED[spec]}`);
    const ldml = STRFTIME_TO_LDML[spec];
    if (ldml === undefined)
      return bad(`axisFormat specifier '%${spec}' is not a d3-time-format directive`);
    out += quoted(literal);
    literal = '';
    out += ldml;
    i += 2;
  }
  out += quoted(literal);
  return ok(out);
}

/**
 * Whether an LDML pattern uses a token that needs locale names, and
 * which token that is. Used to turn `compileDateFormat`'s TypeError into
 * a `JM` error that names the Mermaid spelling and the way out.
 * @param {string} ldml
 * @returns {string | null}
 */
export function ldmlNeedsNames(ldml) {
  let inQuote = false;
  for (let i = 0; i < ldml.length;) {
    if (ldml[i] === "'") {
      if (ldml[i + 1] === "'") { i += 2; continue; }
      inQuote = !inQuote;
      i += 1;
      continue;
    }
    if (inQuote) { i += 1; continue; }
    for (let len = 4; len >= 1; len--) {
      const candidate = ldml.slice(i, i + len);
      if (candidate.length === len && NEEDS_NAMES.has(candidate))
        return candidate;
    }
    i += 1;
  }
  return null;
}

// `tickInterval` is one regular grammar in the shipped renderer, and
// this is that regular expression. It is a module constant: a Gantt
// header is read once per parse, but building a pattern per parse is
// the habit this codebase does not have.
const TICK_INTERVAL = /^([1-9]\d*)(millisecond|second|minute|hour|day|week|month)$/;

/**
 * Parse a `tickInterval` directive.
 * @param {string} text
 * @returns {Adapted} `value` is `{ amount, unit }`, the unit a core
 *   `DATE_UNITS` member
 */
export function parseTickInterval(text) {
  const match = TICK_INTERVAL.exec(text.trim());
  if (match === null) {
    return bad(`tickInterval '${text}' is not a whole count followed by`
      + ' millisecond, second, minute, hour, day, week or month');
  }
  return ok({ amount: Number(match[1]), unit: match[2] });
}

// The task duration grammar, likewise straight from the shipped chunk.
const DURATION = /^(\d+(?:\.\d+)?)([Mdhmswy]|ms)$/;

/** Mermaid's one-letter duration units → core calendar units. */
const DURATION_UNITS = Object.freeze({
  ms: 'millisecond', s: 'second', m: 'minute', h: 'hour',
  d: 'day', w: 'week', M: 'month', y: 'year',
});

/**
 * Parse a task duration (`3d`, `1.5w`, `2M`).
 * @param {string} text
 * @returns {Adapted} `value` is `{ amount, unit }`, or `null` with no
 *   error when the text is simply not a duration (the caller then tries
 *   to read it as a date)
 */
export function parseTaskDuration(text) {
  const match = DURATION.exec(text.trim());
  if (match === null)
    return { value: null, error: null };
  return ok({ amount: Number(match[1]), unit: DURATION_UNITS[match[2]] });
}

/** ISO weekday numbers, 1 is Monday — the numbering `isoWeekdayFromDays` uses. */
export const ISO_WEEKDAYS = Object.freeze({
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6, sunday: 7,
});

/**
 * Parse a `weekday` directive: which day a whole-week tick starts on.
 * @param {string} text
 * @returns {Adapted} `value` is an ISO weekday, 1 to 7
 */
export function parseWeekday(text) {
  const day = ISO_WEEKDAYS[text.trim().toLowerCase()];
  if (day === undefined)
    return bad(`weekday '${text}' is not a day name (monday … sunday)`);
  return ok(day);
}

/**
 * Parse a `weekend` directive: the first of the two days
 * `excludes weekends` removes.
 * @param {string} text
 * @returns {Adapted} `value` is an ISO weekday, 5 (friday) or 6 (saturday)
 */
export function parseWeekend(text) {
  const name = text.trim().toLowerCase();
  if (name !== 'friday' && name !== 'saturday')
    return bad(`weekend '${text}' is neither friday nor saturday`);
  return ok(ISO_WEEKDAYS[name]);
}

export { MOMENT_TO_LDML, MOMENT_REFUSED, STRFTIME_TO_LDML, STRFTIME_REFUSED };
