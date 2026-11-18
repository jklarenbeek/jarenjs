//@ts-check

/**
 * SECONDLY, MINUTELY and HOURLY series through the writer and the reader:
 * every rule of the python-dateutil sub-daily oracle
 * (test/core/calendar/fixtures/rrule-oracle-subdaily) written with its
 * rule, read back, and expanded to the oracle's starts; a start the rule
 * does not make; and a zoned series read through the file's own
 * VTIMEZONE, whose compiled definition lists its offset changes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parseIcal, stringifyIcal } from '@jarenjs/josl/ical';
import { compileRecurrence, defineSeries, expandSeries } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import fixture from '../core/calendar/fixtures/rrule-oracle-subdaily/occurrences.json' with { type: 'json' };
import { tableProvider } from '../core/calendar/oracle.js';

const provider = createIntlZoneProvider({ revision: 'subdaily' });
const LIMITS = { maxOccurrences: 100000, maxWork: 10000000 };

/** @param {string} text */
const wallOf = (text) => Date.parse(text.endsWith('Z') ? text : `${text}Z`);
/** @param {number} wall @param {boolean} utc */
const valueAt = (wall, utc) => {
  const text = new Date(wall).toISOString();
  return utc ? { kind: 'utc', instant: `${text.slice(0, 19)}Z` } : { kind: 'floating', date: text.slice(0, 10), time: text.slice(11, 19) };
};
/** @param {number} wall @param {boolean} utc */
const idOf = (wall, utc) => new Date(wall).toISOString().slice(0, 19) + (utc ? 'Z' : '');

/**
 * Write one series, read it back strictly.
 * @param {any} series
 * @param {any} [options]
 */
function roundTrip(series, options = {}) {
  const text = stringifyIcal({ prodId: '-//Test//EN', components: [{ type: 'event', dtstamp: 0, series }] }, options);
  const { calendar, report } = parseIcal(text, { provider, strict: true });
  assert.deepStrictEqual(report.unsupported, []);
  return { text, series: /** @type {any} */ (calendar.components[0]).series };
}

describe('ical sub-daily: the dateutil oracle written and read back', () => {
  const cases = /** @type {[string, string, string, number[]][]} */ (fixture.cases);

  it('every one of the 600 rules, floating and utc, reads back to the oracle\'s starts over its horizon', () => {
    assert.strictEqual(cases.length, 600);
    let occurrences = 0;
    for (const [rule, dtstart, end, offsets] of cases) {
      const utc = dtstart.endsWith('Z');
      const start = wallOf(dtstart);
      const read = roundTrip({ uid: 'o', base: { dtstart: valueAt(start, utc), rrule: rule } }, { limits: LIMITS }).series;
      const expansion = expandSeries(read, { horizon: /** @type {any} */ ([valueAt(start, utc), valueAt(wallOf(end), utc)]), limits: LIMITS });
      assert.strictEqual(expansion.status, 'complete', rule);
      assert.deepStrictEqual(expansion.occurrences.map((o) => o.recurrenceId), offsets.map((s) => idOf(start + s * 1000, utc)), `${rule} from ${dtstart}`);
      occurrences += offsets.length;
    }
    assert.ok(occurrences > 10000, `${occurrences}`);
  });
});

describe('ical sub-daily: a start the rule does not make', () => {
  const floating = (/** @type {string} */ time) => ({ kind: 'floating', date: '2026-03-02', time });
  const horizon = /** @type {any} */ ([floating('00:00:00'), { kind: 'floating', date: '2026-03-04', time: '00:00:00' }]);
  const ids = (/** @type {any} */ series) => expandSeries(series, { horizon }).occurrences.map((o) => o.recurrenceId.slice(11));

  for (const [rule, want] of /** @type {const} */ ([
    ['FREQ=HOURLY;BYMINUTE=30;COUNT=3', ['09:00:00', '09:30:00', '10:30:00']],
    ['FREQ=MINUTELY;BYSECOND=0,30;BYSETPOS=2;COUNT=3', ['09:00:00', '09:00:30', '09:01:30']],
    ['FREQ=SECONDLY;INTERVAL=20;BYHOUR=10;COUNT=2', ['09:00:00', '10:00:00']],
  ])) {
    it(`${rule}: DTSTART written also as an RDATE and COUNT as UNTIL; the same set read back`, () => {
      const source = defineSeries({ uid: 'n', base: compileRecurrence({ dtstart: floating('09:00:00'), rrule: rule }) });
      assert.deepStrictEqual(ids(source), want);
      const { text, series } = roundTrip({ uid: 'n', base: { dtstart: floating('09:00:00'), rrule: rule } });
      assert.match(text, /\r\nRDATE:20260302T090000\r\n/);
      assert.match(text, /RRULE:[^\r]*UNTIL=/);
      assert.deepStrictEqual(ids(series), want);
    });
  }

  it('a start the rule makes is written once, with its rule as given', () => {
    const { text } = roundTrip({ uid: 'm', base: { dtstart: floating('09:30:00'), rrule: 'FREQ=HOURLY;BYMINUTE=30;COUNT=3' } });
    assert.match(text, /\r\nRRULE:FREQ=HOURLY;COUNT=3;BYMINUTE=30\r\n/);
    assert.doesNotMatch(text, /RDATE/);
  });
});

describe('ical sub-daily: zoned, through the file\'s VTIMEZONE', () => {
  const at = (/** @type {string} */ text) => Date.parse(text);
  const horizon = /** @type {[number, number]} */ ([at('2026-03-01T00:00:00Z'), at('2026-04-01T00:00:00Z')]);
  const base = { dtstart: { kind: 'zoned', date: '2026-03-28', time: '22:00:00', zone: 'Europe/Amsterdam' }, rrule: 'FREQ=MINUTELY;INTERVAL=30' };
  const text = stringifyIcal({ prodId: '-//Test//EN', components: [{ type: 'event', dtstamp: 0, series: { uid: 'z', base } }] },
    { zones: 'embed', provider, horizon });
  const { calendar, report, zones } = parseIcal(text, { provider, strict: true });
  const series = /** @type {any} */ (calendar.components[0]).series;
  const instants = (/** @type {any} */ answer) => answer.occurrences.map((/** @type {any} */ o) => o.instants.start);

  it('reads back to the source provider\'s instants across the March change', () => {
    assert.deepStrictEqual(report.unsupported, []);
    const span = [at('2026-03-28T20:00:00Z'), at('2026-03-29T04:00:00Z')];
    const source = expandSeries(defineSeries({ uid: 'z', base: compileRecurrence(/** @type {any} */ (base)) }), { horizon: span, provider });
    const read = expandSeries(series, { horizon: span, provider: zones.provider });
    assert.strictEqual(read.status, 'complete');
    assert.deepStrictEqual(instants(read), instants(source));
    // 01:30Z is 02:30 standard time, which the change skips; 02:00 and 02:30 resolve to 03:00 and 03:30
    assert.ok(instants(read).includes(at('2026-03-29T01:30:00Z')));
  });

  it('a TZID the file does not define routes to the caller\'s provider, which lists no changes: resolved time by time, exactly', () => {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', 'BEGIN:VEVENT', 'UID:n', 'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=Europe/Amsterdam:20260329T013000', 'RRULE:FREQ=MINUTELY;INTERVAL=20;COUNT=6', 'END:VEVENT', 'END:VCALENDAR', ''];
    const read = parseIcal(lines.join('\r\n'), { provider });
    const only = /** @type {any} */ (read.calendar.components[0]).series;
    assert.strictEqual(typeof read.zones.provider.offsetChanges, 'function');
    const span = [at('2026-03-28T00:00:00Z'), at('2026-03-30T00:00:00Z')];
    const through = expandSeries(only, { horizon: span, provider: read.zones.provider });
    assert.deepStrictEqual(instants(through), instants(expandSeries(only, { horizon: span, provider })));
    assert.deepStrictEqual(instants(through).map((t) => new Date(t).toISOString().slice(11, 16)), ['00:30', '00:50', '01:10', '01:10', '01:30', '01:50']);
  });

  it('a caller\'s provider with no list, a change and its undoing inside one hour: the read\'s provider never claims the hour clean', () => {
    // +01:00, then +00:40 from 01:30Z to 01:40Z: wall 02:30-02:39 lies at 01:50Z-01:59Z, though the hour's ends are an hour apart
    const table = { initial: 60, changes: [{ at: at('2026-03-10T01:30:00Z'), before: 60, after: 40 }, { at: at('2026-03-10T01:40:00Z'), before: 40, after: 60 }] };
    const listed = tableProvider('Etc/Synthetic', table);
    const unlisted = { toParts: listed.toParts, toEpoch: listed.toEpoch, candidates: listed.candidates, identity: listed.identity };
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', 'BEGIN:VEVENT', 'UID:x', 'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=Etc/Synthetic:20260310T000000', 'RRULE:FREQ=MINUTELY;INTERVAL=3', 'END:VEVENT', 'END:VCALENDAR', ''];
    const read = parseIcal(lines.join('\r\n'), { provider: unlisted });
    const series = /** @type {any} */ (read.calendar.components[0]).series;
    const span = [at('2026-03-10T01:45:00Z'), at('2026-03-10T02:05:00Z')];
    const through = instants(expandSeries(series, { horizon: span, provider: read.zones.provider }));
    assert.deepStrictEqual(through, instants(expandSeries(series, { horizon: span, provider: listed })));
    assert.ok(through.includes(at('2026-03-10T01:50:00Z')));
  });

  it('the read\'s provider lists the compiled offset changes, so a zoned SECONDLY walk asks it per hour, not per second, as the Intl provider\'s list does', () => {
    assert.strictEqual(typeof zones.provider.offsetChanges, 'function');
    assert.deepStrictEqual(zones.provider.offsetChanges(at('2026-03-01T00:00:00Z'), at('2026-03-31T00:00:00Z'), 'Europe/Amsterdam')
      .map((/** @type {any} */ change) => [new Date(change.at).toISOString(), change.before, change.after]),
    [['2026-03-29T01:00:00.000Z', 60, 120]]);
    // a day clear of the change: the hours before the horizon are each asked once (the calendar layer resolves time by
    // time from the first hour that holds a change on)
    const secondly = defineSeries({ uid: 's', base: compileRecurrence(/** @type {any} */ ({
      dtstart: { ...base.dtstart, date: '2026-03-30' }, rrule: 'FREQ=SECONDLY;INTERVAL=7' })) });
    const span = [at('2026-03-31T12:00:00Z'), at('2026-03-31T12:01:00Z')];
    const options = { horizon: span, limits: { maxProviderCalls: 200 } };
    const read = expandSeries(secondly, { ...options, provider: zones.provider });
    assert.strictEqual(read.status, 'complete');
    // the Intl provider lists its changes too: the same walk, under the same limit, completes with the same instants
    const intl = expandSeries(secondly, { ...options, provider });
    assert.strictEqual(intl.status, 'complete');
    assert.deepStrictEqual(instants(intl), instants(read));
    const roomy = expandSeries(secondly, { horizon: span, provider, limits: { maxProviderCalls: 1000000 } });
    assert.deepStrictEqual(instants(read), instants(roomy));
  });
});
