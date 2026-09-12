import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { rmSync } from 'node:fs';
import { createApp, formEventFields } from '@jarenjs/app';
import { servePort } from '@jarenjs/contract/port';
import { nodeDriver } from '@jarenjs/db/node';
import { mountDataEditor, createTransport, createDataController, createDataState, DATA_ACTIONS } from '@jarenjs/studio/data';
import { createDataHandlers, dataContract } from '@jarenjs/studio/data/host';
import { tempDbPath } from '../db/helpers.js';
import { createStubHost, fire } from '../view/dom.stub.js';
const model = { $model: '0.1', collections: { rows: { schema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'integer' } } }, key: '/id' } } };
const query = [{ $for: { row: '$[*]' }, $return: '$row' }];
function find(node, predicate) { return predicate(node) ? node : [...(node.childNodes ?? [])].map(n => find(n, predicate)).find(Boolean); }
function fixture(t) {
  const { dbPath, cleanup } = tempDbPath(), { container } = createStubHost(), releases = [];
  let created = 0, terminated = 0, unlinks = 0, registrations = () => 0;
  const transport = () => createTransport({
    spawnWorker() {
      created++;
      const { port1, port2 } = new MessageChannel();
      const table = createDataHandlers({
        init: async () => ({ topology: 'owner', vfs: 'node', version: '3' }),
        makeDriver: () => nodeDriver(), makeScratchDriver: () => nodeDriver(), path: () => dbPath,
        vfs: () => 'node', durable: () => true,
        unlink: () => { unlinks++; rmSync(dbPath, { force: true }); },
        announce: notice => port1.postMessage(notice), operators: undefined,
      });
      registrations = () => table.state.lives.size;
      const server = servePort(dataContract, table.handlers, { channel: port1 });
      let release;
      port2.terminate = () => {
        if (release) return;
        terminated++; server.close(); port1.close(); port2.close();
        release = table.dispose(); releases.push(release);
      };
      queueMicrotask(() => port1.postMessage({ ready: true })); return port2;
    },
    openChannel() { throw new Error('A private test store cannot join another channel.'); },
  });
  const editor = mountDataEditor(container, { model: structuredClone(model), query, transport, seeds: [{ id: 'one', value: 7 }],
    lifecycleTarget: {}, schedule: f => f(), onError: e => { throw e; } });
  t.after(async () => { editor.dispose(); await Promise.all(releases); cleanup(); });
  return { editor, container, counts: () => ({ created, terminated, unlinks, live: registrations() }) };
}
it('independent mounts use real SQLite stores and the shared contract for run and explain', async t => {
  const a = fixture(t), b = fixture(t);
  assert.equal((await a.editor.ready).ok, true); assert.equal((await b.editor.ready).ok, true);
  assert.equal('app' in a.editor, false);
  const result = await a.editor.run(); assert.equal(result.ok, true); assert.deepEqual(result.result, [{ id: 'one', value: 7 }]);
  assert.match(result.explain.sql, /SELECT/);
  const candidate = { model, query: [{ $for: { row: '$[*]' }, $where: { $gt: ['$row.value', '$limit'] }, $return: '$row' }] };
  const changed = await a.editor.replace(candidate, { expectedRevision: a.editor.read().revision });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.deepEqual((await a.editor.run({ externals: { limit: 9 } })).result, []);
  assert.deepEqual((await b.editor.run()).result, [{ id: 'one', value: 7 }]);
});
it('manual drafts and candidate publication share revision checks while refused input keeps results', async t => {
  const { editor, container } = fixture(t); await editor.ready; await editor.run();
  const before = editor.read(), events = []; editor.subscribe(value => events.push(value));
  const invalid = await editor.replace({ model: { collections: [] }, query }, { expectedRevision: before.revision });
  assert.equal(invalid.ok, false); assert.deepEqual(editor.read(), before);
  const queryPane = find(container, n => n.getAttribute?.('class')?.includes('data-query'));
  fire(find(queryPane, n => n.tagName === 'textarea'), 'input', { target: { value: '{unfinished' } });
  const refused = await editor.replace({ model, query }, { expectedRevision: before.revision });
  assert.equal(refused.conflict, true); assert.equal(editor.read().buffers.queryText, '{unfinished');
  assert.deepEqual(editor.read().result, before.result); assert.equal(events.length, 1);
  const accepted = await editor.replace({ model, query }, { expectedRevision: editor.read().revision });
  assert.equal(accepted.ok, true); assert.equal(events.length, 2);
});
it('applying a model does not recreate storage; explicit open uses the existing owner operation', async t => {
  const { editor, counts } = fixture(t); await editor.ready;
  const replacement = structuredClone(model); replacement.collections.rows.indexes = [{ name: 'by_value', path: '$.value' }];
  const result = await editor.apply([{ op: 'replace', path: '/model', value: replacement }], { expectedRevision: editor.read().revision });
  assert.equal(result.ok, true); assert.equal(counts().unlinks, 0);
  assert.equal((await editor.run({ operation: 'open' })).ok, true); assert.equal(counts().unlinks, 1);
  assert.deepEqual((await editor.run()).result, []);
});
it('checks queued manual edits before applying a candidate', async t => {
  let app, proposal;
  const runtime = { dispose() {}, effects: {} }, controller = createDataController({ getApp: () => app, runtime });
  app = createApp({ state: { data: { ...createDataState(), modelText: JSON.stringify(model), queryText: JSON.stringify(query) } }, actions: DATA_ACTIONS, view: [] }, { schedule: f => f(), eventFields: formEventFields, effects: controller.effects });
  controller.attach(); t.after(() => { controller.dispose(); app.destroy(); });
  const before = controller.read();
  app.subscribe((_state, changes) => {
    if (!changes?.includes('/data/mobilePane')) return;
    app.dispatch('data/query-text', null, { target: { value: '"queued"' } });
    proposal = controller.replace({ model, query }, { expectedRevision: before.revision });
  });
  app.dispatch('data/pane', 'live');
  assert.equal((await proposal).conflict, true); assert.equal(controller.read().buffers.queryText, '"queued"');
});
it('disposal releases the live query and worker once, and refuses further writes and runs', async t => {
  const { editor, container, counts } = fixture(t); await editor.ready;
  assert.equal(counts().created, 1);
  editor.dispose(); editor.dispose();
  assert.equal(counts().terminated, 1); assert.equal(counts().live, 0); assert.equal(container.childNodes.length, 0);
  assert.equal((await editor.run()).ok, false);
  assert.equal((await editor.replace({ model, query }, { expectedRevision: editor.read().revision })).ok, false);
});

it('route activation releases and resumes resources, keeps live failures visible, and removes lifecycle listeners', async () => {
  const { createDataRuntime } = await import('@jarenjs/studio/data');
  const target = new EventTarget(), events = [], models = [];
  let callbacks, stopCount = 0, closeCount = 0, pending;
  const runtime = createDataRuntime({ model, query, lifecycleTarget: target, transport: () => ({
    boot: async () => ({ topology: 'owner', vfs: 'memory' }), bounded: (_stage, work) => work(),
    request: async (operation, input) => {
      if (operation === 'data.open') { models.push(input.model); return { model: input.model, capabilities: { live: true } }; }
      if (operation === 'data.rows') return [];
      if (operation === 'data.lives') return { count: 1 };
    },
    subscribe: (_input, handlers) => { callbacks = handlers; return { stop() { stopCount++; } }; },
    notices() {}, faults() {}, settled() {}, stage: () => 'store-open', close() { closeCount++; },
  }) });
  const dispatch = (name, payload) => {
    events.push({ name, payload });
    if (name === 'data/boot') pending = runtime.effects['data-boot']({}, dispatch);
    if (name === 'data/resume') pending = runtime.effects['data-resume']({}, dispatch);
  };
  const release = runtime.ownerSub({}, dispatch); await pending;
  callbacks.onError({ error: { details: { message: 'live refused' } } });
  assert.equal(events.at(-1).payload.message, 'live refused');
  callbacks.onEnd({ reason: 'server-shutdown' }); assert.match(events.at(-1).payload.message, /server-shutdown/);
  target.dispatchEvent(new Event('pagehide')); assert.equal(stopCount, 1);
  release(); assert.equal(closeCount, 1);
  runtime.ownerSub({}, dispatch); await pending;
  assert.equal(events.filter(event => event.name === 'data/seed').length, 1, 'returning does not overwrite typing buffers');
  assert.equal(models.length, 2);
  runtime.dispose(); runtime.dispose(); const stopped = stopCount;
  target.dispatchEvent(new Event('beforeunload')); assert.equal(stopCount, stopped);
  assert.equal(closeCount, 2);
});

it('executes an injected corpus and round trip through a real scratch store, exposing disagreements', async t => {
  const { createDataRuntime } = await import('@jarenjs/studio/data');
  const table = createDataHandlers({
    init: async () => ({ topology: 'memory', vfs: 'memory', version: '3' }),
    makeDriver: () => nodeDriver(), makeScratchDriver: () => nodeDriver(), path: () => ':memory:',
    vfs: () => 'memory', durable: () => false, unlink() {}, announce() {}, operators: undefined,
  });
  const { port1, port2 } = new MessageChannel();
  const server = servePort(dataContract, table.handlers, { channel: port1 });
  const { openPortClient } = await import('@jarenjs/contract/port');
  const client = openPortClient(dataContract, { channel: port2 });
  const request = async (op, input) => { const result = await client.invoke(op, input); if (!result.ok) throw new Error(result.error.message); return result.value; };
  const documents = [{ id: 'source', value: 2 }], events = [];
  const runtime = createDataRuntime({ model, query, lifecycleTarget: {}, corpus: async () => ({ ok: true, value: {
    source: 'fixture', collection: 'rows', mappings: { plain: model }, skipped: [], entries: [
      { name: 'agreed', documents, query, expected: documents },
      { name: 'disagreed', documents, query, expected: [] },
      { name: 'empty', documents, query: { $for: { r: '$[*]' }, $where: false, $return: '$r' }, empty: true },
    ],
  } }), trip: { csv: 'id,value\nsource,2', pipeline: () => ({ valid: true, rows: documents, documents, model, collectionName: 'rows', query, externals: {} }) },
  transport: () => ({ boot: () => request('data.init', null), request, bounded: (_stage, work) => work(),
    subscribe: (input, handlers) => client.subscribe('data.live', input, handlers), notices() {}, faults() {}, settled() {}, close() { client.close(); },
  }) });
  t.after(async () => { runtime.dispose(); server.close(); port1.close(); port2.close(); await table.dispose(); });
  const dispatch = (name, payload) => events.push({ name, payload });
  await runtime.effects['data-boot']({}, dispatch);
  const waitFor = async name => {
    for (let n = 0; n < 200; n++) { const event = events.find(event => event.name === name && event.payload.status === 'done'); if (event) return event.payload; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('the scratch operation did not settle');
  };
  runtime.effects['data-oracle']({}, dispatch);
  const corpus = await waitFor('data/oracle'); assert.equal(corpus.ran, 3); assert.equal(corpus.agreed, 2);
  assert.equal(corpus.disagreements.length, 1); assert.match(corpus.disagreements[0], /disagreed.*recorded.*answered/);
  runtime.effects['data-trip']({ csv: 'id,value\nsource,2' }, dispatch);
  const trip = await waitFor('data/trip'); assert.deepEqual(trip.results, documents); assert.match(trip.explain.sql, /SELECT/);
});

it('mounted activation releases workers and resumes without overwriting incomplete manual buffers', async t => {
  const { editor, container, counts } = fixture(t);
  await editor.ready;
  const text = find(container, n => n.tagName === 'textarea' && n.value.includes('$model'));
  text.value = '{ unfinished model'; fire(text, 'input');
  const before = editor.read(); assert.equal(before.buffers.modelText, '{ unfinished model');
  assert.equal((await editor.setActive(false)).ok, false);
  assert.equal(counts().terminated, 1);
  assert.match((await editor.run()).error, /inactive/);
  assert.equal((await editor.setActive(false)).ok, false);
  assert.equal((await editor.setActive(true)).ok, true);
  assert.equal((await editor.setActive(true)).ok, true);
  assert.equal(counts().created, 2);
  assert.deepEqual(editor.read().buffers, before.buffers);
  assert.equal(editor.read().revision, before.revision);
  const queryResult = await editor.run();
  assert.equal(queryResult.ok, true); assert.deepEqual(queryResult.result, [{ id: 'one', value: 7 }]);
  editor.dispose(); assert.equal((await editor.setActive(true)).ok, false);
});
