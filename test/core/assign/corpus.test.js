//@ts-check
/**
 * The quality corpus (corpus/PROVENANCE.md): every instance solved by
 * every strategy that applies to it, and every answer held to the
 * independent validator (oracle/validate.js), which reads raw JSON and
 * imports no engine module. Where the oracle can enumerate an instance,
 * `exhaustive` (and `auto` on its exhaustive path) must answer exactly the
 * proof's status, best score and bound; every other answer must be a list
 * the problem allows with the oracle's score, the raw churn and a status
 * it may claim. The validator is itself held: each tampered field of a
 * right answer must be caught.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { admitProblem, registerRules, scoreAssignment, solve } from '@jarenjs/core/assign';
import { REFERENCE_RULES } from './rules/reference.js';
import { rollingCap } from './rules/rolling.js';
import { oracleSolve } from './oracle/solve.js';
import { oracleOf, prove, validateAnswer, churnOf } from './oracle/validate.js';
import { tinyInstance, enumerate } from './oracle/instances.js';
import { corpusInstances, solveInstance, CALLS } from './corpus/run.js';

/** @param {string} file @returns {string[]} */
function importsOf(file) {
  const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.doesNotMatch(text, /import\(/, `${file} imports dynamically`);
  return [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

const instances = corpusInstances();
const solved = new Map(instances.map((instance) => [instance.name, { instance, ...solveInstance(instance) }]));

describe('the quality corpus', () => {
  it('the validator, the oracle and the generator import no engine module', () => {
    for (const file of ['validate.js', 'rolling.js', 'solve.js', 'score.js', 'instances.js', 'days.js'])
      for (const from of importsOf(`./oracle/${file}`)) assert.match(from, /^\.\/[a-z]+\.js$/, `oracle/${file} imports ${from}`);
    assert.deepStrictEqual(importsOf('./corpus/domains.js'), ['../oracle/instances.js']);
  });

  it('the generalized proof is the oracle\'s on the 30 tiny instances', () => {
    const answerOf = oracleOf('reference');
    for (let seed = 1; seed <= 30; seed++) {
      const raw = tinyInstance(seed);
      assert.deepStrictEqual(prove(raw, answerOf), oracleSolve(raw), `seed ${seed}`);
    }
  });

  it(`${instances.length} instances, each solved every applicable way, and the validator agrees with every answer`, (t) => {
    let runs = 0;
    const statuses = new Map();
    for (const { instance, runs: list, refused } of solved.values()) {
      assert.deepStrictEqual(refused, [], instance.name);
      for (const run of list) {
        runs++;
        assert.deepStrictEqual(run.wrong, [], `${instance.name} ${run.label}`);
        statuses.set(run.status, (statuses.get(run.status) ?? 0) + 1);
      }
    }
    assert.strictEqual(instances.length, 80);
    assert.deepStrictEqual([...statuses.keys()].sort(), ['feasible', 'infeasible', 'limit', 'optimal', 'unknown']);
    t.diagnostic(`${runs} answers; ${[...statuses].map(([s, n]) => `${s} ${n}`).join(', ')}`);
  });

  it('exhaustive answers every proof exactly, and the heuristics\' reach of the proven optima is counted', (t) => {
    let proofs = 0;
    let matched = 0;
    /** @type {Record<string, [number, number]>} */
    const reached = {};
    for (const { instance, proof, runs } of solved.values()) {
      if (proof === null) continue;
      const exhaustive = runs.find((run) => run.label === 'exhaustive');
      if (exhaustive === undefined) continue;
      proofs++;
      assert.strictEqual(exhaustive.status, proof.status, instance.name);
      matched++;
      if (proof.status !== 'optimal') continue;
      const fills = (instance.problem.assignments ?? []).length === 0;
      for (const run of runs) {
        if (run.label === 'exhaustive' || (run.strategy === 'local' && !fills) || run.status === 'limit') continue;
        const at = (reached[run.label] ??= [0, 0]);
        at[1]++;
        const score = run.answer.score.score;
        if (String(score.hard) === proof.score.hard && String(score.service) === proof.score.service && String(score.soft) === proof.score.soft) at[0]++;
      }
    }
    assert.ok(proofs >= 55, `${proofs} proofs`);
    assert.strictEqual(matched, proofs);
    assert.strictEqual(reached.auto[0], reached.auto[1], 'auto proves within its limit');
    t.diagnostic(`${proofs} proofs matched; optima reached: ${Object.entries(reached).map(([label, [hit, of]]) => `${label} ${hit}/${of}`).join(', ')}`);
  });

  it('the rolling oracle scores every list of the small rolling instances as the engine does, and the rule bites', () => {
    const ruleSet = registerRules([...REFERENCE_RULES, rollingCap]);
    const answerOf = oracleOf('rolling');
    let lists = 0;
    let bitten = 0;
    for (const { instance } of solved.values()) {
      if (instance.domain !== 'rolling' || instance.size !== 'small') continue;
      const problem = admitProblem(instance.problem);
      for (const list of enumerate(instance.problem)) {
        lists++;
        const result = /** @type {any} */ (scoreAssignment(problem, ruleSet, list));
        const expected = answerOf(instance.problem, list);
        assert.deepStrictEqual({ hard: String(result.score.hard), service: String(result.score.service), soft: String(result.score.soft) }, expected.score, `${instance.name} ${JSON.stringify(list)}`);
        assert.strictEqual(result.verdict, expected.verdict);
        if (result.matches.some((/** @type {any} */ m) => m.rule === 'rolling-cap')) bitten++;
      }
    }
    assert.ok(lists > 100 && bitten > 0, `${lists} lists, ${bitten} with a rolling-cap match`);
  });

  it('a feasible list whose soft level is undecided is not proved optimal over a list that ties it above', () => {
    const raw = {
      revision: 'tie', resources: [{ id: 'r1', revision: 1 }, { id: 'r2', revision: 1 }],
      tasks: [{ id: 't', revision: 1, interval: { start: 0, end: 10 }, demands: [{ slot: 'lead', count: 1 }] }],
      facts: { availability: { revision: 1, rows: [{ resource: 'r1', start: 0, end: 100, state: 'available' }, { resource: 'r2', start: 0, end: 100, state: 'available' }] } },
      attributes: { minGap: 0, cap: 1000, window: { start: 0, end: 100 } },
    };
    const proof = prove(raw, oracleOf('reference'));
    assert.deepStrictEqual(proof, oracleSolve(raw));
    assert.strictEqual(proof.status, 'feasible');
    const answer = solve(admitProblem(raw), registerRules(REFERENCE_RULES), { strategy: 'exhaustive' });
    assert.deepStrictEqual(validateAnswer(raw, 'exhaustive', answer, oracleOf('reference'), { proof }), []);
  });

  it('every call of the corpus is made', () => {
    const labels = new Set([...solved.values()].flatMap((entry) => entry.runs.map((run) => run.label)));
    assert.deepStrictEqual([...labels].sort(), CALLS.map((call) => call.label).sort());
  });
});

describe('the validator catches a wrong answer', () => {
  /** @param {string} name @param {string} label */
  const pick = (name, label) => {
    const entry = /** @type {any} */ (solved.get(name));
    const run = entry.runs.find((/** @type {any} */ r) => r.label === label);
    return { raw: entry.instance.problem, proof: entry.proof, run, answerOf: oracleOf(entry.instance.domain === 'rolling' ? 'rolling' : entry.instance.domain === 'days' ? 'days' : 'reference') };
  };
  /** @param {any} value */
  const copy = (value) => JSON.parse(JSON.stringify(value));
  /**
   * Make every other field agree with a tampered `best` (the oracle's score
   * and verdict, the raw `added`, `removed` and `churn`), so the one broken
   * invariant is all that is left for the validator to catch.
   * @param {any} answer @param {any} raw @param {any} answerOf
   */
  const consistent = (answer, raw, answerOf) => {
    const key = (/** @type {any} */ x) => JSON.stringify([x.task, x.slot, x.resource]);
    const own = new Set((raw.assignments ?? []).map(key));
    const kept = new Set(answer.best.map(key));
    const oracle = answerOf(raw, answer.best);
    for (const level of ['hard', 'service', 'soft']) answer.score.score[level] = Number(/** @type {any} */ (oracle.score)[level]);
    answer.score.verdict = oracle.verdict;
    answer.added = answer.best.filter((/** @type {any} */ x) => !own.has(key(x)));
    if ('removed' in answer) answer.removed = (raw.assignments ?? []).filter((/** @type {any} */ x) => !kept.has(key(x)));
    if ('churn' in answer) answer.churn = churnOf(raw.baseline.assignments, answer.best);
  };
  const cases = [
    ['overlaps-small-1', 'exhaustive', 'a soft score one lower', (/** @type {any} */ a) => { a.score.score.soft = Number(a.score.score.soft) - 1; }],
    ['overlaps-small-1', 'exhaustive', 'a hard score one lower', (/** @type {any} */ a) => { a.score.score.hard = Number(a.score.score.hard) - 1; }],
    ['overlaps-small-1', 'exhaustive', 'a service score one higher', (/** @type {any} */ a) => { a.score.score.service = Number(a.score.score.service) + 1; }],
    ['overlaps-small-1', 'exhaustive', 'the verdict flipped', (/** @type {any} */ a) => { a.score.verdict = 'unknown'; }],
    ['overlaps-small-1', 'exhaustive', 'a bound one higher', (/** @type {any} */ a) => { a.bound.soft = Number(a.bound.soft) + 1; }],
    ['overlaps-small-1', 'exhaustive', 'a proven optimum called feasible', (/** @type {any} */ a) => { a.status = 'feasible'; }],
    ['overlaps-small-1', 'construct', 'construct claiming optimal', (/** @type {any} */ a) => { a.status = 'optimal'; }],
    ['overlaps-small-1', 'construct', 'limit with no budget', (/** @type {any} */ a) => { a.status = 'limit'; }],
    ['overlaps-small-1', 'construct', 'an added assignment left out of added', (/** @type {any} */ a) => { a.added.pop(); }],
    ['overlaps-small-1', 'construct', 'a duplicate in best, all else consistent', (/** @type {any} */ a) => { a.best.push({ ...a.best[0] }); }, true],
    ['overlaps-small-1', 'construct', 'a resource the problem lacks', (/** @type {any} */ a) => { a.best[0].resource = 'nobody'; }],
    ['overlaps-small-1', 'construct', 'a lock the host never set', (/** @type {any} */ a) => { a.best[0].lock = 'soft'; }],
    ['repair-small-1', 'construct', 'a held assignment dropped by a fill, all else consistent', (/** @type {any} */ a, /** @type {any} */ raw) => {
      const held = raw.assignments[0];
      a.best = a.best.filter((/** @type {any} */ x) => !(x.task === held.task && x.slot === held.slot && x.resource === held.resource));
    }, true],
    ['overlaps-small-1', 'construct', 'a validated feasible best called unknown', (/** @type {any} */ a) => { a.status = 'unknown'; }],
    ['repair-small-1', 'local', 'churn one lower', (/** @type {any} */ a) => { a.churn.total -= 1; }],
    ['repair-small-1', 'local', 'a move read as its own resource', (/** @type {any} */ a) => { a.churn.moved[0].to = a.churn.moved[0].from; }],
    ['repair-small-1', 'local', 'removed missing an entry', (/** @type {any} */ a) => { a.removed.pop(); }],
    ['locks-small-1', 'local', 'a hard lock dropped', (/** @type {any} */ a, /** @type {any} */ raw) => {
      const held = raw.assignments.find((/** @type {any} */ x) => x.lock === 'hard');
      a.best = a.best.filter((/** @type {any} */ x) => !(x.task === held.task && x.slot === held.slot && x.resource === held.resource));
    }, true],
    ['coverage-small-1', 'construct', 'a slot filled past its count', (/** @type {any} */ a, /** @type {any} */ raw) => {
      const task = raw.tasks[0];
      const taken = new Set(a.best.filter((/** @type {any} */ x) => x.task === task.id && x.slot === task.demands[0].slot).map((/** @type {any} */ x) => x.resource));
      for (const resource of raw.resources) if (!taken.has(resource.id)) a.best.push({ resource: resource.id, slot: task.demands[0].slot, task: task.id });
    }, true],
  ];
  for (const [name, label, what, tamper, isolate] of /** @type {[string, string, string, (a: any, raw: any) => void, boolean?][]} */ (cases)) {
    it(`${what} (${name}, ${label})`, () => {
      const { raw, proof, run, answerOf } = pick(name, label);
      const options = { stoppable: false, proof };
      assert.deepStrictEqual(validateAnswer(raw, run.strategy, run.answer, answerOf, options), []);
      const wrong = copy(run.answer);
      tamper(wrong, raw);
      if (isolate === true) consistent(wrong, raw, answerOf);
      assert.notDeepStrictEqual(validateAnswer(raw, run.strategy, wrong, answerOf, options), [], 'the validator agreed with a wrong answer');
    });
  }

  // On a budget-stopped answer no status check applies, so a duplicate in a
  // slot with room and an extra holder of a full slot (everything else made
  // consistent) are each caught by their own check alone.
  for (const [what, wants] of /** @type {[string, 'room' | 'full'][]} */ ([['a duplicate in a slot with room', 'room'], ['a full slot filled past its count', 'full']])) {
    it(`${what}, on a budget-stopped answer, all else consistent`, () => {
      let done = false;
      for (const entry of solved.values()) {
        const run = entry.runs.find((r) => r.label === 'local, 3 moves' && r.status === 'limit');
        if (run === undefined || entry.instance.domain === 'days' || entry.instance.domain === 'rolling') continue;
        const raw = entry.instance.problem;
        const held = (/** @type {any} */ x) => run.answer.best.filter((/** @type {any} */ y) => y.task === x.task && y.slot === x.slot).length;
        const countOf = (/** @type {any} */ x) => raw.tasks.find((/** @type {any} */ t) => t.id === x.task).demands.find((/** @type {any} */ d) => d.slot === x.slot).count;
        const wrong = copy(run.answer);
        if (wants === 'room') {
          const item = wrong.best.find((/** @type {any} */ x) => held(x) < countOf(x));
          if (item === undefined) continue;
          wrong.best.push({ ...item });
        }
        else {
          const item = wrong.best.find((/** @type {any} */ x) => held(x) === countOf(x) && raw.resources.some((/** @type {any} */ r) => !wrong.best.some((/** @type {any} */ y) => y.task === x.task && y.slot === x.slot && y.resource === r.id)));
          if (item === undefined) continue;
          const free = raw.resources.find((/** @type {any} */ r) => !wrong.best.some((/** @type {any} */ y) => y.task === item.task && y.slot === item.slot && y.resource === r.id));
          wrong.best.push({ resource: free.id, slot: item.slot, task: item.task });
        }
        const answerOf = oracleOf('reference');
        consistent(wrong, raw, answerOf);
        const options = { stoppable: true, proof: entry.proof };
        assert.deepStrictEqual(validateAnswer(raw, 'local', run.answer, answerOf, options), []);
        assert.notDeepStrictEqual(validateAnswer(raw, 'local', wrong, answerOf, options), [], 'the validator agreed with a wrong answer');
        done = true;
        break;
      }
      assert.ok(done, 'the corpus holds a budget-stopped answer to tamper');
    });
  }

  it('churn is counted by hand on a pinned case', () => {
    const baseline = [{ task: 't1', slot: 's', resource: 'a' }, { task: 't1', slot: 's', resource: 'b' }, { task: 't2', slot: 's', resource: 'c' }];
    const list = [{ task: 't1', slot: 's', resource: 'd' }, { task: 't2', slot: 's', resource: 'c' }, { task: 't3', slot: 's', resource: 'a' }];
    assert.deepStrictEqual(churnOf(baseline, list), {
      added: [{ resource: 'a', slot: 's', task: 't3' }],
      byResource: [{ count: 2, resource: 'a' }, { count: 1, resource: 'b' }, { count: 1, resource: 'd' }],
      byTask: [{ count: 2, task: 't1' }, { count: 1, task: 't3' }],
      moved: [{ from: 'a', slot: 's', task: 't1', to: 'd' }],
      removed: [{ resource: 'b', slot: 's', task: 't1' }],
      total: 3,
    });
  });
});
