//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDbReceipts, open } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { fixture, identity, model } from '../durable/fixtures.js';
import { tempDbPath } from '../db/helpers.js';
import { runPhysicalReceiptConsumer } from '../consumer/durable.js';

it('maps application receipt fields losslessly and refuses malformed mappings before writes', async () => {
  const client = await open({ ...model, collections: { ...model.collections, history: { key: '/key', schema: { type: 'object' }, indexes: [] } } }, { driver: nodeDriver(), validator: null });
  try {
    const mapping = { collection: 'history', write: ({ id, ...record }) => ({ key: id, entry: record }), read: ({ key, entry }) => ({ id: key, ...entry }) };
    const receipts = createDbReceipts(client, { receipts: mapping });
    await receipts.execute(identity(), async () => ({ outcome: { kind: 'value', value: 1 }, references: ['event-1'] }));
    const stored = (await client.collections.history.toArray())[0];
    assert.equal(stored.entry.identity.key, 'command-1');
    assert.deepEqual((await receipts.lookup(identity())).receipt.references, ['event-1']);
    assert.throws(() => createDbReceipts(client, { receipts: 'missing' }), /declared collection/);
    assert.throws(() => createDbReceipts(client, { receipts: 'receipts', leases: 'receipts' }), /distinct/);
    const bad = createDbReceipts(client, { receipts: { ...mapping, read: (value) => ({ ...mapping.read(value), identity: {} }) } });
    await assert.rejects(bad.execute({ ...identity(), key: 'new' }, async () => ({ outcome: 1 })), { code: 'JL2009' });
    assert.equal((await client.collections.history.toArray()).length, 1);
  }
  finally { await client.close(); }
});

it('separate processes settle one same-key effect and one expected-revision winner', async () => {
  const { dbPath, cleanup } = tempDbPath();
  const code = `
    import { fixture, contract, input, identity, adjust } from './test/durable/fixtures.js';
    import { createCommand } from '@jarenjs/contract/command';
    const f = await fixture({path: process.argv[1], busyTimeout: 5000});
    try {
      const command = createCommand(contract.operations['item.adjust'], {repository:f.receipts, identity, authorize:()=>true, handler:adjust});
      const result = await command.execute({...input, key:process.argv[2], expected:Number(process.argv[3])});
      process.stdout.write(result.state);
    } finally { await f.client.close(); }
  `;
  const run = (key, revision) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', code, dbPath, key, String(revision)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (value) => { out += value; });
    child.stderr.on('data', (value) => { err += value; });
    child.on('error', reject);
    child.on('close', (status) => status === 0 ? resolve(out) : reject(new Error(err)));
  });
  try {
    const seeded = await fixture({ path: dbPath });
    await seeded.client.close();
    assert.deepEqual((await Promise.all([run('one', 0), run('one', 0)])).sort(), ['committed', 'replay']);
    assert.deepEqual((await Promise.all([run('two', 1), run('three', 1)])).sort(), ['committed', 'uncommitted']);
    const f = await fixture({ path: dbPath });
    try {
      assert.equal((await f.client.collections.items.get('item-1')).revision, 2);
      assert.equal((await f.client.collections.receipts.toArray()).length, 2);
    }
    finally { await f.client.close(); }
  }
  finally { cleanup(); }
});

it('a logically lossless mapping with the wrong physical key rolls back before replay authority is lost', async () => {
  const f = await fixture();
  try {
    const bad = createDbReceipts(f.client, { receipts: { collection: 'receipts',
      write: (record) => ({ id: 'wrong-key', record }), read: (stored) => stored.record } });
    await assert.rejects(bad.execute(identity(), async (tx) => {
      await tx.collections.items.put({ id: 'effect' }, 'effect'); return { outcome: 1 };
    }), /physical key/);
    assert.deepEqual(await f.client.collections.items.toArray(), []);
    assert.deepEqual(await f.client.collections.receipts.toArray(), []);
  }
  finally { await f.client.close(); }
});

it('adopts an existing column-only receipt table with a composite application key and no shadow ledger', runPhysicalReceiptConsumer);
