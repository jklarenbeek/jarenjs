//@ts-check
/**
 * @file A dialect whose meta-schema requires (`$vocabulary`, `true`) a
 * vocabulary this package does not implement is refused `JK0016` where a
 * place under it compiles, naming the meta-schema and the vocabulary: read
 * on, that vocabulary's keywords would be annotations and assert nothing.
 * Every shape that answered right before still answers: a vocabulary
 * declared `false`, the vocabularies this package implements (the Jaren
 * query vocabulary among them), a meta-schema without `$vocabulary` or of a
 * draft without it, the meta-schema read as a schema, and a held document
 * of the dialect that the compile does not reach.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';
import { emitTypeScript } from '@jarenjs/emit';
import jaren2020, { dialect as JAREN, queryVocabulary } from '@jarenjs/refs/jaren-2020-12';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const VOCAB = 'https://json-schema.org/draft/2020-12/vocab/';
const UNKNOWN = 'https://v.test/vocab/unknown';
const META = 'https://v.test/meta-unknown';
const BASE = { [`${VOCAB}core`]: true, [`${VOCAB}applicator`]: true, [`${VOCAB}validation`]: true };

/** A validator holding a 2020-12 dialect whose `$vocabulary` adds `extra`. @param {Record<string, boolean>} extra @param {string} [over] */
const holding = (extra, over = D20) => new JarenValidator().addMetaSchema({ $schema: over, $id: META, $dynamicAnchor: 'meta', $vocabulary: { ...BASE, ...extra } });

/** @param {() => unknown} fn */
const refusal = (fn) => {
  try { fn(); return 'answers'; }
  catch (error) { return `${/** @type {any} */ (error).code} ${/** @type {any} */ (error).docPath ?? ''}`.trim(); }
};

describe('a required vocabulary the validator does not implement', () => {
  it('refuses a schema of the dialect JK0016, naming the meta-schema and the vocabulary (it asserted type and skipped the vocabulary)', () => {
    const validator = holding({ [UNKNOWN]: true });
    assert.throws(() => validator.compile({ $schema: META, type: 'string' }), (error) => {
      const e = /** @type {any} */ (error);
      assert.equal(e.code, 'JK0016');
      assert.equal(e.docPath, '#/%24schema');
      assert.match(e.message, /the meta-schema 'https:\/\/v\.test\/meta-unknown' requires the vocabulary 'https:\/\/v\.test\/vocab\/unknown'/);
      assert.match(e.message, /declare it false in that meta-schema's \$vocabulary/);
      return true;
    });
  });

  it('refuses an embedded resource of the dialect, and a held one a $ref reaches by the first call (as any refusal of a held document), at its $schema', () => {
    const held = holding({ [UNKNOWN]: true }).addSchema({ $schema: META, $id: 'https://v.test/held.json', type: 'string' });
    const referenced = held.compile({ $schema: D20, $ref: 'https://v.test/held.json' });
    assert.equal(refusal(() => referenced('x')), 'JK0016 https://v.test/held.json#/%24schema');
    assert.equal(refusal(() => holding({ [UNKNOWN]: true }).compile({ $schema: D20, properties: { r: { $schema: META, $id: 'https://v.test/r.json', type: 'string' } } })),
      'JK0016 https://v.test/r.json#/%24schema');
  });

  it('answers as before for every shape that answered right', () => {
    // declared false: a validator that does not implement it goes on without it
    const optional = holding({ [UNKNOWN]: false }).compile({ $schema: META, type: 'string' });
    assert.deepEqual([optional('x'), optional(1)], [true, false]);
    // only implemented vocabularies, the hyper-schema one among them (its keywords are annotations)
    const known = holding({ [`${VOCAB}unevaluated`]: true, [`${VOCAB}format-assertion`]: false, [`${VOCAB}meta-data`]: true, [`${VOCAB}content`]: true,
      'https://json-schema.org/draft/2019-09/vocab/hyper-schema': true, [`${VOCAB}hyper-schema`]: true }).compile({ $schema: META, type: 'string' });
    assert.deepEqual([known('x'), known(1)], [true, false]);
    // no $vocabulary at all
    const plain = new JarenValidator().addMetaSchema({ $schema: D20, $id: META, $dynamicAnchor: 'meta' }).compile({ $schema: META, type: 'string' });
    assert.deepEqual([plain('x'), plain(1)], [true, false]);
    // a meta-schema of a draft without $vocabulary: the member is no keyword there
    assert.equal(refusal(() => holding({ [UNKNOWN]: true }, D07).compile({ $schema: META, type: 'string' })), 'answers');
    // the meta-schema itself is a 2020-12 schema: validating schemas against it answers
    const meta = holding({ [UNKNOWN]: true }).compile({ $ref: META });
    assert.equal(meta({ type: 'string' }), true);
    // a held document of the dialect the compile does not reach
    const unreached = holding({ [UNKNOWN]: true }).addSchema({ $schema: META, $id: 'https://v.test/held.json', type: 'string' }).compile({ $schema: D20, type: 'integer' });
    assert.deepEqual([unreached(1), unreached('x')], [true, false]);
    // a $vocabulary in a document no $schema names reads nothing
    const unnamed = new JarenValidator().compile({ $schema: D20, $vocabulary: { [UNKNOWN]: true }, type: 'string' });
    assert.deepEqual([unnamed('x'), unnamed(1)], [true, false]);
  });

  it('keeps admitting the Jaren dialect, whose query vocabulary this package implements', () => {
    const validator = new JarenValidator().addMetaSchema([...jaren2020], JAREN);
    const validate = validator.compile({ $schema: JAREN, type: 'object', $query: { $count: '$.items' } });
    assert.equal(typeof validate, 'function');
    assert.equal(/** @type {any} */ (jaren2020[0]).$vocabulary[queryVocabulary], true);
  });

  it('the readers handed the dialect refuse it alike', () => {
    const dialects = holding({ [UNKNOWN]: true });
    const schema = { $schema: META, type: 'object', properties: { a: { type: 'integer', default: 1 } } };
    assert.equal(refusal(() => compileNormalizer(schema, { useDefaults: true, dialects })), 'JK0016 #/%24schema');
    assert.equal(refusal(() => deriveStrictProfile(schema, { dialects })), 'JK0016 #/%24schema');
    assert.equal(refusal(() => emitTypeScript(schema, { name: 'T', dialects })), 'JK0016 #/%24schema');
    // without the option a $schema is read by its name alone, as before
    assert.equal(refusal(() => compileNormalizer(schema, { useDefaults: true })), 'answers');
  });
});
