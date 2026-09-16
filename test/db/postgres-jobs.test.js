//@ts-check
/** Native queue, lease, checkpoint and outbox behavior on independent clients. */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, createDagJobRunner } from '@jarenjs/db';
import { compileDag } from '@jarenjs/flow';
import { postgresDriver } from '@jarenjs/db/postgres';
import { nodeDriver } from '@jarenjs/db/node';

const url = process.env.JAREN_PG_URL;
const model = { $model: '0.1', collections: { notes: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } } } } };
const until = async (fn) => {
  const stop = Date.now() + 15000;
  while (!await fn()) {
    assert.ok(Date.now() < stop, 'native queue did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
// Intercept a real server reply without replacing native execution or locking.
const observedSource = (pool, observe) => ({ connect: async () => {
  const client = await pool.connect();
  return { release: (error) => client.release(error), query: async (query, values) => {
    const result = await client.query(query, values);
    await observe(typeof query === 'string' ? query : query.text);
    return result;
  } };
} });

describe('PostgreSQL jobs and transactional outbox', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let pg, serial = 0;
  before(async () => { pg = (await import('pg')).default; });
  async function fixture(fn) {
    const schema = `jaren_jobs_${process.pid}_${serial++}`;
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    const stores = [], workers = [];
    let at = 1800000000000.5;
    const options = { jobs: { now: () => at, random: () => 0 } };
    const open = async (extra = {}, source = pool) => {
      const store = await openStore(model, { driver: postgresDriver(source, { schema }), ...options, ...extra });
      stores.push(store); return store;
    };
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await fn({ pool, schema, open, options, workers, now: () => at, advance: (ms) => { at += ms; } });
    }
    finally {
      try {
        for (const worker of workers) await worker.stop({ graceMs: 1000 });
        for (const store of stores) await store.close();
      }
      finally {
        try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await pool.end(); }
      }
    }
  }

  it('preserves SQLite records, fractional epochs, large attempt budgets and fenced retry/renewal', async () => {
    await fixture(async ({ open, options, now, advance }) => {
      const native = await open(), sqlite = await openStore(model, { driver: nodeDriver(), ...options });
      try {
        for (const store of [native, sqlite]) {
          await store.jobs.enqueue('mail', { body: 'payload?' }, { id: 'same', runAt: now() + 1.25, maxAttempts: 2147483649 });
          await store.jobs.enqueue('mail', { ignored: true }, { id: 'same' });
          assert.equal(await store.jobs.claim({ kinds: ['mail'], owner: 'host' }), undefined);
        }
        assert.deepEqual(await native.jobs.get('same'), await sqlite.jobs.get('same'));
        advance(2);
        for (const store of [native, sqlite]) {
          const first = await store.jobs.claim({ kinds: ['mail'], owner: 'host', leaseMs: 1000.25 });
          assert.equal(first.lease.expiresAt, now() + 1000.25);
          const lease = await store.jobs.renew(first.lease, { leaseMs: 2000.5 });
          await assert.rejects(async () => store.jobs.complete(first.lease, {}), { code: 'JD2066' });
          await store.jobs.fail(lease, new Error('retry'));
        }
        assert.deepEqual(await native.jobs.get('same'), await sqlite.jobs.get('same'));
        advance(501);
        for (const store of [native, sqlite]) {
          const claimed = await store.jobs.claim({ kinds: ['mail'], owner: 'host' });
          assert.equal(claimed.lease.generation, 2);
          await store.jobs.complete(claimed.lease, { delivered: true });
          await store.jobs.complete(claimed.lease, { ignored: true });
        }
        assert.deepEqual(await native.jobs.get('same'), await sqlite.jobs.get('same'));
      }
      finally { await sqlite.close(); }
    });
  });

  it('co-commits business data, enqueue and journal while rollback excludes all three', async () => {
    await fixture(async ({ open }) => {
      const store = await open({ capture: { log: true } });
      assert.equal(store.capabilities.jobs, true);
      await assert.rejects(store.transaction(async (tx) => {
        await tx.collection('notes').insert({ id: 'rollback' });
        await tx.jobs.enqueue('effect', { id: 'rollback' }, { id: 'rollback' });
        throw new Error('rollback');
      }), /rollback/);
      assert.equal(await store.jobs.get('rollback'), undefined);
      assert.equal(await store.collection('notes').get('rollback'), undefined);
      assert.deepEqual((await store.changes.page({ after: 0 })).items, []);
      await store.transaction(async (tx) => {
        await tx.collection('notes').insert({ id: 'committed' });
        await tx.jobs.enqueue('effect', { id: 'committed' }, { id: 'committed' });
      });
      await store.close();
      const reopened = await open({ capture: { log: true } });
      assert.equal((await reopened.jobs.get('committed')).state, 'pending');
      assert.equal((await reopened.collection('notes').get('committed')).id, 'committed');
      assert.deepEqual((await reopened.changes.page({ after: 0 })).items.map((r) => r.seq), [1]);
    });
  });

  it('opens concurrently and 4 independent workers claim and settle 200 jobs once', async () => {
    await fixture(async ({ open, workers }) => {
      const stores = await Promise.all(Array.from({ length: 4 }, () => open()));
      await stores[0].transaction(async (tx) => {
        for (let i = 0; i < 200; i++) await tx.jobs.enqueue('work', { i }, { id: String(i) });
      });
      const seen = new Map();
      for (const [i, store] of stores.entries()) {
        const worker = store.jobs.createWorker({ owner: `worker-${i}`, concurrency: 2, pollInterval: 5,
          handlers: { work: async ({ i }) => {
            seen.set(i, (seen.get(i) ?? 0) + 1);
            await new Promise((resolve) => setImmediate(resolve));
            return i;
          } } });
        workers.push(worker); worker.start();
      }
      await until(async () => (await stores[0].jobs.counts()).done === 200);
      assert.equal(seen.size, 200);
      assert.ok([...seen.values()].every((n) => n === 1));
      assert.equal(workers.reduce((sum, worker) => sum + worker.stats().claims, 0), 200);
      for (const worker of workers) assert.deepEqual(await worker.stop(), { drained: true, inFlight: 0 });
    });
  });

  it('skips a locked eligible row and holds an asserted lease through mapped writes', async () => {
    await fixture(async ({ open, pool, schema, advance }) => {
      const first = await open(), second = await open();
      for (const id of ['a', 'b']) await first.jobs.enqueue('work', {}, { id });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT id FROM "${schema}"._jaren_jobs WHERE id='a' FOR UPDATE`);
        assert.equal((await second.jobs.claim({ kinds: ['work'], owner: 'next' })).id, 'b');
        assert.equal(await second.jobs.claim({ kinds: ['work'], owner: 'next' }), undefined);
      }
      finally { await client.query('ROLLBACK'); client.release(); }
      const held = await first.jobs.claim({ kinds: ['work'], owner: 'first', leaseMs: 100 });
      const release = Promise.withResolvers();
      let paused = false;
      const tx = first.transaction(async (tx) => {
        await tx.jobs.assertLease(held.lease);
        paused = true; await release.promise;
        await tx.collection('notes').insert({ id: 'guarded' });
      });
      try {
        await until(() => paused); advance(101);
        assert.equal(await second.jobs.claim({ kinds: ['work'], owner: 'replacement' }), undefined);
      }
      finally { release.resolve(); await tx; }
      const replacement = await second.jobs.claim({ kinds: ['work'], owner: 'replacement' });
      assert.equal(replacement.id, 'a');
      await assert.rejects(first.jobs.assertLease(held.lease), { code: 'JD2066' });
      assert.equal((await first.collection('notes').get('guarded')).id, 'guarded');
    });
  });

  it('recovers expired checkpoints and atomically settles result and pruning', async () => {
    await fixture(async ({ open, pool, schema, advance }) => {
      let store = await open();
      await store.jobs.enqueue('flow', {}, { id: 'run' });
      const first = await store.jobs.claim({ kinds: ['flow'], owner: 'old', leaseMs: 10 });
      await store.jobs.checkpointsFor(first).save('run', 'one', { saved: true });
      advance(11);
      await assert.rejects(store.jobs.checkpointsFor(first).save('run', 'late', 1), { code: 'JD2067' });
      await store.close(); store = await open();
      const next = await store.jobs.claim({ kinds: ['flow'], owner: 'new' });
      assert.deepEqual(await store.jobs.checkpointsFor(next).load('run'), { values: { one: { saved: true } } });
      await assert.rejects(store.jobs.checkpointsFor(first).complete('run', {}), { code: 'JD2066' });
      await pool.query(`CREATE FUNCTION "${schema}".refuse_prune() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'prune failure'; END $body$;
        CREATE TRIGGER refuse_prune BEFORE DELETE ON "${schema}"._jaren_job_checkpoints FOR EACH ROW EXECUTE FUNCTION "${schema}".refuse_prune()`);
      await assert.rejects(store.jobs.checkpointsFor(next).complete('run', { complete: true }), /prune failure/);
      assert.equal((await store.jobs.get('run')).state, 'leased');
      assert.deepEqual(await store.jobs.checkpointsFor(next).load('run'), { values: { one: { saved: true } } });
      await pool.query(`DROP TRIGGER refuse_prune ON "${schema}"._jaren_job_checkpoints`);
      await store.jobs.checkpointsFor(next).complete('run', { complete: true });
      assert.equal(await store.jobs.checkpointsFor(next).load('run'), null);
      assert.deepEqual((await store.jobs.get('run')).result, { complete: true });
    });
  });

  it('holds a checkpoint fence until its save commits, even after lease expiry', async () => {
    await fixture(async ({ open, pool, advance }) => {
      const release = Promise.withResolvers();
      let armed = false, selected = false, paused = false;
      const first = await open({}, observedSource(pool, async (text) => {
        if (armed && text.includes('SELECT id FROM "_jaren_jobs"') && text.endsWith('FOR UPDATE')) selected = true;
        if (selected && text.startsWith('FETCH')) {
          selected = false; armed = false; paused = true; await release.promise;
        }
      })), second = await open();
      await first.jobs.enqueue('flow', {}, { id: 'run' });
      const old = await first.jobs.claim({ kinds: ['flow'], owner: 'old', leaseMs: 10 });
      armed = true;
      const save = first.jobs.checkpointsFor(old).save('run', 'node', { original: true });
      try {
        await until(() => paused); advance(11);
        assert.equal(await second.jobs.claim({ kinds: ['flow'], owner: 'new' }), undefined);
      }
      finally { release.resolve(); await save; }
      const fresh = await second.jobs.claim({ kinds: ['flow'], owner: 'new' });
      assert.equal(fresh.lease.generation, 2);
      assert.deepEqual(await second.jobs.checkpointsFor(fresh).load('run'), { values: { node: { original: true } } });
      await assert.rejects(first.jobs.checkpointsFor(old).save('run', 'node', { stale: true }), { code: 'JD2066' });
    });
  });

  it('sweeps one locked victim set when another job becomes settled between replies', async () => {
    await fixture(async ({ open, pool, schema, now }) => {
      const release = Promise.withResolvers();
      let armed = false, paused = false;
      const first = await open({}, observedSource(pool, async (text) => {
        if (armed && text.includes('DELETE FROM "_jaren_job_checkpoints"')) {
          armed = false; paused = true; await release.promise;
        }
      })), second = await open();
      for (const [id, maxAttempts] of [['a', 1], ['0', 2]]) {
        await first.jobs.enqueue(id, {}, { id, maxAttempts });
        const job = await first.jobs.claim({ kinds: [id], owner: 'seed' });
        await first.jobs.checkpointsFor(job).save(id, 'saved', id);
        await first.jobs.fail(job.lease, 'failure');
      }
      assert.equal((await first.jobs.get('a')).state, 'dead');
      assert.equal((await first.jobs.get('0')).state, 'failed');
      armed = true;
      const sweep = first.jobs.sweep({ settledBefore: now() + 1, limit: 1 });
      try {
        await until(() => paused);
        assert.equal(await second.jobs.cancel('0'), true);
      }
      finally { release.resolve(); }
      assert.deepEqual(await sweep, { removed: 1 });
      assert.equal(await first.jobs.get('a'), undefined);
      assert.equal((await first.jobs.get('0')).state, 'cancelled');
      assert.deepEqual((await pool.query(`SELECT run_id FROM "${schema}"._jaren_job_checkpoints`)).rows, [{ run_id: '0' }]);
      assert.deepEqual(await first.jobs.sweep({ settledBefore: now() + 1 }), { removed: 1 });
      assert.deepEqual(await first.jobs.sweep({ settledBefore: now() + 1 }), { removed: 0 });
    });
  });

  it('preserves historical queue rows and checkpoint values across concurrent forward upgrades', async () => {
    await fixture(async ({ open, pool, schema, advance }) => {
      const first = await open();
      for (const id of ['pending', 'leased', 'failed']) await first.jobs.enqueue(id, { id }, { id });
      const leased = await first.jobs.claim({ kinds: ['leased'], owner: 'previous', leaseMs: 10 });
      await first.jobs.checkpointsFor(leased).save('leased', 'node', { kept: true });
      const failed = await first.jobs.claim({ kinds: ['failed'], owner: 'previous' });
      await first.jobs.fail(failed.lease, 'historical error');
      const records = await Promise.all(['pending', 'leased', 'failed'].map((id) => first.jobs.get(id)));
      await first.close();
      await pool.query(`ALTER TABLE "${schema}"._jaren_jobs DROP COLUMN lease_generation, DROP COLUMN lease_token;
        ALTER TABLE "${schema}"._jaren_job_checkpoints DROP COLUMN generation`);
      const upgraded = await Promise.all([open(), open()]);
      for (const store of upgraded) {
        for (const record of records) assert.deepEqual(await store.jobs.get(record.id), { ...record, leaseGeneration: 0 });
      }
      advance(11);
      const recovered = await upgraded[0].jobs.claim({ kinds: ['leased'], owner: 'current' });
      assert.equal(recovered.attempts, 2); assert.equal(recovered.lease.generation, 1);
      assert.deepEqual(await upgraded[0].jobs.checkpointsFor(recovered).load('leased'), { values: { node: { kept: true } } });
      await upgraded[0].jobs.checkpointsFor(recovered).complete('leased', { resumed: true });
      await upgraded[0].close(); await upgraded[1].close();
      const reopened = await open({ adopt: true });
      assert.equal((await reopened.jobs.get('leased')).state, 'done');
      assert.equal((await reopened.jobs.get('failed')).lastError, 'historical error');
    });
  });

  it('resumes the injected DAG runner after reopen and refuses changed task identity before reuse', async () => {
    await fixture(async ({ open, workers, advance }) => {
      const document = { $dag: '0.1', nodes: {
        in: { kind: 'input' },
        expensive: { kind: 'task', run: 'expensive', checkpoint: true, version: '1' },
        fragile: { kind: 'task', run: 'fragile', version: '1' }, out: { kind: 'output' },
      }, edges: [{ from: 'in', to: 'expensive' }, { from: 'expensive', to: 'fragile' }, { from: 'fragile', to: 'out' }] };
      const counts = { expensive: 0, fragile: 0 };
      let crash = true;
      const runner = (store, version) => {
        const revision = { ...document, nodes: { ...document.nodes, fragile: { ...document.nodes.fragile, version } } };
        const worker = createDagJobRunner(store, { compileDag, documents: { report: revision }, pollInterval: 5,
          tasks: {
            expensive: { version: '1', run: ({ input }) => { counts.expensive++; return { loaded: input.day }; } },
            fragile: { version, run: ({ input }) => { counts.fragile++; if (crash) throw new Error('interrupted'); return input; } },
          } });
        workers.push(worker); worker.start(); return worker;
      };
      let store = await open();
      await store.jobs.enqueue('report', { input: { day: 'mon' } }, { id: 'report' });
      const first = runner(store, '1');
      await until(async () => (await store.jobs.get('report')).state === 'failed');
      await first.stop(); await store.close();
      store = await open(); advance(501); crash = false;
      const changed = runner(store, '2');
      await until(async () => (await store.jobs.get('report')).attempts === 2 && (await store.jobs.get('report')).state === 'failed');
      await changed.stop();
      assert.match((await store.jobs.get('report')).lastError, /task versions/);
      assert.deepEqual(counts, { expensive: 1, fragile: 1 });
      advance(1001);
      const restored = runner(store, '1');
      await until(async () => (await store.jobs.get('report')).state === 'done');
      await restored.stop();
      assert.deepEqual(counts, { expensive: 1, fragile: 2 });
      assert.deepEqual((await store.jobs.get('report')).result, { loaded: 'mon' });
    });
  });

  it('bounds stop, fences a late handler, and recovers its abandoned claim', async () => {
    await fixture(async ({ open, workers, advance }) => {
      const first = await open(), second = await open();
      const release = Promise.withResolvers();
      let context;
      const worker = first.jobs.createWorker({ owner: 'wedged', renew: false, leaseMs: 100, pollInterval: 5,
        handlers: { work: async (_payload, value) => { context = value; await release.promise; return { stale: true }; } } });
      workers.push(worker);
      await first.jobs.enqueue('work', {}, { id: 'abandoned' }); worker.start();
      try {
        await until(() => context !== undefined);
        const started = performance.now();
        assert.deepEqual(await worker.stop({ graceMs: 10 }), { drained: false, inFlight: 1 });
        assert.ok(performance.now() - started < 2000, 'stop remains bounded independently of the handler');
        assert.equal(context.signal.aborted, true);
        advance(101);
        const fresh = await second.jobs.claim({ kinds: ['work'], owner: 'replacement' });
        assert.equal(fresh.attempts, 2);
        await second.jobs.complete(fresh.lease, { fresh: true });
      }
      finally { release.resolve(); }
      await worker.stop();
      assert.deepEqual((await second.jobs.get('abandoned')).result, { fresh: true });
      assert.equal(worker.stats().completions, 0);
    });
  });

  it('pages with native cursor cleanup and cancels or resets only the authorized generation', async () => {
    await fixture(async ({ open }) => {
      const store = await open();
      for (const id of ['a', 'b', 'c']) await store.jobs.enqueue('work', { id }, { id });
      const page = store.jobs.page({ state: 'pending', kind: 'work', after: 'a', limit: 1 });
      assert.equal((await page.next()).value.id, 'b'); await page.return();
      assert.equal((await store.jobs.get('c')).state, 'pending');
      const controller = new AbortController();
      const cancelled = store.jobs.page({ signal: controller.signal });
      await cancelled.next(); controller.abort();
      await assert.rejects(cancelled.next(), { code: 'JD2072' }); await cancelled.return();
      const claim = await store.jobs.claim({ kinds: ['work'], owner: 'owner' });
      await store.jobs.checkpointsFor(claim).save(claim.id, 'node', { saved: true });
      await assert.rejects(store.jobs.cancel(claim.id), { code: 'JD2068' });
      await assert.rejects(store.jobs.reset(claim.id, { expectedGeneration: claim.lease.generation }), { code: 'JD2068' });
      assert.equal(await store.jobs.cancel(claim.id, { lease: claim.lease }), true);
      assert.equal(await store.jobs.cancel(claim.id, { lease: claim.lease }), false);
      assert.deepEqual(await store.jobs.reset(claim.id, { expectedGeneration: claim.lease.generation }),
        { reset: true, discarded: 1, generation: 2 });
      await assert.rejects(store.jobs.reset(claim.id, { expectedGeneration: claim.lease.generation }), { code: 'JD2066' });
      const fresh = await store.jobs.claim({ kinds: ['work'], owner: 'fresh' });
      assert.equal(fresh.id, claim.id); assert.equal(fresh.attempts, 1); assert.equal(fresh.lease.generation, 3);
      assert.equal(await store.jobs.checkpointsFor(fresh).load(fresh.id), null);
      await assert.rejects(store.jobs.complete(claim.lease, { stale: true }), { code: 'JD2066' });
    });
  });

  it('reconciles unknown enqueue and claim replies without replaying effects or attempts', async () => {
    await fixture(async ({ open, pool, advance }) => {
      let lose = '', replies = 0;
      const source = observedSource(pool, (text) => {
        if (lose && (lose === 'commit' ? text === 'COMMIT' : text.startsWith('UPDATE "_jaren_jobs" SET state=\'leased\''))) {
          lose = ''; replies++;
          throw Object.assign(new Error('queue reply lost'), { code: '08006' });
        }
      });
      let writer = await open({}, source);
      lose = 'commit';
      await assert.rejects(writer.transaction(async (tx) => {
        await tx.collection('notes').insert({ id: 'receipt' });
        await tx.jobs.enqueue('work', { receipt: 'receipt' }, { id: 'receipt' });
      }), { code: 'JD2087' });
      await writer.close();
      writer = await open({}, source);
      assert.equal((await writer.jobs.get('receipt')).attempts, 0);
      assert.equal((await writer.collection('notes').get('receipt')).id, 'receipt');
      lose = 'claim';
      await assert.rejects(writer.jobs.claim({ kinds: ['work'], owner: 'unknown', leaseMs: 10 }), /queue reply lost/);
      await writer.close();
      const reader = await open();
      assert.equal((await reader.jobs.get('receipt')).attempts, 1);
      assert.equal(await reader.jobs.claim({ kinds: ['work'], owner: 'new' }), undefined);
      advance(11);
      const recovered = await reader.jobs.claim({ kinds: ['work'], owner: 'new' });
      assert.equal(recovered.attempts, 2); assert.equal(recovered.lease.generation, 2);
      assert.equal(replies, 2);
      await reader.jobs.complete(recovered.lease, { delivered: true });
    });
  });

  it('adopts an existing native queue without DDL and refuses damaged columns or indexes', async () => {
    await fixture(async ({ open, pool, schema }) => {
      const seed = await open();
      await seed.jobs.enqueue('history', { original: true }, { id: 'original' }); await seed.close();
      const ddl = [];
      const source = { connect: async () => {
        const client = await pool.connect();
        return { release: (error) => client.release(error), query: (query, values) => {
          const text = typeof query === 'string' ? query : query.text;
          if (/^\s*(CREATE|ALTER|DROP)\b/.test(text)) ddl.push(text);
          return client.query(query, values);
        } };
      } };
      const adopted = await open({ adopt: true }, source);
      assert.equal((await adopted.jobs.get('original')).payload.original, true);
      assert.deepEqual(ddl, []); await adopted.close();
      await pool.query(`ALTER TABLE "${schema}"._jaren_jobs DROP COLUMN lease_token`);
      await assert.rejects(open({ adopt: true }, source), { code: 'JD0002' });
      assert.deepEqual(ddl, []);
      const upgraded = await open(); await upgraded.close();
      await pool.query(`DROP INDEX "${schema}"._jaren_jobs_claim`);
      await assert.rejects(open({ adopt: true }, source), { code: 'JD0002' });
      assert.deepEqual(ddl, []);
    });
  });
});
