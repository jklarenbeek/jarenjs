//@ts-check

/**
 * Golden files, compared byte for byte: a calendar hand-authored from
 * RFC 5545's own examples (fixtures/ical/PROVENANCE.md), which the
 * writer must reproduce exactly, and the writer's output for each kind,
 * for rule and expanded series and for free/busy, under a fixed clock.
 *
 * Regenerate the writer's own goldens after an intentional change with
 *   JAREN_UPDATE_GOLDENS=1 node --test test/josl/ical-golden.test.js
 * and review the diff line by line.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { stringifyIcal, createIcalWriter } from '@jarenjs/josl/ical';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const DIR = fileURLToPath(new URL('./fixtures/ical/', import.meta.url));
const provider = createIntlZoneProvider({ revision: 'golden' });
const runtime = { now: () => Date.parse('2026-01-15T10:20:30Z') };
const at = (/** @type {string} */ text) => Date.parse(text);

/**
 * Compare a calendar with its golden, as bytes.
 * @param {string} name
 * @param {string} text
 * @param {boolean} [authored] - hand-authored: never regenerated
 */
function golden(name, text, authored = false) {
  const file = `${DIR}${name}`;
  if (process.env.JAREN_UPDATE_GOLDENS && !authored)
    fs.writeFileSync(file, text);
  assert.ok(Buffer.from(text, 'utf8').equals(fs.readFileSync(file)), `${name} differs from its golden`);
}

const zoned = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'zoned', date, time, zone: 'Europe/Amsterdam' });
const floating = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'floating', date, time });

describe('ical goldens', () => {
  it('reproduces the RFC 5545 examples, hand-authored, byte for byte', () => {
    const calendar = {
      prodId: '-//xyz Corp//NONSGML PDA Calendar Version 1.0//EN',
      components: [
        { type: 'event', uid: '19970901T130000Z-123401@example.com', dtstamp: at('1997-09-01T13:00:00Z'),
          start: { kind: 'utc', instant: '1997-09-03T16:30:00Z' }, end: { kind: 'utc', instant: '1997-09-03T19:00:00Z' }, summary: 'Annual Employee Review' },
        { type: 'event', uid: '19970901T130000Z-123402@example.com', dtstamp: at('1997-09-01T13:00:00Z'),
          start: { kind: 'utc', instant: '1997-04-01T16:30:00Z' }, end: { kind: 'utc', instant: '1997-04-02T01:00:00Z' },
          summary: 'Laurel is in sensitivity awareness class.' },
        { type: 'event', uid: '20070423T123432Z-541111@example.com', dtstamp: { kind: 'utc', instant: '2007-04-23T12:34:32Z' },
          start: { kind: 'date-range', start: '2007-06-28', end: '2007-07-09' }, summary: 'Festival International de Jazz de Montreal' },
        { type: 'freebusy', uid: '19970901T115957Z-76A912@example.com', dtstamp: at('1997-09-01T12:00:00Z'),
          start: at('1998-03-13T14:17:11Z'), end: at('1998-04-10T14:17:11Z'), periods: [
            { start: at('1998-03-16T15:30:00Z'), end: at('1998-03-16T16:30:00Z') },
            { start: at('1998-03-14T23:30:00Z'), end: at('1998-03-15T00:30:00Z') },
            { start: at('1998-03-18T03:00:00Z'), end: at('1998-03-18T04:00:00Z') },
          ] },
      ],
    };
    golden('rfc5545-examples.ics', stringifyIcal(calendar), true);
  });

  it('every kind of time, text that folds and escapes, and the clock\'s DTSTAMP', () => {
    golden('kinds.ics', stringifyIcal({
      prodId: '-//Example//Shop hours//EN', method: 'publish',
      components: [
        { type: 'event', uid: 'closed-christmas', start: { kind: 'date', date: '2026-12-25' }, summary: 'Closed', status: 'confirmed' },
        { type: 'event', uid: 'inventory', start: floating('2026-03-02', '18:00'), end: floating('2026-03-02', '24:00'), location: 'Back room' },
        { type: 'event', uid: 'delivery', start: { kind: 'utc', instant: '2026-03-03T06:30:00Z' }, duration: 'PT45M', sequence: 1 },
        { type: 'event', uid: 'late-opening', start: zoned('2026-03-28', '20:00'), duration: 'P1DT1H', policy: 'rfc5545',
          summary: 'Late opening; extended hours, all departments', description: 'Line one\nLine two: café, 中文, 😀 and a backslash \\ too.' },
      ],
    }, { zones: 'utc', provider, runtime }));
  });

  it('rule series and an expanded zoned series with a moved slot', () => {
    const writer = createIcalWriter({ prodId: '-//Example//Staff rota//EN', zones: 'utc', provider, runtime,
      horizon: [at('2026-03-01T00:00:00Z'), at('2026-05-01T00:00:00Z')] });
    writer.write({ type: 'event', summary: 'Stock check', series: {
      uid: 'stock-check', sequence: 4,
      base: { dtstart: floating('2026-03-02', '08:00'), duration: 'PT2H', rrule: 'FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20260430T080000' },
      rdates: [{ start: floating('2026-03-07', '10:00'), end: floating('2026-03-07', '11:00') }],
      exdates: [floating('2026-04-06', '08:00')],
      overrides: [{ recurrenceId: '2026-03-12T08:00:00', status: 'moved', start: floating('2026-03-13', '08:00') },
        { recurrenceId: '2026-04-09T08:00:00', status: 'cancelled' }],
    } });
    writer.write({ type: 'event', summary: 'Morning briefing', series: {
      uid: 'briefing', base: { dtstart: zoned('2026-03-16', '09:00'), duration: 'PT15M', rrule: 'FREQ=WEEKLY;COUNT=4' },
      overrides: [{ recurrenceId: '2026-03-30T09:00:00', status: 'moved', start: zoned('2026-03-30', '09:30') }],
    } });
    golden('series.ics', writer.end());
  });
});
