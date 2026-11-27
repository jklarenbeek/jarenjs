//@ts-check
/**
 * @file The site's project surface runs an app that computes with the
 * site's registered operators: its IDE validates the app under the
 * site's registry, and the stage boots it through the site's document
 * host with that registry.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';

import { projectHost } from '../../packages/website/src/boundaries/project.js';
import { loadStudioDocument, validateAppDocument } from '../../packages/website/src/boundaries/studio.js';
import { operatorRegistry } from '../../packages/website/src/boundaries/engines.js';
import { createStubHost, serialize } from '../view/dom.stub.js';

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
