//@ts-check
/**
 * @file An entity member named `__proto__` is data like any other. The write
 * path builds the stored document, the defaults, the column values and the
 * update's merge from member names, so each member is defined as an own
 * property and each membership is asked of the document itself: assigning by
 * name sets a prototype and drops the member, and `name in doc` is true of
 * every document.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { onBothEngines } from './query-core-engines.js';

const KEY = '"id":{"type":"integer","x-entity":{"key":true}}';
/** @param {string} member the schema of the one member named `__proto__` */
const modelWith = (member) => JSON.parse(`{"$model":"0.1","entities":{"A":{"schema":{"type":"object","required":["id"],"properties":{${KEY},"__proto__":${member},"n":{"type":"integer"}}}},`
  + '"C":{"schema":{"type":"object","required":["cid"],"properties":{"cid":{"type":"integer","x-entity":{"key":true}},"pid":{"type":"integer"}}}}}}');
const own = (/** @type {any} */ doc) => (doc !== undefined && Object.hasOwn(doc, '__proto__') ? doc['__proto__'] : undefined);

describe('an entity member named __proto__', () => {
  it('a mapped column keeps its value through create, get and update', async () => {
    await onBothEngines(modelWith('{"type":"integer"}'), async (store, host) => {
      const entity = store.entity('A');
      const created = await entity.create(JSON.parse('{"id":1,"__proto__":5,"n":1}'));
      assert.equal(own(created), 5, `${host}: create`);
      assert.equal(own(await entity.get(1)), 5, `${host}: get`);
      assert.equal(own(await entity.update(1, JSON.parse('{"__proto__":6}'))), 6, `${host}: update`);
      assert.equal(own(await entity.get(1)), 6, `${host}: get after update`);
    });
  });

  it('a document member keeps its value through create, update and a tracked save', async () => {
    await onBothEngines(modelWith('{"type":["integer","object"]}'), async (store, host) => {
      const entity = store.entity('A');
      await entity.create(JSON.parse('{"id":1,"__proto__":{"a":1}}'));
      assert.deepEqual(own(await entity.get(1)), { a: 1 }, `${host}: create`);
      await entity.update(1, JSON.parse('{"__proto__":{"b":2}}'));
      assert.deepEqual(own(await entity.get(1)), { b: 2 }, `${host}: update`);
      entity.add(JSON.parse('{"id":2,"__proto__":{"c":3},"n":1}'));
      await store.saveChanges();
      const row = await entity.get(2);
      assert.deepEqual(own(row), { c: 3 }, `${host}: add`);
      entity.put({ ...row, n: 2 });
      await store.saveChanges();
      assert.deepEqual(own(await entity.get(2)), { c: 3 }, `${host}: put`);
      assert.equal((await entity.get(2)).n, 2, `${host}: put changes`);
    });
  });

  it('a default fills it where the document has none', async () => {
    await onBothEngines(modelWith('{"type":"string","x-entity":{"default":{"value":"x"}}}'), async (store, host) => {
      const entity = store.entity('A');
      assert.equal(own(await entity.create({ id: 1 })), 'x', `${host}: create`);
      assert.equal(own(await entity.create(JSON.parse('{"id":2,"__proto__":"given"}'))), 'given', `${host}: given`);
      assert.equal(own(await entity.get(2)), 'given', `${host}: get`);
    });
  });

  it('a key named so is written, read and updated by its value', async () => {
    const model = JSON.parse('{"$model":"0.1","entities":{"A":{"schema":{"type":"object","required":["__proto__"],'
      + '"properties":{"__proto__":{"type":"integer","x-entity":{"key":true}},"n":{"type":"integer"}}}}}}');
    await onBothEngines(model, async (store, host) => {
      const entity = store.entity('A');
      assert.equal(own(await entity.create(JSON.parse('{"__proto__":1,"n":1}'))), 1, `${host}: create`);
      assert.equal((await entity.update(1, { n: 2 })).n, 2, `${host}: update`);
      assert.deepEqual(await entity.update(1, JSON.parse('{"__proto__":1,"n":3}')), JSON.parse('{"__proto__":1,"n":3}'), `${host}: update naming the key`);
      await assert.rejects(Promise.resolve().then(() => entity.update(1, JSON.parse('{"__proto__":2}'))), { code: 'JD2003' }, `${host}: a key is not rewritten`);
      assert.deepEqual(await store.execute([{ $for: { a: '$.A[*]' }, $return: '$a.n' }]), [3], host);
    });
  });

  it('a relation named so refuses a value it holds and no document that holds none', async () => {
    const relation = '{"x-entity":{"relation":{"to":"C","many":true,"via":"pid","onDelete":"cascade"}}}';
    await onBothEngines(modelWith(relation), async (store, host) => {
      const entity = store.entity('A');
      assert.equal((await entity.create({ id: 1 })).id, 1, `${host}: a document without it is created`);
      await assert.rejects(Promise.resolve().then(() => entity.create(JSON.parse('{"id":2,"__proto__":[{"cid":1}]}'))),
        { code: 'JD2003' }, `${host}: a document holding it is refused as a projection`);
      assert.equal(await entity.get(2), undefined, host);
    });
  });
});
