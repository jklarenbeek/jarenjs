import { it } from 'node:test';
import assert from 'node:assert/strict';
import { compileWorkflow } from '@jarenjs/flow';
import { withProviderRun } from '@jarenjs/contract/provider';

const doc = { $workflow: '0.2', revision: '1', initial: 'read', states: {
  read: { work: { task: 'read', version: '1' }, then: 'done' }, done: { final: true },
} };

it('compiled workflows carry per-run private resources only to their tasks', async () => {
  const saved = [], traces = [];
  const workflow = compileWorkflow(doc, { tasks: {
    read: { version: '1', run: async (_props, signal, resources) => {
      const response = await resources.execute({ url: 'https://inventory.example/items', safety: 'safe-read' }, { signal });
      return { state: response.state, actor: resources.evidence.actor };
    } },
  }, store: { load: () => null, save: (_key, snapshot) => { saved.push(structuredClone(snapshot)); return true; } } });
  const results = await Promise.all(['a', 'b'].map((actor) => {
    const evidence = { runId: actor, actor, destination: 'inventory/test', environment: 'test', revision: '1', lease: actor };
    const host = {
      identify: () => ({ host: { token: 'secret-identity' } }),
      acquire: (_input, _identity, enter) => enter({ host: { token: `secret-${actor}` } }),
      current: () => evidence,
      transport: async (_request, { host }) => { assert.equal(host.token, `secret-${actor}`); return new Response('{}'); },
    };
    return withProviderRun(evidence, host, (resources) => workflow.run({}, {
      runId: actor, resources, signal: resources.signal, onTrace: (record) => traces.push(record),
    }));
  }));
  assert.deepEqual(results.map((r) => r.value.result), [{ state: 'ok', actor: 'a' }, { state: 'ok', actor: 'b' }]);
  assert.ok(!/secret|token|authorization|AbortController/.test(JSON.stringify({ saved, traces, results })));
});

it('resource-bearing workflow abort drains tasks before a caller releases its resources', async () => {
  let release;
  const events = [];
  const workflow = compileWorkflow(doc, { tasks: { read: { version: '1', run: async (_props, _signal, resources) => {
    await new Promise((resolve) => { release = resolve; });
    events.push(resources.name);
    return {};
  } } } });
  const controller = new AbortController();
  const pending = workflow.run({}, { runId: 'drain', resources: { name: 'settled' }, signal: controller.signal });
  const failure = assert.rejects(pending);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  release();
  await failure;
  events.push('released');
  assert.deepEqual(events, ['settled', 'released']);
});
