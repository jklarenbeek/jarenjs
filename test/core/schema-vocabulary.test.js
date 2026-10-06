//@ts-check
/** Shared vocabulary leaves nullable analysis and reference scope policies distinct. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS, canonicalNullable } from '@jarenjs/core/schema';
import { collectSameDocumentAnchors } from '@jarenjs/validate/normalize';

const union = (schema) => ({ anyOf: [{ type: 'object', properties: { payload: schema } }, { type: 'null' }] });

it('exposes immutable schema vocabulary that consumers can compose without changing its owner', () => {
  for (const keywords of [SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS]) {
    const before = [...keywords];
    assert.equal(Object.isFrozen(keywords), true);
    assert.throws(() => Reflect.apply(Array.prototype.push, keywords, ['custom']), TypeError);
    const composed = keywords.concat(['custom']);
    assert.equal(composed.at(-1), 'custom');
    assert.deepEqual(keywords, before);
  }
});

it('contentSchema reaches nullable normalizers but remains outside reference registration', () => {
  const schema = { contentSchema: { default: 'fill', $anchor: 'content' } };
  assert.equal(canonicalNullable(union(schema)), null);
  assert.deepEqual([...collectSameDocumentAnchors(schema)], []);
});

it('reference-only compatibility maps do not become nullable normalizer traversal positions', () => {
  for (const keyword of ['dependencies', 'dependentRequired', 'definitions', '$defs', 'components']) {
    const leaf = { default: 'fill', $anchor: 'found' };
    const schema = { [keyword]: { named: leaf } };
    assert.notEqual(canonicalNullable(union(schema)), null, keyword);
    assert.deepEqual([...collectSameDocumentAnchors(schema)], [['found', leaf]], keyword);
  }
});

it('legacy additionalItems registration stays separate from nullable analysis', () => {
  const leaf = { default: 'fill', $anchor: 'found' };
  const schema = { additionalItems: leaf };
  assert.notEqual(canonicalNullable(union(schema)), null);
  assert.deepEqual([...collectSameDocumentAnchors(schema)], [['found', leaf]]);
});

it('a legacy items tuple stays a reference list without becoming a nullable schema value', () => {
  const leaf = { default: 'fill', $anchor: 'found' };
  assert.notEqual(canonicalNullable(union({ items: [leaf] })), null);
  assert.equal(canonicalNullable(union({ items: leaf })), null);
  assert.deepEqual([...collectSameDocumentAnchors({ items: [leaf] })], [['found', leaf]]);
});

it('instance-data annotations enter neither the nullable nor reference schema walk', () => {
  for (const keyword of ['const', 'enum', 'examples', 'x-note']) {
    const schema = { [keyword]: { default: 'fill', $anchor: 'data', items: { $anchor: 'nested-data' } } };
    assert.notEqual(canonicalNullable(union(schema)), null, keyword);
    assert.deepEqual([...collectSameDocumentAnchors(schema)], [], keyword);
  }
});
