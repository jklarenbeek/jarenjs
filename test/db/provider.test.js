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
import { openStore } from '@jarenjs/db';
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
