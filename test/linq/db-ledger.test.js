//@ts-check
/**
 * @file `createDbLedger` (DB-CLIENT.md §2.6): the contract ledger over a
 * declared collection through the client's own surface. The shared
 * ledger contract runs over a real store; construction refuses by name;
 * a root claim takes the write lock up front and a transaction-client
 * ledger nests in the transaction it was handed; two processes released
 * on one absent file see exactly one `new`; a reopened process replays
 * the stored response and honours the persisted generation fence; a
 * domain write and a settlement inside one transaction commit together
 * or not at all; a legacy-spelled record is matched by no claim; and
 * the module imports neither the contract package nor a driver.
 */
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { open, createDbLedger } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { idempotencyLedgerModel } from '@jarenjs/contract/ledger';
import { ledgerContract, CLAIM, RESPONSE } from '../contract/ledger-contract.js';
import { tempDbPath } from '../db/helpers.js';

/** The ledger model plus one domain collection, for the atomicity proof. */
const MODEL = {
  $model: '0.1',
  collections: {
    ...idempotencyLedgerModel.collections,
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
};

/** @type {(() => any)[]} */
const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** @param {any} [options] */
async function memoryClient(options = {}) {
  const client = await open(idempotencyLedgerModel, { driver: nodeDriver(), validator: null, ...options });
  cleanups.push(() => client.close());
  return client;
}

ledgerContract('createDbLedger over a linq client (node driver, in memory)', async (options) => {
  const client = await open(idempotencyLedgerModel, { driver: nodeDriver(), validator: null });
  return { ledger: createDbLedger(client, options), staleCode: 'JL2007', close: () => client.close() };
});

describe('createDbLedger — construction', () => {
  it('refuses by name: not a client, an undeclared collection, a bad ttl, a bad clock', async () => {
    const client = await memoryClient();
    assert.throws(() => createDbLedger(/** @type {any} */ (null)), /must be a @jarenjs\/linq\/db client/);
    assert.throws(() => createDbLedger(/** @type {any} */ ({ collections: {} })), /must be a @jarenjs\/linq\/db client/);
    assert.throws(() => createDbLedger(client, { collection: 'nope' }), /declares no collection 'nope'/);
    assert.throws(() => createDbLedger(client, { collection: '' }), /non-empty collection name/);
    assert.throws(() => createDbLedger(client, { ttlMs: 0 }), /ttlMs must be a positive number/);
    assert.throws(() => createDbLedger(client, { now: /** @type {any} */ ('soon') }), /now must be a function/);
    assert.ok(Object.isFrozen(createDbLedger(client)));
  });

  it('the default collection is the model\'s `ledger`; a named collection is honoured', async () => {
    const client = await open({
      $model: '0.1',
      collections: { keys: idempotencyLedgerModel.collections.ledger },
    }, { driver: nodeDriver(), validator: null });
    cleanups.push(() => client.close());
    assert.throws(() => createDbLedger(client), /declares no collection 'ledger'/);
    const ledger = createDbLedger(client, { collection: 'keys' });
    const claimed = await ledger.claim({ ...CLAIM, now: 1000 });
    assert.strictEqual(claimed.state, 'new');
    assert.strictEqual((await client.collections.keys.get(claimed.ref.id))?.status, 'started');
  });

  it('the module imports neither the contract package nor a driver builtin, and no store', () => {
    const source = fs.readFileSync(new URL('../../packages/linq/src/db/ledger.js', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(imports, ['@jarenjs/core/runtime', '../errors.js']);
  });
});

describe('createDbLedger — the transaction it runs in', () => {
  /**
   * A client whose `transaction` records the options it was asked for —
   * the ledger is structural, so the spy IS a client to it.
   * @param {any} target
   */
  function spied(target) {
    /** @type {any[]} */
    const calls = [];
    const spy = { ...target, transaction: (/** @type {any} */ fn, /** @type {any} */ opts) => { calls.push(opts); return target.transaction(fn, opts); } };
    return { spy, calls };
  }

  it('a root client\'s claim, settlement, lookup and sweep each run in one transaction that takes the write lock up front', async () => {
    const client = await memoryClient();
    const { spy, calls } = spied(client);
    const ledger = createDbLedger(spy, { now: () => 1000 });
    const claimed = await ledger.claim(CLAIM);
    await ledger.commit(claimed.ref, RESPONSE);
    await ledger.lookup(CLAIM);
    await ledger.sweep();
    assert.deepStrictEqual(calls, [{ mode: 'immediate' }, { mode: 'immediate' }, { mode: 'immediate' }, { mode: 'immediate' }]);
  });

  it('a transaction-client ledger nests in the transaction it was handed and asks for no mode of its own', async () => {
    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    cleanups.push(() => client.close());
    /** @type {any[]} */
    let calls = [];
    await client.transaction(async (tx) => {
      const inner = spied(tx);
      calls = inner.calls;
      const ledger = createDbLedger(inner.spy, { now: () => 1000 });
      const claimed = await ledger.claim(CLAIM);
      assert.strictEqual(claimed.state, 'new');
      await ledger.commit(claimed.ref, RESPONSE);
    });
    assert.deepStrictEqual(calls, [undefined, undefined], 'a nested transaction is the host\'s savepoint');
    assert.deepStrictEqual(await createDbLedger(client).claim({ ...CLAIM, now: 1001 }), { state: 'replay', response: RESPONSE });
  });
});

describe('createDbLedger — durability and the fence across processes', () => {
  /** One child: open the store on `dbPath`, claim `key` with `hash`, print the state. */
  const CHILD = `
    import { open, createDbLedger } from '@jarenjs/linq/db';
    import { nodeDriver } from '@jarenjs/db/node';
    import { idempotencyLedgerModel } from '@jarenjs/contract/ledger';
    const [dbPath, who, key, hash] = process.argv.slice(1);
    const client = await open(idempotencyLedgerModel, { driver: nodeDriver(), path: dbPath, busyTimeout: 5000, validator: null });
    const ledger = createDbLedger(client, { now: () => 1000 });
    const claimed = await ledger.claim({ op: 'product.save', scope: '', key, hash });
    await client.close();
    process.stdout.write(who + ' ' + claimed.state + '\\n');
  `;

  /** @param {string[][]} argv */
  function release(argv) {
    const children = argv.map((args) => spawn(process.execPath,
      ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', CHILD, ...args],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }));
    return Promise.all(children.map((child) => new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    })));
  }

  it('two processes released on one absent file claim one key: exactly one new, the other in-progress; a third hash is a mismatch', async () => {
    const rounds = 6;
    for (let round = 0; round < rounds; round++) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        const hash = 'a'.repeat(64);
        const outcomes = await release([[dbPath, 'p0', 'k', hash], [dbPath, 'p1', 'k', hash]]);
        for (const outcome of outcomes) {
          assert.strictEqual(outcome.status, 0, `round ${round}: ${outcome.stderr.slice(0, 400)}`);
          assert.doesNotMatch(outcome.stderr, /database is locked/);
        }
        const states = outcomes.map((o) => o.stdout.trim().split(' ')[1]).sort();
        assert.deepStrictEqual(states, ['in-progress', 'new'], `round ${round}`);
        const [other] = await release([[dbPath, 'p2', 'k', 'b'.repeat(64)]]);
        assert.strictEqual(other.stdout.trim(), 'p2 mismatch');
      }
      finally {
        cleanup();
      }
    }
  });

  it('a reopened process replays the stored response without a handler; an old ref cannot settle a reclaimed key, before or after reopen', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      let at = 1000;
      const first = await open(idempotencyLedgerModel, { driver: nodeDriver(), path: dbPath, validator: null });
      const ledger = createDbLedger(first, { ttlMs: 50, now: () => at });
      const a = await ledger.claim(CLAIM);
      await ledger.commit(a.ref, RESPONSE);
      const stale = await ledger.claim({ ...CLAIM, key: 'k2' });
      await first.close();

      const second = await open(idempotencyLedgerModel, { driver: nodeDriver(), path: dbPath, validator: null });
      const reopened = createDbLedger(second, { ttlMs: 50, now: () => at });
      assert.deepStrictEqual(await reopened.claim(CLAIM), { state: 'replay', response: RESPONSE }, 'the restart replays');
      // k2 expires; a fresh claim mints a new generation the old ref cannot touch
      at = 1100;
      const fresh = await reopened.claim({ ...CLAIM, key: 'k2' });
      assert.strictEqual(fresh.state, 'new');
      assert.notStrictEqual(fresh.ref.generation, stale.ref.generation);
      await assert.rejects(reopened.commit(stale.ref, RESPONSE), (/** @type {any} */ err) => err.code === 'JL2007');
      await assert.rejects(reopened.fail(stale.ref, true), (/** @type {any} */ err) => err.code === 'JL2007');
      const record = await reopened.lookup({ ...CLAIM, key: 'k2' });
      assert.strictEqual(record?.generation, fresh.ref.generation);
      assert.strictEqual(record?.status, 'started');
      await second.close();

      const third = await open(idempotencyLedgerModel, { driver: nodeDriver(), path: dbPath, validator: null });
      const again = createDbLedger(third, { ttlMs: 50, now: () => at });
      await assert.rejects(again.commit(stale.ref, RESPONSE), (/** @type {any} */ err) => err.code === 'JL2007', 'the fence is the persisted generation');
      await again.commit(fresh.ref, RESPONSE);
      assert.deepStrictEqual(await again.claim({ ...CLAIM, key: 'k2' }), { state: 'replay', response: RESPONSE });
      await third.close();
    }
    finally {
      cleanup();
    }
  });

  it('a record under the legacy "<op>|<scope>|<key>" spelling is matched by no claim and expires by its own clock', async () => {
    const client = await memoryClient();
    const legacy = {
      id: `${CLAIM.op}|${CLAIM.scope}|${CLAIM.key}`, generation: 'legacy', op: CLAIM.op, scope: CLAIM.scope, key: CLAIM.key, hash: CLAIM.hash,
      status: 'committed', response: RESPONSE, retryable: null, createdAt: 1, updatedAt: 1, expiresAt: 500,
    };
    await client.collections.ledger.insert(legacy);
    const ledger = createDbLedger(client, { now: () => 400 });
    const claimed = await ledger.claim(CLAIM);
    assert.strictEqual(claimed.state, 'new', 'the legacy record is not this key');
    assert.strictEqual(await ledger.sweep(600), 1, 'the legacy record expires by its expiresAt');
    assert.strictEqual(await client.collections.ledger.get(legacy.id), undefined);
    assert.strictEqual((await ledger.lookup(CLAIM))?.status, 'started');
  });
});

describe('createDbLedger — atomicity with a domain write', () => {
  it('a domain write and a settlement in one transaction commit together; a throw after either half leaves neither', async () => {
    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    cleanups.push(() => client.close());
    const root = createDbLedger(client, { now: () => 1000 });
    const claimed = await root.claim(CLAIM);

    // the throw after the domain write: nothing lands
    await assert.rejects(client.transaction(async (tx) => {
      await tx.collections.notes.insert({ id: 'n1', text: 'first' });
      throw new Error('after the domain write');
    }), /after the domain write/);
    assert.strictEqual(await client.collections.notes.get('n1'), undefined);
    assert.strictEqual((await root.lookup(CLAIM))?.status, 'started');

    // the throw after the settlement: the note and the settlement both roll back
    await assert.rejects(client.transaction(async (tx) => {
      await tx.collections.notes.insert({ id: 'n1', text: 'first' });
      await createDbLedger(tx, { now: () => 1001 }).commit(claimed.ref, RESPONSE);
      throw new Error('after the settlement');
    }), /after the settlement/);
    assert.strictEqual(await client.collections.notes.get('n1'), undefined);
    assert.strictEqual((await root.lookup(CLAIM))?.status, 'started', 'the settlement rolled back with the note');

    // a stale settlement inside the transaction rejects it whole
    const stale = { id: claimed.ref.id, generation: 'not-this-one' };
    await assert.rejects(client.transaction(async (tx) => {
      await tx.collections.notes.insert({ id: 'n1', text: 'first' });
      await createDbLedger(tx, { now: () => 1001 }).commit(stale, RESPONSE);
    }), (/** @type {any} */ err) => err.code === 'JL2007');
    assert.strictEqual(await client.collections.notes.get('n1'), undefined);

    // the whole: both visible after the commit
    await client.transaction(async (tx) => {
      await tx.collections.notes.insert({ id: 'n1', text: 'first' });
      await createDbLedger(tx, { now: () => 1001 }).commit(claimed.ref, RESPONSE);
    });
    assert.strictEqual((await client.collections.notes.get('n1'))?.text, 'first');
    assert.deepStrictEqual(await root.claim({ ...CLAIM, now: 1002 }), { state: 'replay', response: RESPONSE });
  });
});
