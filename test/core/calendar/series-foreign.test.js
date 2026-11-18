//@ts-check

/**
 * A zoned series' RDATEs and EXDATEs given in another zone or as utc
 * values (RFC 5545 lets each RDATE and EXDATE carry its own TZID). Each
 * is read at its instant: an RDATE adds the slot the series' wall clock
 * names there; an EXDATE removes every slot that starts at its instant
 * (§3.8.5.1: the set is the RRULE and RDATE starts, "and then excluding
 * any start DATE-TIME values specified by EXDATE"). The zones answer from
 * the zdump transitions through oracle.js's arithmetic provider.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileRecurrence, defineSeries, expandSeries, floatingValue } from '@jarenjs/core/calendar';
import { oracleZone, tableProvider } from './oracle.js';

const at = (/** @type {string} */ text) => Date.parse(text);
const iso = (/** @type {number} */ instant) => new Date(instant).toISOString().slice(0, 16);
/** @param {string} date @param {string} time @param {string} [zone] */
const z = (date, time, zone = 'Europe/Amsterdam') => ({ kind: /** @type {const} */ ('zoned'), date, time, zone });
const utc = (/** @type {string} */ instant) => ({ kind: /** @type {const} */ ('utc'), instant });

// one provider for two zones, each answered from its own table
const zones = { 'Europe/Amsterdam': tableProvider('Europe/Amsterdam', oracleZone('Europe/Amsterdam')),
  'America/New_York': tableProvider('America/New_York', oracleZone('America/New_York')) };
const of = (/** @type {string} */ zone) => {
  const provider = /** @type {any} */ (zones)[zone];
  if (provider === undefined)
    throw new RangeError(`unknown zone ${zone}`);
  return provider;
};
const provider = {
  toParts: (/** @type {number} */ epoch, /** @type {string} */ zone) => of(zone).toParts(epoch, zone),
  toEpoch: () => { throw new Error('not used'); },
  candidates: (/** @type {any} */ parts, /** @type {string} */ zone) => of(zone).candidates(parts, zone),
  identity: Object.freeze({ name: 'tables', revision: 'synthetic' }),
};
const MARCH = { horizon: [at('2026-03-01T00:00:00Z'), at('2026-04-01T00:00:00Z')], zoneProvider: provider };

/** `id start-wall instant` per occurrence. @param {import('@jarenjs/core/calendar').SeriesExpansion} expansion */
const rows = (expansion) => expansion.occurrences.map((/** @type {any} */ o) =>
  `${o.recurrenceId.slice(0, 16)} ${o.start.date}T${o.start.time.slice(0, 5)} ${iso(o.instants.start)}-${iso(o.instants.end).slice(11)}`);

const daily = compileRecurrence({ dtstart: z('2026-03-09', '09:00:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=5' });

describe('a zoned series\' RDATEs and EXDATEs in another zone or utc', () => {
  it('an RDATE is read at its instant and named by the series\' wall clock there; a period keeps its own length', () => {
    const series = defineSeries({ uid: 'f', base: daily, rdates: [
      utc('2026-03-10T15:00:00Z'),
      // New York has been on -04:00 since 2026-03-08: 10:00 there is 14:00Z, 15:00 in Amsterdam
      z('2026-03-12', '10:00:00', 'America/New_York'),
      { start: z('2026-03-14', '10:00:00', 'America/New_York'), end: z('2026-03-14', '12:30:00', 'America/New_York') },
      // a period whose end is in the series' own zone
      { start: utc('2026-03-15T08:00:00Z'), end: z('2026-03-15', '09:45:00') },
    ] });
    const got = expandSeries(series, MARCH);
    assert.strictEqual(got.status, 'complete');
    assert.deepStrictEqual(rows(got), [
      '2026-03-09T09:00 2026-03-09T09:00 2026-03-09T08:00-09:00',
      '2026-03-10T09:00 2026-03-10T09:00 2026-03-10T08:00-09:00',
      '2026-03-10T16:00 2026-03-10T16:00 2026-03-10T15:00-16:00',
      '2026-03-11T09:00 2026-03-11T09:00 2026-03-11T08:00-09:00',
      '2026-03-12T09:00 2026-03-12T09:00 2026-03-12T08:00-09:00',
      '2026-03-12T15:00 2026-03-12T15:00 2026-03-12T14:00-15:00',
      '2026-03-13T09:00 2026-03-13T09:00 2026-03-13T08:00-09:00',
      '2026-03-14T15:00 2026-03-14T15:00 2026-03-14T14:00-16:30',
      '2026-03-15T09:00 2026-03-15T09:00 2026-03-15T08:00-08:45',
    ]);
  });

  it('an RDATE at a rule slot\'s instant is that slot once', () => {
    const series = defineSeries({ uid: 'f', base: daily, rdates: [utc('2026-03-11T08:00:00Z'), z('2026-03-12', '04:00:00', 'America/New_York')] });
    assert.strictEqual(expandSeries(series, MARCH).occurrences.length, 5);
    // an RDATE in the series' own zone wins over one elsewhere that names the same slot
    const both = defineSeries({ uid: 'f', base: daily, rdates: [
      { start: utc('2026-03-20T12:00:00Z'), end: utc('2026-03-20T15:00:00Z') }, z('2026-03-20', '13:00:00'),
    ] });
    assert.deepStrictEqual(rows(expandSeries(both, MARCH)).at(-1), '2026-03-20T13:00 2026-03-20T13:00 2026-03-20T12:00-13:00');
  });

  it('an EXDATE removes the slot that starts at its instant, and nothing when none does', () => {
    const series = defineSeries({ uid: 'f', base: daily, rdates: [utc('2026-03-20T12:00:00Z')], exdates: [
      utc('2026-03-11T08:00:00Z'), z('2026-03-13', '04:00:00', 'America/New_York'), utc('2026-03-10T08:30:00Z'), z('2026-03-20', '08:00:00', 'America/New_York'),
    ] });
    assert.deepStrictEqual(expandSeries(series, MARCH).occurrences.map((o) => o.recurrenceId.slice(5, 16)), ['03-09T09:00', '03-10T09:00', '03-12T09:00']);
  });

  it('an EXDATE removes every slot that starts at its instant: a time a gap moved and the time it moved onto', () => {
    const base = compileRecurrence({ dtstart: z('2026-03-29', '02:00:00'), rrule: 'FREQ=DAILY;BYHOUR=2,3;COUNT=4' });
    const keep = expandSeries(defineSeries({ uid: 'g', base }), MARCH);
    assert.deepStrictEqual(keep.occurrences.map((o) => iso(/** @type {any} */ (o.instants).start)),
      ['2026-03-29T01:00', '2026-03-29T01:00', '2026-03-30T00:00', '2026-03-30T01:00']);
    const cut = expandSeries(defineSeries({ uid: 'g', base, exdates: [utc('2026-03-29T01:00:00Z')] }), MARCH);
    assert.deepStrictEqual(cut.occurrences.map((o) => o.recurrenceId), ['2026-03-30T02:00:00', '2026-03-30T03:00:00']);
    // an EXDATE in the series' own zone still names one slot by its wall clock
    const own = expandSeries(defineSeries({ uid: 'g', base, exdates: [z('2026-03-29', '02:00:00')] }), MARCH);
    assert.deepStrictEqual(own.occurrences.map((o) => o.recurrenceId), ['2026-03-29T03:00:00', '2026-03-30T02:00:00', '2026-03-30T03:00:00']);
  });

  it('an override of a slot such an EXDATE removed is an orphan; a range moves a later RDATE', () => {
    const series = defineSeries({ uid: 'f', base: daily, rdates: [utc('2026-03-20T12:00:00Z')], exdates: [utc('2026-03-11T08:00:00Z')], overrides: [
      { recurrenceId: '2026-03-11T09:00:00', status: 'moved', start: z('2026-03-11', '10:00:00') },
      { recurrenceId: '2026-03-12T09:00:00', status: 'moved', start: z('2026-03-12', '11:00:00'), range: 'THISANDFUTURE' },
    ] });
    const got = expandSeries(series, MARCH);
    assert.deepStrictEqual(got.orphans, { count: 1, ids: ['2026-03-11T09:00:00'] });
    assert.deepStrictEqual(got.occurrences.map((o) => `${o.recurrenceId.slice(5, 16)}>${/** @type {any} */ (o.start).time.slice(0, 5)}`),
      ['03-09T09:00>09:00', '03-10T09:00>09:00', '03-12T09:00>11:00', '03-13T09:00>11:00', '03-20T13:00>15:00']);
  });

  it('an RDATE on the second pass of the series\' repeated hour is refused: its wall clock names the first', () => {
    const base = compileRecurrence({ dtstart: z('2026-10-24', '09:00:00'), rrule: 'FREQ=DAILY;COUNT=2' });
    const horizon = { horizon: [at('2026-10-01T00:00:00Z'), at('2026-11-01T00:00:00Z')], zoneProvider: provider };
    // 2026-10-25 02:30 happens at 00:30Z (+02:00) and again at 01:30Z (+01:00)
    assert.throws(() => expandSeries(defineSeries({ uid: 'r', base, rdates: [utc('2026-10-25T01:30:00Z')] }), horizon),
      (/** @type {any} */ error) => error.code === 'JY0013' && error.docPath === '/rdates/0');
    assert.deepStrictEqual(expandSeries(defineSeries({ uid: 'r', base, rdates: [utc('2026-10-25T00:30:00Z')] }), horizon).occurrences
      .map((o) => o.recurrenceId), ['2026-10-24T09:00:00', '2026-10-25T02:30:00', '2026-10-25T09:00:00']);
    // under `later` the series reads 02:30 as the second pass
    const later = compileRecurrence({ dtstart: z('2026-10-24', '09:00:00'), rrule: 'FREQ=DAILY;COUNT=2', policy: 'later' });
    assert.strictEqual(expandSeries(defineSeries({ uid: 'r', base: later, rdates: [utc('2026-10-25T01:30:00Z')] }), horizon).occurrences.length, 3);
  });

  it('refusals: a period that ends before it starts, a time the policy refuses, another kind for a series of times without a zone', () => {
    assert.throws(() => expandSeries(defineSeries({ uid: 'p', base: daily,
      rdates: [{ start: z('2026-03-14', '10:00:00', 'America/New_York'), end: z('2026-03-14', '14:00:00') }] }), MARCH),
    (/** @type {any} */ error) => error.code === 'JY0014' && error.docPath === '/rdates/0/end');
    const strict = compileRecurrence({ dtstart: z('2026-03-09', '09:00:00'), rrule: 'FREQ=DAILY;COUNT=5', policy: 'reject' });
    // 2026-03-08 02:30 never happens in New York; under reject the EXDATE refuses wherever it falls
    assert.throws(() => expandSeries(defineSeries({ uid: 'p', base: strict, exdates: [z('2026-03-08', '02:30:00', 'America/New_York')] }), MARCH),
      (/** @type {any} */ error) => error.code === 'JY0002');
    const floating = compileRecurrence({ dtstart: floatingValue('2026-03-09', '09:00'), rrule: 'FREQ=DAILY;COUNT=5' });
    assert.throws(() => defineSeries({ uid: 'p', base: floating, rdates: [utc('2026-03-10T15:00:00Z')] }),
      (/** @type {any} */ error) => error.code === 'JY0013' && error.docPath === '/rdates/0/kind');
    assert.throws(() => defineSeries({ uid: 'p', base: daily, exdates: [utc('2026-03-10T15:00:00.5Z')] }),
      (/** @type {any} */ error) => error.code === 'JY0013');
  });
});
