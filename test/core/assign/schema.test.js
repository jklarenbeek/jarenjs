//@ts-check
/**
 * The problem schema twin: every admitted problem validates; every
 * refusal admitProblem makes that a schema can state fails the schema in
 * the definition named after its code; over a corpus of mutated problems
 * admission and the schema agree, except on the refusals the schema
 * cannot state (a repeated id, a reference that does not resolve, a slot
 * filled past its count, an interval whose start is not before its end,
 * host data too deep), which are pinned as validating so the gap stays
 * visible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import problemSchema from '@jarenjs/core/schemas/assign/problem.schema.json' with { type: 'json' };
import { admitProblem, AssignError } from '@jarenjs/core/assign';
import { rosterProblem } from './fixtures.js';
import { tinyInstance } from './oracle/instances.js';

const check = new JarenValidator({ skipErrors: false, collectErrors: true }).compile(problemSchema);

/** The definitions that each name one refusal, by the code they mirror. */
const REASONS = /** @type {Record<string, string>} */ ({ id: 'JN0002', revision: 'JN0004', intervalOrder: 'JN0005', count: 'JN0006' });

/** The refusals no schema keyword states. */
const BEYOND = new Set(['JN0003', 'JN0005', 'JN0007', 'JN0008', 'JN0009']);

/**
 * The codes the schema's leaf errors name.
 * @param {any} outcome
 * @returns {Set<string>}
 */
function codesOf(outcome) {
  const codes = new Set();
  for (const error of outcome.errors ?? []) {
    if (['allOf', 'anyOf', 'oneOf', 'if', 'then', '$ref'].includes(error.keyword)) continue;
    if (/\/facts\/propertyNames/.test(error.schemaPath)) {
      codes.add('JN0002');
      continue;
    }
    const name = [...error.schemaPath.matchAll(/\$defs\/([A-Za-z]+)/g)].pop()?.[1];
    codes.add(name !== undefined && Object.hasOwn(REASONS, name) ? REASONS[name] : 'JN0001');
  }
  return codes;
}

/** @param {unknown} problem @returns {string | null} */
function codeOf(problem) {
  try {
    admitProblem(problem);
    return null;
  }
  catch (error) {
    assert.ok(error instanceof AssignError, String(error));
    return error.code;
  }
}

describe('the problem schema twin', () => {
  it('has its $id under the core schema namespace', () => {
    assert.strictEqual(problemSchema.$id, 'https://jarenjs.dev/schemas/jaren-core/assign/problem/0.1');
  });

  it('validates every problem admission accepts, raw and admitted', () => {
    const problems = [rosterProblem(), { revision: 0, resources: [], tasks: [] }];
    for (let seed = 1; seed <= 30; seed++) problems.push(tinyInstance(seed));
    for (const raw of problems) {
      assert.strictEqual(check(raw).valid, true, JSON.stringify(raw).slice(0, 200));
      assert.strictEqual(check(JSON.parse(JSON.stringify(admitProblem(raw)))).valid, true);
    }
  });

  it('fails each refusal it can state in the definition named after its code', () => {
    const refused = /** @type {[(p: any) => void, string][]} */ ([
      [(p) => { p.horizon = 1; }, 'JN0001'],
      [(p) => { delete p.tasks; }, 'JN0001'],
      [(p) => { p.resources = {}; }, 'JN0001'],
      [(p) => { p.tasks[0].timezone = 'UTC'; }, 'JN0001'],
      [(p) => { p.tasks[0].zone = ''; }, 'JN0001'],
      [(p) => { p.tasks[0].zone = 3; }, 'JN0001'],
      [(p) => { p.tasks[0].interval = [0, 1]; }, 'JN0001'],
      [(p) => { p.assignments[0].lock = 'firm'; }, 'JN0001'],
      [(p) => { p.facts.availability.rows = {}; }, 'JN0001'],
      [(p) => { delete p.baseline.revision; }, 'JN0001'],
      [(p) => { p.resources[0].attributes = 'x'; }, 'JN0001'],
      [(p) => { p.resources[0].id = ''; }, 'JN0002'],
      [(p) => { p.assignments[0].resource = 7; }, 'JN0002'],
      [(p) => { p.facts[''] = { revision: 1, rows: [] }; }, 'JN0002'],
      [(p) => { p.revision = ''; }, 'JN0004'],
      [(p) => { p.tasks[1].revision = 2.5; }, 'JN0004'],
      [(p) => { p.facts.preferences.revision = -1; }, 'JN0004'],
      [(p) => { p.tasks[0].interval.start = 0.5; }, 'JN0005'],
      [(p) => { p.tasks[0].interval.end = '480'; }, 'JN0005'],
      [(p) => { p.tasks[0].interval.end = 2 ** 53; }, 'JN0005'],
      [(p) => { p.tasks[0].demands[0].count = 0; }, 'JN0006'],
      [(p) => { p.tasks[0].demands[0].count = 1.5; }, 'JN0006'],
    ]);
    for (const [edit, code] of refused) {
      const problem = rosterProblem();
      edit(problem);
      const label = `${edit.toString()} (${code})`;
      assert.strictEqual(codeOf(problem), code, label);
      const outcome = check(problem);
      assert.strictEqual(outcome.valid, false, label);
      assert.ok(codesOf(outcome).has(code), `${label}: schema names ${[...codesOf(outcome)].join(', ')}`);
    }
  });

  it('validates the refusals it cannot state, so the gap stays visible', () => {
    const beyond = /** @type {[(p: any) => void, string][]} */ ([
      [(p) => { p.resources[1].id = p.resources[0].id; }, 'JN0003'],
      [(p) => { p.tasks[0].demands[1].slot = p.tasks[0].demands[0].slot; }, 'JN0003'],
      [(p) => { p.tasks[0].interval.end = 0; }, 'JN0005'],
      [(p) => { p.assignments[0].task = 'tue'; }, 'JN0007'],
      [(p) => { p.baseline.assignments[0].resource = 'kim'; }, 'JN0007'],
      [(p) => { p.assignments.push({ ...p.assignments[0] }); }, 'JN0008'],
      [(p) => {
        let deep = {};
        for (let i = 0; i < 70; i++) deep = { d: deep };
        p.attributes = deep;
      }, 'JN0009'],
    ]);
    for (const [edit, code] of beyond) {
      const problem = rosterProblem();
      edit(problem);
      assert.strictEqual(codeOf(problem), code);
      assert.strictEqual(check(problem).valid, true, `${code} is beyond the schema`);
    }
  });

  it('agrees with admission over a corpus of mutated problems', () => {
    const POOL = [null, true, 0, -1, 1.5, 2 ** 53, '', 'x', 'nina', [], [1], {}, { a: 1 }, 'hard'];
    let state = 99;
    const next = (/** @type {number} */ n) => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n;
    /** @param {any} node @param {string[]} path @param {string[][]} out */
    const paths = (node, path, out) => {
      out.push(path);
      if (node !== null && typeof node === 'object') for (const key of Object.keys(node)) paths(node[key], [...path, key], out);
      return out;
    };
    let agreed = 0;
    let refusedBoth = 0;
    for (let round = 0; round < 1500; round++) {
      const problem = rosterProblem();
      const all = paths(problem, [], []).filter((path) => path.length > 0);
      const path = all[next(all.length)];
      /** @type {any} */
      let parent = problem;
      for (const key of path.slice(0, -1)) parent = parent[key];
      const last = path[path.length - 1];
      if (next(5) === 0 && !Array.isArray(parent)) delete parent[last];
      else parent[last] = structuredClone(POOL[next(POOL.length)]);
      const code = codeOf(problem);
      const outcome = check(problem);
      const label = `${path.join('/')} -> ${JSON.stringify(parent[last])}`;
      if (code === null) assert.strictEqual(outcome.valid, true, `admitted but invalid: ${label}`);
      else if (outcome.valid) assert.ok(BEYOND.has(code), `valid but refused ${code}: ${label}`);
      else {
        assert.ok(codesOf(outcome).has(code), `${label}: admission ${code}, schema ${[...codesOf(outcome)].join(', ')}`);
        refusedBoth++;
      }
      agreed++;
    }
    assert.strictEqual(agreed, 1500);
    assert.ok(refusedBoth > 300, `${refusedBoth} mutations refused by both`);
  });
});
