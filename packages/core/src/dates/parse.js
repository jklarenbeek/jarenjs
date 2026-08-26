//@ts-check

//#region Date parsing
// The inverse of `compileDateFormat`: a pattern is scanned once into a
// chain of *readers*, and calling the result only walks the chain. The
// shape is deliberately the same two-stage compiler the formatter uses,
// for the same reason — a `parse(text, pattern)` helper re-scans its
// pattern on every row, and a Gantt chart with ten thousand tasks reads
// ten thousand dates through one pattern.
//
// No regular expression is built here, per parse or per compile: every
// reader is a closure over integers, and digits are read by char code.
//
// The vocabulary is the formatter's (Unicode LDML, `yyyy-MM-dd`), minus
// the tokens that are *derived* from a date rather than part of one.
// `EEEE` (weekday name), `DDD` (day of year), `ww` (ISO week) and `Q`
// (quarter) all format, and none of them is an independent field, so
// asking this compiler for one is an error rather than a token that
// silently reads nothing.
//
// Consumers whose patterns are NOT LDML (Mermaid's Gantt directives use
// moment's grammar, a d3 axis uses strftime) adapt their tokens to this
// vocabulary; they do not hand their own spelling to this compiler.

import { daysInMonth } from './civil.js';

// `DateNames` is format.js's typedef and stays there: re-declaring it
// here would export the same name from two modules of one barrel, which
// is an ambiguous re-export in the generated declarations — a defect
// only the packed-consumer gate sees.

// char codes
const C_0 = 48;
const C_9 = 57;
const C_QUOTE = 39;
const C_PLUS = 43;
const C_MINUS = 45;
const C_COLON = 58;
const C_Z_UPPER = 90;
const C_Z_LOWER = 122;

/**
 * Read between `min` and `max` ASCII digits at `i`.
 * @param {string} text
 * @param {number} i
 * @param {number} min
 * @param {number} max
 * @returns {[number, number]} `[value, next]`, or `[-1, -1]` on failure
 */
function readDigits(text, i, min, max) {
  let value = 0;
  let n = 0;
  while (n < max) {
    const c = text.charCodeAt(i + n);
    // past the end `charCodeAt` is NaN, and NaN fails BOTH comparisons —
    // so this has to be written as the positive test or the loop reads
    // six characters of nothing and returns NaN
    if (!(c >= C_0 && c <= C_9)) break;
    value = value * 10 + (c - C_0);
    n++;
  }
  if (n < min) return [-1, -1];
  return [value, i + n];
}

/**
 * A field reader: `(text, i, out) => next index`, or -1.
 * @typedef {(text: string, i: number, out: any) => number} Reader
 */

/**
 * Build a reader for a numeric field.
 * @param {string} field - the `out` member to assign
 * @param {number} min - minimum digits
 * @param {number} max - maximum digits
 * @returns {Reader}
 */
function numeric(field, min, max) {
  return (text, i, out) => {
    const [value, next] = readDigits(text, i, min, max);
    if (next < 0) return -1;
    out[field] = value;
    return next;
  };
}

/** The two-digit-year pivot: 00–68 is 2000–2068, 69–99 is 1969–1999. */
const YY_PIVOT = 69;

/** @type {Reader} */
const readYY = (text, i, out) => {
  const [value, next] = readDigits(text, i, 2, 2);
  if (next < 0) return -1;
  out.year = value < YY_PIVOT ? 2000 + value : 1900 + value;
  return next;
};

/** @type {Reader} */
const readSignedYear = (text, i, out) => {
  let j = i;
  let sign = 1;
  if (text.charCodeAt(j) === C_MINUS) { sign = -1; j++; }
  const [value, next] = readDigits(text, j, 1, 6);
  if (next < 0) return -1;
  out.year = sign * value;
  return next;
};

/**
 * A name reader: longest candidate first, so a name that is a prefix of
 * another (`Ju` in a hypothetical catalog) cannot shadow it.
 * @param {string} field
 * @param {string[]} names
 * @param {number} base - the value of `names[0]`
 * @returns {Reader}
 */
function nameOf(field, names, base) {
  // index by descending length once, at compile time
  const order = names.map((name, index) => ({ name, value: index + base }))
    .sort((a, b) => b.name.length - a.name.length);
  const count = order.length;
  return (text, i, out) => {
    for (let k = 0; k < count; k++) {
      const { name, value } = order[k];
      if (name.length !== 0 && text.startsWith(name, i)) {
        out[field] = value;
        return i + name.length;
      }
    }
    return -1;
  };
}

/**
 * @param {boolean} colon - require `+HH:MM` rather than `+HHMM`
 * @param {boolean} zForUtc - accept a bare `Z`
 * @returns {Reader}
 */
function offsetOf(colon, zForUtc) {
  return (text, i, out) => {
    const c = text.charCodeAt(i);
    if (zForUtc && (c === C_Z_UPPER || c === C_Z_LOWER)) {
      out.offset = 0;
      return i + 1;
    }
    if (c !== C_PLUS && c !== C_MINUS) return -1;
    const [hh, afterH] = readDigits(text, i + 1, 2, 2);
    if (afterH < 0) return -1;
    let j = afterH;
    if (colon) {
      if (text.charCodeAt(j) !== C_COLON) return -1;
      j++;
    }
    const [mm, afterM] = readDigits(text, j, 2, 2);
    if (afterM < 0) return -1;
    if (hh > 23 || mm > 59) return -1;
    out.offset = (c === C_MINUS ? -1 : 1) * (hh * 60 + mm);
    return afterM;
  };
}

/** @type {Reader} */
const readMillis = (text, i, out) => {
  const [value, next] = readDigits(text, i, 3, 3);
  if (next < 0) return -1;
  out.millis = value;
  return next;
};

/** @type {Reader} */
const readTenths = (text, i, out) => {
  const [value, next] = readDigits(text, i, 1, 1);
  if (next < 0) return -1;
  out.millis = value * 100;
  return next;
};

/**
 * Which half of a value each token contributes to, and how to read it.
 * `names` is the `DateNames` member a token needs, if any.
 */
const TOKENS = Object.freeze({
  yyyy: { half: 'date', reader: numeric('year', 4, 4) },
  yy: { half: 'date', reader: readYY },
  y: { half: 'date', reader: readSignedYear },
  MMMM: { half: 'date', names: 'months' },
  MMM: { half: 'date', names: 'monthsShort' },
  MM: { half: 'date', reader: numeric('month', 2, 2) },
  M: { half: 'date', reader: numeric('month', 1, 2) },
  dd: { half: 'date', reader: numeric('day', 2, 2) },
  d: { half: 'date', reader: numeric('day', 1, 2) },
  HH: { half: 'time', reader: numeric('hours', 2, 2) },
  H: { half: 'time', reader: numeric('hours', 1, 2) },
  hh: { half: 'time', reader: numeric('hour12', 2, 2) },
  h: { half: 'time', reader: numeric('hour12', 1, 2) },
  mm: { half: 'time', reader: numeric('minutes', 2, 2) },
  m: { half: 'time', reader: numeric('minutes', 1, 2) },
  ss: { half: 'time', reader: numeric('seconds', 2, 2) },
  s: { half: 'time', reader: numeric('seconds', 1, 2) },
  SSS: { half: 'time', reader: readMillis },
  S: { half: 'time', reader: readTenths },
  a: { half: 'time', names: 'meridiem' },
  XXX: { half: 'offset', reader: offsetOf(true, true) },
  XX: { half: 'offset', reader: offsetOf(false, true) },
  X: { half: 'offset', reader: offsetOf(true, false) },
});

/**
 * Tokens `compileDateFormat` writes that no value carries as a field —
 * they are computed FROM a date, so reading one back tells the parser
 * nothing it did not already have. Named individually so the error says
 * which token and why, rather than "unknown token".
 */
const DERIVED = Object.freeze({
  EEEE: 'the weekday name', EEE: 'the abbreviated weekday name',
  E: 'the ISO weekday number', DDD: 'the day of the year',
  D: 'the day of the year', ww: 'the ISO week number',
  w: 'the ISO week number', Q: 'the quarter',
});

const MAX_TOKEN = 4;

/**
 * The value a name token reads into, and the base of its numbering.
 * @param {string} token
 * @returns {[string, number]}
 */
function nameTarget(token) {
  if (token === 'a') return ['meridiem', 0];
  return ['month', 1];
}

/**
 * Compile an LDML date pattern into a strict parser.
 *
 * The returned function takes a string and returns a parts record in
 * exactly the shape `parseRFC3339Parts` produces — so
 * `epochOfRFC3339Parts`, `formatRFC3339Parts`, `addToParts` and every
 * other calendar function accept it unchanged — or `null` when the text
 * does not match. Failure is `null`, never a throw and never a partial
 * record: a malformed *pattern* is the programmer's error and throws at
 * compile time; malformed *text* is data and is reported as no match.
 *
 * Strict means three things:
 *
 * 1. **Full consumption.** Trailing text fails; `yyyy-MM-dd` does not
 *    read `2026-01-02T03:04`.
 * 2. **Impossible civil dates fail.** 31 February and hour 24 are not
 *    silently rolled forward into March and the next day.
 * 3. **Fixed-width tokens are fixed width.** `MM` reads exactly two
 *    digits, `M` one or two, and neither reads three.
 *
 * The lexical family of the result follows the pattern: a pattern with
 * only date tokens yields a full-date (`hours`/`minutes`/`seconds` are
 * the contract's `-1`), one with only time tokens a full-time
 * (`year`/`month`/`day` are `-1`), and one with both a date-time. A
 * pattern with no field token at all is a compile error — it could only
 * ever return the same empty record.
 *
 * Two tokens are not strict inverses of an arbitrary value and are
 * documented rather than refused: `yy` reads 00–68 as 2000–2068 and
 * 69–99 as 1969–1999 (the POSIX pivot moment uses), and `h`/`hh`
 * without an `a` in the same pattern read as the morning, so 12 is
 * midnight. Both round-trip their own spelling exactly.
 *
 * @param {string} pattern - an LDML pattern, e.g. `'yyyy-MM-dd'`
 * @param {import('./format.js').DateNames} [names] - locale names, required only if the
 *   pattern uses `MMM`/`MMMM`/`a`
 * @returns {(text: string) => object | null} the compiled parser
 * @throws {TypeError} on an unterminated quote, a derived token, a name
 *   token with no provider, or a pattern that reads no field
 * @example
 * const read = compileDateParser('dd-MM-yyyy');
 * read('06-01-2014');  // { year: 2014, month: 1, day: 6, hours: -1, … }
 * read('06-01-2014x'); // null — trailing input
 * read('31-02-2014');  // null — February has no 31st
 */
export function compileDateParser(pattern, names = undefined) {
  if (typeof pattern !== 'string')
    throw new TypeError('a date pattern must be a string');

  /** @type {Reader[]} */
  const steps = [];
  let literal = '';
  let hasDate = false;
  let hasTime = false;
  let hasOffset = false;
  let hasMeridiem = false;

  const flushLiteral = () => {
    if (literal !== '') {
      const text = literal;
      const width = text.length;
      steps.push((source, i) => (source.startsWith(text, i) ? i + width : -1));
      literal = '';
    }
  };

  for (let i = 0; i < pattern.length;) {
    const ch = pattern[i];
    if (ch === "'") { // quoted literal, '' is one quote
      if (pattern.charCodeAt(i + 1) === C_QUOTE) {
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
      if (candidate.length !== len) continue;
      if (TOKENS[candidate] !== undefined || DERIVED[candidate] !== undefined) {
        matched = candidate;
        break;
      }
    }
    if (matched === null) {
      literal += ch;
      i += 1;
      continue;
    }
    if (DERIVED[matched] !== undefined) {
      throw new TypeError(`the '${matched}' token writes ${DERIVED[matched]},`
        + ' which is derived from a date rather than part of one, so it cannot be parsed');
    }
    const spec = TOKENS[matched];
    let reader = spec.reader;
    if (spec.names !== undefined) {
      const table = names === undefined ? undefined : names[spec.names];
      if (table === undefined)
        throw new TypeError(`the '${matched}' token needs a '${spec.names}' names provider`
          + ' (@jarenjs/core/dates is locale-free by design)');
      const [field, base] = nameTarget(matched);
      reader = nameOf(field, table, base);
      if (matched === 'a') hasMeridiem = true;
    }
    flushLiteral();
    steps.push(reader);
    if (spec.half === 'date') hasDate = true;
    else if (spec.half === 'time') hasTime = true;
    else hasOffset = true;
    i += matched.length;
  }
  flushLiteral();

  if (!hasDate && !hasTime)
    throw new TypeError(`the date pattern '${pattern}' reads no date or time field`);

  const count = steps.length;
  return (text) => {
    if (typeof text !== 'string') return null;
    /** @type {any} */
    const out = {
      year: 1970, month: 1, day: 1,
      hours: 0, minutes: 0, seconds: 0, millis: 0,
      hour12: -1, meridiem: -1, offset: null,
    };
    let i = 0;
    for (let k = 0; k < count; k++) {
      i = steps[k](text, i, out);
      if (i < 0) return null;
    }
    if (i !== text.length) return null;
    return assemble(out, hasDate, hasTime, hasOffset, hasMeridiem);
  };
}

/**
 * Turn the reader's scratch record into a validated parts record.
 * @param {any} out
 * @param {boolean} hasDate
 * @param {boolean} hasTime
 * @param {boolean} hasOffset
 * @param {boolean} hasMeridiem
 * @returns {object | null}
 */
function assemble(out, hasDate, hasTime, hasOffset, hasMeridiem) {
  if (hasDate) {
    if (out.month < 1 || out.month > 12) return null;
    if (out.day < 1 || out.day > daysInMonth(out.year, out.month)) return null;
  }
  let hours = out.hours;
  if (hasTime) {
    if (out.hour12 >= 0) {
      if (out.hour12 < 1 || out.hour12 > 12) return null;
      hours = out.hour12 % 12;
      if (hasMeridiem && out.meridiem === 1) hours += 12;
    }
    if (hours < 0 || hours > 23) return null;
    if (out.minutes < 0 || out.minutes > 59) return null;
    if (out.seconds < 0 || out.seconds > 59) return null;
  }
  return {
    year: hasDate ? out.year : -1,
    month: hasDate ? out.month : -1,
    day: hasDate ? out.day : -1,
    hours: hasTime ? hours : -1,
    minutes: hasTime ? out.minutes : -1,
    seconds: hasTime ? out.seconds + out.millis / 1000 : -1,
    offset: hasOffset ? out.offset : null,
  };
}

//#endregion
