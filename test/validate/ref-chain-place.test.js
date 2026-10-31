//@ts-check
/**
 * @file The end of a chain of bare `$ref`s is read at its own place: under
 * the draft that place declares and against its own base, as a `$ref`
 * straight to it reads it, a `$ref` to the chain below the compiled schema
 * reads it, and the normalizer's index places it. The compile holds the
 * end under every hop's URI; the object it built there from that end was
 * read at the hop's place.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { listOutput } from '@jarenjs/validate/output';
import { indexSchemaResources, resolveSchemaReference, schemaPlace } from '@jarenjs/validate/normalize';

const D07 = 'http://json-schema.org/draft-07/schema#';

/** `prefixItems` is no keyword under draft-07: `[1]` is valid there, and refused where it applies. */
const doc = {
  $id: 'urn:doc',
  $defs: {
    o: { $ref: '#/$defs/r/$defs/s' },
    o2: { $ref: '#/$defs/o' },
    r: { $schema: D07, $defs: { s: { prefixItems: [{ type: 'string' }] } } },
  },
};
const holding = () => new JarenValidator().addSchema(doc);

describe('the end of a chain of bare $refs is read at its own place', () => {
  it('reads it under the draft its place declares, from one hop or two (the chain read it under none)', () => {
    assert.equal(holding().compile({ $ref: 'urn:doc#/$defs/o' })([1]), true);
    assert.equal(holding().compile({ $ref: 'urn:doc#/$defs/o2' })([1]), true);
    const { $id: _id, ...inline } = doc;
    assert.equal(new JarenValidator().compile({ ...inline, $ref: '#/$defs/o2' })([1]), true);
    // as every other reach of it reads it
    assert.equal(holding().compile({ $ref: 'urn:doc#/$defs/r/$defs/s' })([1]), true);
    assert.equal(holding().compile({ type: 'array', items: { $ref: 'urn:doc#/$defs/o' } })([[1]]), true);
    assert.equal(holding().compile({ properties: { p: { $ref: 'urn:doc#/$defs/o2' } } })({ p: [1] }), true);
    // and as the normalizer's index places it
    const index = indexSchemaResources(doc);
    assert.equal(schemaPlace(index, resolveSchemaReference('#/$defs/o', 'urn:doc', index)).draft, null);
    assert.equal(schemaPlace(index, doc.$defs.r.$defs.s).draft, 7);
  });

  it('resolves the end\'s own references against its base (the chain resolved them against the hop\'s)', () => {
    const embedded = new JarenValidator().addSchema({
      $id: 'urn:outer',
      $defs: {
        t: { type: 'number' },
        o: { $ref: 'urn:inner#/$defs/s' },
        inner: { $id: 'urn:inner', $defs: { s: { type: 'array', items: { $ref: '#/$defs/t' } }, t: { type: 'string' } } },
      },
    });
    const chain = embedded.compile({ $ref: 'urn:outer#/$defs/o' });
    assert.deepEqual([chain(['x']), chain([1])], [true, false]);
    const direct = embedded.compile({ $ref: 'urn:inner#/$defs/s' });
    assert.deepEqual([direct(['x']), direct([1])], [true, false]);
  });

  it('resolves the end\'s own references in its own document when the chain crosses into another (they were read against the document the chain starts in)', () => {
    const lib = { $id: 'https://x.example/lib.json', $defs: { S: { type: 'string' }, In: { type: 'object', properties: { m: { $ref: '#/$defs/S' } } } } };
    const crossing = new JarenValidator().addSchema(lib).addSchema({ $id: 'urn:a', x: { $ref: 'https://x.example/lib.json#/$defs/In' } });
    const chain = crossing.compile({ $ref: 'urn:a#/x' });
    assert.deepEqual([chain({ m: 1 }), chain({ m: 'a' })], [false, true]);
    // where the starting document holds a schema at the same pointer, it is not the one read
    const shadowing = new JarenValidator().addSchema(lib).addSchema({ $id: 'urn:a', x: { $ref: 'https://x.example/lib.json#/$defs/In' }, $defs: { S: { type: 'number' } } });
    assert.deepEqual([shadowing.compile({ $ref: 'urn:a#/x' })({ m: 1 }), shadowing.compile({ $ref: 'https://x.example/lib.json#/$defs/In' })({ m: 1 })], [false, false]);
  });

  it('ends a chain at a $ref beside a keyword that asserts, from 2019-09 on, as before', () => {
    const validator = new JarenValidator().addSchema({
      $id: 'urn:doc',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { o: { $ref: '#/$defs/p' }, p: { $ref: '#/$defs/s', minimum: 5 }, s: { type: 'number' } },
    });
    const chain = validator.compile({ $ref: 'urn:doc#/$defs/o' });
    assert.deepEqual([chain(3), chain(7), chain('x')], [false, true, false]);
    const below = validator.compile({ type: 'array', items: { $ref: 'urn:doc#/$defs/o' } });
    assert.deepEqual([below([3]), below([7])], [false, true]);
  });

  it('still names each hop in the output, the end at its own location', () => {
    const validate = /** @type {any} */ (new JarenValidator({ outputFormat: listOutput }).addSchema({
      $id: 'urn:doc',
      $defs: { o: { $ref: '#/$defs/r/$defs/s' }, r: { $schema: D07, $defs: { s: { type: 'string', prefixItems: [{ type: 'string' }] } } } },
    }).compile({ $ref: 'urn:doc#/$defs/o' }));
    assert.deepEqual(validate([1]).details.map((/** @type {any} */ u) => [u.evaluationPath, u.schemaLocation, u.errors]),
      [['/$ref/$ref', 'urn:doc#/$defs/r/$defs/s', { type: 'must be a string' }]]);
  });
});
