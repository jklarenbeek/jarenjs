import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { registerSiteWebMcp } from '../../packages/website/src/boundaries/webmcp.js';

function context() {
  const tools = new Map(), added = [], removed = [];
  return { tools, added, removed,
    registerTool(tool) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); added.push(tool.name); },
    unregisterTool(name) { assert.equal(tools.delete(name), true); removed.push(name); },
  };
}
function site(t, webmcp, extra = {}) {
  let navigate;
  const app = createSiteApp({ schedule: f => f(), debounceMs: 0,
    listenHash: callback => { navigate = hash => callback(parseHash(hash)); navigate('#/project'); },
    fetchJson: async () => { throw new Error('fixture has no benchmark service'); },
    storage: { read: () => null, write: () => {} }, webmcp, ...extra,
  });
  t.after(async () => { app.destroy(); await app.webmcp.dispose(); });
  return { app, navigate };
}

it('the actual site chooses document, navigator, aliases and unusable preferred roots exactly once', async t => {
  for (const mode of ['document', 'navigator', 'both', 'alias', 'unusable', 'throwing', 'legacy']) {
    const doc = context(), nav = context();
    const realm = { document: {}, navigator: {} };
    if (mode === 'document' || mode === 'both' || mode === 'alias') realm.document.modelContext = doc;
    if (mode !== 'document') realm.navigator.modelContext = mode === 'alias' ? doc : nav;
    if (mode === 'unusable') realm.document.modelContext = { registerTool: 1 };
    if (mode === 'throwing') Object.defineProperty(realm.document, 'modelContext', { get() { throw new Error('root blocked'); } });
    if (mode === 'legacy') { realm.document.modelContext = { provideContext({ tools }) { for (const tool of tools) doc.registerTool(tool); return () => { for (const tool of tools) doc.unregisterTool(tool.name); }; } }; }
    const { app, navigate } = site(t, { realm });
    const result = await app.webmcp.ready;
    const selected = ['document','both','alias','legacy'].includes(mode) ? doc : nav;
    assert.equal(result.status, 'registered', mode);
    assert.equal(result.registered, 5);
    assert.equal(result.root, selected === doc ? 'document' : 'navigator');
    assert.equal((selected === doc ? nav : doc).added.length, 0);
    const old = selected.tools.get('jaren_site_read');
    assert.deepEqual(await old.execute({}), { page: 'project', editor: 'project' });
    navigate('#/docs');
    assert.equal(app.webmcp.status, 'pending');
    assert.match((await old.execute({})).error, /inactive/);
    await app.webmcp.ready;
    assert.equal(selected.removed.length, 5);
    assert.deepEqual([...selected.tools.keys()], ['jaren_site_read']);
    await app.webmcp.dispose();
    assert.equal(selected.removed.length, 6);
    assert.equal(app.webmcp.status, 'disposed');
    assert.equal(app.webmcp.dispose(), app.webmcp.dispose());
    await app.webmcp.refresh();
  }
});

it('explicit null/undefined overrides remain authoritative and late capabilities register on refresh', async t => {
  for (const value of [null, undefined]) {
    const native = context();
    const { app } = site(t, { realm: { document: { modelContext: native } } }, { modelContext: value });
    assert.equal((await app.webmcp.ready).status, 'unavailable');
    assert.equal(native.added.length, 0);
  }
  const realm = {}, native = context(), { app } = site(t, { realm });
  assert.equal((await app.webmcp.ready).status, 'unavailable');
  realm.navigator = { modelContext: native };
  assert.equal((await app.webmcp.refresh()).status, 'registered');
  assert.equal(native.added.length, 5);
});

it('executes checked public editor operations, refuses invalid/stale inputs, and returns settled results', async t => {
  const native = context(), { app, navigate } = site(t, { context: native });
  await app.webmcp.ready;
  const execute = (name, value, options) => native.tools.get('jaren_'+name).execute(value, options);
  const initial = await execute('editor_read', {});
  const invalid = await execute('editor_replace', { document: {}, revision: initial.revision });
  assert.equal(invalid.ok, false);
  assert.equal((await execute('editor_read', {})).revision, initial.revision);
  assert.equal((await execute('editor_apply', { patch: [], revision: 'stale' })).conflict, true);
  assert.equal((await execute('editor_apply', { patch: 'bad', revision: initial.revision })).ok, false);
  assert.match((await execute('editor_read', {}, { signal: AbortSignal.abort() })).error, /inactive/);
  const changed = await execute('editor_apply', { patch: [{ op: 'replace', path: '/name', value: 'Reviewed' }], revision: initial.revision });
  assert.equal(changed.ok, true);
  const read = await execute('editor_read', {});
  assert.equal(read.document.name, 'Reviewed');
  const run = await execute('editor_run', { revision: read.revision });
  assert.equal(typeof run.ok, 'boolean');
  navigate('#/flow'); await app.webmcp.ready;
  assert.deepEqual(await execute('site_read', {}), { page: 'flow', editor: 'flow' });
  let flow = await execute('editor_read', {});
  const replaced = await execute('editor_replace', { kind: 'fsm', document: { initial: 'idle', states: ['idle','done'], transitions: [{ from: 'idle', to: 'done', event: 'go' }] }, revision: flow.revision });
  assert.equal(replaced.ok, true);
  flow = await execute('editor_read', {});
  assert.equal((await execute('editor_run', { revision: flow.revision, input: { events: ['go'] } })).ok, true);
  navigate('#/data'); await app.webmcp.ready;
  const data = await execute('editor_read', {});
  const unavailable = await execute('editor_run', { revision: data.revision, operation: 'query' });
  assert.equal(unavailable.ok, false, 'headless worker absence is a truthful refusal');
});

it('serializes async navigation/disposal and does not fall back after a registration failure', async t => {
  const native = context(), fallback = context(); let release, calls = 0;
  const late = { async registerTool(tool) { calls++; await new Promise(resolve => { release = resolve; }); native.registerTool(tool); return () => native.unregisterTool(tool.name); } };
  const { app, navigate } = site(t, { realm: { document: { modelContext: late }, navigator: { modelContext: fallback } } });
  assert.equal(app.webmcp.status, 'pending');
  navigate('#/flow'); navigate('#/docs');
  const closing = app.webmcp.dispose();
  release(); await closing;
  assert.equal(calls, 1); assert.equal(native.removed.length, 1); assert.equal(fallback.added.length, 0);
  const errors = [];
  const failed = site(t, { realm: { document: { modelContext: { registerTool() { throw new Error('browser refused'); } } }, navigator: { modelContext: fallback } } }, { onError: e => errors.push(e.message) }).app;
  assert.equal((await failed.webmcp.ready).status, 'failed');
  assert.deepEqual(errors, ['browser refused']);
  assert.equal(fallback.added.length, 0);
});

it('reports a thrown editor operation and deactivates an owned catalog on route change', async () => {
  const native = context(); let subscriber, page = 'project';
  const host = { getState: () => ({ route: { page } }), subscribe: fn => { subscriber = fn; return () => { subscriber = null; }; },
    projectEditor: { read: () => ({ revision: 'r' }), run: () => { throw Object.assign(new Error('execution failed'), { code: 'fixture' }); } } };
  const binding = registerSiteWebMcp(host, { context: native }); await binding.ready;
  assert.deepEqual(await native.tools.get('jaren_editor_run').execute({ revision: 'r' }), { ok: false, error: 'execution failed', code: 'fixture' });
  const old = native.tools.get('jaren_site_read'); page = 'docs';
  assert.match((await old.execute({})).error, /inactive/);
  subscriber(host.getState(), ['/route']); await binding.ready;
  await binding.dispose(); assert.equal(subscriber, null);
});
