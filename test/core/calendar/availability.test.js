//@ts-check

/**
 * Availability layers: RFC 7953 priorities and ties, bounded layers
 * claiming their whole period (available ones) or only their spans
 * (busy ones) against unbounded layers that fall through, the three sources
 * of unknown time (default, no zone, a stopped expansion) and a fourth
 * for questions outside the horizon, none of which ever reads as free;
 * open bounds, horizon edges, Amsterdam's 23- and 25-hour days, the
 * whole-interval question, the free/busy projection and its privacy,
 * slot search, and every refusal.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  evaluateAvailability, availabilityOf, freeBusy, findAvailableSlots, AVAILABILITY_LIMITS,
  weeklyPattern, compileRecurrence, defineSeries, dateValue, dateRangeValue, floatingValue, utcValue, zonedValue, CalendarError,
} from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider({ revision: 'test-tzdata' });
const AMS = { zone: 'Europe/Amsterdam', zoneSource: 'location', provider, policy: /** @type {const} */ ('rfc5545') };
const Z = (/** @type {string} */ text) => Date.parse(text);
const HOUR = 3600000;
const week = /** @type {[any, any]} */ ([utcValue('2026-03-02T00:00:00Z'), utcValue('2026-03-09T00:00:00Z')]);

/** @param {any} result */
const brief = (result) => result.spans.map((/** @type {any} */ s) => [new Date(s.start).toISOString().slice(5, 16), new Date(s.end).toISOString().slice(5, 16),
  s.state + (s.busyType ? `:${s.busyType}` : '') + (s.reason ? `:${s.reason}` : ''), s.sources.map((/** @type {any} */ x) => x.id).join(',')].join(' '));

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

/** Two instant spans, one layer each. */
const span = (/** @type {string} */ id, /** @type {number} */ priority, /** @type {'available' | 'busy'} */ mode, /** @type {string} */ from, /** @type {string} */ to, extra = {}) =>
  ({ id, priority, mode, spans: [{ start: Z(from), end: Z(to) }], source: `src:${id}`, ...extra });
const day = /** @type {[any, any]} */ ([Z('2026-03-02T00:00:00Z'), Z('2026-03-03T00:00:00Z')]);

describe('priorities follow RFC 7953, and ties go to busy', () => {
  it('a priority-1 busy layer beats a priority-5 available layer', () => {
    const result = evaluateAvailability([
      span('open', 5, 'available', '2026-03-02T08:00:00Z', '2026-03-02T16:00:00Z'),
      span('meeting', 1, 'busy', '2026-03-02T10:00:00Z', '2026-03-02T11:00:00Z'),
    ], { horizon: day });
    assert.deepStrictEqual(brief(result), [
      '03-02T00:00 03-02T08:00 unknown:default ', '03-02T08:00 03-02T10:00 available open',
      '03-02T10:00 03-02T11:00 busy:busy meeting', '03-02T11:00 03-02T16:00 available open', '03-02T16:00 03-03T00:00 unknown:default ']);
  });

  it('a lower-priority busy layer under a higher-priority available layer stays available', () => {
    const result = evaluateAvailability([
      span('override', 1, 'available', '2026-03-02T08:00:00Z', '2026-03-02T16:00:00Z'),
      span('closure', 5, 'busy', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z'),
    ], { horizon: day });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-02T08:00 busy:busy closure', '03-02T08:00 03-02T16:00 available override',
      '03-02T16:00 03-03T00:00 busy:busy closure']);
  });

  it('available against busy at equal priority is busy; priority 0 loses to everything', () => {
    const tie = evaluateAvailability([
      span('a', 3, 'available', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z'),
      span('b', 3, 'busy', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z', { busyType: 'busy-tentative' }),
    ], { horizon: day });
    assert.deepStrictEqual(brief(tie), ['03-02T00:00 03-03T00:00 busy:busy-tentative b']);
    const zero = evaluateAvailability([
      span('undefined', 0, 'busy', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z'),
      span('lowest', 9, 'available', '2026-03-02T06:00:00Z', '2026-03-02T18:00:00Z'),
    ], { horizon: day });
    assert.deepStrictEqual(brief(zero), ['03-02T00:00 03-02T06:00 busy:busy undefined', '03-02T06:00 03-02T18:00 available lowest',
      '03-02T18:00 03-03T00:00 busy:busy undefined']);
  });

  it('among equal busy layers the strongest busy type wins and both are named', () => {
    const result = evaluateAvailability([
      span('x', 2, 'busy', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z', { busyType: 'busy-tentative' }),
      span('y', 2, 'busy', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z', { busyType: 'busy-unavailable', revision: 'v7' }),
      span('z', 2, 'busy', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z'),
    ], { horizon: day });
    assert.deepStrictEqual(result.spans.map((s) => [s.busyType, s.sources]), [['busy-unavailable', [{ id: 'x' }, { id: 'y', revision: 'v7' }, { id: 'z' }]]]);
  });

  it('unknown at a rank beats available at that rank and below, and loses to busy at it', () => {
    const floating = { id: 'hours', priority: 4, mode: 'available', source: 's',
      spans: [{ start: floatingValue('2026-03-02', '09:00'), end: floatingValue('2026-03-02', '17:00') }] };
    const tie = evaluateAvailability(/** @type {any} */ ([floating, span('open', 4, 'available', '2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z')]), { horizon: day });
    assert.deepStrictEqual(brief(tie), ['03-02T00:00 03-03T00:00 unknown:no-zone hours']);
    const busy = evaluateAvailability(/** @type {any} */ ([floating, span('closed', 4, 'busy', '2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z')]), { horizon: day });
    assert.deepStrictEqual(brief(busy), ['03-02T00:00 03-03T00:00 busy:busy closed']);
    const above = evaluateAvailability(/** @type {any} */ ([floating, span('open', 1, 'available', '2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z')]), { horizon: day });
    assert.deepStrictEqual(brief(above), ['03-02T00:00 03-03T00:00 available open']);
  });
});

describe('unknown is never free', () => {
  const hours = weeklyPattern({ days: { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']] } });

  it('the default: time no layer claims is unknown, or busy-unavailable when the caller says busy, never available', () => {
    const result = evaluateAvailability([], { horizon: day });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-03T00:00 unknown:default ']);
    assert.deepStrictEqual(brief(evaluateAvailability([], { horizon: day, default: 'busy' })), ['03-02T00:00 03-03T00:00 busy:busy-unavailable ']);
    refuses(() => evaluateAvailability([], { horizon: day, default: /** @type {any} */ ('available') }), 'JY0014', '/options/default');
    assert.strictEqual(availabilityOf(result, { start: day[0], end: day[1] }).state, 'unknown');
    assert.deepStrictEqual(findAvailableSlots(result, { duration: 'PT15M' }).slots, []);
    assert.ok(freeBusy(result).periods.every((p) => p.fbtype !== 'free'));
  });

  it('no zone: a floating weekly layer yields only unknown spans, no-zone a day either side of its hours', () => {
    const result = evaluateAvailability([{ id: 'hours', priority: 5, mode: 'available', series: hours, source: 'contract' }],
      { horizon: week, zone: null, provider, policy: 'rfc5545' });
    assert.ok(result.spans.every((s) => s.state === 'unknown'));
    // Wednesday's 17:00 reaches Thursday 17:00; next Monday's 09:00 reaches back to Sunday 09:00
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-05T17:00 unknown:no-zone hours', '03-05T17:00 03-08T09:00 unknown:default ',
      '03-08T09:00 03-09T00:00 unknown:no-zone hours']);
    assert.strictEqual(result.binding, null);
    assert.deepStrictEqual(findAvailableSlots(result, { duration: 'PT15M' }).slots, []);
    assert.ok(freeBusy(result).periods.every((p) => p.fbtype === 'busy-unavailable'));
    const zoned = evaluateAvailability([{ id: 'hours', priority: 5, mode: 'available', series: hours, source: 'contract' }],
      { horizon: week, ...AMS });
    assert.deepStrictEqual(zoned.spans.filter((s) => s.state === 'available').map((s) => [s.start, s.end]),
      [2, 3, 4].map((d) => [Z(`2026-03-0${d}T08:00:00Z`), Z(`2026-03-0${d}T16:00:00Z`)]));
    assert.deepStrictEqual(zoned.binding, { zone: 'Europe/Amsterdam', source: 'location' });
    assert.deepStrictEqual(zoned.provider, { name: 'intl', revision: 'test-tzdata' });
  });

  it('no zone: date spans and date bounds are unknown too, while instant spans stay known', () => {
    const result = evaluateAvailability([
      { id: 'leave', priority: 1, mode: 'busy', spans: [dateValue('2026-03-04')], source: 'hr' },
      { id: 'open', priority: 5, mode: 'available', spans: [{ start: day[0], end: Z('2026-03-09T00:00:00Z') }], bounds: [undefined, dateValue('2026-03-07')], source: 'x' },
    ], { horizon: week });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-03T00:00 available open', '03-03T00:00 03-06T00:00 unknown:no-zone leave',
      '03-06T00:00 03-08T00:00 unknown:no-zone open', '03-08T00:00 03-09T00:00 unknown:default ']);
  });

  it('a stopped expansion: its uncovered remainder is unknown with reason incomplete, and the layer names the limit', () => {
    const result = evaluateAvailability([{ id: 'hours', priority: 5, mode: 'available', series: hours, source: 'contract', revision: 'r3' }],
      { horizon: week, ...AMS, limits: { maxOccurrences: 3 } });
    assert.strictEqual(result.complete, false);
    assert.deepStrictEqual(result.layers.map((l) => [l.id, l.status, l.limit]), [['hours', 'incomplete', 'maxOccurrences']]);
    assert.ok(result.layers[0].counts.emitted > 0);
    // the third occurrence (Wednesday 09:00) is where the cut fell; from a day before its wall clock nothing is proven
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-02T08:00 unknown:default ', '03-02T08:00 03-02T16:00 available hours',
      '03-02T16:00 03-03T08:00 unknown:default ', '03-03T08:00 03-03T09:00 available hours', '03-03T09:00 03-09T00:00 unknown:incomplete hours']);
    for (const slot of findAvailableSlots(result, { duration: 'PT30M' }).slots)
      assert.strictEqual(availabilityOf(result, slot).state, 'available');
    const all = evaluateAvailability([{ id: 'hours', priority: 5, mode: 'available', series: hours, source: 'c' }],
      { horizon: week, ...AMS, limits: { maxWork: 2 } });
    assert.deepStrictEqual(brief(all), ['03-02T00:00 03-09T00:00 unknown:incomplete hours']);
    assert.strictEqual(all.layers[0].limit, 'maxWork');
  });

  it('a question outside the evaluated horizon is unknown there', () => {
    const result = evaluateAvailability([span('open', 1, 'available', '2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z')], { horizon: day });
    const answer = availabilityOf(result, { start: Z('2026-03-02T22:00:00Z'), end: Z('2026-03-03T02:00:00Z') });
    assert.strictEqual(answer.state, 'unknown');
    assert.deepStrictEqual(answer.reasons, [{ start: day[1], end: Z('2026-03-03T02:00:00Z'), state: 'unknown', sources: [], reason: 'outside-horizon' }]);
    assert.strictEqual(availabilityOf(result, { start: Z('2026-03-01T23:00:00Z'), end: Z('2026-03-02T01:00:00Z') }).reasons[0].reason, 'outside-horizon');
    assert.strictEqual(availabilityOf(result, { start: day[0], end: day[1] }).state, 'available');
  });
});

describe('bounds, horizon edges and dropped spans', () => {
  it('open bounds are clipped to the horizon; a closed bound clips the layer', () => {
    const result = evaluateAvailability([
      { id: 'absence', priority: 1, mode: 'busy', spans: [{ start: Z('2026-03-02T12:00:00Z') }], source: 'hr' },
      { id: 'open', priority: 5, mode: 'available', spans: [{}], bounds: [Z('2026-03-02T06:00:00Z')], source: 'x' },
    ], { horizon: day });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-02T06:00 unknown:default ', '03-02T06:00 03-02T12:00 available open',
      '03-02T12:00 03-03T00:00 busy:busy absence']);
  });

  it('a span edge exactly on a horizon edge claims nothing outside, and its touching neighbour nothing inside', () => {
    const result = evaluateAvailability([
      span('before', 1, 'busy', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z'),
      span('after', 1, 'busy', '2026-03-03T00:00:00Z', '2026-03-04T00:00:00Z'),
      span('exact', 2, 'available', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z'),
    ], { horizon: day });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-03T00:00 available exact']);
    assert.deepStrictEqual(result.horizon, { start: day[0], end: day[1] });
  });

  it('a floating span the spring gap reverses covers nothing and is not refused', () => {
    const result = evaluateAvailability([{ id: 'odd', priority: 1, mode: 'available', source: 's',
      spans: [{ start: floatingValue('2026-03-29', '02:50'), end: floatingValue('2026-03-29', '03:10') }] }],
    { horizon: [Z('2026-03-28T00:00:00Z'), Z('2026-03-30T00:00:00Z')], ...AMS });
    assert.deepStrictEqual(brief(result), ['03-28T00:00 03-30T00:00 unknown:default ']);
  });

  it('a date range is whole civil days, its end exclusive of the next', () => {
    const result = evaluateAvailability([{ id: 'leave', priority: 1, mode: 'busy', spans: [dateRangeValue('2026-03-03', '2026-03-04')], source: 'hr' }],
      { horizon: week, ...AMS, default: 'busy' });
    assert.deepStrictEqual(brief(result).filter((s) => s.includes('leave')), ['03-02T23:00 03-04T23:00 busy:busy leave']);
  });

  it('a utc series layer expands from its own instants', () => {
    const series = defineSeries({ uid: 'standup', base: compileRecurrence({ dtstart: utcValue('2026-03-01T08:30:00Z'), duration: 'PT15M', rrule: 'FREQ=DAILY' }) });
    const result = evaluateAvailability([{ id: 'standup', priority: 1, mode: 'busy', series, source: 'cal' }], { horizon: day, default: 'busy' });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-02T08:30 busy:busy-unavailable ', '03-02T08:30 03-02T08:45 busy:busy standup',
      '03-02T08:45 03-03T00:00 busy:busy-unavailable ']);
  });
});

describe('a floating weekly layer bound to Amsterdam across its 23- and 25-hour days', () => {
  const allDay = weeklyPattern({ days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true } });
  const layer = [{ id: 'all', priority: 1, mode: /** @type {const} */ ('available'), series: allDay, source: 's' }];

  for (const [date, hours, start] of /** @type {[string, number, string][]} */ ([
    ['2026-03-29', 23, '2026-03-28T23:00:00Z'], ['2026-10-25', 25, '2026-10-24T22:00:00Z']])) {
    it(`${date} is ${hours} hours of available time`, () => {
      const begin = Z(start);
      const result = evaluateAvailability(layer, { horizon: [begin, begin + hours * HOUR], ...AMS });
      assert.deepStrictEqual(result.spans.map((s) => [s.state, s.end - s.start]), [['available', hours * HOUR]]);
    });
  }

  it('09:00-17:00 lands at its instants on both sides of the spring change', () => {
    const nine = weeklyPattern({ days: { sat: [['09:00', '17:00']], sun: [['09:00', '17:00']], mon: [['09:00', '17:00']] } });
    const result = evaluateAvailability([{ id: 'h', priority: 1, mode: 'available', series: nine, source: 's' }],
      { horizon: [Z('2026-03-28T00:00:00Z'), Z('2026-03-31T00:00:00Z')], ...AMS });
    assert.deepStrictEqual(result.spans.filter((s) => s.state === 'available').map((s) => new Date(s.start).toISOString().slice(5, 16)),
      ['03-28T08:00', '03-29T07:00', '03-30T07:00']);
  });

  it('slots fit 22:00-02:00 across midnight and across the spring change, never past an edge', () => {
    const night = weeklyPattern({ days: { sat: [['22:00', '24:00']], sun: [['00:00', '02:00'], ['22:00', '24:00']], mon: [['00:00', '02:00']] } });
    const result = evaluateAvailability([{ id: 'night', priority: 1, mode: 'available', series: night, source: 's' }],
      { horizon: [Z('2026-03-28T00:00:00Z'), Z('2026-03-31T00:00:00Z')], ...AMS });
    // Saturday 22:00 CET to Sunday 02:00 CET is four hours; Sunday 22:00 CEST to Monday 02:00 CEST is four
    assert.deepStrictEqual(result.spans.filter((s) => s.state === 'available').map((s) => [new Date(s.start).toISOString().slice(5, 16), (s.end - s.start) / HOUR]),
      [['03-28T21:00', 4], ['03-29T20:00', 4]]);
    const slots = findAvailableSlots(result, { duration: 'PT3H', step: 'PT1H' }).slots;
    assert.deepStrictEqual(slots.map((s) => new Date(s.start).toISOString().slice(5, 16)), ['03-28T21:00', '03-28T22:00', '03-29T20:00', '03-29T21:00']);
    const spring = evaluateAvailability([{ id: 'n', priority: 1, mode: 'available', source: 's',
      spans: [{ start: floatingValue('2026-03-29', '00:00'), end: floatingValue('2026-03-29', '04:00') }] }],
    { horizon: [Z('2026-03-28T00:00:00Z'), Z('2026-03-30T00:00:00Z')], ...AMS });
    assert.deepStrictEqual(findAvailableSlots(spring, { duration: 'PT3H', step: 'PT30M' }).slots.map((s) => new Date(s.start).toISOString().slice(11, 16)), ['23:00']);
  });
});

describe('availabilityOf: whether a whole interval is available', () => {
  const result = evaluateAvailability([
    span('open', 5, 'available', '2026-03-02T08:00:00Z', '2026-03-02T16:00:00Z', { revision: 'r1' }),
    span('meeting', 1, 'busy', '2026-03-02T12:00:00Z', '2026-03-02T13:00:00Z'),
  ], { horizon: day });

  it('available only when every instant is, naming the layers', () => {
    assert.deepStrictEqual(availabilityOf(result, { start: Z('2026-03-02T08:00:00Z'), end: Z('2026-03-02T12:00:00Z') }),
      { state: 'available', reasons: [], sources: [{ id: 'open', revision: 'r1' }] });
  });

  it('one busy minute makes it busy, and the answer says which', () => {
    const answer = availabilityOf(result, { start: utcValue('2026-03-02T11:00:00Z'), end: utcValue('2026-03-02T12:01:00Z') });
    assert.strictEqual(answer.state, 'busy');
    assert.deepStrictEqual(answer.reasons, [{ start: Z('2026-03-02T12:00:00Z'), end: Z('2026-03-02T12:01:00Z'), state: 'busy', busyType: 'busy', sources: [{ id: 'meeting' }] }]);
    assert.deepStrictEqual(answer.sources, [{ id: 'meeting' }]);
  });

  it('busy outranks unknown in the verdict, and every reason is listed', () => {
    const answer = availabilityOf(result, { start: Z('2026-03-02T07:00:00Z'), end: Z('2026-03-02T13:00:00Z') });
    assert.strictEqual(answer.state, 'busy');
    assert.deepStrictEqual(answer.reasons.map((r) => r.state), ['unknown', 'busy']);
  });

  it('reads an answer that went through JSON, and refuses what is not one', () => {
    const cached = JSON.parse(JSON.stringify(result));
    assert.strictEqual(availabilityOf(cached, { start: Z('2026-03-02T08:00:00Z'), end: Z('2026-03-02T09:00:00Z') }).state, 'available');
    refuses(() => availabilityOf(/** @type {any} */ ({ horizon: { start: 0, end: 10 }, spans: [{ start: 0, end: 5, state: 'available', sources: [] }] }), { start: 0, end: 1 }),
      'JY0014', '/result/spans');
    refuses(() => availabilityOf(/** @type {any} */ ({ spans: [] }), { start: 0, end: 1 }), 'JY0014', '/result');
    refuses(() => availabilityOf(/** @type {any} */ ({ horizon: { start: 0, end: 10 }, spans: [{ start: 0, end: 10, state: 'free', sources: [] }] }), { start: 0, end: 1 }),
      'JY0014', '/result/spans/0');
    refuses(() => availabilityOf(/** @type {any} */ ({ horizon: { start: 0, end: 0 }, spans: [] }), { start: 0, end: 1 }), 'JY0014', '/result/horizon');
    refuses(() => availabilityOf(result, { start: day[1], end: day[0] }), 'JY0014', '/interval/end');
    refuses(() => availabilityOf(result, /** @type {any} */ ({ start: 0, end: 1, zone: 'x' })), 'JY0014', '/interval/zone');
    refuses(() => availabilityOf(result, /** @type {any} */ (null)), 'JY0014', '/interval');
    refuses(() => availabilityOf(result, /** @type {any} */ ({ start: 0.5, end: 1 })), 'JY0013', '/interval/start');
  });
});

describe('freeBusy: intervals and types, nothing else', () => {
  const layers = [
    { id: 'contract-7781', priority: 5, mode: /** @type {const} */ ('available'), spans: [{ start: Z('2026-03-02T08:00:00Z'), end: Z('2026-03-02T16:00:00Z') }],
      source: { system: 'hr-secret', row: 'payload-42' }, revision: 'rev-abc' },
    { id: 'clinic-visit', priority: 1, mode: /** @type {const} */ ('busy'), busyType: /** @type {const} */ ('busy-tentative'),
      spans: [{ start: Z('2026-03-02T10:00:00Z'), end: Z('2026-03-02T11:00:00Z') }], source: 'medical-note' },
    { id: 'other-busy', priority: 1, mode: /** @type {const} */ ('busy'), spans: [{ start: Z('2026-03-02T11:00:00Z'), end: Z('2026-03-02T12:00:00Z') }], source: 'x' },
    { id: 'more-busy', priority: 2, mode: /** @type {const} */ ('busy'), spans: [{ start: Z('2026-03-02T12:00:00Z'), end: Z('2026-03-02T13:00:00Z') }], source: 'y' },
  ];
  const result = evaluateAvailability(layers, { horizon: day });

  it('maps states to FBTYPE values, unknown to busy-unavailable with a count, and joins neighbours of one type', () => {
    const fb = freeBusy(result);
    assert.deepStrictEqual(fb.periods.map((p) => [new Date(p.start).toISOString().slice(11, 16), new Date(p.end).toISOString().slice(11, 16), p.fbtype]), [
      ['00:00', '08:00', 'busy-unavailable'], ['08:00', '10:00', 'free'], ['10:00', '11:00', 'busy-tentative'],
      ['11:00', '13:00', 'busy'], ['13:00', '16:00', 'free'], ['16:00', '00:00', 'busy-unavailable']]);
    assert.strictEqual(fb.unknownCount, 2);
    assert.deepStrictEqual([fb.start, fb.end], day);
  });

  it('reveal none shows every period that is not free as busy', () => {
    assert.deepStrictEqual(freeBusy(result, { reveal: 'none' }).periods.map((p) => p.fbtype), ['busy', 'free', 'busy', 'free', 'busy']);
  });

  it('leaks no layer id, source, revision or reason', () => {
    const text = JSON.stringify([freeBusy(result), freeBusy(result, { reveal: 'none' })]);
    for (const secret of ['contract-7781', 'hr-secret', 'payload-42', 'rev-abc', 'clinic-visit', 'medical-note', 'other-busy', 'more-busy', 'default', 'sources', 'reason'])
      assert.ok(!text.includes(secret), `${secret} leaked`);
  });

  it('an edge inside a second moves outward for busy time and inward for free time', () => {
    const fine = evaluateAvailability([
      { id: 'a', priority: 1, mode: 'available', spans: [{ start: 1500, end: 9500 }], source: 's' },
      { id: 'b', priority: 1, mode: 'busy', spans: [{ start: 4200, end: 4700 }], source: 's' },
    ], { horizon: [250, 12000] });
    const fb = freeBusy(fine);
    assert.deepStrictEqual(fb.periods.map((p) => [p.start, p.end, p.fbtype]),
      [[0, 2000, 'busy-unavailable'], [2000, 4000, 'free'], [4000, 5000, 'busy'], [5000, 9000, 'free'], [9000, 12000, 'busy-unavailable']]);
    assert.deepStrictEqual([fb.start, fb.end], [0, 12000]);
    const tiny = evaluateAvailability([{ id: 'a', priority: 1, mode: 'available', spans: [{ start: 1200, end: 1800 }], source: 's' }], { horizon: [1000, 3000] });
    assert.deepStrictEqual(freeBusy(tiny).periods.map((p) => p.fbtype), ['busy-unavailable']);
    assert.deepStrictEqual(freeBusy(evaluateAvailability([], { horizon: [500, 2500] }), { reveal: 'none' }).periods, [{ start: 0, end: 3000, fbtype: 'busy' }]);
  });

  it('refuses a malformed option', () => {
    refuses(() => freeBusy(result, /** @type {any} */ ({ reveal: 'all' })), 'JY0014', '/options/reveal');
    refuses(() => freeBusy(result, /** @type {any} */ ({ show: 'types' })), 'JY0014', '/options/show');
    refuses(() => freeBusy(result, /** @type {any} */ (7)), 'JY0014', '/options');
  });
});

describe('findAvailableSlots: findSlots over available time only', () => {
  const result = evaluateAvailability([
    span('open', 5, 'available', '2026-03-02T08:10:00Z', '2026-03-02T12:00:00Z'),
    span('more', 5, 'available', '2026-03-02T12:00:00Z', '2026-03-02T13:00:00Z', { revision: 'x' }),
    span('lunch', 1, 'busy', '2026-03-02T10:00:00Z', '2026-03-02T10:30:00Z'),
  ], { horizon: day });

  it('touching available spans are one window; busy time splits it', () => {
    const { slots, status, counts } = findAvailableSlots(result, { duration: 'PT1H', alignment: 'PT30M' });
    assert.strictEqual(status, 'complete');
    assert.deepStrictEqual(slots.map((s) => new Date(s.start).toISOString().slice(11, 16)), ['08:30', '09:00', '10:30', '11:00', '11:30', '12:00']);
    assert.strictEqual(counts.emitted, 6);
    assert.deepStrictEqual(findAvailableSlots(result, { duration: HOUR }).slots.map((s) => new Date(s.start).toISOString().slice(11, 16)),
      ['08:10', '10:30', '11:30']);
  });

  it('stops at maxSlots and says so', () => {
    const capped = findAvailableSlots(result, { duration: 'PT15M', limits: { maxSlots: 2 } });
    assert.deepStrictEqual([capped.status, capped.limit, capped.slots.length], ['incomplete', 'maxSlots', 2]);
    assert.strictEqual(findAvailableSlots(result, { duration: 'PT15M', limits: {} }).slots.length, 17);
    assert.strictEqual(findAvailableSlots(result, { duration: 'PT15M', limits: { maxSlots: 0 } }).status, 'incomplete');
    assert.strictEqual(AVAILABILITY_LIMITS.maxSlots, 10000);
    assert.ok(Object.isFrozen(AVAILABILITY_LIMITS));
  });

  it('refuses a malformed search', () => {
    refuses(() => findAvailableSlots(result, { duration: 'P1M' }), 'JY0014', '/options/duration');
    refuses(() => findAvailableSlots(result, { duration: 0 }), 'JY0014', '/options/duration');
    refuses(() => findAvailableSlots(result, { duration: 'PT1H', alignment: 'PT30M', step: 'PT20M' }), 'JY0014', '/options/step');
    refuses(() => findAvailableSlots(result, /** @type {any} */ ({ duration: 'PT1H', at: 1 })), 'JY0014', '/options/at');
    refuses(() => findAvailableSlots(result, /** @type {any} */ ({ duration: 'PT1H', limits: 3 })), 'JY0014', '/options/limits');
    refuses(() => findAvailableSlots(result, /** @type {any} */ ({ duration: 'PT1H', limits: { maxSlots: -1 } })), 'JY0014', '/options/limits/maxSlots');
    refuses(() => findAvailableSlots(result, /** @type {any} */ ({ duration: 'PT1H', limits: { slots: 1 } })), 'JY0014', '/options/limits/slots');
    refuses(() => findAvailableSlots(result, /** @type {any} */ (null)), 'JY0014', '/options');
  });
});

describe('evaluateAvailability refuses a malformed layer or option', () => {
  const ok = { id: 'a', priority: 1, mode: 'busy', spans: [], source: 's' };
  const run = (/** @type {any} */ layer, /** @type {any} */ options = {}) => () => evaluateAvailability([layer], { horizon: day, ...options });

  it('names the member at fault', () => {
    refuses(run({ ...ok, colour: 'red' }), 'JY0014', '/layers/0/colour');
    refuses(run({ ...ok, id: '' }), 'JY0014', '/layers/0/id');
    refuses(run({ ...ok, priority: 10 }), 'JY0014', '/layers/0/priority');
    refuses(run({ ...ok, priority: 1.5 }), 'JY0014', '/layers/0/priority');
    refuses(run({ ...ok, mode: 'free' }), 'JY0014', '/layers/0/mode');
    refuses(run({ ...ok, mode: 'available', busyType: 'busy' }), 'JY0014', '/layers/0/busyType');
    refuses(run({ ...ok, busyType: 'tentative' }), 'JY0014', '/layers/0/busyType');
    refuses(run({ ...ok, revision: 3 }), 'JY0014', '/layers/0/revision');
    refuses(run({ id: 'a', priority: 1, mode: 'busy', spans: [] }), 'JY0014', '/layers/0/source');
    refuses(run({ ...ok, series: weeklyPattern({ days: { mon: true } }) }), 'JY0014', '/layers/0');
    refuses(run({ id: 'a', priority: 1, mode: 'busy', source: 's' }), 'JY0014', '/layers/0');
    refuses(run({ ...ok, spans: 'all' }), 'JY0014', '/layers/0/spans');
    refuses(run({ ...ok, bounds: [1, 2, 3] }), 'JY0014', '/layers/0/bounds');
    refuses(run({ ...ok, bounds: [5, 5] }), 'JY0014', '/layers/0/bounds/1');
    refuses(run(7), 'JY0014', '/layers/0');
    refuses(() => evaluateAvailability([ok, ok], { horizon: day }), 'JY0014', '/layers/1/id');
    refuses(() => evaluateAvailability(/** @type {any} */ ('x'), { horizon: day }), 'JY0014', '/layers');
  });

  it('names a span, bound or series at fault', () => {
    refuses(run({ ...ok, spans: [{ start: 10, end: 5 }] }), 'JY0013', '/layers/0/spans/0/end');
    refuses(run({ ...ok, spans: [{ start: 1.5 }] }), 'JY0013', '/layers/0/spans/0/start');
    refuses(run({ ...ok, spans: [{ start: 0, stop: 5 }] }), 'JY0014', '/layers/0/spans/0/stop');
    refuses(run({ ...ok, spans: [3] }), 'JY0013', '/layers/0/spans/0');
    refuses(run({ ...ok, spans: [floatingValue('2026-03-02', '09:00')] }), 'JY0013', '/layers/0/spans/0/kind');
    refuses(run({ ...ok, spans: [{ start: { kind: 'date', date: '2026-02-30' } }] }), 'JY0012', '/layers/0/spans/0/start/date');
    refuses(run({ ...ok, bounds: [dateRangeValue('2026-03-02', '2026-03-03')] }), 'JY0013', '/layers/0/bounds/0/kind');
    refuses(run({ ...ok, spans: undefined, series: [] }), 'JY0013', '/layers/0/series');
    refuses(run({ ...ok, spans: undefined, series: { kind: 'series' } }), 'JY0013', '/layers/0/series');
    const utc = defineSeries({ uid: 'u', base: compileRecurrence({ dtstart: utcValue('2026-03-01T08:00:00Z'), rrule: 'FREQ=DAILY' }) });
    refuses(run({ ...ok, spans: undefined, series: [utc, ...weeklyPattern({ days: { mon: true } })] }), 'JY0013', '/layers/0/series');
    // a malformed series is refused even when its bounds put it outside the horizon
    refuses(run({ ...ok, spans: undefined, series: [], bounds: [0, 1] }), 'JY0013', '/layers/0/series');
  });

  it('names an option at fault, and binding refusals keep their own code', () => {
    refuses(() => evaluateAvailability([], /** @type {any} */ (null)), 'JY0014', '/options');
    refuses(() => evaluateAvailability([], /** @type {any} */ ({ horizon: day, timezone: 'x' })), 'JY0014', '/options/timezone');
    refuses(() => evaluateAvailability([], { horizon: [day[1], day[0]] }), 'JY0014', '/options/horizon/1');
    refuses(() => evaluateAvailability([], { horizon: day, zone: '' }), 'JY0001', '/options/zone');
    refuses(() => evaluateAvailability([], /** @type {any} */ ({ horizon: day, provider: 'intl' })), 'JY0004', '/options/provider');
    refuses(() => evaluateAvailability([], /** @type {any} */ ({ horizon: day, provider: { identity: { name: '' } } })), 'JY0004', '/options/provider/identity');
    refuses(() => evaluateAvailability([], /** @type {any} */ ({ horizon: day, limits: { maxSpans: 1 } })), 'JY0014', '/options/limits/maxSpans');
    refuses(run({ ...ok, spans: [dateValue('2026-03-02')] }, { zone: 'Europe/Amsterdam', provider }), 'JY0006', '/layers/0/spans/0/policy');
  });

  it('a layer outside the horizon claims nothing and still reads its spans', () => {
    const result = evaluateAvailability([{ ...ok, bounds: [0, 1000], spans: [{ start: 0, end: 500 }] }], { horizon: day });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-03T00:00 unknown:default ']);
    assert.deepStrictEqual(result.layers, [{ id: 'a', source: 's', status: 'complete', counts: { emitted: 0, work: 0, providerCalls: 0 } }]);
    assert.deepStrictEqual(result.counts, { layers: 1, spans: 1, available: 0, busy: 0, unknown: 1, emitted: 0, work: 0, providerCalls: 0 });
  });
});

/**
 * Every minute a limited answer calls available is available in the
 * unlimited one, with the same layers; every busy minute is busy there.
 * @param {any} limited
 * @param {any} truth
 */
function onlyAddsUnknown(limited, truth) {
  const at = (/** @type {any} */ result, /** @type {number} */ t) => result.spans.find((/** @type {any} */ s) => s.start <= t && t < s.end);
  for (let t = limited.horizon.start; t < limited.horizon.end; t += 60000) {
    const got = at(limited, t);
    const want = at(truth, t);
    if (got.state === 'available')
      assert.deepStrictEqual([want.state, want.sources], ['available', got.sources], `available at ${new Date(t).toISOString()}`);
    else if (got.state === 'busy')
      assert.strictEqual(want.state, 'busy', `busy at ${new Date(t).toISOString()}`);
  }
}

describe('zoned, date and full series layers', () => {
  const spring = /** @type {[any, any]} */ ([Z('2026-03-27T00:00:00Z'), Z('2026-04-01T00:00:00Z')]);
  const DAYS = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU';

  it('a zoned weekly layer equals the floating one bound to Amsterdam across the spring change', () => {
    const zoned = defineSeries({ uid: 'z', base: compileRecurrence({ dtstart: zonedValue('2026-03-23', '09:00', 'Europe/Amsterdam'), duration: 'PT8H', rrule: DAYS }) });
    const floating = defineSeries({ uid: 'f', base: compileRecurrence({ dtstart: floatingValue('2026-03-23', '09:00'), duration: 'PT8H', rrule: DAYS }) });
    const one = evaluateAvailability([{ id: 'h', priority: 1, mode: 'available', series: zoned, source: 's' }], { horizon: spring, provider });
    const two = evaluateAvailability([{ id: 'h', priority: 1, mode: 'available', series: floating, source: 's' }], { horizon: spring, ...AMS });
    assert.deepStrictEqual(one.spans, two.spans);
    assert.strictEqual(one.spans.filter((x) => x.state === 'available').length, 5);
    assert.ok(one.counts.providerCalls > 0);
    assert.deepStrictEqual(one.provider, { name: 'intl', revision: 'test-tzdata' });
  });

  it('a date series is whole civil days; zoned values bound spans and layers (bounded: the rest of the period is busy)', () => {
    const days = defineSeries({ uid: 'd', base: compileRecurrence({ dtstart: dateValue('2026-03-23'), rrule: 'FREQ=WEEKLY;BYDAY=SU' }) });
    const result = evaluateAvailability([
      { id: 'sundays', priority: 1, mode: 'busy', series: days, source: 's' },
      { id: 'open', priority: 2, mode: 'available', source: 's', bounds: [zonedValue('2026-03-27', '12:00', 'Europe/Amsterdam')],
        spans: [{ start: zonedValue('2026-03-27', '06:00', 'Europe/Amsterdam'), end: zonedValue('2026-03-31', '06:00', 'Europe/Amsterdam') }] },
    ], { horizon: spring, ...AMS });
    assert.deepStrictEqual(brief(result), ['03-27T00:00 03-27T11:00 unknown:default ', '03-27T11:00 03-28T23:00 available open',
      '03-28T23:00 03-29T22:00 busy:busy sundays', '03-29T22:00 03-31T04:00 available open', '03-31T04:00 04-01T00:00 busy:busy-unavailable open']);
  });

  it('a series with a far RDATE, EXDATEs and a moved override under tiny limits only adds unknown time', () => {
    const base = compileRecurrence({ dtstart: floatingValue('2026-03-23', '09:00'), duration: 'PT2H', rrule: DAYS });
    const series = defineSeries({ uid: 's', base,
      rdates: [floatingValue('2026-03-31', '20:00'), floatingValue('2026-03-27', '05:00')],
      exdates: [floatingValue('2026-03-27', '09:00'), floatingValue('2026-03-29', '09:00')],
      overrides: [{ recurrenceId: '2026-03-28T09:00:00', status: 'moved', start: floatingValue('2026-03-31', '13:00') }] });
    for (const mode of /** @type {const} */ (['available', 'busy'])) {
      const layers = [{ id: 'rule', priority: 1, mode, series, source: 's' }, span('base', 3, mode === 'busy' ? 'available' : 'busy', '2026-03-26T00:00:00Z', '2026-04-02T00:00:00Z')];
      const truth = evaluateAvailability(layers, { horizon: spring, ...AMS });
      assert.strictEqual(truth.complete, true);
      for (let max = 0; max <= 8; max++) {
        const limited = evaluateAvailability(layers, { horizon: spring, ...AMS, limits: { maxOccurrences: max } });
        onlyAddsUnknown(limited, truth);
      }
      for (const maxWork of [1, 3, 6, 10, 20])
        onlyAddsUnknown(evaluateAvailability(layers, { horizon: spring, ...AMS, limits: { maxWork } }), truth);
    }
  });

  it('a zoned series under tiny provider budgets only adds unknown time, and names the limit', () => {
    const zoned = defineSeries({ uid: 'z', base: compileRecurrence({ dtstart: zonedValue('2026-03-23', '01:30', 'Europe/Amsterdam'), duration: 'PT3H', rrule: DAYS }),
      exdates: [zonedValue('2026-03-30', '01:30', 'Europe/Amsterdam')] });
    const layers = [{ id: 'z', priority: 1, mode: /** @type {const} */ ('available'), series: zoned, source: 's' }];
    const truth = evaluateAvailability(layers, { horizon: spring, provider });
    const limits = new Set();
    for (const maxProviderCalls of [0, 1, 2, 4, 8, 16, 32]) {
      const limited = evaluateAvailability(layers, { horizon: spring, provider, limits: { maxProviderCalls } });
      if (!limited.complete)
        limits.add(limited.layers[0].limit);
      onlyAddsUnknown(limited, truth);
    }
    assert.ok(limits.has('maxProviderCalls'));
  });

  it('when one rank leaves time unknown for two reasons, no-zone is named', () => {
    const result = evaluateAvailability([
      { id: 'floating', priority: 2, mode: 'available', source: 's', spans: [{ start: floatingValue('2026-03-02', '09:00'), end: floatingValue('2026-03-02', '10:00') }] },
      { id: 'utc', priority: 2, mode: 'available', source: 's',
        series: defineSeries({ uid: 'u', base: compileRecurrence({ dtstart: utcValue('2026-03-01T00:00:00Z'), duration: 'PT1H', rrule: 'FREQ=DAILY' }) }) },
    ], { horizon: day, limits: { maxWork: 1 } });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-03T00:00 unknown:no-zone floating,utc']);
  });

  it('a series occurrence refused while binding names the layer', () => {
    const gap = weeklyPattern({ days: { sun: [['02:30', '03:30']] } });
    refuses(() => evaluateAvailability([{ id: 'g', priority: 1, mode: 'busy', series: gap, source: 's' }],
      { horizon: [Z('2026-03-28T00:00:00Z'), Z('2026-03-30T00:00:00Z')], ...AMS, policy: 'reject' }), 'JY0002', '/layers/0/series/parts');
    refuses(() => evaluateAvailability([{ id: 'g', priority: 1, mode: 'busy', series: gap, source: 's' }],
      { horizon: [Z('2026-03-28T00:00:00Z'), Z('2026-03-30T00:00:00Z')], zone: 'Europe/Amsterdam', provider }), 'JY0006', '/layers/0/series/policy');
  });
});

describe('the readers hold a cached answer to the evaluation\'s own forms', () => {
  it('a busy type outside the three, or on a span that is not busy, is refused rather than shown', () => {
    const cached = { horizon: { start: 0, end: 10000 }, spans: [{ start: 0, end: 10000, state: 'busy', busyType: 'free', sources: [] }] };
    refuses(() => freeBusy(/** @type {any} */ (cached)), 'JY0014', '/result/spans/0/busyType');
    refuses(() => freeBusy(/** @type {any} */ ({ ...cached, spans: [{ ...cached.spans[0], busyType: 'whatever' }] })), 'JY0014', '/result/spans/0/busyType');
    refuses(() => freeBusy(/** @type {any} */ ({ ...cached, spans: [{ ...cached.spans[0], busyType: undefined }] })), 'JY0014', '/result/spans/0/busyType');
    refuses(() => freeBusy(/** @type {any} */ ({ ...cached, spans: [{ ...cached.spans[0], state: 'unknown', reason: 'default' }] })), 'JY0014', '/result/spans/0/busyType');
    assert.deepStrictEqual(freeBusy(/** @type {any} */ ({ ...cached, spans: [{ ...cached.spans[0], busyType: 'busy-tentative' }] })).periods,
      [{ start: 0, end: 10000, fbtype: 'busy-tentative' }]);
  });

  it('a raised slot limit returns every slot of one wide window', () => {
    const wide = evaluateAvailability([{ id: 'a', priority: 1, mode: 'available', spans: [{ start: 0, end: 300000 }], source: 's' }], { horizon: [0, 300000] });
    const found = findAvailableSlots(wide, { duration: 1, limits: { maxSlots: 300000 } });
    assert.deepStrictEqual([found.status, found.slots.length, found.slots.at(-1)], ['complete', 300000, { start: 299999, end: 300000 }]);
  });
});

describe('bounds: a bounded available layer claims its whole period, as RFC 7953 does', () => {
  const contract = (/** @type {any} */ extra = {}) => ({ id: 'contract', priority: 5, mode: 'available', source: 'hr', revision: 'c1',
    series: weeklyPattern({ days: { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']] } }),
    bounds: [dateValue('2026-03-02'), dateValue('2026-03-05')], ...extra });

  it('inside its bounds the time outside its spans is busy-unavailable, typed and sourced; outside them the default', () => {
    const result = evaluateAvailability([contract()], { horizon: week, ...AMS });
    assert.deepStrictEqual(brief(result), [
      '03-02T00:00 03-02T08:00 busy:busy-unavailable contract', '03-02T08:00 03-02T16:00 available contract',
      '03-02T16:00 03-03T08:00 busy:busy-unavailable contract', '03-03T08:00 03-03T16:00 available contract',
      '03-03T16:00 03-04T08:00 busy:busy-unavailable contract', '03-04T08:00 03-04T16:00 available contract',
      '03-04T16:00 03-04T23:00 busy:busy-unavailable contract', '03-04T23:00 03-09T00:00 unknown:default ']);
    assert.deepStrictEqual(result.spans[0].sources, [{ id: 'contract', revision: 'c1' }]);
    // the stated "not at other times" beats a lower layer's availability, and loses to a higher one's
    const lower = evaluateAvailability([contract(), span('extra', 7, 'available', '2026-03-02T00:00:00Z', '2026-03-09T00:00:00Z')], { horizon: week, ...AMS });
    assert.strictEqual(availabilityOf(lower, { start: Z('2026-03-02T17:00:00Z'), end: Z('2026-03-02T18:00:00Z') }).state, 'busy');
    assert.strictEqual(availabilityOf(lower, { start: Z('2026-03-06T17:00:00Z'), end: Z('2026-03-06T18:00:00Z') }).state, 'available');
    const higher = evaluateAvailability([contract(), span('overtime', 2, 'available', '2026-03-02T16:00:00Z', '2026-03-02T19:00:00Z')], { horizon: week, ...AMS });
    assert.deepStrictEqual(availabilityOf(higher, { start: Z('2026-03-02T08:00:00Z'), end: Z('2026-03-02T19:00:00Z') }).sources, [{ id: 'contract', revision: 'c1' }, { id: 'overtime' }]);
    assert.deepStrictEqual(freeBusy(result).periods.slice(0, 2).map((x) => x.fbtype), ['busy-unavailable', 'free']);
  });

  it('both ends open still claims the whole horizon', () => {
    const result = evaluateAvailability([span('desk', 5, 'available', '2026-03-02T09:00:00Z', '2026-03-02T17:00:00Z', { bounds: [] })], { horizon: day });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-02T09:00 busy:busy-unavailable desk', '03-02T09:00 03-02T17:00 available desk',
      '03-02T17:00 03-03T00:00 busy:busy-unavailable desk']);
  });

  it('a bounded busy layer claims only its spans: its gaps fall through', () => {
    const result = evaluateAvailability([
      span('meetings', 1, 'busy', '2026-03-02T10:00:00Z', '2026-03-02T11:00:00Z', { bounds: [Z('2026-03-02T00:00:00Z'), Z('2026-03-03T00:00:00Z')] }),
      span('open', 5, 'available', '2026-03-02T08:00:00Z', '2026-03-02T16:00:00Z'),
    ], { horizon: day });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-02T08:00 unknown:default ', '03-02T08:00 03-02T10:00 available open',
      '03-02T10:00 03-02T11:00 busy:busy meetings', '03-02T11:00 03-02T16:00 available open', '03-02T16:00 03-03T00:00 unknown:default ']);
  });

  it('without bounds both modes claim only their spans, and the gaps fall through', () => {
    const result = evaluateAvailability([
      span('hours', 2, 'available', '2026-03-02T08:00:00Z', '2026-03-02T12:00:00Z'),
      span('closure', 5, 'busy', '2026-03-02T00:00:00Z', '2026-03-02T10:00:00Z'),
    ], { horizon: day });
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-02T08:00 busy:busy closure', '03-02T08:00 03-02T12:00 available hours',
      '03-02T12:00 03-03T00:00 unknown:default ']);
  });

  it('nested bounds of different ranks: the inner period decides inside itself, the outer elsewhere', () => {
    const result = evaluateAvailability([
      contract(),
      { id: 'swap', priority: 2, mode: 'available', source: 'manager', bounds: [Z('2026-03-03T00:00:00Z'), Z('2026-03-04T00:00:00Z')],
        spans: [{ start: Z('2026-03-03T12:00:00Z'), end: Z('2026-03-03T20:00:00Z') }] },
      { id: 'cover', priority: 9, mode: 'available', source: 'pool', bounds: [], spans: [{ start: Z('2026-03-02T00:00:00Z'), end: Z('2026-03-09T00:00:00Z') }] },
    ], { horizon: week, ...AMS });
    assert.deepStrictEqual(brief(result).slice(2, 7), [
      '03-02T16:00 03-03T00:00 busy:busy-unavailable contract', '03-03T00:00 03-03T12:00 busy:busy-unavailable swap',
      '03-03T12:00 03-03T20:00 available swap', '03-03T20:00 03-04T00:00 busy:busy-unavailable swap',
      '03-04T00:00 03-04T08:00 busy:busy-unavailable contract']);
    assert.deepStrictEqual(brief(result).at(-1), '03-04T23:00 03-09T00:00 available cover');
  });

  it('without a zone, a bounded available layer is unknown wherever a date bound may fall, and busy inside', () => {
    const result = evaluateAvailability([span('open', 5, 'available', '2026-03-03T09:00:00Z', '2026-03-03T17:00:00Z',
      { bounds: [dateValue('2026-03-03'), dateValue('2026-03-05')] })], { horizon: week });
    // a two-day period whose dates may fall a day either way is sure nowhere
    assert.deepStrictEqual(brief(result), ['03-02T00:00 03-06T00:00 unknown:no-zone open', '03-06T00:00 03-09T00:00 unknown:default ']);
    const wide = evaluateAvailability([span('open', 5, 'available', '2026-03-03T09:00:00Z', '2026-03-03T17:00:00Z',
      { bounds: [dateValue('2026-03-02'), dateValue('2026-03-07')] })], { horizon: week });
    assert.deepStrictEqual(brief(wide), ['03-02T00:00 03-03T00:00 unknown:no-zone open', '03-03T00:00 03-03T09:00 busy:busy-unavailable open',
      '03-03T09:00 03-03T17:00 available open', '03-03T17:00 03-06T00:00 busy:busy-unavailable open', '03-06T00:00 03-08T00:00 unknown:no-zone open',
      '03-08T00:00 03-09T00:00 unknown:default ']);
  });
});
