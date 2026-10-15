//@ts-check
/**
 * @file An entity named after a prototype member. `__proto__` passes the
 * identifier grammar, and the mapping that names each entity's table was a
 * plain object assigned by name: an entity called `__proto__` rewrote the
 * map's prototype instead of becoming a member, so it had no table (the open
 * created none, and the first write met the driver's raw "no such table"), no
 * join tables and no plan. It is an own member like any other name. So is
 * a root named like one in a profile's per-root maps: a store profile that
 * keeps no predicate for `constructor` reads none for it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore, explainMapping, planModelMigration, migrate, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

/** An object whose members are all OWN, `__proto__` included. @param {Record<string, any>} members */
const own = (members) => {
  const out = {};
  for (const [key, value] of Object.entries(members)) Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
  return out;
};
const entity = (extra = {}) => ({ schema: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } }, ...extra } } });
const many = (/** @type {string} */ to, /** @type {any} */ more = {}) => ({ 'x-entity': { relation: { to, many: true, ...more } } });
const MODEL = {
  $model: '0.1',
  entities: own({
    ['__proto__']: entity({ tags: many('Tag'), kids: many('Kid', { via: 'parentId', onDelete: 'cascade' }) }),
    Tag: entity(),
    Kid: entity({ parentId: { type: 'string' } }),
  }),
};

describe('an entity named __proto__', () => {
  it('has a mapping, a table and a join table of its own', () => {
    const mapping = explainMapping(MODEL);
    assert.deepStrictEqual(Object.keys(mapping.entities).sort(), ['Kid', 'Tag', '__proto__']);
    assert.strictEqual(mapping.entities['__proto__'].table, '__proto__');
    assert.deepStrictEqual(Object.keys(mapping.joinTables), ['Tag___proto__']);
  });

  it('is written, linked, loaded, queried and deleted like any entity', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      await store.entity('__proto__').create({ id: 'p1' });
      await store.entity('Tag').create({ id: 't1' });
      await store.entity('Kid').create({ id: 'k1', parentId: 'p1' });
      store.entity('__proto__').link('p1', 'tags', 't1');
      await store.saveChanges();
      const [loaded] = await store.entity('__proto__').asNoTracking().load({ include: { tags: true, kids: true } });
      assert.deepStrictEqual(loaded, { id: 'p1', tags: [{ id: 't1' }], kids: [{ id: 'k1', parentId: 'p1' }] });
      assert.deepStrictEqual(await store.execute([{ $for: { it: '$.__proto__[*]' }, $return: '$it.id' }]), ['p1']);
      await store.entity('__proto__').delete('p1');
      assert.strictEqual(await store.entity('Kid').get('k1'), undefined, 'the children went with their parent');
    }
    finally { await store.close(); }
  });

  it('a join table named __proto__ is a table of the mapping and a query root', async () => {
    const model = { $model: '0.1', entities: own({ Post: entity({ tags: many('Tag', { through: '__proto__' }) }), Tag: entity() }) };
    assert.deepStrictEqual(Object.keys(explainMapping(model).joinTables), ['__proto__']);
    const store = await openStore(model, { driver: nodeDriver() });
    try {
      await store.entity('Post').create({ id: 'p1' });
      await store.entity('Tag').create({ id: 't1' });
      store.entity('Post').link('p1', 'tags', 't1');
      await store.saveChanges();
      const [post] = await store.entity('Post').asNoTracking().load({ include: { tags: true } });
      assert.deepStrictEqual(post.tags, [{ id: 't1' }]);
      assert.deepStrictEqual(await store.execute([{ $for: { it: '$.__proto__[*]' }, $return: '$it.Tag_key' }]), ['t1']);
    }
    finally { await store.close(); }
  });

  it('is migrated: a member added, the entity dropped and created again', async () => {
    const withExtra = { $model: '0.1', entities: own({
      ['__proto__']: entity({ tags: many('Tag'), kids: many('Kid', { via: 'parentId', onDelete: 'cascade' }), extra: { type: 'string' } }),
      Tag: entity(), Kid: entity({ parentId: { type: 'string' } }) }) };
    const without = { $model: '0.1', entities: own({ Tag: entity(), Kid: entity({ parentId: { type: 'string' } }) }) };
    const add = planModelMigration(MODEL, withExtra, { dialect: sqliteDialect, id: 'add' }).migration;
    assert.deepStrictEqual(add.steps.filter((step) => step.kind === 'ddl').map((step) => step.sql), ['ALTER TABLE "__proto__" ADD COLUMN "extra" TEXT']);
    const drop = planModelMigration(MODEL, without, { dialect: sqliteDialect, id: 'drop' }).migration;
    assert.deepStrictEqual(drop.steps.filter((step) => step.kind === 'ddl').map((step) => step.sql).filter((sql) => sql.startsWith('DROP')),
      ['DROP TABLE "Tag___proto__"', 'DROP TABLE "__proto__"']);
    const create = planModelMigration(without, MODEL, { dialect: sqliteDialect, id: 'create' }).migration;
    assert.ok(create.steps.some((step) => step.kind === 'ddl' && /^CREATE TABLE "__proto__" /.test(step.sql)));
    const { dbPath, cleanup } = tempDbPath();
    try {
      await (await openStore(MODEL, { driver: nodeDriver(), path: dbPath })).close();
      const applied = (/** @type {any} */ migration) => ({ ...migration, steps: migration.steps.filter((/** @type {any} */ step) => step.draft !== true) });
      assert.deepStrictEqual((await migrate({ driver: nodeDriver(), path: dbPath }, [applied(add)], { baseline: MODEL, model: withExtra })).applied, ['add']);
      const store = await openStore(withExtra, { driver: nodeDriver(), path: dbPath });
      await store.entity('__proto__').create({ id: 'p2', extra: 'x' });
      assert.strictEqual((await store.entity('__proto__').get('p2'))?.extra, 'x');
      await store.close();
    }
    finally { cleanup(); }
  });
});

describe('a root named like a prototype member on a store with a profile', () => {
  // the profile's per-root maps were read by name, so a root called
  // `constructor` or `toString` read the prototype's function as its
  // predicate: every write and read of it failed JQ0003
  const MODEL = { $model: '0.1', collections: { constructor: { key: '/id', schema: { type: 'object' } },
    other: { key: '/id', schema: { type: 'object' } } },
  entities: { toString: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, k: { type: 'string' } } } } } };
  for (const [label, profile, kept] of /** @type {[string, any, string[]][]} */ ([
    ["the 'safe' profile, which keeps no predicate for it", 'safe', ['a', 'b']],
    ['a member list of another root', { members: { other: ['$.id'] } }, ['a', 'b']],
    ['a predicate the host keys by its name', { predicates: { constructor: { $eq: ['$it.k', 'x'] }, toString: { $eq: ['$it.k', 'x'] } } }, ['a']],
  ])) {
    it(`is written, read and queried under ${label}`, async () => {
      const store = await openStore(MODEL, { driver: nodeDriver(), profile });
      try {
        for (const [id, k] of [['a', 'x'], ['b', 'y']]) {
          await store.collection('constructor').insert({ id, k });
          await store.entity('toString').create({ id, k });
        }
        const answer = kept.length === 1 ? kept[0] : kept;
        assert.deepStrictEqual(await store.collection('constructor').execute({ $for: { it: '$[*]' }, $return: '$it.id' }), answer);
        assert.deepStrictEqual(await store.execute({ $for: { e: '$.toString[*]' }, $return: '$e.id' }), answer);
        assert.deepStrictEqual(await store.collection('constructor').get('b'), kept.includes('b') ? { id: 'b', k: 'y' } : undefined);
        assert.deepStrictEqual(await store.entity('toString').get('b'), kept.includes('b') ? { id: 'b', k: 'y' } : undefined);
      }
      finally { await store.close(); }
    });
  }
});
