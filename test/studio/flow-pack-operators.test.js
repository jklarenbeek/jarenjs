//@ts-check
/**
 * @file Flow files under the studio's operator registry: an fsm or dag
 * file whose guard, effect props, query, stylesheet, task `with` or edge
 * `select` uses a pack operator validates under a registry that mounts
 * the pack (the built-in math/finance/stats packs when the host names
 * none), and runs under that same registry: `runProjectFile`, the Flow
 * runtime's machine and dag runs, and the project's flow widget. Under a
 * registry without the pack it is the `JQ0002` it was, and a flow that
 * names no registry operator answers exactly as before.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateFile, fileSkeleton } from '@jarenjs/studio';
import { createProjectHost, mountStudioEditor } from '@jarenjs/studio/component';
import { createFlowRuntime } from '@jarenjs/studio/flow';
import { createFlowController } from '../../components/studio/src/flow-editor.js';
import { defaultOperators } from '../../components/studio/src/validate.js';
import { createJsltRegistry, mathPack, financePack } from '@jarenjs/json/jslt';
import { createStubHost, serialize, fire } from '../view/dom.stub.js';

const math = createJsltRegistry().use(mathPack);
const finance = createJsltRegistry().use(financePack);
const empty = createJsltRegistry();
/** A host registry with an operator the built-in packs do not hold. */
const triple = createJsltRegistry().use({ name: 'triple', entries: {
  $triple: { kind: 'op', signature: ['number'], result: 'number', fn: (/** @type {number} */ x) => x * 3 },
} });

/** @param {any} guard */
const machine = (guard) => ({ $fsm: '0.1', initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b', guard }] });
const sqrtMachine = machine({ $gt: [{ $sqrt: '$.context.n' }, 3] });
/**
 * @param {Record<string, any>} nodes
 * @param {any[]} edges
 */
const graph = (nodes, edges) => ({ $dag: '0.1', nodes: { in: { kind: 'input' }, ...nodes, out: { kind: 'output' } }, edges });
const sqrtGraph = graph({ q: { kind: 'query', query: { $sqrt: '$.n' } } }, [{ from: 'in', to: 'q' }, { from: 'q', to: 'out' }]);
const powGraph = graph({ j: { kind: 'jslt', stylesheet: [{ match: '$', body: { r: { $pow: ['$.n', 2] } } }] } },
  [{ from: 'in', to: 'j' }, { from: 'j', to: 'out', select: { $sqrt: '$.r' } }]);

/**
 * @param {'fsm' | 'dag'} kind
 * @param {any} doc
 * @param {any} [operators]
 */
const verdict = (kind, doc, operators) => validateFile({ name: `f.${kind}`, kind, text: JSON.stringify(doc) }, operators ? { operators } : {});
/** @param {'fsm' | 'dag'} kind */
const valid = (kind) => ({ valid: true, kind, total: 0, errors: [], warnings: [] });
/**
 * @param {'fsm' | 'dag'} kind
 * @param {string} docPath
 * @param {string} message
 */
const refused = (kind, docPath, message) => ({ valid: false, kind, total: 1, errors: [{ code: 'JQ0002', message, docPath }], warnings: [] });

describe('fsm and dag files validate under the registry', () => {
  it('a pack operator validates under a registry that mounts it, the default one included', () => {
    for (const operators of [undefined, math, defaultOperators]) {
      assert.deepEqual(verdict('fsm', sqrtMachine, operators), valid('fsm'));
      assert.deepEqual(verdict('dag', sqrtGraph, operators), valid('dag'));
      assert.deepEqual(verdict('dag', powGraph, operators), valid('dag'));
    }
    assert.deepEqual(verdict('fsm', machine({ $gt: [{ $pmt: [0.01, 12, '$.context.n'] }, 3] }), finance), valid('fsm'));
    const effect = { $fsm: '0.1', initial: 'a', states: ['a'], transitions: [{ from: 'a', to: 'a', effects: [{ run: 'log', with: { $sqrt: 4 } }] }] };
    assert.deepEqual(verdict('fsm', effect), valid('fsm'));
    const task = graph({ t: { kind: 'task', run: 'x', with: { $sqrt: 4 } } }, [{ from: 'in', to: 't' }, { from: 't', to: 'out' }]);
    assert.deepEqual(verdict('dag', task), valid('dag'));
  });

  it('under a registry without the pack it is refused as before', () => {
    const sqrt = "unknown operator '$sqrt' (no operator does this in jaren-query)";
    for (const operators of [finance, empty]) {
      assert.deepEqual(verdict('fsm', sqrtMachine, operators), refused('fsm', '/transitions/0/guard/$gt/0', sqrt));
      assert.deepEqual(verdict('dag', sqrtGraph, operators), refused('dag', '/nodes/q/query', sqrt));
    }
    assert.deepEqual(verdict('fsm', machine({ $gt: [{ $pmt: [0.01, 12, '$.context.n'] }, 3] }), math),
      refused('fsm', '/transitions/0/guard/$gt/0', "unknown operator '$pmt' (did you mean '$let'?)"));
  });

  it('a misspelt operator names the nearest one the registry mounts', () => {
    const typo = machine({ $gt: [{ $sqrtt: '$.context.n' }, 3] });
    assert.deepEqual(verdict('fsm', typo), refused('fsm', '/transitions/0/guard/$gt/0', "unknown operator '$sqrtt' (did you mean '$sqrt'?)"));
    assert.deepEqual(verdict('fsm', typo, empty), refused('fsm', '/transitions/0/guard/$gt/0', "unknown operator '$sqrtt' (did you mean '$sort'?)"));
  });

  it('a file failing its grammar for another reason does not report a mounted operator', () => {
    const doc = { initial: 'a', states: ['a'], transitions: [{ from: 'a', to: 'a', event: 5 }, { from: 'a', to: 'a', guard: { $sqrt: 4 } }] };
    assert.deepEqual(verdict('fsm', doc), { valid: false, kind: 'fsm', total: 2, warnings: [], errors: [
      { code: null, message: 'must be one of the following types: string, null', docPath: '/transitions/0/event' },
      { code: null, message: 'array items are invalid', docPath: '/transitions' },
    ] });
    const dag = graph({ q: { kind: 'query', query: { $sqrt: '$.n' } }, z: { kind: 'nope' } }, [{ from: 'in', to: 'q' }, { from: 'q', to: 'out' }]);
    const errors = verdict('dag', dag).errors;
    assert.equal(errors.some((e) => e.code === 'JQ0002'), false);
    assert.equal(errors.every((e) => e.docPath.startsWith('/nodes/z') || e.docPath === '/nodes'), true, JSON.stringify(errors));
  });

  it('a flow that names no registry operator answers exactly as without one', () => {
    const docs = /** @type {Array<['fsm' | 'dag', any]>} */ ([
      ['fsm', fileSkeleton('fsm')],
      ['dag', fileSkeleton('dag')],
      ['fsm', machine({ $gt: [{ $abs: '$.context.n' }, 3] })],
      ['fsm', machine({ $abs: [1, 2] })],
      ['fsm', machine({ $call: ['f'] })],
      ['fsm', { $fsm: '0.1', initial: 'a', states: [{ id: 'a', $sqrt: 1 }], transitions: [] }],
      ['dag', graph({ q: { kind: 'query', query: { $abs: '$.n' } } }, [{ from: 'in', to: 'q' }, { from: 'q', to: 'out' }])],
      ['dag', graph({ c: { kind: 'const', value: { $sqrt: 1 } } }, [{ from: 'c', to: 'out' }])],
    ]);
    for (const [kind, doc] of docs) {
      const core = verdict(kind, doc, empty);
      assert.deepEqual(verdict(kind, doc), core, JSON.stringify(doc));
      assert.deepEqual(verdict(kind, doc, math), core, JSON.stringify(doc));
    }
  });
});

describe('fsm and dag files run under the registry they validate under', () => {
  const runners = { loadDocument: () => ({ ok: false }), runQuery: () => [], runJslt: () => [], runValidation: () => null };
  /** @param {Array<{ name: string, kind: string, text: string }>} files */
  const project = (files) => ({ project: '0.1', files, active: files[0].name });
  const fsmFile = { name: 'm.fsm', kind: 'fsm', text: JSON.stringify(sqrtMachine) };
  const dagFile = { name: 'g.dag', kind: 'dag', text: JSON.stringify(powGraph) };
  const input = (/** @type {any} */ value) => ({ name: 'in.data', kind: 'data', text: JSON.stringify(value) });

  it('runProjectFile steps a machine and runs a graph with the host\'s registry, else the default one', async () => {
    for (const host of [createProjectHost(runners), createProjectHost({ ...runners, operators: math })]) {
      const machineRun = /** @type {any} */ (host.runProjectFile(project([fsmFile, input({ context: { n: 16 }, events: ['go'] })]), 'm.fsm'));
      assert.equal(JSON.parse(machineRun.nodes[0].text).state, 'b');
      const graphRun = /** @type {any} */ (await host.runProjectFile(project([dagFile, input({ n: 7 })]), 'g.dag'));
      assert.equal(graphRun.nodes[0].text, '7');
    }
    const finance = createProjectHost({ ...runners, operators: createJsltRegistry().use(financePack) });
    const refusedRun = /** @type {any} */ (finance.runProjectFile(project([fsmFile, input({ context: { n: 16 }, events: ['go'] })]), 'm.fsm'));
    assert.match(JSON.stringify(refusedRun.nodes), /unknown operator '\$sqrt'/);
    const refusedGraph = /** @type {any} */ (finance.runProjectFile(project([dagFile, input({ n: 7 })]), 'g.dag'));
    assert.match(JSON.stringify(refusedGraph.nodes), /unknown operator '\$pow'/);
  });

  it('the project host answers the registry its files validate, boot and run under', () => {
    assert.equal(createProjectHost(runners).operators, defaultOperators);
    assert.equal(createProjectHost({ ...runners, operators: math }).operators, math);
  });

  it('the Flow runtime runs a graph and boots a machine with its registry, else the default one', async () => {
    for (const env of [{}, { operators: math }]) {
      const runtime = createFlowRuntime({ schedule: (/** @type {() => void} */ f) => f(), ...env });
      /** @type {any[]} */
      const seen = [];
      const result = await runtime.effects['flow-dag-run']({ doc: powGraph, inputText: '{"n":7}' }, (/** @type {string} */ a, /** @type {any} */ p) => seen.push([a, p]));
      assert.equal(result.ok, true, JSON.stringify(seen));
      assert.deepEqual(seen.find(([a]) => a === 'flow/dag-done')?.[1].output, 7);
      const { container } = createStubHost();
      /** @type {any[]} */
      const emitted = [];
      const handle = runtime.widget.mount(container, { doc: sqrtMachine, revision: 1, context: { n: 16 } }, (/** @type {any} */ e) => emitted.push(e));
      assert.deepEqual(emitted.filter((e) => e.with?.run === 'error'), []);
      runtime.effects['flow-run-send']({ event: 'go' });
      assert.match(serialize(container), /b<\/div>/);
      runtime.widget.unmount(handle);
      runtime.dispose();
    }
    const runtime = createFlowRuntime({ schedule: (/** @type {() => void} */ f) => f(), operators: empty });
    const result = await runtime.effects['flow-dag-run']({ doc: powGraph, inputText: '{"n":7}' }, () => {});
    assert.equal(result.ok, false);
    assert.match(result.error, /unknown operator '\$pow'/);
    const { container } = createStubHost();
    /** @type {any[]} */
    const emitted = [];
    runtime.widget.mount(container, { doc: sqrtMachine, revision: 1, context: null }, (/** @type {any} */ e) => emitted.push(e));
    assert.match(emitted.find((e) => e.with?.run === 'error')?.with.props, /unknown operator '\$sqrt'/);
    runtime.dispose();
  });

  it('the Flow editor publishes under the registry it is handed', () => {
    const tripled = machine({ $gt: [{ $triple: '$.context.n' }, 3] });
    const controller = (/** @type {any} */ operators) => createFlowController({ getApp: () => null, runtime: null, operators });
    assert.deepEqual(controller(triple).validate(tripled, 'fsm'), valid('fsm'));
    assert.equal(controller(undefined).validate(tripled, 'fsm').valid, false);
    assert.equal(controller(undefined).validate(sqrtMachine, 'fsm').valid, true);
  });

  it('the project\'s flow widget runs a machine under the host\'s registry', (t) => {
    const tripled = machine({ $gt: [{ $triple: '$.context.n' }, 3] });
    const host = createProjectHost({ ...runners, operators: triple });
    const { container } = createStubHost();
    const editor = mountStudioEditor(container, { host, schedule: (/** @type {() => void} */ f) => f(), debounceMs: 0, project: {
      project: '0.1', active: 'm.fsm',
      files: [{ name: 'm.fsm', kind: 'fsm', text: JSON.stringify(tripled), input: 'in.data' }, input({ context: { n: 2 } })],
    } });
    t.after(() => editor.dispose());
    /** @param {any} node @returns {any} */
    const button = (node) => (node.tagName?.toLowerCase() === 'button' && serialize(node).includes('Run machine') ? node
      : [...(node.childNodes ?? [])].map(button).find(Boolean));
    fire(button(container), 'click');
    const markup = serialize(container);
    assert.doesNotMatch(markup, /unknown operator/);
    assert.match(markup, /flow-run-current/);
  });
});
