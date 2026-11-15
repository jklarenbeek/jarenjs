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

describe('RFC 5545 §3.8.5.3 examples', () => {
  const rows = /** @type {any[]} */ (fixture.examples);
  const enumerated = rows.filter((row) => row.expected !== undefined);
  const refused = rows.filter((row) => row.expected === undefined);

  it('the fixture holds the whole section: 42 rules, 38 of them DAILY, WEEKLY, MONTHLY or YEARLY', () => {
    assert.strictEqual(rows.length, 42);
    assert.strictEqual(enumerated.length, 38);
    assert.strictEqual(enumerated.filter((row) => /^FREQ=(MONTHLY|YEARLY);/.test(row.rrule)).length, 23);
    for (const row of rows)
      assert.strictEqual(/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY);/.test(row.rrule), row.expected !== undefined, row.rrule);
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

  for (const row of refused) {
    const freq = row.rrule.split(';')[0].split('=')[1];
    it(`${row.title} — FREQ=${freq} is refused by name`, () => {
      assert.throws(() => compileRecurrence({ dtstart: dtstartOf(row.dtstart), rrule: row.rrule }), (/** @type {any} */ error) => {
        assert.strictEqual(error.code, 'JY0020');
        assert.strictEqual(error.docPath, 'rrule.FREQ');
        assert.ok(error.message.includes(`FREQ=${freq}`) && error.message.includes('not enumerated in this release'), error.message);
        return true;
      });
    });
  }

  it('each refused row, made malformed, names its fault before its frequency', () => {
    for (const row of refused) {
      const broken = `${row.rrule};BYMINUTE=0,60`;
      assert.throws(() => compileRecurrence({ dtstart: dtstartOf(row.dtstart), rrule: broken }),
        (/** @type {any} */ error) => error.code === (row.rrule.includes('BYMINUTE') ? 'JY0017' : 'JY0016')
          && error.docPath === (row.rrule.includes('BYMINUTE') ? 'rrule.BYMINUTE' : 'rrule.BYMINUTE[1]'), broken);
    }
  });
});
