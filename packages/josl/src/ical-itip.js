//@ts-check

//#region iTIP (RFC 5546)
// The scheduling methods of RFC 5546 as data: the METHOD a calendar
// names, each component checked against §3's restriction table for that
// method and component (which properties and subcomponents it requires,
// takes at most once, or excludes), and the people and status lines a
// message carries. The tables are reported, never enforced by dropping
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
 * @typedef {{ code: 'ICAL1026' | 'ICAL1027', name: string, path: string, line: number, reason: string }} SchedulingEntry
 */

/**
 * A component's entries against its method's table: a property or
 * subcomponent it requires and lacks (`ICAL1026`), or one it excludes or
 * takes fewer times (`ICAL1027`); a component the method does not take
 * at all is one entry (`ICAL1027`).
 * @param {{ name: string, path: string, line: number, props: readonly { name: string, line: number }[], children: readonly { name: string }[] }} node
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
  return entries;
}

/**
 * The calendar's entries: how many components of each kind the method
 * takes, and which kinds (and VTIMEZONEs) its tables exclude beside them.
 * @param {Map<string, number>} counts - components by name
 * @param {string} method - upper case
 * @param {{ path: string, line: number }} at - the calendar
 * @returns {SchedulingEntry[]}
 */
export function calendarEntries(counts, method, at) {
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
  }
  return entries;
}

/**
 * The entries of the components a writer rendered, against the method's
 * table: their unfolded lines read back into components and properties.
 * @param {readonly string[]} lines
 * @param {string} method - upper case
 * @returns {SchedulingEntry[]}
 */
export function writtenEntries(lines, method) {
  /** @type {any[]} */
  const stack = [];
  /** @type {SchedulingEntry[]} */
  const entries = [];
  for (const [i, line] of lines.entries()) {
    const name = /^[A-Za-z0-9-]+/.exec(line)?.[0].toUpperCase() ?? '';
    const value = line.slice(line.indexOf(':') + 1).toUpperCase();
    if (name === 'BEGIN') {
      const node = { name: value, path: `/${value}`, line: i + 1, props: [], children: [] };
      stack.at(-1)?.children.push(node);
      stack.push(node);
    }
    else if (name === 'END') {
      const node = stack.pop();
      if (stack.length === 0 && Object.hasOwn(ITIP_KINDS, node.name))
        entries.push(...componentEntries(node, method));
    }
    else
      stack.at(-1)?.props.push({ name, line: i + 1 });
  }
  return entries;
}

//#endregion
