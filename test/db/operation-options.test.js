//@ts-check
/**
 * @file The options of the maintenance operations, the change page and the
 * replication calls are closed sets: a member that is none of the call's own
 * is `JD0013` naming the nearest, before anything runs. A misspelt `mode` ran
 * a PASSIVE checkpoint where a TRUNCATE was asked for, and a misspelt `limit`
 * paged with the default bound.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = { $model: '0.1', collections: { notes: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' } } } } } };

/** @param {(store: any) => Promise<void>} body */
async function withStore(body) {
  const store = await openStore(MODEL, {
    driver: nodeDriver(), capture: { mode: 'journal', log: true }, replication: { replica: 'a' } });
  try {
    await store.collection('notes').put({ id: 'n1' });
    await body(store);
  }
  finally { await store.close(); }
}

const refused = (/** @type {string} */ call, /** @type {string} */ typo, /** @type {string} */ meant) =>
  ({ code: 'JD0013', message: new RegExp(`^JD0013: ${call} option '${typo}' is not one it reads.*${meant}`, 's') });

describe('closed option sets', () => {
  it('a maintenance operation refuses a misspelt option and runs nothing', async () => {
    await withStore(async (store) => {
      await assert.rejects(async () => store.checkpoint({ mod: 'truncate' }), refused('checkpoint', 'mod', 'mode'));
      await assert.rejects(async () => store.integrityCheck({ lmit: 5 }), refused('integrityCheck', 'lmit', 'limit'));
      await assert.rejects(async () => store.foreignKeyCheck({ sginal: 1 }), refused('foreignKeyCheck', 'sginal', 'signal'));
      await assert.rejects(async () => store.optimize({ deadlin: 1 }), refused('optimize', 'deadlin', 'deadline'));
      assert.deepEqual(await store.integrityCheck({ limit: 5 }), { ok: true, problems: [] });
      assert.equal(typeof (await store.checkpoint({ mode: 'passive' })).busy, 'boolean');
    });
  });

  it('the change page refuses a misspelt option, and pages with the bound it was given', async () => {
    await withStore(async (store) => {
      await store.collection('notes').put({ id: 'n2' });
      await assert.rejects(async () => store.changes.page({ after: 0, lmit: 1 }), refused('changes\\.page', 'lmit', 'limit'));
      const page = await store.changes.page({ after: 0, limit: 1 });
      assert.deepEqual([page.items.length, page.hasMore], [1, true]);
    });
  });

  it('the replication calls refuse a misspelt option', async () => {
    await withStore(async (store) => {
      await assert.rejects(async () => store.replication.page({ after: 0, lmit: 1 }), refused('replication\\.page', 'lmit', 'limit'));
      await assert.rejects(async () => store.replication.snapshot({ maxByte: 1 }), refused('replication\\.snapshot', 'maxByte', 'maxBytes'));
      await assert.rejects(async () => store.replication.conflicts({ lmit: 1 }), refused('replication\\.conflicts', 'lmit', 'limit'));
      const page = await store.replication.page({ after: 0, limit: 1 });
      assert.equal(page.items.length, 1);
      const target = await openStore(MODEL, { driver: nodeDriver(), replication: { replica: 'b' } });
      try {
        await assert.rejects(async () => target.replication.apply(page.items[0], { sginal: 1 }), refused('replication\\.apply', 'sginal', 'signal'));
        const snapshot = await store.replication.snapshot();
        await assert.rejects(async () => target.replication.reset(snapshot, { deadlin: 1 }), refused('replication\\.reset', 'deadlin', 'deadline'));
        assert.equal((await target.replication.apply(page.items[0])).status, 'applied');
      }
      finally { await target.close(); }
    });
  });
});
