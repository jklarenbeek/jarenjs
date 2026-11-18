//@ts-check

//#region iCalendar reader
// The reader maps the supported subset of RFC 5545 to the values of
// `@jarenjs/core/calendar`, canonical mode: what it maps it maps exactly,
// and everything else is REPORTED, never silently interpreted.
//
// - A property, parameter or component outside the subset is left out
//   of the model and listed in `report.unsupported` with its code, name,
//   path and line (`ICAL1011`-`ICAL1013`).
// - A VTIMEZONE is compiled into a zone provider over the zone horizon
//   (ical-vtimezone.js). Under `vtimezone: 'embedded'`, the default and
//   RFC 5545's rule, a TZID the file defines resolves through that
//   definition; one it cannot compile is reported (`ICAL1014`), and one
//   that disagrees with the caller's provider for an IANA name is
//   reported (`ICAL1023`) whichever source is used.
// - A component whose times or occurrences cannot be read exactly is
//   WITHHELD whole and listed (`ICAL1017`-`ICAL1022`): a missing or
//   repeated property, a malformed value, a TZID that names no IANA zone
//   the provider knows, a rule or series the calendar layer refuses (its
//   CalendarError the cause), EXRULE. An override over this and future
//   occurrences (RANGE=THISANDFUTURE) is read into its series, which the
//   calendar layer expands.
// - `strict: true` turns the first entry into a refusal with its code.
// - Syntax, structure and limits stop the read in either mode
//   (`ICAL1001`-`ICAL1009`, `ICAL2xxx`), from the content-line machine.
//
// One engine reads for all three entries: `parseIcal` feeds the whole
// text, `createIcalReader` takes chunks, `iterateIcal` pulls them. A
// single event or a free/busy component is handed over as soon as its
// END is read. A recurring event's overrides (VEVENTs with its UID and a
// RECURRENCE-ID) may come anywhere in the file, so a series and its
// overrides are held until the input ends, then handed over in the order
// their series began; an override no series claims is reported.
// The reader takes no clock and invents nothing: a component without a
// DTSTAMP has none in the model.

import { CalendarError, compileRecurrence, dateValue, defineSeries, floatingValue, isZone, parseTemporal, toUtc, utcValue, zonedValue }
  from '@jarenjs/core/calendar';
import { ITIP_KINDS, ITIP_METHODS, calendarEntries, componentEntries } from './ical-itip.js';
import { IcalMachine } from './ical-machine.js';
import { IANA_FORM, ZONE_HORIZON, ZoneTable } from './ical-vtimezone.js';
import { IcalError, daysOf, formatDuration, readDuration, wallOf } from './ical-wire.js';
import { limitOption } from './limits.js';
import { ICAL_ITERATE, ICAL_PARSE, ICAL_READ, admitOptions } from './options.js';
import { abortedError, closeIterator } from './pull.js';

const DAY = 86400000;
const DATE_FORM = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_FORM = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
const STATUS = Object.freeze({ TENTATIVE: 'tentative', CONFIRMED: 'confirmed', CANCELLED: 'cancelled' });
const FBTYPE = Object.freeze({ BUSY: 'busy', FREE: 'free', 'BUSY-UNAVAILABLE': 'busy-unavailable', 'BUSY-TENTATIVE': 'busy-tentative' });
const TEXT_PROPERTIES = /** @type {const} */ ([['SUMMARY', 'summary'], ['DESCRIPTION', 'description'], ['LOCATION', 'location']]);

/** The value type each property of the subset takes, and the parameters it reads. */
const EVENT_PROPERTIES = Object.freeze({
  UID: ['TEXT'], DTSTAMP: ['DATE-TIME'], DTSTART: ['DATE-TIME', 'DATE'], DTEND: ['DATE-TIME', 'DATE'], DURATION: ['DURATION'],
  SUMMARY: ['TEXT'], DESCRIPTION: ['TEXT'], LOCATION: ['TEXT'], STATUS: ['TEXT'], SEQUENCE: ['INTEGER'], RRULE: ['RECUR'],
  RDATE: ['DATE-TIME', 'DATE', 'PERIOD'], EXDATE: ['DATE-TIME', 'DATE'], 'RECURRENCE-ID': ['DATE-TIME', 'DATE'],
});
const FREEBUSY_PROPERTIES = Object.freeze({
  UID: ['TEXT'], DTSTAMP: ['DATE-TIME'], DTSTART: ['DATE-TIME'], DTEND: ['DATE-TIME'], FREEBUSY: ['PERIOD'],
});
const AVAILABILITY_PROPERTIES = Object.freeze({
  UID: ['TEXT'], DTSTAMP: ['DATE-TIME'], DTSTART: ['DATE-TIME'], DTEND: ['DATE-TIME'], DURATION: ['DURATION'], PRIORITY: ['INTEGER'],
  BUSYTYPE: ['TEXT'], SUMMARY: ['TEXT'], DESCRIPTION: ['TEXT'], LOCATION: ['TEXT'],
});
const TIME_PARAMETERS = Object.freeze(['VALUE', 'TZID']);
const PARAMETERS = Object.freeze({
  DTSTART: TIME_PARAMETERS, DTEND: TIME_PARAMETERS, RDATE: TIME_PARAMETERS, EXDATE: TIME_PARAMETERS,
  'RECURRENCE-ID': Object.freeze([...TIME_PARAMETERS, 'RANGE']), FREEBUSY: Object.freeze(['VALUE', 'FBTYPE']),
});
/** Properties a component holds at most once. */
const ONCE = Object.freeze(['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'STATUS',
  'SEQUENCE', 'RRULE', 'RECURRENCE-ID', 'PRIORITY', 'BUSYTYPE']);
/** The report entries that withhold their component. */
const WITHHOLDING = Object.freeze(['ICAL1017', 'ICAL1018', 'ICAL1019', 'ICAL1020', 'ICAL1021', 'ICAL1022', 'ICAL1025']);

/**
 * One entry of the report.
 * @typedef {Object} IcalReportEntry
 * @property {string} code - one of `ICAL_CODES`, `ICAL1010`-`ICAL1022`
 * @property {string} name - the component, property (`X-FOO`) or parameter (`SUMMARY;LANGUAGE`) concerned
 * @property {string} path - where it is: `/VCALENDAR/VEVENT[2]/X-FOO`
 * @property {number} line - the physical line it starts on, from 1
 * @property {string} reason
 * @property {true} [withheld] - its component is not in the model
 * @property {{ code: string, reason: string, docPath?: string }} [cause] - the calendar layer's refusal
 */

/**
 * What a read left out.
 * @typedef {Object} IcalReport
 * @property {IcalReportEntry[]} unsupported - every entry, in the order read, up to `maxReported`
 * @property {Record<string, number>} counts - entries by code, every one counted
 * @property {number} omitted - entries past `maxReported`, counted but not listed
 */

/**
 * The reader's options.
 * @typedef {Object} IcalReaderOptions
 * @property {'canonical' | 'lossless'} [mode] - `'canonical'` (the default) reads the model;
 *   `'lossless'`, which only `parseIcal` takes, also keeps the syntax tree over the input's
 *   octets, for `patchIcal`
 * @property {import('@jarenjs/core/series').ZoneProvider | null} [provider] - resolves a TZID
 *   that names an IANA zone and that no VTIMEZONE of the file defines (every TZID under
 *   `vtimezone: 'provider'`); without it such a TZID is reported unresolved
 * @property {'embedded' | 'provider'} [vtimezone] - which definition a TZID the file defines
 *   resolves through: `'embedded'` (the default, RFC 5545's: the file's VTIMEZONE is
 *   authoritative for the file) or `'provider'` (the caller's zone data, which a stale
 *   exporter cannot override, at the cost of reading the file other than it says)
 * @property {[unknown, unknown]} [zoneHorizon] - the `[start, end)` (utc values or epoch
 *   milliseconds) a VTIMEZONE is compiled over; outside it its instants are refused, never
 *   guessed (default 1900-01-01 to 2100-01-01)
 * @property {Partial<typeof import('@jarenjs/core/calendar').VTIMEZONE_LIMITS>} [zoneLimits] - the
 *   compilation's limits (the calendar layer's defaults when absent)
 * @property {boolean} [strict] - refuse at the first report entry, with its code
 * @property {boolean} [strictScheduling] - refuse at the first scheduling entry (a calendar with a METHOD whose
 *   component breaks RFC 5546 §3's table for it), with its code
 * @property {number} [maxOctets] - octets of input
 * @property {number} [maxComponents] - components, every BEGIN inside the calendar counted
 * @property {number} [maxLineOctets] - octets of one unfolded content line
 * @property {number} [maxParameters] - parameters of one content line
 * @property {number} [maxDepth] - nesting of components, the calendar counted as 1
 * @property {number} [maxProperties] - properties of one component
 * @property {number} [maxReported] - report entries listed; past it they are counted only
 */

/**
 * A calendar's METHOD (RFC 5546), as the model spells it.
 * @typedef {'publish' | 'request' | 'reply' | 'add' | 'cancel' | 'refresh' | 'counter' | 'declinecounter'} IcalMethod
 */

/**
 * What a read of a calendar with a METHOD answers beside its model: one
 * message per VEVENT, VTODO, VJOURNAL or VFREEBUSY, and the components'
 * breaches of RFC 5546 §3's table for the method. PUBLISH and REQUEST
 * components (and PUBLISH and REPLY VFREEBUSYs) are calendar data and
 * are also read into the model; every other method's are messages only.
 * @typedef {Object} IcalScheduling
 * @property {IcalMethod} method
 * @property {Record<string, any>[]} messages - `{ component, uid?, dtstamp?, sequence?, recurrenceId?, range?,
 *   organizer?, attendees, requestStatus?, status?, start?, end?, cancellation?, event?, suggested? }`, in the order read
 *   (`start` and `end`, epoch milliseconds, of a VFREEBUSY only)
 * @property {import('./ical-itip.js').SchedulingEntry[]} report - `ICAL1026` (a property or subcomponent the
 *   table requires is missing) and `ICAL1027` (one it excludes, or takes fewer times, is present; or a
 *   component the method does not take), in the order read
 */

/**
 * The zones of a read.
 * @typedef {Object} IcalZones
 * @property {Required<import('@jarenjs/core/series').ZoneProvider>} provider - what the read's zoned values
 *   resolve through: the file's compiled VTIMEZONEs for the TZIDs they define (under
 *   `vtimezone: 'embedded'`), the caller's provider for every other name
 * @property {Record<string, import('@jarenjs/core/calendar').CompiledZone>} compiled - every VTIMEZONE
 *   compiled, by TZID, whichever source `vtimezone` chose
 * @property {string[]} undeclared - TZIDs the read's values use that no VTIMEZONE of the file
 *   defines (RFC 5545 asks for one); they resolve through the caller's provider
 */

/**
 * The syntax tree a lossless read keeps beside the model: the input's
 * octets and every component and property of the calendar over them.
 * Each property carries its name (upper case), parameters and value as
 * written (escapes kept), and `from`/`to`, the octets of its own lines -
 * the folded spelling, folds and line break included; each component
 * carries `from`/`head` (its BEGIN line), `tail`/`to` (its END line), its
 * properties and its children in the order read. Unknown, X- and IANA
 * content is in it exactly as written, and the octets between two spans
 * (a byte order mark, an empty line) belong to neither. `patchIcal` reads
 * only a tree `parseIcal` returned.
 * @typedef {Object} IcalTree
 * @property {'text' | 'octets'} form - what was read: a string, re-emitted as one, or octets
 * @property {Uint8Array} source - the input's octets (a string's UTF-8), a copy
 * @property {import('./ical-machine.js').IcalNode} root - the VCALENDAR component
 * @property {{ prodId: string, method?: IcalMethod, components: Record<string, any>[] }} calendar - the model read
 * @property {IcalZones} zones - the zones of the read
 */

/**
 * The trees `parseIcal` made, each with the options it was read under:
 * `patchIcal` takes no other, and reads its output under the same.
 * @type {WeakMap<object, IcalReaderOptions>}
 */
export const TREES = /* @__PURE__ */ new WeakMap();

//#region report

/** The report a read builds, bounded by `maxReported`. */
class Report {
  /** @type {IcalReportEntry[]} */
  #entries = [];
  /** @type {Record<string, number>} */
  #counts = {};
  #omitted = 0;
  #strict;
  #max;

  /**
   * @param {boolean} strict
   * @param {number} max
   */
  constructor(strict, max) {
    this.#strict = strict;
    this.#max = max;
  }

  /**
   * Add an entry, or refuse with it under `strict`.
   * @param {string} code
   * @param {string} name
   * @param {string} path
   * @param {number} line
   * @param {string} reason
   * @param {unknown} [cause]
   */
  add(code, name, path, line, reason, cause = undefined) {
    if (this.#strict)
      throw new IcalError(code, reason, path, cause, line);
    this.#counts[code] = (this.#counts[code] ?? 0) + 1;
    if (this.#entries.length >= this.#max) {
      this.#omitted++;
      return;
    }
    /** @type {IcalReportEntry} */
    const entry = { code, name, path, line, reason };
    if (WITHHOLDING.includes(code))
      entry.withheld = true;
    if (cause instanceof CalendarError)
      entry.cause = { code: cause.code, reason: cause.reason, ...(cause.docPath !== undefined ? { docPath: cause.docPath } : {}) };
    this.#entries.push(entry);
  }

  /** @returns {IcalReport} */
  json() {
    return { unsupported: [...this.#entries], counts: { ...this.#counts }, omitted: this.#omitted };
  }
}

/**
 * Withhold the component being read.
 * @param {string} code
 * @param {string} reason
 * @param {{ path: string, line: number }} at
 * @param {unknown} [cause]
 * @returns {never}
 */
function withhold(code, reason, at, cause = undefined) {
  throw new IcalError(code, reason, at.path, cause, at.line);
}

/**
 * Run a calendar-layer constructor; its refusal withholds the component.
 * @template T
 * @param {() => T} call
 * @param {string} code
 * @param {string} what
 * @param {{ path: string, line: number }} at
 * @returns {T}
 */
function viaCalendar(call, code, what, at) {
  try {
    return call();
  }
  catch (error) {
    if (error instanceof CalendarError)
      withhold(code, `${what}: ${error.code} ${error.reason}`, at, error);
    throw error;
  }
}

//#endregion

//#region values

/**
 * The context a component is read in.
 * @typedef {Object} ReadContext
 * @property {any} provider
 * @property {Report} report
 * @property {Map<string, boolean>} zones - TZIDs already asked of the provider
 * @property {ZoneTable} zoneTable - the file's compiled VTIMEZONEs and the TZIDs its values use
 */

/**
 * A property's parameters: those of the subset by name (each once), the
 * rest reported.
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {readonly string[]} types - the value types it takes, the default first
 * @param {ReadContext} context
 * @returns {Map<string, string>}
 */
function paramsOf(prop, types, context) {
  const known = /** @type {Record<string, readonly string[]>} */ (PARAMETERS)[prop.name] ?? ['VALUE'];
  /** @type {Map<string, string>} */
  const params = new Map();
  for (const param of prop.params) {
    if (!known.includes(param.name)) {
      context.report.add('ICAL1012', `${prop.name};${param.name}`, `${prop.path};${param.name}`, prop.line,
        `the parameter ${param.name} of ${prop.name} is outside the subset; ${prop.name} is read without it`);
      continue;
    }
    if (params.has(param.name) || param.values.length !== 1)
      withhold('ICAL1018', `${prop.name} takes one value of ${param.name}`, prop);
    params.set(param.name, param.name === 'TZID' ? param.values[0] : param.values[0].toUpperCase());
  }
  const type = params.get('VALUE');
  if (type !== undefined && !types.includes(type))
    withhold('ICAL1018', `${prop.name} takes VALUE=${types.join(' or ')}, not ${type}`, prop);
  return params;
}

/**
 * Unescape TEXT (RFC 5545 §3.3.11): `\\`, `\;`, `\,`, `\n` and `\N`.
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @returns {string}
 */
export function textOf(prop) {
  const { value } = prop;
  if (!value.includes('\\'))
    return value;
  let out = '';
  let from = 0;
  for (let i = value.indexOf('\\'); i >= 0; i = value.indexOf('\\', from)) {
    const next = value[i + 1];
    let char;
    if (next === 'n' || next === 'N')
      char = '\n';
    else if (next === '\\' || next === ';' || next === ',')
      char = next;
    else
      withhold('ICAL1018', `${prop.name} holds the escape \\${next ?? ''}, which TEXT does not define`, prop);
    out += value.slice(from, i) + char;
    from = i + 2;
  }
  return out + value.slice(from);
}

/**
 * The zone a TZID names, when it is an IANA name the provider knows.
 * @param {string} tzid
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {ReadContext} context
 * @returns {string}
 */
function zoneOf(tzid, prop, context) {
  if (context.zoneTable.embedded(tzid))
    return tzid;
  if (!IANA_FORM.test(tzid))
    withhold('ICAL1019', `the TZID '${tzid}' of ${prop.name} is no IANA zone name, and no VTIMEZONE read before it defines it; it is not guessed`, prop);
  if (context.provider === null)
    withhold('ICAL1019', `the TZID '${tzid}' of ${prop.name} resolves through a zone provider, and none was given`, prop);
  let known = context.zones.get(tzid);
  if (known === undefined) {
    known = isZone(tzid, context.provider);
    if (context.zones.size >= 64)
      context.zones.clear();
    context.zones.set(tzid, known);
  }
  if (!known)
    withhold('ICAL1019', `the provider knows no zone '${tzid}' (the TZID of ${prop.name})`, prop);
  return tzid;
}

/**
 * One DATE or DATE-TIME value of a property.
 * @param {string} text
 * @param {string} type - DATE or DATE-TIME
 * @param {string | undefined} tzid
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {ReadContext} context
 * @returns {any} a date, floating, utc or zoned value
 */
function timeOf(text, type, tzid, prop, context) {
  if (type === 'DATE') {
    const form = DATE_FORM.exec(text);
    if (form === null)
      withhold('ICAL1018', `${prop.name} is a DATE (YYYYMMDD), not '${text}'`, prop);
    return viaCalendar(() => dateValue(`${form[1]}-${form[2]}-${form[3]}`), 'ICAL1018', `${prop.name} '${text}'`, prop);
  }
  const form = DATE_TIME_FORM.exec(text);
  if (form === null)
    withhold('ICAL1018', `${prop.name} is a DATE-TIME (YYYYMMDDTHHMMSS, Z for UTC), not '${text}'`, prop);
  const date = `${form[1]}-${form[2]}-${form[3]}`;
  const time = `${form[4]}:${form[5]}:${form[6]}`;
  if (form[7] === 'Z') {
    if (tzid !== undefined)
      withhold('ICAL1018', `${prop.name} is a UTC time and takes no TZID`, prop);
    return viaCalendar(() => utcValue(`${date}T${time}Z`), 'ICAL1018', `${prop.name} '${text}'`, prop);
  }
  if (tzid === undefined)
    return viaCalendar(() => floatingValue(date, time), 'ICAL1018', `${prop.name} '${text}'`, prop);
  const zone = zoneOf(tzid, prop, context);
  const value = viaCalendar(() => zonedValue(date, time, zone), 'ICAL1018', `${prop.name} '${text}'`, prop);
  context.zoneTable.use(zone, wallOf(date, time, prop.path));
  return value;
}

/**
 * The value type and TZID of a property that holds times; a TZID on a
 * DATE is reported and left out.
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {ReadContext} context
 * @returns {{ type: string, tzid: string | undefined }}
 */
function timeParams(prop, context) {
  const params = paramsOf(prop, /** @type {any} */ (EVENT_PROPERTIES)[prop.name], context);
  const type = params.get('VALUE') ?? 'DATE-TIME';
  const tzid = params.get('TZID');
  if (type !== 'DATE' || tzid === undefined)
    return { type, tzid };
  context.report.add('ICAL1012', `${prop.name};TZID`, `${prop.path};TZID`, prop.line, `a DATE has no time of day for a TZID to place; ${prop.name} is read without it`);
  return { type, tzid: undefined };
}

/**
 * The time of a property that holds one: DTSTART, DTEND, RECURRENCE-ID.
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {ReadContext} context
 * @returns {any}
 */
function singleTime(prop, context) {
  const { type, tzid } = timeParams(prop, context);
  if (prop.value.includes(','))
    withhold('ICAL1018', `${prop.name} holds one value`, prop);
  return timeOf(prop.value, type, tzid, prop, context);
}

/**
 * Where a value lies: days times a day, a wall clock, or an instant.
 * @param {any} value
 * @returns {number}
 */
function placeOf(value) {
  if (value.kind === 'date')
    return daysOf(value.date) * DAY;
  if (value.kind === 'utc')
    return Date.parse(value.instant);
  return wallOf(value.date, value.time, '');
}

/**
 * A date, utc or floating value at a place.
 * @param {string} kind
 * @param {number} at
 * @returns {any}
 */
function valueAt(kind, at) {
  const iso = new Date(at).toISOString();
  if (kind === 'date')
    return dateValue(iso.slice(0, 10));
  if (kind === 'utc')
    return utcValue(`${iso.slice(0, 19)}Z`);
  return floatingValue(iso.slice(0, 10), iso.slice(11, 19));
}

/**
 * Whether two values are one: kind, place and zone.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
const sameValue = (a, b) => a.kind === b.kind && a.zone === b.zone && placeOf(a) === placeOf(b);

/**
 * The length a DURATION gives, checked against its start's kind.
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {any} start
 * @param {ReadContext} context
 * @returns {{ days: number, ms: number }}
 */
function durationOf(prop, start, context) {
  paramsOf(prop, EVENT_PROPERTIES.DURATION, context);
  let length;
  try {
    length = readDuration(prop.value, prop.path);
  }
  catch {
    withhold('ICAL1018', `${prop.name} is an RFC 5545 duration such as P1W, P1D or PT1H30M, not '${prop.value}'`, prop);
  }
  if (start.kind === 'date' && length.ms !== 0)
    withhold('ICAL1018', `an event that starts on a DATE lasts whole days or weeks, not ${prop.value}`, prop);
  return length;
}

/**
 * The end a length gives a start of a kind without a zone: days for a
 * date, wall or UTC time otherwise.
 * @param {any} start
 * @param {{ days: number, ms: number }} length
 * @param {{ path: string, line: number, name: string }} at
 * @returns {any}
 */
function endAfter(start, length, at) {
  return viaCalendar(() => valueAt(start.kind, placeOf(start) + length.days * DAY + length.ms), 'ICAL1018', at.name, at);
}

/**
 * The length a zoned start is given, as RFC 5545 §3.3.6 reads it: the
 * days on the wall clock, then the time exactly, through the file's zones
 * under the RFC's policy. It is the end it gives, a wall clock of the
 * zone, where that wall clock names it; an end in the second pass of a
 * repeated hour, which a zoned end does not name, is the duration itself,
 * which the calendar layer reads exactly.
 * @param {any} start
 * @param {{ days: number, ms: number }} length
 * @param {ReadContext} context
 * @param {{ path: string, line: number, name: string }} at
 * @returns {{ end: any } | { duration: string }}
 */
function zonedLength(start, length, context, at) {
  const { value, named } = zonedEnd(start, length, context, at);
  return named ? { end: value } : { duration: formatDuration(length) };
}

/**
 * The end a length gives a zoned start (see {@link zonedLength}): its
 * wall clock, its instant, and whether that wall clock names the instant.
 * @param {any} start
 * @param {{ days: number, ms: number }} length
 * @param {ReadContext} context
 * @param {{ path: string, line: number, name: string }} at
 * @returns {{ value: any, instant: number, named: boolean }}
 */
function zonedEnd(start, length, context, at) {
  const { provider } = context.zoneTable;
  const { zone } = start;
  const dayWall = valueAt('floating', placeOf(start) + length.days * DAY);
  const instant = viaCalendar(() => toUtc({ ...dayWall, kind: 'zoned', zone }, { provider, policy: 'rfc5545' }), 'ICAL1018', at.name, at).instant
    + length.ms;
  const parts = viaCalendar(() => {
    try {
      return provider.toParts(instant, zone);
    }
    catch (error) {
      if (error instanceof CalendarError)
        throw error;
      throw new CalendarError('JY0004', `the zone provider's toParts(instant, '${zone}') threw`, '/provider', error);
    }
  }, 'ICAL1018', at.name, at);
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const value = { kind: 'zoned', date: `${String(parts.year).padStart(4, '0')}-${two(parts.month)}-${two(parts.day)}`,
    time: `${two(parts.hours)}:${two(parts.minutes)}:${two(Math.floor(parts.seconds))}`, zone };
  return { value, instant, named: viaCalendar(() => toUtc(value, { provider, policy: 'rfc5545' }), 'ICAL1018', at.name, at).instant === instant };
}

/**
 * The exact time between two zoned values of one zone, through the
 * file's zones under the RFC's policy.
 * @param {any} start
 * @param {any} end
 * @param {ReadContext} context
 * @param {{ path: string, line: number, name: string }} at
 * @returns {number}
 */
function exactBetween(start, end, context, at) {
  const { provider } = context.zoneTable;
  const instant = (/** @type {any} */ value) => viaCalendar(() => toUtc(value, { provider, policy: 'rfc5545' }), 'ICAL1018', at.name, at).instant;
  return instant(end) - instant(start);
}

/**
 * The values of an RDATE or EXDATE: dates, date-times or periods.
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {ReadContext} context
 * @returns {any[]} values, and `{ start, end }` periods (`{ start, duration }` for a zoned
 *   start/duration whose end a zoned wall clock does not name)
 */
function listOf(prop, context) {
  const { type, tzid } = timeParams(prop, context);
  return prop.value.split(',').map((text) => {
    if (type !== 'PERIOD')
      return timeOf(text, type, tzid, prop, context);
    const slash = text.indexOf('/');
    if (slash < 0)
      withhold('ICAL1018', `a PERIOD of ${prop.name} is start/end or start/duration, not '${text}'`, prop);
    const start = timeOf(text.slice(0, slash), 'DATE-TIME', tzid, prop, context);
    const rest = text.slice(slash + 1);
    if (/^[+]?P/.test(rest)) {
      const length = durationOf({ ...prop, value: rest, params: [] }, start, context);
      return start.kind === 'zoned' ? { start, ...zonedLength(start, length, context, prop) } : { start, end: endAfter(start, length, prop) };
    }
    const end = timeOf(rest, 'DATE-TIME', tzid, prop, context);
    if (end.kind !== start.kind || placeOf(end) < placeOf(start))
      withhold('ICAL1018', `a PERIOD of ${prop.name} ends at or after its start, in its kind`, prop);
    return { start, end };
  });
}

/**
 * A DTSTAMP: a UTC DATE-TIME, as epoch milliseconds.
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {ReadContext} context
 * @returns {number}
 */
function instantOf(prop, context) {
  if (paramsOf(prop, ['DATE-TIME'], context).has('TZID'))
    withhold('ICAL1018', `${prop.name} is a UTC time and takes no TZID`, prop);
  return instantText(prop.value, prop, context);
}

/**
 * One UTC DATE-TIME text, as epoch milliseconds.
 * @param {string} text
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {ReadContext} context
 * @returns {number}
 */
function instantText(text, prop, context) {
  const value = timeOf(text, 'DATE-TIME', undefined, prop, context);
  if (value.kind !== 'utc')
    withhold('ICAL1018', `${prop.name} is a UTC time (…Z), not '${text}'`, prop);
  return Date.parse(value.instant);
}

//#endregion

//#region components

/**
 * A component's properties by name, those outside its subset reported
 * and left out, and each property the subset holds once checked.
 * @param {import('./ical-machine.js').IcalNode} node
 * @param {Readonly<Record<string, readonly string[]>>} known
 * @param {ReadContext} context
 * @param {string} [read] - the subcomponent its caller reads itself
 * @returns {Map<string, import('./ical-machine.js').IcalProperty[]>}
 */
function propertiesOf(node, known, context, read = undefined) {
  for (const child of node.children) {
    if (child.name === read)
      continue;
    context.report.add('ICAL1013', child.name, child.path, child.line,
      `${child.name} inside ${node.name} is outside the subset; it is left out with everything inside it`);
  }
  /** @type {Map<string, import('./ical-machine.js').IcalProperty[]>} */
  const props = new Map();
  for (const prop of node.props) {
    if (prop.name === 'EXRULE')
      withhold('ICAL1022', 'EXRULE removes occurrences by a rule, which this release does not read', prop);
    if (!Object.hasOwn(known, prop.name)) {
      context.report.add('ICAL1011', prop.name, prop.path, prop.line, `${prop.name} in ${node.name} is outside the subset; it is left out`);
      continue;
    }
    const list = props.get(prop.name);
    if (list === undefined)
      props.set(prop.name, [prop]);
    else if (ONCE.includes(prop.name))
      withhold('ICAL1017', `${node.name} holds ${prop.name} once; it is given again`, prop);
    else
      list.push(prop);
  }
  return props;
}

/**
 * The one property of a name, if any.
 * @param {Map<string, import('./ical-machine.js').IcalProperty[]>} props
 * @param {string} name
 * @returns {import('./ical-machine.js').IcalProperty | undefined}
 */
const one = (props, name) => props.get(name)?.[0];

/**
 * The UID of a component, which it requires.
 * @param {Map<string, import('./ical-machine.js').IcalProperty[]>} props
 * @param {import('./ical-machine.js').IcalNode} node
 * @param {ReadContext} context
 * @returns {string}
 */
function uidOf(props, node, context) {
  const prop = one(props, 'UID');
  if (prop === undefined)
    withhold('ICAL1017', `${node.name} has a UID`, node);
  paramsOf(prop, ['TEXT'], context);
  const uid = textOf(prop);
  if (uid === '')
    withhold('ICAL1018', 'the UID is not empty', prop);
  return uid;
}

/**
 * The text, status and sequence an event's VEVENTs carry.
 * @param {Map<string, import('./ical-machine.js').IcalProperty[]>} props
 * @param {ReadContext} context
 * @returns {Record<string, any>}
 */
function eventText(props, context) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, member] of TEXT_PROPERTIES) {
    const prop = one(props, name);
    if (prop !== undefined) {
      paramsOf(prop, ['TEXT'], context);
      out[member] = textOf(prop);
    }
  }
  const status = one(props, 'STATUS');
  if (status !== undefined) {
    paramsOf(status, ['TEXT'], context);
    const value = status.value.toUpperCase();
    if (!Object.hasOwn(STATUS, value))
      withhold('ICAL1018', `the STATUS of a VEVENT is TENTATIVE, CONFIRMED or CANCELLED, not '${status.value}'`, status);
    out.status = STATUS[/** @type {keyof typeof STATUS} */ (value)];
  }
  const sequence = one(props, 'SEQUENCE');
  if (sequence !== undefined) {
    paramsOf(sequence, ['INTEGER'], context);
    if (!/^\+?\d{1,15}$/.test(sequence.value))
      withhold('ICAL1018', `SEQUENCE is a whole number from 0, not '${sequence.value}'`, sequence);
    out.sequence = Number(sequence.value);
  }
  return out;
}

/**
 * The start, and the end or duration, of a VEVENT.
 * @param {Map<string, import('./ical-machine.js').IcalProperty[]>} props
 * @param {import('./ical-machine.js').IcalNode} node
 * @param {ReadContext} context
 * @returns {{ start: any, end?: any, duration?: string, length?: { days: number, ms: number } }}
 */
function spanOf(props, node, context) {
  const startProp = one(props, 'DTSTART');
  if (startProp === undefined)
    withhold('ICAL1017', 'a VEVENT has a DTSTART', node);
  const start = singleTime(startProp, context);
  const endProp = one(props, 'DTEND');
  const durationProp = one(props, 'DURATION');
  if (endProp !== undefined && durationProp !== undefined)
    withhold('ICAL1017', 'a VEVENT takes DTEND or DURATION, not both', durationProp);
  if (durationProp !== undefined) {
    const length = durationOf(durationProp, start, context);
    return { start, duration: durationProp.value, length };
  }
  if (endProp === undefined)
    return { start };
  const end = singleTime(endProp, context);
  const timed = (/** @type {any} */ value) => (value.kind === 'utc' || value.kind === 'zoned' ? 'instant' : value.kind);
  if (timed(end) !== timed(start))
    withhold('ICAL1018', `DTEND is of DTSTART's kind (${start.kind}), not ${end.kind}`, endProp);
  if (end.kind === start.kind && end.zone === start.zone) {
    const delta = placeOf(end) - placeOf(start);
    if (delta < 0 || (delta === 0 && start.kind === 'date'))
      withhold('ICAL1018', 'DTEND is after DTSTART', endProp);
    // an end at the start is no length, which a time without an end has
    if (delta === 0)
      return { start };
    return { start, end, length: start.kind === 'date' ? { days: delta / DAY, ms: 0 } : { days: 0, ms: delta } };
  }
  return { start, end };
}

/**
 * Read one VEVENT: a single event, the master of a series, or an
 * override of one.
 * @param {import('./ical-machine.js').IcalNode} node
 * @param {ReadContext} context
 * @param {boolean} [asMaster] - read a single event as the master of a series of itself
 * @returns {{ type: 'single', component: Record<string, any> } | { type: 'master', master: Master } | { type: 'override', override: Override }}
 */
function readEvent(node, context, asMaster = false) {
  const props = propertiesOf(node, EVENT_PROPERTIES, context);
  const uid = uidOf(props, node, context);
  const stampProp = one(props, 'DTSTAMP');
  const dtstamp = stampProp === undefined ? undefined : instantOf(stampProp, context);
  const span = spanOf(props, node, context);
  const text = eventText(props, context);
  const rrule = one(props, 'RRULE');
  const rdates = (props.get('RDATE') ?? []).flatMap((prop) => listOf(prop, context));
  const exdates = (props.get('EXDATE') ?? []).flatMap((prop) => listOf(prop, context));
  const idProp = one(props, 'RECURRENCE-ID');
  if (idProp !== undefined) {
    if (rrule !== undefined || rdates.length !== 0 || exdates.length !== 0)
      withhold('ICAL1017', 'an override (RECURRENCE-ID) holds no RRULE, RDATE or EXDATE of its own', idProp);
    const recurrenceId = singleTime(idProp, context);
    const range = idProp.params.find((param) => param.name === 'RANGE')?.values[0].toUpperCase();
    if (range !== undefined && range !== 'THISANDFUTURE')
      withhold('ICAL1018', `RANGE is THISANDFUTURE, not ${range}`, idProp);
    return { type: 'override', override: { uid, dtstamp, recurrenceId, range, span, text, node, idProp } };
  }
  if (rrule !== undefined) {
    paramsOf(rrule, ['RECUR'], context);
    if (span.start.kind === 'zoned')
      context.zoneTable.use(span.start.zone, wallOf(span.start.date, span.start.time, rrule.path), true);
    return { type: 'master', master: { uid, dtstamp, span, text, rrule: rrule.value, rdates, exdates, node } };
  }
  if (rdates.length !== 0 || asMaster)
    return { type: 'master', master: { uid, dtstamp, span, text, rrule: undefined, rdates, exdates, node } };
  if (exdates.length !== 0)
    withhold('ICAL1022', 'EXDATE on an event with no RRULE or RDATE removes its only occurrence, which this release does not read', props.get('EXDATE')[0]);
  /** @type {Record<string, any>} */
  const component = { type: 'event', uid };
  if (dtstamp !== undefined)
    component.dtstamp = dtstamp;
  component.start = span.start;
  if (span.start.kind === 'date' && span.end !== undefined) {
    component.start = viaCalendar(() => parseTemporal({ kind: 'date-range', start: span.start.date, end: span.end.date }), 'ICAL1018', 'DTSTART and DTEND', node);
  }
  else if (span.end !== undefined)
    component.end = span.end;
  else if (span.duration !== undefined)
    component.duration = span.duration;
  if (span.start.kind === 'zoned' || span.end?.kind === 'zoned')
    component.policy = 'rfc5545';
  Object.assign(component, text);
  return { type: 'single', component };
}

/**
 * @typedef {{ uid: string, dtstamp: number | undefined, span: ReturnType<typeof spanOf>, text: Record<string, any>,
 *   rrule: string | undefined, rdates: any[], exdates: any[], node: import('./ical-machine.js').IcalNode }} Master
 * @typedef {{ uid: string, dtstamp: number | undefined, recurrenceId: any, range: string | undefined, span: ReturnType<typeof spanOf>,
 *   text: Record<string, any>, node: import('./ical-machine.js').IcalNode, idProp: import('./ical-machine.js').IcalProperty }} Override
 */

/**
 * The recurrenceId a slot's value spells.
 * @param {any} value
 * @returns {string}
 */
export function slotId(value) {
  if (value.kind === 'date')
    return value.date;
  if (value.kind === 'utc')
    return `${new Date(Date.parse(value.instant)).toISOString().slice(0, 19)}Z`;
  return `${value.date}T${value.time}`;
}

/**
 * The length a series gives one of its slots: an RDATE period's own at
 * that slot, or else the series'.
 * @param {Master} master
 * @param {string} id
 * @param {{ days: number, ms: number }} none - the length of a slot the series gives none
 * @returns {{ days: number, ms: number }}
 */
function slotLength(master, id, none) {
  const period = master.rdates.find((entry) => entry.kind === undefined && slotId(entry.start) === id);
  if (period === undefined)
    return master.span.length ?? none;
  if (period.end === undefined)
    return readDuration(period.duration, '');
  return { days: 0, ms: placeOf(period.end) - placeOf(period.start) };
}

/**
 * A series' override, from its VEVENT.
 * @param {Override} override
 * @param {Master} master
 * @param {ReadContext} context
 * @param {Override[]} [ranges] - the series' overrides over this and future occurrences
 * @returns {Record<string, any>}
 */
function overrideOf(override, master, context, ranges = []) {
  const { start } = master.span;
  const { recurrenceId, span, idProp, node } = override;
  const kindOf = (/** @type {any} */ value) => `${value.kind}${value.zone === undefined ? '' : ` in ${value.zone}`}`;
  if (recurrenceId.kind !== start.kind || recurrenceId.zone !== start.zone)
    withhold('ICAL1018', `the RECURRENCE-ID is of the series' kind (${kindOf(start)}), not ${kindOf(recurrenceId)}`, idProp);
  for (const [name, member] of [...TEXT_PROPERTIES, ['SEQUENCE', 'sequence'], ['DTSTAMP', 'dtstamp']]) {
    const own = member === 'dtstamp' ? override.dtstamp : override.text[member];
    const series = member === 'dtstamp' ? master.dtstamp : master.text[member];
    if (own !== series) {
      context.report.add('ICAL1016', name, `${node.path}/${name}`, node.line,
        `the override of ${slotId(recurrenceId)} has another ${name} than its series; the series' is kept`);
    }
  }
  const own = override.text.status;
  if (own === 'cancelled')
    return { recurrenceId: slotId(recurrenceId), status: 'cancelled', ...(override.range !== undefined ? { range: override.range } : {}) };
  if (own !== master.text.status) {
    context.report.add('ICAL1016', 'STATUS', `${node.path}/STATUS`, node.line,
      `the override of ${slotId(recurrenceId)} has another STATUS than its series; the series' is kept`);
  }
  if (span.start.kind !== start.kind || span.start.zone !== start.zone)
    withhold('ICAL1018', `the override's DTSTART is of the series' kind (${kindOf(start)}), not ${kindOf(span.start)}`, node);
  /** @type {Record<string, any>} */
  const out = { recurrenceId: slotId(recurrenceId), status: 'moved', start: span.start };
  // an override with no end lasts what an event with no end lasts (RFC
  // 5545 §3.6.1: a day for a date, nothing for a time); the model's
  // override without one keeps its slot's length (an RDATE period's own,
  // or else the series'), so the end is spelled out exactly where the two
  // differ. A range carries its length to every later slot only where it
  // changes its own slot's (§3.8.4.4: "if the duration of the given
  // recurrence instance is modified"), so a range of its own slot's
  // length has no end, and each later slot keeps its own
  const none = { days: start.kind === 'date' ? 1 : 0, ms: 0 };
  const same = (/** @type {{ days: number, ms: number }} */ a, /** @type {{ days: number, ms: number }} */ b) => a.days === b.days && a.ms === b.ms;
  const id = slotId(recurrenceId);
  if (span.end !== undefined && (override.range === undefined || span.length === undefined || !same(span.length, slotLength(master, id, none))))
    out.end = span.end;
  else if (span.end === undefined) {
    const own = span.length ?? none;
    // a series whose DTEND lies in another zone has no slot length here:
    // the calendar layer refuses its rule, and a series of extra dates is withheld
    // and one after an override over this and future occurrences lasts
    // what that range gives: its own length where it changes its slot's
    const over = override.range === undefined
      ? ranges.filter((range) => slotId(range.recurrenceId) <= id)
        .reduce((/** @type {Override | undefined} */ a, b) => (a === undefined || slotId(b.recurrenceId) > slotId(a.recurrenceId) ? b : a), undefined)
      : undefined;
    const overLength = over === undefined || over.text.status === 'cancelled' || (over.span.end !== undefined && over.span.length === undefined)
      ? undefined : over.span.length ?? none;
    const slot = overLength !== undefined && !same(overLength, slotLength(master, slotId(/** @type {Override} */ (over).recurrenceId), none))
      ? overLength : slotLength(master, id, none);
    if (!same(own, slot)) {
      const at = { path: node.path, line: node.line, name: 'the override\'s length' };
      if (own.days === 0 && own.ms === 0)
        out.end = span.start;
      else
        Object.assign(out, span.start.kind === 'zoned' ? zonedLength(span.start, own, context, at) : { end: endAfter(span.start, own, at) });
    }
  }
  if (override.range !== undefined)
    out.range = override.range;
  return out;
}

/**
 * A series from its master VEVENT and its overrides.
 * @param {Master} master
 * @param {Override[]} overrides
 * @param {ReadContext} context
 * @returns {Record<string, any>}
 */
function seriesOf(master, overrides, context) {
  const { start, end, duration, length } = master.span;
  const at = master.node;
  let base = null;
  let rdates = master.rdates;
  if (master.rrule !== undefined) {
    /** @type {any} */
    const definition = { dtstart: start, rrule: master.rrule };
    if (duration !== undefined)
      definition.duration = duration;
    else if (end !== undefined)
      definition.dtend = end;
    base = viaCalendar(() => compileRecurrence(definition), 'ICAL1020', 'the recurrence', at);
    // DTSTART is the series' first occurrence: an RDATE of it says nothing more
    rdates = rdates.filter((entry) => entry.kind === undefined || !sameValue(entry, start));
  }
  else {
    // no rule: DTSTART and every RDATE are the occurrences, each as long as DTSTART's event
    const slot = (/** @type {any} */ value) => {
      if (value.kind === undefined || length === undefined || (value.kind === 'date' && length.days === 1 && length.ms === 0))
        return value;
      if (end !== undefined && sameValue(value, start))
        return { start: value, end };
      const where = { path: at.path, line: at.line, name: 'the length of an RDATE' };
      if (value.kind !== 'zoned')
        return { start: value, end: endAfter(value, exact ?? length, where) };
      return { start: value, ...zonedLength(value, exact ?? length, context, where) };
    };
    // a zoned DTEND gives every RDATE the exact time between it and DTSTART (RFC 5545 §3.8.5.3)
    const exact = start.kind === 'zoned' && end !== undefined && length !== undefined
      ? { days: 0, ms: exactBetween(start, end, context, { path: at.path, line: at.line, name: 'DTEND' }) } : undefined;
    if (end !== undefined && length === undefined)
      withhold('ICAL1022', 'a series of extra dates whose DTEND lies in another zone than DTSTART', at);
    rdates = [start, ...rdates.filter((entry) => entry.kind === undefined || !sameValue(entry, start))].map(slot);
  }
  const definition = { uid: master.uid, ...(master.text.sequence !== undefined ? { sequence: master.text.sequence } : {}), base,
    rdates, exdates: master.exdates, overrides: overrides.map((override) => overrideOf(override, master, context, overrides.filter((other) => other.range !== undefined))) };
  const series = viaCalendar(() => defineSeries(/** @type {any} */ (definition)), 'ICAL1020', 'the series', at);
  /** @type {Record<string, any>} */
  const component = { type: 'event', series };
  if (master.dtstamp !== undefined)
    component.dtstamp = master.dtstamp;
  for (const [, member] of TEXT_PROPERTIES) {
    if (master.text[member] !== undefined)
      component[member] = master.text[member];
  }
  if (master.text.status !== undefined)
    component.status = master.text.status;
  return component;
}

/**
 * Read one VFREEBUSY.
 * @param {import('./ical-machine.js').IcalNode} node
 * @param {ReadContext} context
 * @returns {Record<string, any>}
 */
function readFreebusy(node, context) {
  const props = propertiesOf(node, FREEBUSY_PROPERTIES, context);
  /** @type {Record<string, any>} */
  const component = { type: 'freebusy', uid: uidOf(props, node, context) };
  for (const [name, member] of [['DTSTAMP', 'dtstamp'], ['DTSTART', 'start'], ['DTEND', 'end']]) {
    const prop = one(props, name);
    if (prop !== undefined)
      component[member] = instantOf(prop, context);
  }
  if (component.start !== undefined && component.end !== undefined && component.end <= component.start)
    withhold('ICAL1018', 'the DTEND of a VFREEBUSY is after its DTSTART', one(props, 'DTEND'));
  component.periods = (props.get('FREEBUSY') ?? []).flatMap((prop) => {
    const params = paramsOf(prop, ['PERIOD'], context);
    const type = params.get('FBTYPE') ?? 'BUSY';
    if (!Object.hasOwn(FBTYPE, type))
      withhold('ICAL1018', `FBTYPE is FREE, BUSY, BUSY-UNAVAILABLE or BUSY-TENTATIVE, not ${type}`, prop);
    return prop.value.split(',').map((text) => {
      const slash = text.indexOf('/');
      if (slash < 0)
        withhold('ICAL1018', `a FREEBUSY period is start/end or start/duration, not '${text}'`, prop);
      const start = instantText(text.slice(0, slash), prop, context);
      const rest = text.slice(slash + 1);
      let end;
      if (/^[+]?P/.test(rest)) {
        const length = durationOf({ ...prop, value: rest, params: [] }, { kind: 'utc' }, context);
        end = start + length.days * DAY + length.ms;
      }
      else
        end = instantText(rest, prop, context);
      if (end <= start)
        withhold('ICAL1018', `a FREEBUSY period ends after it starts: '${text}'`, prop);
      return { start, end, fbtype: FBTYPE[/** @type {keyof typeof FBTYPE} */ (type)] };
    });
  });
  return component;
}

/**
 * Read one VAVAILABILITY (RFC 7953): its period, PRIORITY and BUSYTYPE,
 * and each AVAILABLE as a series (a recurring one with its RDATEs,
 * EXDATEs and RECURRENCE-ID overrides, which are AVAILABLEs of its UID).
 * Its times are UTC or zoned DATE-TIMEs (§3.1). What the availability
 * layers cannot hold is withheld whole (`ICAL1025`): a BUSYTYPE other than
 * BUSY-UNAVAILABLE, and AVAILABLE times of more than one kind.
 * @param {import('./ical-machine.js').IcalNode} node
 * @param {ReadContext} context
 * @returns {Record<string, any>}
 */
function readAvailability(node, context) {
  const props = propertiesOf(node, AVAILABILITY_PROPERTIES, context, 'AVAILABLE');
  /** @type {Record<string, any>} */
  const component = { type: 'availability', uid: uidOf(props, node, context) };
  const stamp = one(props, 'DTSTAMP');
  if (stamp !== undefined)
    component.dtstamp = instantOf(stamp, context);
  const timed = (/** @type {any} */ value, /** @type {any} */ prop) => {
    if (value.kind !== 'utc' && value.kind !== 'zoned')
      withhold('ICAL1018', `the times of a VAVAILABILITY and its AVAILABLE components are DATE-TIMEs in UTC or with a TZID (RFC 7953 §3.1), not ${value.kind}`, prop);
    return value;
  };
  const startProp = one(props, 'DTSTART');
  const endProp = one(props, 'DTEND');
  const durationProp = one(props, 'DURATION');
  if (endProp !== undefined && durationProp !== undefined)
    withhold('ICAL1017', 'a VAVAILABILITY takes DTEND or DURATION, not both', durationProp);
  if (durationProp !== undefined && startProp === undefined)
    withhold('ICAL1017', 'a VAVAILABILITY with a DURATION has a DTSTART', durationProp);
  const instant = (/** @type {any} */ value, /** @type {any} */ prop) => (value.kind === 'utc' ? Date.parse(value.instant)
    : viaCalendar(() => toUtc(value, { provider: context.zoneTable.provider, policy: 'rfc5545' }), 'ICAL1018', prop.name, prop).instant);
  if (startProp !== undefined)
    component.start = timed(singleTime(startProp, context), startProp);
  if (endProp !== undefined)
    component.end = timed(singleTime(endProp, context), endProp);
  else if (durationProp !== undefined) {
    const length = durationOf(durationProp, component.start, context);
    const at = { path: durationProp.path, line: durationProp.line, name: 'DURATION' };
    if (component.start.kind === 'utc')
      component.end = endAfter(component.start, length, at);
    else {
      // a zoned end that names its instant, or else that instant in UTC
      const end = zonedEnd(component.start, length, context, at);
      component.end = end.named ? end.value : valueAt('utc', end.instant);
    }
  }
  if (component.start !== undefined && component.end !== undefined && instant(component.end, endProp ?? durationProp) <= instant(component.start, startProp))
    withhold('ICAL1018', 'the end of a VAVAILABILITY is after its start', endProp ?? durationProp);
  const priority = one(props, 'PRIORITY');
  if (priority !== undefined) {
    paramsOf(priority, ['INTEGER'], context);
    if (!/^\+?[0-9]$/.test(priority.value))
      withhold('ICAL1018', `PRIORITY is a whole number from 0 to 9, not '${priority.value}'`, priority);
    component.priority = Number(priority.value);
  }
  const busy = one(props, 'BUSYTYPE');
  if (busy !== undefined) {
    paramsOf(busy, ['TEXT'], context);
    const value = textOf(busy).toUpperCase();
    if (value !== 'BUSY-UNAVAILABLE') {
      withhold('ICAL1025', `BUSYTYPE:${value} marks the time outside its AVAILABLE components ${value.toLowerCase()}, and an availability layer `
        + 'marks it busy-unavailable', busy);
    }
    component.busyType = 'busy-unavailable';
  }
  Object.assign(component, eventText(props, context));
  /** @type {Map<string, Master>} */
  const masters = new Map();
  /** @type {Map<string, Override[]>} */
  const overrides = new Map();
  for (const child of node.children.filter((other) => other.name === 'AVAILABLE')) {
    const read = readEvent(child, context, true);
    if (read.type === 'override') {
      timed(read.override.span.start, child);
      overrides.set(read.override.uid, [...(overrides.get(read.override.uid) ?? []), read.override]);
    }
    else if (read.type === 'master') {
      if (masters.has(read.master.uid))
        withhold('ICAL1021', `a second AVAILABLE with the UID '${read.master.uid}'`, child);
      timed(read.master.span.start, child);
      masters.set(read.master.uid, read.master);
    }
  }
  for (const [uid, list] of overrides) {
    if (!masters.has(uid))
      withhold('ICAL1021', `the AVAILABLE override of ${slotId(list[0].recurrenceId)} names the UID '${uid}', and no AVAILABLE has it`, list[0].node);
  }
  component.available = [...masters.values()].map((master) => {
    const { type: _type, ...available } = seriesOf(master, overrides.get(master.uid) ?? [], context);
    return available;
  });
  const kinds = new Set([...masters.values()].map((master) => master.span.start.kind));
  if (kinds.size > 1)
    withhold('ICAL1025', 'its AVAILABLE components are both UTC and zoned, and one availability layer holds series of one kind', node);
  return component;
}

/** What a scheduling message reads of its component (RFC 5546 §3). */
const MESSAGE_PROPERTIES = Object.freeze(['UID', 'DTSTAMP', 'SEQUENCE', 'RECURRENCE-ID', 'ORGANIZER', 'ATTENDEE', 'REQUEST-STATUS', 'STATUS']);
/** What a VFREEBUSY message reads besides: the span a free/busy request asks about, or a reply answers for. */
const FREEBUSY_MESSAGE_PROPERTIES = Object.freeze([...MESSAGE_PROPERTIES, 'DTSTART', 'DTEND']);
/** The methods whose VEVENTs (and VTODOs and VJOURNALs) are calendar data, read into the model as without a method. */
const DATA_METHODS = Object.freeze(['publish', 'request']);
/** The methods whose VFREEBUSYs are free/busy data. */
const FREEBUSY_DATA_METHODS = Object.freeze(['publish', 'reply']);

/** The parameters of an ORGANIZER or ATTENDEE a message reads. */
const PERSON_PARAMETERS = Object.freeze(['CN', 'PARTSTAT', 'ROLE', 'CUTYPE', 'RSVP', 'DELEGATED-TO', 'DELEGATED-FROM', 'SENT-BY']);

/**
 * A calendar user of an ORGANIZER or ATTENDEE: its address (the
 * cal-address as written) and the parameters scheduling reads; any other
 * parameter is reported where the message is all the read takes of its
 * component (a PUBLISH or REQUEST event reports the whole line, left out
 * of the event).
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {ReadContext} context
 * @param {boolean} alone
 * @returns {Record<string, any>}
 */
function personOf(prop, context, alone) {
  for (const param of alone ? prop.params.filter((other) => !PERSON_PARAMETERS.includes(other.name)) : []) {
    context.report.add('ICAL1012', `${prop.name};${param.name}`, `${prop.path};${param.name}`, prop.line,
      `the parameter ${param.name} of ${prop.name} is outside what a message reads; ${prop.name} is read without it`);
  }
  /** @type {Record<string, any>} */
  const person = { address: prop.value };
  const param = (/** @type {string} */ name) => prop.params.find((entry) => entry.name === name)?.values;
  const name = param('CN')?.[0];
  if (name !== undefined)
    person.name = name;
  for (const [key, member] of [['PARTSTAT', 'partstat'], ['ROLE', 'role'], ['CUTYPE', 'cutype']]) {
    const value = param(key)?.[0];
    if (value !== undefined)
      person[member] = value.toLowerCase();
  }
  const rsvp = param('RSVP')?.[0]?.toUpperCase();
  if (rsvp === 'TRUE' || rsvp === 'FALSE')
    person.rsvp = rsvp === 'TRUE';
  for (const [key, member] of [['DELEGATED-TO', 'delegatedTo'], ['DELEGATED-FROM', 'delegatedFrom'], ['SENT-BY', 'sentBy']]) {
    const values = param(key);
    if (values !== undefined)
      person[member] = key === 'SENT-BY' ? values[0] : [...values];
  }
  return person;
}

/**
 * The scheduling message of one component of a calendar with a METHOD:
 * its UID, DTSTAMP, SEQUENCE and RECURRENCE-ID, its organizer and
 * attendees (each attendee's PARTSTAT is a REPLY's answer), its
 * REQUEST-STATUS, and the method's own data - a CANCEL's cancellation, in
 * the series model's terms, and the event an ADD adds or a COUNTER
 * suggests. Under a method whose components are not calendar data, the
 * rest of the component is reported, as outside the subset.
 * @param {import('./ical-machine.js').IcalNode} node
 * @param {string} method
 * @param {ReadContext} context
 * @param {boolean} alone - the message is all the read takes of the component
 * @returns {Record<string, any>}
 */
function messageOf(node, method, context, alone) {
  /** @type {Record<string, any>} */
  const message = { component: /** @type {any} */ (ITIP_KINDS)[node.name] };
  const props = (/** @type {string} */ name) => node.props.filter((prop) => prop.name === name);
  // an ADD's or COUNTER's VEVENT is also read as the event it adds or suggests, which reports what that leaves out
  const evented = (method === 'add' || method === 'counter') && node.name === 'VEVENT';
  if (alone && !evented) {
    for (const prop of node.props.filter((other) => !(node.name === 'VFREEBUSY' ? FREEBUSY_MESSAGE_PROPERTIES : MESSAGE_PROPERTIES).includes(other.name)))
      context.report.add('ICAL1011', prop.name, prop.path, prop.line, `${prop.name} in a METHOD:${method.toUpperCase()} ${node.name} is outside what its message reads; it is left out`);
    for (const child of node.children)
      context.report.add('ICAL1013', child.name, child.path, child.line, `${child.name} inside a METHOD:${method.toUpperCase()} ${node.name} is left out with everything inside it`);
  }
  const [uid] = props('UID');
  if (uid !== undefined)
    message.uid = textOf(uid);
  const [stamp] = props('DTSTAMP');
  if (stamp !== undefined)
    message.dtstamp = instantText(stamp.value, stamp, context);
  const [sequence] = props('SEQUENCE');
  if (sequence !== undefined) {
    if (!/^\+?\d{1,15}$/.test(sequence.value))
      withhold('ICAL1018', `SEQUENCE is a whole number from 0, not '${sequence.value}'`, sequence);
    message.sequence = Number(sequence.value);
  }
  const [id] = props('RECURRENCE-ID');
  if (id !== undefined) {
    const { type, tzid } = timeParams(id, context);
    message.recurrenceId = timeOf(id.value, type, tzid, id, context);
    const range = id.params.find((param) => param.name === 'RANGE')?.values[0].toUpperCase();
    if (range === 'THISANDFUTURE')
      message.range = range;
  }
  if (node.name === 'VFREEBUSY') {
    for (const [name, member] of [['DTSTART', 'start'], ['DTEND', 'end']]) {
      const [prop] = props(name);
      if (prop !== undefined)
        message[member] = instantOf(prop, context);
    }
  }
  const [organizer] = props('ORGANIZER');
  if (organizer !== undefined)
    message.organizer = personOf(organizer, context, alone);
  message.attendees = props('ATTENDEE').map((prop) => personOf(prop, context, alone));
  const statuses = props('REQUEST-STATUS').map((prop) => {
    const [code, description, ...data] = prop.value.split(/(?<!\\);/).map((part) => textOf({ ...prop, value: part }));
    return { code, description: description ?? '', ...(data.length !== 0 ? { data: data.join(';') } : {}) };
  });
  if (statuses.length !== 0)
    message.requestStatus = statuses;
  const [status] = props('STATUS');
  if (status !== undefined)
    message.status = status.value.toLowerCase();
  if (method === 'cancel')
    message.cancellation = message.recurrenceId === undefined ? { status: 'cancelled' }
      : { recurrenceId: slotId(message.recurrenceId), status: 'cancelled', ...(message.range !== undefined ? { range: message.range } : {}) };
  if (evented) {
    // the message's own people and status lines are read above, not left out of the event
    const read = readEvent({ ...node, props: node.props.filter((prop) => !['ORGANIZER', 'ATTENDEE', 'REQUEST-STATUS'].includes(prop.name)) }, context);
    /** @type {Record<string, any>} */
    let event;
    if (read.type === 'single')
      event = read.component;
    else if (read.type === 'master')
      event = seriesOf(read.master, [], context);
    else {
      const { span, text } = read.override;
      event = { type: 'event', uid: read.override.uid, ...(read.override.dtstamp !== undefined ? { dtstamp: read.override.dtstamp } : {}),
        start: span.start, ...(span.end !== undefined ? { end: span.end } : {}),
        ...(span.duration !== undefined ? { duration: span.duration } : {}), ...(span.start.kind === 'zoned' ? { policy: 'rfc5545' } : {}), ...text };
    }
    message[method === 'add' ? 'event' : 'suggested'] = event;
  }
  return message;
}

//#endregion

//#region engine

/**
 * The calendar component of a reader's input, once read; set by the
 * reader class, for `parseIcal`'s lossless tree.
 * @type {(reader: IcalReader) => import('./ical-machine.js').IcalNode | null}
 */
let rootOf;

/**
 * The incremental iCalendar reader: chunks in, components out. One
 * engine serves `parseIcal`, `createIcalReader` and `iterateIcal`.
 */
export class IcalReader {
  static {
    rootOf = (reader) => reader.#machine.calendar;
  }

  #machine;
  #report;
  /** @type {ReadContext} */
  #context;
  /** @type {Record<string, any>[]} */
  #ready = [];
  /** @type {Map<string, Master>} */
  #masters = new Map();
  /** @type {Map<string, Override[]>} */
  #overrides = new Map();
  /** @type {{ version: number, prodId: string | undefined, method: string | undefined, methods: number }} */
  #head = { version: 0, prodId: undefined, method: undefined, methods: 0 };
  /** @type {Record<string, any>[]} */
  #messages = [];
  /** @type {import('./ical-itip.js').SchedulingEntry[]} */
  #scheduling = [];
  /** @type {Map<string, number>} */
  #kinds = new Map();
  #strictScheduling = false;

  /**
   * @param {IcalReaderOptions} [options]
   * @param {string} [owner] - the entry that takes the options, for their refusals
   * @param {any} [table] - the options table
   */
  constructor(options = undefined, owner = 'createIcalReader', table = ICAL_READ) {
    const admitted = admitOptions(options, table, owner);
    this.#report = new Report(admitted.strict === true, limitOption(admitted, 'maxReported'));
    this.#strictScheduling = admitted.strictScheduling === true;
    const provider = admitted.provider ?? null;
    const zoneTable = new ZoneTable(admitted.vtimezone ?? 'embedded', admitted.zoneHorizon ?? ZONE_HORIZON, admitted.zoneLimits ?? undefined, provider);
    this.#context = { provider, report: this.#report, zones: new Map(), zoneTable };
    const limits = {
      maxOctets: limitOption(admitted, 'maxOctets'),
      maxComponents: limitOption(admitted, 'maxComponents'),
      maxLineOctets: limitOption(admitted, 'maxLineOctets'),
      maxParameters: limitOption(admitted, 'maxParameters'),
      maxDepth: limitOption(admitted, 'maxDepth'),
      maxProperties: limitOption(admitted, 'maxProperties'),
    };
    this.#machine = new IcalMachine(limits, {
      property: (prop) => this.#calendarProperty(prop),
      component: (node) => this.#component(node),
      lineFeed: (line) => this.#report.add('ICAL1010', 'LF', this.#machine.calendar === null ? '' : '/VCALENDAR', line,
        'the line ends in a bare line feed; it is read as CRLF'),
    }, admitted.mode === 'lossless');
  }

  /**
   * The zone provider the read's zoned values resolve through, live
   * while the input is fed: the file's compiled VTIMEZONEs for the
   * TZIDs they define (under `vtimezone: 'embedded'`), the caller's
   * provider for every other name.
   * @returns {Required<import('@jarenjs/core/series').ZoneProvider>}
   */
  get provider() {
    return /** @type {any} */ (this.#context.zoneTable.provider);
  }

  /**
   * Feed a chunk: octets or text, ending anywhere.
   * @param {string | Uint8Array} chunk
   * @returns {Record<string, any>[]} the components it completed, in order
   * @throws {IcalError} for text the reader cannot follow, and under `strict` for any report entry
   * @throws {import('./limits.js').JoslLimitError} for a limit the input crosses
   */
  feed(chunk) {
    this.#machine.feed(chunk);
    return this.#ready.splice(0, this.#ready.length);
  }

  /**
   * End the input.
   * @returns {{ calendar: { prodId: string, method?: IcalMethod, components: Record<string, any>[] }, report: IcalReport,
   *   zones: IcalZones, scheduling?: IcalScheduling }} the calendar's head and the components still held (every
   *   series), the report of the whole read, its zones, and with a METHOD its scheduling messages and report
   * @throws {IcalError} for an unclosed component, a calendar that is not iCalendar 2.0, and under `strict` for any report entry
   */
  end() {
    this.#machine.end();
    const { version, prodId, method } = this.#head;
    if (version === 0 || prodId === undefined) {
      const calendar = /** @type {import('./ical-machine.js').IcalNode} */ (this.#machine.calendar);
      throw new IcalError('ICAL1008', `the calendar has no ${version === 0 ? 'VERSION' : 'PRODID'}`, calendar.path, undefined, calendar.line);
    }
    for (const [uid, master] of this.#masters) {
      try {
        this.#ready.push(seriesOf(master, this.#overrides.get(uid) ?? [], this.#context));
      }
      catch (error) {
        this.#withheld(error);
      }
      this.#overrides.delete(uid);
    }
    for (const list of this.#overrides.values()) {
      for (const override of list) {
        this.#report.add('ICAL1021', 'VEVENT', override.node.path, override.node.line,
          `the override of ${slotId(override.recurrenceId)} names the UID '${override.uid}', and no series has it`);
      }
    }
    this.#masters.clear();
    this.#overrides.clear();
    this.#context.zoneTable.compare(this.#report);
    if (method !== undefined) {
      const calendar = /** @type {import('./ical-machine.js').IcalNode} */ (this.#machine.calendar);
      this.#schedule(calendarEntries(this.#kinds, method.toUpperCase(), calendar));
    }
    return {
      calendar: { prodId, ...(method !== undefined ? { method: /** @type {IcalMethod} */ (method) } : {}), components: this.#ready.splice(0, this.#ready.length) },
      report: this.#report.json(),
      zones: this.#context.zoneTable.summary(),
      ...(method !== undefined ? { scheduling: { method: /** @type {IcalMethod} */ (method), messages: this.#messages.splice(0), report: [...this.#scheduling] } } : {}),
    };
  }

  /**
   * Add scheduling entries, or refuse at the first under `strictScheduling`.
   * @param {import('./ical-itip.js').SchedulingEntry[]} entries
   */
  #schedule(entries) {
    if (this.#strictScheduling && entries.length !== 0)
      throw new IcalError(entries[0].code, entries[0].reason, entries[0].path, undefined, entries[0].line);
    this.#scheduling.push(...entries);
  }

  /**
   * Report a withheld component, or pass on what is no report entry.
   * @param {unknown} error
   */
  #withheld(error) {
    if (!(error instanceof IcalError) || !WITHHOLDING.includes(error.code))
      throw error;
    const line = /** @type {any} */ (error).line;
    this.#report.add(error.code, /** @type {string} */ (error.docPath).split('/').pop()?.replace(/\[\d+\]$/, '') ?? '', /** @type {string} */ (error.docPath),
      line, error.reason, error.cause);
  }

  /**
   * A property of the calendar itself.
   * @param {import('./ical-machine.js').IcalProperty} prop
   */
  #calendarProperty(prop) {
    const head = this.#head;
    const fail = (/** @type {string} */ reason) => {
      throw new IcalError('ICAL1008', reason, prop.path, undefined, prop.line);
    };
    if (prop.name === 'VERSION' || prop.name === 'PRODID' || prop.name === 'CALSCALE' || prop.name === 'METHOD') {
      for (const param of prop.params) {
        this.#report.add('ICAL1012', `${prop.name};${param.name}`, `${prop.path};${param.name}`, prop.line,
          `the parameter ${param.name} of ${prop.name} is outside the subset; ${prop.name} is read without it`);
      }
    }
    if (prop.name === 'VERSION') {
      if (head.version !== 0)
        fail('the calendar holds VERSION once');
      if (prop.value !== '2.0')
        fail(`the calendar is iCalendar VERSION 2.0, not ${prop.value}`);
      head.version = 2;
    }
    else if (prop.name === 'PRODID') {
      if (head.prodId !== undefined)
        fail('the calendar holds PRODID once');
      try {
        head.prodId = textOf(prop);
      }
      catch (error) {
        fail(/** @type {any} */ (error).reason);
      }
    }
    else if (prop.name === 'CALSCALE') {
      if (prop.value.toUpperCase() !== 'GREGORIAN')
        fail(`the calendar's scale is GREGORIAN, not ${prop.value}`);
    }
    else if (prop.name === 'METHOD' && ITIP_METHODS.includes(prop.value.toLowerCase()) && head.methods++ === 0)
      head.method = prop.value.toLowerCase();
    else {
      this.#report.add('ICAL1011', prop.name, prop.path, prop.line, prop.name === 'METHOD'
        ? `METHOD ${prop.value} is outside the subset (one of RFC 5546's eight methods, once); it is left out`
        : `${prop.name} in VCALENDAR is outside the subset; it is left out`);
    }
  }

  /**
   * A whole component directly inside the calendar.
   * @param {import('./ical-machine.js').IcalNode} node
   */
  #component(node) {
    const { method } = this.#head;
    const kind = Object.hasOwn(ITIP_KINDS, node.name);
    if (method !== undefined && (kind || node.name === 'VTIMEZONE')) {
      this.#kinds.set(node.name, (this.#kinds.get(node.name) ?? 0) + 1);
      if (kind)
        this.#schedule(componentEntries(node, method.toUpperCase()));
    }
    // under a method whose components are messages, not calendar data, the message is all that is read
    const data = method === undefined || (node.name === 'VFREEBUSY' ? FREEBUSY_DATA_METHODS : DATA_METHODS).includes(method);
    if (method !== undefined && kind) {
      try {
        this.#messages.push(messageOf(node, method, this.#context, !data));
      }
      catch (error) {
        this.#withheld(error);
      }
      if (!data)
        return;
    }
    try {
      if (node.name === 'VEVENT') {
        const read = readEvent(node, this.#context);
        if (read.type === 'single')
          this.#ready.push(read.component);
        else if (read.type === 'override') {
          const list = this.#overrides.get(read.override.uid);
          if (list === undefined)
            this.#overrides.set(read.override.uid, [read.override]);
          else
            list.push(read.override);
        }
        else if (this.#masters.has(read.master.uid))
          withhold('ICAL1021', `a second series with the UID '${read.master.uid}'`, node);
        else
          this.#masters.set(read.master.uid, read.master);
      }
      else if (node.name === 'VFREEBUSY')
        this.#ready.push(readFreebusy(node, this.#context));
      else if (node.name === 'VAVAILABILITY')
        this.#ready.push(readAvailability(node, this.#context));
      else if (node.name === 'VTIMEZONE')
        this.#context.zoneTable.define(node, this.#report);
      else {
        this.#report.add('ICAL1013', node.name, node.path, node.line,
          `${node.name} is outside the subset; it is left out with everything inside it`);
      }
    }
    catch (error) {
      this.#withheld(error);
    }
  }
}

//#endregion

//#region entries


/**
 * Read a whole iCalendar text (RFC 5545) into the model `stringifyIcal`
 * writes, canonical mode: what is outside the supported subset is
 * listed in `report.unsupported`, never silently interpreted. Under
 * `mode: 'lossless'` the answer also holds `tree`, the syntax tree over
 * the input's octets that `patchIcal` edits; the model and report are
 * the same in both modes.
 * @param {string | Uint8Array} text - the calendar, as text or UTF-8 octets
 * @param {IcalReaderOptions} [options]
 * @returns {{ calendar: { prodId: string, method?: IcalMethod, components: Record<string, any>[] }, report: IcalReport,
 *   zones: IcalZones, scheduling?: IcalScheduling, tree?: IcalTree }} single events and free/busy components in
 *   the order read, then every series in the order it began; `zones.provider` is what their zoned values
 *   resolve through; `scheduling` with a METHOD only; `tree` under `mode: 'lossless'` only
 * @throws {IcalError} for text the reader cannot follow (`ICAL1001`-`ICAL1009`), and under `strict` for any report entry
 * @throws {import('./limits.js').JoslLimitError} for a limit the input crosses
 * @throws {TypeError} for an unknown or mistyped option
 * @example
 * const { calendar, report } = parseIcal('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//EN\r\n'
 *   + 'BEGIN:VEVENT\r\nUID:sale\r\nDTSTART;VALUE=DATE:20261224\r\nX-COLOR:red\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
 * calendar.components[0]; // { type: 'event', uid: 'sale', start: { kind: 'date', date: '2026-12-24' } }
 * report.unsupported[0].path; // '/VCALENDAR/VEVENT[0]/X-COLOR'
 */
export function parseIcal(text, options = undefined) {
  const reader = new IcalReader(options, 'parseIcal', ICAL_PARSE);
  const first = reader.feed(text);
  const { calendar, report, zones, scheduling } = reader.end();
  calendar.components = [...first, ...calendar.components];
  const root = rootOf(reader);
  if (/** @type {any} */ (options)?.mode !== 'lossless' || root === null)
    return { calendar, report, zones, ...(scheduling !== undefined ? { scheduling } : {}) };
  // the octets the machine read: a string has no lone surrogate here, so its UTF-8 is exact
  const source = typeof text === 'string' ? new TextEncoder().encode(text) : text.slice();
  /** @type {IcalTree} */
  const tree = Object.freeze({ form: typeof text === 'string' ? 'text' : 'octets', source, root, calendar, zones });
  const { mode: _mode, ...read } = /** @type {IcalReaderOptions} */ (options);
  TREES.set(tree, read);
  return { calendar, report, zones, ...(scheduling !== undefined ? { scheduling } : {}), tree };
}

/**
 * Create an incremental iCalendar reader: `feed(chunk)` returns the
 * components the chunk completed, `end()` the calendar's head, the
 * series held until the end, and the report.
 * @param {IcalReaderOptions} [options]
 * @returns {IcalReader}
 * @throws {TypeError} for an unknown or mistyped option
 * @example
 * const reader = createIcalReader();
 * reader.feed('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260302T0800');
 * // a line is whole once the octet after its line break is read
 * reader.feed('00Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n').length; // 1
 * reader.end().calendar.prodId; // 'p'
 */
export function createIcalReader(options = undefined) {
  return new IcalReader(options);
}

/**
 * Read an async iterable of chunks (a fetch body, a file stream) into
 * components, as they complete. Yields `{ type: 'component', component }`
 * per component and, last, `{ type: 'end', calendar: { prodId, method? },
 * report, zones }`; `reader.provider` is not reachable here, so a consumer
 * that resolves as it goes reads `zones.provider` at the end. `options.signal` aborts between chunks; an abort, a consumer
 * that stops early or a throw closes the source exactly once.
 * @param {AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>} chunks
 * @param {IcalReaderOptions & { signal?: AbortSignal | null }} [options]
 * @returns {AsyncGenerator<{ type: 'component', component: Record<string, any> }
 *   | { type: 'end', calendar: { prodId: string, method?: IcalMethod }, report: IcalReport, zones: IcalZones, scheduling?: IcalScheduling }>}
 * @example
 * for await (const item of iterateIcal(response.body))
 *   if (item.type === 'component') await save(item.component);
 */
export async function* iterateIcal(chunks, options = undefined) {
  const signal = /** @type {any} */ (options)?.signal ?? null;
  const reader = new IcalReader(options, 'iterateIcal', ICAL_ITERATE);
  const iterator = /** @type {any} */ (chunks)[Symbol.asyncIterator]?.() ?? /** @type {any} */ (chunks)[Symbol.iterator]();
  let finished = false;
  try {
    for (;;) {
      if (signal !== null && signal.aborted)
        throw abortedError(signal);
      const step = await iterator.next();
      if (step.done) {
        finished = true;
        break;
      }
      for (const component of reader.feed(step.value))
        yield { type: /** @type {const} */ ('component'), component };
    }
  }
  finally {
    if (!finished)
      await closeIterator(iterator);
  }
  const { calendar: { components, ...head }, report, zones, scheduling } = reader.end();
  for (const component of components)
    yield { type: /** @type {const} */ ('component'), component };
  yield { type: /** @type {const} */ ('end'), calendar: head, report, zones, ...(scheduling !== undefined ? { scheduling } : {}) };
}

//#endregion

//#endregion
