//@ts-check
/**
 * @file The D2 seam: a `@jarenjs/linq` chain executes against a
 * collection because the collection implements `execute(document,
 * options)` — contract-level coupling. The one import edge between the
 * two packages is the client subpath's (`@jarenjs/linq/db` → db,
 * validate, formats, as optional peers) and it runs one way: the D6
 * suite below scans both manifests and every source and declaration
 * file for every import spelling. The same chains run in-memory and
 * against the store and must agree; `fromAsync` streams the cursor.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

describe('one edge, one direction (D6)', () => {
  const PEERS = ['@jarenjs/db', '@jarenjs/validate', '@jarenjs/formats'];
  /** Every quoted `@jarenjs/<name>` specifier in a file's CODE — the
   * import, export-from, dynamic-import, require and reference spellings
   * alike, under either quote — with comments stripped first: prose may
   * name a package (the provider comment does, by design), an import
   * edge may not. */
  const specifiers = (file, names) => {
    const code = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const pattern = new RegExp(`['"](${names.map((n) => n.replace('/', '\\/')).join('|')})(?:\\/[^'"]*)?['"]`, 'g');
    return [...code.matchAll(pattern)].map((m) => m[1]);
  };
  // `recursive` yields the platform's separator, and the edge predicate
  // below is spelled with forward slashes — normalise once, here.
  const walk = (dir) => fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(js|ts)$/.test(f)).map((f) => `${dir}/${f.replaceAll('\\', '/')}`);

  it("db's manifest and sources never name linq", () => {
    const db = JSON.parse(fs.readFileSync('packages/db/package.json', 'utf8'));
    for (const field of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'])
      assert.strictEqual('@jarenjs/linq' in (db[field] ?? {}), false, `db must not declare linq under ${field}`);
    for (const file of [...walk('packages/db/src'), ...walk('packages/db/types')])
      assert.deepStrictEqual(specifiers(file, ['@jarenjs/linq']), [], `${file} imports linq`);
  });

  it("linq imports the store, the validator and the formats under src/db/ and types/db.d.ts only", () => {
    const edge = (file) => /packages\/linq\/(src\/db\/|types\/db\.d\.ts)/.test(file);
    let inside = 0;
    for (const file of [...walk('packages/linq/src'), ...walk('packages/linq/types')]) {
      const found = specifiers(file, PEERS);
      if (edge(file)) inside += found.length;
      else assert.deepStrictEqual(found, [], `${file} imports ${found.join(', ')} outside the edge`);
    }
    assert.ok(inside > 0, 'the edge exists: src/db/ imports the peers');
  });

  it('the scan is load-bearing: every import spelling, in a .js and in a .d.ts', () => {
    // D7 (the hunt): the first version of this suite read `src/**` with a
    // regex that only saw a static `import … from`, so a `.d.ts` and four
    // other spellings could carry the edge past it. The predicate is
    // proven here against synthetic sources rather than by mutating the
    // package tree: what a file under `types/` says binds a consumer's
    // `tsc` exactly as what a file under `src/` says binds its bundler.
    const probe = path.join(os.tmpdir(), `edge-probe-${process.pid}`);
    fs.mkdirSync(probe, { recursive: true });
    /** @param {string} name @param {string} code */
    const scan = (name, code) => {
      const file = path.join(probe, name);
      fs.writeFileSync(file, code);
      return specifiers(file, PEERS);
    };
    try {
      const seen = [
        ['static.js', "import { openStore } from '@jarenjs/db';"],
        ['named-deep.js', "import { nodeDriver } from '@jarenjs/db/node';"],
        ['dynamic.js', 'export const p = () => import("@jarenjs/db");'],
        ['require.cjs', "const db = require('@jarenjs/db');"],
        ['export-from.js', "export { JarenValidator } from '@jarenjs/validate';"],
        ['side-effect.js', "import '@jarenjs/formats';"],
        ['type-only.d.ts', "import type { Store } from '@jarenjs/db';\nexport type S = Store;"],
        ['reference.d.ts', 'export type S = import("@jarenjs/db").Store;'],
      ];
      for (const [name, code] of seen) {
        assert.notDeepStrictEqual(scan(name, code), [], `${name} must be seen as an edge`);
      }
      // and prose is not an edge: the provider comment names the store on
      // purpose, in both comment forms and in a string that is not a
      // specifier
      assert.deepStrictEqual(scan('prose.js',
        '/* @jarenjs/db implements this contract */\n// see @jarenjs/validate\nexport const why = 1;'), []);
      assert.deepStrictEqual(scan('message.js',
        "export const msg = 'install @jarenjs/db beside it';"), []);
    }
    finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });

  it("linq's manifest names the three as optional peers only; its dependencies are unchanged", () => {
    const linq = JSON.parse(fs.readFileSync('packages/linq/package.json', 'utf8'));
    assert.deepStrictEqual(Object.keys(linq.peerDependencies).sort(), [...PEERS].sort());
    for (const peer of PEERS) {
      assert.strictEqual(peer in (linq.dependencies ?? {}), false, `${peer} must not be a dependency`);
      assert.deepStrictEqual(linq.peerDependenciesMeta[peer], { optional: true });
      assert.match(linq.peerDependencies[peer], /^\^\d+\.\d+\.\d+$/, 'a caret range the version bump moves');
    }
    assert.deepStrictEqual(Object.keys(linq.dependencies).sort(), ['@jarenjs/core', '@jarenjs/json']);
    assert.strictEqual(linq.devDependencies, undefined);
    assert.deepStrictEqual(linq.exports['./db'],
      { types: './types/db.d.ts', default: './src/db/index.js' });
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
  // is reached with get() — the collision QUERY-PEN §4 records
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

// ————— relation navigation: the table on the handles, the hop as a residual (MODEL-FORMAT §10.1) —————

const RELATED_MODEL = {
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      email: { type: 'string' }, age: { type: 'integer' },
      posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
      labels: { 'x-entity': { relation: { to: 'Label', many: true } } } } } },
    Post: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } },
      title: { type: 'string' }, authorId: { type: 'string' }, stars: { type: 'integer' },
      author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'cascade' } } } } } },
    Label: { schema: { type: 'object', required: ['name'], properties: {
      name: { type: 'string', 'x-entity': { key: true } } } } },
  },
};
const RELATED_POSTS = [...ENTITY_POSTS, { id: 4, title: 'orphan', stars: 2 }];

async function seededRelated() {
  const store = await openStore(RELATED_MODEL, { driver: nodeDriver() });
  for (const user of ENTITY_USERS) await store.entity('User').create(user);
  for (const post of RELATED_POSTS) await store.entity('Post').create(post);
  return store;
}

describe('the relation table on the entity handles (MODEL-FORMAT §10.1)', () => {
  it('every handle carries its own frozen table; the scope and the store carry all of them by name', async () => {
    const store = await seededRelated();
    const expected = {
      User: {
        posts: { to: 'Post', kind: 'oneToMany', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' },
        labels: { to: 'Label', kind: 'manyToMany', joinTable: 'Label_User', targetKey: 'name' },
      },
      Post: {
        author: { to: 'User', kind: 'oneToOne', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' },
      },
      Label: {},
    };
    assert.deepStrictEqual(store.relations, expected);
    assert.strictEqual(store.sync.relations, store.relations, 'one record, both surfaces');
    for (const name of ['User', 'Post', 'Label']) {
      assert.strictEqual(store.entity(name).relations, store.relations[name]);
      assert.strictEqual(store.sync.entity(name).relations, store.relations[name]);
      assert.strictEqual(store.entity(name).scope.relations, store.relations,
        'the scope carries every root\'s table, so a hop can chain into another root');
    }
    assert.ok(Object.isFrozen(store.relations) && Object.isFrozen(store.relations.Post.author));
    // a collections-only store has neither entities nor tables
    const { store: plain } = await seeded();
    assert.strictEqual(plain.relations, undefined);
    assert.strictEqual(plain.sync.relations, undefined);
    await plain.close();
    await store.close();
  });
});

describe('a relation hop is a residual the store runs over the fetched roots (MODEL-FORMAT §10.1, §10.6)', () => {
  it('the to-one hop in a projection: the rows agree native, residual and in the engine; strict refuses', async () => {
    const store = await seededRelated();
    const chain = from(store.sync.entity('Post')).select((p) => ({ title: p.title, by: p.author.email }));
    const doc = chain.toDocument();
    assert.deepStrictEqual(doc, {
      $for: { it: '$.Post[*]' },
      $return: { title: '$it.title', by: {
        $for: { r1: '$.User[*]' }, $where: { $eq: ['$r1.id', '$it.authorId'] }, $return: '$r1.email' } },
    });
    assert.strictEqual(/\bauthor\b/.test(JSON.stringify(doc)), false, 'no relation name in the document');
    const root = { User: ENTITY_USERS, Post: RELATED_POSTS };
    const expected = [{ title: 'p1', by: 'ada@x' }, { title: 'p2', by: 'lin@x' }, { title: 'p3', by: 'ada@x' }, { title: 'orphan' }];
    assert.deepStrictEqual(chain.toArray(), expected);
    assert.deepStrictEqual(compileJsonQuery([doc])(root), expected, "the engine's own answer");
    assert.deepStrictEqual(await store.entity('Post').execute([doc], { pushdown: false }), expected);
    assert.deepStrictEqual(await fromAsync(store.entity('Post')).select((p) => ({ title: p.title, by: p.author.email })).toArray(),
      expected);
    // the residual, named: the §2.6 projection reason, over both roots
    const explained = store.sync.explain(doc);
    assert.strictEqual(explained.mode, 'set');
    assert.deepStrictEqual(explained.referenced, ['Post', 'User']);
    assert.deepStrictEqual(explained.reasons, [{ construct: '$return',
      reason: 'entity queries return one bare binding natively; projections run in the engine' }]);
    assert.deepStrictEqual(chain.explain().hops, [{ member: 'author', kind: 'oneToOne', binding: 'r1' }]);
    assert.throws(() => store.sync.execute(doc, { strict: true }), (e) => e.code === 'JD0010');
    await store.close();
  });

  it('the to-many count and existence, the chained hop and the it2 hop agree across executors', async () => {
    const store = await seededRelated();
    const users = store.sync.entity('User');
    const posts = store.sync.entity('Post');
    const root = { User: ENTITY_USERS, Post: RELATED_POSTS };
    const agree = async (chain) => {
      const doc = chain.toDocument();
      const engine = compileJsonQuery([doc])(root);
      assert.deepStrictEqual(chain.toArray(), engine);
      assert.deepStrictEqual(await store.execute([doc], { pushdown: false }), engine);
      assert.deepStrictEqual(await store.execute([doc]), engine);
      return engine;
    };
    assert.deepStrictEqual(await agree(from(users).where((u) => u.posts.all().count().ge(2)).select((u) => u.id)), ['u1']);
    assert.deepStrictEqual(await agree(from(users).where((u) => u.posts.all().exists()).select((u) => u.id)), ['u1', 'u2']);
    assert.deepStrictEqual(await agree(from(posts).orderBy((p) => p.id)
      .select((p) => ({ id: p.id, siblings: p.author.posts.all().count() }))),
    [{ id: 1, siblings: 2 }, { id: 2, siblings: 1 }, { id: 3, siblings: 2 }, { id: 4, siblings: 0 }]);
    assert.deepStrictEqual(await agree(from(posts).join(from(users), (p) => p.authorId, (u) => u.id,
      (p, u) => ({ title: p.title, n: u.posts.all().count() }))),
    [{ title: 'p1', n: 2 }, { title: 'p2', n: 1 }, { title: 'p3', n: 2 }]);
    assert.strictEqual(from(users).where((u) => u.posts.all().exists()).count(), 2);
    assert.strictEqual(await fromAsync(store.entity('User')).where((u) => u.posts.all().exists()).count(), 2);
    // the many-to-many hop is refused at build time, naming the join table the model made
    assert.throws(() => from(users).where((u) => u.labels.all().exists()),
      (e) => e.code === 'JL0105' && /Label_User/.test(e.message));
    await store.close();
  });

  it('which lowered shapes push natively today: none — every hop is a named residual, pinned per shape', async () => {
    const store = await seededRelated();
    const users = store.sync.entity('User');
    const posts = store.sync.entity('Post');
    const pins = [
      ['a to-one hop in $where', from(posts).where((p) => p.author.email.eq('ada@x')),
        'comparisons translate only between a singular member path and a literal or external'],
      ['a to-one existence in $where', from(posts).where((p) => p.author.exists()),
        'existence tests translate only over a singular member path on the binding'],
      ['a to-one hop under $orderby', from(posts).orderBy((p) => p.author.email),
        'ordering translates only over typed entity paths (never a boolean, never a document path that admits null)'],
      ['a to-many count in $where', from(users).where((u) => u.posts.all().count().ge(2)),
        'comparisons translate only between a singular member path and a literal or external'],
      ['a to-many existence in $where', from(users).where((u) => u.posts.all().exists()),
        'existence tests translate only over a singular member path on the binding'],
      ['a hop in $return', from(posts).select((p) => p.author.email),
        'entity queries return one bare binding natively; projections run in the engine'],
    ];
    for (const [name, chain, reason] of pins) {
      const explained = store.sync.explain(chain.toDocument());
      assert.strictEqual(explained.mode, 'set', name);
      assert.strictEqual(explained.sql, null, name);
      assert.strictEqual(explained.reasons[0].reason, reason, name);
      // the terminal's window is read through as it is for every chain
      assert.strictEqual(store.sync.explain([chain.toDocument()]).wrapped, true, name);
    }
    // the contrast a hand-written document keeps: the two-binding equijoin
    // returning a bare binding is the one native shape (§10.2)
    assert.strictEqual(store.sync.explain(from(posts).join(from(users),
      (p) => p.authorId, (u) => u.id, (p) => p).toDocument()).mode, 'native');
    await store.close();
  });
});

describe("a chain's element window is read through by both planners (QUERY-PEN §6, D15)", () => {
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
    // a projection inside the window: one member path projects natively,
    // still one array
    const projected = [{ $for: { it: ['$[*]'] }, $where: { $ge: ['$it.age', 30] }, $return: '$it.id' }];
    assert.strictEqual((await users.explain(projected)).mode, 'native');
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
