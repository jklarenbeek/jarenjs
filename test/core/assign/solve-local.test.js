//@ts-check
/**
 * `solve` with the `local` and `auto` strategies: locks, churn against a
 * baseline, repair after a withdrawn availability, the lexicographic
 * objective (hard and service, then churn, then soft), local optimality,
 * `auto` against `exhaustive`, budgets, restarts, the signal, status
 * truth, provenance and byte determinism (runs, key order, host zones).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createEvaluator, registerRules, scoreAssignment, solve, SOLVE_LIMITS } from '@jarenjs/core/assign';
import { REFERENCE_RULES, coverageMin } from './rules/reference.js';
import { tinyInstance } from './oracle/instances.js';
import { brokenFixed, oneFixed, rosterFixture, ROSTER_RULES } from './solve-fixtures.js';
import { shuffled } from './fixtures.js';
import { keyOf, rawChurn, rawObjective, REPAIR_RULES, rosterRepair, withLocks } from './local-fixtures.js';

const reference = registerRules(REFERENCE_RULES);
const repairRules = registerRules(REPAIR_RULES);
const CHILD = fileURLToPath(new URL('./solve-local-child.js', import.meta.url));
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

/** A tiny instance repaired: its construct fill, locked by a seed, as its own list and its baseline, and its first resource now busy throughout. @param {number} seed */
function tinyRepair(seed) {
  const raw = tinyInstance(seed);
  const fill = solve(raw, reference, { strategy: 'construct', seed });
  const list = withLocks(fill.best.map((item) => ({ ...item })), seed);
  const problem = structuredClone(raw);
  problem.assignments = list;
  problem.baseline = { revision: `b${seed}`, assignments: list.map(({ task, slot, resource }) => ({ task, slot, resource })) };
  const rows = problem.facts.availability?.rows ?? [];
  problem.facts.availability = { revision: 'changed', rows: [...rows, { resource: raw.resources[0].id, start: 0, end: 1000, state: 'busy' }] };
  return problem;
}

/**
 * Hold a local or auto answer to what every answer owes: the score is a
 * fresh scoring of `best` to the byte; the status is never a proof; the
 * churn, when the problem has a baseline, is the raw diff; `added` and
 * `removed` are `best` against the problem's own list.
 * @param {any} problem @param {any} rules @param {any} result
 */
function holds(problem, rules, result) {
  assert.strictEqual(text(result.score), text(scoreAssignment(problem, rules, result.best)));
  if (result.provenance.algorithm !== 'exhaustive') assert.ok(!['optimal', 'infeasible'].includes(result.status), result.status);
  if (problem.baseline === undefined) assert.ok(!('churn' in result));
  else assert.strictEqual(text(result.churn), text(rawChurn(problem.baseline.assignments, result.best)));
  const own = new Set((problem.assignments ?? []).map(keyOf));
  const best = new Set(result.best.map(keyOf));
  assert.deepStrictEqual(result.added.map(keyOf).sort(), [...best].filter((key) => !own.has(key)).sort());
  assert.deepStrictEqual(result.removed.map(keyOf).sort(), [...own].filter((key) => !best.has(key)).sort());
}

/**
 * Every hard lock of the problem's own list is in `best` with its lock,
 * and so is every soft lock whose change churn could not count; and
 * `best` makes no lock: each locked assignment in it is one the
 * problem's list holds with that same lock.
 * @param {any} problem @param {any} result
 */
function locksHeld(problem, result) {
  const best = new Map(result.best.map((/** @type {any} */ item) => [keyOf(item), item]));
  const locked = new Set((problem.assignments ?? []).filter((/** @type {any} */ item) => item.lock !== undefined).map((/** @type {any} */ item) => `${keyOf(item)}|${item.lock}`));
  for (const item of result.best) if (item.lock !== undefined) assert.ok(locked.has(`${keyOf(item)}|${item.lock}`), `best makes a lock: ${keyOf(item)} ${item.lock}`);
  const base = new Set((problem.baseline?.assignments ?? []).map(keyOf));
  for (const item of problem.assignments ?? []) {
    const kept = best.get(keyOf(item));
    if (item.lock === 'hard') assert.strictEqual(kept?.lock, 'hard', `hard lock ${keyOf(item)} changed`);
    if (item.lock === 'soft' && kept?.lock !== 'soft') {
      assert.ok(base.has(keyOf(item)), `soft lock ${keyOf(item)} changed with no baseline entry to count it`);
      const listed = [...result.churn.removed.map(keyOf), ...result.churn.moved.map((/** @type {any} */ m) => keyOf({ task: m.task, slot: m.slot, resource: m.from }))];
      assert.ok(listed.includes(keyOf(item)), `soft lock ${keyOf(item)} changed without churn listing it`);
    }
  }
}

describe('solve local: locks', () => {
  it('never changes a hard lock, and changes a soft lock only as churn, over seeded streams of repairs', () => {
    let softChanged = 0;
    let runs = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const problem = tinyRepair(seed);
      for (const options of [{}, { seed }, { seed: seed + 100, budgets: { maxRestarts: 2 } }, { seed, budgets: { maxMoves: 1 + seed * 7 } }]) {
        const result = solve(problem, reference, { strategy: 'local', ...options });
        holds(problem, reference, result);
        locksHeld(problem, result);
        softChanged += problem.assignments.filter((/** @type {any} */ item) => item.lock === 'soft' && !result.best.some((/** @type {any} */ b) => keyOf(b) === keyOf(item))).length;
        runs++;
      }
    }
    for (const seed of [1, 2, 3]) {
      const { problem } = rosterRepair(seed, 's3', 7, 12);
      problem.assignments = withLocks(problem.assignments, seed);
      for (const options of [{}, { seed, budgets: { maxRestarts: 2 } }, { seed: seed + 1000, budgets: { maxRestarts: 3 } }]) {
        const result = solve(problem, repairRules, { strategy: 'local', ...options });
        holds(problem, repairRules, result);
        locksHeld(problem, result);
        runs++;
      }
    }
    assert.strictEqual(runs, 129);
    assert.ok(softChanged > 0, 'no stream changed a soft lock: the property would not bite');
  });

  it('keeps a hard-locked forbidden assignment, and answers unknown, never infeasible', () => {
    const { problem } = rosterRepair(2, 's3');
    problem.assignments = problem.assignments.map((/** @type {any} */ item) => (item.resource === 's3' ? { ...item, lock: 'hard' } : item));
    const result = solve(problem, repairRules, { strategy: 'local' });
    holds(problem, repairRules, result);
    locksHeld(problem, result);
    assert.strictEqual(result.score.verdict, 'infeasible-by-validation');
    assert.strictEqual(result.status, 'unknown');
    const stopped = solve(problem, repairRules, { strategy: 'local', budgets: { maxMoves: 50 } });
    assert.strictEqual(stopped.status, 'limit');
    assert.strictEqual(stopped.score.verdict, 'infeasible-by-validation');
  });

  it('moves a soft lock with a baseline (listed in the churn) and holds it without one', () => {
    const { problem } = rosterRepair(2, 's3');
    problem.assignments = problem.assignments.map((/** @type {any} */ item) => (item.resource === 's3' ? { ...item, lock: 'soft' } : item));
    const repaired = solve(problem, repairRules, { strategy: 'local' });
    locksHeld(problem, repaired);
    assert.strictEqual(repaired.score.score.hard, 0);
    assert.ok(repaired.best.every((/** @type {any} */ item) => item.resource !== 's3'));
    const changed = [...repaired.churn.removed, ...repaired.churn.moved.map((/** @type {any} */ m) => ({ resource: m.from }))];
    assert.strictEqual(changed.filter((item) => item.resource === 's3').length, problem.assignments.filter((/** @type {any} */ item) => item.resource === 's3').length);
    const bare = structuredClone(problem);
    delete bare.baseline;
    const held = solve(bare, repairRules, { strategy: 'local' });
    holds(bare, repairRules, held);
    for (const item of problem.assignments.filter((/** @type {any} */ item) => item.lock === 'soft'))
      assert.ok(held.best.some((/** @type {any} */ b) => keyOf(b) === keyOf(item) && b.lock === 'soft'));
    const elsewhere = structuredClone(problem);
    elsewhere.baseline.assignments = elsewhere.baseline.assignments.filter((/** @type {any} */ item) => item.resource !== 's3');
    const kept = solve(elsewhere, repairRules, { strategy: 'local' });
    holds(elsewhere, repairRules, kept);
    for (const item of problem.assignments.filter((/** @type {any} */ item) => item.lock === 'soft'))
      assert.ok(kept.best.some((/** @type {any} */ b) => keyOf(b) === keyOf(item) && b.lock === 'soft'));
  });

  it('moves a soft-locked assignment to a resource with no lock, and makes no lock anywhere', () => {
    const problem = {
      revision: 1, resources: ['ada', 'bo', 'cy'].map((id) => ({ id, revision: 1 })),
      tasks: [
        { id: 'room-1', revision: 1, interval: { start: 0, end: 60 }, demands: [{ slot: 'host', count: 1 }] },
        { id: 'room-2', revision: 1, interval: { start: 100, end: 160 }, demands: [{ slot: 'host', count: 1 }] },
      ],
      facts: { away: { revision: 2, rows: [{ resource: 'ada' }] } },
      assignments: [{ task: 'room-1', slot: 'host', resource: 'ada', lock: 'soft' }, { task: 'room-2', slot: 'host', resource: 'bo', lock: 'soft' }],
      baseline: { revision: 'published', assignments: [{ task: 'room-1', slot: 'host', resource: 'ada' }, { task: 'room-2', slot: 'host', resource: 'bo' }] },
    };
    const notAway = {
      id: 'not-away', version: 1, level: /** @type {const} */ ('hard'), scope: /** @type {const} */ ('resource'), reads: { facts: ['away'] },
      evaluate(/** @type {any} */ view, /** @type {any} */ unit) {
        if (view.factRows('away', 'resource', unit.id).length === 0) return {};
        return { matches: view.assignmentsOf(unit.id).map((/** @type {any} */ a) => ({ magnitude: 1, messageId: 'away', subjects: { resources: [unit.id], tasks: [a.task] } })) };
      },
    };
    const rules = registerRules([notAway, coverageMin]);
    const result = solve(problem, rules, { strategy: 'local' });
    holds(problem, rules, result);
    locksHeld(problem, result);
    assert.strictEqual(text(result.churn.moved), text([{ from: 'ada', slot: 'host', task: 'room-1', to: 'bo' }]));
    assert.strictEqual(text(result.best), text([{ resource: 'bo', slot: 'host', task: 'room-1' }, { lock: 'soft', resource: 'bo', slot: 'host', task: 'room-2' }]));
    // the evaluator's own move would have carried the lock: local made it as an unassign and an assign
    const evaluator = createEvaluator(problem, rules, problem.assignments);
    evaluator.apply({ op: 'move', task: 'room-1', slot: 'host', from: 'ada', to: 'bo' });
    assert.strictEqual(evaluator.assignments[0].lock, 'soft');
    evaluator.close();
    const bothAway = structuredClone(problem);
    bothAway.facts.away.rows = [{ resource: 'ada' }, { resource: 'cy' }];
    bothAway.tasks[1].interval = { start: 0, end: 60 };
    bothAway.assignments[1] = { task: 'room-2', slot: 'host', resource: 'cy' };
    bothAway.baseline.assignments[1] = { task: 'room-2', slot: 'host', resource: 'cy' };
    const again = solve(bothAway, rules, { strategy: 'local' });
    holds(bothAway, rules, again);
    locksHeld(bothAway, again);
    assert.ok(again.best.every((/** @type {any} */ item) => item.lock === undefined), text(again.best));
    // a split edit is made whole or not at all, and never past the budget
    const full = solve(problem, rules, { strategy: 'local' });
    for (let maxMoves = 1; maxMoves <= full.counts.moves; maxMoves++) {
      const stopped = solve(problem, rules, { strategy: 'local', budgets: { maxMoves } });
      assert.ok(stopped.counts.moves <= maxMoves, `${stopped.counts.moves} moves past ${maxMoves}`);
      holds(problem, rules, stopped);
      locksHeld(problem, stopped);
    }
  });

  it('gives a soft lock back when a restart takes it away and the descent makes it again', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const problem = tinyRepair(seed);
      const result = solve(problem, reference, { strategy: 'local', seed, budgets: { maxRestarts: 4 } });
      const own = new Map(problem.assignments.map((/** @type {any} */ item) => [keyOf(item), item.lock]));
      for (const item of result.best) if (own.has(keyOf(item)) && item.lock !== own.get(keyOf(item)) && item.lock === undefined)
        assert.fail(`${keyOf(item)} came back without its lock`);
    }
  });
});

describe('solve local: repair after a withdrawn availability', () => {
  for (const [seed, options] of /** @type {[number, any][]} */ ([[1, {}], [2, {}], [4, {}], [2, { seed: 5, budgets: { maxRestarts: 3 } }]])) {
    it(`roster ${seed} ${text(options)}: changes only what a rule now forbids and what the objective strictly prefers; churn is the diff`, () => {
      const { problem, published } = rosterRepair(seed, 's3');
      const result = solve(problem, repairRules, { strategy: 'local', ...options });
      holds(problem, repairRules, result);
      assert.strictEqual(result.status, 'feasible');
      assert.strictEqual(result.score.score.hard, 0);
      const forbidden = published.filter((item) => item.resource === 's3');
      assert.ok(forbidden.length > 0);
      const churn = rawChurn(published, result.best);
      assert.strictEqual(result.churn.total, churn.total);
      assert.ok(churn.total >= forbidden.length);
      const baseNow = scoreAssignment(problem, repairRules, published);
      assert.ok(baseNow.score.hard < 0);
      // Every change that is not one of the forbidden assignments is one
      // the objective strictly prefers: taking it back alone is worse.
      const evaluator = createEvaluator(problem, repairRules, result.best);
      const changes = [
        ...result.churn.added.map((/** @type {any} */ a) => ({ edit: { op: 'unassign', task: a.task, slot: a.slot, resource: a.resource }, from: null })),
        ...result.churn.moved.map((/** @type {any} */ m) => ({ edit: { op: 'move', task: m.task, slot: m.slot, from: m.to, to: m.from }, from: m.from })),
        ...result.churn.removed.map((/** @type {any} */ r) => ({ edit: { op: 'assign', task: r.task, slot: r.slot, resource: r.resource }, from: r.resource })),
      ];
      let reversed = 0;
      for (const { edit, from } of changes) {
        if (from === 's3') continue;
        let back;
        try {
          back = evaluator.whatIf(/** @type {any} */ (edit));
        }
        catch {
          continue;
        }
        const list = applyRaw(result.best, edit);
        assert.strictEqual(rawObjective(back, rawChurn(published, list).total, result.score, churn.total), -1, `${text(edit)} is not strictly preferred`);
        reversed++;
      }
      evaluator.close();
      const named = [...churn.removed.map((r) => r.resource), ...churn.moved.map((m) => m.from)];
      if (options.budgets === undefined) {
        // Without restarts every change is one of the withdrawn person's assignments, each one changed once.
        assert.strictEqual(reversed, 0);
        assert.deepStrictEqual(churn.added, []);
        assert.ok(named.every((resource) => resource === 's3'), text(churn));
        assert.strictEqual(churn.total, forbidden.length);
      }
      else assert.ok(reversed > 0, 'no change past the forbidden ones was checked');
    });
  }

  it('a churn-free change is never taken at the cost of churn: soft gains wait behind churn, service gains do not', () => {
    const base = {
      revision: 1, resources: [{ id: 'a', revision: 1 }, { id: 'b', revision: 1 }],
      tasks: [{ id: 'room-1', revision: 1, interval: { start: 0, end: 10 }, demands: [{ slot: 'host', count: 1 }] }],
      assignments: [{ task: 'room-1', slot: 'host', resource: 'a' }],
      baseline: { revision: 'published', assignments: [{ task: 'room-1', slot: 'host', resource: 'a' }] },
    };
    const dislikesA = (/** @type {'soft' | 'service'} */ level) => registerRules([coverageMin, {
      id: `avoid-a-${level}`, version: 1, level, scope: 'task',
      evaluate(view, unit) {
        return { matches: view.assignmentsFor(/** @type {string} */ (unit.id)).filter((item) => item.resource === 'a').map(() => ({ magnitude: 1, messageId: 'a', subjects: { resources: ['a'], tasks: [/** @type {string} */ (unit.id)] } })) };
      },
    }]);
    const soft = solve(base, dislikesA('soft'), { strategy: 'local' });
    assert.strictEqual(soft.churn.total, 0);
    assert.strictEqual(soft.best[0].resource, 'a');
    const service = solve(base, dislikesA('service'), { strategy: 'local' });
    assert.strictEqual(text(service.churn.moved), text([{ from: 'a', slot: 'host', task: 'room-1', to: 'b' }]));
    const { baseline: _, ...noBaseline } = base;
    const free = solve(noBaseline, dislikesA('soft'), { strategy: 'local' });
    assert.strictEqual(free.best[0].resource, 'b');
    assert.ok(!('churn' in free));
  });

  it('a host that wants churn scored writes a rule that reads baseline(); the score holds it and churn stays its own member', () => {
    const { problem } = rosterRepair(2, 's3');
    const churnRule = {
      id: 'churn-penalty', version: 1, level: /** @type {const} */ ('soft'), scope: /** @type {const} */ ('global'),
      evaluate(/** @type {any} */ view) {
        const base = new Set((view.baseline()?.assignments ?? []).map(keyOf));
        const now = view.assignments();
        const kept = now.filter((/** @type {any} */ item) => base.has(keyOf(item))).length;
        const changes = Math.max(base.size - kept, now.length - kept);
        return changes === 0 ? {} : { matches: [{ magnitude: changes, messageId: 'churn', subjects: {} }] };
      },
    };
    const rules = registerRules([...REPAIR_RULES, churnRule]);
    const result = solve(problem, rules, { strategy: 'local' });
    holds(problem, rules, result);
    const penalty = result.score.matches.find((/** @type {any} */ m) => m.rule === 'churn-penalty');
    assert.strictEqual(penalty?.magnitude, result.churn.total);
    const plain = solve(problem, repairRules, { strategy: 'local' });
    assert.notStrictEqual(text(plain.score.score), text(result.score.score));
    assert.ok(!plain.score.matches.some((/** @type {any} */ m) => m.rule === 'churn-penalty'));
  });
});

/** @param {readonly any[]} list @param {any} edit */
function applyRaw(list, edit) {
  const out = list.map(({ task, slot, resource }) => ({ task, slot, resource }));
  if (edit.op === 'assign') return [...out, { task: edit.task, slot: edit.slot, resource: edit.resource }];
  if (edit.op === 'unassign') return out.filter((item) => keyOf(item) !== keyOf(edit));
  if (edit.op === 'swap') return out.map((item) => (keyOf(item) === keyOf(edit.a) ? { ...item, resource: edit.b.resource } : keyOf(item) === keyOf(edit.b) ? { ...item, resource: edit.a.resource } : item));
  return out.map((item) => (item.task === edit.task && item.slot === edit.slot && item.resource === edit.from ? { ...item, resource: edit.to } : item));
}

describe('solve local: churn', () => {
  it('lists every change exactly, pairs a slot in id order and counts per resource and per task', () => {
    const resources = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, revision: 1 }));
    const allowed = /** @type {Record<string, string[]>} */ ({ 'room-1/host': ['d', 'e', 'c'], 'room-2/host': [], 'room-3/host': ['a'] });
    const onlyListed = {
      id: 'only-listed', version: 1, level: /** @type {const} */ ('hard'), scope: /** @type {const} */ ('task'),
      evaluate(/** @type {any} */ view, /** @type {any} */ unit) {
        return { matches: view.assignmentsFor(unit.id).filter((/** @type {any} */ item) => !allowed[`${item.task}/${item.slot}`].includes(item.resource))
          .map((/** @type {any} */ item) => ({ magnitude: 1, messageId: 'not-listed', subjects: { resources: [item.resource], tasks: [item.task] } })) };
      },
    };
    const problem = {
      revision: 1, resources,
      tasks: ['room-1', 'room-2', 'room-3'].map((id, i) => ({ id, revision: 1, interval: { start: i * 10, end: i * 10 + 5 }, demands: [{ slot: 'host', count: 3 }] })),
      assignments: [{ task: 'room-1', slot: 'host', resource: 'c' }, { task: 'room-1', slot: 'host', resource: 'd' }, { task: 'room-1', slot: 'host', resource: 'e' }, { task: 'room-3', slot: 'host', resource: 'a' }],
      baseline: { revision: 'v7', assignments: [
        { task: 'room-1', slot: 'host', resource: 'a' }, { task: 'room-1', slot: 'host', resource: 'b' }, { task: 'room-1', slot: 'host', resource: 'c' },
        { task: 'room-2', slot: 'host', resource: 'a' }, { task: 'room-2', slot: 'host', resource: 'b' },
      ] },
    };
    const result = solve(problem, registerRules([onlyListed, coverageMin]), { strategy: 'local' });
    assert.strictEqual(text(result.best.map(keyOf)), text(problem.assignments.map(keyOf)));
    assert.strictEqual(text(result.churn), text({
      added: [{ resource: 'a', slot: 'host', task: 'room-3' }],
      byResource: [{ count: 3, resource: 'a' }, { count: 2, resource: 'b' }, { count: 1, resource: 'd' }, { count: 1, resource: 'e' }],
      byTask: [{ count: 2, task: 'room-1' }, { count: 2, task: 'room-2' }, { count: 1, task: 'room-3' }],
      moved: [{ from: 'a', slot: 'host', task: 'room-1', to: 'd' }, { from: 'b', slot: 'host', task: 'room-1', to: 'e' }],
      removed: [{ resource: 'a', slot: 'host', task: 'room-2' }, { resource: 'b', slot: 'host', task: 'room-2' }],
      total: 5,
    }));
    assert.strictEqual(text(result.churn), text(rawChurn(problem.baseline.assignments, result.best)));
    assert.strictEqual(result.provenance.baseline, 'v7');
  });

  it('is counted against the baseline, not the list the search started from', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const problem = tinyRepair(seed);
      problem.baseline.assignments = problem.baseline.assignments.slice(1);
      const result = solve(problem, reference, { strategy: 'local', seed });
      holds(problem, reference, result);
    }
  });

  it('is absent without a baseline, for local and auto', () => {
    const problem = oneFixed(tinyInstance(4));
    for (const strategy of /** @type {const} */ (['local', 'auto'])) {
      const result = solve(problem, reference, { strategy });
      assert.ok(!('churn' in result));
      assert.strictEqual(result.provenance.baseline, null);
    }
  });
});

describe('solve local: the search', () => {
  it('ends at a local optimum: no single edit it offers is strictly better', () => {
    let checked = 0;
    const cases = [];
    for (let seed = 1; seed <= 30; seed++) cases.push({ seed, problem: tinyRepair(seed), rules: reference });
    cases.push({ seed: 31, problem: rosterRepair(1, 's3', 7, 12).problem, rules: repairRules });
    for (const { seed, problem, rules } of cases) {
      const result = solve(problem, rules, { strategy: 'local' });
      assert.strictEqual(result.status === 'limit', false);
      const held = new Set(problem.assignments.filter((/** @type {any} */ item) => item.lock === 'hard' || item.lock === 'soft' && !problem.baseline.assignments.some((/** @type {any} */ b) => keyOf(b) === keyOf(item))).map(keyOf));
      const evaluator = createEvaluator(problem, rules, result.best);
      const total = result.churn.total;
      const holders = (/** @type {string} */ task, /** @type {string} */ slot) => result.best.filter((/** @type {any} */ item) => item.task === task && item.slot === slot).map((/** @type {any} */ item) => item.resource);
      const edits = [];
      for (const task of problem.tasks)
        for (const demand of task.demands) {
          const here = holders(task.id, demand.slot);
          for (const r of problem.resources) {
            if (here.length < demand.count && !here.includes(r.id)) edits.push({ op: 'assign', task: task.id, slot: demand.slot, resource: r.id });
          }
        }
      for (const item of result.best) {
        if (held.has(keyOf(item))) continue;
        edits.push({ op: 'unassign', task: item.task, slot: item.slot, resource: item.resource });
        for (const r of problem.resources) if (!holders(item.task, item.slot).includes(r.id)) edits.push({ op: 'move', task: item.task, slot: item.slot, from: item.resource, to: r.id });
        for (const other of result.best)
          if (!held.has(keyOf(other)) && other.resource !== item.resource && (other.task !== item.task || other.slot !== item.slot)
            && !holders(item.task, item.slot).includes(other.resource) && !holders(other.task, other.slot).includes(item.resource))
            edits.push({ op: 'swap', a: { task: item.task, slot: item.slot, resource: item.resource }, b: { task: other.task, slot: other.slot, resource: other.resource } });
      }
      for (const edit of edits) {
        const after = evaluator.whatIf(/** @type {any} */ (edit));
        assert.notStrictEqual(rawObjective(after, rawChurn(problem.baseline.assignments, applyRaw(result.best, edit)).total, result.score, total), 1, `seed ${seed}: ${text(edit)} is better`);
        checked++;
      }
      evaluator.close();
    }
    assert.ok(checked > 800, String(checked));
  });

  it('changes nothing when it starts at a local optimum: it never takes a worse edit', () => {
    let changed = 0;
    for (let seed = 85; seed <= 100; seed++) {
      const problem = tinyRepair(seed);
      const first = solve(problem, reference, { strategy: 'local', seed: seed + 1000, budgets: { maxRestarts: 3 } });
      const again = structuredClone(problem);
      again.assignments = first.best.map((item) => ({ ...item }));
      const second = solve(again, reference, { strategy: 'local' });
      assert.strictEqual(text(second.best), text(first.best), `seed ${seed}`);
      assert.deepStrictEqual([second.added, second.removed], [[], []]);
      if (first.removed.length + first.added.length > 0) changed++;
    }
    assert.ok(changed > 0);
  });

  it('breaks a tie between equally good edits with the seed, and by id order without one', () => {
    const problem = {
      revision: 1, resources: ['k', 'l', 'm', 'n'].map((id) => ({ id, revision: 1 })),
      tasks: [{ id: 'slot-9', revision: 1, interval: { start: 0, end: 60 }, demands: [{ slot: 'driver', count: 1 }] }],
    };
    const rules = registerRules([coverageMin]);
    assert.strictEqual(solve(problem, rules, { strategy: 'local' }).best[0].resource, 'k');
    const picks = new Set();
    for (let seed = 0; seed < 16; seed++) picks.add(solve(problem, rules, { strategy: 'local', seed }).best[0].resource);
    assert.ok(picks.size >= 3, [...picks].join());
  });

  it('starts from the problem\'s own list and never answers a proof', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const broken = brokenFixed(tinyInstance(seed));
      for (const problem of [tinyInstance(seed), oneFixed(tinyInstance(seed)), ...(broken === null ? [] : [broken])]) {
        const result = solve(problem, reference, { strategy: 'local', seed });
        holds(problem, reference, result);
        const start = scoreAssignment(problem, reference, problem.assignments ?? []);
        assert.notStrictEqual(rawObjective(start, null, result.score, null), 1);
        assert.strictEqual(result.provenance.algorithm, 'local');
      }
    }
  });
});

describe('solve counts the evaluator\'s full fallbacks', () => {
  // a rule that reads outside its row and matches nothing: the search walks the same path,
  // and every evaluator answer it asks for re-evaluates that rule over every unit
  const outside = (/** @type {string} */ id) => /** @type {any} */ ({ id, version: 1, level: 'soft', scope: 'resource',
    evaluate(/** @type {any} */ view) {
      view.assignments();
      return { matches: [] };
    } });
  it('one per moving answer for each such rule, and none for rules that keep to their row', () => {
    const plain = registerRules(ROSTER_RULES);
    const one = registerRules([...ROSTER_RULES, outside('wide')]);
    const two = registerRules([...ROSTER_RULES, outside('wide'), outside('wider')]);
    for (const strategy of /** @type {const} */ (['construct', 'local', 'auto'])) {
      for (const seed of [1, 2]) {
        const problem = rosterFixture(seed, 4, 6);
        const options = { strategy, seed, budgets: { maxMoves: 3000 } };
        const base = solve(problem, plain, options);
        const once = solve(problem, one, options);
        const twice = solve(problem, two, options);
        assert.strictEqual(base.counts.fullFallbacks, 0, `${strategy} ${seed}`);
        assert.strictEqual(text(once.best), text(base.best), `${strategy} ${seed}`);
        assert.ok(base.counts.moves > 0);
        assert.strictEqual(once.counts.fullFallbacks, base.counts.moves, `${strategy} ${seed}`);
        assert.strictEqual(twice.counts.fullFallbacks, 2 * base.counts.moves, `${strategy} ${seed}`);
      }
    }
  });

  it('is not on an exhaustive answer, whose budget counts candidates', () => {
    const answer = solve(oneFixed(tinyInstance(1)), reference, { strategy: 'exhaustive' });
    assert.strictEqual('fullFallbacks' in answer.counts, false);
  });
});

describe('solve auto', () => {
  it('within the limit runs exhaustive and answers exactly what exhaustive answers', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const problem = oneFixed(tinyInstance(seed));
      const auto = /** @type {any} */ (solve(problem, reference, { strategy: 'auto', seed }));
      const exact = /** @type {any} */ (solve(problem, reference, { strategy: 'exhaustive' }));
      for (const member of ['status', 'best', 'added', 'score', 'bound']) assert.strictEqual(text(auto[member]), text(exact[member]), `seed ${seed} ${member}`);
      const { restarts, editWork, fullFallbacks, ...counts } = auto.counts;
      assert.strictEqual(text(counts), text(exact.counts));
      assert.strictEqual(restarts, 0);
      assert.ok(editWork > 0);
      assert.strictEqual(fullFallbacks, 0);
      assert.strictEqual(auto.provenance.algorithm, 'exhaustive');
      assert.strictEqual(auto.provenance.strategy, 'auto');
      assert.deepStrictEqual(auto.removed, []);
    }
  });

  it('past the limit runs construct and then local over the same space, and says so', () => {
    const problem = rosterFixture(3);
    const untrained = /** @type {string} */ (problem.resources.find((/** @type {any} */ r) => !r.attributes.skills.includes('first-aid'))?.id);
    problem.assignments = [{ task: 'shift-0', slot: 'lead', resource: 's4', lock: 'soft' }, { task: 'shift-5', slot: 'crew', resource: 's7' }, { task: 'shift-6', slot: 'lead', resource: untrained }];
    problem.baseline = { revision: 'last-week', assignments: [{ task: 'shift-1', slot: 'lead', resource: 's2' }] };
    const rules = registerRules(ROSTER_RULES);
    refuses(() => solve(problem, rules, { strategy: 'exhaustive' }), 'JN0024');
    const auto = /** @type {any} */ (solve(problem, rules, { strategy: 'auto', seed: 3 }));
    holds(problem, rules, auto);
    assert.strictEqual(auto.provenance.algorithm, 'construct+local');
    assert.strictEqual(auto.counts.space, null);
    for (const own of problem.assignments)
      assert.ok(auto.best.some((/** @type {any} */ item) => keyOf(item) === keyOf(own) && item.lock === own.lock), 'a fill keeps the problem\'s own list');
    assert.deepStrictEqual(auto.removed, []);
    assert.strictEqual(auto.score.verdict, 'infeasible-by-validation', 'a fill keeps an assignment a hard rule forbids');
    assert.strictEqual(auto.status, 'unknown');
    const greedy = solve(problem, rules, { strategy: 'construct', seed: 3 });
    assert.notStrictEqual(rawObjective(greedy.score, null, auto.score, null), 1);
    assert.ok(auto.counts.nodes > greedy.counts.nodes && auto.counts.moves > greedy.counts.moves, 'local did not run after construct');
    const repaired = solve(problem, rules, { strategy: 'local', seed: 3 });
    assert.ok(!repaired.best.some((/** @type {any} */ item) => item.resource === untrained && item.slot === 'lead'), 'local repairs what auto keeps');
    const stopped = /** @type {any} */ (solve(problem, rules, { strategy: 'auto', seed: 3, budgets: { maxMoves: 30 } }));
    assert.strictEqual(stopped.provenance.algorithm, 'construct');
    assert.strictEqual(stopped.status, 'limit');
    assert.ok(SOLVE_LIMITS.maxSpace === 100000);
  });
});

describe('solve local: budgets, restarts and the signal', () => {
  const { problem } = rosterRepair(1, 's3', 7, 12);

  it('stops at exactly maxMoves and maxNodes, and answers limit with the best it held', () => {
    for (const maxMoves of [1, 9, 120]) {
      const result = solve(problem, repairRules, { strategy: 'local', budgets: { maxMoves } });
      assert.strictEqual(result.counts.moves, maxMoves);
      assert.strictEqual(result.status, 'limit');
      holds(problem, repairRules, result);
    }
    for (const maxNodes of [1, 5]) {
      const result = solve(problem, repairRules, { strategy: 'local', budgets: { maxNodes } });
      assert.strictEqual(result.counts.nodes, maxNodes);
      assert.strictEqual(result.status, 'limit');
    }
    const full = solve(problem, repairRules, { strategy: 'local' });
    assert.strictEqual(full.status, 'feasible');
    const exact = solve(problem, repairRules, { strategy: 'local', budgets: { maxMoves: full.counts.moves } });
    assert.strictEqual(text(exact.best), text(full.best));
  });

  it('counts edit work as the evaluator\'s rule evaluations and stops before a move past maxEditWork', () => {
    const full = solve(problem, repairRules, { strategy: 'local' });
    const first = createEvaluator(problem, repairRules, problem.assignments).counts.evaluated;
    assert.ok(full.counts.editWork > first);
    const none = solve(problem, repairRules, { strategy: 'local', budgets: { maxEditWork: first } });
    assert.strictEqual(none.counts.moves, 0);
    assert.strictEqual(none.status, 'limit');
    assert.deepStrictEqual(none.best.map(keyOf).sort(), problem.assignments.map(keyOf).sort());
    for (const maxEditWork of [first + 1, first + 500]) {
      const some = solve(problem, repairRules, { strategy: 'local', budgets: { maxEditWork } });
      assert.strictEqual(some.status, 'limit');
      assert.ok(some.counts.editWork >= maxEditWork && some.counts.moves > 0);
      const step = solve(problem, repairRules, { strategy: 'local', budgets: { maxMoves: some.counts.moves } });
      assert.strictEqual(step.counts.editWork, some.counts.editWork);
    }
    assert.strictEqual(solve(problem, repairRules, { strategy: 'local', budgets: { maxEditWork: full.counts.editWork + 1 } }).status, 'feasible');
  });

  it('makes exactly maxRestarts seeded restarts, each counted, and keeps the best list', () => {
    const plain = solve(problem, repairRules, { strategy: 'local', seed: 7 });
    assert.strictEqual(plain.counts.restarts, 0);
    for (const maxRestarts of [1, 3]) {
      const result = solve(problem, repairRules, { strategy: 'local', seed: 7, budgets: { maxRestarts } });
      assert.strictEqual(result.counts.restarts, maxRestarts);
      assert.ok(result.counts.moves > plain.counts.moves);
      assert.notStrictEqual(rawObjective(plain.score, plain.churn.total, result.score, result.churn.total), 1, 'a restart lost the best list');
      assert.strictEqual(result.status, 'feasible');
      assert.strictEqual(result.provenance.budgets.maxRestarts, maxRestarts);
    }
    const a = solve(problem, repairRules, { strategy: 'local', seed: 7, budgets: { maxRestarts: 3 } });
    const b = solve(problem, repairRules, { strategy: 'local', seed: 8, budgets: { maxRestarts: 3 } });
    assert.notStrictEqual(text(a.counts), text(b.counts), 'the perturbation does not follow the seed');
  });

  it('answers limit with cancelled for an abort before the call, from a rule, and inside a restart, holding the best list', () => {
    const pre = solve(problem, repairRules, { strategy: 'local', signal: { aborted: true } });
    assert.strictEqual(pre.status, 'limit');
    assert.strictEqual(pre.cancelled, true);
    assert.strictEqual(pre.counts.moves, 0);
    const descent = solve(problem, repairRules, { strategy: 'local', seed: 7 });
    for (const at of [40, 2000, descent.counts.editWork + 300]) {
      const signal = { aborted: false };
      let calls = 0;
      const tripwire = { id: 'tripwire', version: 1, level: /** @type {const} */ ('soft'), scope: /** @type {const} */ ('task'), evaluate() {
        if (++calls >= at) signal.aborted = true;
        return {};
      } };
      const rules = registerRules([...REPAIR_RULES, tripwire]);
      const result = solve(problem, rules, { strategy: 'local', seed: 7, signal, budgets: { maxRestarts: 5 } });
      assert.strictEqual(result.status, 'limit');
      assert.strictEqual(result.cancelled, true);
      signal.aborted = false;
      holds(problem, rules, result);
      if (at > descent.counts.editWork) assert.notStrictEqual(rawObjective(descent.score, descent.churn.total, result.score, result.churn.total), 1, 'the abort lost the best list');
    }
  });
});

describe('solve local and auto: options and provenance', () => {
  const problem = tinyRepair(5);

  it('refuses options out of form', () => {
    refuses(() => solve(problem, reference, { strategy: /** @type {any} */ ('anneal') }), 'JN0015', '/options/strategy');
    refuses(() => solve(problem, reference, { strategy: 'local', rank: () => 0 }), 'JN0015', '/options/rank');
    refuses(() => solve(problem, reference, { strategy: 'local', budgets: { maxRestarts: 2 } }), 'JN0015', '/options/budgets/maxRestarts');
    for (const strategy of /** @type {const} */ (['exhaustive', 'construct']))
      for (const name of ['maxRestarts', 'maxEditWork'])
        refuses(() => solve(problem, reference, { strategy, budgets: { [name]: 3 } }), 'JN0015', `/options/budgets/${name}`);
    for (const value of [0, 1.5, -1, '3'])
      refuses(() => solve(problem, reference, { strategy: 'local', seed: 1, budgets: { maxEditWork: /** @type {any} */ (value) } }), 'JN0015', '/options/budgets/maxEditWork');
  });

  it('binds the baseline revision, the strategy asked for and the one that ran, the seed and every budget', () => {
    const result = solve(problem, reference, { strategy: 'local', seed: 9, budgets: { maxRestarts: 1, maxEditWork: 99999999 } });
    assert.strictEqual(text(result.provenance.budgets), text({ maxEditWork: 99999999, maxMoves: null, maxNodes: null, maxRestarts: 1 }));
    assert.strictEqual(result.provenance.baseline, 'b5');
    assert.strictEqual(result.provenance.problem, problem.revision);
    assert.strictEqual(result.provenance.seed, 9);
    assert.strictEqual(result.provenance.strategy, 'local');
    assert.strictEqual(result.provenance.algorithm, 'local');
    const other = structuredClone(problem);
    other.baseline.revision = 'b5-next';
    assert.strictEqual(solve(other, reference, { strategy: 'local', seed: 9 }).provenance.baseline, 'b5-next');
  });

  it('gives the same bytes across runs and key orders', () => {
    for (const seed of [2, 6, 11]) {
      const repair = tinyRepair(seed);
      for (const options of [{ strategy: /** @type {const} */ ('local'), seed, budgets: { maxRestarts: 2 } }, { strategy: /** @type {const} */ ('auto'), seed }]) {
        const once = text(solve(repair, reference, options));
        assert.strictEqual(text(solve(repair, reference, options)), once);
        for (const order of [1, 2, 3]) assert.strictEqual(text(solve(shuffled(repair, order * 31 + seed), reference, options)), once, `seed ${seed} order ${order}`);
      }
    }
    const roster = rosterFixture(4);
    const rules = registerRules(ROSTER_RULES);
    const auto = text(solve(roster, rules, { strategy: 'auto', seed: 4, budgets: { maxMoves: 6000 } }));
    assert.strictEqual(text(solve(shuffled(roster, 77), rules, { strategy: 'auto', seed: 4, budgets: { maxMoves: 6000 } })), auto);
  });

  it('gives the same bytes in every host time zone', () => {
    const expected = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CHILD], { env: { ...process.env, TZ: 'UTC', FORCE_COLOR: '0' }, encoding: 'utf8' });
    assert.strictEqual(expected.status, 0, expected.stderr);
    for (const zone of ['Pacific/Apia', 'Europe/Amsterdam']) {
      const run = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CHILD], { env: { ...process.env, TZ: zone, FORCE_COLOR: '0' }, encoding: 'utf8' });
      assert.strictEqual(run.status, 0, run.stderr);
      assert.strictEqual(run.stdout, expected.stdout, zone);
    }
    const out = JSON.parse(expected.stdout);
    assert.strictEqual(out.length, 5);
    const { problem: repair } = rosterRepair(2, 's3', 7, 12);
    assert.strictEqual(text(out[0]), text(solve(repair, repairRules, { strategy: 'local', seed: 2, budgets: { maxRestarts: 2 } })));
  });
});
