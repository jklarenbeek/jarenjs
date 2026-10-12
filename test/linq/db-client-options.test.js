//@ts-check
/**
 * @file What the database client takes as a name or an option, and used to
 * take wrongly in silence: a relation looked up on its table's prototype
 * (`include`, `link`, `unlink`), a graph ordering whose options were not a
 * closed set, the durable adapters' and range providers' option bags that
 * replaced a misspelt member with its default, `live()` options the client
 * merged into something the store would have refused, and a range export
 * closed before its first read that kept its credit for good.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { open, createDbReceipts, createDbRunStore, createDbEffectStore, createDbIngestionStore,
  createDbRangeProvider, createLexicalRangeProvider } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';

import { fixture } from '../durable/fixtures.js';

const User = m.object({
  id: m.integer().key(),
  name: m.string(),
  posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }),
  tags: m.rel.belongsToMany('Tag'),
});
const Post = m.object({
  pid: m.integer().key(),
  authorId: m.integer(),
  author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'cascade' }),
});
const Tag = m.object({ tid: m.integer().key(), label: m.string() });
const model = m.defineModel({ entities: { User, Post, Tag } });

/** The coded refusal a call raises, or a failed assertion. @param {() => any} fn */
function refusal(fn) {
  try { fn(); }
  catch (err) { return /** @type {any} */ (err); }
  return assert.fail('expected a refusal');
}

/** @param {(client: any) => Promise<void>} body @param {any} [options] */
async function withClient(body, options = {}) {
  const client = await open(model, { driver: nodeDriver(), validator: null, ...options });
  try { await body(client); }
  finally { await client.close(); }
}

describe('a relation is looked up among its table\'s own members', () => {
  const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

  it('include() of a name every object carries is JL0107, not an include of that name', async () => {
    await withClient(async (client) => {
      for (const name of inherited) {
        const error = refusal(() => client.entities.User.include((/** @type {any} */ u) => u.get(name)));
        assert.strictEqual(error.code, 'JL0107', name);
        assert.strictEqual(error.message,
          `JL0107: '${name}' is not a relation member of 'User' — include() loads a declared relation ('posts', 'tags')`);
      }
    });
  });

  it('a nested include of such a name is refused against the target entity', async () => {
    await withClient(async (client) => {
      for (const name of inherited) {
        const error = refusal(() => client.entities.User.include((/** @type {any} */ u) => u.posts, { include: { [name]: true } }));
        assert.strictEqual(error.message,
          `JL0107: '${name}' is not a relation member of 'Post' — a nested include loads a declared relation ('author')`);
      }
    });
  });

  it('link() and unlink() name the members that are declared, never "a undefined relation"', async () => {
    await withClient(async (client) => {
      for (const name of inherited) {
        for (const verb of ['link', 'unlink']) {
          const error = refusal(() => client.entities.User[verb](1, name, 2));
          assert.strictEqual(error.message,
            `JL0107: '${name}' is not a relation member of 'User' — ${verb}() attaches a many-to-many membership ('tags')`);
        }
      }
    });
  });

  it('the declared members still load and link', async () => {
    await withClient(async (client) => {
      assert.deepStrictEqual(client.entities.User.include((/** @type {any} */ u) => u.posts).toSpec(), { include: { posts: true } });
      assert.deepStrictEqual(client.entities.User.include((/** @type {any} */ u) => u.get('tags'), true).toSpec(),
        { include: { tags: true } });
    });
  });
});

describe('a graph ordering takes the chain\'s closed option set', () => {
  it('a misspelt option, null and a non-object are refused, as orderBy() on the chain refuses them', async () => {
    await withClient(async (client) => {
      const graph = client.entities.User.graph();
      for (const method of ['orderBy', 'orderByDescending']) {
        assert.strictEqual(refusal(() => graph[method]((/** @type {any} */ u) => u.name, { emtpy: 'last' })).message,
          `JL0005: ${method}() does not take 'emtpy' — did you mean 'empty'?`);
        assert.strictEqual(refusal(() => graph[method]((/** @type {any} */ u) => u.name, null)).message,
          `JL0005: ${method}() takes a plain options object`);
      }
      assert.strictEqual(refusal(() => graph.orderBy((/** @type {any} */ u) => u.name).thenBy((/** @type {any} */ u) => u.id, 'last')).message,
        'JL0005: thenBy() takes a plain options object');
      assert.strictEqual(refusal(() => graph.orderBy((/** @type {any} */ u) => u.name).thenByDescending((/** @type {any} */ u) => u.id, { colation: 'x' })).message,
        "JL0005: thenByDescending() does not take 'colation' — did you mean 'collation'?");
    });
  });

  it('an include ordering term takes key, desc, empty and collation, and desc is a boolean', async () => {
    await withClient(async (client) => {
      const include = (/** @type {any} */ orderBy) => client.entities.User.include((/** @type {any} */ u) => u.posts, { orderBy });
      const key = (/** @type {any} */ p) => p.pid;
      assert.strictEqual(refusal(() => include({ key, descending: true })).message,
        "JL0101: posts orderBy does not take 'descending' — the members are key, desc, empty, collation");
      assert.strictEqual(refusal(() => include({ key, descending: true })).docPath, undefined);
      assert.strictEqual(refusal(() => include([key, { key, desc: 'yes' }])).code, 'JL0101');
      assert.strictEqual(refusal(() => include([key, { key, desc: 'yes' }])).message,
        'JL0101: posts orderBy[1] desc is a boolean, got a string');
      assert.deepStrictEqual(include({ key, desc: true, empty: 'greatest', collation: 'c' }).toSpec(),
        { include: { posts: { orderBy: { $key: '$it.pid', $dir: 'desc', $empty: 'greatest', $collation: 'c' } } } });
      assert.deepStrictEqual(include({ key, desc: false }).toSpec(), { include: { posts: { orderBy: '$it.pid' } } });
    });
  });
});

describe('a constructor of the durable layer takes the members it reads', () => {
  it('a misspelt member of any of the four adapters is refused, naming the nearest', async () => {
    const f = await fixture();
    try {
      const c = f.client;
      assert.strictEqual(refusal(() => createDbReceipts(c, /** @type {any} */ ({ receipts: 'receipts', lease: 'leases' }))).message,
        "createDbReceipts() does not take 'lease' — did you mean 'leases'?");
      assert.strictEqual(refusal(() => createDbRunStore(c, /** @type {any} */ ({ runs: 'runs', events: 'events', maxPag: 1 }))).message,
        "createDbRunStore() does not take 'maxPag' — did you mean 'maxPage'?");
      assert.strictEqual(refusal(() => createDbEffectStore(c, /** @type {any} */ ({ operations: 'effects', maxLeg: 1 }))).message,
        "createDbEffectStore() does not take 'maxLeg' — did you mean 'maxLegs'?");
      assert.strictEqual(refusal(() => createDbIngestionStore(c, /** @type {any} */ (
        { staging: 'items', checkpoints: 'audit', publications: 'effects', fact: 'runs' }))).message,
      "createDbIngestionStore() does not take 'fact' — did you mean 'facts'?");
      for (const create of [createDbReceipts, createDbRunStore, createDbEffectStore, createDbIngestionStore]) {
        assert.match(refusal(() => create(c, /** @type {any} */ (null))).message, /takes a plain options object$/);
        assert.match(refusal(() => create(c, /** @type {any} */ ([]))).message, /takes a plain options object$/);
      }
    }
    finally { await f.client.close(); }
  });

  it('every documented member still builds', async () => {
    const f = await fixture();
    try {
      const c = f.client;
      createDbReceipts(c, { receipts: 'receipts', leases: 'leases', runtime: { now: () => 1 } });
      createDbRunStore(c, { runs: 'runs', events: 'events', statuses: {}, summary: () => ({}), canReset: () => true, maxPage: 1, maxBytes: 9 });
      createDbEffectStore(c, { operations: 'effects', maxLegs: 2, maxBytes: 9 });
      createDbIngestionStore(c, { staging: 'items', checkpoints: 'audit', publications: 'effects', facts: 'runs', reconcile: (_, incoming) => incoming });
    }
    finally { await f.client.close(); }
  });

  it('a misspelt bound of a range provider no longer falls back to its default', async () => {
    await withClient(async (client) => {
      const options = { keys: ['id'], resident: true };
      await assert.rejects(createDbRangeProvider(client.store, 'User', {}, /** @type {any} */ ({ ...options, maxRow: 3 })),
        { message: "createDbRangeProvider() does not take 'maxRow' — did you mean 'maxRows'?" });
      await assert.rejects(client.entities.User.range({}, /** @type {any} */ ({ ...options, maxRow: 3 })),
        { message: "createDbRangeProvider() does not take 'maxRow' — did you mean 'maxRows'?" });
      await assert.rejects(client.entities.User.range({}, /** @type {any} */ (null)),
        { message: 'createDbRangeProvider() takes a plain options object' });
      await assert.rejects(client.entities.User.range(/** @type {any} */ (null), options),
        { message: 'range provider needs a spec object' });
    }, { capture: true });
  });

  it('a lexical range provider takes the members it reads, and the range provider\'s own', async () => {
    const source = /** @type {any} */ ({ search: async () => assert.fail('opened'), subscribe: () => () => {} });
    await assert.rejects(createLexicalRangeProvider(source, 'x', {}, /** @type {any} */ ({ maxMatch: 3 })),
      { message: "createLexicalRangeProvider() does not take 'maxMatch' — did you mean 'maxMatches'?" });
    await assert.rejects(createLexicalRangeProvider(source, 'x', {}, /** @type {any} */ (null)),
      { message: 'createLexicalRangeProvider() takes a plain options object' });
  });
});

describe('live() hands the store the options the store judges', () => {
  it('externals that are not a plain object reach the store, which refuses them', async () => {
    await withClient(async (client) => {
      const document = { $for: { it: '$.User[*]' }, $return: '$it' };
      for (const externals of [5, 'abc', [1], true]) {
        const viaClient = await client.live(document, { externals }).catch((/** @type {any} */ e) => e);
        assert.strictEqual(viaClient.code, 'JD0013', JSON.stringify(externals));
        const viaStore = await client.store.live(document, { externals }).catch((/** @type {any} */ e) => e);
        assert.strictEqual(viaClient.message, viaStore.message);
      }
      for (const options of [null, 'abc', 5, []]) {
        const error = await client.live(document, /** @type {any} */ (options)).catch((/** @type {any} */ e) => e);
        assert.strictEqual(error.code, 'JD0013', JSON.stringify(options));
        assert.strictEqual(error.message, 'JD0013: live options must be a plain object');
      }
      const live = await client.live(document, { externals: null });
      await live.dispose?.();
    }, { capture: true });
  });
});

describe('a range export closed before it was read gives its credit back', () => {
  it('closing three unstarted exports of a two-export bound leaves the bound free', async () => {
    await withClient(async (client) => {
      for (let i = 0; i < 3; i++) await client.entities.User.create({ id: i + 1, name: `u${i}` });
      const provider = await client.entities.User.range({ orderBy: '$it.id' },
        { keys: ['id'], resident: true, source: 's', query: 'q', maxInFlight: 2 });
      try {
        const request = { query: 'q', snapshot: provider.snapshot };
        for (let i = 0; i < 3; i++) {
          const exported = provider.export(request);
          assert.strictEqual(provider.stats().exports, 1);
          await exported.return(undefined);
          assert.strictEqual(provider.stats().exports, 0);
        }
        const thrown = provider.export(request);
        await assert.rejects(thrown.throw(new Error('stop')), { message: 'stop' });
        assert.strictEqual(provider.stats().exports, 0);
        const pages = [];
        for await (const page of provider.export(request)) pages.push(page.state);
        assert.deepStrictEqual(pages, ['ready', 'complete']);
        assert.strictEqual(provider.stats().exports, 0);
      }
      finally { await provider.dispose(); }
    }, { capture: true });
  });
});

describe('a completed run keeps its status', () => {
  it('finish() over a done run changes nothing, as requestCancel() refuses it; over a waiting run it still records the observation', async () => {
    const f = await fixture();
    try {
      await f.client.store.jobs.enqueue('domain', {}, { id: 'job' });
      const job = await f.client.store.jobs.claim({ kinds: ['domain'], owner: 'worker', leaseMs: 1000 });
      const store = createDbRunStore(f.client, { runs: 'runs', events: 'events' });
      for (const id of ['finished', 'interrupted']) {
        await store.attach({ id, jobId: 'job', workflow: 'w', schemaVersion: '1' }, job.lease);
      }
      await store.save('finished', { runId: 'finished', generation: 1, status: 'done', result: 7 }, 0, job.lease);
      await store.save('interrupted', { runId: 'interrupted', generation: 1, status: 'waiting' }, 0, job.lease);
      const done = await store.get('finished');
      assert.deepStrictEqual(await store.finish('finished', 'failed', job.lease), { record: done, changes: 0, writes: 0, revisions: 0 });
      assert.strictEqual((await store.get('finished')).status, 'done');
      assert.strictEqual((await store.get('finished')).revision, done.revision);
      const result = await store.finish('interrupted', 'cancelled', job.lease);
      assert.strictEqual(result.writes, 2);
      assert.strictEqual((await store.get('interrupted')).status, 'cancelled');
    }
    finally { await f.client.close(); }
  });
});
