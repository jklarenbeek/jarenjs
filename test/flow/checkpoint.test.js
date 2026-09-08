//@ts-check
/**
 * @file The checkpoint contract (FLOW-FORMAT §7.6–§7.7): a resumed
 * run seeds recorded values and SKIPS those nodes (proven by counting
 * handlers), undeclared nodes recompute (the preserved 0.1 default),
 * a declared node with a non-JSON value is JF2008 at save time, a
 * throwing store is JF2009, `restored` records fire, `complete`
 * carries the result, and the FSM persistence helpers round-trip a
 * session through a synchronous store.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  compileDag, compileFsm, createFsmSession,
  snapshotFsm, resumeFsmSession, createDurableFsmSession,
} from '@jarenjs/flow';

/** An in-memory checkpoint store with call recording. */
function memoryStore() {
  /** @type {Map<string, any>} */
  const runs = new Map();
  const calls = [];
  return {
    calls,
    runs,
    load(runId) {
      calls.push(['load', runId]);
      return runs.get(runId) ?? null;
    },
    save(runId, nodeId, value) {
      calls.push(['save', runId, nodeId]);
      let run = runs.get(runId);
      if (run === undefined) {
        run = { values: {}, result: undefined };
        runs.set(runId, run);
      }
      run.values[nodeId] = value;
    },
    complete(runId, result) {
      calls.push(['complete', runId]);
      const run = runs.get(runId) ?? { values: {} };
      run.result = result;
      runs.set(runId, run);
    },
  };
}

const DOC = {
  $dag: '0.1',
  nodes: {
    in: { kind: 'input' },
    // a checkpointed node declares the handler identity its recorded
    // value belongs to; the registry must agree
    fetch: { kind: 'task', run: 'fetch', checkpoint: true, version: '1' },
    shape: { kind: 'jslt', checkpoint: true,
      stylesheet: [{ match: '$', body: { doubled: { $mul: ['$.n', 2] } } }] },
    verify: { kind: 'task', run: 'verify' },
    out: { kind: 'output' },
  },
  edges: [
    { from: 'in', to: 'fetch' },
    { from: 'fetch', to: 'shape' },
    { from: 'shape', to: 'verify' },
    { from: 'verify', to: 'out' },
  ],
};

describe('the checkpoint contract (§7.6)', () => {
  it('records declared nodes and the completion; undeclared nodes are not saved', async () => {
    const store = memoryStore();
    const counts = { fetch: 0, verify: 0 };
    const dag = compileDag(DOC, {
      checkpoint: store,
      tasks: {
        fetch: { version: '1', run: ({ input }) => { counts.fetch++; return { n: input.n }; } },
        verify: ({ input }) => { counts.verify++; return input; },
      },
    });
    const result = await dag.run({ n: 21 }, { runId: 'r1' });
    assert.deepStrictEqual(result, { doubled: 42 });
    const run = store.runs.get('r1');
    assert.deepStrictEqual(Object.keys(run.values).sort(), ['fetch', 'shape'],
      'only DECLARED nodes are recorded');
    assert.deepStrictEqual(run.result, { doubled: 42 });
    assert.deepStrictEqual(store.calls.filter(([kind]) => kind === 'complete'),
      [['complete', 'r1']]);
  });

  it('a resumed run SKIPS recorded nodes and recomputes the rest (counting handlers)', async () => {
    const store = memoryStore();
    const counts = { fetch: 0, verify: 0 };
    let failVerify = true;
    const dag = compileDag(DOC, {
      checkpoint: store,
      tasks: {
        fetch: { version: '1', run: ({ input }) => { counts.fetch++; return { n: input.n }; } },
        verify: ({ input }) => {
          counts.verify++;
          if (failVerify) throw new Error('flaky downstream');
          return input;
        },
      },
    });
    await assert.rejects(() => dag.run({ n: 21 }, { runId: 'r2' }), /flaky/);
    assert.strictEqual(counts.fetch, 1);
    assert.deepStrictEqual(Object.keys(store.runs.get('r2').values).sort(),
      ['fetch', 'shape'], 'the failure did not lose the completed prefix');

    failVerify = false;
    const restored = [];
    const result = await dag.run({ n: 21 }, {
      runId: 'r2',
      onNode: (record) => {
        if (record.status === 'restored') restored.push(record.id);
      },
    });
    assert.deepStrictEqual(result, { doubled: 42 });
    assert.strictEqual(counts.fetch, 1,
      'the checkpointed node did NOT re-run — the resume is the point');
    assert.strictEqual(counts.verify, 2, 'the undeclared node recomputed');
    assert.deepStrictEqual(restored.sort(), ['fetch', 'shape']);
  });

  it('a declared non-JSON value is JF2008 at save time, never a silent skip', async () => {
    const store = memoryStore();
    const dag = compileDag({
      $dag: '0.1',
      nodes: {
        in: { kind: 'input' },
        bad: { kind: 'task', run: 'bad', checkpoint: true, version: '1' },
        out: { kind: 'output' },
      },
      edges: [{ from: 'in', to: 'bad' }, { from: 'bad', to: 'out' }],
    }, {
      checkpoint: store,
      tasks: { bad: { version: '1', run: () => ({ f: () => {} }) } },
    });
    await assert.rejects(() => dag.run(null, { runId: 'r3' }),
      (error) => /** @type {any} */ (error).code === 'JF2008'
        && /'bad'/.test(/** @type {any} */ (error).message));
    assert.strictEqual(store.runs.get('r3'), undefined, 'nothing was saved');
  });

  it('a throwing store is JF2009 on save, load and complete', async () => {
    const failing = (member) => ({
      load: member === 'load' ? () => { throw new Error('disk gone'); } : () => null,
      save: member === 'save' ? () => { throw new Error('disk gone'); } : () => {},
      complete: member === 'complete' ? () => { throw new Error('disk gone'); } : () => {},
    });
    for (const member of ['load', 'save', 'complete']) {
      const dag = compileDag(DOC, {
        checkpoint: failing(member),
        tasks: { fetch: { version: '1', run: ({ input }) => input }, verify: ({ input }) => input },
      });
      await assert.rejects(() => dag.run({ n: 1 }, { runId: 'r4' }),
        (error) => /** @type {any} */ (error).code === 'JF2009',
        `the ${member} failure surfaces coded`);
    }
  });

  it('stale values — unknown nodes or undeclared ones — are ignored on resume', async () => {
    const store = memoryStore();
    store.runs.set('r5', { values: {
      ghost: 123, // no such node
      verify: { n: 9 }, // exists but does NOT declare checkpoint
      fetch: { n: 5 },
    } });
    const counts = { verify: 0 };
    const dag = compileDag(DOC, {
      checkpoint: store,
      tasks: {
        fetch: { version: '1', run: () => { throw new Error('must not run'); } },
        verify: ({ input }) => { counts.verify++; return input; },
      },
    });
    const result = await dag.run({ n: 999 }, { runId: 'r5' });
    assert.deepStrictEqual(result, { doubled: 10 }, 'fetch seeded with n:5');
    assert.strictEqual(counts.verify, 1, 'the undeclared node recomputed');
  });

  it('misuse guards: a partial store, a runId without a store, a store without a runId', () => {
    assert.throws(() => compileDag(DOC, {
      checkpoint: /** @type {any} */ ({ load: () => null }),
      tasks: { fetch: { version: '1', run: () => 0 }, verify: () => 0 },
    }), TypeError);
    const plain = compileDag(DOC, {
      tasks: { fetch: { version: '1', run: ({ input }) => input }, verify: ({ input }) => input } });
    assert.throws(() => plain.run({}, { runId: 'r' }), TypeError);
    const stored = compileDag(DOC, {
      checkpoint: memoryStore(),
      tasks: { fetch: { version: '1', run: ({ input }) => input }, verify: ({ input }) => input } });
    assert.throws(() => stored.run({}), TypeError,
      'a checkpointed dag needs a run identity');
  });
});

describe('FSM persistence (§7.7)', () => {
  const MACHINE = {
    initial: 'draft',
    states: ['draft', 'sent', { id: 'paid', final: true }],
    transitions: [
      { from: 'draft', event: 'send', to: 'sent' },
      { from: 'sent', event: 'pay', to: 'paid' },
    ],
  };

  it('snapshot and resume round-trip a session', () => {
    const fsm = compileFsm(MACHINE);
    const session = createFsmSession(fsm);
    session.send('send');
    const snapshot = snapshotFsm(session);
    assert.deepStrictEqual(snapshot, { state: 'sent' });
    const resumed = resumeFsmSession(fsm, JSON.parse(JSON.stringify(snapshot)));
    assert.strictEqual(resumed.state, 'sent');
    resumed.send('pay');
    assert.strictEqual(resumed.done, true);
    assert.throws(() => resumeFsmSession(fsm, { state: 'nope' }),
      (error) => /** @type {any} */ (error).code === 'JF2001');
    assert.throws(() => resumeFsmSession(fsm, /** @type {any} */ ({})), TypeError);
  });

  it('a durable session persists every state CHANGE through the store', () => {
    const fsm = compileFsm(MACHINE);
    const saved = [];
    let stored = /** @type {string | null} */ (null);
    const store = {
      load: () => stored,
      save: (state) => { saved.push(state); stored = state; },
    };
    const first = createDurableFsmSession(fsm, store);
    first.send('send');
    first.send('missing'); // no transition: unchanged, not saved
    assert.deepStrictEqual(saved, ['sent']);

    const second = createDurableFsmSession(fsm, store);
    assert.strictEqual(second.state, 'sent', 'resumed from the store');
    assert.strictEqual(second.can('pay'), true);
    second.send('pay');
    assert.deepStrictEqual(saved, ['sent', 'paid']);
    assert.strictEqual(second.done, true);
    assert.throws(() => createDurableFsmSession(fsm, /** @type {any} */ ({})), TypeError);
  });

  it('a throwing save fails the send rather than losing the transition silently', () => {
    const fsm = compileFsm(MACHINE);
    const session = createDurableFsmSession(fsm, {
      load: () => null,
      save: () => { throw new Error('disk gone'); },
    });
    assert.throws(() => session.send('send'), /disk gone/);
    assert.strictEqual(session.state, 'draft');
    assert.strictEqual(session.done, false);
  });

  it('retries a failed save from the original state and evaluates each step once', () => {
    const compiled = compileFsm(MACHINE);
    let steps = 0;
    const fsm = { ...compiled, step: (...args) => { steps++; return compiled.step(...args); } };
    let stored = 'draft';
    let fail = true;
    const session = createDurableFsmSession(fsm, {
      load: () => stored,
      save: (state) => {
        if (fail) throw new Error('disk gone');
        assert.strictEqual(session.state, 'draft', 'publish only after persistence');
        stored = state;
      },
    });
    assert.throws(() => session.send('send'), /disk gone/);
    assert.strictEqual(stored, 'draft');
    assert.strictEqual(session.state, 'draft');
    fail = false;
    assert.strictEqual(session.send('send').changed, true);
    assert.strictEqual(session.state, 'sent');
    assert.strictEqual(stored, 'sent');
    assert.strictEqual(steps, 2, 'one step evaluation per send, including the failed send');
  });
});
