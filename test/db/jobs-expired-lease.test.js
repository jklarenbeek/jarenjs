//@ts-check
/**
 * @file An expired lease at an exhausted attempt budget (JOBS-FORMAT §4, §5):
 * the claim dead-letters the job instead of claiming it again, on SQLite and,
 * where JAREN_PG_URL is set, on PostgreSQL. Time is an injected clock.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const model = { $model: '0.1', collections: { x: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' } } } } } };
const url = process.env.JAREN_PG_URL;

/** The shared cases, run against whatever `{ store, cleanup }` `open(options)` makes. */
const cases = (open) => {
  const fixture = async (fn) => {
    let at = 1_000_000;
    const { store, cleanup } = await open({ jobs: { now: () => at, random: () => 0 } });
    try { await fn(store, (ms) => { at += ms; }); } finally {
      try { await store.close(); } finally { await cleanup(); }
    }
  };
  const claim = (store, kinds = ['k']) => store.jobs.claim({ kinds, owner: 'w', leaseMs: 10 });

  it('dead-letters a crashed final attempt instead of claiming it again', async () => {
    await fixture(async (store, advance) => {
      await store.jobs.enqueue('k', null, { id: 'j', maxAttempts: 1 });
      const first = await claim(store);
      assert.equal(first.attempts, 1);
      advance(100);
      assert.equal(await claim(store), undefined);
      const job = await store.jobs.get('j');
      assert.equal(job.state, 'dead');
      assert.equal(job.attempts, 1);
      assert.equal(job.lastError, 'lease expired');
      assert.equal(job.leaseUntil, null);
      assert.equal(job.leaseGeneration, 2);
      assert.equal(await claim(store), undefined);
      assert.equal((await store.jobs.get('j')).attempts, 1);
      // the crashed attempt's token meets a fence, not a silent success
      await assert.rejects(async () => store.jobs.complete(first.lease, 'late'), { code: 'JD2065' });
      assert.equal((await store.jobs.counts()).dead, 1);
    });
  });

  it('keeps the last recorded error of an earlier failed attempt', async () => {
    await fixture(async (store, advance) => {
      await store.jobs.enqueue('k', null, { id: 'j', maxAttempts: 2 });
      const first = await claim(store);
      await store.jobs.fail(first.lease, new Error('boom'));
      advance(100_000);
      const second = await claim(store);
      assert.equal(second.attempts, 2);
      advance(100);
      assert.equal(await claim(store), undefined);
      const job = await store.jobs.get('j');
      assert.deepEqual([job.state, job.attempts, job.lastError], ['dead', 2, 'boom']);
    });
  });

  it('still reclaims an expired lease while attempts remain', async () => {
    await fixture(async (store, advance) => {
      await store.jobs.enqueue('k', null, { id: 'j', maxAttempts: 3 });
      assert.equal((await claim(store)).attempts, 1);
      advance(100);
      const again = await claim(store);
      assert.deepEqual([again.attempts, again.state], [2, 'leased']);
    });
  });

  it('leaves a requeued dead job its one extra attempt, then dead-letters it again', async () => {
    await fixture(async (store, advance) => {
      await store.jobs.enqueue('k', null, { id: 'j', maxAttempts: 1 });
      await claim(store);
      advance(100);
      assert.equal(await claim(store), undefined);
      assert.equal(await store.jobs.requeue('j'), true);
      const extra = await claim(store);
      assert.deepEqual([extra.attempts, extra.state], [2, 'leased']);
      advance(100);
      assert.equal(await claim(store), undefined);
      const job = await store.jobs.get('j');
      assert.deepEqual([job.state, job.attempts], ['dead', 2]);
    });
  });

  it('dead-letters only the kinds the claim names, and never a live lease', async () => {
    await fixture(async (store, advance) => {
      await store.jobs.enqueue('other', null, { id: 'o', maxAttempts: 1 });
      await store.jobs.enqueue('k', null, { id: 'live', maxAttempts: 1 });
      await store.jobs.claim({ kinds: ['other'], owner: 'w', leaseMs: 10 });
      advance(100);
      await store.jobs.claim({ kinds: ['k'], owner: 'w', leaseMs: 1_000 });
      assert.equal(await claim(store), undefined);
      assert.equal((await store.jobs.get('o')).state, 'leased');
      assert.equal((await store.jobs.get('live')).state, 'leased');
      assert.equal(await store.jobs.claim({ kinds: ['other'], owner: 'w' }), undefined);
      assert.equal((await store.jobs.get('o')).state, 'dead');
    });
  });
};

describe('an expired lease past maxAttempts on SQLite', () => {
  cases(async (options) => ({
    store: await openStore(model, { driver: nodeDriver(), ...options }), cleanup: async () => {} }));
});

describe('an expired lease past maxAttempts on PostgreSQL', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let serial = 0;
  cases(async (options) => {
    const pg = (await import('pg')).default;
    const schema = `jaren_expired_${process.pid}_${serial++}`;
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const store = await openStore(model, { driver: postgresDriver(pool, { schema }), ...options });
    return { store, cleanup: async () => {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    } };
  });
});
