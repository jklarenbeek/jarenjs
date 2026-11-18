//@ts-check
/**
 * @file `@jarenjs/json/query/calendar` - the calendar half of the query
 * operators `$instant` and `$wall` (QUERY-FORMAT §8.13 "Calendar values"):
 * a calendar value admitted as `@jarenjs/core/calendar` admits it, a utc or
 * zoned value's instant, and a floating or zoned value's wall clock in its
 * one spelling. It is a subpath of its own so a query that reads no
 * calendar value carries no calendar: pass {@link queryCalendar}'s answer
 * as the compile option `calendar` (a store takes it inside
 * `storeTemporals()` of `@jarenjs/db/temporals`). Without it either
 * operator is `JQ0003` when the query compiles.
 * @module
 */
import { parseTemporal, toUtc } from '@jarenjs/core/calendar';
import { queryRuntimeError } from './messages.js';
import { itemRef } from './runtime.js';
import { CALENDAR_SEAMS } from './calendar-seam.js';

/**
 * The calendar value an `$instant` or `$wall` operand holds, admitted as
 * its constructor admits it: an object of one of the five kinds, or
 * `JQ2001` naming the calendar's own code.
 * @param {string} operator
 * @param {unknown} v
 * @param {string} docPath
 * @returns {any}
 */
function temporalArg(operator, v, docPath) {
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw queryRuntimeError('JQ2001', 'query/temporal-expected', { operator, kinds: 'date, floating, utc, zoned, date-range', got: itemRef(v) }, docPath);
  try {
    return parseTemporal(/** @type {any} */ (v));
  }
  catch (e) {
    if (typeof (/** @type {any} */ (e))?.code === 'string' && /** @type {any} */ (e).code.startsWith('JY'))
      throw queryRuntimeError('JQ2001', 'query/temporal-invalid', { operator, code: /** @type {any} */ (e).code, pointer: /** @type {any} */ (e).docPath ?? '' }, docPath);
    throw e;
  }
}

/**
 * The epoch milliseconds a utc or zoned value names; a date, floating or
 * date-range value names none (it is bound to a zone first, never read as
 * one in UTC).
 * @param {unknown} v
 * @param {string | null} policy - the policy captured when the query compiled
 * @param {any} provider - the compilation's zone provider, or `null`
 * @param {string} docPath
 * @returns {number}
 */
function instantOf(v, policy, provider, docPath) {
  const value = temporalArg('$instant', v, docPath);
  if (value.kind === 'utc')
    return toUtc(value).instant;
  if (value.kind !== 'zoned')
    throw queryRuntimeError('JQ2001', 'query/temporal-expected', { operator: '$instant', kinds: 'utc, zoned', got: value.kind }, docPath);
  if (policy === null)
    throw queryRuntimeError('JQ2001', 'query/instant-policy', {}, docPath);
  if (provider === null)
    throw queryRuntimeError('JQ2001', 'query/series-zone-provider', { zone: value.zone }, docPath);
  try {
    return toUtc(value, { provider, policy: /** @type {any} */ (policy) }).instant;
  }
  catch (e) {
    if (typeof (/** @type {any} */ (e))?.code === 'string' && /** @type {any} */ (e).code.startsWith('JY'))
      throw queryRuntimeError('JQ2001', 'query/instant-unresolved', { date: value.date, time: value.time, zone: value.zone, policy, code: /** @type {any} */ (e).code }, docPath);
    throw e;
  }
}

/**
 * A wall clock in its one spelling, `YYYY-MM-DDTHH:MM:SS.fff`: a time the
 * calendar admits (`HH:MM`, `HH:MM:SS`, `HH:MM:SS.f` to `.fff`) padded to
 * seconds and three fraction digits, so two spellings of one wall clock are
 * one string and its code-point order is the clock's.
 * @param {string} date
 * @param {string} time
 * @returns {string}
 */
function canonicalWall(date, time) {
  const clock = time.length === 5 ? `${time}:00.000` : time.length === 8 ? `${time}.000` : `${time}00`.slice(0, 12);
  return `${date}T${clock}`;
}

/**
 * A floating or zoned value's wall clock in its one spelling.
 * @param {unknown} v
 * @param {string} docPath
 * @returns {string}
 */
function wallOf(v, docPath) {
  const value = temporalArg('$wall', v, docPath);
  if (value.kind !== 'floating' && value.kind !== 'zoned')
    throw queryRuntimeError('JQ2001', 'query/temporal-expected', { operator: '$wall', kinds: 'floating, zoned', got: value.kind }, docPath);
  return canonicalWall(value.date, value.time);
}

/**
 * The calendar seam `$instant` and `$wall` read their values through.
 * @typedef {{ readonly instantOf: typeof instantOf, readonly wallOf: typeof wallOf }} QueryCalendar
 */

/**
 * Enable the calendar operators `$instant` and `$wall`: pass the answer as
 * the compile option `calendar` (`compileJsonQuery(doc, { calendar:
 * queryCalendar() })`, a linq source's `{ calendar }`).
 * @returns {QueryCalendar}
 */
export function queryCalendar() {
  const seam = Object.freeze({ instantOf, wallOf });
  CALENDAR_SEAMS.add(seam);
  return seam;
}
