//@ts-check

/**
 * The writer model's schema twin: every calendar the writer writes in
 * this corpus validates, every one it refuses for its shape does not,
 * and what only the writer can refuse (it needs a provider, a policy or
 * the calendar layer) is pinned as validating, so the gap stays visible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import icalSchema from '@jarenjs/josl/schemas/jaren-josl-ical.schema.json' with { type: 'json' };
import temporalSchema from '@jarenjs/core/schemas/calendar/temporal.schema.json' with { type: 'json' };
import rruleSchema from '@jarenjs/core/schemas/calendar/rrule.schema.json' with { type: 'json' };
import { stringifyIcal } from '@jarenjs/josl/ical';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const validator = new JarenValidator({ skipErrors: false, collectErrors: true });
validator.addSchema(temporalSchema);
validator.addSchema(rruleSchema);
const check = validator.compile(icalSchema);
const provider = createIntlZoneProvider({ revision: 'test' });
const options = { zones: /** @type {const} */ ('utc'), provider, runtime: { now: () => 0 },
  horizon: [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z')] };

/** @param {any[]} components */
const calendar = (components) => ({ prodId: '-//Example//Test//EN', components });
/** @param {unknown} model */
const valid = (model) => check(model).valid === true;
/** @param {any} model */
function writes(model) {
  try {
    stringifyIcal(model, options);
    return true;
  }
  catch (error) {
    assert.match(String(/** @type {any} */ (error).code), /^ICAL3/, String(error));
    return false;
  }
}

const floating = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'floating', date, time });
const zoned = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'zoned', date, time, zone: 'Europe/Amsterdam' });
const event = (/** @type {any} */ extra) => ({ type: 'event', uid: 'e', ...extra });

const WRITTEN = [
  calendar([]),
  calendar([{ type: 'event', series: { uid: 'h', base: { dtstart: floating('2026-03-02', '09:00'), rrule: 'FREQ=HOURLY' } } }]),
  { ...calendar([]), method: 'publish' },
  { ...calendar([]), method: 'request' },
  calendar([{ type: 'event', series: { uid: 'r', base: { dtstart: floating('2026-03-02', '09:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=4' },
    rdates: [{ start: floating('2026-03-10', '09:00'), duration: 'PT2H' }],
    overrides: [{ recurrenceId: '2026-03-03T09:00:00', status: 'moved', start: floating('2026-03-03', '10:00'), duration: 'PT30M', range: 'THISANDFUTURE' }] } }]),
  calendar([{ type: 'availability', uid: 'v', start: { kind: 'utc', instant: '2026-03-02T00:00:00Z' }, priority: 3, busyType: 'busy-unavailable',
    available: [{ series: { uid: 'a', base: { dtstart: { kind: 'utc', instant: '2026-03-02T09:00:00Z' }, duration: 'PT8H', rrule: 'FREQ=DAILY;COUNT=5' } }, summary: 'open' }] }]),
  calendar([{ type: 'availability', uid: 'v', busyType: 'busy', available: [] }, { type: 'availability', uid: 'w', busyType: 'busy-tentative', available: [] }]),
  { ...calendar([{ type: 'message', uid: 'm', dtstamp: 0, sequence: 1, organizer: { address: 'mailto:a@example.com' },
    attendees: [{ address: 'mailto:b@example.com' }], cancellation: { status: 'uninvited', attendees: ['mailto:b@example.com'] } }]), method: 'cancel' },
  calendar([{ type: 'message', uid: 'm', dtstamp: 0, organizer: { address: 'mailto:a@example.com', name: 'A' },
    attendees: [{ address: 'mailto:b@example.com', partstat: 'accepted', rsvp: false }], requestStatus: [{ code: '2.0', description: 'Success' }] }]),
  calendar([event({ start: { kind: 'date', date: '2026-03-02' }, summary: 'a', description: 'b', location: 'c', status: 'cancelled', sequence: 0 })]),
  calendar([event({ start: floating('2026-03-02', '09:00'), end: floating('2026-03-02', '24:00') })]),
  calendar([event({ start: { kind: 'utc', instant: '2026-03-02T09:00:00Z' }, duration: 'PT1H', dtstamp: 0 })]),
  calendar([event({ start: zoned('2026-03-02', '09:00'), policy: 'later', dtstamp: { kind: 'utc', instant: '2026-01-01T00:00:00Z' } })]),
  calendar([event({ start: { kind: 'date-range', start: '2026-03-02', end: '2026-03-05' } })]),
  calendar([{ type: 'event', series: { uid: 's', sequence: 1, revision: 'r1',
    base: { dtstart: floating('2026-03-02', '09:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;COUNT=4', wkst: 'MO', policy: 'rfc5545' },
    rdates: [floating('2026-03-20', '09:00'), { start: floating('2026-03-21', '09:00'), end: floating('2026-03-21', '11:00') }],
    exdates: [floating('2026-03-09', '09:00')],
    overrides: [{ recurrenceId: '2026-03-16T09:00:00', status: 'moved', start: floating('2026-03-16', '10:00'), payload: { any: 'thing' } },
      { recurrenceId: '2026-03-23T09:00:00', status: 'cancelled' }] }, summary: 'x' }]),
  calendar([{ type: 'event', series: { uid: 's', base: { dtstart: zoned('2026-03-02', '09:00'), rrule: { FREQ: 'DAILY', COUNT: 3 } } } }]),
  calendar([{ type: 'event', series: { uid: 's', rdates: [zoned('2026-03-02', '09:00')] } }]),
  calendar([{ type: 'freebusy', uid: 'f', start: 0, end: { kind: 'utc', instant: '1970-01-02T00:00:00Z' },
    periods: [{ start: 0, end: 1000, fbtype: 'busy-tentative' }, { start: 2000, end: 3000 }] }]),
];

const REFUSED_BY_SHAPE = [
  { components: [] },
  { prodId: 'p' },
  { ...calendar([]), method: 'x-push' },
  { ...calendar([]), timezones: [] },
  calendar([{ type: 'availability', uid: 'v', available: [], busyType: 'free' }]),
  calendar([{ type: 'availability', uid: 'v', available: [], priority: 10 }]),
  calendar([{ type: 'message', uid: 'm', attendees: [{ address: 'b@example.com' }] }]),
  { ...calendar([{ type: 'message', uid: 'm', dtstamp: 0, sequence: 1, organizer: { address: 'mailto:a@example.com' },
    attendees: [{ address: 'mailto:b@example.com' }], cancellation: { status: 'gone' } }]), method: 'cancel' },
  calendar([event({})]),
  calendar([{ type: 'event', start: { kind: 'date', date: '2026-03-02' } }]),
  calendar([event({ start: { kind: 'date', date: '2026-03-02' }, attendee: 'x' })]),
  calendar([event({ start: { kind: 'date', date: '2026-03-02' }, status: 'needs-action' })]),
  calendar([event({ start: { kind: 'date', date: '2026-03-02' }, sequence: -1 })]),
  calendar([event({ start: { kind: 'utc', instant: '2026-03-02T09:00:00Z' }, duration: 'P1Y' })]),
  calendar([event({ start: { kind: 'utc', instant: '2026-03-02T09:00:00Z' }, end: { kind: 'utc', instant: '2026-03-02T10:00:00Z' }, duration: 'PT1H' })]),
  calendar([event({ start: { kind: 'date', date: '2026-03-02' }, summary: 'bell\u0007' })]),
  calendar([event({ start: floating('2026-03-02', '24:00') })]),
  calendar([event({ start: { kind: 'date', date: '2026-03-02' }, dtstamp: 1.5 })]),
  calendar([{ type: 'todo', uid: 't' }]),
  calendar([{ type: 'event', series: { uid: 's', base: { dtstart: floating('2026-03-02', '09:00'), rrule: 'FREQ=DAILY' } }, uid: 'x' }]),
  calendar([{ type: 'event', series: { uid: 's' } }]),
  calendar([{ type: 'event', series: { uid: 's', base: { dtstart: floating('2026-03-02', '09:00'), rrule: 'FREQ=DAILY' },
    overrides: [{ recurrenceId: '2026-03-03T09:00:00', status: 'moved' }] } }]),
  calendar([{ type: 'freebusy', uid: 'f' }]),
  calendar([{ type: 'freebusy', uid: 'f', periods: [{ start: 0, end: 1000, fbtype: 'BUSY' }] }]),
  calendar([{ type: 'freebusy', uid: 'f', periods: [{ start: floating('2026-03-02', '09:00'), end: 1000 }] }]),
];

/** What the schema cannot say: each validates, and the writer refuses it. */
const REFUSED_BY_WRITER_ONLY = [
  ['a zoned single event with no policy', calendar([event({ start: zoned('2026-03-02', '09:00') })])],
  ['an end before its start', calendar([event({ start: floating('2026-03-02', '09:00'), end: floating('2026-03-02', '08:00') })])],
  ['an end of another kind', calendar([event({ start: floating('2026-03-02', '09:00'), end: { kind: 'date', date: '2026-03-03' } })])],
  ['a fraction of a second', calendar([event({ start: floating('2026-03-02', '09:00:00.5') })])],
  ['a lone surrogate in text', calendar([event({ start: { kind: 'date', date: '2026-03-02' }, summary: 'x\uD800' })])],
  ['a sub-daily frequency on a date start', calendar([{ type: 'event', series: { uid: 's', base: { dtstart: { kind: 'date', date: '2026-03-02' }, rrule: 'FREQ=HOURLY' } } }])],
  ['an override of a slot the series never makes', calendar([{ type: 'event', series: { uid: 's', base: { dtstart: floating('2026-03-02', '09:00'), rrule: 'FREQ=WEEKLY' },
    overrides: [{ recurrenceId: '2026-03-03T09:00:00', status: 'cancelled' }] } }])],
  ['a period of dates as an extra date', calendar([{ type: 'event', series: { uid: 's', rdates: [{ kind: 'date', date: '2026-03-01' }, { start: { kind: 'date', date: '2026-03-02' }, end: { kind: 'date', date: '2026-03-04' } }] } }])],
];

describe('the iCalendar model schema', () => {
  it('carries its $id and refs the calendar layer\'s two schemas', () => {
    assert.strictEqual(icalSchema.$id, 'https://jarenjs.dev/schemas/jaren-josl-ical/0.1');
    const text = JSON.stringify(icalSchema);
    assert.ok(text.includes(temporalSchema.$id) && text.includes(rruleSchema.$id));
  });

  it('validates every calendar the writer writes', () => {
    for (const model of WRITTEN) {
      assert.strictEqual(writes(model), true, JSON.stringify(model));
      assert.strictEqual(valid(model), true, `${JSON.stringify(model)}: ${JSON.stringify(check(model).errors)}`);
    }
  });

  it('refuses every calendar the writer refuses for its shape', () => {
    for (const model of REFUSED_BY_SHAPE) {
      assert.strictEqual(writes(model), false, JSON.stringify(model));
      assert.strictEqual(valid(model), false, JSON.stringify(model));
    }
  });

  for (const [name, model] of REFUSED_BY_WRITER_ONLY) {
    it(`pins the gap: ${name} validates and is refused by the writer`, () => {
      assert.strictEqual(valid(model), true, JSON.stringify(check(model).errors));
      assert.strictEqual(writes(model), false);
    });
  }
});
