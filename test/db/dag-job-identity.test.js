//@ts-check
/** Exact resume identities, including deterministic content-hash collisions. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { hashContent } from '@jarenjs/core/string';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { compileDag } from '@jarenjs/flow';
import { createDagJobRunner, RUN_IDENTITY_NODE } from '../../packages/db/src/dag-job.js';

const fingerprint = (value) => hashContent(canonicalizeJson(value));
const literalDocument = (value) => ({
  $dag: '0.1',
  nodes: {
    in: { kind: 'input' },
    shape: { kind: 'jslt', checkpoint: true, stylesheet: [{ match: '$', body: { value } }] },
    out: { kind: 'output' },
  },
  edges: [{ from: 'in', to: 'shape' }, { from: 'shape', to: 'out' }],
});
const TASK_DOCUMENT = {
  $dag: '0.1',
  nodes: {
    in: { kind: 'input' },
    transform: { kind: 'task', run: 'transform', checkpoint: true, version: '1' },
    out: { kind: 'output' },
  },
  edges: [{ from: 'in', to: 'transform' }, { from: 'transform', to: 'out' }],
};

/** The injected checkpoint seam retains values at the completion boundary. */
function fixture() {
  const rows = new Map();
  const events = [];
  let calls = 0;
  let attempt = 0;
  const store = { jobs: { createWorker: (options) => options } };
  const context = {
    job: { id: 'r', lease: { token: '0' } },
    signal: new AbortController().signal,
    checkpoints: {
      inspect: async (_id, node) => ({
        value: rows.get(node), hasValues: [...rows.keys()].some((key) => key !== RUN_IDENTITY_NODE),
      }),
      load: async () => { events.push('load'); return { values: Object.fromEntries(rows) }; },
      save: async (_id, node, value) => { events.push(`save:${node}`); rows.set(node, value); },
      complete: async () => {},
    },
  };
  const run = (document, input, nestedVersion = undefined) => {
    context.job.lease.token = String(++attempt);
    const runner = /** @type {any} */ (createDagJobRunner(store, {
      compileDag, documents: { job: document },
      tasks: { transform: {
        version: '1',
        run: ({ input: value }) => { calls++; return value; },
        ...(nestedVersion === undefined ? {} : { taskVersions: { inner: nestedVersion } }),
      } },
    }));
    return runner.handlers.job({ input }, context);
  };
  return { rows, events, run, calls: () => calls };
}

async function refusesBeforeLoad(f, document, input, component, nestedVersion = undefined) {
  const before = [...f.rows];
  const events = [...f.events];
  const calls = f.calls();
  await assert.rejects(f.run(document, input, nestedVersion), (error) =>
    error.code === 'JD2069' && component.test(error.message));
  assert.deepStrictEqual(f.events, events, 'refusal precedes checkpoint load and writes');
  assert.strictEqual(f.calls(), calls, 'no task runs');
  assert.deepStrictEqual([...f.rows], before, 'the original run remains intact');
}

describe('persisted DAG identities compare exact canonical values', () => {
  it('refuses distinct workflows with the same diagnostic revision', async () => {
    const before = literalDocument('v274es9');
    const after = literalDocument('v1d1pu5d');
    assert.strictEqual(fingerprint(before), '1iwy0ee');
    assert.strictEqual(fingerprint(after), fingerprint(before));
    const f = fixture();
    assert.deepStrictEqual(await f.run(before, null), { value: 'v274es9' });
    assert.deepStrictEqual(await compileDag(after).run(null), { value: 'v1d1pu5d' });
    await refusesBeforeLoad(f, after, null, /the workflow/);
  });

  it('refuses distinct inputs with the same diagnostic input hash', async () => {
    const before = { value: 'vorcsi8' };
    const after = { value: 'v8e3uu8' };
    assert.strictEqual(fingerprint(before), 'pqzqt6');
    assert.strictEqual(fingerprint(after), fingerprint(before));
    const f = fixture();
    assert.deepStrictEqual(await f.run(TASK_DOCUMENT, before), before);
    await refusesBeforeLoad(f, TASK_DOCUMENT, after, /the input/);
  });

  it('refuses colliding nested task maps while the workflow stays the same', async () => {
    const before = { transform: '1', 'transform/inner': 'vch1prk' };
    const after = { transform: '1', 'transform/inner': 'vy1phhm' };
    assert.strictEqual(fingerprint(before), 'q0uk4e');
    assert.strictEqual(fingerprint(after), fingerprint(before));
    const f = fixture();
    await f.run(TASK_DOCUMENT, null, before['transform/inner']);
    assert.deepStrictEqual(f.rows.get(RUN_IDENTITY_NODE).taskVersions, before);
    await refusesBeforeLoad(f, TASK_DOCUMENT, null, /the task versions/, after['transform/inner']);
  });

  it('restores a canonically identical run with reordered object members', async () => {
    const f = fixture();
    const input = { first: 1, second: 2 };
    await f.run(TASK_DOCUMENT, input);
    const identity = f.rows.get(RUN_IDENTITY_NODE);
    assert.strictEqual(identity.workflowIdentity, canonicalizeJson(TASK_DOCUMENT));
    assert.strictEqual(identity.inputIdentity, canonicalizeJson(input));
    assert.strictEqual(identity.revision, fingerprint(TASK_DOCUMENT));
    assert.strictEqual(identity.inputHash, fingerprint(input));
    assert.strictEqual(identity.taskVersionsHash, fingerprint({ transform: '1' }));
    const document = Object.fromEntries(Object.entries(TASK_DOCUMENT).reverse());
    const saves = f.events.filter((event) => event.startsWith('save:'));
    assert.deepStrictEqual(await f.run(document, { second: 2, first: 1 }), input);
    assert.strictEqual(f.calls(), 1, 'the checkpointed task is restored');
    assert.deepStrictEqual(f.events.filter((event) => event.startsWith('save:')), saves);
  });
});

describe('legacy DAG identity upgrades require an empty run', () => {
  for (const legacy of ['hash-only', 'pre-versions']) {
    const makeLegacy = (f) => {
      const identity = f.rows.get(RUN_IDENTITY_NODE);
      delete identity.workflowIdentity;
      delete identity.inputIdentity;
      if (legacy === 'pre-versions') {
        delete identity.taskVersions;
        delete identity.taskVersionsHash;
      }
    };

    it(`upgrades a matching ${legacy} identity before loading an empty run`, async () => {
      const f = fixture();
      await f.run(TASK_DOCUMENT, null);
      makeLegacy(f);
      f.rows.delete('transform');
      f.events.length = 0;
      await f.run(TASK_DOCUMENT, null);
      assert.strictEqual(f.events[0], `save:${RUN_IDENTITY_NODE}`);
      assert.strictEqual(f.events[1], 'load');
      assert.strictEqual(f.rows.get(RUN_IDENTITY_NODE).workflowIdentity, canonicalizeJson(TASK_DOCUMENT));
      assert.strictEqual(f.rows.get(RUN_IDENTITY_NODE).inputIdentity, 'null');
      assert.deepStrictEqual(f.rows.get(RUN_IDENTITY_NODE).taskVersions, { transform: '1' });
    });

    it(`refuses a ${legacy} identity with recorded values before loading them`, async () => {
      const f = fixture();
      await f.run(TASK_DOCUMENT, null);
      makeLegacy(f);
      await refusesBeforeLoad(f, TASK_DOCUMENT, null, /cannot be confirmed/);
    });
  }

  it('preserves a mismatching legacy empty identity instead of upgrading it', async () => {
    const f = fixture();
    await f.run(TASK_DOCUMENT, null);
    f.rows.delete('transform');
    const identity = f.rows.get(RUN_IDENTITY_NODE);
    delete identity.workflowIdentity;
    delete identity.inputIdentity;
    identity.inputHash = 'different';
    await refusesBeforeLoad(f, TASK_DOCUMENT, null, /the input/);
  });
});
