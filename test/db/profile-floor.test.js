//@ts-check
/**
 * @file The store's profile is a floor under every per-call one
 * (MODEL-FORMAT §8): a call's `profile` can lower the store's bounds, add
 * predicates and narrow its allow-lists, and a member that would widen what
 * the store admits is refused `JD0011`, named. Every read surface that takes
 * a per-call profile keeps the store's mandatory predicate under it —
 * collection `execute`, `query`, `explain` and `all`, entity `load`,
 * `loadCursor`, `page` and `explainLoad`, store-root `execute` — and a store
 * opened with no profile runs a call's profile as it always did.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: { type: 'string' }, tenant: { type: 'string' }, n: { type: 'integer' } } },
      key: '/id',
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
        },
      },
    },
  },
};

const BY_TENANT = { $eq: ['$it.tenant', '$tenant'] };
const TENANT_A = { $eq: ['$it.tenant', 'a'] };
const IDS = { $for: { it: '$[*]' }, $return: '$it.id' };
const USER_IDS = { $for: { u: '$.User[*]' }, $return: '$u.id' };
const A = { tenant: 'a' };

/** A store holding two tenants' rows in each root.
 * @param {any} profile - `undefined` opens the store with none */
async function seeded(profile) {
  const store = await openStore(MODEL, { driver: nodeDriver(), ...(profile === undefined ? {} : { profile }) });
  store.sync.transaction(() => {
    for (const [i, tenant] of ['a', 'b', 'a', 'b'].entries()) {
      store.sync.collection('docs').insert({ id: `${tenant}${i}`, tenant, n: i });
      store.sync.entity('User').create({ id: i + 1, tenant, age: 20 + i });
    }
  });
  return store;
}

/** @param {any} answer */
const asList = (answer) => (Array.isArray(answer) ? answer : answer === undefined ? [] : [answer]);

describe('a per-call profile keeps the store\'s mandatory predicate', () => {
  it('on a collection: execute, query, explain and all', async () => {
    const store = await seeded({ externals: ['tenant'], predicates: { docs: BY_TENANT } });
    const docs = store.collection('docs');
    try {
      assert.deepStrictEqual(await docs.execute(IDS, { externals: A, profile: { maxRows: 50 } }), ['a0', 'a2']);
      assert.deepStrictEqual(store.sync.collection('docs').execute(IDS, { externals: A, profile: { maxRows: 50 } }),
        ['a0', 'a2']);
      const pulled = [];
      for await (const id of docs.query(IDS, { externals: A, profile: { maxRows: 50 } })) pulled.push(id);
      assert.deepStrictEqual(pulled, ['a0', 'a2']);
      const plan = await docs.explain(IDS, { externals: A, profile: { maxRows: 50 } });
      assert.strictEqual(plan.budget.rows, 50);
      assert.match(plan.sql, /tenant/);
      await store.transaction(async (tx) => {
        assert.deepStrictEqual(await tx.collection('docs').execute(IDS, { externals: A, profile: { maxRows: 50 } }),
          ['a0', 'a2']);
      });
    }
    finally { await store.close(); }
  });

  it('on an entity: store execute, load, loadCursor, page and explainLoad; a collection\'s all', async () => {
    const store = await seeded({ predicates: { User: TENANT_A, docs: TENANT_A } });
    const users = store.entity('User');
    const narrowed = { profile: { maxRows: 50 } };
    try {
      assert.deepStrictEqual(await store.execute(USER_IDS, narrowed), [1, 3]);
      assert.deepStrictEqual(store.sync.execute(USER_IDS, narrowed), [1, 3]);
      assert.deepStrictEqual((await users.load({}, narrowed)).map((/** @type {any} */ u) => u.id), [1, 3]);
      assert.deepStrictEqual((await users.asNoTracking().load({}, narrowed)).map((/** @type {any} */ u) => u.id), [1, 3]);
      const pulled = [];
      for await (const user of users.loadCursor({}, narrowed)) pulled.push(user.id);
      assert.deepStrictEqual(pulled, [1, 3]);
      const page = await users.page({ orderBy: '$it.id' }, { limit: 10, ...narrowed });
      assert.deepStrictEqual(page.items.map((/** @type {any} */ u) => u.id), [1, 3]);
      assert.match(users.explainLoad({}, narrowed).sql, /tenant/);
      assert.deepStrictEqual((await store.collection('docs').all({ profile: { maxRows: 50 } }))
        .map((/** @type {any} */ doc) => doc.id), ['a0', 'a2']);
    }
    finally { await store.close(); }
  });

  it('conjoins a per-call predicate with the store\'s, and lowers the row bound', async () => {
    const store = await seeded({ externals: ['tenant'], predicates: { docs: BY_TENANT, User: TENANT_A } });
    try {
      assert.deepStrictEqual(await store.collection('docs').execute(IDS,
        { externals: A, profile: { predicates: { docs: { $gt: ['$it.n', 0] } } } }), 'a2');
      // a per-call predicate that would keep every row keeps only the store's
      assert.deepStrictEqual(await store.collection('docs').execute(IDS,
        { externals: A, profile: { predicates: { docs: { $exists: '$it.id' } } } }), ['a0', 'a2']);
      assert.deepStrictEqual(await store.execute(USER_IDS,
        { profile: { predicates: { User: { $ge: ['$it.age', 22] } } } }), 3);
      await assert.rejects(async () => store.collection('docs').execute(IDS, { externals: A, profile: { maxRows: 1 } }),
        { code: 'JD2007' });
      await assert.rejects(async () => store.execute(USER_IDS, { profile: { maxRows: 1 } }), { code: 'JD2007' });
    }
    finally { await store.close(); }
  });
});

describe('a per-call profile that would widen the store\'s is refused, named', () => {
  const STORE = {
    externals: ['tenant'], functions: [], collections: ['docs', 'User'],
    predicates: { docs: BY_TENANT }, maxRows: 100, limits: { steps: 5000 },
    maxDepth: 2, members: { User: ['$.id', '$.age'] },
  };
  const WIDER = [
    [{ maxRows: 101 }, /asks maxRows 101, and the store's profile allows 100/],
    [{ limits: { steps: 5001 } }, /asks limits\.steps 5001, and the store's profile allows 5000/],
    [{ limits: { depth: 33 } }, /asks limits\.depth 33, and the store's profile allows 32/],
    [{ maxDepth: 3 }, /asks maxDepth 3, and the store's profile allows 2/],
    [{ maxDepth: null }, /asks maxDepth null, and the store's profile allows 2/],
    [{ externals: ['tenant', 'min'] }, /asks externals "min", and the store's profile allows \["tenant"\]/],
    [{ functions: ['f'] }, /asks functions "f"/],
    [{ collections: ['docs', 'other'] }, /asks collections "other"/],
    [{ collections: null }, /asks collections null/],
    [{ refuseFullScan: false }, /asks refuseFullScan false, and the store's profile allows true/,
      { refuseFullScan: true }],
    [{ members: { User: ['$.id', '$.tenant'] } }, /asks members\['User'\] "\$\.tenant"/],
    [{ members: null }, /asks members null/],
    ['safe', /asks limits\.steps 1000000, and the store's profile allows 5000/],
  ];
  for (const [profile, message, also] of WIDER) {
    it(`${JSON.stringify(profile)}`, async () => {
      const store = await seeded({ ...STORE, ...also });
      try {
        await assert.rejects(async () => store.collection('docs').execute(IDS, { externals: A, profile }),
          { code: 'JD0011', message });
        await assert.rejects(async () => store.execute({ $for: { u: '$.User[*]' }, $return: '$u.age' }, { profile }),
          { code: 'JD0011', message });
      }
      finally { await store.close(); }
    });
  }

  it('answers a call that narrows every member, or spells the store\'s own values', async () => {
    const store = await seeded(STORE);
    try {
      for (const profile of [
        { maxRows: 100, limits: { steps: 5000 }, maxDepth: 2, refuseFullScan: false, externals: ['tenant'] },
        { maxRows: 10, limits: { steps: 4000 }, maxDepth: 1, collections: ['docs'], functions: [] },
      ]) {
        assert.deepStrictEqual(await store.collection('docs').execute(IDS,
          { externals: A, profile, pushdown: true }), ['a0', 'a2'], JSON.stringify(profile));
      }
      // a narrower member list for a root
      assert.deepStrictEqual(await store.execute({ $for: { u: '$.User[*]' }, $return: '$u.age' },
        { profile: { members: { User: ['$.age'] } } }), [20, 21, 22, 23]);
      await assert.rejects(async () => store.execute({ $for: { u: '$.User[*]' }, $return: '$u.id' },
        { profile: { members: { User: ['$.age'] } } }), { code: 'JD0011', message: /does not allow the member 'id'/ });
      // a narrower collection list refuses the root it leaves out
      await assert.rejects(async () => store.execute(USER_IDS, { profile: { collections: ['docs'] } }),
        { code: 'JD0011' });
    }
    finally { await store.close(); }
  });
});

describe('a store opened with no profile runs a call\'s profile as before', () => {
  it('normalizes the call\'s profile over the safe defaults', async () => {
    const store = await seeded(undefined);
    try {
      assert.deepStrictEqual(asList(await store.collection('docs').execute(IDS)), ['a0', 'b1', 'a2', 'b3']);
      assert.deepStrictEqual(await store.collection('docs').execute(IDS,
        { externals: A, profile: { externals: ['tenant'], predicates: { docs: BY_TENANT } } }), ['a0', 'a2']);
      assert.deepStrictEqual(asList(await store.collection('docs').execute(IDS, { profile: { maxRows: 5000 } })),
        ['a0', 'b1', 'a2', 'b3']);
      await assert.rejects(async () => store.collection('docs').execute(IDS, { profile: { maxRows: 3 } }),
        { code: 'JD2007' });
      const plan = await store.collection('docs').explain(IDS, { profile: 'safe' });
      assert.deepStrictEqual(plan.budget.profile, { source: 'call', name: 'safe' });
    }
    finally { await store.close(); }
  });
});
