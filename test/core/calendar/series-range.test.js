//@ts-check

/**
 * Overrides that range over this and future occurrences
 * (RANGE=THISANDFUTURE, RFC 5545 §3.2.13 and §3.8.4.4): §3.8.4.4's two
 * rules ("all subsequent instances are also rescheduled by the same time
 * difference"; "modified to have this same duration") on its example
 * RECURRENCE-ID 19960120T120000Z (§3.8.5 has no RANGE example), and cases
 * derived by hand: several
 * ranges, a range beside a one-slot override, RDATEs, EXDATEs, orphans,
 * a zoned series across a change of offset, and a cut at maxOccurrences.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileRecurrence, dateValue, defineSeries, expandSeries, floatingValue } from '@jarenjs/core/calendar';
import { oracleZone, tableProvider } from './oracle.js';

const at = (/** @type {string} */ text) => Date.parse(text);
const f = (/** @type {string} */ date, /** @type {string} */ time) => floatingValue(date, time);
const utc = (/** @type {string} */ instant) => ({ kind: /** @type {const} */ ('utc'), instant });
const amsterdam = tableProvider('Europe/Amsterdam', oracleZone('Europe/Amsterdam'));
const JANUARY = { horizon: [f('2026-01-01', '00:00'), f('2026-02-01', '00:00')] };

/**
 * `id:start-end` per occurrence (floating: dates and times as read), with
 * `*` when moved and `#payload` when it carries one.
 * @param {import('@jarenjs/core/calendar').SeriesExpansion} expansion
 */
const rows = (expansion) => expansion.occurrences.map((/** @type {any} */ o) => {
  const start = o.start.time === undefined ? o.start.date ?? o.start.instant : `${o.start.date}T${o.start.time.slice(0, 5)}`;
  const end = o.end.time === undefined ? o.end.date ?? o.end.instant : o.end.time.slice(0, 5);
  return `${o.recurrenceId.slice(0, 16)}:${start}-${end}${o.moved ? '*' : ''}${o.payload !== undefined ? `#${o.payload}` : ''}`;
});

const daily = compileRecurrence({ dtstart: f('2026-01-05', '09:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=10' });

describe('RANGE=THISANDFUTURE', () => {
  it('§3.8.4.4: an instance rescheduled two hours later reschedules every later one by the same time difference', () => {
    const base = compileRecurrence({ dtstart: utc('1996-01-18T12:00:00Z'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=5' });
    const series = defineSeries({ uid: 'rfc', base, overrides: [
      { recurrenceId: '1996-01-20T12:00:00Z', range: 'THISANDFUTURE', status: 'moved', start: utc('1996-01-20T14:00:00Z') },
    ] });
    const got = expandSeries(series, { horizon: [at('1996-01-01T00:00:00Z'), at('1996-02-01T00:00:00Z')] });
    assert.strictEqual(got.status, 'complete');
    assert.deepStrictEqual(rows(got), [
      '1996-01-18T12:00:1996-01-18T12:00:00.000Z-1996-01-18T13:00:00.000Z',
      '1996-01-19T12:00:1996-01-19T12:00:00.000Z-1996-01-19T13:00:00.000Z',
      '1996-01-20T12:00:1996-01-20T14:00:00.000Z-1996-01-20T15:00:00.000Z*',
      '1996-01-21T12:00:1996-01-21T14:00:00.000Z-1996-01-21T15:00:00.000Z*',
      '1996-01-22T12:00:1996-01-22T14:00:00.000Z-1996-01-22T15:00:00.000Z*',
    ]);
    assert.deepStrictEqual(got.occurrences.map((o) => o.instants?.start), [at('1996-01-18T12:00:00Z'), at('1996-01-19T12:00:00Z'),
      at('1996-01-20T14:00:00Z'), at('1996-01-21T14:00:00Z'), at('1996-01-22T14:00:00Z')]);
  });

  it('§3.8.4.4: a changed duration becomes every later instance\'s, and the payload is carried', () => {
    const series = defineSeries({ uid: 'a', base: daily, overrides: [{ recurrenceId: '2026-01-12T09:00:00', range: 'THISANDFUTURE', status: 'moved',
      start: f('2026-01-12', '09:00'), end: f('2026-01-12', '09:30'), payload: 'short' }] });
    assert.deepStrictEqual(rows(expandSeries(series, JANUARY)).slice(6), [
      '2026-01-11T09:00:2026-01-11T09:00-10:00',
      '2026-01-12T09:00:2026-01-12T09:00-09:30*#short',
      '2026-01-13T09:00:2026-01-13T09:00-09:30*#short',
      '2026-01-14T09:00:2026-01-14T09:00-09:30*#short',
    ]);
  });

  it('a cancelled range removes its slot and every later one', () => {
    const series = defineSeries({ uid: 'a', base: daily, overrides: [{ recurrenceId: '2026-01-08T09:00:00', range: 'THISANDFUTURE', status: 'cancelled' }] });
    const got = expandSeries(series, JANUARY);
    assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId), ['2026-01-05T09:00:00', '2026-01-06T09:00:00', '2026-01-07T09:00:00']);
    assert.strictEqual(got.orphans.count, 0);
  });

  it('several ranges apply in recurrenceId order, each from its own slot: distances do not add up', () => {
    const series = defineSeries({ uid: 'a', base: daily, overrides: [
      // given out of order: the order is the recurrenceIds'
      { recurrenceId: '2026-01-10T09:00:00', range: 'THISANDFUTURE', status: 'moved', start: f('2026-01-10', '08:00') },
      { recurrenceId: '2026-01-07T09:00:00', range: 'THISANDFUTURE', status: 'moved', start: f('2026-01-07', '11:00'), payload: 'first' },
      { recurrenceId: '2026-01-13T09:00:00', range: 'THISANDFUTURE', status: 'cancelled' },
    ] });
    assert.deepStrictEqual(rows(expandSeries(series, JANUARY)), [
      '2026-01-05T09:00:2026-01-05T09:00-10:00',
      '2026-01-06T09:00:2026-01-06T09:00-10:00',
      '2026-01-07T09:00:2026-01-07T11:00-12:00*#first',
      '2026-01-08T09:00:2026-01-08T11:00-12:00*#first',
      '2026-01-09T09:00:2026-01-09T11:00-12:00*#first',
      '2026-01-10T09:00:2026-01-10T08:00-09:00*',
      '2026-01-11T09:00:2026-01-11T08:00-09:00*',
      '2026-01-12T09:00:2026-01-12T08:00-09:00*',
    ]);
  });

  it('a one-slot override still wins for its slot, keeps the range\'s length, and can bring back a cancelled slot', () => {
    const series = defineSeries({ uid: 'a', base: daily, overrides: [
      { recurrenceId: '2026-01-07T09:00:00', range: 'THISANDFUTURE', status: 'moved', start: f('2026-01-07', '10:00'), end: f('2026-01-07', '12:00') },
      { recurrenceId: '2026-01-09T09:00:00', status: 'moved', start: f('2026-01-09', '15:00'), payload: 'own' },
      { recurrenceId: '2026-01-10T09:00:00', status: 'cancelled' },
      { recurrenceId: '2026-01-12T09:00:00', range: 'THISANDFUTURE', status: 'cancelled' },
      { recurrenceId: '2026-01-13T09:00:00', status: 'moved', start: f('2026-01-20', '09:00') },
    ] });
    assert.deepStrictEqual(rows(expandSeries(series, JANUARY)), [
      '2026-01-05T09:00:2026-01-05T09:00-10:00',
      '2026-01-06T09:00:2026-01-06T09:00-10:00',
      '2026-01-07T09:00:2026-01-07T10:00-12:00*',
      '2026-01-08T09:00:2026-01-08T10:00-12:00*',
      '2026-01-09T09:00:2026-01-09T15:00-17:00*#own',
      '2026-01-11T09:00:2026-01-11T10:00-12:00*',
      '2026-01-13T09:00:2026-01-20T09:00-10:00*',
    ]);
  });

  it('RDATEs after a range move with it; a period keeps its own length unless the range names one', () => {
    const base = compileRecurrence({ dtstart: f('2026-01-05', '09:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;COUNT=3' });
    const rdates = [f('2026-01-03', '09:00'), f('2026-01-15', '13:00'), { start: f('2026-01-16', '13:00'), end: f('2026-01-16', '13:20') }];
    const moved = defineSeries({ uid: 'a', base, rdates, overrides: [
      { recurrenceId: '2026-01-05T09:00:00', range: 'THISANDFUTURE', status: 'moved', start: f('2026-01-05', '09:45') },
    ] });
    assert.deepStrictEqual(rows(expandSeries(moved, JANUARY)), [
      '2026-01-03T09:00:2026-01-03T09:00-10:00',
      '2026-01-05T09:00:2026-01-05T09:45-10:45*',
      '2026-01-12T09:00:2026-01-12T09:45-10:45*',
      '2026-01-15T13:00:2026-01-15T13:45-14:45*',
      '2026-01-16T13:00:2026-01-16T13:45-14:05*',
      '2026-01-19T09:00:2026-01-19T09:45-10:45*',
    ]);
    const lengthened = defineSeries({ uid: 'a', base, rdates, overrides: [
      { recurrenceId: '2026-01-12T09:00:00', range: 'THISANDFUTURE', status: 'moved', start: f('2026-01-12', '09:00'), end: f('2026-01-12', '11:00') },
    ] });
    assert.deepStrictEqual(rows(expandSeries(lengthened, JANUARY)).slice(2), [
      '2026-01-12T09:00:2026-01-12T09:00-11:00*',
      '2026-01-15T13:00:2026-01-15T13:00-15:00*',
      '2026-01-16T13:00:2026-01-16T13:00-15:00*',
      '2026-01-19T09:00:2026-01-19T09:00-11:00*',
    ]);
  });

  it('EXDATEs go first; a range on an excluded or unmade slot is an orphan and moves nothing', () => {
    const series = defineSeries({ uid: 'a', base: daily, exdates: [f('2026-01-07', '09:00'), f('2026-01-09', '09:00')], overrides: [
      { recurrenceId: '2026-01-06T09:00:00', range: 'THISANDFUTURE', status: 'moved', start: f('2026-01-06', '10:00') },
      { recurrenceId: '2026-01-09T09:00:00', range: 'THISANDFUTURE', status: 'cancelled' },
      { recurrenceId: '2026-01-11T10:00:00', range: 'THISANDFUTURE', status: 'cancelled' },
    ] });
    const got = expandSeries(series, JANUARY);
    assert.deepStrictEqual(got.orphans, { count: 2, ids: ['2026-01-09T09:00:00', '2026-01-11T10:00:00'] });
    assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId.slice(5, 10)), ['01-05', '01-06', '01-08', '01-10', '01-11', '01-12', '01-13', '01-14']);
    assert.ok(got.occurrences.slice(1).every((o) => /** @type {any} */ (o.start).time === '10:00:00' && /** @type {any} */ (o).moved));
  });

  it('a range moves slots across the horizon both ways, from before it and from after it', () => {
    const forward = defineSeries({ uid: 'a', base: daily, overrides: [
      { recurrenceId: '2026-01-05T09:00:00', range: 'THISANDFUTURE', status: 'moved', start: f('2026-01-25', '09:00') },
    ] });
    assert.deepStrictEqual(rows(expandSeries(forward, { horizon: [f('2026-01-27', '00:00'), f('2026-02-02', '00:00')] })).map((row) => row.slice(0, 33)), [
      '2026-01-07T09:00:2026-01-27T09:00', '2026-01-08T09:00:2026-01-28T09:00', '2026-01-09T09:00:2026-01-29T09:00',
      '2026-01-10T09:00:2026-01-30T09:00', '2026-01-11T09:00:2026-01-31T09:00', '2026-01-12T09:00:2026-02-01T09:00',
    ]);
    const back = defineSeries({ uid: 'a', base: compileRecurrence({ dtstart: f('2026-03-02', '09:00'), rrule: 'FREQ=DAILY;COUNT=5' }), overrides: [
      { recurrenceId: '2026-03-04T09:00:00', range: 'THISANDFUTURE', status: 'moved', start: f('2026-01-20', '09:00') },
    ] });
    assert.deepStrictEqual(rows(expandSeries(back, JANUARY)).map((row) => row.slice(0, 33)),
      ['2026-03-04T09:00:2026-01-20T09:00', '2026-03-05T09:00:2026-01-21T09:00', '2026-03-06T09:00:2026-01-22T09:00']);
  });

  it('a backward range under a small maxOccurrences keeps a prefix of the whole answer, and says it is incomplete', () => {
    const rule = compileRecurrence({ dtstart: f('2026-01-01', '09:00'), rrule: 'FREQ=DAILY' });
    const series = defineSeries({ uid: 'a', base: rule, overrides: [
      { recurrenceId: '2026-01-20T09:00:00', range: 'THISANDFUTURE', status: 'moved', start: f('2026-01-10', '21:00') },
    ] });
    const horizon = [f('2026-01-01', '00:00'), f('2026-03-01', '00:00')];
    const whole = expandSeries(series, { horizon });
    assert.strictEqual(whole.status, 'complete');
    for (const maxOccurrences of [5, 12, 25]) {
      const cut = expandSeries(series, { horizon, limits: { maxOccurrences } });
      assert.deepStrictEqual([cut.complete, cut.stoppedAt], [false, { limit: 'maxOccurrences' }], `${maxOccurrences}`);
      assert.ok(cut.occurrences.length <= maxOccurrences);
      assert.deepStrictEqual(rows(cut), rows(whole).slice(0, cut.occurrences.length), `${maxOccurrences}`);
    }
  });

  it('a zoned backward range under a small maxOccurrences: a run cut before its own slots keeps the answer a prefix', () => {
    const base = compileRecurrence({ dtstart: { kind: 'zoned', date: '2026-02-01', time: '00:00:00', zone: 'Europe/Amsterdam' }, rrule: 'FREQ=HOURLY' });
    const series = defineSeries({ uid: 'h', base, overrides: [{ recurrenceId: '2026-02-01T10:00:00', range: 'THISANDFUTURE', status: 'moved',
      start: { kind: 'zoned', date: '2026-02-01', time: '01:00:00', zone: 'Europe/Amsterdam' } }] });
    const options = { horizon: [at('2026-01-31T23:00:00Z'), at('2026-02-10T00:00:00Z')], zoneProvider: amsterdam };
    const whole = expandSeries(series, options);
    assert.strictEqual(whole.status, 'complete');
    assert.deepStrictEqual(whole.occurrences.slice(0, 5).map((o) => o.recurrenceId.slice(11, 13)), ['00', '01', '10', '02', '11']);
    assert.ok(whole.occurrences.length > 200 && whole.occurrences.length < 400, `${whole.occurrences.length}`);
    for (const maxOccurrences of [5, 30, 60]) {
      const cut = expandSeries(series, { ...options, limits: { maxOccurrences } });
      assert.deepStrictEqual([cut.complete, cut.stoppedAt], [false, { limit: 'maxOccurrences' }], `${maxOccurrences}`);
      assert.deepStrictEqual(cut.occurrences.map((o) => o.recurrenceId), whole.occurrences.slice(0, cut.occurrences.length).map((o) => o.recurrenceId));
    }
    // a run stopped at its cap cuts the answer where an unread slot could start (two days early for a zone) ...
    assert.ok(expandSeries(series, { ...options, limits: { maxOccurrences: 60 } }).occurrences.length > 0);
    // ... and leaves it complete when no unread slot can reach the horizon
    const roomy = expandSeries(series, { ...options, limits: { maxOccurrences: 290 } });
    assert.deepStrictEqual([roomy.status, roomy.occurrences.length], ['complete', whole.occurrences.length]);
  });

  it('a zoned series moves by wall clock across a change of offset, and its UNTIL reads each slot where the rule made it', () => {
    const base = compileRecurrence({ dtstart: { kind: 'zoned', date: '2026-03-26', time: '09:00:00', zone: 'Europe/Amsterdam' }, duration: 'PT1H',
      rrule: 'FREQ=DAILY;UNTIL=20260330T070000Z' });
    const series = defineSeries({ uid: 'z', base, overrides: [
      { recurrenceId: '2026-03-27T09:00:00', range: 'THISANDFUTURE', status: 'moved',
        start: { kind: 'zoned', date: '2026-03-27', time: '10:30:00', zone: 'Europe/Amsterdam' } },
    ] });
    const got = expandSeries(series, { horizon: [at('2026-03-20T00:00:00Z'), at('2026-04-10T00:00:00Z')], zoneProvider: amsterdam });
    assert.deepStrictEqual(got.occurrences.map((o) => [o.recurrenceId.slice(5, 10), /** @type {any} */ (o.start).time,
      new Date(/** @type {any} */ (o.instants).start).toISOString().slice(5, 16)]), [
      ['03-26', '09:00:00', '03-26T08:00'],
      ['03-27', '10:30:00', '03-27T09:30'],
      ['03-28', '10:30:00', '03-28T09:30'],
      ['03-29', '10:30:00', '03-29T08:30'],
      // 03-30 09:00 is 07:00Z, at UNTIL: made, then moved to 10:30
      ['03-30', '10:30:00', '03-30T08:30'],
    ]);
    // a range into the gap: 01:30 moved an hour later is 02:30, which starts at 03:30
    const night = defineSeries({ uid: 'n', base: compileRecurrence({ dtstart: { kind: 'zoned', date: '2026-03-28', time: '01:30:00', zone: 'Europe/Amsterdam' },
      rrule: 'FREQ=DAILY;COUNT=3' }), overrides: [{ recurrenceId: '2026-03-28T01:30:00', range: 'THISANDFUTURE', status: 'moved',
      start: { kind: 'zoned', date: '2026-03-28', time: '02:30:00', zone: 'Europe/Amsterdam' } }] });
    assert.deepStrictEqual(expandSeries(night, { horizon: [at('2026-03-27T00:00:00Z'), at('2026-04-01T00:00:00Z')], zoneProvider: amsterdam })
      .occurrences.map((o) => `${/** @type {any} */ (o.start).date}T${/** @type {any} */ (o.start).time}`),
    ['2026-03-28T02:30:00', '2026-03-29T03:30:00', '2026-03-30T02:30:00']);
  });

  it('a date series moves by whole days', () => {
    const base = compileRecurrence({ dtstart: dateValue('2026-01-05'), rrule: 'FREQ=WEEKLY;COUNT=4' });
    const series = defineSeries({ uid: 'd', base, overrides: [{ recurrenceId: '2026-01-12', range: 'THISANDFUTURE', status: 'moved', start: dateValue('2026-01-14') }] });
    assert.deepStrictEqual(rows(expandSeries(series, { horizon: [dateValue('2026-01-01'), dateValue('2026-03-01')] })),
      ['2026-01-05:2026-01-05-2026-01-06', '2026-01-12:2026-01-14-2026-01-15*', '2026-01-19:2026-01-21-2026-01-22*', '2026-01-26:2026-01-28-2026-01-29*']);
  });
});
