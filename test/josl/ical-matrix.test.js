//@ts-check

/**
 * The capability matrix of docs/ICAL.md, held to the reader name by
 * name: every row's names are read from the table, a calendar holding
 * only that name is read, and the code the row's Read column gives
 * first (or no entry, for a row that reads it) is what the report says.
 * The same calendar comes back unchanged from a lossless read and an
 * empty patch. A name the table lists and this file cannot probe fails,
 * as does a probe the table no longer lists.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseIcal, patchIcal } from '@jarenjs/josl/ical';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const DOC = fileURLToPath(new URL('../../packages/josl/docs/ICAL.md', import.meta.url));
const provider = createIntlZoneProvider({ revision: 'matrix' });

const ZONE = ['BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100', 'TZNAME:CET', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT'];
const EVENT = ['UID:m', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260302T090000Z'];

/**
 * A calendar: its own lines, then components.
 * @param {string[]} head - calendar properties after VERSION and PRODID
 * @param {string[]} body
 */
const calendar = (head, body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Matrix//EN', ...head, ...body, 'END:VCALENDAR', '']
  .join('\r\n');
/** @param {string[]} lines */
const event = (lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
/** @param {string[]} extra */
const zone = (extra = []) => [...ZONE, ...extra, 'END:VTIMEZONE'];
const OTHER_COMPONENTS = { 'X- and IANA components': ['X-WIDGET', 'VPOLL'] };
const OTHER_PROPERTIES = { 'X- and IANA properties': ['X-SHOP-AISLE', 'STRUCTURED-DATA'] };
const OTHER_PARAMETERS = { 'X- and IANA parameters': ['X-SOURCE', 'DERIVED'] };
const EVENT_PROPERTIES = ['ATTACH', 'CATEGORIES', 'CLASS', 'COMMENT', 'GEO', 'PERCENT-COMPLETE', 'PRIORITY', 'RESOURCES', 'COMPLETED', 'DUE',
  'TRANSP', 'ATTENDEE', 'CONTACT', 'ORGANIZER', 'RELATED-TO', 'URL', 'CREATED', 'LAST-MODIFIED', 'REQUEST-STATUS', 'CONFERENCE'];
const SAMPLE = /** @type {Record<string, string>} */ ({ GEO: '37.386013;-122.082932', 'PERCENT-COMPLETE': '39', PRIORITY: '1',
  COMPLETED: '20260302T100000Z', DUE: '20260303T000000Z', TRANSP: 'OPAQUE', ATTENDEE: 'mailto:a@example.com',
  ORGANIZER: 'mailto:o@example.com', URL: 'https://example.com/', CREATED: '20260101T000000Z', 'LAST-MODIFIED': '20260101T000000Z',
  'REQUEST-STATUS': '2.0;Success', CONFERENCE: 'https://example.com/call' });

/**
 * The calendar that holds one name, and the name its report entry carries.
 * @param {string} name
 * @param {boolean} [onCalendar] - a property of the calendar itself (RFC 7986)
 * @returns {{ text: string, reported: string } | undefined}
 */
function probe(name, onCalendar = false) {
  const plain = (/** @type {string[]} */ lines) => ({ text: calendar([], event([...EVENT, ...lines])), reported: name });
  switch (onCalendar ? '' : name) {
    case 'VCALENDAR': case 'VERSION': case 'PRODID': case 'UID': case 'DTSTAMP': case 'DTSTART':
      return plain([]);
    case 'VEVENT':
      return plain(['SUMMARY:x']);
    case 'VFREEBUSY': case 'FREEBUSY': case 'FBTYPE':
      return { text: calendar([], ['BEGIN:VFREEBUSY', 'UID:f', 'DTSTAMP:20260101T000000Z', 'FREEBUSY;FBTYPE=BUSY:20260302T090000Z/PT1H',
        'END:VFREEBUSY']), reported: name === 'FBTYPE' ? 'FREEBUSY;FBTYPE' : name };
    case 'VTIMEZONE': case 'STANDARD': case 'DAYLIGHT': case 'TZOFFSETFROM': case 'TZOFFSETTO': case 'TZNAME': case 'TZID (property)':
      return { text: calendar([], zone()), reported: name.replace(' (property)', '') };
    case 'TZURL': case 'TZUNTIL': case 'TZID-ALIAS-OF': {
      const prop = name;
      const value = { TZURL: 'https://tz.example.com/zones/Europe/Amsterdam', TZUNTIL: '21000101T000000Z', 'TZID-ALIAS-OF': 'Europe/Brussels' }[prop];
      return { text: calendar([], zone([`${prop}:${value}`])), reported: prop };
    }
    case 'VTODO': case 'VJOURNAL': case 'VAVAILABILITY': case 'X-WIDGET': case 'VPOLL':
      return { text: calendar([], [`BEGIN:${name}`, 'UID:c', 'DTSTAMP:20260101T000000Z', `END:${name}`]), reported: name };
    case 'AVAILABLE':
      return { text: calendar([], ['BEGIN:VAVAILABILITY', 'UID:c', 'DTSTAMP:20260101T000000Z', 'BEGIN:AVAILABLE', 'UID:d',
        'DTSTAMP:20260101T000000Z', 'END:AVAILABLE', 'END:VAVAILABILITY']), reported: 'VAVAILABILITY' };
    case 'VALARM': case 'ACTION': case 'REPEAT': case 'TRIGGER':
      return { text: calendar([], event([...EVENT, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'REPEAT:1', 'DURATION:PT1M',
        'DESCRIPTION:r', 'END:VALARM'])), reported: 'VALARM' };
    case 'CALSCALE':
      return { text: calendar(['CALSCALE:GREGORIAN'], event(EVENT)), reported: name };
    case 'METHOD':
      return { text: calendar(['METHOD:PUBLISH'], event(EVENT)), reported: name };
    case 'DTEND':
      return plain(['DTEND:20260302T100000Z']);
    case 'DURATION':
      return plain(['DURATION:PT1H']);
    case 'SUMMARY': case 'DESCRIPTION': case 'LOCATION':
      return plain([`${name}:Text\\, escaped`]);
    case 'STATUS':
      return plain(['STATUS:CONFIRMED']);
    case 'SEQUENCE':
      return plain(['SEQUENCE:2']);
    case 'RRULE':
      return plain(['RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=3']);
    case 'RDATE':
      return plain(['RDATE:20260303T090000Z']);
    case 'EXDATE':
      return plain(['RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20260303T090000Z']);
    case 'EXRULE':
      return plain(['RRULE:FREQ=DAILY;COUNT=3', 'EXRULE:FREQ=DAILY;COUNT=1']);
    case 'RECURRENCE-ID': case 'RANGE':
      return { text: calendar([], [...event([...EVENT, 'RRULE:FREQ=DAILY;COUNT=3']), ...event(['UID:m', 'DTSTAMP:20260101T000000Z',
        `RECURRENCE-ID${name === 'RANGE' ? ';RANGE=THISANDFUTURE' : ''}:20260303T090000Z`, 'DTSTART:20260303T100000Z'])]),
      reported: name === 'RANGE' ? 'RECURRENCE-ID;RANGE' : name };
    case 'VALUE':
      return { text: calendar([], event(['UID:m', 'DTSTAMP:20260101T000000Z', 'DTSTART;VALUE=DATE:20260302'])), reported: 'DTSTART;VALUE' };
    case 'TZID':
      return { text: calendar([], [...zone(), ...event(['UID:m', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000'])]),
        reported: 'DTSTART;TZID' };
    default:
      break;
  }
  if (onCalendar) {
    const value = { NAME: 'Shop hours', 'REFRESH-INTERVAL;VALUE=DURATION': 'P1W', 'SOURCE;VALUE=URI': 'https://example.com/h.ics',
      COLOR: 'turquoise', 'IMAGE;VALUE=URI': 'https://example.com/i.png', DESCRIPTION: 'Opening hours', UID: 'shop-hours',
      URL: 'https://example.com/', 'LAST-MODIFIED': '20260101T000000Z', CATEGORIES: 'SHOP' };
    const line = Object.entries(value).find(([key]) => key.split(';')[0] === name);
    return line === undefined ? undefined : { text: calendar([`${line[0]}:${line[1]}`], event(EVENT)), reported: name };
  }
  if (EVENT_PROPERTIES.includes(name) || OTHER_PROPERTIES['X- and IANA properties'].includes(name))
    return plain([`${name}:${SAMPLE[name] ?? 'x'}`]);
  // a parameter, on a property of the subset
  if (/^[A-Z][A-Z-]*$/.test(name))
    return { ...plain([`SUMMARY;${name}=${name === 'ALTREP' ? '"cid:x"' : 'x'}:Text`]), reported: `SUMMARY;${name}` };
  return undefined;
}

/**
 * The text of a cell up to its first `;` outside parentheses.
 * @param {string} cell
 */
function firstClause(cell) {
  let depth = 0;
  for (let i = 0; i < cell.length; i++) {
    if (cell[i] === '(')
      depth++;
    else if (cell[i] === ')')
      depth--;
    else if (cell[i] === ';' && depth === 0)
      return cell.slice(0, i);
  }
  return cell;
}

/** The matrix rows: their names, and the Read column. */
function rows() {
  const text = fs.readFileSync(DOC, 'utf8');
  const table = text.slice(text.indexOf('## Capability matrix'));
  /** @type {{ names: string[], read: string, onCalendar: boolean }[]} */
  const out = [];
  for (const line of table.split('\n')) {
    const cells = line.split(' | ');
    if (!line.startsWith('| `') && !line.startsWith('| X-'))
      continue;
    const first = cells[0].slice(2);
    /** @type {string[]} */
    const names = [];
    for (const part of first.split(/, (?=`|X- )/)) {
      const phrase = part.trim();
      const other = { ...OTHER_COMPONENTS, ...OTHER_PROPERTIES, ...OTHER_PARAMETERS }[phrase];
      if (other !== undefined)
        names.push(...other);
      else
        names.push(phrase.replace(/`/g, ''));
    }
    out.push({ names, read: cells[2], onCalendar: first.endsWith('(RFC 7986, calendar)') });
  }
  return out;
}

describe('the capability matrix of ICAL.md is what the reader does', () => {
  const table = rows();

  it('lists the components, properties and parameters it is expected to', () => {
    const names = table.flatMap((row) => row.names);
    assert.ok(names.length >= 85, `${names.length} names`);
    for (const required of ['VEVENT', 'VTODO', 'VALARM', 'RRULE', 'EXRULE', 'TRIGGER', 'TZUNTIL (RFC 7808)', 'CONFERENCE (RFC 7986)', 'RANGE', 'ALTREP', 'LABEL'])
      assert.ok(names.includes(required), required);
  });

  for (const row of table) {
    for (const name of row.names) {
      it(`${name}${row.onCalendar ? ' (calendar)' : ''}: ${firstClause(row.read).trim()}`, () => {
        // the property and the parameter TZID are two rows; any other note is not part of the name
        const found = probe(name === 'TZID (property)' ? name : name.replace(/ \(.*\)$/, ''), row.onCalendar);
        assert.ok(found !== undefined, `no probe for ${name}`);
        const clause = firstClause(row.read);
        const code = /reported|withheld/.test(clause) ? /ICAL\d{4}/.exec(clause)?.[0] : undefined;
        const read = parseIcal(found.text, { provider });
        const entries = read.report.unsupported.filter((entry) => entry.name === found.reported);
        if (code === undefined)
          assert.deepStrictEqual(entries, [], `${name} reads without a report entry`);
        else
          assert.deepStrictEqual(entries.map((entry) => entry.code), [code], `${name}: ${JSON.stringify(read.report.unsupported)}`);
        const lossless = /** @type {any} */ (parseIcal(found.text, { mode: 'lossless', provider }));
        assert.strictEqual(patchIcal(lossless.tree), found.text);
      });
    }
  }
});
