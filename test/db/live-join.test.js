//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { createJsltRegistry, statsPack } from '@jarenjs/json/jslt';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { liveOracle } from './oracle/replication.js';

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
