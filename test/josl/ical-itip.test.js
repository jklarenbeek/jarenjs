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

import { createIcalReader, createIcalWriter, iterateIcal, parseIcal, stringifyIcal } from '@jarenjs/josl/ical';

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

describe('ical iTIP: the tables\' comments on values and the calendar\'s counts (RFC 5546 §3)', () => {
  const cal = (/** @type {string} */ method, /** @type {string[]} */ lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', `METHOD:${method}`, ...lines,
    'END:VCALENDAR', ''].join('\r\n');
  const component = (/** @type {string} */ name, /** @type {string[]} */ lines) => [`BEGIN:${name}`, ...lines, `END:${name}`];
  const head = (/** @type {string} */ uid = 'u') => [`UID:${uid}`, 'DTSTAMP:20260101T000000Z', `ORGANIZER:${A}`];
  const report = (/** @type {string} */ text) => /** @type {any} */ (parseIcal(text)).scheduling.report.map((/** @type {any} */ e) => `${e.code} ${e.name}`);
  const event = (/** @type {string[]} */ extra, uid = 'u') => component('VEVENT', [...head(uid), 'SEQUENCE:1', 'SUMMARY:s', 'DTSTART:20260302T090000Z', ...extra]);

  it('ADD: "SEQUENCE ... MUST be greater than 0" (§3.2.4, §3.4.4, §3.5.2)', () => {
    const add = (/** @type {string} */ name, /** @type {string[]} */ lines) => report(cal('ADD', component(name, [...head(), 'SUMMARY:s', 'DTSTART:20260302T090000Z', ...lines])));
    assert.deepStrictEqual(add('VEVENT', ['SEQUENCE:0']), ['ICAL1028 SEQUENCE']);
    assert.deepStrictEqual(add('VEVENT', ['SEQUENCE:2']), []);
    assert.deepStrictEqual(add('VTODO', ['SEQUENCE:0', 'PRIORITY:1']), ['ICAL1028 SEQUENCE']);
    assert.deepStrictEqual(add('VJOURNAL', ['SEQUENCE:0', 'DESCRIPTION:d']), ['ICAL1028 SEQUENCE']);
    assert.match(/** @type {any} */ (parseIcal(cal('ADD', event(['SEQUENCE:0']).filter((l) => l !== 'SEQUENCE:1')))).scheduling.report[0].reason,
      /holds SEQUENCE greater than 0 \(RFC 5546 §3\), not '0'/);
  });

  it('CANCEL: STATUS "MUST be set to CANCELLED" where it is given; left out it is no entry (§3.2.5, §3.4.5, §3.5.3)', () => {
    const cancel = (/** @type {string} */ name, /** @type {string[]} */ lines) => report(cal('CANCEL', component(name, [...head(), 'SEQUENCE:1', ...lines])));
    assert.deepStrictEqual(cancel('VEVENT', ['STATUS:CONFIRMED']), ['ICAL1028 STATUS']);
    assert.deepStrictEqual(cancel('VEVENT', ['STATUS:cancelled']), []);
    assert.deepStrictEqual(cancel('VEVENT', ['ATTENDEE:mailto:b@example.com']), []);
    assert.deepStrictEqual(cancel('VTODO', ['STATUS:NEEDS-ACTION']), ['ICAL1028 STATUS']);
    assert.deepStrictEqual(cancel('VJOURNAL', ['STATUS:FINAL']), ['ICAL1028 STATUS']);
    assert.deepStrictEqual(cancel('VJOURNAL', []), []);
  });

  it('COUNTER: a VEVENT\'s STATUS "must be one of CONFIRMED/TENATIVE/CANCELLED" (§3.2.7; TENATIVE is RFC 5545\'s TENTATIVE)', () => {
    assert.deepStrictEqual(report(cal('COUNTER', event(['STATUS:TENTATIVE']))), []);
    assert.deepStrictEqual(report(cal('COUNTER', event(['STATUS:NEEDS-ACTION']))), ['ICAL1028 STATUS']);
    // "MAY be one of TENTATIVE/CONFIRMED" (REQUEST, ADD, DECLINECOUNTER) is a MAY: no entry
    assert.deepStrictEqual(report(cal('REQUEST', event(['STATUS:CANCELLED', 'ATTENDEE:mailto:b@example.com']))), []);
  });

  it('REQUEST-STATUS: RFC 5545 §3.8.8.3\'s syntax, a class 1-5, and one class in a component and across them (§3.6)', () => {
    const reply = (/** @type {string[]} */ statuses, uid = 'u') => component('VEVENT', [...head(uid), 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:b@example.com',
      ...statuses.map((status) => `REQUEST-STATUS:${status}`)]);
    for (const status of ['2.0;Success', '2.0.1;ok;data', '3.14;Unsupported capability', '5.3;No scheduling support for user', '1.1;Sent'])
      assert.deepStrictEqual(report(cal('REPLY', reply([status]))), [], status);
    for (const status of ['2;Success', '6.1;Unknown class', '0.1;x', '2.0', 'Success', '2.0.1.1;deep'])
      assert.deepStrictEqual(report(cal('REPLY', reply([status]))), ['ICAL1028 REQUEST-STATUS'], status);
    // rule 1: "there cannot be a mixture of, e.g., 2.xx and 5.xx codes within a single component"
    assert.deepStrictEqual(report(cal('REPLY', reply(['2.0;Success', '5.1;Unavailable']))), ['ICAL1028 REQUEST-STATUS']);
    assert.deepStrictEqual(report(cal('REPLY', reply(['2.0;Success', '2.8;Ignored']))), []);
    // rule 2: a 5.xx (else a 3.xx) in one component, so every component with one; 2.xx and 4.xx mix
    const two = (/** @type {string} */ a, /** @type {string | undefined} */ b) => report(cal('REPLY', [...reply([a]), ...reply(b === undefined ? [] : [b])]));
    assert.deepStrictEqual(two('5.1;Unavailable', '2.0;Success'), ['ICAL1028 REQUEST-STATUS']);
    assert.deepStrictEqual(two('3.7;Invalid user', '2.0;Success'), ['ICAL1028 REQUEST-STATUS']);
    assert.deepStrictEqual(two('5.1;Unavailable', '5.3;No support'), []);
    assert.deepStrictEqual(two('5.1;Unavailable', undefined), []);
    assert.deepStrictEqual(two('2.0;Success', '4.0;Event conflict'), []);
  });

  it('"All components MUST have the same UID" where the table says so; PUBLISH and CANCEL of VTODOs do not', () => {
    assert.deepStrictEqual(report(cal('REQUEST', [...event(['ATTENDEE:mailto:b@example.com']), ...event(['ATTENDEE:mailto:b@example.com'], 'v')])), ['ICAL1028 UID']);
    assert.deepStrictEqual(report(cal('REQUEST', [...event(['ATTENDEE:mailto:b@example.com']), ...event(['ATTENDEE:mailto:b@example.com', 'RECURRENCE-ID:20260302T090000Z'])])), []);
    assert.deepStrictEqual(report(cal('CANCEL', [...component('VEVENT', [...head(), 'SEQUENCE:1']), ...component('VEVENT', [...head('v'), 'SEQUENCE:1'])])), ['ICAL1028 UID']);
    assert.deepStrictEqual(report(cal('PUBLISH', [...event([]), ...event([], 'v')])), []);
    assert.deepStrictEqual(report(cal('CANCEL', [...component('VTODO', [...head(), 'SEQUENCE:1']), ...component('VTODO', [...head('v'), 'SEQUENCE:1'])])), []);
  });

  it('DTEND or DUE beside DURATION (every VEVENT and VTODO table), and a VALARM\'s DURATION without REPEAT (§3.1.3)', () => {
    assert.deepStrictEqual(report(cal('CANCEL', component('VEVENT', [...head(), 'SEQUENCE:1', 'DTEND:20260302T100000Z', 'DURATION:PT1H']))), ['ICAL1027 DURATION']);
    assert.deepStrictEqual(report(cal('REPLY', component('VTODO', [...head(), 'ATTENDEE:mailto:b@example.com', 'DUE:20260302T100000Z', 'DURATION:PT1H']))),
      ['ICAL1027 DURATION']);
    const alarm = (/** @type {string[]} */ lines) => report(cal('REQUEST', event(['ATTENDEE:mailto:b@example.com', 'BEGIN:VALARM', 'ACTION:DISPLAY',
      'DESCRIPTION:d', 'TRIGGER:-PT5M', ...lines, 'END:VALARM'])));
    assert.deepStrictEqual(alarm(['DURATION:PT5M']), ['ICAL1026 REPEAT']);
    assert.deepStrictEqual(alarm(['REPEAT:2']), ['ICAL1026 DURATION']);
    assert.deepStrictEqual(alarm(['DURATION:PT5M', 'REPEAT:2']), []);
  });

  it('a VTIMEZONE for every TZID the message names, and §3.1.2\'s VTIMEZONE: local DTSTARTs, RDATE or RRULE', () => {
    const zoned = component('VEVENT', [...head(), 'SEQUENCE:1', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20260302T090000']);
    const zone = (/** @type {string[]} */ onset) => component('VTIMEZONE', ['TZID:Europe/Amsterdam', ...component('STANDARD', ['TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0100', ...onset])]);
    assert.deepStrictEqual(report(cal('CANCEL', zoned)), ['ICAL1026 VTIMEZONE']);
    assert.deepStrictEqual(report(cal('CANCEL', [...zone(['DTSTART:19700101T000000']), ...zoned])), []);
    assert.deepStrictEqual(report(cal('CANCEL', [...zone(['DTSTART:19700101T000000Z']), ...zoned])), ['ICAL1028 DTSTART']);
    assert.deepStrictEqual(report(cal('CANCEL', [...zone(['DTSTART:19700101T000000', 'RRULE:FREQ=YEARLY', 'RDATE:19710101T000000']), ...zoned])),
      ['ICAL1027 RRULE']);
    assert.deepStrictEqual(report(cal('CANCEL', [...component('VTIMEZONE', ['TZID:Europe/Amsterdam']), ...zoned])), ['ICAL1026 STANDARD']);
  });

  it('a VFREEBUSY\'s "DateTime values must be in UTC" is the read\'s own rule already (ICAL1018)', () => {
    const { report: own } = /** @type {any} */ (parseIcal(cal('REQUEST', component('VFREEBUSY', [...head(), 'ATTENDEE:mailto:b@example.com',
      'DTSTART;TZID=Europe/Amsterdam:20260302T000000', 'DTEND:20260303T000000Z']))));
    assert.deepStrictEqual(codes(own.unsupported), ['ICAL1018 DTSTART']);
  });

  it('the hand-written violating cases (fixtures/ical-itip/violating-*.ics) answer the entries their broken rows give', () => {
    for (const [file, entries] of /** @type {[string, string[]][]} */ ([
      ['violating-add.ics', ['ICAL1028 SEQUENCE', 'ICAL1027 VEVENT']],
      ['violating-cancel.ics', ['ICAL1028 STATUS', 'ICAL1027 DURATION', 'ICAL1028 UID']],
      ['violating-reply.ics', ['ICAL1028 REQUEST-STATUS', 'ICAL1028 REQUEST-STATUS']],
      ['violating-late-method.ics', []],
    ]))
      assert.deepStrictEqual(codes(read(file).scheduling.report), entries, file);
    const late = read('violating-late-method.ics');
    assert.deepStrictEqual([codes(late.report.unsupported), late.calendar.components.length, late.scheduling.messages.length], [['ICAL1029 METHOD'], 0, 2]);
    assert.throws(() => read('violating-add.ics', { strictScheduling: true }), { code: 'ICAL1028', line: 9 });
  });

  it('the writer checks the calendar\'s counts and its comments on values (ICAL3021)', () => {
    const message = (/** @type {Record<string, any>} */ extra) => ({ type: 'message', uid: 'u', dtstamp: 0, organizer: { address: A },
      attendees: [{ address: 'mailto:b@example.com', partstat: 'accepted' }], ...extra });
    // ADD's one VEVENT: the second is refused where it is written
    const added = { type: 'message', uid: 'u', dtstamp: 0, sequence: 1, organizer: { address: A },
      event: { type: 'event', uid: 'u', dtstamp: 0, sequence: 1, summary: 's', start: utc('2026-03-02T09:00:00Z') } };
    assert.ok(stringifyIcal({ prodId: 'p', method: 'add', components: [added] }));
    assert.throws(() => stringifyIcal({ prodId: 'p', method: 'add', components: [added, added] }), (/** @type {any} */ error) =>
      error.code === 'ICAL3021' && error.docPath === '/components/1' && /holds VEVENT exactly once/.test(error.message));
    assert.throws(() => stringifyIcal({ prodId: 'p', method: 'reply', components: [message({}), message({ uid: 'v' })] }),
      { code: 'ICAL3021', docPath: '/components/1' });
    assert.throws(() => stringifyIcal({ prodId: 'p', method: 'reply', components: [message({ requestStatus: [{ code: '6.0', description: 'x' }] })] }),
      { code: 'ICAL3021', docPath: '/components/0' });
    assert.throws(() => stringifyIcal({ prodId: 'p', method: 'reply', components: [message({ requestStatus: [{ code: '5.1', description: 'x' }] }),
      message({ requestStatus: [{ code: '2.0', description: 'Success' }] })] }), { code: 'ICAL3021', docPath: '/components/1' });
    // the streaming writer refuses where the calendar stops being a message, and is closed after
    const writer = createIcalWriter({ prodId: 'p', method: 'reply' });
    writer.write(message({}));
    assert.throws(() => writer.write(message({ uid: 'v' })), { code: 'ICAL3021' });
    assert.throws(() => writer.end(), { code: 'ICAL3018' });
  });
});

describe('ical iTIP: a METHOD after the first component (RFC 5545 §3.6 places it before them)', () => {
  const late = (/** @type {string} */ method, /** @type {string[]} */ before, /** @type {string[]} */ after) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p',
    ...before, `METHOD:${method}`, ...after, 'END:VCALENDAR', ''].join('\r\n');
  const early = (/** @type {string} */ text) => text.replace(/(METHOD:[A-Z]+\r\n)/, '').replace('PRODID:p\r\n', `PRODID:p\r\n${/METHOD:[A-Z]+\r\n/.exec(text)?.[0]}`);
  const request = (/** @type {string} */ uid, /** @type {string[]} */ extra = []) => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', `ORGANIZER:${A}`,
    'ATTENDEE:mailto:b@example.com', 'SUMMARY:s', 'DTSTART:20260302T090000Z', ...extra, 'END:VEVENT'];
  const cancel = (/** @type {string} */ id) => ['BEGIN:VEVENT', 'UID:u', 'DTSTAMP:20260101T000000Z', `ORGANIZER:${A}`, 'SEQUENCE:2', `RECURRENCE-ID:${id}`, 'END:VEVENT'];
  /** a read without its ICAL1029 entry @param {any} read */
  const without = (read) => {
    const { ICAL1029: _late, ...counts } = read.report.counts;
    return { ...read, report: { ...read.report, counts, unsupported: read.report.unsupported.filter((/** @type {any} */ e) => e.code !== 'ICAL1029') } };
  };
  const stream = async (/** @type {string} */ text, /** @type {any} */ options = {}) => {
    const items = [];
    for await (const item of iterateIcal([text.slice(0, 120), text.slice(120)], options))
      items.push(item);
    return items;
  };

  it('parseIcal reports it (ICAL1029) and applies it to the whole calendar, as if it were in its place', () => {
    for (const text of [late('REQUEST', request('u'), request('u', ['RECURRENCE-ID:20260302T090000Z'])), late('CANCEL', cancel('20260302T090000Z'), cancel('20260303T090000Z')),
      late('REQUEST', request('u', ['RRULE:FREQ=DAILY;COUNT=3']), request('u', ['RECURRENCE-ID:20260303T090000Z', 'SUMMARY:moved']).filter((l) => l !== 'SUMMARY:s'))]) {
      const read = /** @type {any} */ (parseIcal(text));
      assert.deepStrictEqual(read.report.unsupported.filter((/** @type {any} */ e) => e.code === 'ICAL1029').map((/** @type {any} */ e) => [e.name, e.line]),
        [['METHOD', text.split('\r\n').indexOf(/METHOD:[A-Z]+/.exec(text)?.[0] ?? '') + 1]]);
      assert.match(read.report.unsupported.find((/** @type {any} */ e) => e.code === 'ICAL1029').reason, /follows 1 component, .*applied to the whole calendar/);
      // the same answer as with the METHOD in its place, lines aside
      const placed = /** @type {any} */ (parseIcal(early(text)));
      const plain = (/** @type {any} */ r) => [r.calendar, r.scheduling.messages, codes(r.scheduling.report), codes(r.report.unsupported), r.report.counts];
      assert.deepStrictEqual(plain(without(read)), plain(placed));
      // strict refuses the calendar at the first entry it meets: here an ORGANIZER the read before the METHOD leaves out (ICAL1011)
      assert.throws(() => parseIcal(text, { strict: true }), { code: 'ICAL1011' });
    }
    // a CANCEL's messages are no events of the calendar, the one before the METHOD too
    const cancelled = /** @type {any} */ (parseIcal(late('CANCEL', cancel('20260302T090000Z'), cancel('20260303T090000Z'))));
    assert.deepStrictEqual([cancelled.calendar.components.length, cancelled.scheduling.messages.map((/** @type {any} */ m) => m.cancellation.recurrenceId)],
      [0, ['2026-03-02T09:00:00Z', '2026-03-03T09:00:00Z']]);
  });

  it('a streaming read applies a data method to what follows and says what it could not; it refuses a method whose components are messages', async () => {
    const text = late('REQUEST', request('u'), request('v'));
    const reader = createIcalReader();
    const first = reader.feed(text);
    const end = /** @type {any} */ (reader.end());
    assert.deepStrictEqual([[...first, ...end.calendar.components].map((c) => c.uid), end.scheduling.messages.map((/** @type {any} */ m) => m.uid)], [['u', 'v'], ['v']]);
    assert.match(end.report.unsupported.find((/** @type {any} */ e) => e.code === 'ICAL1029').reason, /without their scheduling messages/);
    // the component before it went unchecked, as the entry says: two UIDs, and no ICAL1028 (parseIcal has it)
    assert.deepStrictEqual([codes(end.scheduling.report), codes(/** @type {any} */ (parseIcal(text)).scheduling.report)], [[], ['ICAL1028 UID']]);
    const items = await stream(text);
    assert.deepStrictEqual(items.at(-1).scheduling.messages.map((/** @type {any} */ m) => m.uid), ['v']);
    const refused = late('CANCEL', cancel('20260302T090000Z'), cancel('20260303T090000Z'));
    assert.throws(() => createIcalReader().feed(refused), { code: 'ICAL1008', docPath: '/VCALENDAR/METHOD' });
    await assert.rejects(() => stream(refused), { code: 'ICAL1008' });
    const plain = late('REQUEST', request('u').filter((line) => !/^(ORGANIZER|ATTENDEE)/.test(line)), request('v'));
    assert.throws(() => createIcalReader({ strict: true }).feed(plain), { code: 'ICAL1029' });
    await assert.rejects(() => stream(plain, { strict: true }), { code: 'ICAL1029' });
    assert.throws(() => parseIcal(plain, { strict: true }), { code: 'ICAL1029' });
    // a METHOD after a VTIMEZONE only is late too, and the VTIMEZONE still defines its TZID; one at the head is not late
    assert.ok(!codes(/** @type {any} */ (parseIcal(early(text))).report.unsupported).includes('ICAL1029 METHOD'));
    const zone = ['BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100',
      'END:STANDARD', 'END:VTIMEZONE'];
    const zoned = late('REQUEST', zone, request('u').map((line) => (line.startsWith('DTSTART') ? 'DTSTART;TZID=Europe/Amsterdam:20260302T090000' : line)));
    const parsed = /** @type {any} */ (parseIcal(zoned, { strictScheduling: true }));
    assert.deepStrictEqual([codes(parsed.report.unsupported), codes(parsed.scheduling.report), parsed.scheduling.messages.length],
      [['ICAL1029 METHOD', 'ICAL1011 ORGANIZER', 'ICAL1011 ATTENDEE'], [], 1]);
    const streamed = createIcalReader({ strictScheduling: true });
    streamed.feed(zoned);
    assert.deepStrictEqual(codes(/** @type {any} */ (streamed.end()).scheduling.report), []);
    assert.deepStrictEqual(codes((await stream(zoned, { strictScheduling: true })).at(-1).scheduling.report), []);
  });
});
