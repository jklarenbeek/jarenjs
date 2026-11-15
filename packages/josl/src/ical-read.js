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
//   CalendarError the cause; a sub-daily rule is its `JY0020`), EXRULE.
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

import { CalendarError, compileRecurrence, dateValue, defineSeries, floatingValue, isZone, parseTemporal, utcValue, zonedValue }
  from '@jarenjs/core/calendar';
import { IcalMachine } from './ical-machine.js';
import { IANA_FORM, ZONE_HORIZON, ZoneTable } from './ical-vtimezone.js';
import { IcalError, daysOf, readDuration, wallOf } from './ical-wire.js';
import { limitOption } from './limits.js';
import { ICAL_ITERATE, ICAL_READ, admitOptions } from './options.js';
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
const TIME_PARAMETERS = Object.freeze(['VALUE', 'TZID']);
const PARAMETERS = Object.freeze({
  DTSTART: TIME_PARAMETERS, DTEND: TIME_PARAMETERS, RDATE: TIME_PARAMETERS, EXDATE: TIME_PARAMETERS,
  'RECURRENCE-ID': Object.freeze([...TIME_PARAMETERS, 'RANGE']), FREEBUSY: Object.freeze(['VALUE', 'FBTYPE']),
});
/** Properties a component holds at most once. */
const ONCE = Object.freeze(['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'STATUS',
  'SEQUENCE', 'RRULE', 'RECURRENCE-ID']);
/** The report entries that withhold their component. */
const WITHHOLDING = Object.freeze(['ICAL1017', 'ICAL1018', 'ICAL1019', 'ICAL1020', 'ICAL1021', 'ICAL1022']);

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
 * @property {number} [maxOctets] - octets of input
 * @property {number} [maxComponents] - components, every BEGIN inside the calendar counted
 * @property {number} [maxLineOctets] - octets of one unfolded content line
 * @property {number} [maxParameters] - parameters of one content line
 * @property {number} [maxDepth] - nesting of components, the calendar counted as 1
 * @property {number} [maxProperties] - properties of one component
 * @property {number} [maxReported] - report entries listed; past it they are counted only
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
function textOf(prop) {
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
 * The end a length gives a start, where it is exact without a zone:
 * days for a date, wall or UTC time otherwise. A zoned start with a
 * length is not placed here.
 * @param {any} start
 * @param {{ days: number, ms: number }} length
 * @param {{ path: string, line: number, name: string }} at
 * @returns {any}
 */
function endAfter(start, length, at) {
  if (start.kind === 'zoned')
    withhold('ICAL1022', `${at.name} gives a zoned time a length that only the zone's offsets can place, which this release does not read`, at);
  return viaCalendar(() => valueAt(start.kind, placeOf(start) + length.days * DAY + length.ms), 'ICAL1018', at.name, at);
}

/**
 * The values of an RDATE or EXDATE: dates, date-times or periods.
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {ReadContext} context
 * @returns {any[]} values, and `{ start, end }` periods
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
    const end = /^[+]?P/.test(rest) ? endAfter(start, durationOf({ ...prop, value: rest, params: [] }, start, context), prop)
      : timeOf(rest, 'DATE-TIME', tzid, prop, context);
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
 * @returns {Map<string, import('./ical-machine.js').IcalProperty[]>}
 */
function propertiesOf(node, known, context) {
  for (const child of node.children) {
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
 * @returns {{ type: 'single', component: Record<string, any> } | { type: 'master', master: Master } | { type: 'override', override: Override }}
 */
function readEvent(node, context) {
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
    if (range !== undefined) {
      context.report.add('ICAL1015', 'RECURRENCE-ID;RANGE', `${idProp.path};RANGE`, idProp.line,
        'the override ranges over this and future occurrences; it is kept as data and its expansion is refused (JY0021)');
    }
    return { type: 'override', override: { uid, dtstamp, recurrenceId, range, span, text, node, idProp } };
  }
  if (rrule !== undefined) {
    paramsOf(rrule, ['RECUR'], context);
    if (span.start.kind === 'zoned')
      context.zoneTable.use(span.start.zone, wallOf(span.start.date, span.start.time, rrule.path), true);
    return { type: 'master', master: { uid, dtstamp, span, text, rrule: rrule.value, rdates, exdates, node } };
  }
  if (rdates.length !== 0)
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
function slotId(value) {
  if (value.kind === 'date')
    return value.date;
  if (value.kind === 'utc')
    return `${new Date(Date.parse(value.instant)).toISOString().slice(0, 19)}Z`;
  return `${value.date}T${value.time}`;
}

/**
 * A series' override, from its VEVENT.
 * @param {Override} override
 * @param {Master} master
 * @param {ReadContext} context
 * @returns {Record<string, any>}
 */
function overrideOf(override, master, context) {
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
  // override without one keeps its slot's length, so the end is spelled
  // out exactly where the two differ
  if (span.end !== undefined)
    out.end = span.end;
  else {
    const none = { days: start.kind === 'date' ? 1 : 0, ms: 0 };
    const own = span.length ?? none;
    // a series whose DTEND lies in another zone has no slot length here:
    // the calendar layer refuses its rule, and a series of extra dates is withheld
    const slot = master.span.length ?? none;
    if (own.days !== slot.days || own.ms !== slot.ms) {
      out.end = own.days === 0 && own.ms === 0 ? span.start
        : endAfter(span.start, own, { path: node.path, line: node.line, name: 'the override\'s length' });
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
      return { start: value, end: endAfter(value, length, { path: at.path, line: at.line, name: 'the length of an RDATE' }) };
    };
    if (end !== undefined && length === undefined)
      withhold('ICAL1022', 'a series of extra dates whose DTEND lies in another zone than DTSTART', at);
    rdates = [start, ...rdates.filter((entry) => entry.kind === undefined || !sameValue(entry, start))].map(slot);
  }
  const definition = { uid: master.uid, ...(master.text.sequence !== undefined ? { sequence: master.text.sequence } : {}), base,
    rdates, exdates: master.exdates, overrides: overrides.map((override) => overrideOf(override, master, context)) };
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

//#endregion

//#region engine

/**
 * The incremental iCalendar reader: chunks in, components out. One
 * engine serves `parseIcal`, `createIcalReader` and `iterateIcal`.
 */
export class IcalReader {
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

  /**
   * @param {IcalReaderOptions} [options]
   * @param {string} [owner] - the entry that takes the options, for their refusals
   * @param {any} [table] - the options table
   */
  constructor(options = undefined, owner = 'createIcalReader', table = ICAL_READ) {
    const admitted = admitOptions(options, table, owner);
    this.#report = new Report(admitted.strict === true, limitOption(admitted, 'maxReported'));
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
    });
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
   * @returns {{ calendar: { prodId: string, method?: 'publish', components: Record<string, any>[] }, report: IcalReport,
   *   zones: IcalZones }} the calendar's head and the components still held (every series), the report of the
   *   whole read, and its zones
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
    return {
      calendar: { prodId, ...(method !== undefined ? { method: /** @type {'publish'} */ (method) } : {}), components: this.#ready.splice(0, this.#ready.length) },
      report: this.#report.json(),
      zones: this.#context.zoneTable.summary(),
    };
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
    else if (prop.name === 'METHOD' && prop.value.toUpperCase() === 'PUBLISH' && head.methods++ === 0)
      head.method = 'publish';
    else {
      this.#report.add('ICAL1011', prop.name, prop.path, prop.line, prop.name === 'METHOD'
        ? `METHOD ${prop.value} is outside the subset (PUBLISH, once); it is left out` : `${prop.name} in VCALENDAR is outside the subset; it is left out`);
    }
  }

  /**
   * A whole component directly inside the calendar.
   * @param {import('./ical-machine.js').IcalNode} node
   */
  #component(node) {
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
 * listed in `report.unsupported`, never silently interpreted.
 * @param {string | Uint8Array} text - the calendar, as text or UTF-8 octets
 * @param {IcalReaderOptions} [options]
 * @returns {{ calendar: { prodId: string, method?: 'publish', components: Record<string, any>[] }, report: IcalReport,
 *   zones: IcalZones }} single events and free/busy components in the order read, then every
 *   series in the order it began; `zones.provider` is what their zoned values resolve through
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
  const reader = new IcalReader(options, 'parseIcal');
  const first = reader.feed(text);
  const { calendar, report, zones } = reader.end();
  calendar.components = [...first, ...calendar.components];
  return { calendar, report, zones };
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
 *   | { type: 'end', calendar: { prodId: string, method?: 'publish' }, report: IcalReport, zones: IcalZones }>}
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
  const { calendar: { components, ...head }, report, zones } = reader.end();
  for (const component of components)
    yield { type: /** @type {const} */ ('component'), component };
  yield { type: /** @type {const} */ ('end'), calendar: head, report, zones };
}

//#endregion

//#endregion
