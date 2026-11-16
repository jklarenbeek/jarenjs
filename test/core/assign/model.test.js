//@ts-check
/**
 * Admitting an assignment problem: the canonical frozen form, every
 * refusal with its own code and JSON Pointer, ids indexed as data (never
 * as object members), and the code-unit order every id sorts by.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { admitProblem, registerRules, scoreAssignment, AssignError, ASSIGN_CODES } from '@jarenjs/core/assign';
import { rosterProblem, shuffled } from './fixtures.js';

/** @param {() => unknown} run @returns {{ code: string, docPath: string | undefined }} */
function refusal(run) {
  try {
    run();
  }
  catch (error) {
    assert.ok(error instanceof AssignError, String(error));
    assert.ok(Object.hasOwn(ASSIGN_CODES, error.code), error.code);
    return { code: error.code, docPath: error.docPath };
  }
  assert.fail('no refusal');
}

/** @param {(p: any) => void} edit */
function edited(edit) {
  const problem = rosterProblem();
  edit(problem);
  return problem;
}

describe('admitProblem', () => {
  it('answers canonical frozen JSON: ids sorted, keys in code-unit order, defaults filled', () => {
    const admitted = admitProblem(rosterProblem());
    assert.deepStrictEqual(admitted.resources.map((r) => r.id), ['ari', 'nina', 'sam']);
    assert.deepStrictEqual(admitted.tasks[0].demands.map((d) => d.slot), ['crew', 'lead']);
    assert.deepStrictEqual(Object.keys(admitted), ['assignments', 'attributes', 'baseline', 'facts', 'resources', 'revision', 'tasks']);
    assert.deepStrictEqual(Object.keys(admitted.tasks[0]), ['demands', 'id', 'interval', 'revision']);
    assert.ok(Object.isFrozen(admitted) && Object.isFrozen(admitted.tasks[0].interval) && Object.isFrozen(admitted.facts.availability.rows[0]));
    assert.strictEqual(admitProblem(admitted), admitted, 'admitting the answer again answers it unchanged');
    const bare = admitProblem({ revision: 0, resources: [], tasks: [] });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(bare)), { assignments: [], facts: {}, resources: [], revision: 0, tasks: [] });
  });

  it('admits two problems that differ only in key and array order to the same bytes; fact rows keep their order', () => {
    const text = JSON.stringify(admitProblem(rosterProblem()));
    for (let seed = 1; seed <= 20; seed++) assert.strictEqual(JSON.stringify(admitProblem(shuffled(rosterProblem(), seed, true))), text);
  });

  it('copies host data and never reads it', () => {
    const raw = edited((p) => { p.resources[0].attributes = { nested: { b: 1, a: [true, null, 'x'] } }; });
    const admitted = admitProblem(raw);
    raw.resources[0].attributes.nested.b = 2;
    const nina = admitted.resources.find((r) => r.id === 'nina');
    assert.deepStrictEqual(nina?.attributes, { nested: { a: [true, null, 'x'], b: 1 } });
    assert.deepStrictEqual(Object.keys(/** @type {any} */ (nina).attributes.nested), ['a', 'b']);
  });

  it('indexes ids as data: __proto__, constructor and toString are ordinary ids', () => {
    const problem = {
      revision: 1,
      resources: [{ id: '__proto__', revision: 1 }, { id: 'constructor', revision: 1 }, { id: 'toString', revision: 1 }],
      tasks: [{ id: '__proto__', revision: 1, interval: { start: 0, end: 1 }, demands: [{ slot: 'constructor', count: 3 }] }],
      facts: { __proto__: { revision: 1, rows: [{ hasOwnProperty: 1 }] } },
    };
    // A literal `__proto__:` sets the prototype; build the member as data.
    problem.facts = /** @type {any} */ (Object.defineProperty({}, '__proto__', { value: { revision: 1, rows: [{ hasOwnProperty: 1 }] }, enumerable: true }));
    const admitted = admitProblem(problem);
    assert.deepStrictEqual(Object.keys(admitted.facts), ['__proto__']);
    assert.strictEqual(Object.getPrototypeOf(admitted.facts), Object.prototype);
    const assignments = ['__proto__', 'constructor', 'toString'].map((resource) => ({ task: '__proto__', slot: 'constructor', resource }));
    const rules = registerRules([]);
    assert.strictEqual(scoreAssignment(admitted, rules, assignments).complete, true);
    assert.deepStrictEqual(refusal(() => scoreAssignment(admitted, rules, [{ task: 'hasOwnProperty', slot: 'constructor', resource: 'toString' }])),
      { code: 'JN0007', docPath: '/assignments/0/task' });
    assert.deepStrictEqual(refusal(() => scoreAssignment(admitted, rules, [{ task: '__proto__', slot: 'valueOf', resource: 'toString' }])),
      { code: 'JN0007', docPath: '/assignments/0/slot' });
  });

  it('sorts ids by code unit, never by number or locale: r10 before r9, and an astral character before U+FFFF', () => {
    const ids = ['r9', 'r10', 'b', 'B', '￿', '\u{1F600}', 'é', 'e'];
    const admitted = admitProblem({ revision: 1, resources: ids.map((id) => ({ id, revision: 1 })), tasks: [] });
    // U+1F600 is the surrogate pair D83D DE00, and D83D sorts before FFFF.
    assert.deepStrictEqual(admitted.resources.map((r) => r.id), ['B', 'b', 'e', 'r10', 'r9', 'é', '\u{1F600}', '￿']);
  });

  const REFUSALS = /** @type {[string, (p: any) => void, string, string][]} */ ([
    ['not an object', (p) => { p.tasks = 'x'; }, 'JN0001', '/tasks'],
    ['an unknown top member', (p) => { p.horizon = 1; }, 'JN0001', '/horizon'],
    ['a missing revision', (p) => { delete p.revision; }, 'JN0001', '/revision'],
    ['an unknown task member', (p) => { p.tasks[1].timezone = 'Europe/Amsterdam'; }, 'JN0001', '/tasks/1/timezone'],
    ['a zone that is not a string', (p) => { p.tasks[1].zone = 1; }, 'JN0001', '/tasks/1/zone'],
    ['an empty zone', (p) => { p.tasks[1].zone = ''; }, 'JN0001', '/tasks/1/zone'],
    ['attributes that are not an object', (p) => { p.resources[0].attributes = []; }, 'JN0001', '/resources/0/attributes'],
    ['a lock that is neither hard nor soft', (p) => { p.assignments[0].lock = 'firm'; }, 'JN0001', '/assignments/0/lock'],
    ['rows that are not an array', (p) => { p.facts.preferences.rows = {}; }, 'JN0001', '/facts/preferences/rows'],
    ['a baseline without assignments', (p) => { delete p.baseline.assignments; }, 'JN0001', '/baseline/assignments'],
    ['an empty id', (p) => { p.resources[1].id = ''; }, 'JN0002', '/resources/1/id'],
    ['a numeric slot', (p) => { p.tasks[1].demands[0].slot = 1; }, 'JN0002', '/tasks/1/demands/0/slot'],
    ['an empty fact name', (p) => { p.facts[''] = { revision: 1, rows: [] }; }, 'JN0002', '/facts/'],
    ['two resources with one id', (p) => { p.resources[2].id = 'nina'; }, 'JN0003', '/resources/2/id'],
    ['two tasks with one id', (p) => { p.tasks[1].id = 'mon-early'; }, 'JN0003', '/tasks/1/id'],
    ['two slots with one name', (p) => { p.tasks[0].demands[1].slot = 'lead'; }, 'JN0003', '/tasks/0/demands/1/slot'],
    ['a fractional revision', (p) => { p.resources[0].revision = 1.5; }, 'JN0004', '/resources/0/revision'],
    ['a negative revision', (p) => { p.revision = -1; }, 'JN0004', '/revision'],
    ['an empty fact revision', (p) => { p.facts.availability.revision = ''; }, 'JN0004', '/facts/availability/revision'],
    ['an interval that ends at its start', (p) => { p.tasks[0].interval.end = 0; }, 'JN0005', '/tasks/0/interval'],
    ['a fractional start', (p) => { p.tasks[0].interval.start = 0.5; }, 'JN0005', '/tasks/0/interval'],
    ['an unsafe end', (p) => { p.tasks[0].interval.end = 2 ** 53; }, 'JN0005', '/tasks/0/interval'],
    ['a zero count', (p) => { p.tasks[1].demands[0].count = 0; }, 'JN0006', '/tasks/1/demands/0/count'],
    ['an assignment to no task', (p) => { p.assignments[0].task = 'tue'; }, 'JN0007', '/assignments/0/task'],
    ['an assignment to no slot', (p) => { p.assignments[0].slot = 'crew2'; }, 'JN0007', '/assignments/0/slot'],
    ['an assignment of no resource', (p) => { p.assignments[0].resource = 'kim'; }, 'JN0007', '/assignments/0/resource'],
    ['a baseline entry to no task', (p) => { p.baseline.assignments[0].task = 'tue'; }, 'JN0007', '/baseline/assignments/0/task'],
    ['a repeated assignment', (p) => { p.assignments.push({ task: 'mon-early', slot: 'lead', resource: 'nina' }); }, 'JN0008', '/assignments/1'],
    // The entry named is the one that sorts past the count: ari before nina.
    ['a slot filled past its count', (p) => { p.assignments.push({ task: 'mon-early', slot: 'lead', resource: 'ari' }); }, 'JN0008', '/assignments/0'],
    ['a NaN inside attributes', (p) => { p.attributes.cap = Number.NaN; }, 'JN0009', '/attributes/cap'],
    ['undefined inside a fact row', (p) => { p.facts.preferences.rows[0].penalty = undefined; }, 'JN0009', '/facts/preferences/rows/0/penalty'],
    ['a function inside attributes', (p) => { p.resources[0].attributes.at = () => 1; }, 'JN0009', '/resources/0/attributes/at'],
    ['a Date inside attributes', (p) => { p.resources[0].attributes.at = new Date(0); }, 'JN0009', '/resources/0/attributes/at'],
  ]);

  for (const [what, edit, code, docPath] of REFUSALS) {
    it(`refuses ${what} with ${code} at ${docPath}`, () => {
      assert.deepStrictEqual(refusal(() => admitProblem(edited(edit))), { code, docPath });
    });
  }

  it('refuses a cycle and nesting past 64 levels as JN0009, never a stack overflow', () => {
    const cyclic = rosterProblem();
    cyclic.attributes.self = cyclic.attributes;
    assert.strictEqual(refusal(() => admitProblem(cyclic)).code, 'JN0009');
    let deep = /** @type {any} */ ({});
    for (let i = 0; i < 63; i++) deep = { d: deep };
    assert.doesNotThrow(() => admitProblem({ revision: 1, resources: [], tasks: [], attributes: deep }));
    assert.strictEqual(refusal(() => admitProblem({ revision: 1, resources: [], tasks: [], attributes: { d: deep } })).code, 'JN0009');
  });

  it('refuses a value that is not a problem at the root', () => {
    for (const value of [null, [], 'problem', 1, new Map()]) assert.deepStrictEqual(refusal(() => admitProblem(value)), { code: 'JN0001', docPath: '' });
  });

  it('escapes ids in a JSON Pointer', () => {
    const problem = edited((p) => { p.facts['a/b~c'] = { revision: '', rows: [] }; });
    assert.deepStrictEqual(refusal(() => admitProblem(problem)), { code: 'JN0004', docPath: '/facts/a~1b~0c/revision' });
  });
});
