//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createCommand } from '@jarenjs/contract/command';
import { openLocalClient } from '@jarenjs/contract/local';
import { serveHttp } from '@jarenjs/contract/http';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { fixture, contract, input, identity, adjust } from '../durable/fixtures.js';

it('HTTP/local/job replays commit one effect after both lease and HTTP TTL expiry', async () => {
  const f = await fixture();
  let authorized = true;
  try {
    const command = createCommand(contract.operations['item.adjust'], { repository: f.receipts, identity, authorize: () => authorized, handler: adjust });
    const handlers = { 'item.adjust': command.handler };
    const local = openLocalClient(contract, handlers);
    const http = serveHttp(contract, handlers);
    assert.equal(local.capabilities.idempotency, false);
    const first = await local.invoke('item.adjust', input);
    assert.equal(first.ok, true);
    const leaseIdentity = identity();
    const ttl = createMemoryLedger({ ttlMs: 10 });
    const key = { op: 'legacy', scope: 'a', key: 'one', hash: 'h', now: 100 };
    ttl.commit(ttl.claim(key).ref, { historic: true }, 101);
    f.advance(1000);
    assert.equal(ttl.claim({ ...key, now: f.now() }).state, 'new');
    const response = await http.dispatch({ method: 'POST', url: '/adjust', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    const job = await command.execute(input, { carrier: 'job' });
    assert.equal(job.state, 'replay');
    assert.equal(job.historic, true);
    assert.deepEqual(job.receipt.outcome.value, { revision: 1, count: 3 });
    assert.equal((await f.receipts.claim(leaseIdentity, { leaseMs: 10 })).state, 'replay');
    assert.equal((await f.client.collections.items.get('item-1')).count, 3);
    assert.equal((await f.client.collections.receipts.toArray()).length, 1);
    const collision = await command.execute({ ...input, delta: 4 });
    assert.deepEqual([collision.state, collision.reason], ['refused', 'identity-mismatch']);
    authorized = false;
    assert.deepEqual(await command.execute(input), { state: 'refused', reason: 'unauthorized', historic: false });
    assert.equal((await local.invoke('item.adjust', input)).ok, false);
    const deniedHttp = await http.dispatch({ method: 'POST', url: '/adjust', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(deniedHttp.status, 500);
    assert.ok(!JSON.stringify(deniedHttp).includes('count'));
    local.close();
  }
  finally { await f.client.close(); }
});

for (const failure of ['output', 'details', 'receipt', 'commit', 'undeclared']) it(`${failure} failure rolls back domain/outbox/receipt`, async () => {
  const f = await fixture();
  try {
    let repository = f.receipts;
    if (failure === 'receipt' || failure === 'commit') {
      const { createDbReceipts } = await import('@jarenjs/linq/db');
      repository = createDbReceipts({ ...f.client, transaction: (fn, options) => f.client.transaction(async (tx) => {
        if (failure === 'receipt') return fn({ ...tx, collections: { ...tx.collections, receipts: { ...tx.collections.receipts, insert: () => { throw new Error('receipt refused'); } } } });
        const result = await fn(tx);
        throw new Error(`commit refused: ${result.state}`);
      }, options) }, { receipts: 'receipts' });
    }
    const command = createCommand(contract.operations['item.adjust'], { repository, identity, authorize: () => true,
      handler: async (value, context) => {
        const result = await adjust(value, context);
        if (failure === 'output') return { count: 'broken' };
        if (failure === 'details') return context.fail('rejected', {}, { reason: 3 });
        if (failure === 'undeclared') return context.fail('unknown');
        return result;
      } });
    await assert.rejects(command.execute(input));
    assert.deepEqual(await f.client.collections.items.toArray(), []);
    assert.deepEqual(await f.client.collections.receipts.toArray(), []);
    assert.equal(await f.client.store.jobs.get(input.key), undefined);
  }
  finally { await f.client.close(); }
});

it('commits only explicitly declared validated failure facts and replays them', async () => {
  const f = await fixture();
  try {
    const handler = async (value, ctx) => {
      await ctx.host.collections.audit.put({ id: value.key, observation: 'rejected' }, value.key);
      return ctx.fail('rejected', {}, { reason: 'not available' });
    };
    const normal = createCommand(contract.operations['item.adjust'], { repository: f.receipts, identity, authorize: () => true, handler });
    assert.equal((await normal.execute(input)).state, 'uncommitted');
    assert.deepEqual(await f.client.collections.audit.toArray(), []);
    const command = createCommand(contract.operations['item.adjust'], { repository: f.receipts, identity, authorize: () => true, handler, commitFailures: ['rejected'] });
    assert.equal((await command.execute(input)).state, 'committed');
    assert.equal((await command.execute(input)).state, 'replay');
    const local = openLocalClient(contract, { 'item.adjust': command.handler });
    const result = await local.invoke('item.adjust', input);
    assert.equal(result.error.code, 'rejected');
    assert.deepEqual(result.error.details, { reason: 'not available' });
    assert.equal((await f.client.collections.audit.toArray()).length, 1);
    local.close();
  }
  finally { await f.client.close(); }
});

it('guards expected revisions, rejects malformed configuration and rolls back cancellation', async () => {
  const f = await fixture();
  try {
    const opts = { repository: f.receipts, identity, authorize: () => true, handler: adjust };
    assert.throws(() => createCommand(null, opts), { code: 'JC1013' });
    assert.throws(() => createCommand(contract.operations['item.adjust'], { ...opts, commitFailures: ['missing'] }), { code: 'JC1013' });
    const command = createCommand(contract.operations['item.adjust'], opts);
    assert.equal((await command.execute(input)).state, 'committed');
    assert.equal((await command.execute({ ...input, key: 'stale' })).state, 'uncommitted');
    const abort = new AbortController();
    const cancelled = createCommand(contract.operations['item.adjust'], { ...opts, handler: async (value, ctx) => { const result = await adjust(value, ctx); abort.abort(); return result; } });
    assert.equal((await cancelled.execute({ ...input, expected: 1, key: 'abort' }, { signal: abort.signal })).reason, 'cancelled');
    assert.equal((await f.client.collections.items.get('item-1')).revision, 1);
    await assert.rejects(command.execute({ ...input, delta: 'bad' }), { code: 'JC2110' });
  }
  finally { await f.client.close(); }
});

it('a real deferred database commit failure rolls back a validated command, receipt and outbox', async () => {
  const { nodeDriver } = await import('@jarenjs/db/node');
  const driver = { ...nodeDriver(), open: async (...args) => {
    const connection = await nodeDriver().open(...args);
    connection.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)');
    return connection;
  } };
  const f = await fixture({ driver });
  try {
    const command = createCommand(contract.operations['item.adjust'], { repository: f.receipts, identity, authorize: () => true,
      handler: async (value, context) => {
        const result = await adjust(value, context);
        await context.host.sql.prepare('INSERT INTO child VALUES(1,99)', { access: 'write' }).run([]);
        return result;
      } });
    await assert.rejects(command.execute(input), /FOREIGN KEY constraint failed/);
    assert.equal(await f.client.collections.items.get('item-1'), undefined);
    assert.equal((await f.receipts.lookup(identity())).state, 'absent');
    assert.equal(await f.client.store.jobs.get(input.key), undefined);
  }
  finally { await f.client.close(); }
});
