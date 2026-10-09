//@ts-check
/**
 * @file The read surfaces' closed vocabularies. A graph-load specification
 * is a plain object whose members are the ones a node reads, and the
 * options of `load`, `execute` and `query` are closed sets like the
 * options of their twins `all` and `page`: a misspelt filter refuses by
 * code, naming the member it most likely meant, instead of loading (and
 * tracking) every row.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = { $model: '0.1',
  entities: {
    Item: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' },
      children: { 'x-entity': { relation: { to: 'Child', many: true, via: 'ownerId', onDelete: 'cascade' } } },
    } } },
    Child: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, ownerId: { type: 'string' }, n: { type: 'integer' },
    } } },
  },
  collections: { docs: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' } } } } },
};

/** @param {(store: any) => Promise<void>} fn */
async function withStore(fn) {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  try {
    for (let i = 0; i < 5; i++) await store.entity('Item').create({ id: `i${i}`, v: i });
    await store.entity('Child').create({ id: 'c0', ownerId: 'i1', n: 1 });
    await store.entity('Child').create({ id: 'c1', ownerId: 'i1', n: 2 });
    for (const id of ['a', 'b']) await store.collection('docs').put({ id });
    await fn(store);
  }
  finally {
    await store.close();
  }
}

/** A refusal with `code` whose message carries `pattern`.
 * @param {string} code @param {RegExp} pattern */
const refusal = (code, pattern) => (/** @type {any} */ error) => {
  assert.equal(error.code, code, error.message);
  assert.match(error.message, pattern);
  return true;
};
/** @param {() => any} call */
const later = (call) => Promise.resolve().then(call);

describe('a graph-load specification', () => {
  it('refuses a member no node reads, naming the nearest one', async () => {
    await withStore(async (store) => {
      const items = store.entity('Item');
      assert.deepEqual(await items.load({ where: { $eq: ['$it.v', 1] } }), [{ id: 'i1', v: 1 }]);
      await assert.rejects(later(() => items.load({ wher: { $eq: ['$it.v', 1] } })), refusal('JD0032', /'wher'.*did you mean 'where'/));
      await assert.rejects(later(() => items.load({ orderby: '$it.v' })), refusal('JD0032', /'orderby'.*did you mean 'orderBy'/));
      await assert.rejects(later(() => items.load({ include: { children: { wher: { $eq: ['$it.n', 1] } } } })),
        refusal('JD0032', /'wher'.*did you mean 'where'.*children/));
      // the depth bound is the whole graph's, declared once at the root
      await assert.rejects(later(() => items.load({ include: { children: { maxDepth: 2 } } })), refusal('JD0032', /'maxDepth'/));
      await assert.rejects(later(() => items.page({ wher: { $eq: ['$it.v', 1] } }, { limit: 2 })), refusal('JD0032', /'wher'/));
      await assert.rejects(later(async () => {
        for await (const doc of items.loadCursor({ wher: { $eq: ['$it.v', 1] } })) assert.fail(`loaded ${JSON.stringify(doc)}`);
      }), refusal('JD0032', /'wher'/));
      await assert.rejects(later(() => items.explainLoad({ wher: { $eq: ['$it.v', 1] } })), refusal('JD0032', /'wher'/));
    });
  });

  it('is a plain object, and so is every include and its specification', async () => {
    await withStore(async (store) => {
      const items = store.entity('Item');
      for (const spec of [null, 'x', 7, ['where']])
        await assert.rejects(later(() => items.load(spec)), refusal('JD0032', /plain object/), JSON.stringify(spec));
      await assert.rejects(later(() => items.load({ include: 'children' })), refusal('JD0032', /plain object/));
      for (const child of [null, false, 'x'])
        await assert.rejects(later(() => items.load({ include: { children: child } })), refusal('JD0032', /children/), JSON.stringify(child));
      assert.equal((await items.load()).length, 5);
      assert.equal((await items.load({})).length, 5);
    });
  });

  it('keeps every member a node reads, with its answer', async () => {
    await withStore(async (store) => {
      const items = store.entity('Item');
      const loaded = await items.load({ where: { $eq: ['$it.id', 'i1'] }, orderBy: '$it.v', take: 1, skip: 0, maxDepth: 2,
        include: { children: { where: { $ge: ['$it.n', 1] }, orderBy: '$it.n', take: 5, skip: 0, maxRows: 10, maxBytes: 4096 } } });
      assert.deepEqual(loaded, [{ id: 'i1', v: 1, children: [{ id: 'c0', ownerId: 'i1', n: 1 }, { id: 'c1', ownerId: 'i1', n: 2 }] }]);
      assert.deepEqual(await items.load({ where: { $eq: ['$it.id', 'i1'] }, include: { children: { count: true } } }),
        [{ id: 'i1', v: 1, children: 2 }]);
      assert.deepEqual(await items.load({ where: { $eq: ['$it.id', 'i1'] }, include: { children: true } }),
        [{ id: 'i1', v: 1, children: [{ id: 'c0', ownerId: 'i1', n: 1 }, { id: 'c1', ownerId: 'i1', n: 2 }] }]);
    });
  });
});

describe('the options of load, execute and query', () => {
  it('refuse a member they do not read, as all() and page() do', async () => {
    await withStore(async (store) => {
      const items = store.entity('Item');
      await assert.rejects(later(() => items.load({}, { signl: 1 })), refusal('JD0013', /'signl'.*did you mean 'signal'/));
      await assert.rejects(later(() => items.load({}, 'x')), refusal('JD0013', /plain object/));
      assert.equal((await items.load({}, { signal: new AbortController().signal, profile: undefined })).length, 5);

      const docs = store.collection('docs');
      const q = { $for: { it: '$[*]' }, $return: '$it.id' };
      await assert.rejects(later(() => docs.execute(q, { profle: { maxRows: 0 } })), refusal('JD0013', /'profle'.*did you mean 'profile'/));
      await assert.rejects(later(() => docs.execute(q, { signl: 1 })), refusal('JD0013', /'signl'/));
      await assert.rejects(later(() => docs.execute(q, 'x')), refusal('JD0013', /plain object/));
      // a whole answer has no stream to hold to: the cursor's option is misuse here
      await assert.rejects(later(() => docs.execute(q, { strictStreaming: true })), refusal('JD0013', /strictStreaming/));
      await assert.rejects(later(async () => {
        for await (const id of docs.query(q, { strictStreamin: true })) assert.fail(`yielded ${id}`);
      }), refusal('JD0013', /'strictStreamin'.*did you mean 'strictStreaming'/));
      assert.deepEqual(await docs.execute(q, { externals: {}, strict: true, pushdown: true, strictStreaming: false,
        signal: new AbortController().signal, deadline: Date.now() + 60_000 }), ['a', 'b']);
      const seen = [];
      for await (const id of docs.query(q, { strictStreaming: true, externals: {}, pushdown: true })) seen.push(id);
      assert.deepEqual(seen, ['a', 'b']);
    });
  });
});

describe('the options of the other read calls', () => {
  const q = { $for: { it: '$.Item[*]' }, $where: { $eq: ['$it.v', 1] }, $return: '$it.id' };
  const dq = { $for: { it: '$[*]' }, $return: '$it.id' };
  /** @param {AsyncIterable<any>} cursor */
  const drain = async (cursor) => {
    const items = [];
    for await (const item of cursor) items.push(item);
    return items;
  };

  it('refuse a member they do not read, naming the nearest one', async () => {
    await withStore(async (store) => {
      const items = store.entity('Item');
      const docs = store.collection('docs');
      await assert.rejects(later(() => items.execute(q, { profle: {} })), refusal('JD0013', /'profle'.*did you mean 'profile'/));
      await assert.rejects(later(() => items.execute(q, 'x')), refusal('JD0013', /plain object/));
      // a whole answer has no stream to hold to, on an entity as on a collection
      await assert.rejects(later(() => items.execute(q, { strictStreaming: true })), refusal('JD0013', /strictStreaming/));
      await assert.rejects(later(() => drain(items.cursor(q, { strictStreamin: true }))),
        refusal('JD0013', /'strictStreamin'.*did you mean 'strictStreaming'/));
      await assert.rejects(later(() => items.explain(q, { externls: {} })), refusal('JD0013', /'externls'.*did you mean 'externals'/));
      await assert.rejects(later(() => drain(items.loadCursor({}, { signl: 1 }))), refusal('JD0013', /'signl'.*did you mean 'signal'/));
      await assert.rejects(later(() => docs.explain(dq, { profle: {} })), refusal('JD0013', /'profle'.*did you mean 'profile'/));
      // the explanation of a load reads the profile it explains under and nothing else: a misspelt profile is no profile at all,
      // and it said so by answering; a signal or a deadline was never read, so naming one is refused too
      await assert.rejects(later(() => items.explainLoad({}, { profle: 'safe' })), refusal('JD0013', /'profle'.*did you mean 'profile'/));
      await assert.rejects(later(() => items.explainLoad({}, { signal: new AbortController().signal })), refusal('JD0013', /'signal' is not one it reads/));
      await assert.rejects(later(() => items.explainLoad({}, 'x')), refusal('JD0013', /plain object/));

      // every member each call reads still answers
      const controls = { signal: new AbortController().signal, deadline: Date.now() + 60_000 };
      assert.equal(await items.execute(q, { externals: {}, strict: false, pushdown: true, strictStreaming: false, ...controls }), 'i1');
      assert.deepEqual(await drain(items.cursor(q, { tracking: false, strictStreaming: true, externals: {}, ...controls })), ['i1']);
      assert.equal((await items.explain(q, { externals: {}, strict: true, strictStreaming: true, tracking: true, ...controls })).mode,
        'native');
      assert.deepEqual((await drain(items.loadCursor({ where: { $eq: ['$it.v', 1] } }, { tracking: false, ...controls })))
        .map((/** @type {any} */ doc) => doc.id), ['i1']);
      assert.deepEqual(items.explainLoad({}, { profile: 'safe' }).budget.profile, { source: 'call', name: 'safe' });
      assert.equal((await docs.explain(dq, { externals: {}, strict: true, pushdown: true, strictStreaming: true, ...controls })).mode,
        'native');
    });
  });

  it('refuse a malformed control by code, as all() and page() do', async () => {
    await withStore(async (store) => {
      const items = store.entity('Item');
      const docs = store.collection('docs');
      for (const [name, options] of /** @type {const} */ ([['signal', { signal: 'x' }], ['deadline', { deadline: 'soon' }],
        ['externals', { externals: 'abc' }]])) {
        const pattern = new RegExp(`'${name}' must be`);
        await assert.rejects(later(() => docs.execute(dq, options)), refusal('JD0013', pattern), `execute ${name}`);
        await assert.rejects(later(() => drain(docs.query(dq, options))), refusal('JD0013', pattern), `query ${name}`);
        await assert.rejects(later(() => docs.explain(dq, options)), refusal('JD0013', pattern), `explain ${name}`);
        await assert.rejects(later(() => items.execute(q, options)), refusal('JD0013', pattern), `entity execute ${name}`);
        await assert.rejects(later(() => drain(items.cursor(q, options))), refusal('JD0013', pattern), `entity cursor ${name}`);
        await assert.rejects(later(() => items.explain(q, options)), refusal('JD0013', pattern), `entity explain ${name}`);
      }
      for (const [name, options] of /** @type {const} */ ([['signal', { signal: 5 }], ['deadline', { deadline: 'soon' }]])) {
        const pattern = new RegExp(`'${name}' must be`);
        await assert.rejects(later(() => items.load({}, options)), refusal('JD0013', pattern), `load ${name}`);
        await assert.rejects(later(() => drain(items.loadCursor({}, options))), refusal('JD0013', pattern), `loadCursor ${name}`);
      }
      await assert.rejects(later(() => drain(docs.query(dq, { strictStreaming: 'yes' }))),
        refusal('JD0013', /'strictStreaming' must be true or false/));
    });
  });
});
