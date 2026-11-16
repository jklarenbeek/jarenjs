//@ts-check
/**
 * Seeded 10,000-edit streams over generated problems, with and without
 * civil-day rules: after every edit, the evaluator's answer and its
 * preview of another edit are the bytes a fresh full scoring of that
 * state answers (or the same refusal), and neither a refusal nor a
 * preview changes its state. Each stream asserts what it visited.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { admitProblem, createEvaluator, registerRules, scoreAssignment } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { REFERENCE_RULES, coverageMin, noOverlap } from './rules/reference.js';
import { DAY_RULES } from './rules/days.js';
import { fixtureProvider } from './days-provider.js';
import { runStream, streamInstance } from './stream.js';

const EDITS = 10000;
const HOUR = 3600000;
/** A rule reading a fact table no stream problem holds: unknown on every answer. */
const certified = /** @type {import('@jarenjs/core/assign').AssignRule} */ ({
  id: 'certified', version: 1, level: 'soft', scope: 'resource', reads: { facts: ['certificates'] }, evaluate: () => ({}),
});

/**
 * Run a 10,000-edit stream in four parts of 2,500, one test each, so no
 * single test runs long; the last asserts what the whole stream visited.
 * @param {() => { evaluator: any, problem: any, ruleSet: any, list: any[], options?: any, seed: number,
 *   onApplied?: (list: any[], result: any) => void }} start
 * @param {(seen: any, evaluator: any) => void} visited
 */
function inParts(start, visited) {
  const PART = EDITS / 4;
  /** @type {any} */
  let run = null;
  const seen = { applied: 0, refused: /** @type {Record<string, number>} */ ({}), previews: 0, incomplete: 0, complete: 0, unitsMoved: 0 };
  for (let part = 1; part <= 4; part++)
    it(`edits ${(part - 1) * PART + 1} to ${part * PART}: apply and whatIf answer full scoring's bytes; refusals and previews change nothing`, () => {
      run ??= { ...start(), list: undefined, next: undefined };
      const out = runStream({ ...run, list: run.list ?? run.first, edits: PART });
      assert.strictEqual(out.failure, null, JSON.stringify(out.failure));
      run.list = out.list;
      run.next = out.next;
      for (const key of /** @type {const} */ (['applied', 'previews', 'incomplete', 'complete', 'unitsMoved'])) seen[key] += out.seen[key];
      for (const [code, n] of Object.entries(out.seen.refused)) seen.refused[code] = (seen.refused[code] ?? 0) + /** @type {number} */ (n);
      if (part === 4) visited(seen, run.evaluator);
    });
}

describe('a 10,000-edit stream without day rules equals full scoring after every edit', () => {
  const verdicts = new Set();
  inParts(() => {
    const { problem: raw, assignments } = streamInstance(1, { resources: 6, tasks: 24 });
    const problem = admitProblem(raw);
    const ruleSet = registerRules([...REFERENCE_RULES, certified]);
    return { evaluator: createEvaluator(problem, ruleSet, assignments), problem, ruleSet, first: assignments, seed: 101,
      onApplied: (/** @type {any} */ _, /** @type {any} */ result) => verdicts.add(result.verdict) };
  }, (seen, evaluator) => {
    assert.ok(seen.applied > 7000, `${seen.applied} applied`);
    assert.ok(seen.refused.JN0007 > 0 && seen.refused.JN0008 > 0 && seen.refused.JN0023 > 0, JSON.stringify(seen.refused));
    assert.strictEqual(seen.previews, EDITS);
    assert.strictEqual(seen.incomplete, 0);
    assert.deepStrictEqual([...verdicts].sort(), ['feasible', 'infeasible-by-validation']);
    const counts = evaluator.counts;
    assert.deepStrictEqual([counts.edits, counts.fullFallbacks, counts.fullScorings], [seen.applied, 0, 1]);
    assert.ok(counts.reused > counts.evaluated, JSON.stringify(counts));
  });
});

describe('streams across their limits', () => {
  it('a stream across its limits: each answer is the full scoring, incomplete ones with no total', () => {
    const { problem: raw, assignments } = streamInstance(2, { resources: 5, tasks: 20 });
    const problem = admitProblem(raw);
    const ruleSet = registerRules(REFERENCE_RULES);
    const first = /** @type {any} */ (scoreAssignment(problem, ruleSet, assignments)).counts;
    for (const limits of [{ maxMatches: first.matches - 1 }, { maxWork: first.work - 10 }, { maxUnits: first.units - 1 }]) {
      const evaluator = createEvaluator(problem, ruleSet, assignments, { limits });
      const run = runStream({ evaluator, problem, ruleSet, list: assignments, options: { limits }, edits: 1500, seed: 7 });
      assert.strictEqual(run.failure, null, JSON.stringify(run.failure));
      // the units of a problem do not move: past maxUnits every answer is incomplete
      if ('maxUnits' in limits) assert.deepStrictEqual([run.seen.incomplete, run.seen.complete], [run.seen.applied, 0]);
      else assert.ok(run.seen.incomplete > 0 && run.seen.complete > 0, JSON.stringify(run.seen));
      assert.ok(evaluator.counts.fullScorings > 1);
    }
  });
});

describe('a 10,000-edit stream with day rules equals full scoring after every edit', () => {
  // two zones across their changes of the clock, tasks without a zone and one in a zone the provider does not know
  /** @type {Set<string>} */
  let zoneless = new Set();
  /** @type {Map<string, boolean>} */
  let untold = new Map();
  let flips = 0;
  let noZone = 0;
  const lengths = new Set();
  const zones = new Set();
  inParts(() => {
    const { problem: raw, assignments } = streamInstance(3, { resources: 5, tasks: 20, days: 14,
      zones: ['Europe/Amsterdam', 'America/New_York'], stray: 'Atlantis/Nowhere' });
    const problem = admitProblem(raw);
    const ruleSet = registerRules([...DAY_RULES, noOverlap, coverageMin]);
    const options = { days: civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' }) };
    zoneless = new Set(problem.tasks.filter((task) => task.zone === undefined).map((task) => task.id));
    assert.ok(zoneless.size > 0);
    return { evaluator: createEvaluator(problem, ruleSet, assignments, options), problem, ruleSet, options, first: assignments, seed: 202,
      onApplied: (/** @type {any[]} */ list, /** @type {any} */ result) => {
        const now = new Map(problem.resources.map((r) => [r.id, list.some((a) => a.resource === r.id && zoneless.has(a.task))]));
        for (const [id, flag] of now) if (untold.has(id) && untold.get(id) !== flag) flips++;
        untold = now;
        for (const match of result.matches ?? []) {
          if (match.rule === 'daily-rest') lengths.add((match.intervals[0].end - match.intervals[0].start) / HOUR);
          if (match.unit.zone) zones.add(match.unit.zone);
        }
        noZone += (result.unknowns ?? []).some((/** @type {any} */ u) => u.reason === 'no-zone') ? 1 : 0;
      } };
  }, (seen, evaluator) => {
    assert.ok(seen.applied > 7000, `${seen.applied} applied`);
    // assigning the task whose zone the provider does not know is refused as full scoring refuses it
    assert.ok(seen.refused.JN0022 > 0 && seen.refused.JN0008 > 0, JSON.stringify(seen.refused));
    assert.ok(seen.unitsMoved > 1000, `day units appeared or vanished on ${seen.unitsMoved} edits`);
    assert.ok(flips > 100, `${flips} resources turned untellable or tellable`);
    assert.ok(noZone > 100, `${noZone} answers with no-zone`);
    assert.deepStrictEqual([...zones].sort(), ['America/New_York', 'Europe/Amsterdam']);
    assert.ok(lengths.has(24) && lengths.has(25), [...lengths].join(', '));
    assert.strictEqual(evaluator.counts.fullFallbacks, 0);
  });
});

describe('a day stream across its work limit', () => {
  it('a day stream across its work limit', () => {
    const { problem: raw, assignments } = streamInstance(4, { resources: 4, tasks: 14, days: 10, zones: ['Europe/Amsterdam', 'America/New_York'], stray: 'Atlantis/Nowhere' });
    const problem = admitProblem(raw);
    const ruleSet = registerRules(DAY_RULES);
    const days = civilDays({ zoneProvider: fixtureProvider(), policy: 'later' });
    const work = /** @type {any} */ (scoreAssignment(problem, ruleSet, assignments, { days })).counts.work;
    const options = { days, limits: { maxWork: work - 5 } };
    const evaluator = createEvaluator(problem, ruleSet, assignments, options);
    const run = runStream({ evaluator, problem, ruleSet, list: assignments, options, edits: 1500, seed: 9 });
    assert.strictEqual(run.failure, null, JSON.stringify(run.failure));
    // with the stray task: refused where scoring reaches its split, incomplete where a limit comes first
    assert.ok(run.seen.incomplete > 0 && run.seen.complete > 0 && run.seen.refused.JN0022 > 0, JSON.stringify(run.seen));
  });
});

describe('a rule reading outside its row in a stream', () => {
  it('falls back on every answer and stays exact', () => {
    const paired = /** @type {import('@jarenjs/core/assign').AssignRule} */ ({
      id: 'paired-shifts', version: 1, level: 'soft', scope: 'resource',
      evaluate(view, unit) {
        const ids = view.resources().map((r) => r.id);
        const buddy = ids[(ids.indexOf(/** @type {string} */ (unit.id)) + 1) % ids.length];
        const theirs = new Set(view.assignmentsOf(buddy).map((a) => a.task));
        return { matches: view.assignmentsOf(/** @type {string} */ (unit.id)).filter((a) => theirs.has(a.task)).map(() => ({ magnitude: 1, messageId: 'paired' })) };
      },
    });
    const { problem: raw, assignments } = streamInstance(5, { resources: 5, tasks: 16 });
    const problem = admitProblem(raw);
    const rules = [...REFERENCE_RULES, paired];
    const ruleSet = registerRules(rules);
    const evaluator = createEvaluator(problem, ruleSet, assignments);
    const run = runStream({ evaluator, problem, ruleSet, list: assignments, edits: 2000, seed: 13,
      rules, make: (/** @type {any} */ set) => createEvaluator(problem, set, assignments) });
    assert.strictEqual(run.failure, null, JSON.stringify(run.failure));
    const counts = evaluator.counts;
    // every answer that changed anything evaluated the rule over every resource
    assert.ok(counts.fullFallbacks > 0.5 * (counts.edits + counts.previews) && counts.fullFallbacks <= counts.edits + counts.previews, JSON.stringify(counts));
  });
});
