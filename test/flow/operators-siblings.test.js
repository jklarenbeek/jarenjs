//@ts-check
/**
 * @file The `operators` option of the flow compilers beyond `compileFsm`
 * and `compileDag`: a statechart's guards and effect `with`, a workflow's
 * guards, task `with` and `input` queries (through `lowerWorkflow` and
 * `compileWorkflow`), and the machine `fsmStateSchema` checks all compile
 * with an operator registry's operators. Without one each is the `JQ0002`
 * refusal it was, and a document that names no registry operator answers
 * exactly as without one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileStatechart, compileWorkflow, lowerWorkflow, fsmStateSchema, fsmToApp, FlowCompileError } from '@jarenjs/flow';
import { createJsltRegistry, mathPack, financePack } from '@jarenjs/json/jslt';

const math = createJsltRegistry().use(mathPack);
const finance = createJsltRegistry().use(financePack);
const none = [undefined, {}, { operators: null }, { operators: finance }, { operators: createJsltRegistry() }];
const NOT_A_REGISTRY = '"operators" must be an operator registry (an object with a toOptions function)';

/** @param {string} code @param {string | null} docPath - null: not compared @param {string} name */
const unknownOperator = (code, docPath, name) => (/** @type {any} */ err) => err instanceof FlowCompileError
  && err.code === code && (docPath === null || err.docPath === docPath) && err.cause?.code === 'JQ0002'
  && new RegExp(`unknown operator '\\${name}'`).test(err.cause.message);

/** A statechart a -> b whose guard, transition effect and entry/exit effects use `$sqrt` / `$pow`. */
const chart = {
  $fsm: '0.2', initial: 'a',
  states: [{ id: 'a', exit: [{ run: 'leave', with: { $pow: ['$.context.n', 2] } }] },
    { id: 'b', entry: [{ run: 'enter', with: { $sqrt: '$.context.n' } }] }],
  transitions: [{ from: 'a', event: 'go', to: 'b', guard: { $gt: [{ $sqrt: '$.context.n' }, 3] },
    effects: [{ run: 'log', with: { $sqrt: { $add: ['$.context.n', 9] } } }] }],
};
/** @param {any} doc @param {string} at - the member to keep, the others dropped */
const only = (doc, at) => {
  const copy = structuredClone(doc);
  const [a, b] = copy.states;
  const t = copy.transitions[0];
  if (at !== 'exit') delete a.exit;
  if (at !== 'entry') delete b.entry;
  if (at !== 'guard') delete t.guard;
  if (at !== 'effects') delete t.effects;
  return copy;
};

const workflow = {
  $workflow: '0.2', revision: 'test/1', initial: 'check', states: {
    check: { choose: [{ guard: { $gt: [{ $sqrt: '$.context.data' }, 3] }, to: 'work' }], otherwise: 'done' },
    work: { work: { task: 't', version: '1', with: { $sqrt: '$' } }, input: { $pow: ['$.context.data', 2] }, then: 'done' },
    done: { final: true },
  },
};
const tasks = { t: { version: '1', run: (/** @type {{ with: any, input: any }} */ p) => ({ with: p.with, input: p.input }) } };
/** @param {any} states @returns {any} */
const flowOf = (states) => ({ $workflow: '0.2', revision: 'test/1', initial: 'work', states });

describe('compileStatechart: the operators option', () => {
  it('a guard, a transition effect and entry and exit effects compute with a registry operator', () => {
    const compiled = compileStatechart(chart, { operators: math });
    const start = compiled.start({ context: { n: 16 } });
    const go = compiled.step(start.state, 'go', { context: { n: 16 } });
    assert.deepEqual(go.state.active, ['b']);
    assert.deepEqual(go.effects, [{ run: 'leave', with: 256 }, { run: 'log', with: 5 }, { run: 'enter', with: 4 }]);
    assert.deepEqual(compiled.step(start.state, 'go', { context: { n: 4 } }).state.active, ['a']);
  });

  it('without the operator mounted each is the JQ0002 it was', () => {
    for (const options of none) {
      const label = JSON.stringify(options) ?? 'undefined';
      assert.throws(() => compileStatechart(only(chart, 'guard'), options), unknownOperator('JF0007', '/transitions/0/guard', '$sqrt'), label);
      assert.throws(() => compileStatechart(only(chart, 'effects'), options), unknownOperator('JF0009', '/transitions/0/effects/0/with', '$sqrt'), label);
      assert.throws(() => compileStatechart(only(chart, 'entry'), options), unknownOperator('JF0009', '/states/1/entry/0/with', '$sqrt'), label);
      assert.throws(() => compileStatechart(only(chart, 'exit'), options), unknownOperator('JF0009', '/states/0/exit/0/with', '$pow'), label);
    }
  });

  it('a statechart that names no registry operator steps exactly as without one', () => {
    const core = { ...only(chart, ''), transitions: [{ from: 'a', event: 'go', to: 'b', guard: { $gt: [{ $abs: '$.context.n' }, 3] },
      effects: [{ run: 'log', with: { $add: ['$.context.n', 1] } }] }] };
    for (const n of [-5, 2]) {
      const withMath = compileStatechart(core, { operators: math });
      const plain = compileStatechart(core);
      assert.deepEqual(withMath.step(withMath.start().state, 'go', { context: { n } }), plain.step(plain.start().state, 'go', { context: { n } }), String(n));
    }
  });

  it('refuses an operators value that is no registry', () => {
    for (const value of [{}, mathPack, 'math']) {
      assert.throws(() => compileStatechart(chart, { operators: /** @type {any} */ (value) }),
        { name: 'TypeError', message: `compileStatechart: ${NOT_A_REGISTRY}` });
    }
  });
});

describe('lowerWorkflow and compileWorkflow: the operators option', () => {
  it('a choose guard, a task `with` and a state `input` compute with a registry operator', async () => {
    assert.deepEqual(lowerWorkflow(workflow, { operators: math }).fsm.transitions[0].guard, { $gt: [{ $sqrt: '$.context.data' }, 3] });
    const compiled = compileWorkflow(workflow, { tasks, operators: math });
    assert.deepEqual((await compiled.run(16, { runId: 'big' })).result, { with: 16, input: 256 });
    assert.equal((await compiled.run(4, { runId: 'small' })).result, 4);
  });

  it('an embedded DAG and an `on` guard compute with it', async () => {
    const dag = { $dag: '0.1', nodes: { in: { kind: 'input' }, q: { kind: 'query', query: { $sqrt: '$' } }, out: { kind: 'output' } },
      edges: [{ from: 'in', to: 'q' }, { from: 'q', to: 'out' }] };
    const doc = flowOf({ work: { work: { dag }, then: 'wait' }, wait: { on: [{ event: 'ok', guard: { $gt: [{ $sqrt: '$.context.data' }, 1] }, to: 'done' }] }, done: { final: true } });
    const compiled = compileWorkflow(doc, { operators: math });
    const first = await compiled.run(9, { runId: 'r' });
    assert.equal(first.snapshot.context.data, 3);
    const end = await compiled.run(9, { runId: 'r', snapshot: first.snapshot, event: { type: 'ok' } });
    assert.deepEqual([end.status, end.result], ['done', 3]);
  });

  it('without the operator mounted each is the JQ0002 it was', () => {
    // a guard's refusal names its place in the lowered machine, not in the
    // workflow document, so its place is not compared here
    const cases = [
      [workflow, 'JF0007', null, '$sqrt'],
      [flowOf({ work: { work: { task: 't', version: '1', with: { $sqrt: '$' } }, then: 'done' }, done: { final: true } }), 'JF0014', '/states/work/work/with', '$sqrt'],
      [flowOf({ work: { work: { task: 't', version: '1' }, input: { $pow: ['$.context.data', 2] }, then: 'done' }, done: { final: true } }), 'JF0014', '/states/work/input', '$pow'],
    ];
    for (const options of none) {
      const label = JSON.stringify(options) ?? 'undefined';
      for (const [doc, code, docPath, name] of /** @type {Array<[any, string, string | null, string]>} */ (cases))
        assert.throws(() => compileWorkflow(doc, { tasks, ...options }), unknownOperator(code, docPath, name), `${label} ${docPath}`);
      assert.throws(() => lowerWorkflow(workflow, options), unknownOperator('JF0007', null, '$sqrt'), label);
    }
  });

  it('a workflow that names no registry operator runs exactly as without one', async () => {
    const core = flowOf({ work: { work: { task: 't', version: '1', with: { $abs: '$' } }, input: { $add: ['$.context.data', 1] }, then: 'done' }, done: { final: true } });
    assert.deepEqual(lowerWorkflow(core, { operators: math }), lowerWorkflow(core));
    assert.deepEqual((await compileWorkflow(core, { tasks, operators: math }).run(-5, { runId: 'r' })).result,
      (await compileWorkflow(core, { tasks }).run(-5, { runId: 'r' })).result);
  });

  it('refuses an operators value that is no registry, naming the compiler it was given to', () => {
    assert.throws(() => compileWorkflow(workflow, { tasks, operators: /** @type {any} */ (mathPack) }),
      { name: 'TypeError', message: `compileWorkflow: ${NOT_A_REGISTRY}` });
    assert.throws(() => lowerWorkflow(workflow, { operators: /** @type {any} */ ('math') }),
      { name: 'TypeError', message: `lowerWorkflow: ${NOT_A_REGISTRY}` });
  });
});

describe('fsmStateSchema: the operators option', () => {
  const machine = { initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b', guard: { $gt: [{ $sqrt: '$.context.n' }, 3] } }] };
  const schema = { type: 'object', required: ['current'],
    properties: { current: { description: 'The machine\'s control state: always one of the declared state ids.', enum: ['a', 'b'] } } };

  it('accepts the machine fsmToApp accepts under the same registry', () => {
    assert.equal(fsmToApp(machine, { operators: math }).slice.current, 'a');
    assert.deepEqual(fsmStateSchema(machine, { operators: math }), schema);
  });

  it('without the operator mounted the machine is the JQ0002 it was', () => {
    for (const options of none) {
      assert.throws(() => fsmStateSchema(machine, options), unknownOperator('JF0007', '/transitions/0/guard', '$sqrt'), JSON.stringify(options) ?? 'undefined');
    }
  });

  it('a machine that names no registry operator has the same schema', () => {
    const core = { ...machine, transitions: [{ from: 'a', event: 'go', to: 'b', guard: { $abs: 1 } }] };
    assert.deepEqual(fsmStateSchema(core, { operators: math }), schema);
    assert.deepEqual(fsmStateSchema(core), schema);
  });
});
