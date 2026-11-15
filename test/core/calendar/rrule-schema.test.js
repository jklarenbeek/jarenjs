//@ts-check

/**
 * The recurrence rule's schema twin: over a seeded corpus of JSON rules,
 * valid and broken part by part, the schema validates exactly the rules
 * the grammar reads (`formatRRule` on the JSON form), for every
 * frequency. What only the compiler can refuse - UNTIL against the
 * start's kind, time parts with a date start, and a frequency not
 * enumerated - is pinned as validating, so the gap stays visible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import rruleSchema from '@jarenjs/core/schemas/calendar/rrule.schema.json' with { type: 'json' };
import temporalSchema from '@jarenjs/core/schemas/calendar/temporal.schema.json' with { type: 'json' };
import { compileRecurrence, formatRRule, dateValue, floatingValue } from '@jarenjs/core/calendar';
import { mulberry32 } from '@jarenjs/core/random';

const validator = new JarenValidator({ skipErrors: false, collectErrors: true });
validator.addSchema(temporalSchema);
const check = validator.compile(rruleSchema);

/** @param {unknown} rule */
function grammarReads(rule) {
  try {
    formatRRule(/** @type {any} */ (rule));
    return true;
  }
  catch (error) {
    assert.match(/** @type {any} */ (error).code, /^JY00(08|09|12|13|15|16|18)$/, String(error));
    return false;
  }
}

/** @param {unknown} rule */
const valid = (rule) => check(rule).valid === true;

const FREQS = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/** What each part may hold in the corpus: right values and wrong ones side by side. */
const VALUES = /** @type {Record<string, unknown[]>} */ ({
  INTERVAL: [1, 2, 0, -1, 1.5, '2'],
  COUNT: [1, 10, 0, 2.5],
  UNTIL: [
    { kind: 'date', date: '2026-12-24' }, { kind: 'floating', date: '2026-12-24', time: '23:00' },
    { kind: 'floating', date: '2026-12-24', time: '23:00:00.000' }, { kind: 'utc', instant: '2026-12-24T00:00:00Z' },
    { kind: 'utc', instant: '2026-12-24T00:00:00.000Z' }, { kind: 'utc', instant: '2026-12-24T00:00:00.500Z' },
    { kind: 'floating', date: '2026-12-24', time: '23:00:00.5' }, { kind: 'zoned', date: '2026-12-24', time: '00:00', zone: 'UTC' },
    { kind: 'date', date: '2026-02-30' }, { kind: 'floating', date: '2026-12-24', time: '24:00' }, '20261224',
    { kind: 'date-range', start: '2026-01-01', end: '2026-01-02' }, { kind: 'date', date: '2026-12-24', extra: 1 },
  ],
  BYSECOND: [[0], [59], [60], [61], [], [-1]],
  BYMINUTE: [[0, 30], [59], [60], [1.5]],
  BYHOUR: [[9], [0, 23], [24], [-1], ['9']],
  BYDAY: [['MO'], ['MO', 'FR'], ['1MO'], ['-1FR'], ['+2TU'], ['05WE'], ['53SU'], ['-53SU'], ['0MO'], ['54MO'], ['+MO'],
    ['mo'], ['MONDAY'], [], 'MO', ['100MO']],
  BYMONTHDAY: [[1], [-1, 31], [0], [32], [-32], [15, -15]],
  BYYEARDAY: [[1], [-366, 366], [0], [367]],
  BYWEEKNO: [[1], [-53, 53], [0], [54]],
  BYMONTH: [[1], [12, 6], [0], [13]],
  BYSETPOS: [[1], [-1, 366], [0], [367]],
  WKST: ['MO', 'SU', 'SUN', 'mo'],
});

describe('rrule.schema.json validates exactly the rules the grammar reads', () => {
  it('8,000 seeded JSON rules over every frequency', () => {
    const random = mulberry32(5545);
    const names = Object.keys(VALUES);
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 8000; i++) {
      /** @type {Record<string, unknown>} */
      const rule = {};
      if (random() < 0.97)
        rule.FREQ = random() < 0.95 ? FREQS[Math.floor(random() * FREQS.length)] : 'daily';
      const parts = Math.floor(random() * 4);
      for (let p = 0; p < parts; p++) {
        const name = names[Math.floor(random() * names.length)];
        const values = VALUES[name];
        // favour the right values so the accepted side is not thin
        rule[name] = values[Math.floor(random() * Math.min(values.length, random() < 0.6 ? 2 : values.length))];
      }
      if (random() < 0.01)
        rule.EXTRA = 1;
      const grammar = grammarReads(rule);
      assert.strictEqual(valid(rule), grammar, JSON.stringify(rule));
      if (grammar)
        accepted++;
      else
        refused++;
    }
    assert.ok(accepted > 1500 && refused > 1500, `${accepted} accepted, ${refused} refused`);
  });

  it('every compiled rule\'s canonical JSON validates', () => {
    for (const text of ['FREQ=DAILY;COUNT=3', 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20261224T000000;BYDAY=MO,WE;WKST=SU',
      'FREQ=DAILY;BYMONTH=1;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0;BYSECOND=0;BYSETPOS=1'])
      assert.ok(valid(compileRecurrence({ dtstart: floatingValue('2026-01-05', '09:00'), rrule: text }).rrule), text);
  });

  it('what only the compiler refuses still validates (the gap is pinned)', () => {
    /** @type {[unknown, any, string][]} */
    const gaps = [
      [{ FREQ: 'DAILY', UNTIL: { kind: 'date', date: '2026-12-24' } }, floatingValue('2026-01-05', '09:00'), 'JY0019'],
      [{ FREQ: 'DAILY', BYHOUR: [9] }, dateValue('2026-01-05'), 'JY0018'],
      [{ FREQ: 'MONTHLY', BYDAY: ['1FR'] }, floatingValue('2026-01-05', '09:00'), 'JY0020'],
    ];
    for (const [rule, dtstart, code] of gaps) {
      assert.ok(valid(rule), JSON.stringify(rule));
      assert.throws(() => compileRecurrence({ dtstart, rrule: /** @type {any} */ (rule) }), (/** @type {any} */ e) => e.code === code);
    }
  });
});
