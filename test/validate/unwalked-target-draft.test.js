//@ts-check
/**
 * @file A `$ref` target below a position the validator's walk does not
 * enter (a keyword no draft defines, as the `components` of an OpenAPI
 * document) is read under the nearest `$schema` on the way to it in its
 * document — its document's, or one an object on the way declares — as
 * the normalizer's index places it and as the target reads when reached
 * through its parent. It was read under no draft: every keyword, and the
 * siblings of a `$ref`, applied in a draft-07 document.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { indexSchemaResources, resolveSchemaReference, schemaPlace } from '@jarenjs/validate/normalize';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
/** `prefixItems` is a keyword from 2020-12 on: `[1]` is valid where it is none. */
const tuple = { type: 'array', prefixItems: [{ type: 'string' }] };

/**
 * A target's answers held under `urn:doc` and compiled with its document,
 * and the draft the normalizer's index places it under.
 * @param {Record<string, any>} document @param {string} pointer @param {unknown} instance
 */
function read(document, pointer, instance) {
  const held = new JarenValidator().addSchema({ ...document, $id: 'urn:doc' }).compile({ $ref: `urn:doc${pointer}` })(instance);
  const direct = new JarenValidator().compile({ ...document, $ref: pointer })(instance);
  const index = indexSchemaResources(document);
  const draft = schemaPlace(index, resolveSchemaReference(pointer, [...index.resources.keys()][0], index)).draft;
  return { held, direct, draft };
}

describe('a $ref target below a keyword no draft defines', () => {
  it('reads under its document\'s draft (it read under none)', () => {
    assert.deepEqual(read({ $schema: D07, components: { schemas: { p: tuple } } }, '#/components/schemas/p', [1]), { held: true, direct: true, draft: 7 });
    assert.deepEqual(read({ $schema: D19, 'x-defs': { p: tuple } }, '#/x-defs/p', [1]), { held: true, direct: true, draft: 2019 });
    // a draft-07 `$ref` overrides its siblings there too
    const sibling = { $schema: D07, definitions: { any: {} }, components: { schemas: { p: { $ref: '#/definitions/any', type: 'string' } } } };
    assert.deepEqual(read(sibling, '#/components/schemas/p', 1), { held: true, direct: true, draft: 7 });
  });

  it('reads under a $schema an object on the way declares, as through that object (it read under none)', () => {
    const document = { x: { $schema: D07, properties: { m: tuple } } };
    assert.deepEqual(read(document, '#/x/properties/m', [1]), { held: true, direct: true, draft: 7 });
    assert.deepEqual(read(document, '#/x', { m: [1] }), { held: true, direct: true, draft: 7 });
    // `$dynamicRef` is no keyword under draft-07
    const dynamic = { x: { $schema: D07, properties: { m: { $dynamicRef: '#/$defs/text' } } }, $defs: { text: { type: 'string' } } };
    assert.equal(new JarenValidator().addSchema({ ...dynamic, $id: 'urn:doc' }).compile({ $ref: 'urn:doc#/x/properties/m' })(1), true);
  });

  it('reads under the draft a resource on the way inherits (it read under none)', () => {
    const validator = new JarenValidator().addSchema({ $id: 'urn:doc', $schema: D07, $defs: { r: { $id: 'urn:r', 'x-ext': { s: tuple } } } });
    assert.equal(validator.compile({ $ref: 'urn:r#/x-ext/s' })([1]), true);
  });

  it('keeps reading one under no $schema as before, every keyword applying', () => {
    assert.deepEqual(read({ components: { schemas: { p: tuple } } }, '#/components/schemas/p', [1]), { held: false, direct: false, draft: null });
  });

  it('reads one that names an unknown dialect itself as a recorded place is read (its $dynamicRef applied nothing)', () => {
    const own = { x: { m: { $schema: 'https://v.test/unknown', $dynamicRef: '#/$defs/text' } }, $defs: { text: { type: 'string' } } };
    const recorded = { $defs: { m: { $schema: 'https://v.test/unknown', $dynamicRef: '#/$defs/text' }, text: { type: 'string' } } };
    for (const [document, pointer] of /** @type {[object, string][]} */ ([[own, '#/x/m'], [recorded, '#/$defs/m']])) {
      const validate = new JarenValidator().addSchema({ ...document, $id: 'urn:doc' }).compile({ $ref: `urn:doc${pointer}` });
      assert.deepEqual([validate('a'), validate(1)], [true, false], pointer);
    }
  });

  it('keeps reading a $dynamicRef where a $schema on the way names no draft this package knows, as where none is declared', () => {
    const validator = new JarenValidator().addSchema({
      $id: 'urn:doc',
      x: { $schema: 'https://v.test/unknown', properties: { m: { $dynamicRef: '#/$defs/text' } } },
      $defs: { text: { type: 'string' } },
    });
    const validate = validator.compile({ $ref: 'urn:doc#/x/properties/m' });
    assert.deepEqual([validate('a'), validate(1)], [true, false]);
  });
});
