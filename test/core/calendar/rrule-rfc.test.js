//@ts-check

/**
 * RFC 5545 §3.8.5.3, vendored (fixtures/rfc5545-recurrence): every DAILY,
 * WEEKLY, MONTHLY and YEARLY example expands to the RFC's own list in
 * America/New_York (local time and offset alike), and every sub-daily
 * example compiles to the typed refusal that names its frequency.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileRecurrence, defineSeries, expandRecurrence, expandSeries, formatRRule } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import fixture from './fixtures/rfc5545-recurrence/examples.json' with { type: 'json' };

const provider = createIntlZoneProvider({ revision: 'host' });

/**
 * `DTSTART;TZID=America/New_York:19970902T090000` as a zoned value.
 * @param {string} line
 */
function dtstartOf(line) {
  const form = /^DTSTART;TZID=([^:]+):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(line);
  assert.ok(form, line);
  return { kind: /** @type {const} */ ('zoned'), date: `${form[2]}-${form[3]}-${form[4]}`, time: `${form[5]}:${form[6]}:${form[7]}`, zone: form[1] };
}

/**
 * The sub-daily examples, their lists written out by hand from the RFC's
 * `result` text (EDT, -04:00). The "every 3 hours" list follows erratum
 * 3883's corrected UNTIL (17:00 EDT); the rule as printed ends at 13:00.
 * @type {Record<string, { rrule: string, horizon: [string, string], expected: string[] }>}
 */
const SUB_DAILY = {
  'FREQ=HOURLY;INTERVAL=3;UNTIL=19970902T170000Z': { rrule: 'FREQ=HOURLY;INTERVAL=3;UNTIL=19970902T210000Z',
    horizon: ['1997-09-02T00:00:00Z', '1997-09-03T00:00:00Z'], expected: ['1997-09-02T09:00-04:00', '1997-09-02T12:00-04:00', '1997-09-02T15:00-04:00'] },
  'FREQ=MINUTELY;INTERVAL=15;COUNT=6': { rrule: 'FREQ=MINUTELY;INTERVAL=15;COUNT=6',
    horizon: ['1997-09-02T00:00:00Z', '1997-09-03T00:00:00Z'], expected: ['1997-09-02T09:00-04:00', '1997-09-02T09:15-04:00', '1997-09-02T09:30-04:00', '1997-09-02T09:45-04:00', '1997-09-02T10:00-04:00', '1997-09-02T10:15-04:00'] },
  'FREQ=MINUTELY;INTERVAL=90;COUNT=4': { rrule: 'FREQ=MINUTELY;INTERVAL=90;COUNT=4',
    horizon: ['1997-09-02T00:00:00Z', '1997-09-03T00:00:00Z'], expected: ['1997-09-02T09:00-04:00', '1997-09-02T10:30-04:00', '1997-09-02T12:00-04:00', '1997-09-02T13:30-04:00'] },
  // the RFC lists two days of 09:00 to 16:40, 24 starts each
  'FREQ=MINUTELY;INTERVAL=20;BYHOUR=9,10,11,12,13,14,15,16': { rrule: 'FREQ=MINUTELY;INTERVAL=20;BYHOUR=9,10,11,12,13,14,15,16',
    horizon: ['1997-09-02T00:00:00Z', '1997-09-04T04:00:00Z'], expected: [
      '1997-09-02T09:00-04:00', '1997-09-02T09:20-04:00', '1997-09-02T09:40-04:00', '1997-09-02T10:00-04:00', '1997-09-02T10:20-04:00', '1997-09-02T10:40-04:00', '1997-09-02T11:00-04:00', '1997-09-02T11:20-04:00', '1997-09-02T11:40-04:00', '1997-09-02T12:00-04:00', '1997-09-02T12:20-04:00', '1997-09-02T12:40-04:00', '1997-09-02T13:00-04:00', '1997-09-02T13:20-04:00', '1997-09-02T13:40-04:00', '1997-09-02T14:00-04:00', '1997-09-02T14:20-04:00', '1997-09-02T14:40-04:00', '1997-09-02T15:00-04:00', '1997-09-02T15:20-04:00', '1997-09-02T15:40-04:00', '1997-09-02T16:00-04:00', '1997-09-02T16:20-04:00', '1997-09-02T16:40-04:00', '1997-09-03T09:00-04:00', '1997-09-03T09:20-04:00', '1997-09-03T09:40-04:00', '1997-09-03T10:00-04:00', '1997-09-03T10:20-04:00', '1997-09-03T10:40-04:00', '1997-09-03T11:00-04:00', '1997-09-03T11:20-04:00', '1997-09-03T11:40-04:00', '1997-09-03T12:00-04:00', '1997-09-03T12:20-04:00', '1997-09-03T12:40-04:00', '1997-09-03T13:00-04:00', '1997-09-03T13:20-04:00', '1997-09-03T13:40-04:00', '1997-09-03T14:00-04:00', '1997-09-03T14:20-04:00', '1997-09-03T14:40-04:00', '1997-09-03T15:00-04:00', '1997-09-03T15:20-04:00', '1997-09-03T15:40-04:00', '1997-09-03T16:00-04:00', '1997-09-03T16:20-04:00', '1997-09-03T16:40-04:00'] },
};

describe('RFC 5545 §3.8.5.3 examples', () => {
  const rows = /** @type {any[]} */ (fixture.examples);
  const enumerated = rows.filter((row) => row.expected !== undefined);
  const subDaily = rows.filter((row) => row.expected === undefined);

  it('the fixture holds the whole section: 42 rules, 38 with their list in the fixture and 4 sub-daily ones written out here', () => {
    assert.strictEqual(rows.length, 42);
    assert.strictEqual(enumerated.length, 38);
    assert.strictEqual(enumerated.filter((row) => /^FREQ=(MONTHLY|YEARLY);/.test(row.rrule)).length, 23);
    for (const row of rows)
      assert.strictEqual(/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY);/.test(row.rrule), row.expected !== undefined, row.rrule);
    assert.deepStrictEqual(subDaily.map((row) => row.rrule).sort(), Object.keys(SUB_DAILY).sort());
  });

  for (const row of enumerated) {
    it(`${row.title} — ${row.rrule}`, () => {
      const compiled = compileRecurrence({ dtstart: dtstartOf(row.dtstart), rrule: row.rrule });
      assert.strictEqual(formatRRule(compileRecurrence({ dtstart: dtstartOf(row.dtstart), rrule: formatRRule(compiled) })), formatRRule(compiled));
      const horizon = [Date.parse(row.horizon[0]), Date.parse(row.horizon[1])];
      // the Friday-13th example removes its own DTSTART with an EXDATE
      const got = row.exdate === undefined ? expandRecurrence(compiled, { horizon, provider })
        : expandSeries(defineSeries({ uid: 'rfc', base: compiled, exdates: [dtstartOf(row.exdate.replace(/^EXDATE/, 'DTSTART'))] }),
          { horizon, provider });
      assert.strictEqual(got.status, 'complete');
      const local = got.occurrences.map((o) => `${/** @type {any} */ (o.start).date}T${/** @type {any} */ (o.start).time.slice(0, 5)}`);
      assert.deepStrictEqual(local, row.expected.map((/** @type {string} */ text) => text.slice(0, 16)));
      assert.deepStrictEqual(got.occurrences.map((o) => o.instants?.start), row.expected.map((/** @type {string} */ text) => Date.parse(text)));
      assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId),
        row.expected.map((/** @type {string} */ text) => `${text.slice(0, 16)}:00`));
    });
  }

  for (const row of subDaily) {
    it(`${row.title} — ${row.rrule}`, () => {
      const { rrule, horizon, expected } = SUB_DAILY[row.rrule];
      const compiled = compileRecurrence({ dtstart: dtstartOf(row.dtstart), rrule });
      const got = expandRecurrence(compiled, { horizon: [Date.parse(horizon[0]), Date.parse(horizon[1])], provider });
      assert.strictEqual(got.status, 'complete');
      assert.deepStrictEqual(got.occurrences.map((o) => o.instants?.start), expected.map((text) => Date.parse(text)));
      assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId), expected.map((text) => `${text.slice(0, 16)}:00`));
    });
  }

  it('erratum 3883 moves the HOURLY example\'s UNTIL: the rule as printed ends at 13:00 EDT', () => {
    const row = subDaily.find((entry) => entry.rrule.includes('UNTIL'));
    const printed = compileRecurrence({ dtstart: dtstartOf(row.dtstart), rrule: row.rrule });
    const got = expandRecurrence(printed, { horizon: [Date.parse('1997-09-02T00:00:00Z'), Date.parse('1997-09-03T00:00:00Z')], provider });
    assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId), ['1997-09-02T09:00:00', '1997-09-02T12:00:00']);
  });
});
