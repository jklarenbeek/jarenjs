//@ts-check
/**
 * @file Regressions for the query-path quirks a reading of the planner,
 * the emitter and the load engine found: where SQL would answer
 * something the engine refuses or answers differently — a boolean or a
 * nullable path under `$orderby`/`$min`, a window bound SQL cannot take,
 * a `$count` over a grouped phrase, a member literally named `a.b`, a
 * negative array index, a name the path grammar cannot spell — the plan
 * now names the residual instead, and the differential agreement the
 * package promises holds on those shapes too. The load engine refuses
 * what it silently dropped or interpolated, and the entity engine
 * refuses a document that names no entity.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { queryJson } from '@jarenjs/json/query';

const ROWS = {
  $model: '0.1',
  collections: {
    rows: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          a: { type: 'object', properties: { b: { type: 'integer' } } },
          'a.b': { type: 'integer' },
          'a"b': { type: 'integer' },
          b: { type: 'boolean' },
          v: { type: ['integer', 'null'] },
          t: { type: 'array', items: { type: 'string' } },
          n: { type: 'integer' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_nested', path: '$.a.b' }, { name: 'by_flat', path: "$['a.b']" }, { name: 'by_n', path: '$.n' }],
    },
  },
};
const DOCS = [
  { id: 'x', a: { b: 1 }, 'a.b': 2, 'a"b': 2, b: true, v: 1, t: ['p', 'a'], n: 1 },
  { id: 'y', a: { b: 2 }, 'a.b': 1, 'a"b': 1, b: false, v: null, t: ['q', 'b'], n: 2 },
  { id: 'z', a: { b: 3 }, 'a.b': 3, 'a"b': 3, b: false, v: 3, t: ['r', 'c'], n: 3 },
];

/** The engine alone over the same documents: the reference answer, or its refusal. */
const reference = (document) => {
  try { return { value: queryJson(document, DOCS) }; }
  catch (error) { return { code: /** @type {any} */ (error).code }; }
};
/** The store's answer in the same shape. */
const native = async (store, document) => {
  try { return { value: await store.collection('rows').execute(document) }; }
  catch (error) { return { code: /** @type {any} */ (error).code }; }
};
/** `execute` answers a value or throws on a synchronous driver: a rejection assertion needs the call deferred. */
const call = (fn) => () => Promise.resolve().then(fn);
const FROM = { $for: { it: '$[*]' } };

async function seeded() {
  const store = await openStore(ROWS, { driver: nodeDriver() });
  for (const doc of DOCS) await store.collection('rows').insert(doc);
  return store;
}

describe('the store answers what the engine answers, or names the residual', () => {
  it('a member literally named a.b is not the nested path a → b (the canonical is injective)', async () => {
    const store = await seeded();
    const flat = { ...FROM, $where: { $eq: ["$it['a.b']", 2] }, $return: '$it.id' };
    const nested = { ...FROM, $where: { $eq: ['$it.a.b', 2] }, $return: '$it.id' };
    assert.deepStrictEqual(await native(store, flat), reference(flat));
    assert.deepStrictEqual(await native(store, nested), reference(nested));
    assert.strictEqual((await native(store, flat)).value, 'x');
    assert.strictEqual((await native(store, nested)).value, 'y');
    // and the two indexes are two columns
    const how = await store.collection('rows').explain(flat);
    assert.deepStrictEqual(how.indexes, ['rows_by_flat']);
    await store.close();
  });

  it('a window bound SQL cannot take as written is the engine’s to interpret', async () => {
    const store = await seeded();
    const inner = { ...FROM, $return: '$it.id' };
    for (const bounds of [[-1, 2], [0, -1], [0.5, 2], [0, 2.5], [0, Infinity], [0, NaN], [2, 0]]) {
      const document = { $subsequence: [inner, ...bounds] };
      const how = await store.collection('rows').explain(document);
      const pushed = bounds.every((bound) => Number.isSafeInteger(bound) && bound >= 0);
      assert.strictEqual(how.mode === 'set', !pushed, `bounds ${bounds} ${pushed ? 'push' : 'stay in the engine'}`);
      assert.deepStrictEqual(await native(store, document), reference(document), `bounds ${bounds}`);
    }
    await store.close();
  });

  it('a boolean or a nullable path under $orderby, $min/$max or $avg is a named residual', async () => {
    const store = await seeded();
    const cases = [
      { ...FROM, $orderby: ['$it.b'], $return: '$it.id' },
      { ...FROM, $orderby: ['$it.v'], $return: '$it.id' },
      { $min: { ...FROM, $return: '$it.b' } },
      { $max: { ...FROM, $return: '$it.b' } },
      { $avg: { ...FROM, $return: '$it.v' } },
      { $sum: { ...FROM, $return: '$it.v' } },
    ];
    for (const document of cases) {
      const how = await store.collection('rows').explain(document);
      assert.strictEqual(how.mode, 'set', JSON.stringify(document));
      assert.deepStrictEqual(await native(store, document), reference(document), JSON.stringify(document));
    }
    // a plain integer path still orders natively
    assert.strictEqual((await store.collection('rows').explain({ ...FROM, $orderby: ['$it.n'], $return: '$it.id' })).mode, 'row');
    await store.close();
  });

  it('a $count over a grouped phrase counts its groups', async () => {
    const store = await seeded();
    const grouped = { $for: { it: '$[*]' }, $groupby: { g: '$it.b' }, $return: { key: '$g', n: { $count: '$it' } } };
    const document = { $count: grouped };
    assert.strictEqual((await store.collection('rows').explain(document)).mode, 'set');
    assert.deepStrictEqual(await native(store, document), { value: 2 });
    assert.deepStrictEqual(await native(store, document), reference(document));
    await store.close();
  });

  it('a negative array index reaches the last element in SQL as it does in the engine', async () => {
    const store = await seeded();
    const document = { ...FROM, $where: { $eq: ['$it.t[-1]', 'b'] }, $return: '$it.id' };
    assert.deepStrictEqual(await native(store, document), { value: 'y' });
    assert.deepStrictEqual(await native(store, document), reference(document));
    await store.close();
  });

  it('a member name the path grammar cannot spell runs in the residual, named, and strict refuses it', async () => {
    const store = await seeded();
    const document = { ...FROM, $where: { $eq: ['$it[\'a"b\']', 2] }, $return: '$it' };
    const how = await store.collection('rows').explain(document);
    assert.strictEqual(how.mode, 'set');
    assert.match(how.residual.reasons[0].reason, /path grammar/);
    assert.deepStrictEqual((await native(store, document)).value.id, 'x');
    await assert.rejects(call(() => store.collection('rows').execute(document, { strict: true })), (e) => e.code === 'JD0010');
    await store.close();
  });

  it('a diverting external under refuseFullScan is the full scan the profile refuses', async () => {
    const store = await seeded();
    const document = { ...FROM, $where: { $eq: ['$it.n', '$x'] }, $return: '$it.id' };
    const profile = { externals: ['x'], refuseFullScan: true };
    assert.strictEqual(await store.collection('rows').execute(document, { externals: { x: 2 }, profile }), 'y');
    await assert.rejects(call(() => store.collection('rows').execute(document, { externals: { x: true }, profile })),
      (e) => e.code === 'JD0011' && /diverted/.test(e.message));
    await store.close();
  });

  it('a negative distance bound names the bound, not a pole; explain() reports the residual limits it compiled', async () => {
    const places = {
      $model: '0.1',
      collections: { places: { schema: { type: 'object', properties: { id: { type: 'string' }, at: { type: 'array', items: { type: 'number' } } } }, key: '/id', indexes: [{ name: 'by_box', path: '$.at', derive: 'bbox' }] } },
    };
    const store = await openStore(places, { driver: nodeDriver() });
    const document = { ...FROM, $where: { $le: [{ $distance: ['$it.at', [4.9, 52.3]] }, -1] }, $return: '$it.id' };
    const how = await store.collection('places').explain(document, { profile: { externals: [] } });
    assert.match(how.residual.reasons[0].reason, /non-negative/);
    const limited = await store.collection('places').explain({ ...FROM, $return: '$it.id' }, { profile: { limits: { steps: 123 } } });
    assert.strictEqual(limited.limits?.steps, 123);
    await store.close();
  });
});

describe('the load engine refuses what it dropped or interpolated', () => {
  const ent = (props, required = ['id']) => ({ schema: { type: 'object', required, properties: { id: { type: 'string', 'x-entity': { key: true } }, ...props } } });
  const MODEL = {
    $model: '0.1',
    entities: {
      User: ent({
        posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
        labels: { 'x-entity': { relation: { to: 'Label', many: true } } },
        profile: { 'x-entity': { relation: { to: 'Profile', via: 'profileId', onDelete: 'setNull' } } },
      }),
      Post: { schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', 'x-entity': { key: true } }, stars: { type: 'integer' }, authorId: { type: 'string' } } } },
      Label: ent({}),
      Profile: ent({}),
    },
  };

  async function graph() {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.entity('Profile').create({ id: 'p1' });
    await store.entity('Label').create({ id: 'l1' });
    await store.entity('Label').create({ id: 'l2' });
    await store.entity('User').create({ id: 'u1', profileId: 'p1', labels: ['l1', 'l2'] });
    await store.entity('User').create({ id: 'u2' });
    for (const [pid, stars] of [[1, 5], [2, 1], [3, 4], [4, 0]]) await store.entity('Post').create({ pid, stars, authorId: 'u1' });
    return store;
  }

  it('count: true counts every relation kind, and takes no where/take beside it', async () => {
    const store = await graph();
    const [u1] = await store.entity('User').load({ where: { $eq: ['$it.id', 'u1'] }, include: { posts: { count: true }, labels: { count: true }, profile: { count: true } } });
    assert.deepStrictEqual([u1.posts, u1.labels, u1.profile], [4, 2, 1]);
    const [u2] = await store.entity('User').load({ where: { $eq: ['$it.id', 'u2'] }, include: { profile: { count: true }, labels: { count: true } } });
    assert.deepStrictEqual([u2.profile, u2.labels], [0, 0]);
    await assert.rejects(store.entity('User').load({ include: { posts: { count: true, where: { $ge: ['$it.stars', 3] } } } }),
      (e) => e.code === 'JD0032' && /count: true/.test(e.message) && /where/.test(e.message));
    await assert.rejects(store.entity('User').load({ include: { posts: { count: true, take: 1 } } }), (e) => e.code === 'JD0032');
    await store.close();
  });

  it('take and skip are non-negative integers, never SQL text', async () => {
    const store = await graph();
    for (const spec of [{ take: -1 }, { take: 2.5 }, { skip: 1.5 }, { take: '1 OFFSET 1' }, { take: '(SELECT 2)' }, { include: { posts: { take: -1 } } }]) {
      await assert.rejects(store.entity('User').load(spec), (e) => e.code === 'JD0032', JSON.stringify(spec));
    }
    assert.deepStrictEqual((await store.entity('User').load({ take: 1 })).map((u) => u.id), ['u1']);
    await store.close();
  });

  it('a document over the entity map that names no entity array is JD0033, not the rows of every entity', async () => {
    const store = await graph();
    assert.throws(() => store.execute({ $for: { it: '$[*]' }, $return: '$it' }), (e) => e.code === 'JD0033');
    await assert.rejects(store.explain({ $for: { it: '$[*]' }, $return: '$it' }), (e) => e.code === 'JD0033');
    assert.deepStrictEqual(await store.execute({ $count: '$.Label[*]' }), 2);
    await store.close();
  });
});
