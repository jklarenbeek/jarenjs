//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore, normalizeReplication, encodeReplication, replicationIdentity } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { replicationModel, replicaState, deliverySchedule, liveOracle } from './oracle/replication.js';
import { tempDbPath } from './helpers.js';

const open = (replica, config = {}, options = {}) => openStore(replicationModel,
  { driver: nodeDriver(), ...options, replication: { replica, ...config } });
const allNotes = [{ $for: { n: '$[*]' }, $orderby: '$n.id', $return: '$n' }];

for (const mode of ['session', 'journal']) it(`${mode}: envelopes replicate documents, entities and relation changes without echoes`, async () => {
  const a = await open('a', {}, { capture: { mode } });
  const b = await open('b', {}, { capture: { mode } });
  try {
    const live = await b.collection('notes').live(allNotes);
    const oracle = liveOracle(live, () => b.collection('notes').execute(allNotes));
    let next = 0;
    const deliver = async () => {
      const page = await a.replication.page({ after: next });
      for (const envelope of page.items) {
        assert.equal((await b.replication.apply(envelope)).status, 'applied');
        const count = oracle.emissions;
        assert.equal((await b.replication.apply(envelope)).status, 'duplicate');
        assert.equal(oracle.emissions, count);
        await oracle.check();
      }
      next = page.next;
      assert.deepEqual(await replicaState(a), await replicaState(b));
      assert.equal((await b.replication.page()).items.length, 0);
    };
    await a.transaction(async (tx) => {
      await tx.collection('notes').put({ id: 'a/~😀', n: 1 });
      await tx.entity('Tag').create({ id: 'tag' });
      await tx.entity('Parent').create({ id: 'p', name: 'first', tags: ['tag'] });
    });
    await deliver();
    await a.entity('Parent').update('p', { name: 'second' });
    await a.collection('notes').put({ id: 'a/~😀', n: 3 });
    await deliver();
    await a.entity('Parent').delete('p');
    await a.collection('notes').delete('a/~😀');
    await deliver();
    oracle.close();
  }
  finally { await a.close(); await b.close(); }
});

it('duplicate, reordered and dropped deliveries have stable refusal codes and converge on retry', async () => {
  const a = await open('a'); const b = await open('b');
  try {
    for (let n = 0; n < 12; n++) await a.collection('notes').put({ id: 'a', n });
    const envelopes = (await a.replication.page()).items;
    for (const envelope of deliverySchedule(envelopes, { seed: 31, drop: [3] })) {
      const before = await replicaState(b);
      try { await b.replication.apply(envelope); }
      catch (error) { assert.equal(error.code, 'JD2100'); assert.deepEqual(await replicaState(b), before); }
    }
    for (const envelope of envelopes) await b.replication.apply(envelope);
    assert.deepEqual(await replicaState(a), await replicaState(b));
    await assert.rejects(b.replication.apply({ ...envelopes[0], model: 'other' }), { code: 'JD2102' });
    const different = structuredClone(envelopes[0]); different.operations[0].after.n = 100;
    await assert.rejects(b.replication.apply(different), { code: 'JD2101' });
    assert.deepEqual(await b.replication.frontier(), { a: 12 });
  }
  finally { await a.close(); await b.close(); }
});

it('default conflicts preserve both contenders and do not acknowledge or overwrite data', async () => {
  const a = await open('a'); const b = await open('b');
  try {
    await a.collection('notes').put({ id: 'shared', n: 0 });
    await b.replication.apply((await a.replication.page()).items[0]);
    await a.collection('notes').put({ id: 'shared', n: 1 });
    await b.collection('notes').put({ id: 'shared', n: 2 });
    const result = await b.replication.apply((await a.replication.page({ after: 1 })).items[0]);
    assert.equal(result.status, 'conflict');
    assert.equal((await b.collection('notes').get('shared')).n, 2);
    assert.deepEqual(await b.replication.frontier(), { a: 1, b: 1 });
    const evidence = (await b.replication.conflicts())[0];
    assert.equal(evidence.base.n, 0); assert.equal(evidence.local.value.n, 2);
    assert.equal(evidence.remote.value.n, 1); assert.equal(evidence.resolver, null);
  }
  finally { await a.close(); await b.close(); }
});

it('pure resolution is recorded, durable and replayed exactly once after reopen', async () => {
  const temp = tempDbPath();
  const path = temp.dbPath;
  const a = await open('a'); let b;
  const resolver = { id: 'max-n-v1', resolve: (c) => ({ action: 'merged', value: { ...c.local.value, n: Math.max(c.local.value.n, c.remote.value.n) } }) };
  try {
    b = await open('b', { resolver }, { path });
    await a.collection('notes').put({ id: 'x', n: 0 });
    await b.replication.apply((await a.replication.page()).items[0]);
    await b.collection('notes').put({ id: 'x', n: 1 });
    await a.collection('notes').put({ id: 'x', n: 3 });
    const envelope = (await a.replication.page({ after: 1 })).items[0];
    assert.equal((await b.replication.apply(envelope)).status, 'applied');
    assert.equal((await b.collection('notes').get('x')).n, 3);
    await b.close();
    b = await open('b', { resolver }, { path });
    assert.equal((await b.replication.apply(envelope)).status, 'duplicate');
    assert.equal((await b.replication.conflicts())[0].resolver, resolver.id);
    assert.equal((await b.replication.conflicts())[0].resolution.value.n, 3);
  }
  finally { await a.close(); await b?.close(); temp.cleanup(); }
});

it('retention, byte credits, operation bounds and cancellation refuse without acknowledgement', async () => {
  const a = await open('a', { retention: 2 }); const b = await open('b', { maxOperations: 1 });
  try {
    for (let n = 0; n < 3; n++) await a.collection('notes').put({ id: 'x', n });
    assert.equal((await a.replication.page()).resetRequired, true);
    await assert.rejects(a.replication.page({ after: 1, maxBytes: 1 }), { code: 'JD2074' });
    assert.equal((await a.replication.page({ after: 1, limit: 1 })).hasMore, true);
    await assert.rejects(a.replication.page({ after: 1, signal: AbortSignal.abort() }), { code: 'JD2064' });
    await assert.rejects(b.transaction(async (tx) => {
      await tx.collection('notes').put({ id: 'one' });
      await tx.collection('notes').put({ id: 'two' });
    }), { code: 'JD2106' });
    assert.deepEqual(await b.replication.frontier(), {});
    assert.deepEqual((await replicaState(b)).notes, {});
    await b.collection('notes').put({ id: 'ok' });
    assert.deepEqual(await b.replication.frontier(), { b: 1 });
  }
  finally { await a.close(); await b.close(); }
});

it('canonical encoding detaches input and keeps hostile replica identities unambiguous', () => {
  assert.notEqual(replicationIdentity('a:1', 2), replicationIdentity('a', 12));
  const document = { $replication: '0.1', replica: 'a', seq: 1, model: 'm', frontier: {},
    operations: [{ table: 'notes', key: '__proto__', before: null, after: { id: '__proto__', n: 1 } }] };
  const normalized = normalizeReplication(document);
  assert.equal(encodeReplication(normalized), encodeReplication(document));
  document.operations[0].after.n = 2;
  assert.equal(normalized.operations[0].after.n, 1);
  for (const wrong of [{ ...document, extra: true }, { ...document, seq: 2 },
    { ...document, $replication: '0.2' }, { ...document, operations: [...document.operations, ...document.operations] }])
    assert.throws(() => normalizeReplication(wrong), { code: 'JD0060' });
});

it('snapshot reset reconnects after retention loss and cannot discard acknowledged writes', async () => {
  const a = await open('a', { retention: 1 }); const b = await open('b');
  try {
    await a.collection('notes').put({ id: 'first', n: 1 });
    await b.replication.apply((await a.replication.page()).items[0]);
    await a.collection('notes').put({ id: 'next', n: 2 });
    await a.collection('notes').delete('first');
    assert.equal((await a.replication.page({ after: 1 })).resetRequired, true);
    const live = await b.collection('notes').live(allNotes);
    const oracle = liveOracle(live, () => b.collection('notes').execute(allNotes));
    const snapshot = await a.replication.snapshot();
    assert.equal((await b.replication.reset(snapshot)).status, 'reset');
    await oracle.check();
    assert.deepEqual(await replicaState(a), await replicaState(b));
    assert.equal((await b.replication.apply(snapshot.receipts[0])).status, 'duplicate');
    await b.collection('notes').put({ id: 'local' });
    await assert.rejects(b.replication.reset(snapshot), { code: 'JD2105' });
    assert.ok(await b.collection('notes').get('local'));
    oracle.close();
  }
  finally { await a.close(); await b.close(); }
});

it('hostile replica ids never read inherited frontier members', async () => {
  const a = await open('__proto__'); const b = await open('constructor');
  try {
    await a.collection('notes').put({ id: '__proto__', n: 1 });
    const envelope = (await a.replication.page()).items[0];
    assert.equal((await b.replication.apply(envelope)).status, 'applied');
    await b.collection('notes').put({ id: 'toString', n: 2 });
    await a.replication.apply((await b.replication.page()).items[0]);
    assert.deepEqual(await replicaState(a), await replicaState(b));
    assert.deepEqual(Object.keys(await b.replication.frontier()), ['__proto__', 'constructor']);
  }
  finally { await a.close(); await b.close(); }
});

it('causal dependencies, identity claims and failed resolvers cannot acknowledge partial effects', async () => {
  const a = await open('a'); const b = await open('b'); const c = await open('c');
  try {
    await a.collection('notes').put({ id: 'x', n: 0 });
    const first = (await a.replication.page()).items[0];
    await b.replication.apply(first);
    await b.collection('notes').put({ id: 'own', n: 1 });
    const dependent = (await b.replication.page()).items[0];
    await assert.rejects(c.replication.apply(dependent), { code: 'JD2100' });
    assert.deepEqual(await c.replication.frontier(), {});
    await c.replication.apply(first); await c.replication.apply(dependent);
    await a.replication.apply(dependent);
    assert.deepEqual(await replicaState(a), await replicaState(c));
    await a.collection('notes').put({ id: 'x', n: 2 });
    await b.collection('notes').put({ id: 'x', n: 3 });
    const contender = (await a.replication.page({ after: 1 })).items[0];
    assert.equal((await b.replication.apply(contender)).status, 'conflict');
    const changed = structuredClone(contender); changed.operations[0].after.n = 99;
    await assert.rejects(b.replication.apply(changed), { code: 'JD2101' });
  }
  finally { await a.close(); await b.close(); await c.close(); }
});

for (const resolve of [() => { throw new Error('failed'); }, () => ({ action: 'unknown' }),
  () => Promise.reject(new Error('async resolver'))]) it('invalid resolver decisions roll back and close no live result', async () => {
  const a = await open('a'); const b = await open('b', { resolver: { id: 'invalid', resolve } });
  try {
    await a.collection('notes').put({ id: 'x', n: 1 });
    await b.collection('notes').put({ id: 'x', n: 2 });
    const frontier = await b.replication.frontier();
    await assert.rejects(b.replication.apply((await a.replication.page()).items[0]), { code: 'JD2103' });
    assert.deepEqual(await b.replication.frontier(), frontier);
    assert.equal((await b.collection('notes').get('x')).n, 2);
  }
  finally { await a.close(); await b.close(); }
});

it('invalid identities, credits, internal names and document values refuse before mutation', async () => {
  for (const config of [{ replica: '' }, { maxOperations: 0 }, { maxBytes: -1 }, { retention: 1.5 }, { resolver: {} }])
    await assert.rejects(open('a', config));
  await assert.rejects(open('a', {}, { capture: false }));
  await assert.rejects(openStore({ $model: '0.1', collections: {
    _JAREN_REPLICA: { key: '/id', schema: { type: 'object' } },
  } }, { driver: nodeDriver(), replication: { replica: 'a' } }), { code: 'JD0060' });
  const base = { $replication: '0.1', replica: 'a', seq: 1, frontier: {}, model: 'm',
    operations: [{ table: 'notes', key: 'x', before: null, after: {} }] };
  for (const value of [NaN, Infinity, undefined, 1n, new Date(), () => {}, { get bad() { return 1; } },
    Object.assign([], { extra: true }), Array(1), Object.defineProperty([], '0', { get: () => 1, enumerable: true })]) {
    assert.throws(() => normalizeReplication({ ...base, operations: [{ ...base.operations[0], after: { value } }] }), { code: 'JD0060' });
  }
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => normalizeReplication({ ...base, operations: [{ ...base.operations[0], after: cycle }] }), { code: 'JD0060' });
});

for (const mode of ['session', 'journal']) it(`${mode}: undeclared membership cascades roll back data, receipts and live state`, async () => {
  const a = await open('a', {}, { capture: { mode } }); const b = await open('b', {}, { capture: { mode } });
  try {
    await a.transaction(async (tx) => {
      assert.equal(tx.replication, undefined);
      await tx.entity('Tag').create({ id: 't' });
      await tx.entity('Parent').create({ id: 'p', tags: ['t'] });
    });
    await b.replication.apply((await a.replication.page()).items[0]);
    const before = await replicaState(b);
    const events = []; b.observe((event) => events.push(event));
    await a.entity('Parent').delete('p');
    const envelope = (await a.replication.page({ after: 1 })).items[0];
    const incomplete = { ...envelope, operations: envelope.operations.filter((op) => op.table === 'Parent') };
    await assert.rejects(b.replication.apply(incomplete), { code: 'JD2104' });
    assert.deepEqual(await replicaState(b), before);
    assert.deepEqual(await b.replication.frontier(), { a: 1 });
    assert.equal(events.length, 0);
    assert.equal((await b.replication.apply(envelope)).status, 'applied');
    assert.deepEqual(await replicaState(b), await replicaState(a));
  }
  finally { await a.close(); await b.close(); }
});

it('journal replication refuses hidden child cascades, while session capture includes their operations', async () => {
  const model = structuredClone(replicationModel);
  model.entities.Parent.schema.properties.children = { 'x-entity': {
    relation: { to: 'Tag', many: true, via: 'parentId', onDelete: 'cascade' },
  } };
  model.entities.Tag.schema.properties.parentId = { type: 'string' };
  await assert.rejects(openStore(model, { driver: nodeDriver(), capture: { mode: 'journal' }, replication: { replica: 'j' } }),
    { code: 'JD0051' });
  const a = await openStore(model, { driver: nodeDriver(), capture: { mode: 'session' }, replication: { replica: 'a' } });
  const b = await openStore(model, { driver: nodeDriver(), capture: { mode: 'session' }, replication: { replica: 'b' } });
  try {
    await a.entity('Parent').create({ id: 'p' });
    await a.entity('Tag').create({ id: 't', parentId: 'p' });
    for (const envelope of (await a.replication.page()).items) await b.replication.apply(envelope);
    await a.entity('Parent').delete('p');
    const envelope = (await a.replication.page({ after: 2 })).items[0];
    assert.deepEqual(envelope.operations.map((op) => op.table).sort(), ['Parent', 'Tag']);
    await b.replication.apply(envelope);
    assert.equal(await b.entity('Tag').get('t'), undefined);
  }
  finally { await a.close(); await b.close(); }
});

it('snapshot accumulation and resolver output obey byte capacity without partial effects', async () => {
  const a = await open('a');
  const b = await open('b', { maxBytes: 700, resolver: { id: 'oversize', resolve: () => ({ action: 'merged', value: { id: 'x', n: 'x'.repeat(1000) } }) } });
  try {
    await a.collection('notes').put({ id: 'x', n: 1 });
    await b.collection('notes').put({ id: 'x', n: 2 });
    await assert.rejects(b.replication.apply((await a.replication.page()).items[0]), { code: 'JD2074' });
    assert.deepEqual(await b.replication.frontier(), { b: 1 });
    assert.deepEqual(await b.replication.conflicts(), []);
    for (let n = 3; n < 10; n++) await b.collection('notes').put({ id: 'x', n });
    await assert.rejects(b.replication.snapshot(), { code: 'JD2074' });
    assert.equal((await b.collection('notes').get('x')).n, 9);
    assert.equal((await b.replication.page({ limit: 1 })).items.length, 1);
    await assert.rejects(b.replication.conflicts({ maxBytes: 0 }), TypeError);
    await assert.rejects(b.replication.conflicts({ signal: AbortSignal.abort() }), { code: 'JD2064' });
  }
  finally { await a.close(); await b.close(); }
});
