//@ts-check

//#region Classifying and resolving a local time
// A wall clock in a named zone is not a function of the clock. On a
// spring-forward day an hour never happens (a gap); on a fall-back day
// an hour happens twice (a fold). The zone seam's `toEpoch` collapses
// both into one number, or `NaN` when told to refuse, so a caller cannot
// learn which case it met. This module asks the provider's optional
// `candidates` member instead, names the case first, and only then
// applies a policy the caller chose - there is no default policy,
// because an implicit choice is exactly what goes wrong unnoticed.

import { daysFromCivil, daysInMonth } from '../dates/civil.js';
import { nearestName } from '../object.js';
import { CalendarError } from './errors.js';

/**
 * The named ways a local time that never happened, or happened twice,
 * becomes one instant:
 *
 *   rfc5545   gap: read with the offset before the change (the time moves
 *             forward by the gap's length); fold: the earlier instant.
 *             RFC 5545 §3.3.5 defines it for recurrence.
 *   later     gap: as rfc5545; fold: the later instant.
 *   reject    either case is a refusal naming which one it was.
 *
 * A time that exists has one instant and every policy answers it.
 */
export const RESOLUTION_POLICIES = Object.freeze(['rfc5545', 'later', 'reject']);

/** What a provider without `identity` is recorded as. */
const UNRECORDED = Object.freeze({ name: 'unrecorded', revision: 'unrecorded' });

const MINUTE = 60000;
const DAY = 86400000;

/**
 * A civil date and time of day, as the zone seam reads it.
 * `hours`, `minutes` and `seconds` default to `0`; `seconds` may carry a
 * millisecond fraction. Any other member (an `offset` a provider's
 * `toParts` reported, say) is not read: the zone decides the offset.
 * @typedef {Object} LocalParts
 * @property {number} year - 0 to 9999
 * @property {number} month - 1 to 12
 * @property {number} day - 1 to the month's length
 * @property {number} [hours] - 0 to 23
 * @property {number} [minutes] - 0 to 59
 * @property {number} [seconds] - at least 0 and below 60
 */

/**
 * One instant a local time names, with the offset in force there in
 * minutes east of UTC.
 * @typedef {{ readonly instant: number, readonly offsetMinutes: number }} LocalCandidate
 */

/**
 * What a local time is in a zone: `exists` (one candidate), `fold` (two,
 * ascending) or `gap` (none). A gap and a fold carry `offsets`, the
 * offsets in force before and after the change.
 * @typedef {Object} LocalClassification
 * @property {'exists' | 'gap' | 'fold'} kind
 * @property {ReadonlyArray<LocalCandidate>} candidates
 * @property {{ readonly before: number, readonly after: number }} [offsets]
 */

/**
 * How an instant was reached: the case the local time was in, the
 * policy that decided it, the zone, the offset in force at the returned
 * instant (for a gap, the offset after the change: the wall clock moved
 * forward), and which zone data answered.
 * @typedef {Object} Resolution
 * @property {'exists' | 'gap' | 'fold'} kind
 * @property {'rfc5545' | 'later' | 'reject'} policy
 * @property {string} zone
 * @property {number} offsetMinutes
 * @property {{ readonly name: string, readonly revision: string }} provider
 */

/**
 * Whether a value is a whole number from `low` to `high` inclusive.
 * @param {unknown} value
 * @param {number} low
 * @param {number} high - inclusive
 * @returns {boolean}
 */
export const wholeIn = (value, low, high) => Number.isInteger(value)
  && /** @type {number} */ (value) >= low && /** @type {number} */ (value) <= high;

/** The members a local time is read from (CALENDAR.md "Parts"). */
const PART_MEMBERS = ['year', 'month', 'day', 'hours', 'minutes', 'seconds'];

/**
 * Refuse an own member that misspells a member the record lacks: an absent
 * time member is `0`, so `{ hour: 2, minute: 30 }` would read as midnight.
 * A near name (the suite's nearest-name rule) is refused only when it is no
 * longer than the member it corrects to and that member is absent: a name
 * that extends one (`hoursWorked`, `hour12`, `dayOfWeek`) is another member,
 * not read, as an `offset` is not. A millisecond count, which is never read,
 * names the fraction of `seconds` that carries it.
 * @param {object} parts
 */
function refuseMisspeltMembers(parts) {
  for (const key of Object.keys(parts)) {
    if (PART_MEMBERS.includes(key)) continue;
    const lower = key.toLowerCase();
    if (lower === 'millisecond' || lower === 'milliseconds') {
      throw new CalendarError('JY0007',
        `'${key}' is not a member of a local time: milliseconds are the fraction of 'seconds'`, `/parts/${key}`);
    }
    const meant = nearestName(key, PART_MEMBERS);
    if (meant !== undefined && key.length <= meant.length && !Object.hasOwn(parts, meant)) {
      throw new CalendarError('JY0007',
        `'${key}' is not a member of a local time: did you mean '${meant}'?`, `/parts/${key}`);
    }
  }
}

/**
 * Refuse anything that is not a real civil date and time of day. An
 * impossible date (the thirtieth of February, hour 25) reads back as a
 * different wall clock, exactly as a gap does, so it must be refused
 * before the provider is asked or a policy would "resolve" it.
 * @param {any} parts
 * @returns {{ year: number, month: number, day: number, hours: number, minutes: number, seconds: number }}
 */
function admitParts(parts) {
  if (parts === null || typeof parts !== 'object' || Array.isArray(parts))
    throw new CalendarError('JY0007', 'a local time is a parts record { year, month, day, hours, minutes, seconds }', '/parts');
  refuseMisspeltMembers(parts);
  const { year, month, day } = parts;
  const hours = parts.hours ?? 0;
  const minutes = parts.minutes ?? 0;
  const seconds = parts.seconds ?? 0;
  if (!wholeIn(year, 0, 9999))
    throw new CalendarError('JY0007', `year is a whole number from 0 to 9999, not ${String(year)}`, '/parts/year');
  if (!wholeIn(month, 1, 12))
    throw new CalendarError('JY0007', `month is a whole number from 1 to 12, not ${String(month)}`, '/parts/month');
  if (!wholeIn(day, 1, daysInMonth(year, month))) {
    throw new CalendarError('JY0007',
      `day is a whole number from 1 to ${daysInMonth(year, month)} in ${year}-${String(month).padStart(2, '0')}, not ${String(day)}`,
      '/parts/day');
  }
  if (!wholeIn(hours, 0, 23))
    throw new CalendarError('JY0007', `hours is a whole number from 0 to 23, not ${String(hours)}`, '/parts/hours');
  if (!wholeIn(minutes, 0, 59))
    throw new CalendarError('JY0007', `minutes is a whole number from 0 to 59, not ${String(minutes)}`, '/parts/minutes');
  if (typeof seconds !== 'number' || !(seconds >= 0 && seconds < 60))
    throw new CalendarError('JY0007', `seconds is a number from 0 up to but not including 60, not ${String(seconds)}`, '/parts/seconds');
  // a fraction past the millisecond is refused, never rounded: an instant
  // is whole milliseconds, and rounding 59.9996 would name the next minute
  const millis = seconds * 1000;
  if (Math.abs(millis - Math.round(millis)) > 1e-6)
    throw new CalendarError('JY0007', `seconds carries a fraction past the millisecond (${seconds})`, '/parts/seconds');
  return { year, month, day, hours, minutes, seconds };
}

/**
 * Refuse a zone that is not a non-empty name; whether the provider knows
 * it is learned from the provider.
 * @param {unknown} zone
 * @returns {string}
 */
export function admitZoneName(zone) {
  if (typeof zone !== 'string' || zone === '')
    throw new CalendarError('JY0001', `a zone is a non-empty name, not ${typeof zone === 'string' ? "''" : typeof zone}`, '/zone');
  return zone;
}

/**
 * The identity a resolution records: the provider's own, or
 * `'unrecorded'` for one that names none.
 * @param {any} provider
 * @returns {{ readonly name: string, readonly revision: string }}
 */
export function identityOf(provider) {
  const identity = provider.identity;
  if (identity === undefined)
    return UNRECORDED;
  if (identity === null || typeof identity !== 'object'
    || typeof identity.name !== 'string' || identity.name === ''
    || typeof identity.revision !== 'string' || identity.revision === '') {
    throw new CalendarError('JY0004', 'the provider\'s identity is not { name, revision } with non-empty strings', '/provider/identity');
  }
  return Object.isFrozen(identity) ? identity : Object.freeze({ name: identity.name, revision: identity.revision });
}

/**
 * Whether a provider knows a zone, asked through `toParts` at one
 * instant: an unknown name throws there. A provider whose data does not
 * reach that instant (`JY0024`, a compiled VTIMEZONE's horizon) knows
 * the zone all the same.
 * @param {any} provider
 * @param {string} zone
 * @returns {boolean}
 */
export function providerKnows(provider, zone) {
  try {
    provider.toParts(0, zone);
    return true;
  }
  catch (error) {
    return error instanceof CalendarError && error.code === 'JY0024';
  }
}

/**
 * Refuse a provider that lacks `member`.
 * @param {any} provider
 * @param {'candidates' | 'toParts'} member
 * @returns {any}
 */
export function admitProvider(provider, member) {
  if (provider === null || typeof provider !== 'object' || typeof provider[member] !== 'function') {
    throw new CalendarError('JY0004', `the provider has no ${member}(${member === 'toParts' ? 'epoch' : 'parts'}, zone)`
      + (member === 'candidates' ? '; classification never guesses through toEpoch' : ''), '/provider');
  }
  return provider;
}

/** @param {unknown} value @returns {boolean} */
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Ask the provider, and hold its answer to the seam's shape.
 * @param {any} provider
 * @param {ReturnType<typeof admitParts>} wall
 * @param {string} zone
 * @returns {LocalClassification}
 */
function classify(provider, wall, zone) {
  let answer;
  try {
    answer = provider.candidates(wall, zone);
  }
  catch (error) {
    // a provider that refuses in this layer's own terms (a compiled
    // VTIMEZONE asked outside its horizon) is passed through as it is
    if (error instanceof CalendarError)
      throw error;
    if (!providerKnows(provider, zone))
      throw new CalendarError('JY0001', `the provider does not know the zone '${zone}'`, '/zone', error);
    throw new CalendarError('JY0004', `the provider's candidates(parts, '${zone}') threw`, '/provider', error);
  }
  const list = answer?.candidates;
  const malformed = (why) => new CalendarError('JY0004', `the provider's candidates(parts, '${zone}') ${why}`, '/provider');
  if (!Array.isArray(list) || list.length > 2)
    throw malformed('answered no { candidates } list of at most two instants');
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (entry === null || typeof entry !== 'object' || !finite(entry.instant) || !finite(entry.offsetMinutes))
      throw malformed('answered a candidate that is not { instant, offsetMinutes } with finite numbers');
    if (i > 0 && !(entry.instant > list[i - 1].instant))
      throw malformed('answered candidates out of ascending order');
  }
  const offsets = answer.offsets;
  const hasOffsets = offsets !== null && typeof offsets === 'object'
    && finite(offsets.before) && finite(offsets.after);
  if (list.length === 1)
    return Object.freeze({ kind: 'exists', candidates: freezeList(list) });
  if (list.length === 0 && !hasOffsets)
    throw malformed('answered a gap without the offsets { before, after } either side of it');
  const kind = list.length === 0 ? 'gap' : 'fold';
  return Object.freeze({
    kind,
    candidates: freezeList(list),
    offsets: hasOffsets
      ? Object.freeze({ before: offsets.before, after: offsets.after })
      : Object.freeze({ before: list[0].offsetMinutes, after: list[1].offsetMinutes }),
  });
}

/**
 * @param {ReadonlyArray<{ instant: number, offsetMinutes: number }>} list
 * @returns {ReadonlyArray<LocalCandidate>}
 */
function freezeList(list) {
  return Object.freeze(list.map((entry) => (Object.isFrozen(entry)
    ? entry : Object.freeze({ instant: entry.instant, offsetMinutes: entry.offsetMinutes }))));
}

/**
 * Refuse a missing policy and one that is not named in
 * {@link RESOLUTION_POLICIES}: resolution has no default.
 * @param {unknown} policy
 * @returns {'rfc5545' | 'later' | 'reject'}
 */
export function admitPolicy(policy) {
  if (policy === undefined || policy === null)
    throw new CalendarError('JY0006', `a policy is required: one of ${RESOLUTION_POLICIES.join(', ')}`, '/policy');
  if (typeof policy !== 'string' || !RESOLUTION_POLICIES.includes(policy))
    throw new CalendarError('JY0005', `the policy is one of ${RESOLUTION_POLICIES.join(', ')}, not ${String(policy)}`, '/policy');
  return /** @type {'rfc5545' | 'later' | 'reject'} */ (policy);
}

/**
 * Whether a local time exists in a zone, falls in a gap (it never
 * happened) or in a fold (it happened twice), with every instant it
 * names.
 *
 * The provider must carry the optional `candidates(parts, zone)` member
 * (`createIntlZoneProvider` from `@jarenjs/locales/intl-zones` does); a
 * provider with only `toEpoch` is refused rather than guessed through,
 * since `toEpoch` cannot say which case it met.
 *
 * @param {LocalParts} parts - the civil date and time of day
 * @param {string} zone - a zone name the provider knows
 * @param {import('../series/zone.js').ZoneProvider} provider
 * @returns {LocalClassification}
 * @throws {CalendarError} `JY0007` for parts that are not a real date and
 *   time of day, `JY0001` for a zone the provider does not know, `JY0004`
 *   for a provider without `candidates` or with a malformed answer
 * @example
 * const provider = createIntlZoneProvider();
 * classifyLocal({ year: 2026, month: 3, day: 29, hours: 2, minutes: 30 }, 'Europe/Amsterdam', provider);
 * // { kind: 'gap', candidates: [], offsets: { before: 60, after: 120 } }
 */
export function classifyLocal(parts, zone, provider) {
  const wall = admitParts(parts);
  const name = admitZoneName(zone);
  return classify(admitProvider(provider, 'candidates'), wall, name);
}

/**
 * The instant a local time names in a zone, under a policy the caller
 * names (see {@link RESOLUTION_POLICIES}); there is no default. The
 * answer records how it was reached, so a caller can store which case
 * occurred and which zone data decided it.
 *
 * @param {LocalParts} parts - the civil date and time of day
 * @param {string} zone - a zone name the provider knows
 * @param {{ provider: import('../series/zone.js').ZoneProvider,
 *   policy: 'rfc5545' | 'later' | 'reject' }} options
 * @returns {{ instant: number, resolution: Resolution }}
 * @throws {CalendarError} `JY0006` without a policy, `JY0005` for an
 *   unknown one, `JY0002` / `JY0003` for a gap / fold under `reject`, and
 *   what {@link classifyLocal} throws
 * @example
 * const provider = createIntlZoneProvider({ revision: '2026e' });
 * resolveLocal({ year: 2026, month: 10, day: 25, hours: 2, minutes: 30 }, 'Europe/Amsterdam',
 *   { provider, policy: 'rfc5545' });
 * // { instant: Date.parse('2026-10-25T00:30:00Z'), resolution: { kind: 'fold', policy: 'rfc5545',
 * //   zone: 'Europe/Amsterdam', offsetMinutes: 120, provider: { name: 'intl', revision: '2026e' } } }
 */
export function resolveLocal(parts, zone, options) {
  const policy = admitPolicy(options?.policy);
  const wall = admitParts(parts);
  const name = admitZoneName(zone);
  const provider = admitProvider(options.provider, 'candidates');
  const identity = identityOf(provider);
  const found = classify(provider, wall, name);
  let instant;
  let offsetMinutes;
  if (found.kind === 'exists') {
    ({ instant, offsetMinutes } = found.candidates[0]);
  }
  else if (policy === 'reject') {
    throw found.kind === 'gap'
      ? new CalendarError('JY0002', `${describe(wall)} never happens in '${name}': the clock moves from ${
        formatOffset(offsetsOf(found).before)} to ${formatOffset(offsetsOf(found).after)}`, '/parts')
      : new CalendarError('JY0003', `${describe(wall)} happens twice in '${name}': at ${
        formatOffset(offsetsOf(found).before)} and again at ${formatOffset(offsetsOf(found).after)}`, '/parts');
  }
  else if (found.kind === 'fold') {
    ({ instant, offsetMinutes } = found.candidates[policy === 'later' ? 1 : 0]);
  }
  else {
    // both policies read a gap with the offset before the change, which
    // lands as far past the gap as the time stood into it
    const offsets = offsetsOf(found);
    instant = wallAsUtc(wall) - offsets.before * MINUTE;
    offsetMinutes = offsets.after;
  }
  return Object.freeze({
    instant,
    resolution: Object.freeze({ kind: found.kind, policy, zone: name, offsetMinutes, provider: identity }),
  });
}

/**
 * The wall clock read as if it were UTC, in epoch milliseconds - the
 * civil day number times a day plus the time of day, the reading the
 * Intl provider's probe starts from (and without the RFC 3339 module,
 * which a Node process would load the core root for).
 * @param {ReturnType<typeof admitParts>} wall
 * @returns {number}
 */
function wallAsUtc(wall) {
  const whole = Math.floor(wall.seconds);
  return daysFromCivil(wall.year, wall.month, wall.day) * DAY
    + ((wall.hours * 60 + wall.minutes) * 60 + whole) * 1000 + Math.round((wall.seconds - whole) * 1000);
}

/**
 * The offsets either side of a gap or fold (always present there).
 * @param {LocalClassification} found
 * @returns {{ readonly before: number, readonly after: number }}
 */
const offsetsOf = (found) => /** @type {{ readonly before: number, readonly after: number }} */ (found.offsets);

/** `+02:00` / `-05:30` / `+10:30`, for a message. @param {number} minutes @returns {string} */
function formatOffset(minutes) {
  const abs = Math.abs(minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** @param {ReturnType<typeof admitParts>} wall @returns {string} */
function describe(wall) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hours)}:${pad(wall.minutes)}:${
    pad(Math.floor(wall.seconds))}`;
}
//#endregion
