//@ts-check

//#region iTIP (RFC 5546)
// The scheduling methods of RFC 5546 as data: the METHOD a calendar
// names, each component checked against §3's restriction table for that
// method and component (which properties and subcomponents it requires,
// takes at most once, or excludes, and what its comments ask of their
// values), the calendar's components against the tables' counts, and the
// people and status lines a message carries. The tables are reported, never enforced by dropping
// content; the organizer's and attendees' state machine and the
// transport (iMIP, CalDAV scheduling) are the host's.

/** The eight methods, as the model spells them. */
export const ITIP_METHODS = /* @__PURE__ */ Object.freeze(['publish', 'request', 'reply', 'add', 'cancel', 'refresh', 'counter', 'declinecounter']);
/** The model's name of each component a method's table covers. */
export const ITIP_KINDS = /* @__PURE__ */ Object.freeze({ VEVENT: 'event', VTODO: 'todo', VJOURNAL: 'journal', VFREEBUSY: 'freebusy' });

/**
 * RFC 5546 §3.2-3.5, one entry per method and component it takes:
 * `count|properties|subcomponents|calendar components`, each constraint
 * a name and its presence - `1` exactly one, `+` one or more, `0` none,
 * `?` at most one (a name the table gives as 0+ is left out). Copied from
 * the RFC's tables (https://www.rfc-editor.org/rfc/rfc5546.txt).
 */
const TABLES = /* @__PURE__ */ Object.freeze({
  'PUBLISH VEVENT': '+|DTSTAMP1 DTSTART1 ORGANIZER1 SUMMARY1 UID1 RECURRENCE-ID? SEQUENCE? CLASS? CONTACT? CREATED? DESCRIPTION? DTEND? DURATION? GEO? LAST-MODIFIED? LOCATION? PRIORITY? RRULE? STATUS? TRANSP? URL? ATTENDEE0 REQUEST-STATUS0||VFREEBUSY0 VJOURNAL0 VTODO0',
  'REQUEST VEVENT': '+|ATTENDEE+ DTSTAMP1 DTSTART1 ORGANIZER1 SEQUENCE? SUMMARY1 UID1 CLASS? CREATED? DESCRIPTION? DTEND? DURATION? GEO? LAST-MODIFIED? LOCATION? PRIORITY? RECURRENCE-ID? REQUEST-STATUS0 RRULE? STATUS? TRANSP? URL?||VFREEBUSY0 VJOURNAL0 VTODO0',
  'REPLY VEVENT': '+|ATTENDEE1 DTSTAMP1 ORGANIZER1 RECURRENCE-ID? UID1 SEQUENCE? CLASS? CREATED? DESCRIPTION? DTEND? DTSTART? DURATION? GEO? LAST-MODIFIED? LOCATION? PRIORITY? RRULE? STATUS? SUMMARY? TRANSP? URL?|VALARM0|VTIMEZONE? VFREEBUSY0 VJOURNAL0 VTODO0',
  'ADD VEVENT': '1|DTSTAMP1 DTSTART1 ORGANIZER1 SEQUENCE1 SUMMARY1 UID1 CLASS? CREATED? DESCRIPTION? DTEND? DURATION? GEO? LAST-MODIFIED? LOCATION? PRIORITY? STATUS? TRANSP? URL? EXDATE0 RECURRENCE-ID0 REQUEST-STATUS0 RDATE0 RRULE0||VFREEBUSY0 VTODO0 VJOURNAL0',
  'CANCEL VEVENT': '+|DTSTAMP1 ORGANIZER1 SEQUENCE1 UID1 CLASS? CREATED? DESCRIPTION? DTEND? DTSTART? DURATION? GEO? LAST-MODIFIED? LOCATION? PRIORITY? RECURRENCE-ID? RRULE? STATUS? SUMMARY? TRANSP? URL? REQUEST-STATUS0|VALARM0|VTODO0 VJOURNAL0 VFREEBUSY0',
  'REFRESH VEVENT': '1|ATTENDEE1 DTSTAMP1 ORGANIZER1 UID1 RECURRENCE-ID? ATTACH0 CATEGORIES0 CLASS0 CONTACT0 CREATED0 DESCRIPTION0 DTEND0 DTSTART0 DURATION0 EXDATE0 GEO0 LAST-MODIFIED0 LOCATION0 PRIORITY0 RDATE0 RELATED-TO0 REQUEST-STATUS0 RESOURCES0 RRULE0 SEQUENCE0 STATUS0 SUMMARY0 TRANSP0 URL0|VALARM0|VTODO0 VJOURNAL0 VFREEBUSY0',
  'COUNTER VEVENT': '1|DTSTAMP1 DTSTART1 ORGANIZER1 SEQUENCE1 SUMMARY1 UID1 CLASS? CREATED? DESCRIPTION? DTEND? DURATION? GEO? LAST-MODIFIED? LOCATION? PRIORITY? RECURRENCE-ID? RRULE? STATUS? TRANSP? URL?||VTODO0 VJOURNAL0 VFREEBUSY0',
  'DECLINECOUNTER VEVENT': '+|ATTENDEE+ DTSTAMP1 ORGANIZER1 SEQUENCE1 UID1 CLASS? CREATED? DESCRIPTION? DTSTART? DTEND? DURATION? GEO? LAST-MODIFIED? LOCATION? PRIORITY? RECURRENCE-ID? RRULE? STATUS? SUMMARY? TRANSP? URL?|VALARM0|VFREEBUSY0 VJOURNAL0 VTODO0',
  'PUBLISH VFREEBUSY': '+|DTSTAMP1 DTSTART1 DTEND1 ORGANIZER1 UID1 CONTACT? URL? ATTENDEE0 DURATION0 REQUEST-STATUS0|VALARM0|VEVENT0 VTODO0 VJOURNAL0 VTIMEZONE0',
  'REQUEST VFREEBUSY': '1|ATTENDEE+ DTEND1 DTSTAMP1 DTSTART1 ORGANIZER1 UID1 CONTACT? FREEBUSY0 DURATION0 REQUEST-STATUS0 URL0|VALARM0|VEVENT0 VTODO0 VJOURNAL0 VTIMEZONE0',
  'REPLY VFREEBUSY': '1|ATTENDEE1 DTSTAMP1 DTEND1 DTSTART1 ORGANIZER1 UID1 CONTACT? URL? DURATION0 SEQUENCE0|VALARM0|VEVENT0 VTODO0 VJOURNAL0 VTIMEZONE0',
  'PUBLISH VTODO': '+|DTSTAMP1 DTSTART1 ORGANIZER1 PRIORITY1 SEQUENCE? SUMMARY1 UID1 CLASS? COMPLETED? CREATED? DESCRIPTION? DUE? DURATION? GEO? LAST-MODIFIED? LOCATION? PERCENT-COMPLETE? RECURRENCE-ID? RRULE? STATUS? URL? ATTENDEE0 REQUEST-STATUS0||VFREEBUSY0 VEVENT0 VJOURNAL0',
  'REQUEST VTODO': '+|ATTENDEE+ DTSTAMP1 DTSTART1 ORGANIZER1 PRIORITY1 SEQUENCE? SUMMARY1 UID1 CLASS? COMPLETED? CREATED? DESCRIPTION? DUE? DURATION? GEO? LAST-MODIFIED? LOCATION? PERCENT-COMPLETE? RECURRENCE-ID? RRULE? STATUS? URL? REQUEST-STATUS0||VEVENT0 VFREEBUSY0 VJOURNAL0',
  'REPLY VTODO': '+|ATTENDEE1 DTSTAMP1 ORGANIZER1 UID1 CLASS? COMPLETED? CREATED? DESCRIPTION? DTSTART? DUE? DURATION? GEO? LAST-MODIFIED? LOCATION? PERCENT-COMPLETE? PRIORITY? RRULE? RECURRENCE-ID? SEQUENCE? STATUS? SUMMARY? URL?|VALARM0|VTIMEZONE? VEVENT0 VFREEBUSY0',
  'ADD VTODO': '1|DTSTAMP1 ORGANIZER1 PRIORITY1 SEQUENCE1 SUMMARY1 UID1 CLASS? COMPLETED? CREATED? DESCRIPTION? DTSTART? DUE? DURATION? GEO? LAST-MODIFIED? LOCATION? PERCENT-COMPLETE? STATUS? URL? EXDATE0 RECURRENCE-ID0 REQUEST-STATUS0 RDATE0 RRULE0||VEVENT0 VJOURNAL0 VFREEBUSY0',
  'CANCEL VTODO': '+|UID1 DTSTAMP1 ORGANIZER1 SEQUENCE1 CLASS? COMPLETED? CREATED? DESCRIPTION? DTSTART? DUE? DURATION? GEO? LAST-MODIFIED? LOCATION? PERCENT-COMPLETE? RECURRENCE-ID? RRULE? PRIORITY? STATUS? URL? REQUEST-STATUS0|VALARM0|VTIMEZONE? VEVENT0 VFREEBUSY0',
  'REFRESH VTODO': '1|ATTENDEE1 DTSTAMP1 UID1 RECURRENCE-ID? ATTACH0 CATEGORIES0 CLASS0 COMMENT0 COMPLETED0 CONTACT0 CREATED0 DESCRIPTION0 DTSTART0 DUE0 DURATION0 EXDATE0 GEO0 LAST-MODIFIED0 LOCATION0 ORGANIZER0 PERCENT-COMPLETE0 PRIORITY0 RDATE0 RELATED-TO0 REQUEST-STATUS0 RESOURCES0 RRULE0 SEQUENCE0 STATUS0 URL0|VALARM0|VEVENT0 VFREEBUSY0',
  'COUNTER VTODO': '1|ATTENDEE+ DTSTAMP1 ORGANIZER1 PRIORITY1 SUMMARY1 UID1 CLASS? COMPLETED? CREATED? DESCRIPTION? DTSTART? DUE? DURATION? GEO? LAST-MODIFIED? LOCATION? PERCENT-COMPLETE? RECURRENCE-ID? RRULE? SEQUENCE? STATUS? URL?||VTIMEZONE? VEVENT0 VFREEBUSY0',
  'DECLINECOUNTER VTODO': '1|ATTENDEE+ DTSTAMP1 ORGANIZER1 SEQUENCE1 UID1 CLASS? COMPLETED? CREATED? DESCRIPTION? DTSTART? DUE? DURATION? GEO? LAST-MODIFIED? LOCATION? PERCENT-COMPLETE? PRIORITY? RECURRENCE-ID? RRULE? STATUS? URL?|VALARM0|VEVENT0 VFREEBUSY0',
  'PUBLISH VJOURNAL': '+|DESCRIPTION1 DTSTAMP1 DTSTART1 ORGANIZER1 UID1 CLASS? CREATED? LAST-MODIFIED? RECURRENCE-ID? RRULE? SEQUENCE? STATUS? SUMMARY? URL? ATTENDEE0 REQUEST-STATUS0||VEVENT0 VFREEBUSY0 VTODO0',
  'ADD VJOURNAL': '1|DESCRIPTION1 DTSTAMP1 DTSTART1 ORGANIZER1 SEQUENCE1 UID1 CLASS? CREATED? LAST-MODIFIED? STATUS? SUMMARY? URL? ATTENDEE0 EXDATE0 RECURRENCE-ID0 REQUEST-STATUS0 RDATE0 RRULE0||VTIMEZONE? VEVENT0 VFREEBUSY0 VTODO0',
  'CANCEL VJOURNAL': '+|DTSTAMP1 ORGANIZER1 SEQUENCE1 UID1 ATTENDEE0 CLASS? CREATED? DESCRIPTION? DTSTART? LAST-MODIFIED? RECURRENCE-ID? RRULE? STATUS? SUMMARY? URL? REQUEST-STATUS0|VALARM0|VEVENT0 VFREEBUSY0 VTODO0',
});

/**
 * RFC 5546 §3's comments on values a message alone can be checked against,
 * by method and component (the others need the message they answer, the
 * host's): ADD's "SEQUENCE ... MUST be greater than 0" (§3.2.4, §3.4.4,
 * §3.5.2), CANCEL's STATUS "MUST be set to CANCELLED" when present (§3.2.5,
 * §3.4.5, §3.5.3), and COUNTER's VEVENT STATUS "must be one of
 * CONFIRMED/TENATIVE/CANCELLED" (§3.2.7, read as RFC 5545's TENTATIVE).
 * @type {Readonly<Record<string, readonly [string, string, readonly string[]?][]>>}
 */
const VALUES = /* @__PURE__ */ Object.freeze({
  'ADD VEVENT': [['SEQUENCE', 'positive']], 'ADD VTODO': [['SEQUENCE', 'positive']], 'ADD VJOURNAL': [['SEQUENCE', 'positive']],
  'CANCEL VEVENT': [['STATUS', 'one of', ['CANCELLED']]], 'CANCEL VTODO': [['STATUS', 'one of', ['CANCELLED']]],
  'CANCEL VJOURNAL': [['STATUS', 'one of', ['CANCELLED']]],
  'COUNTER VEVENT': [['STATUS', 'one of', ['CONFIRMED', 'TENTATIVE', 'CANCELLED']]],
});
/** The tables whose components "MUST have the same UID" (§3.2.2, §3.2.3, §3.2.5, §3.2.8, §3.4.2, §3.4.3, §3.5.3). */
const ONE_UID = /* @__PURE__ */ Object.freeze(['REQUEST VEVENT', 'REPLY VEVENT', 'CANCEL VEVENT', 'DECLINECOUNTER VEVENT', 'REQUEST VTODO',
  'REPLY VTODO', 'CANCEL VJOURNAL']);
/** The pairs every VEVENT and VTODO table's comments exclude together: "If present, ... MUST NOT be present". */
const EXCLUSIVE = /* @__PURE__ */ Object.freeze({ VEVENT: ['DTEND', 'DURATION'], VTODO: ['DUE', 'DURATION'] });
/** A REQUEST-STATUS code (RFC 5545 §3.8.8.3: statcode = 1*DIGIT 1*2("." 1*DIGIT)), of a class RFC 5545 and RFC 5546 §3.6 define (1-5). */
const STATUS_CODE = /^([1-5])(?:\.\d+){1,2}$/;

/** @type {Map<string, { count: string, props: [string, string][], subs: [string, string][], calendar: [string, string][] }>} */
const parsed = new Map();

/**
 * The table of a method and component, or undefined where §3 has none.
 * @param {string} method - upper case
 * @param {string} name - VEVENT, VTODO, VJOURNAL or VFREEBUSY
 */
function tableOf(method, name) {
  const key = `${method} ${name}`;
  if (!parsed.has(key)) {
    const text = /** @type {Record<string, string>} */ (TABLES)[key];
    if (text === undefined)
      return undefined;
    const [count, ...lists] = text.split('|');
    const [props, subs, calendar] = lists.map((list) => list.split(' ').filter(Boolean)
      .map((entry) => /** @type {[string, string]} */ ([entry.slice(0, -1), entry.slice(-1)])));
    parsed.set(key, { count, props, subs, calendar });
  }
  return parsed.get(key);
}

/**
 * Whether a count meets a presence.
 * @param {string} presence
 * @param {number} n
 */
const fits = (presence, n) => (presence === '1' ? n === 1 : presence === '+' ? n >= 1 : presence === '0' ? n === 0 : n <= 1);

/** @param {string} presence */
const spelled = (presence) => ({ 1: 'exactly once', '+': 'at least once', 0: 'never', '?': 'at most once' })[presence];

/**
 * One entry of the scheduling report.
 * @typedef {{ code: 'ICAL1026' | 'ICAL1027' | 'ICAL1028', name: string, path: string, line: number, reason: string }} SchedulingEntry
 */

/**
 * A property as the checks read it: its name, line, raw value and parameters.
 * @typedef {{ name: string, line: number, value?: string, params?: readonly { name: string, values: readonly string[] }[] }} ItipProp
 * @typedef {{ name: string, path: string, line: number, props: readonly ItipProp[], children: readonly ItipNode[] }} ItipNode
 */

/**
 * The status code of a REQUEST-STATUS value (its text before the first
 * unescaped `;`), and whether a description follows it.
 * @param {string} value
 */
function statusOf(value) {
  const cut = value.search(/(?<!\\);/);
  return { code: cut < 0 ? value : value.slice(0, cut), described: cut >= 0 };
}

/**
 * The top-level classes of a component's well-formed REQUEST-STATUS codes.
 * @param {readonly ItipProp[]} props
 * @returns {Set<string>}
 */
function statusClasses(props) {
  const classes = new Set();
  for (const prop of props) {
    const match = prop.name === 'REQUEST-STATUS' ? STATUS_CODE.exec(statusOf(prop.value ?? '').code) : null;
    if (match !== null)
      classes.add(match[1]);
  }
  return classes;
}

/**
 * A component's entries against its method's table: a property or
 * subcomponent it requires and lacks (`ICAL1026`), or one it excludes or
 * takes fewer times (`ICAL1027`); a component the method does not take
 * at all is one entry (`ICAL1027`). Then the tables' comments the
 * message alone answers: a value they restrict (`ICAL1028`: ADD's
 * SEQUENCE above 0, CANCEL's STATUS CANCELLED, COUNTER's VEVENT STATUS),
 * DTEND or DUE beside DURATION (`ICAL1027`), a VALARM's DURATION without
 * its REPEAT or the reverse (`ICAL1026`, §3.1.3), and each REQUEST-STATUS
 * (`ICAL1028`): a status code of RFC 5545 §3.8.8.3's syntax with its
 * description, of a class 1-5, one class in the component (§3.6 rule 1).
 * @param {ItipNode} node
 * @param {string} method - upper case
 * @returns {SchedulingEntry[]}
 */
export function componentEntries(node, method) {
  const table = tableOf(method, node.name);
  if (table === undefined)
    return [{ code: 'ICAL1027', name: node.name, path: node.path, line: node.line, reason: `METHOD:${method} takes no ${node.name} (RFC 5546 §3)` }];
  /** @type {SchedulingEntry[]} */
  const entries = [];
  const check = (/** @type {[string, string][]} */ list, /** @type {readonly { name: string, line?: number }[]} */ items) => {
    for (const [name, presence] of list) {
      const found = items.filter((item) => item.name === name);
      if (!fits(presence, found.length)) {
        entries.push({ code: found.length === 0 ? 'ICAL1026' : 'ICAL1027', name, path: `${node.path}/${name}`, line: found[presence === '0' ? 0 : 1]?.line ?? node.line,
          reason: `a ${node.name} of METHOD:${method} holds ${name} ${spelled(presence)} (RFC 5546 §3), not ${found.length} times` });
      }
    }
  };
  check(table.props, node.props);
  check(table.subs, node.children);
  const value = (/** @type {ItipProp} */ prop, /** @type {string} */ reason) => entries.push({ code: 'ICAL1028', name: prop.name,
    path: `${node.path}/${prop.name}`, line: prop.line, reason: `${reason} (RFC 5546 §3), not '${prop.value}'` });
  for (const [name, rule, allowed] of VALUES[`${method} ${node.name}`] ?? []) {
    for (const prop of node.props.filter((item) => item.name === name)) {
      const text = (prop.value ?? '').toUpperCase();
      if (rule === 'positive' ? /^\+?\d+$/.test(text) && Number(text) === 0 : !(/** @type {readonly string[]} */ (allowed)).includes(text))
        value(prop, `a ${node.name} of METHOD:${method} holds ${name} ${rule === 'positive' ? 'greater than 0' : `of ${(/** @type {readonly string[]} */ (allowed)).join(' or ')}`}`);
    }
  }
  const pair = /** @type {Record<string, readonly string[]>} */ (EXCLUSIVE)[node.name];
  const second = pair === undefined ? undefined : node.props.find((prop) => prop.name === pair[1]);
  if (second !== undefined && node.props.some((prop) => prop.name === pair[0])) {
    entries.push({ code: 'ICAL1027', name: pair[1], path: `${node.path}/${pair[1]}`, line: second.line,
      reason: `a ${node.name} of METHOD:${method} holds ${pair[0]} or ${pair[1]}, never both (RFC 5546 §3)` });
  }
  for (const alarm of node.children.filter((child) => child.name === 'VALARM')) {
    const has = (/** @type {string} */ name) => alarm.props.some((prop) => prop.name === name);
    for (const [name, other] of [['DURATION', 'REPEAT'], ['REPEAT', 'DURATION']]) {
      if (has(name) && !has(other)) {
        entries.push({ code: 'ICAL1026', name: other, path: `${alarm.path}/${other}`, line: alarm.line,
          reason: `a VALARM holding ${name} holds ${other} too (RFC 5546 §3.1.3)` });
      }
    }
  }
  const statuses = node.props.filter((prop) => prop.name === 'REQUEST-STATUS');
  for (const prop of statuses) {
    const { code, described } = statusOf(prop.value ?? '');
    if (!STATUS_CODE.test(code) || !described)
      value(prop, 'REQUEST-STATUS is a status code of class 1 to 5 (RFC 5545 §3.8.8.3, RFC 5546 §3.6), a \';\' and its description');
  }
  if (statusClasses(statuses).size > 1) {
    const prop = /** @type {ItipProp} */ (statuses.at(-1));
    value(prop, `the REQUEST-STATUS codes of one ${node.name} are of one class, "there cannot be a mixture" (RFC 5546 §3.6)`);
  }
  return entries;
}

/**
 * A VTIMEZONE's entries against §3.1.2: one or more STANDARD or DAYLIGHT
 * (`ICAL1026`), each with a DTSTART "in local time format" (`ICAL1028`,
 * no UTC designator, no TZID) and an RDATE or an RRULE, not both
 * (`ICAL1027`).
 * @param {ItipNode} node
 * @returns {SchedulingEntry[]}
 */
export function timezoneEntries(node) {
  /** @type {SchedulingEntry[]} */
  const entries = [];
  const onsets = node.children.filter((child) => child.name === 'STANDARD' || child.name === 'DAYLIGHT');
  if (onsets.length === 0)
    entries.push({ code: 'ICAL1026', name: 'STANDARD', path: `${node.path}/STANDARD`, line: node.line, reason: 'a VTIMEZONE holds one or more STANDARD or DAYLIGHT (RFC 5546 §3.1.2)' });
  for (const onset of onsets) {
    for (const prop of onset.props.filter((item) => item.name === 'DTSTART')) {
      if (/Z$/i.test(prop.value ?? '') || (prop.params ?? []).some((param) => param.name === 'TZID')) {
        entries.push({ code: 'ICAL1028', name: 'DTSTART', path: `${onset.path}/DTSTART`, line: prop.line,
          reason: `a ${onset.name}'s DTSTART is in local time format (RFC 5546 §3.1.2), not '${prop.value}'` });
      }
    }
    const rule = onset.props.find((prop) => prop.name === 'RRULE');
    if (rule !== undefined && onset.props.some((prop) => prop.name === 'RDATE')) {
      entries.push({ code: 'ICAL1027', name: 'RRULE', path: `${onset.path}/RRULE`, line: rule.line,
        reason: `a ${onset.name} of an iTIP message holds RDATE or RRULE, never both (RFC 5546 §3.1.2)` });
    }
  }
  return entries;
}

/**
 * What the calendar-wide checks keep of each component: how many of
 * each kind, the UIDs of each scheduling kind, the REQUEST-STATUS classes
 * of each component that has one, the TZIDs its properties name and those
 * its VTIMEZONEs define.
 * @typedef {{ counts: Map<string, number>, uids: Map<string, Set<string>>, statuses: { name: string, classes: Set<string> }[],
 *   named: Set<string>, defined: Set<string> }} ItipTally
 */

/** @returns {ItipTally} */
export function createTally() {
  return { counts: new Map(), uids: new Map(), statuses: [], named: new Set(), defined: new Set() };
}

/**
 * Count a component directly inside the calendar and keep the TZID a
 * VTIMEZONE defines; with `full` keep what the calendar-wide checks read
 * of a scheduling component.
 * @param {ItipTally} tally
 * @param {ItipNode} node
 * @param {boolean} full - the calendar has a METHOD
 */
export function tallyComponent(tally, node, full) {
  tally.counts.set(node.name, (tally.counts.get(node.name) ?? 0) + 1);
  // a VTIMEZONE defines its TZID for the whole calendar, one read before a late METHOD too
  if (node.name === 'VTIMEZONE') {
    const tzid = node.props.find((prop) => prop.name === 'TZID')?.value;
    if (tzid !== undefined)
      tally.defined.add(tzid);
    return;
  }
  if (!full || !Object.hasOwn(ITIP_KINDS, node.name))
    return;
  const uid = node.props.find((prop) => prop.name === 'UID')?.value;
  if (uid !== undefined)
    tally.uids.set(node.name, (tally.uids.get(node.name) ?? new Set()).add(uid));
  const classes = statusClasses(node.props);
  if (classes.size !== 0)
    tally.statuses.push({ name: node.name, classes });
  const walk = (/** @type {ItipNode} */ part) => {
    for (const prop of part.props) {
      for (const param of prop.params ?? []) {
        if (param.name === 'TZID')
          tally.named.add(param.values[0]);
      }
    }
    part.children.forEach(walk);
  };
  walk(node);
}

/**
 * The calendar's entries: how many components of each kind the method
 * takes, and which kinds (and VTIMEZONEs) its tables exclude beside them
 * (`ICAL1027`); components of one UID where the table says "All
 * components MUST have the same UID" (`ICAL1028`); a TZID no VTIMEZONE of
 * the message defines, where "VTIMEZONE ... MUST be present if any
 * date/time refers to a timezone" (`ICAL1026`); and §3.6 rule 2, a 5.x or
 * 3.x REQUEST-STATUS in one component and another class in another
 * (`ICAL1028`).
 * @param {ItipTally} tally
 * @param {string} method - upper case
 * @param {{ path: string, line: number }} at - the calendar
 * @returns {SchedulingEntry[]}
 */
export function calendarEntries(tally, method, at) {
  const { counts } = tally;
  /** @type {SchedulingEntry[]} */
  const entries = [];
  const seen = new Set();
  for (const name of Object.keys(ITIP_KINDS)) {
    const table = (counts.get(name) ?? 0) === 0 ? undefined : tableOf(method, name);
    if (table === undefined)
      continue;
    for (const [other, presence] of [[name, table.count], ...table.calendar]) {
      const n = counts.get(other) ?? 0;
      // a kind the method takes no table for is named at each such component already
      const untaken = Object.hasOwn(ITIP_KINDS, other) && tableOf(method, other) === undefined;
      if (!fits(presence, n) && !seen.has(other) && !untaken) {
        seen.add(other);
        entries.push({ code: 'ICAL1027', name: other, path: `${at.path}/${other}`, line: at.line,
          reason: `a METHOD:${method} calendar of ${name}s holds ${other} ${spelled(presence)} (RFC 5546 §3), not ${n} times` });
      }
    }
    const uids = tally.uids.get(name);
    if (ONE_UID.includes(`${method} ${name}`) && uids !== undefined && uids.size > 1) {
      entries.push({ code: 'ICAL1028', name: 'UID', path: `${at.path}/${name}`, line: at.line,
        reason: `the ${name}s of a METHOD:${method} calendar have one UID (RFC 5546 §3), not ${uids.size}` });
    }
  }
  const undefinedZones = [...tally.named].filter((tzid) => !tally.defined.has(tzid));
  if (undefinedZones.length !== 0) {
    entries.push({ code: 'ICAL1026', name: 'VTIMEZONE', path: `${at.path}/VTIMEZONE`, line: at.line,
      reason: `a METHOD:${method} calendar holds the VTIMEZONE of every TZID it names (RFC 5546 §3), and none defines ${undefinedZones.join(', ')}` });
  }
  for (const top of ['5', '3']) {
    if (!tally.statuses.some((entry) => entry.classes.has(top)))
      continue;
    // a component that mixes classes is its own entry (rule 1)
    if (tally.statuses.some((entry) => !entry.classes.has(top))) {
      entries.push({ code: 'ICAL1028', name: 'REQUEST-STATUS', path: `${at.path}/REQUEST-STATUS`, line: at.line,
        reason: `a ${top}.xx REQUEST-STATUS in one component of a METHOD:${method} calendar means every component with one has a ${top}.xx code (RFC 5546 §3.6)` });
    }
    break;
  }
  return entries;
}

/**
 * The components a writer rendered, read back from their unfolded lines
 * into the nodes the checks take: each property's name, raw value and
 * parameters (a quoted parameter value is read whole).
 * @param {readonly string[]} lines
 * @returns {ItipNode[]} the components directly inside the calendar
 */
export function writtenNodes(lines) {
  /** @type {any[]} */
  const stack = [];
  /** @type {ItipNode[]} */
  const top = [];
  for (const [i, line] of lines.entries()) {
    const name = /^[A-Za-z0-9-]+/.exec(line)?.[0].toUpperCase() ?? '';
    // the value starts at the first colon outside a quoted parameter value
    let at = name.length;
    let quoted = false;
    while (at < line.length && (quoted || line[at] !== ':')) {
      if (line[at] === '"')
        quoted = !quoted;
      at++;
    }
    const value = line.slice(at + 1);
    if (name === 'BEGIN') {
      const node = { name: value.toUpperCase(), path: `/${value.toUpperCase()}`, line: i + 1, props: [], children: [] };
      (stack.length === 0 ? top : stack.at(-1).children).push(node);
      stack.push(node);
    }
    else if (name === 'END')
      stack.pop();
    else {
      const params = line.slice(name.length, at).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/).slice(1).map((param) => {
        const eq = param.indexOf('=');
        return { name: param.slice(0, eq).toUpperCase(), values: [param.slice(eq + 1).replace(/^"|"$/g, '')] };
      });
      stack.at(-1)?.props.push({ name, line: i + 1, value, params });
    }
  }
  return top;
}

//#endregion
