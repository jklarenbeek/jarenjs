//@ts-check
/**
 * @file The normalized side of an emitted type claims a defaulted member
 * present only where `compileNormalizer` fills it: a default a schema object
 * at some place of the document refuses by its name (an
 * `additionalProperties: false` beside a `$ref`) is left unfilled there, so
 * the member keeps its declared presence on both sides.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileEmitModel } from '@jarenjs/emit';
import { compileNormalizer } from '@jarenjs/validate/normalize';

const D20 = 'https://json-schema.org/draft/2020-12/schema';

/** Each declaration as [name, variant, members as [name, required]] (or its kind). @param {any} model */
const shape = (model) => model.declarations.map((/** @type {any} */ d) =>
  [d.name, d.variant ?? null, d.type.kind === 'object' ? d.type.members.map((/** @type {any} */ m) => [m.name, m.required]) : d.type.kind]);
const S = () => ({ type: 'object', properties: { a: { type: 'string', default: 'x' } } });

describe('a default a place refuses is not claimed on the normalized side', () => {
  it('beside a $ref closed by additionalProperties: false (was a: required, with an Input twin)', () => {
    const schema = { $schema: D20, $defs: { s: S() }, $ref: '#/$defs/s', properties: { b: { type: 'integer' } }, additionalProperties: false };
    assert.deepEqual(shape(compileEmitModel(schema, { name: 'T', normalize: { useDefaults: true } })),
      [['S', 'normalized', [['a', false]]], ['T', 'normalized', 'intersection']]);
    assert.deepEqual(compileNormalizer(schema, { useDefaults: true })({}), {});
  });

  it('a declaration met at a place that fills it and at one that does not', () => {
    const schema = { $schema: D20, type: 'object', $defs: { s: S() },
      properties: { open: { $ref: '#/$defs/s' }, closed: { $ref: '#/$defs/s', properties: { b: {} }, additionalProperties: false } } };
    assert.deepEqual(shape(compileEmitModel(schema, { name: 'T', normalize: { useDefaults: true } })),
      [['S', 'normalized', [['a', false]]], ['T', 'normalized', [['open', false], ['closed', false]]]]);
    assert.deepEqual(compileNormalizer(schema, { useDefaults: true })({ open: {}, closed: {} }), { open: { a: 'x' }, closed: {} });
    // `required` still makes it present after normalizing, and optional before
    const required = structuredClone(schema);
    required.$defs.s.required = ['a'];
    assert.deepEqual(shape(compileEmitModel(required, { name: 'T', normalize: { useDefaults: true } })), [
      ['S', 'normalized', [['a', true]]], ['T', 'normalized', [['open', false], ['closed', false]]],
      ['SInput', 'accepted', [['a', false]]], ['TInput', 'accepted', [['open', false], ['closed', false]]]]);
  });

  it('a default every place fills keeps its twin', () => {
    const schema = { $schema: D20, type: 'object', $defs: { s: S() }, properties: { open: { $ref: '#/$defs/s' } }, additionalProperties: false };
    assert.deepEqual(shape(compileEmitModel(schema, { name: 'T', normalize: { useDefaults: true } })), [
      ['S', 'normalized', [['a', true]]], ['T', 'normalized', [['open', false]]],
      ['SInput', 'accepted', [['a', false]]], ['TInput', 'accepted', [['open', false]]]]);
  });
});
