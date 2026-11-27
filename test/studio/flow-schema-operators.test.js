//@ts-check
/**
 * @file Flow files and the schema operators: an fsm or dag file whose
 * guard, effect props, query, stylesheet, task `with` or edge `select`
 * uses `$valid` validates as a `query` file with the same `$valid` does,
 * because the studio compiles every file kind with one type-test compiler;
 * and it runs with that compiler too: `runProjectFile`, the Flow runtime's
 * machine and dag runs, and the project's flow widget.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateFile } from '@jarenjs/studio';
import { createProjectHost, mountStudioEditor } from '@jarenjs/studio/component';
import { createFlowRuntime } from '@jarenjs/studio/flow';
import { createFlowController } from '../../components/studio/src/flow-editor.js';
import { createStubHost, serialize, fire } from '../view/dom.stub.js';

const isNumber = (/** @type {string} */ at) => ({ $valid: [at, { type: 'number' }] });
/** @param {any} guard */
const machine = (guard) => ({ $fsm: '0.1', initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b', guard }] });
const validMachine = machine(isNumber('$.context.n'));
const effectMachine = { $fsm: '0.1', initial: 'a', states: ['a', 'b'],
  transitions: [{ from: 'a', event: 'go', to: 'b', effects: [{ run: 'log', with: isNumber('$.context.n') }] }] };
/** @param {Record<string, any>} nodes @param {any[]} edges */
const graph = (nodes, edges) => ({ $dag: '0.1', nodes: { in: { kind: 'input' }, ...nodes, out: { kind: 'output' } }, edges });
const queryGraph = graph({ q: { kind: 'query', query: isNumber('$.n') } }, [{ from: 'in', to: 'q' }, { from: 'q', to: 'out' }]);
const jsltGraph = graph({ j: { kind: 'jslt', stylesheet: [{ match: '$', body: 'other' }, { match: { schema: { type: 'object' } }, body: { ok: isNumber('$.n') } }] } },
  [{ from: 'in', to: 'j' }, { from: 'j', to: 'out', select: { $valid: ['$', { required: ['ok'] }] } }]);
const taskGraph = graph({ t: { kind: 'task', run: 'echo', with: isNumber('$.n') } }, [{ from: 'in', to: 't' }, { from: 't', to: 'out' }]);

/** @param {'fsm' | 'dag' | 'query'} kind @param {any} doc */
const verdict = (kind, doc) => validateFile({ name: `f.${kind}`, kind, text: JSON.stringify(doc) });
/** @param {'fsm' | 'dag' | 'query'} kind */
const valid = (kind) => ({ valid: true, kind, total: 0, errors: [], warnings: [] });

describe('fsm and dag files validate with the schema operators', () => {
  it('a $valid guard, effect, query, stylesheet match, task `with` and edge `select` validate as a query file does', () => {
    assert.deepEqual(verdict('query', isNumber('$.n')), valid('query'));
    assert.deepEqual(verdict('fsm', validMachine), valid('fsm'));
    assert.deepEqual(verdict('fsm', effectMachine), valid('fsm'));
    assert.deepEqual(verdict('dag', queryGraph), valid('dag'));
    assert.deepEqual(verdict('dag', jsltGraph), valid('dag'));
    assert.deepEqual(verdict('dag', taskGraph), valid('dag'));
  });

  it('a malformed $valid is refused where a query file refuses it', () => {
    const bad = { $valid: ['$.n', { type: 'nope' }] };
    const query = verdict('query', bad);
    assert.equal(query.valid, false);
    const fsm = verdict('fsm', machine(bad));
    assert.equal(fsm.valid, false);
    assert.equal(fsm.errors[0].code, 'JF0007');
    assert.equal(fsm.errors[0].docPath, '/transitions/0/guard');
  });

  it('a file failing its grammar for another reason reports only that', () => {
    const doc = { initial: 'a', states: ['a'], transitions: [{ from: 'a', to: 'a', event: 5 }, { from: 'a', to: 'a', guard: isNumber('$.context.n') }] };
    assert.deepEqual(verdict('fsm', doc), { valid: false, kind: 'fsm', total: 2, warnings: [], errors: [
      { code: null, message: 'must be one of the following types: string, null', docPath: '/transitions/0/event' },
      { code: null, message: 'array items are invalid', docPath: '/transitions' },
    ] });
  });

  it('a $valid guard does not hide a misspelt operator after it in a file failing its grammar', () => {
    const doc = { initial: 'a', states: ['a'], transitions: [{ from: 'a', to: 'a', guard: isNumber('$.context.n') },
      { from: 'a', to: 'a', guard: { $sqrtt: 4 } }, { from: 'a', to: 'a', event: 5 }] };
    assert.deepEqual(verdict('fsm', doc), { valid: false, kind: 'fsm', total: 2, warnings: [], errors: [
      { code: 'JQ0002', message: "unknown operator '$sqrtt' (did you mean '$sqrt'?)", docPath: '/transitions/1/guard' },
      { code: null, message: 'must be one of the following types: string, null', docPath: '/transitions/2/event' },
    ] });
    const dag = graph({ q: { kind: 'query', query: isNumber('$.n') }, r: { kind: 'query', query: { $sqrtt: '$.n' } }, z: { kind: 'nope' } },
      [{ from: 'in', to: 'q' }, { from: 'q', to: 'r' }, { from: 'r', to: 'out' }]);
    const errors = verdict('dag', dag).errors;
    assert.deepEqual(errors.filter((e) => e.code !== null), [{ code: 'JQ0002', message: "unknown operator '$sqrtt' (did you mean '$sqrt'?)", docPath: '/nodes/r/query' }]);
  });

  it('the Flow editor publishes a $valid machine', () => {
    const controller = createFlowController({ getApp: () => null, runtime: null });
    assert.deepEqual(controller.validate(validMachine, 'fsm'), valid('fsm'));
  });
});

describe('fsm and dag files run with the schema operators', () => {
  const runners = { loadDocument: () => ({ ok: false }), runQuery: () => [], runJslt: () => [], runValidation: () => null };
  /** @param {Array<{ name: string, kind: string, text: string }>} files */
  const project = (files) => ({ project: '0.1', files, active: files[0].name });
  const input = (/** @type {any} */ value) => ({ name: 'in.data', kind: 'data', text: JSON.stringify(value) });

  it('runProjectFile steps a $valid machine and runs a $valid graph', async () => {
    const host = createProjectHost(runners);
    for (const [n, state] of /** @type {Array<[any, string]>} */ ([[16, 'b'], ['x', 'a']])) {
      const run = /** @type {any} */ (host.runProjectFile(project([{ name: 'm.fsm', kind: 'fsm', text: JSON.stringify(validMachine) },
        input({ context: { n }, events: ['go'] })]), 'm.fsm'));
      assert.equal(JSON.parse(run.nodes[0].text).state, state, String(n));
    }
    for (const [doc, n, output] of /** @type {Array<[any, any, string]>} */ ([[queryGraph, 7, 'true'], [queryGraph, 'x', 'false'], [jsltGraph, 7, 'true']])) {
      const run = /** @type {any} */ (await host.runProjectFile(project([{ name: 'g.dag', kind: 'dag', text: JSON.stringify(doc) }, input({ n })]), 'g.dag'));
      assert.equal(run.nodes[0].text, output, `${JSON.stringify(doc.nodes)} ${n}`);
    }
  });

  it('the Flow runtime runs a $valid graph and boots and steps a $valid machine', async () => {
    const runtime = createFlowRuntime({ schedule: (/** @type {() => void} */ f) => f() });
    /** @type {any[]} */
    const seen = [];
    const result = await runtime.effects['flow-dag-run']({ doc: queryGraph, inputText: '{"n":7}' }, (/** @type {string} */ a, /** @type {any} */ p) => seen.push([a, p]));
    assert.equal(result.ok, true, JSON.stringify(seen));
    assert.equal(seen.find(([a]) => a === 'flow/dag-done')?.[1].output, true);
    for (const [n, current] of /** @type {Array<[any, string]>} */ ([[16, 'b'], ['x', 'a']])) {
      const { container } = createStubHost();
      /** @type {any[]} */
      const emitted = [];
      const handle = runtime.widget.mount(container, { doc: validMachine, revision: 1, context: { n } }, (/** @type {any} */ e) => emitted.push(e));
      assert.deepEqual(emitted.filter((e) => e.with?.run === 'error'), []);
      runtime.effects['flow-run-send']({ event: 'go' });
      assert.match(serialize(container), new RegExp(`${current}</div>`), String(n));
      runtime.widget.unmount(handle);
    }
    runtime.dispose();
  });

  it('the project\'s flow widget boots a $valid machine on Run machine', (t) => {
    const host = createProjectHost(runners);
    const { container } = createStubHost();
    const editor = mountStudioEditor(container, { host, schedule: (/** @type {() => void} */ f) => f(), debounceMs: 0, project: {
      project: '0.1', active: 'm.fsm',
      files: [{ name: 'm.fsm', kind: 'fsm', text: JSON.stringify(validMachine), input: 'in.data' }, input({ context: { n: 2 } })],
    } });
    t.after(() => editor.dispose());
    /** @param {any} node @returns {any} */
    const button = (node) => (node.tagName?.toLowerCase() === 'button' && serialize(node).includes('Run machine') ? node
      : [...(node.childNodes ?? [])].map(button).find(Boolean));
    fire(button(container), 'click');
    const markup = serialize(container);
    assert.doesNotMatch(markup, /type-test compiler/);
    assert.match(markup, /flow-run-current/);
  });
});
