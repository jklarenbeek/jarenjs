//@ts-check
/**
 * @file The D2 seam: a `@jarenjs/linq` chain executes against a
 * collection because the collection implements `execute(document,
 * options)` — contract-level coupling, no import edge in either
 * direction (asserted against both manifests). The same chains run
 * in-memory and against the store and must agree; `fromAsync` streams
 * the cursor.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { from, fromAsync } from '@jarenjs/linq';
import { compileJsonQuery } from '@jarenjs/json/query';
import { openStore, entityRoot } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const REGION = {
  type: 'Polygon',
  coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]],
};
const PLACES_MODEL = {
  $model: '0.1',
  collections: {
    places: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, at: { type: ['array', 'object'] } } },
      key: '/id',
      indexes: [{ name: 'by_box', path: '$.at', derive: 'bbox' }],
    },
  },
};
const PLACES = [
  { id: 'inside', at: [4.5, 52.5] },
  { id: 'vertex', at: [4, 52] },
  { id: 'far', at: [2.3522, 48.8566] },
];

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, name: { type: 'string' }, age: { type: 'integer' } } },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }],
    },
  },
};
const DATA = [
  { id: 'a', name: 'ada', age: 36 },
  { id: 'b', name: 'kid', age: 8 },
  { id: 'c', name: 'lin', age: 64 },
  { id: 'd', name: 'nil' },
];

async function seeded() {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  const users = store.collection('users');
  for (const row of DATA) await users.insert(row);
  return { store, users };
}

describe('a linq chain against a collection (D2)', () => {
  it('where/orderBy/select agree with the in-memory run', async () => {
    const { store, users } = await seeded();
    const chain = (source) => from(source)
      .where((u) => u.age.gt(20))
      .orderBy((u) => u.name)
      .select((u) => ({ who: u.name }));
    assert.deepStrictEqual(chain(users).toArray(), chain(DATA).toArray());
    await store.close();
  });

  it('terminals ride the native aggregates', async () => {
    const { store, users } = await seeded();
    assert.strictEqual(from(users).count(), from(DATA).count());
    assert.strictEqual(
      from(users).where((u) => u.age.gt(20)).count(),
      from(DATA).where((u) => u.age.gt(20)).count());
    assert.deepStrictEqual(
      from(users).orderBy((u) => u.age).skip(1).take(2).toArray(),
      from(DATA).orderBy((u) => u.age).skip(1).take(2).toArray());
    assert.strictEqual(
      from(users).where((u) => u.id.eq('a')).single().name,
      'ada');
    await store.close();
  });

  it('parameters flow as externals', async () => {
    const { store, users } = await seeded();
    const chain = (source) => from(source)
      .params({ min: 21 })
      .where((u, p) => u.age.ge(p.min))
      .select((u) => u.id);
    assert.deepStrictEqual(chain(users).toArray(), chain(DATA).toArray());
    await store.close();
  });

  it('fromAsync streams the cursor shape', async () => {
    const { store, users } = await seeded();
    const streamed = await fromAsync(
      users.query({ $for: { it: '$[*]' }, $orderby: ['$it.age'], $return: '$it' }))
      .where((u) => u.age.exists())
      .select((u) => u.id)
      .toArray();
    assert.deepStrictEqual(streamed, ['b', 'a', 'c']);
    await store.close();
  });
});

describe('no import edge in either direction (D2)', () => {
  it('neither manifest names the other', () => {
    const db = JSON.parse(fs.readFileSync('packages/db/package.json', 'utf8'));
    const linq = JSON.parse(fs.readFileSync('packages/linq/package.json', 'utf8'));
    for (const manifest of [db, linq]) {
      const declared = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
        ...manifest.devDependencies,
      };
      const other = manifest.name === '@jarenjs/db' ? '@jarenjs/linq' : '@jarenjs/db';
      assert.strictEqual(other in declared, false,
        `${manifest.name} must not declare ${other}`);
    }
  });

  it('no db source imports linq and no linq source imports db', () => {
    const scan = (dir) => {
      const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.js'));
      return files.map((f) => fs.readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
    };
    // the assertion is about IMPORT EDGES — prose may mention the
    // other package (the provider comment does, by design)
    assert.strictEqual(/from '@jarenjs\/linq/.test(scan('packages/db/src')), false);
    assert.strictEqual(/import\('@jarenjs\/linq/.test(scan('packages/db/src')), false);
    assert.strictEqual(/from '@jarenjs\/db/.test(scan('packages/linq/src')), false);
    assert.strictEqual(/import\('@jarenjs\/db/.test(scan('packages/linq/src')), false);
  });
});

describe('a spatial linq chain reaches the derived index (D2)', () => {
  const seededPlaces = async () => {
    const store = await openStore(PLACES_MODEL, { driver: nodeDriver() });
    const places = store.collection('places');
    for (const row of PLACES) await places.insert(row);
    return { store, places };
  };
  // `at` is the index METHOD on this surface, so a member of that name
  // is reached with get() — the collision LINQ-FORMAT §4 records
  const chain = (source) => from(source)
    .params({ region: REGION })
    .where((p, q) => p.get('at').within(q.region))
    .select((p) => p.id);

  it('the fluent surface and the in-memory run agree', async () => {
    const { store, places } = await seededPlaces();
    assert.deepStrictEqual(chain(places).toArray(), chain(PLACES).toArray());
    assert.deepStrictEqual(chain(PLACES).toArray(), ['inside', 'vertex']);
    await store.close();
  });

  it('the document it emits plans onto the derived columns and SEEKS them', async () => {
    const { store, places } = await seededPlaces();
    // `toDocument()` is the chain as data; the provider explains it
    const explained = await places.explain(chain(places).toDocument(),
      { externals: { region: REGION } });
    assert.deepStrictEqual(explained.prefilters, [{
      construct: '$within',
      via: 'columns',
      columns: ['gx_at_bbox_w', 'gx_at_bbox_e', 'gx_at_bbox_s', 'gx_at_bbox_n'],
      exact: false,
    }]);
    assert.deepStrictEqual(explained.params.map((slot) => slot.derived?.axis),
      ['e', 'w', 'n', 's'], 'the region binds through derived slots, not as an object');
    assert.match(explained.scanNarrative, /SEARCH/);
    assert.match(explained.scanNarrative, /places_by_box/);
    await store.close();
  });

  it('a region with no bounding box diverts to the full scan and still answers', async () => {
    const { store, places } = await seededPlaces();
    const empty = { type: 'FeatureCollection', features: [] };
    const emptyChain = (source) => from(source)
      .params({ region: empty })
      .where((p, q) => p.get('at').within(q.region))
      .select((p) => p.id);
    assert.deepStrictEqual(emptyChain(places).toArray(), emptyChain(PLACES).toArray());
    assert.deepStrictEqual(emptyChain(PLACES).toArray(), []);
    await store.close();
  });
});

// ————— entity roots: an entity set is a provider (MODEL-FORMAT §10.1) —————

const ENTITY_MODEL = {
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      email: { type: 'string' }, age: { type: 'integer' } } } },
    Post: { schema: { type: 'object', required: ['id', 'authorId'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } },
      title: { type: 'string' }, authorId: { type: 'string' }, stars: { type: 'integer' } } } },
  },
};
const ENTITY_USERS = [{ id: 'u1', email: 'ada@x', age: 36 }, { id: 'u2', email: 'lin@x', age: 64 }];
const ENTITY_POSTS = [
  { id: 1, title: 'p1', authorId: 'u1', stars: 3 },
  { id: 2, title: 'p2', authorId: 'u2', stars: 1 },
  { id: 3, title: 'p3', authorId: 'u1', stars: 4 },
];

async function seededEntities() {
  const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
  for (const user of ENTITY_USERS) await store.entity('User').create(user);
  for (const post of ENTITY_POSTS) await store.entity('Post').create(post);
  return store;
}

describe('a linq chain over an entity set (entity roots)', () => {
  it('the store itself is JL0007 naming its roots; an entity set answers the row count', async () => {
    const store = await seededEntities();
    assert.throws(() => from(store.sync), (e) => e.code === 'JL0007' && /User, Post/.test(e.message));
    assert.throws(() => fromAsync(store), (e) => e.code === 'JL0007' && /User, Post/.test(e.message));
    assert.deepStrictEqual(store.roots, ['User', 'Post']);
    assert.deepStrictEqual(store.sync.roots, ['User', 'Post']);
    assert.strictEqual(from(store.sync.entity('Post')).count(), 3);
    assert.strictEqual(await fromAsync(store.entity('Post')).count(), 3);
    await store.close();
  });

  it('the chain emits the entity-root document and the store runs it natively, wrapper and all', async () => {
    const store = await seededEntities();
    const chain = from(store.sync.entity('Post')).where((p) => p.stars.ge(3));
    const doc = chain.toDocument();
    assert.deepStrictEqual(doc,
      { $for: { it: '$.Post[*]' }, $where: { $ge: ['$it.stars', 3] }, $return: '$it' });
    const explained = store.sync.explain(doc);
    assert.strictEqual(explained.mode, 'native');
    assert.strictEqual(explained.residual, null);
    assert.deepStrictEqual(explained.reasons, []);
    assert.deepStrictEqual(explained.referenced, ['Post']);
    // what toArray() hands over is the one-item window, read through the same way
    const window = await store.entity('Post').explain([doc]);
    assert.strictEqual(window.mode, 'native');
    assert.strictEqual(window.wrapped, true);
    assert.deepStrictEqual(chain.toArray(), [ENTITY_POSTS[0], ENTITY_POSTS[2]]);
    assert.deepStrictEqual(
      await fromAsync(store.entity('Post')).where((p) => p.stars.ge(3)).toArray(),
      [ENTITY_POSTS[0], ENTITY_POSTS[2]]);
    assert.deepStrictEqual(from(store.sync.entity('Post')).orderBy((p) => p.stars).first(), ENTITY_POSTS[1]);
    await store.close();
  });

  it('the handles are providers: execute/explain/root/scope on both surfaces, one handle per name', async () => {
    const store = await seededEntities();
    // a projected return is the declared residual (MODEL-FORMAT §10.6): the
    // values prove the seam, the bare binding proves the translator ran
    const doc = { $for: { it: '$.User[*]' }, $where: { $gt: ['$it.age', 40] }, $return: '$it.email' };
    const bare = { $for: { it: '$.User[*]' }, $where: { $gt: ['$it.age', 40] }, $return: '$it' };
    for (const handle of [store.entity('Post'), store.sync.entity('Post')]) {
      assert.strictEqual(handle.root, '$.Post[*]');
      assert.strictEqual(handle.root, entityRoot('Post'));
      assert.strictEqual(handle.scope, store.entity('User').scope, 'one scope per store');
    }
    assert.strictEqual(store.sync.entity('Post'), store.sync.entity('Post'), 'one handle per name');
    assert.strictEqual(store.entity('Post'), store.entity('Post'));
    assert.strictEqual(store.sync.entity('User').execute(doc), 'lin@x', 'a value on the sync surface');
    assert.strictEqual(await store.entity('User').execute(doc), 'lin@x');
    assert.strictEqual(store.sync.entity('User').explain(doc).mode, 'set');
    assert.strictEqual(store.sync.entity('User').explain(bare).mode, 'native');
    assert.strictEqual((await store.entity('Post').explain(bare)).mode, 'native',
      'a handle contributes its root as a hint; the document is over the multi-entity root');
    await store.close();
  });

  it('a join between two entity sets of one store is the two-binding shape the store answers natively; across two stores it is JL0005', async () => {
    const store = await seededEntities();
    const posts = store.sync.entity('Post');
    const users = store.sync.entity('User');
    const chain = from(posts).join(from(users), (p) => p.authorId, (u) => u.id, (p) => p);
    const doc = chain.toDocument();
    assert.deepStrictEqual(doc, {
      $for: { it: '$.Post[*]', it2: '$.User[*]' },
      $where: { $eq: ['$it.authorId', '$it2.id'] },
      $return: '$it',
    });
    const explained = store.sync.explain(doc);
    assert.strictEqual(explained.mode, 'native');
    assert.deepStrictEqual(explained.join,
      { left: { binding: 'it', column: 'authorId' }, right: { binding: 'it2', column: 'id' } });
    assert.deepStrictEqual(chain.toArray(), ENTITY_POSTS);
    // a projected join is the declared residual (MODEL-FORMAT §10.6) and agrees with the engine
    const projected = from(posts).join(from(users), (p) => p.authorId, (u) => u.id,
      (p, u) => ({ title: p.title, by: u.email }));
    const root = { User: ENTITY_USERS, Post: ENTITY_POSTS };
    assert.deepStrictEqual(projected.toArray(), compileJsonQuery([projected.toDocument()])(root));
    assert.strictEqual(store.sync.explain(projected.toDocument()).mode, 'set');
    const other = await seededEntities();
    assert.throws(() => from(posts).join(from(other.sync.entity('User')), (p) => p.authorId, (u) => u.id, (p) => p),
      (e) => e.code === 'JL0005' && /same source/.test(e.message));
    await other.close();
    await store.close();
  });

  it('the runtime half of the typed pin: a projection over the set answers the member values', async () => {
    const store = await seededEntities();
    assert.deepStrictEqual(
      from(store.sync.entity('User')).orderBy((u) => u.id).select((u) => u.email).toArray(),
      ['ada@x', 'lin@x']);
    await store.close();
  });
});

describe("a chain's element window is read through by both planners (LINQ-FORMAT §6, D15)", () => {
  it('a collection answers the rows as the one array item, never unwrapped: [] for none, [row] for one', async () => {
    const { store, users } = await seeded();
    const window = (min) => [{ $for: { it: ['$[*]'] }, $where: { $ge: ['$it.age', min] }, $return: '$it' }];
    const explained = await users.explain(window(60));
    assert.strictEqual(explained.mode, 'native');
    assert.strictEqual(explained.wrapped, true);
    assert.deepStrictEqual(await users.execute(window(60)), [DATA[2]]);
    assert.deepStrictEqual(await users.execute(window(99)), []);
    assert.deepStrictEqual(await users.execute(window(60), { pushdown: false }), [DATA[2]],
      'the residual answers the same shape');
    assert.deepStrictEqual(compileJsonQuery(window(60))(DATA), [DATA[2]], "the engine's own answer");
    // a projection inside the window: the row residual, still one array
    const projected = [{ $for: { it: ['$[*]'] }, $where: { $ge: ['$it.age', 30] }, $return: '$it.id' }];
    assert.strictEqual((await users.explain(projected)).mode, 'row');
    assert.deepStrictEqual(await users.execute(projected), ['a', 'c']);
    // the cursor yields the one item
    const items = [];
    for await (const item of users.query(window(60))) items.push(item);
    assert.deepStrictEqual(items, [[DATA[2]]]);
    // an aggregate inside a window is the one-item array too
    assert.deepStrictEqual(await users.execute([{ $count: { $for: { it: ['$[*]'] }, $return: '$it' } }]), [4]);
    await store.close();
  });

  it('an entity set answers the same way, natively', async () => {
    const store = await seededEntities();
    const window = (id) => [{ $for: { it: '$.Post[*]' }, $where: { $eq: ['$it.id', id] }, $return: '$it' }];
    assert.strictEqual((await store.explain(window(2))).wrapped, true);
    assert.deepStrictEqual(await store.execute(window(2)), [ENTITY_POSTS[1]]);
    assert.deepStrictEqual(await store.execute(window(9)), []);
    assert.deepStrictEqual(await store.execute(window(2), { pushdown: false }), [ENTITY_POSTS[1]]);
    assert.deepStrictEqual(await store.execute([{ $count: { $for: { it: '$.Post[*]' }, $return: '$it' } }]), [3]);
    await store.close();
  });
});
