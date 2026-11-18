//@ts-check

/**
 * SECONDLY, MINUTELY and HOURLY expansion against a second, independent
 * implementation: 600 seeded rules whose occurrences python-dateutil
 * generated (fixtures/rrule-oracle-subdaily; the test reads the JSON and
 * never runs Python). Each rule is expanded over its whole horizon and
 * over a later part of it, so the walk's skip ahead is checked too.
 * Floating and utc rules: dateutil steps a naive wall clock, which is
 * what both kinds step. Zoned rules across a change of offset are pinned
 * by rrule-subdaily.test.js, by hand from the zdump transitions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileRecurrence, expandRecurrence, formatRRule } from '@jarenjs/core/calendar';
import fixture from './fixtures/rrule-oracle-subdaily/occurrences.json' with { type: 'json' };

const LIMITS = { maxOccurrences: 100000, maxWork: 10000000 };

/** @param {string} text */
const wallOf = (text) => Date.parse(text.endsWith('Z') ? text : `${text}Z`);

/**
 * A wall clock as a value of the case's kind.
 * @param {number} wall
 * @param {boolean} utc
 */
const valueAt = (wall, utc) => {
  const text = new Date(wall).toISOString();
  return utc ? { kind: /** @type {const} */ ('utc'), instant: `${text.slice(0, 19)}Z` }
    : { kind: /** @type {const} */ ('floating'), date: text.slice(0, 10), time: text.slice(11, 19) };
};

/** @param {number} wall @param {boolean} utc */
const idOf = (wall, utc) => new Date(wall).toISOString().slice(0, 19) + (utc ? 'Z' : '');

describe('SECONDLY/MINUTELY/HOURLY expansion equals python-dateutil', () => {
  const cases = /** @type {[string, string, string, number[]][]} */ (fixture.cases);

  it('the fixture holds 600 cases from one seed, covering every frequency and part', () => {
    assert.strictEqual(cases.length, 600);
    assert.strictEqual(fixture.seed, 20261118);
    const shapes = /** @type {Record<string, number>} */ ({ utc: 0, negative: 0 });
    const names = ['SECONDLY', 'MINUTELY', 'HOURLY', 'COUNT', 'UNTIL', 'INTERVAL', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY',
      'BYMONTHDAY', 'BYYEARDAY', 'BYMONTH', 'BYSETPOS'];
    for (const [rule, dtstart] of cases) {
      for (const name of names)
        shapes[name] = (shapes[name] ?? 0) + (rule.includes(`${name}=`) || rule.startsWith(`FREQ=${name};`) ? 1 : 0);
      shapes.negative += /(BYMONTHDAY|BYYEARDAY|BYSETPOS)=[^;]*-/.test(rule) ? 1 : 0;
      shapes.utc += dtstart.endsWith('Z') ? 1 : 0;
    }
    for (const [name, n] of Object.entries(shapes))
      assert.ok(n >= 50, `${name}: ${n} cases`);
    // each frequency with each part it takes
    for (const freq of ['SECONDLY', 'MINUTELY', 'HOURLY']) {
      for (const name of names.slice(3)) {
        const n = cases.filter(([rule]) => rule.startsWith(`FREQ=${freq};`) && rule.includes(`${name}=`)).length;
        assert.ok(n >= 5, `${freq} with ${name}: ${n} cases`);
      }
    }
  });

  it('every case, over its whole horizon and over a later part of it', () => {
    let occurrences = 0;
    for (const [index, [rule, dtstart, end, offsets]] of cases.entries()) {
      const utc = dtstart.endsWith('Z');
      const start = wallOf(dtstart);
      const high = wallOf(end);
      const want = offsets.map((offset) => start + offset * 1000);
      const compiled = compileRecurrence({ dtstart: valueAt(start, utc), rrule: index % 2 === 0 ? rule : rule.toLowerCase() });
      assert.strictEqual(formatRRule(compileRecurrence({ dtstart: valueAt(start, utc), rrule: formatRRule(compiled) })),
        formatRRule(compiled));
      const whole = expandRecurrence(compiled, { horizon: [valueAt(start, utc), valueAt(high, utc)], limits: LIMITS });
      assert.strictEqual(whole.status, 'complete', rule);
      assert.deepStrictEqual(whole.occurrences.map((o) => o.recurrenceId), want.map((wall) => idOf(wall, utc)), `${rule} from ${dtstart}`);
      // a later part: from a second past the middle start, so the walk may skip ahead
      const pivot = want[Math.floor(want.length / 2)];
      const low = pivot + (index % 3) * 1000;
      if (low < high) {
        const part = expandRecurrence(compiled, { horizon: [valueAt(low, utc), valueAt(high, utc)], limits: LIMITS });
        assert.deepStrictEqual(part.occurrences.map((o) => o.recurrenceId),
          want.filter((wall) => wall >= low).map((wall) => idOf(wall, utc)), `${rule} from ${dtstart} over [${low}, ${high})`);
      }
      occurrences += want.length;
    }
    assert.ok(occurrences >= 5000, `${occurrences} occurrences`);
  });
});
