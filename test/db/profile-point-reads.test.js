//@ts-check
/**
 * @file A point read on a store opened with a profile answers the row of
 * its key only when the root's mandatory predicate keeps it
 * (MODEL-FORMAT §8): the collection `get` and the entity `get`, tracked and
 * untracked, asynchronous and synchronous, inside a transaction, and agreeing
 * row for row with the query engine's answer under the same predicate. A
 * predicate that names an external is bound by the read's own `externals`,
 * and a read that binds too few is refused. A root the profile keeps no
 * predicate for reads as it always did, and the store's own writes still
 * read the stored row.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, tenant: {}, n: { type: 'integer' } } },
      key: '/id',
    },
    counters: {
      schema: { type: 'object', properties: { id: { type: 'integer' }, tenant: { type: 'string' } } },
      key: '/id',
    },
    open: {
      schema: { type: 'object', properties: { id: { type: 'string' }, tenant: { type: 'string' } } },
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
          active: { type: 'boolean' },
        },
      },
    },
    Note: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer', 'x-entity': { key: true } }, tenant: { type: 'string' } },
      },
    },
  },
};

const TENANT_A = { $eq: ['$it.tenant', 'a'] };
const PROFILE = { predicates: { docs: TENANT_A, counters: TENANT_A, User: TENANT_A } };

/** A store with the profile, holding two tenants in every root.
 * @param {any} [profile] - `false` opens the store with none
 * @param {string} [path] - the database file, in memory when omitted */
async function seeded(profile = PROFILE, path = undefined) {
  const store = await openStore(MODEL, { driver: nodeDriver(), ...(path === undefined ? {} : { path }),
    ...(profile === false ? {} : { profile }) });
  const sync = store.sync;
  sync.transaction(() => {
    for (const tenant of ['a', 'b']) {
      sync.collection('docs').insert({ id: `${tenant}1`, tenant, n: 1 });
      sync.collection('open').insert({ id: `${tenant}1`, tenant });
      sync.collection('counters').insert({ id: tenant === 'a' ? 1 : 2, tenant });
      sync.entity('User').create({ id: tenant === 'a' ? 1 : 2, tenant, age: 30, active: true });
      sync.entity('Note').create({ id: tenant === 'a' ? 1 : 2, tenant });
    }
  });
  return store;
}

/** A file the stored rows can be read back from by a store with no profile —
 * the one reader a store profile, a floor, does not bound.
 * @param {(path: string) => Promise<void>} body */
async function onFile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-point-reads-'));
  try { await body(join(dir, 'store.sqlite')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The stored document of one key, read by a store with no profile.
 * @param {string} path @param {'collection' | 'entity'} kind @param {string} root @param {any} key */
async function storedAt(path, kind, root, key) {
  const bare = await openStore(MODEL, { driver: nodeDriver(), path });
  try { return await (kind === 'collection' ? bare.collection(root) : bare.entity(root)).get(key); }
  finally { await bare.close(); }
}

describe('a point read on a profiled store keeps the rows the mandatory predicate keeps', () => {
  it('answers a collection row of another tenant as absent, on every surface', async () => {
    const store = await seeded();
    try {
      assert.deepStrictEqual(await store.collection('docs').get('a1'), { id: 'a1', tenant: 'a', n: 1 });
      assert.strictEqual(await store.collection('docs').get('b1'), undefined);
      assert.strictEqual(await store.collection('docs').get('nobody'), undefined);
      assert.deepStrictEqual(store.sync.collection('docs').get('a1'), { id: 'a1', tenant: 'a', n: 1 });
      assert.strictEqual(store.sync.collection('docs').get('b1'), undefined);
      await store.transaction(async (tx) => {
        assert.deepStrictEqual(await tx.collection('docs').get('a1'), { id: 'a1', tenant: 'a', n: 1 });
        assert.strictEqual(await tx.collection('docs').get('b1'), undefined);
      });
      store.sync.transaction(() => {
        assert.strictEqual(store.sync.collection('docs').get('b1'), undefined);
        assert.strictEqual(store.sync.collection('docs').get('a1').tenant, 'a');
      });
    }
    finally { await store.close(); }
  });

  it('answers a numeric-keyed collection row of another tenant as absent', async () => {
    const store = await seeded();
    try {
      assert.deepStrictEqual(await store.collection('counters').get(1), { id: 1, tenant: 'a' });
      assert.strictEqual(await store.collection('counters').get(2), undefined);
      assert.strictEqual(store.sync.collection('counters').get(2), undefined);
    }
    finally { await store.close(); }
  });

  it('answers an entity row of another tenant as absent, tracked and untracked', async () => {
    const store = await seeded();
    try {
      const users = store.entity('User');
      assert.deepStrictEqual(await users.get(1), { id: 1, tenant: 'a', age: 30, active: true });
      assert.strictEqual(await users.get(2), undefined);
      assert.strictEqual(await users.asNoTracking().get(2), undefined);
      assert.strictEqual((await users.asNoTracking().get(1)).tenant, 'a');
      assert.strictEqual(store.sync.entity('User').get(2), undefined);
      assert.strictEqual(store.sync.entity('User').asNoTracking().get(2), undefined);
      assert.strictEqual(store.sync.entity('User').get(1).tenant, 'a');
      await store.transaction(async (tx) => {
        assert.strictEqual(await tx.entity('User').get(2), undefined);
        assert.strictEqual((await tx.entity('User').get(1)).tenant, 'a');
      });
    }
    finally { await store.close(); }
  });

  it('registers no snapshot for a row it answers as absent, and a tracked put of its key still writes', () => onFile(async (path) => {
    const store = await seeded(PROFILE, path);
    try {
      const users = store.entity('User');
      assert.strictEqual(await users.get(2), undefined);
      // the hidden row is not tracked, but a write is not a read: a tracked
      // put of the same key still replaces the stored row
      users.put({ id: 2, tenant: 'b', age: 99, active: false });
      await store.saveChanges();
      assert.strictEqual(store.sync.entity('User').get(1).age, 30);
    }
    finally { await store.close(); }
    assert.deepStrictEqual(await storedAt(path, 'entity', 'User', 2), { id: 2, tenant: 'b', age: 99, active: false });
  }));

  it('leaves a root the profile keeps no predicate for, and a store with no profile, unchanged', async () => {
    const store = await seeded();
    try {
      assert.strictEqual((await store.collection('open').get('b1')).tenant, 'b');
      assert.strictEqual((await store.entity('Note').get(2)).tenant, 'b');
    }
    finally { await store.close(); }
    const bare = await seeded(false);
    try {
      assert.strictEqual((await bare.collection('docs').get('b1')).tenant, 'b');
      assert.strictEqual((await bare.entity('User').get(2)).tenant, 'b');
    }
    finally { await bare.close(); }
    const safe = await seeded('safe');
    try {
      assert.strictEqual((await safe.collection('docs').get('b1')).tenant, 'b');
    }
    finally { await safe.close(); }
  });

  it('does not change what the store reads for its own writes', () => onFile(async (path) => {
    const store = await seeded(PROFILE, path);
    try {
      // a patch, a put with a precondition and an entity update read the stored row, as a write must
      await store.collection('docs').patch('b1', [{ op: 'replace', path: '/n', value: 7 }]);
      await store.collection('docs').put({ id: 'b1', tenant: 'b', n: 8 }, undefined,
        { expect: { path: '/n', value: 7 } });
      assert.strictEqual((await store.entity('User').update(2, { age: 31 })).age, 31);
    }
    finally { await store.close(); }
    assert.strictEqual((await storedAt(path, 'collection', 'docs', 'b1')).n, 8);
  }));

  it('binds a predicate that names an external from the read\'s own externals, on every surface', async () => {
    const profile = { externals: ['tenant'],
      predicates: { docs: { $eq: ['$it.tenant', '$tenant'] }, User: { $eq: ['$it.tenant', '$tenant'] } } };
    const store = await seeded(profile);
    const A = { externals: { tenant: 'a' } };
    const B = { externals: { tenant: 'b' } };
    try {
      assert.strictEqual(await store.collection('docs').get('b1', A), undefined);
      assert.deepStrictEqual(await store.collection('docs').get('b1', B), { id: 'b1', tenant: 'b', n: 1 });
      assert.strictEqual(await store.collection('docs').get('nobody', A), undefined);
      assert.strictEqual(store.sync.collection('docs').get('b1', A), undefined);
      assert.strictEqual(store.sync.collection('docs').get('a1', A).tenant, 'a');
      const users = store.entity('User');
      assert.strictEqual(await users.get(2, A), undefined);
      assert.strictEqual((await users.get(2, B)).tenant, 'b');
      assert.strictEqual(await users.asNoTracking().get(2, A), undefined);
      assert.strictEqual((await users.asNoTracking().get(1, A)).tenant, 'a');
      assert.strictEqual(store.sync.entity('User').get(2, A), undefined);
      assert.strictEqual(store.sync.entity('User').asNoTracking().get(2, A), undefined);
      assert.strictEqual(store.sync.entity('User').get(1, A).tenant, 'a');
      await store.transaction(async (tx) => {
        assert.strictEqual(await tx.collection('docs').get('b1', A), undefined);
        assert.strictEqual((await tx.collection('docs').get('a1', A)).tenant, 'a');
        assert.strictEqual(await tx.entity('User').get(2, A), undefined);
        assert.strictEqual((await tx.entity('User').asNoTracking().get(1, A)).tenant, 'a');
      });
      store.sync.transaction(() => {
        assert.strictEqual(store.sync.collection('docs').get('b1', A), undefined);
        assert.strictEqual(store.sync.entity('User').get(2, A), undefined);
      });
      // the query that supplies the same external keeps the same rows
      assert.deepStrictEqual(await store.collection('docs').execute(
        { $for: { it: '$[*]' }, $return: '$it.id' }, A), 'a1');
    }
    finally { await store.close(); }
  });

  it('refuses a point read that does not bind the external its predicate names, before reading the row', async () => {
    const profile = { externals: ['tenant'],
      predicates: { docs: { $eq: ['$it.tenant', '$tenant'] }, User: { $eq: ['$it.tenant', '$tenant'] } } };
    const store = await seeded(profile);
    const refused = { code: 'JD0011',
      message: /the profile's predicate for '(docs|User)' cannot bind '\$tenant' for this point read/ };
    try {
      // a key that holds a row and one that holds nothing answer alike: the
      // refusal does not tell another tenant's key from a missing one
      await assert.rejects(async () => store.collection('docs').get('b1'), refused);
      await assert.rejects(async () => store.collection('docs').get('nobody'), refused);
      await assert.rejects(async () => store.collection('docs').get('b1', { externals: { other: 'a' } }), refused);
      await assert.rejects(async () => store.collection('docs').get('b1', { externals: { tenant: undefined } }), refused);
      // a value the database compares otherwise than the engine, or cannot bind
      await assert.rejects(async () => store.collection('docs').get('b1', { externals: { tenant: null } }), refused);
      await assert.rejects(async () => store.collection('docs').get('b1', { externals: { tenant: true } }), refused);
      await assert.rejects(async () => store.collection('docs').get('b1', { externals: { tenant: ['b', null] } }),
        refused);
      assert.throws(() => store.sync.collection('docs').get('b1'), refused);
      await assert.rejects(async () => store.entity('User').get(2), refused);
      await assert.rejects(async () => store.entity('User').asNoTracking().get(2), refused);
      assert.throws(() => store.sync.entity('User').get(2), refused);
      assert.throws(() => store.sync.entity('User').asNoTracking().get(2), refused);
      // the query engines refuse the same call the same way
      await assert.rejects(async () => store.collection('docs').execute({ $for: { it: '$[*]' }, $return: '$it.id' }),
        { code: 'JD0011', message: /the profile's predicate for 'docs' cannot bind '\$tenant'/ });
      await assert.rejects(async () => {
        for await (const id of store.collection('docs').query({ $for: { it: '$[*]' }, $return: '$it.id' })) void id;
      }, { code: 'JD0011', message: /the profile's predicate for 'docs' cannot bind '\$tenant'/ });
      await assert.rejects(async () => store.execute({ $for: { u: '$.User[*]' }, $return: '$u.id' }),
        { code: 'JD0011', message: /the profile's predicate for 'User' cannot bind '\$tenant'/ });
      // an external a comparison reads otherwise than it stands for is refused as the query engines refuse it
      await assert.rejects(async () => store.collection('docs').get('a1', { externals: { tenant: new Date(0) } }),
        { code: 'JD0041', message: /collection\('docs'\)\.get external '\$tenant' holds a Date instance/ });
      await assert.rejects(async () => store.collection('docs').execute({ $for: { it: '$[*]' }, $return: '$it.id' },
        { externals: { tenant: new Date(0) } }), { code: 'JD0041' });
    }
    finally { await store.close(); }
  });

  it('refuses a point read of a root with a member allow-list, which answers the whole document', async () => {
    const store = await seeded({ members: { docs: ['$.id'], User: ['$.id', '$.age'] } });
    try {
      await assert.rejects(async () => store.collection('docs').get('a1'), { code: 'JD0011',
        message: /the profile allows only the members \(\$\.id\) of 'docs', and a point read answers the whole document/ });
      assert.throws(() => store.sync.collection('docs').get('a1'), { code: 'JD0011' });
      await assert.rejects(async () => store.entity('User').get(1), { code: 'JD0011',
        message: /the profile allows only the members \(\$\.id, \$\.age\) of 'User'/ });
      assert.throws(() => store.sync.entity('User').asNoTracking().get(1), { code: 'JD0011' });
      // the query the policy allows still answers, and a root it does not name reads as stored
      assert.deepStrictEqual(await store.collection('docs').execute({ $for: { it: '$[*]' }, $return: '$it.id' }),
        ['a1', 'b1']);
      assert.strictEqual((await store.collection('open').get('b1')).tenant, 'b');
      assert.strictEqual((await store.entity('Note').get(2)).tenant, 'b');
    }
    finally { await store.close(); }
  });

  it('judges a point read by the predicate whatever the profile\'s engine limits are', async () => {
    const store = await seeded({ limits: { steps: 1, depth: 1 }, predicates: { docs: {
      $and: [TENANT_A, { $ne: ['$it.id', 'zz'] }] } } });
    try {
      assert.strictEqual((await store.collection('docs').get('a1')).tenant, 'a');
      assert.strictEqual(await store.collection('docs').get('b1'), undefined);
    }
    finally { await store.close(); }
  });
});

describe('a point read agrees with the query engine row for row under one predicate', () => {
  /** Rows a predicate meets in every shape a member can take. */
  const SHAPES = [
    { id: 'm1', tenant: 'a', n: 1 },
    { id: 'm2', tenant: 'b', n: 2 },
    { id: 'm3', n: 3 },
    { id: 'm4', tenant: null, n: 4 },
    { id: 'm5', tenant: 5, n: 5 },
    { id: 'm6', tenant: 'a' },
    { id: 'm7', tenant: 'A', n: 7 },
    { id: 'm8', tenant: '', n: 8 },
  ];
  const PREDICATES = {
    equals: { $eq: ['$it.tenant', 'a'] },
    differs: { $ne: ['$it.tenant', 'a'] },
    negated: { $not: { $eq: ['$it.tenant', 'a'] } },
    both: { $and: [{ $eq: ['$it.tenant', 'a'] }, { $gt: ['$it.n', 0] }] },
    either: { $or: [{ $eq: ['$it.tenant', 'b'] }, { $ge: ['$it.n', 7] }] },
    above: { $gt: ['$it.n', 3] },
    present: { $exists: '$it.n' },
  };

  for (const [name, predicate] of Object.entries(PREDICATES)) {
    it(`the collection, ${name}`, async () => {
      const profile = { predicates: { docs: predicate } };
      const store = await openStore(MODEL, { driver: nodeDriver(), profile });
      try {
        for (const doc of SHAPES) store.sync.collection('docs').insert(doc);
        const seen = await store.collection('docs').execute(
          { $for: { it: '$[*]' }, $return: '$it.id' });
        const ids = Array.isArray(seen) ? seen : seen === undefined ? [] : [seen];
        for (const { id } of SHAPES) {
          const found = (await store.collection('docs').get(id)) !== undefined;
          assert.strictEqual(found, ids.includes(id), `${name}: ${id}`);
        }
        assert.ok(ids.length > 0 && ids.length < SHAPES.length, `${name} keeps some rows and drops some`);
      }
      finally { await store.close(); }
    });
  }

  const BOUND = {
    tenant: { $eq: ['$it.tenant', '$tenant'] },
    other: { $ne: ['$it.tenant', '$tenant'] },
    floor: { $and: [{ $eq: ['$it.tenant', '$tenant'] }, { $ge: ['$it.n', '$min'] }] },
    among: { $eq: ['$it.tenant', '$tenants[*]'] },
  };
  for (const [name, predicate] of Object.entries(BOUND)) {
    it(`the collection, ${name}, bound from the read's externals`, async () => {
      const profile = { externals: ['tenant', 'min', 'tenants'], predicates: { docs: predicate } };
      const store = await openStore(MODEL, { driver: nodeDriver(), profile });
      try {
        for (const doc of SHAPES) store.sync.collection('docs').insert(doc);
        for (const tenant of ['a', 'b', 'A', '', 5]) {
          const externals = { tenant, min: 2, tenants: [tenant, 'b'] };
          const seen = await store.collection('docs').execute({ $for: { it: '$[*]' }, $return: '$it.id' }, { externals });
          const ids = Array.isArray(seen) ? seen : seen === undefined ? [] : [seen];
          for (const { id } of SHAPES) {
            const found = (await store.collection('docs').get(id, { externals })) !== undefined;
            assert.strictEqual(found, ids.includes(id), `${name} ${JSON.stringify(tenant)}: ${id}`);
          }
        }
      }
      finally { await store.close(); }
    });
  }

  it('the entity, with the mapped columns', async () => {
    const predicates = [
      { $eq: ['$it.tenant', 'a'] },
      { $and: [{ $ge: ['$it.age', 30] }, { $eq: ['$it.active', true] }] },
      { $or: [{ $lt: ['$it.age', 20] }, { $not: { $eq: ['$it.tenant', 'a'] } }] },
    ];
    for (const predicate of predicates) {
      const store = await openStore(MODEL, { driver: nodeDriver(), profile: { predicates: { User: predicate } } });
      try {
        const rows = [
          { id: 1, tenant: 'a', age: 30, active: true }, { id: 2, tenant: 'b', age: 30, active: true },
          { id: 3, tenant: 'a', age: 10, active: false }, { id: 4, tenant: 'b', age: 41, active: false },
          { id: 5, tenant: 'a', age: 45, active: true }, { id: 6, tenant: 'c', age: 5, active: true },
        ];
        for (const row of rows) store.sync.entity('User').create(row);
        const seen = await store.execute({ $for: { u: '$.User[*]' }, $return: '$u.id' });
        const ids = Array.isArray(seen) ? seen : seen === undefined ? [] : [seen];
        for (const { id } of rows) {
          assert.strictEqual((await store.entity('User').get(id)) !== undefined, ids.includes(id),
            `${JSON.stringify(predicate)}: ${id}`);
        }
        assert.ok(ids.length > 0 && ids.length < rows.length, JSON.stringify(predicate));
      }
      finally { await store.close(); }
    }
  });
});
