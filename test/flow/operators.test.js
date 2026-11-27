//@ts-check
/**
 * @file The flow compilers' `operators` option: every embedded query and
 * stylesheet of a jaren-fsm machine (guards, effect `with`) and of a
 * jaren-dag graph (query and jslt nodes, task `with`, edge `select`)
 * compiles with the registry's operators and `$call` functions. Without
 * one they compile with the core operators, and a pack operator is the
 * `JQ0002` it always was.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileFsm, compileDag, fsmToApp, FlowCompileError } from '@jarenjs/flow';
import { createApp } from '@jarenjs/app';
import { createJsltRegistry, mathPack, financePack } from '@jarenjs/json/jslt';

const math = createJsltRegistry().use(mathPack);
const finance = createJsltRegistry().use(financePack);
const host = createJsltRegistry().use({ name: 'host', entries: { twice: { kind: 'fn', fn: (/** @type {number} */ x) => x * 2 } } });

/** @param {any} transition - the members of the one transition a -> b */
const machine = (transition, entry = undefined) => ({
  initial: 'a',
  states: ['a', entry === undefined ? 'b' : { id: 'b', entry }],
  transitions: [{ from: 'a', event: 'go', to: 'b', ...transition }],
});
const sqrtGuard = machine({ guard: { $gt: [{ $sqrt: '$.context.n' }, 3] } });
const sqrtWith = machine({ effects: [{ run: 'log', with: { $sqrt: '$.context.n' } }] });
const sqrtEntry = machine({}, [{ run: 'enter', with: { $pow: ['$.context.n', 2] } }]);

/**
 * @param {Record<string, any>} nodes - nodes between `in` and `out`
 * @param {any[]} edges
 */
const graph = (nodes, edges) => ({ $dag: '0.1', nodes: { in: { kind: 'input' }, ...nodes, out: { kind: 'output' } }, edges });
const queryNode = graph({ q: { kind: 'query', query: { $sqrt: '$.n' } } }, [{ from: 'in', to: 'q' }, { from: 'q', to: 'out' }]);
const jsltNode = graph({ j: { kind: 'jslt', stylesheet: [{ match: '$', body: { r: { $pow: ['$.n', 2] } } }] } }, [{ from: 'in', to: 'j' }, { from: 'j', to: 'out' }]);
const taskWith = graph({ t: { kind: 'task', run: 'echo', with: { $sqrt: '$.n' } } }, [{ from: 'in', to: 't' }, { from: 't', to: 'out' }]);
const edgeSelect = graph({}, [{ from: 'in', to: 'out', select: { $sqrt: '$.n' } }]);
const tasks = { echo: (/** @type {{ with: any }} */ props) => props.with };

/**
 * A FlowCompileError with this code and place whose cause chain holds the
 * `JQ0002` unknown-operator refusal for `name`.
 * @param {string} code
 * @param {string} docPath
 * @param {string} name
 */
const unknownOperator = (code, docPath, name) => (/** @type {any} */ err) => err instanceof FlowCompileError
  && err.code === code && err.docPath === docPath && causeCodes(err).includes('JQ0002')
  && new RegExp(`unknown operator '\\${name}'`).test(err.message);
/** The codes of an error's cause chain (a stylesheet wraps the query's). @param {any} err */
const causeCodes = (err) => {
  const codes = [];
  for (let link = err.cause; link; link = link.cause) codes.push(link.code);
  return codes;
};

describe('compileFsm: the operators option', () => {
  it('a guard computes with a registry operator', () => {
    const fsm = compileFsm(sqrtGuard, { operators: math });
    assert.deepEqual(fsm.step('a', 'go', { context: { n: 16 } }), { changed: true, state: 'b', effects: [], final: false, errors: [] });
    assert.deepEqual(fsm.step('a', 'go', { context: { n: 4 } }), { changed: false, state: 'a', effects: [], final: false, errors: [] });
  });

  it('a transition\'s and a state\'s effect `with` compute with it', () => {
    assert.deepEqual(compileFsm(sqrtWith, { operators: math }).step('a', 'go', { context: { n: 16 } }).effects,
      [{ run: 'log', with: 4 }]);
    assert.deepEqual(compileFsm(sqrtEntry, { operators: math }).step('a', 'go', { context: { n: 3 } }).effects,
      [{ run: 'enter', with: 9 }]);
  });

  it('a guard calls a registry\'s `$call` function', () => {
    const doc = machine({ guard: { $eq: [{ $call: ['twice', '$.context.n'] }, 8] } });
    assert.equal(compileFsm(doc, { operators: host }).step('a', 'go', { context: { n: 4 } }).state, 'b');
    assert.throws(() => compileFsm(doc), (/** @type {any} */ err) => err.code === 'JF0007' && err.cause?.code === 'JQ0010');
  });

  it('without the operator mounted the refusal is the JQ0002 it was', () => {
    for (const options of [undefined, {}, { operators: null }, { operators: undefined }, { operators: finance }, { operators: createJsltRegistry() }]) {
      const label = JSON.stringify(options) ?? 'undefined';
      assert.throws(() => compileFsm(sqrtGuard, options), unknownOperator('JF0007', '/transitions/0/guard', '$sqrt'), label);
      assert.throws(() => compileFsm(sqrtWith, options), unknownOperator('JF0009', '/transitions/0/effects/0/with', '$sqrt'), label);
      assert.throws(() => compileFsm(sqrtEntry, options), unknownOperator('JF0009', '/states/1/entry/0/with', '$pow'), label);
    }
    assert.throws(() => compileFsm(machine({ guard: { $sqrtt: 4 } }), { operators: math }), unknownOperator('JF0007', '/transitions/0/guard', '$sqrtt'));
  });

  it('a machine that names no registry operator steps exactly as without one', () => {
    const core = machine({ guard: { $gt: [{ $abs: '$.context.n' }, 3] }, effects: [{ run: 'log', with: { $add: ['$.context.n', 1] } }] });
    for (const n of [-5, 2]) {
      assert.deepEqual(compileFsm(core, { operators: math }).step('a', 'go', { context: { n } }),
        compileFsm(core).step('a', 'go', { context: { n } }), String(n));
    }
  });

  it('refuses an operators value that is no registry', () => {
    for (const value of [{}, mathPack, 'math', 1]) {
      assert.throws(() => compileFsm(sqrtGuard, { operators: /** @type {any} */ (value) }), {
        name: 'TypeError', message: 'compileFsm: "operators" must be an operator registry (an object with a toOptions function)',
      });
    }
  });
});

describe('compileDag: the operators option', () => {
  it('query and jslt nodes, a task\'s `with` and an edge\'s `select` compute with it', async () => {
    assert.equal(await compileDag(queryNode, { operators: math }).run({ n: 16 }), 4);
    assert.deepEqual(await compileDag(jsltNode, { operators: math }).run({ n: 3 }), { r: 9 });
    assert.equal(await compileDag(taskWith, { tasks, operators: math }).run({ n: 25 }), 5);
    assert.equal(await compileDag(edgeSelect, { operators: math }).run({ n: 9 }), 3);
  });

  it('without the operator mounted each is the JQ0002 it was', () => {
    for (const operators of [undefined, null, finance, createJsltRegistry()]) {
      const label = String(operators && operators.packs().map((p) => p.name));
      assert.throws(() => compileDag(queryNode, { operators }), unknownOperator('JF0014', '/nodes/q/query', '$sqrt'), label);
      assert.throws(() => compileDag(jsltNode, { operators }), unknownOperator('JF0014', '/nodes/j/stylesheet', '$pow'), label);
      assert.throws(() => compileDag(taskWith, { tasks, operators }), unknownOperator('JF0014', '/nodes/t/with', '$sqrt'), label);
      assert.throws(() => compileDag(edgeSelect, { operators }), unknownOperator('JF0014', '/edges/0/select', '$sqrt'), label);
    }
    assert.throws(() => compileDag(queryNode), unknownOperator('JF0014', '/nodes/q/query', '$sqrt'));
  });

  it('a graph that names no registry operator runs exactly as without one', async () => {
    const core = graph({ q: { kind: 'query', query: { $abs: '$.n' } } }, [{ from: 'in', to: 'q' }, { from: 'q', to: 'out', select: { $add: ['$', 1] } }]);
    assert.equal(await compileDag(core, { operators: math }).run({ n: -4 }), 5);
    assert.equal(await compileDag(core).run({ n: -4 }), 5);
  });

  it('refuses an operators value that is no registry', () => {
    for (const value of [{}, mathPack, 'math']) {
      assert.throws(() => compileDag(queryNode, { operators: /** @type {any} */ (value) }), {
        name: 'TypeError', message: 'compileDag: "operators" must be an operator registry (an object with a toOptions function)',
      });
    }
  });
});

describe('fsmToApp: the operators option', () => {
  it('accepts a machine whose guard uses a registry operator, and the app hosting it runs under the same registry', () => {
    const { slice, actions } = fsmToApp(sqrtGuard, { operators: math });
    const app = createApp({ state: { fsm: slice, n: 16 }, view: [{ match: '$', body: ['p', {}, '$.fsm.current'] }], actions },
      { schedule: (/** @type {() => void} */ f) => f(), operators: math });
    app.dispatch('fsm/go');
    assert.deepEqual(app.getState(), { fsm: { current: 'b' }, n: 16 });
    app.destroy();
  });

  it('without one the machine is refused as compileFsm refuses it', () => {
    assert.throws(() => fsmToApp(sqrtGuard), unknownOperator('JF0007', '/transitions/0/guard', '$sqrt'));
    assert.throws(() => fsmToApp(sqrtGuard, { operators: finance }), unknownOperator('JF0007', '/transitions/0/guard', '$sqrt'));
  });
});
