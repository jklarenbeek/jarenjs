//@ts-check

/**
 * SECONDLY, MINUTELY and HOURLY rules: zoned walks across a change of
 * offset, against a table derived by hand from the zdump transitions
 * (fixtures/zone-transitions, read through oracle.js's arithmetic
 * provider, never host ICU); floating and utc walks, which have no gaps;
 * and the limits a sub-daily rule meets. The floating and utc lists
 * against python-dateutil are in rrule-dateutil-subdaily.test.js.
 *
 * Each zoned row below is derived from the transition it crosses (see
 * fixtures/rrule-oracle-subdaily/PROVENANCE.md): a generated wall clock
 * that exists is read with the offset in force; one in a gap with the
 * offset before the change (rfc5545 and later); one in a fold with the
 * earlier offset (rfc5545) or the later one (later).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileRecurrence, expandRecurrence, floatingValue, nextOccurrences } from '@jarenjs/core/calendar';
import { oracleZone, tableProvider } from './oracle.js';

const at = (/** @type {string} */ text) => Date.parse(text);
const iso = (/** @type {number} */ instant) => new Date(instant).toISOString().slice(0, 16);
/** @param {string} zone @param {string} date @param {string} time */
const zoned = (zone, date, time) => ({ kind: /** @type {const} */ ('zoned'), date, time, zone });
const providerOf = (/** @type {string} */ zone) => tableProvider(zone, oracleZone(zone));

/**
 * `id start-wall instant` per occurrence, minutes only.
 * @param {import('@jarenjs/core/calendar').RecurrenceExpansion} expansion
 */
const rows = (expansion) => expansion.occurrences.map((o) => {
  const start = /** @type {any} */ (o.start);
  return `${o.recurrenceId.slice(0, 16)} ${start.date}T${start.time.slice(0, 5)} ${iso(/** @type {any} */ (o.instants).start)}`;
});

/**
 * Expand a zoned rule over `[low, high)`.
 * @param {string} zone
 * @param {string} dtstart - `YYYY-MM-DDTHH:MM:SS` wall clock
 * @param {string} rrule
 * @param {[string, string]} horizon - utc instants
 * @param {'rfc5545' | 'later' | 'reject'} [policy]
 */
const expandZoned = (zone, dtstart, rrule, horizon, policy = 'rfc5545') => expandRecurrence(
  compileRecurrence({ dtstart: zoned(zone, dtstart.slice(0, 10), dtstart.slice(11)), rrule, policy }),
  { horizon: [at(horizon[0]), at(horizon[1])], zoneProvider: providerOf(zone) });

describe('zoned sub-daily rules step the wall clock and resolve each time under the policy', () => {
  it('Amsterdam 2026-03-29 (gap 02:00-03:00): the 02:00 that never happens starts at 03:00, beside the 03:00 the rule makes', () => {
    const got = expandZoned('Europe/Amsterdam', '2026-03-29T00:00:00', 'FREQ=HOURLY', ['2026-03-28T23:00:00Z', '2026-03-29T04:00:00Z']);
    assert.strictEqual(got.status, 'complete');
    assert.deepStrictEqual(rows(got), [
      '2026-03-29T00:00 2026-03-29T00:00 2026-03-28T23:00',
      '2026-03-29T01:00 2026-03-29T01:00 2026-03-29T00:00',
      '2026-03-29T02:00 2026-03-29T03:00 2026-03-29T01:00',
      '2026-03-29T03:00 2026-03-29T03:00 2026-03-29T01:00',
      '2026-03-29T04:00 2026-03-29T04:00 2026-03-29T02:00',
      '2026-03-29T05:00 2026-03-29T05:00 2026-03-29T03:00',
    ]);
    assert.deepStrictEqual(got.occurrences.map((o) => o.resolution?.kind), ['exists', 'exists', 'gap', 'exists', 'exists', 'exists']);
    // the sibling DAILY rule answers the same two occurrences on that day
    const daily = expandZoned('Europe/Amsterdam', '2026-03-29T02:00:00', 'FREQ=DAILY;BYHOUR=2,3;COUNT=2', ['2026-03-28T00:00:00Z', '2026-03-30T00:00:00Z']);
    assert.deepStrictEqual(rows(daily), rows(got).slice(2, 4));
    // under reject the generated 02:00 refuses the expansion, once the horizon holds it
    assert.throws(() => expandZoned('Europe/Amsterdam', '2026-03-29T00:00:00', 'FREQ=HOURLY', ['2026-03-28T23:00:00Z', '2026-03-29T04:00:00Z'], 'reject'),
      (/** @type {any} */ error) => error.code === 'JY0002');
    assert.strictEqual(expandZoned('Europe/Amsterdam', '2026-03-29T00:00:00', 'FREQ=HOURLY', ['2026-03-29T02:00:00Z', '2026-03-29T04:00:00Z'],
      'reject').occurrences.length, 2);
  });

  it('Amsterdam 2026-10-25 (fold 02:00-03:00): each wall clock once, so the repeated hour appears once', () => {
    const horizon = /** @type {[string, string]} */ (['2026-10-24T22:00:00Z', '2026-10-25T04:00:00Z']);
    const earlier = expandZoned('Europe/Amsterdam', '2026-10-25T00:00:00', 'FREQ=HOURLY', horizon);
    assert.deepStrictEqual(rows(earlier), [
      '2026-10-25T00:00 2026-10-25T00:00 2026-10-24T22:00',
      '2026-10-25T01:00 2026-10-25T01:00 2026-10-24T23:00',
      '2026-10-25T02:00 2026-10-25T02:00 2026-10-25T00:00',
      '2026-10-25T03:00 2026-10-25T03:00 2026-10-25T02:00',
      '2026-10-25T04:00 2026-10-25T04:00 2026-10-25T03:00',
    ]);
    const later = expandZoned('Europe/Amsterdam', '2026-10-25T00:00:00', 'FREQ=HOURLY', horizon, 'later');
    assert.deepStrictEqual(later.occurrences.map((o) => iso(/** @type {any} */ (o.instants).start)),
      ['2026-10-24T22:00', '2026-10-24T23:00', '2026-10-25T01:00', '2026-10-25T02:00', '2026-10-25T03:00']);
    assert.throws(() => expandZoned('Europe/Amsterdam', '2026-10-25T00:00:00', 'FREQ=HOURLY', horizon, 'reject'),
      (/** @type {any} */ error) => error.code === 'JY0003');
  });

  it('New York 2026-03-08 (gap 02:00-03:00) and 2026-11-01 (fold 01:00-02:00), every 30 minutes', () => {
    assert.deepStrictEqual(rows(expandZoned('America/New_York', '2026-03-08T01:00:00', 'FREQ=MINUTELY;INTERVAL=30;COUNT=6',
      ['2026-03-08T00:00:00Z', '2026-03-09T00:00:00Z'])), [
      '2026-03-08T01:00 2026-03-08T01:00 2026-03-08T06:00',
      '2026-03-08T01:30 2026-03-08T01:30 2026-03-08T06:30',
      '2026-03-08T02:00 2026-03-08T03:00 2026-03-08T07:00',
      '2026-03-08T03:00 2026-03-08T03:00 2026-03-08T07:00',
      '2026-03-08T02:30 2026-03-08T03:30 2026-03-08T07:30',
      '2026-03-08T03:30 2026-03-08T03:30 2026-03-08T07:30',
    ]);
    assert.deepStrictEqual(rows(expandZoned('America/New_York', '2026-11-01T00:30:00', 'FREQ=MINUTELY;INTERVAL=30;COUNT=5',
      ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'])), [
      '2026-11-01T00:30 2026-11-01T00:30 2026-11-01T04:30',
      '2026-11-01T01:00 2026-11-01T01:00 2026-11-01T05:00',
      '2026-11-01T01:30 2026-11-01T01:30 2026-11-01T05:30',
      '2026-11-01T02:00 2026-11-01T02:00 2026-11-01T07:00',
      '2026-11-01T02:30 2026-11-01T02:30 2026-11-01T07:30',
    ]);
  });

  it('Lord Howe 2026-04-05 (30-minute fold) and 2026-10-04 (30-minute gap), every 15 minutes', () => {
    assert.deepStrictEqual(rows(expandZoned('Australia/Lord_Howe', '2026-04-05T01:00:00', 'FREQ=MINUTELY;INTERVAL=15;COUNT=6',
      ['2026-04-04T00:00:00Z', '2026-04-05T00:00:00Z'])), [
      '2026-04-05T01:00 2026-04-05T01:00 2026-04-04T14:00',
      '2026-04-05T01:15 2026-04-05T01:15 2026-04-04T14:15',
      '2026-04-05T01:30 2026-04-05T01:30 2026-04-04T14:30',
      '2026-04-05T01:45 2026-04-05T01:45 2026-04-04T14:45',
      '2026-04-05T02:00 2026-04-05T02:00 2026-04-04T15:30',
      '2026-04-05T02:15 2026-04-05T02:15 2026-04-04T15:45',
    ]);
    assert.deepStrictEqual(rows(expandZoned('Australia/Lord_Howe', '2026-10-04T01:45:00', 'FREQ=MINUTELY;INTERVAL=15;COUNT=5',
      ['2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z'])), [
      '2026-10-04T01:45 2026-10-04T01:45 2026-10-03T15:15',
      '2026-10-04T02:00 2026-10-04T02:30 2026-10-03T15:30',
      '2026-10-04T02:30 2026-10-04T02:30 2026-10-03T15:30',
      '2026-10-04T02:15 2026-10-04T02:45 2026-10-03T15:45',
      '2026-10-04T02:45 2026-10-04T02:45 2026-10-03T15:45',
    ]);
  });

  it('Apia 2011-12-30 (a skipped day): each generated time of that day moves a day forward, onto the next day\'s own', () => {
    assert.deepStrictEqual(rows(expandZoned('Pacific/Apia', '2011-12-29T18:00:00', 'FREQ=HOURLY;INTERVAL=6;COUNT=6',
      ['2011-12-29T00:00:00Z', '2012-01-01T00:00:00Z'])), [
      '2011-12-29T18:00 2011-12-29T18:00 2011-12-30T04:00',
      '2011-12-30T00:00 2011-12-31T00:00 2011-12-30T10:00',
      '2011-12-31T00:00 2011-12-31T00:00 2011-12-30T10:00',
      '2011-12-30T06:00 2011-12-31T06:00 2011-12-30T16:00',
      '2011-12-30T12:00 2011-12-31T12:00 2011-12-30T22:00',
      '2011-12-30T18:00 2011-12-31T18:00 2011-12-31T04:00',
    ]);
  });

  it('a zoned UNTIL is an instant: the gap\'s moved 02:00 and the 03:00 both end at it', () => {
    assert.deepStrictEqual(rows(expandZoned('Europe/Amsterdam', '2026-03-29T00:00:00', 'FREQ=HOURLY;UNTIL=20260329T010000Z',
      ['2026-03-28T00:00:00Z', '2026-03-30T00:00:00Z'])).map((row) => row.slice(0, 16)),
    ['2026-03-29T00:00', '2026-03-29T01:00', '2026-03-29T02:00', '2026-03-29T03:00']);
  });

  it('nextOccurrences across the gap answers by instant, settling only as far as the gap moved a time', () => {
    const rule = compileRecurrence({ dtstart: zoned('Europe/Amsterdam', '2026-03-29', '01:30:00'), rrule: 'FREQ=MINUTELY;INTERVAL=20' });
    const got = nextOccurrences(rule, at('2026-03-29T00:00:00Z'), 6, { zoneProvider: providerOf('Europe/Amsterdam') });
    assert.strictEqual(got.status, 'complete');
    assert.deepStrictEqual(rows(got).map((row) => row.slice(0, 16)),
      ['2026-03-29T01:30', '2026-03-29T01:50', '2026-03-29T02:10', '2026-03-29T03:10', '2026-03-29T02:30', '2026-03-29T03:30']);
    // the walk goes on an hour (the gap) past the sixth, not three days: about 3 x 4 more times than it keeps
    assert.ok(got.counts.providerCalls < 30, `${got.counts.providerCalls} provider calls`);
  });

  it('a later part of a zoned day equals the whole day cut to it, on either side of the gap', () => {
    const whole = expandZoned('Europe/Amsterdam', '2026-03-28T22:00:00', 'FREQ=MINUTELY;INTERVAL=7', ['2026-03-28T21:00:00Z', '2026-03-29T06:00:00Z']);
    for (const low of ['2026-03-28T23:00:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-03-29T01:05:00Z', '2026-03-29T01:30:00Z',
      '2026-03-29T02:00:00Z']) {
      const part = expandZoned('Europe/Amsterdam', '2026-03-28T22:00:00', 'FREQ=MINUTELY;INTERVAL=7', [low, '2026-03-29T06:00:00Z']);
      assert.deepStrictEqual(rows(part), rows(whole).filter((row) => at(`${row.slice(-16)}:00Z`) >= at(low)), low);
    }
  });

  it('an hour whose start and end exist but hold a gap is resolved time by time, not passed over', () => {
    // a made-up zone: at 01:30Z the clock moves from 02:30 (+01:00) to 02:50 (+01:20); the hour 02:00-03:00 holds the gap
    const provider = tableProvider('Test/Gap', { initial: 60, changes: [{ at: at('2026-03-01T01:30:00Z'), before: 60, after: 80 }] });
    const rule = compileRecurrence({ dtstart: zoned('Test/Gap', '2026-02-28', '00:00:00'), rrule: 'FREQ=MINUTELY' });
    const over = (/** @type {string} */ low) => expandRecurrence(rule, { horizon: [at(low), at('2026-03-01T02:00:00Z')], zoneProvider: provider });
    // 03:00 is 01:40Z: an hour end at the horizon's start, while the gap's 02:40-02:49 start at 01:40Z-01:49Z
    const part = over('2026-03-01T01:40:00Z');
    assert.deepStrictEqual(rows(part), rows(over('2026-03-01T00:00:00Z')).filter((row) => at(`${row.slice(-16)}:00Z`) >= at('2026-03-01T01:40:00Z')));
    assert.deepStrictEqual(part.occurrences.slice(0, 4).map((o) => o.recurrenceId.slice(11, 16)), ['02:40', '03:00', '02:41', '03:01']);
    // and one holding a fold: at 01:30Z the clock moves back from 02:30 (+01:00) to 02:10 (+00:40), so 02:30 is 01:50Z, not 01:30Z
    const folding = tableProvider('Test/Fold', { initial: 60, changes: [{ at: at('2026-03-01T01:30:00Z'), before: 60, after: 40 }] });
    const back = compileRecurrence({ dtstart: zoned('Test/Fold', '2026-02-28', '00:00:00'), rrule: 'FREQ=MINUTELY' });
    const fold = (/** @type {string} */ low) => expandRecurrence(back, { horizon: [at(low), at('2026-03-01T02:10:00Z')], zoneProvider: folding });
    const late = fold('2026-03-01T01:45:00Z');
    assert.deepStrictEqual(rows(late), rows(fold('2026-03-01T00:00:00Z')).filter((row) => at(`${row.slice(-16)}:00Z`) >= at('2026-03-01T01:45:00Z')));
    assert.strictEqual(late.occurrences[0].recurrenceId.slice(11, 16), '02:30');
  });
});

describe('floating and utc sub-daily rules', () => {
  it('a floating rule steps a wall clock that has no gap; a utc rule steps instants', () => {
    const floating = expandRecurrence(compileRecurrence({ dtstart: floatingValue('2026-03-29', '00:00'), rrule: 'FREQ=HOURLY;COUNT=4' }),
      { horizon: [floatingValue('2026-03-29', '00:00'), floatingValue('2026-03-30', '00:00')] });
    assert.deepStrictEqual(floating.occurrences.map((o) => o.recurrenceId),
      ['2026-03-29T00:00:00', '2026-03-29T01:00:00', '2026-03-29T02:00:00', '2026-03-29T03:00:00']);
    const utc = expandRecurrence(compileRecurrence({ dtstart: { kind: 'utc', instant: '2026-03-29T00:30:00Z' }, rrule: 'FREQ=MINUTELY;INTERVAL=45;COUNT=4' }),
      { horizon: [at('2026-03-29T00:00:00Z'), at('2026-03-30T00:00:00Z')] });
    assert.deepStrictEqual(utc.occurrences.map((o) => o.recurrenceId),
      ['2026-03-29T00:30:00Z', '2026-03-29T01:15:00Z', '2026-03-29T02:00:00Z', '2026-03-29T02:45:00Z']);
    assert.deepStrictEqual(utc.occurrences.map((o) => /** @type {any} */ (o.instants).end - /** @type {any} */ (o.instants).start), [0, 0, 0, 0]);
  });

  it('a rule whose INTERVAL never reaches its BYHOUR makes DTSTART only, and ends under its limits', () => {
    const rule = compileRecurrence({ dtstart: floatingValue('2026-01-01', '00:00'), rrule: 'FREQ=HOURLY;INTERVAL=30;BYHOUR=2' });
    const year = expandRecurrence(rule, { horizon: [floatingValue('2026-01-01', '00:00'), floatingValue('2027-01-01', '00:00')] });
    assert.strictEqual(year.status, 'complete');
    assert.deepStrictEqual(year.occurrences.map((o) => o.recurrenceId), ['2026-01-01T00:00:00']);
    assert.ok(year.counts.work < 400, `${year.counts.work} steps for 292 periods`);
    const next = nextOccurrences(rule, floatingValue('2026-01-02', '00:00'), 1, { limits: { maxWork: 5000 } });
    assert.deepStrictEqual([next.complete, next.stoppedAt?.limit, next.occurrences.length], [false, 'maxWork', 0]);
  });
});

describe('a sub-daily rule stays under its limits', () => {
  it('a SECONDLY rule over a year stops at maxOccurrences or maxWork with the incomplete shape, after building only what it returns', () => {
    const rule = compileRecurrence({ dtstart: floatingValue('2026-01-01', '00:00'), rrule: 'FREQ=SECONDLY' });
    const horizon = [floatingValue('2026-01-01', '00:00'), floatingValue('2027-01-01', '00:00')];
    const capped = expandRecurrence(rule, { horizon, limits: { maxOccurrences: 50 } });
    assert.deepStrictEqual([capped.complete, capped.status, capped.stoppedAt, capped.counts.emitted], [false, 'incomplete', { limit: 'maxOccurrences' }, 50]);
    assert.ok(capped.counts.work < 200, `${capped.counts.work} steps`);
    const worked = expandRecurrence(rule, { horizon, limits: { maxWork: 1000 } });
    assert.deepStrictEqual([worked.complete, worked.stoppedAt, worked.counts.work <= 1000], [false, { limit: 'maxWork' }, true]);
    assert.ok(worked.occurrences.length > 400 && worked.occurrences.length <= 500, `${worked.occurrences.length}`);
  });

  it('a day, hour or minute a limit drops costs one step: the work grows with the days, not the seconds', () => {
    const rule = compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), rrule: 'FREQ=SECONDLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0,30' });
    const over = (/** @type {number} */ days) => expandRecurrence(rule, {
      horizon: [floatingValue('2026-01-01', '00:00'), floatingValue(new Date(Date.UTC(2026, 0, 1 + days)).toISOString().slice(0, 10), '00:00')],
    });
    const small = over(10);
    const large = over(80);
    assert.deepStrictEqual([small.counts.emitted, large.counts.emitted], [20, 160]);
    const growth = large.counts.work / small.counts.work;
    assert.ok(growth > 6 && growth < 10, `work ${small.counts.work} -> ${large.counts.work}`);
    // a day: 23 hours passed, 59 minutes passed, 60 seconds examined in the kept minute
    assert.ok(large.counts.work / 80 < 200, `${large.counts.work / 80} steps a day`);
    const june = expandRecurrence(compileRecurrence({ dtstart: floatingValue('2026-01-01', '00:00'), rrule: 'FREQ=SECONDLY;BYMONTH=6' }), {
      horizon: [floatingValue('2026-01-02', '00:00'), floatingValue('2026-07-01', '00:00')], limits: { maxOccurrences: 10 },
    });
    assert.deepStrictEqual(june.occurrences.map((o) => o.recurrenceId).slice(0, 2), ['2026-06-01T00:00:00', '2026-06-01T00:00:01']);
    assert.ok(june.counts.work < 300, `${june.counts.work} steps for 150 dropped days`);
  });

  it('a zoned SECONDLY rule over ten seconds asks the provider about hours before the horizon, not seconds', () => {
    // on the hour, half past, ten seconds before the hour, and in a +10:30 zone
    for (const [zone, low, wall] of [['Europe/Amsterdam', '2026-06-01T10:00:00Z', '12:00:00'], ['Europe/Amsterdam', '2026-06-01T10:30:00Z', '12:30:00'],
      ['Europe/Amsterdam', '2026-06-01T10:59:50Z', '12:59:50'], ['Australia/Lord_Howe', '2026-06-01T10:00:00Z', '20:30:00']]) {
      const horizon = [at(low), at(low) + 10000];
      const ids = Array.from({ length: 10 }, (_, i) => new Date(Date.parse(`2026-06-01T${wall}Z`) + i * 1000).toISOString().slice(11, 19));
      for (const rrule of ['FREQ=SECONDLY', 'FREQ=SECONDLY;COUNT=500000', 'FREQ=MINUTELY;BYSECOND=0,1,2,3,4,5,6,7,8,9,50,51,52,53,54,55,56,57,58,59']) {
        const got = expandRecurrence(compileRecurrence({ dtstart: zoned(zone, '2026-05-31', '00:00:00'), rrule }),
          { horizon, zoneProvider: providerOf(zone) });
        assert.strictEqual(got.status, 'complete', rrule);
        assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId.slice(11)), ids, `${zone} ${low} ${rrule}`);
        assert.ok(got.counts.providerCalls < 80, `${zone} ${low} ${rrule}: ${got.counts.providerCalls} provider calls`);
      }
    }
  });
});
