//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { asyncLive } from '@jarenjs/db/async-live';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { nodeDriver } from '@jarenjs/db/node';
import { applyJSONPatch } from '@jarenjs/json/patch';

const model = { $model: '0.1', collections: { notes: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, tenant: { type: 'string' } },
} } } };
const all = [{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }];

it('declares opt-in modes and refuses missing capabilities and invalid credits', async () => {
  for (const options of [{ maxQueries: 0 }, { maxInputBytes: Infinity }, { pollMs: 2147483648 }])
    assert.throws(() => asyncLive(options), TypeError);
  for (const options of [{}, { capture: { log: true } }, { live: asyncLive() }]) {
    const store = await openStore(model, { driver: nodeWorkerDriver(), ...options });
    try {
      assert.equal(store.capabilities.live, false); assert.deepEqual(store.capabilities.liveModes, []);
      await assert.rejects(store.collection('notes').live(all), { code: options.capture ? 'JD0051' : 'JD0050' });
    }
    finally { await store.close(); }
  }
  const store = await openStore(model, { driver: nodeDriver(), capture: { log: true }, live: asyncLive() });
  try {
    assert.deepEqual(store.capabilities.liveModes, ['incremental', 'rerun', 'resnapshot']);
    const incremental = await store.collection('notes').live(all);
    assert.equal(incremental.mode.mode, 'incremental');
    const snapshot = await store.collection('notes').live(all, { mode: 'resnapshot' });
    assert.equal(snapshot.mode.mode, 'resnapshot');
    await assert.rejects(store.collection('notes').live(all,
      { mode: 'resnapshot', eventTime: { watermark: 0 } }), { code: 'JD0053' });
    await snapshot.close(); incremental.close();
  }
  finally { await store.close(); }
});

for (const factory of [nodeWorkerDriver, nodeWorkerPoolDriver, nodeProcessDriver])
  describe(`${factory.name} durable resnapshot`, () => {
    it('queues an unrelated read behind a transaction under the declared default timeout', async () => {
      const store = await openStore(model, { driver: factory() });
      const started = Promise.withResolvers(), release = Promise.withResolvers();
      try {
        const write = store.transaction(async (tx) => {
          await tx.collection('notes').insert({ id: 'a', title: 'tea' });
          started.resolve(); await release.promise;
        });
        await started.promise;
        const read = store.collection('notes').get('a');
        // Observe a premature rejection without allowing an unhandled promise.
        let failure; read.catch((error) => { failure = error; });
        await new Promise((resolve) => setTimeout(resolve, 25));
        release.resolve(); await write;
        assert.equal(failure, undefined);
        assert.equal((await read).title, 'tea');
      }
      finally { release.resolve(); await store.close(); }
    });

    it('publishes committed snapshots, ignores rollback, preserves references and drains twice', async () => {
      const store = await openStore(model, { driver: factory(), capture: { mode: 'journal', log: true },
        live: asyncLive({ pollMs: 60000 }) });
      try {
        const rows = store.collection('notes');
        await rows.insert({ id: 'a', title: 'tea' });
        const live = await rows.live(all);
        assert.deepEqual(store.capabilities.liveModes, ['resnapshot']);
        assert.equal(store.capabilities.live, true);
        assert.equal(live.mode.mode, 'resnapshot');
        assert.deepEqual(live.result.rows, [{ id: 'a', title: 'tea' }]);
        const first = live.result.rows[0], events = [];
        live.subscribe((event) => events.push(event));
        await rows.insert({ id: 'b', title: 'coffee' });
        await live.refresh();
        assert.deepEqual(live.result.rows, await rows.execute(all));
        assert.equal(live.result.rows[0], first);
        assert.equal(live.state, 'live');
        const before = events.length;
        await assert.rejects(store.transaction(async (tx) => {
          await tx.collection('notes').insert({ id: 'c', title: 'rollback' });
          throw new Error('rollback');
        }), /rollback/);
        await live.refresh();
        assert.equal(events.length, before);
        assert.equal(live.stats().pending, 0);
        assert.equal(live.stats().checkpoint, 2);
        await live.close(); await live.close();
        assert.equal(store.stats().liveQueries, 0);
        assert.equal(live.state, 'closed');
        assert.equal(live.stats().subscriptions, 0);
      }
      finally { await store.close(); }
    });

    it('bounds slow observers and emits a standalone latest patch', async () => {
      const store = await openStore(model, { driver: factory(), capture: { mode: 'journal', log: true },
        live: asyncLive({ pollMs: 60000, maxObservers: 1 }) });
      const release = Promise.withResolvers();
      try {
        const rows = store.collection('notes');
        const live = await rows.live(all); await live.refresh();
        let received = live.result;
        const events = [];
        live.subscribe((event) => {
          received = applyJSONPatch(received, event.patch);
          events.push(event);
          if (events.length === 1) return release.promise;
        });
        assert.throws(() => live.subscribe(() => {}), { code: 'JD0052' });
        for (let i = 0; i < 5; i++) {
          await rows.put({ id: 'a', title: String(i) }); await live.refresh();
        }
        assert.equal(events.length, 1);
        assert.equal(live.stats().observerPending, 2);
        release.resolve(); await release.promise; await Promise.resolve();
        assert.equal(events.length, 2);
        assert.equal(events[1].coalesced, true);
        assert.deepEqual(received, live.result);
        await live.close();
      }
      finally { release.resolve(); await store.close(); }
    });

    it('refuses oversized input/results and releases failed registrations', async () => {
      const store = await openStore(model, { driver: factory(), capture: { mode: 'journal', log: true },
        live: asyncLive({ pollMs: 60000, maxInputRows: 2, maxInputBytes: 300, maxMaintained: 4, maxBytes: 200 }) });
      try {
        for (let i = 0; i < 3; i++) await store.collection('notes').insert({ id: String(i), title: 'tea' });
        const count = await store.collection('notes').live({ $count: { $for: { it: '$[*]' }, $return: '$it' } });
        assert.deepEqual(count.result.rows, [3]);
        assert.equal(count.stats().inputRows, 1, 'native aggregate output uses one decoded row; native scan work is a separate host capability');
        await count.close();
        const residual = [{ $for: { it: '$[*]' }, $let: { title: { $default: ['$it.title', ''] } },
          $where: { $eq: ['$title', 'absent'] }, $return: '$it' }];
        await assert.rejects(store.collection('notes').live(residual), (e) => ['JD2060', 'JD2007'].includes(e.code));
        assert.equal(store.stats().liveQueries, 0, 'a small answer cannot hide an oversized residual input');
        await store.collection('notes').delete('2'); await store.collection('notes').delete('1');
        await store.collection('notes').put({ id: '0', title: 'x'.repeat(250) });
        await assert.rejects(store.collection('notes').live(all), { code: 'JD2060' });
        assert.equal(store.stats().liveQueries, 0);
        await store.collection('notes').put({ id: '0', title: 'small' });
        const live = await store.collection('notes').live(all);
        await assert.rejects(store.collection('notes').live(all, { mode: 'incremental' }), { code: 'JD0051' });
        await store.collection('notes').put({ id: '0', title: 'x'.repeat(250) });
        await live.refresh();
        assert.equal(live.state, 'errored'); assert.equal(live.error.code, 'JD2060');
        assert.deepEqual(live.result.rows, [{ id: '0', title: 'small' }]);
        assert.equal(store.stats().liveQueries, 0);
        await live.close();
      }
      finally { await store.close(); }
    });

    it('preserves explicit queue deadlines and the fate of transaction-local registrations', async () => {
      const store = await openStore(model, { driver: factory(), queueTimeout: 10,
        capture: { mode: 'journal', log: true }, live: asyncLive({ pollMs: 60000 }) });
      const release = Promise.withResolvers(), started = Promise.withResolvers();
      let provisional;
      try {
        const hold = store.transaction(async () => { started.resolve(); await release.promise; });
        await started.promise;
        await assert.rejects(store.collection('notes').get('a'), (error) => error.code === 'JD0012' && /10ms/.test(error.message));
        release.resolve(); await hold;
        await assert.rejects(store.transaction(async (tx) => {
          await tx.collection('notes').insert({ id: 'a', title: 'provisional' });
          provisional = await tx.collection('notes').live(all);
          assert.deepEqual(provisional.result.rows, [{ id: 'a', title: 'provisional' }]);
          throw new Error('rollback');
        }), /rollback/);
        assert.equal(provisional.state, 'closed');
        assert.equal(store.stats().liveQueries, 0);
        assert.equal(await store.collection('notes').get('a'), undefined);
      }
      finally { release.resolve(); await provisional?.close(); await store.close(); }
    });

    it('retains host row predicates and member permissions while narrowing execution credits', async () => {
      const store = await openStore(model, { driver: factory(), capture: { mode: 'journal', log: true },
        profile: { predicates: { notes: { $eq: ['$it.tenant', 'allowed'] } }, members: { notes: ['$.id', '$.title'] } },
        live: asyncLive({ pollMs: 60000 }) });
      try {
        await store.collection('notes').insert({ id: 'a', title: 'visible', tenant: 'allowed' });
        await store.collection('notes').insert({ id: 'b', title: 'private', tenant: 'other' });
        const projected = [{ $for: { it: '$[*]' }, $return: { id: '$it.id', title: '$it.title' } }];
        const live = await store.collection('notes').live(projected);
        assert.deepEqual(live.result.rows, [{ id: 'a', title: 'visible' }]);
        await assert.rejects(store.collection('notes').live(all), { code: 'JD0011' });
        await live.close();
      }
      finally { await store.close(); }
    });

    it('fixes query bindings, reserves registration credits and resets an oversized log record', async () => {
      const store = await openStore(model, { driver: factory(), capture: { mode: 'journal', log: true },
        live: asyncLive({ pollMs: 60000, maxQueries: 1, maxBytes: 150 }) });
      try {
        const rows = store.collection('notes');
        const document = [{ $for: { it: '$[*]' }, $where: { $eq: ['$it.id', '$id'] }, $return: '$it.id' }];
        const externals = { id: 'a' };
        const live = await rows.live(document, { externals }); await live.refresh();
        await assert.rejects(rows.live(all), { code: 'JD0052' });
        document[0].$return = '$it.title'; externals.id = 'b';
        const events = []; live.subscribe((event) => events.push(event));
        await rows.insert({ id: 'a', title: 'x'.repeat(2000) });
        await live.refresh();
        assert.deepEqual(live.result.rows, ['a']);
        assert.equal(events.at(-1).resetRequired, true);
        assert.equal(live.stats().checkpoint, 1);
        await live.close();
        const replacement = await rows.live([{ $for: { it: '$[*]' }, $return: '$it.id' }]);
        await replacement.close();
      }
      finally { await store.close(); }
    });

    it('retains the host full-scan refusal through native EXPLAIN', async () => {
      const store = await openStore(model, { driver: factory(), profile: { refuseFullScan: true },
        capture: { log: true }, live: asyncLive() });
      try {
        await assert.rejects(store.collection('notes').live(all), { code: 'JD0011' });
        assert.equal(store.stats().liveQueries, 0);
      }
      finally { await store.close(); }
    });
  });

it('counts input across entity roots even when each root is individually within credit', async () => {
  const schema = { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } } } };
  const store = await openStore({ $model: '0.1', entities: { Item: { schema }, Other: { schema } } },
    { driver: nodeWorkerDriver(), capture: { log: true }, live: asyncLive({ maxInputRows: 3 }) });
  try {
    for (const name of ['Item', 'Other']) for (const id of ['a', 'b']) await store.entity(name).create({ id });
    const query = { items: ['$.Item[*]'], other: ['$.Other[*]'] };
    assert.deepEqual(await store.execute(query), { items: [{ id: 'a' }, { id: 'b' }], other: [{ id: 'a' }, { id: 'b' }] });
    await assert.rejects(store.live(query), { code: 'JD2060' });
    assert.equal(store.stats().liveQueries, 0);
  }
  finally { await store.close(); }
});

it('takes a finite observer set before callbacks can register replacements', async () => {
  const store = await openStore(model, { driver: nodeDriver(), capture: { log: true }, live: asyncLive({ maxObservers: 1 }) });
  try {
    const live = await store.collection('notes').live(all, { mode: 'resnapshot' }); await live.refresh();
    const seen = []; let stop;
    stop = live.subscribe(() => {
      seen.push('original'); stop();
      stop = live.subscribe(() => { seen.push('replacement'); });
    });
    await store.collection('notes').insert({ id: 'a' }); await live.refresh();
    assert.deepEqual(seen, ['original']);
    await store.collection('notes').insert({ id: 'b' }); await live.refresh();
    assert.deepEqual(seen, ['original', 'replacement']);
    stop(); await live.close();
  }
  finally { await store.close(); }
});
