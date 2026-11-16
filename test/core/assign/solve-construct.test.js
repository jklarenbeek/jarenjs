//@ts-check
/**
 * `solve` with the construct strategy: every proposal re-validated by
 * `scoreAssignment` to the byte; never `optimal` or `infeasible`; a
 * seeded tie-break; budgets and the signal; and a `rank` hook that
 * reproduces a path-dependent greedy exactly, in integer ms.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { registerRules, scoreAssignment, solve } from '@jarenjs/core/assign';
import { REFERENCE_RULES, coverageMin, noOverlap } from './rules/reference.js';
import { tinyInstance } from './oracle/instances.js';
import { brokenFixed, decided, greedyByLeastTime, leastTimeRank, ROSTER_RULES, rosterFixture } from './solve-fixtures.js';

const rules = registerRules(REFERENCE_RULES);
const roster = registerRules(ROSTER_RULES);
const text = (/** @type {unknown} */ value) => JSON.stringify(value);
const plain = (/** @type {readonly any[]} */ list) => list.map((a) => ({ task: a.task, slot: a.slot, resource: a.resource }));

/** @param {() => unknown} call @param {string} code @param {string} [docPath] */
function refuses(call, code, docPath) {
  assert.throws(call, (error) => {
    const e = /** @type {any} */ (error);
    assert.strictEqual(e.code, code, e.message);
    if (docPath !== undefined) assert.strictEqual(e.docPath, docPath);
    return true;
  });
}

describe('construct proposes, re-validated, and claims no proof', () => {
  it('every proposal is the bytes scoreAssignment answers for it, and its status follows that scoring', () => {
    for (let seed = 1; seed <= 30; seed++)
      for (const raw of [tinyInstance(seed), decided(tinyInstance(seed)), brokenFixed(tinyInstance(seed))]) {
        if (raw === null) continue;
        const solved = solve(raw, rules, { strategy: 'construct' });
        assert.strictEqual(text(solved.score), text(scoreAssignment(raw, rules, solved.best)), `seed ${seed}`);
        assert.strictEqual(solved.status, solved.score.verdict === 'feasible' ? 'feasible' : 'unknown', `seed ${seed}`);
      }
  });

  it('answers feasible where exhaustive proves optimal, and unknown where it proves infeasible', () => {
    for (const seed of [1, 9, 17]) {
      const raw = decided(tinyInstance(seed));
      const proved = solve(raw, rules, { strategy: 'exhaustive' });
      const built = solve(raw, rules, { strategy: 'construct' });
      assert.strictEqual(proved.status, 'optimal');
      assert.strictEqual(built.status, 'feasible');
      assert.strictEqual(built.bound, undefined);
    }
    const broken = brokenFixed(tinyInstance(4));
    assert.strictEqual(solve(broken, rules, { strategy: 'exhaustive' }).status, 'infeasible');
    const built = solve(broken, rules, { strategy: 'construct' });
    assert.strictEqual(built.status, 'unknown');
    assert.strictEqual(built.score.verdict, 'infeasible-by-validation');
  });

  it('keeps the problem\'s assignments and adds no hard match that leaving a place open avoids', () => {
    const broken = brokenFixed(tinyInstance(4));
    const solved = solve(broken, rules, { strategy: 'construct' });
    for (const fixed of broken.assignments) assert.ok(solved.best.some((a) => a.task === fixed.task && a.resource === fixed.resource && a.slot === fixed.slot));
    assert.strictEqual(solved.score.score.hard, scoreAssignment(broken, rules, broken.assignments).score.hard);
  });
});

describe('ties', () => {
  // four people, three shifts apart, one place each: every person ties for every place
  const raw = {
    revision: 1,
    resources: ['d', 'b', 'a', 'c'].map((id) => ({ id, revision: 1 })),
    tasks: [0, 1, 2].map((i) => ({ id: `t${i}`, revision: 1, interval: { start: i * 100, end: i * 100 + 50 }, demands: [{ slot: 'crew', count: 1 }] })),
  };
  const fill = registerRules([noOverlap, coverageMin]);

  it('go to the first resource in id order without a seed, and to a seeded draw with one', () => {
    const unseeded = solve(raw, fill, { strategy: 'construct' });
    assert.deepStrictEqual(unseeded.best.map((a) => a.resource), ['a', 'a', 'a']);
    const lists = new Set();
    for (let seed = 0; seed < 8; seed++) {
      const once = solve(raw, fill, { strategy: 'construct', seed });
      assert.strictEqual(text(solve(raw, fill, { strategy: 'construct', seed })), text(once));
      lists.add(once.best.map((a) => a.resource).join());
    }
    assert.ok(lists.size >= 4, `${lists.size} distinct proposals over 8 seeds`);
  });

  it('leaving a place open wins a tie with filling it', () => {
    const solved = solve(raw, registerRules([noOverlap]), { strategy: 'construct', seed: 3 });
    assert.deepStrictEqual(solved.best, []);
    assert.strictEqual(solved.counts.nodes, 3);
  });
});

describe('budgets and the signal', () => {
  const raw = decided(tinyInstance(9));
  const full = solve(raw, rules, { strategy: 'construct' });

  it('maxNodes counts places decided and maxMoves evaluator answers; past either, limit', () => {
    assert.strictEqual(full.status, 'feasible');
    assert.strictEqual(solve(raw, rules, { strategy: 'construct', budgets: { maxNodes: full.counts.nodes, maxMoves: full.counts.moves } }).status, 'feasible');
    const nodes = solve(raw, rules, { strategy: 'construct', budgets: { maxNodes: full.counts.nodes - 1 } });
    assert.strictEqual(nodes.status, 'limit');
    assert.strictEqual(nodes.counts.nodes, full.counts.nodes - 1);
    const moves = solve(raw, rules, { strategy: 'construct', budgets: { maxMoves: 5 } });
    assert.strictEqual(moves.status, 'limit');
    assert.strictEqual(moves.counts.moves, 5);
    for (const solved of [nodes, moves]) {
      assert.strictEqual(text(solved.score), text(scoreAssignment(raw, rules, solved.best)));
      assert.strictEqual(solved.cancelled, undefined);
    }
  });

  it('an abort before the call or from the rank hook answers limit, cancelled', () => {
    const controller = new AbortController();
    controller.abort();
    const before = solve(raw, rules, { strategy: 'construct', signal: controller.signal });
    assert.deepStrictEqual([before.status, before.cancelled, before.counts.nodes, before.best.length], ['limit', true, 0, 0]);
    const late = new AbortController();
    let calls = 0;
    const solved = solve(raw, rules, {
      strategy: 'construct', signal: late.signal,
      rank: () => {
        if (++calls === 4) late.abort();
        return 0;
      },
    });
    assert.deepStrictEqual([solved.status, solved.cancelled], ['limit', true]);
    assert.ok(solved.counts.nodes < full.counts.nodes);
    assert.strictEqual(text(solved.score), text(scoreAssignment(raw, rules, solved.best)));
  });
});

describe('the rank hook', () => {
  it('reproduces a path-dependent greedy (least time already assigned in this pass first) exactly', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const problem = rosterFixture(seed);
      const expected = greedyByLeastTime(problem);
      const solved = solve(problem, roster, { strategy: 'construct', rank: leastTimeRank(problem) });
      assert.deepStrictEqual(plain(solved.best), expected, `roster ${seed}`);
      assert.strictEqual(solved.status, 'feasible');
      assert.ok(solved.counts.ranked > expected.length);
      // the score alone orders differently: the fixture tells a rank that is ignored
      assert.notDeepStrictEqual(plain(solve(problem, roster, { strategy: 'construct' }).best), expected, `roster ${seed} without rank`);
    }
  });

  it('is shown frozen candidates and state, with leaving open as resource null', () => {
    const problem = rosterFixture(1, 4, 3);
    /** @type {any[]} */
    const seen = [];
    solve(problem, roster, {
      strategy: 'construct',
      rank: (candidate, state) => {
        assert.ok(Object.isFrozen(candidate) && Object.isFrozen(state) && Object.isFrozen(state.added) && Object.isFrozen(state.assignments));
        assert.ok(Object.isFrozen(state.problem));
        seen.push(candidate);
        return candidate.resource === null ? 1n : 0n;
      },
    });
    assert.ok(seen.some((c) => c.resource === null));
    assert.ok(seen.every((c) => c.result.complete === true));
  });

  it('orders only candidates the hard rules admit: a rank never waives one', () => {
    const problem = rosterFixture(3);
    const solved = solve(problem, roster, { strategy: 'construct', rank: (candidate) => (candidate.resource === 's0' ? -1 : 0) });
    assert.strictEqual(solved.score.score.hard, 0);
    assert.ok(solved.best.some((a) => a.resource === 's0'));
  });

  it('answering other than an integer, or throwing, is refused (JN0025)', () => {
    const problem = rosterFixture(1, 4, 3);
    for (const value of [1.5, NaN, '1', null, undefined, 2 ** 60])
      refuses(() => solve(problem, roster, { strategy: 'construct', rank: () => /** @type {any} */ (value) }), 'JN0025', '/options/rank');
    const cause = new Error('rank failed');
    assert.throws(() => solve(problem, roster, { strategy: 'construct', rank: () => { throw cause; } }),
      (error) => /** @type {any} */ (error).code === 'JN0025' && /** @type {any} */ (error).cause === cause);
    assert.strictEqual(solve(problem, roster, { strategy: 'construct', rank: () => 2n ** 70n }).status, 'feasible');
  });
});
