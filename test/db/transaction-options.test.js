//@ts-check
/**
 * @file A transaction's options are ONE closed set on every surface
 * (MODEL-FORMAT §5.1): the asynchronous root, the synchronous twin, a
 * nested transaction and the typed client. An unknown member is refused
 * by name with the nearest one (`JD0013`) before the body runs — a
 * misspelt `{ mod: 'immediate' }` used to run DEFERRED, and a bare
 * string, `{ retry: 3 }` or `{ isolation: 'serializable' }` ran as if
 * nothing had been asked. A nested transaction reads the same set and
 * refuses what its savepoint cannot honour (`JD0014`): `unitOfWork` is
 * the root's to choose, and only the root can take the writer lock. The
 * synchronous twin honours `unitOfWork` as the root does, and the typed
 * client keeps its own unit when `unitOfWork` is passed as `undefined`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { open } from '@jarenjs/linq/db';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
  entities: {
    Team: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' } },
      },
    },
  },
};

/** @param {string} code */
const coded = (code) => (/** @type {any} */ error) => error?.code === code;

describe('transaction options are a closed set (JD0013)', () => {
  it('a misspelt member is refused by name, with the nearest one, before any body runs — on every surface', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    let ran = 0;
    const misspelt = (/** @type {any} */ error) => error?.code === 'JD0013'
      && /'mod'/.test(error.message) && /did you mean 'mode'\?/.test(error.message);
    await assert.rejects(store.transaction(async () => { ran++; }, /** @type {any} */ ({ mod: 'immediate' })), misspelt);
    assert.throws(() => store.sync?.transaction(() => { ran++; }, /** @type {any} */ ({ mod: 'immediate' })), misspelt);
    await store.transaction(async (tx) => {
      await assert.rejects(tx.transaction(async () => { ran++; }, /** @type {any} */ ({ mod: 'immediate' })), misspelt);
    });
    store.sync?.transaction((tx) => {
      assert.throws(() => tx.sync.transaction(() => { ran++; }, /** @type {any} */ ({ mod: 'immediate' })), misspelt);
    });
    assert.strictEqual(ran, 0, 'no refused body ran');
    await store.close();

    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    await assert.rejects(client.transaction(async () => { ran++; }, /** @type {any} */ ({ mod: 'immediate' })), misspelt);
    await client.transaction(async (tx) => {
      await assert.rejects(tx.transaction(async () => { ran++; }, /** @type {any} */ ({ mod: 'immediate' })), misspelt);
    });
    assert.strictEqual(ran, 0);
    await client.close();
  });

  it('a bare string, a guarantee no transaction reads, and a malformed value are refused as JD0013', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    let ran = 0;
    for (const options of ['immediate', { retry: 3 }, { isolation: 'serializable' }, { timeout: 10 },
      { mode: 'bogus' }, { unitOfWork: 'bogus' }, { signal: 'soon' }, null, ['immediate']]) {
      await assert.rejects(store.transaction(async () => { ran++; }, /** @type {any} */ (options)), coded('JD0013'),
        `store.transaction ${JSON.stringify(options)}`);
      assert.throws(() => store.sync?.transaction(() => { ran++; }, /** @type {any} */ (options)), coded('JD0013'),
        `store.sync.transaction ${JSON.stringify(options)}`);
      await assert.rejects(client.transaction(async () => { ran++; }, /** @type {any} */ (options)), coded('JD0013'),
        `client.transaction ${JSON.stringify(options)}`);
    }
    assert.strictEqual(ran, 0);
    // the value refusals keep their wording
    await assert.rejects(store.transaction(async () => {}, /** @type {any} */ ({ mode: 'exclusive' })),
      (/** @type {any} */ error) => error.code === 'JD0013' && /mode must be 'deferred' or 'immediate'/.test(error.message));
    await assert.rejects(store.transaction(async () => {}, /** @type {any} */ ({ unitOfWork: 'mine' })),
      (/** @type {any} */ error) => error.code === 'JD0013' && /unitOfWork must be 'shared' or 'own'/.test(error.message));
    // every member the set names still runs
    const controller = new AbortController();
    assert.strictEqual(await store.transaction(async () => 'ok', { mode: 'immediate', signal: controller.signal, unitOfWork: 'own' }), 'ok');
    assert.strictEqual(store.sync?.transaction(() => 'ok', { mode: 'immediate', unitOfWork: 'shared' }), 'ok');
    await store.close();
    await client.close();
  });
});

describe('a nested transaction reads the same set and refuses what a savepoint cannot honour (JD0014)', () => {
  it('unitOfWork, and an immediate the root did not take, are JD0014; a mode the root holds and a signal are accepted', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    let ran = 0;
    await store.transaction(async (tx) => {
      for (const unitOfWork of ['own', 'shared']) {
        await assert.rejects(tx.transaction(async () => { ran++; }, /** @type {any} */ ({ unitOfWork })),
          (/** @type {any} */ error) => error.code === 'JD0014' && /unitOfWork cannot act on a nested transaction/.test(error.message));
      }
      await assert.rejects(tx.transaction(async () => { ran++; }, { mode: 'immediate' }),
        (/** @type {any} */ error) => error.code === 'JD0014' && /writer lock/.test(error.message));
      assert.strictEqual(ran, 0);
      assert.strictEqual(await tx.transaction(async () => 'deferred', { mode: 'deferred' }), 'deferred');
      assert.strictEqual(await tx.transaction(async () => 'signalled', { signal: new AbortController().signal }), 'signalled');
    });
    await store.transaction(async (tx) => {
      assert.strictEqual(await tx.transaction(async () => 'held', { mode: 'immediate' }), 'held');
      assert.strictEqual(await tx.transaction(async () => 'weaker', { mode: 'deferred' }), 'weaker');
      await tx.transaction(async (inner) => {
        // the root's mode reaches every level
        assert.strictEqual(await inner.transaction(async () => 'deep', { mode: 'immediate' }), 'deep');
      });
    }, { mode: 'immediate' });
    store.sync?.transaction((tx) => {
      assert.throws(() => tx.sync.transaction(() => { ran++; }, /** @type {any} */ ({ unitOfWork: 'own' })), coded('JD0014'));
      assert.throws(() => tx.sync.transaction(() => { ran++; }, { mode: 'immediate' }), coded('JD0014'));
      assert.strictEqual(tx.sync.transaction(() => 'nested', { mode: 'deferred' }), 'nested');
    });
    assert.strictEqual(ran, 0);
    await store.close();
  });

  it('a nested or synchronous transaction never queues, so an aborted signal refuses it before it begins (JD2064)', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const controller = new AbortController();
    controller.abort();
    let ran = 0;
    await store.transaction(async (tx) => {
      await assert.rejects(tx.transaction(async () => { ran++; }, { signal: controller.signal }), coded('JD2064'));
    });
    assert.throws(() => store.sync?.transaction(() => { ran++; }, { signal: controller.signal }), coded('JD2064'));
    assert.strictEqual(ran, 0);
    await store.close();
  });
});

describe('unitOfWork is honoured wherever it is read', () => {
  it("the synchronous twin gives an 'own' transaction a tracker of its own, as the asynchronous root does", async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const sync = /** @type {any} */ (store.sync);
    store.entity('Team').add({ id: 'staged', name: 'outside' });
    sync.transaction((/** @type {any} */ tx) => { tx.sync.saveChanges(); }, { unitOfWork: 'own' });
    assert.strictEqual(sync.entity('Team').get('staged'), undefined, 'the root tracker was not saved from an own unit');
    assert.strictEqual(/** @type {any} */ (store.stats()).tracker.pendingInserts, 1);
    // the shared default still saves what was staged outside
    sync.transaction((/** @type {any} */ tx) => { tx.sync.saveChanges(); });
    assert.strictEqual(sync.entity('Team').get('staged')?.name, 'outside');
    await store.close();
  });

  it("the typed client keeps 'own' when unitOfWork is passed as undefined", async () => {
    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    const teams = /** @type {any} */ (client.entities).Team;
    teams.add({ id: 'staged', name: 'outside' });
    await client.transaction(async (tx) => { await tx.saveChanges?.(); }, { mode: 'immediate', unitOfWork: undefined });
    assert.strictEqual(await teams.get('staged'), undefined, 'the client tracker was not saved from the transaction');
    await client.saveChanges?.();
    assert.strictEqual((await teams.get('staged'))?.name, 'outside');
    await client.close();
  });
});
