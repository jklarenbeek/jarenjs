//@ts-check
/**
 * @file The client's handle records build each handle on its first read:
 * the same names in the same order, frozen, a handle the same object on
 * every read, the inverse members of one many-to-many edge sharing one
 * join handle — and one getter per name for the whole module, so every
 * record over the same names, every client's and every transaction's,
 * keeps one hidden class with fast properties. A schema the compiler
 * refuses is still refused at open, and the store is closed then; a
 * handle read after its transaction or its store ended refuses its calls
 * as before (`JD2070`, `JD2063`). A model prepared once (`prepareModel`)
 * opens clients that answer as clients of the document do.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { prepareModel } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const User = m.object({ id: m.string().key(), name: m.string(), labels: m.rel.belongsToMany('Label') });
const Label = m.object({ name: m.string().key(), users: m.rel.belongsToMany('User') });
const NOTE = { key: '/id', schema: { type: 'object', required: ['id'],
  properties: { id: { type: 'string' }, rank: { type: 'integer' } } } };
const model = {
  ...m.defineModel({ entities: { User, Label } }),
  collections: { notes: NOTE, later: NOTE, logs: { identity: 'integer', schema: { type: 'object' } } },
};

/** A driver whose connections count their closes. @param {{ closed: number }} counter */
function countingDriver(counter) {
  const base = nodeDriver();
  return {
    ...base,
    open: async (/** @type {any[]} */ ...args) => {
      const connection = await base.open(...args);
      return { ...connection, close: () => { counter.closed++; return connection.close(); } };
    },
  };
}

describe('lazy handle records', () => {
  it('keep the names, their order and the frozen record; a handle is one object on every read', async () => {
    const client = await open(model, { driver: nodeDriver() });
    try {
      assert.deepStrictEqual(Object.keys(client.entities), ['User', 'Label']);
      assert.deepStrictEqual(Object.keys(client.collections), ['notes', 'later', 'logs']);
      assert.ok(Object.isFrozen(client.entities) && Object.isFrozen(client.collections));
      assert.strictEqual(client.collections.notes, client.collections.notes);
      assert.strictEqual(client.entities.User, client.entities.User);
      assert.strictEqual(client.collections.missing, undefined);
      assert.ok(!('missing' in client.collections));
      // the inverse members of one edge name one join handle
      assert.strictEqual(client.entities.User.memberships.labels, client.entities.Label.memberships.users);
      await client.transaction(async (/** @type {any} */ tx) => {
        assert.deepStrictEqual(Object.keys(tx.entities), Object.keys(client.entities));
        assert.deepStrictEqual(Object.keys(tx.collections), Object.keys(client.collections));
        assert.strictEqual(tx.collections.notes, tx.collections.notes);
        assert.notStrictEqual(tx.collections.notes, client.collections.notes);
        assert.strictEqual(tx.entities.User.memberships.labels, tx.entities.Label.memberships.users);
        assert.strictEqual(tx.sql, tx.sql);
        assert.strictEqual(tx.relational, tx.relational);
        assert.strictEqual(tx.savepoints, tx.store.savepoints);
        await tx.collections.notes.put({ id: 'in', rank: 1 });
      });
      assert.deepStrictEqual(await client.collections.notes.toArray(), [{ id: 'in', rank: 1 }]);
      // enumeration builds every handle, as the eager record held them
      assert.deepStrictEqual(Object.entries(client.collections).map(([name, handle]) => [name, typeof handle.put]),
        [['notes', 'function'], ['later', 'function'], ['logs', 'function']]);
    }
    finally { await client.close(); }
  });

  it('share one getter per name across clients and transactions', async () => {
    const a = await open(model, { driver: nodeDriver() });
    const b = await open(model, { driver: nodeDriver() });
    try {
      /** @param {any} record @param {string} name */
      const getter = (record, name) => Object.getOwnPropertyDescriptor(record, name)?.get;
      assert.strictEqual(typeof getter(a.collections, 'notes'), 'function');
      assert.strictEqual(getter(a.collections, 'notes'), getter(b.collections, 'notes'));
      assert.strictEqual(getter(a.entities, 'User'), getter(b.entities, 'User'));
      await a.transaction(async (/** @type {any} */ tx) => {
        assert.strictEqual(getter(tx.collections, 'notes'), getter(b.collections, 'notes'));
        assert.strictEqual(getter(tx, 'sql'), getter(tx, 'sql'));
      });
    }
    finally { await a.close(); await b.close(); }
  });

  it('keep one hidden class with fast properties for every client and transaction', () => {
    const script = `
      import { open } from '@jarenjs/linq/db';
      import { nodeDriver } from '@jarenjs/db/node';
      const NOTE = { key: '/id', schema: { type: 'object' } };
      const model = { $model: '0.1', collections: Object.fromEntries(Array.from({ length: 64 }, (_, i) => ['c' + i, NOTE])) };
      const a = await open(model, { driver: nodeDriver() }), b = await open(model, { driver: nodeDriver() });
      a.collections.c3; b.collections.c9;
      const txs = [];
      await a.transaction(async (tx) => { txs.push(tx); tx.collections.c1; tx.sql; });
      await b.transaction(async (tx) => { txs.push(tx); });
      console.log(JSON.stringify([%HaveSameMap(a, b), %HaveSameMap(a.collections, b.collections),
        %HasFastProperties(a.collections), %HaveSameMap(txs[0], txs[1]),
        %HaveSameMap(txs[0].collections, txs[1].collections), %HaveSameMap(txs[0].collections, a.collections),
        %HasFastProperties(txs[0].collections), %HasFastProperties(txs[0])]));
      await a.close(); await b.close();`;
    const run = spawnSync(process.execPath, ['--allow-natives-syntax', '--input-type=module', '-e', script],
      { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(JSON.parse(run.stdout), [true, true, true, true, true, true, true, true]);
  });

  it('cost a client about what its store costs until a handle is read (live set, 8 of each)', () => {
    const script = `
      import { openStore } from '@jarenjs/db';
      import { open } from '@jarenjs/linq/db';
      import { nodeDriver } from '@jarenjs/db/node';
      const NOTE = { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, a: { type: 'string' } } },
        indexes: [{ name: 'by_a', path: ['$.a'] }] };
      const model = { $model: '0.1', collections: Object.fromEntries(Array.from({ length: 64 }, (_, i) => ['c' + i, NOTE])) };
      const check = () => true, compileSchema = () => check;
      const live = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
      const growth = async (openOne) => {
        await (await openOne()).close();
        const before = live(), opened = [];
        for (let i = 0; i < 8; i++) opened.push(await openOne());
        const after = live();
        for (const one of opened) await one.close();
        return after - before;
      };
      const options = () => ({ driver: nodeDriver(), compileSchema });
      const store = await growth(() => openStore(model, options()));
      const client = await growth(() => open(model, options()));
      console.log(JSON.stringify({ store, client }));`;
    const run = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script],
      { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    assert.strictEqual(run.status, 0, run.stderr);
    const { store, client } = JSON.parse(run.stdout);
    // every handle built at open made a client cost several stores
    assert.ok(client < store * 1.6, `8 clients grew the live set by ${client} bytes, 8 stores by ${store}`);
  });

  it('cost a transaction whose body reads no handle the same at 32 and 256 names (an 8x step)', async () => {
    const LOG = { identity: 'integer', schema: { type: 'object' } };
    /** The best per-transaction time of rounds of empty transactions. @param {number} names */
    const perTransaction = async (names) => {
      const client = await open({ $model: '0.1',
        collections: Object.fromEntries(Array.from({ length: names }, (_, i) => [`c${i}`, LOG])) },
      { driver: nodeDriver(), validator: null });
      try {
        const body = async () => {};
        for (let i = 0; i < 1000; i++) await client.transaction(body);
        let best = Infinity;
        for (let round = 0; round < 5; round++) {
          const started = performance.now();
          for (let i = 0; i < 1000; i++) await client.transaction(body);
          best = Math.min(best, performance.now() - started);
        }
        return best;
      }
      finally { await client.close(); }
    };
    const small = await perTransaction(32);
    const large = await perTransaction(256);
    // both records built per transaction made the large model's cost several times the small one's
    assert.ok(large < small * 2, `1000 transactions took ${large} ms at 256 names, ${small} ms at 32`);
  });

  it('refuse at open a schema the compiler refuses, and close the store they opened', async () => {
    const isNote = (/** @type {any} */ schema) => JSON.stringify(schema).includes('"rank"');
    const cases = /** @type {[string, (schema: any) => any, RegExp][]} */ ([
      ['an entity schema', (schema) => { if (!isNote(schema)) throw new Error('entity refused'); return () => true; }, /entity refused/],
      ['a collection schema', (schema) => { if (isNote(schema)) throw new Error('collection refused'); return () => true; }, /collection refused/],
      ['a result that is no validation function', () => 42, /compileSchema must return a validation function/],
    ]);
    for (const [, compileSchema, message] of cases) {
      const counter = { closed: 0 };
      await assert.rejects(open(model, { driver: countingDriver(counter), compileSchema }), { message });
      assert.strictEqual(counter.closed, 1);
    }
    // a validator the client wires is read the same way
    const refusing = { compile: () => { throw new Error('validator refused'); } };
    await assert.rejects(open(model, { driver: nodeDriver(), validator: /** @type {any} */ (refusing) }), /validator refused/);
  });

  it('compile each declared schema once per open, and hand it to the store on first use', async () => {
    /** @type {any[]} */
    const compiled = [];
    const client = await open(model, { driver: nodeDriver(),
      compileSchema: (/** @type {any} */ schema) => { compiled.push(schema); return () => true; } });
    try {
      const atOpen = compiled.length;
      // two entities and the two distinct collection schemas
      assert.strictEqual(atOpen, 4);
      await client.collections.notes.put({ id: 'a' });
      await client.collections.later.put({ id: 'b' });
      await client.collections.logs.insert({});
      assert.strictEqual(compiled.length, atOpen);
    }
    finally { await client.close(); }
  });

  it('refuse the calls of a handle first read after its transaction or store ended', async () => {
    const client = await open(model, { driver: nodeDriver() });
    /** @type {any} */
    let kept;
    await client.transaction(async (/** @type {any} */ tx) => { kept = tx; });
    assert.strictEqual(typeof kept.collections.notes, 'object');
    await assert.rejects(async () => kept.collections.notes.get('x'), { code: 'JD2070' });
    await assert.rejects(async () => kept.entities.User.get('x'), { code: 'JD2070' });
    await client.close();
    assert.strictEqual(typeof client.collections.later, 'object');
    await assert.rejects(async () => client.collections.later.get('x'), { code: 'JD2063' });
    await assert.rejects(async () => client.entities.Label.get('x'), { code: 'JD2063' });
  });

  it('open from a prepared model, as from the document, beside clients of the document', async () => {
    const prepared = prepareModel(model);
    const clients = [];
    for (let i = 0; i < 4; i++) clients.push(await open(i % 2 === 0 ? prepared : model, { driver: nodeDriver() }));
    try {
      for (const [i, client] of clients.entries()) {
        assert.deepStrictEqual(Object.keys(client.collections), ['notes', 'later', 'logs']);
        assert.deepStrictEqual(Object.keys(client.entities), ['User', 'Label']);
        await client.collections.notes.put({ id: `n${i}`, rank: i });
        await client.transaction(async (/** @type {any} */ tx) => {
          await tx.store.entity('User').create({ id: `u${i}`, name: 'Ada' });
          await tx.store.entity('Label').create({ name: 'admin' });
        });
        client.entities.User.link(`u${i}`, 'labels', 'admin');
        await client.saveChanges();
      }
      const answers = await Promise.all(clients.map(async (client) => [
        await client.collections.notes.select((/** @type {any} */ n) => n.rank).toArray(),
        await client.entities.User.memberships.labels.select((/** @type {any} */ j) => j.Label_key).toArray()]));
      assert.deepStrictEqual(answers, [[[0], ['admin']], [[1], ['admin']], [[2], ['admin']], [[3], ['admin']]]);
      // a schema the validator refuses is refused at open from a prepared model too
      await assert.rejects(open(prepared, { driver: nodeDriver(), compileSchema: () => { throw new Error('refused'); } }), /refused/);
    }
    finally { for (const client of clients) await client.close(); }
  });
});
