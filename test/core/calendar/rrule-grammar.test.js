//@ts-check

/**
 * The RRULE grammar, every frequency: each part's spelling, range and
 * sign, the cross-part rules of RFC 5545 §3.3.10, the start-dependent
 * rules, and the refusal of a valid rule whose frequency is not
 * enumerated. Every refusal is pinned to its code and diagnostic path,
 * in the text form and the JSON form alike.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  compileRecurrence, formatRRule, floatingValue, dateValue, utcValue, zonedValue, CalendarError, CALENDAR_CODES,
} from '@jarenjs/core/calendar';

const floating = floatingValue('2026-01-05', '09:00');

/**
 * @param {unknown} rrule
 * @param {any} [dtstart]
 */
const compile = (rrule, dtstart = floating) => compileRecurrence({ dtstart, rrule: /** @type {any} */ (rrule) });

/**
 * @param {() => unknown} run
 * @param {string} code
 * @param {string} path
 */
function refuses(run, code, path) {
  assert.throws(run, (/** @type {any} */ error) => {
    assert.ok(error instanceof CalendarError, String(error));
    assert.strictEqual(error.code, code, error.message);
    assert.strictEqual(error.docPath, path, error.message);
    return true;
  });
}

describe('positive cases for every part, in every frequency the grammar has', () => {
  const accepted = [
    ['FREQ=DAILY', 'FREQ=DAILY'],
    ['RRULE:FREQ=DAILY', 'FREQ=DAILY'],
    ['freq=daily;interval=1;wkst=mo', 'FREQ=DAILY'],
    ['FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=TU,TH', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU'],
    ['BYDAY=WE,MO,MO;FREQ=WEEKLY', 'FREQ=WEEKLY;BYDAY=MO,WE'],
    ['FREQ=DAILY;COUNT=10', 'FREQ=DAILY;COUNT=10'],
    ['FREQ=DAILY;COUNT=+3', 'FREQ=DAILY;COUNT=3'],
    ['FREQ=DAILY;UNTIL=20261224T000000', 'FREQ=DAILY;UNTIL=20261224T000000'],
    ['FREQ=DAILY;BYHOUR=9,10,23,0;BYMINUTE=0,59;BYSECOND=0,30,59', 'FREQ=DAILY;BYSECOND=0,30,59;BYMINUTE=0,59;BYHOUR=0,9,10,23'],
    ['FREQ=DAILY;BYMONTH=12,1;BYMONTHDAY=-1,1,31,+15', 'FREQ=DAILY;BYMONTHDAY=-1,1,15,31;BYMONTH=1,12'],
    ['FREQ=DAILY;BYDAY=MO,TU;BYSETPOS=-1,1', 'FREQ=DAILY;BYDAY=MO,TU;BYSETPOS=-1,1'],
    ['FREQ=WEEKLY;BYMONTH=6;BYSETPOS=366,-366', 'FREQ=WEEKLY;BYMONTH=6;BYSETPOS=-366,366'],
    ['FREQ=MONTHLY;BYDAY=1FR,-1SU,+2MO,01TU', 'FREQ=MONTHLY;BYDAY=2MO,1TU,1FR,-1SU'],
    ['FREQ=MONTHLY;BYMONTHDAY=-31,31', 'FREQ=MONTHLY;BYMONTHDAY=-31,31'],
    ['FREQ=YEARLY;BYYEARDAY=1,-366,366;BYWEEKNO=-53,53,1;BYMONTH=1', 'FREQ=YEARLY;BYYEARDAY=-366,1,366;BYWEEKNO=-53,1,53;BYMONTH=1'],
    ['FREQ=YEARLY;BYDAY=20MO,-53SU', 'FREQ=YEARLY;BYDAY=20MO,-53SU'],
    ['FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO;WKST=SU', 'FREQ=YEARLY;BYDAY=MO;BYWEEKNO=20;WKST=SU'],
    ['FREQ=HOURLY;BYYEARDAY=100;BYMONTHDAY=-2', 'FREQ=HOURLY;BYMONTHDAY=-2;BYYEARDAY=100'],
    ['FREQ=MINUTELY;INTERVAL=90;BYDAY=MO', 'FREQ=MINUTELY;INTERVAL=90;BYDAY=MO'],
    ['FREQ=SECONDLY;BYSECOND=59', 'FREQ=SECONDLY;BYSECOND=59'],
  ];
  for (const [text, canonical] of accepted) {
    it(`${text}`, () => {
      const compiled = compile(text);
      assert.strictEqual(formatRRule(compiled), canonical);
      assert.strictEqual(formatRRule(/** @type {string} */ (text)), canonical);
      assert.strictEqual(formatRRule(compiled.rrule), canonical);
      assert.ok(Object.isFrozen(compiled) && Object.isFrozen(compiled.rrule));
    });
  }

  it('UNTIL of each kind matches its start (date, floating, utc for utc and zoned)', () => {
    assert.strictEqual(formatRRule(compile('FREQ=DAILY;UNTIL=20261224', dateValue('2026-01-05'))), 'FREQ=DAILY;UNTIL=20261224');
    assert.strictEqual(formatRRule(compile('FREQ=DAILY;UNTIL=20261224T235959Z', utcValue('2026-01-05T09:00:00Z'))),
      'FREQ=DAILY;UNTIL=20261224T235959Z');
    assert.strictEqual(formatRRule(compile('FREQ=DAILY;UNTIL=20261224T000000Z', zonedValue('2026-01-05', '09:00', 'Europe/Amsterdam'))),
      'FREQ=DAILY;UNTIL=20261224T000000Z');
    assert.deepStrictEqual(compile({ FREQ: 'DAILY', UNTIL: { kind: 'floating', date: '2026-12-24', time: '23:00' } }).rrule.UNTIL,
      { kind: 'floating', date: '2026-12-24', time: '23:00' });
    assert.strictEqual(formatRRule({ FREQ: 'DAILY', UNTIL: { kind: 'floating', date: '2026-12-24', time: '23:00' } }),
      'FREQ=DAILY;UNTIL=20261224T230000');
    assert.strictEqual(formatRRule({ FREQ: 'DAILY', UNTIL: { kind: 'utc', instant: '2026-12-24T23:00:00.000Z' } }),
      'FREQ=DAILY;UNTIL=20261224T230000Z');
  });

  it('the wkst option sets WKST when the rule does not, and agrees with it when it does', () => {
    assert.strictEqual(formatRRule(compileRecurrence({ dtstart: floating, rrule: 'FREQ=WEEKLY', wkst: 'SU' })), 'FREQ=WEEKLY;WKST=SU');
    assert.strictEqual(formatRRule(compileRecurrence({ dtstart: floating, rrule: 'FREQ=WEEKLY;WKST=SU', wkst: 'SU' })), 'FREQ=WEEKLY;WKST=SU');
    assert.strictEqual(formatRRule(compileRecurrence({ dtstart: floating, rrule: 'FREQ=WEEKLY', wkst: 'MO' })), 'FREQ=WEEKLY');
    refuses(() => compileRecurrence({ dtstart: floating, rrule: 'FREQ=WEEKLY;WKST=MO', wkst: 'SU' }), 'JY0017', 'rrule.WKST');
    refuses(() => compileRecurrence({ dtstart: floating, rrule: { FREQ: 'WEEKLY', WKST: 'TU' }, wkst: 'SU' }), 'JY0017', 'rrule.WKST');
    refuses(() => compileRecurrence({ dtstart: floating, rrule: 'FREQ=WEEKLY', wkst: /** @type {any} */ ('SUN') }), 'JY0014', '/wkst');
  });
});

describe('negative cases: every fault has its code and its path, in both forms', () => {
  /** @type {[string | object, string, string][]} */
  const refused = [
    ['', 'JY0015', 'rrule'],
    ['RRULE:', 'JY0015', 'rrule'],
    ['INTERVAL=2', 'JY0015', 'rrule.FREQ'],
    ['FREQ=FORTNIGHTLY', 'JY0015', 'rrule.FREQ'],
    ['FREQ=DAILY;', 'JY0015', 'rrule'],
    ['FREQ=DAILY;;COUNT=2', 'JY0015', 'rrule'],
    ['FREQ=DAILY;COUNT', 'JY0015', 'rrule'],
    ['FREQ=DAILY;COUNT=', 'JY0015', 'rrule.COUNT'],
    ['FREQ=DAILY;RSCALE=GREGORIAN', 'JY0015', 'rrule.RSCALE'],
    ['FREQ=DAILY;X-NAME=1', 'JY0015', 'rrule.X-NAME'],
    ['FREQ=DAILY;FREQ=WEEKLY', 'JY0017', 'rrule.FREQ'],
    ['FREQ=DAILY;BYHOUR=1;byhour=2', 'JY0017', 'rrule.BYHOUR'],
    ['FREQ=DAILY;INTERVAL=0', 'JY0016', 'rrule.INTERVAL'],
    ['FREQ=DAILY;INTERVAL=-1', 'JY0016', 'rrule.INTERVAL'],
    ['FREQ=DAILY;INTERVAL=two', 'JY0015', 'rrule.INTERVAL'],
    ['FREQ=DAILY;INTERVAL=99999999999999999999', 'JY0015', 'rrule.INTERVAL'],
    ['FREQ=DAILY;COUNT=0', 'JY0016', 'rrule.COUNT'],
    ['FREQ=DAILY;COUNT=1.5', 'JY0015', 'rrule.COUNT'],
    ['FREQ=DAILY;BYSECOND=61', 'JY0016', 'rrule.BYSECOND[0]'],
    ['FREQ=DAILY;BYSECOND=0,60', 'JY0009', 'rrule.BYSECOND[1]'],
    ['FREQ=DAILY;BYMINUTE=0,60', 'JY0016', 'rrule.BYMINUTE[1]'],
    ['FREQ=DAILY;BYHOUR=24', 'JY0016', 'rrule.BYHOUR[0]'],
    ['FREQ=DAILY;BYHOUR=-1', 'JY0016', 'rrule.BYHOUR[0]'],
    ['FREQ=DAILY;BYHOUR=+1', 'JY0016', 'rrule.BYHOUR[0]'],
    ['FREQ=DAILY;BYHOUR=001', 'JY0015', 'rrule.BYHOUR[0]'],
    ['FREQ=DAILY;BYHOUR=1,,2', 'JY0015', 'rrule.BYHOUR[1]'],
    ['FREQ=DAILY;BYMONTHDAY=1,2,0', 'JY0016', 'rrule.BYMONTHDAY[2]'],
    ['FREQ=DAILY;BYMONTHDAY=32', 'JY0016', 'rrule.BYMONTHDAY[0]'],
    ['FREQ=DAILY;BYMONTHDAY=-32', 'JY0016', 'rrule.BYMONTHDAY[0]'],
    ['FREQ=DAILY;BYMONTHDAY=+0', 'JY0016', 'rrule.BYMONTHDAY[0]'],
    ['FREQ=YEARLY;BYYEARDAY=367', 'JY0016', 'rrule.BYYEARDAY[0]'],
    ['FREQ=YEARLY;BYYEARDAY=0', 'JY0016', 'rrule.BYYEARDAY[0]'],
    ['FREQ=YEARLY;BYWEEKNO=54', 'JY0016', 'rrule.BYWEEKNO[0]'],
    ['FREQ=YEARLY;BYWEEKNO=-54', 'JY0016', 'rrule.BYWEEKNO[0]'],
    ['FREQ=DAILY;BYMONTH=13', 'JY0016', 'rrule.BYMONTH[0]'],
    ['FREQ=DAILY;BYMONTH=0', 'JY0016', 'rrule.BYMONTH[0]'],
    ['FREQ=DAILY;BYMONTH=-1', 'JY0016', 'rrule.BYMONTH[0]'],
    ['FREQ=DAILY;BYMONTH=6;BYSETPOS=367', 'JY0016', 'rrule.BYSETPOS[0]'],
    ['FREQ=DAILY;BYMONTH=6;BYSETPOS=0', 'JY0016', 'rrule.BYSETPOS[0]'],
    ['FREQ=WEEKLY;BYDAY=MO,XX', 'JY0015', 'rrule.BYDAY[1]'],
    ['FREQ=WEEKLY;BYDAY=MONDAY', 'JY0015', 'rrule.BYDAY[0]'],
    ['FREQ=MONTHLY;BYDAY=+MO', 'JY0015', 'rrule.BYDAY[0]'],
    ['FREQ=MONTHLY;BYDAY=0MO', 'JY0016', 'rrule.BYDAY[0]'],
    ['FREQ=MONTHLY;BYDAY=54MO', 'JY0016', 'rrule.BYDAY[0]'],
    ['FREQ=MONTHLY;BYDAY=-54MO', 'JY0016', 'rrule.BYDAY[0]'],
    ['FREQ=MONTHLY;BYDAY=100MO', 'JY0015', 'rrule.BYDAY[0]'],
    ['FREQ=WEEKLY;WKST=SUN', 'JY0015', 'rrule.WKST'],
    ['FREQ=DAILY;UNTIL=2026-12-24', 'JY0015', 'rrule.UNTIL'],
    ['FREQ=DAILY;UNTIL=20261324', 'JY0012', 'rrule.UNTIL'],
    ['FREQ=DAILY;UNTIL=20260230', 'JY0012', 'rrule.UNTIL'],
    ['FREQ=DAILY;UNTIL=20261224T240000', 'JY0008', 'rrule.UNTIL'],
    ['FREQ=DAILY;UNTIL=20261224T235960', 'JY0009', 'rrule.UNTIL'],
    ['FREQ=DAILY;UNTIL=20261224T236000', 'JY0013', 'rrule.UNTIL'],
    ['FREQ=DAILY;COUNT=2;UNTIL=20261224T000000', 'JY0018', 'rrule.COUNT'],
    ['FREQ=DAILY;BYWEEKNO=1', 'JY0018', 'rrule.BYWEEKNO'],
    ['FREQ=MONTHLY;BYWEEKNO=1', 'JY0018', 'rrule.BYWEEKNO'],
    ['FREQ=DAILY;BYYEARDAY=1', 'JY0018', 'rrule.BYYEARDAY'],
    ['FREQ=WEEKLY;BYYEARDAY=1', 'JY0018', 'rrule.BYYEARDAY'],
    ['FREQ=MONTHLY;BYYEARDAY=1', 'JY0018', 'rrule.BYYEARDAY'],
    ['FREQ=WEEKLY;BYMONTHDAY=1', 'JY0018', 'rrule.BYMONTHDAY'],
    ['FREQ=WEEKLY;BYDAY=MO,1TU', 'JY0018', 'rrule.BYDAY[1]'],
    ['FREQ=DAILY;BYDAY=-1FR', 'JY0018', 'rrule.BYDAY[0]'],
    ['FREQ=HOURLY;BYDAY=1MO', 'JY0018', 'rrule.BYDAY[0]'],
    ['FREQ=YEARLY;BYWEEKNO=20;BYDAY=1MO', 'JY0018', 'rrule.BYDAY[0]'],
    ['FREQ=DAILY;BYSETPOS=1', 'JY0018', 'rrule.BYSETPOS'],
    ['FREQ=MONTHLY;BYSETPOS=-1', 'JY0018', 'rrule.BYSETPOS'],
    [{ FREQ: 'DAILY', BYMONTHDAY: [1, 2, 0] }, 'JY0016', 'rrule.BYMONTHDAY[2]'],
    [{ FREQ: 'DAILY', BYMONTHDAY: [] }, 'JY0015', 'rrule.BYMONTHDAY'],
    [{ FREQ: 'DAILY', BYMONTHDAY: 1 }, 'JY0015', 'rrule.BYMONTHDAY'],
    [{ FREQ: 'DAILY', BYHOUR: [1.5] }, 'JY0015', 'rrule.BYHOUR[0]'],
    [{ FREQ: 'DAILY', BYHOUR: ['1'] }, 'JY0015', 'rrule.BYHOUR[0]'],
    [{ FREQ: 'daily' }, 'JY0015', 'rrule.FREQ'],
    [{ freq: 'DAILY' }, 'JY0015', 'rrule.freq'],
    [{ FREQ: 'DAILY', INTERVAL: '2' }, 'JY0015', 'rrule.INTERVAL'],
    [{ FREQ: 'DAILY', COUNT: 0 }, 'JY0016', 'rrule.COUNT'],
    [{ FREQ: 'WEEKLY', BYDAY: ['mo'] }, 'JY0015', 'rrule.BYDAY[0]'],
    [{ FREQ: 'WEEKLY', BYDAY: 'MO' }, 'JY0015', 'rrule.BYDAY'],
    [{ FREQ: 'DAILY', UNTIL: '20261224' }, 'JY0013', 'rrule.UNTIL'],
    [{ FREQ: 'DAILY', UNTIL: { kind: 'zoned', date: '2026-12-24', time: '00:00', zone: 'UTC' } }, 'JY0015', 'rrule.UNTIL'],
    [{ FREQ: 'DAILY', UNTIL: { kind: 'floating', date: '2026-12-24', time: '00:00:00.500' } }, 'JY0015', 'rrule.UNTIL'],
    [{ FREQ: 'DAILY', UNTIL: { kind: 'utc', instant: '2026-12-24T00:00:00.001Z' } }, 'JY0015', 'rrule.UNTIL'],
    [{ FREQ: 'DAILY', COUNT: 2, UNTIL: { kind: 'floating', date: '2026-12-24', time: '00:00' } }, 'JY0018', 'rrule.COUNT'],
    [{ FREQ: 'WEEKLY', BYSETPOS: [1] }, 'JY0018', 'rrule.BYSETPOS'],
    [/** @type {any} */ (42), 'JY0015', 'rrule'],
    [/** @type {any} */ (['FREQ=DAILY']), 'JY0015', 'rrule'],
  ];
  for (const [rule, code, path] of refused) {
    it(`${typeof rule === 'string' ? rule || "''" : JSON.stringify(rule)} -> ${code} at ${path}`, () => {
      refuses(() => compile(rule), code, path);
      refuses(() => formatRRule(/** @type {any} */ (rule)), code, path);
    });
  }

  it('faults are found in one order: spelling and range part by part, then the combinations', () => {
    refuses(() => compile('FREQ=WEEKLY;BYMONTHDAY=0;BYWEEKNO=1'), 'JY0016', 'rrule.BYMONTHDAY[0]');
    refuses(() => compile('FREQ=MONTHLY;COUNT=1;UNTIL=20261224T000000;BYHOUR=24'), 'JY0016', 'rrule.BYHOUR[0]');
    // a malformed rule names its fault part by part
    refuses(() => compile('FREQ=MONTHLY;BYMONTHDAY=1,2,0'), 'JY0016', 'rrule.BYMONTHDAY[2]');
    refuses(() => compile('FREQ=YEARLY;BYWEEKNO=20;BYDAY=1MO'), 'JY0018', 'rrule.BYDAY[0]');
  });
});

describe('start-dependent rules', () => {
  it('BYHOUR, BYMINUTE and BYSECOND do not go with a date start', () => {
    const date = dateValue('2026-01-05');
    refuses(() => compile('FREQ=DAILY;BYHOUR=9', date), 'JY0018', 'rrule.BYHOUR');
    refuses(() => compile('FREQ=DAILY;BYMINUTE=9', date), 'JY0018', 'rrule.BYMINUTE');
    refuses(() => compile('FREQ=DAILY;BYSECOND=9', date), 'JY0018', 'rrule.BYSECOND');
    refuses(() => compile('FREQ=MONTHLY;BYHOUR=9', date), 'JY0018', 'rrule.BYHOUR');
  });

  it('SECONDLY, MINUTELY and HOURLY do not go with a date start', () => {
    for (const freq of ['SECONDLY', 'MINUTELY', 'HOURLY'])
      refuses(() => compile(`FREQ=${freq};COUNT=3`, dateValue('2026-01-05')), 'JY0018', 'rrule.FREQ');
  });

  it('UNTIL of the wrong kind for the start is JY0019, before the frequency is asked', () => {
    const zoned = zonedValue('2026-01-05', '09:00', 'Europe/Amsterdam');
    const cases = [
      [floating, 'FREQ=DAILY;UNTIL=20261224'], [floating, 'FREQ=DAILY;UNTIL=20261224T000000Z'],
      [dateValue('2026-01-05'), 'FREQ=DAILY;UNTIL=20261224T000000'], [dateValue('2026-01-05'), 'FREQ=DAILY;UNTIL=20261224T000000Z'],
      [utcValue('2026-01-05T09:00:00Z'), 'FREQ=DAILY;UNTIL=20261224T000000'], [utcValue('2026-01-05T09:00:00Z'), 'FREQ=WEEKLY;UNTIL=20261224'],
      [zoned, 'FREQ=DAILY;UNTIL=20261224T000000'], [zoned, 'FREQ=DAILY;UNTIL=20261224'],
      [zoned, 'FREQ=MONTHLY;UNTIL=20261224T000000'],
    ];
    for (const [dtstart, rrule] of cases)
      refuses(() => compile(rrule, dtstart), 'JY0019', 'rrule.UNTIL');
  });

  it('the start, its length and the policy are checked', () => {
    refuses(() => compileRecurrence(/** @type {any} */ (null)), 'JY0014', '/');
    refuses(() => compileRecurrence({ dtstart: /** @type {any} */ ({ kind: 'date-range', start: '2026-01-01', end: '2026-01-02' }),
      rrule: 'FREQ=DAILY' }), 'JY0013', '/dtstart/kind');
    refuses(() => compile('FREQ=DAILY', floatingValue('2026-01-05', '09:00:00.500')), 'JY0013', '/dtstart');
    refuses(() => compile('FREQ=DAILY', { kind: 'floating', date: '2026-02-30', time: '09:00' }), 'JY0012', '/dtstart/date');
    refuses(() => compileRecurrence({ dtstart: floating, rrule: 'FREQ=DAILY', policy: /** @type {any} */ ('earlier') }), 'JY0005', '/policy');
    for (const duration of ['P', 'PT', '-P1D', 'P1H', 'PT1D', 'P1W2D', 'P1.5D', 'P1Y', 'P1M', '1D'])
      refuses(() => compileRecurrence({ dtstart: floating, duration, rrule: 'FREQ=DAILY' }), 'JY0014', '/duration');
    refuses(() => compileRecurrence({ dtstart: dateValue('2026-01-05'), duration: 'PT1H', rrule: 'FREQ=DAILY' }), 'JY0014', '/duration');
    refuses(() => compileRecurrence({ dtstart: floating, duration: 'PT1H', dtend: floating, rrule: 'FREQ=DAILY' }), 'JY0014', '/duration');
    refuses(() => compileRecurrence({ dtstart: floating, dtend: dateValue('2026-01-06'), rrule: 'FREQ=DAILY' }), 'JY0013', '/dtend/kind');
    refuses(() => compileRecurrence({ dtstart: floating, dtend: floatingValue('2026-01-05', '08:00'), rrule: 'FREQ=DAILY' }),
      'JY0014', '/dtend');
    for (const duration of ['P1W', 'P2D', 'PT1H30M', 'P1DT2H', 'PT0S', '+PT15M', 'PT90M', 'P0D']) {
      const compiled = compileRecurrence({ dtstart: floating, duration, rrule: 'FREQ=DAILY' });
      assert.strictEqual(compiled.duration, duration);
    }
    const ended = compileRecurrence({ dtstart: floating, dtend: floatingValue('2026-01-05', '24:00', { bound: 'end' }), rrule: 'FREQ=DAILY' });
    assert.deepStrictEqual(ended.dtend, { kind: 'floating', date: '2026-01-05', time: '24:00' });
    assert.strictEqual(compileRecurrence({ dtstart: floating, rrule: 'FREQ=DAILY' }).policy, 'rfc5545');
  });
});

describe('every frequency compiles', () => {
  it('SECONDLY to YEARLY each compile from a time start', () => {
    for (const freq of ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
      assert.strictEqual(compile(`FREQ=${freq};COUNT=3`).rrule.FREQ, freq);
  });
  it('the code table carries every recurrence code', () => {
    for (const code of ['JY0015', 'JY0016', 'JY0017', 'JY0018', 'JY0019', 'JY0020', 'JY0021'])
      assert.ok(Object.hasOwn(CALENDAR_CODES, code), code);
  });
});
