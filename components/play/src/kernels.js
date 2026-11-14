//@ts-check
/**
 * @file The kernels engine's table: the `@jarenjs/core` functions the
 * `$query` operators run (geo, dates, math, text), each with the operator
 * document that runs the same kernel over the same arguments. A kernel is
 * called directly over the Arguments pane's JSON array; the operator
 * document reads that array as its data (`$[0]`, `$[1]`, …), so the two
 * answers are the same arguments through the two doors.
 *
 * The choice is small on purpose: kernels whose inputs and answers are
 * JSON. The date kernels work on a parts record, so their entries read and
 * write RFC 3339 text through the parse and format kernels, as the
 * operators do; a kernel that compiles a function (a date picture, an
 * I-Regexp) is called with the value it then reads.
 *
 * The two doors do not answer every argument alike: a kernel answers
 * `null` where it has no answer (an invalid I-Regexp, a value that is not
 * a position), and answers arguments the operator refuses (`geohashEncode`
 * defaults a missing precision to 9, where `$geohash` refuses `JQ2001`), so
 * the card compares only arguments both doors answer.
 */
import { geoDistance, geohashEncode } from '@jarenjs/core/geo';
import { parseRFC3339Parts, formatRFC3339Parts, parseDuration, addDuration, compileDateFormat } from '@jarenjs/core/dates';
import { roundExact } from '@jarenjs/core/math';
import { compileIRegexp } from '@jarenjs/core/text/iregexp';

/** @typedef {(id: string, params?: Record<string, unknown>) => string} Text */

/**
 * A parse kernel's answer, refused when it is `null` — the next kernel
 * would read it as a record and fail with a property-read TypeError.
 * @param {(text: any) => any} parse @param {string} name @param {any} text @param {number} index
 * @param {Text} t - the run's text function
 */
function parsed(parse, name, text, index, t) {
  const value = parse(text);
  if (value === null) throw new TypeError(t('play/error/kernel-null', { index, name, text: JSON.stringify(text) }));
  return value;
}

/**
 * @typedef {Object} Kernel
 * @property {string} value - the option value, the kernel's export name
 * @property {'geo' | 'dates' | 'math' | 'text'} family - its `@jarenjs/core` subpath
 * @property {string} signature - the call the Arguments pane spells, in English
 * @property {string} msgid - the message id of `signature` (the output panel's label)
 * @property {(args: any[], t: Text) => any} call - the kernel over the arguments;
 *   `null` (or nothing) where the kernel has no answer for them; `t` words a refusal
 * @property {(args: any[]) => object} query - the operator document over the same arguments
 * @property {(args: any[], t: Text) => import('./index.js').Panel[]} [deep] - extra drill-down panels
 */

/** @type {readonly Kernel[]} */
export const KERNELS = Object.freeze([
  {
    value: 'geoDistance', family: 'geo', signature: 'geoDistance(a, b) — metres between two [lon, lat] positions',
    msgid: 'play/kernel/geo-distance',
    call: ([a, b]) => geoDistance(a, b),
    query: () => ({ $distance: ['$[0]', '$[1]'] }),
  },
  {
    value: 'geohashEncode', family: 'geo', signature: 'geohashEncode(lon, lat, precision) — the base-32 cell',
    msgid: 'play/kernel/geohash-encode',
    call: ([lon, lat, precision]) => geohashEncode(lon, lat, precision),
    query: () => ({ $geohash: [['$[0]', '$[1]'], '$[2]'] }),
  },
  {
    value: 'addDuration', family: 'dates', signature: 'addDuration(date, duration) — calendar arithmetic over RFC 3339 text',
    msgid: 'play/kernel/add-duration',
    call: ([date, duration], t) => formatRFC3339Parts(addDuration(
      parsed(parseRFC3339Parts, 'parseRFC3339Parts', date, 0, t), parsed(parseDuration, 'parseDuration', duration, 1, t))),
    query: () => ({ '$date-add': ['$[0]', '$[1]'] }),
  },
  {
    value: 'compileDateFormat', family: 'dates', signature: 'compileDateFormat(pattern)(date) — an LDML picture over RFC 3339 text',
    msgid: 'play/kernel/date-format',
    call: ([pattern, date], t) => compileDateFormat(pattern)(parsed(parseRFC3339Parts, 'parseRFC3339Parts', date, 1, t)),
    query: () => ({ '$date-format': ['$[1]', '$[0]'] }),
  },
  {
    value: 'roundExact', family: 'math', signature: "roundExact(x, precision, mode) — exact decimal rounding, 'half-up' or 'half-even'",
    msgid: 'play/kernel/round-exact',
    call: ([x, precision, mode]) => roundExact(x, precision, mode),
    query: (args) => ({ [args[2] === 'half-even' ? '$round-half-to-even' : '$round']: ['$[0]', '$[1]'] }),
  },
  {
    value: 'compileIRegexp', family: 'text', signature: 'compileIRegexp(pattern, true).test(input) — an RFC 9485 I-Regexp matched whole',
    msgid: 'play/kernel/iregexp',
    call: ([pattern, input], t) => {
      if (typeof input !== 'string') throw new TypeError(t('play/error/kernel-input'));
      // a value that is not a string is no I-Regexp, as a number already
      // answered; the kernel itself reads a string's length
      const re = typeof pattern === 'string' ? compileIRegexp(pattern, true) : null;
      return re === null ? null : re.test(input);
    },
    query: () => ({ $match: ['$[1]', '$[0]'] }),
    deep: ([pattern], t) => {
      const re = typeof pattern === 'string' ? compileIRegexp(pattern, true) : null;
      return re === null ? [] : [{ id: 'regexp', label: t('play/panel/regexp'), kind: 'code', depth: 'deep', text: String(re) }];
    },
  },
]);
