//@ts-check

/**
 * `weeklyPattern`: seven booleans, seven-slot opening hours and
 * per-weekday rules as floating FREQ=WEEKLY;BYDAY series; and the cost
 * of expanding it and a long COUNT rule growing with what they return.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  weeklyPattern, expandSeries, compileRecurrence, expandRecurrence, formatRRule, bindFloating, dateValue, floatingValue, CalendarError,
} from '@jarenjs/core/calendar';
import { oracleZone, tableProvider } from './oracle.js';

const week = /** @type {[any, any]} */ ([dateValue('2026-03-02'), dateValue('2026-03-09')]);
const slots = (/** @type {any} */ result) => result.occurrences.map((/** @type {any} */ o) =>
  `${o.start.date} ${o.start.time.slice(0, 5)}-${o.end.date === o.start.date ? '' : `${o.end.date} `}${o.end.time.slice(0, 5)}`);

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

describe('weeklyPattern compiles to floating weekly series', () => {
  it('seven booleans: a true day is the whole day', () => {
    const pattern = weeklyPattern({ days: { mon: true, tue: false, wed: true, thu: true, fri: true, sat: false, sun: false } });
    assert.strictEqual(pattern.length, 1);
    assert.strictEqual(pattern[0].uid, 'weekly:00:00:00-24:00:00');
    assert.strictEqual(formatRRule(/** @type {any} */ (pattern[0].base)), 'FREQ=WEEKLY;BYDAY=MO,WE,TH,FR');
    assert.deepStrictEqual(slots(expandSeries(pattern, { horizon: week })), [
      '2026-03-02 00:00-2026-03-03 00:00', '2026-03-04 00:00-2026-03-05 00:00', '2026-03-05 00:00-2026-03-06 00:00',
      '2026-03-06 00:00-2026-03-07 00:00',
    ]);
  });

  it('seven-slot opening hours, 24:00 as an end', () => {
    const weekday = [['09:00', '17:30']];
    const pattern = weeklyPattern({ days: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: [['10:00', '24:00']], sun: [] } });
    assert.deepStrictEqual(pattern.map((s) => s.uid), ['weekly:09:00:00-17:30:00', 'weekly:10:00:00-24:00:00']);
    const got = expandSeries(pattern, { horizon: week });
    assert.deepStrictEqual(slots(got), [
      '2026-03-02 09:00-17:30', '2026-03-03 09:00-17:30', '2026-03-04 09:00-17:30', '2026-03-05 09:00-17:30', '2026-03-06 09:00-17:30',
      '2026-03-07 10:00-2026-03-08 00:00',
    ]);
    assert.ok(got.occurrences.every((o) => o.start.kind === 'floating' && o.uid.startsWith('weekly:')));
  });

  it('per-weekday rules: several slots a day, shared slots become one series', () => {
    const pattern = weeklyPattern({ days: { mon: [['13:00', '17:00'], ['09:00', '12:00']], tue: [['09:00', '12:00']], sun: [['22:00:30', '23:59:59']] },
      wkst: 'SU' });
    assert.deepStrictEqual(pattern.map((s) => [s.uid, formatRRule(/** @type {any} */ (s.base))]), [
      ['weekly:09:00:00-12:00:00', 'FREQ=WEEKLY;BYDAY=MO,TU;WKST=SU'],
      ['weekly:13:00:00-17:00:00', 'FREQ=WEEKLY;BYDAY=MO;WKST=SU'],
      ['weekly:22:00:30-23:59:59', 'FREQ=WEEKLY;BYDAY=SU;WKST=SU'],
    ]);
    assert.deepStrictEqual(slots(expandSeries(pattern, { horizon: week })), [
      '2026-03-02 09:00-12:00', '2026-03-02 13:00-17:00', '2026-03-03 09:00-12:00', '2026-03-08 22:00-23:59',
    ]);
  });

  it('a floating occurrence binds to a zone in the caller\'s step', () => {
    const [series] = weeklyPattern({ days: { sun: [['01:30', '03:30']] } });
    const [o] = expandSeries(series, { horizon: [dateValue('2026-03-29'), dateValue('2026-03-30')] }).occurrences;
    const provider = tableProvider('Europe/Amsterdam', oracleZone('Europe/Amsterdam'));
    const start = bindFloating(o.start, { zone: 'Europe/Amsterdam', source: 'location', provider, policy: 'rfc5545' });
    const end = bindFloating(o.end, { zone: 'Europe/Amsterdam', source: 'location', provider, policy: 'rfc5545', bound: 'end' });
    assert.strictEqual(start.kind === 'instant' && end.kind === 'instant' && end.instant - start.instant, 3600000);
  });

  it('refusals name the day and slot at fault', () => {
    refuses(() => weeklyPattern(/** @type {any} */ ({})), 'JY0014', '/days');
    refuses(() => weeklyPattern(/** @type {any} */ ({ days: {}, zone: 'UTC' })), 'JY0014', '/zone');
    refuses(() => weeklyPattern(/** @type {any} */ ({ days: { monday: true } })), 'JY0014', '/days/monday');
    refuses(() => weeklyPattern(/** @type {any} */ ({ days: { mon: 'yes' } })), 'JY0014', '/days/mon');
    refuses(() => weeklyPattern(/** @type {any} */ ({ days: { mon: [['09:00']] } })), 'JY0014', '/days/mon/0');
    refuses(() => weeklyPattern({ days: { mon: [['09:00', '17:00'], ['12:00', '12:00']] } }), 'JY0014', '/days/mon/1/1');
    refuses(() => weeklyPattern({ days: { mon: [['24:00', '24:00']] } }), 'JY0008', '/days/mon/0/0');
    refuses(() => weeklyPattern({ days: { mon: [['9am', '17:00']] } }), 'JY0013', '/days/mon/0/0');
    refuses(() => weeklyPattern({ days: { mon: [['09:00', '17:00:00.5']] } }), 'JY0013', '/days/mon/0/1');
    refuses(() => weeklyPattern({ days: { mon: true }, wkst: /** @type {any} */ ('SUN') }), 'JY0014', '/wkst');
    assert.deepStrictEqual(weeklyPattern({ days: {} }), []);
  });
});

describe('cost grows with what is returned (an 8x step)', () => {
  /** @param {number} years */
  const pattern = weeklyPattern({ days: { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], sat: [['10:00', '14:00']] } });
  const over = (/** @type {number} */ years) => expandSeries(pattern, {
    horizon: [dateValue('2026-01-01'), dateValue(`${2026 + years}-01-01`)],
  });

  it('a weekly pattern over 1 year and over 8 years', () => {
    const one = over(1);
    const eight = over(8);
    const ratio = eight.counts.work / one.counts.work;
    assert.ok(ratio > 7.5 && ratio < 8.5, `work ${one.counts.work} -> ${eight.counts.work}`);
    assert.ok(eight.counts.emitted / one.counts.emitted > 7.5);
    assert.ok(over(10).status === 'complete' && over(10).counts.emitted > 10 * 150);
  });

  it('FREQ=DAILY;COUNT=1250 and COUNT=10000', () => {
    /** @param {number} count */
    const daily = (count) => expandRecurrence(compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), rrule: `FREQ=DAILY;COUNT=${count}` }),
      { horizon: [dateValue('2026-01-01'), dateValue('2060-01-01')] });
    const small = daily(1250);
    const large = daily(10000);
    assert.deepStrictEqual([small.counts.emitted, large.counts.emitted, large.status], [1250, 10000, 'complete']);
    assert.strictEqual(large.counts.work / small.counts.work, (1 + 2 * 10000) / (1 + 2 * 1250));
  });
});
