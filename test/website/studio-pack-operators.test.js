//@ts-check
/**
 * @file The site's project surface runs an app that computes with the
 * site's registered operators: its IDE validates the app under the
 * site's registry, and the stage boots it through the site's document
 * host with that registry. A machine and a graph that compute with them
 * validate, run, and boot in the site's flow widget.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';

import { projectHost } from '../../packages/website/src/boundaries/project.js';
import { loadStudioDocument, validateAppDocument } from '../../packages/website/src/boundaries/studio.js';
import { operatorRegistry } from '../../packages/website/src/boundaries/engines.js';
import { createProjectFlowWidget } from '../../packages/website/src/boundaries/project-flow.js';
import { createStubHost, serialize, fire } from '../view/dom.stub.js';

const doc = { state: { n: 16, xs: [1, 2, 3, 6] }, view: [{ match: '$', body: ['p', {}, { $string: { $sqrt: '$.n' } }, ' ', { $string: { $mean: '$.xs[*]' } }] }] };

it('the site\'s IDE validates a pack-operator app, and its stage boots it', () => {
  const file = { name: 'app.json', kind: 'app', text: JSON.stringify(doc) };
  assert.deepEqual(projectHost.projectComponent.validateFile(file), { valid: true, kind: 'app', total: 0, errors: [], warnings: [] });
  assert.equal(validateAppDocument(doc, { operators: operatorRegistry }).valid, true);
  assert.equal(validateAppDocument(doc).valid, false, 'the document host alone mounts no registry');

  const { container } = createStubHost();
  /** @type {any[]} */
  const emitted = [];
  const stage = projectHost.createProjectStageWidget({ schedule: (/** @type {() => void} */ f) => f() });
  const handle = stage.mount(container, { doc, revision: 1 }, (/** @type {any} */ e) => emitted.push(e));
  assert.deepEqual(emitted, [{ action: 'project/stage-error', with: null }]);
  assert.notEqual(handle.app, null);
  assert.match(serialize(container), /<p>4 3<\/p>/);
  stage.unmount(handle);
  assert.equal(loadStudioDocument(doc, {}).ok, false);
});

it('the site\'s IDE validates and runs a pack-operator machine and graph, and its flow widget boots the machine', async () => {
  const machine = { $fsm: '0.1', initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b', guard: { $gt: [{ $sqrt: '$.context.n' }, 3] } }] };
  const graph = { $dag: '0.1', nodes: { in: { kind: 'input' }, q: { kind: 'query', query: { $mean: '$.xs[*]' } }, out: { kind: 'output' } },
    edges: [{ from: 'in', to: 'q' }, { from: 'q', to: 'out' }] };
  const files = [{ name: 'm.fsm', kind: 'fsm', text: JSON.stringify(machine) }, { name: 'g.dag', kind: 'dag', text: JSON.stringify(graph) }];
  for (const file of files) {
    assert.deepEqual(projectHost.projectComponent.validateFile(file), { valid: true, kind: file.kind, total: 0, errors: [], warnings: [] });
  }
  const project = (/** @type {any} */ file, /** @type {any} */ input) => ({ project: '0.1', active: file.name,
    files: [file, { name: 'in.data', kind: 'data', text: JSON.stringify(input) }] });
  const stepped = /** @type {any} */ (projectHost.runProjectFile(project(files[0], { context: { n: 16 }, events: ['go'] }), 'm.fsm'));
  assert.equal(JSON.parse(stepped.nodes[0].text).state, 'b');
  const ran = /** @type {any} */ (await projectHost.runProjectFile(project(files[1], { xs: [1, 2, 3, 6] }), 'g.dag'));
  assert.equal(ran.nodes[0].text, '3');

  const { container } = createStubHost();
  /** @type {any[]} */
  const emitted = [];
  const widget = createProjectFlowWidget({ schedule: (/** @type {() => void} */ f) => f() });
  const handle = widget.mount(container, { name: 'm.fsm', kind: 'fsm', doc: machine, input: { n: 16 }, revision: 1 }, (/** @type {any} */ e) => emitted.push(e));
  /** @param {any} node @returns {any} */
  const button = (node) => (node.tagName?.toLowerCase() === 'button' && serialize(node).includes('Run machine') ? node
    : [...(node.childNodes ?? [])].map(button).find(Boolean));
  fire(button(container), 'click');
  const markup = serialize(container);
  assert.doesNotMatch(markup, /unknown operator/);
  assert.match(markup, /flow-run-current/);
  widget.unmount(handle);
  assert.deepEqual(emitted.filter((e) => e.action === 'project/stage-error'), []);
});
