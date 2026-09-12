import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { projectTemplate } from '../../packages/website/src/content/projectTemplates.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, fire } from '../view/dom.stub.js';


function find(node, label) {
  if (node.getAttribute?.('aria-label') === label) return node;
  for (const child of node.childNodes ?? []) { const hit = find(child, label); if (hit) return hit; }
}
function site(t, extra = {}) {
  const { container, document } = createStubHost();
  let route;
  const app = createSiteApp({ node: container, document, schedule: (f) => f(), debounceMs: 0,
    listenHash: (cb) => { route = cb; cb(parseHash('#/project')); },
    navigate: (hash) => route(parseHash(hash)), fetchJson: async () => { throw new Error('404'); },
    storage: { read: () => null, write: () => {} },
    ...extra,
  });
  t.after(() => app.destroy());
  return { app, container };
}

it('routing, diagram edits and offline export operate on the complete project snapshot', async (t) => {
  let exported;
  const { app, container } = site(t, { exportProject: async (project) => { exported = project; return true; } });
  const project = projectTemplate('fsm');
  project.files.push({ name: 'seed', kind: 'data', text: '{"ready":true}' });
  app.dispatch('project/open', project);
  fire(find(container, 'Input file'), 'change', { target: { value: 'seed' } });
  assert.equal(app.getState().project.files[0].input, 'seed');
  const doc = JSON.parse(project.files[0].text);
  doc.states.push('added');
  app.dispatch('project/artifact-edit', { name: project.active, doc });
  assert.deepEqual(JSON.parse(app.getState().project.files[0].text).states, doc.states);
  app.dispatch('project/eject');
  await Promise.resolve();
  assert.equal(exported.files[0].input, 'seed');
  assert.equal(exported.files.length, 2);
  assert.equal(exported.layout.mode, project.layout.mode);
});
