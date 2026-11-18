//@ts-check

/**
 * The scheduling methods of RFC 5546 through `@jarenjs/josl/ical`: the
 * METHOD read and written, each component checked against §3's table for
 * its method as a report of its own (never through `strict`), and each
 * method's data mapped - a REPLY's PARTSTAT, a CANCEL as the series
 * model's cancellation, an ADD's event and a COUNTER's suggested event - with
 * the §4 examples (fixtures/ical-itip) as the oracle, expected answers
 * derived by hand from the tables.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { parseIcal, stringifyIcal } from '@jarenjs/josl/ical';

const FIXTURES = new URL('./fixtures/ical-itip/', import.meta.url);
const read = (/** @type {string} */ name, /** @type {Record<string, any>} */ options = {}) => /** @type {any} */ (parseIcal(fs.readFileSync(new URL(name, FIXTURES), 'utf8'), options));
const codes = (/** @type {any[]} */ entries) => entries.map((entry) => `${entry.code} ${entry.name}`);
const utc = (/** @type {string} */ instant) => ({ kind: 'utc', instant });
const A = 'mailto:a@example.com';

/** [file, method, scheduling report, components read, withheld report entries] */
const ROWS = /** @type {const} */ ([
  ['rfc5546-4.1.1-1.ics', 'publish', [], 1, []],
  ['rfc5546-4.1.3-1.ics', 'cancel', [], 0, []],
  ['rfc5546-4.2.1-1.ics', 'request', [], 0, ['ICAL1018 DTEND']],
  ['rfc5546-4.2.2-1.ics', 'reply', [], 0, []],
  ['rfc5546-4.2.4-2.ics', 'counter', [], 0, []],
  ['rfc5546-4.2.4-4.ics', 'declinecounter', [], 0, []],
  ['rfc5546-4.3.2-1.ics', 'request', [], 0, ['ICAL1018 DTEND']],
  ['rfc5546-4.3.3-1.ics', 'reply', [], 1, []],
  ['rfc5546-4.4.3-1.ics', 'cancel', [], 0, []],
  ['rfc5546-4.4.4-1.ics', 'cancel', [], 0, []],
  ['rfc5546-4.4.6-1.ics', 'add', [], 0, []],
  ['rfc5546-4.4.9-1.ics', 'counter', [], 0, []],
  ['rfc5546-4.5.2-1.ics', 'reply', [], 0, []],
  ['rfc5546-4.6-1.ics', 'publish', [], 0, []],
  ['rfc5546-4.7.1-1.ics', 'refresh', ['ICAL1027 ATTENDEE'], 0, ['ICAL1018 DTSTAMP']],
]);

describe('ical iTIP: the RFC 5546 §4 examples, read', () => {
  for (const [file, method, report, components, withheld] of ROWS) {
    it(`${file}: METHOD:${method.toUpperCase()}, its table's report, and its data`, () => {
      const { calendar, scheduling, report: own } = read(file);
      assert.deepStrictEqual([calendar.method, scheduling.method, codes(scheduling.report), calendar.components.length,
        codes(own.unsupported.filter((/** @type {any} */ entry) => entry.withheld))], [method, method, report, components, withheld]);
    });
  }

  it('reports only what a message and its event leave out', () => {
    const unsupported = (/** @type {string} */ file) => codes(read(file).report.unsupported);
    assert.deepStrictEqual([unsupported('rfc5546-4.2.4-2.ics'), unsupported('rfc5546-4.4.6-1.ics'), unsupported('rfc5546-4.2.2-1.ics'),
      unsupported('rfc5546-4.4.3-1.ics'), unsupported('rfc5546-4.4.9-1.ics')],
    [['ICAL1011 COMMENT'], ['ICAL1011 CLASS'], [], [], ['ICAL1011 CLASS', 'ICAL1011 COMMENT']]);
    // so a COUNTER of nothing but what its message and event read is read strictly
    const clean = fs.readFileSync(new URL('rfc5546-4.2.4-2.ics', FIXTURES), 'utf8').replace(/COMMENT:[^\r]*\r\n [^\r]*\r\n/, '');
    assert.strictEqual(/** @type {any} */ (parseIcal(clean, { strict: true, strictScheduling: true })).scheduling.messages[0].suggested.location, 'Blue Conference Room');
    // a parameter of a calendar user the message does not read is reported
    const member = /** @type {any} */ (parseIcal(fs.readFileSync(new URL('rfc5546-4.2.2-1.ics', FIXTURES), 'utf8')
      .replace('ATTENDEE;PARTSTAT=ACCEPTED:', 'ATTENDEE;PARTSTAT=ACCEPTED;MEMBER="mailto:team@example.com":')));
    assert.deepStrictEqual(codes(member.report.unsupported), ['ICAL1012 ATTENDEE;MEMBER']);
  });

  it('§4.2.9 has a semicolon for an ATTENDEE\'s colon, which stops the read (ICAL1003)', () => {
    assert.throws(() => read('rfc5546-4.2.9-1.ics'), { code: 'ICAL1003', line: 7 });
  });

  it('a REPLY is its attendee\'s PARTSTAT and request status, and no event of the calendar', () => {
    const [message] = read('rfc5546-4.2.2-1.ics').scheduling.messages;
    assert.deepStrictEqual(message, { component: 'event', uid: 'calsrv.example.com-873970198738777@example.com', dtstamp: Date.parse('1997-06-12T19:00:00Z'),
      sequence: 0, organizer: { address: A }, attendees: [{ address: 'mailto:b@example.com', partstat: 'accepted' }],
      requestStatus: [{ code: '2.0', description: 'Success' }] });
    assert.deepStrictEqual(read('rfc5546-4.5.2-1.ics').scheduling.messages[0].attendees, [{ address: 'mailto:b@example.com', partstat: 'accepted' }]);
  });

  it('a CANCEL is the series model\'s cancellation: of one instance by its RECURRENCE-ID, or of the whole event', () => {
    assert.deepStrictEqual(read('rfc5546-4.4.3-1.ics').scheduling.messages[0].cancellation, { recurrenceId: '1997-08-01T21:00:00Z', status: 'cancelled' });
    assert.deepStrictEqual(read('rfc5546-4.4.4-1.ics').scheduling.messages[0].cancellation, { status: 'cancelled' });
    assert.deepStrictEqual(read('rfc5546-4.1.3-1.ics').scheduling.messages[0].cancellation, { status: 'cancelled' });
  });

  it('a COUNTER is the event it suggests and an ADD the event it adds, reported to the host, never read as events of the calendar', () => {
    const counter = read('rfc5546-4.2.4-2.ics').scheduling.messages[0];
    assert.deepStrictEqual([counter.suggested.start, counter.suggested.end, counter.suggested.location],
      [utc('1997-07-01T16:00:00Z'), utc('1997-07-01T17:00:00Z'), 'Blue Conference Room']);
    const instance = read('rfc5546-4.4.9-1.ics').scheduling.messages[0];
    assert.deepStrictEqual([instance.recurrenceId, instance.suggested.start, instance.suggested.end],
      [utc('1997-07-15T21:00:00Z'), utc('1997-07-15T22:00:00Z'), utc('1997-07-15T23:00:00Z')]);
    const add = read('rfc5546-4.4.6-1.ics').scheduling.messages[0];
    assert.deepStrictEqual([add.sequence, add.event.start, add.event.end, add.event.summary],
      [4, utc('1997-07-15T21:00:00Z'), utc('1997-07-15T22:00:00Z'), 'IETF Calendaring Working Group Meeting']);
  });

  it('a REQUEST and a PUBLISH keep their events as calendar data, beside the message; a REPLY VFREEBUSY its periods', () => {
    const request = read('rfc5546-4.2.1-1.ics');
    assert.deepStrictEqual(request.scheduling.messages[0].attendees.map((/** @type {any} */ person) => [person.address, person.partstat ?? null, person.rsvp ?? null]),
      [[A, 'accepted', null], ['mailto:b@example.com', null, true], ['mailto:c@example.com', null, true], ['mailto:d@example.com', null, true],
        ['conf_big@example.com', null, false], ['mailto:e@example.com', null, false]]);
    const published = read('rfc5546-4.1.1-1.ics');
    assert.deepStrictEqual([published.calendar.components[0].start, published.scheduling.messages[0].organizer], [utc('1997-07-01T20:00:00Z'), { address: A }]);
    assert.deepStrictEqual(read('rfc5546-4.3.3-1.ics').calendar.components[0].periods.map((/** @type {any} */ p) => [p.start, p.end]),
      [[Date.parse('1997-07-01T09:00:00Z'), Date.parse('1997-07-01T10:00:00Z')], [Date.parse('1997-07-01T14:00:00Z'), Date.parse('1997-07-01T14:30:00Z')]]);
  });
});

describe('ical iTIP: the table report', () => {
  const cal = (/** @type {string} */ method, /** @type {string[]} */ lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', `METHOD:${method}`, ...lines,
    'END:VCALENDAR', ''].join('\r\n');
  const reply = ['BEGIN:VEVENT', 'UID:u', 'DTSTAMP:20260101T000000Z', `ORGANIZER:${A}`, 'END:VEVENT'];

  it('names what a method\'s table requires and lacks (ICAL1026) or excludes (ICAL1027), at calendar and component', () => {
    const { scheduling } = /** @type {any} */ (parseIcal(cal('REPLY', reply)));
    assert.deepStrictEqual(scheduling.report.map((/** @type {any} */ e) => [e.code, e.path]), [['ICAL1026', '/VCALENDAR/VEVENT[0]/ATTENDEE']]);
    // a property the table takes at most once, given twice
    const twice = /** @type {any} */ (parseIcal(cal('REPLY', [...reply.slice(0, -1), 'ATTENDEE:mailto:b@example.com', 'SUMMARY:a', 'SUMMARY:b', 'END:VEVENT'])));
    assert.deepStrictEqual(twice.scheduling.report.map((/** @type {any} */ e) => [e.code, e.name, e.line]), [['ICAL1027', 'SUMMARY', 11]]);
    const add = /** @type {any} */ (parseIcal(cal('ADD', ['BEGIN:VEVENT', 'UID:u', 'DTSTAMP:20260101T000000Z', `ORGANIZER:${A}`, 'SEQUENCE:1', 'SUMMARY:s',
      'DTSTART:20260302T090000Z', 'RRULE:FREQ=DAILY', 'END:VEVENT', 'BEGIN:VJOURNAL', 'UID:j', 'END:VJOURNAL'])));
    // ADD takes a VJOURNAL, by a table of its own, but not beside a VEVENT
    assert.deepStrictEqual(codes(add.scheduling.report), ['ICAL1027 RRULE', 'ICAL1026 DESCRIPTION', 'ICAL1026 DTSTAMP', 'ICAL1026 DTSTART',
      'ICAL1026 ORGANIZER', 'ICAL1026 SEQUENCE', 'ICAL1027 VJOURNAL', 'ICAL1027 VEVENT']);
    const two = /** @type {any} */ (parseIcal(cal('COUNTER', ['BEGIN:VEVENT', 'UID:u', 'DTSTAMP:20260101T000000Z', `ORGANIZER:${A}`, 'SEQUENCE:1', 'SUMMARY:s',
      'DTSTART:20260302T090000Z', 'END:VEVENT', 'BEGIN:VJOURNAL', 'UID:j', 'END:VJOURNAL', 'BEGIN:VEVENT', 'UID:v', 'DTSTAMP:20260101T000000Z', `ORGANIZER:${A}`,
      'SEQUENCE:1', 'SUMMARY:s', 'DTSTART:20260302T090000Z', 'END:VEVENT'])));
    assert.deepStrictEqual(codes(two.scheduling.report), ['ICAL1027 VJOURNAL', 'ICAL1027 VEVENT']);
    assert.match(two.scheduling.report[1].reason, /holds VEVENT exactly once \(RFC 5546 §3\), not 2 times/);
  });

  it('is its own: strict refuses no table entry, strictScheduling refuses the first', () => {
    assert.ok(parseIcal(cal('REPLY', reply), { strict: true }));
    assert.throws(() => parseIcal(cal('REPLY', reply), { strictScheduling: true }), { code: 'ICAL1026', docPath: '/VCALENDAR/VEVENT[0]/ATTENDEE' });
    // a calendar with no METHOD is no message: no scheduling member at all
    assert.strictEqual(/** @type {any} */ (parseIcal(cal('X', reply).replace('METHOD:X\r\n', ''))).scheduling, undefined);
  });

  it('reads a METHOD outside RFC 5546 as before: reported and left out', () => {
    const { calendar, report } = /** @type {any} */ (parseIcal(cal('X-PUSH', reply)));
    // and the VEVENT is read as an event, which lacks its DTSTART
    assert.deepStrictEqual([calendar.method, codes(report.unsupported)], [undefined, ['ICAL1011 METHOD', 'ICAL1011 ORGANIZER', 'ICAL1017 VEVENT']]);
  });
});

describe('ical iTIP: written and read back', () => {
  for (const file of ['rfc5546-4.2.2-1.ics', 'rfc5546-4.4.3-1.ics', 'rfc5546-4.4.4-1.ics', 'rfc5546-4.2.4-2.ics', 'rfc5546-4.4.9-1.ics',
    'rfc5546-4.4.6-1.ics', 'rfc5546-4.2.4-4.ics', 'rfc5546-4.3.3-1.ics', 'rfc5546-4.5.2-1.ics']) {
    it(`${file}: each message written as a METHOD message reads back to itself`, () => {
      const { calendar, scheduling } = read(file);
      const out = stringifyIcal({ prodId: 'p', method: calendar.method, components: scheduling.messages.map((/** @type {any} */ m) => ({ type: 'message', ...m })) });
      assert.match(out, new RegExp(`^BEGIN:VCALENDAR\\r\\nVERSION:2.0\\r\\nPRODID:p\\r\\nMETHOD:${calendar.method.toUpperCase()}\\r\\n`));
      const back = /** @type {any} */ (parseIcal(out, { strictScheduling: true }));
      assert.deepStrictEqual(back.scheduling.messages, scheduling.messages);
    });
  }

  it('refuses a message its method\'s table would not take (ICAL3021), and writes PUBLISH events as before', () => {
    assert.throws(() => stringifyIcal({ prodId: 'p', method: 'reply', components: [{ type: 'message', uid: 'u', dtstamp: 0, organizer: { address: A } }] }),
      { code: 'ICAL3021', docPath: '/components/0' });
    assert.throws(() => stringifyIcal({ prodId: 'p', method: 'request', components: [{ type: 'event', uid: 'e', dtstamp: 0, start: utc('2026-03-02T09:00:00Z') }] }),
      { code: 'ICAL3021' });
    assert.ok(stringifyIcal({ prodId: 'p', method: 'publish', components: [{ type: 'event', uid: 'e', dtstamp: 0, start: utc('2026-03-02T09:00:00Z') }] }));
    assert.throws(() => stringifyIcal({ prodId: 'p', method: 'x', components: [] }), { code: 'ICAL3002', docPath: '/method' });
    assert.throws(() => stringifyIcal({ prodId: 'p', components: [{ type: 'message', uid: 'u', attendees: [{ address: 'b@example' }] }] }),
      { code: 'ICAL3003', docPath: '/components/0/attendees/0/address' });
  });

  it('spells a calendar user\'s parameters, quoting what holds a colon', () => {
    const out = stringifyIcal({ prodId: 'p', method: 'reply', components: [{ type: 'message', uid: 'u', dtstamp: 0, organizer: { address: A, name: 'A: chair' },
      attendees: [{ address: 'mailto:b@example.com', partstat: 'delegated', delegatedTo: ['mailto:c@example.com'], rsvp: false }] }] });
    assert.ok(out.replaceAll('\r\n ', '').includes('ORGANIZER;CN="A: chair":mailto:a@example.com\r\n'
      + 'ATTENDEE;PARTSTAT=DELEGATED;RSVP=FALSE;DELEGATED-TO="mailto:c@example.com":mailto:b@example.com\r\n'), out);
    assert.deepStrictEqual(/** @type {any} */ (parseIcal(out)).scheduling.messages[0].attendees,
      [{ address: 'mailto:b@example.com', partstat: 'delegated', rsvp: false, delegatedTo: ['mailto:c@example.com'] }]);
  });
});
