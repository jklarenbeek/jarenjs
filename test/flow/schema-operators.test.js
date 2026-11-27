//@ts-check
/**
 * @file The flow compilers' `compileTypeTest` option: given a type-test
 * compiler, every embedded query and stylesheet of a machine, statechart,
 * graph or workflow compiles the schema operators (`$valid`) and a JSLT
 * schema match, as `compileJsonQuery` and `compileJsltStylesheet` do with
 * the same hook. Without one each is refused as before: `JQ0008` (a query)
 * or `JT0006` (a stylesheet match) inside the flow's own code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileFsm, compileDag, compileStatechart, compileWorkflow, lowerWorkflow, fsmToApp, fsmStateSchema, FlowCompileError } from '@jarenjs/flow';
import { createApp } from '@jarenjs/app';
import { createJsltRegistry, mathPack } from '@jarenjs/json/jslt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const compileTypeTest = createTypeTestCompiler();
const math = createJsltRegistry().use(mathPack);
const absent = [undefined, {}, { compileTypeTest: null }, { compileTypeTest: undefined }, { operators: math }];
const NOT_A_FUNCTION = '"compileTypeTest" must be a function (a type-test compiler)';
const isNumber = (/** @type {string} */ at) => ({ $valid: [at, { type: 'number' }] });

/**
 * A FlowCompileError with this code and place whose cause is the refusal
 * a schema operator meets without a type-test compiler.
 * @param {string} code @param {string | null} docPath - null: not compared
 * @param {string} [cause] - the engine code (`JQ0008`, or `JT0006` for a stylesheet match)
 */
const noTypeTest = (code, docPath, cause = 'JQ0008') => (/** @type {any} */ err) => err instanceof FlowCompileError
  && err.code === code && (docPath === null || err.docPath === docPath) && err.cause?.code === cause
  && /require a type-test compiler/.test(err.cause.message);

const machine = {
  initial: 'a', states: ['a', { id: 'b', entry: [{ run: 'enter', with: isNumber('$.context.n') }] }],
  transitions: [{ from: 'a', event: 'go', to: 'b', guard: isNumber('$.context.n'), effects: [{ run: 'log', with: isNumber('$.context.n') }] }],
};
/** @param {Record<string, any>} nodes @param {any[]} edges */
const graph = (nodes, edges) => ({ $dag: '0.1', nodes: { in: { kind: 'input' }, ...nodes, out: { kind: 'output' } }, edges });
const through = (/** @type {string} */ id) => [{ from: 'in', to: id }, { from: id, to: 'out' }];
const queryNode = graph({ q: { kind: 'query', query: isNumber('$') } }, through('q'));
const jsltMatch = graph({ j: { kind: 'jslt', stylesheet: [{ match: '$', body: 'other' }, { match: { schema: { type: 'number' } }, body: 'number' }] } }, through('j'));
const jsltValid = graph({ j: { kind: 'jslt', stylesheet: [{ match: '$', body: { ok: isNumber('$') } }] } }, through('j'));
const taskWith = graph({ t: { kind: 'task', run: 'echo', with: isNumber('$') } }, through('t'));
const edgeSelect = graph({}, [{ from: 'in', to: 'out', select: isNumber('$') }]);
const tasks = { echo: (/** @type {{ with: any }} */ props) => props.with };

describe('compileFsm: the compileTypeTest option', () => {
  it('a guard, a transition effect and an entry effect use $valid', () => {
    const fsm = compileFsm(machine, { compileTypeTest });
    assert.deepEqual(fsm.step('a', 'go', { context: { n: 1 } }),
      { changed: true, state: 'b', effects: [{ run: 'log', with: true }, { run: 'enter', with: true }], final: false, errors: [] });
    assert.deepEqual(fsm.step('a', 'go', { context: { n: 'x' } }), { changed: false, state: 'a', effects: [], final: false, errors: [] });
  });

  it('combines with a registry', () => {
    const doc = { initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b', guard: { $and: [isNumber('$.context.n'), { $gt: [{ $sqrt: '$.context.n' }, 3] }] } }] };
    const fsm = compileFsm(doc, { compileTypeTest, operators: math });
    assert.deepEqual([16, 4].map((n) => fsm.step('a', 'go', { context: { n } }).state), ['b', 'a']);
  });

  it('without one each is the JQ0008 it was', () => {
    for (const options of absent) {
      const label = JSON.stringify(options) ?? 'undefined';
      const { guard, effects } = machine.transitions[0];
      const one = (/** @type {any} */ member) => ({ ...machine, states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b', ...member }] });
      assert.throws(() => compileFsm(one({ guard }), options), noTypeTest('JF0007', '/transitions/0/guard'), label);
      assert.throws(() => compileFsm(one({ effects }), options), noTypeTest('JF0009', '/transitions/0/effects/0/with'), label);
      assert.throws(() => compileFsm(machine, options), noTypeTest('JF0009', '/states/1/entry/0/with'), label);
    }
  });

  it('a machine that names no schema operator steps exactly as without one', () => {
    const core = { initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b', guard: { $gt: ['$.context.n', 3] }, effects: [{ run: 'log', with: '$.context.n' }] }] };
    for (const n of [5, 2]) assert.deepEqual(compileFsm(core, { compileTypeTest }).step('a', 'go', { context: { n } }), compileFsm(core).step('a', 'go', { context: { n } }));
  });

  it('refuses a compileTypeTest that is no function', () => {
    for (const value of [{}, 'ajv', 1, true]) {
      assert.throws(() => compileFsm(machine, { compileTypeTest: /** @type {any} */ (value) }), { name: 'TypeError', message: `compileFsm: ${NOT_A_FUNCTION}` });
      assert.throws(() => compileDag(queryNode, { compileTypeTest: /** @type {any} */ (value) }), { name: 'TypeError', message: `compileDag: ${NOT_A_FUNCTION}` });
      assert.throws(() => compileStatechart({ $fsm: '0.2', initial: 'a', states: [{ id: 'a' }], transitions: [] }, { compileTypeTest: /** @type {any} */ (value) }),
        { name: 'TypeError', message: `compileStatechart: ${NOT_A_FUNCTION}` });
    }
  });
});

describe('compileDag: the compileTypeTest option', () => {
  it('a query node, a stylesheet\'s schema match and $valid, a task `with` and an edge `select` use it', async () => {
    assert.deepEqual(await Promise.all([1, 'x'].map((n) => compileDag(queryNode, { compileTypeTest }).run(n))), [true, false]);
    assert.deepEqual(await Promise.all([1, 'x'].map((n) => compileDag(jsltMatch, { compileTypeTest }).run(n))), ['number', 'other']);
    assert.deepEqual(await compileDag(jsltValid, { compileTypeTest }).run('x'), { ok: false });
    assert.equal(await compileDag(taskWith, { tasks, compileTypeTest }).run(2), true);
    assert.equal(await compileDag(edgeSelect, { compileTypeTest }).run(null), false);
  });

  it('without one each is the refusal it was', () => {
    for (const options of absent) {
      const label = JSON.stringify(options) ?? 'undefined';
      assert.throws(() => compileDag(queryNode, options), noTypeTest('JF0014', '/nodes/q/query'), label);
      assert.throws(() => compileDag(jsltMatch, options), noTypeTest('JF0014', '/nodes/j/stylesheet', 'JT0006'), label);
      assert.throws(() => compileDag(taskWith, { tasks, ...options }), noTypeTest('JF0014', '/nodes/t/with'), label);
      assert.throws(() => compileDag(edgeSelect, options), noTypeTest('JF0014', '/edges/0/select'), label);
    }
  });
});

describe('compileStatechart, lowerWorkflow and compileWorkflow: the compileTypeTest option', () => {
  const chart = { $fsm: '0.2', initial: 'a', states: [{ id: 'a' }, { id: 'b', entry: [{ run: 'enter', with: isNumber('$.context.n') }] }],
    transitions: [{ from: 'a', event: 'go', to: 'b', guard: isNumber('$.context.n') }] };
  const workflow = { $workflow: '0.2', revision: 'test/1', initial: 'check', states: {
    check: { choose: [{ guard: isNumber('$.context.data'), to: 'work' }], otherwise: 'done' },
    work: { work: { task: 't', version: '1', with: { $valid: ['$', { type: 'boolean' }] } }, input: { $valid: ['$.context.data', { minimum: 10 }] }, then: 'done' },
    done: { final: true } } };
  const wfTasks = { t: { version: '1', run: (/** @type {{ with: any, input: any }} */ p) => ({ with: p.with, input: p.input }) } };

  it('a statechart guard and entry effect use $valid', () => {
    const compiled = compileStatechart(chart, { compileTypeTest });
    const start = compiled.start().state;
    const go = compiled.step(start, 'go', { context: { n: 1 } });
    assert.deepEqual([go.state.active, go.effects], [['b'], [{ run: 'enter', with: true }]]);
    assert.deepEqual(compiled.step(start, 'go', { context: { n: 'x' } }).state.active, ['a']);
  });

  it('a workflow guard, task `with` and `input` use $valid', async () => {
    const compiled = compileWorkflow(workflow, { tasks: wfTasks, compileTypeTest });
    assert.deepEqual((await compiled.run(16, { runId: 'a' })).result, { with: true, input: true });
    assert.deepEqual((await compiled.run(4, { runId: 'b' })).result, { with: true, input: false });
    assert.equal((await compiled.run('x', { runId: 'c' })).result, 'x');
    assert.equal(lowerWorkflow(workflow, { compileTypeTest }).revision, 'test/1');
  });

  it('without one each is the JQ0008 it was', () => {
    for (const options of absent) {
      const label = JSON.stringify(options) ?? 'undefined';
      assert.throws(() => compileStatechart(chart, options), noTypeTest('JF0009', '/states/1/entry/0/with'), label);
      assert.throws(() => compileStatechart({ ...chart, states: [{ id: 'a' }, { id: 'b' }] }, options), noTypeTest('JF0007', '/transitions/0/guard'), label);
      assert.throws(() => compileWorkflow(workflow, { tasks: wfTasks, ...options }), noTypeTest('JF0007', null), label);
      assert.throws(() => lowerWorkflow(workflow, options), noTypeTest('JF0007', null), label);
    }
    const unguarded = structuredClone(workflow);
    unguarded.states.check.choose[0].guard = true;
    assert.throws(() => compileWorkflow(unguarded, { tasks: wfTasks }), noTypeTest('JF0014', '/states/work/work/with'));
    delete unguarded.states.work.work.with;
    assert.throws(() => compileWorkflow(unguarded, { tasks: wfTasks }), noTypeTest('JF0014', '/states/work/input'));
  });

  it('refuses a compileTypeTest that is no function, naming the compiler it was given to', () => {
    assert.throws(() => compileWorkflow(workflow, { tasks: wfTasks, compileTypeTest: /** @type {any} */ ('x') }), { name: 'TypeError', message: `compileWorkflow: ${NOT_A_FUNCTION}` });
    assert.throws(() => lowerWorkflow(workflow, { compileTypeTest: /** @type {any} */ ('x') }), { name: 'TypeError', message: `lowerWorkflow: ${NOT_A_FUNCTION}` });
  });
});

describe('fsmToApp and fsmStateSchema: the compileTypeTest option', () => {
  const doc = { initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b', guard: isNumber('$.context.n') }] };

  it('accept a $valid guard, and the app hosting the actions runs it with the same compiler', () => {
    assert.deepEqual(fsmStateSchema(doc, { compileTypeTest }).properties.current.enum, ['a', 'b']);
    const { slice, actions } = fsmToApp(doc, { compileTypeTest });
    for (const [n, current] of /** @type {Array<[any, string]>} */ ([[1, 'b'], ['x', 'a']])) {
      const app = createApp({ state: { fsm: slice, n }, view: [{ match: '$', body: ['p', {}, '$.fsm.current'] }], actions },
        { schedule: (/** @type {() => void} */ f) => f(), compileTypeTest });
      app.dispatch('fsm/go');
      assert.equal(app.getState().fsm.current, current, String(n));
      app.destroy();
    }
  });

  it('without one the machine is refused as compileFsm refuses it', () => {
    for (const options of absent) {
      assert.throws(() => fsmToApp(doc, options), noTypeTest('JF0007', '/transitions/0/guard'));
      assert.throws(() => fsmStateSchema(doc, options), noTypeTest('JF0007', '/transitions/0/guard'));
    }
  });
});
