//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { createJsltRegistry, statsPack } from '@jarenjs/json/jslt';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { liveOracle } from './oracle/replication.js';
import { skipFor, withStore } from './store-core-engines.js';
import { asyncLive } from '@jarenjs/db/async-live';

const MODEL = { $model: '0.1', entities: {
  Author: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' },
  } } },
  Post: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } },
    author: { type: 'string', 'x-entity': { index: true } }, title: { type: 'string' },
  } } },
} };
const JOIN = [{ $for: { p: '$.Post[*]', a: '$.Author[*]' },
  $where: { $eq: ['$p.author', '$a.id'] }, $return: { id: '$p.id', title: '$p.title', author: '$a.name' } }];

for (const mode of ['session', 'journal']) it(`${mode}: an indexed join reconstructs fresh snapshots for mutations on both sides`, async () => {
  const store = await openStore(MODEL, { driver: nodeDriver(), capture: { mode } });
  try {
    const live = await store.live(JOIN, { mode: 'incremental' });
    assert.equal(live.mode.strategy, 'join');
    const oracle = liveOracle(live, () => store.execute(JOIN));
    for (const mutate of [
      () => store.entity('Author').create({ id: 'a', name: 'Ada' }),
      () => store.entity('Post').create({ id: 'z', author: 'a', title: 'same' }),
      () => store.entity('Post').create({ id: 'b', author: 'a', title: 'same' }),
      () => store.entity('Author').create({ id: 'b', name: 'Bob' }),
      () => store.entity('Post').update('b', { author: 'b' }),
      () => store.entity('Author').update('a', { name: 'ADA' }),
      () => store.entity('Author').delete('b'),
      () => store.entity('Post').delete('z'),
      () => store.entity('Author').create({ id: 'b', name: 'BOB' }),
    ]) { await mutate(); await oracle.check(); }
    assert.equal(live.stats().reruns, 0);
    assert.equal(live.stats().dependencyReads, 9);
    oracle.close();
  }
  finally { await store.close(); }
});

it('a graph or allowing-empty join that needs the store\'s registered operators or zone provider re-runs, as execute answers it', async () => {
  const child = { $for: { x: '$.Post[*]' }, $where: { $eq: ['$x.author', '$a.id'] }, $return: '$x.title' };
  const left = (value) => [{ $for: { a: '$.Author[*]', p: { $in: { $for: { x: '$.Post[*]' },
    $where: { $eq: ['$x.author', '$a.id'] }, $return: '$x' }, '$allowing-empty': true } }, $return: { a: '$a.id', value } }];
  const day = (path) => ({ '$time-bucket': [path, 'P1D', null, { zone: 'Europe/Amsterdam' }] });
  const cases = [
    [{ operators: createJsltRegistry().use(statsPack) }, [
      [{ $for: { a: '$.Author[*]' }, $return: { a: '$a.id', n: { $mean: [[{ $count: [child] }, 1]] } } }],
      left({ $mean: [[{ $count: ['$p'] }, 1]] }),
    ]],
    [{ zoneProvider: createIntlZoneProvider() }, [
      [{ $for: { a: '$.Author[*]' }, $return: { a: '$a.id', titles: [child], day: day('$a.since') } }],
      left(day('$a.since')),
    ]],
  ];
  for (const [options, documents] of cases) {
    const model = structuredClone(MODEL);
    model.entities.Author.schema.properties.since = { type: 'string', format: 'date-time' };
    const store = await openStore(model, { driver: nodeDriver(), capture: true, ...options });
    try {
      await store.entity('Author').create({ id: 'a', name: 'Ada', since: '2024-03-30T23:30:00Z' });
      await store.entity('Post').create({ id: 'p', author: 'a', title: 'one' });
      for (const document of documents) {
        const live = await store.live(document);
        assert.equal(live.mode.mode, 'rerun');
        assert.match(live.mode.reason, /^entity dependency plan: /);
        await assert.rejects(store.live(document, { mode: 'incremental' }), { code: 'JD0051' });
        const oracle = liveOracle(live, () => store.execute(document));
        await oracle.check();
        await store.entity('Post').create({ id: `q${documents.indexOf(document)}`, author: 'a', title: 'two' });
        await oracle.check();
        oracle.close();
        live.close();
      }
    }
    finally { await store.close(); }
  }
});

it('an unsupported join names its reason and demanded incremental refuses', async () => {
  const model = structuredClone(MODEL); delete model.entities.Post.schema.properties.author['x-entity'];
  const store = await openStore(model, { driver: nodeDriver(), capture: true });
  try {
    const live = await store.live(JOIN);
    assert.equal(live.mode.mode, 'rerun'); assert.match(live.mode.reason, /no declared index/);
    await assert.rejects(store.live(JOIN, { mode: 'incremental' }), { code: 'JD0051' });
  }
  finally { await store.close(); }
});

it('dependency caches and fan-out are charged to maxMaintained and close once on overflow', async () => {
  const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, live: { maxMaintained: 4 } });
  try {
    await store.entity('Author').create({ id: 'a' });
    await store.entity('Post').create({ id: 'p', author: 'a' });
    const live = await store.live(JOIN);
    const events = []; live.subscribe((event) => events.push(event));
    await store.entity('Post').create({ id: 'q', author: 'a' });
    assert.equal(live.error.code, 'JD2060'); assert.equal(live.state, 'errored');
    await store.entity('Post').create({ id: 'r', author: 'a' });
    assert.equal(events.length, 1);
  }
  finally { await store.close(); }
});

it('the fan-out bound counts each connected row once: rows reached along several edges do not exhaust it', async () => {
  const key = { 'x-entity': { key: true } };
  const model = { $model: '0.1', entities: {
    Owner: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...key },
      items: { 'x-entity': { relation: { to: 'Item', many: true, via: 'ownerId', onDelete: 'cascade' } } } } } },
    Item: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...key },
      k: { type: 'string', 'x-entity': { index: true } } } } },
    Other: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...key },
      k: { type: 'string', 'x-entity': { index: true } }, flag: { type: 'integer' } } } },
  } };
  // 64 items and 64 others share one value: every item reaches every other
  const store = await openStore(model, { driver: nodeDriver(), capture: true, live: { maxMaintained: 1000 } });
  try {
    await store.transaction(async (tx) => {
      await tx.entity('Owner').create({ id: 'o' });
      for (let i = 0; i < 64; i++) await tx.entity('Item').create({ id: `i${i}`, ownerId: 'o', k: 'K' });
      for (let i = 0; i < 64; i++) await tx.entity('Other').create({ id: `x${i}`, k: 'K', flag: i === 0 ? 1 : 0 });
    });
    const document = [{ $for: { o: '$.Owner[*]', i: '$.Item[*]', x: '$.Other[*]' },
      $where: { $and: [{ $eq: ['$i.ownerId', '$o.id'] }, { $eq: ['$i.k', '$x.k'] }, { $eq: ['$x.flag', 1] }] },
      $return: { i: '$i.id', x: '$x.id' } }];
    // 129 source rows and 64 tuples: within live.maxMaintained
    const live = await store.live(document);
    assert.deepEqual(live.mode, { strategy: 'join', mode: 'incremental' });
    const oracle = liveOracle(live, () => store.execute(document));
    await oracle.check();
    for (let i = 64; i < 80; i++) await store.entity('Other').create({ id: `x${i}`, k: 'K', flag: 0 });
    await store.entity('Item').create({ id: 'i64', ownerId: 'o', k: 'K' });
    await oracle.check();
    assert.equal(live.result.rows.length, 65);
    oracle.close();
  }
  finally { await store.close(); }
});

it('an indexed left join maintains null transitions without reloading unrelated owners', async () => {
  const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
  const document = [{ $for: { p: '$.Post[*]', a: { $in: {
    $for: { match: '$.Author[*]' }, $where: { $eq: ['$match.id', '$p.author'] }, $return: '$match',
  }, '$allowing-empty': true } }, $return: { id: '$p.id', author: { $default: ['$a.name', null] } } }];
  try {
    for (const id of ['p', 'q']) await store.entity('Post').create({ id, author: id });
    const live = await store.live(document, { mode: 'incremental' });
    const oracle = liveOracle(live, () => store.execute(document));
    await oracle.check();
    const prior = live.result.rows[1]; const refreshes = live.stats().refreshedRoots;
    await store.entity('Author').create({ id: 'p', name: 'Ada' });
    await oracle.check();
    assert.equal(live.stats().refreshedRoots - refreshes, 1);
    assert.equal(live.result.rows[1], prior);
    await store.entity('Author').delete('p'); await oracle.check();
    assert.equal(live.result.rows[0].author, null);
    oracle.close();
  }
  finally { await store.close(); }
});

it('a bounded relation graph refreshes only owners of a changed child and membership', async () => {
  const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
  const document = [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id', posts: [{
    $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.author', '$a.id'] }, $return: '$p',
  }] } }];
  try {
    await store.entity('Author').create({ id: 'a' });
    await store.entity('Author').create({ id: 'unrelated' });
    await store.entity('Post').create({ id: 'p', author: 'a', title: 'first' });
    const live = await store.live(document, { mode: 'incremental' });
    assert.equal(live.mode.strategy, 'graph');
    const oracle = liveOracle(live, () => store.execute(document)); await oracle.check();
    const before = live.result.rows[1]; const refreshes = live.stats().refreshedRoots;
    await store.entity('Post').update('p', { title: 'changed' }); await oracle.check();
    assert.equal(live.stats().refreshedRoots - refreshes, 1); assert.equal(live.result.rows[1], before);
    await store.entity('Post').update('p', { author: 'unrelated' }); await oracle.check();
    await store.entity('Post').delete('p'); await oracle.check();
    oracle.close();
  }
  finally { await store.close(); }
});

it('a three-root projection refreshes affected outer identities after attach, move and detach', async () => {
  const model = structuredClone(MODEL);
  model.entities.Comment = { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } },
    post: { type: 'string', 'x-entity': { index: true } }, text: { type: 'string' },
  } } };
  const document = [{ $for: { a: '$.Author[*]', p: '$.Post[*]', c: '$.Comment[*]' },
    $where: { $and: [{ $eq: ['$p.author', '$a.id'] }, { $eq: ['$c.post', '$p.id'] }] },
    $return: { author: '$a.name', post: '$p.title', text: '$c.text' } }];
  const store = await openStore(model, { driver: nodeDriver(), capture: true });
  try {
    await store.entity('Author').create({ id: 'a', name: 'Ada' });
    await store.entity('Author').create({ id: 'b', name: 'Bob' });
    await store.entity('Post').create({ id: 'p', author: 'a', title: 'P' });
    await store.entity('Post').create({ id: 'q', author: 'b', title: 'Q' });
    const live = await store.live(document, { mode: 'incremental' });
    const oracle = liveOracle(live, () => store.execute(document));
    for (const mutate of [
      () => store.entity('Comment').create({ id: 'c', post: 'p', text: 'C' }),
      () => store.entity('Comment').update('c', { post: 'q' }),
      () => store.entity('Post').update('q', { author: 'a' }),
      () => store.entity('Comment').delete('c'),
    ]) { await mutate(); await oracle.check(); }
    assert.equal(live.stats().dependencyReads, 4);
    assert.equal(live.stats().reruns, 0);
    oracle.close();
  }
  finally { await store.close(); }
});

it('join dependency bytes refuse oversize state at registration and close once after growth', async () => {
  const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, live: { maxBytes: 200 } });
  try {
    await store.entity('Author').create({ id: 'a', name: 'Ada' });
    await store.entity('Post').create({ id: 'p', author: 'a' });
    const live = await store.live(JOIN);
    const events = []; live.subscribe((event) => events.push(event));
    await store.entity('Author').update('a', { name: 'a'.repeat(201) });
    assert.equal(live.error.code, 'JD2060');
    assert.equal(events.length, 1);
    await assert.rejects(store.live(JOIN), { code: 'JD2060' });
  }
  finally { await store.close(); }
});

for (const mode of ['session', 'journal']) it(`${mode}: an entity deleted and created again with the document it had, in one transaction, re-runs a view whose ties it moved`, async () => {
  const store = await openStore(MODEL, { driver: nodeDriver(), capture: { mode } });
  try {
    for (const id of ['p', 'q', 'r']) await store.entity('Author').create({ id, name: 'same' });
    const ordered = [{ $for: { a: '$.Author[*]' }, $orderby: { $key: '$a.name' }, $return: '$a.id' }];
    const live = await store.live(ordered);
    const oracle = liveOracle(live, () => store.execute(ordered)); await oracle.check();
    assert.deepEqual(live.result.rows, ['p', 'q', 'r']);
    await store.transaction(async (tx) => {
      await tx.entity('Author').delete('p');
      await tx.entity('Author').create({ id: 'p', name: 'same' });
    });
    assert.deepEqual(live.result.rows, ['q', 'r', 'p']);
    await oracle.check();
    oracle.close();
  }
  finally { await store.close(); }
});

it('session: an entity whose delete a store rule judges, deleted and created again with the document it had, re-runs a view whose ties it moved', async () => {
  const key = { type: 'string', 'x-entity': { key: true } };
  const judged = { $model: '0.1', entities: {
    Hub: { schema: { type: 'object', required: ['id'], properties: { id: key, name: { type: 'string' },
      spokes: { 'x-entity': { relation: { to: 'Spoke', many: true, via: 'hub', onDelete: 'cascade' } } } } } },
    Spoke: { schema: { type: 'object', required: ['id'], properties: { id: key, hub: { type: ['string', 'null'] } } },
      invariants: [{ name: 'kept', on: ['delete'], enforcement: 'store', assert: { $ne: ['$.old.id', 'kept'] } }] },
  } };
  const store = await openStore(judged, { driver: nodeDriver(), capture: { mode: 'session' } });
  try {
    for (const id of ['p', 'q', 'r']) await store.entity('Hub').create({ id, name: 'same' });
    const ordered = [{ $for: { h: '$.Hub[*]' }, $orderby: { $key: '$h.name' }, $return: '$h.id' }];
    const live = await store.live(ordered);
    const oracle = liveOracle(live, () => store.execute(ordered)); await oracle.check();
    await store.transaction(async (tx) => {
      await tx.entity('Hub').delete('p');
      await tx.entity('Hub').create({ id: 'p', name: 'same' });
    });
    assert.deepEqual(live.result.rows, ['q', 'r', 'p']);
    await oracle.check();
    oracle.close();
  }
  finally { await store.close(); }
});

for (const mode of ['session', 'journal']) it(`${mode}: a maintained join and graph move a row deleted and created again with the document it had, in one transaction`, async () => {
  const store = await openStore(MODEL, { driver: nodeDriver(), capture: { mode } });
  try {
    await store.entity('Author').create({ id: 'a', name: 'Ada' });
    await store.entity('Author').create({ id: 'b', name: 'Bob' });
    for (const id of ['p', 'q', 'r']) await store.entity('Post').create({ id, author: 'a', title: id });
    const graph = [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id',
      posts: [{ $for: { x: '$.Post[*]' }, $where: { $eq: ['$x.author', '$a.id'] }, $return: '$x.id' }] } }];
    const join = await store.live(JOIN, { mode: 'incremental' });
    const projection = await store.live(graph, { mode: 'incremental' });
    assert.deepEqual([join.mode.strategy, projection.mode.strategy], ['join', 'graph']);
    const oracles = [liveOracle(join, () => store.execute(JOIN)), liveOracle(projection, () => store.execute(graph))];
    for (const oracle of oracles) await oracle.check();
    await store.transaction(async (tx) => {
      await tx.entity('Post').delete('p');
      await tx.entity('Post').create({ id: 'p', author: 'a', title: 'p' });
    });
    assert.deepEqual(join.result.rows.map((row) => row.id), ['q', 'r', 'p']);
    assert.deepEqual(projection.result.rows[0].posts, ['q', 'r', 'p']);
    await store.transaction(async (tx) => {
      await tx.entity('Author').delete('a');
      await tx.entity('Author').create({ id: 'a', name: 'Ada' });
    });
    assert.deepEqual(projection.result.rows.map((row) => row.id), ['b', 'a']);
    for (const oracle of oracles) { await oracle.check(); oracle.close(); }
  }
  finally { await store.close(); }
});

/** Hubs whose spokes a foreign-key action removes, and tags they are members of. */
const RESTORED = { $model: '0.1', entities: {
  Hub: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' },
    spokes: { 'x-entity': { relation: { to: 'Spoke', many: true, via: 'hub', onDelete: 'cascade' } } },
    leaning: { 'x-entity': { relation: { to: 'Spoke', many: true, via: 'other', onDelete: 'setNull' } } },
    tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
  Spoke: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } },
    hub: { type: ['string', 'null'] }, other: { type: ['string', 'null'] }, name: { type: 'string' } } } },
  Tag: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } } } } },
} };

/**
 * A store holding hubs `g`, `h` and `k`, spokes `p` (on `h`), `q` and `r` (on `g`)
 * tied by name, and `h` a member of tags `a`, `b` and `c`, handed to `fn`
 * with a live view over the spokes, one over the membership rows, every
 * record the store delivers, and a check that a replica the envelopes apply
 * to holds what the store holds.
 * @param {string} engine @param {'session' | 'journal'} mode
 * @param {(world: { store: any, views: any[], oracles: any[], records: any[], replicated: () => Promise<void>,
 *   settled: () => Promise<void> }) => Promise<void>} fn
 */
const restoredWorld = (engine, mode, fn) => withStore(engine, RESTORED, async (store) => {
  const replica = await openStore(RESTORED, { driver: nodeDriver(), replication: { replica: 'b' } });
  /** @type {any[]} */
  const oracles = [];
  try {
    for (const id of ['g', 'h', 'k']) await store.entity('Hub').create({ id, name: id });
    await store.entity('Spoke').create({ id: 'p', hub: 'h', name: 'same' });
    for (const id of ['q', 'r']) await store.entity('Spoke').create({ id, hub: 'g', name: 'same' });
    for (const id of ['a', 'b', 'c']) {
      await store.entity('Tag').create({ id });
      store.entity('Hub').link('h', 'tags', id);
    }
    await store.saveChanges();
    const spokes = [{ $for: { s: '$.Spoke[*]' }, $orderby: { $key: '$s.name' }, $return: '$s.id' }];
    const members = [{ $for: { m: '$.Hub_Tag[*]' }, $return: '$m.Tag_key' }];
    const views = [await store.live(spokes), await store.live(members)];
    if (engine !== 'sqlite') for (const view of views) await view.refresh();
    oracles.push(liveOracle(views[0], () => store.execute(spokes)), liveOracle(views[1], () => store.execute(members)));
    /** @type {any[]} */
    const records = [];
    store.observe((/** @type {any} */ record) => records.push(record.patch));
    const replicated = async () => {
      for (const envelope of (await store.replication.page({ after: 0 })).items)
        assert.equal((await replica.replication.apply(envelope)).status, 'applied', mode);
      // a replica holds the rows, not their order in a table
      const held = async (/** @type {any} */ at, /** @type {string} */ name) => (await at.entity(name).asNoTracking()
        .load(name === 'Hub' ? { include: { tags: true } } : {}))
        .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.id < b.id ? -1 : 1));
      for (const name of ['Hub', 'Spoke', 'Tag'])
        assert.deepEqual(await held(replica, name), await held(store, name), `${mode} ${name}`);
    };
    const settled = async () => { if (engine !== 'sqlite') for (const view of views) await view.refresh(); };
    await fn({ store, views, oracles, records, replicated, settled });
  }
  finally {
    for (const oracle of oracles) oracle.close();
    await replica.close();
  }
}, engine === 'sqlite' ? { capture: { mode }, replication: { replica: 'a' } }
  // a PostgreSQL view follows commits from a durable log, refreshed before each check
  : { capture: { mode, log: { retention: 4 } }, replication: { replica: 'a' }, live: asyncLive({ pollMs: 60000 }) });

// both capture modes on SQLite, the journal on PostgreSQL (which keeps no session)
for (const [engine, mode] of /** @type {const} */ ([['sqlite', 'session'], ['sqlite', 'journal'], ['postgres', 'journal']])) {
  const name = engine === 'sqlite' ? mode : `${engine} ${mode}`;
  for (const [label, storeAgain] of /** @type {[string, (tx: any) => Promise<any>][]} */ ([
    ['read, removed by a save and added by the next', async (tx) => {
      tx.entity('Spoke').remove(await tx.entity('Spoke').get('p')); await tx.saveChanges();
      tx.entity('Spoke').add({ id: 'p', hub: 'h', name: 'same' }); await tx.saveChanges();
    }],
    ['removed by a save of rows it never read and created', async (tx) => {
      tx.entity('Spoke').remove('p'); await tx.saveChanges();
      await tx.entity('Spoke').create({ id: 'p', hub: 'h', name: 'same' });
    }],
    ['deleted and added by a save', async (tx) => {
      await tx.entity('Spoke').delete('p');
      tx.entity('Spoke').add({ id: 'p', hub: 'h', name: 'same' }); await tx.saveChanges();
    }],
  ])) {
    it(`${name}: a row ${label}, with the document it had, in one transaction, ties behind the rows that stayed`, { skip: skipFor(engine) }, () => restoredWorld(engine, mode, async ({ store, views, oracles, records, replicated, settled }) => {
      await store.transaction(storeAgain, { unitOfWork: 'own' });
      await settled();
      assert.deepEqual(views[0].result.rows, ['q', 'r', 'p']);
      for (const oracle of oracles) await oracle.check();
      assert.deepEqual(records, [[{ op: 'replace', path: '/Spoke/p', value: { id: 'p', hub: 'h', name: 'same' } }]]);
      await replicated();
    }));
  }

  for (const [label, remove] of /** @type {[string, (tx: any) => Promise<any>][]} */ ([
    ['a delete', (tx) => tx.entity('Hub').delete('h')],
    ['a save', (tx) => { tx.entity('Hub').remove('h'); return tx.saveChanges(); }],
  ])) {
    it(`${name}: rows the foreign-key actions of ${label} removed, stored again with the documents they had in one transaction, move in every view`, { skip: skipFor(engine) }, () => restoredWorld(engine, mode, async ({ store, views, oracles, records, replicated, settled }) => {
      await store.transaction(async (tx) => {
        await remove(tx);
        await tx.entity('Hub').create({ id: 'h', name: 'h' });
        await tx.entity('Spoke').create({ id: 'p', hub: 'h', name: 'same' });
        for (const id of ['a', 'b', 'c']) tx.entity('Hub').link('h', 'tags', id);
        await tx.saveChanges();
      }, { unitOfWork: 'own' });
      await settled();
      assert.deepEqual(views.map((view) => view.result.rows), [['q', 'r', 'p'], ['a', 'b', 'c']]);
      for (const oracle of oracles) await oracle.check();
      assert.deepEqual(records.map((patch) => patch.map((op) => `${op.op} ${op.path}`).sort()), [[
        'replace /Hub/h', 'replace /Hub_Tag/["h","a"]', 'replace /Hub_Tag/["h","b"]', 'replace /Hub_Tag/["h","c"]', 'replace /Spoke/p',
      ]]);
      await replicated();
    }));
  }

  for (const [label, storeAgain] of /** @type {[string, (tx: any) => Promise<any>][]} */ ([
    ['deleted, created with another document and updated', async (tx) => {
      await tx.entity('Spoke').delete('p');
      await tx.entity('Spoke').create({ id: 'p', hub: 'h', name: 'other' });
      await tx.entity('Spoke').update('p', { name: 'same' });
    }],
    ['removed by a save, added with another document by the next and put', async (tx) => {
      tx.entity('Spoke').remove('p'); await tx.saveChanges();
      const added = tx.entity('Spoke').add({ id: 'p', hub: 'h', name: 'other' }); await tx.saveChanges();
      tx.entity('Spoke').put({ ...added, name: 'same' }); await tx.saveChanges();
    }],
  ])) {
    it(`${name}: a row ${label} back to the document it had, in one transaction, records the document it holds`, { skip: skipFor(engine) }, () => restoredWorld(engine, mode, async ({ store, views, oracles, records, replicated, settled }) => {
      await store.transaction(storeAgain, { unitOfWork: 'own' });
      await settled();
      assert.deepEqual(views[0].result.rows, ['q', 'r', 'p']);
      for (const oracle of oracles) await oracle.check();
      assert.deepEqual(records, [[{ op: 'replace', path: '/Spoke/p', value: { id: 'p', hub: 'h', name: 'same' } }]]);
      await replicated();
    }));
  }

  for (const [label, storeAgain] of /** @type {[string, (tx: any) => Promise<any>][]} */ ([
    ['updated', (tx) => tx.entity('Spoke').update('p', { other: null })],
    ['nulled by the foreign-key action of a later delete', (tx) => tx.entity('Hub').delete('k')],
    ['nulled by the foreign-key action of a later save', (tx) => { tx.entity('Hub').remove('k'); return tx.saveChanges(); }],
  ])) {
    it(`${name}: a row a foreign-key action removed, created with another document and ${label} back to the one it had, in one transaction, records the document it holds`, { skip: skipFor(engine) }, () => restoredWorld(engine, mode, async ({ store, views, oracles, records, replicated, settled }) => {
      await store.transaction(async (tx) => {
        await tx.entity('Hub').delete('h');
        await tx.entity('Hub').create({ id: 'h', name: 'h' });
        await tx.entity('Spoke').create({ id: 'p', hub: 'h', other: 'k', name: 'same' });
        await storeAgain(tx);
      }, { unitOfWork: 'own' });
      await settled();
      assert.deepEqual(views[0].result.rows, ['q', 'r', 'p']);
      for (const oracle of oracles) await oracle.check();
      const spoke = records[0].filter((op) => op.path === '/Spoke/p');
      assert.deepEqual(spoke, [{ op: 'replace', path: '/Spoke/p', value: { id: 'p', hub: 'h', name: 'same' } }]);
      await replicated();
    }));
  }

  it(`${name}: a membership unlinked by a save and linked again by the next, in one transaction, moves in a view over its rows`, { skip: skipFor(engine) }, () => restoredWorld(engine, mode, async ({ store, views, oracles, records, replicated, settled }) => {
    assert.deepEqual(views[1].result.rows, ['a', 'b', 'c']);
    await store.transaction(async (tx) => {
      tx.entity('Hub').unlink('h', 'tags', 'a'); await tx.saveChanges();
      tx.entity('Hub').link('h', 'tags', 'a'); await tx.saveChanges();
    });
    await settled();
    assert.deepEqual(views[1].result.rows, ['b', 'c', 'a']);
    for (const oracle of oracles) await oracle.check();
    assert.deepEqual(records, [[{ op: 'replace', path: '/Hub_Tag/["h","a"]', value: { Hub_key: 'h', Tag_key: 'a' } }]]);
    await replicated();
  }));
}
