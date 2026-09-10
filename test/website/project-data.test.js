//@ts-check
/** File routing and resource ownership over real contract ports and SQLite. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { compileContract, ContractFailure } from '@jarenjs/contract';
import { servePort } from '@jarenjs/contract/port';
import { nodeDriver } from '@jarenjs/db/node';
import { createDataHandlers } from '../../packages/website/src/db-handlers.js';
import { createProjectDataRuntime } from '../../packages/website/src/boundaries/project-data.js';
import { commitProject } from '../../packages/website/src/boundaries/project.js';
import { projectTemplate } from '../../packages/website/src/content/projectTemplates.js';
import doc from '../../packages/website/src/contracts/data.contract.json' with { type: 'json' };
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

async function until(check) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.ok(check(), 'the worker view settled');
}
function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) { const hit = find(child, predicate); if (hit) return hit; }
}

function setup(t, overrides = {}) {
  const resources = [];
  const servers = [];
  let created = 0;
  let terminated = 0;
  const runtime = createProjectDataRuntime({ createWorker: () => {
    created++;
    const { port1, port2 } = new MessageChannel();
    const table = createDataHandlers({
      init: async () => ({ topology: 'owner', vfs: 'memory', version: '3' }),
      makeDriver: () => nodeDriver(), makeScratchDriver: () => nodeDriver(),
      path: () => ':memory:', vfs: () => 'memory', durable: () => false,
      unlink: () => {}, announce: () => {},
    });
    const server = servePort(compileContract(doc), { ...table.handlers, ...overrides }, { channel: port1 });
    servers.push(server);
    const release = async () => { await server.close(); await table.dispose(); port1.close(); port2.close(); };
    resources.push(release);
    port2.terminate = () => { terminated++; void release(); };
    return port2;
  } });
  t.after(async () => { runtime.dispose(); for (const release of resources) await release(); });
  return { runtime, created: () => created, terminated: () => terminated,
    shutdown: () => Promise.all(servers.map((server) => server.close())) };
}

it('model/query files share rows, independent models isolate them, deletion and teardown retire each owner', async (t) => {
  const { runtime, created, terminated } = setup(t);
  const project = projectTemplate('store');
  const model = project.files.find((f) => f.kind === 'model');
  const first = runtime.acquire(project, model);
  await first.entry.ready;
  await first.entry.request('data.insert', { collection: 'notes', doc: { id: 'one', title: 'retained', points: 20 } });
  const result = await runtime.execute(project, 'notes.query');
  assert.match(JSON.stringify(result.result), /retained/);
  assert.match(JSON.stringify(result.plan), /SELECT/);
  assert.equal(created(), 1);
  const other = { ...model, name: 'other.model' };
  const independent = { ...project, files: [...project.files, other] };
  assert.deepEqual((await runtime.execute(independent, other.name)).result, []);
  assert.equal(created(), 2);
  runtime.sync(project);
  assert.equal(terminated(), 1);
  assert.equal(runtime.acquire(project, model).entry, first.entry);
  runtime.dispose();
  assert.equal(terminated(), 2);
});

it('invalid model drafts preserve the committed stage and owner; committed model/seed changes replace it', async (t) => {
  const { runtime, terminated } = setup(t);
  const base = projectTemplate('store');
  const model = base.files.find((f) => f.kind === 'model');
  const project = { ...base, active: model.name };
  const committed = { ...project, ...commitProject(project) };
  const first = runtime.acquire(project, model);
  await first.entry.ready;
  const invalid = { ...committed, files: project.files.map((f) => f === model ? { ...f, text: '{' } : f) };
  runtime.sync(invalid);
  assert.equal(commitProject(invalid).mount, committed.mount);
  assert.equal(terminated(), 0);
  const seed = { name: 'seed.data', kind: 'data', text: '{"notes":[{"id":"seed","title":"seeded","points":20}]}' };
  const seededModel = { ...model, input: seed.name };
  const seeded = { ...project, files: [...project.files.map((f) => f === model ? seededModel : f), seed] };
  assert.match(JSON.stringify((await runtime.execute(seeded, model.name)).result), /seeded/);
  assert.equal(terminated(), 1);
  runtime.sync(seeded, true);
  assert.equal(terminated(), 2);
});

it('the model widget owns one live view across query switches and releases it on unmount', async (t) => {
  const { runtime } = setup(t);
  const { container } = createStubHost();
  const project = projectTemplate('store');
  const props = { files: project.files, name: 'notes.model', revision: 1 };
  const handle = runtime.widget.mount(container, props);
  t.after(() => runtime.widget.unmount(handle));
  await until(() => handle.ready && handle.live !== null);
  assert.equal((await handle.entry.request('data.lives', null)).count, 1);
  fire(find(container, (node) => node.__jarenOn?.click === 'insert'), 'click');
  await until(() => JSON.stringify(handle.live).includes('New note'));
  runtime.widget.update(handle, { ...props, name: 'notes.query', revision: 2 });
  await until(() => handle.ready && JSON.stringify(handle.result).includes('New note'));
  assert.match(serialize(container), /Query plan/);
  assert.equal((await handle.entry.request('data.lives', null)).count, 1);
  runtime.widget.unmount(handle);
  await until(() => container.childNodes.length === 0);
  // The stop message precedes the following request on the same port.
  assert.equal((await handle.entry.request('data.lives', null)).count, 0);
});

it('the model widget reports an ended stream when its server shuts down', async (t) => {
  const { runtime, shutdown } = setup(t);
  const { container } = createStubHost();
  const project = projectTemplate('store');
  const handle = runtime.widget.mount(container, { files: project.files, name: 'notes.model', revision: 1 });
  t.after(() => runtime.widget.unmount(handle));
  await until(() => handle.ready && handle.live !== null);
  await shutdown();
  await until(() => handle.status.startsWith('Live query ended:'));
  assert.match(serialize(container), /Live query ended: server-shutdown/);
});

it('the model widget reports a refused subscription alongside the completed query result', async (t) => {
  const { runtime } = setup(t, { 'data.live': () => ContractFailure('db', {}, { code: 'JD2005', message: 'live unavailable' }) });
  const { container } = createStubHost();
  const project = projectTemplate('store');
  const handle = runtime.widget.mount(container, { files: project.files, name: 'notes.model', revision: 1 });
  t.after(() => runtime.widget.unmount(handle));
  await until(() => handle.status.includes('live unavailable'));
  assert.deepEqual(handle.result, []);
  assert.match(serialize(container), /Live query: live unavailable/);
});
