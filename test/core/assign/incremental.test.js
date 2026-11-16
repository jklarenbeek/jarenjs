//@ts-check
/**
 * The evaluator: every answer of `apply` and `whatIf` is the bytes a
 * fresh `scoreAssignment` of the same state answers; a preview changes
 * nothing; edits are refused as the list cannot take them; a rule that
 * reads outside its row falls back to full evaluation and is counted;
 * a revise, a limit or a failing rule is answered by a full scoring.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { admitProblem, createEvaluator, registerRules, scoreAssignment } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { REFERENCE_RULES } from './rules/reference.js';
import { DAY_RULES } from './rules/days.js';
import { fixtureProvider } from './days-provider.js';
import { largeProblem, rosterProblem } from './fixtures.js';

const ruleSet = registerRules(REFERENCE_RULES);
const START = [
  { task: 'mon-early', slot: 'lead', resource: 'nina', lock: 'hard' },
  { task: 'mon-early', slot: 'crew', resource: 'ari' },
  { task: 'mon-late', slot: 'crew', resource: 'sam' },
];
const text = (/** @type {unknown} */ value) => JSON.stringify(value);

/** @param {() => unknown} call @param {string} code @param {string} [docPath] */
function refuses(call, code, docPath) {
  assert.throws(call, (error) => {
    const e = /** @type {any} */ (error);
    assert.strictEqual(e.code, code, e.message);
    if (docPath !== undefined) assert.strictEqual(e.docPath, docPath);
    return true;
  });
}

/** A deep check that every object in a value is frozen. @param {unknown} value @returns {boolean} */
function deepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

describe('createEvaluator answers what full scoring answers', () => {
  it('at creation, and after each kind of edit', () => {
    const problem = admitProblem(rosterProblem());
    const evaluator = createEvaluator(problem, ruleSet, START);
    assert.strictEqual(text(evaluator.result), text(scoreAssignment(problem, ruleSet, START)));
    assert.ok(deepFrozen(evaluator.result));
    const early = (/** @type {string} */ slot, /** @type {string} */ resource, /** @type {string} */ [lock] = []) => (lock ? { task: 'mon-early', slot, resource, lock } : { task: 'mon-early', slot, resource });
    const late = (/** @type {string} */ resource) => ({ task: 'mon-late', slot: 'crew', resource });
    const steps = [
      [{ op: 'assign', task: 'mon-early', slot: 'crew', resource: 'sam', lock: 'soft' }],
      [{ op: 'unassign', task: 'mon-late', slot: 'crew', resource: 'sam' }],
      [{ op: 'assign', task: 'mon-late', slot: 'crew', resource: 'nina' }],
      [{ op: 'move', task: 'mon-early', slot: 'lead', from: 'nina', to: 'sam' }],
      [{ op: 'swap', a: { task: 'mon-early', slot: 'lead', resource: 'sam' }, b: { task: 'mon-late', slot: 'crew', resource: 'nina' } }],
    ];
    const lists = [
      [...START, early('crew', 'sam', ['soft'])],
      [START[0], START[1], early('crew', 'sam', ['soft'])],
      [START[0], START[1], early('crew', 'sam', ['soft']), late('nina')],
      [early('lead', 'sam', ['hard']), START[1], early('crew', 'sam', ['soft']), late('nina')],
      [early('lead', 'nina', ['hard']), START[1], early('crew', 'sam', ['soft']), late('sam')],
    ];
    steps.forEach(([edit], i) => {
      const answer = evaluator.apply(/** @type {any} */ (edit));
      const full = scoreAssignment(problem, ruleSet, lists[i]);
      assert.strictEqual(text(answer), text(full), `step ${i}`);
      assert.strictEqual(evaluator.result, answer);
      assert.strictEqual(text(evaluator.assignments), text(admitProblem({ ...rosterProblem(), assignments: lists[i] }).assignments), `list ${i}`);
    });
    const counts = evaluator.counts;
    assert.deepStrictEqual([counts.edits, counts.previews, counts.fullFallbacks, counts.fullScorings], [5, 0, 0, 1]);
    assert.ok(counts.reused > 0);
  });

  it('a move re-evaluates its task\'s row, both resources\' rows and the global rules, nothing else', () => {
    const { problem, assignments } = largeProblem(200, 20);
    const evaluator = createEvaluator(problem, ruleSet, assignments);
    const first = evaluator.counts.evaluated;
    // 2 task rules + 4 resource rules over 1 task and 2 resources, plus 2 global rules
    assert.strictEqual(first, 2 * 200 + 4 * 20 + 2);
    const held = evaluator.assignments.find((a) => a.slot === 'crew' && a.resource === 'p3');
    const free = ['p5', 'p6', 'p7'].find((id) => !evaluator.assignments.some((a) => a.task === held?.task && a.resource === id));
    evaluator.apply({ op: 'move', task: /** @type {any} */ (held).task, slot: 'crew', from: 'p3', to: /** @type {string} */ (free) });
    assert.strictEqual(evaluator.counts.evaluated - first, 2 * 1 + 4 * 2 + 2);
    assert.strictEqual(evaluator.counts.reused, 2 * 200 + 4 * 20 + 2 - (2 * 1 + 4 * 2 + 2));
  });

  it('whatIf answers what apply would and changes nothing', () => {
    const problem = admitProblem(rosterProblem());
    const one = createEvaluator(problem, ruleSet, START);
    const two = createEvaluator(problem, ruleSet, START);
    const edit = /** @type {const} */ ({ op: 'move', task: 'mon-late', slot: 'crew', from: 'sam', to: 'nina' });
    const result = one.result;
    const held = one.assignments;
    const before = text(result);
    const preview = one.whatIf(edit);
    assert.strictEqual(one.result, result);
    assert.strictEqual(one.assignments, held);
    assert.strictEqual(text(one.result), before);
    assert.ok(deepFrozen(preview));
    assert.strictEqual(text(preview), text(two.apply(edit)));
    // the preview's units were not kept: applying now answers the same bytes
    assert.strictEqual(text(one.apply(edit)), text(preview));
    assert.deepStrictEqual([one.counts.previews, one.counts.edits], [1, 1]);
  });

  it('an edit that changes nothing answers the result it holds', () => {
    const evaluator = createEvaluator(rosterProblem(), ruleSet, START);
    const result = evaluator.result;
    const before = evaluator.counts.evaluated;
    for (const edit of /** @type {any[]} */ ([
      { op: 'move', task: 'mon-early', slot: 'crew', from: 'ari', to: 'ari' },
      { op: 'swap', a: { task: 'mon-early', slot: 'crew', resource: 'ari' }, b: { task: 'mon-early', slot: 'crew', resource: 'ari' } },
      { op: 'revise', ruleSet },
    ])) assert.strictEqual(evaluator.apply(edit), result);
    assert.strictEqual(evaluator.counts.evaluated, before);
  });

  it('a swap of two assignments of one resource keeps each lock with its task', () => {
    const list = [{ task: 'mon-early', slot: 'lead', resource: 'nina', lock: 'hard' }, { task: 'mon-late', slot: 'crew', resource: 'nina' }];
    const evaluator = createEvaluator(rosterProblem(), ruleSet, list);
    const result = evaluator.result;
    assert.strictEqual(evaluator.apply({ op: 'swap', a: { task: 'mon-early', slot: 'lead', resource: 'nina' }, b: { task: 'mon-late', slot: 'crew', resource: 'nina' } }), result);
    // two resources of one slot swapped: the lock moves to the other resource
    const crew = [{ task: 'mon-early', slot: 'crew', resource: 'ari', lock: 'soft' }, { task: 'mon-early', slot: 'crew', resource: 'sam' }];
    const other = createEvaluator(rosterProblem(), ruleSet, crew);
    const swapped = other.apply({ op: 'swap', a: { task: 'mon-early', slot: 'crew', resource: 'ari' }, b: { task: 'mon-early', slot: 'crew', resource: 'sam' } });
    assert.strictEqual(text(other.assignments), text([{ resource: 'ari', slot: 'crew', task: 'mon-early' }, { lock: 'soft', resource: 'sam', slot: 'crew', task: 'mon-early' }]));
    assert.strictEqual(text(swapped), text(scoreAssignment(rosterProblem(), ruleSet, [{ task: 'mon-early', slot: 'crew', resource: 'sam', lock: 'soft' }, { task: 'mon-early', slot: 'crew', resource: 'ari' }])));
  });
});

describe('edits the list cannot take are refused and change nothing', () => {
  const evaluator = createEvaluator(rosterProblem(), ruleSet, START);
  const result = evaluator.result;
  const held = evaluator.assignments;
  const cases = /** @type {[string, unknown, string, string][]} */ ([
    ['not an object', 'assign', 'JN0023', '/edit'],
    ['an unknown op', { op: 'replace' }, 'JN0023', '/edit/op'],
    ['a missing member', { op: 'assign', task: 'mon-late', slot: 'crew' }, 'JN0023', '/edit/resource'],
    ['a member the op does not take', { op: 'unassign', task: 'mon-late', slot: 'crew', resource: 'sam', lock: 'hard' }, 'JN0023', '/edit/lock'],
    ['a swapped side that is not an object', { op: 'swap', a: 'x', b: {} }, 'JN0023', '/edit/a'],
    ['a swapped side with another member', { op: 'swap', a: { task: 'mon-late', slot: 'crew', resource: 'sam', lock: 'soft' }, b: {} }, 'JN0023', '/edit/a/lock'],
    ['an id that is not a string', { op: 'assign', task: 7, slot: 'crew', resource: 'sam' }, 'JN0002', '/edit/task'],
    ['a task the problem does not hold', { op: 'assign', task: 'tue', slot: 'crew', resource: 'sam' }, 'JN0007', '/edit/task'],
    ['a slot the task does not have', { op: 'assign', task: 'mon-late', slot: 'lead', resource: 'sam' }, 'JN0007', '/edit/slot'],
    ['a resource the problem does not hold', { op: 'move', task: 'mon-late', slot: 'crew', from: 'sam', to: 'kim' }, 'JN0007', '/edit/to'],
    ['a lock that is not hard or soft', { op: 'assign', task: 'mon-early', slot: 'crew', resource: 'sam', lock: 'firm' }, 'JN0001', '/edit/lock'],
    ['an assignment held twice', { op: 'assign', task: 'mon-early', slot: 'crew', resource: 'ari' }, 'JN0008', '/edit'],
    ['a slot past its count', { op: 'assign', task: 'mon-late', slot: 'crew', resource: 'ari' }, 'JN0008', '/edit'],
    ['a move onto a resource the slot holds', { op: 'move', task: 'mon-early', slot: 'crew', from: 'ari', to: 'ari2' }, 'JN0007', '/edit/to'],
    ['an unassign of an assignment not held', { op: 'unassign', task: 'mon-late', slot: 'crew', resource: 'ari' }, 'JN0023', '/edit'],
    ['a move of an assignment not held', { op: 'move', task: 'mon-late', slot: 'crew', from: 'ari', to: 'nina' }, 'JN0023', '/edit/from'],
    ['a swap of an assignment not held', { op: 'swap', a: { task: 'mon-late', slot: 'crew', resource: 'sam' }, b: { task: 'mon-late', slot: 'crew', resource: 'nina' } }, 'JN0023', '/edit/b'],
    ['a revise naming nothing', { op: 'revise' }, 'JN0023', '/edit'],
  ]);
  for (const [name, edit, code, docPath] of cases)
    it(`${name}: ${code} at ${docPath}, by apply and by whatIf`, () => {
      refuses(() => evaluator.apply(/** @type {any} */ (edit)), code, docPath);
      refuses(() => evaluator.whatIf(/** @type {any} */ (edit)), code, docPath);
      assert.strictEqual(evaluator.result, result);
      assert.strictEqual(evaluator.assignments, held);
    });

  it('a move or a swap that would hold a resource twice in one slot: JN0008', () => {
    const two = createEvaluator(rosterProblem(), ruleSet, [{ task: 'mon-early', slot: 'crew', resource: 'ari' }, { task: 'mon-early', slot: 'crew', resource: 'sam' }]);
    refuses(() => two.apply({ op: 'move', task: 'mon-early', slot: 'crew', from: 'ari', to: 'sam' }), 'JN0008', '/edit');
    const three = createEvaluator(rosterProblem(), ruleSet, [{ task: 'mon-early', slot: 'lead', resource: 'nina' }, { task: 'mon-early', slot: 'crew', resource: 'ari' }, { task: 'mon-early', slot: 'crew', resource: 'nina' }]);
    refuses(() => three.whatIf({ op: 'swap', a: { task: 'mon-early', slot: 'lead', resource: 'nina' }, b: { task: 'mon-early', slot: 'crew', resource: 'ari' } }), 'JN0008', '/edit');
  });

  it('the options and arguments scoreAssignment refuses, with the same codes', () => {
    for (const [args, code] of /** @type {[any[], string][]} */ ([
      [[rosterProblem(), {}, []], 'JN0014'],
      [[rosterProblem(), ruleSet, [], { limits: { maxWork: -1 } }], 'JN0015'],
      [[rosterProblem(), ruleSet, [], { cache: true }], 'JN0015'],
      [[rosterProblem(), ruleSet, [], { days: {} }], 'JN0021'],
      [[rosterProblem(), registerRules(DAY_RULES), []], 'JN0021'],
      [[rosterProblem(), ruleSet, [{ task: 'tue', slot: 'crew', resource: 'sam' }]], 'JN0007'],
    ])) {
      refuses(() => scoreAssignment(...(/** @type {[any, any, any, any]} */ (args))), code);
      refuses(() => createEvaluator(...(/** @type {[any, any, any, any]} */ (args))), code);
    }
  });

  it('a closed evaluator refuses every edit and still answers its last result', () => {
    const closing = createEvaluator(rosterProblem(), ruleSet, START);
    const last = closing.result;
    closing.close();
    closing.close();
    refuses(() => closing.apply({ op: 'unassign', task: 'mon-late', slot: 'crew', resource: 'sam' }), 'JN0023', '/edit');
    refuses(() => closing.whatIf({ op: 'revise', problem: rosterProblem() }), 'JN0023', '/edit');
    assert.strictEqual(closing.result, last);
    assert.strictEqual(closing.assignments.length, 3);
  });
});

describe('a revise is a full re-evaluation', () => {
  const days = civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' });

  it('a new problem revision, a new rule set or new assignments: every rule again, the bytes of full scoring', () => {
    const evaluator = createEvaluator(rosterProblem(), ruleSet, START);
    const scorings = evaluator.counts.fullScorings;
    const revised = { ...rosterProblem(), revision: 'week-12b', attributes: { minGap: 600, cap: 100, window: { start: 0, end: 1440 } } };
    const preview = evaluator.whatIf({ op: 'revise', problem: revised });
    assert.strictEqual(text(preview), text(scoreAssignment(revised, ruleSet, START)));
    assert.strictEqual(evaluator.counts.fullScorings, scorings + 1);
    assert.strictEqual(text(evaluator.result), text(scoreAssignment(rosterProblem(), ruleSet, START)));
    assert.strictEqual(text(evaluator.apply({ op: 'revise', problem: revised })), text(preview));
    assert.strictEqual(evaluator.counts.fullScorings, scorings + 2);
    // the cache now holds the new problem: an edit answers against it
    const moved = [START[0], START[1], { task: 'mon-late', slot: 'crew', resource: 'nina' }];
    assert.strictEqual(text(evaluator.apply({ op: 'move', task: 'mon-late', slot: 'crew', from: 'sam', to: 'nina' })), text(scoreAssignment(revised, ruleSet, moved)));
    const fewer = registerRules(REFERENCE_RULES.slice(0, 4));
    assert.strictEqual(text(evaluator.apply({ op: 'revise', ruleSet: fewer })), text(scoreAssignment(revised, fewer, moved)));
    assert.strictEqual(text(evaluator.apply({ op: 'revise', assignments: [] })), text(scoreAssignment(revised, fewer, [])));
    assert.strictEqual(evaluator.counts.fullScorings, scorings + 4);
  });

  it('the same rule set registered again is another rule set: its functions may differ', () => {
    const evaluator = createEvaluator(rosterProblem(), ruleSet, START);
    const scorings = evaluator.counts.fullScorings;
    evaluator.apply({ op: 'revise', ruleSet: registerRules(REFERENCE_RULES) });
    assert.strictEqual(evaluator.counts.fullScorings, scorings + 1);
    evaluator.apply({ op: 'revise', problem: admitProblem(rosterProblem()) });
    assert.strictEqual(evaluator.counts.fullScorings, scorings + 2);
  });

  it('a zone provider of another identity: every rule again, its identity in provenance', () => {
    const problem = { revision: 1, resources: [{ id: 'r1', revision: 1 }], tasks: [{ id: 't1', revision: 1, zone: 'Europe/Amsterdam',
      interval: { start: Date.UTC(2026, 9, 24, 20), end: Date.UTC(2026, 9, 25, 9) }, demands: [{ slot: 's', count: 1 }] }],
      attributes: { dayCap: 8 * 3600000, minDay: 3 * 3600000, maxRun: 1, minRest: 11 * 3600000 } };
    const dayRules = registerRules(DAY_RULES);
    const list = [{ task: 't1', slot: 's', resource: 'r1' }];
    const evaluator = createEvaluator(problem, dayRules, list, { days });
    assert.strictEqual(text(evaluator.result), text(scoreAssignment(problem, dayRules, list, { days })));
    const other = civilDays({ zoneProvider: fixtureProvider({}, { name: 'fixture', revision: 'other' }), policy: 'rfc5545' });
    const scorings = evaluator.counts.fullScorings;
    const answer = evaluator.apply({ op: 'revise', days: other });
    assert.strictEqual(evaluator.counts.fullScorings, scorings + 1);
    assert.strictEqual(text(answer), text(scoreAssignment(problem, dayRules, list, { days: other })));
    assert.deepStrictEqual(/** @type {any} */ (answer).provenance.days.provider, { name: 'fixture', revision: 'other' });
    // the seam it holds, named again, changes nothing
    assert.strictEqual(evaluator.apply({ op: 'revise', days: other }), answer);
    assert.strictEqual(evaluator.counts.fullScorings, scorings + 1);
    refuses(() => evaluator.apply({ op: 'revise', days: { ...other } }), 'JN0021', '/options/days');
  });

  it('a revise the new state refuses changes nothing', () => {
    const evaluator = createEvaluator(rosterProblem(), ruleSet, START);
    const result = evaluator.result;
    const smaller = { ...rosterProblem(), tasks: rosterProblem().tasks.slice(0, 1) };
    refuses(() => evaluator.apply({ op: 'revise', problem: smaller }), 'JN0007', '/assignments/2/task');
    refuses(() => evaluator.apply({ op: 'revise', ruleSet: registerRules(DAY_RULES) }), 'JN0021', '/options/days');
    refuses(() => evaluator.apply({ op: 'revise', ruleSet: /** @type {any} */ ({}) }), 'JN0014');
    assert.strictEqual(evaluator.result, result);
    assert.strictEqual(text(evaluator.apply({ op: 'unassign', task: 'mon-late', slot: 'crew', resource: 'sam' })), text(scoreAssignment(rosterProblem(), ruleSet, START.slice(0, 2))));
  });
});

describe('a rule that reads outside its row falls back to full evaluation', () => {
  /** A resource rule that also reads the next resource's assignments: wider than its scope. */
  const pairedShifts = /** @type {import('@jarenjs/core/assign').AssignRule} */ ({
    id: 'paired-shifts', version: 1, level: 'soft', scope: 'resource',
    evaluate(view, unit) {
      const ids = view.resources().map((r) => r.id);
      const buddy = ids[(ids.indexOf(/** @type {string} */ (unit.id)) + 1) % ids.length];
      const theirs = new Set(view.assignmentsOf(buddy).map((a) => a.task));
      const matches = view.assignmentsOf(/** @type {string} */ (unit.id)).filter((a) => theirs.has(a.task))
        .map((a) => ({ magnitude: 1, messageId: 'paired', subjects: { resources: [/** @type {string} */ (unit.id), buddy], tasks: [a.task] } }));
      return { matches };
    },
  });

  it('it is evaluated over every unit on every edit, counted, and answers exactly', () => {
    const rules = registerRules([...REFERENCE_RULES, pairedShifts]);
    const evaluator = createEvaluator(rosterProblem(), rules, START);
    let list = START;
    for (const [edit, next] of /** @type {[any, any[]][]} */ ([
      [{ op: 'assign', task: 'mon-early', slot: 'crew', resource: 'nina' }, [...START, { task: 'mon-early', slot: 'crew', resource: 'nina' }]],
      [{ op: 'move', task: 'mon-early', slot: 'crew', from: 'ari', to: 'sam' }, [START[0], START[2], { task: 'mon-early', slot: 'crew', resource: 'nina' }, { task: 'mon-early', slot: 'crew', resource: 'sam' }]],
    ])) {
      assert.strictEqual(text(evaluator.whatIf(edit)), text(scoreAssignment(rosterProblem(), rules, next)));
      assert.strictEqual(text(evaluator.apply(edit)), text(scoreAssignment(rosterProblem(), rules, next)));
      list = next;
    }
    assert.ok(list.length === 4);
    assert.deepStrictEqual([evaluator.counts.fullFallbacks, evaluator.counts.fullScorings], [4, 1]);
  });

  it('a rule reading every assignment in a non-global scope falls back too', () => {
    const rule = /** @type {any} */ ({ id: 'share', version: 1, level: 'soft', scope: 'task',
      evaluate: (/** @type {any} */ view, /** @type {any} */ unit) => {
        const mine = view.assignmentsFor(unit.id).length;
        return mine * 2 > view.assignments().length ? { matches: [{ magnitude: 1, messageId: 'most' }] } : {};
      } });
    const rules = registerRules([rule]);
    const evaluator = createEvaluator(rosterProblem(), rules, START);
    const answer = evaluator.apply({ op: 'unassign', task: 'mon-late', slot: 'crew', resource: 'sam' });
    assert.strictEqual(text(answer), text(scoreAssignment(rosterProblem(), rules, START.slice(0, 2))));
    assert.strictEqual(evaluator.counts.fullFallbacks, 1);
  });
});

describe('what a preview or a day read tells the evaluator about a rule', () => {
  it('a rule that reads outside its row only in a previewed state does not fall back after the preview', () => {
    // reads the next resource's assignments only while its own resource holds two or more
    const crowded = /** @type {any} */ ({ id: 'crowded', version: 1, level: 'soft', scope: 'resource',
      evaluate: (/** @type {any} */ view, /** @type {any} */ unit) => {
        const mine = view.assignmentsOf(unit.id).length;
        if (mine < 2) return {};
        const ids = view.resources().map((/** @type {any} */ r) => r.id);
        const buddy = ids[(ids.indexOf(unit.id) + 1) % ids.length];
        return view.assignmentsOf(buddy).length === 0 ? { matches: [{ magnitude: mine, messageId: 'alone' }] } : {};
      } });
    const rules = registerRules([crowded]);
    const evaluator = createEvaluator(rosterProblem(), rules, START);
    const preview = evaluator.whatIf({ op: 'assign', task: 'mon-early', slot: 'crew', resource: 'nina' });
    assert.strictEqual(text(preview), text(scoreAssignment(rosterProblem(), rules, [...START, { task: 'mon-early', slot: 'crew', resource: 'nina' }])));
    assert.strictEqual(evaluator.counts.fullFallbacks, 0);
    evaluator.apply({ op: 'unassign', task: 'mon-late', slot: 'crew', resource: 'sam' });
    assert.strictEqual(evaluator.counts.fullFallbacks, 0, 'the preview\'s wide read is not kept');
    // applied, the wide read is kept: the next edit falls back
    evaluator.apply({ op: 'assign', task: 'mon-early', slot: 'crew', resource: 'nina' });
    evaluator.apply({ op: 'assign', task: 'mon-late', slot: 'crew', resource: 'sam' });
    assert.strictEqual(evaluator.counts.fullFallbacks, 1);
    assert.strictEqual(text(evaluator.result), text(scoreAssignment(rosterProblem(), rules, [...START, { task: 'mon-early', slot: 'crew', resource: 'nina' }])));
  });

  it('a day rule reading another resource\'s day falls back, and an edit of that resource alone is answered exactly', () => {
    const days = civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' });
    const at = (/** @type {number} */ hour) => Date.UTC(2026, 9, 20, hour);
    const problem = { revision: 1, resources: [{ id: 'r1', revision: 1 }, { id: 'r2', revision: 1 }],
      tasks: ['t1', 't2', 't3'].map((id, i) => ({ id, revision: 1, zone: 'Europe/Amsterdam', interval: { start: at(8 + i), end: at(9 + i) }, demands: [{ slot: 's', count: 2 }] })) };
    // judges r1's day by how much r2 works on the same date
    const sameDay = /** @type {any} */ ({ id: 'same-day', version: 1, level: 'soft', scope: 'resource-day',
      evaluate: (/** @type {any} */ view, /** @type {any} */ unit) => {
        if (unit.id !== 'r1') return {};
        const other = view.day('r2', unit.zone, unit.date);
        return other === null ? {} : { matches: [{ magnitude: other.pieces.length, messageId: 'shared' }] };
      } });
    const rules = registerRules([sameDay]);
    const list = [{ task: 't1', slot: 's', resource: 'r1' }, { task: 't2', slot: 's', resource: 'r2' }];
    const evaluator = createEvaluator(problem, rules, list, { days });
    const answer = evaluator.apply({ op: 'assign', task: 't3', slot: 's', resource: 'r2' });
    assert.strictEqual(text(answer), text(scoreAssignment(problem, rules, [...list, { task: 't3', slot: 's', resource: 'r2' }], { days })));
    assert.strictEqual(/** @type {any} */ (answer).score.soft, -2);
    assert.strictEqual(evaluator.counts.fullFallbacks, 1);
  });
});

describe('a host rule reading state the view cannot see is caught by the equality check', () => {
  it('the stream names it', async () => {
    const { streamInstance, runStream } = await import('./stream.js');
    const { problem, assignments } = streamInstance(5, { resources: 5, tasks: 16 });
    const host = { list: assignments };
    /** Reads the next resource's load from the host's own list, not the view: under-declared. */
    const hostLoad = /** @type {import('@jarenjs/core/assign').AssignRule} */ ({
      id: 'host-load', version: 1, level: 'soft', scope: 'resource',
      evaluate(view, unit) {
        const n = Number(String(unit.id).slice(1));
        const buddy = `p${(n + 1) % 5}`;
        const theirs = host.list.filter((a) => a.resource === buddy).length;
        const mine = view.assignmentsOf(/** @type {string} */ (unit.id)).length;
        return theirs > mine ? { matches: [{ magnitude: theirs - mine, messageId: 'lighter' }] } : {};
      },
    });
    const rules = registerRules([...REFERENCE_RULES, hostLoad]);
    const admitted = admitProblem(problem);
    const evaluator = createEvaluator(admitted, rules, assignments);
    const all = [...REFERENCE_RULES, hostLoad];
    const run = runStream({ evaluator, problem: admitted, ruleSet: rules, list: assignments, edits: 200, seed: 3, onState: (list) => { host.list = list; },
      rules: all, make: (/** @type {any} */ set) => {
        host.list = assignments;
        return createEvaluator(admitted, set, assignments);
      } });
    assert.ok(run.failure !== null, 'the stream sees the stale answer');
    assert.deepStrictEqual(run.failure.culprits, ['host-load']);
    assert.ok(run.failure.differing.includes('host-load'), run.failure.differing.join(', '));
    assert.ok(!run.failure.differing.some((/** @type {string} */ id) => REFERENCE_RULES.some((rule) => rule.id === id)), run.failure.differing.join(', '));
  });
});

describe('limits and failing rules are answered by full scoring', () => {
  it('past a limit the answer is the incomplete full scoring, never a partial total', () => {
    const problem = admitProblem(rosterProblem());
    const work = /** @type {any} */ (scoreAssignment(problem, ruleSet, START)).counts.work;
    const limits = { maxWork: work };
    const evaluator = createEvaluator(problem, ruleSet, START, { limits });
    assert.strictEqual(evaluator.result.complete, true);
    const more = [...START, { task: 'mon-early', slot: 'crew', resource: 'nina' }];
    const over = evaluator.apply({ op: 'assign', task: 'mon-early', slot: 'crew', resource: 'nina' });
    assert.strictEqual(over.complete, false);
    assert.ok(!('score' in over) && !('matches' in over) && !('unknowns' in over));
    assert.strictEqual(text(over), text(scoreAssignment(problem, ruleSet, more, { limits })));
    const back = evaluator.apply({ op: 'unassign', task: 'mon-early', slot: 'crew', resource: 'nina' });
    assert.strictEqual(back.complete, true);
    assert.strictEqual(text(back), text(scoreAssignment(problem, ruleSet, START, { limits })));
    assert.strictEqual(evaluator.counts.fullScorings, 2);
    for (const name of /** @type {const} */ (['maxUnits', 'maxMatches'])) {
      const full = /** @type {any} */ (scoreAssignment(problem, ruleSet, START)).counts;
      const tight = { [name]: name === 'maxUnits' ? full.units : full.matches };
      const each = createEvaluator(problem, ruleSet, START, { limits: tight });
      const answer = each.apply({ op: 'assign', task: 'mon-early', slot: 'crew', resource: 'nina' });
      assert.strictEqual(text(answer), text(scoreAssignment(problem, ruleSet, more, { limits: tight })), name);
    }
  });

  it('a rule that throws in a new state: the edit is refused as full scoring refuses it, and the state is kept', () => {
    const fussy = /** @type {any} */ ({ id: 'fussy', version: 1, level: 'hard', scope: 'resource',
      evaluate: (/** @type {any} */ view, /** @type {any} */ unit) => {
        if (view.assignmentsOf(unit.id).length > 1) throw new Error('too busy');
        return {};
      } });
    const rules = registerRules([fussy]);
    const evaluator = createEvaluator(rosterProblem(), rules, START);
    const result = evaluator.result;
    const swapped = [START[0], START[1], { task: 'mon-late', slot: 'crew', resource: 'ari' }];
    refuses(() => scoreAssignment(rosterProblem(), rules, swapped), 'JN0016', '/rules/fussy/resources/ari');
    refuses(() => evaluator.whatIf({ op: 'move', task: 'mon-late', slot: 'crew', from: 'sam', to: 'ari' }), 'JN0016', '/rules/fussy/resources/ari');
    refuses(() => evaluator.apply({ op: 'move', task: 'mon-late', slot: 'crew', from: 'sam', to: 'ari' }), 'JN0016', '/rules/fussy/resources/ari');
    assert.strictEqual(evaluator.result, result);
    const fine = evaluator.apply({ op: 'unassign', task: 'mon-late', slot: 'crew', resource: 'sam' });
    assert.strictEqual(text(fine), text(scoreAssignment(rosterProblem(), rules, START.slice(0, 2))));
    // what full scoring answers past a limit comes before the throw it never reaches
    const limited = createEvaluator(rosterProblem(), rules, START, { limits: { maxUnits: 0 } });
    const stopped = limited.apply({ op: 'move', task: 'mon-late', slot: 'crew', from: 'sam', to: 'ari' });
    assert.strictEqual(text(stopped), text(scoreAssignment(rosterProblem(), rules, swapped, { limits: { maxUnits: 0 } })));
    assert.strictEqual(stopped.complete, false);
    // the failed unit is kept failed: the next edit is answered by full scoring too
    const scorings = limited.counts.fullScorings;
    limited.apply({ op: 'move', task: 'mon-late', slot: 'crew', from: 'ari', to: 'sam' });
    assert.strictEqual(limited.counts.fullScorings, scorings + 1);
  });

  it('a level that passes Number.MAX_SAFE_INTEGER on an edit turns decimal, and back, as full scoring encodes it', () => {
    const heavy = /** @type {any} */ ({ id: 'heavy', version: 1, level: 'soft', scope: 'resource',
      evaluate: (/** @type {any} */ view, /** @type {any} */ unit) => ({ matches: view.assignmentsOf(unit.id).map(() => ({ magnitude: 2 ** 52, messageId: 'heavy' })) }) });
    const rules = registerRules([heavy]);
    const one = [START[1]];
    const two = [START[1], START[2]];
    const evaluator = createEvaluator(rosterProblem(), rules, one);
    assert.strictEqual(/** @type {any} */ (evaluator.result).score.encoding.soft, 'number');
    const up = evaluator.apply({ op: 'assign', task: 'mon-late', slot: 'crew', resource: 'sam' });
    assert.strictEqual(text(up), text(scoreAssignment(rosterProblem(), rules, two)));
    assert.deepStrictEqual([/** @type {any} */ (up).score.encoding.soft, /** @type {any} */ (up).score.soft], ['decimal', String(-(2n ** 53n))]);
    const down = evaluator.apply({ op: 'unassign', task: 'mon-late', slot: 'crew', resource: 'sam' });
    assert.strictEqual(text(down), text(scoreAssignment(rosterProblem(), rules, one)));
    assert.strictEqual(/** @type {any} */ (down).score.encoding.soft, 'number');
  });

  it('a missing fact is reported for each answer as full scoring reports it', () => {
    const lacking = /** @type {any} */ ({ id: 'certified', version: 1, level: 'hard', scope: 'resource', reads: { facts: ['certificates'] }, evaluate: () => ({}) });
    const rules = registerRules([...REFERENCE_RULES, lacking]);
    const evaluator = createEvaluator(rosterProblem(), rules, START);
    const answer = evaluator.apply({ op: 'unassign', task: 'mon-early', slot: 'crew', resource: 'ari' });
    assert.strictEqual(text(answer), text(scoreAssignment(rosterProblem(), rules, [START[0], START[2]])));
    assert.ok(/** @type {any} */ (answer).unknowns.some((/** @type {any} */ u) => u.reason === 'missing-fact' && u.rule === 'certified' && u.unit === null));
  });
});

describe('the work of an edit does not grow with the problem', () => {
  it('over an 8x step in tasks and resources, the units evaluated per edit stay the same', () => {
    /** @param {number} tasks @param {number} resources */
    const perEdit = (tasks, resources) => {
      const { problem, assignments } = largeProblem(tasks, resources);
      const evaluator = createEvaluator(problem, ruleSet, assignments);
      const start = evaluator.counts.evaluated;
      let edits = 0;
      for (let i = 0; i < 40; i++) {
        const held = evaluator.assignments[(i * 7919) % evaluator.assignments.length];
        const to = `p${(Number(held.resource.slice(1)) + 3 + (i % 20)) % resources}`;
        try {
          evaluator.apply({ op: 'move', task: held.task, slot: held.slot, from: held.resource, to });
          edits++;
        }
        catch (error) {
          if (/** @type {any} */ (error).code !== 'JN0008') throw error;
        }
      }
      return { units: (evaluator.counts.evaluated - start) / edits, edits, scorings: evaluator.counts.fullScorings };
    };
    const small = perEdit(1000, 25);
    const large = perEdit(8000, 200);
    assert.ok(small.edits > 30 && large.edits > 30);
    assert.deepStrictEqual([small.scorings, large.scorings], [1, 1]);
    // one task row and two resource rows: 2 + 4 * 2 + 2 global
    assert.deepStrictEqual([small.units, large.units], [12, 12]);
  });
});
