//@ts-check
/**
 * @file The attempt's fence reaches every DAG task (JOBS-FORMAT §7): the
 * runner hands each task `{ jobId, assertLease, signal }` through the flow
 * engine's host-private `resources`, merged over the host's own, so a
 * task can check the lease inside the transaction that publishes its
 * result. Two workers and a forced lease loss, on SQLite and, where
 * JAREN_PG_URL is set, on PostgreSQL: the attempt that lost the job is
 * refused, the one that holds it publishes, and the run's checkpoint
 * identity never sees the resources. Time is an injected clock.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { compileDag } from '@jarenjs/flow';
import { openStore, createDagJobRunner, RUN_IDENTITY_NODE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;
const MODEL = { $model: '0.1', collections: { pubs: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, by: { type: 'string' } } } } } };

/** One task between input and output: the provider call and its publication. */
const PUBLISH_DAG = { $dag: '0.1', nodes: { in: { kind: 'input' },
  publish: { kind: 'task', run: 'publish' }, out: { kind: 'output' } },
edges: [{ from: 'in', to: 'publish' }, { from: 'publish', to: 'out' }] };

/** A checkpointed node, then one that can crash: the resume shape. */
const RESUME_DAG = { $dag: '0.1', nodes: { in: { kind: 'input' },
  a: { kind: 'task', run: 'a', checkpoint: true, version: '1' },
  b: { kind: 'task', run: 'b', version: '1' }, out: { kind: 'output' } },
edges: [{ from: 'in', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'out' }] };

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
/** @param {() => boolean | Promise<boolean>} done @param {string} what */
const until = async (done, what) => {
  const by = Date.now() + 5_000;
  while (!(await done())) {
    assert.ok(Date.now() < by, `stalled waiting for ${what}`);
    await tick();
  }
};

/** Publish the task's late response in one transaction, fenced the documented way. */
const publishFenced = async (store, owner, resources) => {
  try {
    await store.transaction(async (tx) => {
      await resources.assertLease(tx);
      await tx.collection('pubs').put({ id: `response-${owner}`, by: owner });
    });
    return { published: owner };
  }
  catch (error) { return { refused: owner, code: /** @type {any} */ (error).code }; }
};

/** The shared cases, run against whatever `{ store, cleanup }` `open(options)` makes. */
const cases = (open) => {
  const fixture = async (fn) => {
    let at = 1_000_000;
    const { store, cleanup } = await open({ jobs: { now: () => at, random: () => 0 } });
    const runners = [];
    try { await fn(store, (ms) => { at += ms; }, runners); } finally {
      try { await Promise.all(runners.map((runner) => runner.stop())); }
      finally { try { await store.close(); } finally { await cleanup(); } }
    }
  };
  const pubsOf = async (store) => (await store.collection('pubs').all()).map((p) => p.id).sort();

  it('refuses the late write of an attempt whose job another worker reclaimed', async () => {
    await fixture(async (store, advance, runners) => {
      const gates = new Map();
      /** @type {Record<string, any>} */
      const outcomes = {};
      const worker = (owner) => createDagJobRunner(store, { compileDag, documents: { pub: PUBLISH_DAG },
        owner, renew: false, leaseMs: 100, pollInterval: 5,
        tasks: { publish: async (_props, _signal, resources) => {
          await new Promise((resolve) => gates.set(owner, resolve)); // the provider's latency
          outcomes[owner] = await publishFenced(store, owner, resources);
          return outcomes[owner];
        } } });
      await store.jobs.enqueue('pub', { input: {} }, { id: 'j' });
      runners.push(worker('A').start());
      await until(() => gates.has('A'), 'A to claim');
      advance(10_000); // A's lease lapses: it never renews
      runners.push(worker('B').start());
      await until(() => gates.has('B'), 'B to reclaim');
      gates.get('A')(); // A's provider answers while B holds the job
      await until(() => outcomes.A !== undefined, 'A to publish');
      assert.deepEqual(outcomes.A, { refused: 'A', code: 'JD2066' });
      gates.get('B')();
      await until(async () => (await store.jobs.get('j')).state === 'done', 'B to finish');
      assert.deepEqual(outcomes.B, { published: 'B' });
      assert.deepEqual((await store.jobs.get('j')).result, { published: 'B' });
      assert.deepEqual(await pubsOf(store), ['response-B'], 'one publication for one job');
    });
  });

  it('refuses the late write of an attempt whose lease expired unclaimed', async () => {
    await fixture(async (store, advance, runners) => {
      let release = null;
      let outcome;
      runners.push(createDagJobRunner(store, { compileDag, documents: { pub: PUBLISH_DAG },
        owner: 'A', renew: false, leaseMs: 100, pollInterval: 5,
        tasks: { publish: async (_props, _signal, resources) => {
          await new Promise((resolve) => { release = resolve; });
          outcome = await publishFenced(store, 'A', resources);
          return outcome;
        } } }).start());
      await store.jobs.enqueue('pub', { input: {} }, { id: 'j' });
      await until(() => release !== null, 'A to claim');
      advance(10_000);
      /** @type {any} */ (release)();
      await until(() => outcome !== undefined, 'A to publish');
      assert.deepEqual(outcome, { refused: 'A', code: 'JD2067' });
      assert.deepEqual(await pubsOf(store), []);
    });
  });

  it('lets the live attempt fence after its lease was renewed', async () => {
    await fixture(async (store, _advance, runners) => {
      let outcome;
      const runner = createDagJobRunner(store, { compileDag, documents: { pub: PUBLISH_DAG },
        owner: 'A', leaseMs: 300, pollInterval: 5,
        tasks: { publish: async (_props, _signal, resources) => {
          // the claim's own lease is superseded by the first renewal
          await until(() => runner.stats().renewals >= 1, 'a renewal');
          outcome = await publishFenced(store, 'A', resources);
          return outcome;
        } } });
      runners.push(runner.start());
      await store.jobs.enqueue('pub', { input: {} }, { id: 'j' });
      await until(async () => (await store.jobs.get('j')).state === 'done', 'the run');
      assert.deepEqual(outcome, { published: 'A' });
      assert.deepEqual(await pubsOf(store), ['response-A']);
    });
  });

  it('hands each task the job id, the attempt signal and the host resources, frozen', async () => {
    await fixture(async (store, _advance, runners) => {
      const host = { http: 'client', [Symbol.for('extra')]: 1 };
      let seen;
      const runner = createDagJobRunner(store, { compileDag, documents: { pub: PUBLISH_DAG },
        owner: 'A', pollInterval: 5, resources: host,
        tasks: { publish: (_props, signal, resources) => {
          seen = { keys: Object.keys(resources).sort(), jobId: resources.jobId, http: resources.http,
            extra: resources[Symbol.for('extra')], frozen: Object.isFrozen(resources),
            attemptSignal: resources.signal instanceof AbortSignal && resources.signal !== signal };
          return null;
        } } });
      // a member added after the runner was built cannot shadow the attempt's
      Object.assign(host, { jobId: 'forged' });
      runners.push(runner.start());
      await store.jobs.enqueue('pub', { input: {} }, { id: 'j' });
      await until(async () => (await store.jobs.get('j')).state === 'done', 'the run');
      assert.deepEqual(seen, { keys: ['assertLease', 'http', 'jobId', 'signal'], jobId: 'j', http: 'client',
        extra: 1, frozen: true, attemptSignal: true });
      assert.deepEqual(host, { http: 'client', jobId: 'forged', [Symbol.for('extra')]: 1 },
        "the host's object is not written");
    });
  });

  it('fences only through a transaction, and never hands the lease out', async () => {
    await fixture(async (store, _advance, runners) => {
      let seen;
      runners.push(createDagJobRunner(store, { compileDag, documents: { pub: PUBLISH_DAG },
        owner: 'A', pollInterval: 5,
        tasks: { publish: async (_props, _signal, resources) => {
          const refusals = [];
          for (const value of [undefined, null, {}, { jobs: {} }]) {
            try { await resources.assertLease(value); refusals.push('checked'); }
            catch (error) { refusals.push(/** @type {any} */ (error).code); }
          }
          const inside = await store.transaction(async (tx) => resources.assertLease(tx));
          seen = { refusals, inside, values: Object.values(resources)
            .filter((value) => value !== null && typeof value === 'object' && 'token' in value).length };
          return null;
        } } }).start());
      await store.jobs.enqueue('pub', { input: {} }, { id: 'j' });
      await until(async () => (await store.jobs.get('j')).state === 'done', 'the run');
      assert.deepEqual(seen, { refusals: ['JD0014', 'JD0014', 'JD0014', 'JD0014'], inside: true, values: 0 });
    });
  });

  it('resumes across different host resources: they never enter the run identity', async () => {
    await fixture(async (store, advance, runners) => {
      let crash = true;
      const ran = { a: 0 };
      const runner = (resources) => createDagJobRunner(store, { compileDag, documents: { r: RESUME_DAG },
        owner: 'A', leaseMs: 1_000, pollInterval: 5, resources,
        tasks: {
          a: { version: '1', run: () => { ran.a += 1; return { step: 'a' }; } },
          b: { version: '1', run: ({ input }, _signal, res) => {
            if (crash) throw new Error('downstream down');
            return { ...input, tag: res.tag };
          } },
        } });
      await store.jobs.enqueue('r', { input: { day: 'mon' } }, { id: 'j', maxAttempts: 5 });
      const first = runner({ tag: 'one' }).start();
      runners.push(first);
      await until(async () => (await store.jobs.get('j')).state === 'failed', 'the crash');
      await first.stop();

      // what the crashed attempt recorded as the run's identity
      advance(100_000);
      const probe = await store.jobs.claim({ kinds: ['r'], owner: 'probe', leaseMs: 10 });
      const identity = (await store.jobs.checkpointsFor(probe).inspect('j', RUN_IDENTITY_NODE)).value;
      assert.deepEqual(Object.keys(identity).sort(),
        ['inputHash', 'inputIdentity', 'revision', 'taskVersions', 'taskVersionsHash', 'workflowIdentity']);
      assert.equal(identity.inputIdentity, '{"day":"mon"}');
      assert.ok(!JSON.stringify(identity).includes('one'), 'no resource value in the identity');
      advance(100_000); // the probe's lease lapses

      crash = false;
      runners.push(runner({ tag: 'two' }).start());
      await until(async () => (await store.jobs.get('j')).state === 'done', 'the resume');
      assert.deepEqual((await store.jobs.get('j')).result, { step: 'a', tag: 'two' });
      assert.equal(ran.a, 1, 'the checkpointed node was restored, not re-run');
    });
  });

  it('refuses a host resource named like the attempt\'s own, and one that is not a plain object', async () => {
    await fixture(async (store) => {
      for (const name of ['jobId', 'assertLease', 'signal']) {
        assert.throws(() => createDagJobRunner(store, { compileDag, documents: { pub: PUBLISH_DAG },
          resources: { [name]: 1 } }), (error) => /** @type {any} */ (error).code === 'JD0013'
          && new RegExp(`'${name}'`).test(/** @type {any} */ (error).message));
      }
      for (const resources of [[], new Map(), 'db', 1]) {
        assert.throws(() => createDagJobRunner(store, { compileDag, documents: { pub: PUBLISH_DAG },
          resources }), { code: 'JD0013' });
      }
    });
  });
};

describe('a DAG task fences its own writes with the attempt (SQLite)', () => {
  cases(async (options) => ({
    store: await openStore(MODEL, { driver: nodeDriver(), ...options }), cleanup: async () => {} }));
});

describe('a DAG task fences its own writes with the attempt (PostgreSQL)', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let serial = 0;
  cases(async (options) => {
    const pg = (await import('pg')).default;
    const schema = `jaren_dag_resources_${process.pid}_${serial++}`;
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }), ...options });
    return { store, cleanup: async () => {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    } };
  });
});
