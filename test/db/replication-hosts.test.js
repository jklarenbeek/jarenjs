//@ts-check
/** Identical logical envelopes over native sessions, wasm sessions and journals. */
import { it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import init from '@sqlite.org/sqlite-wasm';
import { openStore, encodeReplication } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { replicationModel, replicaState } from './oracle/replication.js';

let sqlite3;
before(async () => { sqlite3 = await init({ print: () => {}, printErr: () => {} }); });

async function corpus(driver, mode) {
  const store = await openStore(replicationModel, { driver, capture: { mode, log: true }, replication: { replica: 'origin' } });
  try {
    await store.transaction(async (tx) => {
      await tx.collection('notes').put({ id: 'x/~😀', n: 1 });
      await tx.collection('notes').put({ id: 'x/~😀', n: 2 });
      await tx.entity('Tag').create({ id: 't' });
      await tx.entity('Parent').create({ id: 'p', tags: ['t'] });
    });
    await store.entity('Parent').update('p', { name: 'updated' });
    await assert.rejects(store.transaction(async (tx) => {
      await tx.collection('notes').delete('x/~😀'); throw new Error('abort');
    }), /abort/);
    await store.entity('Parent').delete('p');
    return { envelopes: (await store.replication.page()).items.map(encodeReplication), state: await replicaState(store) };
  }
  finally { await store.close(); }
}

it('session and journal capture on Node, wasm and the worker produce equal logical transactions', async () => {
  const expected = await corpus(nodeDriver(), 'session');
  for (const [driver, mode] of [
    [nodeDriver(), 'journal'], [wasmDriver(sqlite3Handle(sqlite3)), 'session'],
    [wasmDriver(sqlite3Handle(sqlite3)), 'journal'], [nodeWorkerDriver(), 'journal'],
  ]) assert.deepEqual(await corpus(driver, mode), expected);
});

it('an async worker applies receipts and data in one transaction', async () => {
  const source = await openStore(replicationModel, { driver: nodeDriver(), replication: { replica: 'source' } });
  const target = await openStore(replicationModel, { driver: nodeWorkerDriver(), replication: { replica: 'target' } });
  try {
    await source.collection('notes').put({ id: 'one', n: 1 });
    const envelope = (await source.replication.page()).items[0];
    assert.equal((await target.replication.apply(envelope)).status, 'applied');
    assert.equal((await target.replication.apply(envelope)).status, 'duplicate');
    assert.deepEqual(await replicaState(target), await replicaState(source));
  }
  finally { await source.close(); await target.close(); }
});
