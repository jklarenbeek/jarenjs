//@ts-check
/**
 * @file A root `$id` that is only a fragment (`#root`), or a URI with one,
 * names the document too: `compile` resolves the document's pointers
 * against the URI before the fragment, as `addSchema(document, key)` holds
 * it under the key, so the compiled document answers as the held one does.
 * A URI another schema the validator holds keeps naming that schema.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { embeddedResourceSchemas, placeType } from '../lib/embedded-resources.js';

const DRAFTS = ['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-06/schema#',
  'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema', undefined];

/** @param {object} schema @param {unknown[]} values */
const verdicts = (schema, values) => values.map(new JarenValidator().compile(schema));

describe('a root $id that is only a fragment', () => {
  it('resolves the document\'s pointers, in every draft (was JK0009)', () => {
    for (const $schema of DRAFTS) {
      const schema = { ...($schema ? { $schema } : {}), $id: '#root', definitions: { s: { type: 'string' } }, properties: { a: { $ref: '#/definitions/s' } } };
      assert.deepEqual(verdicts(schema, [{ a: 's' }, { a: 1 }]), [true, false], String($schema));
      const held = new JarenValidator().addSchema(schema, 'http://k.test/r.json').compile({ $ref: 'http://k.test/r.json' });
      assert.deepEqual([held({ a: 's' }), held({ a: 1 })], [true, false], String($schema));
    }
  });

  it('resolves them under a URI that ends in a plain name, absolute or relative', () => {
    for (const $id of ['http://o.test/r.json#root', 'r.json#root'])
      assert.deepEqual(verdicts({ $id, $defs: { s: { type: 'string' } }, properties: { a: { $ref: '#/$defs/s' } } }, [{ a: 's' }, { a: 1 }]), [true, false], $id);
  });

  it('is still reached by its name, from inside the document', () => {
    const schema = { $id: '#root', type: 'object', properties: { a: { type: 'string' }, n: { $ref: '#root' } } };
    assert.deepEqual(verdicts(schema, [{ n: { a: 's' } }, { n: { a: 1 } }, { n: 1 }]), [true, false, false]);
  });

  it('leaves a URI another schema the validator holds has to that schema', () => {
    const origin = 'https://github.com/jklarenbeek/jarenjs';
    const validator = new JarenValidator().addSchema({ $id: origin, definitions: { t: { type: 'integer' } } });
    const validate = validator.compile({ $id: '#root', properties: { a: { $ref: `${origin}#/definitions/t` } } });
    assert.deepEqual([validate({ a: 1 }), validate({ a: 's' })], [true, false]);
  });

  it('resolves the pointers beside a root $id spelled as a pointer, as held under a key (was JK0009)', () => {
    const schema = { $id: '#/x', definitions: { s: { type: 'string' } }, properties: { a: { $ref: '#/definitions/s' } } };
    assert.deepEqual(verdicts(schema, [{ a: 's' }, { a: 1 }]), [true, false]);
    const held = new JarenValidator().addSchema(schema, 'http://k.test/r.json').compile({ $ref: 'http://k.test/r.json' });
    assert.deepEqual([held({ a: 's' }), held({ a: 1 })], [true, false]);
  });

  it('names the origin for a compile only: a meta-schema held so leaves it to later documents', () => {
    const validator = new JarenValidator().addMetaSchema({ $id: '#x', type: 'object' });
    assert.deepEqual([validator.compile({ type: 'string' })('s'), validator.compile({ type: 'string' })(1)], [true, false]);
  });

  it('keeps a true self-reference refused', () => {
    assert.throws(() => new JarenValidator().compile({ $id: '#root', $ref: '#root' }), { code: 'JK0001' });
  });

  it('answers as the same document held under a key, and as the document without the $id, at every leaf of the embedded-resource corpus', () => {
    const counts = { documents: 0, answered: 0, refused: 0, leaves: 0, differFromHeld: 0, differFromPlain: 0 };
    for (const name of ['#root', '#']) for (const { schema, leaves } of embeddedResourceSchemas()) {
      const { $id: _ignored, ...plain } = schema;
      let without;
      try { without = new JarenValidator().compile(structuredClone(plain)); }
      catch { continue; }
      counts.documents++;
      const document = { ...plain, $id: name };
      let direct;
      try { direct = new JarenValidator().compile(structuredClone(document)); }
      catch { counts.refused++; continue; }
      counts.answered++;
      const held = new JarenValidator().addSchema(structuredClone(document), 'http://k.test/r.json').compile({ $ref: 'http://k.test/r.json' });
      for (const leaf of leaves) {
        counts.leaves++;
        const type = placeType(direct, leaf);
        if (type !== placeType(held, leaf)) counts.differFromHeld++;
        if (type !== placeType(without, leaf)) counts.differFromPlain++;
      }
    }
    assert.deepEqual(counts, { documents: 1836, answered: 1836, refused: 0, leaves: 4896, differFromHeld: 0, differFromPlain: 0 });
  });
});
