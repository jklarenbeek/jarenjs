//@ts-check

/**
 * A zoned series whose RDATE or EXDATE is utc or in another zone: the
 * reader takes each with its own TZID, the writer under `zones: 'embed'`
 * writes each with its own (and that zone's VTIMEZONE), and `patchIcal`
 * never takes such an EXDATE for the slot its wall clock spells.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parseIcal, patchIcal, stringifyIcal } from '@jarenjs/josl/ical';
import { compileRecurrence, defineSeries, expandSeries } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider({ revision: 'foreign' });
const at = (/** @type {string} */ text) => Date.parse(text);
const horizon = /** @type {[number, number]} */ ([at('2026-03-01T00:00:00Z'), at('2026-05-01T00:00:00Z')]);
const z = (/** @type {string} */ date, /** @type {string} */ time, zone = 'Europe/Amsterdam') => ({ kind: 'zoned', date, time, zone });
const cal = (/** @type {string[]} */ lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
/** @param {any} series @param {any} zones */
const instants = (series, zones = provider) => expandSeries(series, { horizon, provider: zones }).occurrences
  .map((o) => `${o.recurrenceId} ${new Date(/** @type {any} */ (o.instants).start).toISOString().slice(0, 16)}`);

const SERIES = { uid: 'f', base: { dtstart: z('2026-03-02', '09:00:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;COUNT=6' },
  rdates: [z('2026-03-04', '09:00:00', 'America/New_York'), { start: z('2026-03-05', '09:00:00', 'America/New_York'), end: z('2026-03-05', '10:00:00', 'America/New_York') },
    { start: { kind: 'utc', instant: '2026-03-06T12:00:00Z' }, end: z('2026-03-06', '14:00:00', 'America/New_York') }],
  exdates: [{ kind: 'utc', instant: '2026-03-09T08:00:00Z' }, z('2026-03-16', '04:00:00', 'America/New_York')] };
const WANT = ['2026-03-02T09:00:00 2026-03-02T08:00', '2026-03-04T15:00:00 2026-03-04T14:00', '2026-03-05T15:00:00 2026-03-05T14:00',
  '2026-03-06T13:00:00 2026-03-06T12:00', '2026-03-23T09:00:00 2026-03-23T08:00', '2026-03-30T09:00:00 2026-03-30T07:00',
  '2026-04-06T09:00:00 2026-04-06T07:00'];

describe('ical: RDATE and EXDATE in another zone or utc', () => {
  it('the source series makes these occurrences', () => {
    assert.deepStrictEqual(instants(defineSeries({ ...SERIES, base: compileRecurrence(/** @type {any} */ (SERIES.base)) })), WANT);
  });

  it('is written under zones: \'embed\' with each value\'s own TZID or as UTC, and reads back to the same occurrences', () => {
    const text = stringifyIcal({ prodId: 'p', components: [{ type: 'event', dtstamp: 0, series: SERIES }] }, { zones: 'embed', provider, horizon });
    const lines = text.split('\r\n');
    assert.deepStrictEqual(lines.filter((line) => /^(RDATE|EXDATE)/.test(line)), [
      'RDATE;TZID=America/New_York:20260304T090000',
      'RDATE;VALUE=PERIOD;TZID=America/New_York:20260305T090000/20260305T100000',
      'RDATE;VALUE=PERIOD:20260306T120000Z/20260306T190000Z',
      'EXDATE:20260309T080000Z',
      'EXDATE;TZID=America/New_York:20260316T040000']);
    assert.deepStrictEqual(lines.filter((line) => line.startsWith('TZID:')), ['TZID:Europe/Amsterdam', 'TZID:America/New_York']);
    const { calendar, report, zones } = parseIcal(text, { provider, strict: true });
    assert.deepStrictEqual(report.unsupported, []);
    const read = /** @type {any} */ (calendar.components[0]).series;
    assert.deepStrictEqual(read.exdates, SERIES.exdates);
    assert.deepStrictEqual(instants(read, zones.provider), WANT);
  });

  it('is written under zones: \'utc\' by its occurrences, the same instants', () => {
    const text = stringifyIcal({ prodId: 'p', components: [{ type: 'event', dtstamp: 0, series: SERIES }] }, { zones: 'utc', provider, horizon });
    const read = /** @type {any} */ (parseIcal(text, { provider, strict: true }).calendar.components[0]).series;
    assert.deepStrictEqual(instants(read).map((row) => row.split(' ')[1]), WANT.map((row) => row.split(' ')[1]));
  });

  it('reads each RDATE and EXDATE with its own TZID', () => {
    const { calendar, report } = parseIcal(cal(['BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000',
      'RRULE:FREQ=WEEKLY;COUNT=3', 'RDATE;TZID=America/New_York:20260304T090000', 'EXDATE:20260309T080000Z', 'END:VEVENT']), { provider });
    assert.deepStrictEqual(report.unsupported, []);
    const series = /** @type {any} */ (calendar.components[0]).series;
    assert.deepStrictEqual([series.rdates, series.exdates], [[z('2026-03-04', '09:00:00', 'America/New_York')], [{ kind: 'utc', instant: '2026-03-09T08:00:00Z' }]]);
    assert.deepStrictEqual(instants(series), ['2026-03-02T09:00:00 2026-03-02T08:00', '2026-03-04T15:00:00 2026-03-04T14:00', '2026-03-16T09:00:00 2026-03-16T08:00']);
  });

  it('patchIcal: an EXDATE in another zone whose wall clock spells another slot does not make cancelling that slot a no-op', () => {
    // EXDATE 2026-03-02T09:00 New York is 15:00 Amsterdam: it removes no slot; the slot 2026-03-02T09:00 Amsterdam stays
    const text = cal(['BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000',
      'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;TZID=America/New_York:20260302T090000', 'END:VEVENT']);
    const { tree, calendar } = parseIcal(text, { mode: 'lossless', provider });
    assert.strictEqual(instants(/** @type {any} */ (calendar.components[0]).series).length, 3);
    for (const op of ['cancel', 'exdate']) {
      const out = /** @type {string} */ (patchIcal(tree, [{ op: /** @type {any} */ (op), uid: 'r', recurrenceId: '2026-03-02T09:00:00' }]));
      assert.notStrictEqual(out, text, op);
      assert.deepStrictEqual(instants(/** @type {any} */ (parseIcal(out, { provider }).calendar.components[0]).series),
        ['2026-03-03T09:00:00 2026-03-03T08:00', '2026-03-04T09:00:00 2026-03-04T08:00'], op);
    }
  });
});
