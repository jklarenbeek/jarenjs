//@ts-check
/**
 * @file The store's option surfaces say what they do, and its scoped
 * members and unit of work leave the state they claim.
 *
 * - `openStore` validates option VALUES before the driver opens
 *   (`JD0009`): `queueTimeout: Infinity` used to become a 1 ms wait,
 *   `capture: 'false'` and `jobs: 0` switched the feature ON, `jobs: null`
 *   threw a raw `TypeError`, and a misspelt `transactions` was refused
 *   only after the file was created and its handle opened.
 * - A transaction view's `stats()`, its collections' `stats()` and its
 *   `introspect()` answer for their own live scope or refuse `JD2070`:
 *   an escaped `tx.stats()` reported a rolled-back scope, and
 *   `tx.introspect()` queued behind its own transaction until `JD0012`.
 * - The tracker: `discard(k)` drops a pending `remove(k)`, so a removal
 *   that failed its optimistic guard no longer poisons every later save;
 *   a rollback after a shared-unit save restores what the save cleared
 *   and keeps what was staged after it; a rolled-back auto-key insert
 *   leaves no clean record behind for a row that never existed.
 * - `postgresDriver` reads a closed option set, naming the nearest member.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver, postgresNotifications } from '@jarenjs/db/postgres';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          name: { type: 'string' },
          ver: { type: 'integer', 'x-entity': { version: true } },
          labels: { 'x-entity': { relation: { to: 'Label', many: true } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
          title: { type: 'string' },
        },
      },
    },
    Label: {
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', 'x-entity': { key: true } } },
      },
    },
  },
};

/** @param {string} code */
const coded = (code) => (/** @type {any} */ error) => error?.code === code;

/** A node driver that counts how often it was asked to open. */
function countingDriver() {
  const inner = nodeDriver();
  let opens = 0;
  return {
    driver: { ...inner, open: (/** @type {any[]} */ ...args) => { opens++; return inner.open(...args); } },
    opens: () => opens,
  };
}

describe('openStore validates option values before the driver opens (JD0009)', () => {
  it('refuses each malformed value by name — no driver open, no file', async () => {
    const cases = [
      { queueTimeout: Infinity }, { queueTimeout: -1 }, { queueTimeout: 'soon' }, { queueTimeout: 2 ** 31 },
      { queueTimeout: 1.5 },
      { capture: 'false' }, { capture: 0 }, { capture: '' }, { capture: null },
      { jobs: 'false' }, { jobs: 0 }, { jobs: null },
      { transactions: 'strcit' },
      { live: true }, { replication: true }, { adopt: 'yes' }, { readOnly: 'true' },
    ];
    for (const extra of cases) {
      const [name] = Object.keys(extra);
      const { dbPath, cleanup } = tempDbPath();
      const { driver, opens } = countingDriver();
      await assert.rejects(openStore(MODEL, /** @type {any} */ ({ driver, path: dbPath, ...extra })),
        (/** @type {any} */ error) => error.code === 'JD0009' && error.message.includes(`'${name}'`),
        `${JSON.stringify(extra)} is JD0009 naming '${name}'`);
      assert.strictEqual(opens(), 0, `${JSON.stringify(extra)}: the driver never opened`);
      assert.strictEqual(fs.existsSync(dbPath), false, `${JSON.stringify(extra)}: no file was created`);
      cleanup();
    }
  });

  it('every documented value still opens', async () => {
    for (const extra of [
      { queueTimeout: 0 }, { queueTimeout: 2 ** 31 - 1 }, { capture: true }, { capture: {} }, { capture: false },
      { jobs: true }, { jobs: {} }, { jobs: false }, { live: { maxQueries: 8 }, capture: true },
      { transactions: 'strict' }, { transactions: 'wait' }, { adopt: false }, { readOnly: false },
    ]) {
      const store = await openStore(MODEL, /** @type {any} */ ({ driver: nodeDriver(), ...extra }));
      await store.close();
    }
  });
});

describe('scoped members answer for their own live scope (JD2070)', () => {
  it('an escaped tx.stats() and tx.collection(n).stats() refuse; the outer handle refuses while an inner scope is current', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    /** @type {any} */
    let escaped;
    await assert.rejects(store.transaction(async (tx) => {
      escaped = tx;
      tx.entity('User').add({ id: 'u1', name: 'ada', ver: 0 });
      await tx.saveChanges();
      throw new Error('roll back');
    }, { unitOfWork: 'own' }), /roll back/);
    assert.throws(() => escaped.stats(), coded('JD2070'));
    assert.throws(() => escaped.collection('docs').stats(), coded('JD2070'));
    await store.transaction(async (tx) => {
      assert.strictEqual(typeof tx.collection('docs').stats(), 'object');
      await tx.transaction(async (/** @type {any} */ inner) => {
        assert.throws(() => tx.stats(), coded('JD2070'), 'the outer handle while the inner scope is current');
        assert.strictEqual(typeof inner.stats(), 'object');
      });
      assert.strictEqual(typeof tx.stats(), 'object', 'current again once the inner scope settled');
    });
    // the root always answers for the root
    assert.strictEqual(typeof store.stats(), 'object');
    await store.close();
  });

  it('tx.introspect() answers on the transaction\'s own connection instead of queueing behind it', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), queueTimeout: 200 });
    const outside = await store.introspect();
    // after an await, as a real handler is: the stack no longer says the
    // call is the owner's own, so a gated member would wait for itself
    const inside = await store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'x' }, 'x');
      return tx.introspect();
    });
    assert.deepStrictEqual(inside, outside);
    await store.close();
  });
});

describe('the unit of work leaves the state it claims', () => {
  it('remove(k); discard(k); saveChanges() deletes nothing', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const users = store.entity('User');
    await users.create({ id: 'b', name: 'bea', ver: 0 });
    users.remove('b');
    users.discard('b');
    const report = await store.saveChanges();
    assert.strictEqual(report.deleted, 0);
    assert.strictEqual((await users.get('b'))?.name, 'bea');
    await store.close();
  });

  it('after a JD2040 on a guarded delete, discarding it lets an unrelated edit save', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const users = store.entity('User');
    await users.create({ id: 'c', name: 'cy', ver: 0 });
    await users.create({ id: 'd', name: 'dee', ver: 0 });
    await users.get('c');
    users.remove('c');
    // a stranger moves the row's version under the pending removal
    await store.entity('User').asNoTracking().get('c');
    await users.update('c', { name: 'changed' });
    await assert.rejects(store.saveChanges(), coded('JD2040'));
    users.discard('c');
    const d = /** @type {any} */ (await users.get('d'));
    users.put({ ...d, name: 'dee2' });
    const report = await store.saveChanges();
    assert.strictEqual(report.updated, 1);
    assert.strictEqual(report.deleted, 0);
    assert.strictEqual((await users.get('c'))?.name, 'changed', 'the discarded removal never ran');
    await store.close();
  });

  it('a rollback after a shared-unit save restores what the save cleared and keeps what was staged after it', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.entity('User').create({ id: 'e', name: 'eve', ver: 0 });
    await store.entity('User').create({ id: 'h', name: 'hal', ver: 0 });
    await store.entity('Label').create({ name: 'red' });
    store.entity('User').remove('h');   // staged BEFORE the save, which runs it
    await assert.rejects(store.transaction(async (tx) => {
      const users = tx.entity('User');
      users.add({ id: 'f', name: 'fay', ver: 0 });
      await tx.saveChanges();
      users.remove('e');
      users.link('e', 'labels', 'red');
      users.add({ id: 'g', name: 'gus', ver: 0 });
      throw new Error('roll back');
    }), /roll back/);
    const counts = /** @type {any} */ (store.stats()).tracker;
    assert.strictEqual(counts.pendingDeletes, 2, "the save's removal of 'h' is back, and the later remove('e') survived");
    assert.strictEqual(counts.pendingMemberships, 1, 'the later link survived');
    assert.strictEqual(counts.pendingInserts, 2, "'f' is pending again beside the later 'g'");
    await store.close();
  });

  it('a rolled-back auto-key insert leaves no clean record for a row that never existed', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await assert.rejects(store.transaction(async (tx) => {
      tx.entity('Post').add({ title: 'draft' });
      await tx.saveChanges();
      throw new Error('roll back');
    }), /roll back/);
    assert.deepStrictEqual(
      { tracked: /** @type {any} */ (store.stats()).tracker.tracked, pendingInserts: /** @type {any} */ (store.stats()).tracker.pendingInserts },
      { tracked: 0, pendingInserts: 1 });
    assert.strictEqual((await store.entity('Post').execute('$.Post[*]') ?? []).length ?? 0, 0);
    const report = await store.saveChanges();
    assert.strictEqual(report.inserted, 1, 'the retry inserts it once');
    await store.close();
  });
});

describe('the PostgreSQL driver reads a closed option set', () => {
  it('a misspelt option is refused, naming the nearest one', () => {
    const source = { connect: async () => ({ query: async () => ({ rows: [] }) }) };
    assert.throws(() => postgresDriver(source, /** @type {any} */ ({ statmentTimeoutMs: 1 })),
      (/** @type {any} */ error) => error.code === 'JD0003' && /'statmentTimeoutMs'/.test(error.message)
        && /did you mean 'statementTimeoutMs'\?/.test(error.message));
    assert.throws(() => postgresNotifications(source, /** @type {any} */ ({ channel: 'wake', maxReconnect: 2 })),
      (/** @type {any} */ error) => error.code === 'JD0003' && /did you mean 'maxReconnects'\?/.test(error.message));
    // every documented option still constructs
    const driver = postgresDriver(source, { statementTimeoutMs: 1000, lockTimeoutMs: 100, schema: 'app', cursorMode: 'buffered' });
    assert.strictEqual(driver.name, 'postgres');
  });
});
