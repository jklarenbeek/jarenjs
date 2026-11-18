//@ts-check

//#region iCalendar wire rules
// What every line the iCalendar writer emits obeys (RFC 5545 §3.1-3.3):
// a content line is NAME *(;PARAM=VALUE) : VALUE, ends in CRLF, and is
// folded so that no physical line holds more than 75 octets (the leading
// space of a continuation counts); a fold never splits a UTF-8 code
// point. TEXT values escape backslash, semicolon, comma and newlines,
// and refuse what iCalendar cannot carry (control characters, lone
// surrogates) rather than replace it. Every parameter the writer emits
// is a fixed token from its own tables (VALUE=DATE, VALUE=PERIOD,
// FBTYPE=...), none of which needs quoting.

import { CodedError } from '@jarenjs/core/errors';

/**
 * The diagnoses of the iCalendar reader and the refusals of the writer,
 * one code each. The reader's are `ICAL1xxx`: `ICAL1001`-`ICAL1009`
 * stop the read (the text is not an iCalendar object it can follow),
 * `ICAL1010`-`ICAL1025` are entries of its report, `ICAL1026`-`ICAL1027` of its scheduling report (thrown instead under
 * `strict`). `ICAL2xxx` are the size limits (`ICAL_LIMIT_CODES`); the
 * writer's own refusals are `ICAL3xxx`.
 * @type {Readonly<Record<'ICAL1001' | 'ICAL1002' | 'ICAL1003' | 'ICAL1004' | 'ICAL1005' | 'ICAL1006'
 *   | 'ICAL1007' | 'ICAL1008' | 'ICAL1009' | 'ICAL1010' | 'ICAL1011' | 'ICAL1012' | 'ICAL1013'
 *   | 'ICAL1014' | 'ICAL1015' | 'ICAL1016' | 'ICAL1017' | 'ICAL1018' | 'ICAL1019' | 'ICAL1020'
 *   | 'ICAL1021' | 'ICAL1022' | 'ICAL1023' | 'ICAL1024' | 'ICAL1025' | 'ICAL1026' | 'ICAL1027'
 *   | 'ICAL3001' | 'ICAL3002' | 'ICAL3003' | 'ICAL3004' | 'ICAL3005' | 'ICAL3006'
 *   | 'ICAL3007' | 'ICAL3008' | 'ICAL3009' | 'ICAL3010' | 'ICAL3011' | 'ICAL3012' | 'ICAL3013'
 *   | 'ICAL3014' | 'ICAL3015' | 'ICAL3016' | 'ICAL3017' | 'ICAL3018' | 'ICAL3019' | 'ICAL3020' | 'ICAL3021' | 'ICAL3022'
 *   | 'ICAL4001' | 'ICAL4002' | 'ICAL4003' | 'ICAL4004' | 'ICAL4005' | 'ICAL4006' | 'ICAL4007'
 *   | 'ICAL4008' | 'ICAL4009' | 'ICAL4010' | 'ICAL4011' | 'ICAL4012' | 'ICAL4013', string>>}
 */
export const ICAL_CODES = /* @__PURE__ */ Object.freeze({
  ICAL1001: 'the input is not UTF-8, or a string holds a lone surrogate',
  ICAL1002: 'a content line is not NAME *(;PARAM) : VALUE, or BEGIN or END names no component',
  ICAL1003: 'a parameter is not NAME=VALUE *(,VALUE), or a quoted value is not closed where it ends',
  ICAL1004: 'a line holds a control character other than a tab, or a carriage return no line feed follows',
  ICAL1005: 'an END names a component other than the one open',
  ICAL1006: 'the input ends inside a component',
  ICAL1007: 'content outside the calendar: before BEGIN:VCALENDAR, after its END, or a calendar inside a calendar',
  ICAL1008: 'the calendar is not iCalendar 2.0 in the Gregorian scale: VERSION or PRODID missing, repeated or other',
  ICAL1009: 'the reader has ended or stopped, and takes no more input',
  ICAL1010: 'a line ends in a bare line feed; it is read as CRLF',
  ICAL1011: 'a property outside the subset; it is left out of the model',
  ICAL1012: 'a parameter outside the subset; its property is read without it',
  ICAL1013: 'a component outside the subset; it is left out of the model with everything inside it',
  ICAL1014: 'a VTIMEZONE that cannot be compiled, a second one of a TZID, or one a limit stopped; a TZID it would define resolves as one no VTIMEZONE defines',
  ICAL1015: 'Retired, no longer raised: an override over this and future occurrences is read into its series and expanded',
  ICAL1016: 'an override\'s property differs from its series\'; the series\' value is kept',
  ICAL1017: 'a component lacks a property it requires, repeats one, or holds two that exclude each other; it is withheld',
  ICAL1018: 'a value is not of the form or kind its property takes here; its component is withheld',
  ICAL1019: 'a TZID that names no IANA zone the provider knows, or no provider; its component is withheld, never guessed',
  ICAL1020: 'the calendar layer refused a value, rule or series; its CalendarError is the cause and the component is withheld',
  ICAL1021: 'an override with no series of its UID, or a second series of one UID; it is withheld',
  ICAL1022: 'what changes when the event occurs and this release does not read (EXRULE, EXDATE with no rule, extra dates whose DTEND lies in another zone); its component is withheld',
  ICAL1023: 'a VTIMEZONE of an IANA name and the provider give other offsets over the span the file uses it; the source vtimezone chose is used',
  ICAL1024: 'a value lies outside what the VTIMEZONE of its TZID covers; the provider answers there for an IANA name it knows, and it is refused when resolved otherwise',
  ICAL1025: 'a VAVAILABILITY the availability layers cannot hold as RFC 7953 reads it: a BUSYTYPE other than BUSY-UNAVAILABLE, or AVAILABLE times both UTC and zoned; it is withheld',
  ICAL1026: 'scheduling: a component of a calendar with a METHOD lacks a property or subcomponent RFC 5546 §3 requires of it under that method',
  ICAL1027: 'scheduling: a component of a calendar with a METHOD holds a property or subcomponent RFC 5546 §3 excludes, or more of one than it takes, or the method takes no such component',
  ICAL3001: 'the calendar or a component is not an object of the documented model, or lacks a member it requires',
  ICAL3002: 'a member or component type outside the documented subset; it is refused, never written raw',
  ICAL3003: 'a member holds a value of a form it does not take',
  ICAL3004: 'text holds a control character or a lone surrogate, which iCalendar cannot carry',
  ICAL3005: 'the calendar layer refused a value, rule or series; its CalendarError is the cause',
  ICAL3006: 'a time carries a fraction of a second; iCalendar counts whole seconds and nothing is truncated',
  ICAL3007: 'an end is not after its start, is of another kind, or comes with a duration',
  ICAL3008: 'a zoned value and no zones mode chosen',
  ICAL3009: 'a zoned value and no zone provider, in the options or the runtime',
  ICAL3010: 'a zoned value of a single event and no policy to resolve it',
  ICAL3011: 'a zoned recurring series and no horizon: a UTC start with a rule would move occurrences across offset changes',
  ICAL3012: 'a series expansion stopped at a limit; nothing is written truncated',
  ICAL3013: 'a series makes no occurrence to write',
  ICAL3014: 'two slots of a zoned series resolve to one UTC instant, which a UTC calendar cannot tell apart',
  ICAL3015: 'an override names a slot the series never makes',
  ICAL3016: 'an override over this and future occurrences that names its own slot\'s length, in a series with an RDATE period, for later slots of another length',
  ICAL3017: 'a value iCalendar cannot spell here: a period of dates as an extra date, or a free/busy span that is not an instant',
  ICAL3018: 'the writer has ended or refused, and takes no more components',
  ICAL3019: "zones: 'embed' and no horizon for the VTIMEZONE of a zone",
  ICAL3020: "a zoned time outside the horizon its VTIMEZONE covers under zones: 'embed'",
  ICAL3021: 'a component the writer would write is no message of the calendar\'s METHOD: RFC 5546 §3 requires, excludes or limits a property it holds',
  ICAL3022: 'under zones: \'utc\' a zoned recurring AVAILABLE whose VAVAILABILITY period the horizon does not hold, where its occurrences would end at the horizon',
  ICAL4001: 'an edit is not one of the documented edits, or a member of it has a form it does not take',
  ICAL4002: 'no VEVENT holds the UID, or the occurrence, an edit names',
  ICAL4003: 'more than one VEVENT could be the one an edit names',
  ICAL4004: 'the event is not recurring, or its series makes no such occurrence, or the occurrence is excluded or cancelled',
  ICAL4005: 'the occurrence is the slot of an override over this and future occurrences whose next slot has its own VEVENT, where cancelling or excluding it would move the range',
  ICAL4006: "the read withheld the event, or the occurrence's own VEVENT, so the occurrence cannot be checked",
  ICAL4007: 'the edit would lose content: a property held more than once, a text with an alternate representation, or an occurrence with its own VEVENT',
  ICAL4008: "a moved occurrence's start or end is not of its series' kind and zone",
  ICAL4009: 'a move gives no end, and the length is held by a DTEND the new start would leave behind',
  ICAL4010: 'two edits reach one property or occurrence, or an event another edit removes',
  ICAL4011: "the tree is not one parseIcal returned under mode: 'lossless'",
  ICAL4012: 'the edited calendar would not read back with every event an edit reached and kept',
  ICAL4013: "a VALARM's TRIGGER is an absolute time, which a duration does not replace",
});

/**
 * The refusal of the iCalendar writer or reader: a {@link CodedError}
 * whose `code` is one of {@link ICAL_CODES}. The writer's `docPath` is a
 * JSON pointer into the calendar model (`/components/2/summary`,
 * `/options/zones`); the reader's is the path of the content in the
 * text (`/VCALENDAR/VEVENT[2]/DTSTART`), with its 1-based physical
 * `line`.
 */
export class IcalError extends CodedError {
  /**
   * @param {string} code - one of {@link ICAL_CODES}
   * @param {string} reason - the bare reason; `message` is composed per the coded contract
   * @param {string} [docPath] - the member at fault
   * @param {unknown} [cause] - the calendar layer's refusal, when it refused
   * @param {number} [line] - the reader's: the physical line the content starts on
   */
  constructor(code, reason, docPath = undefined, cause = undefined, line = undefined) {
    super('IcalError', code, reason, docPath, cause !== undefined ? { cause } : undefined);
    if (line !== undefined) {
      // the reason stays bare; the message names the line
      this.line = line;
      this.message = `${this.message} (line ${line})`;
    }
  }
}

/**
 * The size limits, by option name. The writer checks each before the
 * component that would cross it is emitted, so a refusal never leaves a
 * calendar that looks whole; the reader checks each as the octets that
 * cross it arrive (`maxOctets`, `maxComponents` and the reader's own
 * `ICAL2004`-`ICAL2007`).
 * @type {Readonly<Record<'ICAL2001' | 'ICAL2002' | 'ICAL2003' | 'ICAL2004' | 'ICAL2005' | 'ICAL2006' | 'ICAL2007', string>>}
 */
export const ICAL_LIMIT_CODES = /* @__PURE__ */ Object.freeze({
  ICAL2001: 'the calendar exceeds maxOctets',
  ICAL2002: 'the calendar has more than maxComponents components',
  ICAL2003: 'the calendar has more than maxRdates extra dates',
  ICAL2004: 'an unfolded content line exceeds maxLineOctets',
  ICAL2005: 'a content line has more than maxParameters parameters',
  ICAL2006: 'components nest deeper than maxDepth',
  ICAL2007: 'a component has more than maxProperties properties',
});

//#endregion

//#region lines

const CRLF = '\r\n';
const LINE_OCTETS = 75;

/**
 * Octets of the code point starting at `i`, and its length in code units.
 * @param {number} code - the code unit at `i`
 * @returns {number}
 */
const octetsOf = (code) => (code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xD800 && code <= 0xDBFF ? 4 : 3);

/**
 * Fold one content line at 75 octets: the first physical line holds at
 * most 75, each continuation a space and at most 74; a code point is
 * never split. The text is already checked free of lone surrogates.
 * @param {string} line - one unfolded content line, no line break
 * @returns {string} the folded line, CRLF after every physical line
 */
export function foldLine(line) {
  let out = '';
  let start = 0;
  let octets = 0;
  let room = LINE_OCTETS;
  for (let i = 0; i < line.length;) {
    const code = line.charCodeAt(i);
    const size = octetsOf(code);
    if (octets + size > room) {
      out += `${line.slice(start, i)}${CRLF} `;
      start = i;
      octets = 0;
      room = LINE_OCTETS - 1;
    }
    octets += size;
    i += size === 4 ? 2 : 1;
  }
  return `${out}${line.slice(start)}${CRLF}`;
}

/**
 * Refuse text iCalendar cannot carry: a control character other than a
 * tab (and, where `newlines` is set, a line break, which TEXT escapes),
 * or a surrogate without its pair.
 * @param {string} text
 * @param {string} path
 * @param {boolean} newlines - whether line breaks are admitted (TEXT) or not
 */
export function admitChars(text, path, newlines) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7F) {
      if (code === 0x09 || (newlines && (code === 0x0A || code === 0x0D)))
        continue;
      throw new IcalError('ICAL3004', `the text holds the control character U+${code.toString(16).toUpperCase().padStart(4, '0')}`, path);
    }
    if (code >= 0xD800 && code <= 0xDFFF) {
      const next = text.charCodeAt(i + 1);
      if (code <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
        i++;
        continue;
      }
      throw new IcalError('ICAL3004', `the text holds a lone surrogate U+${code.toString(16).toUpperCase()}`, path);
    }
  }
}

/**
 * A TEXT value (RFC 5545 §3.3.11): backslash, semicolon and comma
 * escaped, every line break written as `\n`.
 * @param {unknown} text
 * @param {string} path
 * @returns {string}
 */
export function escapeText(text, path) {
  if (typeof text !== 'string')
    throw new IcalError('ICAL3003', `a text member is a string, not ${text === null ? 'null' : typeof text}`, path);
  admitChars(text, path, true);
  return text.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r\n|\r|\n/g, '\\n');
}

//#endregion

//#region values

const DAY = 86400000;
const DATE_FORM = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_FORM = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const INSTANT_FORM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
/** The RFC 5545 duration forms the calendar layer reads (a leading `+` admitted). */
const DURATION_FORM = /^\+?P(?:(\d+)W|(?=\d|T\d)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/;

/**
 * A civil date `YYYY-MM-DD` as its day number since 1970-01-01.
 * @param {string} date - already admitted by the calendar layer
 * @returns {number}
 */
export function daysOf(date) {
  const form = /** @type {RegExpExecArray} */ (DATE_FORM.exec(date));
  const at = new Date(0);
  at.setUTCFullYear(Number(form[1]), Number(form[2]) - 1, Number(form[3]));
  return Math.floor(at.getTime() / DAY);
}

/**
 * A wall clock or instant in milliseconds as `YYYYMMDD` or `YYYYMMDDTHHMMSS`.
 * @param {number} ms
 * @param {boolean} withTime
 * @returns {string}
 */
function spell(ms, withTime) {
  const iso = new Date(ms).toISOString();
  const date = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
  return withTime ? `${date}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}` : date;
}

/**
 * A DATE value from a day number.
 * @param {number} days
 * @returns {string}
 */
export const formatDate = (days) => spell(days * DAY, false);

/**
 * A floating DATE-TIME (no Z, no TZID) from a wall clock in milliseconds.
 * @param {number} wall
 * @returns {string}
 */
export const formatFloating = (wall) => spell(wall, true);

/**
 * A UTC DATE-TIME (`...Z`) from an instant in epoch milliseconds.
 * @param {number} instant
 * @returns {string}
 */
export const formatUtc = (instant) => `${spell(instant, true)}Z`;

/**
 * The wall clock of a date and a time of day (`24:00` the next midnight),
 * refusing a fraction of a second.
 * @param {string} date - `YYYY-MM-DD`, already admitted
 * @param {string} time - `HH:MM[:SS[.fff]]`, already admitted
 * @param {string} path
 * @returns {number}
 */
export function wallOf(date, time, path) {
  const form = /** @type {RegExpExecArray} */ (TIME_FORM.exec(time));
  if (form[4] !== undefined && Number(form[4]) !== 0)
    throw new IcalError('ICAL3006', `the time ${time} carries a fraction of a second`, path);
  return daysOf(date) * DAY + ((Number(form[1]) * 60 + Number(form[2])) * 60 + Number(form[3] ?? 0)) * 1000;
}

/**
 * The instant of an admitted utc value's text or an epoch, refusing a
 * fraction of a second.
 * @param {string | number} value
 * @param {string} path
 * @returns {number}
 */
export function instantOf(value, path) {
  if (typeof value === 'number') {
    if (value % 1000 !== 0)
      throw new IcalError('ICAL3006', `the instant ${value} carries a fraction of a second`, path);
    return value;
  }
  const form = /** @type {RegExpExecArray} */ (INSTANT_FORM.exec(value));
  if (form[7] !== undefined && Number(form[7]) !== 0)
    throw new IcalError('ICAL3006', `the instant ${value} carries a fraction of a second`, path);
  return daysOf(`${form[1]}-${form[2]}-${form[3]}`) * DAY + ((Number(form[4]) * 60 + Number(form[5])) * 60 + Number(form[6])) * 1000;
}

/**
 * Read an RFC 5545 duration into nominal days and exact milliseconds.
 * @param {unknown} text
 * @param {string} path
 * @returns {{ days: number, ms: number }}
 */
export function readDuration(text, path) {
  const form = typeof text === 'string' ? DURATION_FORM.exec(text) : null;
  if (form === null)
    throw new IcalError('ICAL3003', `a duration is an RFC 5545 duration such as P1W, P1D or PT1H30M, not ${typeof text === 'string' ? `'${text}'` : typeof text}`, path);
  return {
    days: Number(form[1] ?? 0) * 7 + Number(form[2] ?? 0),
    ms: ((Number(form[3] ?? 0) * 60 + Number(form[4] ?? 0)) * 60 + Number(form[5] ?? 0)) * 1000,
  };
}

/**
 * A duration in the canonical spelling of RFC 5545's grammar: whole
 * weeks as `PnW`, otherwise days and then hours, minutes and seconds
 * with no unit skipped between the first and the last given.
 * @param {{ days: number, ms: number }} length
 * @returns {string}
 */
export function formatDuration({ days, ms }) {
  if (ms === 0 && days !== 0 && days % 7 === 0)
    return `P${days / 7}W`;
  const seconds = Math.floor(ms / 1000);
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  const first = parts.findIndex((n) => n !== 0);
  if (first === -1)
    return days !== 0 ? `P${days}D` : 'PT0S';
  const last = parts.findLastIndex((n) => n !== 0);
  let time = 'T';
  for (let i = first; i <= last; i++)
    time += `${parts[i]}${'HMS'[i]}`;
  return `P${days !== 0 ? `${days}D` : ''}${time}`;
}

//#endregion
