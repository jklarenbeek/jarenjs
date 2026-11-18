//@ts-check

/**
 * The iCalendar writer: each temporal kind written and read back by the
 * test's own reader, zoned values against the calendar layer's `toUtc`,
 * TEXT escaping, the documented subset (anything else refused by code),
 * the options, the incremental writer's parity with `stringifyIcal`, the
 * limits (never a truncated calendar) and free/busy spans - every
 * emitted line held to RFC 5545's ABNF.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { stringifyIcal, createIcalWriter, IcalWriter, IcalError, ICAL_CODES, ICAL_LIMIT_CODES, JoslLimitError } from '@jarenjs/josl/ical';
import { toUtc, CALENDAR_CODES } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { readIcal, physicalLines, unfold, splitLine, unescapeText, prop, props, timeOf, durationOf } from './ical-reader.js';
import { checkGrammar } from './ical-grammar.js';

const provider = createIntlZoneProvider({ revision: 'test' });
const NOW = Date.parse('2026-01-15T10:20:30Z');
const runtime = { now: () => NOW + 456 };
const BS = String.fromCharCode(92);

/** @param {string} date @param {string} time @param {string} [zone] */
const zoned = (date, time, zone = 'Europe/Amsterdam') => ({ kind: 'zoned', date, time, zone });
/** @param {string} date @param {string} time */
const floating = (date, time) => ({ kind: 'floating', date, time });
/** @param {string} instant */
const utc = (instant) => ({ kind: 'utc', instant });
/** @param {string} date */
const date = (date) => ({ kind: 'date', date });

/**
 * Write one calendar and read it back, every line held to the grammar.
 * @param {any[]} components
 * @param {any} [options]
 */
function roundTrip(components, options = {}) {
  const text = stringifyIcal({ prodId: '-//Example//Test//EN', components }, { runtime, ...options });
  for (const line of unfold(physicalLines(text)))
    checkGrammar(splitLine(line));
  return { text, calendar: readIcal(text) };
}

/** The first component read back. @param {any[]} components @param {any} [options] */
const first = (components, options) => roundTrip(components, options).calendar.children[0];

/**
 * Assert a call is refused with an IcalError of this code and pointer.
 * @param {() => unknown} fn @param {string} code @param {string} [docPath]
 * @returns {any} the error
 */
function refuses(fn, code, docPath = undefined) {
  let caught;
  assert.throws(fn, (/** @type {any} */ error) => {
    caught = error;
    assert.ok(error instanceof IcalError, String(error));
    assert.strictEqual(error.code, code, error.message);
    assert.ok(Object.hasOwn(ICAL_CODES, code));
    if (docPath !== undefined)
      assert.strictEqual(error.docPath, docPath, error.message);
    return true;
  });
  return caught;
}

const event = (/** @type {any} */ extra) => ({ type: 'event', uid: 'e1', ...extra });

describe('ical: the calendar head and a minimal event', () => {
  it('writes VERSION, PRODID, a VEVENT with UID and DTSTAMP from the runtime clock, CRLF throughout', () => {
    const { text, calendar } = roundTrip([event({ start: utc('2026-03-02T08:00:00Z') })]);
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//Test//EN\r\n'));
    assert.ok(text.endsWith('END:VCALENDAR\r\n'));
    assert.strictEqual(text.replaceAll('\r\n', '').includes('\n'), false);
    assert.strictEqual(prop(calendar, 'METHOD'), undefined);
    const vevent = calendar.children[0];
    assert.strictEqual(vevent.name, 'VEVENT');
    assert.strictEqual(prop(vevent, 'UID')?.value, 'e1');
    // the clock is floored to the second; iCalendar has no fraction
    assert.strictEqual(prop(vevent, 'DTSTAMP')?.value, '20260115T102030Z');
  });

  it('writes METHOD:PUBLISH and refuses a method outside RFC 5546\'s eight by name', () => {
    const text = stringifyIcal({ prodId: 'p', method: 'publish', components: [] }, { runtime });
    assert.strictEqual(text, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\nMETHOD:PUBLISH\r\nEND:VCALENDAR\r\n');
    for (const method of ['x-push', 'PUBLISH', 'Cancel', 1])
      refuses(() => stringifyIcal({ prodId: 'p', method, components: [] }), 'ICAL3002', '/method');
  });

  it('takes the DTSTAMP a component gives, as a utc value or epoch milliseconds', () => {
    const a = first([event({ start: date('2026-03-02'), dtstamp: utc('2025-12-31T23:59:59Z') })]);
    const b = first([event({ start: date('2026-03-02'), dtstamp: 0 })]);
    assert.strictEqual(prop(a, 'DTSTAMP')?.value, '20251231T235959Z');
    assert.strictEqual(prop(b, 'DTSTAMP')?.value, '19700101T000000Z');
    refuses(() => roundTrip([event({ start: date('2026-03-02'), dtstamp: 1500 })]), 'ICAL3006', '/components/0/dtstamp');
    refuses(() => roundTrip([event({ start: date('2026-03-02'), dtstamp: floating('2026-01-01', '00:00') })]), 'ICAL3017', '/components/0/dtstamp');
    refuses(() => roundTrip([event({ start: date('2026-03-02'), dtstamp: 1.5e20 })]), 'ICAL3003', '/components/0/dtstamp');
  });

  it('reads the runtime clock once per writer and refuses a clock that answers no instant', () => {
    let calls = 0;
    const counting = { now: () => { calls++; return NOW; } };
    stringifyIcal({ prodId: 'p', components: [event({ start: date('2026-03-02') }), event({ uid: 'e2', start: date('2026-03-03') })] },
      { runtime: counting });
    assert.strictEqual(calls, 1);
    assert.throws(() => stringifyIcal({ prodId: 'p', components: [event({ start: date('2026-03-02') })] },
      { runtime: { now: () => Number.NaN } }), /runtime\.now\(\) answered NaN/);
  });
});

describe('ical: times by kind', () => {
  it('utc is written with Z, date with VALUE=DATE, floating with no zone', () => {
    const vu = first([event({ start: utc('2026-03-02T08:00:00Z'), end: utc('2026-03-02T16:30:00Z') })]);
    assert.deepStrictEqual([prop(vu, 'DTSTART'), prop(vu, 'DTEND')].map((p) => [p?.params, timeOf(p?.value ?? '')]),
      [[{}, { kind: 'utc', at: Date.parse('2026-03-02T08:00:00Z') }], [{}, { kind: 'utc', at: Date.parse('2026-03-02T16:30:00Z') }]]);
    const vd = first([event({ start: date('2026-12-24'), end: date('2026-12-27') })]);
    assert.deepStrictEqual(prop(vd, 'DTSTART'), { name: 'DTSTART', params: { VALUE: 'DATE' }, value: '20261224' });
    assert.deepStrictEqual(prop(vd, 'DTEND'), { name: 'DTEND', params: { VALUE: 'DATE' }, value: '20261227' });
    const vf = first([event({ start: floating('2026-03-02', '09:00'), end: floating('2026-03-02', '17:30:15') })]);
    assert.deepStrictEqual([prop(vf, 'DTSTART')?.value, prop(vf, 'DTEND')?.value], ['20260302T090000', '20260302T173015']);
    assert.strictEqual(timeOf(prop(vf, 'DTSTART')?.value ?? '').kind, 'floating');
    for (const vevent of [vu, vd, vf])
      assert.ok(vevent.props.every((p) => p.params.TZID === undefined));
  });

  it('a floating 24:00 end is the next midnight; a date range is DTSTART and an exclusive DTEND', () => {
    const vf = first([event({ start: floating('2026-03-02', '22:00'), end: floating('2026-03-02', '24:00') })]);
    assert.strictEqual(prop(vf, 'DTEND')?.value, '20260303T000000');
    const vr = first([event({ start: { kind: 'date-range', start: '2026-07-01', end: '2026-07-15' } })]);
    assert.deepStrictEqual([prop(vr, 'DTSTART')?.value, prop(vr, 'DTEND')?.value], ['20260701', '20260715']);
    refuses(() => roundTrip([event({ start: { kind: 'date-range', start: '2026-07-01', end: '2026-07-15' }, end: date('2026-07-20') })]),
      'ICAL3007', '/components/0/end');
    refuses(() => roundTrip([event({ start: date('2026-07-01'), end: { kind: 'date-range', start: '2026-07-01', end: '2026-07-15' } })]),
      'ICAL3007', '/components/0/end');
  });

  it('zoned under zones: utc is the instant toUtc answers, under each policy, with no TZID', () => {
    const cases = [
      [zoned('2026-03-02', '09:00'), 'rfc5545'],
      [zoned('2026-03-29', '02:30'), 'rfc5545'], // a gap: moved forward
      [zoned('2026-10-25', '02:30'), 'rfc5545'], // a fold: the earlier instant
      [zoned('2026-10-25', '02:30'), 'later'],
      [zoned('2026-11-01', '01:30', 'America/New_York'), 'later'],
      [zoned('2026-07-01', '12:00', 'Asia/Kolkata'), 'reject'],
    ];
    for (const [value, policy] of cases) {
      const vevent = first([event({ start: value, policy })], { zones: 'utc', provider });
      const want = toUtc(/** @type {any} */ (value), { provider, policy: /** @type {any} */ (policy) }).instant;
      assert.deepStrictEqual(timeOf(prop(vevent, 'DTSTART')?.value ?? ''), { kind: 'utc', at: want });
      assert.ok(vevent.props.every((p) => p.params.TZID === undefined));
    }
  });

  it('a zoned end resolves under the same policy, and a utc end may close a zoned start', () => {
    const vevent = first([event({ start: zoned('2026-03-28', '22:00'), end: zoned('2026-03-29', '24:00'), policy: 'rfc5545' })],
      { zones: 'utc', provider });
    assert.deepStrictEqual([prop(vevent, 'DTSTART')?.value, prop(vevent, 'DTEND')?.value], ['20260328T210000Z', '20260329T220000Z']);
    const mixed = first([event({ start: zoned('2026-03-02', '09:00'), end: utc('2026-03-02T10:00:00Z'), policy: 'later' })],
      { zones: 'utc', provider });
    assert.strictEqual(prop(mixed, 'DTEND')?.value, '20260302T100000Z');
  });

  it('a zoned value needs the zones mode, a provider and, for a single event, a policy', () => {
    const start = zoned('2026-03-02', '09:00');
    refuses(() => roundTrip([event({ start, policy: 'rfc5545' })], { provider }), 'ICAL3008', '/components/0/start');
    refuses(() => roundTrip([event({ start, policy: 'rfc5545' })], { zones: 'utc' }), 'ICAL3009', '/components/0/start');
    refuses(() => roundTrip([event({ start })], { zones: 'utc', provider }), 'ICAL3010', '/components/0/start');
    refuses(() => roundTrip([event({ start, policy: 'earliest' })], { zones: 'utc', provider }), 'ICAL3003', '/components/0/policy');
    // the runtime's provider serves when the options name none
    const vevent = first([event({ start, policy: 'rfc5545' })], { zones: 'utc', runtime: { now: () => NOW, zoneProvider: provider } });
    assert.strictEqual(prop(vevent, 'DTSTART')?.value, '20260302T080000Z');
  });

  it('a gap or fold under reject is the calendar layer\'s refusal, carried as the cause', () => {
    for (const [time, code] of [['02:30', 'JY0002']]) {
      const error = refuses(() => roundTrip([event({ start: zoned('2026-03-29', time), policy: 'reject' })], { zones: 'utc', provider }),
        'ICAL3005', '/components/0/start');
      assert.strictEqual(error.cause.code, code);
      assert.ok(Object.hasOwn(CALENDAR_CODES, error.cause.code));
    }
    const fold = refuses(() => roundTrip([event({ start: zoned('2026-10-25', '02:30'), policy: 'reject' })], { zones: 'utc', provider }), 'ICAL3005');
    assert.strictEqual(fold.cause.code, 'JY0003');
    const unknown = refuses(() => roundTrip([event({ start: zoned('2026-10-25', '02:30', 'Mars/Olympus'), policy: 'later' })],
      { zones: 'utc', provider }), 'ICAL3005');
    assert.strictEqual(unknown.cause.code, 'JY0001');
  });

  it('a fraction of a second is refused, never truncated; a zero fraction is a whole second', () => {
    refuses(() => roundTrip([event({ start: floating('2026-03-02', '09:00:00.5') })]), 'ICAL3006', '/components/0/start');
    refuses(() => roundTrip([event({ start: utc('2026-03-02T09:00:00.001Z') })]), 'ICAL3006', '/components/0/start');
    refuses(() => roundTrip([event({ start: zoned('2026-03-02', '09:00:00.250'), policy: 'later' })], { zones: 'utc', provider }),
      'ICAL3006', '/components/0/start');
    refuses(() => roundTrip([event({ start: utc('2026-03-02T09:00:00Z'), end: utc('2026-03-02T10:00:00.5Z') })]), 'ICAL3006', '/components/0/end');
    const vevent = first([event({ start: floating('2026-03-02', '09:00:00.000'), end: utc('2026-03-02T10:00:00.000Z').kind === 'utc' ? floating('2026-03-02', '10:00:00.00') : undefined })]);
    assert.deepStrictEqual([prop(vevent, 'DTSTART')?.value, prop(vevent, 'DTEND')?.value], ['20260302T090000', '20260302T100000']);
  });

  it('an end is after its start and of its kind, and never comes with a duration', () => {
    refuses(() => roundTrip([event({ start: floating('2026-03-02', '09:00'), end: floating('2026-03-02', '09:00') })]), 'ICAL3007', '/components/0/end');
    refuses(() => roundTrip([event({ start: date('2026-03-02'), end: date('2026-03-01') })]), 'ICAL3007', '/components/0/end');
    refuses(() => roundTrip([event({ start: floating('2026-03-02', '09:00'), end: utc('2026-03-02T10:00:00Z') })]), 'ICAL3007', '/components/0/end');
    refuses(() => roundTrip([event({ start: date('2026-03-02'), end: floating('2026-03-03', '00:00') })]), 'ICAL3007', '/components/0/end');
    refuses(() => roundTrip([event({ start: date('2026-03-02'), end: date('2026-03-03'), duration: 'P1D' })]), 'ICAL3007', '/components/0/duration');
  });

  it('a malformed temporal value is the calendar layer\'s refusal, pointed at the member', () => {
    const error = refuses(() => roundTrip([event({ start: date('2026-02-30') })]), 'ICAL3005', '/components/0/start');
    assert.strictEqual(error.cause.code, 'JY0012');
    refuses(() => roundTrip([event({ start: floating('2026-03-02', '24:00') })]), 'ICAL3005', '/components/0/start');
  });
});

describe('ical: durations', () => {
  it('writes the canonical spelling of the RFC 5545 grammar', () => {
    const cases = [['PT1H', 'PT1H'], ['PT1H5S', 'PT1H0M5S'], ['P1DT2H', 'P1DT2H'], ['P2W', 'P2W'], ['P14D', 'P2W'], ['PT0S', 'PT0S'],
      ['P0D', 'PT0S'], ['+PT90M', 'PT1H30M'], ['PT3600S', 'PT1H'], ['P1DT0H0M1S', 'P1DT1S'], ['PT45M', 'PT45M']];
    for (const [given, written] of cases) {
      const vevent = first([event({ start: utc('2026-03-02T08:00:00Z'), duration: given })]);
      assert.strictEqual(prop(vevent, 'DURATION')?.value, written, given);
      assert.deepStrictEqual(durationOf(written), durationOf(given.replace('+', '').replace('PT90M', 'PT1H30M').replace('PT3600S', 'PT1H')
        .replace('P14D', 'P2W').replace('P0D', 'PT0S').replace('PT1H5S', 'PT1H0M5S').replace('P1DT0H0M1S', 'P1DT1S')), given);
    }
    for (const bad of ['-PT1H', 'P1Y', 'PT', 'P', '1H', 3600])
      refuses(() => roundTrip([event({ start: utc('2026-03-02T08:00:00Z'), duration: bad })]), 'ICAL3003', '/components/0/duration');
  });

  it('a date start lasts whole days or weeks', () => {
    assert.strictEqual(prop(first([event({ start: date('2026-03-02'), duration: 'P3D' })]), 'DURATION')?.value, 'P3D');
    refuses(() => roundTrip([event({ start: date('2026-03-02'), duration: 'PT12H' })]), 'ICAL3003', '/components/0/duration');
  });

  it('a zoned start with nominal days ends at the same wall clock those days later in its zone', () => {
    // 2026-03-28 09:00 CET + P1DT1H = 2026-03-29 10:00 CEST: 24 hours of clock, 24 exact (23 + 1)
    const vevent = first([event({ start: zoned('2026-03-28', '09:00'), duration: 'P1DT1H', policy: 'rfc5545' })], { zones: 'utc', provider });
    assert.strictEqual(prop(vevent, 'DURATION'), undefined);
    assert.deepStrictEqual([prop(vevent, 'DTSTART')?.value, prop(vevent, 'DTEND')?.value], ['20260328T080000Z', '20260329T080000Z']);
    const exact = first([event({ start: zoned('2026-03-28', '09:00'), duration: 'PT25H', policy: 'rfc5545' })], { zones: 'utc', provider });
    assert.strictEqual(prop(exact, 'DURATION')?.value, 'PT25H');
  });
});

describe('ical: TEXT', () => {
  it('escapes backslash, semicolon, comma and every line break, and the reader gets the text back', () => {
    const text = `a;b,c${BS}d\r\ne\nf\rg: "quoted"\ttab ${BS}n not a newline`;
    const vevent = first([event({ start: date('2026-03-02'), summary: text, description: text, location: text })]);
    for (const name of ['SUMMARY', 'DESCRIPTION', 'LOCATION']) {
      const value = prop(vevent, name)?.value ?? '';
      assert.strictEqual(value, `a${BS};b${BS},c${BS}${BS}d${BS}ne${BS}nf${BS}ng: "quoted"\ttab ${BS}${BS}n not a newline`);
      assert.strictEqual(unescapeText(value), text.replace(/\r\n|\r/g, '\n'));
    }
  });

  it('escapes the UID and the product id as TEXT', () => {
    const { calendar } = roundTrip([event({ uid: 'a,b;c', start: date('2026-03-02') })]);
    assert.strictEqual(unescapeText(prop(calendar.children[0], 'UID')?.value ?? ''), 'a,b;c');
    const text = stringifyIcal({ prodId: '-//A, B//C;D//EN', components: [] });
    assert.strictEqual(unescapeText(prop(readIcal(text), 'PRODID')?.value ?? ''), '-//A, B//C;D//EN');
  });

  it('refuses a control character or a lone surrogate, never replacing it', () => {
    for (const bad of ['a\u0000b', 'bell\u0007', 'del\u007F', 'esc\u001B', 'lone \uD83D here', 'low \uDE00 first', 'end \uD83D']) {
      const error = refuses(() => roundTrip([event({ start: date('2026-03-02'), summary: bad })]), 'ICAL3004', '/components/0/summary');
      assert.match(error.message, /U\+/);
    }
    refuses(() => roundTrip([event({ uid: 'a\u0000b', start: date('2026-03-02') })]), 'ICAL3004', '/components/0/uid');
    refuses(() => stringifyIcal({ prodId: 'x\u0001', components: [] }), 'ICAL3004', '/prodId');
    refuses(() => roundTrip([event({ start: date('2026-03-02'), summary: 42 })]), 'ICAL3003', '/components/0/summary');
  });
});

describe('ical: the documented subset, and nothing else', () => {
  it('refuses a member, a component type or a calendar member outside it', () => {
    for (const member of ['attendee', 'organizer', 'xFoo', 'alarm', 'tzid', 'rrule'])
      refuses(() => roundTrip([event({ start: date('2026-03-02'), [member]: 'x' })]), 'ICAL3002', `/components/0/${member}`);
    for (const type of ['todo', 'journal', 'alarm', 'vavailability', 'EVENT'])
      refuses(() => roundTrip([{ type, uid: 'x' }]), 'ICAL3002', '/components/0/type');
    refuses(() => stringifyIcal({ prodId: 'p', components: [], timezones: [] }), 'ICAL3002', '/timezones');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', periods: [], organizer: 'x' }]), 'ICAL3002', '/components/0/organizer');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', periods: [{ start: 0, end: 1000, note: 'x' }] }]), 'ICAL3002', '/components/0/periods/0/note');
  });

  it('refuses a model missing what it requires', () => {
    refuses(() => stringifyIcal(/** @type {any} */ (null)), 'ICAL3001', '');
    refuses(() => stringifyIcal(/** @type {any} */ ([])), 'ICAL3001', '');
    refuses(() => stringifyIcal(/** @type {any} */ ({ components: [] })), 'ICAL3001', '/prodId');
    refuses(() => stringifyIcal(/** @type {any} */ ({ prodId: 'p' })), 'ICAL3001', '/components');
    refuses(() => roundTrip(['event']), 'ICAL3001', '/components/0');
    refuses(() => roundTrip([{ uid: 'x' }]), 'ICAL3001', '/components/0/type');
    refuses(() => roundTrip([{ type: 'event', start: date('2026-03-02') }]), 'ICAL3001', '/components/0/uid');
    refuses(() => roundTrip([{ type: 'event', uid: 'x' }]), 'ICAL3001', '/components/0/start');
    refuses(() => roundTrip([{ type: 'event', uid: '', start: date('2026-03-02') }]), 'ICAL3003', '/components/0/uid');
    refuses(() => stringifyIcal({ prodId: /** @type {any} */ (7), components: [] }), 'ICAL3003', '/prodId');
  });

  it('writes status and sequence, refusing values outside their sets', () => {
    const vevent = first([event({ start: date('2026-03-02'), status: 'tentative', sequence: 3 })]);
    assert.deepStrictEqual([prop(vevent, 'STATUS')?.value, prop(vevent, 'SEQUENCE')?.value], ['TENTATIVE', '3']);
    for (const status of ['TENTATIVE', 'needs-action', 'toString'])
      refuses(() => roundTrip([event({ start: date('2026-03-02'), status })]), 'ICAL3003', '/components/0/status');
    for (const sequence of [-1, 1.5, '2'])
      refuses(() => roundTrip([event({ start: date('2026-03-02'), sequence })]), 'ICAL3003', '/components/0/sequence');
  });
});

describe('ical: options', () => {
  it('refuses an unknown or mistyped option, naming the nearest one', () => {
    assert.throws(() => stringifyIcal({ prodId: 'p', components: [] }, /** @type {any} */ ({ zone: 'utc' })),
      { name: 'TypeError', message: "stringifyIcal: unknown option 'zone' — did you mean 'zones'?" });
    assert.throws(() => stringifyIcal({ prodId: 'p', components: [] }, /** @type {any} */ ({ zones: 'reference' })),
      { name: 'TypeError', message: "options.zones must be 'utc' or 'embed'" });
    assert.throws(() => stringifyIcal({ prodId: 'p', components: [] }, /** @type {any} */ ({ horizon: [0] })),
      { name: 'TypeError', message: 'options.horizon must be a [start, end) pair' });
    assert.throws(() => stringifyIcal({ prodId: 'p', components: [] }, /** @type {any} */ ({ limits: [] })),
      { name: 'TypeError', message: 'options.limits must be an object of recurrence limits' });
    assert.throws(() => stringifyIcal({ prodId: 'p', components: [] }, /** @type {any} */ ({ provider: 'intl' })),
      { name: 'TypeError', message: 'options.provider must be a zone provider' });
    assert.throws(() => stringifyIcal({ prodId: 'p', components: [] }, /** @type {any} */ ({ onChunk: () => {} })),
      { name: 'TypeError', message: "stringifyIcal: unknown option 'onChunk'; the options are zones, onsets, provider, runtime, horizon, limits, maxOctets, maxComponents, maxRdates" });
    for (const limit of ['maxOctets', 'maxComponents', 'maxRdates'])
      assert.throws(() => stringifyIcal({ prodId: 'p', components: [] }, { [limit]: 0 }), { name: 'TypeError', message: `options.${limit} must be a positive integer or Infinity` });
    assert.throws(() => createIcalWriter(/** @type {any} */ ({ prodId: 'p', onchunk: () => {} })), { name: 'TypeError', message: "createIcalWriter: unknown option 'onchunk' — did you mean 'onChunk'?" });
    assert.throws(() => stringifyIcal({ prodId: 'p', components: [] }, /** @type {any} */ ({ runtime: { clock: () => 0 } })), TypeError);
  });

  it('a null option keeps its default', () => {
    const text = stringifyIcal({ prodId: 'p', components: [] }, { zones: null, provider: null, horizon: null, limits: null, maxOctets: null, runtime: null });
    assert.strictEqual(text, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\nEND:VCALENDAR\r\n');
  });
});

describe('ical: the incremental writer', () => {
  const components = [
    event({ start: utc('2026-03-02T08:00:00Z'), duration: 'PT8H', summary: 'Early shift' }),
    event({ uid: 'e2', start: zoned('2026-03-02', '09:00'), end: zoned('2026-03-02', '17:00'), policy: 'rfc5545' }),
    { type: 'freebusy', uid: 'fb', periods: [{ start: Date.parse('2026-03-02T08:00:00Z'), end: Date.parse('2026-03-02T16:00:00Z') }] },
  ];
  const options = { zones: /** @type {const} */ ('utc'), provider, runtime };

  it('writes what stringifyIcal writes, a chunk per component', () => {
    const whole = stringifyIcal({ prodId: '-//Example//Test//EN', method: 'publish', components }, options);
    const writer = createIcalWriter({ prodId: '-//Example//Test//EN', method: 'publish', ...options });
    assert.ok(writer instanceof IcalWriter);
    writer.write(components[0]).writeAll(components.slice(1));
    assert.strictEqual(writer.end(), whole);
    /** @type {string[]} */
    const chunks = [];
    const sunk = createIcalWriter({ prodId: '-//Example//Test//EN', method: 'publish', ...options, onChunk: (chunk) => chunks.push(chunk) });
    assert.strictEqual(sunk.writeAll(components).end(), '');
    assert.strictEqual(sunk.toString(), '');
    assert.strictEqual(chunks.join(''), whole);
    assert.deepStrictEqual(chunks.map((chunk) => chunk.split('\r\n')[0]), ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'BEGIN:VEVENT', 'BEGIN:VFREEBUSY', 'END:VCALENDAR']);
  });

  it('gives a refused component the pointer stringifyIcal gives it, and then takes nothing more', () => {
    const bad = event({ uid: 'e3', start: date('2026-03-02'), summary: 'x\u0000' });
    refuses(() => stringifyIcal({ prodId: 'p', components: [...components, bad] }, options), 'ICAL3004', '/components/3/summary');
    const writer = createIcalWriter({ prodId: 'p', ...options });
    writer.writeAll(components);
    const before = writer.toString();
    refuses(() => writer.write(bad), 'ICAL3004', '/components/3/summary');
    assert.strictEqual(writer.toString(), before);
    refuses(() => writer.write(components[0]), 'ICAL3018', '/components/3');
    refuses(() => writer.end(), 'ICAL3018');
    assert.ok(!writer.toString().includes('END:VCALENDAR'));
    const ended = createIcalWriter({ prodId: 'p' });
    ended.end();
    refuses(() => ended.write(components[0]), 'ICAL3018', '/components/0');
    refuses(() => ended.end(), 'ICAL3018');
  });

  it('refuses a missing or malformed head at once', () => {
    refuses(() => createIcalWriter(/** @type {any} */ ({})), 'ICAL3001', '/options/prodId');
    refuses(() => createIcalWriter(/** @type {any} */ (undefined)), 'ICAL3001', '/options/prodId');
    refuses(() => createIcalWriter(/** @type {any} */ ({ prodId: 'p', method: 'x-push' })), 'ICAL3002', '/options/method');
  });
});

describe('ical: limits are checked before a component is emitted', () => {
  const components = Array.from({ length: 5 }, (_, i) => event({ uid: `e${i}`, start: date(`2026-03-0${i + 1}`), dtstamp: 0 }));
  const whole = stringifyIcal({ prodId: 'p', components });
  const octets = new TextEncoder().encode(whole).length;

  it('the tables are frozen and name their options', () => {
    assert.deepStrictEqual(Object.keys(ICAL_LIMIT_CODES), ['ICAL2001', 'ICAL2002', 'ICAL2003', 'ICAL2004', 'ICAL2005', 'ICAL2006', 'ICAL2007']);
    assert.ok(Object.isFrozen(ICAL_LIMIT_CODES) && Object.isFrozen(ICAL_CODES));
  });

  it('maxOctets admits a calendar of exactly that size and refuses one octet less, never truncated', () => {
    assert.strictEqual(stringifyIcal({ prodId: 'p', components }, { maxOctets: octets }), whole);
    assert.throws(() => stringifyIcal({ prodId: 'p', components }, { maxOctets: octets - 1 }), (/** @type {any} */ error) =>
      error instanceof JoslLimitError && error.code === 'ICAL2001' && error.limit === octets - 1
      && error.message === `ICAL2001: the calendar exceeds maxOctets (maxOctets ${octets - 1})`);
    assert.throws(() => stringifyIcal({ prodId: 'p', components }, { maxOctets: 10 }), { code: 'ICAL2001' });
  });

  it('with a sink, the chunks before a refusal are whole components and no END:VCALENDAR', () => {
    /** @type {string[]} */
    const chunks = [];
    const writer = createIcalWriter({ prodId: 'p', maxOctets: octets - 1, onChunk: (chunk) => chunks.push(chunk) });
    assert.throws(() => writer.writeAll(components), { code: 'ICAL2001' });
    assert.strictEqual(chunks.length, 5); // the head and four of the five events; the fifth would leave no room for the end
    assert.ok(chunks.every((chunk) => !chunk.includes('END:VCALENDAR')));
    assert.ok(chunks.slice(1).every((chunk) => chunk.startsWith('BEGIN:VEVENT\r\n') && chunk.endsWith('END:VEVENT\r\n')));
    refuses(() => writer.end(), 'ICAL3018');
  });

  it('maxComponents counts each override\'s VEVENT; maxRdates counts given and expanded extra dates', () => {
    const series = {
      uid: 's', base: { dtstart: floating('2026-03-02', '09:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=5' },
      rdates: [floating('2026-03-20', '09:00'), floating('2026-03-21', '09:00')],
      overrides: [{ recurrenceId: '2026-03-03T09:00:00', status: 'moved', start: floating('2026-03-03', '10:00') }],
    };
    const recurring = [{ type: 'event', series, dtstamp: 0 }];
    assert.doesNotThrow(() => stringifyIcal({ prodId: 'p', components: recurring }, { maxComponents: 2, maxRdates: 2 }));
    assert.throws(() => stringifyIcal({ prodId: 'p', components: recurring }, { maxComponents: 1 }), { code: 'ICAL2002', limit: 1 });
    assert.throws(() => stringifyIcal({ prodId: 'p', components: recurring }, { maxRdates: 1 }), { code: 'ICAL2003', limit: 1 });
    assert.throws(() => stringifyIcal({ prodId: 'p', components }, { maxComponents: 4 }), { code: 'ICAL2002' });
    const expanded = [{ type: 'event', series: { uid: 'z', base: { dtstart: zoned('2026-03-02', '09:00'), rrule: 'FREQ=DAILY;COUNT=10' } }, dtstamp: 0 }];
    const horizon = [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z')];
    assert.doesNotThrow(() => stringifyIcal({ prodId: 'p', components: expanded }, { zones: 'utc', provider, horizon, maxRdates: 9 }));
    assert.throws(() => stringifyIcal({ prodId: 'p', components: expanded }, { zones: 'utc', provider, horizon, maxRdates: 8 }), { code: 'ICAL2003' });
  });
});

describe('ical: free/busy', () => {
  it('writes UTC periods in ascending order with their types, and the component\'s range', () => {
    const at = (/** @type {string} */ t) => Date.parse(`2026-03-02T${t}:00Z`);
    const vfb = first([{
      type: 'freebusy', uid: 'fb', start: at('00:00'), end: utc('2026-03-03T00:00:00Z'), periods: [
        { start: at('13:00'), end: at('14:00'), fbtype: 'busy-tentative' },
        { start: utc('2026-03-02T09:00:00Z'), end: at('10:30') },
        { start: at('09:00'), end: at('09:30'), fbtype: 'free' },
        { start: at('16:00'), end: at('17:00'), fbtype: 'busy-unavailable' },
      ],
    }]);
    assert.strictEqual(vfb.name, 'VFREEBUSY');
    assert.deepStrictEqual([prop(vfb, 'DTSTART')?.value, prop(vfb, 'DTEND')?.value], ['20260302T000000Z', '20260303T000000Z']);
    assert.deepStrictEqual(props(vfb, 'FREEBUSY').map((p) => `${p.params.FBTYPE} ${p.value}`), [
      'FREE 20260302T090000Z/20260302T093000Z',
      'BUSY 20260302T090000Z/20260302T103000Z',
      'BUSY-TENTATIVE 20260302T130000Z/20260302T140000Z',
      'BUSY-UNAVAILABLE 20260302T160000Z/20260302T170000Z',
    ]);
    assert.ok(prop(vfb, 'UID') && prop(vfb, 'DTSTAMP'));
    assert.strictEqual(props(first([{ type: 'freebusy', uid: 'none', periods: [] }]), 'FREEBUSY').length, 0);
  });

  it('refuses a span that is not an instant, an end not after its start, and missing periods', () => {
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', periods: [{ start: floating('2026-03-02', '09:00'), end: 1000 }] }]), 'ICAL3017', '/components/0/periods/0/start');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', periods: [{ start: 0, end: zoned('2026-03-02', '09:00') }] }]), 'ICAL3017', '/components/0/periods/0/end');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', periods: [{ start: 2000, end: 1000 }] }]), 'ICAL3007', '/components/0/periods/0/end');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', start: 2000, end: 2000, periods: [] }]), 'ICAL3007', '/components/0/end');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f' }]), 'ICAL3001', '/components/0/periods');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', periods: {} }]), 'ICAL3003', '/components/0/periods');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', periods: [7] }]), 'ICAL3001', '/components/0/periods/0');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', periods: [{ start: 0 }] }]), 'ICAL3001', '/components/0/periods/0/end');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', periods: [{ start: 0, end: 1000, fbtype: 'BUSY' }] }]), 'ICAL3003', '/components/0/periods/0/fbtype');
    refuses(() => roundTrip([{ type: 'freebusy', uid: 'f', periods: [{ start: 0.5, end: 1000 }] }]), 'ICAL3003', '/components/0/periods/0/start');
    refuses(() => roundTrip([{ type: 'freebusy', periods: [] }]), 'ICAL3001', '/components/0/uid');
  });
});
