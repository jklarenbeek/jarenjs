//@ts-check

/**
 * A moved override's and an RDATE period's own duration (RFC 5545
 * §3.3.6: weeks and days on the wall clock, the time exact): its end
 * instant is exact even where its wall clock falls in the second pass of
 * a repeated hour, which an end alone cannot name. The expected ends are
 * derived by hand from the zdump transition rows
 * (fixtures/series-duration/PROVENANCE.md); an end and a duration given
 * together must name one end.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CalendarError, compileRecurrence, dateValue, defineSeries, expandSeries, floatingValue } from '@jarenjs/core/calendar';
import { oracleZone, tableProvider } from './oracle.js';

const ENDS = JSON.parse(readFileSync(new URL('./fixtures/series-duration/ends.json', import.meta.url), 'utf8')).cases;
const TRANSITIONS = JSON.parse(readFileSync(new URL('./fixtures/zone-transitions/transitions.json', import.meta.url), 'utf8'));
const DAY = 86400000;
const at = (/** @type {string} */ text) => Date.parse(text);
/** @param {string} zone @param {string} wall - `YYYY-MM-DDTHH:MM:SS` */
const zoned = (zone, wall) => ({ kind: /** @type {const} */ ('zoned'), date: wall.slice(0, 10), time: wall.slice(11), zone });
const dayBefore = (/** @type {string} */ date, /** @type {number} */ days) => new Date(at(`${date}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
const wallText = (/** @type {any} */ value) => `${value.date}T${value.time}`;
const providers = { 'Europe/Amsterdam': tableProvider('Europe/Amsterdam', oracleZone('Europe/Amsterdam')),
  'America/New_York': tableProvider('America/New_York', oracleZone('America/New_York')) };

/**
 * @param {() => unknown} run
 * @param {string} code
 * @param {string} path
 */
function refuses(run, code, path) {
  assert.throws(run, (/** @type {any} */ error) => {
    assert.ok(error instanceof CalendarError, String(error));
    assert.equal(error.code, code, error.message);
    assert.equal(error.docPath, path, error.message);
    return true;
  });
}

/**
 * A daily 09:00 series of an hour, five slots from three days before
 * `date`, in `zone` under `policy`.
 * @param {string} zone
 * @param {string} date
 * @param {'rfc5545' | 'later'} [policy]
 */
const daily = (zone, date, policy = 'rfc5545') => compileRecurrence({
  dtstart: zoned(zone, `${dayBefore(date, 3)}T09:00:00`), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=5', policy });

/**
 * Expand a zoned series over the days around `date`.
 * @param {any} series
 * @param {string} zone
 * @param {string} date
 */
const around = (series, zone, date) => expandSeries(series, {
  horizon: [at(`${dayBefore(date, 4)}T00:00:00Z`), at(`${dayBefore(date, -4)}T00:00:00Z`)], zoneProvider: /** @type {any} */ (providers)[zone] });

describe('the hand-derived ends, as a moved override and as an RDATE period', () => {
  it('every transition the table names is a row of the zdump table', () => {
    for (const row of ENDS) {
      const found = TRANSITIONS.zones[row.zone].transitions.find((/** @type {any} */ change) => change.at === row.change);
      assert.ok(found, `${row.zone} ${row.change}`);
    }
  });

  for (const row of ENDS) {
    const given = { ...(row.end !== undefined ? { end: zoned(row.zone, row.end) } : {}), ...(row.duration !== undefined ? { duration: row.duration } : {}) };
    const date = row.start.slice(0, 10);
    it(`${row.zone} ${row.name} (${row.policy})`, () => {
      const slot = `${dayBefore(date, 1)}T09:00:00`;
      const moved = defineSeries({ uid: 'm', base: daily(row.zone, date, row.policy),
        overrides: [{ recurrenceId: slot, status: 'moved', start: zoned(row.zone, row.start), ...given }] });
      const occurrence = /** @type {any} */ (around(moved, row.zone, date).occurrences.find((o) => o.recurrenceId === slot));
      assert.equal(occurrence.moved, true);
      assert.equal(new Date(occurrence.instants.end).toISOString().replace('.000', ''), row.endInstant, row.derivation);
      assert.equal(wallText(occurrence.end), row.endWall, row.derivation);
      // the same end on an RDATE period of the series
      const period = defineSeries({ uid: 'p', base: daily(row.zone, date, row.policy), rdates: [{ start: zoned(row.zone, row.start), ...given }] });
      const added = /** @type {any} */ (around(period, row.zone, date).occurrences.find((o) => o.recurrenceId === row.start));
      assert.equal(new Date(added.instants.end).toISOString().replace('.000', ''), row.endInstant, row.derivation);
      assert.equal(wallText(added.end), row.endWall, row.derivation);
    });
  }
});

describe('an end and a duration given together name one end', () => {
  const zone = 'Europe/Amsterdam';
  const base = daily(zone, '2026-10-25');
  const start = zoned(zone, '2026-10-25T01:30:00');

  it('a zoned pair that disagrees is refused at expansion, whatever the horizon', () => {
    const series = defineSeries({ uid: 'x', base,
      overrides: [{ recurrenceId: '2026-10-24T09:00:00', status: 'moved', start, end: zoned(zone, '2026-10-25T02:45:00'), duration: 'PT2H' }] });
    refuses(() => around(series, zone, '2026-10-25'), 'JY0014', '/overrides/0/duration');
    refuses(() => expandSeries(series, { horizon: [at('2026-12-01T00:00:00Z'), at('2026-12-02T00:00:00Z')], zoneProvider: providers[zone] }),
      'JY0014', '/overrides/0/duration');
    const period = defineSeries({ uid: 'y', base, rdates: [{ start, end: zoned(zone, '2026-10-25T03:30:00'), duration: 'PT2H' }] });
    refuses(() => around(period, zone, '2026-10-25'), 'JY0014', '/rdates/0/duration');
  });

  it('a date, floating or utc pair is compared when the series is defined', () => {
    const floating = compileRecurrence({ dtstart: floatingValue('2026-01-05', '09:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=3' });
    refuses(() => defineSeries({ uid: 'f', base: floating, overrides: [{ recurrenceId: '2026-01-06T09:00:00', status: 'moved',
      start: floatingValue('2026-01-06', '10:00'), end: floatingValue('2026-01-06', '11:00'), duration: 'PT90M' }] }), 'JY0014', '/overrides/0/duration');
    const agreed = defineSeries({ uid: 'f', base: floating, overrides: [{ recurrenceId: '2026-01-06T09:00:00', status: 'moved',
      start: floatingValue('2026-01-06', '10:00'), end: floatingValue('2026-01-06', '11:30'), duration: 'PT90M' }] });
    const moved = /** @type {any} */ (expandSeries(agreed, { horizon: [floatingValue('2026-01-05', '00:00'), floatingValue('2026-01-08', '00:00')] })
      .occurrences.find((o) => o.recurrenceId === '2026-01-06T09:00:00'));
    assert.equal(wallText(moved.end), '2026-01-06T11:30:00');
    const dates = compileRecurrence({ dtstart: dateValue('2026-01-05'), rrule: 'FREQ=WEEKLY;COUNT=2' });
    refuses(() => defineSeries({ uid: 'd', base: dates, rdates: [{ start: dateValue('2026-01-07'), end: dateValue('2026-01-08'), duration: 'P2D' }] }),
      'JY0014', '/rdates/0/duration');
    refuses(() => defineSeries({ uid: 'd', base: dates, rdates: [{ start: dateValue('2026-01-07'), duration: 'PT1H' }] }), 'JY0014', '/rdates/0/duration');
    const utc = compileRecurrence({ dtstart: { kind: 'utc', instant: '2026-01-05T09:00:00Z' }, rrule: 'FREQ=DAILY;COUNT=2' });
    refuses(() => defineSeries({ uid: 'u', base: utc, rdates: [{ start: { kind: 'utc', instant: '2026-01-07T09:00:00Z' },
      end: { kind: 'utc', instant: '2026-01-07T10:00:00Z' }, duration: 'PT2H' }] }), 'JY0014', '/rdates/0/duration');
  });
});

describe('a duration on a date, floating or utc series is an end on its wall clock', () => {
  it('floating, date and utc periods and overrides', () => {
    const floating = defineSeries({ uid: 'f',
      base: compileRecurrence({ dtstart: floatingValue('2026-01-05', '09:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=3' }),
      overrides: [{ recurrenceId: '2026-01-06T09:00:00', status: 'moved', start: floatingValue('2026-01-06', '10:00'), duration: 'PT90M' }],
      rdates: [{ start: floatingValue('2026-01-09', '23:00'), duration: 'P1DT2H' }] });
    const got = expandSeries(floating, { horizon: [floatingValue('2026-01-05', '00:00'), floatingValue('2026-01-12', '00:00')] });
    assert.deepEqual(got.occurrences.map((o) => [o.recurrenceId, wallText(o.end)]), [
      ['2026-01-05T09:00:00', '2026-01-05T10:00:00'], ['2026-01-06T09:00:00', '2026-01-06T11:30:00'],
      ['2026-01-07T09:00:00', '2026-01-07T10:00:00'], ['2026-01-09T23:00:00', '2026-01-11T01:00:00']]);
    const dates = defineSeries({ uid: 'd', base: compileRecurrence({ dtstart: dateValue('2026-01-05'), rrule: 'FREQ=WEEKLY;COUNT=1' }),
      rdates: [{ start: dateValue('2026-01-07'), duration: 'P2D' }] });
    const days = expandSeries(dates, { horizon: [dateValue('2026-01-01'), dateValue('2026-02-01')] });
    assert.deepEqual(days.occurrences.map((o) => /** @type {any} */ (o.end).date), ['2026-01-06', '2026-01-09']);
    const utc = defineSeries({ uid: 'u', base: null, rdates: [{ start: { kind: 'utc', instant: '2026-03-29T00:30:00Z' }, duration: 'P1DT1H' }] });
    const instants = expandSeries(utc, { horizon: [at('2026-03-28T00:00:00Z'), at('2026-04-01T00:00:00Z')] });
    assert.equal(/** @type {any} */ (instants.occurrences[0].instants).end, at('2026-03-30T01:30:00Z'));
  });

  it('a series keeps each member as given, and refuses a duration where none is read', () => {
    const base = compileRecurrence({ dtstart: floatingValue('2026-01-05', '09:00'), rrule: 'FREQ=DAILY;COUNT=3' });
    const series = defineSeries({ uid: 's', base, rdates: [{ start: floatingValue('2026-01-09', '09:00'), duration: 'PT1H' },
      { start: floatingValue('2026-01-10', '09:00'), end: floatingValue('2026-01-10', '10:00') }],
    overrides: [{ recurrenceId: '2026-01-06T09:00:00', status: 'moved', start: floatingValue('2026-01-06', '10:00'), duration: 'PT1H' }] });
    assert.deepEqual(Object.keys(series.rdates[0]), ['start', 'duration']);
    assert.deepEqual(Object.keys(series.rdates[1]), ['start', 'end']);
    assert.equal(series.overrides[0].duration, 'PT1H');
    refuses(() => defineSeries({ uid: 's', base, overrides: [{ recurrenceId: '2026-01-06T09:00:00', status: 'cancelled', duration: 'PT1H' }] }),
      'JY0014', '/overrides/0/duration');
    refuses(() => defineSeries({ uid: 's', base, overrides: [{ recurrenceId: '2026-01-06T09:00:00', status: 'moved',
      start: floatingValue('2026-01-06', '10:00'), duration: '-PT1H' }] }), 'JY0014', '/overrides/0/duration');
    refuses(() => defineSeries({ uid: 's', base, rdates: [{ start: floatingValue('2026-01-09', '09:00'), length: 'PT1H' }] }), 'JY0014', '/rdates/0');
  });
});

describe('a range override\'s duration is every later slot\'s', () => {
  const zone = 'Europe/Amsterdam';
  const base = compileRecurrence({ dtstart: zoned(zone, '2026-10-20T09:00:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=10' });
  const horizon = /** @type {[number, number]} */ ([at('2026-10-20T00:00:00Z'), at('2026-10-30T00:00:00Z')]);
  const lengths = (/** @type {any} */ series, /** @type {[number, number]} */ over = horizon) => Object.fromEntries(
    expandSeries(series, { horizon: over, zoneProvider: providers[zone] }).occurrences
      .map((o) => [o.recurrenceId.slice(5, 10), (/** @type {any} */ (o.instants).end - /** @type {any} */ (o.instants).start) / 3600000]));

  it('exact hours stay exact across the fold, a nominal day is 25 hours over it', () => {
    const range = (/** @type {string} */ duration) => defineSeries({ uid: 'r', base, overrides: [{ recurrenceId: '2026-10-23T09:00:00',
      status: 'moved', start: zoned(zone, '2026-10-23T09:00:00'), duration, range: 'THISANDFUTURE' }] });
    const exact = lengths(range('PT24H'));
    assert.deepEqual([exact['10-22'], exact['10-23'], exact['10-24'], exact['10-25']], [1, 24, 24, 24]);
    // 2026-10-24 09:00 is +120 (07:00Z); 2026-10-25 09:00 is +60 (08:00Z): the nominal day lasts 25 hours
    const nominal = lengths(range('P1D'));
    assert.deepEqual([nominal['10-22'], nominal['10-23'], nominal['10-24'], nominal['10-25']], [1, 24, 25, 24]);
    // a slot starting days before the horizon reaches into it by the range's days (2026-10-23 07:00Z to 10-28 08:00Z)
    const late = lengths(range('P5D'), [at('2026-10-27T12:00:00Z'), at('2026-10-27T13:00:00Z')]);
    assert.deepEqual(Object.keys(late), ['10-23', '10-24', '10-25', '10-26', '10-27']);
  });

  it('a one-slot override takes its own duration, else its end, else the range\'s duration', () => {
    const series = defineSeries({ uid: 'r', base, overrides: [
      { recurrenceId: '2026-10-23T09:00:00', status: 'moved', start: zoned(zone, '2026-10-23T09:00:00'), duration: 'PT3H', range: 'THISANDFUTURE' },
      { recurrenceId: '2026-10-24T09:00:00', status: 'moved', start: zoned(zone, '2026-10-24T10:00:00') },
      { recurrenceId: '2026-10-25T09:00:00', status: 'moved', start: zoned(zone, '2026-10-25T10:00:00'), duration: 'PT30M' },
      { recurrenceId: '2026-10-26T09:00:00', status: 'moved', start: zoned(zone, '2026-10-26T10:00:00'), end: zoned(zone, '2026-10-26T12:00:00') },
    ] });
    const got = lengths(series);
    assert.deepEqual([got['10-23'], got['10-24'], got['10-25'], got['10-26'], got['10-27']], [3, 3, 0.5, 2, 3]);
  });

  it('without a duration nothing changed: an end gives its wall-clock length, neither keeps each slot\'s own', () => {
    const byEnd = defineSeries({ uid: 'r', base, overrides: [{ recurrenceId: '2026-10-23T09:00:00', status: 'moved',
      start: zoned(zone, '2026-10-23T09:00:00'), end: zoned(zone, '2026-10-24T09:00:00'), range: 'THISANDFUTURE' }] });
    const ended = lengths(byEnd);
    assert.deepEqual([ended['10-23'], ended['10-24'], ended['10-25']], [24, 25, 24]);
    const neither = defineSeries({ uid: 'r', base, overrides: [{ recurrenceId: '2026-10-23T09:00:00', status: 'moved',
      start: zoned(zone, '2026-10-23T10:00:00'), range: 'THISANDFUTURE' }] });
    const kept = lengths(neither);
    assert.deepEqual([kept['10-23'], kept['10-24'], kept['10-25']], [1, 1, 1]);
  });
});

describe('an RDATE period in another zone or utc counts its duration in its own zone', () => {
  const zone = 'Europe/Amsterdam';
  const own = tableProvider(zone, oracleZone(zone));
  const ny = tableProvider('America/New_York', oracleZone('America/New_York'));
  // one provider for both zones: each table answers its own
  const provider = Object.fromEntries(['toParts', 'candidates', 'offsetChanges'].map((name) => [name, (/** @type {any[]} */ ...args) =>
    (args[args.length - 1] === zone ? /** @type {any} */ (own)[name] : /** @type {any} */ (ny)[name])(...args)]));
  Object.assign(provider, { toEpoch: own.toEpoch, identity: own.identity });

  it('a utc start plus exact hours; a New York start plus a nominal day across its own gap', () => {
    // the series is in Amsterdam; its RDATEs are not
    const amsterdam = defineSeries({ uid: 'f', base: compileRecurrence({ dtstart: zoned(zone, '2026-01-05T09:00:00'), rrule: 'FREQ=YEARLY;COUNT=1' }),
      rdates: [
        { start: { kind: 'utc', instant: '2026-10-24T23:30:00Z' }, duration: 'PT2H' },
        // 12:00 on the 7th in New York is 17:00Z; a day on New York's wall clock is 12:00 on the 8th, -240: 16:00Z
        { start: zoned('America/New_York', '2026-03-07T12:00:00'), duration: 'P1D' },
      ] });
    const got = expandSeries(amsterdam, { horizon: [at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z')], zoneProvider: /** @type {any} */ (provider) });
    const ends = Object.fromEntries(got.occurrences.map((o) => [o.recurrenceId, new Date(/** @type {any} */ (o.instants).end).toISOString()]));
    assert.equal(ends['2026-10-25T01:30:00'], '2026-10-25T01:30:00.000Z');
    assert.equal(ends['2026-03-07T18:00:00'], '2026-03-08T16:00:00.000Z');
    // given with an end that names another instant, refused
    const wrong = defineSeries({ uid: 'w', base: compileRecurrence({ dtstart: zoned(zone, '2026-01-05T09:00:00'), rrule: 'FREQ=YEARLY;COUNT=1' }),
      rdates: [{ start: zoned('America/New_York', '2026-03-07T12:00:00'), end: zoned('America/New_York', '2026-03-08T13:00:00'), duration: 'P1D' }] });
    refuses(() => expandSeries(wrong, { horizon: [at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z')], zoneProvider: /** @type {any} */ (provider) }),
      'JY0014', '/rdates/0/duration');
  });
});
