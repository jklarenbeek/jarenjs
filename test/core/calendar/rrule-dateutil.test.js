//@ts-check

/**
 * MONTHLY and YEARLY expansion against a second, independent
 * implementation: 3000 seeded rules whose occurrences python-dateutil
 * generated (fixtures/rrule-oracle; the test reads the JSON and never
 * runs Python). Each rule is expanded over its whole horizon and over a
 * later part of it, so the walk's skip ahead is checked too. The classes
 * where dateutil and RFC 5545 disagree are left out of the fixture by
 * their shape (see its PROVENANCE.md) and pinned by rrule-calendar.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileRecurrence, expandRecurrence, formatRRule } from '@jarenjs/core/calendar';
import fixture from './fixtures/rrule-oracle/occurrences.json' with { type: 'json' };

const LIMITS = { maxOccurrences: 100000, maxWork: 10000000 };

/** @param {string} text */
const wallOf = (text) => Date.parse(text.length === 10 ? `${text}T00:00:00Z` : `${text}Z`);

/**
 * A wall clock as a value of the case's kind.
 * @param {number} wall
 * @param {boolean} isDate
 */
const valueAt = (wall, isDate) => {
  const text = new Date(wall).toISOString();
  return isDate ? { kind: /** @type {const} */ ('date'), date: text.slice(0, 10) }
    : { kind: /** @type {const} */ ('floating'), date: text.slice(0, 10), time: text.slice(11, 19) };
};

/** @param {number} wall @param {boolean} isDate */
const idOf = (wall, isDate) => new Date(wall).toISOString().slice(0, isDate ? 10 : 19);

describe('MONTHLY/YEARLY expansion equals python-dateutil', () => {
  const cases = /** @type {[string, string, string, number[]][]} */ (fixture.cases);

  it('the fixture holds 3000 cases from one seed, with every divergence class left out by shape', () => {
    assert.strictEqual(cases.length, 3000);
    assert.strictEqual(fixture.seed, 20261115);
    assert.deepStrictEqual(Object.keys(fixture.excluded).sort(),
      ['byday-mixed', 'weekno-52-53', 'weekno-period', 'weekno-without-day']);
    const shapes = { MONTHLY: 0, YEARLY: 0, COUNT: 0, UNTIL: 0, BYSETPOS: 0, BYWEEKNO: 0, BYYEARDAY: 0, ordinal: 0, negative: 0, date: 0 };
    for (const [rule, dtstart] of cases) {
      for (const name of /** @type {const} */ (['MONTHLY', 'YEARLY', 'COUNT', 'UNTIL', 'BYSETPOS', 'BYWEEKNO', 'BYYEARDAY']))
        shapes[name] += rule.includes(name) ? 1 : 0;
      shapes.ordinal += /BYDAY=[^;]*\d/.test(rule) ? 1 : 0;
      shapes.negative += /(BYMONTHDAY|BYYEARDAY|BYWEEKNO|BYSETPOS)=[^;]*-/.test(rule) ? 1 : 0;
      shapes.date += dtstart.length === 10 ? 1 : 0;
    }
    for (const [name, n] of Object.entries(shapes))
      assert.ok(n >= 50, `${name}: ${n} cases`);
  });

  it('every case, over its whole horizon and over a later part of it', () => {
    let occurrences = 0;
    for (const [index, [rule, dtstart, end, offsets]] of cases.entries()) {
      const isDate = dtstart.length === 10;
      const start = wallOf(dtstart);
      const high = wallOf(end);
      const want = offsets.map((offset) => start + offset * 1000);
      const compiled = compileRecurrence({ dtstart: valueAt(start, isDate), rrule: index % 2 === 0 ? rule : rule.toLowerCase() });
      assert.strictEqual(formatRRule(compileRecurrence({ dtstart: valueAt(start, isDate), rrule: formatRRule(compiled) })),
        formatRRule(compiled));
      const whole = expandRecurrence(compiled, { horizon: [valueAt(start, isDate), valueAt(high, isDate)], limits: LIMITS });
      assert.strictEqual(whole.status, 'complete', rule);
      assert.deepStrictEqual(whole.occurrences.map((o) => o.recurrenceId), want.map((wall) => idOf(wall, isDate)), `${rule} from ${dtstart}`);
      // a later part: from a day boundary past the middle start, so the walk may skip ahead
      const pivot = want[Math.floor(want.length / 2)];
      const low = (Math.floor(pivot / 86400000) + (index % 3)) * 86400000;
      if (low < high) {
        const part = expandRecurrence(compiled, { horizon: [valueAt(low, isDate), valueAt(high, isDate)], limits: LIMITS });
        assert.deepStrictEqual(part.occurrences.map((o) => o.recurrenceId),
          want.filter((wall) => wall >= low).map((wall) => idOf(wall, isDate)), `${rule} from ${dtstart} over [${low}, ${high})`);
      }
      occurrences += want.length;
    }
    assert.ok(occurrences > 40000, `${occurrences} occurrences`);
  });
});
