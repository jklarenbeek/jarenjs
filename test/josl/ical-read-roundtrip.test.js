//@ts-check

/**
 * Read back what the writer writes, and what RFC 5545 and calendar
 * exporters write.
 *
 * The writer is not one-to-one (a zoned value becomes its UTC instant, a
 * zoned series its occurrences, a cancelled slot an EXDATE, a COUNT
 * whose start the rule does not make an UNTIL, free/busy periods are
 * sorted), so "the same model" is held three ways: a strict read of
 * every written calendar reports nothing; writing the read model again
 * gives the same octets; and every series read back makes the same
 * occurrences as the series written. Where the writer is one-to-one the
 * read model equals the written one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseIcal, stringifyIcal } from '@jarenjs/josl/ical';
import { defineSeries, compileRecurrence, expandSeries, toUtc, evaluateAvailability, freeBusy, weeklyPattern } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import fixture from '../core/calendar/fixtures/rfc5545-recurrence/examples.json' with { type: 'json' };
import { JarenValidator } from '@jarenjs/validate';
import icalSchema from '@jarenjs/josl/schemas/jaren-josl-ical.schema.json' with { type: 'json' };
import temporalSchema from '@jarenjs/core/schemas/calendar/temporal.schema.json' with { type: 'json' };
import rruleSchema from '@jarenjs/core/schemas/calendar/rrule.schema.json' with { type: 'json' };

const DIR = fileURLToPath(new URL('./fixtures/ical/', import.meta.url));
const provider = createIntlZoneProvider({ revision: 'roundtrip' });
const runtime = { now: () => Date.parse('2026-01-15T10:20:30Z') };
const at = (/** @type {string} */ text) => Date.parse(text);
const HORIZON = [at('2025-01-01T00:00:00Z'), at('2028-01-01T00:00:00Z')];
const WRITE = { zones: /** @type {'utc'} */ ('utc'), provider, runtime, horizon: /** @type {[number, number]} */ (HORIZON) };

const floating = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'floating', date, time });
const zoned = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'zoned', date, time, zone: 'Europe/Amsterdam' });
const utc = (/** @type {string} */ instant) => ({ kind: 'utc', instant });
const date = (/** @type {string} */ day) => ({ kind: 'date', date: day });

/**
 * The occurrences of a series as instants (utc and zoned) or wall clocks.
 * @param {any} series
 */
function occurrencesOf(series, span = HORIZON) {
  const defined = series.kind === 'series' ? series : defineSeries({ ...series, base: series.base === undefined ? null : compileRecurrence(series.base) });
  const kind = (defined.base?.dtstart ?? defined.rdates[0].start ?? defined.rdates[0]).kind;
  const day = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 10);
  const horizon = kind === 'date' ? [date(day(span[0])), date(day(span[1]))]
    : kind === 'floating' ? [floating(day(span[0]), '00:00'), floating(day(span[1]), '00:00')] : span;
  const expansion = expandSeries(defined, { horizon: /** @type {any} */ (horizon), provider });
  assert.strictEqual(expansion.status, 'complete');
  const place = (/** @type {any} */ value) => (value.kind === 'date' ? value.date : `${value.date}T${value.time.length === 5 ? `${value.time}:00` : value.time}`);
  return expansion.occurrences.map((o) => (o.instants ? [o.instants.start, o.instants.end] : [place(o.start), place(o.end)]));
}

/**
 * Write, read strictly, write again.
 * @param {any} calendar
 * @param {any} [options] - the writer's
 */
function roundTrip(calendar, options = WRITE) {
  const text = stringifyIcal(calendar, options);
  const { calendar: read, report } = parseIcal(text, { provider, strict: true });
  assert.deepStrictEqual(report, { unsupported: [], counts: {}, omitted: 0 });
  assert.strictEqual(stringifyIcal(read, options), text, 'the read model writes the same octets');
  return read;
}

describe('ical round trip: the writer\'s goldens', () => {
  for (const name of ['rfc5545-examples.ics', 'kinds.ics', 'series.ics']) {
    it(`${name}: a strict read reports nothing, and writes back byte for byte`, () => {
      const text = fs.readFileSync(`${DIR}${name}`, 'utf8');
      const { calendar, report } = parseIcal(text, { provider, strict: true });
      assert.deepStrictEqual(report.unsupported, []);
      assert.strictEqual(stringifyIcal(calendar, WRITE), text);
    });
  }

  it('series.ics reads back to series making the occurrences of those written', () => {
    const { calendar } = parseIcal(fs.readFileSync(`${DIR}series.ics`), { provider });
    const written = [
      { uid: 'stock-check', base: { dtstart: floating('2026-03-02', '08:00'), duration: 'PT2H', rrule: 'FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20260430T080000' },
        rdates: [{ start: floating('2026-03-07', '10:00'), end: floating('2026-03-07', '11:00') }], exdates: [floating('2026-04-06', '08:00')],
        overrides: [{ recurrenceId: '2026-03-12T08:00:00', status: 'moved', start: floating('2026-03-13', '08:00') },
          { recurrenceId: '2026-04-09T08:00:00', status: 'cancelled' }] },
      { uid: 'briefing', base: { dtstart: zoned('2026-03-16', '09:00'), duration: 'PT15M', rrule: 'FREQ=WEEKLY;COUNT=4' },
        overrides: [{ recurrenceId: '2026-03-30T09:00:00', status: 'moved', start: zoned('2026-03-30', '09:30') }] },
    ];
    assert.deepStrictEqual(calendar.components.map((c) => occurrencesOf(c.series)), written.map((series) => occurrencesOf(series)));
  });

  it('rfc5545-examples.ics reads back to the model written, its periods in the order written', () => {
    const { calendar } = parseIcal(fs.readFileSync(`${DIR}rfc5545-examples.ics`), { provider });
    assert.deepStrictEqual(calendar.components[2].start, { kind: 'date-range', start: '2007-06-28', end: '2007-07-09' });
    assert.deepStrictEqual(calendar.components[3].periods.map((/** @type {any} */ p) => [p.start, p.end, p.fbtype]), [
      [at('1998-03-14T23:30:00Z'), at('1998-03-15T00:30:00Z'), 'busy'], [at('1998-03-16T15:30:00Z'), at('1998-03-16T16:30:00Z'), 'busy'],
      [at('1998-03-18T03:00:00Z'), at('1998-03-18T04:00:00Z'), 'busy']]);
  });
});

describe('ical round trip: single events and free/busy, where the writer is one-to-one', () => {
  const events = [
    { type: 'event', uid: 'u1', dtstamp: 0, start: utc('2026-03-02T08:00:00Z'), end: utc('2026-03-02T09:30:00Z'), summary: 'a; b, c \\ d\ne', status: 'tentative', sequence: 3 },
    { type: 'event', uid: 'u2', dtstamp: 0, start: utc('2026-03-02T08:00:00Z'), duration: 'PT45M', location: '中文 😀 café' },
    { type: 'event', uid: 'd1', dtstamp: 0, start: date('2026-12-25'), description: 'x'.repeat(200) },
    { type: 'event', uid: 'd2', dtstamp: 0, start: { kind: 'date-range', start: '2026-07-01', end: '2026-07-15' } },
    { type: 'event', uid: 'd3', dtstamp: 0, start: date('2026-07-01'), duration: 'P2W' },
    { type: 'event', uid: 'f1', dtstamp: 0, start: floating('2026-03-02', '09:00:00'), end: floating('2026-03-02', '17:00:00'), status: 'cancelled' },
    { type: 'event', uid: 'f2', dtstamp: 0, start: floating('2026-03-02', '09:00:00'), duration: 'P1DT2H' },
  ];

  it('reads each event back to the model written', () => {
    assert.deepStrictEqual(roundTrip({ prodId: 'p', method: 'publish', components: events }).components, events);
  });

  it('reads a zoned event back as the instants toUtc gives it', () => {
    const start = zoned('2026-03-29', '02:30');
    const [read] = roundTrip({ prodId: 'p', components: [{ type: 'event', uid: 'z', dtstamp: 0, start, end: zoned('2026-03-29', '04:00'), policy: 'later' }] }).components;
    assert.deepStrictEqual([read.start.instant, read.end.instant], [new Date(/** @type {any} */ (toUtc(/** @type {any} */ (start), { provider, policy: 'later' })).instant).toISOString().replace('.000', ''), '2026-03-29T02:00:00Z']);
  });

  it('reads free/busy back, its periods in ascending order', () => {
    const result = evaluateAvailability([{ id: 'hours', priority: 5, mode: 'available', series: weeklyPattern({ days: { mon: [['09:00', '17:00']] } }), source: 's' },
      { id: 'leave', priority: 1, mode: 'busy', busyType: 'busy-unavailable', spans: [{ start: at('2026-03-02T12:00:00Z'), end: at('2026-03-02T13:00:00Z') }], source: 's' }],
    { horizon: [at('2026-03-02T00:00:00Z'), at('2026-03-04T00:00:00Z')], zone: 'Europe/Amsterdam', provider, policy: 'rfc5545' });
    const { start, end, periods } = freeBusy(result);
    const component = { type: 'freebusy', uid: 'fb', dtstamp: 0, start, end, periods };
    const [read] = roundTrip({ prodId: 'p', components: [component] }).components;
    assert.deepStrictEqual(read, component);
  });
});

describe('ical round trip: series of every kind and frequency make the same occurrences', () => {
  const shapes = /** @type {[string, any][]} */ ([
    ['floating, rule, extra and excluded dates, moved and cancelled slots', {
      uid: 'f', sequence: 2, base: { dtstart: floating('2026-03-02', '09:00'), duration: 'PT1H30M', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8' },
      rdates: [floating('2026-03-07', '10:00'), { start: floating('2026-03-08', '10:00'), end: floating('2026-03-08', '14:00') }],
      exdates: [floating('2026-03-04', '09:00')],
      overrides: [{ recurrenceId: '2026-03-09T09:00:00', status: 'moved', start: floating('2026-03-09', '11:00') },
        { recurrenceId: '2026-03-11T09:00:00', status: 'moved', start: floating('2026-03-12', '09:00'), end: floating('2026-03-12', '12:00') },
        { recurrenceId: '2026-03-16T09:00:00', status: 'cancelled' }] }],
    ['floating, periods on slots the rule makes', {
      uid: 'p', base: { dtstart: floating('2026-03-02', '09:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6' },
      rdates: [{ start: floating('2026-03-04', '09:00'), end: floating('2026-03-04', '12:00') }] }],
    ['floating, a start the rule does not make, with COUNT', {
      uid: 'q', base: { dtstart: floating('2026-03-03', '09:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' } }],
    ['utc, a start the rule does not make, with UNTIL', {
      uid: 'k', base: { dtstart: utc('2026-03-03T08:00:00Z'), rrule: 'FREQ=DAILY;BYHOUR=10;UNTIL=20260306T100000Z' } }],
    ['dates, with an excluded date', {
      uid: 'j', base: { dtstart: date('2026-03-02'), rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=4' }, exdates: [date('2026-03-06')] }],
    ['floating with dtend and a moved slot', {
      uid: 'g', base: { dtstart: floating('2026-03-02', '22:00'), dtend: floating('2026-03-02', '24:00'), rrule: 'FREQ=DAILY;INTERVAL=2;UNTIL=20260320T220000' },
      overrides: [{ recurrenceId: '2026-03-04T22:00:00', status: 'moved', start: floating('2026-03-04', '21:00') }] }],
    ['floating MONTHLY, the first Sunday', {
      uid: 'm', base: { dtstart: floating('2026-03-01', '10:00'), duration: 'PT2H', rrule: 'FREQ=MONTHLY;BYDAY=1SU;COUNT=6' } }],
    ['dates YEARLY, the last day of February', {
      uid: 'y', base: { dtstart: date('2026-02-28'), rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1;COUNT=3' } }],
    ['utc MONTHLY with BYSETPOS', {
      uid: 's', base: { dtstart: utc('2026-01-30T12:00:00Z'), rrule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=5' } }],
    ['zoned, expanded over the horizon, with a moved slot', {
      uid: 'z', base: { dtstart: zoned('2026-03-16', '09:00'), duration: 'PT15M', rrule: 'FREQ=WEEKLY;COUNT=6' },
      overrides: [{ recurrenceId: '2026-03-30T09:00:00', status: 'moved', start: zoned('2026-03-30', '09:30') }] }],
    ['zoned MONTHLY across both offset changes', {
      uid: 'zm', base: { dtstart: zoned('2026-01-25', '02:30'), duration: 'PT1H', rrule: 'FREQ=MONTHLY;BYDAY=-1SU;COUNT=12' } }],
    ['utc extra dates, no rule', { uid: 'r', rdates: [utc('2026-03-02T08:00:00Z'), utc('2026-03-05T08:00:00Z')] }],
    ['floating periods, no rule', { uid: 'rp', rdates: [{ start: floating('2026-03-02', '08:00'), end: floating('2026-03-02', '09:00') },
      { start: floating('2026-03-03', '08:00'), end: floating('2026-03-03', '09:00') }] }],
    ['dates, no rule', { uid: 'rd', rdates: [date('2026-03-02'), date('2026-03-09')] }],
  ]);

  for (const [title, series] of shapes) {
    it(title, () => {
      const [read] = roundTrip({ prodId: 'p', components: [{ type: 'event', dtstamp: 0, summary: title, series }] }).components;
      assert.strictEqual(read.summary, title);
      assert.deepStrictEqual(occurrencesOf(read.series), occurrencesOf(series));
    });
  }
});

describe('ical reader: RFC 5545 §3.8.5.3, every example read from its own lines', () => {
  const rows = /** @type {any[]} */ (fixture.examples);

  it('the fixture holds 42 examples: 38 with their instants, 4 sub-daily', () => {
    assert.deepStrictEqual([rows.length, rows.filter((row) => row.expected !== undefined).length], [42, 38]);
  });

  for (const row of rows) {
    it(`${row.rrule}${row.exdate ? ` with ${row.exdate}` : ''}`, () => {
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RFC 5545//Examples//EN', 'BEGIN:VEVENT', 'UID:rfc', 'DTSTAMP:19970901T000000Z', row.dtstart,
        `RRULE:${row.rrule}`, ...(row.exdate ? [row.exdate] : []), 'END:VEVENT', 'END:VCALENDAR', ''];
      const { calendar, report } = parseIcal(lines.join('\r\n'), { provider });
      assert.deepStrictEqual(report.unsupported, []);
      if (row.expected === undefined) {
        // sub-daily: the fixture lists no instants (the calendar layer's own tests pin them); the read series makes
        // what the rule compiled directly makes, over a day from its start
        const [, zone, wall] = /** @type {RegExpExecArray} */ (/^DTSTART;TZID=([^:]+):(\d{8}T\d{6})$/.exec(row.dtstart));
        const dtstart = { kind: 'zoned', date: `${wall.slice(0, 4)}-${wall.slice(4, 6)}-${wall.slice(6, 8)}`, time: `${wall.slice(9, 11)}:${wall.slice(11, 13)}:${wall.slice(13)}`, zone };
        const from = Date.parse(`${dtstart.date}T00:00:00Z`);
        const day = [from, from + 2 * 86400000];
        const direct = expandSeries(defineSeries({ uid: 'rfc', base: compileRecurrence(/** @type {any} */ ({ dtstart, rrule: row.rrule })) }), { horizon: day, provider });
        const read = expandSeries(calendar.components[0].series, { horizon: day, provider });
        assert.ok(direct.occurrences.length >= 2);
        assert.deepStrictEqual(read.occurrences.map((o) => o.instants?.start), direct.occurrences.map((o) => o.instants?.start));
        return;
      }
      const horizon = row.horizon.map((/** @type {string} */ t) => Date.parse(t));
      const expansion = expandSeries(calendar.components[0].series, { horizon, provider });
      assert.deepStrictEqual(expansion.occurrences.map((o) => o.instants?.start), row.expected.map((/** @type {string} */ t) => Date.parse(t)));
    });
  }
});

describe('ical round trip: the RFC 5545 §3.8.5.3 rows the writer writes', () => {
  const rows = /** @type {any[]} */ (fixture.examples).filter((row) => row.expected !== undefined && row.exdate === undefined);
  const startOf = (/** @type {string} */ line) => {
    const form = /** @type {RegExpExecArray} */ (/^DTSTART;TZID=([^:]+):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(line));
    return { zone: form[1], date: `${form[2]}-${form[3]}-${form[4]}`, time: `${form[5]}:${form[6]}:${form[7]}` };
  };

  it('holds the 37 rows the writer\'s own corpus writes', () => assert.strictEqual(rows.length, 37));

  for (const row of rows) {
    it(`${row.rrule}: zoned and expanded, and floating with its rule, read back to the same occurrences`, () => {
      const start = startOf(row.dtstart);
      const horizon = row.horizon.map((/** @type {string} */ t) => Date.parse(t));
      const options = { ...WRITE, horizon };
      const zonedSeries = { uid: 'rfc', base: { dtstart: { kind: 'zoned', date: start.date, time: start.time, zone: start.zone }, rrule: row.rrule } };
      const [zonedRead] = roundTrip({ prodId: 'p', components: [{ type: 'event', dtstamp: 0, series: zonedSeries }] }, options).components;
      assert.deepStrictEqual(occurrencesOf(zonedRead.series, horizon), occurrencesOf(zonedSeries, horizon));
      assert.deepStrictEqual(occurrencesOf(zonedRead.series, horizon).map(([t]) => t), row.expected.map((/** @type {string} */ t) => Date.parse(t)));
      const floatingSeries = { uid: 'rfc', base: { dtstart: floating(start.date, start.time), rrule: row.rrule.replace(/(UNTIL=\d{8}T\d{6})Z/, '$1') } };
      const [floatingRead] = roundTrip({ prodId: 'p', components: [{ type: 'event', dtstamp: 0, series: floatingSeries }] }, options).components;
      assert.deepStrictEqual(occurrencesOf(floatingRead.series, horizon), occurrencesOf(floatingSeries, horizon));
    });
  }
});

describe('ical reader: the vendored RFC and exporter files', () => {
  const readFile = (/** @type {string} */ name) => parseIcal(fs.readFileSync(`${DIR}${name}`), { provider });
  const entries = (/** @type {any} */ report) => report.unsupported.map((/** @type {any} */ e) => `${e.code} ${e.name}`);

  it('RFC 5545 §4 meeting: the zoned event read in America/New_York; its VTIMEZONE starts after it, so the provider answers, reported', () => {
    const { calendar, report, zones } = readFile('rfc5545-section4-meeting.ics');
    assert.deepStrictEqual(calendar.components, [{ type: 'event', uid: 'guid-1.example.com', dtstamp: at('1998-03-09T23:10:00Z'),
      start: { kind: 'zoned', date: '1998-03-12', time: '08:30:00', zone: 'America/New_York' },
      end: { kind: 'zoned', date: '1998-03-12', time: '09:30:00', zone: 'America/New_York' }, policy: 'rfc5545',
      summary: 'XYZ Project Review', description: 'Project XYZ Review Meeting', location: '1CP Conference Room 4350' }]);
    assert.deepStrictEqual(entries(report), ['ICAL1011 ORGANIZER', 'ICAL1011 ATTENDEE', 'ICAL1011 CATEGORIES', 'ICAL1011 CLASS', 'ICAL1011 CREATED',
      'ICAL1024 VTIMEZONE']);
    // the VTIMEZONE's earliest onset is 1998-10-25; the event of March 1998 is EST, as the provider says
    assert.strictEqual(zones.compiled['America/New_York'].horizon.start, at('1998-10-25T06:00:00Z'));
    assert.strictEqual(toUtc(calendar.components[0].start, { provider: zones.provider, policy: 'rfc5545' }).instant, at('1998-03-12T13:30:00Z'));
  });

  it('RFC 5545 §4 interop and to-do: METHOD:xyz, the folded TEXT, the VTODO and its VALARM', () => {
    const interop = readFile('rfc5545-section4-interop.ics');
    assert.strictEqual(interop.calendar.method, undefined);
    assert.strictEqual(interop.calendar.components[0].description, 'Discuss how we can test c&s interoperability\nusing iCalendar and other IETF standards.');
    assert.deepStrictEqual(entries(interop.report), ['ICAL1011 METHOD', 'ICAL1011 ORGANIZER', 'ICAL1011 ATTENDEE', 'ICAL1011 CATEGORIES', 'ICAL1011 CLASS', 'ICAL1011 ATTACH']);
    const todo = readFile('rfc5545-section4-todo.ics');
    // the VTODO is reported once, everything inside it with it
    assert.deepStrictEqual([todo.calendar.components, entries(todo.report)], [[], ['ICAL1013 VTODO']]);
  });

  it('a groupware export: a Windows zone name resolves through its VTIMEZONE; text folded inside a code point reads whole', () => {
    const { calendar, report, zones } = readFile('exporter-groupware.ics');
    assert.deepStrictEqual(calendar.components.map((c) => c.uid), ['040000008200E00074C5B7101A82E008', '040000008200E00074C5B7101A82E009']);
    assert.match(calendar.components[1].description, /café-zaal kan \(één uur\)\.$/);
    assert.deepStrictEqual(calendar.components[0].start, { kind: 'zoned', date: '2026-03-02', time: '09:00:00', zone: 'W. Europe Standard Time' });
    // the file's definition (+01:00 in March before the last Sunday) places it; the provider has no such name
    assert.strictEqual(toUtc(calendar.components[0].start, { provider: zones.provider, policy: 'rfc5545' }).instant, at('2026-03-02T08:00:00Z'));
    assert.deepStrictEqual(report.unsupported.filter((e) => e.withheld), []);
    assert.deepStrictEqual(report.counts, { ICAL1011: 8, ICAL1012: 5, ICAL1013: 1 });
  });

  it('a web calendar feed: the zoned series with its excluded, moved and cancelled slots, in its zone', () => {
    const { calendar, report, zones } = readFile('exporter-webcal.ics');
    assert.strictEqual(calendar.method, 'publish');
    const [holiday, standup] = calendar.components;
    assert.deepStrictEqual(holiday.start, { kind: 'date-range', start: '2026-04-27', end: '2026-04-28' });
    assert.match(standup.description, /👋 — wie doet wat; korte updates, geen discussie\. 中文说明在这里继续。$/);
    const starts = expandSeries(standup.series, { horizon: [at('2026-03-01T00:00:00Z'), at('2026-05-01T00:00:00Z')], provider }).occurrences
      .map((o) => new Date(/** @type {number} */ (o.instants?.start)).toISOString().slice(0, 16));
    assert.deepStrictEqual(starts, ['2026-03-02T08:00', '2026-03-09T08:00', '2026-03-17T09:00', '2026-03-30T07:00', '2026-04-13T07:00',
      '2026-04-20T07:00', '2026-04-27T07:00']);
    // its own definition of Europe/Amsterdam answers as the provider does
    const own = expandSeries(standup.series, { horizon: [at('2026-03-01T00:00:00Z'), at('2026-05-01T00:00:00Z')], provider: zones.provider }).occurrences
      .map((o) => new Date(/** @type {number} */ (o.instants?.start)).toISOString().slice(0, 16));
    assert.deepStrictEqual(own, starts);
    // X-LIC-LOCATION inside the VTIMEZONE is reported now that the VTIMEZONE is read
    assert.deepStrictEqual(report.counts, { ICAL1011: 9, ICAL1013: 1, ICAL1016: 2 });
  });

  it('a desktop export: a monthly zoned series, quoted parameters, a floating event, and what is outside', () => {
    const { calendar, report } = readFile('exporter-desktop.ics');
    const [market, board] = calendar.components;
    assert.deepStrictEqual([market.start, market.summary], [{ kind: 'floating', date: '2026-03-14', time: '08:00:00' }, 'Market (local time, wherever you are)']);
    assert.strictEqual(board.location, 'Town Hall, Room A');
    const starts = expandSeries(board.series, { horizon: [at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z')], provider }).occurrences
      .map((o) => new Date(/** @type {number} */ (o.instants?.start)).toISOString().slice(0, 16));
    assert.deepStrictEqual(starts, ['2026-03-10T22:30', '2026-04-14T22:30', '2026-05-12T22:30', '2026-06-09T22:30', '2026-07-14T22:30', '2026-08-11T22:30']);
    assert.deepStrictEqual(entries(report), ['ICAL1013 VALARM', 'ICAL1011 CREATED', 'ICAL1011 TRANSP',
      'ICAL1011 X-APPLE-TRAVEL-ADVISORY-BEHAVIOR', 'ICAL1011 X-APPLE-STRUCTURED-LOCATION', 'ICAL1013 VTODO']);
  });
});

describe('ical reader: what it reads is the writer\'s model', () => {
  const validator = new JarenValidator({ skipErrors: false, collectErrors: true });
  validator.addSchema(temporalSchema);
  validator.addSchema(rruleSchema);
  const check = validator.compile(icalSchema);

  it('every calendar read from the fixtures validates against the model\'s schema, as its JSON copy', () => {
    const names = fs.readdirSync(DIR).filter((name) => name.endsWith('.ics'));
    assert.strictEqual(names.length, 9);
    for (const name of names) {
      const { calendar } = parseIcal(fs.readFileSync(`${DIR}${name}`), { provider });
      const result = check(JSON.parse(JSON.stringify(calendar)));
      assert.strictEqual(result.valid, true, `${name}: ${JSON.stringify(result.errors?.slice(0, 2))}`);
    }
  });
});
