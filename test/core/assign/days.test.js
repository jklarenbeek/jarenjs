//@ts-check
/**
 * The `resource-day` scope, case by case with the fixture provider: the
 * day a shift lands in across a 23-hour, a 25-hour and a skipped day, a
 * shift ending exactly at local midnight, two zones never merged, a task
 * without a zone (unknown, never guessed), the policy at a change that
 * carries the clock back across midnight, provenance, limits and every
 * refusal of the seam.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { admitProblem, registerRules, scoreAssignment, explain, AssignError } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { DAY_RULES, dayCap, dayMin, dailyRest } from './rules/days.js';
import { REFERENCE_RULES } from './rules/reference.js';
import { fixtureProvider } from './days-provider.js';
import { rosterProblem } from './fixtures.js';

const HOUR = 3600000;
const AMS = 'Europe/Amsterdam';
const NYC = 'America/New_York';
const APIA = 'Pacific/Apia';
const at = (/** @type {string} */ iso) => Date.parse(iso);
const days = civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' });

/** A rule that reports every day it is given, with the day itself as params. */
const probe = /** @type {any} */ ({
  id: 'probe', version: 1, level: 'soft', scope: 'resource-day',
  evaluate(/** @type {any} */ view, /** @type {any} */ unit) {
    const day = view.day(unit.id, unit.zone, unit.date);
    return { matches: [{ magnitude: 1, messageId: 'day', params: { day: JSON.parse(JSON.stringify(day)) } }] };
  },
});
const probeSet = registerRules([probe]);

/**
 * @param {{ id: string, start: string, end: string, zone?: string }[]} tasks
 * @param {string[]} [resources]
 */
function problemOf(tasks, resources = ['ana', 'bo']) {
  return admitProblem({
    revision: 1,
    resources: resources.map((id) => ({ id, revision: 1 })),
    tasks: tasks.map(({ id, start, end, zone }) => ({ id, revision: 1, interval: { start: at(start), end: at(end) }, demands: [{ slot: 's', count: 1 }], ...(zone ? { zone } : {}) })),
    attributes: { dayCap: 8 * HOUR, minDay: 3 * HOUR, maxRun: 1, minRest: 11 * HOUR },
  });
}

/** @param {string} task @param {string} resource */
const on = (task, resource = 'ana') => ({ task, slot: 's', resource });

/** @param {any} result */
function daysOfResult(result) {
  return result.matches.map((/** @type {any} */ m) => ({ unit: `${m.unit.id} ${m.unit.zone} ${m.unit.date}`, hours: (m.params.day.end - m.params.day.start) / HOUR,
    pieces: m.params.day.pieces.map((/** @type {any} */ p) => `${p.task} ${(p.end - p.start) / HOUR}h`) }));
}

/** @param {() => unknown} run */
function refusal(run) {
  try {
    run();
  }
  catch (error) {
    assert.ok(error instanceof AssignError, String(error));
    return { code: error.code, docPath: error.docPath };
  }
  assert.fail('no refusal');
}

describe('civil days across changes of the clock', () => {
  it('a night shift into the 23-hour day: 2 hours on the 28th, 7 on the 29th (02:00 to 03:00 never happened)', () => {
    const problem = problemOf([{ id: 'night', start: '2026-03-28T21:00:00Z', end: '2026-03-29T06:00:00Z', zone: AMS }]);
    const result = scoreAssignment(problem, probeSet, [on('night')], { days });
    assert.deepStrictEqual(daysOfResult(result), [
      { unit: `ana ${AMS} 2026-03-28`, hours: 24, pieces: ['night 2h'] },
      { unit: `ana ${AMS} 2026-03-29`, hours: 23, pieces: ['night 7h'] },
    ]);
  });

  it('a night shift into the 25-hour day: 2 hours on the 24th, 9 on the 25th', () => {
    const problem = problemOf([{ id: 'night', start: '2026-10-24T20:00:00Z', end: '2026-10-25T07:00:00Z', zone: AMS }]);
    const result = scoreAssignment(problem, probeSet, [on('night')], { days });
    assert.deepStrictEqual(daysOfResult(result), [
      { unit: `ana ${AMS} 2026-10-24`, hours: 24, pieces: ['night 2h'] },
      { unit: `ana ${AMS} 2026-10-25`, hours: 25, pieces: ['night 9h'] },
    ]);
    // eight hours cap: the 25th is one hour over, the 24th is not
    const capped = /** @type {any} */ (scoreAssignment(problem, registerRules([dayCap]), [on('night')], { days }));
    assert.deepStrictEqual(capped.matches.map((/** @type {any} */ m) => [m.unit.date, m.magnitude]), [['2026-10-25', HOUR]]);
  });

  it('a shift ending exactly at local midnight has no piece of the next day; one starting at it has none of the day before', () => {
    const problem = problemOf([
      { id: 'late', start: '2026-10-25T15:00:00Z', end: '2026-10-25T23:00:00Z', zone: AMS },
      { id: 'early', start: '2026-10-26T23:00:00Z', end: '2026-10-27T03:00:00Z', zone: AMS },
    ]);
    const result = scoreAssignment(problem, probeSet, [on('late'), on('early')], { days });
    assert.deepStrictEqual(daysOfResult(result), [
      { unit: `ana ${AMS} 2026-10-25`, hours: 25, pieces: ['late 8h'] },
      { unit: `ana ${AMS} 2026-10-27`, hours: 24, pieces: ['early 4h'] },
    ]);
  });

  it('a skipped day has no piece: Pacific/Apia went from the 29th to the 31st of December 2011', () => {
    const problem = problemOf([{ id: 'over', start: '2011-12-30T06:00:00Z', end: '2011-12-30T14:00:00Z', zone: APIA }]);
    const result = scoreAssignment(problem, probeSet, [on('over')], { days });
    assert.deepStrictEqual(daysOfResult(result), [
      { unit: `ana ${APIA} 2011-12-29`, hours: 24, pieces: ['over 4h'] },
      { unit: `ana ${APIA} 2011-12-31`, hours: 24, pieces: ['over 4h'] },
    ]);
  });

  it('a 25-hour day has an hour more to rest in, a 23-hour day an hour less', () => {
    // a shift from local 08:00 to 16:00; eleven hours of rest asked for
    const shift = (/** @type {string} */ start, /** @type {string} */ end) => problemOf([{ id: 'mid', start, end, zone: AMS }]);
    const rest = registerRules([dailyRest]);
    const short = (/** @type {any} */ problem) => {
      const result = /** @type {any} */ (scoreAssignment(problem, rest, [on('mid')], { days }));
      return result.matches.map((/** @type {any} */ m) => [m.magnitude / HOUR, (m.intervals[0].end - m.intervals[0].start) / HOUR]);
    };
    // 7 hours before, 8 after on the 23-hour day; 9 before, 8 after on the 25-hour day; 8 and 8 on a plain one
    assert.deepStrictEqual(short(shift('2026-03-29T06:00:00Z', '2026-03-29T14:00:00Z')), [[3, 23]]);
    assert.deepStrictEqual(short(shift('2026-10-25T07:00:00Z', '2026-10-25T15:00:00Z')), [[2, 25]]);
    assert.deepStrictEqual(short(shift('2026-06-10T06:00:00Z', '2026-06-10T14:00:00Z')), [[3, 24]]);
  });

  it('a day\'s pieces are in time order, even where clipping reorders the tasks', () => {
    // 'long' starts first and ends last; both are clipped to the 11th's first instant
    const problem = problemOf([
      { id: 'long', start: '2026-06-10T20:00:00Z', end: '2026-06-11T08:00:00Z', zone: AMS },
      { id: 'short', start: '2026-06-10T21:00:00Z', end: '2026-06-11T01:00:00Z', zone: AMS },
    ]);
    const result = scoreAssignment(problem, probeSet, [on('long'), on('short')], { days });
    assert.deepStrictEqual(daysOfResult(result).map((day) => day.pieces), [['long 2h', 'short 1h'], ['short 3h', 'long 10h']]);
  });

  it('two zones on one date are two days, never merged', () => {
    const problem = problemOf([
      { id: 'ams', start: '2026-06-10T06:00:00Z', end: '2026-06-10T10:00:00Z', zone: AMS },
      { id: 'nyc', start: '2026-06-10T14:00:00Z', end: '2026-06-10T18:00:00Z', zone: NYC },
      { id: 'nyc2', start: '2026-06-11T14:00:00Z', end: '2026-06-11T18:00:00Z', zone: NYC },
    ]);
    const result = scoreAssignment(problem, probeSet, [on('nyc'), on('ams')], { days });
    assert.deepStrictEqual(daysOfResult(result).map((day) => day.unit), [`ana ${NYC} 2026-06-10`, `ana ${AMS} 2026-06-10`]);
    // by zone, then date: New York's 11th comes before Amsterdam's 10th
    const two = scoreAssignment(problem, probeSet, [on('ams'), on('nyc2')], { days });
    assert.deepStrictEqual(daysOfResult(two).map((day) => day.unit), [`ana ${NYC} 2026-06-11`, `ana ${AMS} 2026-06-10`]);
    const capped = /** @type {any} */ (scoreAssignment(problem, registerRules([{ ...dayCap, id: 'cap' }]), [on('nyc'), on('ams')], { days }));
    assert.strictEqual(capped.matches.length, 0, '4 hours in each zone, not 8 on one day');
  });
});

describe('a task without a zone', () => {
  const problem = problemOf([
    { id: 'zoned', start: '2026-06-10T06:00:00Z', end: '2026-06-10T07:00:00Z', zone: AMS },
    { id: 'bare', start: '2026-06-10T08:00:00Z', end: '2026-06-10T12:00:00Z' },
    { id: 'other', start: '2026-06-10T06:00:00Z', end: '2026-06-10T07:00:00Z', zone: AMS },
  ]);

  it('is unknown no-zone for each day rule, never UTC, and the resource\'s other days are not judged', () => {
    const result = /** @type {any} */ (scoreAssignment(problem, registerRules([dayMin]), [on('zoned'), on('bare')], { days }));
    // judged on its zoned hour alone, the floor rule would report two hours short: a false violation
    assert.deepStrictEqual(result.matches, []);
    assert.deepStrictEqual(result.unknowns.map((/** @type {any} */ u) => ({ ...u })), [{
      fact: null, level: 'hard', reason: 'no-zone', rule: 'day-min', subjects: { resources: ['ana'], tasks: ['bare'] },
      unit: { date: null, id: 'ana', scope: 'resource-day', zone: null }, version: 1,
    }]);
    assert.strictEqual(result.verdict, 'unknown');
    assert.strictEqual(result.counts.units, 0);
  });

  it('leaves other resources judged, and reports once per task and rule', () => {
    const result = /** @type {any} */ (scoreAssignment(problem, registerRules([dayMin, dayCap]), [on('zoned'), on('bare'), on('other', 'bo')], { days }));
    assert.deepStrictEqual(result.matches.map((/** @type {any} */ m) => `${m.rule} ${m.unit.id} ${m.magnitude / HOUR}`), ['day-min bo 2']);
    assert.deepStrictEqual(result.unknowns.map((/** @type {any} */ u) => `${u.rule} ${u.subjects.tasks}`), ['day-cap bare', 'day-min bare']);
    assert.strictEqual(result.verdict, 'infeasible-by-validation');
  });

  it('a read of another resource\'s untellable days makes the unit unknown, whatever the rule answers or catches', () => {
    for (const catching of [false, true]) {
      const peek = /** @type {any} */ ({
        id: 'peek', version: 1, level: 'service', scope: 'resource-day',
        evaluate(/** @type {any} */ view) {
          try {
            view.daysOf('ana');
          }
          catch (error) {
            if (!catching) throw error;
          }
          return { matches: [{ magnitude: 1, messageId: 'never' }] };
        },
      });
      const result = /** @type {any} */ (scoreAssignment(problem, registerRules([peek]), [on('zoned'), on('bare'), on('other', 'bo')], { days }));
      assert.deepStrictEqual(result.matches, []);
      assert.deepStrictEqual(result.unknowns.map((/** @type {any} */ u) => `${u.reason} ${u.unit.id} ${u.unit.date} ${u.subjects.resources} ${u.subjects.tasks}`),
        ['no-zone ana null ana bare', 'no-zone bo 2026-06-10 ana bare']);
      assert.strictEqual(result.verdict, 'feasible', 'a service unknown does not block');
    }
  });

  it('stops at maxWork while reporting no-zone, on its own resource and on a read of it', () => {
    const many = problemOf([1, 2, 3, 4].map((h) => ({ id: `bare${h}`, start: `2026-06-10T0${h}:00:00Z`, end: `2026-06-10T0${h}:30:00Z` })));
    const own = /** @type {any} */ (scoreAssignment(many, registerRules([dayMin]), [1, 2, 3, 4].map((h) => on(`bare${h}`)), { days, limits: { maxWork: 3 } }));
    assert.deepStrictEqual([own.complete, own.stoppedAt], [false, { limit: 'maxWork', rule: 'day-min', unit: { date: null, id: 'ana', scope: 'resource-day', zone: null } }]);
    assert.strictEqual(/** @type {any} */ (scoreAssignment(many, registerRules([dayMin]), [1, 2, 3, 4].map((h) => on(`bare${h}`)), { days, limits: { maxWork: 4 } })).complete, true);
    const peek = /** @type {any} */ ({ id: 'peek', version: 1, level: 'soft', scope: 'resource-day', evaluate: (/** @type {any} */ view) => (view.daysOf('ana'), {}) });
    const mixed = problemOf([{ id: 'z', start: '2026-06-10T06:00:00Z', end: '2026-06-10T07:00:00Z', zone: AMS }, { id: 'b1', start: '2026-06-10T08:00:00Z', end: '2026-06-10T09:00:00Z' }, { id: 'b2', start: '2026-06-10T10:00:00Z', end: '2026-06-10T11:00:00Z' }]);
    const list = [on('b1'), on('b2'), on('z', 'bo')];
    // the table costs 3 (one split, one piece, one span), ana's two unknowns 2, bo's two unknowns 2 (the refused read charges nothing)
    assert.strictEqual(/** @type {any} */ (scoreAssignment(mixed, registerRules([peek]), list, { days })).counts.work, 7);
    const read = /** @type {any} */ (scoreAssignment(mixed, registerRules([peek]), list, { days, limits: { maxWork: 6 } }));
    assert.deepStrictEqual(read.stoppedAt, { limit: 'maxWork', rule: 'peek', unit: { date: '2026-06-10', id: 'bo', scope: 'resource-day', zone: AMS } });
  });

  it('is not read at all when no day rule is scored', () => {
    const plain = scoreAssignment(problem, registerRules(REFERENCE_RULES.filter((rule) => rule.id === 'no-overlap')), [on('zoned'), on('bare')]);
    assert.strictEqual(plain.verdict, 'feasible');
  });
});

describe('the policy decides only where the clock goes back across midnight', () => {
  // a synthetic zone: UTC+1 until 2030-01-01T23:30Z (local 00:30 on the 2nd), then UTC: the clock returns to 23:30 on the 1st
  const crossing = { 'Test/Crossing': { initial: 60, changes: [{ at: at('2030-01-01T23:30:00Z'), before: 60, after: 0 }] } };
  const problem = problemOf([{ id: 'n', start: '2030-01-01T22:00:00Z', end: '2030-01-02T02:00:00Z', zone: 'Test/Crossing' }]);

  it('rfc5545 starts the 2nd at the first midnight, later at the second; reject refuses', () => {
    const split = (/** @type {any} */ policy) => daysOfResult(scoreAssignment(problem, probeSet, [on('n')], { days: civilDays({ zoneProvider: fixtureProvider(crossing), policy }) }));
    assert.deepStrictEqual(split('rfc5545').map((day) => [day.pieces[0], day.hours]), [['n 1h', 24], ['n 3h', 25]]);
    assert.deepStrictEqual(split('later').map((day) => [day.pieces[0], day.hours]), [['n 2h', 25], ['n 2h', 24]]);
    const refused = refusal(() => scoreAssignment(problem, probeSet, [on('n')], { days: civilDays({ zoneProvider: fixtureProvider(crossing), policy: 'reject' }) }));
    assert.deepStrictEqual(refused, { code: 'JN0022', docPath: '/tasks/0/zone' });
  });
});

describe('provenance', () => {
  it('records the policy and the provider identity when days are given, and nothing new when they are not', () => {
    const problem = problemOf([{ id: 'd', start: '2026-06-10T06:00:00Z', end: '2026-06-10T10:00:00Z', zone: AMS }]);
    const result = /** @type {any} */ (scoreAssignment(problem, probeSet, [on('d')], { days }));
    assert.deepStrictEqual(result.provenance.days, { policy: 'rfc5545', provider: { name: 'fixture', revision: 'tzdb-2026e-2000-2040' } });
    assert.deepStrictEqual(Object.keys(result.provenance), ['algorithm', 'assignments', 'baseline', 'days', 'facts', 'problem', 'ruleSet', 'rules']);
    const unrecorded = civilDays({ zoneProvider: { ...fixtureProvider(), identity: undefined }, policy: 'later' });
    assert.deepStrictEqual(/** @type {any} */ (scoreAssignment(problem, probeSet, [on('d')], { days: unrecorded })).provenance.days,
      { policy: 'later', provider: { name: 'unrecorded', revision: 'unrecorded' } });
    const roster = rosterProblem();
    const rules = registerRules(REFERENCE_RULES);
    const without = /** @type {any} */ (scoreAssignment(roster, rules, []));
    const withDays = /** @type {any} */ (scoreAssignment(roster, rules, [], { days }));
    assert.strictEqual('days' in without.provenance, false);
    const { days: _, ...rest } = withDays.provenance;
    assert.strictEqual(JSON.stringify({ ...withDays, provenance: rest }), JSON.stringify(without));
  });

  it('records only the identity\'s name and revision, in one key order', () => {
    const odd = civilDays({ zoneProvider: { ...fixtureProvider(), identity: Object.freeze({ revision: 'r', name: 'n', extra: 1 }) }, policy: 'rfc5545' });
    assert.strictEqual(JSON.stringify(odd), '{"policy":"rfc5545","provider":{"name":"n","revision":"r"}}');
    assert.ok(Object.isFrozen(odd) && Object.isFrozen(odd.provider));
  });

  it('a given seam is not asked when no day rule runs', () => {
    const broken = civilDays({ zoneProvider: { toParts() { throw new Error('asked'); }, candidates() { throw new Error('asked'); } }, policy: 'rfc5545' });
    assert.strictEqual(scoreAssignment(rosterProblem(), registerRules(REFERENCE_RULES), [], { days: broken }).complete, true);
  });

  it('the host Intl provider tells the same days for these zones, with its own identity', () => {
    const intl = civilDays({ zoneProvider: createIntlZoneProvider({ revision: 'host' }), policy: 'rfc5545' });
    const problem = problemOf([
      { id: 'a', start: '2026-03-28T21:00:00Z', end: '2026-03-29T06:00:00Z', zone: AMS },
      { id: 'b', start: '2026-10-31T20:00:00Z', end: '2026-11-01T12:00:00Z', zone: NYC },
    ]);
    const fixture = /** @type {any} */ (scoreAssignment(problem, registerRules(DAY_RULES), [on('a'), on('b', 'bo')], { days }));
    const host = /** @type {any} */ (scoreAssignment(problem, registerRules(DAY_RULES), [on('a'), on('b', 'bo')], { days: intl }));
    assert.deepStrictEqual(host.provenance.days.provider, { name: 'intl', revision: 'host' });
    assert.deepStrictEqual({ ...host, provenance: null }, { ...fixture, provenance: null });
  });
});

describe('order, explanations and limits', () => {
  const problem = problemOf([
    { id: 'm1', start: '2026-06-10T06:00:00Z', end: '2026-06-10T16:00:00Z', zone: AMS },
    { id: 'm2', start: '2026-06-11T06:00:00Z', end: '2026-06-11T16:00:00Z', zone: AMS },
    { id: 'm3', start: '2026-06-12T06:00:00Z', end: '2026-06-12T16:00:00Z', zone: AMS },
  ]);
  const assignments = [on('m3', 'bo'), on('m1'), on('m2')];

  it('evaluates units by resource, zone and date, and explains them by resource', () => {
    const result = /** @type {any} */ (scoreAssignment(problem, probeSet, assignments, { days }));
    assert.deepStrictEqual(daysOfResult(result).map((day) => day.unit), [`ana ${AMS} 2026-06-10`, `ana ${AMS} 2026-06-11`, `bo ${AMS} 2026-06-12`]);
    const capped = scoreAssignment(problem, registerRules(DAY_RULES), assignments, { days });
    const byResource = explain(capped, { group: 'resource' });
    assert.deepStrictEqual(byResource.groups.map((group) => [group.key, group.matches.length]), [['ana', 5], ['bo', 2]]);
  });

  it('splits each task once, however many resources fill it, and asks for each day span once', () => {
    const calls = (/** @type {number} */ fill) => {
      let n = 0;
      const base = fixtureProvider();
      const counting = { ...base, toParts: (/** @type {number} */ e, /** @type {string} */ z) => (n++, base.toParts(e, z)), candidates: (/** @type {any} */ p, /** @type {string} */ z) => (n++, base.candidates(p, z)) };
      const shared = admitProblem({ revision: 1, resources: [{ id: 'ana', revision: 1 }, { id: 'bo', revision: 1 }],
        tasks: [{ id: 'both', revision: 1, zone: AMS, interval: { start: at('2026-10-24T20:00:00Z'), end: at('2026-10-25T07:00:00Z') }, demands: [{ slot: 's', count: 2 }] }] });
      const seam = civilDays({ zoneProvider: counting, policy: 'rfc5545' });
      n = 0;
      const result = /** @type {any} */ (scoreAssignment(shared, probeSet, [on('both'), on('both', 'bo')].slice(0, fill), { days: seam }));
      assert.strictEqual(result.counts.units, 2 * fill);
      return n;
    };
    assert.strictEqual(calls(2), calls(1));
  });

  it('counts day units against maxUnits and the day table against maxWork', () => {
    const units = /** @type {any} */ (scoreAssignment(problem, probeSet, assignments, { days, limits: { maxUnits: 2 } }));
    assert.deepStrictEqual(units.stoppedAt, { limit: 'maxUnits', rule: 'probe', unit: { date: '2026-06-12', id: 'bo', scope: 'resource-day', zone: AMS } });
    const work = /** @type {any} */ (scoreAssignment(problem, probeSet, assignments, { days, limits: { maxWork: 3 } }));
    assert.deepStrictEqual(work.stoppedAt, { limit: 'maxWork', rule: 'probe', unit: { date: null, id: 'ana', scope: 'resource-day', zone: null } });
    assert.strictEqual(work.complete, false);
    assert.strictEqual('score' in work, false);
    const reads = /** @type {any} */ (scoreAssignment(problem, probeSet, assignments, { days, limits: { maxWork: 13 } }));
    assert.deepStrictEqual(reads.stoppedAt.unit, { date: '2026-06-11', id: 'ana', scope: 'resource-day', zone: AMS });
    const full = /** @type {any} */ (scoreAssignment(problem, probeSet, assignments, { days }));
    // the table: per task one split, one piece and one day span (9); per unit one read of one piece and one match (3 each)
    assert.strictEqual(full.counts.work, 18);
  });
});

describe('refusals', () => {
  const problem = problemOf([{ id: 'd', start: '2026-06-10T06:00:00Z', end: '2026-06-10T10:00:00Z', zone: AMS }]);

  it('a day rule without days, or with a days value civilDays did not build (JN0021)', () => {
    assert.deepStrictEqual(refusal(() => scoreAssignment(problem, probeSet, [on('d')])), { code: 'JN0021', docPath: '/options/days' });
    for (const forged of [{ ...days }, { policy: 'rfc5545', provider: { name: 'x', revision: 'y' } }, null, 'days'])
      assert.deepStrictEqual(refusal(() => scoreAssignment(problem, probeSet, [on('d')], { days: /** @type {any} */ (forged) })), { code: 'JN0021', docPath: '/options/days' });
  });

  it('a day read by a rule of another scope (JN0021), even with days given', () => {
    const sneak = /** @type {any} */ ({ id: 'sneak', version: 1, level: 'hard', scope: 'resource', evaluate: (/** @type {any} */ view, /** @type {any} */ unit) => (view.daysOf(unit.id), {}) });
    const sneakDay = /** @type {any} */ ({ ...sneak, id: 'sneak-day', evaluate: (/** @type {any} */ view, /** @type {any} */ unit) => (view.day(unit.id, AMS, '2026-06-10'), {}) });
    for (const rule of [sneak, sneakDay])
      assert.deepStrictEqual(refusal(() => scoreAssignment(problem, registerRules([rule]), [on('d')], { days })), { code: 'JN0021', docPath: `/rules/${rule.id}/scope` });
  });

  it('a zone the provider does not know (JN0022, the calendar\'s refusal the cause)', () => {
    const unknown = problemOf([{ id: 'a', start: '2026-06-10T06:00:00Z', end: '2026-06-10T10:00:00Z', zone: AMS }, { id: 'b', start: '2026-06-10T06:00:00Z', end: '2026-06-10T10:00:00Z', zone: 'Mars/Olympus' }]);
    try {
      scoreAssignment(unknown, probeSet, [on('b')], { days });
      assert.fail('no refusal');
    }
    catch (error) {
      const e = /** @type {any} */ (error);
      assert.deepStrictEqual([e.code, e.docPath, e.cause?.code], ['JN0022', '/tasks/1/zone', 'JY0001']);
    }
  });

  it('a task spanning more than 36600 civil days (JN0022); one spanning exactly that many is scored', () => {
    const spanning = (/** @type {number} */ count) => admitProblem({ revision: 1, resources: [{ id: 'ana', revision: 1 }],
      tasks: [{ id: 'age', revision: 1, interval: { start: at('2000-01-01T00:00:00Z'), end: at('2000-01-01T00:00:00Z') + count * 86400000 }, demands: [{ slot: 's', count: 1 }], zone: 'UTC' }] });
    const quiet = registerRules([{ id: 'quiet', version: 1, level: 'soft', scope: 'resource-day', evaluate: () => ({}) }]);
    assert.strictEqual(/** @type {any} */ (scoreAssignment(spanning(36600), quiet, [on('age')], { days })).counts.units, 36600);
    assert.throws(() => scoreAssignment(spanning(36601), quiet, [on('age')], { days }), (error) => /** @type {any} */ (error).code === 'JN0022' && /** @type {any} */ (error).cause.code === 'JY0014');
  });

  it('civilDays refuses a malformed option (JN0015), the calendar\'s refusal the cause', () => {
    const provider = fixtureProvider();
    const cases = /** @type {[any, string][]} */ ([
      [undefined, '/options'],
      [{ zoneProvider: provider, policy: 'rfc5545', clock: 1 }, '/options/clock'],
      [{ zoneProvider: provider }, '/options/policy'],
      [{ zoneProvider: provider, policy: 'earlier' }, '/options/policy'],
      [{ policy: 'rfc5545' }, '/options/zoneProvider'],
      [{ zoneProvider: { toParts: provider.toParts }, policy: 'rfc5545' }, '/options/zoneProvider'],
      [{ zoneProvider: { ...provider, identity: { name: '', revision: 'r' } }, policy: 'rfc5545' }, '/options/zoneProvider/identity'],
    ]);
    for (const [options, docPath] of cases) {
      const refused = refusal(() => civilDays(options));
      assert.deepStrictEqual(refused, { code: 'JN0015', docPath }, JSON.stringify(options));
    }
  });
});
