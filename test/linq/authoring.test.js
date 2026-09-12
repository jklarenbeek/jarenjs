//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentBuilder, snapshot, optionsOf, captureQuery } from '@jarenjs/linq/authoring';
import { compileJsonQuery } from '@jarenjs/json/query';

it('builds independent immutable plain documents and preserves fluent subclasses', () => {
  class Document extends DocumentBuilder {}
  const source = { title: 'first', items: [{ count: 1 }] };
  const builder = new Document(source);
  source.items[0].count = 99;
  assert.deepEqual(builder.toJSON(), { title: 'first', items: [{ count: 1 }] });
  assert.ok(Object.isFrozen(builder.schema.items[0]));
  const next = builder.with({ title: 'second' });
  assert.ok(next instanceof Document);
  assert.equal(next.schema.title, 'second');
  assert.equal(builder.schema.title, 'first');
  assert.deepEqual(snapshot({ value: 1 }), { value: 1 });
  assert.deepEqual(optionsOf({ title: 'x' }, ['title'], 'document'), { title: 'x' });
  assert.throws(() => optionsOf({ other: 1 }, ['title'], 'document'), { code: 'JL0101' });
});

it('captures an ordinary query without a model and retains undeclared-external refusal', () => {
  const query = captureQuery('document', [], value => value.price);
  assert.equal(compileJsonQuery(query)({ price: 7 }), 7);
  assert.throws(() => captureQuery('document', [], (_, external) => external.missing), { code: 'JL0104' });
});
