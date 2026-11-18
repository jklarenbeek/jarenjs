//@ts-check

//#region Zone definitions (VTIMEZONE) both ways
// RFC 5545 §3.6.5 carries a zone inside the file: STANDARD and DAYLIGHT
// observances, each an onset (DTSTART, a wall clock in the offset it
// changes FROM), the offsets either side, and more onsets by RRULE or
// RDATE. `compileVtimezone` turns that definition into a zone provider
// (the seam's `toParts`, `toEpoch`, `candidates` and `identity`) over an
// explicit horizon; `vtimezoneFor` writes the definition a provider
// answers over a horizon, as onsets by RDATE only.
//
// The definition is neutral JSON (no iCalendar syntax): the iCalendar
// reader maps a parsed VTIMEZONE onto it and the writer renders it.
// Outside its horizon the compiled provider refuses (`JY0024`), never
// guesses; a definition that contradicts itself (two offsets at one
// instant, changes that overlap) is refused whole (`JY0023`); a walk stopped by a limit narrows the horizon and says so.

import { partsFromEpoch, daysFromCivil } from '../dates/civil.js';
import { epochOfRFC3339Parts } from '../dates/rfc3339.js';
import { hashContent } from '../string.js';
import { CalendarError } from './errors.js';
import { floatingValue, parseTemporal } from './model.js';
import { admitKeys, compileRecurrence, expandRecurrence, isRecord } from './recurrence.js';
import { admitProvider, admitZoneName, providerOf } from './resolve.js';
import { readRRule } from './rrule.js';

const SECOND = 1000;
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
/** Wider than any offset either way: the span a wall clock's instants lie in. */
const REACH = 26 * HOUR;
/** The first lookback for an observance's last onset before the horizon. */
const LOOKBACK = 400 * DAY;

/**
 * The limits a compilation stops at when the caller names none.
 * - `maxObservances`: STANDARD and DAYLIGHT blocks; past it the
 *   definition is refused (`JY0025`) before any walk.
 * - `maxTransitions`: onsets kept (DTSTART, RDATE and RRULE ones);
 *   past it the horizon ends at the last one kept, `complete: false` (`status: 'incomplete'`).
 * - `maxWork`: the recurrence engine's work over every RRULE; past it
 *   likewise.
 * - `maxProviderCalls`: `vtimezoneFor`'s calls to `toParts`; past it the
 *   write is refused (`JY0025`).
 * @type {Readonly<{ maxObservances: number, maxTransitions: number, maxWork: number, maxProviderCalls: number }>}
 */
export const VTIMEZONE_LIMITS = /* @__PURE__ */ Object.freeze({
  maxObservances: 1000,
  maxTransitions: 100000,
  maxWork: 1000000,
  maxProviderCalls: 1000000,
});

/**
 * One STANDARD or DAYLIGHT block. `type` is kept for writing: the
 * instants never depend on it.
 * @typedef {Object} VtimezoneObservance
 * @property {'standard' | 'daylight'} type
 * @property {string} start - DTSTART, the first onset: a wall clock
 *   `YYYY-MM-DDTHH:MM:SS` in the offset it changes from
 * @property {string} offsetFrom - TZOFFSETFROM, `+HH:MM` or `+HH:MM:SS`
 * @property {string} offsetTo - TZOFFSETTO, likewise
 * @property {string | import('./rrule.js').RRuleJson} [rrule] - more
 *   onsets by rule; its UNTIL is UTC (RFC 5545) or a wall clock
 * @property {readonly string[]} [rdates] - more onsets: wall clocks in
 *   `offsetFrom`, or UTC instants `YYYY-MM-DDTHH:MM:SSZ`
 * @property {string} [name] - TZNAME, informational
 */

/**
 * A zone definition: what a VTIMEZONE holds, as neutral JSON.
 * @typedef {Object} VtimezoneDefinition
 * @property {string} tzid - TZID, the name its references use
 * @property {readonly VtimezoneObservance[]} observances - at least one
 * @property {string} [until] - TZUNTIL (RFC 7808): the UTC instant
 *   `YYYY-MM-DDTHH:MM:SSZ` where the definition stops being valid
 */

/**
 * A change of offset: at the instant `at` the offset goes from `before`
 * to `after` (minutes east).
 * @typedef {{ readonly at: number, readonly before: number, readonly after: number }} ZoneTransition
 */

/**
 * The provider a definition compiles to: the seam's members, and what
 * it was compiled from and over.
 * @typedef {Object} CompiledZone
 * @property {(epoch: number, zone: string) => any} toParts
 * @property {(parts: any, zone: string, disambiguation?: string) => number} toEpoch
 * @property {(parts: any, zone: string) => import('../series/zone.js').ZoneCandidates} candidates
 * @property {{ readonly name: string, readonly revision: string }} identity - the TZID, and a hash of the definition
 * @property {string} tzid
 * @property {{ readonly start: number, readonly end: number }} horizon - epoch milliseconds, `[start, end)`; outside it every call refuses
 * @property {'complete' | 'incomplete'} status - `incomplete` when a limit ended the horizon early;
 *   the older spelling of `complete`
 * @property {boolean} complete - no limit ended the horizon early
 * @property {'maxTransitions' | 'maxWork'} [limit] - what ended it
 * @property {{ readonly limit: 'maxTransitions' | 'maxWork' }} [stoppedAt] - an incomplete
 *   compilation only: the limit that ended the horizon, as `limit`
 * @property {{ readonly observances: number, readonly transitions: number, readonly work: number }} counts
 * @property {readonly ZoneTransition[]} transitions - the changes inside the horizon, in order
 * @property {number} initial - the offset in force at the horizon's start, minutes east
 */

/** @param {number} n @param {number} [width] */
const pad = (n, width = 2) => String(n).padStart(width, '0');

const WALL_FORM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z?)$/;
const OFFSET_FORM = /^([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A wall clock or UTC instant as milliseconds (a wall read as if UTC).
 * @param {unknown} text
 * @param {string} path
 * @returns {{ at: number, utc: boolean }}
 */
function readWall(text, path) {
  const form = typeof text === 'string' ? WALL_FORM.exec(text) : null;
  const bad = () => new CalendarError('JY0022', `a time is YYYY-MM-DDTHH:MM:SS (Z for UTC) on a real civil date, not ${JSON.stringify(text) ?? String(text)}`, path);
  if (form === null)
    throw bad();
  const [year, month, day, hours, minutes, seconds] = form.slice(1, 7).map(Number);
  const at = daysFromCivil(year, month, day) * DAY + ((hours * 60 + minutes) * 60 + seconds) * SECOND;
  const back = partsFromEpoch(at);
  if (back.year !== year || back.month !== month || back.day !== day || hours > 23 || minutes > 59 || seconds > 59)
    throw bad();
  return { at, utc: form[7] === 'Z' };
}

/**
 * Milliseconds as the wall clock text `YYYY-MM-DDTHH:MM:SS`.
 * @param {number} at
 * @returns {string}
 */
function formatWall(at) {
  const p = partsFromEpoch(at);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hours)}:${pad(p.minutes)}:${pad(Math.floor(p.seconds))}`;
}

/**
 * A UTC offset `+HH:MM[:SS]` as milliseconds east; `-00:00` is refused,
 * as RFC 5545 §3.3.14 refuses `-0000`.
 * @param {unknown} text
 * @param {string} path
 * @returns {number}
 */
function readOffset(text, path) {
  const form = typeof text === 'string' ? OFFSET_FORM.exec(text) : null;
  if (form === null || Number(form[2]) > 23 || Number(form[3]) > 59 || Number(form[4] ?? 0) > 59)
    throw new CalendarError('JY0022', `an offset is +HH:MM or +HH:MM:SS, hours to 23, not ${JSON.stringify(text) ?? String(text)}`, path);
  const ms = ((Number(form[2]) * 60 + Number(form[3])) * 60 + Number(form[4] ?? 0)) * SECOND;
  if (ms === 0 && form[1] === '-')
    throw new CalendarError('JY0022', `the offset ${text} is not allowed; zero is +00:00`, path);
  return form[1] === '-' ? -ms : ms;
}

/**
 * Milliseconds east as the offset text `+HH:MM` (`+HH:MM:SS` when the
 * seconds are not zero).
 * @param {number} ms
 * @returns {string}
 */
function formatOffset(ms) {
  const sign = ms < 0 ? '-' : '+';
  const whole = Math.round(Math.abs(ms) / SECOND);
  const s = whole % 60;
  const text = `${sign}${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}`;
  return s === 0 ? text : `${text}:${pad(s)}`;
}

/**
 * The horizon `[start, end)`: utc values or epoch milliseconds.
 * @param {unknown} horizon
 * @param {string} path
 * @returns {{ low: number, high: number }}
 */
function admitHorizon(horizon, path) {
  if (!Array.isArray(horizon) || horizon.length !== 2)
    throw new CalendarError('JY0014', 'a horizon is [start, end): two utc values or epoch milliseconds', path);
  const [low, high] = horizon.map((bound, i) => {
    if (typeof bound === 'number') {
      if (!Number.isSafeInteger(bound))
        throw new CalendarError('JY0014', `a horizon bound is whole epoch milliseconds, not ${bound}`, `${path}/${i}`);
      return bound;
    }
    let value;
    try {
      value = /** @type {any} */ (parseTemporal(/** @type {any} */ (bound)));
    }
    catch (error) {
      throw new CalendarError('JY0014', 'a horizon bound is a utc value or epoch milliseconds', `${path}/${i}`, error);
    }
    if (value.kind !== 'utc')
      throw new CalendarError('JY0014', `a horizon bound is a utc value or epoch milliseconds, not a ${value.kind} value`, `${path}/${i}`);
    return Date.parse(value.instant);
  });
  if (!(high > low))
    throw new CalendarError('JY0014', 'the horizon ends after it starts', `${path}/1`);
  return { low, high };
}

/**
 * The limits, each a whole number from 1 or the default.
 * @param {unknown} limits
 * @returns {typeof VTIMEZONE_LIMITS}
 */
function admitLimits(limits) {
  if (limits === undefined)
    return VTIMEZONE_LIMITS;
  if (!isRecord(limits))
    throw new CalendarError('JY0014', 'limits are { maxObservances?, maxTransitions?, maxWork?, maxProviderCalls? }', '/options/limits');
  admitKeys(limits, Object.keys(VTIMEZONE_LIMITS), '/options/limits', 'the zone limits');
  /** @type {Record<string, number>} */
  const out = { ...VTIMEZONE_LIMITS };
  for (const [name, value] of Object.entries(limits)) {
    if (value === undefined)
      continue;
    if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1)
      throw new CalendarError('JY0014', `${name} is a whole number from 1, not ${String(value)}`, `/options/limits/${name}`);
    out[name] = /** @type {number} */ (value);
  }
  return /** @type {any} */ (out);
}

/**
 * @typedef {{ type: 'standard' | 'daylight', start: number, from: number, to: number,
 *   rule: any, rdates: { at: number, utc: boolean }[], name?: string }} Observance
 */

/**
 * Check a definition and read it into milliseconds; the canonical JSON
 * of what was read is its revision's source.
 * @param {unknown} definition
 * @param {typeof VTIMEZONE_LIMITS} limits
 * @returns {{ tzid: string, observances: Observance[], until: number | undefined, canonical: string }}
 */
function admitDefinition(definition, limits) {
  if (!isRecord(definition))
    throw new CalendarError('JY0022', 'a zone definition is { tzid, observances, until? }', '');
  admitKeys(definition, ['tzid', 'observances', 'until'], '', 'a zone definition');
  const { tzid, observances } = definition;
  if (typeof tzid !== 'string' || tzid === '' || /\p{Cc}/u.test(tzid))
    throw new CalendarError('JY0022', 'a zone definition names its TZID: a non-empty string without control characters', '/tzid');
  if (!Array.isArray(observances) || observances.length === 0)
    throw new CalendarError('JY0022', `the zone definition of '${tzid}' holds no STANDARD or DAYLIGHT observance`, '/observances');
  if (observances.length > limits.maxObservances)
    throw new CalendarError('JY0025', `the zone definition of '${tzid}' holds ${observances.length} observances, past maxObservances (${limits.maxObservances})`, '/observances');
  let until;
  if (definition.until !== undefined) {
    const read = readWall(definition.until, '/until');
    if (!read.utc)
      throw new CalendarError('JY0022', 'until (TZUNTIL) is a UTC instant YYYY-MM-DDTHH:MM:SSZ', '/until');
    until = read.at;
  }
  const read = observances.map((entry, i) => {
    const at = `/observances/${i}`;
    if (!isRecord(entry))
      throw new CalendarError('JY0022', 'an observance is { type, start, offsetFrom, offsetTo, rrule?, rdates?, name? }', at);
    admitKeys(entry, ['type', 'start', 'offsetFrom', 'offsetTo', 'rrule', 'rdates', 'name'], at, 'an observance');
    if (entry.type !== 'standard' && entry.type !== 'daylight')
      throw new CalendarError('JY0022', `an observance's type is 'standard' or 'daylight', not ${String(entry.type)}`, `${at}/type`);
    const start = readWall(entry.start, `${at}/start`);
    if (start.utc)
      throw new CalendarError('JY0022', 'an observance starts at a wall clock (no Z): its onset in the offset it changes from', `${at}/start`);
    const from = readOffset(entry.offsetFrom, `${at}/offsetFrom`);
    const to = readOffset(entry.offsetTo, `${at}/offsetTo`);
    const rdates = entry.rdates ?? [];
    if (!Array.isArray(rdates))
      throw new CalendarError('JY0022', 'rdates is a list of wall clocks or UTC instants', `${at}/rdates`);
    const onsets = rdates.map((text, j) => readWall(text, `${at}/rdates/${j}`));
    let rule = null;
    if (entry.rrule !== undefined)
      rule = ruleOf(entry.rrule, start.at, from, `${at}/rrule`);
    if (entry.name !== undefined && typeof entry.name !== 'string')
      throw new CalendarError('JY0022', 'name (TZNAME) is a string', `${at}/name`);
    /** @type {Observance} */
    const observance = { type: entry.type, start: start.at, from, to, rule, rdates: onsets };
    if (entry.name !== undefined)
      observance.name = entry.name;
    return observance;
  });
  const canonical = JSON.stringify([tzid, until ?? null, read.map((o) => [o.type, o.start, o.from, o.to,
    o.rule === null ? null : o.rule.text, o.rdates.map((r) => `${r.at}${r.utc ? 'Z' : ''}`), o.name ?? null])]);
  return { tzid, observances: read, until, canonical };
}

/**
 * An observance's rule, compiled over its DTSTART as a wall clock. RFC
 * 5545 writes its UNTIL in UTC; the onset it bounds is a wall clock in
 * `from`, so UNTIL is moved onto that clock first.
 * @param {unknown} rrule
 * @param {number} start
 * @param {number} from
 * @param {string} path
 * @returns {{ compiled: any, text: string }}
 */
function ruleOf(rrule, start, from, path) {
  try {
    let rule = /** @type {any} */ (readRRule(rrule));
    if (rule.UNTIL?.kind === 'utc') {
      const wall = formatWall(Date.parse(rule.UNTIL.instant) + from);
      rule = { ...rule, UNTIL: { kind: 'floating', date: wall.slice(0, 10), time: wall.slice(11) } };
    }
    const wall = formatWall(start);
    const compiled = compileRecurrence({ dtstart: floatingValue(wall.slice(0, 10), wall.slice(11)), rrule: rule });
    return { compiled, text: JSON.stringify(rule) };
  }
  catch (error) {
    if (error instanceof CalendarError)
      throw new CalendarError('JY0022', `the observance's RRULE: ${error.code} ${error.reason}`, path, error);
    throw error;
  }
}

/**
 * A floating value at a wall clock in milliseconds.
 * @param {number} at
 */
const floatingAt = (at) => {
  const wall = formatWall(at);
  return floatingValue(wall.slice(0, 10), wall.slice(11));
};

/**
 * The onsets an observance's rule makes whose instants lie in `[low,
 * high)`, under the shared budget.
 * @param {Observance} observance
 * @param {number} low
 * @param {number} high
 * @param {{ work: number, transitions: number }} budget
 * @returns {{ instants: number[], stopped?: 'maxTransitions' | 'maxWork' }}
 */
function ruleOnsets(observance, low, high, budget) {
  const lowWall = Math.max(low + observance.from, observance.start);
  const highWall = high + observance.from;
  if (!(highWall > lowWall))
    return { instants: [] };
  const expansion = expandRecurrence(observance.rule.compiled, {
    horizon: [floatingAt(lowWall), floatingAt(highWall)],
    limits: {
      maxWork: Math.max(budget.work, 1),
      maxOccurrences: budget.transitions + 1,
      maxHorizonDays: Math.ceil((highWall - lowWall) / DAY) + 2,
    },
  });
  budget.work -= expansion.counts.work;
  const instants = expansion.occurrences.map((occurrence) => {
    const start = /** @type {any} */ (occurrence.start);
    return readWall(`${start.date}T${start.time}`, '').at - observance.from;
  });
  if (expansion.status === 'complete')
    return { instants };
  return { instants, stopped: expansion.limit === 'maxOccurrences' ? 'maxTransitions' : 'maxWork' };
}

/**
 * Compile a zone definition (a VTIMEZONE as neutral JSON) into a zone
 * provider over a horizon. Each observance's onsets are its DTSTART, its
 * RDATEs and what its RRULE makes (through the recurrence engine, under
 * `limits`); each onset is a wall clock in the observance's
 * `offsetFrom` (an RDATE may be a UTC instant) and sets `offsetTo` from
 * there on. Before the earliest onset the definition says nothing, so the
 * horizon starts there at the latest.
 *
 * - The provider answers `toParts`, `toEpoch` and `candidates` exactly as
 *   the Intl provider shapes them (frozen, a fold's and a gap's `offsets`
 *   either side) for the definition's TZID alone; another name is a
 *   `TypeError`, as an unknown zone is. It also lists its changes:
 *   `offsetChanges(from, to, zone)` answers every change with
 *   `from <= at <= to`, which a sub-daily expansion reads to pass a
 *   wall-clock hour with no change in one step.
 * - Outside `horizon` (narrowed by the earliest onset, by `until` and by a limit) every call
 *   refuses with `JY0024`; a wall clock within a day of either end is
 *   outside too, since its instants could lie past it.
 * - `identity` is `{ name: tzid, revision }`, the revision a hash of the
 *   definition: a stored instant can name the definition it came from.
 * - `type` (STANDARD or DAYLIGHT) and `name` (TZNAME) change no instant.
 *
 * @param {VtimezoneDefinition} definition
 * @param {{ horizon: [unknown, unknown], limits?: Partial<typeof VTIMEZONE_LIMITS> }} options - `horizon`:
 *   `[start, end)` as utc values or epoch milliseconds
 * @returns {CompiledZone}
 * @throws {CalendarError} `JY0022` for a definition of the wrong form (an
 *   observance's RRULE refused by the recurrence layer is its cause),
 *   `JY0023` for one that contradicts itself (two onsets at one instant
 *   with different offsets, or changes whose wall-clock spans overlap), `JY0025` past
 *   `maxObservances`, `JY0014` for the options
 * @example
 * const zone = compileVtimezone({ tzid: 'Europe/Amsterdam', observances: [
 *   { type: 'daylight', start: '1981-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00', rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU' },
 *   { type: 'standard', start: '1996-10-27T03:00:00', offsetFrom: '+02:00', offsetTo: '+01:00', rrule: 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU' },
 * ] }, { horizon: [Date.UTC(2000, 0, 1), Date.UTC(2041, 0, 1)] });
 * resolveLocal({ year: 2026, month: 3, day: 29, hours: 2, minutes: 30 }, 'Europe/Amsterdam', { provider: zone, policy: 'rfc5545' }).resolution.kind; // 'gap'
 */
export function compileVtimezone(definition, options) {
  if (!isRecord(options))
    throw new CalendarError('JY0014', 'options are { horizon, limits? }', '/options');
  admitKeys(options, ['horizon', 'limits'], '/options', 'compileVtimezone');
  const { low, high } = admitHorizon(options.horizon, '/options/horizon');
  const limits = admitLimits(options.limits);
  const { tzid, observances, until, canonical } = admitDefinition(definition, limits);
  const budget = { work: limits.maxWork, transitions: limits.maxTransitions };
  let reach = until === undefined ? high : Math.min(high, until);
  /** @type {'maxTransitions' | 'maxWork' | undefined} */
  let limit;
  const stop = (/** @type {'maxTransitions' | 'maxWork'} */ why, /** @type {number} */ at) => {
    limit ??= why;
    reach = Math.min(reach, at);
  };

  /** @type {{ at: number, from: number, to: number, index: number }[]} */
  const inside = [];
  /** @type {{ at: number, from: number, to: number, index: number } | null} */
  let prior = null;
  /** @type {{ at: number, from: number, to: number, index: number }} */
  let earliest = /** @type {any} */ (null);
  for (const [index, observance] of observances.entries()) {
    const { from, to } = observance;
    const seen = new Set();
    const take = (/** @type {number} */ at) => {
      if (seen.has(at))
        return;
      seen.add(at);
      const onset = { at, from, to, index };
      if (earliest === null || at < earliest.at)
        earliest = onset;
      if (at < low) {
        if (prior !== null && at === prior.at && to !== prior.to)
          conflict(tzid, at, prior.index, index);
        if (prior === null || at > prior.at)
          prior = onset;
        return;
      }
      if (at >= high)
        return;
      if (budget.transitions <= 0) {
        stop('maxTransitions', at);
        return;
      }
      budget.transitions--;
      inside.push(onset);
    };
    take(observance.start - from);
    for (const rdate of observance.rdates)
      take(rdate.utc ? rdate.at : rdate.at - from);
    if (observance.rule === null)
      continue;
    const found = ruleOnsets(observance, low, reach, budget);
    found.instants.forEach(take);
    if (found.stopped !== undefined)
      stop(found.stopped, found.instants.length > 0 ? found.instants[found.instants.length - 1] : low);
    // the onset in force as the horizon starts: look back in widening
    // windows until one is found or the observance's DTSTART is passed
    for (let span = LOOKBACK; observance.start - from < low; span *= 4) {
      const back = ruleOnsets(observance, Math.max(low - span, observance.start - from), low, budget);
      back.instants.forEach(take);
      if (back.stopped !== undefined)
        stop(back.stopped, low);
      if (back.instants.length > 0 || low - span <= observance.start - from)
        break;
    }
  }
  // before its earliest onset a definition says nothing (RFC 5545 §3.6.5:
  // its second example is valid only from its earliest onset), so the
  // horizon starts there
  const start = prior === null ? Math.min(Math.max(low, earliest.at), reach) : low;
  const end = Math.max(start, reach);
  inside.sort((a, b) => a.at - b.at || a.index - b.index);
  let current = prior === null ? earliest.to : prior.to;
  const initial = current;
  /** @type {ZoneTransition[]} */
  const transitions = [];
  let last = prior ?? earliest;
  for (const onset of inside) {
    if (onset.at >= end)
      break;
    if (last !== null && last.at === onset.at) {
      if (last.to !== onset.to)
        conflict(tzid, onset.at, last.index, onset.index);
      continue;
    }
    // TZOFFSETFROM places the onset; it need not be the offset in force
    // (RFC 5545's own examples keep a STANDARD rule after DAYLIGHT ends)
    if (onset.to !== current) {
      const previous = transitions[transitions.length - 1];
      const change = { at: onset.at, before: current / MINUTE, after: onset.to / MINUTE };
      if (previous !== undefined && spanOf(previous)[1] > spanOf(change)[0]) {
        throw new CalendarError('JY0023', `the zone '${tzid}' changes at ${new Date(previous.at).toISOString()} and again at `
          + `${new Date(onset.at).toISOString()}, before the wall clock of the first change has passed`, `/observances/${onset.index}`);
      }
      transitions.push(Object.freeze(change));
    }
    current = onset.to;
    last = onset;
  }
  return zoneProvider(tzid, Object.freeze(transitions), initial, start, end, {
    revision: hashContent(canonical),
    status: limit === undefined ? 'complete' : 'incomplete',
    limit,
    counts: Object.freeze({ observances: observances.length, transitions: transitions.length, work: limits.maxWork - Math.max(budget.work, 0) }),
  });
}

/**
 * Refuse two onsets at one instant with different offsets.
 * @param {string} tzid
 * @param {number} at
 * @param {number} a
 * @param {number} b
 * @returns {never}
 */
function conflict(tzid, at, a, b) {
  throw new CalendarError('JY0023', `the zone '${tzid}' has two onsets at ${new Date(at).toISOString()} with different offsets `
    + `(observances ${Math.min(a, b)} and ${Math.max(a, b)})`, `/observances/${Math.max(a, b)}`);
}

/**
 * The wall-clock span a change touches: `[at + min, at + max)` of its
 * two offsets, a gap's or a fold's.
 * @param {ZoneTransition} change
 * @returns {[number, number]}
 */
function spanOf(change) {
  return [change.at + Math.min(change.before, change.after) * MINUTE, change.at + Math.max(change.before, change.after) * MINUTE];
}

/** What a caller may ask for when a local time is ambiguous or absent (the seam's spellings). */
const DISAMBIGUATION = Object.freeze(['reject', 'earlier', 'later']);

/**
 * The wall clock a caller asked for: an absent or negative time member
 * is midnight's, as the Intl provider reads it.
 * @param {any} parts
 */
function wantedWall(parts) {
  const clamp = (/** @type {unknown} */ value) => (typeof value === 'number' && value > 0 ? value : 0);
  return { year: parts.year, month: parts.month, day: parts.day, hours: clamp(parts.hours), minutes: clamp(parts.minutes), seconds: clamp(parts.seconds) };
}

/**
 * The provider over a table of changes.
 * @param {string} tzid
 * @param {readonly ZoneTransition[]} transitions
 * @param {number} initial - milliseconds east before the first change
 * @param {number} low
 * @param {number} end
 * @param {{ revision: string, status: 'complete' | 'incomplete', limit: 'maxTransitions' | 'maxWork' | undefined,
 *   counts: CompiledZone['counts'] }} about
 * @returns {CompiledZone}
 */
function zoneProvider(tzid, transitions, initial, low, end, about) {
  const known = (/** @type {unknown} */ zone) => {
    if (zone !== tzid)
      throw new TypeError(`'${String(zone)}' is not the zone this definition compiles ('${tzid}')`);
  };
  const outside = (/** @type {string} */ what) => new CalendarError('JY0024',
    `${what} lies outside the horizon the definition of '${tzid}' was compiled over `
    + `(${new Date(low).toISOString()} to ${new Date(end).toISOString()})`, '/provider');
  // offsets are kept in milliseconds, so a historical offset with seconds
  // (-04:56:02) never meets a rounding error on its way to an instant
  const afterMs = transitions.map((change) => Math.round(change.after * MINUTE));
  /** How many changes lie at or before an instant. @param {number} at */
  const indexAt = (at) => {
    let lo = 0;
    let hi = transitions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (transitions[mid].at <= at)
        lo = mid + 1;
      else
        hi = mid;
    }
    return lo;
  };
  /** The offset in force at an instant, in milliseconds east. @param {number} at */
  const offsetAt = (at) => {
    const i = indexAt(at);
    return i === 0 ? initial : afterMs[i - 1];
  };

  /**
   * The instants that carry a wall clock, and the change around it.
   * @param {any} parts
   */
  const placed = (parts) => {
    if (parts === null || typeof parts !== 'object')
      throw new TypeError('a wall clock is a parts record');
    const wanted = wantedWall(parts);
    const wall = epochOfRFC3339Parts({ ...wanted, offset: 0 });
    if (!Number.isFinite(wall))
      throw new TypeError('the wall clock names no instant this platform can hold');
    const back = partsFromEpoch(wall);
    if (back.year !== wanted.year || back.month !== wanted.month || back.day !== wanted.day || back.hours !== wanted.hours
      || back.minutes !== wanted.minutes || Math.floor(back.seconds) !== Math.floor(wanted.seconds))
      throw new TypeError('the parts are not a civil date and time of day this provider can place');
    if (wall - REACH < low || wall + REACH >= end)
      throw outside(`the wall clock ${formatWall(wall)}`);
    const offsets = new Set([offsetAt(wall - REACH)]);
    for (let i = indexAt(wall - REACH); i < transitions.length && transitions[i].at <= wall + REACH; i++)
      offsets.add(afterMs[i]);
    const found = [...offsets].map((offset) => wall - offset).filter((at) => offsetAt(at) === wall - at).sort((a, b) => a - b);
    return { wall, found };
  };

  /** @param {number} wall */
  const gapAround = (wall) => {
    for (let i = indexAt(wall - REACH); i < transitions.length && transitions[i].at <= wall + REACH; i++) {
      const [from, to] = spanOf(transitions[i]);
      if (transitions[i].after > transitions[i].before && wall >= from && wall < to)
        return { before: i === 0 ? initial : afterMs[i - 1], after: afterMs[i], change: transitions[i] };
    }
    /* c8 ignore next 2 -- a wall clock no instant carries lies in a forward change by construction */
    throw new Error(`no change around ${formatWall(wall)}`);
  };

  /**
   * @param {any} parts
   * @param {string} zone
   */
  function candidates(parts, zone) {
    known(zone);
    const { wall, found } = placed(parts);
    const entry = (/** @type {number} */ at) => Object.freeze({ instant: at, offsetMinutes: (wall - at) / MINUTE });
    const list = Object.freeze(found.map(entry));
    if (list.length === 1)
      return Object.freeze({ candidates: list });
    if (list.length > 1)
      return Object.freeze({ candidates: list, offsets: Object.freeze({ before: list[0].offsetMinutes, after: list[list.length - 1].offsetMinutes }) });
    const { change } = gapAround(wall);
    return Object.freeze({ candidates: list, offsets: Object.freeze({ before: change.before, after: change.after }) });
  }

  /**
   * @param {any} parts
   * @param {string} zone
   * @param {string} [disambiguation]
   */
  function toEpoch(parts, zone, disambiguation = 'reject') {
    known(zone);
    if (!DISAMBIGUATION.includes(disambiguation))
      throw new TypeError(`disambiguation is ${DISAMBIGUATION.map((d) => `'${d}'`).join(', ')}, not '${disambiguation}'`);
    const { wall, found } = placed(parts);
    if (found.length === 1)
      return found[0];
    if (disambiguation === 'reject')
      return NaN;
    if (found.length > 1)
      return disambiguation === 'earlier' ? found[0] : found[found.length - 1];
    const gap = gapAround(wall);
    return wall - (disambiguation === 'earlier' ? gap.after : gap.before);
  }

  /**
   * @param {number} epoch
   * @param {string} zone
   */
  function toParts(epoch, zone) {
    known(zone);
    if (typeof epoch !== 'number' || !Number.isFinite(epoch))
      throw new TypeError(`an instant is a finite number of epoch milliseconds, not ${epoch}`);
    if (epoch < low || epoch >= end)
      throw outside(`the instant ${new Date(epoch).toISOString()}`);
    const offset = offsetAt(epoch);
    const { year, month, day, hours, minutes, seconds } = partsFromEpoch(epoch + offset);
    return { year, month, day, hours, minutes, seconds, offset: offset / MINUTE };
  }

  /**
   * Every change of offset with `from <= at <= to`, as `{ at, before, after }`.
   * @param {number} from
   * @param {number} to
   * @param {string} zone
   */
  function offsetChanges(from, to, zone) {
    known(zone);
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to))
      throw new TypeError('a span of changes is two finite numbers of epoch milliseconds');
    if (from < low || to >= end)
      throw outside(`the span ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`);
    return Object.freeze(transitions.filter((change) => change.at >= from && change.at <= to));
  }

  return Object.freeze({
    toParts,
    toEpoch,
    candidates,
    offsetChanges,
    identity: Object.freeze({ name: tzid, revision: about.revision }),
    tzid,
    horizon: Object.freeze({ start: low, end }),
    status: about.status,
    complete: about.limit === undefined,
    ...(about.limit !== undefined ? { limit: about.limit, stoppedAt: Object.freeze({ limit: about.limit }) } : {}),
    counts: about.counts,
    transitions,
    initial: initial / MINUTE,
  });
}

/**
 * Write the zone definition a provider answers for one zone over a
 * horizon: the offset changes found by a scan of `toParts` one day apart
 * and a bisection to the second inside each day the offset moved, as
 * STANDARD and DAYLIGHT observances whose onsets are RDATEs (never an
 * invented RRULE), and `until` at the horizon's end (TZUNTIL), so a
 * reader never stretches the definition past what the provider said.
 *
 * - Changes are grouped by their two offsets; a group whose offset rises
 *   is DAYLIGHT, one whose offset falls STANDARD (the seam has no DST
 *   flag; the instants do not depend on the name).
 * - The horizon's start is an onset of its own, a STANDARD observance
 *   from and to the offset in force there, since a definition says
 *   nothing before its earliest onset; a zone with no change in the
 *   horizon (UTC) is that observance alone.
 * - Two changes less than a day apart that restore the offset are not
 *   seen by the scan; changes of the IANA database are months apart.
 *
 * @param {string} zone
 * @param {{ horizon: [unknown, unknown], limits?: Partial<typeof VTIMEZONE_LIMITS> }
 *   & import('./resolve.js').ZoneProviderOptions} options - the provider is `zoneProvider` (or
 *   `provider`), else `runtime.zoneProvider`; `horizon`: `[start, end)`, utc values or epoch milliseconds
 * @returns {VtimezoneDefinition} frozen
 * @throws {CalendarError} `JY0001` for a zone the provider does not know,
 *   `JY0004` for a provider without `toParts` or one that answers no
 *   offset, `JY0025` past `maxProviderCalls`, `JY0014` for the options;
 *   a `CalendarError` the provider throws (a compiled definition's
 *   `JY0024`) as it is
 * @example
 * const definition = vtimezoneFor('Europe/Amsterdam', { provider: createIntlZoneProvider(),
 *   horizon: [utcValue('2026-01-01T00:00:00Z'), utcValue('2027-01-01T00:00:00Z')] });
 * definition.observances.map((o) => [o.type, o.start]);
 * // [['daylight', '2026-03-29T02:00:00'], ['standard', '2026-10-25T03:00:00']]
 */
export function vtimezoneFor(zone, options) {
  if (!isRecord(options))
    throw new CalendarError('JY0014', 'options are { zoneProvider (or runtime), horizon, limits? }', '/options');
  admitKeys(options, ['zoneProvider', 'provider', 'runtime', 'horizon', 'limits'], '/options', 'vtimezoneFor');
  const provider = admitProvider(providerOf(options), 'toParts');
  const name = admitZoneName(zone);
  const { low, high } = admitHorizon(options.horizon, '/options/horizon');
  const limits = admitLimits(options.limits);
  let calls = 0;
  /** The offset at an instant, in milliseconds east (to the second). @param {number} at */
  const offset = (at) => {
    if (++calls > limits.maxProviderCalls)
      throw new CalendarError('JY0025', `writing the definition of '${name}' took more than maxProviderCalls (${limits.maxProviderCalls}) calls`, '/options/limits/maxProviderCalls');
    let parts;
    try {
      parts = provider.toParts(at, name);
    }
    catch (error) {
      // a bounded provider's own refusal (a compiled definition's JY0024) is passed through
      if (error instanceof CalendarError)
        throw error;
      if (calls === 1)
        throw new CalendarError('JY0001', `the provider does not know the zone '${name}'`, '/zone', error);
      throw new CalendarError('JY0004', `the provider's toParts(instant, '${name}') threw`, '/provider', error);
    }
    if (parts === null || typeof parts !== 'object' || typeof parts.offset !== 'number' || !Number.isFinite(parts.offset))
      throw new CalendarError('JY0004', `the provider's toParts(instant, '${name}') answers no offset`, '/provider');
    return Math.round(parts.offset * 60) * SECOND;
  };
  const start = Math.ceil(low / SECOND) * SECOND;
  /** @type {{ at: number, before: number, after: number }[]} */
  const changes = [];
  /**
   * Every change in `(lo, hi]` where the offset goes from `a` to `b`.
   * @param {number} lo
   * @param {number} a
   * @param {number} hi
   * @param {number} b
   */
  const changesIn = (lo, a, hi, b) => {
    while (a !== b) {
      let x = lo;
      let y = hi;
      while (y - x > SECOND) {
        const mid = x + Math.floor((y - x) / (2 * SECOND)) * SECOND;
        if (offset(mid) === a)
          x = mid;
        else
          y = mid;
      }
      const after = offset(y);
      changes.push({ at: y, before: a, after });
      lo = y;
      a = after;
    }
  };
  const initial = offset(start);
  let at = start;
  let current = initial;
  while (at < high) {
    const next = Math.min(at + DAY, Math.ceil(high / SECOND) * SECOND - SECOND);
    if (next <= at)
      break;
    const there = offset(next);
    changesIn(at, current, next, there);
    at = next;
    current = there;
  }
  /** @type {Map<string, { type: 'standard' | 'daylight', start: string, offsetFrom: string, offsetTo: string, rdates: string[] }>} */
  const groups = new Map();
  for (const change of changes) {
    const key = `${change.before}/${change.after}`;
    const wall = formatWall(change.at + change.before);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { type: change.after > change.before ? 'daylight' : 'standard', start: wall,
        offsetFrom: formatOffset(change.before), offsetTo: formatOffset(change.after), rdates: [] });
    }
    else
      group.rdates.push(wall);
  }
  const observances = [{ type: 'standard', start: formatWall(start + initial), offsetFrom: formatOffset(initial), offsetTo: formatOffset(initial) },
    ...[...groups.values()].map((group) => (group.rdates.length === 0
      ? { type: group.type, start: group.start, offsetFrom: group.offsetFrom, offsetTo: group.offsetTo }
      : { ...group, rdates: Object.freeze(group.rdates) }))];
  return /** @type {VtimezoneDefinition} */ (Object.freeze({
    tzid: name,
    observances: Object.freeze(observances.map((o) => Object.freeze(o))),
    until: `${formatWall(Math.ceil(high / SECOND) * SECOND)}Z`,
  }));
}
//#endregion
