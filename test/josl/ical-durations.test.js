//@ts-check

/**
 * Exact lengths through `@jarenjs/josl/ical`: a zoned RDATE period's
 * duration, a zoned series of extra dates, an override's own duration
 * and a range over RDATE periods, each read and written so that the
 * calendar layer expands what was written to the instants the model
 * makes (RFC 5545 §3.3.6, §3.8.4.4, §3.8.5.2).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parseIcal, stringifyIcal } from '@jarenjs/josl/ical';
import { compileRecurrence, defineSeries, expandSeries } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider({ revision: 'durations' });
const AMS = 'Europe/Amsterdam';
const cal = (/** @type {string[]} */ lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const vevent = (/** @type {string[]} */ lines) => ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
const ams = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'zoned', date, time, zone: AMS });
const fl = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'floating', date, time });
const YEAR = [Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)];
const FLOATING_YEAR = [{ kind: 'date', date: '2026-01-01' }, { kind: 'date', date: '2027-01-01' }];
/** `id start end` of every occurrence: instants for a zoned or utc series, wall clocks otherwise. @param {any} series */
const rows = (series) => {
  const { kind } = series.base?.dtstart ?? series.rdates[0].start ?? series.rdates[0];
  const zoned = kind === 'zoned' || kind === 'utc';
  return expandSeries(series, { horizon: /** @type {any} */ (zoned ? YEAR : FLOATING_YEAR), provider }).occurrences.map((o) => (zoned
    ? `${o.recurrenceId} ${new Date(/** @type {any} */ (o.instants).start).toISOString()} ${new Date(/** @type {any} */ (o.instants).end).toISOString()}`
    : `${o.recurrenceId} ${/** @type {any} */ (o.start).date}T${/** @type {any} */ (o.start).time} ${/** @type {any} */ (o.end).date}T${/** @type {any} */ (o.end).time}`));
};
const seriesOf = (/** @type {string} */ text) => {
  const { calendar, report } = parseIcal(text, { provider, strict: true });
  assert.deepStrictEqual(report.unsupported, []);
  return /** @type {any} */ (calendar.components[0]).series;
};
const write = (/** @type {any} */ series, /** @type {Record<string, any>} */ options = {}) => stringifyIcal({ prodId: 'p',
  components: [{ type: 'event', series, dtstamp: Date.UTC(2026, 0, 1) }] }, { provider, horizon: [Date.UTC(2025, 11, 1), Date.UTC(2027, 1, 1)], ...options });

describe('ical: a zoned RDATE period given by its duration', () => {
  const text = cal(vevent(['DTSTART;TZID=Europe/Amsterdam:20261024T020000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=1',
    'RDATE;VALUE=PERIOD;TZID=Europe/Amsterdam:20261025T013000/PT2H,20261026T090000/PT1H']));

  it('is read as the end its zone gives it, or as the duration where that end is a repeated hour\'s second pass', () => {
    const series = seriesOf(text);
    assert.deepStrictEqual(series.rdates, [{ start: ams('2026-10-25', '01:30:00'), duration: 'PT2H' },
      { start: ams('2026-10-26', '09:00:00'), end: ams('2026-10-26', '10:00:00') }]);
    // 01:30 CEST is 23:30Z; two hours on is 01:30Z, 02:30 CET
    assert.deepStrictEqual(rows(series), ['2026-10-24T02:00:00 2026-10-24T00:00:00.000Z 2026-10-24T01:00:00.000Z',
      '2026-10-25T01:30:00 2026-10-24T23:30:00.000Z 2026-10-25T01:30:00.000Z', '2026-10-26T09:00:00 2026-10-26T08:00:00.000Z 2026-10-26T09:00:00.000Z']);
  });

  it('is written back by its duration under zones: \'embed\', and reads back to the same instants', () => {
    const series = seriesOf(text);
    const out = write(series, { zones: 'embed' });
    assert.ok(out.includes('RDATE;VALUE=PERIOD;TZID=Europe/Amsterdam:20261025T013000/PT2H\r\n'), out);
    assert.deepStrictEqual(rows(seriesOf(out)), rows(series));
  });

  it('a duration period of a floating series is written by its duration', () => {
    const series = defineSeries({ uid: 's', base: compileRecurrence({ dtstart: fl('2026-03-02', '09:00:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;COUNT=2' }),
      rdates: [{ start: fl('2026-03-04', '09:00:00'), duration: 'PT3H' }] });
    const out = write(series);
    assert.ok(out.includes('RDATE;VALUE=PERIOD:20260304T090000/PT3H\r\n'), out);
    assert.deepStrictEqual(rows(seriesOf(out)), rows(series));
  });
});

describe('ical: a zoned series of extra dates', () => {
  it('gives each RDATE its DURATION from its own start', () => {
    const series = seriesOf(cal(vevent(['DTSTART;TZID=Europe/Amsterdam:20260302T090000', 'DURATION:PT1H', 'RDATE;TZID=Europe/Amsterdam:20261025T020000'])));
    assert.deepStrictEqual(series.rdates[1], { start: ams('2026-10-25', '02:00:00'), duration: 'PT1H' });
    assert.deepStrictEqual(rows(series)[1], '2026-10-25T02:00:00 2026-10-25T00:00:00.000Z 2026-10-25T01:00:00.000Z');
  });

  it('gives each RDATE the exact time between DTSTART and a zoned DTEND (RFC 5545 §3.8.5.3)', () => {
    // 01:30 to 03:30 on 10-24 is two hours; from 01:30 on 10-25, the change day, two hours end at 02:30 CET
    const series = seriesOf(cal(vevent(['DTSTART;TZID=Europe/Amsterdam:20261024T013000', 'DTEND;TZID=Europe/Amsterdam:20261024T033000',
      'RDATE;TZID=Europe/Amsterdam:20261025T013000'])));
    assert.deepStrictEqual(rows(series), ['2026-10-24T01:30:00 2026-10-23T23:30:00.000Z 2026-10-24T01:30:00.000Z',
      '2026-10-25T01:30:00 2026-10-24T23:30:00.000Z 2026-10-25T01:30:00.000Z']);
    // written as its occurrences' UTC instants, as a zoned series of extra dates is
    assert.deepStrictEqual(rows(seriesOf(write(series, { zones: 'embed' }))).map((row) => row.slice(-50)), rows(series).map((row) => row.slice(-50)));
  });
});

describe('ical: an override with its own duration', () => {
  const moved = { recurrenceId: '2026-03-03T09:00:00', status: 'moved', start: fl('2026-03-03', '11:00:00'), duration: 'PT2H' };

  it('is written with that DURATION, not the series\' length', () => {
    const series = defineSeries({ uid: 's', base: compileRecurrence({ dtstart: fl('2026-03-02', '09:00:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=3' }),
      overrides: [moved] });
    const out = write(series);
    assert.ok(out.includes('RECURRENCE-ID:20260303T090000\r\nDTSTART:20260303T110000\r\nDURATION:PT2H\r\n'), out);
    assert.deepStrictEqual(rows(seriesOf(out)), rows(series));
    assert.strictEqual(rows(series)[1], '2026-03-03T09:00:00 2026-03-03T11:00:00 2026-03-03T13:00:00');
  });

  it('zoned under zones: \'embed\', ending in a repeated hour\'s second pass, reads back to the same instants', () => {
    const series = defineSeries({ uid: 's', base: compileRecurrence({ dtstart: ams('2026-10-24', '02:00:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=3' }),
      overrides: [{ recurrenceId: '2026-10-25T02:00:00', status: 'moved', start: ams('2026-10-25', '01:30:00'), duration: 'PT2H' }] });
    const out = write(series, { zones: 'embed' });
    assert.ok(out.includes('DTSTART;TZID=Europe/Amsterdam:20261025T013000\r\nDURATION:PT2H\r\n'), out);
    assert.deepStrictEqual(rows(seriesOf(out)), rows(series));
  });

  it('on an RDATE period\'s slot, a DURATION equal to the series\' is its length, not the period\'s', () => {
    const series = seriesOf(cal([...vevent(['DTSTART:20260302T090000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=2', 'RDATE;VALUE=PERIOD:20260310T090000/PT3H']),
      ...vevent(['RECURRENCE-ID:20260310T090000', 'DTSTART:20260310T100000', 'DURATION:PT1H'])]));
    assert.deepStrictEqual(rows(series)[2], '2026-03-10T09:00:00 2026-03-10T10:00:00 2026-03-10T11:00:00');
  });
});

describe('ical: a range over this and future occurrences, in a series with RDATE periods', () => {
  const base = compileRecurrence({ dtstart: fl('2026-03-02', '09:00:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;COUNT=4' });
  const rdates = [{ start: fl('2026-03-25', '09:00:00'), duration: 'PT3H' }, { start: fl('2026-03-26', '09:00:00'), end: fl('2026-03-26', '09:30:00') }];
  const range = { recurrenceId: '2026-03-16T09:00:00', status: 'moved', start: fl('2026-03-16', '10:00:00'), range: 'THISANDFUTURE' };

  it('shifts later periods and keeps each one\'s own length where the range keeps its slot\'s', () => {
    const series = defineSeries({ uid: 's', base, rdates, overrides: [range] });
    const out = write(series);
    assert.deepStrictEqual(rows(seriesOf(out)), rows(series));
    assert.deepStrictEqual(rows(series).slice(2), ['2026-03-16T09:00:00 2026-03-16T10:00:00 2026-03-16T11:00:00',
      '2026-03-23T09:00:00 2026-03-23T10:00:00 2026-03-23T11:00:00', '2026-03-25T09:00:00 2026-03-25T10:00:00 2026-03-25T13:00:00',
      '2026-03-26T09:00:00 2026-03-26T10:00:00 2026-03-26T10:30:00']);
  });

  it('gives every later slot its own length where it changes its slot\'s', () => {
    for (const own of [{ duration: 'PT20M' }, { end: fl('2026-03-16', '10:20:00') }]) {
      const series = defineSeries({ uid: 's', base, rdates, overrides: [{ ...range, ...own }] });
      assert.deepStrictEqual(rows(seriesOf(write(series))), rows(series), JSON.stringify(own));
      assert.deepStrictEqual(rows(series).slice(4).map((row) => row.slice(-8)), ['10:20:00', '10:20:00'], JSON.stringify(own));
    }
  });

  it('reads a range whose DTEND keeps its own slot\'s length without one, so a later period keeps its own', () => {
    const series = seriesOf(cal([...vevent(['DTSTART:20260302T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=4', 'RDATE;VALUE=PERIOD:20260325T090000/PT3H']),
      ...vevent(['RECURRENCE-ID;RANGE=THISANDFUTURE:20260316T090000', 'DTSTART:20260316T100000', 'DTEND:20260316T110000'])]));
    assert.deepStrictEqual(series.overrides, [{ recurrenceId: '2026-03-16T09:00:00', status: 'moved', start: fl('2026-03-16', '10:00:00'), range: 'THISANDFUTURE' }]);
    assert.strictEqual(rows(series)[4], '2026-03-25T09:00:00 2026-03-25T10:00:00 2026-03-25T13:00:00');
  });

  it('refuses only a range that names its own slot\'s length for later slots of other lengths (ICAL3016)', () => {
    const series = defineSeries({ uid: 's', base, rdates, overrides: [{ ...range, duration: 'PT1H' }] });
    assert.throws(() => write(series), { code: 'ICAL3016', docPath: '/components/0/series/overrides/0/range' });
    // a range on a period's slot, of that period's length: the rule's later slots last otherwise
    const onPeriod = defineSeries({ uid: 's', base: compileRecurrence({ dtstart: fl('2026-03-02', '09:00:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;COUNT=6' }),
      rdates: [rdates[0]], overrides: [{ recurrenceId: '2026-03-25T09:00:00', status: 'moved', start: fl('2026-03-25', '10:00:00'), duration: 'PT3H', range: 'THISANDFUTURE' }] });
    assert.throws(() => write(onPeriod), { code: 'ICAL3016' });
    // without the periods it names what every later slot has
    const plain = defineSeries({ uid: 's', base, overrides: [{ ...range, duration: 'PT1H' }] });
    assert.deepStrictEqual(rows(seriesOf(write(plain))), rows(plain));
  });
});
