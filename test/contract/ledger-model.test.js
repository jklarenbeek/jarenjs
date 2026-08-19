//@ts-check
/**
 * @file The two documents idempotency ships as data: `idempotencyLedgerModel`
 * opens with `@jarenjs/db` and accepts exactly the record the memory
 * ledger keeps (rejecting a malformed one); `commandLifecycleFsm` compiles
 * with `@jarenjs/flow` and walks `idle → started → committed`, `started →
 * failed`, and `failed → started` only when the failure was retryable.
 * Test-side imports only: `packages/contract` declares neither package.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { JarenValidator } from '@jarenjs/validate';
import { compileFsm, createFsmSession } from '@jarenjs/flow';
import { idempotencyLedgerModel, commandLifecycleFsm, createMemoryLedger } from '@jarenjs/contract/ledger';

const manifest = JSON.parse(readFileSync(new URL('../../packages/contract/package.json', import.meta.url), 'utf8'));
/** The store's write validation hook (`compileTypeTest` signature). */
const compileSchema = (/** @type {any} */ schema) => new JarenValidator({ collectErrors: true }).compile(schema);

describe('idempotencyLedgerModel — a $model 0.1 document', () => {
  it('is pure JSON and the package declares neither db nor flow', () => {
    assert.strictEqual(idempotencyLedgerModel.$model, '0.1');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(idempotencyLedgerModel)), idempotencyLedgerModel);
    assert.strictEqual(Object.isFrozen(idempotencyLedgerModel), true);
    assert.deepStrictEqual(Object.keys(manifest.dependencies).sort(), ['@jarenjs/core', '@jarenjs/json', '@jarenjs/validate']);
  });

  it('opens with @jarenjs/db and accepts the record the memory ledger keeps', async () => {
    const store = await openStore(idempotencyLedgerModel, { driver: nodeDriver(), compileSchema });
    assert.strictEqual(store.capabilities.validated, true);
    const ledger = store.collection('ledger');
    const memory = createMemoryLedger({ now: () => 1_700_000_000_000 });
    const claimed = memory.claim({ op: 'product.save', scope: 'tenant-a', key: 'k1', hash: 'a'.repeat(64) });
    assert.strictEqual(claimed.state, 'new');
    memory.commit(claimed.ref, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"ok":true}' });
    const record = memory.lookup({ op: 'product.save', scope: 'tenant-a', key: 'k1' });
    assert.ok(record !== null);
    await ledger.insert(record);
    const stored = await ledger.get('product.save|tenant-a|k1');
    assert.deepStrictEqual(stored, record);
    const failed = memory.claim({ op: 'product.save', scope: '', key: 'k2', hash: 'b'.repeat(64) });
    memory.fail(failed.ref, true);
    await ledger.insert(memory.lookup({ op: 'product.save', scope: '', key: 'k2' }));
    assert.strictEqual((await ledger.get('product.save||k2')).status, 'failed');
    await store.close();
  });

  it('refuses a malformed record through the collection schema', async () => {
    const store = await openStore(idempotencyLedgerModel, { driver: nodeDriver(), compileSchema });
    const ledger = store.collection('ledger');
    await assert.rejects(() => ledger.insert({ id: 'x', op: 'o', scope: '', key: 'k', hash: 'nope', status: 'started', response: null, retryable: null, createdAt: 1, updatedAt: 1, expiresAt: 2 }));
    await assert.rejects(() => ledger.insert({ id: 'x', op: 'o', scope: '', key: 'k', hash: 'a'.repeat(64), status: 'pending', response: null, retryable: null, createdAt: 1, updatedAt: 1, expiresAt: 2 }));
    await store.close();
  });
});

describe('commandLifecycleFsm — a $fsm 0.1 document', () => {
  it('compiles with @jarenjs/flow and walks idle → started → committed', () => {
    assert.strictEqual(commandLifecycleFsm.$fsm, '0.1');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(commandLifecycleFsm)), commandLifecycleFsm);
    const fsm = compileFsm(commandLifecycleFsm);
    const session = createFsmSession(fsm);
    assert.strictEqual(session.state, 'idle');
    assert.strictEqual(session.send('claim').state, 'started');
    assert.strictEqual(session.send('commit').state, 'committed');
    assert.strictEqual(session.done, true);
  });

  it('re-enters started from failed only when the failure was retryable', () => {
    const fsm = compileFsm(commandLifecycleFsm);
    const session = createFsmSession(fsm);
    session.send('claim');
    assert.strictEqual(session.send('fail').state, 'failed');
    assert.strictEqual(session.send('claim', { context: { retryable: false } }).changed, false);
    assert.strictEqual(session.state, 'failed');
    assert.strictEqual(session.send('claim', { context: { retryable: true } }).state, 'started');
    // the memory ledger walks the same transitions
    const ledger = createMemoryLedger();
    const first = ledger.claim({ op: 'o', scope: '', key: 'k', hash: 'h' });
    ledger.fail(first.ref, false, { status: 409, headers: {}, body: '{}' });
    assert.strictEqual(ledger.claim({ op: 'o', scope: '', key: 'k', hash: 'h' }).state, 'replay');
    const second = ledger.claim({ op: 'o', scope: '', key: 'r', hash: 'h' });
    ledger.fail(second.ref, true);
    assert.strictEqual(ledger.claim({ op: 'o', scope: '', key: 'r', hash: 'h' }).state, 'new');
  });
});
