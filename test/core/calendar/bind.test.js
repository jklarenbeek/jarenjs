//@ts-check

/**
 * Binding a zone-less value to a zone, converting by kind, shifting by
 * civil days and splitting at civil-day boundaries, proved against the
 * transcribed change table the resolution sweep uses (New York, Amsterdam, Lord
 * Howe, Apia, UTC) and against synthetic tables that put a gap or fold
 * across midnight. The day-start oracle is the definition - every
 * instant the wall clock crosses up to midnight - not the code's route.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  bindFloating, toUtc, shiftCivil, splitByCivilDay, dateValue, floatingValue, zonedValue, utcValue, dateRangeValue,
  CalendarError,
} from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { ORACLE_ZONES, oracleZone, oracleResolve, oracleDayStart, tableProvider, sweepOf, partsOf } from './oracle.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const POLICIES = /** @type {const} */ (['rfc5545', 'later', 'reject']);
const provider = createIntlZoneProvider({ revision: 'pinned-for-test' });
const pad = (/** @type {number} */ n, w = 2) => String(n).padStart(w, '0');
const dateOf = (/** @type {number} */ days) => {
  const p = partsOf(days * DAY);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
};
const ctx = (/** @type {string} */ zone, /** @type {any} */ policy, p = /** @type {any} */ (provider)) => ({ zone, source: 'explicit', provider: p, policy });

/**
 * @param {string} code
 * @returns {(error: unknown) => boolean}
 */
const refusal = (code) => (error) => error instanceof CalendarError && error.code === code;

/** The days a change touches, with one either side. @param {{ at: number, before: number, after: number }} change */
const daysAround = ({ at, before, after }) => {
  const low = Math.floor((at + Math.min(before, after) * MINUTE) / DAY) - 1;
  const high = Math.floor((at + Math.max(before, after) * MINUTE) / DAY) + 1;
  return Array.from({ length: high - low + 1 }, (_, i) => low + i);
};

/**
 * The oracle's pieces of an interval: each day's span clipped, empty
 * days dropped.
 * @param {any} table
 * @param {number} start
 * @param {number} end
 * @param {'rfc5545' | 'later'} policy
 */
function oraclePieces(table, start, end, policy) {
  const pieces = [];
  for (let days = Math.floor(start / DAY) - 2; days <= Math.floor(end / DAY) + 2; days++) {
    const from = Math.max(start, /** @type {number} */ (oracleDayStart(table, days, policy)));
    const to = Math.min(end, /** @type {number} */ (oracleDayStart(table, days + 1, policy)));
    if (to > from)
      pieces.push({ date: dateOf(days), start: from, end: to });
  }
  return pieces;
}

describe('the oracle table: binding and day splits across every change 2000-2040', () => {
  for (const zone of ORACLE_ZONES) {
    const table = oracleZone(zone === 'UTC' ? 'Europe/Amsterdam' : zone);
    const truth = zone === 'UTC' ? { initial: 0, changes: [] } : table;

    it(`${zone}: a floating time binds to the instant every policy's table answer names`, () => {
      let checked = 0;
      for (const { wall } of sweepOf(zone)) {
        const p = partsOf(wall);
        const value = floatingValue(`${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`, `${pad(p.hours)}:${pad(p.minutes)}`);
        for (const policy of POLICIES) {
          const expected = oracleResolve(truth, wall, policy);
          if (expected === null) {
            assert.throws(() => bindFloating(value, ctx(zone, policy)), (error) => refusal('JY0002')(error) || refusal('JY0003')(error));
            continue;
          }
          const bound = /** @type {any} */ (bindFloating(value, ctx(zone, policy)));
          assert.strictEqual(bound.kind, 'instant');
          assert.strictEqual(bound.instant, expected.instant, `${zone} ${value.date}T${value.time} ${policy}`);
          assert.strictEqual(bound.resolution.kind, expected.kind);
          assert.deepStrictEqual(bound.value, { kind: 'zoned', date: value.date, time: value.time, zone });
          checked++;
        }
      }
      assert.ok(checked > 1000, `${checked} bindings checked`);
    });

    it(`${zone}: every day a change touches spans [its start, the next day's start) as the table defines them`, () => {
      let checked = 0;
      for (const change of table.changes) {
        for (const days of daysAround(change)) {
          for (const policy of POLICIES) {
            const start = oracleDayStart(truth, days, policy);
            const end = oracleDayStart(truth, days + 1, policy);
            const span = /** @type {any} */ (bindFloating(dateValue(dateOf(days)), ctx(zone, policy)));
            assert.strictEqual(span.kind, 'span');
            assert.deepStrictEqual([span.start, span.end], [start, end], `${zone} ${dateOf(days)} ${policy}`);
            assert.strictEqual(span.provider.revision, 'pinned-for-test');
            checked++;
          }
        }
      }
      if (zone !== 'UTC')
        assert.ok(checked >= table.changes.length * 9, `${checked} days checked`);
    });

    it(`${zone}: an interval across each change splits into the table's civil days, tiling it exactly`, () => {
      for (const { at } of table.changes) {
        const start = at - 30 * HOUR;
        const end = at + 30 * HOUR + 17 * MINUTE;
        for (const policy of /** @type {const} */ (['rfc5545', 'later'])) {
          const pieces = splitByCivilDay({ start, end }, ctx(zone, policy));
          assert.deepStrictEqual(pieces.map((x) => ({ ...x })), oraclePieces(truth, start, end, policy), `${zone} ${new Date(at).toISOString()}`);
          assert.strictEqual(pieces[0].start, start);
          assert.strictEqual(pieces.at(-1)?.end, end);
          for (let i = 1; i < pieces.length; i++)
            assert.strictEqual(pieces[i].start, pieces[i - 1].end);
          for (const piece of pieces) {
            for (const instant of [piece.start, piece.end - 1]) {
              const p = provider.toParts(instant, zone);
              assert.strictEqual(`${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`, piece.date);
            }
          }
        }
      }
    });
  }
});

describe('named days', () => {
  const hours = (/** @type {any} */ span) => (span.end - span.start) / HOUR;
  const day = (/** @type {string} */ date, /** @type {string} */ zone) => bindFloating(dateValue(date), ctx(zone, 'rfc5545'));

  it('a spring-forward day is 23 hours and a fall-back day 25, in Amsterdam and New York', () => {
    assert.strictEqual(hours(day('2026-03-29', 'Europe/Amsterdam')), 23);
    assert.strictEqual(hours(day('2026-10-25', 'Europe/Amsterdam')), 25);
    assert.strictEqual(hours(day('2026-06-01', 'Europe/Amsterdam')), 24);
    assert.strictEqual(hours(day('2026-03-08', 'America/New_York')), 23);
    assert.strictEqual(hours(day('2026-11-01', 'America/New_York')), 25);
    const spring = /** @type {any} */ (day('2026-03-29', 'Europe/Amsterdam'));
    assert.strictEqual(new Date(spring.start).toISOString(), '2026-03-28T23:00:00.000Z');
    assert.strictEqual(new Date(spring.end).toISOString(), '2026-03-29T22:00:00.000Z');
  });

  it('a half-hour change makes 23.5- and 24.5-hour days on Lord Howe', () => {
    assert.strictEqual(hours(day('2026-10-04', 'Australia/Lord_Howe')), 23.5);
    assert.strictEqual(hours(day('2026-04-05', 'Australia/Lord_Howe')), 24.5);
  });

  it("Apia's skipped 2011-12-30 is an empty span under every policy, and splits into no piece", () => {
    for (const policy of POLICIES) {
      const span = /** @type {any} */ (bindFloating(dateValue('2011-12-30'), ctx('Pacific/Apia', policy)));
      assert.strictEqual(span.start, Date.parse('2011-12-30T10:00:00Z'));
      assert.strictEqual(span.end, span.start);
      assert.strictEqual(span.resolution.start.kind, 'gap');
    }
    const pieces = splitByCivilDay({ start: Date.parse('2011-12-29T00:00:00Z'), end: Date.parse('2012-01-01T00:00:00Z') },
      ctx('Pacific/Apia', 'rfc5545'));
    assert.deepStrictEqual(pieces.map((x) => x.date), ['2011-12-28', '2011-12-29', '2011-12-31', '2012-01-01']);
  });

  it('a date range spans from its first day to its exclusive end day', () => {
    const range = /** @type {any} */ (bindFloating(dateRangeValue('2026-03-28', '2026-03-29'), ctx('Europe/Amsterdam', 'rfc5545')));
    assert.strictEqual(range.kind, 'span');
    assert.strictEqual(hours(range), 47);
    assert.deepStrictEqual(range.value, { kind: 'date-range', start: '2026-03-28', end: '2026-03-30' });
  });

  it("24:00 on an end bound is the next day's start, not midnight plus 24 hours", () => {
    const close = /** @type {any} */ (bindFloating(floatingValue('2026-03-29', '24:00', { bound: 'end' }),
      { ...ctx('Europe/Amsterdam', 'rfc5545'), bound: 'end' }));
    assert.strictEqual(close.instant, Date.parse('2026-03-29T22:00:00Z'));
    assert.deepStrictEqual(close.value, { kind: 'zoned', date: '2026-03-29', time: '24:00', zone: 'Europe/Amsterdam' });
    assert.throws(() => bindFloating({ kind: 'floating', date: '2026-03-29', time: '24:00' }, ctx('Europe/Amsterdam', 'rfc5545')), refusal('JY0008'));
    const zoned = /** @type {any} */ (toUtc(zonedValue('2026-10-25', '24:00', 'Europe/Amsterdam', { bound: 'end' }),
      { provider, policy: 'reject', bound: 'end' }));
    assert.strictEqual(zoned.instant, Date.parse('2026-10-25T23:00:00Z'));
  });
});

describe('midnight inside a change (synthetic tables)', () => {
  const at = Date.parse('2030-01-01T23:30:00Z');
  const midGap = tableProvider('Test/MidGap', { initial: 0, changes: [{ at, before: 0, after: 60 }] });
  const crossing = tableProvider('Test/Crossing', { initial: 60, changes: [{ at, before: 60, after: 0 }] });
  const opening = tableProvider('Test/Opening', { initial: 60, changes: [{ at: Date.parse('2030-01-02T00:00:00Z'), before: 60, after: 0 }] });

  it('a gap that midnight falls inside starts the day at the jump, under every policy', () => {
    for (const policy of POLICIES) {
      const span = /** @type {any} */ (bindFloating(dateValue('2030-01-02'), ctx('Test/MidGap', policy, midGap)));
      assert.strictEqual(span.start, at, policy);
      assert.strictEqual((span.end - span.start) / HOUR, 23.5);
    }
  });

  it('a fold that opens at midnight starts the day once, at the first midnight, under every policy', () => {
    for (const policy of POLICIES) {
      const span = /** @type {any} */ (bindFloating(dateValue('2030-01-02'), ctx('Test/Opening', policy, opening)));
      assert.strictEqual(span.start, Date.parse('2030-01-01T23:00:00Z'), policy);
      assert.strictEqual((span.end - span.start) / HOUR, 25);
    }
  });

  it('a fold that returns the clock to the day before leaves the start to the policy; reject refuses it', () => {
    const start = (/** @type {any} */ policy) => /** @type {any} */ (bindFloating(dateValue('2030-01-02'), ctx('Test/Crossing', policy, crossing))).start;
    assert.strictEqual(start('rfc5545'), Date.parse('2030-01-01T23:00:00Z'));
    assert.strictEqual(start('later'), Date.parse('2030-01-02T00:00:00Z'));
    assert.throws(() => start('reject'), refusal('JY0003'));
    const interval = { start: Date.parse('2030-01-01T12:00:00Z'), end: Date.parse('2030-01-02T12:00:00Z') };
    assert.throws(() => splitByCivilDay(interval, ctx('Test/Crossing', 'reject', crossing)), refusal('JY0003'));
    for (const policy of /** @type {const} */ (['rfc5545', 'later'])) {
      const table = { initial: 60, changes: [{ at, before: 60, after: 0 }] };
      const pieces = splitByCivilDay(interval, ctx('Test/Crossing', policy, crossing));
      assert.deepStrictEqual(pieces.map((x) => ({ ...x })), oraclePieces(table, interval.start, interval.end, policy), policy);
    }
    // an instant in the replayed half hour reads the day before but lies after the rfc5545 start
    const replayed = splitByCivilDay({ start: at + 10 * MINUTE, end: at + 20 * MINUTE }, ctx('Test/Crossing', 'rfc5545', crossing));
    assert.deepStrictEqual(replayed.map((x) => x.date), ['2030-01-02']);
    // an instant between the two midnights reads the new day but, under later, belongs to the day before
    const early = splitByCivilDay({ start: at - 20 * MINUTE, end: at - 15 * MINUTE }, ctx('Test/Crossing', 'later', crossing));
    assert.deepStrictEqual(early.map((x) => x.date), ['2030-01-01']);
    assert.strictEqual(crossing.toParts(at - 20 * MINUTE, 'Test/Crossing').day, 2);
  });
});

describe('no zone, no guess', () => {
  it('a missing or null zone answers unresolved without reading a provider or a policy', () => {
    for (const value of [dateValue('2026-03-29'), floatingValue('2026-03-29', '09:00'), dateRangeValue('2026-03-29', '2026-03-30')]) {
      for (const options of [undefined, {}, { zone: null }, { zone: undefined, source: 'tenant' }]) {
        assert.deepStrictEqual(bindFloating(value, options), { kind: 'unresolved', reason: 'no-zone', value });
        assert.deepStrictEqual(toUtc(value, options), { kind: 'unresolved', reason: 'no-zone', value });
      }
    }
    const answer = bindFloating(floatingValue('2026-03-29', '09:00'), { zone: null });
    assert.ok(Object.isFrozen(answer));
  });

  it('a zone that is not a non-empty name is refused, never read as missing', () => {
    assert.throws(() => bindFloating(dateValue('2026-03-29'), { zone: '' }), refusal('JY0001'));
    assert.throws(() => bindFloating(dateValue('2026-03-29'), { zone: /** @type {any} */ (5) }), refusal('JY0001'));
    assert.throws(() => bindFloating(dateValue('2026-03-29'), ctx('Mars/Olympus', 'rfc5545')), refusal('JY0001'));
  });

  it('answers the same whatever the host zone', () => {
    const probe = `
      import { bindFloating, splitByCivilDay, dateValue, floatingValue } from '@jarenjs/core/calendar';
      import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
      const provider = createIntlZoneProvider({ revision: 'r' });
      const o = { zone: 'Europe/Amsterdam', source: 'explicit', provider, policy: 'rfc5545' };
      console.log(JSON.stringify([
        bindFloating(dateValue('2026-03-29'), o), bindFloating(floatingValue('2026-10-25', '02:30'), o),
        bindFloating(floatingValue('2026-10-25', '02:30'), { zone: null }),
        splitByCivilDay({ start: Date.parse('2026-10-24T20:00:00Z'), end: Date.parse('2026-10-25T06:00:00Z') }, o),
      ]));
    `;
    const answers = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'].map((tz) => execFileSync(process.execPath,
      ['--input-type=module', '-e', probe], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, TZ: tz, FORCE_COLOR: '0' } }));
    assert.strictEqual(answers[1], answers[0]);
    assert.strictEqual(answers[2], answers[0]);
    assert.ok(answers[0].includes('"no-zone"'));
  });
});

describe('the options a binding reads', () => {
  it('records the source, or unrecorded, and the provider identity on every answer', () => {
    const bound = /** @type {any} */ (bindFloating(floatingValue('2026-03-29', '09:00'), ctx('Europe/Amsterdam', 'later')));
    assert.deepStrictEqual(bound.binding, { zone: 'Europe/Amsterdam', source: 'explicit' });
    assert.deepStrictEqual(bound.provider, { name: 'intl', revision: 'pinned-for-test' });
    assert.strictEqual(bound.resolution.provider, bound.provider);
    const unsourced = /** @type {any} */ (bindFloating(dateValue('2026-03-29'), { zone: 'Europe/Amsterdam', provider, policy: 'later' }));
    assert.strictEqual(unsourced.binding.source, 'unrecorded');
    assert.strictEqual(unsourced.resolution.end.provider.revision, 'pinned-for-test');
    const anonymous = { toParts: provider.toParts, toEpoch: provider.toEpoch, candidates: provider.candidates };
    assert.deepStrictEqual(/** @type {any} */ (bindFloating(dateValue('2026-03-29'), ctx('Europe/Amsterdam', 'later', anonymous))).provider,
      { name: 'unrecorded', revision: 'unrecorded' });
    for (const source of ['', 5, {}])
      assert.throws(() => bindFloating(dateValue('2026-03-29'), { ...ctx('Europe/Amsterdam', 'later'), source: /** @type {any} */ (source) }), refusal('JY0014'));
  });

  it('requires a policy and a provider with candidates and toParts once a zone is given', () => {
    const value = dateValue('2026-03-29');
    assert.throws(() => bindFloating(value, { zone: 'Europe/Amsterdam', provider }), refusal('JY0006'));
    assert.throws(() => bindFloating(value, { zone: 'Europe/Amsterdam', provider, policy: /** @type {any} */ ('earlier') }), refusal('JY0005'));
    assert.throws(() => bindFloating(value, { zone: 'Europe/Amsterdam', policy: 'later' }), refusal('JY0004'));
    assert.throws(() => bindFloating(value, ctx('Europe/Amsterdam', 'later', { candidates: provider.candidates })), refusal('JY0004'));
    assert.throws(() => bindFloating(value, { ...ctx('Europe/Amsterdam', 'later'), bound: /** @type {any} */ ('middle') }), refusal('JY0014'));
  });

  it('refuses a provider whose toParts throws or answers no date', () => {
    const throwing = { ...provider, toParts: (/** @type {number} */ e, /** @type {string} */ z) => { if (e !== 0) throw new RangeError('boom'); return provider.toParts(e, z); } };
    assert.throws(() => splitByCivilDay({ start: 1, end: 2 }, ctx('Europe/Amsterdam', 'later', throwing)),
      (error) => refusal('JY0004')(error) && /** @type {any} */ (error).cause instanceof RangeError);
    const dateless = { ...provider, toParts: () => ({ year: 'x' }) };
    assert.throws(() => splitByCivilDay({ start: 1, end: 2 }, ctx('Europe/Amsterdam', 'later', dateless)), refusal('JY0004'));
    const forgetful = { ...provider, toParts: () => { throw new RangeError('unknown'); } };
    assert.throws(() => splitByCivilDay({ start: 1, end: 2 }, ctx('Europe/Amsterdam', 'later', forgetful)), refusal('JY0001'));
  });

  it('refuses a utc or zoned value: it names its own instant', () => {
    assert.throws(() => bindFloating(utcValue(0), ctx('Europe/Amsterdam', 'later')), refusal('JY0013'));
    assert.throws(() => bindFloating(zonedValue('2026-03-29', '09:00', 'UTC'), ctx('Europe/Amsterdam', 'later')), refusal('JY0013'));
    assert.throws(() => bindFloating(/** @type {any} */ ({ kind: 'date', date: '2026-02-30' }), ctx('UTC', 'later')), refusal('JY0012'));
  });
});

describe('toUtc', () => {
  it('reads seconds and a fraction to the exact millisecond, through the provider and without it', () => {
    const at = ctx('Europe/Amsterdam', 'rfc5545');
    assert.strictEqual(/** @type {any} */ (bindFloating(floatingValue('2026-06-01', '09:00:05.25'), at)).instant,
      Date.parse('2026-06-01T07:00:05.250Z'));
    assert.strictEqual(/** @type {any} */ (toUtc(zonedValue('2026-12-01', '23:59:59.007', 'Europe/Amsterdam'), at)).instant,
      Date.parse('2026-12-01T22:59:59.007Z'));
    assert.strictEqual(/** @type {any} */ (toUtc(utcValue('2026-03-29T01:30:07.5Z'))).instant, Date.parse('2026-03-29T01:30:07.500Z'));
    assert.strictEqual(/** @type {any} */ (toUtc(utcValue('1969-12-31T23:59:59.99Z'))).instant, -10);
  });

  it('a utc value is its own instant, without a provider or policy', () => {
    const value = utcValue('2026-03-29T01:30:00.250Z');
    const answer = /** @type {any} */ (toUtc(value));
    assert.deepStrictEqual(answer, { kind: 'instant', value, instant: Date.parse('2026-03-29T01:30:00.250Z') });
  });

  it('a zoned value resolves in its own zone, whatever zone the options name', () => {
    const value = zonedValue('2026-10-25', '02:30', 'Europe/Amsterdam');
    const later = /** @type {any} */ (toUtc(value, { zone: 'Asia/Tokyo', provider, policy: 'later' }));
    assert.strictEqual(later.instant, Date.parse('2026-10-25T01:30:00Z'));
    assert.strictEqual(later.resolution.kind, 'fold');
    assert.ok(!('binding' in later));
    assert.throws(() => toUtc(value, { provider }), refusal('JY0006'));
    assert.throws(() => toUtc(value, { provider, policy: 'reject' }), refusal('JY0003'));
    assert.throws(() => toUtc(zonedValue('2026-03-29', '09:00', 'Mars/Olympus'), { provider, policy: 'later' }), refusal('JY0001'));
  });

  it('a floating value or a day binds to the options zone', () => {
    const answer = /** @type {any} */ (toUtc(floatingValue('2026-03-29', '02:30'), ctx('Europe/Amsterdam', 'rfc5545')));
    assert.strictEqual(answer.instant, Date.parse('2026-03-29T01:30:00Z'));
    assert.strictEqual(/** @type {any} */ (toUtc(dateValue('2026-10-25'), ctx('Europe/Amsterdam', 'rfc5545'))).kind, 'span');
  });
});

describe('shiftCivil', () => {
  it('moves the wall clock by civil days and resolves the moved value', () => {
    const shifted = /** @type {any} */ (shiftCivil(zonedValue('2026-03-22', '02:30', 'Europe/Amsterdam'), { days: 7 }, { provider, policy: 'rfc5545' }));
    assert.deepStrictEqual(shifted.value, { kind: 'zoned', date: '2026-03-29', time: '02:30', zone: 'Europe/Amsterdam' });
    assert.strictEqual(shifted.instant, Date.parse('2026-03-29T01:30:00Z'));
    assert.strictEqual(shifted.resolution.kind, 'gap');
    const back = /** @type {any} */ (shiftCivil(zonedValue('2026-03-30', '09:00', 'Europe/Amsterdam'), { days: -2 }, { provider, policy: 'reject' }));
    assert.strictEqual(back.instant - Date.parse('2026-03-30T07:00:00Z'), -47 * HOUR);
  });

  it('keeps a zone-less value unresolved without a zone, carrying the moved value', () => {
    assert.deepStrictEqual(shiftCivil(floatingValue('2026-12-31', '23:00'), { days: 1 }),
      { kind: 'unresolved', reason: 'no-zone', value: { kind: 'floating', date: '2027-01-01', time: '23:00' } });
    assert.deepStrictEqual(/** @type {any} */ (shiftCivil(dateValue('2028-02-28'), { days: 1 })).value, { kind: 'date', date: '2028-02-29' });
    assert.deepStrictEqual(/** @type {any} */ (shiftCivil(dateRangeValue('2026-07-01', '2026-07-14'), { days: 31 })).value,
      { kind: 'date-range', start: '2026-08-01', end: '2026-08-15' });
    const day = /** @type {any} */ (shiftCivil(dateValue('2026-10-18'), { days: 7 }, ctx('Europe/Amsterdam', 'rfc5545')));
    assert.strictEqual((day.end - day.start) / HOUR, 25);
  });

  it('moves a utc value by 24-hour days, and a closing 24:00 with its bound', () => {
    assert.deepStrictEqual(/** @type {any} */ (shiftCivil(utcValue('2026-03-28T12:00:00Z'), { days: 1 })).value,
      { kind: 'utc', instant: '2026-03-29T12:00:00.000Z' });
    const close = /** @type {any} */ (shiftCivil(floatingValue('2026-03-28', '24:00', { bound: 'end' }), { days: 1 },
      { ...ctx('Europe/Amsterdam', 'rfc5545'), bound: 'end' }));
    assert.strictEqual(close.instant, Date.parse('2026-03-29T22:00:00Z'));
  });

  it('refuses a day count that is not whole and a move past 9999-12-31', () => {
    for (const days of [1.5, NaN, '1', undefined])
      assert.throws(() => shiftCivil(dateValue('2026-03-29'), { days: /** @type {any} */ (days) }), refusal('JY0014'));
    assert.throws(() => shiftCivil(/** @type {any} */ (dateValue('2026-03-29')), /** @type {any} */ (undefined)), refusal('JY0014'));
    assert.throws(() => shiftCivil(dateValue('9999-12-31'), { days: 1 }), refusal('JY0012'));
    assert.throws(() => shiftCivil(utcValue('0000-01-01T00:00:00Z'), { days: -1 }), refusal('JY0012'));
  });
});

describe('splitByCivilDay', () => {
  const o = ctx('Europe/Amsterdam', 'rfc5545');

  it('splits a night shift across the fall-back change for payroll', () => {
    const pieces = splitByCivilDay({ start: Date.parse('2026-10-24T20:00:00Z'), end: Date.parse('2026-10-25T06:00:00Z') }, o);
    assert.deepStrictEqual(pieces.map((x) => [x.date, (x.end - x.start) / HOUR]), [['2026-10-24', 2], ['2026-10-25', 8]]);
    assert.ok(Object.isFrozen(pieces) && Object.isFrozen(pieces[0]));
  });

  it('answers no piece for an empty interval, one for an interval inside a day', () => {
    assert.deepStrictEqual(splitByCivilDay({ start: 5, end: 5 }, o), []);
    assert.deepStrictEqual(splitByCivilDay({ start: Date.parse('2026-06-01T08:00:00Z'), end: Date.parse('2026-06-01T09:00:00Z') }, o).map((x) => x.date),
      ['2026-06-01']);
  });

  it('refuses a malformed interval, a missing zone and a walk past maxDays', () => {
    for (const interval of [null, {}, { start: 2, end: 1 }, { start: 0.5, end: 1 }, { start: 0, end: Infinity }])
      assert.throws(() => splitByCivilDay(/** @type {any} */ (interval), o), refusal('JY0014'));
    assert.throws(() => splitByCivilDay({ start: 0, end: 1 }, /** @type {any} */ ({ provider, policy: 'later' })), refusal('JY0001'));
    assert.throws(() => splitByCivilDay({ start: 0, end: 1 }, /** @type {any} */ ({ zone: 'UTC', provider })), refusal('JY0006'));
    const week = { start: Date.parse('2026-06-01T00:00:00Z'), end: Date.parse('2026-06-08T00:00:00Z') };
    assert.strictEqual(splitByCivilDay(week, { ...o, maxDays: 8 }).length, 8);
    assert.throws(() => splitByCivilDay(week, { ...o, maxDays: 3 }), refusal('JY0014'));
    for (const maxDays of [0, 1.5, 'x'])
      assert.throws(() => splitByCivilDay(week, { ...o, maxDays: /** @type {any} */ (maxDays) }), refusal('JY0014'));
  });
});
