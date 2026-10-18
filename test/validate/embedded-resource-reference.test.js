//@ts-check
/**
 * @file A reference resolves against the base URI of the resource holding
 * it, in the normalizer and the strict profile as in the validator: the
 * document is one resource, and a subschema whose `$id` names a URI
 * (relative or absolute) starts another, with its own pointers and names.
 * Before 2019-09 an `$id` beside a `$ref` read alone still names its
 * subschema, and that `$ref` resolves against the enclosing resource.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import {
  compileNormalizer, collectSameDocumentAnchors, indexSchemaResources, resolveSameDocumentRef, resolveSchemaReference,
} from '@jarenjs/validate/normalize';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';
import { embeddedResourceSchemas, instanceAt, placeType } from '../lib/embedded-resources.js';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

/** The document of the reported reading: `thing`'s `x` is a string, the root's an integer. */
const thing = () => ({
  $id: 'http://example.com/root.json',
  definitions: { x: { type: 'integer' } },
  properties: {
    r: { $ref: '#/definitions/x' },
    y: { $id: 'thing', definitions: { x: { type: 'string' } }, properties: { z: { $ref: '#/definitions/x' } } },
  },
});

/** @param {any} schema */
const coerce = (schema) => compileNormalizer(schema, { coerceTypes: true });
/** @param {any} schema */
const validate = (schema) => new JarenValidator().compile(schema);

describe('normalizer — a reference resolves inside the resource holding it', () => {
  it('reads an embedded resource\'s own definitions, as the validator does', () => {
    const v = validate(thing());
    const n = coerce(thing());
    assert.equal(v({ y: { z: '1' } }), true);
    assert.equal(v({ y: { z: 1 } }), false);
    assert.deepEqual(n({ y: { z: '1' } }), { y: { z: '1' } });
    assert.deepEqual(n({ y: { z: 1 } }), { y: { z: '1' } });
    assert.deepEqual(n({ r: '1' }), { r: 1 });
    assert.equal(v(n({ y: { z: 1 } })), true);
  });

  it('reaches a plain name among the embedded resource\'s own', () => {
    for (const [dialect, name] of /** @type {const} */ ([[D20, { $anchor: 'nm' }], [D07, { $id: '#nm' }], [undefined, { $id: '#nm' }]])) {
      const schema = {
        ...(dialect === undefined ? {} : { $schema: dialect }),
        $id: 'http://e.test/root.json',
        definitions: { x: { ...name, type: 'integer' } },
        properties: { r: { $ref: '#nm' }, y: { $id: 'thing.json', definitions: { x: { ...name, type: 'string' } }, properties: { z: { $ref: '#nm' } } } },
      };
      assert.deepEqual(coerce(schema)({ r: '1', y: { z: 1 } }), { r: 1, y: { z: '1' } }, String(dialect));
      assert.equal(validate(schema)({ r: 1, y: { z: '1' } }), true);
    }
  });

  it('follows a URI naming a resource of the same document, relative or absolute', () => {
    const schema = {
      $schema: D20,
      $id: 'http://e.test/a/root.json',
      $defs: { x: { type: 'integer' } },
      properties: {
        r: { $ref: 'b/thing.json#/$defs/x' },
        s: { $ref: 'http://e.test/a/b/deep.json#/$defs/x' },
        t: { $ref: 'b/thing.json' },
        y: {
          $id: 'b/thing.json', type: 'object', $defs: { x: { type: 'string' } },
          properties: { n: { type: 'integer' }, z: { $id: 'deep.json', $defs: { x: { type: 'boolean' } }, properties: { b: { $ref: '#/$defs/x' } } } },
        },
      },
    };
    const v = validate(schema);
    const out = coerce(schema)({ r: 1, s: 'true', t: { n: '2' }, y: { z: { b: 'false' } } });
    assert.deepEqual(out, { r: '1', s: true, t: { n: 2 }, y: { z: { b: false } } });
    assert.equal(v(out), true);
  });

  it('reads `#` inside an embedded resource as that resource\'s root', () => {
    const schema = {
      properties: {
        n: { type: 'string' },
        y: { $id: 'node.json', properties: { n: { type: 'integer' }, child: { $ref: '#' } } },
      },
    };
    const out = coerce(schema)({ y: { child: { n: 1 } } });
    assert.deepEqual(out, { y: { child: { n: 1 } } });
    assert.equal(validate(schema)(out), true);
  });

  it('reads a blank `$ref` inside an embedded resource as that resource\'s root', () => {
    const schema = { properties: { n: { type: 'string' }, y: { $id: 'node.json', properties: { n: { type: 'integer' }, c: { $ref: '' } } } } };
    const out = coerce(schema)({ y: { c: { n: '1' } } });
    assert.deepEqual(out, { y: { c: { n: 1 } } });
    assert.equal(validate(schema)(out), true);
  });

  it('resolves the root\'s `$ref` against the root\'s `$id` in every draft', () => {
    for (const dialect of [undefined, D07, D20]) {
      const schema = {
        ...(dialect === undefined ? {} : { $schema: dialect }),
        $id: 'http://e.test/a/root.json', $ref: 'defs.json',
        definitions: { e: { $id: 'http://e.test/a/defs.json', type: 'integer' } },
      };
      assert.equal(coerce(schema)('1'), 1, String(dialect));
      assert.equal(validate(schema)(1), true);
    }
  });

  it('resolves a `$ref` beside an `$id` against the enclosing resource before 2019-09, against the `$id` from it on', () => {
    /** @param {string|undefined} dialect */
    const schema = (dialect) => ({
      ...(dialect === undefined ? {} : { $schema: dialect }),
      $id: 'http://e.test/root.json',
      definitions: { a: { type: 'integer' } },
      properties: { y: { $id: 'thing', $ref: '#/definitions/a', definitions: { a: { type: 'string' } } }, w: { $ref: 'thing#/definitions/a' } },
    });
    for (const dialect of [undefined, D07]) {
      // the `$ref` reads the root's `a`; the `$id` still names `thing`
      assert.deepEqual(coerce(schema(dialect))({ y: '1', w: 1 }), { y: 1, w: '1' }, String(dialect));
      assert.equal(validate(schema(dialect))({ y: 1, w: '1' }), true);
    }
    for (const dialect of [D19, D20]) {
      assert.deepEqual(coerce(schema(dialect))({ y: 1, w: 1 }), { y: '1', w: '1' }, dialect);
      assert.equal(validate(schema(dialect))({ y: '1', w: '1' }), true);
    }
  });

  it('reads a pointer target outside the schema positions inside the resource it sits in', () => {
    const schema = {
      $id: 'http://e.test/root.json',
      definitions: { x: { type: 'integer' } },
      properties: {
        r: { $ref: 'thing.json#/x-lib/s' },
        y: { $id: 'thing.json', definitions: { x: { type: 'string' } }, 'x-lib': { s: { properties: { v: { $ref: '#/definitions/x' } } } } },
      },
    };
    const out = coerce(schema)({ r: { v: 1 } });
    assert.deepEqual(out, { r: { v: '1' } });
    assert.equal(validate(schema)(out), true);
  });

  it('leaves a reference to another document alone', () => {
    const schema = { properties: { y: { $ref: 'http://other.test/none.json#/definitions/x' } } };
    const input = { y: '1' };
    assert.equal(coerce(schema)(input), input);
  });

  it('indexes each resource under its URI, and each reference\'s base', () => {
    const doc = thing();
    const index = indexSchemaResources(doc);
    assert.deepEqual([...index.resources.keys()], ['http://example.com/root.json', 'http://example.com/thing']);
    assert.equal(index.places.get(doc.properties.y.properties.z)?.refBase, 'http://example.com/thing');
    assert.equal(resolveSchemaReference('#/definitions/x', 'http://example.com/thing', index), doc.properties.y.definitions.x);
    assert.equal(resolveSchemaReference('thing#/definitions/x', 'http://example.com/root.json', index), doc.properties.y.definitions.x);
    assert.equal(resolveSchemaReference('#/definitions/x', 'http://example.com/root.json', index), doc.definitions.x);
    assert.equal(resolveSchemaReference('other.json', 'http://example.com/root.json', index), undefined);
  });

  it('keeps the document-root reading of collectSameDocumentAnchors and resolveSameDocumentRef', () => {
    const doc = {
      $schema: D20,
      $defs: { a: { $anchor: 'top', type: 'integer' } },
      properties: { y: { $id: 'thing.json', $defs: { a: { $anchor: 'inner', type: 'string' } } } },
    };
    const anchors = collectSameDocumentAnchors(doc);
    assert.deepEqual([...anchors.keys()], ['top']);
    assert.equal(resolveSameDocumentRef('#/$defs/a', doc, anchors), doc.$defs.a);
    assert.equal(resolveSameDocumentRef('#inner', doc, anchors), undefined);
  });
});

describe('strict profile — a reference resolves inside the resource holding it', () => {
  it('derives the reported document, reading `thing`\'s `x` as a string', () => {
    const schema = {
      $id: 'http://example.com/root.json', type: 'object', additionalProperties: false,
      definitions: { x: { type: 'integer' } },
      properties: {
        y: { $id: 'thing', type: 'object', additionalProperties: false, definitions: { x: { type: 'string' } }, properties: { z: { $ref: '#/definitions/x' } } },
      },
    };
    const profile = deriveStrictProfile(schema);
    const strict = validate(profile.schema);
    assert.equal(strict(profile.toProfile({ y: { z: '1' } })), true);
    assert.equal(strict(profile.toProfile({ y: { z: 1 } })), false);
  });

  it('derives a document without an `$id` whose embedded resource has a relative one', () => {
    const schema = {
      type: 'object',
      definitions: { x: { type: 'integer' } },
      properties: { y: { $id: 'thing.json', type: 'object', definitions: { x: { type: 'string' } }, properties: { z: { $ref: '#/definitions/x' } } } },
    };
    const profile = deriveStrictProfile(schema);
    const strict = validate(profile.schema);
    assert.equal(strict(profile.toProfile({ y: { z: 's' } })), true);
    assert.equal(strict(profile.toProfile({ y: { z: 1 } })), false);
  });

  it('closes out a member whose `$ref`, beside its own `$id`, names a schema that accepts nothing', () => {
    const schema = {
      $schema: D20, type: 'object',
      $defs: { no: true },
      properties: { a: { type: 'string' }, m: { $id: 'm.json', $ref: '#/$defs/no', $defs: { no: false } } },
    };
    assert.equal(validate(schema)({ m: 1 }), false);
    assert.deepEqual(deriveStrictProfile(schema).schema, {
      type: 'object', properties: { a: { type: ['string', 'null'] } }, required: ['a'], additionalProperties: false,
    });
  });

  it('reaches a resource an `$id` beside a draft-07 `$ref` names', () => {
    const schema = {
      $schema: D07, $id: 'http://e.test/root.json', type: 'object',
      definitions: { a: { type: 'integer' } },
      properties: { y: { $id: 'thing', $ref: '#/definitions/a', definitions: { a: { type: 'string' } } }, w: { $ref: 'thing#/definitions/a' } },
    };
    const profile = deriveStrictProfile(schema);
    const strict = validate(profile.schema);
    assert.equal(validate(schema)({ w: 's' }), true);
    assert.equal(strict(profile.toProfile({ w: 's' })), true);
    assert.equal(strict(profile.toProfile({ w: 1 })), false);
  });

  it('derives a draft-07 `$ref` whose sibling `$id` does not move its base', () => {
    const schema = {
      $schema: D07,
      $id: 'http://localhost:1234/sibling_id/base/',
      definitions: {
        foo: { $id: 'http://localhost:1234/sibling_id/foo.json', type: 'string' },
        base_foo: { $id: 'foo.json', type: 'number' },
      },
      allOf: [{ $id: 'http://localhost:1234/sibling_id/', $ref: 'foo.json' }],
    };
    const profile = deriveStrictProfile(schema);
    const strict = validate(profile.schema);
    assert.equal(strict(profile.toProfile(1)), true);
    assert.equal(strict(profile.toProfile('a')), false);
    assert.equal(validate(schema)(1), true);
  });
});

describe('the normalizer and the strict profile read the place the validator reads (generated)', () => {
  it('normalizes, and profiles, every reference inside embedded resources as the validator reads it', () => {
    const counts = { schemas: 0, instances: 0, accepted: 0, lost: 0, misread: 0, derived: 0, refused: 0, profileMisread: 0 };
    /** @type {string[]} */
    const wrong = [];
    /** @param {unknown} value @param {string} type */
    const coerced = (value, type) => {
      if (type === 'integer' || type === 'number') return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && (type === 'number' || Number.isInteger(Number(value))) ? Number(value) : value;
      if (type === 'boolean') return value === 'true' ? true : value;
      if (type === 'string') return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
      return value;
    };
    for (const { schema, leaves, label } of embeddedResourceSchemas()) {
      let v;
      try { v = validate(schema); }
      catch { continue; }
      counts.schemas++;
      const n = coerce(schema);
      let profile;
      let strict;
      try {
        profile = deriveStrictProfile(schema);
        strict = validate(profile.schema);
        counts.derived++;
      }
      catch (e) {
        counts.refused++;
        wrong.push(`${label}: ${/** @type {Error} */ (e).message}`);
      }
      for (const path of leaves) {
        const type = placeType(v, path);
        for (const value of ['1', 1, 'true', true, '1.5']) {
          counts.instances++;
          const input = instanceAt(path, value);
          const out = n(input);
          if (v(input)) {
            counts.accepted++;
            if (!v(out)) counts.lost++;
          }
          /** @type {any} */
          let at = out;
          for (const key of path) at = at?.[key];
          if (!Object.is(at, coerced(value, type))) {
            counts.misread++;
            wrong.push(`${label}: ${path.join('.')} ${JSON.stringify(value)} -> ${JSON.stringify(at)} (${type})`);
          }
        }
        if (profile !== undefined && strict !== undefined) {
          for (const value of [1, 1.5, 's', true]) {
            const input = instanceAt(path, value);
            if (v(input) !== strict(profile.toProfile(input))) {
              counts.profileMisread++;
              wrong.push(`${label}: profile ${path.join('.')} ${JSON.stringify(value)}`);
            }
          }
        }
      }
    }
    assert.deepEqual(wrong.slice(0, 5), []);
    assert.deepEqual(counts, { schemas: 918, instances: 12240, accepted: 3346, lost: 0, misread: 0, derived: 918, refused: 0, profileMisread: 0 });
  });
});
