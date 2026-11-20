//@ts-check
/**
 * @file A `$ref` target below a position the validator's walk does not
 * enter (a keyword no draft defines, as the `components` of an OpenAPI
 * document) reads the vocabularies of the dialect governing it — the
 * nearest `$schema` on the way to it in its own document, as its draft is
 * read — so it answers as the same subschema under `$defs` or
 * `definitions` of that document answers. It read the compilation's
 * vocabularies: under a dialect without the validation vocabulary its
 * `type` asserted, under a root without that vocabulary a 2020-12
 * document's `type` asserted nothing, and a draft-07 document's content
 * keywords annotated under a 2020-12 root.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator, ValidatorOptions } from '@jarenjs/validate';
import { stringFormats } from '@jarenjs/formats';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const VOCAB = 'https://json-schema.org/draft/2020-12/vocab/';
const OFF = 'https://v.test/no-validation';
const UNITS = 'https://v.test/needs-units';

/** A dialect extending 2020-12 without the validation vocabulary. */
const offDialect = () => ({ $schema: D20, $id: OFF, $dynamicAnchor: 'meta', $vocabulary: { [`${VOCAB}core`]: true, [`${VOCAB}applicator`]: true } });
/** A dialect that requires a vocabulary this package does not implement. */
const unitsDialect = () => ({ $schema: D20, $id: UNITS, $dynamicAnchor: 'meta',
  $vocabulary: { [`${VOCAB}core`]: true, [`${VOCAB}applicator`]: true, [`${VOCAB}validation`]: true, 'https://v.test/vocab/units': true } });

/** A validator holding the dialects. @param {object} [options] */
const holding = (options) => new JarenValidator(options && new ValidatorOptions(options)).addFormats(stringFormats)
  .addMetaSchema(offDialect()).addMetaSchema(unitsDialect());

/**
 * What a reference into a held document answers for each instance.
 * @param {object} document @param {string} ref @param {unknown[]} instances
 * @param {{ from?: string, options?: object, inline?: boolean }} [how] - `from`: the `$schema` the root
 *   declares; `inline`: the dialects are handed to the compile instead of held
 */
function answers(document, ref, instances, { from, options, inline = false } = {}) {
  const validator = inline ? new JarenValidator(options && new ValidatorOptions(options)).addFormats(stringFormats) : holding(options);
  const root = { ...(from ? { $schema: from } : {}), $ref: ref };
  const validate = validator.addSchema(structuredClone(document)).compile(root, inline ? [offDialect(), unitsDialect()] : undefined);
  return instances.map((instance) => {
    const result = /** @type {any} */ (validate(instance));
    return typeof result === 'boolean' ? result : result.valid;
  });
}

/** The entry's document: no validation vocabulary, so `type` asserts nothing in it. */
const offDocument = () => ({ $schema: OFF, $id: 'urn:doc', components: { schemas: { p: { type: 'string' } } }, $defs: { q: { type: 'string' } } });
/** A 2020-12 document of the same shape. */
const onDocument = () => ({ $schema: D20, $id: 'urn:on', components: { schemas: { p: { type: 'string' } } }, $defs: { q: { type: 'string' } } });

describe('a $ref target below a keyword no draft defines reads its own document\'s vocabularies', () => {
  for (const [mode, options] of /** @type {[string, object|undefined][]} */ ([['first failure', undefined], ['collectErrors', { collectErrors: true }]])) {
    it(`the reported input accepts 1 as the $defs member of the same document does (it refused 1): ${mode}`, () => {
      assert.deepEqual(answers(offDocument(), 'urn:doc#/components/schemas/p', [1, 'a'], { options }), [true, true]);
      assert.deepEqual(answers(offDocument(), 'urn:doc#/$defs/q', [1, 'a'], { options }), [true, true]);
    });
  }

  it('whatever dialect the root declares (2020-12 and draft-07 roots refused 1)', () => {
    for (const from of [D20, D07, OFF])
      assert.deepEqual(answers(offDocument(), 'urn:doc#/components/schemas/p', [1], { from }), [true], from);
  });

  it('a 2020-12 document asserts under a root without the vocabulary, as its $defs member does (it accepted 1)', () => {
    assert.deepEqual(answers(onDocument(), 'urn:on#/components/schemas/p', [1, 'a'], { from: OFF }), [false, true]);
    assert.deepEqual(answers(onDocument(), 'urn:on#/$defs/q', [1, 'a'], { from: OFF }), [false, true]);
  });

  it('reads a $schema an object on the way declares, below the keyword (it refused 1 and { m: 1 })', () => {
    const document = { $id: 'urn:way', x: { $schema: OFF, properties: { m: { type: 'string' } } } };
    assert.deepEqual(answers(document, 'urn:way#/x/properties/m', [1]), [true]);
    assert.deepEqual(answers(document, 'urn:way#/x', [{ m: 1 }]), [true]);
    // and the other way: the object on the way restores the vocabulary its document leaves out
    const restored = { $schema: OFF, $id: 'urn:back', x: { $schema: D20, properties: { m: { type: 'string' } } } };
    assert.deepEqual(answers(restored, 'urn:back#/x/properties/m', [1, 'a']), [false, true]);
  });

  it('the content keywords of a draft-07 document assert under a 2020-12 root, as its definitions member does (it accepted "{")', () => {
    // two objects: one object held at both places is recorded where the walk enters it
    const content = () => ({ type: 'string', contentMediaType: 'application/json' });
    const document = { $schema: D07, $id: 'urn:d7', components: { schemas: { c: content() } }, definitions: { c: content() } };
    assert.deepEqual(answers(document, 'urn:d7#/components/schemas/c', ['{', '{}'], { from: D20 }), [false, true]);
    assert.deepEqual(answers(document, 'urn:d7#/definitions/c', ['{', '{}'], { from: D20 }), [false, true]);
  });

  it('format follows the document too: asserted by draft-07, an annotation in 2020-12', () => {
    const email = () => ({ type: 'string', format: 'email' });
    const draft07 = { $schema: D07, $id: 'urn:f7', components: { schemas: { e: email() } }, definitions: { e: email() } };
    assert.deepEqual(answers(draft07, 'urn:f7#/components/schemas/e', ['x', 'a@b.test'], { from: D20 }), [false, true]);
    assert.deepEqual(answers(draft07, 'urn:f7#/definitions/e', ['x', 'a@b.test'], { from: D20 }), [false, true]);
    const draft2020 = { $schema: D20, $id: 'urn:f20', components: { schemas: { e: email() } }, $defs: { e: email() } };
    assert.deepEqual(answers(draft2020, 'urn:f20#/components/schemas/e', ['x', 'a@b.test'], { from: D07 }), [true, true]);
    assert.deepEqual(answers(draft2020, 'urn:f20#/$defs/e', ['x', 'a@b.test'], { from: D07 }), [true, true]);
  });
});

describe('the reading holds wherever the target sits', () => {
  it('with the dialect handed to the compile instead of held', () => {
    assert.deepEqual(answers(offDocument(), 'urn:doc#/components/schemas/p', [1], { inline: true }), [true]);
    assert.deepEqual(answers(offDocument(), 'urn:doc#/$defs/q', [1], { inline: true }), [true]);
    assert.deepEqual(answers(onDocument(), 'urn:on#/components/schemas/p', [1], { from: OFF, inline: true }), [false]);
  });

  it('two unknown keywords deep', () => {
    const document = { $schema: OFF, $id: 'urn:deep', 'x-outer': { 'x-inner': { p: { type: 'string' } } } };
    assert.deepEqual(answers(document, 'urn:deep#/x-outer/x-inner/p', [1]), [true]);
    assert.deepEqual(answers({ ...document, $schema: D20 }, 'urn:deep#/x-outer/x-inner/p', [1], { from: OFF }), [false]);
  });

  it('in the subschemas below the target', () => {
    const nested = () => ({ properties: { m: { items: { type: 'integer' } } }, required: ['m'] });
    const document = { $schema: OFF, $id: 'urn:below', components: { schemas: { p: nested() } }, $defs: { q: nested() } };
    for (const ref of ['urn:below#/components/schemas/p', 'urn:below#/$defs/q'])
      assert.deepEqual(answers(document, ref, [{ m: ['x'] }, {}], { from: D20 }), [true, true], ref);
    for (const ref of ['urn:below#/components/schemas/p', 'urn:below#/$defs/q'])
      assert.deepEqual(answers({ ...document, $schema: D20 }, ref, [{ m: ['x'] }, {}, { m: [1] }], { from: OFF }), [false, false, true], ref);
  });

  it('below an unknown keyword of an embedded resource that declares its own dialect', () => {
    const embedded = (outer, inner) => ({ $schema: outer, $id: 'urn:host', $defs: {
      e: { $schema: inner, $id: 'urn:emb', components: { schemas: { p: { type: 'string' } } }, $defs: { q: { type: 'string' } } },
    } });
    for (const ref of ['urn:emb#/components/schemas/p', 'urn:emb#/$defs/q']) {
      assert.deepEqual(answers(embedded(D20, OFF), ref, [1]), [true], ref);
      assert.deepEqual(answers(embedded(OFF, D20), ref, [1, 'a']), [false, true], ref);
    }
  });

  it('the formatAssertion and contentValidation options still decide', () => {
    const both = { type: 'string', format: 'email', contentMediaType: 'application/json' };
    const draft07 = { $schema: D07, $id: 'urn:o7', components: { schemas: { b: both } } };
    assert.deepEqual(answers(draft07, 'urn:o7#/components/schemas/b', ['x'], { from: D20, options: { formatAssertion: false, contentValidation: false } }), [true]);
    const draft2020 = { $schema: D20, $id: 'urn:o20', components: { schemas: { e: { type: 'string', format: 'email' } } } };
    assert.deepEqual(answers(draft2020, 'urn:o20#/components/schemas/e', ['x'], { from: D07, options: { formatAssertion: true } }), [false]);
  });
});

describe('what read right before reads as before', () => {
  it('a document under no $schema reads the compilation\'s vocabularies, below the keyword and under $defs', () => {
    const document = { $id: 'urn:plain', components: { schemas: { p: { type: 'string' } } }, $defs: { q: { type: 'string' } } };
    for (const ref of ['urn:plain#/components/schemas/p', 'urn:plain#/$defs/q']) {
      assert.deepEqual(answers(document, ref, [1, 'a']), [false, true], ref);
      assert.deepEqual(answers(document, ref, [1, 'a'], { from: D20 }), [false, true], ref);
      assert.deepEqual(answers(document, ref, [1, 'a'], { from: OFF }), [true, true], ref);
    }
  });

  it('a document of the root\'s own dialect, and one compiled itself', () => {
    assert.deepEqual(answers(onDocument(), 'urn:on#/components/schemas/p', [1, 'a'], { from: D20 }), [false, true]);
    assert.deepEqual(answers(onDocument(), 'urn:on#/components/schemas/p', [1, 'a']), [false, true]);
    const itself = holding().compile({ ...offDocument(), $ref: '#/components/schemas/p' });
    assert.deepEqual([itself(1), itself('a')], [true, true]);
  });

  it('a target whose dialect requires a vocabulary the validator does not implement still answers under the compilation\'s (its $defs member is refused JK0016)', () => {
    const document = { $schema: UNITS, $id: 'urn:units', components: { schemas: { p: { type: 'string' } } }, $defs: { q: { type: 'string' } } };
    assert.deepEqual(answers(document, 'urn:units#/components/schemas/p', [1, 'a']), [false, true]);
    assert.deepEqual(answers(document, 'urn:units#/components/schemas/p', [1, 'a'], { from: OFF }), [true, true]);
    assert.throws(() => answers(document, 'urn:units#/$defs/q', [1]), { name: 'SchemaCompileError', code: 'JK0016' });
  });
});
