//@ts-check
/**
 * `solve` with the exhaustive strategy, against the oracle's own optimum
 * search over the same space: the status (what a complete search can
 * prove), the best score and the bound on every tiny instance and two
 * variants of each; then budgets, the signal, the size refusal, options,
 * incomplete scorings, re-validation, provenance and byte determinism
 * (runs, input key order, host time zones).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { registerRules, scoreAssignment, solve, SOLVE_LIMITS, admitProblem } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { REFERENCE_RULES, coverageMin, noOverlap } from './rules/reference.js';
import { DAY_RULES } from './rules/days.js';
import { fixtureProvider } from './days-provider.js';
import { dayInstance } from './oracle/days.js';
import { oracleScore } from './oracle/score.js';
import { oracleSolve } from './oracle/solve.js';
import { tinyInstance, spaceOf } from './oracle/instances.js';
import { brokenFixed, decided, oneFixed } from './solve-fixtures.js';
import { shuffled } from './fixtures.js';

const INSTANCES = 30;
const rules = registerRules(REFERENCE_RULES);
const CHILD = fileURLToPath(new URL('./solve-child.js', import.meta.url));
const text = (/** @type {unknown} */ value) => JSON.stringify(value);
const levels = (/** @type {any} */ score) => ({ hard: String(score.hard), service: String(score.service), soft: String(score.soft) });

/** @param {() => unknown} call @param {string} code @param {string} [docPath] */
function refuses(call, code, docPath) {
  assert.throws(call, (error) => {
    const e = /** @type {any} */ (error);
    assert.strictEqual(e.code, code, e.message);
    if (docPath !== undefined) assert.strictEqual(e.docPath, docPath);
    return true;
  });
}

/** The oracle's reading of a scoring, as oracleScore answers it. @param {any} result */
function engineView(result) {
  const ids = (/** @type {readonly string[]} */ list) => list.join(',');
  return {
    score: levels(result.score),
    verdict: result.verdict,
    matches: result.matches.map((/** @type {any} */ m) => `${m.rule}|${m.magnitude}|${ids(m.subjects.resources)}|${ids(m.subjects.tasks)}`).sort(),
    unknowns: result.unknowns.map((/** @type {any} */ u) => `${u.rule}|${u.reason}|${u.fact}|${ids(u.subjects.resources)}|${ids(u.subjects.tasks)}`).sort(),
  };
}

/**
 * Hold one exhaustive solve to the oracle: status, best score, bound,
 * the number of candidates and of undecided ones; the best list is in
 * the space (it keeps the problem's own assignments) and the oracle
 * scores it as the engine does.
 * @param {any} raw @param {string} label
 * @returns {string} the status
 */
function holdsToOracle(raw, label) {
  const solved = solve(raw, rules, { strategy: 'exhaustive' });
  const expected = oracleSolve(raw);
  assert.strictEqual(solved.status, expected.status, label);
  assert.deepStrictEqual(levels(solved.score.score), expected.score, label);
  assert.deepStrictEqual(levels(solved.bound), expected.bound, label);
  assert.strictEqual(solved.counts.nodes, expected.lists, label);
  assert.strictEqual(solved.counts.space, spaceOf(raw), label);
  assert.strictEqual(solved.counts.undecided, expected.undecided, label);
  const plain = solved.best.map((a) => ({ task: a.task, slot: a.slot, resource: a.resource }));
  assert.deepStrictEqual(engineView(solved.score), oracleScore(raw, plain), label);
  for (const fixed of raw.assignments ?? [])
    assert.ok(solved.best.some((a) => a.task === fixed.task && a.slot === fixed.slot && a.resource === fixed.resource), `${label} keeps ${text(fixed)}`);
  assert.strictEqual(solved.added.length, solved.best.length - (raw.assignments ?? []).length, label);
  return solved.status;
}

describe('exhaustive equals the oracle\'s optimum search', () => {
  it('the oracle\'s search imports only the oracle\'s own files', () => {
    const source = fs.readFileSync(new URL('./oracle/solve.js', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepStrictEqual(imports.sort(), ['./instances.js', './score.js']);
    assert.doesNotMatch(source, /import\(/);
  });

  it(`on ${INSTANCES} tiny instances: status, score, bound and counts`, () => {
    /** @type {Record<string, number>} */
    const statuses = {};
    for (let seed = 1; seed <= INSTANCES; seed++) {
      const status = holdsToOracle(tinyInstance(seed), `seed ${seed}`);
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
    // The corpus's unknowns block a proof on most instances; each answer occurs.
    assert.deepStrictEqual(Object.keys(statuses).sort(), ['feasible', 'optimal', 'unknown']);
  });

  it(`on the ${INSTANCES} instances with facts every rule decides on: optimal on every one`, () => {
    for (let seed = 1; seed <= INSTANCES; seed++) assert.strictEqual(holdsToOracle(decided(tinyInstance(seed)), `decided ${seed}`), 'optimal');
  });

  it('with problem assignments kept: infeasible where no completion is feasible, and as the oracle says otherwise', () => {
    let infeasible = 0;
    for (let seed = 1; seed <= INSTANCES; seed++) {
      const broken = brokenFixed(tinyInstance(seed));
      if (broken !== null) {
        assert.strictEqual(holdsToOracle(broken, `broken ${seed}`), 'infeasible');
        infeasible++;
      }
      holdsToOracle(oneFixed(tinyInstance(seed)), `one fixed ${seed}`);
    }
    assert.ok(infeasible >= 20, `${infeasible} infeasible instances`);
  });

  it('picks a validated feasible list over an undecided one that scores better', () => {
    // seed 3: the best undecided list scores (0, -3, 0), the best feasible (0, -4, -1)
    const solved = solve(tinyInstance(3), rules, { strategy: 'exhaustive' });
    assert.strictEqual(solved.score.verdict, 'feasible');
    assert.strictEqual(solved.status, 'feasible');
    assert.ok(solved.bound !== undefined && Number(solved.bound.service) > Number(solved.score.score.service));
  });
});

describe('unknowns below the hard level', () => {
  // one place, two people; the rule set rates a person's soft cost, and is
  // unknown for those named in `unrated`
  /** @param {string[]} unrated */
  const ruleSet = (unrated) => registerRules([coverageMin, {
    id: 'rated', version: 1, level: 'soft', scope: 'resource',
    evaluate: (/** @type {any} */ view, /** @type {any} */ unit) => (view.assignmentsOf(unit.id).length > 0 && unrated.includes(unit.id)
      ? { unknowns: [{ reason: 'unrated', subjects: { resources: [unit.id] } }] } : {}),
  }]);
  const raw = {
    revision: 1,
    resources: [{ id: 'a', revision: 1 }, { id: 'b', revision: 1 }],
    tasks: [{ id: 't', revision: 1, interval: { start: 0, end: 10 }, demands: [{ slot: 'crew', count: 1 }] }],
  };

  it('a tie on score goes to the candidate whose score is decided, which proves optimal', () => {
    const solved = solve(raw, ruleSet(['a']), { strategy: 'exhaustive' });
    assert.strictEqual(solved.status, 'optimal');
    assert.deepStrictEqual(solved.best.map((x) => x.resource), ['b']);
  });

  it('a soft unknown on the best blocks the proof when another candidate ties it on the levels above', () => {
    const solved = solve(raw, ruleSet(['a', 'b']), { strategy: 'exhaustive' });
    assert.strictEqual(solved.status, 'feasible');
    assert.deepStrictEqual(solved.best.map((x) => x.resource), ['a']);
    assert.deepStrictEqual(levels(solved.bound), { hard: '0', service: '0', soft: '0' });
    assert.strictEqual(solved.counts.undecided, 0);
  });
});

describe('budgets are counted', () => {
  const raw = tinyInstance(9);
  const space = spaceOf(raw);
  const full = solve(raw, rules, { strategy: 'exhaustive' });

  it('maxNodes equal to the space proves; one less answers limit, with no bound', () => {
    assert.strictEqual(full.status, 'optimal');
    const enough = solve(raw, rules, { strategy: 'exhaustive', budgets: { maxNodes: space } });
    assert.strictEqual(enough.status, 'optimal');
    assert.strictEqual(text(enough.score), text(full.score));
    assert.deepStrictEqual(enough.counts, full.counts);
    const short = solve(raw, rules, { strategy: 'exhaustive', budgets: { maxNodes: space - 1 } });
    assert.strictEqual(short.status, 'limit');
    assert.strictEqual(short.bound, undefined);
    assert.strictEqual(short.cancelled, undefined);
    assert.strictEqual(short.counts.nodes, space - 1);
    assert.strictEqual(text(short.score), text(scoreAssignment(raw, rules, short.best)));
  });

  it('maxMoves stops before the move past it', () => {
    for (const maxMoves of [1, 7, 100]) {
      const solved = solve(raw, rules, { strategy: 'exhaustive', budgets: { maxMoves } });
      assert.strictEqual(solved.status, 'limit');
      assert.strictEqual(solved.counts.moves, maxMoves);
      assert.deepStrictEqual(solved.provenance.budgets, { maxMoves, maxNodes: null });
    }
    assert.strictEqual(solve(raw, rules, { strategy: 'exhaustive', budgets: { maxMoves: full.counts.moves } }).status, 'optimal');
  });

  it('a budget-exhausted search of an infeasible instance answers limit, never infeasible', () => {
    const broken = brokenFixed(tinyInstance(4));
    assert.strictEqual(solve(broken, rules, { strategy: 'exhaustive' }).status, 'infeasible');
    for (const budgets of [{ maxNodes: 1 }, { maxNodes: spaceOf(broken) - 1 }, { maxMoves: 3 }]) {
      const solved = solve(broken, rules, { strategy: 'exhaustive', budgets });
      assert.strictEqual(solved.status, 'limit', text(budgets));
      assert.strictEqual(solved.bound, undefined);
      assert.strictEqual(solved.score.verdict, 'infeasible-by-validation');
    }
  });

  it('the same budget stops at the same place: byte-identical answers', () => {
    const a = solve(raw, rules, { strategy: 'exhaustive', budgets: { maxNodes: 1234 } });
    const b = solve(raw, rules, { strategy: 'exhaustive', budgets: { maxNodes: 1234 } });
    assert.strictEqual(text(a), text(b));
  });
});

describe('the signal', () => {
  it('a signal aborted before the call answers limit with the problem as given', () => {
    const raw = tinyInstance(9);
    const controller = new AbortController();
    controller.abort();
    const solved = solve(raw, rules, { strategy: 'exhaustive', signal: controller.signal });
    assert.strictEqual(solved.status, 'limit');
    assert.strictEqual(solved.cancelled, true);
    assert.strictEqual(solved.counts.nodes, 1);
    assert.deepStrictEqual(solved.best, []);
    assert.strictEqual(text(solved.score), text(scoreAssignment(raw, rules, [])));
  });

  it('a signal aborted by a rule mid-search stops at the next node', () => {
    const raw = tinyInstance(9);
    for (const at of [5, 400]) {
      const controller = new AbortController();
      let calls = 0;
      const aborting = registerRules(REFERENCE_RULES.map((rule) => (rule.id !== noOverlap.id ? rule : {
        ...rule,
        evaluate(/** @type {any} */ view, /** @type {any} */ unit) {
          if (++calls === at) controller.abort();
          return rule.evaluate(view, unit);
        },
      })));
      const solved = solve(raw, aborting, { strategy: 'exhaustive', signal: controller.signal });
      assert.strictEqual(solved.status, 'limit');
      assert.strictEqual(solved.cancelled, true);
      assert.ok(solved.counts.nodes < spaceOf(raw), `${solved.counts.nodes} nodes`);
      assert.strictEqual(text(solved.score), text(scoreAssignment(raw, aborting, solved.best)));
    }
  });
});

describe('the size limit', () => {
  /** @param {number} people @param {number} tasks */
  const wide = (people, tasks) => ({
    revision: 1,
    resources: Array.from({ length: people }, (_, i) => ({ id: `p${i}`, revision: 1 })),
    tasks: Array.from({ length: tasks }, (_, i) => ({ id: `t${i}`, revision: 1, interval: { start: i * 10, end: i * 10 + 5 }, demands: [{ slot: 'crew', count: 1 }] })),
  });

  it('a space past SOLVE_LIMITS.maxSpace is refused before anything is scored', () => {
    assert.strictEqual(SOLVE_LIMITS.maxSpace, 100000);
    assert.ok(Object.isFrozen(SOLVE_LIMITS));
    let calls = 0;
    const counting = registerRules([{ ...noOverlap, evaluate: (/** @type {any} */ view, /** @type {any} */ unit) => (calls++, noOverlap.evaluate(view, unit)) }]);
    // 10 ways per slot (9 people or none): 10^5 is at the limit; 10 people make 11^5, a sixth slot 10^6
    refuses(() => solve({ ...wide(9, 5), resources: [...wide(10, 1).resources] }, counting, { strategy: 'exhaustive' }), 'JN0024', '/options/strategy');
    const past = wide(9, 5);
    past.tasks[0].demands = [{ slot: 'crew', count: 1 }, { slot: 'lead', count: 1 }];
    refuses(() => solve(past, counting, { strategy: 'exhaustive' }), 'JN0024', '/options/strategy');
    refuses(() => solve(wide(30, 30), counting, { strategy: 'exhaustive' }), 'JN0024');
    assert.strictEqual(calls, 0);
    const at = solve(wide(9, 5), counting, { strategy: 'exhaustive', budgets: { maxNodes: 2 } });
    assert.strictEqual(at.counts.space, 100000);
    assert.strictEqual(at.status, 'limit');
    // construct has no size limit and is never switched to
    assert.strictEqual(solve(wide(30, 30), counting, { strategy: 'construct' }).status, 'feasible');
  });
});

describe('options', () => {
  const raw = tinyInstance(10);
  it('are refused by name when out of form', () => {
    refuses(() => solve(raw, rules, /** @type {any} */ (undefined)), 'JN0015', '/options');
    refuses(() => solve(raw, rules, /** @type {any} */ ({ strategy: 'anneal' })), 'JN0015', '/options/strategy');
    refuses(() => solve(raw, rules, /** @type {any} */ ({})), 'JN0015', '/options/strategy');
    refuses(() => solve(raw, rules, /** @type {any} */ ({ strategy: 'construct', deadlineMs: 5 })), 'JN0015', '/options/deadlineMs');
    refuses(() => solve(raw, rules, { strategy: 'exhaustive', seed: 1 }), 'JN0015', '/options/seed');
    refuses(() => solve(raw, rules, { strategy: 'exhaustive', rank: () => 0 }), 'JN0015', '/options/rank');
    for (const seed of [-1, 1.5, 2 ** 32, NaN, '1'])
      refuses(() => solve(raw, rules, /** @type {any} */ ({ strategy: 'construct', seed })), 'JN0015', '/options/seed');
    refuses(() => solve(raw, rules, /** @type {any} */ ({ strategy: 'construct', rank: 3 })), 'JN0015', '/options/rank');
    refuses(() => solve(raw, rules, /** @type {any} */ ({ strategy: 'construct', budgets: 5 })), 'JN0015', '/options/budgets');
    refuses(() => solve(raw, rules, /** @type {any} */ ({ strategy: 'construct', budgets: { maxRestarts: 2 } })), 'JN0015', '/options/budgets/maxRestarts');
    for (const value of [0, 1.5, -2, '3'])
      refuses(() => solve(raw, rules, /** @type {any} */ ({ strategy: 'construct', budgets: { maxNodes: value } })), 'JN0015', '/options/budgets/maxNodes');
    for (const signal of [null, {}, { aborted: 'no' }, true])
      refuses(() => solve(raw, rules, /** @type {any} */ ({ strategy: 'construct', signal })), 'JN0015', '/options/signal');
    refuses(() => solve(raw, rules, /** @type {any} */ ({ strategy: 'construct', limits: { maxUnits: -1 } })), 'JN0015', '/options/limits/maxUnits');
    refuses(() => solve(raw, rules, /** @type {any} */ ({ strategy: 'construct', days: {} })), 'JN0021', '/options/days');
    refuses(() => solve(raw, registerRules(DAY_RULES), { strategy: 'construct' }), 'JN0021', '/options/days');
    refuses(() => solve({ ...raw, revision: '' }, rules, { strategy: 'construct' }), 'JN0004', '/revision');
    refuses(() => solve(raw, /** @type {any} */ ({ rules: [] }), { strategy: 'construct' }), 'JN0014');
  });

  it('civil days pass through to every scoring and into provenance', () => {
    const dayRules = registerRules(DAY_RULES);
    const days = civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' });
    const problem = dayInstance(7, Date.parse('2026-03-29T01:00:00Z'), 'Europe/Amsterdam');
    for (const strategy of /** @type {const} */ (['exhaustive', 'construct'])) {
      const solved = solve(problem, dayRules, { strategy, days, budgets: { maxNodes: 50 } });
      assert.strictEqual(text(solved.score), text(scoreAssignment(problem, dayRules, solved.best, { days })));
      assert.deepStrictEqual(solved.provenance.days, solved.score.provenance.days);
      assert.ok(solved.provenance.days !== undefined);
    }
  });
});

describe('what a solve proves when scorings are incomplete or untrue', () => {
  it('scorings past a limit leave every candidate undecided: unknown, no bound', () => {
    const raw = decided(tinyInstance(9));
    const limits = { maxUnits: 3 };
    const solved = solve(raw, rules, { strategy: 'exhaustive', limits });
    assert.strictEqual(solved.status, 'unknown');
    assert.strictEqual(solved.bound, undefined);
    assert.strictEqual(solved.counts.undecided, spaceOf(raw));
    assert.strictEqual(solved.score.complete, false);
    assert.strictEqual(text(solved.score), text(scoreAssignment(raw, rules, solved.best, { limits })));
    assert.deepStrictEqual(solved.provenance.limits, { maxUnits: 3, maxMatches: 1000000, maxWork: 100000000 });
    const built = solve(raw, rules, { strategy: 'construct', limits });
    assert.strictEqual(built.status, 'unknown');
    assert.strictEqual(built.added.length, 0);
  });

  it('a rule that reads state past its view is caught by the re-validation (JN0026)', () => {
    let calls = 0;
    const impure = registerRules([{
      id: 'drifts', version: 1, level: 'soft', scope: 'task',
      evaluate: () => ({ matches: [{ magnitude: 1 + (calls++ % 3), messageId: 'drift' }] }),
    }]);
    refuses(() => solve(tinyInstance(9), impure, { strategy: 'exhaustive' }), 'JN0026', '/ruleSet');
    refuses(() => solve(tinyInstance(9), impure, { strategy: 'construct' }), 'JN0026', '/ruleSet');
  });

  it('a rule that throws is the scoring\'s refusal, never an infeasible candidate', () => {
    const throwing = registerRules([{ ...noOverlap, evaluate: () => { throw new Error('no'); } }]);
    refuses(() => solve(tinyInstance(9), throwing, { strategy: 'exhaustive' }), 'JN0016');
  });
});

describe('provenance and determinism', () => {
  it('binds the problem, rule set, facts, strategy, seed, budgets, limits and the rank hook', () => {
    const raw = tinyInstance(9);
    const solved = solve(raw, rules, { strategy: 'exhaustive', budgets: { maxNodes: 10 } });
    const scored = scoreAssignment(raw, rules, []);
    assert.deepStrictEqual(solved.provenance, {
      ...scored.provenance,
      algorithm: 'exhaustive',
      budgets: { maxMoves: null, maxNodes: 10 },
      limits: { maxUnits: 1000000, maxMatches: 1000000, maxWork: 100000000 },
      rank: false,
      seed: null,
    });
    const built = solve(raw, rules, { strategy: 'construct', seed: 7, rank: () => 0 });
    assert.strictEqual(built.provenance.algorithm, 'construct');
    assert.strictEqual(built.provenance.seed, 7);
    assert.strictEqual(built.provenance.rank, true);
    assert.ok(Object.isFrozen(solved) && Object.isFrozen(solved.provenance) && Object.isFrozen(solved.counts) && Object.isFrozen(solved.best));
  });

  it('answers the same bytes for every key and list order of the input', () => {
    for (const seed of [4, 9, 21]) {
      const raw = tinyInstance(seed);
      for (const strategy of /** @type {const} */ (['exhaustive', 'construct'])) {
        const once = text(solve(raw, rules, { strategy }));
        assert.strictEqual(text(solve(raw, rules, { strategy })), once);
        for (const mix of [1, 2, 3]) assert.strictEqual(text(solve(shuffled(raw, mix, true), rules, { strategy })), once, `seed ${seed} ${strategy} mix ${mix}`);
        assert.strictEqual(text(solve(admitProblem(raw), rules, { strategy })), once);
      }
    }
  });

  it('answers the same bytes under UTC, Pacific/Apia and Europe/Amsterdam', () => {
    const outputs = ['UTC', 'Pacific/Apia', 'Europe/Amsterdam'].map((zone) => {
      const run = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CHILD], {
        env: { ...process.env, TZ: zone, FORCE_COLOR: '0' }, encoding: 'utf8',
      });
      assert.strictEqual(run.status, 0, run.stderr);
      return run.stdout;
    });
    assert.ok(outputs[0].length > 1000);
    assert.strictEqual(outputs[1], outputs[0]);
    assert.strictEqual(outputs[2], outputs[0]);
  });
});
