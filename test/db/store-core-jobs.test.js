//@ts-check
/**
 * @file `jobs.enqueue(kind, payload, options)` reads a closed option set
 * (JOBS-FORMAT §2): `id`, `runAt` and `maxAttempts`. A misspelt member used
 * to be dropped in silence — a typo'd `runAt` made the job eligible at once —
 * and is now `JD0013` naming the nearest member; options that are not a plain
 * object are `JD0013` too, and a caller-supplied `id` is a non-empty string.
 * The value rules `runAt` and `maxAttempts` always had stay `TypeError`s.
 *
 * The PostgreSQL half runs where `JAREN_PG_URL` names a server.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const MODEL = { $model: '0.1', collections: { c: { schema: { type: 'object' }, key: '/id' } } };

for (const engine of ENGINES) {
  describe(`jobs.enqueue reads a closed option set (${engine})`, { skip: skipFor(engine) }, () => {
    it('refuses a misspelt member, options that are not an object, and an id that is not a non-empty string — enqueueing nothing', () =>
      withStore(engine, MODEL, async (store) => {
        const later = Date.now() + 3_600_000;
        /** @param {any} options */
        const enqueue = (options) => Promise.resolve().then(() => store.jobs.enqueue('t', {}, options));
        await assert.rejects(enqueue({ runat: later }), { code: 'JD0013', message: /'runat'.*did you mean 'runAt'\?/ });
        await assert.rejects(enqueue({ maxAttempt: 2 }), { code: 'JD0013', message: /did you mean 'maxAttempts'\?/ });
        await assert.rejects(enqueue({ ID: 'x' }), { code: 'JD0013', message: /did you mean 'id'\?/ });
        for (const options of ['x', 7, null, []])
          await assert.rejects(enqueue(options), { code: 'JD0013', message: /plain object/ }, JSON.stringify(options));
        for (const id of [5, '', null])
          await assert.rejects(enqueue({ id }), { code: 'JD0013', message: /'id'.*non-empty string/ }, JSON.stringify(id));
        // the value rules JOBS-FORMAT documents are unchanged
        await assert.rejects(enqueue({ runAt: 'soon' }), TypeError);
        await assert.rejects(enqueue({ maxAttempts: 0 }), TypeError);
        const queued = [];
        for await (const job of store.jobs.page()) queued.push(job.id);
        assert.deepStrictEqual(queued, [], 'nothing was enqueued');
      }, { jobs: true }));

    it('every documented member still enqueues, and no options at all does too', () =>
      withStore(engine, MODEL, async (store) => {
        const later = Date.now() + 3_600_000;
        assert.strictEqual(await store.jobs.enqueue('t', { n: 1 }, { id: 'job-1', runAt: later, maxAttempts: 2 }), 'job-1');
        const job = await store.jobs.get('job-1');
        assert.deepStrictEqual([job.runAt, job.maxAttempts, job.state], [later, 2, 'pending']);
        assert.strictEqual(typeof await store.jobs.enqueue('t', null), 'string');
        assert.strictEqual(typeof await store.jobs.enqueue('t', null, {}), 'string');
      }, { jobs: true }));
  });
}
