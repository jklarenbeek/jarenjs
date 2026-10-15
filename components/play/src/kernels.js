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
 */
import { geoDistance, geohashEncode } from '@jarenjs/core/geo';
import { parseRFC3339Parts, formatRFC3339Parts, parseDuration, addDuration, compileDateFormat } from '@jarenjs/core/dates';
import { roundExact } from '@jarenjs/core/math';
import { compileIRegexp } from '@jarenjs/core/text/iregexp';

/**
 * A parse kernel's answer, refused when it is `null` — the next kernel
 * would read it as a record and fail with a property-read TypeError.
 * @param {(text: any) => any} parse @param {string} name @param {any} text @param {number} index
 */
function parsed(parse, name, text, index) {
  const value = parse(text);
  if (value === null) throw new TypeError(`argument ${index}: ${name} answers null for ${JSON.stringify(text)}`);
  return value;
}

/**
 * @typedef {Object} Kernel
 * @property {string} value - the option value, the kernel's export name
 * @property {'geo' | 'dates' | 'math' | 'text'} family - its `@jarenjs/core` subpath
 * @property {string} signature - the call the Arguments pane spells
 * @property {(args: any[]) => any} call - the kernel over the arguments
 * @property {(args: any[]) => object} query - the operator document over the same arguments
 * @property {(args: any[]) => import('./index.js').Panel[]} [deep] - extra drill-down panels
 */

/** @type {readonly Kernel[]} */
export const KERNELS = Object.freeze([
  {
    value: 'geoDistance', family: 'geo', signature: 'geoDistance(a, b) — metres between two [lon, lat] positions',
    call: ([a, b]) => geoDistance(a, b),
    query: () => ({ $distance: ['$[0]', '$[1]'] }),
  },
  {
    value: 'geohashEncode', family: 'geo', signature: 'geohashEncode(lon, lat, precision) — the base-32 cell',
    call: ([lon, lat, precision]) => geohashEncode(lon, lat, precision),
    query: () => ({ $geohash: [['$[0]', '$[1]'], '$[2]'] }),
  },
  {
    value: 'addDuration', family: 'dates', signature: 'addDuration(date, duration) — calendar arithmetic over RFC 3339 text',
    call: ([date, duration]) => formatRFC3339Parts(addDuration(
      parsed(parseRFC3339Parts, 'parseRFC3339Parts', date, 0), parsed(parseDuration, 'parseDuration', duration, 1))),
    query: () => ({ '$date-add': ['$[0]', '$[1]'] }),
  },
  {
    value: 'compileDateFormat', family: 'dates', signature: 'compileDateFormat(pattern)(date) — an LDML picture over RFC 3339 text',
    call: ([pattern, date]) => compileDateFormat(pattern)(parsed(parseRFC3339Parts, 'parseRFC3339Parts', date, 1)),
    query: () => ({ '$date-format': ['$[1]', '$[0]'] }),
  },
  {
    value: 'roundExact', family: 'math', signature: "roundExact(x, precision, mode) — exact decimal rounding, 'half-up' or 'half-even'",
    call: ([x, precision, mode]) => roundExact(x, precision, mode),
    query: (args) => ({ [args[2] === 'half-even' ? '$round-half-to-even' : '$round']: ['$[0]', '$[1]'] }),
  },
  {
    value: 'compileIRegexp', family: 'text', signature: 'compileIRegexp(pattern, true).test(input) — an RFC 9485 I-Regexp matched whole',
    call: ([pattern, input]) => {
      if (typeof input !== 'string') throw new TypeError('argument 1: the input a pattern is tested against is a string');
      const re = compileIRegexp(pattern, true);
      return re === null ? null : re.test(input);
    },
    query: () => ({ $match: ['$[1]', '$[0]'] }),
    deep: ([pattern]) => {
      const re = compileIRegexp(pattern, true);
      return re === null ? [] : [{ id: 'regexp', label: 'The ECMAScript RegExp it compiles to', kind: 'code', depth: 'deep', text: String(re) }];
    },
  },
]);
