//@ts-check
/**
 * Every bounded answer of `@jarenjs/core/calendar` carries the shape the
 * assignment engine's does: `complete`, and when it is false, `stoppedAt`
 * naming the limit. `status` and `limit` stay beside them, the older
 * spelling of the same two facts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  compileRecurrence, expandRecurrence, nextOccurrences, defineSeries, expandSeries,
  evaluateAvailability, findAvailableSlots, utcValue, compileVtimezone,
} from '@jarenjs/core/calendar';
import { registerRules, scoreAssignment } from '@jarenjs/core/assign';
import { REFERENCE_RULES } from '../assign/rules/reference.js';
import { rosterProblem } from '../assign/fixtures.js';

const daily = compileRecurrence({ dtstart: utcValue('2026-03-02T09:00:00Z'), duration: 'PT1H', rrule: 'FREQ=DAILY' });
const series = defineSeries({ uid: 'd', base: daily });
const horizon = [utcValue('2026-03-02T00:00:00Z'), utcValue('2026-03-09T00:00:00Z')];

/**
 * The one shape, and its agreement with the older spelling.
 * @param {any} answer
 * @param {string | undefined} limit
 * @param {Record<string, unknown>} [more] - the members `stoppedAt` carries beyond `limit`
 */
function bounded(answer, limit, more = {}) {
  assert.strictEqual(answer.complete, limit === undefined);
  assert.strictEqual(answer.status, limit === undefined ? 'complete' : 'incomplete');
  if (limit === undefined) {
    assert.strictEqual('stoppedAt' in answer, false);
    assert.strictEqual('limit' in answer, false);
    return;
  }
  assert.deepStrictEqual(answer.stoppedAt, { limit, ...more });
  assert.strictEqual(answer.limit, limit);
  assert.ok(Object.isFrozen(answer.stoppedAt));
}

describe('a bounded calendar answer: complete, and stoppedAt when it is not', () => {
  it('expandRecurrence and nextOccurrences', () => {
    bounded(expandRecurrence(daily, { horizon }), undefined);
    bounded(expandRecurrence(daily, { horizon, limits: { maxOccurrences: 3 } }), 'maxOccurrences');
    bounded(expandRecurrence(daily, { horizon, limits: { maxWork: 2 } }), 'maxWork');
    bounded(nextOccurrences(daily, utcValue('2026-03-02T00:00:00Z'), 2), undefined);
    bounded(nextOccurrences(daily, utcValue('2026-03-02T00:00:00Z'), 5, { limits: { maxWork: 2 } }), 'maxWork');
  });

  it('expandSeries', () => {
    const series = defineSeries({ uid: 's', base: daily });
    bounded(expandSeries(series, { horizon }), undefined);
    bounded(expandSeries(series, { horizon, limits: { maxOccurrences: 2 } }), 'maxOccurrences');
  });

  it('evaluateAvailability, for the evaluation and for each layer', () => {
    const layers = [
      { id: 'open', priority: 5, mode: /** @type {const} */ ('available'), series, source: 'contract' },
      { id: 'leave', priority: 1, mode: /** @type {const} */ ('busy'), series, source: 'hr' },
    ];
    const whole = /** @type {any} */ (evaluateAvailability(layers, { horizon }));
    // the evaluation had `complete` already and never a `status`
    assert.deepStrictEqual([whole.complete, 'stoppedAt' in whole, 'status' in whole], [true, false, false]);
    for (const layer of whole.layers) bounded(layer, undefined);
    const cut = /** @type {any} */ (evaluateAvailability(layers, { horizon, limits: { maxOccurrences: 3 } }));
    // the evaluation names the first layer, in the order given, that a limit stopped
    assert.strictEqual(cut.complete, false);
    assert.deepStrictEqual(cut.stoppedAt, { limit: 'maxOccurrences', layer: 'open' });
    assert.strictEqual('status' in cut, false);
    for (const layer of cut.layers) bounded(layer, 'maxOccurrences');
  });

  it('findAvailableSlots', () => {
    const result = evaluateAvailability([{ id: 'open', priority: 5, mode: 'available', series, source: 'c' }], { horizon });
    bounded(findAvailableSlots(result, { duration: 'PT15M' }), undefined);
    bounded(findAvailableSlots(result, { duration: 'PT15M', limits: { maxSlots: 2 } }), 'maxSlots');
  });

  it('compileVtimezone', () => {
    const definition = { tzid: 'Daily', observances: [{ type: /** @type {const} */ ('standard'), start: '2000-01-01T00:00:00',
      offsetFrom: '+00:00', offsetTo: '+00:00', rrule: 'FREQ=DAILY' }] };
    const span = [Date.UTC(2000, 0, 1), Date.UTC(2000, 1, 1)];
    bounded(compileVtimezone(definition, { horizon: span }), undefined);
    bounded(compileVtimezone(definition, { horizon: span, limits: { maxTransitions: 5 } }), 'maxTransitions');
  });

  it('is the assignment engine\'s shape: complete, and stoppedAt with the limit that stopped it', () => {
    const stopped = /** @type {any} */ (scoreAssignment(rosterProblem(), registerRules(REFERENCE_RULES), [], { limits: { maxUnits: 1 } }));
    assert.strictEqual(stopped.complete, false);
    assert.strictEqual(stopped.stoppedAt.limit, 'maxUnits');
    const calendar = /** @type {any} */ (expandRecurrence(daily, { horizon, limits: { maxOccurrences: 1 } }));
    assert.deepStrictEqual(Object.keys(stopped.stoppedAt).filter((key) => key in calendar.stoppedAt), ['limit']);
  });
});
