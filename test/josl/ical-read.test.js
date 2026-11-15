//@ts-check

/**
 * The iCalendar reader's mapping, canonical mode: each kind of time,
 * TZID resolution through the provider (never a guess), series with
 * their extra dates, excluded dates and overrides grouped by UID, free/
 * busy, and the report of everything outside the subset - with strict
 * mode refusing each entry by its own code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parseIcal, createIcalReader, iterateIcal, IcalReader, IcalError, ICAL_CODES } from '@jarenjs/josl/ical';
import { expandSeries, CalendarError } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider({ revision: 'test' });

/**
 * A calendar of the given lines inside the head.
 * @param {string[]} lines
 * @param {string[]} [head]
 */
const cal = (lines, head = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...head, ...lines, 'END:VCALENDAR', ''].join('\r\n');

/**
 * One VEVENT's lines.
 * @param {string[]} lines
 */
const vevent = (lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

/**
 * Read and return the components and report.
 * @param {string} text
 * @param {any} [options]
 */
function read(text, options = { provider }) {
  const { calendar, report } = parseIcal(text, options);
  return { components: calendar.components, report, calendar };
}

/**
 * The refusal of a strict read, by code.
 * @param {string} text
 * @param {string} code
 * @param {any} [options]
 */
function refusesStrict(text, code, options = { provider }) {
  assert.throws(() => parseIcal(text, { ...options, strict: true }), (/** @type {any} */ error) => {
    assert.ok(error instanceof IcalError, String(error));
    assert.strictEqual(error.code, code);
    assert.strictEqual(typeof error.line, 'number');
    return true;
  });
}

/** @param {any} report */
const codes = (report) => report.unsupported.map((/** @type {any} */ entry) => entry.code);

describe('ical reader: times by kind', () => {
  it('reads utc, date, floating and zoned starts, each to its kind', () => {
    const { components, report } = read(cal([
      ...vevent(['UID:u', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260302T080000Z', 'DURATION:PT1H']),
      ...vevent(['UID:d', 'DTSTART;VALUE=DATE:20261225']),
      ...vevent(['UID:f', 'DTSTART:20260302T090000', 'DTEND:20260302T170000']),
      ...vevent(['UID:z', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000', 'DTEND;TZID=Europe/Amsterdam:20260302T100000']),
    ]));
    assert.deepStrictEqual(report.unsupported, []);
    assert.deepStrictEqual(components, [
      { type: 'event', uid: 'u', dtstamp: Date.parse('2026-01-01T00:00:00Z'), start: { kind: 'utc', instant: '2026-03-02T08:00:00Z' }, duration: 'PT1H' },
      { type: 'event', uid: 'd', start: { kind: 'date', date: '2026-12-25' } },
      { type: 'event', uid: 'f', start: { kind: 'floating', date: '2026-03-02', time: '09:00:00' }, end: { kind: 'floating', date: '2026-03-02', time: '17:00:00' } },
      { type: 'event', uid: 'z', start: { kind: 'zoned', date: '2026-03-02', time: '09:00:00', zone: 'Europe/Amsterdam' },
        end: { kind: 'zoned', date: '2026-03-02', time: '10:00:00', zone: 'Europe/Amsterdam' }, policy: 'rfc5545' },
    ]);
  });

  it('reads DTSTART and DTEND of dates as a date range, and a date with a duration as such', () => {
    const { components } = read(cal([
      ...vevent(['UID:r', 'DTSTART;VALUE=DATE:20260701', 'DTEND;VALUE=DATE:20260715']),
      ...vevent(['UID:w', 'DTSTART;VALUE=DATE:20260701', 'DURATION:P2W']),
    ]));
    assert.deepStrictEqual(components.map((c) => [c.start, c.duration]), [
      [{ kind: 'date-range', start: '2026-07-01', end: '2026-07-15' }, undefined],
      [{ kind: 'date', date: '2026-07-01' }, 'P2W'],
    ]);
  });

  it('reads an end at the start as no end, which a time without one has', () => {
    const { components } = read(cal(vevent(['UID:z', 'DTSTART:20260302T090000Z', 'DTEND:20260302T090000Z'])));
    assert.deepStrictEqual(components, [{ type: 'event', uid: 'z', start: { kind: 'utc', instant: '2026-03-02T09:00:00Z' } }]);
  });

  for (const [title, lines, code] of /** @type {[string, string[], string][]} */ ([
    ['a DATE value without VALUE=DATE', ['UID:a', 'DTSTART:20260302'], 'ICAL1018'],
    ['a DATE-TIME under VALUE=DATE', ['UID:a', 'DTSTART;VALUE=DATE:20260302T090000'], 'ICAL1018'],
    ['an unknown VALUE', ['UID:a', 'DTSTART;VALUE=PERIOD:20260302T090000Z/PT1H'], 'ICAL1018'],
    ['a UTC time with a TZID', ['UID:a', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000Z'], 'ICAL1018'],
    ['a day the calendar does not have', ['UID:a', 'DTSTART:20260230T090000'], 'ICAL1018'],
    ['a leap second', ['UID:a', 'DTSTART:20261231T235960Z'], 'ICAL1018'],
    ['an end of another kind', ['UID:a', 'DTSTART:20260302T090000', 'DTEND:20260302T100000Z'], 'ICAL1018'],
    ['an end before the start', ['UID:a', 'DTSTART:20260302T090000Z', 'DTEND:20260302T080000Z'], 'ICAL1018'],
    ['a date range ending on its start', ['UID:a', 'DTSTART;VALUE=DATE:20260302', 'DTEND;VALUE=DATE:20260302'], 'ICAL1018'],
    ['a date with a duration of hours', ['UID:a', 'DTSTART;VALUE=DATE:20260302', 'DURATION:PT1H'], 'ICAL1018'],
    ['a malformed duration', ['UID:a', 'DTSTART:20260302T090000Z', 'DURATION:1H'], 'ICAL1018'],
    ['DTEND and DURATION both', ['UID:a', 'DTSTART:20260302T090000Z', 'DTEND:20260302T100000Z', 'DURATION:PT1H'], 'ICAL1017'],
    ['no DTSTART', ['UID:a', 'SUMMARY:x'], 'ICAL1017'],
    ['no UID', ['DTSTART:20260302T090000Z'], 'ICAL1017'],
    ['an empty UID', ['UID:', 'DTSTART:20260302T090000Z'], 'ICAL1018'],
    ['DTSTART twice', ['UID:a', 'DTSTART:20260302T090000Z', 'DTSTART:20260303T090000Z'], 'ICAL1017'],
    ['two values in DTSTART', ['UID:a', 'DTSTART:20260302T090000Z,20260303T090000Z'], 'ICAL1018'],
    ['a TZID given twice', ['UID:a', 'DTSTART;TZID=Europe/Amsterdam;TZID=Europe/Paris:20260302T090000'], 'ICAL1018'],
    ['a DTSTAMP in local time', ['UID:a', 'DTSTAMP:20260302T090000', 'DTSTART:20260302T090000Z'], 'ICAL1018'],
    ['an unknown STATUS', ['UID:a', 'DTSTART:20260302T090000Z', 'STATUS:NEEDS-ACTION'], 'ICAL1018'],
    ['a negative SEQUENCE', ['UID:a', 'DTSTART:20260302T090000Z', 'SEQUENCE:-1'], 'ICAL1018'],
    ['an escape TEXT does not define', ['UID:a', 'DTSTART:20260302T090000Z', 'SUMMARY:a\\:b'], 'ICAL1018'],
    ['EXDATE with no rule', ['UID:a', 'DTSTART:20260302T090000Z', 'EXDATE:20260302T090000Z'], 'ICAL1022'],
    ['EXRULE', ['UID:a', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=DAILY', 'EXRULE:FREQ=WEEKLY'], 'ICAL1022'],
  ])) {
    it(`withholds an event with ${title} (${code}), never guessing`, () => {
      const { components, report } = read(cal([...vevent(lines), ...vevent(['UID:ok', 'DTSTART:20260302T090000Z'])]));
      assert.deepStrictEqual(components.map((c) => c.uid), ['ok']);
      assert.deepStrictEqual(codes(report), [code]);
      const [entry] = report.unsupported;
      assert.strictEqual(entry.withheld, true);
      assert.ok(entry.path.startsWith('/VCALENDAR/VEVENT[0]'), entry.path);
      assert.ok(entry.line >= 4 && entry.line <= 4 + lines.length, String(entry.line));
      refusesStrict(cal(vevent(lines)), code);
    });
  }

  it('wraps a refusal of the calendar layer as the cause of a withheld value', () => {
    const { report } = read(cal(vevent(['UID:a', 'DTSTART:20260230T090000'])));
    assert.strictEqual(report.unsupported[0].cause?.code, 'JY0012');
    assert.throws(() => parseIcal(cal(vevent(['UID:a', 'DTSTART:20260230T090000'])), { strict: true }),
      (/** @type {any} */ error) => error.code === 'ICAL1018' && error.cause instanceof CalendarError && error.cause.code === 'JY0012');
  });
});

describe('ical reader: a TZID is a zone the provider knows, or it is reported', () => {
  const zonedEvent = (/** @type {string} */ tzid) => cal(vevent(['UID:z', `DTSTART;TZID=${tzid}:20260302T090000`]));

  it('reads an IANA name the provider knows, quoted or not', () => {
    for (const tzid of ['America/New_York', '"Europe/Amsterdam"', 'UTC', 'America/Argentina/Buenos_Aires']) {
      const { components, report } = read(zonedEvent(tzid));
      assert.deepStrictEqual(report.unsupported, [], tzid);
      assert.strictEqual(components[0].start.zone, tzid.replaceAll('"', ''));
    }
  });

  for (const [title, tzid] of [['a Windows name', '"W. Europe Standard Time"'], ['a prefixed name', '/mozilla.org/20050126_1/Europe/Amsterdam'],
    ['an offset', '"+01:00"'], ['an unknown name', 'Mars/Olympus_Mons'], ['a name a VTIMEZONE would define', 'Custom-Zone-1']]) {
    it(`withholds ${title} (ICAL1019), never guessing a zone`, () => {
      const { components, report } = read(zonedEvent(tzid));
      assert.deepStrictEqual(components, []);
      assert.deepStrictEqual(codes(report), ['ICAL1019']);
      assert.strictEqual(report.unsupported[0].path, '/VCALENDAR/VEVENT[0]/DTSTART');
      refusesStrict(zonedEvent(tzid), 'ICAL1019');
    });
  }

  it('withholds every TZID when no provider is given', () => {
    const { components, report } = read(zonedEvent('Europe/Amsterdam'), {});
    assert.deepStrictEqual([components.length, codes(report)], [0, ['ICAL1019']]);
    assert.match(report.unsupported[0].reason, /no(ne was given| provider)/);
  });

  it('compiles a VTIMEZONE, and resolves its TZID through the file\'s definition', () => {
    const { calendar: { components }, report, zones } = parseIcal(cal([
      'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE',
      ...vevent(['UID:z', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000']),
    ]), { provider });
    // the definition and the provider agree on the day the file uses
    assert.deepStrictEqual(report.unsupported, []);
    assert.strictEqual(components[0].start.zone, 'Europe/Amsterdam');
    assert.deepStrictEqual(Object.keys(zones.compiled), ['Europe/Amsterdam']);
    // the file's definition has no DAYLIGHT: in July it says +01:00, and it is what answers
    assert.strictEqual(zones.provider.toParts(Date.UTC(2026, 6, 1, 12), 'Europe/Amsterdam').offset, 60);
    assert.strictEqual(provider.toParts(Date.UTC(2026, 6, 1, 12), 'Europe/Amsterdam').offset, 120);
  });
});

describe('ical reader: series', () => {
  const horizonOf = (/** @type {string} */ kind) => (kind === 'date' ? [{ kind, date: '2026-01-01' }, { kind, date: '2028-01-01' }]
    : kind === 'floating' ? [{ kind, date: '2026-01-01', time: '00:00' }, { kind, date: '2028-01-01', time: '00:00' }]
      : [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2028-01-01T00:00:00Z')]);
  const kindOf = (/** @type {any} */ series) => (series.base?.dtstart ?? series.rdates[0].start ?? series.rdates[0]).kind;
  const expand = (/** @type {any} */ series) => expandSeries(series, { horizon: /** @type {any} */ (horizonOf(kindOf(series))), provider });
  const starts = (/** @type {any} */ series) => expand(series).occurrences.map((o) => o.instants?.start ?? `${o.start.date}T${o.start.time ?? ''}`);

  it('groups overrides into their series by UID, wherever they come, and keeps text per series', () => {
    const { components, report } = read(cal([
      ...vevent(['UID:s', 'RECURRENCE-ID:20260309T090000', 'DTSTART:20260310T090000', 'SUMMARY:Stand-up']),
      ...vevent(['UID:one', 'DTSTART:20260301T090000Z']),
      ...vevent(['UID:s', 'DTSTART:20260302T090000', 'DURATION:PT15M', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE:20260316T090000',
        'RDATE:20260304T090000,20260305T090000', 'RDATE;VALUE=PERIOD:20260306T090000/20260306T100000', 'SUMMARY:Stand-up']),
      ...vevent(['UID:s', 'RECURRENCE-ID:20260323T090000', 'DTSTART:20260323T090000', 'STATUS:CANCELLED', 'SUMMARY:Stand-up']),
    ]));
    assert.deepStrictEqual(report.unsupported, []);
    // single events as they complete, then every series in the order it began
    assert.deepStrictEqual(components.map((c) => c.uid ?? c.series.uid), ['one', 's']);
    const { series, summary } = components[1];
    assert.strictEqual(summary, 'Stand-up');
    assert.deepStrictEqual(series.overrides, [
      // no DTEND or DURATION: it lasts what such an event lasts, nothing (RFC 5545 §3.6.1)
      { recurrenceId: '2026-03-09T09:00:00', status: 'moved', start: { kind: 'floating', date: '2026-03-10', time: '09:00:00' },
        end: { kind: 'floating', date: '2026-03-10', time: '09:00:00' } },
      { recurrenceId: '2026-03-23T09:00:00', status: 'cancelled' },
    ]);
    assert.deepStrictEqual(starts(series), ['2026-03-02T09:00:00', '2026-03-04T09:00:00', '2026-03-05T09:00:00', '2026-03-06T09:00:00',
      '2026-03-10T09:00:00']);
  });

  it('reads an RDATE of DTSTART as the first occurrence it already is', () => {
    const { components } = read(cal(vevent(['UID:s', 'DTSTART:20260303T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260316T090000Z', 'RDATE:20260303T090000Z'])));
    assert.deepStrictEqual(components[0].series.rdates, []);
    assert.deepStrictEqual(starts(components[0].series), [Date.parse('2026-03-03T09:00:00Z'), Date.parse('2026-03-09T09:00:00Z'), Date.parse('2026-03-16T09:00:00Z')]);
  });

  it('reads DTSTART and RDATEs with no rule as the occurrences, each as long as the event', () => {
    const { components } = read(cal(vevent(['UID:s', 'DTSTART:20260302T090000Z', 'DTEND:20260302T100000Z', 'RDATE:20260309T090000Z',
      'RDATE;VALUE=PERIOD:20260316T090000Z/PT2H'])));
    const occurrences = expand(components[0].series).occurrences;
    assert.deepStrictEqual(occurrences.map((o) => [o.instants?.start, o.instants?.end]).map(([a, b]) => [new Date(Number(a)).toISOString(), new Date(Number(b)).toISOString()]), [
      ['2026-03-02T09:00:00.000Z', '2026-03-02T10:00:00.000Z'], ['2026-03-09T09:00:00.000Z', '2026-03-09T10:00:00.000Z'],
      ['2026-03-16T09:00:00.000Z', '2026-03-16T11:00:00.000Z']]);
  });

  it('reads MONTHLY and YEARLY rules, and a zoned rule in its zone', () => {
    const { components } = read(cal([
      ...vevent(['UID:m', 'DTSTART;TZID=Europe/Amsterdam:20260301T100000', 'RRULE:FREQ=MONTHLY;BYDAY=1SU;COUNT=4']),
      ...vevent(['UID:y', 'DTSTART;VALUE=DATE:20260229', 'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1;COUNT=2'].map((l) => l.replace('20260229', '20260228'))),
    ]));
    assert.deepStrictEqual(starts(components[0].series).map((t) => new Date(Number(t)).toISOString().slice(0, 16)),
      ['2026-03-01T09:00', '2026-04-05T08:00', '2026-05-03T08:00', '2026-06-07T08:00']);
    assert.deepStrictEqual(starts(components[1].series), ['2026-02-28T', '2027-02-28T']);
  });

  it('withholds a sub-daily rule by name, the calendar layer\'s JY0020 the cause', () => {
    const text = cal(vevent(['UID:h', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=HOURLY;COUNT=3']));
    const { components, report } = read(text);
    assert.deepStrictEqual([components.length, codes(report), report.unsupported[0].cause?.code], [0, ['ICAL1020'], 'JY0020']);
    assert.match(report.unsupported[0].reason, /FREQ=HOURLY/);
    refusesStrict(text, 'ICAL1020');
  });

  it('keeps a RANGE=THISANDFUTURE override as data and reports it; its expansion is refused', () => {
    const text = cal([...vevent(['UID:s', 'DTSTART:20260302T090000', 'RRULE:FREQ=DAILY;COUNT=5']),
      ...vevent(['UID:s', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260304T090000', 'DTSTART:20260304T100000'])]);
    const { components, report } = read(text);
    assert.deepStrictEqual(report.unsupported.map((e) => [e.code, e.name, e.path]), [['ICAL1015', 'RECURRENCE-ID;RANGE', '/VCALENDAR/VEVENT[1]/RECURRENCE-ID;RANGE']]);
    assert.strictEqual(components[0].series.overrides[0].range, 'THISANDFUTURE');
    assert.throws(() => expand(components[0].series), (/** @type {any} */ error) => error.code === 'JY0021');
    refusesStrict(text, 'ICAL1015');
  });

  it('withholds an override no series claims, and a second series of one UID', () => {
    const { components, report } = read(cal([
      ...vevent(['UID:lonely', 'RECURRENCE-ID:20260302T090000Z', 'DTSTART:20260302T100000Z']),
      ...vevent(['UID:single', 'DTSTART:20260302T090000Z']),
      ...vevent(['UID:single', 'RECURRENCE-ID:20260302T090000Z', 'DTSTART:20260302T100000Z']),
      ...vevent(['UID:s', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=DAILY;COUNT=2']),
      ...vevent(['UID:s', 'DTSTART:20260402T090000Z', 'RRULE:FREQ=DAILY;COUNT=2']),
    ]));
    assert.deepStrictEqual(components.map((c) => c.uid ?? c.series.uid), ['single', 's']);
    assert.deepStrictEqual(report.unsupported.map((e) => [e.code, e.path]), [['ICAL1021', '/VCALENDAR/VEVENT[4]'],
      ['ICAL1021', '/VCALENDAR/VEVENT[0]'], ['ICAL1021', '/VCALENDAR/VEVENT[2]']]);
  });

  it('reports an override whose text differs from its series\', keeping the series\' text', () => {
    const { components, report } = read(cal([...vevent(['UID:s', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:A']),
      ...vevent(['UID:s', 'RECURRENCE-ID:20260303T090000Z', 'DTSTART:20260303T100000Z', 'SUMMARY:B', 'STATUS:TENTATIVE'])]));
    assert.deepStrictEqual(report.unsupported.map((e) => [e.code, e.name]), [['ICAL1016', 'SUMMARY'], ['ICAL1016', 'STATUS']]);
    assert.strictEqual(components[0].summary, 'A');
  });

  it('spells out an override\'s end where its own length differs from the slot\'s', () => {
    const { components } = read(cal([...vevent(['UID:s', 'DTSTART:20260302T090000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=4']),
      ...vevent(['UID:s', 'RECURRENCE-ID:20260303T090000', 'DTSTART:20260303T100000', 'DURATION:PT1H']),
      ...vevent(['UID:s', 'RECURRENCE-ID:20260304T090000', 'DTSTART:20260304T100000', 'DURATION:PT2H']),
      ...vevent(['UID:s', 'RECURRENCE-ID:20260305T090000', 'DTSTART:20260305T100000'])]));
    assert.deepStrictEqual(components[0].series.overrides.map((/** @type {any} */ o) => o.end?.time), [undefined, '12:00:00', '10:00:00']);
  });

  for (const [title, lines, code] of /** @type {[string, string[], string][]} */ ([
    ['an override of another kind', ['UID:s', 'RECURRENCE-ID;VALUE=DATE:20260303', 'DTSTART:20260303T100000Z'], 'ICAL1018'],
    ['an override starting in another kind', ['UID:s', 'RECURRENCE-ID:20260303T090000Z', 'DTSTART:20260303T100000'], 'ICAL1018'],
    ['an override with a rule', ['UID:s', 'RECURRENCE-ID:20260303T090000Z', 'DTSTART:20260303T100000Z', 'RRULE:FREQ=DAILY'], 'ICAL1017'],
    ['RANGE=THISANDPRIOR', ['UID:s', 'RECURRENCE-ID;RANGE=THISANDPRIOR:20260303T090000Z', 'DTSTART:20260303T100000Z'], 'ICAL1018'],
  ])) {
    it(`withholds ${title} (${code})`, () => {
      const { report } = read(cal([...vevent(['UID:s', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=DAILY;COUNT=3']), ...vevent(lines)]));
      assert.deepStrictEqual(codes(report), [code]);
    });
  }

  it('withholds a series the calendar layer refuses, with its overrides', () => {
    const { components, report } = read(cal([...vevent(['UID:s', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=DAILY;UNTIL=20260310T090000', 'SUMMARY:x']),
      ...vevent(['UID:s', 'RECURRENCE-ID:20260303T090000Z', 'DTSTART:20260303T100000Z', 'SUMMARY:x'])]));
    assert.deepStrictEqual([components.length, codes(report), report.unsupported[0].cause?.code], [0, ['ICAL1020'], 'JY0019']);
  });

  it('withholds a zoned series of extra dates with a length, which needs the zone\'s offsets', () => {
    const { report } = read(cal(vevent(['UID:s', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000', 'DURATION:PT1H',
      'RDATE;TZID=Europe/Amsterdam:20260309T090000'])));
    assert.deepStrictEqual(codes(report), ['ICAL1022']);
  });
});

describe('ical reader: free/busy', () => {
  it('reads periods by end and by duration, with their types, as instants', () => {
    const { components, report } = read(cal(['BEGIN:VFREEBUSY', 'UID:fb', 'DTSTAMP:20260301T000000Z', 'DTSTART:20260302T000000Z', 'DTEND:20260303T000000Z',
      'FREEBUSY:20260302T090000Z/PT1H,20260302T130000Z/20260302T140000Z', 'FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260302T150000Z/PT30M',
      'FREEBUSY;FBTYPE=free:20260302T160000Z/P1D', 'END:VFREEBUSY']));
    assert.deepStrictEqual(report.unsupported, []);
    const at = (/** @type {string} */ t) => Date.parse(t);
    assert.deepStrictEqual(components, [{ type: 'freebusy', uid: 'fb', dtstamp: at('2026-03-01T00:00:00Z'), start: at('2026-03-02T00:00:00Z'),
      end: at('2026-03-03T00:00:00Z'), periods: [
        { start: at('2026-03-02T09:00:00Z'), end: at('2026-03-02T10:00:00Z'), fbtype: 'busy' },
        { start: at('2026-03-02T13:00:00Z'), end: at('2026-03-02T14:00:00Z'), fbtype: 'busy' },
        { start: at('2026-03-02T15:00:00Z'), end: at('2026-03-02T15:30:00Z'), fbtype: 'busy-tentative' },
        { start: at('2026-03-02T16:00:00Z'), end: at('2026-03-03T16:00:00Z'), fbtype: 'free' }] }]);
  });

  for (const [title, line] of [['a local period', 'FREEBUSY:20260302T090000/PT1H'], ['an unknown type', 'FREEBUSY;FBTYPE=X-OOF:20260302T090000Z/PT1H'],
    ['a period with no end', 'FREEBUSY:20260302T090000Z'], ['an empty period', 'FREEBUSY:20260302T090000Z/20260302T090000Z']]) {
    it(`withholds ${title} (ICAL1018)`, () => {
      const { components, report } = read(cal(['BEGIN:VFREEBUSY', 'UID:fb', line, 'END:VFREEBUSY']));
      assert.deepStrictEqual([components.length, codes(report)], [0, ['ICAL1018']]);
    });
  }

  it('withholds a range whose time carries a TZID, as a VEVENT\'s UTC time with one is', () => {
    for (const line of ['DTSTART;TZID=Europe/Amsterdam:20260302T000000Z', 'DTEND;TZID=Europe/Amsterdam:20260303T000000Z']) {
      const { components, report } = read(cal(['BEGIN:VFREEBUSY', 'UID:fb', line, 'END:VFREEBUSY']));
      assert.deepStrictEqual([components.length, codes(report), report.unsupported[0].path.split('/').pop()], [0, ['ICAL1018'], line.split(';')[0]]);
    }
  });

  it('withholds a range that ends before it starts', () => {
    const { report } = read(cal(['BEGIN:VFREEBUSY', 'UID:fb', 'DTSTART:20260303T000000Z', 'DTEND:20260302T000000Z', 'END:VFREEBUSY']));
    assert.deepStrictEqual(codes(report), ['ICAL1018']);
  });
});

describe('ical reader: the report of what is outside the subset', () => {
  const text = cal([
    'BEGIN:VTODO', 'UID:t', 'SUMMARY:Buy milk', 'END:VTODO',
    ...vevent(['UID:e', 'DTSTART:20260302T090000Z', 'X-FOO:bar', 'SUMMARY;LANGUAGE=en:Hello', 'ATTENDEE:mailto:a@example.com',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM']),
    'BEGIN:VAVAILABILITY', 'UID:av', 'END:VAVAILABILITY', 'BEGIN:VJOURNAL', 'UID:j', 'END:VJOURNAL', 'BEGIN:X-CUSTOM', 'END:X-CUSTOM',
  ], ['METHOD:REQUEST', 'X-WR-CALNAME:Team', 'CALSCALE:GREGORIAN']);

  it('lists exactly VTODO, VALARM and X-FOO and the rest, with paths, lines and counts', () => {
    const { components, report, calendar } = read(text);
    assert.deepStrictEqual(components, [{ type: 'event', uid: 'e', start: { kind: 'utc', instant: '2026-03-02T09:00:00Z' }, summary: 'Hello' }]);
    assert.strictEqual(calendar.method, undefined);
    assert.deepStrictEqual(report.unsupported.map((e) => [e.code, e.name, e.path, e.line]), [
      ['ICAL1011', 'METHOD', '/VCALENDAR/METHOD', 4],
      ['ICAL1011', 'X-WR-CALNAME', '/VCALENDAR/X-WR-CALNAME', 5],
      ['ICAL1013', 'VTODO', '/VCALENDAR/VTODO[0]', 7],
      ['ICAL1013', 'VALARM', '/VCALENDAR/VEVENT[0]/VALARM[0]', 17],
      ['ICAL1011', 'X-FOO', '/VCALENDAR/VEVENT[0]/X-FOO', 14],
      ['ICAL1011', 'ATTENDEE', '/VCALENDAR/VEVENT[0]/ATTENDEE', 16],
      ['ICAL1012', 'SUMMARY;LANGUAGE', '/VCALENDAR/VEVENT[0]/SUMMARY;LANGUAGE', 15],
      ['ICAL1013', 'VAVAILABILITY', '/VCALENDAR/VAVAILABILITY[0]', 22],
      ['ICAL1013', 'VJOURNAL', '/VCALENDAR/VJOURNAL[0]', 25],
      ['ICAL1013', 'X-CUSTOM', '/VCALENDAR/X-CUSTOM[0]', 28],
    ]);
    assert.deepStrictEqual(report.counts, { ICAL1011: 4, ICAL1012: 1, ICAL1013: 5 });
    assert.strictEqual(report.omitted, 0);
    assert.ok(report.unsupported.every((e) => e.withheld === undefined));
  });

  it('strict mode refuses at the first entry, with its code', () => {
    refusesStrict(text, 'ICAL1011');
    refusesStrict(cal(['BEGIN:VTODO', 'END:VTODO']), 'ICAL1013');
    refusesStrict(cal(vevent(['UID:e', 'DTSTART:20260302T090000Z', 'SUMMARY;LANGUAGE=en:Hello'])), 'ICAL1012');
    refusesStrict(cal(['BEGIN:VTIMEZONE', 'TZID:X', 'END:VTIMEZONE']), 'ICAL1014');
  });

  it('maxReported lists that many entries and counts the rest', () => {
    const { report } = read(text, { provider, maxReported: 3 });
    assert.deepStrictEqual([report.unsupported.length, report.omitted, report.counts.ICAL1013], [3, 7, 5]);
  });

  it('reads METHOD:PUBLISH and CALSCALE:GREGORIAN, refuses another scale or version', () => {
    assert.strictEqual(read(cal([], ['METHOD:PUBLISH'])).calendar.method, 'publish');
    assert.deepStrictEqual(codes(read(cal([], ['METHOD:PUBLISH', 'METHOD:PUBLISH'])).report), ['ICAL1011']);
    assert.deepStrictEqual(codes(read(cal([], ['VERSION;X-A=b:2.0'].slice(0, 0).concat(['CALSCALE;X-A=b:GREGORIAN']))).report), ['ICAL1012']);
    for (const head of [['CALSCALE:CHINESE'], ['VERSION:2.0'], ['PRODID:again']]) {
      assert.throws(() => parseIcal(cal([], head)), (/** @type {any} */ error) => error.code === 'ICAL1008', head[0]);
    }
    for (const text of ['BEGIN:VCALENDAR\r\nVERSION:1.0\r\nPRODID:p\r\nEND:VCALENDAR\r\n', 'BEGIN:VCALENDAR\r\nPRODID:p\r\nEND:VCALENDAR\r\n',
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:a\\q\r\nEND:VCALENDAR\r\n']) {
      assert.throws(() => parseIcal(text), (/** @type {any} */ error) => error.code === 'ICAL1008', text);
    }
  });

  it('every reader code is in the code table', () => {
    for (let i = 1; i <= 24; i++)
      assert.ok(Object.hasOwn(ICAL_CODES, `ICAL${1000 + i}`), String(i));
  });
});

describe('ical reader: three entries, one engine', () => {
  const text = cal([...vevent(['UID:s', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=DAILY;COUNT=3']),
    ...vevent(['UID:a', 'DTSTART:20260302T090000Z', 'X-A:1']), 'BEGIN:VFREEBUSY', 'UID:fb', 'END:VFREEBUSY'], ['METHOD:PUBLISH']);

  it('createIcalReader yields each component as its END is read, the series at the end', () => {
    const reader = createIcalReader({ provider });
    assert.ok(reader instanceof IcalReader);
    const lines = text.split('\r\n');
    const seen = [];
    for (const line of lines)
      seen.push(reader.feed(`${line}\r\n`).map((c) => c.uid ?? c.series.uid));
    const { calendar, report } = reader.end();
    assert.deepStrictEqual(seen.flat(), ['a', 'fb']);
    assert.deepStrictEqual(calendar.components.map((c) => c.series.uid), ['s']);
    assert.deepStrictEqual([calendar.prodId, calendar.method, codes(report)], ['-//Test//EN', 'publish', ['ICAL1011']]);
    assert.throws(() => reader.feed('x'), (/** @type {any} */ error) => error.code === 'ICAL1009');
    assert.throws(() => reader.end(), (/** @type {any} */ error) => error.code === 'ICAL1009');
  });

  it('iterateIcal yields the same components, then the head and report', async () => {
    const items = [];
    async function* source() {
      for (let i = 0; i < text.length; i += 7)
        yield text.slice(i, i + 7);
    }
    for await (const item of iterateIcal(source(), { provider }))
      items.push(item);
    const whole = parseIcal(text, { provider });
    const end = items.pop();
    assert.deepStrictEqual(items.map((item) => item.type === 'component' && item.component), whole.calendar.components);
    const { zones, ...rest } = /** @type {any} */ (end);
    assert.deepStrictEqual(rest, { type: 'end', calendar: { prodId: '-//Test//EN', method: 'publish' }, report: whole.report });
    assert.deepStrictEqual([zones.compiled, zones.undeclared], [whole.zones.compiled, whole.zones.undeclared]);
    assert.strictEqual(zones.provider.identity, provider.identity);
  });

  it('iterateIcal reads a synchronous iterable of octets, and closes a source it stops early', async () => {
    const bytes = new TextEncoder().encode(text);
    const items = [];
    for await (const item of iterateIcal([bytes.subarray(0, 100), bytes.subarray(100)], { provider }))
      items.push(item.type);
    assert.deepStrictEqual(items, ['component', 'component', 'component', 'end']);
    let closed = 0;
    const source = { [Symbol.iterator]() {
      return { next: () => ({ done: false, value: text }), return: () => { closed++; return { done: true, value: undefined }; } };
    } };
    for await (const item of iterateIcal(/** @type {any} */ (source), { provider })) {
      assert.strictEqual(item.type, 'component');
      break;
    }
    assert.strictEqual(closed, 1);
  });

  it('iterateIcal stops at an aborted signal, closing the source', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await assert.rejects(async () => {
      for await (const item of iterateIcal([text], { signal: controller.signal })) assert.fail(String(item));
    }, /stop/);
  });

  it('refuses unknown and mistyped options, and a chunk that is neither text nor octets', () => {
    assert.throws(() => parseIcal(text, /** @type {any} */ ({ zones: 'utc' })), TypeError);
    assert.throws(() => parseIcal(text, /** @type {any} */ ({ strict: 'yes' })), TypeError);
    assert.throws(() => parseIcal(text, { maxDepth: 0 }), TypeError);
    assert.throws(() => createIcalReader({ provider: /** @type {any} */ ('Europe/Amsterdam') }), TypeError);
    assert.throws(() => createIcalReader().feed(/** @type {any} */ (42)), TypeError);
  });

  it('iterateIcal refuses an unknown option at its first pull', async () => {
    await assert.rejects(() => iterateIcal([text], /** @type {any} */ ({ horizon: [] })).next(), TypeError);
  });
});

describe('ical reader: the rarer shapes', () => {
  const at = (/** @type {string} */ t) => Date.parse(t);

  it('reads a zoned start with a UTC or other-zone end as written', () => {
    const { components } = read(cal([...vevent(['UID:a', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000', 'DTEND:20260302T090000Z']),
      ...vevent(['UID:b', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000', 'DTEND;TZID=Europe/London:20260302T090000'])]));
    assert.deepStrictEqual(components.map((c) => [c.end.kind, c.end.zone, c.policy]), [['utc', undefined, 'rfc5545'], ['zoned', 'Europe/London', 'rfc5545']]);
  });

  it('reads a series of dates whose event lasts days, and its override\'s own length', () => {
    const { components, report } = read(cal([
      ...vevent(['UID:d', 'DTSTART;VALUE=DATE:20260302', 'DURATION:P2D', 'RDATE;VALUE=DATE:20260309']),
      ...vevent(['UID:w', 'DTSTART;VALUE=DATE:20260302', 'RRULE:FREQ=WEEKLY;COUNT=3']),
      ...vevent(['UID:w', 'RECURRENCE-ID;VALUE=DATE:20260309', 'DTSTART;VALUE=DATE:20260310', 'DURATION:P3D']),
      ...vevent(['UID:w', 'RECURRENCE-ID;VALUE=DATE:20260316', 'DTSTART;VALUE=DATE:20260317']),
    ]));
    assert.deepStrictEqual(report.unsupported, []);
    assert.deepStrictEqual(components[0].series.rdates, [{ start: { kind: 'date', date: '2026-03-02' }, end: { kind: 'date', date: '2026-03-04' } },
      { start: { kind: 'date', date: '2026-03-09' }, end: { kind: 'date', date: '2026-03-11' } }]);
    assert.deepStrictEqual(components[1].series.overrides, [
      { recurrenceId: '2026-03-09', status: 'moved', start: { kind: 'date', date: '2026-03-10' }, end: { kind: 'date', date: '2026-03-13' } },
      { recurrenceId: '2026-03-16', status: 'moved', start: { kind: 'date', date: '2026-03-17' } }]);
  });

  it('withholds a rule series whose DTEND is of another kind, the calendar layer\'s refusal the cause', () => {
    const { components, report } = read(cal([...vevent(['UID:s', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000', 'DTEND:20260302T090000Z', 'RRULE:FREQ=DAILY;COUNT=3']),
      ...vevent(['UID:s', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20260303T090000', 'DTSTART;TZID=Europe/Amsterdam:20260303T100000'])]));
    assert.deepStrictEqual([components.length, codes(report), report.unsupported[0].cause?.code], [0, ['ICAL1020'], 'JY0013']);
  });

  it('withholds a series of extra dates whose DTEND lies in another zone', () => {
    const { report } = read(cal(vevent(['UID:s', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000', 'DTEND:20260302T090000Z',
      'RDATE;TZID=Europe/Amsterdam:20260309T090000'])));
    assert.deepStrictEqual(codes(report), ['ICAL1022']);
  });

  it('keeps a cancelled override over this and future occurrences as data', () => {
    const { components } = read(cal([...vevent(['UID:s', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=DAILY;COUNT=5']),
      ...vevent(['UID:s', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260304T090000Z', 'DTSTART:20260304T090000Z', 'STATUS:CANCELLED'])]));
    assert.deepStrictEqual(components[0].series.overrides, [{ recurrenceId: '2026-03-04T09:00:00Z', status: 'cancelled', range: 'THISANDFUTURE' }]);
  });

  it('reads a DATE without the TZID given it, and reports the TZID', () => {
    const { components, report } = read(cal(vevent(['UID:d', 'DTSTART;VALUE=DATE;TZID=Europe/Amsterdam:20260302', 'RRULE:FREQ=DAILY;COUNT=2',
      'EXDATE;VALUE=DATE;TZID=Europe/Amsterdam:20260303'])));
    assert.deepStrictEqual(report.unsupported.map((e) => [e.code, e.name]), [['ICAL1012', 'DTSTART;TZID'], ['ICAL1012', 'EXDATE;TZID']]);
    assert.deepStrictEqual(components[0].series.exdates, [{ kind: 'date', date: '2026-03-03' }]);
  });

  for (const [title, line] of [['no end', 'RDATE;VALUE=PERIOD:20260303T090000Z'], ['an end before its start', 'RDATE;VALUE=PERIOD:20260303T090000Z/20260303T080000Z'],
    ['an end of another kind', 'RDATE;VALUE=PERIOD:20260303T090000Z/20260303T100000']]) {
    it(`withholds an RDATE period with ${title} (ICAL1018)`, () => {
      const { report } = read(cal(vevent(['UID:s', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=DAILY;COUNT=2', line])));
      assert.deepStrictEqual(codes(report), ['ICAL1018']);
    });
  }

  it('withholds a TEXT value ending in a lone backslash', () => {
    const { report } = read(cal(vevent(['UID:s', 'DTSTART:20260302T090000Z', 'SUMMARY:a\\'])));
    assert.deepStrictEqual(codes(report), ['ICAL1018']);
  });

  it('asks the provider once per TZID, and as often as it must past 64 names', () => {
    let calls = 0;
    const counting = { ...provider, toParts: (/** @type {any[]} */ ...args) => { calls++; return /** @type {any} */ (provider).toParts(...args); } };
    const names = Array.from({ length: 70 }, (_, i) => `Nowhere/Place_${i}`);
    const { report } = read(cal([...names, ...names].flatMap((name, i) => vevent([`UID:${i}`, `DTSTART;TZID=${name}:20260302T090000`]))), { provider: counting });
    assert.strictEqual(report.counts.ICAL1019, 140);
    assert.ok(calls >= 70 && calls < 140 * 3, String(calls));
    assert.ok(at('2026-01-01T00:00:00Z') > 0);
  });
});
