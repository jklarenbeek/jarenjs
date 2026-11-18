//@ts-check

/**
 * Zone definitions (VTIMEZONE as neutral JSON) both ways: a definition
 * the provider writes compiles back into a provider that answers as the
 * provider does, proved on the oracle's sweep of every change 2000-2040;
 * definitions by rule are checked against the transcribed table, and
 * definitions that contradict themselves, reach past their horizon or
 * cross a limit are refused or stopped by name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CalendarError, RESOLUTION_POLICIES, VTIMEZONE_LIMITS, classifyLocal, compileRecurrence, compileVtimezone, expandRecurrence, isZone, resolveLocal,
  todayIn, vtimezoneFor,
} from '@jarenjs/core/calendar';
import { createRuntime } from '@jarenjs/core/runtime';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { ORACLE_ZONES, oracleZone, partsOf, sweepOf, tableProvider } from './oracle.js';

const intl = createIntlZoneProvider({ revision: 'pinned-for-test' });
const HORIZON = /** @type {[number, number]} */ ([Date.UTC(2000, 0, 1), Date.UTC(2041, 0, 1)]);
const iso = (/** @type {number} */ at) => new Date(at).toISOString();

/**
 * @param {string} code
 * @returns {(error: unknown) => boolean}
 */
const refusal = (code) => (error) => error instanceof CalendarError && error.code === code;

/** New York by rule, as the IANA database has it for 1987-2040 (RFC 5545's own example, cut to 1987). */
const NEW_YORK = Object.freeze({
  tzid: 'America/New_York',
  observances: [
    { type: 'daylight', start: '1987-04-05T02:00:00', offsetFrom: '-05:00', offsetTo: '-04:00', rrule: 'FREQ=YEARLY;BYMONTH=4;BYDAY=1SU;UNTIL=20060402T070000Z' },
    { type: 'standard', start: '1967-10-29T02:00:00', offsetFrom: '-04:00', offsetTo: '-05:00', rrule: 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;UNTIL=20061029T060000Z' },
    { type: 'daylight', start: '2007-03-11T02:00:00', offsetFrom: '-05:00', offsetTo: '-04:00', rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=2SU' },
    { type: 'standard', start: '2007-11-04T02:00:00', offsetFrom: '-04:00', offsetTo: '-05:00', rrule: 'FREQ=YEARLY;BYMONTH=11;BYDAY=1SU' },
  ],
});

/** Amsterdam by rule since 1996, anchored in 1601 as a desktop exporter writes it. */
const AMSTERDAM_1601 = Object.freeze({
  tzid: 'Europe/Amsterdam',
  observances: [
    { type: 'daylight', start: '1601-03-25T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00', rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU' },
    { type: 'standard', start: '1601-10-28T03:00:00', offsetFrom: '+02:00', offsetTo: '+01:00', rrule: 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU' },
  ],
});

/**
 * The changes a compiled zone holds, as the oracle table spells them.
 * @param {import('@jarenjs/core/calendar').CompiledZone} zone
 */
const changesOf = (zone) => zone.transitions.map(({ at, before, after }) => ({ at, before, after }));

describe('vtimezoneFor then compileVtimezone: the Intl provider over 2000-2040, point for point', () => {
  for (const zone of ORACLE_ZONES) {
    it(`${zone}: candidates, toEpoch and every policy equal the Intl provider's on the oracle sweep`, () => {
      const definition = vtimezoneFor(zone, { provider: intl, horizon: HORIZON });
      const compiled = compileVtimezone(definition, { horizon: HORIZON });
      // the changes found are the transcribed table's, not only the Intl provider's
      assert.deepStrictEqual(changesOf(compiled), oracleZone(zone).changes, `${zone} changes`);
      assert.strictEqual(compiled.status, 'complete');
      let points = 0;
      for (const { wall } of sweepOf(zone)) {
        const parts = partsOf(wall);
        const at = `${zone} ${iso(wall).slice(0, 16)} local`;
        assert.deepStrictEqual(compiled.candidates(parts, zone), intl.candidates(parts, zone), at);
        for (const disambiguation of ['reject', 'earlier', 'later'])
          assert.ok(Object.is(compiled.toEpoch(parts, zone, disambiguation), intl.toEpoch(parts, zone, disambiguation)), `${at} ${disambiguation}`);
        assert.deepStrictEqual({ ...classifyLocal(parts, zone, compiled) }, { ...classifyLocal(parts, zone, intl) }, at);
        for (const policy of RESOLUTION_POLICIES) {
          /** @param {any} provider */
          const resolved = (provider) => {
            try {
              const { instant, resolution } = resolveLocal(parts, zone, { provider, policy });
              return { instant, kind: resolution.kind, offsetMinutes: resolution.offsetMinutes };
            }
            catch (error) {
              return /** @type {any} */ (error).code;
            }
          };
          assert.deepStrictEqual(resolved(compiled), resolved(intl), `${at} ${policy}`);
        }
        points++;
      }
      assert.ok(points > 300, `${zone}: ${points} points`);
    });
  }

  it('writes the horizon start as an onset, then RDATE onsets grouped by their two offsets, and TZUNTIL at the horizon end', () => {
    const definition = vtimezoneFor('Europe/Amsterdam', { provider: intl, horizon: [Date.UTC(2026, 0, 1), Date.UTC(2028, 0, 1)] });
    assert.deepStrictEqual(definition, {
      tzid: 'Europe/Amsterdam',
      observances: [
        { type: 'standard', start: '2026-01-01T01:00:00', offsetFrom: '+01:00', offsetTo: '+01:00' },
        { type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00', rdates: ['2027-03-28T02:00:00'] },
        { type: 'standard', start: '2026-10-25T03:00:00', offsetFrom: '+02:00', offsetTo: '+01:00', rdates: ['2027-10-31T03:00:00'] },
      ],
      until: '2028-01-01T00:00:00Z',
    });
    assert.ok(Object.isFrozen(definition) && Object.isFrozen(definition.observances[1]) && Object.isFrozen(definition.observances[1].rdates));
    assert.ok(definition.observances.every((o) => !('rrule' in o)));
  });

  it('a zone with no change in the horizon gets one STANDARD observance from and to its offset', () => {
    assert.deepStrictEqual(vtimezoneFor('UTC', { provider: intl, horizon: HORIZON }).observances,
      [{ type: 'standard', start: '2000-01-01T00:00:00', offsetFrom: '+00:00', offsetTo: '+00:00' }]);
    assert.deepStrictEqual(vtimezoneFor('Australia/Lord_Howe', { provider: intl, horizon: [Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)] }).observances
      .map((o) => [o.type, o.offsetFrom, o.offsetTo]), [['standard', '+11:00', '+11:00'], ['standard', '+11:00', '+10:30'], ['daylight', '+10:30', '+11:00']]);
  });

  it('an offset with seconds is written and compiled exactly', () => {
    // a table zone at -04:56:02 that moves to -05:00 in 2001
    const table = { initial: -(4 * 60 + 56 + 2 / 60), changes: [{ at: Date.UTC(2001, 0, 1, 5), before: -(4 * 60 + 56 + 2 / 60), after: -300 }] };
    const provider = tableProvider('Old/Town', table);
    const definition = vtimezoneFor('Old/Town', { provider, horizon: HORIZON });
    assert.deepStrictEqual(definition.observances, [
      { type: 'standard', start: '1999-12-31T19:03:58', offsetFrom: '-04:56:02', offsetTo: '-04:56:02' },
      { type: 'standard', start: '2001-01-01T00:03:58', offsetFrom: '-04:56:02', offsetTo: '-05:00' },
    ]);
    const compiled = compileVtimezone(definition, { horizon: HORIZON });
    assert.deepStrictEqual(changesOf(compiled), table.changes);
    const wall = Date.UTC(2000, 5, 1, 12);
    assert.deepStrictEqual(compiled.candidates(partsOf(wall), 'Old/Town'), provider.candidates(partsOf(wall), 'Old/Town'));
    assert.strictEqual(compiled.toEpoch(partsOf(wall), 'Old/Town'), wall + (4 * 3600 + 56 * 60 + 2) * 1000);
  });

  it('refuses an unknown zone, a provider without toParts and a horizon past maxProviderCalls by name', () => {
    assert.throws(() => vtimezoneFor('Mars/Olympus', { provider: intl, horizon: HORIZON }), refusal('JY0001'));
    assert.throws(() => vtimezoneFor('UTC', { provider: /** @type {any} */ ({}), horizon: HORIZON }), refusal('JY0004'));
    assert.throws(() => vtimezoneFor('UTC', { provider: /** @type {any} */ ({ toParts: () => ({ year: 2000 }) }), horizon: HORIZON }), refusal('JY0004'));
    assert.throws(() => vtimezoneFor('UTC', { provider: intl, horizon: HORIZON, limits: { maxProviderCalls: 100 } }), refusal('JY0025'));
    assert.throws(() => vtimezoneFor('UTC', { provider: intl, horizon: [HORIZON[1], HORIZON[0]] }), refusal('JY0014'));
    assert.throws(() => vtimezoneFor('UTC', /** @type {any} */ ({ provider: intl, horizon: HORIZON, step: 1 })), refusal('JY0014'));
    // a provider that knows the zone and then fails mid-scan is the provider's fault
    let calls = 0;
    const failing = { toParts: (/** @type {number} */ at, /** @type {string} */ zone) => {
      if (++calls > 2)
        throw new Error('down');
      return intl.toParts(at, zone);
    } };
    assert.throws(() => vtimezoneFor('UTC', { provider: /** @type {any} */ (failing), horizon: HORIZON }), refusal('JY0004'));
    // a bounded provider asked past its horizon refuses in its own terms, not as an unknown zone
    const bounded = compileVtimezone(NEW_YORK, { horizon: HORIZON });
    assert.throws(() => vtimezoneFor('America/New_York', { provider: bounded, horizon: [Date.UTC(1990, 0, 1), Date.UTC(2001, 0, 1)] }), refusal('JY0024'));
    assert.strictEqual(vtimezoneFor('America/New_York', { provider: bounded, horizon: [Date.UTC(2010, 0, 1), Date.UTC(2011, 0, 1)] }).observances.length, 3);
  });
});

describe('compileVtimezone: definitions by rule against the transcribed table', () => {
  it('cuts a fraction finer than a millisecond, as the fixed-offset clock does', () => {
    const compiled = compileVtimezone(NEW_YORK, { horizon: HORIZON });
    const parts = { year: 2026, month: 7, day: 1, hours: 9, minutes: 0, seconds: 5.9996 };
    const instant = Date.parse('2026-07-01T13:00:05.999Z');
    assert.strictEqual(compiled.toEpoch(parts, 'America/New_York'), instant);
    assert.deepStrictEqual(compiled.candidates(parts, 'America/New_York'),
      { candidates: [{ instant, offsetMinutes: -240 }] });
  });

  it('New York by RRULE with UTC UNTILs gives the 82 changes of 2000-2040', () => {
    const compiled = compileVtimezone(NEW_YORK, { horizon: HORIZON });
    assert.deepStrictEqual(changesOf(compiled), oracleZone('America/New_York').changes);
    assert.strictEqual(compiled.initial, -300);
    assert.deepStrictEqual(compiled.horizon, { start: HORIZON[0], end: HORIZON[1] });
    assert.deepStrictEqual(compiled.counts.observances, 4);
  });

  it('a 1601 DTSTART is looked back from the horizon, not walked from 1601', () => {
    const compiled = compileVtimezone(AMSTERDAM_1601, { horizon: HORIZON });
    assert.deepStrictEqual(changesOf(compiled), oracleZone('Europe/Amsterdam').changes);
    // 41 years of two monthly walks plus a year's lookback each, not four centuries
    assert.ok(compiled.counts.work < 40000, `work ${compiled.counts.work}`);
  });

  it('answers the zone name it defines, isZone included, and nothing else', () => {
    const compiled = compileVtimezone(AMSTERDAM_1601, { horizon: HORIZON });
    assert.strictEqual(isZone('Europe/Amsterdam', compiled), true);
    assert.strictEqual(isZone('Europe/Berlin', compiled), false);
    assert.throws(() => compiled.toParts(Date.UTC(2026, 0, 1), 'Europe/Berlin'), TypeError);
    assert.throws(() => compiled.candidates(partsOf(Date.UTC(2026, 0, 1)), 'Europe/Berlin'), TypeError);
    assert.throws(() => compiled.toEpoch(partsOf(Date.UTC(2026, 0, 1)), 'Europe/Berlin'), TypeError);
    assert.deepStrictEqual(compiled.identity.name, 'Europe/Amsterdam');
    assert.ok(Object.isFrozen(compiled) && Object.isFrozen(compiled.transitions));
  });

  it('answers toParts as the Intl provider does, and refuses parts that are no wall clock', () => {
    const compiled = compileVtimezone(AMSTERDAM_1601, { horizon: HORIZON });
    for (const at of [Date.UTC(2026, 2, 29, 0, 59, 59, 500), Date.UTC(2026, 2, 29, 1), Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1, 30)])
      assert.deepStrictEqual(compiled.toParts(at, 'Europe/Amsterdam'), intl.toParts(at, 'Europe/Amsterdam'), iso(at));
    assert.throws(() => compiled.toParts(NaN, 'Europe/Amsterdam'), TypeError);
    assert.throws(() => compiled.candidates({ year: 2026, month: 2, day: 30 }, 'Europe/Amsterdam'), TypeError);
    assert.throws(() => compiled.candidates(null, 'Europe/Amsterdam'), TypeError);
    assert.throws(() => compiled.candidates({ year: 1e6, month: 1, day: 1 }, 'Europe/Amsterdam'), TypeError);
    assert.throws(() => compiled.toEpoch({ year: 2026, month: 1, day: 1 }, 'Europe/Amsterdam', 'nearest'), TypeError);
    assert.strictEqual(compiled.toEpoch({ year: 2026, month: 1, day: 1 }, 'Europe/Amsterdam'), Date.UTC(2025, 11, 31, 23));
  });

  it('the revision hashes the definition: stable, and moved by any change that moves an instant or a name', () => {
    const a = compileVtimezone(NEW_YORK, { horizon: HORIZON });
    const b = compileVtimezone(NEW_YORK, { horizon: [Date.UTC(2010, 0, 1), Date.UTC(2020, 0, 1)] });
    assert.strictEqual(a.identity.revision, b.identity.revision);
    const moved = { ...NEW_YORK, observances: [...NEW_YORK.observances.slice(0, 3), { ...NEW_YORK.observances[3], offsetTo: '-05:30' }] };
    assert.notStrictEqual(compileVtimezone(moved, { horizon: HORIZON }).identity.revision, a.identity.revision);
  });

  it('STANDARD or DAYLIGHT and TZNAME change no instant', () => {
    const swapped = { ...NEW_YORK, observances: NEW_YORK.observances.map((o) => ({ ...o, type: o.type === 'daylight' ? 'standard' : 'daylight', name: 'X' })) };
    assert.deepStrictEqual(changesOf(compileVtimezone(/** @type {any} */ (swapped), { horizon: HORIZON })), changesOf(compileVtimezone(NEW_YORK, { horizon: HORIZON })));
  });
});

describe('compileVtimezone: adversarial definitions', () => {
  it('outside the horizon every member refuses with JY0024, never guesses', () => {
    const compiled = compileVtimezone(NEW_YORK, { horizon: [Date.UTC(2010, 0, 1), Date.UTC(2020, 0, 1)] });
    assert.throws(() => compiled.toParts(Date.UTC(2020, 0, 1), 'America/New_York'), refusal('JY0024'));
    assert.throws(() => compiled.toParts(Date.UTC(2009, 11, 31), 'America/New_York'), refusal('JY0024'));
    assert.throws(() => compiled.candidates(partsOf(Date.UTC(2021, 5, 1)), 'America/New_York'), refusal('JY0024'));
    assert.throws(() => compiled.toEpoch(partsOf(Date.UTC(2021, 5, 1)), 'America/New_York', 'later'), refusal('JY0024'));
    // within a day of an end a wall clock's instants could lie past it
    assert.throws(() => compiled.candidates(partsOf(Date.UTC(2019, 11, 31, 12)), 'America/New_York'), refusal('JY0024'));
    // the calendar layer passes the refusal through, naming the horizon
    assert.throws(() => resolveLocal(partsOf(Date.UTC(2030, 0, 1)), 'America/New_York', { provider: compiled, policy: 'rfc5545' }),
      (error) => refusal('JY0024')(error) && /horizon/.test(/** @type {Error} */ (error).message));
    assert.throws(() => todayIn('America/New_York', { provider: compiled, runtime: createRuntime({ now: () => Date.UTC(2030, 0, 1) }) }), refusal('JY0024'));
    assert.strictEqual(todayIn('America/New_York', { provider: compiled, runtime: createRuntime({ now: () => Date.UTC(2015, 0, 1, 3) }) }), '2014-12-31');
    // isZone still knows it: the instant isZone asks at (1970) is outside, the name is not unknown
    assert.strictEqual(isZone('America/New_York', compiled), true);
  });

  it('before its earliest onset a definition says nothing (RFC 5545 §3.6.5\'s DTSTART-only example)', () => {
    const short = { tzid: 'America/New_York', observances: [
      { type: 'standard', start: '2007-11-04T02:00:00', offsetFrom: '-04:00', offsetTo: '-05:00' },
      { type: 'daylight', start: '2007-03-11T02:00:00', offsetFrom: '-05:00', offsetTo: '-04:00' },
    ] };
    const compiled = compileVtimezone(/** @type {any} */ (short), { horizon: HORIZON });
    assert.deepStrictEqual([compiled.horizon.start, compiled.initial], [Date.UTC(2007, 2, 11, 7), -240]);
    assert.deepStrictEqual(changesOf(compiled), [{ at: Date.UTC(2007, 10, 4, 6), before: -240, after: -300 }]);
    assert.throws(() => compiled.toParts(Date.UTC(2007, 0, 1), 'America/New_York'), refusal('JY0024'));
    assert.strictEqual(compiled.toParts(Date.UTC(2030, 0, 1), 'America/New_York').offset, -300);
    // every onset past the horizon: nothing is covered
    const later = compileVtimezone(/** @type {any} */ (short), { horizon: [Date.UTC(2000, 0, 1), Date.UTC(2005, 0, 1)] });
    assert.deepStrictEqual([later.horizon.start, later.horizon.end], [Date.UTC(2005, 0, 1), Date.UTC(2005, 0, 1)]);
  });

  it('TZUNTIL narrows the horizon: past it the definition says nothing', () => {
    const compiled = compileVtimezone({ ...NEW_YORK, until: '2012-01-01T00:00:00Z' }, { horizon: HORIZON });
    assert.strictEqual(compiled.horizon.end, Date.UTC(2012, 0, 1));
    assert.strictEqual(compiled.status, 'complete');
    assert.strictEqual(compiled.transitions.length, 24);
    assert.throws(() => compiled.toParts(Date.UTC(2013, 0, 1), 'America/New_York'), refusal('JY0024'));
    assert.throws(() => compileVtimezone({ ...NEW_YORK, until: '2012-01-01T00:00:00' }, { horizon: HORIZON }), refusal('JY0022'));
  });

  it('an observance\'s UNTIL is UTC: an onset after it by its instant is not made, though its wall clock is before it', () => {
    const rule = (/** @type {string} */ until) => compileVtimezone({ tzid: 'X', observances: [
      { type: 'standard', start: '2000-10-29T02:00:00', offsetFrom: '-04:00', offsetTo: '-05:00', rrule: 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU' },
      { type: 'daylight', start: '2001-04-01T02:00:00', offsetFrom: '-05:00', offsetTo: '-04:00', rrule: `FREQ=YEARLY;BYMONTH=4;BYDAY=1SU;UNTIL=${until}` },
    ] }, { horizon: HORIZON }).transitions.filter((c) => c.after === -240).map((c) => iso(c.at));
    // the 2006 onset is 02:00 local, 07:00 UTC
    assert.deepStrictEqual(rule('20060402T070000Z').slice(-1), ['2006-04-02T07:00:00.000Z']);
    assert.deepStrictEqual(rule('20060402T065959Z').slice(-1), ['2005-04-03T07:00:00.000Z']);
    assert.deepStrictEqual(rule('20060402T030000Z').slice(-1), ['2005-04-03T07:00:00.000Z']);
  });

  it('a rule past its UNTIL makes no onset: the last offset stays in force', () => {
    const ended = { tzid: 'Ended', observances: [
      { type: 'standard', start: '1990-10-28T02:00:00', offsetFrom: '-04:00', offsetTo: '-05:00', rrule: 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;UNTIL=19951029T060000Z' },
      { type: 'daylight', start: '1991-04-07T02:00:00', offsetFrom: '-05:00', offsetTo: '-04:00', rrule: 'FREQ=YEARLY;BYMONTH=4;BYDAY=1SU;UNTIL=19950402T070000Z' },
    ] };
    const compiled = compileVtimezone(ended, { horizon: HORIZON });
    assert.deepStrictEqual(compiled.transitions, []);
    assert.strictEqual(compiled.initial, -300);
    assert.strictEqual(compiled.toParts(Date.UTC(2030, 6, 1), 'Ended').offset, -300);
  });

  it('two onsets at one instant with different offsets, and changes that overlap, are JY0023', () => {
    const twice = { tzid: 'Twice', observances: [
      { type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00' },
      { type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+03:00' },
    ] };
    assert.throws(() => compileVtimezone(twice, { horizon: HORIZON }), refusal('JY0023'));
    // the same onset twice with the same offset is one onset
    const same = { tzid: 'Same', observances: [
      { type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00', rdates: ['2026-03-29T02:00:00', '2026-03-29T01:00:00Z'] },
    ] };
    const once = compileVtimezone(same, { horizon: HORIZON });
    assert.deepStrictEqual([once.transitions.length, once.horizon.start, once.initial], [0, Date.UTC(2026, 2, 29, 1), 120]);
    // two changes an hour apart: the second's wall-clock span [03:00, 05:00) starts inside the first's [02:00, 04:00)
    const overlap = { tzid: 'Overlap', observances: [
      { type: 'standard', start: '2025-01-01T00:00:00', offsetFrom: '+01:00', offsetTo: '+01:00' },
      { type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+03:00' },
      { type: 'standard', start: '2026-03-29T05:00:00', offsetFrom: '+03:00', offsetTo: '+01:00' },
    ] };
    assert.throws(() => compileVtimezone(overlap, { horizon: HORIZON }), refusal('JY0023'));
    const before = { tzid: 'Before', observances: [
      { type: 'daylight', start: '1990-03-25T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00' },
      { type: 'daylight', start: '1990-03-25T02:00:00', offsetFrom: '+01:00', offsetTo: '+03:00' },
    ] };
    assert.throws(() => compileVtimezone(before, { horizon: HORIZON }), refusal('JY0023'));
  });

  it('a definition of the wrong form is JY0022 at its member', () => {
    /** @type {[unknown, string][]} */
    const cases = [
      [null, ''],
      [{ tzid: 'X' }, '/observances'],
      [{ tzid: 'X', observances: [] }, '/observances'],
      [{ tzid: '', observances: [] }, '/tzid'],
      [{ tzid: 'X\u0007', observances: [] }, '/tzid'],
      [{ tzid: 'X', observances: [{ type: 'summer', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00' }] }, '/observances/0/type'],
      [{ tzid: 'X', observances: [{ type: 'daylight', start: '2026-02-30T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00' }] }, '/observances/0/start'],
      [{ tzid: 'X', observances: [{ type: 'daylight', start: '2026-03-29T02:00:00Z', offsetFrom: '+01:00', offsetTo: '+02:00' }] }, '/observances/0/start'],
      [{ tzid: 'X', observances: [{ type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '-00:00', offsetTo: '+02:00' }] }, '/observances/0/offsetFrom'],
      [{ tzid: 'X', observances: [{ type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+24:00' }] }, '/observances/0/offsetTo'],
      [{ tzid: 'X', observances: [{ type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00', rrule: 'FREQ=WEEKLY;BYMONTHDAY=1' }] }, '/observances/0/rrule'],
      [{ tzid: 'X', observances: [{ type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00', rdates: '2027' }] }, '/observances/0/rdates'],
      [{ tzid: 'X', observances: [{ type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00', rdates: ['2027'] }] }, '/observances/0/rdates/0'],
      [{ tzid: 'X', observances: [{ type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00', name: 1 }] }, '/observances/0/name'],
      [{ tzid: 'X', observances: [null] }, '/observances/0'],
    ];
    for (const [definition, docPath] of cases) {
      assert.throws(() => compileVtimezone(/** @type {any} */ (definition), { horizon: HORIZON }),
        (error) => refusal('JY0022')(error) && /** @type {any} */ (error).docPath === docPath, JSON.stringify(definition));
    }
    // an observance's RRULE carries the recurrence layer's refusal as its cause
    assert.throws(() => compileVtimezone(/** @type {any} */ (cases[10][0]), { horizon: HORIZON }),
      (error) => /** @type {any} */ (error).cause?.code === 'JY0018');
    assert.throws(() => compileVtimezone(/** @type {any} */ ({ tzid: 'X', observances: [], extra: 1 }), { horizon: HORIZON }), refusal('JY0014'));
  });

  it('options are checked: a horizon of utc values or epoch milliseconds, limits by name', () => {
    assert.strictEqual(compileVtimezone(NEW_YORK, { horizon: [{ kind: 'utc', instant: '2010-01-01T00:00:00Z' }, Date.UTC(2011, 0, 1)] }).transitions.length, 2);
    for (const options of [undefined, {}, { horizon: [0] }, { horizon: [0.5, 1] }, { horizon: [{ kind: 'date', date: '2010-01-01' }, 1] }, { horizon: ['x', 1] },
      { horizon: HORIZON, limits: 1 }, { horizon: HORIZON, limits: { maxWork: 0 } }, { horizon: HORIZON, limits: { maxSteps: 1 } }, { horizon: HORIZON, other: 1 }])
      assert.throws(() => compileVtimezone(NEW_YORK, /** @type {any} */ (options)), refusal('JY0014'), JSON.stringify(options));
    assert.strictEqual(compileVtimezone(NEW_YORK, { horizon: HORIZON, limits: { maxWork: undefined } }).status, 'complete');
    assert.deepStrictEqual(Object.keys(VTIMEZONE_LIMITS), ['maxObservances', 'maxTransitions', 'maxWork', 'maxProviderCalls']);
  });

  it('a hostile observance count is refused before any walk; a hostile onset count stops typed, never truncated silently', () => {
    const many = { tzid: 'Many', observances: Array.from({ length: 1001 }, (_, i) => ({
      type: 'standard', start: `${2000 + (i % 40)}-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00`, offsetFrom: '+00:00', offsetTo: '+00:00' })) };
    assert.throws(() => compileVtimezone(/** @type {any} */ (many), { horizon: HORIZON }), refusal('JY0025'));
    // a DAILY observance flipping nothing still costs an onset a day
    const daily = { tzid: 'Daily', observances: [{ type: 'standard', start: '2000-01-01T00:00:00', offsetFrom: '+00:00', offsetTo: '+00:00', rrule: 'FREQ=DAILY' }] };
    const stopped = compileVtimezone(/** @type {any} */ (daily), { horizon: HORIZON, limits: { maxTransitions: 100 } });
    assert.strictEqual(stopped.status, 'incomplete');
    assert.strictEqual(stopped.limit, 'maxTransitions');
    assert.ok(stopped.horizon.end <= Date.UTC(2000, 3, 10), iso(stopped.horizon.end));
    assert.throws(() => stopped.toParts(Date.UTC(2001, 0, 1), 'Daily'), refusal('JY0024'));
    const worked = compileVtimezone(AMSTERDAM_1601, { horizon: HORIZON, limits: { maxWork: 2000 } });
    assert.strictEqual(worked.status, 'incomplete');
    assert.strictEqual(worked.limit, 'maxWork');
    assert.ok(worked.horizon.end < HORIZON[1]);
    for (const change of worked.transitions)
      assert.ok(change.at < worked.horizon.end);
  });
});

describe('compileVtimezone: an observance of a sub-daily frequency', () => {
  it('compiles, and stops at maxTransitions with the incomplete shape instead of making a change every two hours of a year', () => {
    const definition = { tzid: 'X', observances: [
      { type: 'standard', start: '2026-01-01T00:00:00', offsetFrom: '+01:00', offsetTo: '+01:00' },
      { type: 'daylight', start: '2026-03-29T02:00:00', offsetFrom: '+01:00', offsetTo: '+02:00', rrule: 'FREQ=HOURLY;INTERVAL=2' },
      { type: 'standard', start: '2026-03-29T03:00:00', offsetFrom: '+02:00', offsetTo: '+01:00', rrule: 'FREQ=HOURLY;INTERVAL=2' },
    ] };
    const zone = compileVtimezone(/** @type {any} */ (definition), { horizon: [Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)], limits: { maxTransitions: 50 } });
    assert.deepStrictEqual([zone.complete, zone.status, zone.stoppedAt], [false, 'incomplete', { limit: 'maxTransitions' }]);
    assert.ok(zone.transitions.length <= 50);
  });

  it('a compiled zone lists its changes, and a MINUTELY walk reads the same through it with or without that list', () => {
    const zone = compileVtimezone(NEW_YORK, { horizon: HORIZON });
    const name = zone.tzid;
    const changes = zone.offsetChanges(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1), name);
    assert.deepStrictEqual(changes.map((change) => new Date(change.at).toISOString()), ['2026-03-08T07:00:00.000Z', '2026-11-01T06:00:00.000Z']);
    assert.deepStrictEqual(zone.offsetChanges(Date.parse('2026-03-08T07:00:00Z'), Date.parse('2026-03-08T07:00:00Z'), name).length, 1);
    assert.throws(() => zone.offsetChanges(0, 1, 'Elsewhere'), TypeError);
    assert.throws(() => zone.offsetChanges(/** @type {any} */ ('0'), 1, name), TypeError);
    assert.throws(() => zone.offsetChanges(Date.UTC(1990, 0, 1), Date.UTC(2026, 0, 1), name), refusal('JY0024'));
    const { offsetChanges, ...bare } = zone;
    assert.strictEqual(typeof offsetChanges, 'function');
    const rule = compileRecurrence({ dtstart: { kind: 'zoned', date: '2026-03-07', time: '00:00:00', zone: name }, rrule: 'FREQ=MINUTELY;INTERVAL=7' });
    const horizon = [Date.parse('2026-03-08T07:30:00Z'), Date.parse('2026-03-08T09:00:00Z')];
    const listed = expandRecurrence(rule, { horizon, zoneProvider: zone });
    const asked = expandRecurrence(rule, { horizon, zoneProvider: bare });
    assert.deepStrictEqual(listed.occurrences, asked.occurrences);
    assert.ok(listed.counts.providerCalls < asked.counts.providerCalls, `${listed.counts.providerCalls} < ${asked.counts.providerCalls}`);
  });
});
