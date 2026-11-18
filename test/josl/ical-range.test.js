//@ts-check

/**
 * Overrides over this and future occurrences (RFC 5545 §3.8.4.4,
 * RECURRENCE-ID;RANGE=THISANDFUTURE) written and read back: a series
 * written with its rule writes each as its slot's VEVENT with RANGE (a
 * cancelled one with STATUS:CANCELLED), one written by its occurrences
 * writes the expansion; and a one-slot override after a range lasts what
 * its own VEVENT says.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parseIcal, patchIcal, stringifyIcal } from '@jarenjs/josl/ical';
import { compileRecurrence, defineSeries, expandSeries } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider({ revision: 'range' });
const at = (/** @type {string} */ text) => Date.parse(text);
const HORIZON = /** @type {[number, number]} */ ([at('2026-03-01T00:00:00Z'), at('2026-06-01T00:00:00Z')]);
const f = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'floating', date, time });
const z = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'zoned', date, time, zone: 'Europe/Amsterdam' });
const cal = (/** @type {string[]} */ lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');

/** `id start end` per occurrence, as instants for a zoned series. @param {any} series @param {any} [zones] */
function rows(series, zones = provider) {
  const kind = (series.base?.dtstart ?? series.rdates[0].start ?? series.rdates[0]).kind;
  const horizon = kind === 'floating' ? [f('2026-03-01', '00:00:00'), f('2026-06-01', '00:00:00')] : HORIZON;
  const answer = expandSeries(series, { horizon: /** @type {any} */ (horizon), provider: zones });
  assert.strictEqual(answer.status, 'complete');
  const place = (/** @type {any} */ value, /** @type {number | undefined} */ instant) => (instant !== undefined
    ? new Date(instant).toISOString().slice(0, 16) : `${value.date}T${value.time.slice(0, 5)}`);
  return answer.occurrences.map((o) => `${o.recurrenceId} ${place(o.start, o.instants?.start)} ${place(o.end, o.instants?.end)}`);
}

/** @param {any} series @param {any} options */
function roundTrip(series, options) {
  const text = stringifyIcal({ prodId: 'p', components: [{ type: 'event', dtstamp: 0, series }] }, options);
  const { calendar, report, zones } = parseIcal(text, { provider, strict: true });
  assert.deepStrictEqual(report.unsupported, []);
  return { text, series: /** @type {any} */ (calendar.components[0]).series, zones };
}

const defined = (/** @type {any} */ series) => defineSeries({ ...series, base: compileRecurrence(series.base) });

describe('ical writer: overrides over this and future occurrences', () => {
  const floating = { uid: 'r', base: { dtstart: f('2026-03-02', '09:00:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=10' }, overrides: [
    { recurrenceId: '2026-03-04T09:00:00', status: 'moved', start: f('2026-03-04', '10:00:00'), end: f('2026-03-04', '10:30:00'), range: 'THISANDFUTURE' },
    { recurrenceId: '2026-03-06T09:00:00', status: 'moved', start: f('2026-03-06', '12:00:00') },
    { recurrenceId: '2026-03-07T09:00:00', status: 'moved', start: f('2026-03-07', '08:00:00'), range: 'THISANDFUTURE' },
    { recurrenceId: '2026-03-09T09:00:00', status: 'cancelled', range: 'THISANDFUTURE' }] };

  it('a floating series with its rule: each range its VEVENT with RANGE, a one-slot override after it the range\'s length', () => {
    const { text, series } = roundTrip(floating, {});
    const lines = text.split('\r\n');
    assert.deepStrictEqual(lines.filter((line) => line.startsWith('RECURRENCE-ID')), ['RECURRENCE-ID;RANGE=THISANDFUTURE:20260304T090000',
      'RECURRENCE-ID:20260306T090000', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260307T090000', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260309T090000']);
    assert.ok(text.includes('RECURRENCE-ID:20260306T090000\r\nDTSTART:20260306T120000\r\nDURATION:PT30M\r\n'));
    assert.ok(text.includes('RECURRENCE-ID;RANGE=THISANDFUTURE:20260309T090000\r\nDTSTART:20260309T090000\r\nSTATUS:CANCELLED\r\n'));
    assert.deepStrictEqual(rows(series), rows(defined(floating)));
    assert.deepStrictEqual(rows(series), ['2026-03-02T09:00:00 2026-03-02T09:00 2026-03-02T10:00', '2026-03-03T09:00:00 2026-03-03T09:00 2026-03-03T10:00',
      '2026-03-04T09:00:00 2026-03-04T10:00 2026-03-04T10:30', '2026-03-05T09:00:00 2026-03-05T10:00 2026-03-05T10:30',
      '2026-03-06T09:00:00 2026-03-06T12:00 2026-03-06T12:30', '2026-03-07T09:00:00 2026-03-07T08:00 2026-03-07T09:00',
      '2026-03-08T09:00:00 2026-03-08T08:00 2026-03-08T09:00']);
  });

  it('a zoned series under zones: \'embed\' keeps its rule and its ranges, across the March change', () => {
    const zoned = { uid: 'z', base: { dtstart: z('2026-03-26', '09:00:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=6' }, overrides: [
      { recurrenceId: '2026-03-28T09:00:00', status: 'moved', start: z('2026-03-28', '11:00:00'), range: 'THISANDFUTURE' }] };
    const { text, series, zones } = roundTrip(zoned, { zones: 'embed', provider, horizon: HORIZON });
    assert.ok(text.includes('RRULE:FREQ=DAILY;COUNT=6\r\n'));
    assert.ok(text.includes('RECURRENCE-ID;TZID=Europe/Amsterdam;RANGE=THISANDFUTURE:20260328T090000\r\nDTSTART;TZID=Europe/Amsterdam:20260328T110000\r\n'));
    assert.deepStrictEqual(rows(series, zones.provider), rows(defined(zoned)));
    assert.deepStrictEqual(rows(series, zones.provider).slice(2, 4), ['2026-03-28T09:00:00 2026-03-28T10:00 2026-03-28T11:00',
      '2026-03-29T09:00:00 2026-03-29T09:00 2026-03-29T10:00']);
  });

  it('a zoned series under zones: \'utc\' is written by its occurrences, the ranges expanded', () => {
    const zoned = { uid: 'z', base: { dtstart: z('2026-03-26', '09:00:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=6' }, overrides: [
      { recurrenceId: '2026-03-28T09:00:00', status: 'moved', start: z('2026-03-28', '11:00:00'), end: z('2026-03-28', '11:20:00'), range: 'THISANDFUTURE' }] };
    const { text, series } = roundTrip(zoned, { zones: 'utc', provider, horizon: HORIZON });
    assert.doesNotMatch(text, /RANGE/);
    const instants = (/** @type {string[]} */ list) => list.map((row) => row.split(' ').slice(1).join(' '));
    assert.deepStrictEqual(instants(rows(series)), instants(rows(defined(zoned))));
  });
});

describe('ical reader: a one-slot override after a range lasts what its own VEVENT says', () => {
  it('a DURATION equal to the series\' is its length, not the range\'s', () => {
    const text = cal(['BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260302T090000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=5', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260303T090000', 'DTSTART:20260303T100000', 'DURATION:PT30M', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20260305T090000', 'DTSTART:20260305T140000', 'DURATION:PT1H', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20260306T090000', 'DTSTART:20260306T150000', 'DURATION:PT30M', 'END:VEVENT']);
    const { calendar, report } = parseIcal(text, { provider, strict: true });
    assert.deepStrictEqual(report.unsupported, []);
    assert.deepStrictEqual(rows(/** @type {any} */ (calendar.components[0]).series).slice(2), [
      '2026-03-04T09:00:00 2026-03-04T10:00 2026-03-04T10:30', '2026-03-05T09:00:00 2026-03-05T14:00 2026-03-05T15:00',
      '2026-03-06T09:00:00 2026-03-06T15:00 2026-03-06T15:30']);
  });
});

describe('ical reader: a zoned override with its own DURATION', () => {
  const head = ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Amsterdam:20260328T230000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=4', 'END:VEVENT'];
  const override = (/** @type {string} */ id, /** @type {string} */ start, /** @type {string} */ duration) => ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z',
    `RECURRENCE-ID;TZID=Europe/Amsterdam:${id}`, `DTSTART;TZID=Europe/Amsterdam:${start}`, `DURATION:${duration}`, 'END:VEVENT'];

  it('is read: the days on the wall clock, the time exactly, across the March change', () => {
    const { calendar, report } = parseIcal(cal([...head, ...override('20260328T230000', '20260329T010000', 'PT2H'),
      ...override('20260330T230000', '20260330T220000', 'P1DT30M')]), { provider, strict: true });
    assert.deepStrictEqual(report.unsupported, []);
    const series = /** @type {any} */ (calendar.components[0]).series;
    assert.deepStrictEqual(series.overrides.map((/** @type {any} */ o) => o.end), [z('2026-03-29', '04:00:00'), z('2026-03-31', '22:30:00')]);
    assert.deepStrictEqual(rows(series), ['2026-03-28T23:00:00 2026-03-29T00:00 2026-03-29T02:00', '2026-03-29T23:00:00 2026-03-29T21:00 2026-03-29T22:00',
      '2026-03-30T23:00:00 2026-03-30T20:00 2026-03-31T20:30', '2026-03-31T23:00:00 2026-03-31T21:00 2026-03-31T22:00']);
  });

  it('is withheld only where it ends in the second pass of a repeated hour (ICAL1022)', () => {
    const { calendar, report } = parseIcal(cal([...head.map((line) => line.replace('20260328T230000', '20261024T020000')),
      ...override('20261025T020000', '20261025T013000', 'PT2H')]), { provider });
    assert.deepStrictEqual([calendar.components.length, report.unsupported.map((e) => e.code)], [0, ['ICAL1022']]);
    assert.match(report.unsupported[0].reason, /second pass/);
  });
});

describe('ical: the range in force is the latest at or before a slot, whatever order the overrides are listed in', () => {
  const head = ['BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260302T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=8', 'END:VEVENT'];
  const vevent = (/** @type {string[]} */ lines) => ['BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
  // the later range first: 03-30 lasts 20 minutes, 03-16 lasts the series' hour
  const reversed = [...head, ...vevent(['RECURRENCE-ID;RANGE=THISANDFUTURE:20260330T090000', 'DTSTART:20260330T100000', 'DURATION:PT20M']),
    ...vevent(['RECURRENCE-ID;RANGE=THISANDFUTURE:20260316T090000', 'DTSTART:20260316T100000', 'DURATION:PT1H'])];

  it('reader: a one-slot override after both, with the series\' DURATION, keeps that hour', () => {
    const text = cal([...reversed, ...vevent(['RECURRENCE-ID:20260413T090000', 'DTSTART:20260413T140000', 'DURATION:PT1H'])]);
    const series = /** @type {any} */ (parseIcal(text, { provider, strict: true }).calendar.components[0]).series;
    assert.deepStrictEqual(rows(series).slice(2), ['2026-03-16T09:00:00 2026-03-16T10:00 2026-03-16T11:00', '2026-03-23T09:00:00 2026-03-23T10:00 2026-03-23T11:00',
      '2026-03-30T09:00:00 2026-03-30T10:00 2026-03-30T10:20', '2026-04-06T09:00:00 2026-04-06T10:00 2026-04-06T10:20',
      '2026-04-13T09:00:00 2026-04-13T14:00 2026-04-13T15:00', '2026-04-20T09:00:00 2026-04-20T10:00 2026-04-20T10:20']);
  });

  it('writer: a one-slot override after both gets the later range\'s length', () => {
    const series = { uid: 'r', base: { dtstart: f('2026-03-02', '09:00:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;COUNT=8' }, overrides: [
      { recurrenceId: '2026-03-30T09:00:00', status: 'moved', start: f('2026-03-30', '10:00:00'), end: f('2026-03-30', '10:20:00'), range: 'THISANDFUTURE' },
      { recurrenceId: '2026-03-16T09:00:00', status: 'moved', start: f('2026-03-16', '10:00:00'), end: f('2026-03-16', '10:45:00'), range: 'THISANDFUTURE' },
      { recurrenceId: '2026-04-13T09:00:00', status: 'moved', start: f('2026-04-13', '14:00:00') }] };
    const { text, series: read } = roundTrip(series, {});
    assert.ok(text.includes('RECURRENCE-ID:20260413T090000\r\nDTSTART:20260413T140000\r\nDURATION:PT20M\r\n'));
    assert.deepStrictEqual(rows(read), rows(defined(series)));
  });

  it('patchIcal: an occurrence moved after both ends by the later range\'s length', () => {
    const text = cal(reversed);
    const { tree } = /** @type {any} */ (parseIcal(text, { mode: 'lossless', provider }));
    const out = /** @type {string} */ (patchIcal(tree, [{ op: 'move', uid: 'r', recurrenceId: '2026-04-13T09:00:00', start: f('2026-04-14', '08:00:00') }]));
    assert.ok(out.includes('RECURRENCE-ID:20260413T090000\r\nDTSTART:20260414T080000\r\nDTEND:20260414T082000\r\n'));
  });
});

describe('patchIcal: a slot under a cancelled range is gone', () => {
  const text = cal(['BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260302T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=8', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260330T090000', 'DTSTART:20260330T090000', 'STATUS:CANCELLED', 'END:VEVENT']);
  const { tree, calendar } = /** @type {any} */ (parseIcal(text, { mode: 'lossless', provider }));

  it('the series makes four occurrences; a later slot is not moved back into it, and cancelling or excluding it writes nothing', () => {
    assert.strictEqual(rows(calendar.components[0].series).length, 4);
    assert.throws(() => patchIcal(tree, [{ op: 'move', uid: 'r', recurrenceId: '2026-04-13T09:00:00', start: f('2026-04-14', '08:00:00') }]), { code: 'ICAL4004' });
    assert.strictEqual(patchIcal(tree, [{ op: 'cancel', uid: 'r', recurrenceId: '2026-04-13T09:00:00' }]), text);
    assert.strictEqual(patchIcal(tree, [{ op: 'exdate', uid: 'r', recurrenceId: '2026-04-13T09:00:00' }]), text);
  });
});
