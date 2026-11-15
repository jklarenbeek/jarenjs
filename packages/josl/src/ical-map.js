//@ts-check

//#region iCalendar model mapping
// The calendar model (a neutral JSON shape over `@jarenjs/core/calendar`
// values) mapped to unfolded content lines, one component at a time.
// Times are written by kind: utc as `...Z`, date as `VALUE=DATE`,
// floating as the local form with no TZID, and zoned - under
// `zones: 'utc'`, the only zone mode - as the UTC instant the calendar
// layer resolves it to, under the event's or the series' policy.
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
const TEXT_PROPERTIES = /** @type {const} */ ([['summary', 'SUMMARY'], ['description', 'DESCRIPTION'], ['location', 'LOCATION']]);
const STATUS = Object.freeze({ tentative: 'TENTATIVE', confirmed: 'CONFIRMED', cancelled: 'CANCELLED' });
const FBTYPE = Object.freeze({ busy: 'BUSY', free: 'FREE', 'busy-unavailable': 'BUSY-UNAVAILABLE', 'busy-tentative': 'BUSY-TENTATIVE' });
const POLICIES = Object.freeze(['rfc5545', 'later', 'reject']);

/**
 * What a component's mapping reads from the writer.
 * @typedef {Object} MapContext
 * @property {'utc' | undefined} zones
 * @property {any} provider - the zone provider, or null
 * @property {[unknown, unknown] | undefined} horizon - bounds the expansion of zoned recurring series
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
  if (context.zones !== 'utc')
    throw new IcalError('ICAL3008', "a zoned value is written only under a zones mode; pass zones: 'utc'", path);
  if (context.provider === null)
    throw new IcalError('ICAL3009', 'a zoned value needs a zone provider (options.provider or runtime.zoneProvider)', path);
  return context.provider;
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
    wallOf(value.date, value.time, path);
    const provider = zonedProvider(context, path);
    if (policy === undefined)
      throw new IcalError('ICAL3010', 'a zoned time of an event resolves under its policy: rfc5545, later or reject', path);
    return written('instant', viaCalendar(() => toUtc(value, { provider, policy: /** @type {any} */ (policy), bound }), path).instant);
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
    if (value.kind === 'zoned' && length.days !== 0) {
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
  for (const [i, override] of series.overrides.entries()) {
    if (override.range !== undefined)
      throw new IcalError('ICAL3016', `the override of ${override.recurrenceId} ranges over this and future occurrences`, `${path}/series/overrides/${i}/range`);
  }
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
  if (kind === 'zoned' || series.base === null)
    return renderExpanded(series, kind, zoned, head, shared, context, path);
  return renderRule(series, kind, head, shared, context, path);
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
  for (const entry of series.rdates) {
    if (entry.kind === undefined)
      places.push(placeOf(entry.start), placeOf(entry.end));
    else
      places.push(placeOf(entry));
  }
  for (const entry of series.overrides) {
    for (const value of [entry.start, entry.end]) {
      if (value !== undefined)
        places.push(placeOf(value));
    }
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
 * The VEVENT of a moved slot.
 * @param {string[]} head - UID and DTSTAMP
 * @param {string[]} shared
 * @param {Written} slot
 * @param {Written} start
 * @param {string | undefined} endLine
 * @returns {string[]}
 */
function movedEvent(head, shared, slot, start, endLine) {
  return ['BEGIN:VEVENT', ...head, `RECURRENCE-ID${slot.param}:${slot.text}`, `DTSTART${start.param}:${start.text}`,
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
 * @returns {Rendered}
 */
function renderRule(series, kind, head, shared, context, path) {
  const { base } = series;
  const form = kind === 'utc' ? 'instant' : kind;
  const at = written(form, placeOf(base.dtstart));
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
    const to = written(form, placeOf(base.dtend));
    length = kind === 'date' ? { days: (to.at - at.at) / DAY, ms: 0 } : { days: 0, ms: to.at - at.at };
    lines.push(`DTEND${to.param}:${to.text}`);
  }
  const rule = ruleLines(base, kind, at, context, path);
  lines.push(...rule);
  // one RDATE per slot, the first given winning as it does in the series
  /** @type {Map<string, { days: number, ms: number }>} */
  const periods = new Map();
  /** @type {Map<string, { from: Written, to: Written }>} */
  const onRule = new Map();
  const seen = new Set();
  let rdates = rule.length - 1;
  for (const [i, entry] of series.rdates.entries()) {
    const period = entry.kind === undefined;
    const from = written(form, placeOf(period ? entry.start : entry));
    const id = slotIdOf(from.at, kind);
    if (seen.has(id))
      continue;
    seen.add(id);
    if (!period) {
      lines.push(`RDATE${from.param}:${from.text}`);
      rdates++;
      continue;
    }
    if (kind === 'date')
      throw new IcalError('ICAL3017', 'a period of dates is no RDATE; an RDATE period runs between two date-times', `${path}/series/rdates/${i}`);
    const to = written(form, placeOf(entry.end));
    periods.set(id, { days: 0, ms: to.at - from.at });
    // a period on a slot the rule makes too would be a duplicate instance
    // whose length a reader may take from either: it is written as that
    // slot's own VEVENT instead
    if (ruleMakes(base, kind, from.at, context, path))
      onRule.set(id, { from, to });
    else {
      lines.push(`RDATE;VALUE=PERIOD:${from.text}/${to.text}`);
      rdates++;
    }
  }
  const excluded = new Set();
  for (const entry of series.exdates) {
    const value = written(form, placeOf(entry));
    excluded.add(slotIdOf(value.at, kind));
    lines.push(`EXDATE${value.param}:${value.text}`);
  }
  const moved = [];
  const overridden = new Set();
  for (const override of series.overrides) {
    overridden.add(override.recurrenceId);
    const slot = slotOf(override.recurrenceId, kind, { policy: base.policy, provider: null }, `${path}/series/overrides`);
    if (override.status === 'cancelled') {
      lines.push(`EXDATE${slot.param}:${slot.text}`);
      continue;
    }
    const start = written(form, placeOf(override.start));
    let endLine;
    if (override.end !== undefined) {
      const end = written(form, placeOf(override.end));
      endLine = `DTEND${end.param}:${end.text}`;
    }
    else {
      const own = periods.get(override.recurrenceId) ?? length;
      if (own !== undefined)
        endLine = `DURATION:${formatDuration(own)}`;
    }
    moved.push(movedEvent(head, shared, slot, start, endLine));
  }
  for (const [id, { from, to }] of onRule) {
    if (!overridden.has(id) && !excluded.has(id))
      moved.push(movedEvent(head, shared, from, from, `DTEND:${to.text}`));
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
 * @returns {string[]}
 */
function ruleLines(base, kind, at, context, path) {
  const { COUNT, UNTIL, ...open } = base.rrule;
  const interval = open.INTERVAL ?? 1;
  const step = (open.FREQ === 'WEEKLY' ? 7 : 1) * interval * DAY;
  // the rule started one whole period earlier makes the start exactly when
  // the rule does; near year 0 the question is asked 400 years on, where the
  // Gregorian calendar repeats day for day (146097 days, 20871 weeks)
  const probe = at.at - step >= FIRST_INSTANT ? at.at : at.at + GREGORIAN_CYCLE * interval;
  const synced = ruleMakes(viaCalendar(() => compileRecurrence({ dtstart: valueAt(kind, probe - step), rrule: open, policy: base.policy }),
    `${path}/series`), kind, probe, context, path);
  if (synced)
    return [`RRULE:${formatRRule(base)}`];
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
  if (component.type === undefined)
    throw new IcalError('ICAL3001', "a component has a type: 'event' or 'freebusy'", `${path}/type`);
  throw new IcalError('ICAL3002', `the component type ${String(component.type)} is outside the documented subset ('event', 'freebusy')`, `${path}/type`);
}

//#endregion
