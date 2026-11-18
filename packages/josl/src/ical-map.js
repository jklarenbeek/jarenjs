//@ts-check

//#region iCalendar model mapping
// The calendar model (a neutral JSON shape over `@jarenjs/core/calendar`
// values) mapped to unfolded content lines, one component at a time.
// Times are written by kind: utc as `...Z`, date as `VALUE=DATE`,
// floating as the local form with no TZID, and zoned - under
// `zones: 'utc'` - as the UTC instant the calendar layer resolves it to,
// under the event's or the series' policy. Under `zones: 'embed'` a zoned
// time is its wall clock with a TZID, and the writer adds a VTIMEZONE of
// that zone over its horizon before the component that first uses it;
// a recurring series under the RFC's policy keeps its rule (DTSTART;TZID
// and RRULE), so every occurrence is the zone's wall clock.
//
// A zoned recurring series is never written as a UTC start with a rule:
// the rule's meaning is the zone's wall clock, and a UTC start would move
// every occurrence after an offset change by the change. It is expanded
// over the caller's horizon into its occurrences instead (a start and
// extra dates, each with its own end where its length differs), or
// refused when no horizon is given. A series without a rule is written
// as the occurrences it makes, in any kind.

import {
  CalendarError, compileRecurrence, defineSeries, expandRecurrence, expandSeries, formatRRule, nextOccurrences, parseTemporal, shiftCivil, toUtc,
} from '@jarenjs/core/calendar';
import { tzidParam } from './ical-vtimezone.js';
import {
  IcalError, daysOf, escapeText, formatDate, formatDuration, formatFloating, formatUtc, instantOf, readDuration, wallOf,
} from './ical-wire.js';

const DAY = 86400000;
/** Wider than any zone offset either way. */
const MARGIN = 3 * DAY;
/** 0000-01-01T00:00:00Z and 9999-12-31T23:59:59Z, the calendar layer's range. */
const FIRST_INSTANT = -62167219200000;
const LAST_INSTANT = 253402300799000;
/** The Gregorian calendar's cycle: 400 years, 146097 days, a whole number of weeks. */
const GREGORIAN_CYCLE = 146097 * DAY;

const EVENT_KEYS = Object.freeze(['type', 'uid', 'dtstamp', 'start', 'end', 'duration', 'policy',
  'summary', 'description', 'location', 'status', 'sequence']);
const SERIES_EVENT_KEYS = Object.freeze(['type', 'series', 'dtstamp', 'summary', 'description', 'location', 'status']);
const FREEBUSY_KEYS = Object.freeze(['type', 'uid', 'dtstamp', 'start', 'end', 'periods']);
const PERIOD_KEYS = Object.freeze(['start', 'end', 'fbtype']);
const AVAILABILITY_KEYS = Object.freeze(['type', 'uid', 'dtstamp', 'start', 'end', 'priority', 'busyType', 'summary', 'description', 'location', 'available']);
const AVAILABLE_KEYS = Object.freeze(['series', 'dtstamp', 'summary', 'description', 'location']);
const MESSAGE_KEYS = Object.freeze(['type', 'component', 'uid', 'dtstamp', 'sequence', 'recurrenceId', 'range', 'organizer', 'attendees',
  'requestStatus', 'status', 'start', 'end', 'cancellation', 'event', 'suggested']);
const PERSON_KEYS = Object.freeze(['address', 'name', 'partstat', 'role', 'cutype', 'rsvp', 'delegatedTo', 'delegatedFrom', 'sentBy']);
const MESSAGE_KINDS = Object.freeze({ event: 'VEVENT', todo: 'VTODO', journal: 'VJOURNAL', freebusy: 'VFREEBUSY' });
const TEXT_PROPERTIES = /** @type {const} */ ([['summary', 'SUMMARY'], ['description', 'DESCRIPTION'], ['location', 'LOCATION']]);
const STATUS = Object.freeze({ tentative: 'TENTATIVE', confirmed: 'CONFIRMED', cancelled: 'CANCELLED' });
const FBTYPE = Object.freeze({ busy: 'BUSY', free: 'FREE', 'busy-unavailable': 'BUSY-UNAVAILABLE', 'busy-tentative': 'BUSY-TENTATIVE' });
const POLICIES = Object.freeze(['rfc5545', 'later', 'reject']);
const MESSAGE_STATUS = Object.freeze({ ...STATUS, 'needs-action': 'NEEDS-ACTION', completed: 'COMPLETED', 'in-process': 'IN-PROCESS',
  draft: 'DRAFT', final: 'FINAL' });

/**
 * What a component's mapping reads from the writer.
 * @typedef {Object} MapContext
 * @property {'utc' | 'embed' | undefined} zones
 * @property {'rdate' | 'rrule'} [onsets] - how a VTIMEZONE writes its onsets
 * @property {any} provider - the zone provider, or null
 * @property {[unknown, unknown] | undefined} horizon - bounds the expansion of zoned recurring series,
 *   and under `zones: 'embed'` the span each VTIMEZONE covers
 * @property {[number, number] | undefined} [span] - the horizon in epoch milliseconds, once read
 * @property {Set<string>} used - the zones the component being mapped writes by TZID
 * @property {string} [method] - the calendar's METHOD, as the model spells it
 * @property {object | undefined} limits - the expansion's limits
 * @property {() => number} now - the DTSTAMP instant, whole seconds
 */

/**
 * The content lines of one component, before folding, and the extra
 * dates it wrote.
 * @typedef {{ lines: string[], components: number, rdates: number }} Rendered
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Refuse a member the documented subset does not name.
 * @param {Record<string, unknown>} object
 * @param {readonly string[]} known
 * @param {string} path
 * @param {string} what
 */
function admitKeys(object, known, path, what) {
  for (const key of Object.keys(object)) {
    if (!known.includes(key))
      throw new IcalError('ICAL3002', `${what} carries no '${key}' in the documented subset`, `${path}/${key}`);
  }
}

/**
 * Run a calendar-layer call, turning its refusal into the writer's.
 * @template T
 * @param {() => T} call
 * @param {string} path
 * @returns {T}
 */
function viaCalendar(call, path) {
  try {
    return call();
  }
  catch (error) {
    if (error instanceof CalendarError)
      throw new IcalError('ICAL3005', `the calendar layer refused it: ${error.message}`, path, error);
    throw error;
  }
}

/**
 * The provider a zoned value needs, after the zones mode.
 * @param {MapContext} context
 * @param {string} path
 */
function zonedProvider(context, path) {
  if (context.zones !== 'utc' && context.zones !== 'embed')
    throw new IcalError('ICAL3008', "a zoned value is written only under a zones mode; pass zones: 'utc' or 'embed'", path);
  if (context.provider === null)
    throw new IcalError('ICAL3009', 'a zoned value needs a zone provider (options.provider or runtime.zoneProvider)', path);
  if (context.zones === 'embed' && context.horizon === undefined)
    throw new IcalError('ICAL3019', "zones: 'embed' writes each zone's VTIMEZONE over a horizon, and none was given", path);
  return context.provider;
}

/**
 * The horizon in epoch milliseconds.
 * @param {MapContext} context
 * @returns {[number, number]}
 */
export function horizonSpan(context) {
  if (context.span === undefined) {
    const [start, end] = /** @type {[unknown, unknown]} */ (context.horizon);
    context.span = [readInstant(start, '/options/horizon/0'), readInstant(end, '/options/horizon/1')];
  }
  return context.span;
}

/**
 * A zoned time written as its wall clock and TZID, inside the horizon
 * its VTIMEZONE covers.
 * @param {string} zone
 * @param {number} wall
 * @param {number} instant
 * @param {MapContext} context
 * @param {string} path
 * @returns {Written}
 */
function zonedWritten(zone, wall, instant, context, path) {
  const [low, high] = horizonSpan(context);
  if (instant < low || instant >= high)
    throw new IcalError('ICAL3020', `the zoned time ${formatUtc(instant)} lies outside the horizon its VTIMEZONE covers`, path);
  context.used.add(zone);
  return { kind: 'instant', text: formatFloating(wall), param: `;TZID=${tzidParam(zone, path)}`, at: instant };
}

//#region times

/**
 * A time as a written value: its spelling, the parameter it needs, and
 * where it lies (an instant for utc and zoned, a wall clock otherwise).
 * @typedef {{ kind: 'date' | 'floating' | 'instant', text: string, param: string, at: number }} Written
 */

/**
 * @param {'date' | 'floating' | 'instant'} kind
 * @param {number} at
 * @returns {Written}
 */
function written(kind, at) {
  if (kind === 'date')
    return { kind, text: formatDate(at / DAY), param: ';VALUE=DATE', at };
  return { kind, text: kind === 'floating' ? formatFloating(at) : formatUtc(at), param: '', at };
}

/**
 * Read a temporal value as the calendar layer admits it.
 * @param {unknown} json
 * @param {'start' | 'end'} bound
 * @param {string} path
 * @returns {any}
 */
const readTemporal = (json, bound, path) => viaCalendar(() => parseTemporal(/** @type {any} */ (json), { bound }), path);

/**
 * Write an admitted date, floating, utc or zoned value.
 * @param {any} value
 * @param {'start' | 'end'} bound
 * @param {MapContext} context
 * @param {unknown} policy - a zoned value's policy
 * @param {string} path
 * @returns {Written}
 */
function writeTime(value, bound, context, policy, path) {
  if (value.kind === 'date')
    return written('date', daysOf(value.date) * DAY);
  if (value.kind === 'floating')
    return written('floating', wallOf(value.date, value.time, path));
  if (value.kind === 'utc')
    return written('instant', instantOf(value.instant, path));
  if (value.kind === 'zoned') {
    const wall = wallOf(value.date, value.time, path);
    const provider = zonedProvider(context, path);
    if (policy === undefined)
      throw new IcalError('ICAL3010', 'a zoned time of an event resolves under its policy: rfc5545, later or reject', path);
    const instant = viaCalendar(() => toUtc(value, { provider, policy: /** @type {any} */ (policy), bound }), path).instant;
    if (context.zones !== 'embed')
      return written('instant', instant);
    // a reader resolves a wall clock and TZID under RFC 5545's rule; where
    // the event's own policy picks another instant (a gap or fold under
    // later), the wall clock alone would read back wrong, so it is the instant
    const rfc = policy === 'rfc5545' ? instant : viaCalendar(() => toUtc(value, { provider, policy: 'rfc5545', bound }), path).instant;
    return rfc === instant ? zonedWritten(value.zone, wall, instant, context, path) : written('instant', instant);
  }
  throw new IcalError('ICAL3007', 'a date range is an event\'s whole start; it is no end', path);
}

/**
 * An instant member: epoch milliseconds or a utc value.
 * @param {unknown} json
 * @param {string} path
 * @returns {number}
 */
function readInstant(json, path) {
  if (typeof json === 'number') {
    if (!Number.isSafeInteger(json) || json < FIRST_INSTANT || json > LAST_INSTANT)
      throw new IcalError('ICAL3003', `an instant is whole epoch milliseconds from 0000 to 9999, not ${json}`, path);
    return instantOf(json, path);
  }
  const value = /** @type {any} */ (viaCalendar(() => parseTemporal(/** @type {any} */ (json)), path));
  if (value.kind !== 'utc')
    throw new IcalError('ICAL3017', `this member is an instant (a utc value or epoch milliseconds), not a ${value.kind} value`, path);
  return instantOf(value.instant, path);
}

/**
 * The DTSTAMP line: the component's own, or the writer's clock.
 * @param {Record<string, any>} component
 * @param {MapContext} context
 * @param {string} path
 * @returns {string}
 */
function dtstamp(component, context, path) {
  const at = component.dtstamp === undefined ? context.now() : readInstant(component.dtstamp, `${path}/dtstamp`);
  return `DTSTAMP:${formatUtc(at)}`;
}

/**
 * The UID line of a non-empty uid.
 * @param {unknown} uid
 * @param {string} path
 * @returns {string}
 */
function uidLine(uid, path) {
  if (uid === undefined)
    throw new IcalError('ICAL3001', 'a component has a uid', path);
  if (typeof uid !== 'string' || uid === '')
    throw new IcalError('ICAL3003', 'a uid is a non-empty string', path);
  return `UID:${escapeText(uid, path)}`;
}

//#endregion

//#region events

/**
 * The text, status and sequence lines an event's VEVENTs share.
 * @param {Record<string, any>} component
 * @param {number | undefined} sequence
 * @param {string} path
 * @returns {string[]}
 */
function eventProperties(component, sequence, path) {
  const lines = [];
  for (const [member, name] of TEXT_PROPERTIES) {
    if (component[member] !== undefined)
      lines.push(`${name}:${escapeText(component[member], `${path}/${member}`)}`);
  }
  if (component.status !== undefined) {
    const status = Object.hasOwn(STATUS, component.status) ? STATUS[component.status] : undefined;
    if (status === undefined)
      throw new IcalError('ICAL3003', `status is 'tentative', 'confirmed' or 'cancelled', not ${String(component.status)}`, `${path}/status`);
    lines.push(`STATUS:${status}`);
  }
  if (sequence !== undefined)
    lines.push(`SEQUENCE:${sequence}`);
  return lines;
}

/**
 * One VEVENT, single or recurring.
 * @param {Record<string, any>} component
 * @param {MapContext} context
 * @param {string} path
 * @returns {Rendered}
 */
function renderEvent(component, context, path) {
  if (component.series !== undefined)
    return renderSeries(component, context, path);
  admitKeys(component, EVENT_KEYS, path, 'an event');
  const { sequence, policy } = component;
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0))
    throw new IcalError('ICAL3003', 'sequence is a whole number from 0', `${path}/sequence`);
  if (policy !== undefined && !POLICIES.includes(policy))
    throw new IcalError('ICAL3003', `policy is rfc5545, later or reject, not ${String(policy)}`, `${path}/policy`);
  const uid = uidLine(component.uid, `${path}/uid`);
  const stamp = dtstamp(component, context, path);
  if (component.start === undefined)
    throw new IcalError('ICAL3001', 'a single event has a start', `${path}/start`);
  const lines = [uid, stamp, ...spanLines(component, context, path), ...eventProperties(component, sequence, path)];
  return { lines: ['BEGIN:VEVENT', ...lines, 'END:VEVENT'], components: 1, rdates: 0 };
}

/**
 * DTSTART and DTEND or DURATION of a single event.
 * @param {Record<string, any>} component
 * @param {MapContext} context
 * @param {string} path
 * @returns {string[]}
 */
function spanLines(component, context, path) {
  const { end, duration, policy } = component;
  const value = readTemporal(component.start, 'start', `${path}/start`);
  if (value.kind === 'date-range') {
    if (end !== undefined || duration !== undefined)
      throw new IcalError('ICAL3007', 'a date range is its own end; it takes no end or duration', `${path}/${end !== undefined ? 'end' : 'duration'}`);
    return [`DTSTART;VALUE=DATE:${formatDate(daysOf(value.start))}`, `DTEND;VALUE=DATE:${formatDate(daysOf(value.end))}`];
  }
  const start = writeTime(value, 'start', context, policy, `${path}/start`);
  const lines = [`DTSTART${start.param}:${start.text}`];
  if (end !== undefined && duration !== undefined)
    throw new IcalError('ICAL3007', 'an event takes an end or a duration, not both', `${path}/duration`);
  if (end !== undefined) {
    const to = writeTime(readTemporal(end, 'end', `${path}/end`), 'end', context, policy, `${path}/end`);
    if (to.kind !== start.kind)
      throw new IcalError('ICAL3007', `the end is of the start's kind (${kindName(start.kind)}), not ${kindName(to.kind)}`, `${path}/end`);
    if (to.at <= start.at)
      throw new IcalError('ICAL3007', 'the end is after the start', `${path}/end`);
    lines.push(`DTEND${to.param}:${to.text}`);
  }
  else if (duration !== undefined) {
    const length = readDuration(duration, `${path}/duration`);
    if (start.kind === 'date' && length.ms !== 0)
      throw new IcalError('ICAL3003', 'an event that starts on a date lasts whole days or weeks', `${path}/duration`);
    if (value.kind === 'zoned' && length.days !== 0 && !start.param.startsWith(';TZID=')) {
      // nominal days are the zone's: the end is the same wall clock days
      // later, resolved there, then the exact time - written as an instant
      const moved = viaCalendar(() => shiftCivil(value, { days: length.days }, { provider: context.provider, policy }), `${path}/duration`);
      lines.push(`DTEND:${formatUtc(/** @type {any} */ (moved).instant + length.ms)}`);
    }
    else
      lines.push(`DURATION:${formatDuration(length)}`);
  }
  return lines;
}

/** @param {Written['kind']} kind */
const kindName = (kind) => (kind === 'instant' ? 'utc or zoned' : kind);

//#endregion

//#region series

/**
 * The series a recurring event names: a value `defineSeries` returned,
 * or its JSON definition, compiled here.
 * @param {unknown} json
 * @param {string} path
 * @returns {any}
 */
function seriesOf(json, path) {
  if (!isRecord(json))
    throw new IcalError('ICAL3001', 'series is a series defineSeries returned, or its definition { uid, base?, rdates?, exdates?, overrides? }', path);
  // a defined series and its JSON copy are read as their definition: the
  // writer never trusts a shape it did not compile
  const { kind, ...definition } = json;
  if (kind !== undefined && kind !== 'series')
    throw new IcalError('ICAL3003', `a series' kind is 'series', not ${String(kind)}`, `${path}/kind`);
  const base = definition.base;
  return viaCalendar(() => {
    let compiled = base;
    if (isRecord(base)) {
      const { kind: baseKind, ...rest } = base;
      if (baseKind !== undefined && baseKind !== 'recurrence')
        throw new IcalError('ICAL3003', `a recurrence's kind is 'recurrence', not ${String(baseKind)}`, `${path}/base/kind`);
      compiled = compileRecurrence(/** @type {any} */ (rest));
    }
    return defineSeries(/** @type {any} */ ({ ...definition, base: compiled }));
  }, path);
}

/**
 * The kind of a series' values, read from its rule or its first extra date.
 * @param {any} series
 * @returns {'date' | 'floating' | 'utc' | 'zoned'}
 */
function seriesKind(series) {
  if (series.base !== null)
    return series.base.dtstart.kind;
  const first = series.rdates[0];
  return (first.kind === undefined ? first.start : first).kind;
}

/**
 * The written form of a slot's start in a series of a kind: a date, a
 * floating wall clock or a UTC instant, from its recurrenceId (a zoned
 * slot resolved under the series' policy).
 * @param {string} id
 * @param {'date' | 'floating' | 'utc' | 'zoned'} kind
 * @param {{ zone?: string, policy: string, provider: any }} zoned
 * @param {string} path
 * @returns {Written}
 */
function slotOf(id, kind, zoned, path) {
  if (kind === 'date')
    return written('date', daysOf(id) * DAY);
  if (kind === 'utc')
    return written('instant', instantOf(id, path));
  const wall = wallOf(id.slice(0, 10), id.slice(11), path);
  if (kind === 'floating')
    return written('floating', wall);
  const value = { kind: 'zoned', date: id.slice(0, 10), time: id.slice(11), zone: zoned.zone };
  return written('instant', viaCalendar(() => toUtc(/** @type {any} */ (value), { provider: zoned.provider, policy: /** @type {any} */ (zoned.policy) }), path).instant);
}

/**
 * Where a value of a series lies: a wall clock, or an instant for utc.
 * @param {any} value
 * @returns {number}
 */
function placeOf(value) {
  if (value.kind === 'date')
    return daysOf(value.date) * DAY;
  if (value.kind === 'utc')
    return instantOf(value.instant, '');
  return wallOf(value.date, value.time, '');
}

/**
 * A recurring VEVENT, its overrides as VEVENTs of their own.
 * @param {Record<string, any>} component
 * @param {MapContext} context
 * @param {string} path
 * @returns {Rendered}
 */
function renderSeries(component, context, path) {
  admitKeys(component, SERIES_EVENT_KEYS, path, 'a recurring event (its uid, times and sequence are the series\')');
  const series = seriesOf(component.series, `${path}/series`);
  const kind = seriesKind(series);
  const zoned = { zone: undefined, policy: series.base?.policy ?? 'rfc5545', provider: null };
  if (kind === 'zoned') {
    zoned.provider = zonedProvider(context, `${path}/series`);
    if (series.base !== null && context.horizon === undefined) {
      throw new IcalError('ICAL3011', 'a zoned recurring series is written under zones: \'utc\' only expanded over a horizon; '
        + 'a UTC start with its rule would move each occurrence after an offset change', `${path}/series`);
    }
  }
  const head = [uidLine(series.uid, `${path}/series/uid`), dtstamp(component, context, path)];
  const shared = eventProperties(component, series.sequence, path);
  if (kind === 'zoned' && context.zones === 'embed' && series.base !== null && series.base.policy === 'rfc5545')
    return renderZonedRule(series, head, shared, context, path);
  if (kind === 'zoned' || series.base === null)
    return renderExpanded(series, kind, zoned, head, shared, context, path);
  return renderRule(series, kind, head, shared, context, path);
}

/**
 * How a zoned series is written by its floating twin under
 * `zones: 'embed'`.
 * @typedef {Object} Embed
 * @property {any} base - the series' own compiled rule, whose UNTIL is UTC
 * @property {(value: Written) => Written} written - a twin's wall clock with the zone's TZID, checked against the horizon
 * @property {(start: any, path: string) => any} until - the UTC UNTIL of a twin's last start
 * @property {readonly any[]} rdates - the series' own RDATEs, in the twin's order
 * @property {readonly any[]} exdates - the series' own EXDATEs, in the twin's order
 * @property {(value: any, always?: boolean) => Written | undefined} own - a utc value or one of another zone spelled
 *   as itself (its zone's VTIMEZONE written too); undefined for a value in the series' zone, which the twin spells,
 *   unless `always`
 */

/**
 * A zoned series with a rule under the RFC's policy, written as it is
 * defined: the series' floating twin (every value its wall clock) is
 * written as a floating series is, each time with the zone's TZID, and
 * its RRULE's UNTIL in UTC (RFC 5545 §3.3.10).
 * @param {any} series
 * @param {string[]} head
 * @param {string[]} shared
 * @param {MapContext} context
 * @param {string} path
 * @returns {Rendered}
 */
function renderZonedRule(series, head, shared, context, path) {
  const { provider } = context;
  const zone = series.base.dtstart.zone;
  /** @param {string} date @param {string} time */
  const instantAt = (date, time) => viaCalendar(() => toUtc(/** @type {any} */ ({ kind: 'zoned', date, time, zone }),
    { provider, policy: 'rfc5545' }), `${path}/series`).instant;
  const twin = floatingTwin(series, zone, provider, path);
  return renderRule(twin, 'floating', head, shared, context, path, {
    base: series.base,
    rdates: series.rdates,
    exdates: series.exdates,
    own: (value, always = false) => {
      if (value.kind === 'zoned' && value.zone === zone && !always)
        return undefined;
      if (value.kind === 'utc')
        return written('instant', instantOf(value.instant, `${path}/series`));
      const instant = viaCalendar(() => toUtc(value, { provider, policy: 'rfc5545' }), `${path}/series`).instant;
      return zonedWritten(value.zone, wallOf(value.date, value.time, `${path}/series`), instant, context, `${path}/series`);
    },
    written: (value) => {
      // the twin places its values by wall clock, and keeps doing so
      const iso = new Date(value.at).toISOString();
      return { ...zonedWritten(zone, value.at, instantAt(iso.slice(0, 10), iso.slice(11, 19)), context, `${path}/series`), at: value.at };
    },
    until: (start) => ({ kind: 'utc', instant: `${new Date(instantAt(start.date, start.time)).toISOString().slice(0, 19)}Z` }),
  });
}

/**
 * The floating twin of a zoned series: the same definition with every
 * value its wall clock, and UNTIL the wall clock at its instant.
 * @param {any} series
 * @param {string} zone
 * @param {any} provider
 * @param {string} path
 * @returns {any}
 */
function floatingTwin(series, zone, provider, path) {
  // every value of a zoned series is in its zone but an RDATE or EXDATE,
  // which may be utc or in another zone: the twin holds such a value as
  // the series' wall clock at its instant, which is the slot it names
  /** @param {any} value @param {string} [where] */
  const wall = (value, where = `${path}/series`) => {
    if (value === undefined)
      return undefined;
    if (value.kind === 'zoned' && value.zone === zone)
      return { kind: 'floating', date: value.date, time: value.time };
    const instant = value.kind === 'utc' ? Date.parse(value.instant)
      : viaCalendar(() => toUtc(value, { provider, policy: 'rfc5545' }), where).instant;
    const parts = viaCalendar(() => provider.toParts(instant, zone), where);
    const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return { kind: 'floating', date: `${String(parts.year).padStart(4, '0')}-${two(parts.month)}-${two(parts.day)}`,
      time: `${two(parts.hours)}:${two(parts.minutes)}:${two(Math.floor(parts.seconds))}` };
  };
  const { base } = series;
  /** @type {Record<string, any>} */
  const rrule = { ...base.rrule };
  if (rrule.UNTIL !== undefined)
    rrule.UNTIL = wall(rrule.UNTIL, `${path}/series/base/rrule`);
  /** @type {Record<string, any>} */
  const twinBase = { dtstart: wall(base.dtstart), rrule };
  if (base.duration !== undefined)
    twinBase.duration = base.duration;
  if (base.dtend !== undefined)
    twinBase.dtend = wall(base.dtend);
  const definition = {
    uid: series.uid,
    ...(series.sequence !== undefined ? { sequence: series.sequence } : {}),
    base: twinBase,
    rdates: series.rdates.map((/** @type {any} */ entry) => (entry.kind === undefined
      ? { start: wall(entry.start), ...(entry.end !== undefined ? { end: wall(entry.end) } : {}),
        ...(entry.duration !== undefined ? { duration: entry.duration } : {}) }
      : wall(entry))),
    exdates: series.exdates.map(wall),
    overrides: series.overrides.map((/** @type {any} */ override) => {
      const { start, end, ...rest } = override;
      return { ...rest, ...(start !== undefined ? { start: wall(start) } : {}),
        ...(end !== undefined ? { end: wall(end) } : {}) };
    }),
  };
  return seriesOf(definition, `${path}/series`);
}

/**
 * Expand a series in a horizon, refusing an answer that is not whole.
 * @param {any} series
 * @param {[unknown, unknown]} horizon
 * @param {MapContext} context
 * @param {any} provider
 * @param {string} path
 */
function expandWhole(series, horizon, context, provider, path) {
  /** @type {any} */
  const options = { horizon };
  if (context.limits !== undefined)
    options.limits = context.limits;
  if (provider !== null)
    options.provider = provider;
  const expansion = viaCalendar(() => expandSeries(series, options), `${path}/series`);
  if (expansion.status !== 'complete') {
    const { emitted, work, providerCalls } = expansion.counts;
    throw new IcalError('ICAL3012', `the expansion stopped at ${expansion.limit} after ${emitted} occurrences `
      + `(work ${work}, provider calls ${providerCalls}); raise the limit or narrow the horizon`, `${path}/series`);
  }
  if (expansion.orphans.count !== 0)
    throw new IcalError('ICAL3015', `the series never makes the slot ${expansion.orphans.ids.join(', ')} its overrides name`, `${path}/series/overrides`);
  return expansion;
}

/**
 * The horizon a series without a rule covers: every value it holds, with
 * a margin wider than any zone offset, inside the calendar's range.
 * @param {any} series
 * @param {'date' | 'floating' | 'utc' | 'zoned'} kind
 * @param {string} path
 * @returns {[unknown, unknown]}
 */
function ownHorizon(series, kind, path) {
  const places = [];
  // a duration reaches as far on the wall clock as its days and time do
  const reach = (/** @type {any} */ entry, /** @type {string} */ at) => {
    const length = readDuration(entry.duration, at);
    return placeOf(entry.start) + length.days * DAY + length.ms;
  };
  for (const [i, entry] of series.rdates.entries()) {
    if (entry.kind === undefined)
      places.push(placeOf(entry.start), entry.end !== undefined ? placeOf(entry.end) : reach(entry, `${path}/series/rdates/${i}/duration`));
    else
      places.push(placeOf(entry));
  }
  for (const [i, entry] of series.overrides.entries()) {
    for (const value of [entry.start, entry.end]) {
      if (value !== undefined)
        places.push(placeOf(value));
    }
    if (entry.start !== undefined && entry.duration !== undefined)
      places.push(reach(entry, `${path}/series/overrides/${i}/duration`));
  }
  const low = Math.max(FIRST_INSTANT, Math.min(...places) - MARGIN);
  const last = Math.max(...places);
  const high = Math.min(LAST_INSTANT, last + MARGIN);
  if (last >= high - DAY)
    throw new IcalError('ICAL3012', 'the series reaches the last day of the calendar\'s range, where no horizon can hold it', `${path}/series`);
  if (kind === 'utc' || kind === 'zoned')
    return [low, high];
  if (kind === 'date')
    return [{ kind: 'date', date: formatDay(low) }, { kind: 'date', date: formatDay(high) }];
  return [{ kind: 'floating', date: formatDay(low), time: '00:00' }, { kind: 'floating', date: formatDay(high), time: '00:00' }];
}

/**
 * A series written as its occurrences: DTSTART the first slot, an RDATE
 * per further slot (a period where its length differs from the first's),
 * and a VEVENT with a RECURRENCE-ID per moved slot. A zoned series' slots
 * are its UTC instants.
 * @param {any} series
 * @param {'date' | 'floating' | 'utc' | 'zoned'} kind
 * @param {{ zone?: string, policy: string, provider: any }} zoned
 * @param {string[]} head
 * @param {string[]} shared
 * @param {MapContext} context
 * @param {string} path
 * @returns {Rendered}
 */
function renderExpanded(series, kind, zoned, head, shared, context, path) {
  const horizon = series.base !== null ? /** @type {[unknown, unknown]} */ (context.horizon) : ownHorizon(series, kind, path);
  const expansion = expandWhole(series, horizon, context, zoned.provider, path);
  if (expansion.occurrences.length === 0)
    throw new IcalError('ICAL3013', 'the series makes no occurrence in the horizon', `${path}/series`);
  if (kind === 'zoned')
    zoned.zone = expansion.occurrences[0].start.zone;
  const form = kind === 'utc' || kind === 'zoned' ? 'instant' : kind;
  const slots = expansion.occurrences.map((occurrence) => {
    const start = occurrence.instants?.start ?? placeOf(occurrence.start);
    const end = occurrence.instants?.end ?? placeOf(occurrence.end);
    const slot = occurrence.moved ? slotOf(occurrence.recurrenceId, kind, zoned, `${path}/series`).at : start;
    return { id: occurrence.recurrenceId, slot, start, end, moved: occurrence.moved === true };
  });
  slots.sort((a, b) => a.slot - b.slot);
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].slot === slots[i - 1].slot) {
      throw new IcalError('ICAL3014', `the slots ${slots[i - 1].id} and ${slots[i].id} are both ${formatUtc(slots[i].slot)}`,
        `${path}/series`);
    }
  }
  const [first] = slots;
  const length = first.end - first.start;
  const at = written(form, first.slot);
  const lines = [...head, `DTSTART${at.param}:${at.text}`];
  if (length > 0) {
    const to = written(form, first.slot + length);
    lines.push(`DTEND${to.param}:${to.text}`);
  }
  for (const slot of slots.slice(1)) {
    const from = written(form, slot.slot);
    if (slot.moved || slot.end - slot.start === length)
      lines.push(`RDATE${from.param}:${from.text}`);
    else if (form === 'date')
      throw new IcalError('ICAL3017', `the slot ${slot.id} lasts otherwise than the first, and a period of dates is no RDATE`, `${path}/series`);
    else
      lines.push(`RDATE;VALUE=PERIOD:${from.text}/${written(form, slot.end).text}`);
  }
  const overrides = slots.filter((slot) => slot.moved).map((slot) => movedEvent(head, shared, written(form, slot.slot),
    written(form, slot.start), slot.end > slot.start ? `DTEND${written(form, slot.end).param}:${written(form, slot.end).text}` : undefined));
  return {
    lines: ['BEGIN:VEVENT', ...lines, ...shared, 'END:VEVENT', ...overrides.flat()],
    components: 1 + overrides.length,
    rdates: slots.length - 1,
  };
}

/**
 * The length from a start to an end of a series' kind: days for dates,
 * wall-clock or UTC time otherwise.
 * @param {any} start
 * @param {any} end
 * @param {'date' | 'floating' | 'utc'} kind
 * @returns {{ days: number, ms: number }}
 */
function lengthBetween(start, end, kind) {
  const span = placeOf(end) - placeOf(start);
  return kind === 'date' ? { days: span / DAY, ms: 0 } : { days: 0, ms: span };
}

/**
 * The VEVENT of a moved slot.
 * @param {string[]} head - UID and DTSTAMP
 * @param {string[]} shared
 * @param {Written} slot
 * @param {Written} start
 * @param {string | undefined} endLine
 * @param {string} [range] - `;RANGE=THISANDFUTURE` for an override over this and future occurrences
 * @returns {string[]}
 */
function movedEvent(head, shared, slot, start, endLine, range = '') {
  return ['BEGIN:VEVENT', ...head, `RECURRENCE-ID${slot.param}${range}:${slot.text}`, `DTSTART${start.param}:${start.text}`,
    ...(endLine === undefined ? [] : [endLine]), ...shared, 'END:VEVENT'];
}

/**
 * A date, floating or utc series with a rule, written as it is defined:
 * DTSTART, DTEND or DURATION, RRULE, RDATE, EXDATE (cancelled slots
 * among them) and a VEVENT per moved slot.
 * @param {any} series
 * @param {'date' | 'floating' | 'utc'} kind
 * @param {string[]} head
 * @param {string[]} shared
 * @param {MapContext} context
 * @param {string} path
 * @param {Embed | null} [embed] - a zoned series written by its floating twin: each wall clock gets the TZID
 * @returns {Rendered}
 */
function renderRule(series, kind, head, shared, context, path, embed = null) {
  const { base } = series;
  const form = kind === 'utc' ? 'instant' : kind;
  /** @param {Written} value @returns {Written} */
  const tz = (value) => (embed === null ? value : embed.written(value));
  const at = tz(written(form, placeOf(base.dtstart)));
  // the overrides' slots must be the series', which an expansion at the start reports
  expandWhole(series, nearHorizon(kind, at.at), context, null, path);
  /** @type {{ days: number, ms: number } | undefined} */
  let length;
  const lines = [...head, `DTSTART${at.param}:${at.text}`];
  if (base.duration !== undefined) {
    length = readDuration(base.duration, `${path}/series/base/duration`);
    lines.push(`DURATION:${formatDuration(length)}`);
  }
  else if (base.dtend !== undefined) {
    const to = tz(written(form, placeOf(base.dtend)));
    length = kind === 'date' ? { days: (to.at - at.at) / DAY, ms: 0 } : { days: 0, ms: to.at - at.at };
    lines.push(`DTEND${to.param}:${to.text}`);
  }
  const rule = ruleLines(base, kind, at, context, path, embed);
  lines.push(...rule);
  // one RDATE per slot, the first given winning as it does in the series
  /** @type {Map<string, { days: number, ms: number }>} */
  const periods = new Map();
  /** @type {Map<string, { from: Written, line: string }>} */
  const onRule = new Map();
  const seen = new Set();
  let rdates = rule.length - 1;
  for (const [i, entry] of series.rdates.entries()) {
    const period = entry.kind === undefined;
    const from = tz(written(form, placeOf(period ? entry.start : entry)));
    const id = slotIdOf(from.at, kind);
    if (seen.has(id))
      continue;
    seen.add(id);
    const own = embed?.own(period ? embed.rdates[i].start : embed.rdates[i]);
    if (!period) {
      lines.push(`RDATE${(own ?? from).param}:${(own ?? from).text}`);
      rdates++;
      continue;
    }
    if (kind === 'date')
      throw new IcalError('ICAL3017', 'a period of dates is no RDATE; an RDATE period runs between two date-times', `${path}/series/rdates/${i}`);
    if (entry.end === undefined) {
      // a period of a start and a duration keeps its duration, from its own start
      const length = readDuration(entry.duration, `${path}/series/rdates/${i}/duration`);
      periods.set(id, length);
      const spelled = formatDuration(length);
      if (ruleMakes(base, kind, from.at, context, path))
        onRule.set(id, { from, line: `DURATION:${spelled}` });
      else {
        lines.push(`RDATE;VALUE=PERIOD${(own ?? from).param}:${(own ?? from).text}/${spelled}`);
        rdates++;
      }
      continue;
    }
    const to = tz(written(form, placeOf(entry.end)));
    const ownEnd = embed?.own(embed.rdates[i].end);
    periods.set(id, { days: 0, ms: to.at - from.at });
    // a period on a slot the rule makes too would be a duplicate instance
    // whose length a reader may take from either: it is written as that
    // slot's own VEVENT instead
    if (ruleMakes(base, kind, from.at, context, path))
      onRule.set(id, { from, line: `DTEND${to.param}:${to.text}` });
    else {
      // a period outside the series' zone keeps its own when both ends share it, and is two UTC instants otherwise
      const [a, b] = own === undefined && ownEnd === undefined ? [from, to]
        : own !== undefined && ownEnd !== undefined && own.param === ownEnd.param ? [own, ownEnd]
          : [embed?.own(embed.rdates[i].start, true), embed?.own(embed.rdates[i].end, true)]
            .map((value) => written('instant', /** @type {Written} */ (value).at));
      lines.push(`RDATE;VALUE=PERIOD${a.param}:${a.text}/${b.text}`);
      rdates++;
    }
  }
  const excluded = new Set();
  for (const [i, entry] of series.exdates.entries()) {
    const value = tz(written(form, placeOf(entry)));
    excluded.add(slotIdOf(value.at, kind));
    const own = embed?.own(embed.exdates[i]) ?? value;
    lines.push(`EXDATE${own.param}:${own.text}`);
  }
  const moved = [];
  const overridden = new Set();
  // an override over this and future occurrences is its slot's VEVENT
  // with RANGE=THISANDFUTURE (a cancelled one with STATUS:CANCELLED); an
  // override after it without an end lasts what the range gives
  const ranges = series.overrides.filter((/** @type {any} */ override) => override.range !== undefined);
  // a range's DTEND or DURATION carries to its later slots only where it
  // changes its own slot's length (RFC 5545 §3.8.4.4): one that names its
  // own slot's length for later slots of other lengths has no spelling
  const lengthOf = (/** @type {any} */ override) => (override.end !== undefined ? lengthBetween(override.start, override.end, kind)
    : override.duration !== undefined ? readDuration(override.duration, `${path}/series/overrides`) : undefined);
  const same = (/** @type {any} */ a, /** @type {any} */ b) => (a?.days ?? 0) === (b?.days ?? 0) && (a?.ms ?? 0) === (b?.ms ?? 0);
  for (const range of ranges) {
    const given = range.status === 'cancelled' ? undefined : lengthOf(range);
    const ownSlot = periods.get(range.recurrenceId) ?? length;
    if (given === undefined || !same(given, ownSlot) || periods.size === 0)
      continue;
    const next = ranges.filter((/** @type {any} */ other) => other.recurrenceId > range.recurrenceId)
      .reduce((/** @type {string | undefined} */ a, /** @type {any} */ b) => (a === undefined || b.recurrenceId < a ? b.recurrenceId : a), undefined);
    const later = [...periods].filter(([id]) => id > range.recurrenceId && (next === undefined || id < next)).map(([, own]) => own);
    if (!same(ownSlot, length) || later.some((own) => !same(own, given))) {
      throw new IcalError('ICAL3016', `the override of ${range.recurrenceId} ranges over this and future occurrences with its own slot's length, `
        + 'which a RECURRENCE-ID;RANGE gives no later slot of another length', `${path}/series/overrides/${series.overrides.indexOf(range)}/range`);
    }
  }
  for (const override of series.overrides) {
    overridden.add(override.recurrenceId);
    const slot = tz(slotOf(override.recurrenceId, kind, { policy: base.policy, provider: null }, `${path}/series/overrides`));
    const range = override.range === undefined ? '' : ';RANGE=THISANDFUTURE';
    if (override.status === 'cancelled') {
      if (range === '')
        lines.push(`EXDATE${slot.param}:${slot.text}`);
      else {
        moved.push(movedEvent(head, [...shared.filter((line) => !line.startsWith('STATUS:')), 'STATUS:CANCELLED'], slot, slot,
          undefined, range));
      }
      continue;
    }
    const start = tz(written(form, placeOf(override.start)));
    let endLine;
    if (override.end !== undefined) {
      const end = tz(written(form, placeOf(override.end)));
      endLine = `DTEND${end.param}:${end.text}`;
    }
    else if (override.duration !== undefined)
      endLine = `DURATION:${formatDuration(readDuration(override.duration, `${path}/series/overrides/${series.overrides.indexOf(override)}/duration`))}`;
    else {
      // the range in force is the latest at or before the slot, in whatever order the overrides are listed
      const over = range === '' ? ranges.filter((/** @type {any} */ other) => other.recurrenceId <= override.recurrenceId)
        .reduce((/** @type {any} */ a, /** @type {any} */ b) => (a === undefined || b.recurrenceId > a.recurrenceId ? b : a), undefined) : undefined;
      const own = (over?.status === 'cancelled' ? undefined : over === undefined ? undefined : lengthOf(over))
        ?? periods.get(override.recurrenceId) ?? length;
      if (own !== undefined)
        endLine = `DURATION:${formatDuration(own)}`;
    }
    moved.push(movedEvent(head, shared, slot, start, endLine, range));
  }
  for (const [id, { from, line }] of onRule) {
    if (!overridden.has(id) && !excluded.has(id))
      moved.push(movedEvent(head, shared, from, from, line));
  }
  return {
    lines: ['BEGIN:VEVENT', ...lines, ...shared, 'END:VEVENT', ...moved.flat()],
    components: 1 + moved.length,
    rdates,
  };
}

/**
 * The horizon of one slot of a date, floating or utc series: its start
 * and a second (a day, for dates) later.
 * @param {'date' | 'floating' | 'utc'} kind
 * @param {number} at
 * @returns {[unknown, unknown]}
 */
function nearHorizon(kind, at) {
  return kind === 'date' ? [valueAt(kind, at), valueAt(kind, at + DAY)] : [valueAt(kind, at), valueAt(kind, at + 1000)];
}

/**
 * A value of a date, floating or utc series at a place.
 * @param {'date' | 'floating' | 'utc'} kind
 * @param {number} at
 * @returns {any}
 */
function valueAt(kind, at) {
  const iso = new Date(at).toISOString();
  if (kind === 'date')
    return { kind, date: iso.slice(0, 10) };
  if (kind === 'utc')
    return { kind, instant: `${iso.slice(0, 19)}Z` };
  return { kind, date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

/**
 * Whether a compiled rule makes the slot at a place (its start counted,
 * as the calendar layer counts it).
 * @param {any} compiled
 * @param {'date' | 'floating' | 'utc'} kind
 * @param {number} at
 * @param {MapContext} context
 * @param {string} path
 * @returns {boolean}
 */
function ruleMakes(compiled, kind, at, context, path) {
  /** @type {any} */
  const options = { horizon: nearHorizon(kind, at) };
  if (context.limits !== undefined)
    options.limits = context.limits;
  const expansion = viaCalendar(() => expandRecurrence(compiled, options), `${path}/series`);
  if (expansion.status !== 'complete') {
    throw new IcalError('ICAL3012', `the expansion stopped at ${expansion.limit} after ${expansion.counts.work} steps `
      + 'while asking the rule for one slot; raise the limit', `${path}/series`);
  }
  const id = slotIdOf(at, kind);
  return expansion.occurrences.some((occurrence) => occurrence.recurrenceId === id);
}

/**
 * The place a whole number of months before another, on its day of the
 * month and time of day: the fewest multiples of `months` back whose month
 * has that day (a 31st, 29 February); -Infinity once that passes the
 * earliest time a Date holds.
 * @param {number} at
 * @param {number} months
 * @returns {number}
 */
function monthsBefore(at, months) {
  const from = new Date(at);
  const day = from.getUTCDate();
  // 400 years on the calendar repeats, so a month with the day is met by then
  for (let back = months; ; back += months) {
    const to = new Date(at);
    to.setUTCFullYear(from.getUTCFullYear(), from.getUTCMonth() - back, day);
    if (Number.isNaN(to.getTime()))
      return -Infinity;
    if (to.getUTCDate() === day)
      return to.getTime();
  }
}

/**
 * The greatest common divisor of two whole numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/**
 * Where to start the open rule, and the place to ask it about, so that it
 * makes that place exactly when the rule started at `at` makes `at`
 * itself: started a whole number of its periods earlier, on what DTSTART
 * supplies a rule that names no day - its weekday (DAILY, WEEKLY), its day
 * of the month and month (MONTHLY, YEARLY, stepped by month index), or,
 * with BYWEEKNO, whose period is a run of numbered weeks, its weekday and
 * week-year (the least common multiple of 400 and INTERVAL years earlier:
 * whole periods, and the Gregorian calendar repeats day for day every 400
 * years, 146097 days, 20871 weeks). A start before year 0 asks 400 years
 * on, as often as needed. A MONTHLY or YEARLY rule whose span cannot fit
 * the range so (BYWEEKNO every 27 years: 10800; any rule whose INTERVAL
 * nears 10000 years) is started INTERVAL days earlier, as DAILY: its yes
 * is always right, its no can be wrong, and the start is then also
 * written as an RDATE.
 * @param {Record<string, any>} open - the rule without COUNT and UNTIL
 * @param {number} at
 * @returns {[number, number]}
 */
function probeOf(open, at) {
  const interval = open.INTERVAL ?? 1;
  const step = (open.FREQ === 'WEEKLY' ? 7 : 1) * interval * DAY;
  if (open.FREQ === 'MONTHLY' || open.FREQ === 'YEARLY') {
    const start = open.BYWEEKNO === undefined ? monthsBefore(at, (open.FREQ === 'YEARLY' ? 12 : 1) * interval)
      : at - GREGORIAN_CYCLE * (interval / gcd(400, interval));
    const cycles = start >= FIRST_INSTANT ? 0 : Math.ceil((FIRST_INSTANT - start) / GREGORIAN_CYCLE);
    if (at + cycles * GREGORIAN_CYCLE <= LAST_INSTANT - DAY)
      return [start + cycles * GREGORIAN_CYCLE, at + cycles * GREGORIAN_CYCLE];
  }
  const probe = at - step >= FIRST_INSTANT ? at : at + GREGORIAN_CYCLE * interval;
  return [probe - step, probe];
}

/**
 * The RRULE of a series, and an RDATE of its start when the rule itself
 * would not make that start. RFC 5545 leaves the set of such a rule
 * undefined (RFC 2445 counted DTSTART; some readers drop it); the
 * calendar layer counts it as the first occurrence. So the start is
 * also written as an RDATE, which every reader keeps and a duplicate
 * collapses, and a COUNT - which a reader may then count from the rule
 * alone - is written as the UNTIL of the last occurrence it makes.
 * @param {any} base
 * @param {'date' | 'floating' | 'utc'} kind
 * @param {Written} at
 * @param {MapContext} context
 * @param {string} path
 * @param {Embed | null} embed - a zoned series' rule and UNTIL, which are UTC
 * @returns {string[]}
 */
function ruleLines(base, kind, at, context, path, embed) {
  const { COUNT, UNTIL, ...open } = base.rrule;
  const [start, probe] = probeOf(open, at.at);
  const synced = ruleMakes(viaCalendar(() => compileRecurrence({ dtstart: valueAt(kind, start), rrule: open, policy: base.policy }),
    `${path}/series`), kind, probe, context, path);
  if (synced)
    return [`RRULE:${formatRRule(embed === null ? base : embed.base)}`];
  let until = UNTIL;
  if (COUNT !== undefined) {
    /** @type {any} */
    const options = context.limits !== undefined ? { limits: context.limits } : {};
    const next = viaCalendar(() => nextOccurrences(base, valueAt(kind, at.at), COUNT, options), `${path}/series`);
    if (next.status !== 'complete' || next.occurrences.length !== COUNT) {
      throw new IcalError('ICAL3012', `the expansion stopped at ${next.limit ?? 'the horizon'} after ${next.occurrences.length} of ${COUNT} `
        + 'occurrences while finding the last; raise the limit', `${path}/series`);
    }
    until = next.occurrences[COUNT - 1].start;
  }
  if (embed !== null && until !== undefined)
    until = COUNT !== undefined ? embed.until(/** @type {any} */ (until), path) : embed.base.rrule.UNTIL;
  return [`RRULE:${formatRRule(until === undefined ? open : { ...open, UNTIL: until })}`, `RDATE${at.param}:${at.text}`];
}

/** @param {number} at */
const formatDay = (at) => new Date(at).toISOString().slice(0, 10);

/**
 * The recurrenceId a slot of a date, floating or utc series carries.
 * @param {number} at
 * @param {'date' | 'floating' | 'utc'} kind
 * @returns {string}
 */
function slotIdOf(at, kind) {
  const iso = new Date(at).toISOString();
  return kind === 'date' ? iso.slice(0, 10) : kind === 'utc' ? `${iso.slice(0, 19)}Z` : iso.slice(0, 19);
}

//#endregion

//#region free/busy

/**
 * One VFREEBUSY: plain spans of instants, each with its type.
 * @param {Record<string, any>} component
 * @param {MapContext} context
 * @param {string} path
 * @returns {Rendered}
 */
function renderFreebusy(component, context, path) {
  admitKeys(component, FREEBUSY_KEYS, path, 'a free/busy component');
  const lines = [uidLine(component.uid, `${path}/uid`), dtstamp(component, context, path)];
  const range = [];
  for (const [member, name] of /** @type {const} */ ([['start', 'DTSTART'], ['end', 'DTEND']])) {
    if (component[member] !== undefined) {
      range.push(readInstant(component[member], `${path}/${member}`));
      lines.push(`${name}:${formatUtc(range[range.length - 1])}`);
    }
  }
  if (range.length === 2 && range[1] <= range[0])
    throw new IcalError('ICAL3007', 'the end is after the start', `${path}/end`);
  const { periods } = component;
  if (periods === undefined)
    throw new IcalError('ICAL3001', 'a free/busy component has its periods (a list, which may be empty)', `${path}/periods`);
  if (!Array.isArray(periods))
    throw new IcalError('ICAL3003', 'periods is a list of { start, end, fbtype? }', `${path}/periods`);
  const spans = periods.map((period, i) => {
    const at = `${path}/periods/${i}`;
    if (!isRecord(period))
      throw new IcalError('ICAL3001', 'a period is { start, end, fbtype? }', at);
    admitKeys(period, PERIOD_KEYS, at, 'a free/busy period');
    if (period.start === undefined || period.end === undefined)
      throw new IcalError('ICAL3001', 'a period has a start and an end', `${at}/${period.start === undefined ? 'start' : 'end'}`);
    const start = readInstant(period.start, `${at}/start`);
    const end = readInstant(period.end, `${at}/end`);
    if (end <= start)
      throw new IcalError('ICAL3007', 'the end is after the start', `${at}/end`);
    const type = period.fbtype ?? 'busy';
    if (!Object.hasOwn(FBTYPE, type))
      throw new IcalError('ICAL3003', `fbtype is 'busy', 'free', 'busy-unavailable' or 'busy-tentative', not ${String(type)}`, `${at}/fbtype`);
    return { start, end, type: FBTYPE[type], i };
  });
  spans.sort((a, b) => a.start - b.start || a.end - b.end || a.i - b.i);
  for (const span of spans)
    lines.push(`FREEBUSY;FBTYPE=${span.type}:${formatUtc(span.start)}/${formatUtc(span.end)}`);
  return { lines: ['BEGIN:VFREEBUSY', ...lines, 'END:VFREEBUSY'], components: 1, rdates: 0 };
}

//#endregion

/**
 * One VAVAILABILITY (RFC 7953): its period, PRIORITY, BUSYTYPE and text,
 * and each available series as an AVAILABLE (its overrides AVAILABLEs
 * with a RECURRENCE-ID), written as a recurring event's VEVENTs are. Its
 * times are utc or zoned (§3.1).
 * @param {Record<string, any>} component
 * @param {MapContext} context
 * @param {string} path
 * @returns {Rendered}
 */
function renderAvailability(component, context, path) {
  admitKeys(component, AVAILABILITY_KEYS, path, 'an availability');
  const lines = ['BEGIN:VAVAILABILITY', uidLine(component.uid, `${path}/uid`), dtstamp(component, context, path)];
  const times = /** @type {const} */ ([['start', 'DTSTART'], ['end', 'DTEND']]).map(([member, name]) => {
    if (component[member] === undefined)
      return undefined;
    const value = readTemporal(component[member], member, `${path}/${member}`);
    if (value.kind !== 'utc' && value.kind !== 'zoned')
      throw new IcalError('ICAL3003', `an availability's ${member} is a utc or zoned time (RFC 7953 §3.1), not ${value.kind}`, `${path}/${member}`);
    const at = writeTime(value, member, context, 'rfc5545', `${path}/${member}`);
    lines.push(`${name}${at.param}:${at.text}`);
    return at;
  });
  if (times[0] !== undefined && times[1] !== undefined && times[1].at <= times[0].at)
    throw new IcalError('ICAL3007', 'the end is after the start', `${path}/end`);
  const { priority, busyType } = component;
  if (priority !== undefined) {
    if (!Number.isInteger(priority) || priority < 0 || priority > 9)
      throw new IcalError('ICAL3003', 'priority is RFC 7953\'s 0-9 (1 the highest, 0 undefined and lowest)', `${path}/priority`);
    lines.push(`PRIORITY:${priority}`);
  }
  if (busyType !== undefined) {
    if (busyType !== 'busy-unavailable')
      throw new IcalError('ICAL3003', `busyType is 'busy-unavailable', which an availability layer marks its period outside its spans, not ${String(busyType)}`, `${path}/busyType`);
    lines.push('BUSYTYPE:BUSY-UNAVAILABLE');
  }
  lines.push(...eventProperties(component, undefined, path));
  if (!Array.isArray(component.available))
    throw new IcalError(component.available === undefined ? 'ICAL3001' : 'ICAL3003', 'available is a list of { series, dtstamp?, summary?, description?, location? }', `${path}/available`);
  let components = 1;
  let rdates = 0;
  // under zones: 'utc' a zoned rule is written as its occurrences over the horizon, which must hold the whole period
  const [low, high] = context.zones === 'embed' || context.horizon === undefined ? [0, 0] : horizonSpan(context);
  const held = times[0] !== undefined && times[1] !== undefined && low <= times[0].at && times[1].at <= high;
  for (const [i, available] of component.available.entries()) {
    const at = `${path}/available/${i}`;
    if (!isRecord(available))
      throw new IcalError('ICAL3001', 'an available entry is { series, dtstamp?, summary?, description?, location? }', at);
    admitKeys(available, AVAILABLE_KEYS, at, 'an available series');
    const kind = seriesKind(seriesOf(available.series, `${at}/series`));
    if (kind !== 'utc' && kind !== 'zoned')
      throw new IcalError('ICAL3003', `an available series is utc or zoned (RFC 7953 §3.1), not ${kind}`, `${at}/series`);
    if (kind === 'zoned' && context.zones !== 'embed' && context.horizon !== undefined && available.series.base != null && !held) {
      throw new IcalError('ICAL3022', 'under zones: \'utc\' a zoned recurring AVAILABLE is written as its occurrences over the horizon, '
        + 'which does not hold the whole period of its VAVAILABILITY', `${at}/series`);
    }
    const rendered = renderSeries({ type: 'event', ...available }, context, at);
    lines.push(...rendered.lines.map((line) => (line === 'BEGIN:VEVENT' ? 'BEGIN:AVAILABLE' : line === 'END:VEVENT' ? 'END:AVAILABLE' : line)));
    components += rendered.components;
    rdates += rendered.rdates;
  }
  lines.push('END:VAVAILABILITY');
  return { lines, components, rdates };
}

/**
 * A parameter value, quoted where it holds a colon, semicolon or comma.
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function paramValue(value, path) {
  if (typeof value !== 'string' || value === '' || /["\p{Cc}]/u.test(value))
    throw new IcalError('ICAL3003', 'a parameter value is a non-empty string with no double quote or control character', path);
  return /[:;,]/.test(value) ? `"${value}"` : value;
}

/**
 * The ORGANIZER or ATTENDEE line of a calendar user.
 * @param {string} name
 * @param {unknown} person
 * @param {string} path
 * @returns {string}
 */
function personLine(name, person, path) {
  if (!isRecord(person))
    throw new IcalError('ICAL3001', 'a calendar user is { address, name?, partstat?, role?, cutype?, rsvp?, delegatedTo?, delegatedFrom?, sentBy? }', path);
  admitKeys(person, PERSON_KEYS, path, 'a calendar user');
  const { address } = person;
  if (typeof address !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(address))
    throw new IcalError(address === undefined ? 'ICAL3001' : 'ICAL3003', 'a calendar user\'s address is a URI, such as mailto:a@example.com', `${path}/address`);
  let line = name;
  if (person.name !== undefined)
    line += `;CN=${paramValue(person.name, `${path}/name`)}`;
  for (const [member, param] of [['partstat', 'PARTSTAT'], ['role', 'ROLE'], ['cutype', 'CUTYPE']]) {
    if (person[member] !== undefined)
      line += `;${param}=${paramValue(typeof person[member] === 'string' ? person[member].toUpperCase() : person[member], `${path}/${member}`)}`;
  }
  if (person.rsvp !== undefined) {
    if (typeof person.rsvp !== 'boolean')
      throw new IcalError('ICAL3003', 'rsvp is true or false', `${path}/rsvp`);
    line += `;RSVP=${person.rsvp ? 'TRUE' : 'FALSE'}`;
  }
  for (const [member, param] of [['delegatedTo', 'DELEGATED-TO'], ['delegatedFrom', 'DELEGATED-FROM']]) {
    if (person[member] === undefined)
      continue;
    if (!Array.isArray(person[member]) || person[member].length === 0)
      throw new IcalError('ICAL3003', `${member} is a list of addresses`, `${path}/${member}`);
    line += `;${param}=${person[member].map((/** @type {unknown} */ value, /** @type {number} */ i) => `"${paramValue(value, `${path}/${member}/${i}`).replace(/^"|"$/g, '')}"`).join(',')}`;
  }
  if (person.sentBy !== undefined)
    line += `;SENT-BY="${paramValue(person.sentBy, `${path}/sentBy`).replace(/^"|"$/g, '')}"`;
  return `${line}:${address}`;
}

/**
 * A scheduling message (RFC 5546): its component's UID, DTSTAMP,
 * RECURRENCE-ID, SEQUENCE and STATUS, its organizer and attendees, and
 * its REQUEST-STATUS lines; an `event` (or a COUNTER's `suggested` event) is
 * written as an event is, with the message's lines in each of its
 * VEVENTs. The method's table is the writer's to check.
 * @param {Record<string, any>} component
 * @param {MapContext} context
 * @param {string} path
 * @returns {Rendered}
 */
function renderMessage(component, context, path) {
  admitKeys(component, MESSAGE_KEYS, path, 'a scheduling message');
  const kind = component.component ?? 'event';
  if (!Object.hasOwn(MESSAGE_KINDS, kind))
    throw new IcalError('ICAL3003', `component is 'event', 'todo', 'journal' or 'freebusy', not ${String(kind)}`, `${path}/component`);
  const name = MESSAGE_KINDS[/** @type {keyof typeof MESSAGE_KINDS} */ (kind)];
  if (component.event !== undefined && component.suggested !== undefined)
    throw new IcalError('ICAL3003', 'a message carries an event or a suggested event, not both', `${path}/suggested`);
  const member = component.event !== undefined ? 'event' : 'suggested';
  const data = component[member];
  /** @type {string[]} */
  const own = [];
  if (component.recurrenceId !== undefined) {
    const id = writeTime(readTemporal(component.recurrenceId, 'start', `${path}/recurrenceId`), 'start', context, 'rfc5545', `${path}/recurrenceId`);
    if (component.range !== undefined && component.range !== 'THISANDFUTURE')
      throw new IcalError('ICAL3003', `range is 'THISANDFUTURE', not ${String(component.range)}`, `${path}/range`);
    own.push(`RECURRENCE-ID${id.param}${component.range === undefined ? '' : ';RANGE=THISANDFUTURE'}:${id.text}`);
  }
  if (component.organizer !== undefined)
    own.push(personLine('ORGANIZER', component.organizer, `${path}/organizer`));
  if (component.attendees !== undefined && !Array.isArray(component.attendees))
    throw new IcalError('ICAL3003', 'attendees is a list of calendar users', `${path}/attendees`);
  for (const [i, person] of (component.attendees ?? []).entries())
    own.push(personLine('ATTENDEE', person, `${path}/attendees/${i}`));
  if (component.requestStatus !== undefined && !Array.isArray(component.requestStatus))
    throw new IcalError('ICAL3003', 'requestStatus is a list of { code, description, data? }', `${path}/requestStatus`);
  for (const [i, entry] of (component.requestStatus ?? []).entries()) {
    const at = `${path}/requestStatus/${i}`;
    if (!isRecord(entry) || typeof entry.code !== 'string' || !/^\d\.\d{1,3}(\.\d{1,3})?$/.test(entry.code))
      throw new IcalError('ICAL3003', 'a request status is { code: \'2.0\', description, data? }', at);
    own.push(`REQUEST-STATUS:${entry.code};${escapeText(entry.description ?? '', `${at}/description`)}${
      entry.data === undefined ? '' : `;${escapeText(entry.data, `${at}/data`)}`}`);
  }
  for (const [member, name] of /** @type {const} */ ([['start', 'DTSTART'], ['end', 'DTEND']])) {
    if (component[member] === undefined)
      continue;
    if (kind !== 'freebusy')
      throw new IcalError('ICAL3002', `a message's ${member} is a VFREEBUSY's span; a${kind === 'event' ? 'n' : ''} ${kind}'s is its event's`, `${path}/${member}`);
    own.unshift(`${name}:${formatUtc(readInstant(component[member], `${path}/${member}`))}`);
  }
  const status = component.status ?? (component.cancellation !== undefined ? 'cancelled' : undefined);
  if (data === undefined) {
    if (component.sequence !== undefined && (!Number.isSafeInteger(component.sequence) || component.sequence < 0))
      throw new IcalError('ICAL3003', 'sequence is a whole number from 0', `${path}/sequence`);
    if (status !== undefined && !Object.hasOwn(MESSAGE_STATUS, status))
      throw new IcalError('ICAL3003', `status is one of ${Object.keys(MESSAGE_STATUS).join(', ')}, not ${String(status)}`, `${path}/status`);
    return { lines: [`BEGIN:${name}`, uidLine(component.uid, `${path}/uid`), dtstamp(component, context, path), ...own,
      ...(component.sequence !== undefined ? [`SEQUENCE:${component.sequence}`] : []),
      ...(status !== undefined ? [`STATUS:${MESSAGE_STATUS[/** @type {keyof typeof MESSAGE_STATUS} */ (status)]}`] : []), `END:${name}`], components: 1, rdates: 0 };
  }
  if (name !== 'VEVENT' || !isRecord(data) || data.type !== 'event')
    throw new IcalError('ICAL3003', `a message's ${member} is an event, of a VEVENT message`, `${path}/${member}`);
  const rendered = renderEvent(data, context, `${path}/${member}`);
  // the message's lines go into each VEVENT the event writes, before its END
  let depth = 0;
  const lines = rendered.lines.flatMap((line) => {
    depth += line.startsWith('BEGIN:') ? 1 : line.startsWith('END:') ? -1 : 0;
    return line === 'END:VEVENT' && depth === 0 ? [...own, line] : [line];
  });
  return { ...rendered, lines };
}

/**
 * Map one component of the model to its unfolded content lines.
 * @param {unknown} component
 * @param {MapContext} context
 * @param {string} path - its pointer, `/components/<i>`
 * @returns {Rendered}
 */
export function renderComponent(component, context, path) {
  if (!isRecord(component))
    throw new IcalError('ICAL3001', 'a component is an object with a type', path);
  if (component.type === 'event')
    return renderEvent(component, context, path);
  if (component.type === 'freebusy')
    return renderFreebusy(component, context, path);
  if (component.type === 'availability')
    return renderAvailability(component, context, path);
  if (component.type === 'message')
    return renderMessage(component, context, path);
  if (component.type === undefined)
    throw new IcalError('ICAL3001', "a component has a type: 'event', 'freebusy', 'availability' or 'message'", `${path}/type`);
  throw new IcalError('ICAL3002', `the component type ${String(component.type)} is outside the documented subset ('event', 'freebusy', 'availability', 'message')`, `${path}/type`);
}

//#endregion
