import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { compileContract } from '@jarenjs/contract';
import { servePort } from '@jarenjs/contract/port';
import { nodeDriver } from '@jarenjs/db/node';
import { createDataHandlers } from '../../packages/website/src/db-handlers.js';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { projectTemplate } from '../../packages/website/src/content/projectTemplates.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, fire } from '../view/dom.stub.js';
import contract from '../../packages/website/src/contracts/data.contract.json' with { type: 'json' };

const reply = (value) => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }] });
function find(node, label) {
  if (node.getAttribute?.('aria-label') === label) return node;
  for (const child of node.childNodes ?? []) { const hit = find(child, label); if (hit) return hit; }
}
function site(t, extra = {}) {
  const { container, document } = createStubHost();
  let route;
  let registered;
  const app = createSiteApp({ node: container, document, schedule: (f) => f(), debounceMs: 0,
    listenHash: (cb) => { route = cb; cb(parseHash('#/project')); },
    navigate: (hash) => route(parseHash(hash)), fetchJson: async () => { throw new Error('404'); },
    storage: { read: () => null, write: () => {} },
    aiStorage: { read: () => ({ provider: 'openrouter', baseUrl: '', model: 'test', apiKey: 'test-key' }), write: () => {} },
    modelContext: { provideContext: ({ tools }) => { registered = tools; } },
    ...extra,
  });
  t.after(() => app.destroy());
  return { app, container, tool: (name) => registered.find((tool) => tool.name === name) };
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

it('structured authoring publishes a validated file and returns a recoverable candidate on a concurrent edit', async (t) => {
  let pending;
  const requests = [];
  const { app, tool } = site(t, { aiFetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) return reply({ generated: true });
    return new Promise((resolve) => { pending = resolve; });
  } });
  const author = tool('jaren_project_author');
  const first = await author.execute({ name: 'generated.data', kind: 'data', prompt: 'Create data.' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(JSON.parse(app.getState().project.files.at(-1).text), { generated: true });
  const second = author.execute({ name: 'generated.data', prompt: 'Revise data.' });
  for (let i = 0; i < 100 && !pending; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(pending);
  const files = app.getState().project.files.map((f) => f.name === 'generated.data' ? { ...f, text: '{"human":true}' } : f);
  app.dispatch('project/files-set', { files });
  pending(reply({ generated: 'later' }));
  const conflict = await second;
  assert.equal(conflict.conflict, true);
  assert.deepEqual(JSON.parse(conflict.file.text), { generated: 'later' });
  assert.equal(app.getState().project.files, files);
  assert.equal(requests[0].response_format.json_schema.name, 'studio_data');
});

it('the assistant model runner uses the injected private worker and app teardown closes it', async (t) => {
  let terminated = 0;
  const releases = [];
  const { app, tool } = site(t, { projectWorker: () => {
    const { port1, port2 } = new MessageChannel();
    const table = createDataHandlers({ init: async () => ({ topology: 'memory', vfs: 'memory', version: '3' }),
      makeDriver: () => nodeDriver(), makeScratchDriver: () => nodeDriver(), path: () => ':memory:',
      vfs: () => 'memory', durable: () => false, unlink: () => {}, announce: () => {},
    });
    const server = servePort(compileContract(contract), table.handlers, { channel: port1 });
    const release = async () => { await server.close(); await table.dispose(); port1.close(); port2.close(); };
    releases.push(release);
    port2.terminate = () => { terminated++; void release(); };
    return port2;
  } });
  t.after(async () => { for (const release of releases) await release(); });
  app.dispatch('project/open', projectTemplate('store'));
  const result = await tool('jaren_project_run').execute({ name: 'notes.query' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.ran, /SELECT/);
  app.destroy();
  assert.equal(terminated, 1);
});
