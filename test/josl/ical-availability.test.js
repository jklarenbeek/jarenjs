//@ts-check

/**
 * `freeBusy`'s answer feeds the VFREEBUSY writer directly: evaluate
 * availability layers, project them, write the calendar, read it back
 * with the independent reader and get the same periods - and no layer
 * id, source or revision in the bytes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { stringifyIcal } from '@jarenjs/josl/ical';
import { evaluateAvailability, freeBusy, weeklyPattern, dateValue, utcValue } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { readIcal, physicalLines, unfold, splitLine, prop, props, timeOf } from './ical-reader.js';
import { checkGrammar } from './ical-grammar.js';

const provider = createIntlZoneProvider({ revision: 'test' });
const runtime = { now: () => Date.parse('2026-03-01T12:00:00Z') };

describe('availability to VFREEBUSY and back', () => {
  const result = evaluateAvailability([
    { id: 'staff-hours', priority: 5, mode: 'available', series: weeklyPattern({ days: { mon: [['09:00', '17:00']], tue: [['09:00', '12:30']] } }),
      source: 'contract-store', revision: 'rev-41' },
    { id: 'annual-leave', priority: 1, mode: 'busy', busyType: 'busy-unavailable', spans: [dateValue('2026-03-04')], source: 'leave-store' },
    { id: 'training', priority: 2, mode: 'busy', busyType: 'busy-tentative',
      spans: [{ start: Date.parse('2026-03-03T09:00:00Z'), end: Date.parse('2026-03-03T10:00:00Z') }], source: 'calendar' },
    { id: 'shift', priority: 2, mode: 'busy', spans: [{ start: Date.parse('2026-03-02T12:00:00.250Z'), end: Date.parse('2026-03-02T13:00:00Z') }], source: 'rota' },
  ], { horizon: [utcValue('2026-03-02T00:00:00Z'), utcValue('2026-03-06T00:00:00Z')], zone: 'Europe/Amsterdam', provider, policy: 'rfc5545' });

  for (const reveal of /** @type {const} */ (['types', 'none'])) {
    it(`reveal ${reveal}: the periods written are the periods read`, () => {
      const { unknownCount, ...period } = freeBusy(result, { reveal });
      assert.ok(unknownCount > 0);
      const text = stringifyIcal({ prodId: '-//Example//Availability//EN', components: [{ type: 'freebusy', uid: 'fb-1', ...period }] }, { runtime });
      for (const line of unfold(physicalLines(text)))
        checkGrammar(splitLine(line));
      const vfb = readIcal(text).children[0];
      assert.strictEqual(vfb.name, 'VFREEBUSY');
      assert.deepStrictEqual([timeOf(/** @type {any} */ (prop(vfb, 'DTSTART')).value).at, timeOf(/** @type {any} */ (prop(vfb, 'DTEND')).value).at],
        [period.start, period.end]);
      const read = props(vfb, 'FREEBUSY').map((p) => {
        const [from, to] = p.value.split('/');
        return { start: timeOf(from).at, end: timeOf(to).at, fbtype: p.params.FBTYPE.toLowerCase() };
      }).sort((a, b) => a.start - b.start);
      assert.deepStrictEqual(read, period.periods.map((p) => ({ ...p })));
      // the shift's start inside a second was moved outward: busy from 12:00:00, free until then
      assert.deepStrictEqual(read.filter((p) => p.start >= Date.parse('2026-03-02T08:00:00Z') && p.end <= Date.parse('2026-03-02T16:00:00Z')), [
        { start: Date.parse('2026-03-02T08:00:00Z'), end: Date.parse('2026-03-02T12:00:00Z'), fbtype: 'free' },
        { start: Date.parse('2026-03-02T12:00:00Z'), end: Date.parse('2026-03-02T13:00:00Z'), fbtype: 'busy' },
        { start: Date.parse('2026-03-02T13:00:00Z'), end: Date.parse('2026-03-02T16:00:00Z'), fbtype: 'free' }]);
      for (const secret of ['staff-hours', 'contract-store', 'rev-41', 'annual-leave', 'leave-store', 'training', 'rota'])
        assert.ok(!text.includes(secret), `${secret} reached the calendar`);
      if (reveal === 'none')
        assert.deepStrictEqual([...new Set(read.map((p) => p.fbtype))].sort(), ['busy', 'free']);
      else assert.deepStrictEqual([...new Set(read.map((p) => p.fbtype))].sort(), ['busy', 'busy-tentative', 'busy-unavailable', 'free']);
    });
  }
});
