import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileDag, compileWorkflow, lowerWorkflow } from '@jarenjs/flow';

const copy = (v) => JSON.parse(JSON.stringify(v));
const handler = (run, version = '1') => ({ version, run });
const task = (name, then, extra = {}) => ({ work: { task: name, version: '1' }, then, ...extra });
const workflow = (states, initial = Object.keys(states)[0]) => ({ $workflow: '0.2', revision: 'test/1', initial, states });
function memoryStore() {
  const records = new Map();
  return {
    records,
    load: (id) => copy(records.get(id) ?? null),
    save(id, record, expected) {
      if ((records.get(id)?.generation ?? 0) !== expected) return false;
      records.set(id, copy(record)); return true;
    },
  };
}
const fanout = {
  $dag: '0.1', nodes: {
    input: { kind: 'input' },
    left: { kind: 'task', run: 'left', version: '1', checkpoint: true },
    right: { kind: 'task', run: 'right', version: '1', checkpoint: true },
    output: { kind: 'output' },
  }, edges: [
    { from: 'input', to: 'left' }, { from: 'input', to: 'right' },
    { from: 'left', to: 'output', port: 'left' }, { from: 'right', to: 'output', port: 'right' },
  ],
};

describe('one workflow lowered onto statechart and DAG', () => {
  it('rejects malformed declarations with the source path needed to repair them', () => {
    const doc = workflow({ work: task('one', 'done'), done: { final: true } });
    const cases = [
      [{ ...doc, revision: '' }, ''],
      [{ ...doc, states: { ...doc.states, work: { ...doc.states.work, final: true } } }, '/states/work'],
      [{ ...doc, states: { ...doc.states, work: task('one', 'missing') } }, '/states'],
    ];
    for (const [invalid, docPath] of cases)
      assert.throws(() => lowerWorkflow(invalid), { code: 'JF0021', docPath });
  });

  it('refuses corrupt saved control before claiming the run or invoking a task', async () => {
    const doc = workflow({ wait: { on: [{ event: 'go', to: 'work' }] }, work: task('one', 'done'), done: { final: true } });
    let calls = 0; let saves = 0;
    const tasks = { one: handler(() => ++calls) };
    const first = await compileWorkflow(doc, { tasks }).run(null, { runId: 'corrupt' });
    const corruptions = [
      (saved) => { saved.format = 'unknown'; },
      (saved) => { saved.generation = 0; },
      (saved) => { saved.context.visits['/states/wait'] = 0; },
      (saved) => { saved.status = 'done'; },
      (saved) => { saved.pending = { state: '/states/work', visit: 1, values: {} }; },
    ];
    for (const corrupt of corruptions) {
      const saved = copy(first.snapshot);
      corrupt(saved);
      const before = copy(saved);
      const store = { load: () => saved, save: () => { saves++; return true; } };
      await assert.rejects(compileWorkflow(doc, { tasks, store }).run(null,
        { runId: 'corrupt', event: { type: 'go' } }), { code: 'JF2016' });
      assert.deepEqual(saved, before, 'validation leaves the stored record untouched');
    }
    assert.equal(calls, 0);
    assert.equal(saves, 0);
  });

  it('lowers deterministically, isolates compilation from mutation and exposes source/revision identities', async () => {
    const doc = workflow({ work: task('double', 'done'), done: { final: true } });
    const before = copy(doc);
    assert.deepEqual(lowerWorkflow(doc), lowerWorkflow(copy(doc)));
    const flow = compileWorkflow(doc, { tasks: { double: handler(({ input }) => input * 2) } });
    doc.states.work.work.task = 'changed';
    const result = await flow.run(4, { runId: 'one' });
    assert.equal(result.result, 8);
    assert.deepEqual(flow.lowered.document, before);
    assert.deepEqual(flow.taskVersions, { '/states/work/task': '1' });
    assert.equal(typeof flow.revisions.control, 'string');
    assert.equal(flow.lowered.sources['/states/work'], '/states/work');
  });

  it('executes fan-out concurrently and assembles deterministic fan-in regardless of completion order', async () => {
    const started = [];
    const releases = {};
    const flow = compileWorkflow(workflow({ work: { work: { dag: fanout }, then: 'done' }, done: { final: true } }), {
      tasks: Object.fromEntries(['left', 'right'].map((name) => [name, handler(async () => {
        started.push(name); await new Promise((resolve) => { releases[name] = resolve; }); return name;
      })])),
    });
    const trace = [];
    const pending = flow.run(null, { runId: 'parallel', onTrace: (r) => trace.push(r) });
    while (started.length < 2) await new Promise((resolve) => setImmediate(resolve));
    releases.right(); releases.left();
    const result = await pending;
    assert.deepEqual(result.result, { left: 'left', right: 'right' });
    assert.ok(trace.some((r) => r.type === 'node' && r.id === 'left'));
    assert.ok(trace.every((r) => r.revisions.control === flow.revisions.control));
  });

  it('runs nested flows, a guarded bounded loop, and a durable external wait in the same document', async () => {
    const doc = workflow({
      round: { flow: { initial: 'increment', states: { increment: task('inc', 'end'), end: { final: true } } }, then: 'check', limit: 3 },
      check: { choose: [{ guard: { $lt: ['$.context.data', 3] }, to: 'round' }], otherwise: 'review' },
      review: { on: [{ event: 'approve', guard: '$.payload.accept', to: 'done' }], after: { ms: 50, to: 'expired' } },
      expired: { final: true }, done: { final: true },
    });
    let calls = 0;
    const store = memoryStore();
    const tasks = { inc: handler(({ input }) => { calls++; return input + 1; }) };
    const first = await compileWorkflow(doc, { tasks, store }).run(0, { runId: 'nested', now: 10 });
    assert.equal(first.status, 'waiting');
    assert.equal(first.snapshot.context.data, 3);
    assert.equal(first.snapshot.control.timers[0].at, 60);
    assert.equal(first.snapshot.context.visits['/states/round'], 3);
    const refused = await compileWorkflow(doc, { tasks, store }).run(0,
      { runId: 'nested', now: 20, event: { type: 'approve', payload: { accept: false } } });
    assert.equal(refused.status, 'waiting');
    const end = await compileWorkflow(doc, { tasks, store }).run(0,
      { runId: 'nested', now: 30, expectedGeneration: refused.snapshot.generation, event: { type: 'approve', payload: { accept: true } } });
    assert.equal(end.status, 'done'); assert.equal(end.result, 3); assert.equal(calls, 3);
    assert.deepEqual(end.snapshot.control.timers, []);
  });

  it('rejects unbounded automatic cycles, including nested and delay cycles; enforces visit limits on admitted work', async () => {
    assert.throws(() => lowerWorkflow(workflow({ loop: task('inc', 'loop') })), { code: 'JF0022' });
    assert.throws(() => lowerWorkflow(workflow({ loop: { flow: { initial: 'end', states: { end: { final: true } } }, then: 'loop' } })), { code: 'JF0022' });
    assert.throws(() => lowerWorkflow(workflow({ loop: { on: [], after: { ms: 0, to: 'loop' } } })), { code: 'JF0022' });
    let calls = 0;
    const flow = compileWorkflow(workflow({ loop: task('inc', 'loop', { limit: 2 }) }), {
      tasks: { inc: handler(() => ++calls) },
    });
    await assert.rejects(flow.run(0, { runId: 'limit' }), { code: 'JF2015' });
    assert.equal(calls, 2);
    const timed = compileWorkflow(workflow({ loop: { on: [], after: { ms: 0, to: 'loop' }, limit: 2 } }));
    await assert.rejects(timed.run(null, { runId: 'timed', now: 0 }), { code: 'JF2015' });
    assert.doesNotThrow(() => lowerWorkflow(workflow({ loop: { on: [{ event: 'again', to: 'loop' }] } })));
  });

  it('resumes after a branch failure, restores checkpoints and keeps task invocation counts honest', async () => {
    let left = 0; let right = 0; let fail = true;
    const store = memoryStore();
    const tasks = {
      left: handler(() => ++left),
      right: handler(async () => {
        right++;
        await new Promise((resolve) => setImmediate(resolve));
        if (fail) throw new Error('temporary');
        return 10;
      }),
    };
    const doc = workflow({ work: { work: { dag: fanout }, then: 'done' }, done: { final: true } });
    await assert.rejects(compileWorkflow(doc, { tasks, store }).run(null, { runId: 'resume' }), { code: 'JF2006' });
    assert.equal(store.load('resume').pending.values.left, 1);
    fail = false;
    const trace = [];
    const end = await compileWorkflow(doc, { tasks, store }).run(null, { runId: 'resume', onTrace: (r) => trace.push(r) });
    assert.deepEqual(end.result, { left: 1, right: 10 });
    assert.equal(left, 1); assert.equal(right, 2);
    assert.ok(trace.some((r) => r.id === 'left' && r.status === 'restored'));
  });

  it('refuses changed input, lowering documents, task versions and stale external events before task work', async () => {
    const doc = workflow({ work: task('inc', 'wait'), wait: { on: [{ event: 'go', to: 'done' }] }, done: { final: true } });
    let calls = 0;
    const store = memoryStore();
    const tasks = { inc: handler(() => ++calls) };
    const flow = compileWorkflow(doc, { tasks, store });
    const first = await flow.run(1, { runId: 'identity' });
    await assert.rejects(flow.run(2, { runId: 'identity' }), { code: 'JF2013' });
    const changed = copy(doc); changed.states.work.input = 9;
    await assert.rejects(compileWorkflow(changed, { tasks, store }).run(1, { runId: 'identity' }), { code: 'JF2013' });
    const versioned = copy(doc); versioned.states.work.work.version = '2';
    await assert.rejects(compileWorkflow(versioned, { tasks: { inc: handler(() => ++calls, '2') }, store }).run(1, { runId: 'identity' }), { code: 'JF2013' });
    await assert.rejects(flow.run(1, { runId: 'identity', expectedGeneration: first.snapshot.generation - 1, event: { type: 'go' } }), { code: 'JF2014' });
    assert.equal(calls, 1);
  });

  it('rejects competing compiled runners through CAS and prevents late cancelled task checkpoints', async () => {
    const store = memoryStore();
    const doc = workflow({ work: task('slow', 'done'), done: { final: true } });
    let release; let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const tasks = { slow: handler(() => { started(); return new Promise((resolve) => { release = resolve; }); }) };
    const flow = compileWorkflow(doc, { tasks, store });
    const abort = new AbortController();
    const first = flow.run(null, { runId: 'abort', signal: abort.signal });
    await ready;
    await assert.rejects(flow.run(null, { runId: 'abort' }), { code: 'JF2014' });
    abort.abort();
    await assert.rejects(first, { code: 'JF2007' });
    const before = store.load('abort');
    release('late');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(store.load('abort'), before);

    const competingStore = memoryStore();
    const simpleTasks = { slow: handler(() => 'ok') };
    const a = compileWorkflow(doc, { tasks: simpleTasks, store: competingStore });
    const b = compileWorkflow(doc, { tasks: simpleTasks, store: competingStore });
    const results = await Promise.allSettled([a.run(null, { runId: 'same' }), b.run(null, { runId: 'same' })]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'JF2014');
  });

  it('routes task failures explicitly, isolates observers and preserves dangerous member names', async () => {
    const states = JSON.parse('{"__proto__":{"work":{"task":"fail","version":"1"},"then":"done","catch":"recover"},"recover":{"work":{"task":"recover","version":"1"},"then":"done"},"done":{"final":true}}');
    const flow = compileWorkflow(workflow(states, '__proto__'), { tasks: {
      fail: handler(() => { throw new Error('no'); }),
      recover: handler(({ input }) => input.error.code),
    } });
    const result = await flow.run(null, { runId: 'names', onTrace() { throw new Error('observer'); } });
    assert.equal(result.result, 'JF2006');
    assert.equal(Object.hasOwn(result.snapshot.context.results, '/states/__proto__'), true);
  });

  it('does not advance past a failed store save, and returns a reusable waiting snapshot without a store', async () => {
    const doc = workflow({ wait: { on: [{ event: 'go', to: 'done' }] }, done: { final: true } });
    const flow = compileWorkflow(doc);
    const first = await flow.run({ x: 1 }, { runId: 'snapshot' });
    const second = await flow.run({ x: 1 }, { runId: 'snapshot', snapshot: copy(first.snapshot), event: { type: 'go' } });
    assert.equal(second.status, 'done');
    assert.equal(first.status, 'waiting');
    const store = memoryStore();
    const stored = compileWorkflow(doc, { store });
    await stored.run(0, { runId: 'store' });
    const before = store.load('store');
    store.save = () => { throw new Error('disk'); };
    await assert.rejects(stored.run(0, { runId: 'store', event: { type: 'go' } }), { code: 'JF2009' });
    assert.deepEqual(store.load('store'), before);
  });

  it('persists accepted event payloads and gives retried work a stable explicit idempotency key', async () => {
    const doc = workflow({
      wait: { on: [{ event: 'submit', to: 'work' }] },
      work: task('effect', 'done', { input: { payload: '$.context.event.payload', key: '$.context.activation.key' } }),
      done: { final: true },
    });
    const store = memoryStore();
    const keys = []; let fail = true;
    const tasks = { effect: handler(({ input }) => {
      keys.push(input.key);
      if (fail) throw new Error('crash window');
      return input.payload;
    }) };
    await assert.rejects(compileWorkflow(doc, { tasks, store }).run(null,
      { runId: 'event', event: { type: 'submit', payload: { answer: 42 } } }), { code: 'JF2006' });
    fail = false;
    const result = await compileWorkflow(doc, { tasks, store }).run(null, { runId: 'event' });
    assert.deepEqual(result.result, { answer: 42 });
    assert.equal(keys[0], keys[1]);
    assert.deepEqual(JSON.parse(keys[0]), ['event', '/states/work', 1]);
  });

  it('reuses a completed DAG after a failed control commit and detects forged pending provenance', async () => {
    const doc = workflow({ work: task('effect', 'done'), done: { final: true } });
    const store = memoryStore(); const save = store.save;
    let fail = true; let calls = 0;
    store.save = (id, next, expected) => {
      if (fail && next.status === 'done') throw new Error('control commit failed');
      return save(id, next, expected);
    };
    const tasks = { effect: handler(() => ++calls) };
    await assert.rejects(compileWorkflow(doc, { tasks, store }).run(null, { runId: 'complete' }), { code: 'JF2009' });
    const snapshot = store.load('complete');
    assert.equal(snapshot.pending.result, 1);
    const forged = copy(snapshot); forged.pending.identity.input = 'different';
    await assert.rejects(compileWorkflow(doc, { tasks }).run(null, { runId: 'complete', snapshot: forged }), { code: 'JF2013' });
    fail = false;
    const end = await compileWorkflow(doc, { tasks, store }).run(null, { runId: 'complete' });
    assert.equal(end.result, 1); assert.equal(calls, 1);
  });

  it('starts the next delay at a resumed computation’s explicit wake-up time', async () => {
    const doc = workflow({ work: task('retry', 'wait'), wait: { on: [], after: { ms: 10, to: 'done' } }, done: { final: true } });
    const store = memoryStore(); let fail = true;
    const tasks = { retry: handler(() => { if (fail) throw new Error('retry'); return 1; }) };
    const flow = compileWorkflow(doc, { tasks, store });
    await assert.rejects(flow.run(null, { runId: 'time', now: 100 }), { code: 'JF2006' });
    fail = false;
    const resumed = await flow.run(null, { runId: 'time', now: 200 });
    assert.equal(resumed.status, 'waiting');
    assert.equal(resumed.snapshot.control.timers[0].at, 210);
    await assert.rejects(flow.run(null, { runId: 'time', now: 199 }), { code: 'JF2011' });
    assert.equal((await flow.run(null, { runId: 'time', now: 210 })).status, 'done');
  });
});

describe('standalone DAG provenance and cancellation', () => {
  it('checks exact workflow/input/task identity before loading node values', async () => {
    let record = null; let calls = 0;
    const checkpoint = {
      load: () => record,
      save: (id, node, value, identity) => { record ??= { identity, values: {} }; record.values[node] = value; },
      complete() {},
    };
    const doc = lowerWorkflow(workflow({ work: task('one', 'done'), done: { final: true } })).dags['/states/work'];
    const dag = compileDag(doc, { tasks: { one: handler(() => ++calls) }, checkpoint, revision: '1' });
    assert.equal(await dag.run(1, { runId: 'a' }), 1);
    assert.equal(await dag.run(1, { runId: 'a' }), 1);
    await assert.rejects(dag.run(2, { runId: 'a' }), { code: 'JF2013' });
    assert.equal(calls, 1);
    record = { values: { task: 'unknown origin' } };
    await assert.rejects(dag.run(1, { runId: 'a' }), { code: 'JF2013' });
  });

  it('settles abort during an ignoring task and a hung checkpoint load', async () => {
    const doc = lowerWorkflow(workflow({ work: task('slow', 'done'), done: { final: true } })).dags['/states/work'];
    for (const checkpoint of [undefined, { load: () => new Promise(() => {}), save() {}, complete() {} }]) {
      const dag = compileDag(doc, { tasks: { slow: handler(() => new Promise(() => {})) }, checkpoint });
      const abort = new AbortController();
      const promise = dag.run(null, { signal: abort.signal, ...(checkpoint ? { runId: 'hung' } : {}) });
      await new Promise((resolve) => setImmediate(resolve));
      abort.abort();
      await assert.rejects(promise, { code: 'JF2007' });
    }
  });
});
