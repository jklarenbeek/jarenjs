//@ts-check
/**
 * The view a rule evaluates against: frozen, answering frozen data in
 * code-unit or time order, reading only the facts the rule declares,
 * and counting every row it answers toward maxWork.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { admitProblem, registerRules, scoreAssignment, AssignError } from '@jarenjs/core/assign';
import { rosterProblem } from './fixtures.js';

/**
 * Run one probe rule over the roster problem and answer what it saw.
 * @param {(view: any, unit: any) => unknown} look
 * @param {object} [extra] - more of the declaration
 * @param {unknown[]} [assignments]
 */
function probe(look, extra = {}, assignments = [
  { task: 'mon-late', slot: 'crew', resource: 'ari' },
  { task: 'mon-early', slot: 'crew', resource: 'ari' },
  { task: 'mon-early', slot: 'lead', resource: 'nina' },
]) {
  /** @type {unknown[]} */
  const seen = [];
  const rules = registerRules([{ id: 'probe', version: 1, level: 'soft', scope: 'global', ...extra,
    evaluate(view, unit) {
      seen.push(look(view, unit));
      return {};
    } }]);
  const result = scoreAssignment(rosterProblem(), rules, assignments);
  return { seen, result };
}

describe('the rule view', () => {
  it('is frozen, and so is everything it answers; a rule cannot write through it', () => {
    const { seen } = probe((view) => {
      assert.ok(Object.isFrozen(view));
      assert.throws(() => { 'use strict'; view.extra = 1; }, TypeError);
      const list = view.assignments();
      assert.throws(() => { list.push({}); }, TypeError);
      assert.throws(() => { list[0].resource = 'sam'; }, TypeError);
      assert.throws(() => { view.task('mon-early').interval.start = 5; }, TypeError);
      return 'ok';
    });
    assert.deepStrictEqual(seen, ['ok']);
  });

  it('answers resources and tasks by id, assignments per resource in time order and per task by slot', () => {
    const { seen } = probe((view) => ({
      resources: view.resources().map((/** @type {any} */ r) => r.id),
      tasks: view.tasks().map((/** @type {any} */ t) => t.id),
      ari: view.assignmentsOf('ari').map((/** @type {any} */ a) => a.task),
      early: view.assignmentsFor('mon-early').map((/** @type {any} */ a) => `${a.slot}:${a.resource}`),
      nobody: view.assignmentsOf('sam'),
      lead: view.demand('mon-early', 'lead').count,
      missing: [view.resource('kim'), view.task('tue'), view.demand('mon-early', 'x')],
      stored: view.stored().map((/** @type {any} */ a) => a.lock),
      baseline: view.baseline().revision,
      attributes: view.attributes().minGap,
    }));
    assert.deepStrictEqual(seen, [{
      resources: ['ari', 'nina', 'sam'], tasks: ['mon-early', 'mon-late'],
      ari: ['mon-early', 'mon-late'], early: ['crew:ari', 'lead:nina'], nobody: [], lead: 1,
      missing: [undefined, undefined, undefined], stored: ['hard'], baseline: 'b-1', attributes: 60,
    }]);
    const bare = admitProblem({ revision: 1, resources: [], tasks: [] });
    const rules = registerRules([{ id: 'p', version: 1, level: 'soft', scope: 'global', evaluate(view) {
      assert.strictEqual(view.baseline(), null);
      assert.strictEqual(view.attributes(), null);
      return {};
    } }]);
    assert.strictEqual(scoreAssignment(bare, rules, []).complete, true);
  });

  it('finds the tasks overlapping a window exactly as a scan of every pair does', () => {
    const tasks = [];
    let state = 7;
    const next = (/** @type {number} */ n) => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n;
    for (let i = 0; i < 60; i++) {
      const start = next(500);
      tasks.push({ id: `t${i}`, revision: 1, interval: { start, end: start + 1 + next(i % 7 === 0 ? 300 : 20) }, demands: [] });
    }
    const problem = admitProblem({ revision: 1, resources: [], tasks });
    /** @type {[number, number][]} */
    const windows = [];
    for (let i = 0; i < 200; i++) {
      const start = next(600) - 50;
      windows.push([start, start + 1 + next(80)]);
    }
    const rules = registerRules([{ id: 'w', version: 1, level: 'soft', scope: 'global', evaluate(view) {
      for (const [start, end] of windows) {
        const got = view.tasksOverlapping(start, end).map((/** @type {any} */ t) => t.id);
        const want = [...tasks].filter((t) => t.interval.start < end && t.interval.end > start)
          .sort((a, b) => a.interval.start - b.interval.start || a.interval.end - b.interval.end || (a.id < b.id ? -1 : 1)).map((t) => t.id);
        assert.deepStrictEqual(got, want, `[${start}, ${end})`);
      }
      return {};
    } }]);
    assert.strictEqual(scoreAssignment(problem, rules, []).complete, true);
  });

  it('finds a task whose length is past the safe integers', () => {
    const wide = { id: 'wide', revision: 1, interval: { start: -(2 ** 52), end: 2 ** 52 + 1 }, demands: [] };
    const late = { id: 'late', revision: 1, interval: { start: 2 ** 52, end: 2 ** 52 + 2 }, demands: [] };
    const problem = admitProblem({ revision: 1, resources: [], tasks: [wide, late] });
    /** @type {string[][]} */
    const seen = [];
    const rules = registerRules([{ id: 'w', version: 1, level: 'soft', scope: 'global', evaluate(view) {
      seen.push(view.tasksOverlapping(2 ** 52, 2 ** 52 + 1).map((/** @type {any} */ t) => t.id));
      seen.push(view.tasksOverlapping(2 ** 52 + 1, 2 ** 52 + 2).map((/** @type {any} */ t) => t.id));
      return {};
    } }]);
    scoreAssignment(problem, rules, []);
    assert.deepStrictEqual(seen, [['wide', 'late'], ['late']]);
  });

  it('a window that is not safe integers with start before end throws out of the rule as JN0016 with the cause', () => {
    const rules = registerRules([{ id: 'w', version: 1, level: 'soft', scope: 'global', evaluate: (view) => view.tasksOverlapping(5, 5) }]);
    assert.throws(() => scoreAssignment(rosterProblem(), rules, []), (/** @type {any} */ error) =>
      error.code === 'JN0016' && error.cause instanceof AssignError && error.cause.code === 'JN0005');
  });

  it('reads a declared fact whole or by member, and refuses an undeclared one (JN0018)', () => {
    const { seen } = probe((view) => ({
      table: view.fact('availability').revision,
      sam: view.factRows('availability', 'resource', 'sam').map((/** @type {any} */ row) => row.state),
      again: view.factRows('availability', 'resource', 'nina').length,
      none: view.factRows('availability', 'resource', 'kim'),
      byState: view.factRows('availability', 'state', 'available').length,
      noMember: view.factRows('availability', 'colour', 'red'),
    }), { reads: { facts: ['availability'] } });
    assert.deepStrictEqual(seen, [{ table: 'av-1', sam: ['busy'], again: 1, none: [], byState: 2, noMember: [] }]);
    assert.throws(() => probe((view) => view.fact('preferences'), { reads: { facts: ['availability'] } }),
      (/** @type {any} */ error) => error instanceof AssignError && error.code === 'JN0018' && error.docPath === '/rules/probe/reads/facts');
    assert.throws(() => probe((view) => view.factRows('availability', 'resource', 'ari')),
      (/** @type {any} */ error) => error.code === 'JN0018');
  });

  it('counts each call and every row it answers as work', () => {
    const { result } = probe((view) => [view.assignments(), view.resource('ari'), view.factRows('availability', 'resource', 'sam')],
      { reads: { facts: ['availability'] } });
    // assignments: 1 + 3; resource: 1 + 1; factRows: index build 1 + 3, then 1 + 1.
    assert.strictEqual(result.counts.work, 4 + 2 + 4 + 2);
  });
});
