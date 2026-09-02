//@ts-check
/**
 * @file One profile, every engine (MODEL-FORMAT §8): the same profile
 * applies to collection, entity, graph, include and store-root
 * execution with the same refusal; an entity residual that would fetch
 * every referenced root is refused before the fetch under
 * `refuseFullScan`; a budget the engine counts is enforced and one it
 * cannot count is refused on plan shape or reported unavailable, never
 * estimated; `explain()` names the profile and the budgets that applied;
 * and `signal`/`deadline` are honoured before a statement and at every
 * row boundary.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { statementCountingDriver } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, tenant: { type: 'string' }, n: { type: 'integer' }, body: { type: 'string' } } },
      key: '/id',
      indexes: [{ name: 'by_tenant', path: '$.tenant' }],
    },
  },
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer', 'x-entity': { key: true } },
          tenant: { type: 'string', 'x-entity': { index: true } },
          age: { type: 'integer' },
          body: { type: 'string' },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'authorId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true } },
          tenant: { type: 'string' },
          authorId: { type: 'integer' },
          title: { type: 'string' },
          comments: { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } },
        },
      },
    },
    Comment: {
      schema: {
        type: 'object',
        required: ['cid'],
        properties: { cid: { type: 'integer', 'x-entity': { key: true } }, postId: { type: 'integer' } },
      },
    },
  },
};

/** Two tenants, `a` and `b`, three users and six posts each side. */
async function seeded(options = {}) {
  const counters = { iterate: 0, next: 0, return: 0, all: 0 };
  const store = await openStore(MODEL, { driver: statementCountingDriver(counters), ...options });
  const sync = store.sync;
  sync.transaction(() => {
    let pid = 1;
    for (const tenant of ['a', 'b']) {
      for (let i = 1; i <= 3; i++) {
        const id = tenant === 'a' ? i : 10 + i;
        sync.collection('docs').insert({ id: `${tenant}${i}`, tenant, n: i, body: 'x'.repeat(i === 3 ? 400 : 8) });
        sync.entity('User').create({ id, tenant, age: 20 + i, body: 'x'.repeat(i === 3 ? 400 : 8) });
        for (let p = 0; p < 2; p++) sync.entity('Post').create({ pid: pid++, tenant, authorId: id, title: `t${pid}` });
      }
    }
  });
  for (const key of Object.keys(counters)) counters[key] = 0;
  return { store, counters };
}

const codeIs = (code, pattern = undefined) => (error) =>
  error.code === code && (pattern === undefined || pattern.test(error.message));

const TENANT_A = {
  collections: ['docs', 'User', 'Post'],
  predicates: {
    docs: { $eq: ['$it.tenant', 'a'] },
    User: { $eq: ['$it.tenant', 'a'] },
    Post: { $eq: ['$it.tenant', 'a'] },
  },
  maxRows: 10,
};

describe('a profile applies identically to collection, entity, graph, include and store-root execution', () => {
  it('the mandatory predicate binds every engine\'s fetch, and the allow-list refuses each with one code', async () => {
    const { store } = await seeded();
    const profile = TENANT_A;
    // the collection
    const docs = await Promise.resolve(store.collection('docs').execute(
      { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' }, { profile }));
    assert.deepStrictEqual(docs, ['a1', 'a2', 'a3']);
    // the entity engine, native and residual, through the set and the store root
    const users = store.entity('User');
    const native = { $for: { u: '$.User[*]' }, $orderby: ['$u.id'], $return: '$u' };
    const residual = { $for: { u: '$.User[*]' }, $let: { k: 1 }, $orderby: ['$u.id'], $return: '$u' };
    for (const document of [native, residual]) {
      const viaSet = await Promise.resolve(users.execute(document, { profile }));
      const viaRoot = await Promise.resolve(store.execute(document, { profile }));
      assert.deepStrictEqual(viaSet.map((u) => u.id), [1, 2, 3], JSON.stringify(document));
      assert.deepStrictEqual(viaRoot, viaSet);
      const streamed = [];
      for await (const u of users.cursor(document, { profile })) streamed.push(u.id);
      assert.deepStrictEqual(streamed, [1, 2, 3]);
    }
    // the graph: the root and every include wear their entity's predicate
    const spec = { orderBy: '$it.id', include: { posts: true } };
    const loaded = [];
    for await (const u of users.loadCursor(spec, { profile })) loaded.push(u);
    assert.deepStrictEqual(loaded.map((u) => [u.id, u.posts.map((p) => p.tenant)]),
      [[1, ['a', 'a']], [2, ['a', 'a']], [3, ['a', 'a']]]);
    const page = await users.page(spec, { profile, limit: 2 });
    assert.deepStrictEqual(page.items.map((u) => u.id), [1, 2]);
    assert.strictEqual(users.explainLoad(spec, { profile }).budget.rows, 10);
    // the store-level profile reaches load() too
    const narrowed = await openStore(MODEL, { driver: nodeDriver(), profile: { ...profile } });
    await narrowed.entity('User').create({ id: 99, tenant: 'b', age: 1 });
    await narrowed.entity('User').create({ id: 98, tenant: 'a', age: 1 });
    assert.deepStrictEqual((await narrowed.entity('User').asNoTracking().load()).map((u) => u.id), [98]);
    await narrowed.close();

    // the allow-list: the same code and the same shape of reason, per engine
    const denied = { collections: ['docs', 'User'] };
    await assert.rejects(async () => (store.entity('Post').execute(
      { $for: { p: '$.Post[*]' }, $return: '$p' }, { profile: denied })),
    codeIs('JD0011', /does not allow querying entity 'Post'/));
    await assert.rejects(async () => (store.execute(
      { $for: { p: '$.Post[*]' }, $return: '$p' }, { profile: denied })),
    codeIs('JD0011', /does not allow querying entity 'Post'/));
    assert.throws(() => users.cursor({ $for: { p: '$.Post[*]' }, $return: '$p' }, { profile: denied }),
      codeIs('JD0011', /does not allow querying entity 'Post'/));
    assert.throws(() => users.explainLoad({ include: { posts: true } }, { profile: denied }),
      codeIs('JD0011', /does not allow loading entity 'Post' \(include path: posts\)/));
    await assert.rejects(() => users.page({ include: { posts: true } }, { profile: denied }),
      codeIs('JD0011', /does not allow loading entity 'Post'/));
    await assert.rejects(async () => (store.collection('docs').execute(
      { $for: { it: '$[*]' }, $return: '$it' }, { profile: { collections: ['User'] } })),
    codeIs('JD0011', /does not allow querying collection 'docs'/));
    await store.close();
  });

  it('the row bound is counted on every engine: the native answer, the residual\'s input, the cursor, the load', async () => {
    const { store } = await seeded();
    const bounded = { maxRows: 4 };
    const rows = codeIs('JD2007', /maxRows bound of 4/);
    await assert.rejects(async () => (store.collection('docs').execute(
      { $for: { it: '$[*]' }, $return: '$it' }, { profile: bounded })), rows);
    await assert.rejects(async () => (store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $return: '$u' }, { profile: bounded })), rows);
    await assert.rejects(async () => (store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $let: { k: 1 }, $return: '$u' }, { profile: bounded })), rows);
    await assert.rejects(async () => {
      for await (const u of store.entity('User').cursor({ $for: { u: '$.User[*]' }, $return: '$u' }, { profile: bounded })) void u;
    }, rows);
    await assert.rejects(async () => {
      for await (const u of store.entity('User').loadCursor({}, { profile: bounded })) void u;
    }, codeIs('JD2007', /the load crossed the profile's maxRows bound of 4/));
    await assert.rejects(() => store.entity('User').page({}, { profile: bounded, limit: 10 }), codeIs('JD2007'));
    // within the bound, every engine answers
    const within = { maxRows: 6 };
    assert.strictEqual((await Promise.resolve(store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $return: '$u' }, { profile: within }))).length, 6);
    assert.strictEqual((await store.entity('User').page({}, { profile: within, limit: 5 })).items.length, 5);
    await store.close();
  });
});

describe('refusal of an unbounded residual fetch', () => {
  it('an entity residual that would fetch every referenced root is refused, coded, before the fetch', async () => {
    const { store, counters } = await seeded();
    const profile = { refuseFullScan: true };
    const residual = { $for: { u: '$.User[*]' }, $let: { k: 1 }, $return: '$u' };
    const refusal = codeIs('JD0011', /refuses a full-table scan, and the residual this document needs fetches every row of User \('\$let'/);
    await assert.rejects(async () => (store.entity('User').execute(residual, { profile })), refusal);
    assert.throws(() => store.entity('User').cursor(residual, { profile }), refusal);
    await assert.rejects(() => store.entity('User').explain(residual, { profile }), refusal);
    assert.strictEqual(counters.all + counters.iterate, 0, 'nothing was fetched');
    // a native plan without an index is a scan by the database's own account
    await assert.rejects(async () => (store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $where: { $gt: ['$u.age', 1] }, $return: '$u' }, { profile })),
    codeIs('JD0011', /refuses a full-table scan of User \(SCAN t0/));
    // a native plan that seeks through the index runs
    const seeking = await Promise.resolve(store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $where: { $eq: ['$u.tenant', 'a'] }, $return: '$u' }, { profile }));
    assert.strictEqual(seeking.length, 3);
    await store.close();
  });
});

describe('a budget the engine counts is enforced; one it cannot count is refused on shape or reported unavailable', () => {
  it('the graph caps are hard maxima, the byte bound is per item, and the driver slots are named unavailable', async () => {
    const { store } = await seeded();
    const users = store.entity('User');
    assert.throws(() => users.explainLoad({ include: { posts: { maxRows: 5 } } }, { profile: { maxIncludedRows: 2 } }),
      codeIs('JD0011', /caps included rows per root at 2; the include 'posts' declares 5/));
    assert.throws(() => users.explainLoad({ include: { posts: { maxRows: Infinity } } }, { profile: { maxIncludedRows: 2 } }),
      codeIs('JD0011', /declares no bound \(Infinity\)/));
    assert.strictEqual(users.explainLoad({ include: { posts: { take: 2 } } }, { profile: { maxIncludedRows: 2 } }).budget.includedRows, 2);
    assert.throws(() => users.explainLoad({ include: { posts: { include: { comments: true } } } }, { profile: { maxDepth: 1 } }),
      codeIs('JD0011', /caps the include depth at 1; this load asks for 3/));
    const tiny = { maxBytes: 100 };
    const bytes = codeIs('JD2076', /exceeds the profile's maxBytes bound of 100/);
    await assert.rejects(async () => (store.collection('docs').execute(
      { $for: { it: '$[*]' }, $return: '$it' }, { profile: tiny })), bytes);
    await assert.rejects(async () => {
      for await (const d of store.collection('docs').query({ $for: { it: '$[*]' }, $return: '$it' }, { profile: tiny })) void d;
    }, bytes);
    await assert.rejects(async () => (users.execute({ $for: { u: '$.User[*]' }, $return: '$u' }, { profile: tiny })), bytes);
    await assert.rejects(async () => {
      for await (const u of users.loadCursor({}, { profile: tiny })) void u;
    }, bytes);
    // D6: the slots SQLite cannot fill are declared, not guessed
    assert.strictEqual(store.capabilities.statementTimeout, false);
    const explained = await store.collection('docs').explain(
      { $for: { it: '$[*]' }, $return: '$it' }, { profile: { refuseFullScan: true, maxRows: 7 } });
    assert.deepStrictEqual(explained.budget, {
      profile: { source: 'call', name: 'custom' },
      rows: 7, includedRows: null, depth: null, bytes: null,
      limits: { sequenceItems: 100_000, resultItems: 10_000, steps: 1_000_000, depth: 32 },
      scan: 'refused-by-shape', time: 'unavailable', estimatedRows: 'unavailable',
    });
    await store.close();
  });

  it('no estimated-row arithmetic exists anywhere in the engines', () => {
    for (const file of fs.readdirSync('packages/db/src').filter((name) => name.endsWith('.js'))) {
      const source = fs.readFileSync(`packages/db/src/${file}`, 'utf8');
      const sites = source.split('\n').filter((line) => /estimat/i.test(line) && !/^\s*(\/\/|\*)/.test(line));
      for (const line of sites) {
        assert.match(line, /estimatedRows: capabilities\?\.rowEstimates|rowEstimates: false|'unavailable'|\* /,
          `${file}: ${line.trim()} — a row estimate is a capability slot, never a computed number`);
      }
    }
  });
});

describe('explain() names the profile that applied and the budgets imposed', () => {
  it('store-level and per-call profiles are told apart, and no profile is null', async () => {
    const { store } = await seeded({ profile: 'safe' });
    const document = { $for: { u: '$.User[*]' }, $return: '$u' };
    const stored = await store.entity('User').explain(document);
    assert.deepStrictEqual(stored.budget.profile, { source: 'store', name: 'safe' });
    assert.strictEqual(stored.budget.rows, 1000);
    const called = await store.entity('User').explain(document, { profile: { maxRows: 3 } });
    assert.deepStrictEqual([called.budget.profile, called.budget.rows], [{ source: 'call', name: 'custom' }, 3]);
    assert.deepStrictEqual(store.entity('User').explainLoad({}).budget.profile, { source: 'store', name: 'safe' });
    await store.close();
    const plain = await openStore(MODEL, { driver: nodeDriver() });
    const none = await plain.collection('docs').explain({ $for: { it: '$[*]' }, $return: '$it' });
    assert.deepStrictEqual(none.budget, {
      profile: null, rows: null, includedRows: null, depth: null, bytes: null, limits: null,
      scan: 'unbounded', time: 'unavailable', estimatedRows: 'unavailable',
    });
    await plain.close();
  });
});

describe('signal and deadline are declared per call and honoured', () => {
  it('an aborted call and a passed deadline issue no statement; a cursor checks the deadline at every row', async () => {
    const { store, counters } = await seeded();
    const aborted = AbortSignal.abort();
    const document = { $for: { u: '$.User[*]' }, $return: '$u' };
    await assert.rejects(async () => (store.entity('User').execute(document, { signal: aborted })), codeIs('JD2072'));
    await assert.rejects(async () => (store.collection('docs').execute({ $for: { it: '$[*]' }, $return: '$it' }, { signal: aborted })), codeIs('JD2072'));
    assert.throws(() => store.entity('User').cursor(document, { deadline: Date.now() - 1 }), codeIs('JD2075', /passed before the call ran/));
    await assert.rejects(() => store.entity('User').page({}, { deadline: Date.now() - 1 }), codeIs('JD2075'));
    assert.strictEqual(counters.all + counters.iterate, 0, 'no statement ran for any of them');
    assert.throws(() => store.entity('User').cursor(document, { deadline: /** @type {any} */ ('soon') }), TypeError);
    const soon = store.entity('User').cursor(document, { deadline: Date.now() + 40 });
    assert.strictEqual((await soon.next()).done, false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await assert.rejects(() => soon.next(), codeIs('JD2075', /passed before the next row/));
    assert.strictEqual(counters.return, 1, 'released at the row boundary');
    await store.close();
  });
});
