//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withoutModelRenameHints } from '@jarenjs/core/model';

describe('core/model — model shape without rename hints', () => {
  it('strips declaration hints while preserving root and nested schema annotations', () => {
    const collectionSchema = { type: 'object', 'x-rename': 'nested', properties: {
      name: { type: 'string', 'x-rename': 'previous-property' },
    } };
    const entitySchema = { type: 'object', properties: { id: { type: 'string' } } };
    const unchanged = { schema: { type: 'object' } };
    const model = { $model: '0.1', 'x-rename': 'root',
      collections: { docs: { 'x-rename': 'old_docs', schema: collectionSchema }, other: unchanged },
      entities: { User: { 'x-rename': 'Person', schema: entitySchema } },
    };
    const snapshot = structuredClone(model);
    const normalized = withoutModelRenameHints(model);
    assert.deepEqual(normalized, { $model: '0.1', 'x-rename': 'root',
      collections: { docs: { schema: collectionSchema }, other: unchanged },
      entities: { User: { schema: entitySchema } },
    });
    assert.deepEqual(model, snapshot);
    assert.notEqual(normalized, model);
    assert.notEqual(normalized.collections, model.collections);
    assert.notEqual(normalized.entities, model.entities);
    assert.notEqual(normalized.collections.docs, model.collections.docs);
    assert.notEqual(normalized.entities.User, model.entities.User);
    assert.equal(normalized.collections.other, unchanged);
    assert.equal(normalized.collections.docs.schema, collectionSchema);
    assert.equal(normalized.entities.User.schema, entitySchema);
    assert.deepEqual(withoutModelRenameHints(normalized), normalized);
  });

  it('retains own prototype-sensitive names as data at every copied level', () => {
    const model = JSON.parse('{"$model":"0.1","__proto__":{"sentinel":7},"collections":{"__proto__":{"x-rename":"old","__proto__":{"spec":true},"schema":{"properties":{"__proto__":{"const":17}}}},"constructor":{"x-rename":"old_constructor","schema":{}}},"entities":{"__proto__":{"x-rename":"old_entity","schema":{}}}}');
    const before = JSON.stringify(model);
    const normalized = withoutModelRenameHints(model);
    for (const value of [normalized, normalized.collections, normalized.collections.__proto__, normalized.entities]) {
      assert.equal(Object.hasOwn(value, '__proto__'), true);
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
    }
    assert.equal(normalized.__proto__, model.__proto__);
    assert.equal(normalized.collections.__proto__.__proto__, model.collections.__proto__.__proto__);
    assert.equal(normalized.collections.__proto__.schema, model.collections.__proto__.schema);
    assert.equal(normalized.collections.__proto__.schema.properties.__proto__.const, 17);
    assert.equal(Object.hasOwn(normalized.collections.__proto__, 'x-rename'), false);
    assert.equal(Object.hasOwn(normalized.entities.__proto__, 'x-rename'), false);
    assert.equal(Object.hasOwn(normalized.collections, 'constructor'), true);
    assert.equal(normalized.collections.constructor.schema, model.collections.constructor.schema);
    assert.equal(JSON.stringify(model), before);
    assert.equal(Object.hasOwn(Object.prototype, 'sentinel'), false);
    assert.equal(Object.hasOwn(Object.prototype, 'spec'), false);
  });

  it('keeps declaration order and supports null-prototype maps without sharing copies', () => {
    const entities = Object.assign(Object.create(null), {
      Zebra: { schema: { properties: { z: {}, a: {} } }, 'x-rename': 'Previous', note: 'kept' },
      Alpha: { schema: {} },
    });
    const model = Object.assign(Object.create(null), { entities, $model: '0.1', note: 'last' });
    const normalized = withoutModelRenameHints(model);
    assert.deepEqual(Object.keys(normalized), ['entities', '$model', 'note']);
    assert.deepEqual(Object.keys(normalized.entities), ['Zebra', 'Alpha']);
    assert.deepEqual(Object.keys(normalized.entities.Zebra), ['schema', 'note']);
    assert.deepEqual(Object.keys(normalized.entities.Zebra.schema.properties), ['z', 'a']);
    assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
    assert.equal(Object.getPrototypeOf(normalized.entities), Object.prototype);
    assert.equal(normalized.entities.Alpha, entities.Alpha);
    assert.equal(normalized.entities.Zebra.schema, entities.Zebra.schema);
    assert.equal(Object.hasOwn(entities.Zebra, 'x-rename'), true);
  });

  it('leaves non-object roots and non-map declaration members unchanged', () => {
    for (const value of [undefined, null, false, true, -0, 3, 'model', 1n, Symbol('model'), () => {}]) {
      assert.ok(Object.is(withoutModelRenameHints(value), value));
    }
    for (const declared of [undefined, null, false, 1, 'declarations', []]) {
      const model = { $model: '0.1', collections: declared, entities: declared };
      const normalized = withoutModelRenameHints(model);
      assert.notEqual(normalized, model);
      assert.equal(normalized.collections, declared);
      assert.equal(normalized.entities, declared);
    }
    const rows = [{ 'x-rename': 'array-member' }];
    assert.deepEqual(withoutModelRenameHints(rows), { 0: rows[0] });
    assert.equal(withoutModelRenameHints(rows)[0], rows[0]);
  });

  it('retains non-object declarations and inherited hints, removing any own hint value', () => {
    const inherited = Object.assign(Object.create({ 'x-rename': 'inherited' }), { schema: {} });
    const array = [{ 'x-rename': 'nested-array-value' }];
    const model = { collections: { inherited, nil: null, scalar: 'record', array,
      ownNull: { 'x-rename': null, schema: {} }, ownFalse: { 'x-rename': false, schema: {} },
    } };
    const normalized = withoutModelRenameHints(model);
    assert.equal(normalized.collections.inherited, inherited);
    assert.equal(normalized.collections.inherited['x-rename'], 'inherited');
    assert.equal(normalized.collections.nil, null);
    assert.equal(normalized.collections.scalar, 'record');
    assert.equal(normalized.collections.array, array);
    assert.deepEqual(normalized.collections.ownNull, { schema: model.collections.ownNull.schema });
    assert.deepEqual(normalized.collections.ownFalse, { schema: model.collections.ownFalse.schema });
    assert.equal(Object.hasOwn(model.collections.ownNull, 'x-rename'), true);
    assert.equal(Object.hasOwn(model.collections.ownFalse, 'x-rename'), true);
  });
});
