//@ts-check
/**
 * Exact explained scoring: hand-counted totals, the verdict's rules
 * (unknown is never feasible), a rule answering out of contract refused
 * by name, typed incomplete results past each limit, exact decimals past
 * Number.MAX_SAFE_INTEGER, lexicographic comparison, explanations, and
 * byte-identical answers across runs and input orders.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import * as assign from '@jarenjs/core/assign';
import { admitProblem, registerRules, scoreAssignment, compareScores, explain, AssignError, ASSIGN_LIMITS } from '@jarenjs/core/assign';
import { REFERENCE_RULES } from './rules/reference.js';
import { rosterProblem, shuffled } from './fixtures.js';

const ruleSet = registerRules(REFERENCE_RULES);

/** The hand-counted list: ari overlaps 30 ms, is 450 ms past cap, avoids mon-late. */
const ARI_TWICE = [
  { task: 'mon-early', slot: 'lead', resource: 'nina' },
  { task: 'mon-early', slot: 'crew', resource: 'ari' },
  { task: 'mon-late', slot: 'crew', resource: 'ari' },
];

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

/**
 * Score the roster problem with one rule that answers `answer`.
 * @param {unknown} answer @param {object} [extra]
 */
function answering(answer, extra = {}) {
  const rules = registerRules([{ id: 'r', version: 1, level: 'soft', scope: 'resource', ...extra, evaluate: () => answer }]);
  return scoreAssignment(rosterProblem(), rules, []);
}

describe('scoreAssignment', () => {
  it('scores a hand-counted roster exactly', () => {
    const result = scoreAssignment(rosterProblem(), ruleSet, ARI_TWICE);
    assert.strictEqual(result.complete, true);
    assert.strictEqual(result.verdict, 'infeasible-by-validation');
    assert.deepStrictEqual(result.score, { encoding: { hard: 'number', service: 'number', soft: 'number' }, hard: -30, service: -1, soft: -464 });
    assert.deepStrictEqual(result.matches?.map((m) => [m.rule, m.magnitude, m.score, m.messageId]), [
      ['avoid-preference', 4, -12, 'avoided'],
      ['coverage-min', 1, -1, 'under-covered'],
      ['max-sum-in-window', 450, -450, 'over-cap'],
      ['no-overlap', 30, -30, 'overlap'],
      ['spread-fairness', 2, -2, 'spread'],
    ]);
    const overlap = result.matches?.find((m) => m.rule === 'no-overlap');
    assert.deepStrictEqual(overlap, {
      encoding: 'number', intervals: [{ end: 480, start: 450 }], level: 'hard', magnitude: 30, measure: 'ms', messageId: 'overlap',
      params: {}, rule: 'no-overlap', score: -30, subjects: { resources: ['ari'], tasks: ['mon-early', 'mon-late'] },
      unit: { id: 'ari', scope: 'resource' }, version: 1,
    });
    assert.deepStrictEqual(result.unknowns, []);
    assert.deepStrictEqual(result.counts, { rules: 8, units: 3 * 4 + 2 * 2 + 2, matches: 5, unknowns: 0, work: result.counts.work });
    assert.deepStrictEqual({ ...result.provenance, assignments: '', ruleSet: '' }, {
      algorithm: 'full', assignments: '', baseline: 'b-1', facts: { availability: 'av-1', preferences: 2 }, problem: 'week-12', ruleSet: '',
      rules: [['attribute-match', 1], ['availability-required', 2], ['avoid-preference', 1], ['coverage-min', 1], ['max-sum-in-window', 1],
        ['min-gap-between', 1], ['no-overlap', 1], ['spread-fairness', 1]].map(([id, version]) => ({ id, version })),
    });
    assert.strictEqual(result.provenance.ruleSet, ruleSet.hash);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.matches) && Object.isFrozen(result.score));
  });

  it('scores a busy resource and two open slots', () => {
    const result = scoreAssignment(rosterProblem(), ruleSet, [
      { task: 'mon-early', slot: 'lead', resource: 'nina' }, { task: 'mon-early', slot: 'crew', resource: 'sam' }]);
    assert.deepStrictEqual([result.score.hard, result.score.service, result.score.soft, result.verdict], [-1, -2, -1, 'infeasible-by-validation']);
  });

  it('scores a missing skill and a short gap by hand', () => {
    const problem = rosterProblem();
    problem.tasks.push({ id: 'mon-night', revision: 1, interval: { start: 930, end: 1200 }, demands: [{ slot: 'crew', count: 1 }] });
    const result = scoreAssignment(problem, ruleSet, [
      { task: 'mon-early', slot: 'lead', resource: 'ari' },
      { task: 'mon-late', slot: 'crew', resource: 'nina' },
      { task: 'mon-night', slot: 'crew', resource: 'nina' },
    ]);
    // ari lacks first-aid (1); nina's gap is 30 of 60 (30, weight 2); nina
    // works 720 of a 480 cap; mon-early's crew is empty (2); loads 2/1/0.
    assert.deepStrictEqual(result.matches?.map((m) => [m.rule, m.magnitude, m.score]), [
      ['attribute-match', 1, -1],
      ['coverage-min', 2, -2],
      ['max-sum-in-window', 240, -240],
      ['min-gap-between', 30, -60],
      ['spread-fairness', 2, -2],
    ]);
    assert.deepStrictEqual([result.score?.hard, result.score?.service, result.score?.soft, result.verdict], [-1, -62, -242, 'infeasible-by-validation']);
    assert.deepStrictEqual(result.matches?.[0].params, { missing: ['first-aid'], slot: 'lead' });
  });

  it('is feasible only with no hard match and no hard unknown', () => {
    const result = scoreAssignment(rosterProblem(), ruleSet, [{ task: 'mon-early', slot: 'lead', resource: 'nina' }]);
    assert.deepStrictEqual([result.score.hard, result.verdict], [0, 'feasible']);
  });

  it('a hard rule missing its fact makes the verdict unknown, naming the rule and the fact', () => {
    const problem = rosterProblem();
    delete problem.facts.availability;
    const result = scoreAssignment(problem, ruleSet, [{ task: 'mon-early', slot: 'lead', resource: 'nina' }]);
    assert.strictEqual(result.verdict, 'unknown');
    assert.strictEqual(result.score?.hard, 0);
    assert.deepStrictEqual(result.unknowns, [{ fact: 'availability', level: 'hard', reason: 'missing-fact', rule: 'availability-required',
      subjects: { resources: [], tasks: [] }, unit: null, version: 2 }]);
  });

  it('a hard unknown from a rule\'s own answer is unknown; a hard match beside it is still a validated violation', () => {
    const problem = rosterProblem();
    problem.facts.availability.rows = problem.facts.availability.rows.filter((/** @type {any} */ row) => row.resource !== 'ari');
    const open = scoreAssignment(problem, ruleSet, [{ task: 'mon-late', slot: 'crew', resource: 'ari' }]);
    assert.strictEqual(open.verdict, 'unknown');
    assert.deepStrictEqual(open.unknowns?.map((u) => [u.rule, u.reason, u.unit?.id, u.subjects.tasks]), [['availability-required', 'not-covered', 'ari', ['mon-late']]]);
    const both = scoreAssignment(problem, ruleSet, [{ task: 'mon-early', slot: 'crew', resource: 'ari' }, { task: 'mon-late', slot: 'crew', resource: 'ari' }]);
    assert.strictEqual(both.unknowns?.filter((u) => u.level === 'hard').length, 2);
    assert.strictEqual(both.verdict, 'infeasible-by-validation');
  });

  it('service and soft unknowns are reported and do not block', () => {
    const problem = rosterProblem();
    delete problem.facts.preferences;
    const result = scoreAssignment(problem, ruleSet, [{ task: 'mon-early', slot: 'lead', resource: 'nina' }]);
    assert.strictEqual(result.verdict, 'feasible');
    assert.deepStrictEqual(result.unknowns?.map((u) => [u.rule, u.level, u.fact]), [['avoid-preference', 'soft', 'preferences']]);
  });

  it('checks the scored assignments as the problem\'s are', () => {
    assert.deepStrictEqual(refusal(() => scoreAssignment(rosterProblem(), ruleSet, [{ task: 'tue', slot: 'crew', resource: 'ari' }])),
      { code: 'JN0007', docPath: '/assignments/0/task' });
    assert.deepStrictEqual(refusal(() => scoreAssignment(rosterProblem(), ruleSet, [ARI_TWICE[0], ARI_TWICE[0]])), { code: 'JN0008', docPath: '/assignments/1' });
    assert.deepStrictEqual(refusal(() => scoreAssignment(rosterProblem(), ruleSet, {})), { code: 'JN0001', docPath: '/assignments' });
    assert.deepStrictEqual(refusal(() => scoreAssignment({ revision: 1 }, ruleSet, [])), { code: 'JN0001', docPath: '/resources' });
  });

  const OUT_OF_CONTRACT = /** @type {[string, unknown, string, string][]} */ ([
    ['a promise', Promise.resolve({}), 'JN0017', '/rules/r/resources/ari'],
    ['undefined', undefined, 'JN0017', '/rules/r/resources/ari'],
    ['an unknown member', { warnings: [] }, 'JN0017', '/rules/r/resources/ari/warnings'],
    ['matches that are not an array', { matches: {} }, 'JN0017', '/rules/r/resources/ari/matches'],
    ['unknowns that are not an array', { unknowns: 'x' }, 'JN0017', '/rules/r/resources/ari/unknowns'],
    ['a match that is not an object', { matches: [1] }, 'JN0017', '/rules/r/resources/ari/matches/0'],
    ['a zero magnitude', { matches: [{ magnitude: 0, messageId: 'm' }] }, 'JN0017', '/rules/r/resources/ari/matches/0/magnitude'],
    ['a negative magnitude', { matches: [{ magnitude: -3, messageId: 'm' }] }, 'JN0017', '/rules/r/resources/ari/matches/0/magnitude'],
    ['a fractional magnitude', { matches: [{ magnitude: 1.5, messageId: 'm' }] }, 'JN0017', '/rules/r/resources/ari/matches/0/magnitude'],
    ['an unsafe magnitude', { matches: [{ magnitude: 2 ** 53, messageId: 'm' }] }, 'JN0017', '/rules/r/resources/ari/matches/0/magnitude'],
    ['a zero bigint magnitude', { matches: [{ magnitude: 0n, messageId: 'm' }] }, 'JN0017', '/rules/r/resources/ari/matches/0/magnitude'],
    ['a string magnitude', { matches: [{ magnitude: '3', messageId: 'm' }] }, 'JN0017', '/rules/r/resources/ari/matches/0/magnitude'],
    ['no messageId', { matches: [{ magnitude: 1 }] }, 'JN0017', '/rules/r/resources/ari/matches/0/messageId'],
    ['an unknown match member', { matches: [{ magnitude: 1, messageId: 'm', score: -1 }] }, 'JN0017', '/rules/r/resources/ari/matches/0/score'],
    ['params that are not an object', { matches: [{ magnitude: 1, messageId: 'm', params: [] }] }, 'JN0017', '/rules/r/resources/ari/matches/0/params'],
    ['a non-JSON param', { matches: [{ magnitude: 1, messageId: 'm', params: { at: Number.POSITIVE_INFINITY } }] }, 'JN0009', '/rules/r/resources/ari/matches/0/params/at'],
    ['a bad interval', { matches: [{ magnitude: 1, messageId: 'm', intervals: [{ start: 3, end: 3 }] }] }, 'JN0005', '/rules/r/resources/ari/matches/0/intervals/0'],
    ['intervals that are not an array', { matches: [{ magnitude: 1, messageId: 'm', intervals: {} }] }, 'JN0017', '/rules/r/resources/ari/matches/0/intervals'],
    ['a subject the problem lacks', { matches: [{ magnitude: 1, messageId: 'm', subjects: { tasks: ['tue'] } }] }, 'JN0007', '/rules/r/resources/ari/matches/0/subjects/tasks/0'],
    ['an empty subject id', { matches: [{ magnitude: 1, messageId: 'm', subjects: { resources: [''] } }] }, 'JN0002', '/rules/r/resources/ari/matches/0/subjects/resources/0'],
    ['an unknown subject kind', { matches: [{ magnitude: 1, messageId: 'm', subjects: { slots: [] } }] }, 'JN0017', '/rules/r/resources/ari/matches/0/subjects/slots'],
    ['subjects that are not an object', { matches: [{ magnitude: 1, messageId: 'm', subjects: ['ari'] }] }, 'JN0017', '/rules/r/resources/ari/matches/0/subjects'],
    ['subject ids that are not an array', { matches: [{ magnitude: 1, messageId: 'm', subjects: { tasks: 'mon-late' } }] }, 'JN0017', '/rules/r/resources/ari/matches/0/subjects/tasks'],
    ['an unknown that is not an object', { unknowns: [null] }, 'JN0017', '/rules/r/resources/ari/unknowns/0'],
    ['an unknown without a reason', { unknowns: [{ fact: 'x' }] }, 'JN0017', '/rules/r/resources/ari/unknowns/0/reason'],
    ['an unknown with an empty fact', { unknowns: [{ reason: 'r', fact: '' }] }, 'JN0017', '/rules/r/resources/ari/unknowns/0/fact'],
    ['an unknown member of an unknown', { unknowns: [{ reason: 'r', why: 1 }] }, 'JN0017', '/rules/r/resources/ari/unknowns/0/why'],
  ]);

  for (const [what, answer, code, docPath] of OUT_OF_CONTRACT) {
    it(`refuses a rule answering ${what} (${code})`, () => {
      assert.deepStrictEqual(refusal(() => answering(answer)), { code, docPath });
    });
  }

  it('refuses a rule that throws with JN0016, what it threw as the cause, at the rule and unit', () => {
    const thrown = new RangeError('host bug');
    const rules = registerRules([{ id: 'r/1', version: 1, level: 'hard', scope: 'task', evaluate: () => { throw thrown; } }]);
    assert.throws(() => scoreAssignment(rosterProblem(), rules, []), (/** @type {any} */ error) =>
      error instanceof AssignError && error.code === 'JN0016' && error.cause === thrown && error.docPath === '/rules/r~11/tasks/mon-early');
  });

  it('copies params canonically: key order and later host edits do not reach the result', () => {
    const params = { b: 1, a: { d: [1, 2], c: null } };
    const first = answering({ matches: [{ magnitude: 1, messageId: 'm', params }] }, { scope: 'global' });
    params.b = 99;
    const second = answering({ matches: [{ magnitude: 1, messageId: 'm', params: { a: { c: null, d: [1, 2] }, b: 1 } }] }, { scope: 'global' });
    assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
    assert.deepStrictEqual(Object.keys(first.matches?.[0].params ?? {}), ['a', 'b']);
  });

  it('writes params keys in one order: integer-like keys first in numeric order, as JavaScript lists them, then code-unit order', () => {
    const one = answering({ matches: [{ magnitude: 1, messageId: 'm', params: { b: 1, 10: 2, a: 3, 9: 4 } }] }, { scope: 'global' });
    const two = answering({ matches: [{ magnitude: 1, messageId: 'm', params: { 9: 4, a: 3, 10: 2, b: 1 } }] }, { scope: 'global' });
    assert.deepStrictEqual(Object.keys(one.matches?.[0].params ?? {}), ['9', '10', 'a', 'b']);
    assert.strictEqual(JSON.stringify(one), JSON.stringify(two));
  });

  it('orders a unit\'s matches canonically, whatever order the rule emits them in', () => {
    const emit = (/** @type {number[]} */ order) => answering({ matches: order.map((n) => ({ magnitude: n, messageId: `m${n}`, subjects: { tasks: n % 2 ? ['mon-late', 'mon-early'] : ['mon-early'] } })) }, { scope: 'global' });
    assert.strictEqual(JSON.stringify(emit([3, 1, 2])), JSON.stringify(emit([2, 3, 1])));
    assert.deepStrictEqual(emit([1])?.matches?.[0].subjects.tasks, ['mon-early', 'mon-late']);
  });

  it('answers the same bytes across runs and for every key and array order of its inputs', () => {
    const text = JSON.stringify(scoreAssignment(rosterProblem(), ruleSet, ARI_TWICE));
    for (let run = 0; run < 3; run++) assert.strictEqual(JSON.stringify(scoreAssignment(rosterProblem(), ruleSet, ARI_TWICE)), text);
    for (let seed = 1; seed <= 25; seed++) {
      const rules = registerRules(shuffled({ list: REFERENCE_RULES }, seed).list);
      assert.strictEqual(JSON.stringify(scoreAssignment(shuffled(rosterProblem(), seed), rules, shuffled({ assignments: ARI_TWICE }, seed).assignments)), text, `seed ${seed}`);
    }
  });
});

describe('limits', () => {
  it('ships its defaults frozen', () => {
    assert.deepStrictEqual(ASSIGN_LIMITS, { maxUnits: 1000000, maxMatches: 1000000, maxWork: 100000000 });
    assert.ok(Object.isFrozen(ASSIGN_LIMITS));
  });

  for (const [limit, value, rule, unit] of /** @type {[string, number, string, any][]} */ ([
    ['maxUnits', 0, 'attribute-match', { id: 'mon-early', scope: 'task' }],
    ['maxUnits', 7, 'avoid-preference', { id: 'sam', scope: 'resource' }],
    ['maxMatches', 2, 'max-sum-in-window', { id: null, scope: 'global' }],
    ['maxWork', 10, 'attribute-match', { id: 'mon-early', scope: 'task' }],
  ])) {
    it(`past ${limit} ${value} the result is typed incomplete: verdict unknown and no total`, () => {
      const result = scoreAssignment(rosterProblem(), ruleSet, ARI_TWICE, { limits: { [limit]: value } });
      assert.strictEqual(result.complete, false);
      assert.strictEqual(result.verdict, 'unknown');
      assert.deepStrictEqual(result.stoppedAt, { limit, rule, unit });
      for (const key of ['score', 'matches', 'unknowns']) assert.ok(!Object.hasOwn(result, key), key);
      assert.deepStrictEqual(Object.keys(result), ['complete', 'counts', 'provenance', 'stoppedAt', 'verdict']);
      assert.deepStrictEqual(refusal(() => explain(result)), { code: 'JN0020', docPath: '/result' });
    });
  }

  it('a limit exactly at the need completes', () => {
    const full = scoreAssignment(rosterProblem(), ruleSet, ARI_TWICE);
    const { units, matches, work } = full.counts;
    const exact = scoreAssignment(rosterProblem(), ruleSet, ARI_TWICE, { limits: { maxUnits: units, maxMatches: matches, maxWork: work } });
    assert.strictEqual(JSON.stringify(exact), JSON.stringify(full));
    for (const limits of [{ maxUnits: units - 1 }, { maxMatches: matches - 1 }, { maxWork: work - 1 }])
      assert.strictEqual(scoreAssignment(rosterProblem(), ruleSet, ARI_TWICE, { limits }).complete, false, JSON.stringify(limits));
  });

  it('a rule that swallows the work limit is still stopped', () => {
    const rules = registerRules([{ id: 'greedy', version: 1, level: 'hard', scope: 'global', evaluate(view) {
      try {
        for (;;) view.tasks();
      }
      catch {
        return {};
      }
    } }]);
    const result = scoreAssignment(rosterProblem(), rules, [], { limits: { maxWork: 50 } });
    assert.deepStrictEqual([result.complete, result.stoppedAt?.limit], [false, 'maxWork']);
    const raw = registerRules([{ id: 'greedy', version: 1, level: 'hard', scope: 'global', evaluate(view) {
      for (;;) view.tasks();
    } }]);
    assert.strictEqual(scoreAssignment(rosterProblem(), raw, [], { limits: { maxWork: 50 } }).stoppedAt?.limit, 'maxWork');
  });

  for (const [options, docPath] of /** @type {[unknown, string][]} */ ([
    [[], '/options'], [{ limit: {} }, '/options/limit'], [{ limits: 3 }, '/options/limits'],
    [{ limits: { maxRows: 1 } }, '/options/limits/maxRows'], [{ limits: { maxWork: -1 } }, '/options/limits/maxWork'],
    [{ limits: { maxUnits: 1.5 } }, '/options/limits/maxUnits'],
  ])) {
    it(`refuses the options ${JSON.stringify(options)} (JN0015)`, () => {
      assert.deepStrictEqual(refusal(() => scoreAssignment(rosterProblem(), ruleSet, [], /** @type {any} */ (options))), { code: 'JN0015', docPath });
    });
  }
});

describe('exact arithmetic past Number.MAX_SAFE_INTEGER', () => {
  const heavy = (/** @type {unknown[]} */ matches, weight = 1) => answering({ matches }, { scope: 'global', weight });

  it('a match past it is decimal, magnitude and score both, exactly', () => {
    const weight = 2 ** 52;
    const result = heavy([{ magnitude: 3, messageId: 'big' }], weight);
    const match = result.matches?.[0];
    assert.deepStrictEqual([match?.encoding, match?.magnitude, match?.score], ['decimal', '3', String(-3n * BigInt(weight))]);
    assert.deepStrictEqual(result.score, { encoding: { hard: 'number', service: 'number', soft: 'decimal' }, hard: 0, service: 0, soft: '-13510798882111488' });
  });

  it('safe matches whose sum passes it make only the level decimal, decided from the final sum', () => {
    const result = heavy([{ magnitude: 1, messageId: 'a' }, { magnitude: 1, messageId: 'b' }, { magnitude: 1, messageId: 'c' }], 2 ** 52);
    assert.deepStrictEqual(result.matches?.map((m) => [m.encoding, m.score]), [['number', -(2 ** 52)], ['number', -(2 ** 52)], ['number', -(2 ** 52)]]);
    assert.deepStrictEqual([result.score.encoding.soft, result.score.soft], ['decimal', '-13510798882111488']);
    // Number arithmetic would have answered -13510798882111488 too; one more unit shows the rounding it avoids.
    const odd = heavy([{ magnitude: 1, messageId: 'a' }, { magnitude: Number.MAX_SAFE_INTEGER, messageId: 'b' }, { magnitude: 1, messageId: 'c' }]);
    assert.strictEqual(odd.score.soft, '-9007199254740993');
    assert.notStrictEqual(String(-1 - Number.MAX_SAFE_INTEGER - 1), odd.score.soft);
  });

  it('a bigint magnitude is exact at any size, and a sum that returns inside the range is a number again', () => {
    const result = heavy([{ magnitude: 2n ** 80n, messageId: 'huge' }]);
    assert.strictEqual(result.score.soft, (-(2n ** 80n)).toString());
    assert.strictEqual(result.matches?.[0].magnitude, (2n ** 80n).toString());
    const small = heavy([{ magnitude: 7n, messageId: 'small' }]);
    assert.deepStrictEqual([small.matches?.[0].encoding, small.matches?.[0].magnitude, small.score.soft], ['number', 7, -7]);
  });

  it('every match re-sums to the level exactly', () => {
    const result = heavy([{ magnitude: 2n ** 70n, messageId: 'a' }, { magnitude: 5, messageId: 'b' }, { magnitude: 2n ** 60n, messageId: 'c' }], 3);
    let sum = 0n;
    for (const match of result.matches ?? []) sum += BigInt(match.score);
    assert.strictEqual(sum.toString(), result.score.soft);
    assert.strictEqual(result.score.soft, (-3n * (2n ** 70n + 5n + 2n ** 60n)).toString());
  });
});

describe('compareScores', () => {
  const score = (/** @type {number|string} */ hard, /** @type {number|string} */ service, /** @type {number|string} */ soft) => ({
    encoding: { hard: typeof hard === 'string' ? 'decimal' : 'number', service: typeof service === 'string' ? 'decimal' : 'number', soft: typeof soft === 'string' ? 'decimal' : 'number' },
    hard, service, soft,
  });

  it('orders hard before service before soft, 0 best', () => {
    assert.strictEqual(compareScores(/** @type {any} */ (score(0, -100, -100)), /** @type {any} */ (score(-1, 0, 0))), 1);
    assert.strictEqual(compareScores(/** @type {any} */ (score(-1, -2, 0)), /** @type {any} */ (score(-1, -1, -50))), -1);
    assert.strictEqual(compareScores(/** @type {any} */ (score(-1, -1, -3)), /** @type {any} */ (score(-1, -1, -3))), 0);
    const list = [score(0, 0, -5), score(-2, 0, 0), score(0, 0, 0), score(0, -1, 0)];
    assert.deepStrictEqual(list.sort(/** @type {any} */ (compareScores)).map((s) => [s.hard, s.service, s.soft]), [[-2, 0, 0], [0, -1, 0], [0, 0, -5], [0, 0, 0]]);
  });

  it('compares decimal levels exactly where numbers would round to equal', () => {
    assert.strictEqual(Number('-9007199254740993'), Number('-9007199254740992'));
    assert.strictEqual(compareScores(/** @type {any} */ (score(0, 0, '-9007199254740993')), /** @type {any} */ (score(0, 0, '-9007199254740992'))), -1);
    assert.strictEqual(compareScores(/** @type {any} */ (score(0, 0, -5)), /** @type {any} */ (score(0, 0, '-9007199254740992'))), 1);
  });

  for (const [what, bad] of /** @type {[string, unknown][]} */ ([
    ['null', null], ['no encoding', { hard: 0, service: 0, soft: 0 }], ['a positive level', score(1, 0, 0)],
    ['a decimal that is not an integer', score(0, '-1.5', 0)], ['an encoding that lies', { ...score(0, 0, 0), encoding: { hard: 'decimal', service: 'number', soft: 'number' } }],
  ])) {
    it(`refuses ${what} (JN0019)`, () => {
      assert.strictEqual(refusal(() => compareScores(/** @type {any} */ (bad), /** @type {any} */ (score(0, 0, 0)))).code, 'JN0019');
      assert.strictEqual(refusal(() => compareScores(/** @type {any} */ (score(0, 0, 0)), /** @type {any} */ (bad))).code, 'JN0019');
    });
  }

  it('compares the results scoring answers', () => {
    const worse = scoreAssignment(rosterProblem(), ruleSet, ARI_TWICE);
    const better = scoreAssignment(rosterProblem(), ruleSet, [ARI_TWICE[0]]);
    assert.strictEqual(compareScores(/** @type {any} */ (better.score), /** @type {any} */ (worse.score)), 1);
  });
});

describe('explain', () => {
  const result = scoreAssignment(rosterProblem(), ruleSet, ARI_TWICE);

  it('groups by rule (the default) and by level, each summing to the total', () => {
    const byRule = explain(result);
    assert.strictEqual(byRule.group, 'rule');
    assert.deepStrictEqual(byRule.groups.map((g) => g.key), ['avoid-preference', 'coverage-min', 'max-sum-in-window', 'no-overlap', 'spread-fairness']);
    const byLevel = explain(result, { group: 'level' });
    assert.deepStrictEqual(byLevel.groups.map((g) => [g.key, g.score[/** @type {'hard'} */ (g.key)]]), [['hard', -30], ['service', -1], ['soft', -464]]);
    for (const explanation of [byRule, byLevel]) {
      const sums = { hard: 0n, service: 0n, soft: 0n };
      for (const group of explanation.groups) for (const level of /** @type {const} */ (['hard', 'service', 'soft'])) sums[level] += BigInt(group.score[level]);
      assert.deepStrictEqual([sums.hard, sums.service, sums.soft].map(Number), [-30, -1, -464]);
      assert.deepStrictEqual(explanation.ungrouped.matches, []);
    }
  });

  it('groups by resource and by task, a match in every group it names, the rest ungrouped', () => {
    const byResource = explain(result, { group: 'resource' });
    assert.deepStrictEqual(byResource.groups.map((g) => [g.key, g.matches.map((m) => m.rule)]), [
      ['ari', ['avoid-preference', 'max-sum-in-window', 'no-overlap', 'spread-fairness']],
      ['sam', ['spread-fairness']],
    ]);
    assert.deepStrictEqual(byResource.ungrouped.matches.map((m) => m.rule), ['coverage-min']);
    assert.strictEqual(byResource.ungrouped.score.service, -1);
    const byTask = explain(result, { group: 'task' });
    assert.deepStrictEqual(byTask.groups.map((g) => [g.key, g.score.hard, g.score.service, g.score.soft]), [['mon-early', -30, -1, 0], ['mon-late', -30, 0, -12]]);
    assert.ok(Object.isFrozen(byTask.groups[0]));
  });

  it('groups unknowns the same way', () => {
    const problem = rosterProblem();
    delete problem.facts.preferences;
    problem.facts.availability.rows = [];
    const unknown = scoreAssignment(problem, ruleSet, [ARI_TWICE[0]]);
    const byResource = explain(unknown, { group: 'resource' });
    assert.deepStrictEqual(byResource.groups.map((g) => [g.key, g.unknowns.map((u) => u.reason)]), [['ari', []], ['nina', ['not-covered']], ['sam', []]]);
    assert.deepStrictEqual(byResource.ungrouped.unknowns.map((u) => u.reason), ['missing-fact']);
    assert.deepStrictEqual(explain(unknown, { group: 'rule' }).groups.map((g) => [g.key, g.unknowns.length]),
      [['availability-required', 1], ['avoid-preference', 1], ['coverage-min', 0], ['spread-fairness', 0]]);
  });

  it('refuses what is not a complete result (JN0020) and an option it does not take (JN0015)', () => {
    assert.strictEqual(refusal(() => explain(/** @type {any} */ ({ complete: true }))).code, 'JN0020');
    assert.strictEqual(refusal(() => explain(/** @type {any} */ (null))).code, 'JN0020');
    assert.deepStrictEqual(refusal(() => explain(result, /** @type {any} */ ({ group: 'slot' }))), { code: 'JN0015', docPath: '/options/group' });
    assert.deepStrictEqual(refusal(() => explain(result, /** @type {any} */ ({ by: 'rule' }))), { code: 'JN0015', docPath: '/options/by' });
    assert.deepStrictEqual(refusal(() => explain(result, /** @type {any} */ ('rule'))), { code: 'JN0015', docPath: '/options' });
  });
});

describe('the engine source', () => {
  const dir = new URL('../../../packages/core/src/assign/', import.meta.url);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js'));

  it('reads no clock, no randomness, no locale and rounds nothing', () => {
    for (const file of files) {
      const text = fs.readFileSync(new URL(file, dir), 'utf8');
      for (const banned of [/\bDate\b/, /Math\.random/, /localeCompare/, /\bIntl\b/, /Math\.(round|floor|ceil|trunc|fround)/, /parseFloat|toFixed|toPrecision/, /performance\.now/])
        assert.doesNotMatch(text, banned, `${file}: ${banned}`);
    }
  });

  it('imports only its own modules and the core errors and object helpers; only the day seam imports the calendar', () => {
    const calendar = ['../calendar/bind.js', '../calendar/model.js', '../calendar/resolve.js'];
    for (const file of files) {
      const text = fs.readFileSync(new URL(file, dir), 'utf8');
      for (const [, specifier] of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
        assert.ok(/^\.\/[a-z-]+\.js$/.test(specifier) || ['../errors.js', '../object.js'].includes(specifier)
          || (file === 'days.js' && calendar.includes(specifier)), `${file} imports ${specifier}`);
        assert.ok(file === 'days.js' || specifier !== './days.js', `${file} imports the day seam`);
      }
    }
  });

  it('exports the mechanism and no rule', () => {
    assert.deepStrictEqual(Object.keys(assign).sort(), ['ASSIGN_CODES', 'ASSIGN_LIMITS', 'AssignError', 'admitProblem', 'compareScores', 'explain', 'registerRules', 'scoreAssignment']);
  });
});

it('an admitted problem and a raw one score to the same bytes', () => {
  assert.strictEqual(JSON.stringify(scoreAssignment(admitProblem(rosterProblem()), ruleSet, ARI_TWICE)), JSON.stringify(scoreAssignment(rosterProblem(), ruleSet, ARI_TWICE)));
});
