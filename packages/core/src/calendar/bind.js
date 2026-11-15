//@ts-check

//#region Binding, converting, shifting and splitting
// A floating time or a civil day names no instant until it is given a
// zone, and this module never supplies one: with no zone the answer is a
// typed `unresolved` record, never the host's zone and never UTC. Given a
// zone, a time resolves through `resolveLocal` under the caller's policy,
// and a day becomes the half-open span from its first instant to the
// next day's, so a spring-forward day is shorter and a fall-back day
// longer, and a skipped day is empty.
//
// A day starts at the first instant whose wall clock reads that date.
// That has one answer when midnight falls in a gap (the instant the
// clock jumps past it) and when a fold opens at midnight (the first of
// the two midnights - the repeated hour reads the same date both times),
// so no policy is consulted there. Only a fold that carries the clock
// back across midnight to the day before has two candidate starts; the
// policy picks one there, and `reject` refuses it.

import { civilFromDays, daysFromCivil } from '../dates/civil.js';
import { CalendarError } from './errors.js';
import { admitBound, admitValue, formatDate, utcValue } from './model.js';
import { admitPolicy, admitProvider, admitZoneName, classifyLocal, identityOf, providerKnows, resolveLocal } from './resolve.js';

const MINUTE = 60000;
const DAY = 86400000;
/** How many civil days `splitByCivilDay` walks before refusing: about a century. */
const DEFAULT_MAX_DAYS = 36600;

/**
 * The zone a zone-less value was bound to, and where the caller got it
 * (`'location'`, `'tenant'`, `'explicit'`; `'unrecorded'` when not said).
 * @typedef {{ readonly zone: string, readonly source: string }} Binding
 */

/**
 * A zone-less value that was given no zone: it names no instant yet.
 * @typedef {{ readonly kind: 'unresolved', readonly reason: 'no-zone',
 *   readonly value: import('./model.js').TemporalValue }} Unresolved
 */

/**
 * A value resolved to one instant (epoch milliseconds). `value` is the
 * zoned value (a bound floating time becomes one); `binding` is present
 * when a zone was bound; `resolution` and `provider` when a zone was
 * consulted (not for a utc value).
 * @typedef {Object} ResolvedInstant
 * @property {'instant'} kind
 * @property {import('./model.js').TemporalValue} value
 * @property {number} instant
 * @property {Binding} [binding]
 * @property {import('./resolve.js').Resolution} [resolution]
 * @property {{ readonly name: string, readonly revision: string }} [provider]
 */

/**
 * A civil day or date range resolved to the half-open span
 * `[start, end)` of epoch milliseconds, with how each end was reached.
 * @typedef {Object} ResolvedSpan
 * @property {'span'} kind
 * @property {import('./model.js').TemporalValue} value
 * @property {number} start
 * @property {number} end
 * @property {Binding} binding
 * @property {{ readonly start: import('./resolve.js').Resolution,
 *   readonly end: import('./resolve.js').Resolution }} resolution
 * @property {{ readonly name: string, readonly revision: string }} provider
 */

/**
 * One civil day's part of an interval: `[start, end)` in epoch
 * milliseconds, all of whose instants read `date` in the zone.
 * @typedef {{ readonly date: string, readonly start: number, readonly end: number }} CivilDayPiece
 */

/**
 * What binding takes: the zone (absent or `null` gives `unresolved`), its
 * source, the provider and the policy (required once a zone is given),
 * and `bound: 'end'` to admit a `24:00` time.
 * @typedef {Object} BindOptions
 * @property {string | null} [zone]
 * @property {string} [source]
 * @property {import('../series/zone.js').ZoneProvider} [provider]
 * @property {'rfc5545' | 'later' | 'reject'} [policy]
 * @property {'start' | 'end'} [bound]
 */

/**
 * @param {unknown} source
 * @returns {string}
 */
function admitSource(source) {
  if (source === undefined || source === null)
    return 'unrecorded';
  if (typeof source !== 'string' || source === '')
    throw new CalendarError('JY0014', `source is a non-empty token such as 'location' or 'explicit', not ${typeof source === 'string' ? "''" : typeof source}`, '/options/source');
  return source;
}

/**
 * The policy, the provider (with `candidates` and `toParts`) and its
 * identity.
 * @param {any} options
 */
function admitResolver(options) {
  const policy = admitPolicy(options?.policy);
  const provider = admitProvider(admitProvider(options?.provider, 'candidates'), 'toParts');
  return { policy, provider, identity: identityOf(provider) };
}

/**
 * The wall clock at an instant in a zone, in milliseconds read as if UTC.
 * @param {any} provider
 * @param {string} zone
 * @param {number} instant
 * @returns {number}
 */
export function wallAt(provider, zone, instant) {
  let parts;
  try {
    parts = provider.toParts(instant, zone);
  }
  catch (error) {
    if (error instanceof CalendarError)
      throw error;
    if (!providerKnows(provider, zone))
      throw new CalendarError('JY0001', `the provider does not know the zone '${zone}'`, '/zone', error);
    throw new CalendarError('JY0004', `the provider's toParts(instant, '${zone}') threw`, '/provider', error);
  }
  const hours = parts?.hours ?? 0;
  const minutes = parts?.minutes ?? 0;
  const seconds = parts?.seconds ?? 0;
  if (parts === null || typeof parts !== 'object'
    || ![parts.year, parts.month, parts.day, hours, minutes, seconds].every(Number.isFinite)) {
    throw new CalendarError('JY0004', `the provider's toParts(instant, '${zone}') is not a date and time of day`, '/provider');
  }
  return daysFromCivil(parts.year, parts.month, parts.day) * DAY + ((hours * 60 + minutes) * 60) * 1000 + Math.round(seconds * 1000);
}

/**
 * The first instant of a civil day in a zone (see the module note), with
 * the resolution that reached it.
 * @param {{ policy: 'rfc5545' | 'later' | 'reject', provider: any,
 *   identity: { readonly name: string, readonly revision: string } }} resolver
 * @param {string} zone
 * @param {number} days - the civil day number
 * @param {string} path - the argument a refusal names
 * @returns {{ instant: number, resolution: import('./resolve.js').Resolution }}
 */
function dayStart(resolver, zone, days, path) {
  const date = formatDate(days, path);
  const { provider, policy } = resolver;
  const found = classifyLocal(civilFromDays(days), zone, provider);
  const wall = days * DAY;
  /** @type {{ instant: number, offsetMinutes: number }} */
  let chosen;
  if (found.kind === 'exists') {
    chosen = found.candidates[0];
  }
  else if (found.kind === 'gap') {
    // read with the offset before the change the instant reads past
    // midnight; when the gap opened before midnight, the day began
    // earlier, at the jump, which lies after `low` (still the day before)
    const { before, after } = /** @type {{ before: number, after: number }} */ (found.offsets);
    let high = wall - before * MINUTE;
    if (wallAt(provider, zone, high - 1) >= wall) {
      let low = wall - after * MINUTE;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (wallAt(provider, zone, middle) >= wall)
          high = middle;
        else
          low = middle;
      }
    }
    chosen = { instant: high, offsetMinutes: after };
  }
  else {
    const [first, second] = found.candidates;
    if (wallAt(provider, zone, second.instant - 1) >= wall)
      chosen = first;
    else if (policy === 'reject')
      throw new CalendarError('JY0003', `${date} starts twice in '${zone}': after its first midnight the clock returns to the day before`, path);
    else
      chosen = policy === 'later' ? second : first;
  }
  return {
    instant: chosen.instant,
    resolution: Object.freeze({ kind: found.kind, policy, zone, offsetMinutes: chosen.offsetMinutes, provider: resolver.identity }),
  };
}

/**
 * The instant a floating or zoned wall clock names in `zone`; `24:00` is
 * the next day's start.
 * @param {import('./model.js').AdmittedValue} admitted
 * @param {string} zone
 * @param {ReturnType<typeof admitResolver>} resolver
 * @returns {{ instant: number, resolution: import('./resolve.js').Resolution }}
 */
function instantOf(admitted, zone, resolver) {
  const days = /** @type {number} */ (admitted.days);
  const time = /** @type {import('./model.js').WallTime} */ (admitted.time);
  if (time.endOfDay)
    return dayStart(resolver, zone, days + 1, '/value/time');
  return resolveLocal({ ...civilFromDays(days), hours: time.hours, minutes: time.minutes, seconds: time.seconds },
    zone, { provider: resolver.provider, policy: resolver.policy });
}

/**
 * Bind a zone-less admitted value, or answer `unresolved` without one.
 * @param {import('./model.js').AdmittedValue} admitted
 * @param {any} options
 * @returns {Unresolved | ResolvedInstant | ResolvedSpan}
 */
function bindOrUnresolved(admitted, options) {
  const zone = options?.zone;
  if (zone === undefined || zone === null)
    return Object.freeze({ kind: 'unresolved', reason: 'no-zone', value: admitted.value });
  const name = admitZoneName(zone);
  const binding = Object.freeze({ zone: name, source: admitSource(options.source) });
  const resolver = admitResolver(options);
  const value = /** @type {any} */ (admitted.value);
  if (value.kind === 'floating') {
    const { instant, resolution } = instantOf(admitted, name, resolver);
    return Object.freeze({
      kind: 'instant',
      value: Object.freeze({ kind: 'zoned', date: value.date, time: value.time, zone: name }),
      instant, binding, resolution, provider: resolver.identity,
    });
  }
  const days = /** @type {number} */ (admitted.days);
  const start = dayStart(resolver, name, days, '/value');
  const end = dayStart(resolver, name, value.kind === 'date' ? days + 1 : /** @type {number} */ (admitted.endDays), '/value');
  return Object.freeze({
    kind: 'span', value, start: start.instant, end: end.instant, binding,
    resolution: Object.freeze({ start: start.resolution, end: end.resolution }), provider: resolver.identity,
  });
}

/**
 * Bind a zone-less value to a zone the caller names, recording where the
 * zone came from:
 *
 *   floating    the zoned value, its instant and how it was resolved
 *   date        the half-open day [its first instant, the next day's)
 *   date-range  the half-open span from its first day's first instant
 *               to its end day's
 *
 * With `zone` absent or `null` the answer is
 * `{ kind: 'unresolved', reason: 'no-zone', value }` and nothing else is
 * read - no provider, no policy, never the host's zone, never UTC.
 *
 * @param {import('./model.js').TemporalValue} value - a date, floating or date-range value
 * @param {BindOptions} [options]
 * @returns {Unresolved | ResolvedInstant | ResolvedSpan}
 * @throws {CalendarError} `JY0013` for a utc or zoned value (it names its
 *   own instant; see {@link toUtc}), `JY0014` for a malformed source, and
 *   what the value's constructor and {@link resolveLocal} throw
 * @example
 * const day = bindFloating(dateValue('2026-03-29'),
 *   { zone: 'Europe/Amsterdam', source: 'location', provider, policy: 'rfc5545' });
 * (day.end - day.start) / 3600000; // 23
 */
export function bindFloating(value, options = undefined) {
  const admitted = admitValue(value, admitBound(options), '/value');
  const kind = admitted.value.kind;
  if (kind === 'utc' || kind === 'zoned')
    throw new CalendarError('JY0013', `bindFloating binds a date, floating or date-range value; a ${kind} value names its own instant (use toUtc)`, '/value/kind');
  return bindOrUnresolved(admitted, options);
}

/**
 * The instant or span a value names in UTC, by kind: a utc value as it
 * is; a zoned value resolved in its own zone under the policy; a date,
 * floating or date-range value bound as {@link bindFloating} binds it -
 * `unresolved` when no zone is given.
 * @param {import('./model.js').TemporalValue} value
 * @param {BindOptions} [options] - `zone` and `source` bind a zone-less
 *   value and are not read for a zoned one
 * @returns {Unresolved | ResolvedInstant | ResolvedSpan}
 * @throws {CalendarError} what the value's constructor and
 *   {@link resolveLocal} throw
 * @example
 * toUtc(zonedValue('2026-10-25', '02:30', 'Europe/Amsterdam'), { provider, policy: 'later' }).instant;
 * // Date.parse('2026-10-25T01:30:00Z')
 */
export function toUtc(value, options = undefined) {
  const admitted = admitValue(value, admitBound(options), '/value');
  const own = /** @type {any} */ (admitted.value);
  if (own.kind === 'utc')
    return Object.freeze({ kind: 'instant', value: own, instant: /** @type {number} */ (admitted.epoch) });
  if (own.kind === 'zoned') {
    const resolver = admitResolver(options);
    const { instant, resolution } = instantOf(admitted, own.zone, resolver);
    return Object.freeze({ kind: 'instant', value: own, instant, resolution, provider: resolver.identity });
  }
  return bindOrUnresolved(admitted, options);
}

/**
 * Move a value by whole civil days - the same wall clock on another day,
 * not a multiple of 24 hours - and resolve the moved value as
 * {@link toUtc} does. The answer's `value` is the moved value; a moved
 * time that lands in a gap or fold is resolved under the policy, and the
 * wall clock it was written with is kept. A utc value moves by 24-hour
 * days and is spelled with three fraction digits.
 * @param {import('./model.js').TemporalValue} value
 * @param {{ days: number }} shift - a whole number of days, negative to move back
 * @param {BindOptions} [options]
 * @returns {Unresolved | ResolvedInstant | ResolvedSpan}
 * @throws {CalendarError} `JY0014` for a day count that is not a whole
 *   number, `JY0012` for a day outside 0000-9999, and what {@link toUtc}
 *   throws
 * @example
 * // a roster shift on the Saturday before the change, one week on
 * shiftCivil(zonedValue('2026-03-22', '02:30', 'Europe/Amsterdam'), { days: 7 }, { provider, policy: 'rfc5545' });
 * // value 2026-03-29 02:30 (a gap), instant 2026-03-29T01:30:00.000Z
 */
export function shiftCivil(value, shift, options = undefined) {
  const admitted = admitValue(value, admitBound(options), '/value');
  const days = /** @type {any} */ (shift)?.days;
  if (!Number.isSafeInteger(days))
    throw new CalendarError('JY0014', `days is a whole number, not ${String(days)}`, '/shift/days');
  const own = /** @type {any} */ (admitted.value);
  const moved = (/** @type {number} */ day) => formatDate(day + days, '/shift/days');
  let shifted;
  switch (own.kind) {
    case 'utc':
      shifted = utcValue(/** @type {number} */ (admitted.epoch) + days * DAY);
      break;
    case 'date-range':
      shifted = { kind: own.kind, start: moved(/** @type {number} */ (admitted.days)), end: moved(/** @type {number} */ (admitted.endDays)) };
      break;
    default:
      shifted = { ...own, date: moved(/** @type {number} */ (admitted.days)) };
  }
  return toUtc(shifted, options);
}

/**
 * Split a half-open interval of instants at the civil-day boundaries of
 * a zone: one piece per civil day it touches, in order, tiling the
 * interval exactly. A day is as long as the zone made it - 23 or 25
 * hours across a change of an hour, 23.5 or 24.5 across a half-hour one
 * - and a skipped day has no instant, so no piece. See the module note
 * for where a day starts.
 * @param {{ start: number, end: number }} interval - epoch milliseconds,
 *   `start` inclusive and `end` exclusive
 * @param {{ zone: string, provider: import('../series/zone.js').ZoneProvider,
 *   policy: 'rfc5545' | 'later' | 'reject', maxDays?: number }} options -
 *   `maxDays` (default 36600) bounds how many civil days are walked
 * @returns {ReadonlyArray<CivilDayPiece>}
 * @throws {CalendarError} `JY0014` for an interval that is not two whole
 *   numbers with `start <= end`, a malformed `maxDays`, or more days than
 *   it; `JY0001` for a missing or unknown zone; `JY0006` / `JY0005` for
 *   the policy; `JY0003` under `reject` for a day that starts twice
 * @example
 * // a night shift across the fall-back change, split for payroll
 * splitByCivilDay({ start: Date.parse('2026-10-24T20:00:00Z'), end: Date.parse('2026-10-25T06:00:00Z') },
 *   { zone: 'Europe/Amsterdam', provider, policy: 'rfc5545' });
 * // [{ date: '2026-10-24', ... 2h }, { date: '2026-10-25', ... 8h }]
 */
export function splitByCivilDay(interval, options) {
  const start = /** @type {any} */ (interval)?.start;
  const end = /** @type {any} */ (interval)?.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start)
    throw new CalendarError('JY0014', 'an interval is { start, end } of whole epoch milliseconds with start <= end', '/interval');
  const zone = admitZoneName(options?.zone);
  const resolver = admitResolver(options);
  const maxDays = options?.maxDays ?? DEFAULT_MAX_DAYS;
  if (!Number.isSafeInteger(maxDays) || maxDays < 1)
    throw new CalendarError('JY0014', `maxDays is a whole number of at least 1, not ${String(maxDays)}`, '/options/maxDays');
  /** @type {CivilDayPiece[]} */
  const pieces = [];
  if (start === end)
    return Object.freeze(pieces);
  let day = Math.floor(wallAt(resolver.provider, zone, start) / DAY);
  let open = dayStart(resolver, zone, day, '/interval');
  // a fold back across midnight can file an instant under the day before
  // the one its wall clock reads (`later` starts the day at the second
  // midnight); step back to the day whose span holds `start`. A day
  // whose span ends at or before `start` gives an empty piece below
  while (open.instant > start)
    open = dayStart(resolver, zone, --day, '/interval');
  let close = dayStart(resolver, zone, day + 1, '/interval');
  for (let walked = 1; ; walked++) {
    const from = Math.max(start, open.instant);
    const to = Math.min(end, close.instant);
    if (to > from)
      pieces.push(Object.freeze({ date: formatDate(day, '/interval'), start: from, end: to }));
    if (close.instant >= end)
      break;
    if (walked >= maxDays)
      throw new CalendarError('JY0014', `the interval spans more than ${maxDays} civil days in '${zone}'; pass a larger maxDays`, '/options/maxDays');
    open = close;
    close = dayStart(resolver, zone, ++day + 1, '/interval');
  }
  return Object.freeze(pieces);
}
//#endregion
